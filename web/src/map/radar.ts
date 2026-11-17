// RainViewer precipitation radar as a quiet raster underlay.
//
// Design goals (owner feedback: "ça bouge tout le temps", "on la voit beaucoup trop"):
//  - STATIC by default: only the latest observed frame is loaded and shown. It fades in once its tiles are in, and is
//    refreshed quietly every 10 minutes (the new latest frame is fetched in the background and cross-faded when loaded).
//  - The animation only runs when the user asks for it (play button), for two passes over the frames, then it settles
//    back on the latest frame and stops. Frames are fetched on demand, never more than two at a time.
//  - Subtle: low opacity, desaturated, drawn under roads, borders and labels and far under the planes.
//  - Rate limit (RainViewer ~500 tiles/min per IP): 512 px tiles, hidden layers request nothing, and repeated tile
//    errors back off for two minutes.
//
// One raster source+layer per frame (named by timestamp, so a refresh keeps the frames it already has). A frame counts
// as "ready" only when its layer is visible, a short settle time has passed and the source reports all tiles loaded:
// isSourceLoaded() is vacuously true for sources that are not in use, which is what made empty frames flash before.
import type maplibregl from "maplibre-gl";
import type { Theme } from "./style";

export interface RadarFrame { time: number; path: string; forecast: boolean }
interface Api { host: string; radar: { past: { time: number; path: string }[]; nowcast?: { time: number; path: string }[] } }

export const PAST_FRAMES = 6;
const INTRO_MS = 900;      // first fade-in and refresh cross-fade
const FADE_MS = 700;       // frame to frame cross-fade while playing
const STEP_MS = 1100;
const HOLD_MS = 1800;
const SETTLE_MS = 220;
const GIVE_UP_MS = 12_000; // a frame that is still loading after this long is shown anyway
const LOOKAHEAD = 2;
const MAX_FETCHING = 2;
const PASSES = 2;
const REFRESH_MS = 10 * 60_000;
const BACKOFF_MS = 120_000;
/** Layers the radar sits under (first one that exists): below roads, borders and labels, far below the planes. */
const UNDER = ["runway", "road-minor", "road-major", "border-state", "border-country"];
/** Far fainter than the first version: the planes are the hero. */
export const OPACITY: Record<Theme, number> = { light: 0.4, dark: 0.42 };
/** Weaker as you zoom in: the tiles stop at z6, so closer views show stretched blobs that should not outshine traffic. */
export const radarOpacity = (theme: Theme) =>
  ["interpolate", ["linear"], ["zoom"], 3, OPACITY[theme], 6, OPACITY[theme] * 0.75, 9, OPACITY[theme] * 0.55] as unknown as number;
const SATURATION = -0.45;

export const radarId = (f: Pick<RadarFrame, "time">) => `radar-${f.time}`;
/** RainViewer colour scheme 2 ("Universal Blue") at 512 px, smoothed, no snow colours. */
export const radarUrl = (host: string, f: Pick<RadarFrame, "path">) => `${host}${f.path}/512/{z}/{x}/{y}/2/1_0.png`;

/** Source + layer for one frame (pure, so tests can validate them against the style spec). */
export function radarFrameSpec(f: RadarFrame, host: string, theme: Theme, visible: boolean, shown: boolean) {
  const id = radarId(f);
  return {
    id,
    source: { type: "raster" as const, tiles: [radarUrl(host, f)], tileSize: 512, maxzoom: 6, attribution: '<a href="https://www.rainviewer.com">RainViewer</a>' },
    layer: {
      id, type: "raster" as const, source: id, layout: { visibility: visible ? "visible" as const : "none" as const },
      paint: {
        "raster-opacity": shown ? radarOpacity(theme) : 0,
        "raster-opacity-transition": { duration: INTRO_MS, delay: 0 },
        "raster-fade-duration": 160, "raster-resampling": "linear" as const, "raster-saturation": SATURATION,
      },
    },
  };
}

/** Frame indexes after `i` (wrapping), at most `n`, never `i` itself. */
export function lookahead(i: number, n: number, len: number): number[] {
  const out: number[] = [];
  for (let k = 1; k <= n && k < len; k++) out.push((i + k) % len);
  return out;
}

export interface RadarUi { frames: number; index: number; time: number; forecast: boolean; playing: boolean; loading: boolean }

