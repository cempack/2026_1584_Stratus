// Map layers for aircraft: one GeoJSON source for the fleet (throttled dead reckoning, viewport culling),
// one for the selected plane (animated every frame), plus altitude-coloured trail and the route to the destination.
// Picking is done against the positions that were last handed to the GPU, so what you click is what you see.
import maplibregl from "maplibre-gl";
import type { GeoJSONSource } from "maplibre-gl";
import { type Track, greatCircle, renderPos, shapeOf, STALE_S, unwrap, type Shape } from "../lib/core";
import { type Compiled, NO_FILTERS, compileFilters } from "../lib/filters";
import { CATEGORY_COLOR, categoryOf } from "../lib/airport";
import { serverNow, type Airport, type Metar, type Runway, type TrailPoint } from "../api";
import { ICON_PIXEL_RATIO, PATHS, SHAPES, makeIcon } from "./icons";
import { EMPTY, SOURCE_IDS, buildOverlay } from "./layers";
import { restyle } from "./restyle";
import { ACCENT, type Theme } from "./style";
import { lerpBearing, smoothing } from "../lib/follow";

type Pt = [number, number];
interface Props { hex: string; icon: string; ring: string; trk: number; alt: number; op: number; sz: number; cs: string }
interface F { type: "Feature"; geometry: { type: "Point"; coordinates: Pt }; properties: Props }

const SIZE: Record<Shape, number> = { light: 0.85, jet: 1, heavy: 1.2, turboprop: 0.95, heli: 0.85, other: 0.8 };
export const accentHex = (theme: Theme) => ACCENT[theme];

const wrapDiff = (a: number, b: number) => { let d = a - b; while (d > 180) d -= 360; while (d < -180) d += 360; return d; };
const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

function pulseEl(cls: string) {
  const el = document.createElement("div");
  el.className = `pulse ${cls}`;
  el.innerHTML = "<i></i><i></i>";
  return el;
}

/** Selected plane: pulse + ring (screen-aligned) and the silhouette (rotated with the map). */
function selEl() {
  const el = document.createElement("div");
  el.className = "sel-mk";
  el.innerHTML = '<div class="pulse sel"><i></i><i></i></div><span class="sel-ring"></span>'
    + '<svg class="sel-plane" viewBox="0 0 64 64" aria-hidden="true"><path/></svg>';
  return el;
}

/** CSS px of a plane icon at zoom `z` (same ramp as the symbol layers: 120 px image at pixelRatio 4 → 30 px). */
function iconPx(z: number, k: number) {
  const stops: [number, number][] = [[2, 0.36], [5, 0.5], [8, 0.66], [11, 0.85], [15, 1.05]];
  let f = stops[0][1];
  for (let i = 1; i < stops.length; i++) {
    const [z0, f0] = stops[i - 1], [z1, f1] = stops[i];
    if (z <= z0) break;
    f = z >= z1 ? f1 : f0 + ((f1 - f0) * (z - z0)) / (z1 - z0);
  }
  return 30 * 96 / 120 * f * k; // the silhouette spans 96 of the 120 px image
}

export class PlaneLayer {
  selected: string | null = null;
  /** Called every frame with the animated position of the selected plane (before it is drawn). */
  onSelectedMove: ((lat: number, lon: number, trk: number | null) => void) | null = null;
  private cache = new Map<string, F>();
  private rendered: F[] = [];
  private dirty = true;
  private lastMain = 0;
  private lastSel = 0;
  private lastOverlay = 0;
  private inflight = 0;
  private sel: F | null = null;
  private trailPts: { c: Pt; alt: number }[] = [];
  private trailData: object = EMPTY;
  private routeData: object = EMPTY;
  private pointsData: object = EMPTY;
  private dest: Airport | null = null;
  private showRoute = false;
  private atcData: object = EMPTY;
  private atcVisible = false;
  private atcLiveData: object = EMPTY;
  private selMarker: maplibregl.Marker | null = null;
  private selShape: Shape | null = null;
  private selRot: number | null = null;
  private selPx = "";
  private selRotT = 0;
  private atcMarker: maplibregl.Marker | null = null;
  private filter: Compiled = compileFilters(NO_FILTERS);
  private showEst = true;
  private alertHex = new Set<string>();
  private alertsData: object = EMPTY;
  private fullTrackData: object = EMPTY;
  private aptData: object = EMPTY;
  private metarData: object = EMPTY;
  private metarVisible = false;
  private fadeBase = new Map<string, unknown>();

