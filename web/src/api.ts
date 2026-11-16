// Typed client for the v2 API (docs/architecture-v2.md) and the polling scheduler.
import { type Plane, type Snapshot, decodeRows } from "./lib/core";

export interface Airport { icao: string; iata: string | null; name: string | null; city: string | null; country: string | null; lat: number; lon: number }
export interface Aircraft { registration: string | null; type: string | null; type_name: string | null; manufacturer: string | null; operator: string | null; operator_icao: string | null; owner: string | null; country: string | null }
export interface Route { callsign: string | null; airline: string | null; origin: Airport | null; destination: Airport | null; plausible: boolean }
export interface Photo { thumb: string; large: string; photographer: string; link: string }
export type TrailPoint = [lat: number, lon: number, alt: number | null, ts: number];
export interface Detail {
  plane: Plane & { pos_type?: string | null; country?: string | null };
  trail: TrailPoint[]; aircraft: Aircraft | null; route: Route | null; photo: Photo | null;
}
export interface Feed { state: string; mode?: string; last_ok: number | null; next_poll?: number | null; interval?: number; credits_remaining?: number | null; credits_daily?: number | null; last_error: string | null }
export interface Status { planes: number; v: number; t: number; feeds: Record<string, Feed> }
export interface Weather { temp_c: number | null; wind_kt: number | null; wind_dir: number | null; cloud_pct: number | null; level: string | null; time: number }
export interface AtcFeed { id: string; label: string }
export interface AtcAirport { icao: string; name: string; city: string | null; country: string | null; lat: number; lon: number; feeds: AtcFeed[] }

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init);
  if (!r.ok) throw new Error(`${r.status}`);
  return r.json() as Promise<T>;
}

let skew = 0; // server clock minus client clock (s); plane timestamps are server epoch seconds
export const serverNow = () => Date.now() / 1000 + skew;
const noteClock = (t: number) => { if (Number.isFinite(t)) skew = t - Date.now() / 1000; };

let etag: string | null = null;
/** Full snapshot; returns null on 304 (nothing new). */
export async function fetchPlanes(): Promise<Plane[] | null> {
  const r = await fetch("/api/planes", etag ? { headers: { "If-None-Match": etag } } : undefined);
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
  return r.json();
}

export const fetchStatus = () => json<Status>("/api/status");
export const fetchWeather = (lat: number, lon: number, alt: number | null) =>
  json<Weather>(`/api/weather?lat=${lat.toFixed(3)}&lon=${lon.toFixed(3)}&alt=${Math.round(alt ?? 0)}`);
export const fetchAtc = async () => (await json<{ airports: AtcAirport[] }>("/api/atc/airports")).airports;
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
