import "@fontsource-variable/inter/wght.css";
import "maplibre-gl/dist/maplibre-gl.css";
import "./style.css";
import maplibregl from "maplibre-gl";
import {
  ApiError, Loop, fetchAircraft, fetchAirportBoard, fetchAirports, fetchArea, fetchFullTrack, fetchPlanes, fetchWeather, serverNow, type AirportInfo,
} from "./api";
import {
  type Hit, type Plane, type Searchable, type Track, ALT_STOPS, altRamp, distanceNm, fmtAlt, formatUrl, mergePlane, parseUrl, renderPos, unwrap,
} from "./lib/core";
import { compileFilters } from "./lib/filters";
import { FOLLOW_PITCH, endsFollow, lerpBearing, smoothing } from "./lib/follow";
import { dockWidth, isPhone, mapPadding, peekHeight, slotMode } from "./lib/layout";
import type { LayerPrefs } from "./lib/prefs";
import { MetarFeed } from "./map/metar";
import { PlaneLayer } from "./map/planes";
import { Radar } from "./map/radar";
import { type Theme, buildStyle } from "./map/style";
import { nightPolygons } from "./map/sun";
import { WindLayer } from "./map/winds";
import { AirportPanel } from "./ui/airport";
import { Atc } from "./ui/atc";
import { Credits } from "./ui/attribution";
import { hydrateIcons } from "./ui/icons";
import { LayersMenu, loadPrefs } from "./ui/layers";
import { Panel } from "./ui/panel";
import { closeTopmost } from "./ui/popovers";
import { initRadarPill } from "./ui/radar-pill";
import { initSearch } from "./ui/search";
import { initStars } from "./ui/space";
import { StatusChip } from "./ui/status";
import { currentTheme, initTheme } from "./ui/theme";
import { hide, show } from "./ui/motion";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const phone = () => isPhone(innerWidth);

hydrateIcons();
initStars();
const initial = parseUrl(location.search, location.hash);
const store = new Map<string, Track>();
let selected: string | null = null;
let airportCode: string | null = null;
let follow = false;
let pendingFly: string | null = null;
let pendingAirportFly = false;
let prefs: LayerPrefs = loadPrefs();
let satellite = prefs.satellite;

// ---------- layout: the dock width and the sheet peek come from lib/layout (one source of truth, mirrored by CSS breakpoints) ----------
function applyLayout() {
  const root = document.documentElement.style;
  root.setProperty("--dock", `${dockWidth(innerWidth) || 376}px`);
  root.setProperty("--peek", `${peekHeight(innerHeight)}px`);
}
applyLayout();
addEventListener("resize", () => { applyLayout(); if (selected || airportCode) map.easeTo({ padding: padding(), duration: 0 }); updateSlot(); });

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
  attributionControl: false, // credits live behind the "i" button in the bottom row
});
map.touchZoomRotate.disableRotation();
map.keyboard.disableRotation();
const layer = new PlaneLayer(map, store);
const radar = new Radar(map);
const winds = new WindLayer(map, $("winds") as HTMLCanvasElement);
const metar = new MetarFeed(map, (s) => layer.setMetar(s));

function updateNight() {
  const src = map.getSource("night") as maplibregl.GeoJSONSource | undefined;
  src?.setData(nightPolygons(new Date(), currentTheme() === "dark" ? 1 : 0.4) as unknown as Parameters<maplibregl.GeoJSONSource["setData"]>[0]);
}
function paintLegend() {
  const stops = altRamp(currentTheme() === "dark").map(([ft, c]) => `${c} ${(ft / ALT_STOPS[ALT_STOPS.length - 1][0]) * 100}%`).join(", ");
  document.documentElement.style.setProperty("--alt-grad", `linear-gradient(90deg, ${stops})`);
}
function paintWindTone() { winds.setTone(currentTheme() === "dark", satellite); }
map.on("style.load", () => {
  layer.install(currentTheme());
  radar.install(currentTheme());
  layer.setMetarVisible(prefs.metar);
  metar.replay();
  updateNight(); paintLegend(); paintWindTone();
});
// Not "idle": live planes repaint the map continuously, so idle never comes and the splash sat out its timeout.
// The basemap tiles under the first view are what make the reveal look finished.
map.once("load", () => {
  const t0 = performance.now();
  const check = () => {
    if (map.isSourceLoaded("omt") || performance.now() - t0 > 2500) bootStep("map");
    else setTimeout(check, 60);
  };
  check();
});
setInterval(() => { if (!document.hidden) updateNight(); }, 60_000);

