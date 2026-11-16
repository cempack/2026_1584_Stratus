import "@fontsource-variable/inter/wght.css";
import "maplibre-gl/dist/maplibre-gl.css";
import "./style.css";
import maplibregl from "maplibre-gl";
import { Loop, fetchAircraft, fetchArea, fetchPlanes, fetchWeather, serverNow } from "./api";
import {
  type Hit, type Plane, type Searchable, type Track, ALT_STOPS, altRamp, distanceNm, fmtAlt, formatUrl, mergePlane, parseUrl, renderPos,
} from "./lib/core";
import { PlaneLayer } from "./map/planes";
import { Radar, type RadarUi } from "./map/radar";
import { type Theme, buildStyle } from "./map/style";
import { nightPolygons } from "./map/sun";
import { Atc } from "./ui/atc";
import { hydrateIcons, icon } from "./ui/icons";
import { Panel } from "./ui/panel";
import { initSearch } from "./ui/search";
import { initStars } from "./ui/space";
import { StatusChip } from "./ui/status";
import { currentTheme, initTheme } from "./ui/theme";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const isMobile = () => matchMedia("(max-width: 719px)").matches;
const lsGet = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k: string, v: string | null) => { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* private mode */ } };

hydrateIcons();
initStars();
const initial = parseUrl(location.search, location.hash);
const store = new Map<string, Track>();
let selected: string | null = null;
let follow = false;
let pendingFly: string | null = null;
let satellite = lsGet("stratus.sat") === "1";

// ---------- boot sequence: one fade-in once the style and the first snapshot are in ----------
let bootDone = false;
const bootGates = { map: false, data: false };
function bootStep(gate: keyof typeof bootGates) {
  bootGates[gate] = true;
  if (bootDone || !(bootGates.map && bootGates.data)) return;
  bootDone = true;
  requestAnimationFrame(() => {
    document.body.classList.remove("booting");
    const boot = document.getElementById("boot");
    boot?.classList.add("done");
    setTimeout(() => boot?.remove(), 700);
  });
}
setTimeout(() => { bootGates.map = bootGates.data = true; bootStep("map"); }, 7000); // never stay behind the splash

// ---------- map ----------
const map = new maplibregl.Map({
  container: "map",
  style: buildStyle(currentTheme(), { satellite }),
  center: initial.ll ? [initial.ll[1], initial.ll[0]] : [6, 46],
  zoom: initial.z ?? 3.4,
  minZoom: 1.3,
  maxZoom: 16,
  dragRotate: false,
  pitchWithRotate: false,
  renderWorldCopies: false,
  pixelRatio: Math.min(2, window.devicePixelRatio || 1),
  canvasContextAttributes: { antialias: true },
  attributionControl: { compact: true, customAttribution: "Vols : OpenSky · adsb.lol · adsb.fi · Planespotters" },
});
map.touchZoomRotate.disableRotation();
map.keyboard.disableRotation();
const layer = new PlaneLayer(map, store);
const radar = new Radar(map);

function updateNight() {
  const src = map.getSource("night") as maplibregl.GeoJSONSource | undefined;
  src?.setData(nightPolygons(new Date(), currentTheme() === "dark" ? 1 : 0.62) as unknown as Parameters<maplibregl.GeoJSONSource["setData"]>[0]);
}
function paintLegend() {
  const stops = altRamp(currentTheme() === "dark").map(([ft, c]) => `${c} ${(ft / ALT_STOPS[ALT_STOPS.length - 1][0]) * 100}%`).join(", ");
  document.documentElement.style.setProperty("--alt-grad", `linear-gradient(90deg, ${stops})`);
}
map.on("style.load", () => {
  layer.install(currentTheme());
  radar.install(currentTheme());
  updateNight(); paintLegend();
});
map.once("load", () => { map.once("idle", () => bootStep("map")); setTimeout(() => bootStep("map"), 3500); });
setInterval(() => { if (!document.hidden) updateNight(); }, 60_000);

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
  } finally {
    bootStep("data");
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

/** Smooth camera: a short ease when the plane is already close, a proper flight when it is far. */
function flyToPlane(hex: string) {
  const t = store.get(hex);
  if (!t) return;
  const [lat, lon] = renderPos(t, serverNow());
  const z = Math.max(map.getZoom(), 6.5);
  const c = map.getCenter();
  const far = distanceNm([c.lat, c.lng], [lat, lon]) > 400;
  if (far) map.flyTo({ center: [lon, lat], zoom: z, speed: 0.9, curve: 1.5, padding: padding(), essential: false });
  else map.easeTo({ center: [lon, lat], zoom: z, duration: 900, easing: easeOut, padding: padding(), essential: false });
}
const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);

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
  map.easeTo({ padding: padding(), duration: 420, easing: easeOut, essential: false });
  syncUrl(push);
}

layer.onSelectedMove = (lat, lon) => { if (follow && !map.isEasing()) map.jumpTo({ center: [lon, lat] }); };
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
// Picking runs against the positions currently drawn (PlaneLayer.pick), nearest first, with a generous radius:
// planes are small and keep moving between a render and the click.
map.on("click", (e) => {
  if ((atc.isOpen || atc.isLive) && map.getLayer("atc-dots")) {
    const a = map.queryRenderedFeatures([[e.point.x - 12, e.point.y - 12], [e.point.x + 12, e.point.y + 12]], { layers: ["atc-dots"] })[0];
    if (a) { atc.open(String(a.properties.icao)); return; }
  }
  const touch = (e.originalEvent as PointerEvent | undefined)?.pointerType === "touch" || "touches" in (e.originalEvent ?? {});
  const hex = layer.pick(e.point, touch ? 28 : 18);
  if (hex) select(hex, true);
  else if (selected) select(null, true);
});

