// Lookups the browser does itself (public APIs, no key, CORS allowed): each visitor uses their own rate-limit quota,
// and the answer skips the round trip through the Stratus server. The server endpoint stays as a fallback.
//
// Kept on the server: plane positions (adsb.lol / adsb.fi send no CORS headers), METAR (aviationweather: no CORS),
// photos (planespotters refuses browser requests), routes (the server cross-checks them against observed take-offs
// and uses them for estimates), OpenSky / FR24 / subtitles (keys or IP-locked).
import type { Aircraft, Weather } from "../api";

// ---------- sharing: what this browser fetched goes back to the server cache, for every other visitor ----------
// (the server validates it, only fills gaps and rate-limits per IP: stratus/contrib.py)
type Contribution = { aircraft: { hex: string; data: Aircraft | null; miss?: true }[]; weather: { lat: number; lon: number; data: Weather }[] };
let outbox: Contribution = { aircraft: [], weather: [] };
let flushTimer: ReturnType<typeof setTimeout> | undefined;

function share(kind: "aircraft" | "weather", item: Contribution["aircraft"][number] | Contribution["weather"][number]) {
  (outbox[kind] as unknown[]).push(item);
  clearTimeout(flushTimer);
  flushTimer = setTimeout(flush, 3000);
}
function flush() {
  if (!outbox.aircraft.length && !outbox.weather.length) return;
  const body = JSON.stringify({ aircraft: outbox.aircraft.slice(0, 20), weather: outbox.weather.slice(0, 20) });
  outbox = { aircraft: [], weather: [] };
  const send = () => fetch("/api/contribute", { method: "POST", headers: { "Content-Type": "application/json" }, body, keepalive: true });
  // one retry: a POST hitting a proxy hiccup is not replayed by the proxy itself
  void send().then((r) => (r.status >= 500 ? new Promise((ok) => setTimeout(ok, 1500)).then(send) : r)).catch(() => undefined);
}
if (typeof addEventListener === "function") addEventListener("pagehide", flush); // absent in tests (node)

// ---------- weather at the plane (Open-Meteo), same level choice as stratus/weather.py ----------
const METEO = "https://api.open-meteo.com/v1/forecast";
// pressure level -> approx. ISA altitude (ft)
const LEVELS: [number, number][] = [[925, 2500], [850, 4800], [700, 9900], [600, 13800], [500, 18300], [400, 23600], [300, 30100], [250, 34000], [200, 38700], [150, 44600]];
const WX_TTL_MS = 10 * 60_000;

export function pickLevel(altFt: number | null): string {
  if (altFt == null || altFt < 1500) return "surface";
  let best = LEVELS[0];
  for (const lv of LEVELS) if (Math.abs(lv[1] - altFt) < Math.abs(best[1] - altFt)) best = lv;
  return `${best[0]}hPa`;
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const wxCache = new Map<string, { at: number; w: Promise<Weather> }>();

export function weatherAt(lat: number, lon: number, altFt: number | null): Promise<Weather> {
  const level = pickLevel(altFt);
  const clat = Math.round(lat * 4) / 4, clon = Math.round(lon * 4) / 4; // 0.25° grid: neighbours share a lookup
  const key = `${clat},${clon},${level}`;
  const hit = wxCache.get(key);
  if (hit && Date.now() - hit.at < WX_TTL_MS) return hit.w;
  const names = level === "surface"
    ? ["temperature_2m", "wind_speed_10m", "wind_direction_10m", "cloud_cover"]
    : [`temperature_${level}`, `wind_speed_${level}`, `wind_direction_${level}`, `cloud_cover_${level}`];
  const url = `${METEO}?latitude=${clat}&longitude=${clon}&current=${names.join(",")}&wind_speed_unit=kn&timeformat=unixtime`;
  const w = fetch(url).then(async (r) => {
    if (!r.ok) throw new Error(`open-meteo ${r.status}`);
    const cur = ((await r.json()) as { current?: Record<string, unknown> }).current ?? {};
    const out = { temp_c: num(cur[names[0]]), wind_kt: num(cur[names[1]]), wind_dir: num(cur[names[2]]), cloud_pct: num(cur[names[3]]), level, time: num(cur.time) ?? 0 } as Weather;
    share("weather", { lat: clat, lon: clon, data: out });
    return out;
  });
  wxCache.set(key, { at: Date.now(), w });
  w.catch(() => wxCache.delete(key));
  if (wxCache.size > 300) wxCache.delete(wxCache.keys().next().value!);
  return w;
}

// ---------- aircraft registry (adsbdb), same fields as stratus/enrich.py parse_aircraft ----------
const acCache = new Map<string, Promise<Aircraft | null>>();
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

export function parseAdsbdbAircraft(body: unknown): Aircraft | null {
  const a = (body as { response?: { aircraft?: Record<string, unknown> } })?.response?.aircraft;
  if (!a || typeof a !== "object") return null;
  const manu = str(a.manufacturer), model = str(a.type), owner = str(a.registered_owner);
  return {
    registration: str(a.registration), type: str(a.icao_type), type_name: [manu, model].filter(Boolean).join(" ") || null,
    manufacturer: manu, operator: owner, operator_icao: str(a.registered_owner_operator_flag_code), owner,
    country: str(a.registered_owner_country_name),
  } as Aircraft;
}

/** Registry data for an ICAO hex, from the browser; null when unknown (404) or on failure. Cached for the session. */
export function aircraftInfo(hex: string): Promise<Aircraft | null> {
  const key = hex.toLowerCase();
  let p = acCache.get(key);
  if (!p) {
    p = fetch(`https://api.adsbdb.com/v0/aircraft/${encodeURIComponent(key)}`)
      .then(async (r) => (r.status === 404 ? null : r.ok ? parseAdsbdbAircraft(await r.json()) : Promise.reject(new Error(`adsbdb ${r.status}`))))
      // network failures reject before this point, so only a real answer (a record or a 404) is shared
      .then((ac) => { share("aircraft", ac ? { hex: key, data: ac } : { hex: key, data: null, miss: true }); return ac; })
      .catch(() => { acCache.delete(key); return null; });
    acCache.set(key, p);
  }
  return p;
}
