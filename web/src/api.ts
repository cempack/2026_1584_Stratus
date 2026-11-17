// Typed client for the v2 API (docs/architecture-v2.md) and the polling scheduler.
import { type Plane, type Snapshot, decodeRows } from "./lib/core";

export interface Airport { icao: string; iata: string | null; name: string | null; city: string | null; country: string | null; lat: number; lon: number }
export interface Aircraft { registration: string | null; type: string | null; type_name: string | null; manufacturer: string | null; operator: string | null; operator_icao: string | null; owner: string | null; country: string | null }
export interface Route {
  callsign: string | null; airline: string | null; airline_iata?: string | null; airline_icao?: string | null;
  origin: Airport | null; destination: Airport | null; plausible: boolean;
  /** Where the route comes from: FR24 (live flight), adsbdb (schedule database), or "observed" (we saw the take-off;
   *  destination unknown). The server drops database routes that do not fit the plane's position. */
  source?: "adsbdb" | "fr24" | "observed" | null; fr24_id?: string;
  /** The take-off was seen by Stratus (origin confirmed). */
  observed?: boolean;
}
export interface Photo { thumb: string; large: string; photographer: string; link: string }
export type TrailPoint = [lat: number, lon: number, alt: number | null, ts: number];
export interface Fr24Info { state: string; credits_remaining?: number | null; credits_daily?: number | null }
export interface FullTrackInfo { available: boolean; cost: number; reason: string | null }
export interface Detail {
  plane: Plane & { pos_type?: string | null; country?: string | null };
  /** Epoch seconds when the estimate started (null unless plane.est). */
  estimated_since?: number | null;
  trail: TrailPoint[]; aircraft: Aircraft | null; route: Route | null; photo: Photo | null;
  fr24?: Fr24Info | null; full_track?: FullTrackInfo | null;
}
export interface Feed { state: string; mode?: string; last_ok: number | null; next_poll?: number | null; interval?: number; credits_remaining?: number | null; credits_daily?: number | null; last_error: string | null }
export interface Status {
  planes: number; v: number; t: number; feeds: Record<string, Feed>;
  estimated?: number; alerts?: number; fr24?: Fr24Info & { credits_used?: number };
}
export interface Weather { temp_c: number | null; wind_kt: number | null; wind_dir: number | null; cloud_pct: number | null; level: string | null; time: number }
export interface AtcFeed { id: string; label: string }
export interface AtcAirport { icao: string; name: string; city: string | null; country: string | null; lat: number; lon: number; feeds: AtcFeed[] }

export interface Alert {
  hex: string; cs: string | null; squawk: string; kind: "hijack" | "radio_failure" | "emergency";
  lat: number; lon: number; alt: number | null; type: string | null; reg: string | null; gnd: boolean;
}
export interface Metar {
  icao: string; name?: string | null; lat?: number; lon?: number; time?: number | null; raw: string | null;
  wind_dir: number | null; wind_variable?: boolean; wind_kt: number | null; gust_kt: number | null;
  vis_sm?: number | null; vis_km: number | null; ceiling_ft: number | null; clouds: { cover: string; base_ft: number | null }[];
  weather?: string | null; temp_c: number | null; dew_c: number | null; qnh_hpa: number | null; flight_category: string | null;
}
export interface WindsResponse {
  t: number; level: string; unit: string; bbox: [number, number, number, number]; step: number; nx: number; ny: number;
  lats: number[]; lons: number[]; u: (number | null)[]; v: (number | null)[];
}
export interface AirportInfo { icao: string; iata: string | null; name: string; city: string | null; country: string | null; lat: number; lon: number; elev_ft: number | null; type: string }
export interface Runway {
  le_ident: string | null; he_ident: string | null; le_heading: number | null; he_heading: number | null;
  length_ft: number | null; width_ft: number | null; surface: string | null; lighted: boolean | null;
  le_lat: number | null; le_lon: number | null; he_lat: number | null; he_lon: number | null;
}
export interface BoardPlane {
  hex: string; cs: string | null; type: string | null; reg: string | null; lat: number; lon: number; alt: number | null; gs: number | null;
  vr: number | null; gnd: boolean; est?: boolean; dist_nm: number; basis: string; phase: string;
  origin?: Partial<Airport> | null; destination?: Partial<Airport> | null; eta_s: number | null; eta_ts: number | null;
}
export interface AirportBoard {
  t: number; airport: AirportInfo & { runways: Runway[] };
  arrivals: BoardPlane[]; departures: BoardPlane[]; metar: Metar | null;
}
export interface FullTrack { hex: string; fr24_id: string; cached: boolean; points: TrailPoint[]; fr24?: Fr24Info }

/** Failed request: HTTP status and, when the body carries one, the machine reason (e.g. "budget"). */
export class ApiError extends Error {
  constructor(public status: number, public reason: string | null = null) { super(`${status}${reason ? ` ${reason}` : ""}`); }
}

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init);
  if (!r.ok) {
    let reason: string | null = null;
    try { reason = ((await r.json()) as { reason?: string }).reason ?? null; } catch { /* no body */ }
    throw new ApiError(r.status, reason);
  }
  return r.json() as Promise<T>;
}