  constructor(private map: maplibregl.Map, private store: Map<string, Track>) {
    map.on("sourcedata", (e) => { if (e.sourceId === "planes" && e.isSourceLoaded) this.inflight = 0; });
    map.on("moveend", () => (this.dirty = true));
    map.on("zoomend", () => (this.dirty = true));
  }

  /** (Re)create images, sources and layers. Safe to call after every style load. */
  install(theme: Theme) {
    const m = this.map;
    for (const s of SHAPES) {
      if (!m.hasImage(`plane-${s}`)) m.addImage(`plane-${s}`, makeIcon(s), { sdf: true, pixelRatio: ICON_PIXEL_RATIO });
      if (!m.hasImage(`ring-${s}`)) m.addImage(`ring-${s}`, makeIcon(s, true), { sdf: true, pixelRatio: ICON_PIXEL_RATIO });
    }
    const { sources, layers } = buildOverlay(theme, { atcVisible: this.atcVisible, metarVisible: this.metarVisible });
    for (const [id, spec] of Object.entries(sources)) if (!m.getSource(id)) m.addSource(id, spec);
    for (const l of layers) if (!m.getLayer(l.id)) m.addLayer(l);
    const cache: Record<string, object> = {
      trail: this.trailData, route: this.routeData, points: this.pointsData, atc: this.atcData, "atc-live": this.atcLiveData,
      alerts: this.alertsData, fulltrack: this.fullTrackData, apt: this.aptData, metar: this.metarData,
    };
    for (const id of SOURCE_IDS) if (id in cache) this.push(id, cache[id]);
    this.dirty = true;
  }

  /** Theme change without a style reload. */
  retheme(from: Theme, to: Theme) {
    restyle(this.map, buildOverlay(from).layers, buildOverlay(to).layers);
    this.fadeBase.clear(); // remembered opacities belong to the old theme's paint
  }

    private push(id: string, data: object) { (this.map.getSource(id) as GeoJSONSource | undefined)?.setData(data as Parameters<GeoJSONSource["setData"]>[0]); }

  setSelected(hex: string | null) {
    this.selected = hex;
    this.head = null;
    this.sel = null;
    this.dirty = true;
    this.setDetail([], null, null, false);
    this.setFullTrack(null);
    this.selMarker?.remove(); this.selMarker = null; this.selShape = null; this.selRot = null; this.selPx = "";
  }

  setAtc(points: { icao: string; lat: number; lon: number }[]) {
    this.atcData = { type: "FeatureCollection", features: points.map((p) => ({ type: "Feature", geometry: { type: "Point", coordinates: [p.lon, p.lat] }, properties: { icao: p.icao } })) };
    this.push("atc", this.atcData);
  }
  setAtcVisible(v: boolean) {
    this.atcVisible = v;
    this.fadeLayers(["atc-dots", "atc-names"], v, () => this.atcVisible);
  }
  /** Mark the airport whose radio is playing (soft pulsing ring), or clear it. */
  setAtcLive(p: { lat: number; lon: number } | null) {
    this.atcLiveData = p ? { type: "FeatureCollection", features: [{ type: "Feature", geometry: { type: "Point", coordinates: [p.lon, p.lat] }, properties: {} }] } : EMPTY;
    this.push("atc-live", this.atcLiveData);
    if (!p) { this.atcMarker?.remove(); this.atcMarker = null; return; }
    if (!this.atcMarker) this.atcMarker = new maplibregl.Marker({ element: pulseEl("atc"), pitchAlignment: "viewport", rotationAlignment: "viewport" }).setLngLat([p.lon, p.lat]).addTo(this.map);
    else this.atcMarker.setLngLat([p.lon, p.lat]);
  }

  setFilter(c: Compiled) { this.filter = c; this.dirty = true; }
  setShowEstimated(on: boolean) { this.showEst = on; this.dirty = true; }
  /** Planes squawking 7500/7600/7700 (hex codes): drawn with a thin red ring. */
  setAlerts(hexes: Iterable<string>) {
    this.alertHex = new Set(hexes); this.dirty = true;
    if (!this.alertHex.size) { this.alertsData = EMPTY; this.push("alerts", EMPTY); }
  }

  /** FR24 full track (points are [lat, lon, alt, ts]); null clears it. */
  setFullTrack(points: TrailPoint[] | null) {
    const feats: object[] = [];
    if (points && points.length > 1) {
      const ll = unwrap(points.map((p) => [p[1], p[0]] as Pt));
      for (let i = 1; i < ll.length; i++) {
        feats.push({ type: "Feature", geometry: { type: "LineString", coordinates: [ll[i - 1], ll[i]] }, properties: { alt: ((points[i - 1][2] ?? 0) + (points[i][2] ?? 0)) / 2 } });
      }
    }
    this.fullTrackData = feats.length ? { type: "FeatureCollection", features: feats } : EMPTY;
    this.push("fulltrack", this.fullTrackData);
  }