export class Radar {
  enabled = false;
  /** Called whenever the visible frame, the frame count or the play/loading state changes. */
  onChange: ((s: RadarUi) => void) | null = null;
  private host = "";
  private frames: RadarFrame[] = [];
  private idx = 0;               // frame on screen
  private target = 0;            // frame we want on screen (differs from idx while it loads)
  private shown = false;         // the current frame has been faded in
  private ghost: RadarFrame | null = null; // a frame dropped by a refresh that is still on screen
  private started = false;      // playback has begun its first pass
  private playing = false;
  private passesLeft = 0;
  private since = new Map<number, number>();     // frame time -> when its layer became visible
  private holdUntil = new Map<number, number>(); // frame time -> keep the layer visible until (fading out)
  private theme: Theme = "light";
  private stepTimer: ReturnType<typeof setTimeout> | undefined;
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private refreshTimer: ReturnType<typeof setInterval> | undefined;
  private errors: number[] = [];
  private backoffUntil = 0;

  constructor(private map: maplibregl.Map) {
    map.on("error", (e) => {
      const sid = (e as { sourceId?: string }).sourceId;
      if (!sid?.startsWith("radar-")) return;
      const now = Date.now();
      this.errors = this.errors.filter((t) => now - t < 10_000); this.errors.push(now);
      if (this.errors.length >= 4 && now >= this.backoffUntil) {
        this.backoffUntil = now + BACKOFF_MS; this.errors = [];
        this.stopPlayback(); this.target = this.idx; this.sync(); this.emit();
        setTimeout(() => this.pump(), BACKOFF_MS + 100);
      }
    });
    map.on("sourcedata", (e) => { if ((e as { sourceId?: string }).sourceId?.startsWith("radar-") && this.enabled) this.pump(); });
    document.addEventListener("visibilitychange", () => { if (!document.hidden) { this.pump(); this.schedule(); } else clearTimeout(this.stepTimer); });
  }

  // ----- data -----
  private async load(): Promise<RadarFrame[]> {
    const r = await fetch("https://api.rainviewer.com/public/weather-maps.json");
    if (!r.ok) throw new Error(`${r.status}`);
    const j = (await r.json()) as Api;
    this.host = j.host;
    const past = (j.radar.past ?? []).slice(-PAST_FRAMES).map((f) => ({ ...f, forecast: false }));
    const next = (j.radar.nowcast ?? []).map((f) => ({ ...f, forecast: true }));
    const all = [...past, ...next];
    if (!all.length) throw new Error("no frames");
    return all;
  }

  private latest(frames = this.frames) {
    let i = frames.length - 1;
    while (i > 0 && frames[i].forecast) i--;
    return i;
  }

  /** Returns false when the radar could not be loaded. */
  async set(on: boolean, theme: Theme = this.theme): Promise<boolean> {
    this.theme = theme;
    if (!on) {
      this.enabled = false; this.playing = false;
      clearTimeout(this.stepTimer); clearInterval(this.pollTimer); clearInterval(this.refreshTimer);
      this.remove();
      this.emit();
      return true;
    }
    try { this.frames = await this.load(); } catch { return false; }
    this.enabled = true;
    this.idx = this.target = this.latest();
    this.install();
    clearInterval(this.refreshTimer);
    this.refreshTimer = setInterval(() => { if (!document.hidden) void this.refresh(); }, REFRESH_MS);
    clearInterval(this.pollTimer);
    this.pollTimer = setInterval(() => this.pump(), 250);
    this.emit();
    return true;
  }

  /** Quiet refresh: a newer latest frame is fetched in the background and cross-faded in once its tiles are loaded. */
  private async refresh() {
    try {
      const fresh = await this.load();
      const had = new Set(this.frames.map((f) => f.time));
      if (fresh.length === this.frames.length && fresh.every((f) => had.has(f.time))) return;
      const old = this.frames[this.idx], cur = old?.time;
      const wasLatest = this.idx === this.latest();
      this.stopPlayback();
      this.frames = fresh;
      this.addMissing();
      const at = fresh.findIndex((f) => f.time === cur);
      if (at >= 0) { this.idx = at; this.target = wasLatest && !this.playing ? this.latest() : at; }
      else {
        // the frame on screen aged out: keep its layer as a ghost until the latest frame is loaded and faded in
        this.ghost = old; this.holdUntil.set(old.time, Date.now() + 30_000);
        this.idx = this.target = this.latest(); this.shown = false; this.since.delete(fresh[this.idx].time);
      }
      this.pump(); this.emit();
    } catch { /* keep the previous frames */ }
  }

  // ----- layers -----
  private under() { return UNDER.find((id) => this.map.getLayer(id)); }

