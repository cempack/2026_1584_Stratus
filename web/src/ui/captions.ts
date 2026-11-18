// Live subtitles for the ATC player (server: stratus/captions.py, Whisper large-v3-turbo on Workers AI).
//
// - Every call is transcribed, and translated to English when the frequency is in another language (RU, JA…).
// - Timed to the audio: with subtitles on the radio plays CAPTION_LAG_S behind live, and each line is revealed when
//   the playback reaches the start of its call (the caption carries the call's server time).
// - The card says what it is (AI, translated to English, may be wrong), shows the current call large with the
//   previous ones fading, and explains the jargon of the current call in French (lib/glossary).
// - The mini-player shows the current call as a bubble.
import { atcCaptionsUrl } from "../api";
import { glossFor } from "../lib/glossary";

interface Caption { id: number; t: number; dur: number; text: string; lang: string }
type State = "off" | "loading" | "waiting" | "live" | "error" | "quota";

const KEY = "stratus.atc.cc";
const KEEP = 3;
const MINI_SHOW_MS = 12_000;
const LATE_S = 12; // a caption whose call should have been heard this long ago is shown anyway

const $ = (id: string) => document.getElementById(id) as HTMLElement;
const get = () => { try { return localStorage.getItem(KEY) === "1"; } catch { return false; } };
const put = (v: boolean) => { try { localStorage.setItem(KEY, v ? "1" : "0"); } catch { /* private mode */ } };
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text = "") => Object.assign(document.createElement(tag), { className: cls, textContent: text });

const LANG: Record<string, string> = { ru: "Russe", de: "Allemand", fr: "Français", es: "Espagnol", it: "Italien", pt: "Portugais", ja: "Japonais", zh: "Chinois", nl: "Néerlandais", pl: "Polonais", hu: "Hongrois", no: "Norvégien", sv: "Suédois", ko: "Coréen", tr: "Turc" };

export interface CaptionHooks {
  /** Server time (epoch s) of what is being heard right now; null when unknown. */
  clock(): number | null;
  /** Subtitles were switched on/off: the player changes its distance to live accordingly. */
  onToggle(on: boolean): void;
}

export class Captions {
  available = false;
  private _on = get();
  private es: EventSource | null = null;
  private key = "";
  private pending: Caption[] = [];
  private lines: Caption[] = [];
  private state: State = "off";
  private lang: string | null = null;
  private miniTimer: ReturnType<typeof setTimeout> | undefined;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private ticker: ReturnType<typeof setInterval> | undefined;
  private want: { icao: string; feed: string } | null = null;

  constructor(private hooks: CaptionHooks) {
    $("atc-cc-btn").addEventListener("click", () => {
      this._on = !this._on;
      put(this._on);
      this.hooks.onToggle(this._on);
      this.sync();
    });
    this.render();
  }

  get on() { return this._on && this.available; }

  /** What is playing (null when nothing is). Called by the player on every state change. */
  follow(icao: string | null, feed: string | null) {
    this.want = icao && feed ? { icao, feed } : null;
    this.sync();
  }

  private sync() {
    const w = this.on ? this.want : null;
    const key = w ? `${w.icao}|${w.feed}` : "";
    if (key === this.key) { this.render(); return; }
    this.close();
    this.key = key;
    this.lines = []; this.pending = []; this.lang = null;
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
        this.state = ev.state === "loading" ? "loading" : ev.state === "error" ? "error" : ev.state === "quota" ? "quota"
          : this.lines.length ? "live" : "waiting";
        this.render();
      } else if (ev.type === "caption" && ev.text && ev.id != null) {
        if (this.lines.some((l) => l.id === ev.id) || this.pending.some((l) => l.id === ev.id)) return;
        if (ev.lang) this.lang = ev.lang;
        this.pending.push(ev as Caption);
        this.reveal();
      }
    };
    es.onerror = () => { if (es.readyState === EventSource.CLOSED) this.reopen(); };
    clearInterval(this.ticker);
    this.ticker = setInterval(() => this.reveal(), 200);
  }

  /** Move captions whose call has started playing (or is late) from pending to the screen. */
  private reveal() {
    if (!this.pending.length) return;
    const heard = this.hooks.clock();
    const due = this.pending.filter((c) => heard == null || c.t <= heard + 0.2 || (heard - c.t) > LATE_S || Date.now() / 1000 - c.t > 30);
    if (!due.length) return;
    this.pending = this.pending.filter((c) => !due.includes(c));
    this.lines = [...this.lines, ...due].slice(-KEEP);
    if (this.state !== "quota") this.state = "live";
    this.flashMini();
    this.render();
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
    clearInterval(this.ticker);
  }

  private flashMini() {
    clearTimeout(this.miniTimer);
    $("mini-cc").classList.add("show");
    this.miniTimer = setTimeout(() => $("mini-cc").classList.remove("show"), MINI_SHOW_MS);
  }

  private render() {
    const btn = $("atc-cc-btn");
    btn.hidden = !this.available;
    btn.setAttribute("aria-pressed", String(this._on));
    const box = $("atc-cc");
    box.hidden = !(this.on && this.want);
    const foreign = this.lang && this.lang !== "en" ? (LANG[this.lang] ?? this.lang.toUpperCase()) : null;
    $("atc-cc-meta").textContent = this.state === "quota"
      ? "Quota gratuit du jour atteint : modèle local, moins précis"
      : foreign ? `${foreign} → anglais · IA, peut se tromper` : "Transcription IA · traduite en anglais si besoin";
    const msg = this.state === "loading" ? "Connexion aux sous-titres…"
      : this.state === "error" ? "Sous-titres indisponibles pour le moment"
      : !this.lines.length ? "En attente du prochain message radio…" : "";
    const linesEl = $("atc-cc-lines");
    linesEl.replaceChildren(...(msg ? [el("p", "cc-wait", msg)] : this.lines.map((l, i) => el("p", i === this.lines.length - 1 ? "cc-line now" : "cc-line", l.text))));
    const last = this.lines[this.lines.length - 1];
    const gloss = last && !msg ? glossFor(last.text) : [];
    $("atc-cc-gloss").replaceChildren(...gloss.map((g) => {
      const d = el("span", "cc-term");
      d.append(el("b", "", g.term), document.createTextNode(` ${g.meaning}`));
      return d;
    }));
    $("mini-cc").textContent = last && this.on ? last.text : "";
    if (!last || !this.on) $("mini-cc").classList.remove("show");
  }
}