  /** Highlight an airport: a soft ring and its runways. */
  setAirport(a: { lat: number; lon: number; runways: Runway[] } | null) {
    const feats: object[] = [];
    if (a) {
      feats.push({ type: "Feature", geometry: { type: "Point", coordinates: [a.lon, a.lat] }, properties: {} });
      for (const r of a.runways) {
        if (r.le_lat == null || r.le_lon == null || r.he_lat == null || r.he_lon == null) continue;
        feats.push({ type: "Feature", geometry: { type: "LineString", coordinates: [[r.le_lon, r.le_lat], [r.he_lon, r.he_lat]] }, properties: {} });
      }
    }
    this.aptData = feats.length ? { type: "FeatureCollection", features: feats } : EMPTY;
    this.push("apt", this.aptData);
  }

  /** Flight-category dots (stations without a category are left out). */
  setMetar(stations: Metar[]) {
    const feats = stations.flatMap((s) => {
      const cat = categoryOf(s);
      return cat && s.lat != null && s.lon != null
        ? [{ type: "Feature", geometry: { type: "Point", coordinates: [s.lon, s.lat] }, properties: { icao: s.icao, cat, color: CATEGORY_COLOR[cat] } }]
        : [];
    });
    this.metarData = { type: "FeatureCollection", features: feats };
    this.push("metar", this.metarData);
  }
  setMetarVisible(v: boolean) {
    this.metarVisible = v;
    this.fadeLayers(["metar-dots", "metar-labels"], v, () => this.metarVisible);
  }

  /** Fade layers in or out instead of snapping their visibility. `still` re-checks the wish before hiding for good. */
  private fadeLayers(ids: string[], on: boolean, still: () => boolean) {
    const m = this.map;
    const props = (id: string) => (m.getLayer(id)?.type === "circle" ? ["circle-opacity", "circle-stroke-opacity"] : ["text-opacity", "icon-opacity"]);
    const apply = (dur: number, zero: boolean) => {
      for (const id of ids) {
        if (!m.getLayer(id)) continue;
        for (const p of props(id)) {
          const key = `${id}|${p}`;
          if (!this.fadeBase.has(key)) this.fadeBase.set(key, m.getPaintProperty(id, p) ?? 1);
          m.setPaintProperty(id, `${p}-transition`, { duration: dur, delay: 0 });
          m.setPaintProperty(id, p, zero ? 0 : this.fadeBase.get(key));
        }
      }
    };
    if (reducedMotion()) {
      for (const id of ids) if (m.getLayer(id)) m.setLayoutProperty(id, "visibility", on ? "visible" : "none");
      return;
    }
    if (on) {
      apply(0, true);
      for (const id of ids) if (m.getLayer(id)) m.setLayoutProperty(id, "visibility", "visible");
      requestAnimationFrame(() => { if (still()) apply(320, false); });
    } else {
      apply(200, true);
      setTimeout(() => { if (!still()) for (const id of ids) if (m.getLayer(id)) m.setLayoutProperty(id, "visibility", "none"); }, 220);
    }
  }

  /** Trail + route endpoints from the latest detail response. `showRoute` is false when the route is unconfirmed. */
  setDetail(trail: TrailPoint[], origin: Airport | null, dest: Airport | null, showRoute: boolean) {
    const ll = unwrap(trail.map((p) => [p[1], p[0]] as Pt));
    this.trailPts = trail.map((p, i) => ({ c: ll[i], alt: p[2] ?? 0 }));
    this.dest = dest; this.showRoute = showRoute && !!origin && !!dest;
    const pts: object[] = [];
    if (this.showRoute) for (const a of [origin!, dest!]) {
      pts.push({ type: "Feature", geometry: { type: "Point", coordinates: [a.lon, a.lat] }, properties: { name: a.iata ?? a.icao } });
    }
    this.pointsData = { type: "FeatureCollection", features: pts };
    this.push("points", this.pointsData);
    this.refreshOverlay(true);
  }