const tip = $("tip");
if (matchMedia("(hover: hover)").matches) {
  let pending: maplibregl.MapMouseEvent | null = null;
  map.on("mousemove", (e) => {
    if (!pending) requestAnimationFrame(() => {
      const ev = pending!; pending = null;
      if (map.isMoving()) { tip.hidden = true; return; }
      const hex = layer.pick(ev.point, 14), t = hex ? store.get(hex) : undefined;
      map.getCanvas().style.cursor = hex ? "pointer" : "";
      if (!t) { tip.hidden = true; return; }
      if (tip.dataset.hex !== t.hex) {
        tip.dataset.hex = t.hex;
        tip.innerHTML = "<b></b><span></span>";
        tip.firstElementChild!.textContent = t.cs ?? t.reg ?? t.hex.toUpperCase();
        tip.lastElementChild!.textContent = [t.type, fmtAlt(t.alt, t.gnd)].filter(Boolean).join(" · ");
      }
      tip.hidden = false;
      const w = tip.offsetWidth;
      tip.style.left = `${Math.min(ev.point.x, innerWidth - w - 28)}px`; tip.style.top = `${ev.point.y}px`;
    });
    pending = e;
  });
  map.on("mouseout", () => { tip.hidden = true; });
  map.on("movestart", () => { tip.hidden = true; });
}

// ---------- ATC, status ----------
const atc: Atc = new Atc({
  onToggle: (open) => { layer.setAtcVisible(open || atc.isLive); if (open) status.close(); },
  onAirports: (a) => layer.setAtc(a),
  onPick: (a) => { if (Number.isFinite(a.lat) && Number.isFinite(a.lon)) map.flyTo({ center: [a.lon, a.lat], zoom: Math.max(map.getZoom(), 7.5), speed: 0.9, curve: 1.5, essential: false }); },
  onLive: (a) => { layer.setAtcLive(a && Number.isFinite(a.lat) && Number.isFinite(a.lon) ? { lat: a.lat, lon: a.lon } : null); layer.setAtcVisible(atc.isOpen || !!a); },
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
      if (Number.isFinite(a.lat) && Number.isFinite(a.lon)) map.flyTo({ center: [a.lon, a.lat], zoom: Math.max(map.getZoom(), 8), speed: 0.9, curve: 1.5, essential: false });
      atc.open(a.icao);
      return;
    }
    select(h.key, true);
    flyToPlane(h.key);
  },
});

// ---------- toolbar ----------
$("zoom-in").addEventListener("click", () => map.zoomIn({ duration: 300 }));
$("zoom-out").addEventListener("click", () => map.zoomOut({ duration: 300 }));
initTheme((t: Theme) => { map.setStyle(buildStyle(t, { satellite }), { diff: false }); radar.setTheme(t); });

const satBtn = $("btn-sat");
satBtn.setAttribute("aria-pressed", String(satellite));
satBtn.addEventListener("click", async () => {
  satellite = !satellite;
  satBtn.setAttribute("aria-pressed", String(satellite));
  lsSet("stratus.sat", satellite ? "1" : null);
  // The style is rebuilt (cheap: vector tiles come from the HTTP cache) so every layer's colours match the imagery.
  map.setStyle(buildStyle(currentTheme(), { satellite }), { diff: false });
});

// radar: on by default, animated, with a small timeline
const radarBtn = $("btn-radar"), bar = $("radar-bar"), scrub = $<HTMLInputElement>("radar-scrub"), rtime = $("radar-time"), rplay = $("radar-play");
const fmtClock = (s: number) => new Date(s * 1000).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
radar.onChange = (s: RadarUi) => {
  bar.hidden = !radar.enabled;
  document.body.classList.toggle("radar-on", radar.enabled);
  scrub.max = String(Math.max(0, s.frames - 1)); scrub.value = String(s.index);
  scrub.style.setProperty("--v", `${s.frames > 1 ? (s.index / (s.frames - 1)) * 100 : 0}%`);
  rtime.textContent = s.time ? `${fmtClock(s.time)}${s.forecast ? " · prévision" : ""}` : "—";
  rtime.classList.toggle("fc", s.forecast);
  rplay.innerHTML = icon(s.playing ? "pause" : "play");
  rplay.setAttribute("aria-label", s.playing ? "Pause" : "Lecture");
};
scrub.addEventListener("input", () => radar.seek(Number(scrub.value)));
rplay.addEventListener("click", () => radar.toggle());
async function setRadar(on: boolean, manual: boolean) {
  radarBtn.setAttribute("aria-pressed", String(on));
  if (!(await radar.set(on, currentTheme()))) {
    radarBtn.setAttribute("aria-pressed", "false");
    if (manual) toast("Radar météo indisponible");
    return;
  }
  lsSet("stratus.radar", on ? null : "0"); // on is the default
}
radarBtn.addEventListener("click", () => void setRadar(radarBtn.getAttribute("aria-pressed") !== "true", true));
radarBtn.setAttribute("aria-pressed", String(lsGet("stratus.radar") !== "0"));
map.once("load", () => { if (lsGet("stratus.radar") !== "0") void setRadar(true, false); });

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
