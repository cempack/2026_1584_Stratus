// Map layers for aircraft: one GeoJSON source for the fleet (throttled dead reckoning, viewport culling),
// one for the selected plane (animated every frame), plus altitude-coloured trail and the route to the destination.
// Picking is done against the positions that were last handed to the GPU, so what you click is what you see.
import maplibregl from "maplibre-gl";
import type { GeoJSONSource } from "maplibre-gl";
import { type Track, altRamp, greatCircle, renderPos, shapeOf, STALE_S, unwrap, type Shape } from "../lib/core";
import { serverNow, type Airport, type TrailPoint } from "../api";
import { SHAPES, makeIcon } from "./icons";
import { ACCENT, type Theme } from "./style";

type Pt = [number, number];
interface Props { hex: string; icon: string; trk: number; alt: number; op: number; sz: number; cs: string }
interface F { type: "Feature"; geometry: { type: "Point"; coordinates: Pt }; properties: Props }
const EMPTY = { type: "FeatureCollection", features: [] } as const;

const SIZE: Record<Shape, number> = { light: 0.85, jet: 1, heavy: 1.2, turboprop: 0.95, heli: 0.85, other: 0.8 };
export const accentHex = (theme: Theme) => ACCENT[theme];

const PAL = {
  dark: { halo: "#06080c", label: "#aab2c0", labelHalo: "#0e1117", route: "#F5B544", dot: "#0e1117", casing: "#05070b" },
  light: { halo: "#ffffff", label: "#4b5159", labelHalo: "#f2f3f5", route: "#D4900F", dot: "#ffffff", casing: "#ffffff" },
};

const wrapDiff = (a: number, b: number) => { let d = a - b; while (d > 180) d -= 360; while (d < -180) d += 360; return d; };
const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

function pulseEl(cls: string) {
  const el = document.createElement("div");
  el.className = `pulse ${cls}`;
  el.innerHTML = "<i></i><i></i>";
  return el;
}

export class PlaneLayer {
  selected: string | null = null;
  /** Called at ~30 Hz with the animated position of the selected plane. */
  onSelectedMove: ((lat: number, lon: number) => void) | null = null;
  private cache = new Map<string, F>();
  private rendered: F[] = [];
  private dirty = true;
  private lastMain = 0;
  private lastSel = 0;
  private lastOverlay = 0;
  private inflight = 0;
  private sel: F | null = null;
  private selData: object = EMPTY;
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
  private atcMarker: maplibregl.Marker | null = null;

  constructor(private map: maplibregl.Map, private store: Map<string, Track>) {
    map.on("sourcedata", (e) => { if (e.sourceId === "planes" && e.isSourceLoaded) this.inflight = 0; });
    map.on("moveend", () => (this.dirty = true));
    map.on("zoomend", () => (this.dirty = true));
  }

