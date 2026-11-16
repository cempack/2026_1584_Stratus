import "@fontsource-variable/inter/wght.css";
import "maplibre-gl/dist/maplibre-gl.css";
import "./style.css";
import maplibregl from "maplibre-gl";
import { Loop, fetchAircraft, fetchArea, fetchPlanes, fetchWeather, serverNow } from "./api";
import {
  type Hit, type Plane, type Searchable, type Track, distanceNm, fmtAlt, formatUrl, mergePlane, parseUrl, renderPos,
} from "./lib/core";
import { PlaneLayer } from "./map/planes";
import { Radar } from "./map/radar";
import { buildStyle } from "./map/style";
import { Atc } from "./ui/atc";
import { hydrateIcons } from "./ui/icons";
import { Panel } from "./ui/panel";
import { initSearch } from "./ui/search";
import { StatusChip } from "./ui/status";
import { currentTheme, initTheme } from "./ui/theme";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const isMobile = () => matchMedia("(max-width: 719px)").matches;
const lsGet = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k: string, v: string | null) => { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* private mode */ } };

hydrateIcons();
const initial = parseUrl(location.search, location.hash);
const store = new Map<string, Track>();
let selected: string | null = null;
let follow = false;
let pendingFly: string | null = null;

// ---------- map ----------
const map = new maplibregl.Map({
  container: "map",
  style: buildStyle(currentTheme()),
  center: initial.ll ? [initial.ll[1], initial.ll[0]] : [6, 46],
  zoom: initial.z ?? 3.4,
  minZoom: 1.3,
  maxZoom: 16,
  dragRotate: false,
  pitchWithRotate: false,
  attributionControl: { compact: true, customAttribution: "Vols : OpenSky · adsb.lol · adsb.fi · Planespotters" },
});
map.touchZoomRotate.disableRotation();
map.keyboard.disableRotation();
const layer = new PlaneLayer(map, store);
const radar = new Radar(map);
map.on("style.load", () => { layer.install(currentTheme()); radar.install(); });

// ---------- toast ----------
let toastTimer: ReturnType<typeof setTimeout> | undefined;
function toast(msg: string) {
  const el = $("toast");
  el.textContent = msg; el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 2600);
}

// ---------- data ----------
function ingest(planes: Plane[]) {
  const now = serverNow();
  for (const p of planes) mergePlane(store, p, now);
  layer.markDirty();
}
function sweep() {
  const now = serverNow();
  for (const [k, t] of store) if (k !== selected && now - t.ts > (t.gnd ? 300 : 900)) store.delete(k);
}

/** Viewport query for the 5 s area feed; null when the visible radius is above 250 NM. */
function areaParams(): { lat: number; lon: number; r: number } | null {
  if (map.getZoom() < 4) return null;
  const b = map.getBounds(), c = map.getCenter();
  const r = distanceNm([c.lat, c.lng], [b.getNorth(), b.getEast()]);
  return r <= 250 ? { lat: c.lat, lon: c.lng, r } : null;
}

let planesFailed = false;
const planesLoop = new Loop(async () => {
  try {
    const p = await fetchPlanes();
    if (p) { ingest(p); sweep(); }
    planesFailed = false;
  } catch {
    if (!planesFailed) toast("Impossible de joindre le serveur");
    planesFailed = true;
  }
}, () => 15_000);

const areaLoop = new Loop(async () => {
  const a = areaParams();
  if (a) ingest(await fetchArea(a.lat, a.lon, a.r));
}, () => (areaParams() ? 5_000 : null), 1_200);

const detailLoop = new Loop(async () => {
  const hex = selected;
  if (!hex) return;
  const d = await fetchAircraft(hex);
  if (hex !== selected) return;
  if (!d) {
    if (!store.has(hex)) { toast("Avion introuvable"); select(null, true); }
    return;
  }
  mergePlane(store, d.plane, serverNow());
  layer.markDirty();
  const r = d.route;
  layer.setDetail(d.trail, r?.origin ?? null, r?.destination ?? null, !!r && r.plausible);
  panel.render(store.get(hex), d);
  if (pendingFly === hex) { pendingFly = null; flyToPlane(hex); }
}, () => (selected ? 3_000 : null));

const weatherLoop = new Loop(async () => {
  const t = selected ? store.get(selected) : undefined;
  if (!t) return;
  const [lat, lon] = renderPos(t, serverNow());
  const hex = t.hex;
  const w = await fetchWeather(lat, lon, t.alt);
  if (hex === selected) panel.setWeather(w);
}, () => (selected ? 120_000 : null));