  private addFrame(f: RadarFrame, visible: boolean, shown: boolean) {
    const m = this.map, spec = radarFrameSpec(f, this.host, this.theme, visible, shown);
    if (m.getSource(spec.id)) return;
    m.addSource(spec.id, spec.source);
    m.addLayer(spec.layer, this.under());
  }

  private addMissing() { for (const f of this.frames) this.addFrame(f, false, false); }

  /** (Re)add sources/layers; call after every style load. The current frame is faded in again once loaded. */
  install(theme: Theme = this.theme) {
    this.theme = theme;
    const m = this.map;
    if (!this.enabled || !this.frames.length || m.getSource(radarId(this.frames[this.idx] ?? this.frames[0]))) return;
    this.stopPlayback();
    this.shown = false; this.since.clear(); this.holdUntil.clear();
    this.frames.forEach((f, i) => this.addFrame(f, i === this.idx, false));
    this.since.set(this.frames[this.idx].time, Date.now());
    this.target = this.idx;
  }

  /** New theme without a style reload: shown frames take the new opacity at once. */
  setTheme(theme: Theme) {
    this.theme = theme;
    const m = this.map;
    for (const f of this.frames) {
      const id = radarId(f);
      if (m.getLayer(id) && (m.getPaintProperty(id, "raster-opacity") as number) > 0) m.setPaintProperty(id, "raster-opacity", radarOpacity(theme));
    }
  }

  private remove() {
    const m = this.map;
    for (const l of m.getStyle()?.layers ?? []) if (l.id.startsWith("radar-")) m.removeLayer(l.id);
    for (const id of Object.keys(m.getStyle()?.sources ?? {})) if (id.startsWith("radar-")) m.removeSource(id);
    this.since.clear(); this.holdUntil.clear(); this.shown = false;
  }

  private setVis(f: RadarFrame, visible: boolean) {
    const m = this.map, id = radarId(f);
    if (!m.getLayer(id)) return;
    const was = m.getLayoutProperty(id, "visibility") !== "none";
    if (was === visible) return;
    m.setLayoutProperty(id, "visibility", visible ? "visible" : "none");
    if (visible) this.since.set(f.time, Date.now()); else this.since.delete(f.time);
  }

  private isVisible(f: RadarFrame) { return this.map.getLayer(radarId(f)) && this.map.getLayoutProperty(radarId(f), "visibility") !== "none"; }

  /** Loaded and settled: only meaningful for a visible layer. */
  private ready(i: number) {
    const f = this.frames[i];
    if (!f || !this.isVisible(f)) return false;
    const since = this.since.get(f.time) ?? 0, age = Date.now() - since;
    if (!since) return false;
    if (age >= GIVE_UP_MS) return true;
    return age >= SETTLE_MS && this.map.isSourceLoaded(radarId(f));
  }

  private fetching() {
    let n = 0;
    this.frames.forEach((f, i) => { if (this.isVisible(f) && !this.ready(i)) n++; });
    return n;
  }

  /** Drop layers that are not needed (no tiles requested by hidden layers) and add the ones that are, within the cap. */
  private sync() {
    const now = Date.now();
    const want: number[] = [this.idx];
    if (this.target !== this.idx) want.push(this.target);
    if (this.playing) want.push(...lookahead(this.target, LOOKAHEAD, this.frames.length));
    const calm = now < this.backoffUntil;
    this.frames.forEach((f, i) => {
      const keep = this.holdUntil.get(f.time) ?? 0;
      if (calm ? i === this.idx : want.includes(i) || now < keep) return;
      this.setVis(f, false);
    });
    if (calm) return;
    for (const i of want) {
      const f = this.frames[i];
      if (!f || this.isVisible(f)) continue;
      if (this.fetching() >= MAX_FETCHING) break;
      this.setVis(f, true);
    }
    // layers of frames dropped by a refresh, once they are no longer needed
    const keepIds = new Set(this.frames.map(radarId));
    for (const l of this.map.getStyle()?.layers ?? []) {
      if (!l.id.startsWith("radar-") || keepIds.has(l.id)) continue;
      const t = Number(l.id.slice(6));
      if (now >= (this.holdUntil.get(t) ?? 0)) { this.map.removeLayer(l.id); if (this.map.getSource(l.id)) this.map.removeSource(l.id); }
    }
  }

  private fade(f: RadarFrame, to: number, duration: number, delay = 0) {
    const m = this.map, id = radarId(f);
    if (!m.getLayer(id)) return;
    m.setPaintProperty(id, "raster-opacity-transition", { duration, delay });
    m.setPaintProperty(id, "raster-opacity", to);
  }

