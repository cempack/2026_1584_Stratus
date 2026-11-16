// ATC radio: airport list from /api/atc/airports, audio streamed through /api/atc/audio.
//
// Why playback used to fail with "Lecture impossible": play() was called, then any later pause()/load()/src change
// (selecting another airport, switching feed, stop()) made the *earlier* play() promise reject with AbortError.
// That rejection landed after the new play() had already flagged the player as "playing", so it tore the new
// attempt down and printed the error. Every attempt now carries a generation number; rejections, events and timers
// from a superseded attempt are ignored, AbortError is never an error, and NotAllowedError is told apart from
// network failures. 8 kbps feeds take a few seconds to start, so a watchdog gives up after 12 s and moves on to the
// next feed of the same airport before offering a retry button.
import { type AtcAirport, type AtcFeed, atcAudioUrl, fetchAtc } from "../api";
import { MseStream, mseSupported } from "../lib/stream";
import { norm } from "../lib/core";
import { KIND_ICON, Meter, chipLabels, feedKind, parseFreq } from "../lib/radio";
import { icon } from "./icons";
import { closeOthers, registerPopover } from "./popovers";
import { hide, show, shown } from "./motion";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const store = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

export interface AtcHooks {
  onToggle(open: boolean): void;
  onAirports(a: AtcAirport[]): void;
  onPick(a: AtcAirport): void;
  /** Airport whose radio is active (connecting or playing), null when stopped. */
  onLive(a: AtcAirport | null): void;
  /** The mini-player in the bottom slot appeared or went away. */
  onMini?(show: boolean): void;
}

type St = "idle" | "connecting" | "live" | "buffering" | "blocked" | "error";
const PILL: Record<St, string> = { idle: "Arrêté", connecting: "Connexion…", live: "En direct", buffering: "Mise en mémoire…", blocked: "Lecture bloquée", error: "Indisponible" };
const WATCHDOG_MS = 12_000;
const BARS = 56;

const mmss = (s: number) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
/** "EHAM Tower (Rwy 18R/36L)" → "Tower (Rwy 18R/36L)" */
export const feedLabel = (a: AtcAirport | null, f: AtcFeed) => (a && f.label.toUpperCase().startsWith(a.icao) ? f.label.slice(a.icao.length).trim() : f.label) || f.label;

export class Atc {
  airports: AtcAirport[] = [];
  private current: AtcAirport | null = null;
  private feed: AtcFeed | null = null;
  private audio = new Audio();
  private mse?: MseStream;
  private loadState: "loading" | "ok" | "empty" | "error" = "loading";
  private loaded: Promise<void> | null = null;

  private st: St = "idle";
  private note = "";
  private gen = 0;
  private wanted = false;
  private internalPause = false;
  private tried = new Set<string>();
  private reconnects = 0;
  private watchdog: ReturnType<typeof setTimeout> | undefined;
  private liveSince = 0;
  private ticker: ReturnType<typeof setInterval> | undefined;
  private volume = Number(store.get("stratus.atc.vol") ?? 0.8);

  private ctx?: AudioContext;
  private gain?: GainNode;
  private analyser?: AnalyserNode;
  private wave?: Uint8Array<ArrayBuffer>;
  private hist: number[] = new Array(BARS).fill(0);
  private lastSample = 0;
  private raf = 0;
  private meter = new Meter();
  private rx = false;
  private litSegments = -1;

