// Wind particles: a light canvas above the map, thin low-opacity streaks that drift with the wind from /api/winds.
//
// Calm on purpose: ~1 particle per 1300 px², short fading trails, 30 fps, nothing is drawn while the map moves
// (it is redrawn when the camera settles), nothing animates with prefers-reduced-motion (a still field of streaks instead).
import type maplibregl from "maplibre-gl";
import { type WindsResponse, fetchWinds } from "../api";
import { type Bbox, bboxContains, bboxKey, viewBbox } from "../lib/bbox";
import { type WindGrid, advance, degPerPixel, particleCount, sampleWind } from "../lib/winds";
import { isPhone } from "../lib/layout";

const FRAME_MS = 33;
const FADE = 0.1;
const PX_PER_KT = 0.017;
const MAX_AGE = 90;
const GRID_TTL_MS = 25 * 60_000;
const rad = Math.PI / 180;

interface Cached { at: number; bbox: Bbox; grid: WindGrid }

export class WindLayer {
  enabled = false;
  private level = "250";
  private tone = "38, 50, 72";
  private alpha = 0.3;
  private cv: HTMLCanvasElement;
  private g: CanvasRenderingContext2D | null;
  private grid: Cached | null = null;
  private cache = new Map<string, Cached>();
  private n = 0;
  private lat = new Float32Array(0);
  private lon = new Float32Array(0);
  private age = new Uint8Array(0);
  private sx = new Float32Array(0);
  private sy = new Float32Array(0);
  private dpr = 1;
  private raf = 0;
  private last = 0;
  private moving = false;
  private held = false;
  private ctl: AbortController | null = null;
  private fetchTimer: ReturnType<typeof setTimeout> | undefined;
  private reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  /** Called once data has arrived so the UI can fade the layer in; false on failure. */
  onState: ((ok: boolean) => void) | null = null;

  constructor(private map: maplibregl.Map, canvas: HTMLCanvasElement) {
    this.cv = canvas;
    this.g = canvas.getContext("2d");
    map.on("movestart", () => { if (this.held) return; this.moving = true; this.clear(); });
    map.on("moveend", () => { if (this.held) return; this.moving = false; if (this.enabled) { this.resetPoints(); this.scheduleFetch(500); this.kick(); } });
    map.on("resize", () => { if (this.enabled) { this.resize(); this.resetPoints(); } });
    document.addEventListener("visibilitychange", () => { if (!document.hidden) this.kick(); });
  }

  /** `satellite`: streaks turn white over imagery. */
  setTone(dark: boolean, satellite: boolean) {
    this.tone = dark || satellite ? "255, 255, 255" : "38, 50, 72";
    this.alpha = dark || satellite ? 0.42 : 0.3;
  }

  set(on: boolean, level = this.level) {
    this.level = level;
    if (on === this.enabled) { if (on) { this.grid = null; this.scheduleFetch(0); } return; }
    this.enabled = on;
    if (!on) {
      cancelAnimationFrame(this.raf); this.raf = 0;
      this.ctl?.abort(); clearTimeout(this.fetchTimer);
      this.cv.classList.remove("on");
      setTimeout(() => { if (!this.enabled) this.clear(); }, 950);
      return;
    }
    this.resize();
    this.resetPoints();
    this.scheduleFetch(0);
  }

  /** Pause and hide while the camera is driven continuously (follow mode); released with false. */
  hold(on: boolean) {
    if (on === this.held) return;
    this.held = on;
    if (on) { cancelAnimationFrame(this.raf); this.raf = 0; this.cv.classList.remove("on"); this.clear(); }
    else if (this.enabled) { this.moving = false; this.resetPoints(); if (this.grid) this.cv.classList.add("on"); this.kick(); }
  }

  // ----- data -----
  private scheduleFetch(ms: number) {
    clearTimeout(this.fetchTimer);
    this.fetchTimer = setTimeout(() => void this.fetch(), ms);
  }