  /** The heartbeat: fade the first frame in, switch to the target once it is loaded, keep the fetch set small. */
  private pump() {
    if (!this.enabled || !this.frames.length) return;
    const cur = this.frames[this.idx];
    if (!cur || !this.map.getLayer(radarId(cur))) return;
    if (!this.shown) {
      if (!this.isVisible(cur) && Date.now() >= this.backoffUntil) this.setVis(cur, true);
      if (this.ready(this.idx)) {
        this.shown = true; this.fade(cur, radarOpacity(this.theme), INTRO_MS);
        if (this.ghost) { this.fade(this.ghost, 0, INTRO_MS, INTRO_MS * 0.35); this.holdUntil.set(this.ghost.time, Date.now() + INTRO_MS * 1.35 + 80); setTimeout(() => this.sync(), INTRO_MS * 1.35 + 150); this.ghost = null; }
        this.emit();
      }
    } else if (this.target !== this.idx && !this.playing && this.frames[this.target]) {
      if (Date.now() >= this.backoffUntil) this.setVis(this.frames[this.target], true);
      if (this.ready(this.target)) this.swap(this.target, INTRO_MS);
    }
    this.sync();
  }

  /** Cross-fade to frame `i`: the new one comes in, the old one leaves a little later so the map never dips. */
  private swap(i: number, ms: number) {
    const prev = this.frames[this.idx], next = this.frames[i];
    if (!next || i === this.idx) return;
    this.idx = i;
    this.fade(next, radarOpacity(this.theme), ms);
    if (prev) { this.fade(prev, 0, ms, ms * 0.35); this.holdUntil.set(prev.time, Date.now() + ms * 1.35 + 80); setTimeout(() => this.sync(), ms * 1.35 + 120); }
    this.emit();
  }

  // ----- user controls -----
  /** Scrubber: go to frame `i` (and stop playing). Shown as soon as its tiles are in. */
  seek(i: number) {
    this.stopPlayback();
    this.target = Math.max(0, Math.min(this.frames.length - 1, i));
    this.pump(); this.emit();
  }

  get isPlaying() { return this.playing; }

  /** Play two passes over the frames, then settle back on the latest observed frame. */
  toggle() {
    if (!this.enabled || this.frames.length < 2) return;
    if (this.playing) { this.stopPlayback(); this.target = this.latest(); this.pump(); this.emit(); return; }
    if (Date.now() < this.backoffUntil) return;
    this.playing = true; this.started = false; this.passesLeft = PASSES;
    this.emit();
    this.schedule(0);
  }

  private stopPlayback() { this.playing = false; this.started = false; clearTimeout(this.stepTimer); this.stepTimer = undefined; }

  private schedule(delay = STEP_MS) {
    clearTimeout(this.stepTimer);
    if (!this.playing || document.hidden) return;
    this.stepTimer = setTimeout(() => this.step(), delay);
  }

  /** One animation step: oldest frame first, each frame only once its tiles are in, then back to the latest frame. */
  private step() {
    if (!this.playing) return;
    const last = this.frames.length - 1;
    let n: number;
    if (!this.started) { this.started = true; n = 0; }
    else if (this.idx >= last) {
      if (--this.passesLeft <= 0) { this.stopPlayback(); this.target = this.latest(); this.pump(); this.emit(); return; }
      n = 0;
    } else n = this.idx + 1;
    this.target = n;
    if (n !== this.idx) { this.sync(); if (!this.ready(n)) { this.pendingStep(n); return; } }
    this.swap(n, FADE_MS);
    this.sync();
    this.schedule(n >= last ? HOLD_MS : STEP_MS);
  }

  /** The frame we want is still loading: look again shortly (a step is never taken on an empty frame). */
  private pendingStep(n: number) {
    // `started`/`passesLeft` already account for this step, so retry the same frame instead of advancing again
    clearTimeout(this.stepTimer);
    this.stepTimer = setTimeout(() => {
      if (!this.playing) return;
      this.sync();
      if (!this.ready(n)) return this.pendingStep(n);
      this.swap(n, FADE_MS); this.sync();
      this.schedule(n >= this.frames.length - 1 ? HOLD_MS : STEP_MS);
    }, 250);
  }

  private emit() {
    const i = this.target !== this.idx && !this.playing ? this.target : this.idx;
    const f = this.frames[i];
    this.onChange?.({
      frames: this.frames.length, index: i, time: f?.time ?? 0, forecast: !!f?.forecast, playing: this.playing,
      loading: this.enabled && (!this.shown || this.target !== this.idx),
    });
  }
}