// ---------- toast ----------
let toastTimer: ReturnType<typeof setTimeout> | undefined;
function toast(msg: string) {
  const el = $("toast");
  el.textContent = msg; show(el);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => hide(el), 3200);
}

// ---------- data ----------
function ingest(planes: Plane[]) {
  const now = serverNow();
  for (const p of planes) mergePlane(store, p, now);
  layer.markDirty();
}
function sweep() {
  const now = serverNow();
  for (const [k, t] of store) {
    if (k === selected) continue;
    // estimated planes keep an old real `ts` on purpose; they leave when the backend stops sending them
    if (t.est ? now - (t.rts ?? t.ts) > 400 : now - t.ts > (t.gnd ? 300 : 900)) store.delete(k);
  }
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

// ---------- camera ----------
const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);
const padding = (): maplibregl.PaddingOptions => mapPadding({ w: innerWidth, h: innerHeight, panel: !!selected || !!airportCode });

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

function flyToPoint(lat: number, lon: number, zoom: number) {
  map.flyTo({ center: [lon, lat], zoom: Math.max(map.getZoom(), zoom), speed: 0.9, curve: 1.5, padding: padding(), essential: false });
}

// ---------- follow mode: gentle pitch, bearing along the track, any drag lets go ----------
let fBearing = 0, lastFollowT = 0, followEaseUntil = 0, needLevel = false;

function setFollow(on: boolean) {
  const was = follow;
  follow = on && !!selected;
  panel.setFollow(follow);
  winds.hold(follow);
  if (follow && selected) {
    const t = store.get(selected);
    if (!t) { follow = false; panel.setFollow(false); winds.hold(false); return; }
    const [lat, lon] = renderPos(t, serverNow());
    fBearing = map.getBearing();
    followEaseUntil = performance.now() + 1500;
    lastFollowT = performance.now();
    map.easeTo({ center: [lon, lat], zoom: Math.max(map.getZoom(), 7), pitch: FOLLOW_PITCH, bearing: t.trk ?? fBearing, padding: padding(), duration: 1400, easing: easeOut, essential: false });
  } else if (was) levelCamera();
}
function levelCamera() { map.easeTo({ pitch: 0, bearing: 0, padding: padding(), duration: 900, easing: easeOut, essential: false }); }

layer.onSelectedMove = (lat, lon, trk) => {
  if (!follow || performance.now() < followEaseUntil) return;
  const now = performance.now();
  fBearing = lerpBearing(fBearing, trk ?? fBearing, smoothing(now - lastFollowT, 1400));
  lastFollowT = now;
  map.jumpTo({ center: [lon, lat], bearing: fBearing });
};
map.on("movestart", (e) => {
  const type = (e as { originalEvent?: Event }).originalEvent?.type;
  if (follow && endsFollow(type)) { follow = false; needLevel = true; panel.setFollow(false); winds.hold(false); }
});
map.on("moveend", () => { if (needLevel && !follow) { needLevel = false; levelCamera(); } });

// ---------- flight card ----------
const panel = new Panel({
  onClose: () => select(null, true),
  onFollow: (on) => setFollow(on),
  onShare: () => {
    const url = location.href;
    (navigator.clipboard?.writeText(url) ?? Promise.reject()).then(() => toast("Lien copié"), () => window.prompt("Copier le lien", url));
  },
  onFullTrack: () => void toggleFullTrack(),
});

/** FR24 full track (40 credits): only on an explicit click, then drawn and framed. */
let fullTrackShown = false;
const FT_ERRORS: Record<string, string> = {
  budget: "Crédits Flightradar24 épuisés pour aujourd’hui", rate: "Flightradar24 est sollicité, réessayez dans une minute",
  not_found: "Flightradar24 n’a pas ce vol en direct", disabled: "Flightradar24 n’est pas activé", auth_error: "Flightradar24 est indisponible",
};
async function toggleFullTrack() {
  const hex = selected;
  if (!hex) return;
  if (fullTrackShown) { fullTrackShown = false; layer.setFullTrack(null); panel.setFullTrack("idle"); return; }
  panel.setFullTrack("loading");
  try {
    const r = await fetchFullTrack(hex);
    if (hex !== selected) return;
    if (r.points.length < 2) throw new ApiError(404, "not_found");
    fullTrackShown = true;
    layer.setFullTrack(r.points);
    panel.setFullTrack("shown");
    const ll = unwrap(r.points.map((p) => [p[1], p[0]] as [number, number]));
    const b = new maplibregl.LngLatBounds(ll[0], ll[0]);
    for (const p of ll) b.extend(p);
    const pad = mapPadding({ w: innerWidth, h: innerHeight, panel: true });
    map.fitBounds(b, { padding: { top: 96 + pad.top, bottom: 96 + pad.bottom, left: 64 + pad.left, right: 64 + pad.right }, maxZoom: 7, duration: 1200, essential: false });
  } catch (e) {
    if (hex !== selected) return;
    panel.setFullTrack("idle");
    toast((e instanceof ApiError && e.reason && FT_ERRORS[e.reason]) || "Trajectoire complète indisponible");
  }
}