// ---------- selection ----------
const panel = new Panel({
  onClose: () => select(null, true),
  onFollow: (on) => setFollow(on),
  onShare: () => {
    const url = location.href;
    (navigator.clipboard?.writeText(url) ?? Promise.reject()).then(() => toast("Lien copié"), () => window.prompt("Copier le lien", url));
  },
});

function setFollow(on: boolean) {
  follow = on && !!selected;
  panel.setFollow(follow);
  if (follow && selected) flyToPlane(selected);
}

function flyToPlane(hex: string) {
  const t = store.get(hex);
  if (!t) return;
  const [lat, lon] = renderPos(t, serverNow());
  map.flyTo({ center: [lon, lat], zoom: Math.max(map.getZoom(), 7), speed: 1.6, essential: true });
}

function padding(): maplibregl.PaddingOptions {
  const none = { top: 0, right: 0, bottom: 0, left: 0 };
  if (!selected) return none;
  return isMobile() ? { ...none, bottom: 200 } : { ...none, right: 368 + 32 };
}

function select(hex: string | null, push: boolean) {
  if (hex === selected) return;
  selected = hex;
  follow = false;
  layer.setSelected(hex);
  if (hex) {
    panel.show(store.get(hex), hex);
    detailLoop.kick(); weatherLoop.kick();
  } else {
    panel.hide();
  }
  document.title = hex ? `${store.get(hex)?.cs ?? hex.toUpperCase()} — Stratus` : "Stratus — trafic aérien en direct";
  map.easeTo({ padding: padding(), duration: 240 });
  syncUrl(push);
}

layer.onSelectedMove = (lat, lon) => { if (follow) map.jumpTo({ center: [lon, lat] }); };
map.on("movestart", (e) => { if (follow && (e as { originalEvent?: unknown }).originalEvent) { follow = false; panel.setFollow(false); } });

// ---------- URL ----------
let urlTimer: ReturnType<typeof setTimeout> | undefined;
function syncUrl(push = false) {
  const c = map.getCenter();
  const u = location.pathname + formatUrl({ hex: selected, ll: [c.lat, c.lng], z: map.getZoom() });
  try { push ? history.pushState(null, "", u) : history.replaceState(null, "", u); } catch { /* sandboxed */ }
}
map.on("moveend", () => {
  clearTimeout(urlTimer);
  urlTimer = setTimeout(() => syncUrl(false), 400);
  areaLoop.kick();
});
window.addEventListener("popstate", () => {
  const u = parseUrl(location.search, location.hash);
  select(u.hex, false);
  if (u.ll) map.jumpTo({ center: [u.ll[1], u.ll[0]], zoom: u.z ?? map.getZoom() });
});

// ---------- picking, hover ----------
function pickPlane(pt: maplibregl.Point, r: number): string | null {
  if (!map.getLayer("planes") || !map.getLayer("sel-icon")) return null;
  const feats = map.queryRenderedFeatures([[pt.x - r, pt.y - r], [pt.x + r, pt.y + r]], { layers: ["planes", "sel-icon"] });
  let best: string | null = null, bd = Infinity;
  for (const f of feats) {
    if (f.geometry.type !== "Point") continue;
    const p = map.project(f.geometry.coordinates as [number, number]);
    const d = (p.x - pt.x) ** 2 + (p.y - pt.y) ** 2;
    if (d < bd) { bd = d; best = String(f.properties.hex); }
  }
  return best;
}

map.on("click", (e) => {
  if (atc.isOpen && map.getLayer("atc-dots")) {
    const a = map.queryRenderedFeatures([[e.point.x - 10, e.point.y - 10], [e.point.x + 10, e.point.y + 10]], { layers: ["atc-dots"] })[0];
    if (a) { atc.open(String(a.properties.icao)); return; }
  }
  const touch = (e.originalEvent as PointerEvent | undefined)?.pointerType === "touch" || "touches" in (e.originalEvent ?? {});
  const hex = pickPlane(e.point, touch ? 16 : 10);
  if (hex) select(hex, true);
  else if (selected) select(null, true);
});