  private async fetch() {
    if (!this.enabled) return;
    const b = this.map.getBounds();
    const bbox = viewBbox({ south: b.getSouth(), west: b.getWest(), north: b.getNorth(), east: b.getEast() }, 0.2);
    const key = `${this.level}|${bboxKey(bbox)}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < GRID_TTL_MS) { this.use(hit); return; }
    // a grid that already covers the view is good enough (wind is smooth)
    if (this.grid && Date.now() - this.grid.at < GRID_TTL_MS && bboxContains(this.grid.bbox, viewBbox({ south: b.getSouth(), west: b.getWest(), north: b.getNorth(), east: b.getEast() }, 0)) && this.gridLevel === this.level) return;
    this.ctl?.abort();
    this.ctl = new AbortController();
    try {
      const r: WindsResponse = await fetchWinds(bbox, this.level, this.ctl.signal);
      if (!this.enabled) return;
      const c: Cached = { at: Date.now(), bbox, grid: { lats: r.lats, lons: r.lons, nx: r.nx, ny: r.ny, u: r.u, v: r.v } };
      if (this.cache.size > 12) this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(key, c);
      this.use(c);
    } catch (e) {
      if ((e as Error)?.name !== "AbortError") { this.onState?.(false); this.scheduleFetch(60_000); }
    }
  }
  private gridLevel = "";

  private use(c: Cached) {
    this.grid = c; this.gridLevel = this.level;
    if (!this.held) this.cv.classList.add("on");
    this.onState?.(true);
    this.resetPoints();
    this.kick();
    this.scheduleFetch(GRID_TTL_MS);
  }

  // ----- canvas -----
  private resize() {
    const w = this.map.getContainer().clientWidth, h = this.map.getContainer().clientHeight;
    this.dpr = Math.min(1.5, devicePixelRatio || 1);
    this.cv.width = Math.round(w * this.dpr); this.cv.height = Math.round(h * this.dpr);
    const n = particleCount(w, h, isPhone(w));
    if (n !== this.n) {
      this.n = n;
      this.lat = new Float32Array(n); this.lon = new Float32Array(n); this.age = new Uint8Array(n);
      this.sx = new Float32Array(n); this.sy = new Float32Array(n);
    }
  }

  private clear() { this.g?.clearRect(0, 0, this.cv.width, this.cv.height); }

  private resetPoints() {
    for (let i = 0; i < this.n; i++) { this.age[i] = 255; this.sx[i] = NaN; }
    this.clear();
  }

  /** Dot product of the point with the point at the centre of the view: > 0 means the hemisphere facing us. */
  private facing(lat: number, lon: number, cl: { sin: number; cos: number; lon: number }): number {
    return Math.sin(lat * rad) * cl.sin + Math.cos(lat * rad) * cl.cos * Math.cos((lon - cl.lon) * rad);
  }

  private seed(i: number, w: number, h: number, cl: { sin: number; cos: number; lon: number }, globe: boolean) {
    for (let t = 0; t < 3; t++) {
      const p = this.map.unproject([Math.random() * w, Math.random() * h]);
      if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng)) continue;
      if (globe && this.facing(p.lat, p.lng, cl) < 0.12) continue;
      this.lat[i] = p.lat; this.lon[i] = p.lng; this.age[i] = Math.floor(Math.random() * MAX_AGE * 0.6);
      this.sx[i] = NaN;
      return;
    }
    this.age[i] = 255;
  }

  private kick() {
    if (!this.enabled || !this.grid || this.raf || this.moving || this.held) return;
    this.raf = requestAnimationFrame((t) => this.loop(t));
  }

  private loop(t: number) {
    this.raf = 0;
    if (!this.enabled || !this.grid || this.moving || this.held || document.hidden) return;
    if (t - this.last >= FRAME_MS) { this.last = t; this.draw(); if (this.reduced) return; }
    this.raf = requestAnimationFrame((x) => this.loop(x));
  }

  private draw() {
    const g = this.g, grid = this.grid?.grid, m = this.map;
    if (!g || !grid) return;
    const w = m.getContainer().clientWidth, h = m.getContainer().clientHeight, d = this.dpr;
    const z = m.getZoom(), dpp = degPerPixel(z), globe = z < 5.5;
    const c = m.getCenter();
    const cl = { sin: Math.sin(c.lat * rad), cos: Math.cos(c.lat * rad), lon: c.lng };
    g.setTransform(d, 0, 0, d, 0, 0);
    if (this.reduced) g.clearRect(0, 0, w, h);
    else { g.globalCompositeOperation = "destination-out"; g.fillStyle = `rgba(0,0,0,${FADE})`; g.fillRect(0, 0, w, h); g.globalCompositeOperation = "source-over"; }
    // streaks stay secondary to the aircraft: thin, and fainter on the light basemap where dark ink reads strongly
    g.lineWidth = 1; g.lineCap = "round";
    g.strokeStyle = `rgba(${this.tone}, ${(this.reduced ? 0.8 : 1) * this.alpha})`;
    g.beginPath();
    for (let i = 0; i < this.n; i++) {
      if (this.age[i] >= MAX_AGE) { this.seed(i, w, h, cl, globe); if (this.age[i] >= MAX_AGE) continue; }
      const wind = sampleWind(grid, this.lat[i], this.lon[i]);
      if (!wind) { this.age[i] = 255; continue; }
      const [u, v] = wind;
      let nlat: number, nlon: number;
      if (this.reduced) {
        // a still field: each particle is drawn once as a short streak along the wind
        [nlat, nlon] = advance(this.lat[i], this.lon[i], u, v, dpp, PX_PER_KT * 14);
        const a = m.project([this.lon[i], this.lat[i]]), b = m.project([nlon, nlat]);
        g.moveTo(a.x, a.y); g.lineTo(b.x, b.y);
        this.age[i] = 255;
        continue;
      }
      [nlat, nlon] = advance(this.lat[i], this.lon[i], u, v, dpp, PX_PER_KT);
      const p = m.project([nlon, nlat]);
      this.lat[i] = nlat; this.lon[i] = nlon; this.age[i]++;
      const inside = p.x >= -4 && p.y >= -4 && p.x <= w + 4 && p.y <= h + 4 && (!globe || this.facing(nlat, nlon, cl) > 0.1);
      if (!inside) { this.age[i] = 255; continue; }
      const px = this.sx[i], py = this.sy[i];
      if (Number.isFinite(px) && Math.abs(p.x - px) < 40 && Math.abs(p.y - py) < 40) { g.moveTo(px, py); g.lineTo(p.x, p.y); }
      this.sx[i] = p.x; this.sy[i] = p.y;
    }
    g.stroke();
  }
}
