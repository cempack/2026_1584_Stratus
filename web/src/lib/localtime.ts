// Local time anywhere: the IANA time zone of a point (offline lookup, loaded in the background), the time there,
// its offset from the viewer, and the next sunrise / sunset (same sun model as the auto theme).
import { sunElevation } from "./daylight";

type Lookup = (lat: number, lon: number) => string;
let lookup: Lookup | null = null;
let loading: Promise<void> | null = null;

/** Load the time-zone map (~70 KB) once; until then zoneAt() answers null and the UI simply omits local times. */
export function loadZones(): Promise<void> {
  return (loading ??= import("@photostructure/tz-lookup").then((m) => {
    lookup = ((m as unknown as { default?: Lookup }).default ?? (m as unknown as Lookup));
  }).catch(() => { loading = null; }));
}

export function zoneAt(lat: number, lon: number): string | null {
  if (!lookup) { void loadZones(); return null; }
  try { return lookup(lat, lon); } catch { return null; }
}

/** Minutes east of UTC for `zone` at `d`. */
export function zoneOffsetMin(zone: string, d = new Date()): number {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" })
    .formatToParts(d).filter((x) => x.type !== "literal").map((x) => [x.type, Number(x.value)]));
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  return Math.round((asUtc - Math.floor(d.getTime() / 60000) * 60000) / 60000);
}

export const hhmm = (d: Date, zone?: string) => d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", ...(zone ? { timeZone: zone } : {}) });

/** "+8 h", "−1 h 30", "" when it is the viewer's time too. */
export function fmtShift(minutes: number): string {
  if (!minutes) return "";
  const a = Math.abs(minutes), h = Math.floor(a / 60), m = a % 60;
  return `${minutes > 0 ? "+" : "−"}${h ? `${h} h` : ""}${m ? `${h ? " " : ""}${String(m).padStart(h ? 2 : 1, "0")}${h ? "" : " min"}` : ""}`;
}

export interface LocalInfo { zone: string; time: string; shift: string; night: boolean; rise: Date | null; set: Date | null }

const SUN_EDGE = -0.833; // sunrise / sunset: upper limb on the horizon, with refraction

function nextCrossing(lat: number, lon: number, from: Date, rising: boolean): Date | null {
  const step = 10 * 60_000;
  let prev = sunElevation(from, { lat, lon });
  for (let t = from.getTime() + step; t <= from.getTime() + 26 * 3_600_000; t += step) {
    const e = sunElevation(new Date(t), { lat, lon });
    if (rising ? prev < SUN_EDGE && e >= SUN_EDGE : prev >= SUN_EDGE && e < SUN_EDGE) {
      let lo = t - step, hi = t;
      while (hi - lo > 30_000) {
        const mid = (lo + hi) / 2, em = sunElevation(new Date(mid), { lat, lon });
        if (rising ? em >= SUN_EDGE : em < SUN_EDGE) hi = mid; else lo = mid;
      }
      return new Date(hi);
    }
    prev = e;
  }
  return null; // polar day or night
}

/** Everything local about a point, or null while the zone map is not loaded (or for open ocean edge cases). */
export function localInfo(lat: number, lon: number, now = new Date()): LocalInfo | null {
  const zone = zoneAt(lat, lon);
  if (!zone) return null;
  const shiftMin = zoneOffsetMin(zone, now) + now.getTimezoneOffset();
  return {
    zone, time: hhmm(now, zone), shift: fmtShift(shiftMin), night: sunElevation(now, { lat, lon }) < SUN_EDGE,
    rise: nextCrossing(lat, lon, now, true), set: nextCrossing(lat, lon, now, false),
  };
}

/** "08:12 (+8 h)" or "14:32" when it is the viewer's time; "" while unknown. */
export function localClock(lat: number, lon: number, now = new Date()): string {
  const z = zoneAt(lat, lon);
  if (!z) return "";
  const shift = fmtShift(zoneOffsetMin(z, now) + now.getTimezoneOffset());
  return shift ? `${hhmm(now, z)} (${shift})` : hhmm(now, z);
}