const tip = $("tip");
if (matchMedia("(hover: hover)").matches) {
  let pending: maplibregl.MapMouseEvent | null = null;
  map.on("mousemove", (e) => {
    if (!pending) requestAnimationFrame(() => {
      const ev = pending!; pending = null;
      const hex = pickPlane(ev.point, 8), t = hex ? store.get(hex) : undefined;
      map.getCanvas().style.cursor = hex ? "pointer" : "";
      if (!t) { tip.hidden = true; return; }
      tip.hidden = false;
      tip.innerHTML = "<b></b><span></span>";
      tip.firstElementChild!.textContent = t.cs ?? t.reg ?? t.hex.toUpperCase();
      tip.lastElementChild!.textContent = [t.type, fmtAlt(t.alt, t.gnd)].filter(Boolean).join(" · ");
      tip.style.left = `${ev.point.x}px`; tip.style.top = `${ev.point.y}px`;
    });
    pending = e;
  });
  map.on("mouseout", () => { tip.hidden = true; });
  map.on("movestart", () => { tip.hidden = true; });
}

// ---------- ATC, status ----------
const atc: Atc = new Atc({
  onToggle: (open) => { layer.setAtcVisible(open); if (open) status.close(); },
  onAirports: (a) => layer.setAtc(a),
  onPick: (a) => map.flyTo({ center: [a.lon, a.lat], zoom: Math.max(map.getZoom(), 8), speed: 1.6 }),
});
const status: StatusChip = new StatusChip(() => areaParams() !== null, () => atc.close());

// ---------- search ----------
function* searchItems(): Generator<Searchable> {
  for (const t of store.values()) {
    yield { key: t.hex, kind: "plane", fields: [
      { value: t.cs, label: "Indicatif", weight: 1 }, { value: t.reg, label: "Immatriculation", weight: 0.9 },
      { value: t.hex, label: "Code ICAO", weight: 0.7 }, { value: t.type, label: "Type", weight: 0.4 },
    ] };
  }
  for (const a of atc.airports) {
    yield { key: `apt:${a.icao}`, kind: "airport", fields: [
      { value: a.icao, label: "ICAO", weight: 1 }, { value: a.name, label: "Nom", weight: 0.8 }, { value: a.city, label: "Ville", weight: 0.8 },
    ] };
  }
}
initSearch({
  items: searchItems,
  describe: (h: Hit) => {
    if (h.kind === "airport") {
      const a = atc.airports.find((x) => `apt:${x.icao}` === h.key);
      return a ? { kind: "airport", title: a.name, sub: [a.icao, a.city].filter(Boolean).join(" · "), side: "Radio ATC" } : null;
    }
    const t = store.get(h.key);
    return t ? { kind: "plane", title: t.cs ?? t.reg ?? t.hex.toUpperCase(), sub: [t.type, t.reg].filter(Boolean).join(" · ") || t.hex.toUpperCase(), side: fmtAlt(t.alt, t.gnd) } : null;
  },
  pick: (h) => {
    if (h.kind === "airport") {
      const a = atc.airports.find((x) => `apt:${x.icao}` === h.key);
      if (!a) return;
      map.flyTo({ center: [a.lon, a.lat], zoom: Math.max(map.getZoom(), 9), speed: 1.6 });
      atc.open(a.icao);
      return;
    }
    select(h.key, true);
    flyToPlane(h.key);
  },
});

// ---------- toolbar ----------
$("zoom-in").addEventListener("click", () => map.zoomIn({ duration: 250 }));
$("zoom-out").addEventListener("click", () => map.zoomOut({ duration: 250 }));
initTheme((t) => { map.setStyle(buildStyle(t), { diff: false }); });

const radarBtn = $("btn-radar");
radarBtn.addEventListener("click", async () => {
  const on = radarBtn.getAttribute("aria-pressed") !== "true";
  radarBtn.setAttribute("aria-pressed", String(on));
  if (!(await radar.set(on))) { radarBtn.setAttribute("aria-pressed", "false"); toast("Radar météo indisponible"); return; }
  lsSet("stratus.radar", on ? "1" : null);
});
map.on("load", async () => {
  if (lsGet("stratus.radar") === "1" && (await radar.set(true))) radarBtn.setAttribute("aria-pressed", "true");
});

// ---------- keyboard ----------
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (atc.isOpen) atc.close();
  else if (status.isOpen) status.close();
  else if (selected) select(null, true);
});

// ---------- go ----------
function frame(t: number) { layer.frame(t); requestAnimationFrame(frame); }
requestAnimationFrame(frame);
setInterval(() => { if (selected && !document.hidden) panel.tick(store.get(selected)); }, 1000);

planesLoop.start(); areaLoop.start(); detailLoop.start(); weatherLoop.start();
if (initial.hex) {
  if (!initial.ll) pendingFly = initial.hex;
  select(initial.hex, false);
}