  private head: { lat: number; lon: number; alt: number; est: boolean } | null = null;
  private refreshOverlay(force = false, t = performance.now()) {
    if (!force && t - this.lastOverlay < (this.moving() ? 600 : 300)) return;
    this.lastOverlay = t;
    const feats: object[] = [];
    const pts = this.trailPts;
    for (let i = 1; i < pts.length; i++) {
      feats.push({ type: "Feature", geometry: { type: "LineString", coordinates: [pts[i - 1].c, pts[i].c] }, properties: { alt: (pts[i - 1].alt + pts[i].alt) / 2 } });
    }
    const h = this.head;
    if (h && pts.length) {
      const last = pts[pts.length - 1].c;
      let lon = h.lon;
      while (lon - last[0] > 180) lon -= 360;
      while (lon - last[0] < -180) lon += 360;
      feats.push({ type: "Feature", geometry: { type: "LineString", coordinates: [last, [lon, h.lat]] }, properties: { alt: h.alt, est: h.est } });
    }
    this.trailData = { type: "FeatureCollection", features: feats };
    this.push("trail", this.trailData);

    const rf: object[] = [];
    if (h && this.showRoute && this.dest) {
      rf.push({ type: "Feature", geometry: { type: "LineString", coordinates: greatCircle([h.lat, h.lon], [this.dest.lat, this.dest.lon], 48) }, properties: {} });
    }
    this.routeData = { type: "FeatureCollection", features: rf };
    this.push("route", this.routeData);
  }

  markDirty() { this.dirty = true; }

  /** Camera in motion (drag, flyTo…): fleet updates are throttled so tile decoding gets the workers and the main thread. */
  private moving() { return this.map.isMoving() || this.map.isEasing(); }

  private shapes = new Map<string, Shape>();
  private shapeFor(cat: string | null, type: string | null): Shape {
    const k = `${cat}|${type}`;
    let s = this.shapes.get(k);
    if (!s) { s = shapeOf(cat, type); this.shapes.set(k, s); }
    return s;
  }

  private feature(t: Track, now: number, shape: Shape): F {
    let f = this.cache.get(t.hex);
    if (!f) {
      f = { type: "Feature", geometry: { type: "Point", coordinates: [0, 0] }, properties: { hex: t.hex, icon: "", ring: "", trk: 0, alt: 0, op: 1, sz: 1, cs: "" } };
      this.cache.set(t.hex, f);
    }
    const p = f.properties;
    const [lat, lon] = renderPos(t, now);
    f.geometry.coordinates[0] = lon; f.geometry.coordinates[1] = lat;
    p.icon = `plane-${shape}`; p.ring = `ring-${shape}`; p.sz = SIZE[shape];
    p.trk = t.trk ?? 0; p.alt = t.gnd ? 0 : t.alt ?? 0; p.cs = t.cs ?? "";
    p.op = t.est ? 1 : now - t.ts > STALE_S ? 0.3 : t.gnd ? 0.55 : 1;
    return f;
  }

  private mainInterval(z: number) { return z < 3.5 ? 4000 : z < 5 ? 1500 : z < 7 ? 700 : z < 9 ? 300 : 150; }

  /**
   * Nearest plane to a screen point, among what is currently drawn (fleet positions as last pushed + the animated
   * selected plane). Returns the hex or null. `radius` in CSS px.
   */
  pick(pt: { x: number; y: number }, radius: number): string | null {
    const m = this.map;
    const c = m.unproject([pt.x, pt.y]);
    if (!Number.isFinite(c.lat) || !Number.isFinite(c.lng)) return null;
    const a = m.unproject([pt.x + radius, pt.y]), b = m.unproject([pt.x, pt.y + radius]);
    const dLat = Math.max(Math.abs(a.lat - c.lat), Math.abs(b.lat - c.lat)) * 1.7 + 0.01;
    const dLon = Math.max(Math.abs(wrapDiff(a.lng, c.lng)), Math.abs(wrapDiff(b.lng, c.lng))) * 1.7 + 0.01;
    let best: string | null = null, bd = radius * radius;
    const test = (f: F) => {
      const [lon, lat] = f.geometry.coordinates;
      if (Math.abs(lat - c.lat) > dLat || Math.abs(wrapDiff(lon, c.lng)) > dLon) return;
      const p = m.project([lon, lat]);
      // ground traffic is drawn faint and small: it loses ties against airborne aircraft
      const d = (p.x - pt.x) ** 2 + (p.y - pt.y) ** 2 + (f.properties.op < 0.6 ? 16 : 0);
      if (d < bd) { bd = d; best = f.properties.hex; }
    };
    for (const f of this.rendered) test(f);
    if (this.sel) test(this.sel);
    return best;
  }

  /** Call from requestAnimationFrame. Cheap unless an update is due. */
  frame(t: number) {
    const now = serverNow();
    const moving = this.moving();
    if (this.selected) this.frameSelected(t, now);
    const z = this.map.getZoom();
    if (this.inflight && t - this.inflight > 2000) this.inflight = 0;
    const interval = moving ? Math.max(450, this.mainInterval(z)) : this.mainInterval(z);
    if (this.inflight || (!this.dirty && t - this.lastMain < interval) || t - this.lastMain < (moving ? 450 : 90)) return;
    this.lastMain = t; this.dirty = false;
    this.updateMain(now, z);
  }

