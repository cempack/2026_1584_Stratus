// "Auto" theme: dark when the sun is down where the user is.
//
// The location is a guess that needs no permission prompt: longitude from the UTC offset (15° per hour), latitude
// from the time-zone region. That is good to a few minutes around dusk and dawn, which is all a theme needs.
import { subSolarPoint } from "../map/sun";

export interface Place { lat: number; lon: number }

/** The sun is this far below the horizon (degrees) when the app goes dark: a bit after sunset, still civil twilight. */
export const DARK_BELOW_DEG = -4;

const REGION_LAT: [RegExp, number][] = [
  [/^(Europe\/(Oslo|Stockholm|Helsinki|Tallinn|Riga|Moscow)|Atlantic\/Reykjavik)/, 60],
  [/^Europe\//, 48], [/^America\/(Anchorage|Juneau)/, 61], [/^America\/(Toronto|Montreal|Vancouver|Edmonton|Winnipeg|Halifax)/, 47],
  [/^America\/(Sao_Paulo|Buenos_Aires|Santiago|Montevideo|Argentina)/, -28], [/^America\/(Lima|Bogota|Caracas|Guayaquil)/, -2],
  [/^America\/(Mexico_City|Guatemala|Panama|Costa_Rica)/, 17], [/^America\//, 38], [/^Pacific\/(Auckland|Chatham)/, -40],
  [/^Australia\/(Darwin)/, -12], [/^Australia\//, -32], [/^Asia\/(Kolkata|Dubai|Karachi|Riyadh|Qatar|Bangkok|Singapore|Jakarta|Manila|Ho_Chi_Minh)/, 15],
  [/^Asia\/(Tokyo|Seoul|Shanghai|Beijing|Taipei|Hong_Kong|Tehran|Jerusalem|Tel_Aviv)/, 34], [/^Asia\//, 40],
  [/^Africa\/(Johannesburg|Cape_Town|Maputo|Harare)/, -27], [/^Africa\/(Cairo|Tripoli|Tunis|Algiers|Casablanca)/, 32], [/^Africa\//, 5],
  [/^Indian\//, -15], [/^Pacific\/Honolulu/, 21],
];

export function guessPlace(timeZone: string | undefined, utcOffsetMin: number): Place {
  const lat = REGION_LAT.find(([re]) => re.test(timeZone ?? ""))?.[1] ?? 45;
  // getTimezoneOffset is minutes *behind* UTC; summer time shifts the guess by 15°, under an hour of sun: acceptable
  return { lat, lon: Math.max(-180, Math.min(180, -utcOffsetMin / 4)) };
}

export const PLACE_KEY = "stratus.place";

/** The user's place: the real one if they used "locate me" once, else the time-zone guess. */
export function localPlace(now = new Date()): Place {
  try {
    const p = JSON.parse(localStorage.getItem(PLACE_KEY) ?? "null") as Place | null;
    if (p && Number.isFinite(p.lat) && Number.isFinite(p.lon)) return { lat: p.lat, lon: p.lon };
  } catch { /* no storage: guess */ }
  let tz: string | undefined;
  try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { /* old engine */ }
  return guessPlace(tz, now.getTimezoneOffset());
}

const rad = Math.PI / 180;

/** Sun elevation (degrees) at `p`. */
export function sunElevation(date: Date, p: Place): number {
  const s = subSolarPoint(date);
  const cosZ = Math.sin(p.lat * rad) * Math.sin(s.lat * rad) + Math.cos(p.lat * rad) * Math.cos(s.lat * rad) * Math.cos((p.lon - s.lon) * rad);
  return 90 - Math.acos(Math.max(-1, Math.min(1, cosZ))) / rad;
}

export const isNight = (date: Date, p: Place) => sunElevation(date, p) < DARK_BELOW_DEG;

/** When the auto theme flips next (within 30 h), to the minute; null in polar day/night. */
export function nextSwitch(date: Date, p: Place): Date | null {
  const night = isNight(date, p);
  const step = 5 * 60_000;
  for (let t = date.getTime() + step; t < date.getTime() + 30 * 3_600_000; t += step) {
    if (isNight(new Date(t), p) !== night) {
      let lo = t - step, hi = t; // refine to the minute
      while (hi - lo > 60_000) { const mid = (lo + hi) / 2; if (isNight(new Date(mid), p) !== night) hi = mid; else lo = mid; }
      return new Date(hi);
    }
  }
  return null;
}