  constructor(private hooks: AtcHooks) {
    this.audio.preload = "none";
    const vol = $<HTMLInputElement>("atc-vol");
    vol.value = String(this.volume);
    vol.style.setProperty("--v", `${this.volume * 100}%`);
    vol.addEventListener("input", () => {
      this.volume = Number(vol.value);
      vol.style.setProperty("--v", `${this.volume * 100}%`);
      store.set("stratus.atc.vol", String(this.volume));
      this.applyVolume();
    });
    this.applyVolume();

    registerPopover({ el: $("atc"), trigger: $("btn-atc"), isOpen: () => this.isOpen, close: () => this.close() });
    const segs = [...$("atc-lvl").children] as HTMLElement[];
    segs.forEach((el, i) => { el.style.height = `${6 + Math.round((i / (segs.length - 1)) * 16)}px`; });
    $("atc").querySelector("[data-close]")!.addEventListener("click", () => this.close());
    $("btn-atc").addEventListener("click", () => (this.isOpen ? this.close() : this.open()));
    $("atc-q").addEventListener("input", () => this.renderList());
    $("atc-play").addEventListener("click", () => this.toggle());
    $("atc-retry").addEventListener("click", () => this.toggle(true));
    $("mini-open").addEventListener("click", () => this.open());
    $("mini-stop").addEventListener("click", () => { this.stop(); this.current = null; this.feed = null; this.renderAll(); });
    $("atc-list").addEventListener("click", (e) => {
      const li = (e.target as HTMLElement).closest<HTMLElement>("li[data-icao]");
      const a = li && this.airports.find((x) => x.icao === li.dataset.icao);
      if (a) { this.select(a, true); this.hooks.onPick(a); }
      else if ((e.target as HTMLElement).closest("[data-reload]")) { this.loaded = null; void this.load(); }
    });
    $("atc-feeds").addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>("button[data-feed]");
      const f = b && this.current?.feeds.find((x) => x.id === b.dataset.feed);
      if (f) { this.tried.clear(); this.reconnects = 0; this.start(f); }
    });

    const au = this.audio;
    au.addEventListener("playing", () => {
      if (!this.wanted) return;
      clearTimeout(this.watchdog);
      this.reconnects = 0;
      if (this.ctx?.state === "suspended") void this.ctx.resume();
      if (this.st !== "live") { if (!this.liveSince) this.liveSince = Date.now(); this.setSt("live"); }
    });
    for (const ev of ["waiting", "stalled"] as const) {
      au.addEventListener(ev, () => {
        if (!this.wanted || this.st !== "live") return;
        this.setSt("buffering");
        this.arm(this.gen, 20_000);
      });
    }
    au.addEventListener("canplay", () => {
      // retry on canplay: the very first play() can be refused while data is still arriving
      if (this.wanted && au.paused && !this.internalPause) au.play().catch((e) => this.onReject(this.gen, e));
    });
    au.addEventListener("error", () => { if (this.wanted) this.fail(this.gen, "error"); });
    au.addEventListener("ended", () => this.streamEnded(this.gen));
    au.addEventListener("pause", () => {
      // OS media keys, headset button…: our own teardown bumps `gen`/clears `wanted`, so only a foreign pause survives this check
      const my = this.gen;
      setTimeout(() => { if (my === this.gen && this.wanted && !this.internalPause && au.paused && this.st === "live") this.stop(); }, 150);
    });

    this.renderAll();
    void this.load();
    window.addEventListener("resize", () => this.draw());
  }

  get isOpen() { return shown($("atc")); }
  get isLive() { return this.st === "connecting" || this.st === "live" || this.st === "buffering"; }

  // ----- catalogue -----
  private load(): Promise<void> {
    if (this.loaded) return this.loaded;
    this.loadState = "loading"; this.renderList();
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), 10_000);
    return (this.loaded = fetchAtc(ctl.signal).then((a) => {
      this.airports = a.filter((x) => x.feeds?.length).sort((x, y) => x.name.localeCompare(y.name, "fr"));
      this.loadState = this.airports.length ? "ok" : "empty";
      this.hooks.onAirports(this.airports.filter((x) => Number.isFinite(x.lat) && Number.isFinite(x.lon)));
      const last = store.get("stratus.atc.icao");
      const found = this.airports.find((x) => x.icao === last);
      if (found && !this.current) this.select(found, false);
      this.renderList();
    }).catch(() => {
      this.loaded = null; this.loadState = "error"; this.renderList();
    }).finally(() => clearTimeout(to)));
  }

  open(icao?: string) {
    closeOthers($("atc"));
    show($("atc"));
    $("btn-atc").setAttribute("aria-pressed", "true");
    this.hooks.onToggle(true);
    this.renderAll();
    void this.load().then(() => {
      const a = icao ? this.airports.find((x) => x.icao === icao) : null;
      if (a) this.select(a, true);
    });
  }

  close() {
    hide($("atc"));
    $("btn-atc").setAttribute("aria-pressed", "false");
    this.hooks.onToggle(false);
    this.renderAll();
  }

  /** `play` must only be true from a click/key handler: browsers refuse audio started outside a user gesture. */
  select(a: AtcAirport, play: boolean) {
    const changed = this.current !== a;
    if (changed) this.stop();
    this.current = a;
    store.set("stratus.atc.icao", a.icao);
    const remembered = store.get(`stratus.atc.feed.${a.icao}`);
    this.feed = a.feeds.find((f) => f.id === remembered) ?? a.feeds[0] ?? null;
    this.renderAll();
    if (play && this.feed) { this.tried.clear(); this.reconnects = 0; this.start(this.feed); }
  }

  // ----- playback -----
  private toggle(forceStart = false) {
    if (!this.current || !this.feed) return;
    if (!forceStart && this.wanted && this.st !== "error" && this.st !== "blocked") { this.stop(); return; }
    this.tried.clear(); this.reconnects = 0;
    this.start(this.feed);
  }

  private ensureGraph() {
    if (!this.ctx) {
      try {
        const C = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        const ctx = new C();
        const src = ctx.createMediaElementSource(this.audio);
        const an = ctx.createAnalyser();
        an.fftSize = 512; an.smoothingTimeConstant = 0.5;
        const g = ctx.createGain();
        src.connect(an); an.connect(g); g.connect(ctx.destination);
        // the page may be backgrounded or the browser may suspend the context: a suspended context means a silent stream
        ctx.addEventListener("statechange", () => { if (ctx.state === "suspended" && this.wanted) void ctx.resume().catch(() => {}); });
        this.ctx = ctx; this.analyser = an; this.gain = g; this.wave = new Uint8Array(new ArrayBuffer(an.fftSize));
        this.applyVolume();
      } catch { this.ctx = undefined; this.analyser = undefined; this.gain = undefined; }
    }
    if (this.ctx?.state === "suspended") void this.ctx.resume().catch(() => {});
  }

  private applyVolume() {
    if (this.gain) { this.gain.gain.value = this.volume; this.audio.volume = 1; } else this.audio.volume = this.volume;
  }

  /** Begin (or restart) playback of `feed`. Call it synchronously from the user's click the first time. */
  private start(feed: AtcFeed, reconnect = false) {
    const a = this.current;
    if (!a) return;
    const my = ++this.gen;
    this.wanted = true;
    this.feed = feed;
    this.tried.add(feed.id);
    store.set(`stratus.atc.feed.${a.icao}`, feed.id);
    if (!reconnect) { this.liveSince = 0; this.note = ""; }
    this.setSt("connecting");
    this.arm(my, WATCHDOG_MS);
    this.ensureGraph();
    const au = this.audio;
    this.internalPause = true;
    this.mse?.stop();
    this.mse = undefined;
    const url = atcAudioUrl(a.icao, feed.id);
    // MSE starts on the first frames; a plain src makes the browser wait for a large buffer (slow at 8-32 kbps)
    if (mseSupported()) this.mse = new MseStream(au, url, (err) => (err ? this.fail(my, "network") : this.streamEnded(my)));
    else au.src = url;
    this.internalPause = false;
    const p = au.play();
    if (p) p.catch((e) => this.onReject(my, e));
  }

  /** The proxy closed the stream (upstream restart): reconnect a few times before giving up on this feed. */
  private streamEnded(my: number) {
    if (my !== this.gen || !this.wanted) return;
    if (this.reconnects++ < 3 && this.feed) setTimeout(() => { if (my === this.gen && this.wanted && this.feed) this.start(this.feed, true); }, 800);
    else this.fail(my, "ended");
  }

  private arm(my: number, ms: number) {
    clearTimeout(this.watchdog);
    this.watchdog = setTimeout(() => this.fail(my, "timeout"), ms);
  }

  private onReject(my: number, e: unknown) {
    if (my !== this.gen || !this.wanted) return; // superseded by a newer attempt or by stop()
    const name = (e as DOMException)?.name;
    if (name === "AbortError") return; // interrupted by a load we triggered; the new attempt reports for itself
    if (name === "NotAllowedError") {
      clearTimeout(this.watchdog);
      this.note = "Le navigateur a bloqué la lecture automatique : appuyez sur Écouter.";
      this.setSt("blocked");
      return;
    }
    this.fail(my, name === "NotSupportedError" ? "unsupported" : "network");
  }

  /** This feed does not work: try the next one of the airport, else show the error with a retry button. */
  private fail(my: number, _why: string) {
    if (my !== this.gen || !this.wanted) return;
    clearTimeout(this.watchdog);
    const a = this.current;
    const next = a?.feeds.find((f) => !this.tried.has(f.id));
    if (a && next) {
      this.note = `${feedLabel(a, this.feed ?? next)} ne répond pas — essai de ${feedLabel(a, next)}…`;
      this.start(next);
      return;
    }
    this.halt();
    this.note = "Flux indisponible pour le moment. Réessayez ou choisissez un autre aéroport.";
    this.setSt("error");
  }

  /** Tear the element down without touching `wanted`/state. */
  private halt() {
    clearTimeout(this.watchdog);
    this.internalPause = true;
    this.mse?.stop();
    this.mse = undefined;
    this.audio.pause();
    this.audio.removeAttribute("src");
    this.audio.load();
    this.internalPause = false;
    this.wanted = false;
  }

  stop() {
    this.gen++;
    this.halt();
    this.liveSince = 0; this.note = "";
    this.setSt("idle");
  }

  private setSt(s: St) {
    this.st = s;
    if (s !== "live") { this.meter.reset(); this.hist.fill(0); this.setRx(false); this.paintLevel(0); }
    clearInterval(this.ticker);
    if (s === "live" || s === "buffering") this.ticker = setInterval(() => this.renderTime(), 1000);
    this.hooks.onLive(this.isLive ? this.current : null);
    this.renderAll();
    this.draw();
    if (this.isLive && !this.raf) this.raf = requestAnimationFrame((t) => this.loop(t));
  }

  // ----- rendering -----
  private renderAll() {
    this.renderList();
    const a = this.current, f = this.feed;
    const card = $("atc-player");
    card.hidden = !a;
    const mini = $("mini");
    mini.hidden = !(a && (this.st !== "idle") && !this.isOpen);
    $("atc").dataset.state = this.st;
    mini.dataset.state = this.st;
    document.body.classList.toggle("mini-open", !mini.hidden);
    this.hooks.onMini?.(!mini.hidden);
    if (!a || !f) return;
    $("atc-code").textContent = a.icao;
    $("atc-title").textContent = a.name;
    $("atc-sub").textContent = [a.city, a.country].filter(Boolean).join(" · ");
    const pill = $("atc-pill");
    pill.className = `pill st-${this.st}`;
    $("atc-pill-text").textContent = PILL[this.st];
    $("atc-note").textContent = this.note;
    $("atc-note").hidden = !this.note;
    $("atc-retry").hidden = !(this.st === "error");
    const playing = this.wanted && this.st !== "error" && this.st !== "blocked";
    const pb = $("atc-play");
    pb.innerHTML = icon(playing ? "pause" : "play");
    pb.setAttribute("aria-label", playing ? "Arrêter" : "Écouter");
    $("btn-atc").classList.toggle("live", this.isLive);

    // LCD: channel kind, frequency, full label
    const fk = feedKind(f.label), freq = parseFreq(f.label);
    $("atc-kind").textContent = fk.name;
    const ki = $("atc-kind-ico");
    if (ki.dataset.k !== fk.kind) { ki.dataset.k = fk.kind; ki.innerHTML = icon(KIND_ICON[fk.kind]); }
    const fq = $("atc-freq");
    fq.textContent = freq ?? "---.---";
    fq.classList.toggle("none", !freq);
    $("atc-label").textContent = feedLabel(a, f);

    // channel chips with icons: Tour, Sol, Approche, ATIS...
    const names = chipLabels(a.icao, a.feeds.map((x) => x.label));
    $("atc-feeds").replaceChildren(...a.feeds.map((x, i) => {
      const b = document.createElement("button");
      b.type = "button"; b.dataset.feed = x.id; b.className = "chip-feed";
      b.setAttribute("role", "radio"); b.setAttribute("aria-checked", String(x.id === f.id));
      b.innerHTML = `<span class="ci">${icon(KIND_ICON[feedKind(x.label).kind])}</span><span></span>`;
      (b.lastElementChild as HTMLElement).textContent = names[i];
      b.title = x.label;
      return b;
    }));

    // mini-player
    $("mini-freq").textContent = freq ?? fk.name;
    $("mini-code").textContent = this.st === "live" || this.st === "idle" ? a.icao : `${a.icao} · ${PILL[this.st]}`;
    this.renderTime();
  }

  private renderTime() {
    const t = this.liveSince && (this.st === "live" || this.st === "buffering") ? mmss((Date.now() - this.liveSince) / 1000) : "";
    $("atc-time").textContent = t;
    $("atc-time").hidden = !t;
  }

  private renderList() {
    const ul = $("atc-list");
    const q = norm($<HTMLInputElement>("atc-q").value);
    $("atc-count").textContent = this.airports.length ? String(this.airports.length) : "";
    const msg = (cls: string, text: string, action?: string) => {
      const li = document.createElement("li");
      li.className = cls; li.textContent = text;
      if (action) { const b = document.createElement("button"); b.className = "link"; b.dataset.reload = "1"; b.textContent = action; li.append(b); }
      ul.replaceChildren(li);
    };
    if (this.loadState === "loading") {
      ul.replaceChildren(...[0, 1, 2, 3].map(() => Object.assign(document.createElement("li"), { className: "skel" })));
      return;
    }
    if (this.loadState === "error") return msg("empty", "Impossible de charger la liste des aéroports. ", "Réessayer");
    if (this.loadState === "empty") return msg("empty", "Aucun flux radio n’est disponible pour le moment.");
    const rows = this.airports.filter((a) => !q || norm(`${a.icao} ${a.name} ${a.city ?? ""} ${a.country ?? ""}`).includes(q));
    if (!rows.length) return msg("empty", "Aucun aéroport ne correspond.");
    ul.replaceChildren(...rows.map((a) => {
      const li = document.createElement("li");
      li.setAttribute("role", "option"); li.dataset.icao = a.icao;
      li.setAttribute("aria-selected", String(a === this.current));
      if (a === this.current && this.isLive) li.classList.add("live");
      li.innerHTML = '<span class="code"></span><span class="nm"><b></b><small></small></span><span class="eq" aria-hidden="true"><i></i><i></i><i></i></span>';
      li.querySelector(".code")!.textContent = a.icao;
      li.querySelector("b")!.textContent = a.name;
      li.querySelector("small")!.textContent = [a.city, a.country].filter(Boolean).join(" · ") + (a.feeds.length > 1 ? ` · ${a.feeds.length} fréquences` : "");
      return li;
    }));
  }

  // ----- visualiser -----
  private loop(t: number) {
    this.raf = 0;
    if (!this.isLive || document.hidden) { if (this.isLive) this.raf = requestAnimationFrame((x) => this.loop(x)); return; }
    if (t - this.lastSample >= 48) {
      this.lastSample = t;
      let level = 0;
      if (this.analyser && this.wave && this.st === "live") {
        this.analyser.getByteTimeDomainData(this.wave);
        let sum = 0;
        for (const v of this.wave) { const d = (v - 128) / 128; sum += d * d; }
        level = this.meter.push(Math.sqrt(sum / this.wave.length), t);
        this.setRx(this.meter.open);
      }
      this.hist.push(level); this.hist.shift();
      this.paintLevel(level);
      this.draw();
    }
    this.raf = requestAnimationFrame((x) => this.loop(x));
  }

  private draw() {
    const css = getComputedStyle(document.documentElement);
    const colors = { "atc-viz": css.getPropertyValue("--lcd-ink").trim() || "#F5B544", "mini-viz": css.getPropertyValue("--accent").trim() || "#F5B544" };
    for (const id of ["atc-viz", "mini-viz"] as const) {
      const accent = colors[id];
      const cv = $<HTMLCanvasElement>(id);
      if (cv.getClientRects().length === 0) continue;
      const dpr = Math.min(2, devicePixelRatio || 1);
      const w = Math.round(cv.clientWidth * dpr), h = Math.round(cv.clientHeight * dpr);
      if (!w || !h) continue;
      if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
      const g = cv.getContext("2d")!;
      g.clearRect(0, 0, w, h);
      const n = id === "mini-viz" ? 18 : BARS;
      const bw = w / n, gap = Math.max(1, bw * 0.38), mid = h / 2;
      g.fillStyle = accent;
      const live = this.st === "live";
      for (let i = 0; i < n; i++) {
        const v = this.hist[BARS - n + i] ?? 0;
        const bh = Math.max(2 * dpr, v * h * 0.95);
        g.globalAlpha = live ? 0.35 + 0.65 * Math.min(1, v * 1.4) * (0.4 + 0.6 * (i / n)) : 0.18;
        const x = i * bw + gap / 2, r = Math.min((bw - gap) / 2, 3 * dpr);
        g.beginPath();
        g.roundRect(x, mid - bh / 2, bw - gap, bh, r);
        g.fill();
      }
      g.globalAlpha = 1;
    }
  }

  /** RX lamp (squelch open): lit while voice is on the channel. */
  private setRx(on: boolean) {
    if (on === this.rx) return;
    this.rx = on;
    for (const id of ["atc", "mini"]) $(id).dataset.rx = on ? "1" : "0";
  }

  /** Segmented level meter next to the frequency. */
  private paintLevel(level: number) {
    const segs = $("atc-lvl").children, n = Math.round(level * segs.length);
    if (n === this.litSegments) return;
    this.litSegments = n;
    for (let i = 0; i < segs.length; i++) segs[i].classList.toggle("on", i < n);
  }
}