  /**
   * The selected plane, every frame. Order matters: the camera (follow mode) moves first, then the marker is placed
   * against that same camera, so both land in the same paint and the plane cannot drift or jerk on screen.
   */
  private frameSelected(t: number, now: number) {
    const tr = this.store.get(this.selected!);
    if (!tr) return;
    const [lat, lon] = renderPos(tr, now);
    const shape = this.shapeFor(tr.cat, tr.type);
    const f = (this.sel ??= { type: "Feature", geometry: { type: "Point", coordinates: [0, 0] }, properties: { hex: tr.hex, icon: "", ring: "", trk: 0, alt: 0, op: 1, sz: 1, cs: "" } });
    f.geometry.coordinates = [lon, lat];
    f.properties.op = tr.est ? 0.6 : 1;
    this.onSelectedMove?.(lat, lon, tr.trk);
    if (!this.selMarker) {
      this.selMarker = new maplibregl.Marker({ element: selEl(), rotationAlignment: "map", pitchAlignment: "map" }).setLngLat([lon, lat]).addTo(this.map);
    }
    const el = this.selMarker.getElement();
    if (shape !== this.selShape) {
      this.selShape = shape;
      el.querySelector("path")!.setAttribute("d", PATHS[shape]);
      el.style.setProperty("--sz", String(SIZE[shape]));
    }
    const px = `${iconPx(this.map.getZoom(), 1.35 * SIZE[shape]).toFixed(1)}px`;
    if (px !== this.selPx) { this.selPx = px; el.style.setProperty("--px", px); } // no style write when unchanged
    el.classList.toggle("est", !!tr.est);
    // heading changes arrive in steps (one per fix): turn the icon smoothly instead of snapping
    const trk = tr.trk ?? this.selRot ?? 0;
    this.selRot = this.selRot == null ? trk : lerpBearing(this.selRot, trk, smoothing(t - this.selRotT, 300));
    this.selRotT = t;
    this.selMarker.setLngLat([lon, lat]).setRotation(this.selRot);
    if (t - this.lastSel >= 100) {
      this.lastSel = t;
      this.head = { lat, lon, alt: tr.gnd ? 0 : tr.alt ?? 0, est: !!tr.est };
      this.refreshOverlay(false, t);
    }
  }

  private updateMain(now: number, z: number) {
    const feats: F[] = [], est: F[] = [], alerts: object[] = [];
    const all = z < 3.5;
    let w = 0, s = 0, n = 0, span = 0;
    if (!all) {
      const b = this.map.getBounds();
      const dLat = (b.getNorth() - b.getSouth()) * 0.25;
      s = b.getSouth() - dLat; n = b.getNorth() + dLat;
      span = b.getEast() - b.getWest();
      const pad = span * 0.25;
      w = b.getWest() - pad; span += pad * 2;
      if (span >= 360) span = 360;
    }
    const showGround = z >= 7, flt = this.filter, showEst = this.showEst, hasAlerts = this.alertHex.size > 0;
    for (const tr of this.store.values()) {
      if (tr.hex === this.selected) continue;
      if (tr.gnd && !showGround) continue;
      if (tr.est && !showEst) continue;
      if (!all) {
        if (tr.lat < s || tr.lat > n) continue;
        if (span < 360 && ((((tr.lon - w) % 360) + 360) % 360) > span) continue;
      }
      const shape = this.shapeFor(tr.cat, tr.type);
      if (flt.active && !flt.test(tr.alt, tr.gnd, tr.cs, shape)) continue;
      const f = this.feature(tr, now, shape);
      (tr.est ? est : feats).push(f);
      if (hasAlerts && this.alertHex.has(tr.hex)) alerts.push({ type: "Feature", geometry: { type: "Point", coordinates: [f.geometry.coordinates[0], f.geometry.coordinates[1]] }, properties: {} });
    }
    if (this.cache.size > this.store.size * 1.5 + 200) for (const k of this.cache.keys()) if (!this.store.has(k)) this.cache.delete(k);
    this.rendered = est.length ? feats.concat(est) : feats;
    this.inflight = performance.now();
    this.push("planes", { type: "FeatureCollection", features: feats });
    this.push("planes-est", { type: "FeatureCollection", features: est });
    if (hasAlerts || this.alertsData !== EMPTY) {
      this.alertsData = alerts.length ? { type: "FeatureCollection", features: alerts } : EMPTY;
      this.push("alerts", this.alertsData);
    }
  }
}