  /** (Re)create images, sources and layers. Safe to call after every style load. */
  install(theme: Theme) {
    const m = this.map;
    const c = PAL[theme], accent = accentHex(theme);
    for (const s of SHAPES) if (!m.hasImage(`plane-${s}`)) m.addImage(`plane-${s}`, makeIcon(s), { sdf: true, pixelRatio: 2 });
    const empty = () => ({ type: "geojson", data: EMPTY }) as const;
    for (const id of ["planes", "sel", "trail", "route", "points", "atc", "atc-live"]) if (!m.getSource(id)) m.addSource(id, empty());

    const ramp = altRamp(theme === "dark").flat();
    const altColor = ["interpolate", ["linear"], ["get", "alt"], ...ramp] as maplibregl.ExpressionSpecification;
    const size = (k: number) => ["interpolate", ["linear"], ["zoom"], 2, ["*", 0.36 * k, ["get", "sz"]], 5, ["*", 0.5 * k, ["get", "sz"]], 8, ["*", 0.66 * k, ["get", "sz"]], 11, ["*", 0.85 * k, ["get", "sz"]], 15, ["*", 1.05 * k, ["get", "sz"]]] as maplibregl.ExpressionSpecification;
    const iconLayout = (k: number) => ({
      "icon-image": ["get", "icon"], "icon-rotate": ["get", "trk"], "icon-size": size(k), "icon-allow-overlap": true, "icon-ignore-placement": true,
      "icon-rotation-alignment": "map", "icon-pitch-alignment": "map", "symbol-z-order": "source",
    }) as maplibregl.SymbolLayerSpecification["layout"];
    const font = ["Noto Sans Regular"];

    const add = (l: maplibregl.LayerSpecification) => { if (!m.getLayer(l.id)) m.addLayer(l); };
    add({ id: "route-line", type: "line", source: "route", layout: { "line-cap": "round" }, paint: { "line-color": c.route, "line-width": 1.6, "line-dasharray": [1.5, 2.5], "line-opacity": 0.85 } });
    add({ id: "trail-casing", type: "line", source: "trail", layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": c.casing, "line-opacity": 0.55, "line-width": ["interpolate", ["linear"], ["zoom"], 2, 4, 10, 6] } });
    add({ id: "trail", type: "line", source: "trail", layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": ["interpolate", ["linear"], ["coalesce", ["get", "alt"], 0], ...ramp] as maplibregl.ExpressionSpecification,
        "line-width": ["interpolate", ["linear"], ["zoom"], 2, 2, 10, 3.2] } });
    add({ id: "planes", type: "symbol", source: "planes", layout: iconLayout(1),
      paint: { "icon-color": altColor, "icon-opacity": ["get", "op"], "icon-halo-color": c.halo, "icon-halo-width": 0.8, "icon-halo-blur": 0 } });
    add({ id: "plane-labels", type: "symbol", source: "planes", minzoom: 8,
      layout: { "text-field": ["get", "cs"], "text-font": font, "text-size": 11, "text-anchor": "left", "text-offset": [1.1, 0], "text-optional": true },
      paint: { "text-color": c.label, "text-halo-color": c.labelHalo, "text-halo-width": 1.2, "text-opacity": ["get", "op"] } });
    add({ id: "airport-dots", type: "circle", source: "points", paint: { "circle-radius": 4.5, "circle-color": c.dot, "circle-stroke-color": accent, "circle-stroke-width": 1.8 } });
    add({ id: "airport-names", type: "symbol", source: "points",
      layout: { "text-field": ["get", "name"], "text-font": ["Noto Sans Bold"], "text-size": 12, "text-letter-spacing": 0.06, "text-offset": [0, -1.2], "text-anchor": "bottom", "text-allow-overlap": true },
      paint: { "text-color": accent, "text-halo-color": c.labelHalo, "text-halo-width": 1.6 } });
    add({ id: "atc-dots", type: "circle", source: "atc", minzoom: 2, layout: { visibility: this.atcVisible ? "visible" : "none" },
      paint: { "circle-radius": 3.6, "circle-color": accent, "circle-opacity": 0.85, "circle-stroke-color": c.dot, "circle-stroke-width": 1.4 } });
    add({ id: "atc-names", type: "symbol", source: "atc", minzoom: 4, layout: { "text-field": ["get", "icao"], "text-font": font, "text-size": 11, "text-offset": [0, 0.9], "text-anchor": "top", visibility: this.atcVisible ? "visible" : "none" },
      paint: { "text-color": c.label, "text-halo-color": c.labelHalo, "text-halo-width": 1.2 } });
    add({ id: "atc-live", type: "circle", source: "atc-live", paint: { "circle-radius": 5.5, "circle-color": accent, "circle-stroke-color": c.dot, "circle-stroke-width": 2 } });
    add({ id: "sel-ring", type: "circle", source: "sel", paint: { "circle-radius": 19, "circle-color": accent, "circle-opacity": 0.1, "circle-stroke-color": accent, "circle-stroke-width": 1.4, "circle-stroke-opacity": 0.9, "circle-pitch-alignment": "viewport" } });
    add({ id: "sel-icon", type: "symbol", source: "sel", layout: iconLayout(1.35),
      paint: { "icon-color": altColor, "icon-halo-color": accent, "icon-halo-width": 1.6 } });

    this.push("sel", this.selData); this.push("trail", this.trailData); this.push("route", this.routeData);
    this.push("points", this.pointsData); this.push("atc", this.atcData); this.push("atc-live", this.atcLiveData);
    this.dirty = true;
  }

  private push(id: string, data: object) { (this.map.getSource(id) as GeoJSONSource | undefined)?.setData(data as Parameters<GeoJSONSource["setData"]>[0]); }

  setSelected(hex: string | null) {
    this.selected = hex;
    this.head = null;
    this.sel = null;
    this.selData = EMPTY;
    this.push("sel", EMPTY);
    this.dirty = true;
    this.setDetail([], null, null, false);
    if (!hex) { this.selMarker?.remove(); this.selMarker = null; }
  }

  setAtc(points: { icao: string; lat: number; lon: number }[]) {
    this.atcData = { type: "FeatureCollection", features: points.map((p) => ({ type: "Feature", geometry: { type: "Point", coordinates: [p.lon, p.lat] }, properties: { icao: p.icao } })) };
    this.push("atc", this.atcData);
  }
  setAtcVisible(v: boolean) {
    this.atcVisible = v;
    for (const id of ["atc-dots", "atc-names"]) if (this.map.getLayer(id)) this.map.setLayoutProperty(id, "visibility", v ? "visible" : "none");
  }
  /** Mark the airport whose radio is playing (soft pulsing ring), or clear it. */
  setAtcLive(p: { lat: number; lon: number } | null) {
    this.atcLiveData = p ? { type: "FeatureCollection", features: [{ type: "Feature", geometry: { type: "Point", coordinates: [p.lon, p.lat] }, properties: {} }] } : EMPTY;
    this.push("atc-live", this.atcLiveData);
    if (!p) { this.atcMarker?.remove(); this.atcMarker = null; return; }
    if (!this.atcMarker) this.atcMarker = new maplibregl.Marker({ element: pulseEl("atc"), pitchAlignment: "viewport", rotationAlignment: "viewport" }).setLngLat([p.lon, p.lat]).addTo(this.map);
    else this.atcMarker.setLngLat([p.lon, p.lat]);
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

  private head: { lat: number; lon: number; alt: number } | null = null;
  private refreshOverlay(force = false, t = performance.now()) {
    if (!force && t - this.lastOverlay < (this.moving() ? 1000 : 500)) return;
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
      feats.push({ type: "Feature", geometry: { type: "LineString", coordinates: [last, [lon, h.lat]] }, properties: { alt: h.alt } });
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

  private feature(t: Track, now: number): F {
    let f = this.cache.get(t.hex);
    const shape = this.shapeFor(t.cat, t.type);
    if (!f) {
      f = { type: "Feature", geometry: { type: "Point", coordinates: [0, 0] }, properties: { hex: t.hex, icon: "", trk: 0, alt: 0, op: 1, sz: 1, cs: "" } };
      this.cache.set(t.hex, f);
    }
    const p = f.properties;
    const [lat, lon] = renderPos(t, now);
    f.geometry.coordinates[0] = lon; f.geometry.coordinates[1] = lat;
    p.icon = `plane-${shape}`; p.sz = SIZE[shape];
    p.trk = t.trk ?? 0; p.alt = t.gnd ? 0 : t.alt ?? 0; p.cs = t.cs ?? "";
    p.op = now - t.ts > STALE_S ? 0.3 : t.gnd ? 0.55 : 1;
    return f;
  }

  private mainInterval(z: number) { return z < 3 ? 2500 : z < 5 ? 1200 : z < 7 ? 600 : z < 9 ? 300 : 150; }

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
    if (this.selected && t - this.lastSel >= (moving ? 66 : 33)) {
      this.lastSel = t;
      const tr = this.store.get(this.selected);
      if (tr) {
        const [lat, lon] = renderPos(tr, now);
        const f = (this.sel ??= { type: "Feature", geometry: { type: "Point", coordinates: [0, 0] }, properties: { hex: tr.hex, icon: "", trk: 0, alt: 0, op: 1, sz: 1, cs: "" } });
        const shape = this.shapeFor(tr.cat, tr.type);
        f.geometry.coordinates = [lon, lat];
        Object.assign(f.properties, { icon: `plane-${shape}`, sz: SIZE[shape], trk: tr.trk ?? 0, alt: tr.gnd ? 0 : tr.alt ?? 0 });
        this.selData = { type: "FeatureCollection", features: [f] };
        this.push("sel", this.selData);
        this.head = { lat, lon, alt: tr.gnd ? 0 : tr.alt ?? 0 };
        this.refreshOverlay(false, t);
        if (!reducedMotion()) {
          if (!this.selMarker) this.selMarker = new maplibregl.Marker({ element: pulseEl("sel"), pitchAlignment: "viewport", rotationAlignment: "viewport" }).setLngLat([lon, lat]).addTo(this.map);
          else this.selMarker.setLngLat([lon, lat]);
        }
        this.onSelectedMove?.(lat, lon);
      }
    }
    const z = this.map.getZoom();
    if (this.inflight && t - this.inflight > 2000) this.inflight = 0;
    const interval = moving ? Math.max(450, this.mainInterval(z)) : this.mainInterval(z);
    if (this.inflight || (!this.dirty && t - this.lastMain < interval) || t - this.lastMain < (moving ? 450 : 90)) return;
    this.lastMain = t; this.dirty = false;
    this.updateMain(now, z);
  }

  private updateMain(now: number, z: number) {
    const feats: F[] = [];
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
    const showGround = z >= 7;
    for (const tr of this.store.values()) {
      if (tr.hex === this.selected) continue;
      if (tr.gnd && !showGround) continue;
      if (!all) {
        if (tr.lat < s || tr.lat > n) continue;
        if (span < 360 && ((((tr.lon - w) % 360) + 360) % 360) > span) continue;
      }
      feats.push(this.feature(tr, now));
    }
    if (this.cache.size > this.store.size * 1.5 + 200) for (const k of this.cache.keys()) if (!this.store.has(k)) this.cache.delete(k);
    this.rendered = feats;
    this.inflight = performance.now();
    this.push("planes", { type: "FeatureCollection", features: feats });
  }
}
