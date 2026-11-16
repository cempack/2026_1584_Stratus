// RainViewer precipitation radar as an animated raster overlay: the past frames plus the nowcast, one raster layer per
// frame, cross-faded by animating raster-opacity (paint transitions), inserted under borders and labels.
// Colour scheme 2 ("Universal Blue") reads well on both the light and the dark basemap.
import type maplibregl from "maplibre-gl";
import type { Theme } from "./style";

interface Frame { time: number; path: string; forecast: boolean }
interface Api { host: string; radar: { past: { time: number; path: string }[]; nowcast?: { time: number; path: string }[] } }

const FADE_MS = 450;
const STEP_MS = 650;
const HOLD_MS = 1700;
const OPACITY = { dark: 0.62, light: 0.74 };

export interface RadarUi { frames: number; index: number; time: number; forecast: boolean; playing: boolean }

export class Radar {
  enabled = false;
  playing = false;
  /** Called whenever the visible frame, the frame count or the play state changes. */
  onChange: ((s: RadarUi) => void) | null = null;
  private host = "";
  private frames: Frame[] = [];
  private idx = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private refreshTimer: ReturnType<typeof setInterval> | undefined;
  private theme: Theme = "light";
  private userPaused = false;

  constructor(private map: maplibregl.Map) {
    document.addEventListener("visibilitychange", () => { if (document.hidden) this.clearTimer(); else this.schedule(); });
  }

  private async load(): Promise<Frame[]> {
    const r = await fetch("https://api.rainviewer.com/public/weather-maps.json");
    if (!r.ok) throw new Error(`${r.status}`);
    const j = (await r.json()) as Api;
    this.host = j.host;
    const past = (j.radar.past ?? []).map((f) => ({ ...f, forecast: false }));
    const next = (j.radar.nowcast ?? []).map((f) => ({ ...f, forecast: true }));
    const all = [...past, ...next];
    if (!all.length) throw new Error("no frames");
    return all;
  }

  private url(f: Frame) { return `${this.host}${f.path}/256/{z}/{x}/{y}/2/1_1.png`; }
  private id(i: number) { return `radar-${i}`; }

  /** Returns false when the radar could not be loaded. */
  async set(on: boolean, theme: Theme = this.theme): Promise<boolean> {
    this.theme = theme;
    if (!on) {
      this.enabled = false; this.playing = false;
      this.clearTimer(); clearInterval(this.refreshTimer);
      this.remove();
      this.emit();
      return true;
    }
    try { this.frames = await this.load(); } catch { return false; }
    this.enabled = true;
    this.idx = this.lastObserved();
    this.install();
    this.playing = !this.userPaused && !matchMedia("(prefers-reduced-motion: reduce)").matches;
    this.schedule();
    clearInterval(this.refreshTimer);
    this.refreshTimer = setInterval(() => { if (!document.hidden) void this.refresh(); }, 5 * 60_000);
    this.emit();
    return true;
  }

  private lastObserved() {
    let i = this.frames.length - 1;
    while (i > 0 && this.frames[i].forecast) i--;
    return i;
  }

  private async refresh() {
    try {
      const prev = this.frames[this.idx]?.time;
      this.frames = await this.load();
      this.remove(); this.idx = Math.max(0, this.frames.findIndex((f) => f.time === prev));
      if (this.idx < 0) this.idx = this.lastObserved();
      this.install(); this.emit();
    } catch { /* keep the previous frames */ }
  }

  /** (Re)add sources/layers; call after every style load. */
  install(theme: Theme = this.theme) {
    this.theme = theme;
    const m = this.map;
    if (!this.enabled || !this.frames.length || m.getSource(this.id(0))) return;
    const before = m.getLayer("border-state") ? "border-state" : undefined;
    this.frames.forEach((f, i) => {
      m.addSource(this.id(i), { type: "raster", tiles: [this.url(f)], tileSize: 256, maxzoom: 7, attribution: '<a href="https://www.rainviewer.com">RainViewer</a>' });
      m.addLayer({ id: this.id(i), type: "raster", source: this.id(i),
        paint: { "raster-opacity": i === this.idx ? OPACITY[theme] : 0, "raster-opacity-transition": { duration: FADE_MS, delay: 0 }, "raster-fade-duration": 0, "raster-resampling": "linear" } }, before);
    });
  }

  setTheme(theme: Theme) { this.theme = theme; }

  private remove() {
    const m = this.map;
    for (let i = 0; i < 64; i++) {
      if (m.getLayer(this.id(i))) m.removeLayer(this.id(i));
      if (m.getSource(this.id(i))) m.removeSource(this.id(i));
    }
  }

  private show(i: number) {
    const m = this.map;
    if (i === this.idx || !this.frames[i]) return;
    const prev = this.idx;
    this.idx = i;
    if (m.getLayer(this.id(prev))) m.setPaintProperty(this.id(prev), "raster-opacity", 0);
    if (m.getLayer(this.id(i))) m.setPaintProperty(this.id(i), "raster-opacity", OPACITY[this.theme]);
    this.emit();
  }

  /** Scrubber: show frame `i` and pause. */
  seek(i: number) { this.userPaused = true; this.playing = false; this.clearTimer(); this.show(i); this.emit(); }

  toggle() {
    if (!this.enabled) return;
    this.playing = !this.playing;
    this.userPaused = !this.playing;
    if (this.playing) { if (this.idx >= this.frames.length - 1) this.show(0); this.schedule(); } else this.clearTimer();
    this.emit();
  }

  private clearTimer() { clearTimeout(this.timer); this.timer = undefined; }
  private schedule() {
    this.clearTimer();
    if (!this.playing || !this.enabled || document.hidden || this.frames.length < 2) return;
    const last = this.idx >= this.frames.length - 1;
    this.timer = setTimeout(() => {
      this.show(this.idx >= this.frames.length - 1 ? 0 : this.idx + 1);
      this.schedule();
    }, last ? HOLD_MS : STEP_MS);
  }

  private emit() {
    const f = this.frames[this.idx];
    this.onChange?.({ frames: this.frames.length, index: this.idx, time: f?.time ?? 0, forecast: !!f?.forecast, playing: this.playing });
  }
}