function syncDock() {
  document.body.classList.toggle("dock-open", !!selected || !!airportCode);
  updateSlot();
}

function select(hex: string | null, push: boolean) {
  if (hex === selected) return;
  const wasFollowing = follow;
  if (hex && airportCode) closeAirport(false, false);
  selected = hex;
  follow = false; winds.hold(false);
  fullTrackShown = false;
  layer.setSelected(hex);
  if (hex) {
    panel.show(store.get(hex), hex);
    detailLoop.kick(); weatherLoop.kick();
  } else {
    panel.hide();
  }
  document.title = hex ? `${store.get(hex)?.cs ?? hex.toUpperCase()} — Stratus` : "Stratus — trafic aérien en direct";
  syncDock();
  if (wasFollowing) map.easeTo({ pitch: 0, bearing: 0, padding: padding(), duration: 700, easing: easeOut, essential: false });
  else map.easeTo({ padding: padding(), duration: 420, easing: easeOut, essential: false });
  syncUrl(push);
}

// ---------- airport card ----------
interface AptInfo { icao: string; iata?: string | null; name: string | null; city: string | null; country: string | null; lat?: number; lon?: number }
const aptCache = new Map<string, AptInfo>();

const airportPanel = new AirportPanel({
  onClose: () => closeAirport(true),
  onPickFlight: (hex) => { select(hex, true); flyToPlane(hex); },
  onRadio: (icao) => atc.open(icao),
  hasRadio: (icao) => atc.airports.some((a) => a.icao === icao),
});

const aptLoop = new Loop(async () => {
  const code = airportCode;
  if (!code) return;
  try {
    const b = await fetchAirportBoard(code);
    if (code !== airportCode) return;
    airportPanel.update(b);
    layer.setAirport({ lat: b.airport.lat, lon: b.airport.lon, runways: b.airport.runways ?? [] });
    if (pendingAirportFly) { pendingAirportFly = false; flyToPoint(b.airport.lat, b.airport.lon, 9); }
  } catch (e) {
    if (code !== airportCode) return;
    if (e instanceof ApiError && e.status === 404) { toast("Aéroport introuvable"); closeAirport(true); }
    else if (e instanceof ApiError && e.status === 503) toast("Catalogue des aéroports en cours de chargement, nouvel essai…");
  }
}, () => (airportCode ? 10_000 : null));

function selectAirport(code: string, hint?: AptInfo, fly = false, push = true) {
  const c = code.toUpperCase();
  if (selected) select(null, false);
  airportCode = c;
  pendingAirportFly = fly;
  airportPanel.show(c, hint ? { icao: hint.icao, iata: hint.iata, name: hint.name, city: hint.city, country: hint.country } : {});
  syncDock();
  if (fly && hint?.lat != null && hint.lon != null) { pendingAirportFly = false; flyToPoint(hint.lat, hint.lon, 9); }
  else map.easeTo({ padding: padding(), duration: 420, easing: easeOut, essential: false });
  document.title = `${hint?.icao ?? c} — Stratus`;
  aptLoop.kick();
  syncUrl(push);
}

function closeAirport(push: boolean, ease = true) {
  if (!airportCode) return;
  airportCode = null;
  airportPanel.hide();
  layer.setAirport(null);
  syncDock();
  if (ease) { document.title = "Stratus — trafic aérien en direct"; map.easeTo({ padding: padding(), duration: 420, easing: easeOut, essential: false }); syncUrl(push); }
}