let skew = 0; // server clock minus client clock (s); plane timestamps are server epoch seconds
export const serverNow = () => Date.now() / 1000 + skew;
const noteClock = (t: number) => { if (Number.isFinite(t)) skew = t - Date.now() / 1000; };

declare global { interface Window { __boot?: { planes?: Promise<Response>; status?: Promise<Response> } } }
/** The first request of each kind is started by an inline script in index.html, in parallel with the bundle and the style. */
function prefetched(kind: "planes" | "status"): Promise<Response> | null {
  const p = window.__boot?.[kind] ?? null;
  if (window.__boot) delete window.__boot[kind];
  return p;
}

let etag: string | null = null;
/** Full snapshot; returns null on 304 (nothing new). */
export async function fetchPlanes(): Promise<Plane[] | null> {
  let r: Response;
  const early = prefetched("planes");
  try { r = early ? await early : await fetch("/api/planes", etag ? { headers: { "If-None-Match": etag } } : undefined); }
  catch { r = await fetch("/api/planes", etag ? { headers: { "If-None-Match": etag } } : undefined); }
  if (r.status === 304) return null;
  if (!r.ok) throw new Error(`${r.status}`);
  etag = r.headers.get("ETag") ?? null;
  const snap = (await r.json()) as Snapshot;
  noteClock(snap.t);
  return decodeRows(snap);
}

export async function fetchArea(lat: number, lon: number, r: number): Promise<Plane[]> {
  const q = `lat=${lat.toFixed(3)}&lon=${lon.toFixed(3)}&r=${Math.min(250, Math.max(10, Math.ceil(r)))}`;
  const snap = await json<Snapshot>(`/api/planes/area?${q}`);
  noteClock(snap.t);
  return decodeRows(snap);
}

/** null when the backend does not know the aircraft (404). */
export async function fetchAircraft(hex: string): Promise<Detail | null> {
  const r = await fetch(`/api/aircraft/${hex}`);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`${r.status}`);
  const d = (await r.json()) as Detail;
  if (d.plane?.est) d.plane.rts = serverNow(); // the position is valid for "now": reckoning for estimated planes starts here, not at ts
  return d;
}

export async function fetchStatus(): Promise<Status> {
  const early = prefetched("status");
  if (early) { try { const r = await early; if (r.ok) return (await r.json()) as Status; } catch { /* regular request below */ } }
  return json<Status>("/api/status");
}
export const fetchWeather = (lat: number, lon: number, alt: number | null) =>
  json<Weather>(`/api/weather?lat=${lat.toFixed(3)}&lon=${lon.toFixed(3)}&alt=${Math.round(alt ?? 0)}`);
export const fetchAtc = async (signal?: AbortSignal) => (await json<{ airports: AtcAirport[] }>("/api/atc/airports", { signal })).airports ?? [];
export const atcAudioUrl = (icao: string, feed: string) => `/api/atc/audio?icao=${encodeURIComponent(icao)}&feed=${encodeURIComponent(feed)}`;

/**
 * Self-rescheduling poll loop. `every` returns the delay in ms, or null to idle (re-evaluated on kick()).
 * Nothing runs while the tab is hidden; becoming visible again runs the loop immediately.
 */
export class Loop {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private busy = false;
  private on = false;
  private last = 0;
  constructor(private fn: () => Promise<void>, private every: () => number | null, private minGap = 0) {
    document.addEventListener("visibilitychange", () => { if (!document.hidden) this.kick(); });
  }
  start() { this.on = true; this.kick(); }
  stop() { this.on = false; clearTimeout(this.timer); }
  /** Run as soon as the minimum gap allows. */
  kick() {
    if (!this.on) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.run(), Math.max(0, this.last + this.minGap - Date.now()));
  }
  private async run() {
    if (!this.on || document.hidden) return;
    if (this.busy) { this.timer = setTimeout(() => void this.run(), 250); return; }
    if (this.every() === null) return;
    this.busy = true;
    try { await this.fn(); } catch { /* the next tick retries; health is surfaced through /api/status */ }
    this.busy = false;
    this.last = Date.now();
    if (!this.on) return;
    const next = this.every();
    if (next !== null) this.timer = setTimeout(() => void this.run(), next);
  }
}

export const fetchAlerts = async () => (await json<{ alerts: Alert[] }>("/api/alerts")).alerts ?? [];
export const fetchMetars = async (bbox: [number, number, number, number], signal?: AbortSignal) =>
  (await json<{ stations: Metar[] }>(`/api/metar?bbox=${bbox.map((n) => n.toFixed(2)).join(",")}&limit=60`, { signal })).stations ?? [];
export const fetchWinds = (bbox: [number, number, number, number], level: string, signal?: AbortSignal) =>
  json<WindsResponse>(`/api/winds?bbox=${bbox.map((n) => n.toFixed(2)).join(",")}&level=${encodeURIComponent(level)}`, { signal });
export const fetchAirports = async (q: string, signal?: AbortSignal) =>
  (await json<{ airports: AirportInfo[] }>(`/api/airports?q=${encodeURIComponent(q)}&limit=6`, { signal })).airports ?? [];
export const fetchAirportBoard = (code: string, signal?: AbortSignal) => json<AirportBoard>(`/api/airport/${encodeURIComponent(code)}`, { signal });
export const fetchFullTrack = (hex: string) => json<FullTrack>(`/api/aircraft/${hex}/full-track`);
