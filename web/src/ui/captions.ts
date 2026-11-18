// Live subtitles for the ATC player (server: stratus/captions.py, Whisper large-v3-turbo on Workers AI).
//
// - Every call is transcribed, and translated to English when the frequency is in another language (RU, JA…).
// - Timed to the audio: with subtitles on the radio plays CAPTION_LAG_S behind live, and each line is revealed when
//   the playback reaches the start of its call (the caption carries the call's server time).
// - The card says what it is (AI, translated to English, may be wrong), shows the current call large with the
//   previous ones fading, and explains the jargon of the current call in French (lib/glossary).
// - The mini-player shows the current call as a bubble.
import { atcCaptionsUrl, serverNow } from "../api";
import { CAPTION_LAG_S } from "../lib/stream";
import { glossFor } from "../lib/glossary";

interface Caption { id: number; t: number; dur: number; text: string; lang: string }
type State = "off" | "loading" | "waiting" | "live" | "error" | "quota";

const KEY = "stratus.atc.cc";
const KEEP = 2; // the current call and the one before: more reads as a wall of text
const LAG_MAX_S = 16;
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
  /** The audio should play this far behind live (s) so captions are ready when their call is heard. */
  onLag(seconds: number): void;
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
  /** Seconds between a call starting (server time) and its caption arriving: how far behind live to play. */
  private delays: number[] = [];
  lag = CAPTION_LAG_S;

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
        this.learnDelay(serverNow() - (ev.t as number));
        this.pending.push(ev as Caption);
        this.reveal();
      }
    };
    es.onerror = () => { if (es.readyState === EventSource.CLOSED) this.reopen(); };
    clearInterval(this.ticker);
    this.ticker = setInterval(() => this.reveal(), 200);
  }

  /**
   * Adaptive delay: play just far enough behind live that ~80% of captions are ready before their call is heard
   * (translated feeds and long calls need more). It only grows during a session: shrinking would skip audio.
   */
  private learnDelay(d: number) {
    if (!Number.isFinite(d) || d < 0 || d > 60) return;
    this.delays = [...this.delays, d].slice(-12);
    if (this.delays.length < 2) return;
    const sorted = [...this.delays].sort((a, b) => a - b);
    const want = Math.min(LAG_MAX_S, Math.max(CAPTION_LAG_S, sorted[Math.floor(sorted.length * 0.8)] + 0.8));
    if (want > this.lag + 0.75) { this.lag = want; this.hooks.onLag(want); }
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
    $("atc-cc-meta").textContent = this.state === "quota" ? "Quota du jour atteint · modèle réduit"
      : foreign ? `${foreign} → anglais` : "Anglais";
    const msg = this.state === "loading" ? "Connexion aux sous-titres…"
      : this.state === "error" ? "Sous-titres indisponibles pour le moment"
      : !this.lines.length ? "En attente du prochain message radio…" : "";
    const last = this.lines[this.lines.length - 1];
    const gloss = last && !msg ? glossFor(last.text) : [];
    const linesEl = $("atc-cc-lines");
    if (msg) linesEl.replaceChildren(el("p", "cc-wait", msg));
    else {
      const prev = this.lines.length > 1 ? [el("p", "cc-prev", this.lines[0].text)] : [];
      // the current call, with its jargon marked in place (meanings listed underneath)
      const now = el("p", "cc-now");
      let i = 0;
      for (const g of gloss) {
        if (g.at > i) now.append(document.createTextNode(last.text.slice(i, g.at)));
        now.append(el("mark", "cc-j", last.text.slice(g.at, g.end)));
        i = g.end;
      }
      now.append(document.createTextNode(last.text.slice(i)));
      linesEl.replaceChildren(...prev, now);
    }
    $("atc-cc-gloss").replaceChildren(...gloss.flatMap((g) => [el("dt", "", g.term), el("dd", "", g.meaning)]));
    $("mini-cc").textContent = last && this.on ? last.text : "";
    if (!last || !this.on) $("mini-cc").classList.remove("show");
  }
}
