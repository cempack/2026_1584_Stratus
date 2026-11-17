// Live English subtitles for the ATC player (server: stratus/captions.py, Whisper "translate").
//
// One EventSource while subtitles are on and a feed is playing. The panel shows the last few calls (newest last,
// older ones fading), tagged "RU → EN" when the feed is not in English; the mini-player shows the latest call for a
// few seconds as a bubble.
import { atcCaptionsUrl } from "../api";

interface Caption { id: number; t: number; dur: number; text: string; lang: string }
type State = "off" | "loading" | "waiting" | "live" | "error";

const KEY = "stratus.atc.cc";
const KEEP = 3;
const MINI_SHOW_MS = 9000;

const $ = (id: string) => document.getElementById(id) as HTMLElement;
const get = () => { try { return localStorage.getItem(KEY) === "1"; } catch { return false; } };
const put = (v: boolean) => { try { localStorage.setItem(KEY, v ? "1" : "0"); } catch { /* private mode */ } };

const LANG: Record<string, string> = { ru: "RU", de: "DE", fr: "FR", es: "ES", it: "IT", pt: "PT", ja: "JA", zh: "ZH", nl: "NL", pl: "PL", hu: "HU", no: "NO", sv: "SV" };

export class Captions {
  available = false;
  private on = get();
  private es: EventSource | null = null;
  private key = "";
  private lines: Caption[] = [];
  private state: State = "off";
  private miniTimer: ReturnType<typeof setTimeout> | undefined;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private want: { icao: string; feed: string } | null = null;

  constructor() {
    $("atc-cc-btn").addEventListener("click", () => { this.on = !this.on; put(this.on); this.sync(); });
    this.render();
  }

  /** What is playing (null when nothing is). Called by the player on every state change. */
  follow(icao: string | null, feed: string | null) {
    this.want = icao && feed ? { icao, feed } : null;
    this.sync();
  }

  private sync() {
    const w = this.on && this.available ? this.want : null;
    const key = w ? `${w.icao}|${w.feed}` : "";
    if (key === this.key) { this.render(); return; }
    this.close();
    this.key = key;
    this.lines = [];
    if (w) this.connect(w.icao, w.feed);
    this.state = w ? "loading" : "off";
    this.render();
  }

  private connect(icao: string, feed: string) {
    const es = new EventSource(atcCaptionsUrl(icao, feed));
    this.es = es;
    es.onmessage = (m) => {
      let ev: { type: string; state?: string } & Partial<Caption>;
      try { ev = JSON.parse(m.data); } catch { return; }
      if (ev.type === "status") {
        if (ev.state === "ended") { this.reopen(); return; }
        this.state = ev.state === "loading" ? "loading" : ev.state === "error" ? "error" : this.lines.length ? "live" : "waiting";
      } else if (ev.type === "caption" && ev.text) {
        if (this.lines.some((l) => l.id === ev.id)) return;
        this.lines = [...this.lines, ev as Caption].slice(-KEEP);
        this.state = "live";
        this.flashMini();
      }
      this.render();
    };
    es.onerror = () => { if (es.readyState === EventSource.CLOSED) this.reopen(); };
  }

  private reopen() {
    const k = this.key;
    this.close();
    this.key = "";
    clearTimeout(this.retry);
    this.retry = setTimeout(() => { if (k && this.on) this.sync(); }, 2000);
  }

  private close() {
    this.es?.close();
    this.es = null;
  }

  private flashMini() {
    clearTimeout(this.miniTimer);
    $("mini-cc").classList.add("show");
    this.miniTimer = setTimeout(() => $("mini-cc").classList.remove("show"), MINI_SHOW_MS);
  }

  private render() {
    const btn = $("atc-cc-btn");
    btn.hidden = !this.available;
    btn.setAttribute("aria-pressed", String(this.on));
    const box = $("atc-cc");
    box.hidden = !(this.on && this.available && this.want);
    const msg = this.state === "loading" ? "Préparation des sous-titres…"
      : this.state === "error" ? "Sous-titres indisponibles"
      : !this.lines.length ? "Sous-titres en anglais · en attente d’un message radio…" : "";
    box.replaceChildren(...(msg ? [Object.assign(document.createElement("p"), { className: "cc-wait", textContent: msg })] : this.lines.map((l, i) => {
      const p = document.createElement("p");
      p.className = i === this.lines.length - 1 ? "cc-line now" : "cc-line";
      const tag = LANG[l.lang];
      if (tag) p.append(Object.assign(document.createElement("span"), { className: "cc-lang", textContent: `${tag} → EN` }));
      p.append(document.createTextNode(l.text));
      return p;
    })));
    const last = this.lines[this.lines.length - 1];
    $("mini-cc").textContent = last && this.on ? last.text : "";
    if (!last || !this.on) $("mini-cc").classList.remove("show");
  }
}