// ---------- URL ----------
let urlTimer: ReturnType<typeof setTimeout> | undefined;
function syncUrl(push = false) {
  const c = map.getCenter();
  const u = location.pathname + formatUrl({ hex: selected, apt: airportCode, ll: [c.lat, c.lng], z: map.getZoom() });
  try { push ? history.pushState(null, "", u) : history.replaceState(null, "", u); } catch { /* sandboxed */ }
}
map.on("moveend", () => {
  clearTimeout(urlTimer);
  urlTimer = setTimeout(() => syncUrl(false), 400);
  areaLoop.kick();
});
window.addEventListener("popstate", () => {
  const u = parseUrl(location.search, location.hash);
  if (u.apt) { if (airportCode !== u.apt) selectAirport(u.apt, undefined, false, false); }
  else { if (airportCode) closeAirport(false); select(u.hex, false); }
  if (u.ll) map.jumpTo({ center: [u.ll[1], u.ll[0]], zoom: u.z ?? map.getZoom() });
});

// ---------- picking, hover ----------
// Picking runs against the positions currently drawn (PlaneLayer.pick), nearest first, with a generous radius:
// planes are small and keep moving between a render and the click.
const AIRPORT_LAYERS = ["metar-dots", "airport-s0-dot", "airport-s1-dot", "airport-s2-dot", "airport-dot"];
map.on("click", (e) => {
  if ((atc.isOpen || atc.isLive) && map.getLayer("atc-dots")) {
    const a = map.queryRenderedFeatures([[e.point.x - 12, e.point.y - 12], [e.point.x + 12, e.point.y + 12]], { layers: ["atc-dots"] })[0];
    if (a) { atc.open(String(a.properties.icao)); return; }
  }
  const touch = (e.originalEvent as PointerEvent | undefined)?.pointerType === "touch" || "touches" in (e.originalEvent ?? {});
  const hex = layer.pick(e.point, touch ? 28 : 18);
  if (hex) { select(hex, true); return; }
  const r = touch ? 16 : 10;
  const layers = AIRPORT_LAYERS.filter((id) => map.getLayer(id));
  const f = layers.length ? map.queryRenderedFeatures([[e.point.x - r, e.point.y - r], [e.point.x + r, e.point.y + r]], { layers })[0] : undefined;
  const code = f ? String(f.properties?.icao || f.properties?.iata || "") : "";
  if (code) { selectAirport(code); return; }
  if (selected) select(null, true);
  else if (airportCode) closeAirport(true);
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
        tip.lastElementChild!.textContent = [t.est ? "Estimée" : null, t.type, fmtAlt(t.alt, t.gnd)].filter(Boolean).join(" · ");
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

// ---------- ATC, status, credits ----------
let miniShown = false;
const atc: Atc = new Atc({
  onToggle: (open) => { layer.setAtcVisible(open || atc.isLive); },
  onAirports: (a) => layer.setAtc(a),
  onPick: (a) => { if (Number.isFinite(a.lat) && Number.isFinite(a.lon)) map.flyTo({ center: [a.lon, a.lat], zoom: Math.max(map.getZoom(), 7.5), speed: 0.9, curve: 1.5, essential: false }); },
  onLive: (a) => { layer.setAtcLive(a && Number.isFinite(a.lat) && Number.isFinite(a.lon) ? { lat: a.lat, lon: a.lon } : null); layer.setAtcVisible(atc.isOpen || !!a); },
  onMini: (show) => { miniShown = show; updateSlot(); },
});
const status = new StatusChip({
  areaActive: () => areaParams() !== null,
  onAlerts: (alerts) => layer.setAlerts(alerts.map((a) => a.hex)),
  onPick: (hex) => { select(hex, true); flyToPlane(hex); },
});
void status;
new Credits(() => ({ satellite, radar: radar.enabled, winds: prefs.winds, metar: prefs.metar }));

// ---------- bottom slot: radar pill or radio mini-player ----------
let radarShown = false;
function updateSlot() {
  $("slot").dataset.mode = slotMode({ mini: miniShown, radar: radarShown, phone: phone(), panel: document.body.classList.contains("dock-open") });
}

// ---------- search ----------
const atcAsApt = (key: string): AptInfo | undefined => {
  const a = atc.airports.find((x) => `apt:${x.icao}` === key);
  return a ? { icao: a.icao, name: a.name, city: a.city, country: a.country, lat: a.lat, lon: a.lon } : undefined;
};
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
const fromCatalog = (a: AirportInfo): AptInfo => ({ icao: a.icao, iata: a.iata, name: a.name, city: a.city, country: a.country, lat: a.lat, lon: a.lon });
initSearch({
  items: searchItems,
  describe: (h: Hit) => {
    if (h.kind === "airport") {
      const a = aptCache.get(h.key) ?? atcAsApt(h.key);
      if (!a) return null;
      const radio = atc.airports.some((x) => x.icao === a.icao);
      return { kind: "airport", title: a.name ?? a.icao, sub: [a.icao, a.iata, a.city].filter(Boolean).join(" · "), side: radio ? "Radio ATC" : "Aéroport" };
    }
    const t = store.get(h.key);
    return t ? { kind: "plane", title: t.cs ?? t.reg ?? t.hex.toUpperCase(), sub: [t.type, t.reg].filter(Boolean).join(" · ") || t.hex.toUpperCase(), side: t.est ? "Estimée" : fmtAlt(t.alt, t.gnd) } : null;
  },
  remote: async (q, signal) => {
    const list = await fetchAirports(q, signal);
    return list.map((a) => {
      const key = `apt:${a.icao}`;
      aptCache.set(key, fromCatalog(a));
      return { key, kind: "airport" as const, score: 40, label: "Aéroport" };
    });
  },
  pick: (h) => {
    if (h.kind === "airport") {
      const a = aptCache.get(h.key) ?? atcAsApt(h.key);
      if (a) selectAirport(a.icao, a, true);
      return;
    }
    select(h.key, true);
    flyToPlane(h.key);
  },
});

// ---------- toolbar, layers menu ----------
$("zoom-in").addEventListener("click", () => map.zoomIn({ duration: 300 }));
$("zoom-out").addEventListener("click", () => map.zoomOut({ duration: 300 }));
initTheme((t: Theme) => { map.setStyle(buildStyle(t, { satellite }), { diff: false }); radar.setTheme(t); paintWindTone(); });

const rpill = initRadarPill({ onSeek: (i) => radar.seek(i), onToggle: () => radar.toggle() });
radar.onChange = (s) => {
  radarShown = radar.enabled && s.frames > 0;
  rpill.setVisible(radarShown);
  rpill.update(s);
  updateSlot();
};
async function setRadar(on: boolean, manual: boolean) {
  if (!(await radar.set(on, currentTheme()))) {
    menu.setPref("radar", false, false);
    if (manual) toast("Radar météo indisponible");
  }
}

function applyPref(key: keyof LayerPrefs) {
  switch (key) {
    case "radar": void setRadar(prefs.radar, true); break;
    case "winds": case "windLevel": winds.set(prefs.winds, prefs.windLevel); break;
    case "metar": metar.set(prefs.metar); layer.setMetarVisible(prefs.metar); break;
    case "est": layer.setShowEstimated(prefs.est); break;
    case "satellite":
      satellite = prefs.satellite;
      // The style is rebuilt (cheap: vector tiles come from the HTTP cache) so every layer's colours match the imagery.
      map.setStyle(buildStyle(currentTheme(), { satellite }), { diff: false });
      paintWindTone();
      break;
  }
}
const menu: LayersMenu = new LayersMenu({
  onPrefs: (p, key) => { prefs = p; applyPref(key); },
  onFilters: (f) => layer.setFilter(compileFilters(f)),
});
layer.setFilter(compileFilters(menu.state.filters));
layer.setShowEstimated(prefs.est);
map.once("load", () => {
  if (prefs.radar) void setRadar(true, false);
  if (prefs.winds) winds.set(true, prefs.windLevel);
  if (prefs.metar) { metar.set(true); layer.setMetarVisible(true); }
});

// ---------- keyboard ----------
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (closeTopmost()) return;
  if (airportCode) closeAirport(true);
  else if (selected) select(null, true);
});

// ---------- go ----------
function frame(t: number) { layer.frame(t); requestAnimationFrame(frame); }
requestAnimationFrame(frame);
setInterval(() => { if (selected && !document.hidden) panel.tick(store.get(selected)); }, 1000);

planesLoop.start(); areaLoop.start(); detailLoop.start(); weatherLoop.start(); aptLoop.start();
updateSlot();
if (initial.apt) {
  selectAirport(initial.apt, undefined, !initial.ll, false);
} else if (initial.hex) {
  if (!initial.ll) pendingFly = initial.hex;
  select(initial.hex, false);
}
