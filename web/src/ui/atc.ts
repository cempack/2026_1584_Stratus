// ATC radio: airport list from /api/atc/airports, audio streamed through /api/atc/audio.
import { type AtcAirport, atcAudioUrl, fetchAtc } from "../api";
import { norm } from "../lib/core";
import { icon } from "./icons";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const store = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

export interface AtcHooks { onToggle(open: boolean): void; onAirports(a: AtcAirport[]): void; onPick(a: AtcAirport): void }

export class Atc {
  airports: AtcAirport[] = [];
  private current: AtcAirport | null = null;
  private audio = new Audio();
  private loaded: Promise<void> | null = null;
  private playing = false;

  constructor(private hooks: AtcHooks) {
    this.audio.preload = "none";
    this.audio.volume = Number(store.get("stratus.atc.vol") ?? 0.8);
    $<HTMLInputElement>("atc-vol").value = String(this.audio.volume);
    $<HTMLInputElement>("atc-vol").addEventListener("input", (e) => {
      this.audio.volume = Number((e.target as HTMLInputElement).value);
      store.set("stratus.atc.vol", String(this.audio.volume));
    });
    $("atc").querySelector("[data-close]")!.addEventListener("click", () => this.close());
    $("btn-atc").addEventListener("click", () => (this.isOpen ? this.close() : this.open()));
    $("atc-q").addEventListener("input", () => this.renderList());
    $("atc-play").addEventListener("click", () => (this.playing ? this.stop() : this.play()));
    $("atc-feed").addEventListener("change", () => { if (this.playing) this.play(); this.remember(); });
    for (const [ev, msg] of [["playing", "En direct"], ["waiting", "Connexion…"], ["stalled", "Connexion…"]] as const) {
      this.audio.addEventListener(ev, () => { if (this.playing) this.state(msg); });
    }
    this.audio.addEventListener("error", () => { if (this.playing) { this.setPlaying(false); this.state("Flux indisponible"); } });
    this.load();
  }

  get isOpen() { return !$("atc").hidden; }

  private load() {
    return (this.loaded ??= fetchAtc().then((a) => {
      this.airports = a.sort((x, y) => x.name.localeCompare(y.name, "fr"));
      this.hooks.onAirports(this.airports);
      this.renderList();
      const last = store.get("stratus.atc.icao");
      const found = this.airports.find((x) => x.icao === last);
      if (found) this.select(found, false);
    }).catch(() => { this.loaded = null; $("atc-list").innerHTML = '<li class="empty">Liste indisponible</li>'; }));
  }

  open(icao?: string) {
    $("atc").hidden = false;
    $("btn-atc").setAttribute("aria-pressed", "true");
    this.hooks.onToggle(true);
    void this.load().then(() => {
      const a = icao ? this.airports.find((x) => x.icao === icao) : null;
      if (a) this.select(a, true);
    });
  }

  close() {
    $("atc").hidden = true;
    $("btn-atc").setAttribute("aria-pressed", String(this.playing));
    this.hooks.onToggle(false);
  }

  private renderList() {
    const q = norm($<HTMLInputElement>("atc-q").value);
    const rows = this.airports.filter((a) => !q || norm(`${a.icao} ${a.name} ${a.city ?? ""} ${a.country ?? ""}`).includes(q));
    const ul = $("atc-list");
    ul.replaceChildren(...rows.map((a) => {
      const li = document.createElement("li");
      li.setAttribute("role", "option");
      li.setAttribute("aria-selected", String(a === this.current));
      const b = document.createElement("b"), s = document.createElement("span");
      b.textContent = a.name; s.textContent = a.icao;
      li.append(b, s);
      li.addEventListener("click", () => { this.select(a, true); this.hooks.onPick(a); });
      return li;
    }));
    if (!rows.length) ul.innerHTML = `<li class="empty">${this.airports.length ? "Aucun aéroport" : "Chargement…"}</li>`;
  }

  select(a: AtcAirport, autoplay: boolean) {
    const changed = this.current !== a;
    this.current = a;
    store.set("stratus.atc.icao", a.icao);
    $("atc-player").hidden = false;
    $("atc-title").textContent = `${a.name} (${a.icao})`;
    const sel = $<HTMLSelectElement>("atc-feed");
    sel.replaceChildren(...a.feeds.map((f) => Object.assign(document.createElement("option"), { value: f.id, textContent: f.label })));
    const lastFeed = store.get(`stratus.atc.feed.${a.icao}`);
    if (lastFeed && a.feeds.some((f) => f.id === lastFeed)) sel.value = lastFeed;
    if (changed) { this.stop(); this.state("Arrêté"); }
    this.renderList();
    if (autoplay && a.feeds.length) this.play();
  }

  private remember() { if (this.current) store.set(`stratus.atc.feed.${this.current.icao}`, $<HTMLSelectElement>("atc-feed").value); }
  private state(s: string) { $("atc-state").textContent = s; }
  private setPlaying(p: boolean) {
    this.playing = p;
    const btn = $("atc-play");
    btn.innerHTML = icon(p ? "pause" : "play");
    btn.setAttribute("aria-label", p ? "Arrêter" : "Écouter");
    $("btn-atc").setAttribute("aria-pressed", String(p || this.isOpen));
  }

  private play() {
    const a = this.current, feed = $<HTMLSelectElement>("atc-feed").value;
    if (!a || !feed) return;
    this.remember();
    this.setPlaying(true);
    this.state("Connexion…");
    this.audio.src = atcAudioUrl(a.icao, feed);
    this.audio.play().catch(() => { if (this.playing) { this.setPlaying(false); this.state("Lecture impossible"); } });
  }

  private stop() {
    this.setPlaying(false);
    this.audio.pause();
    this.audio.removeAttribute("src");
    this.audio.load();
    this.state("Arrêté");
  }
}
