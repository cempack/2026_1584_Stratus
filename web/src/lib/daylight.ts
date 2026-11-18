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

// The city a time zone is named after is a far better guess than "15 degrees per hour of UTC offset": Europe/Paris
// is UTC+1 (15 degrees E) but Paris is at 2.35 degrees E, which put dusk ~50 min early. Main zones by population.
const ZONE_CITY: Record<string, Place> = {
  "Europe/Paris": { lat: 48.86, lon: 2.35 }, "Europe/London": { lat: 51.51, lon: -0.13 }, "Europe/Brussels": { lat: 50.85, lon: 4.35 },
  "Europe/Amsterdam": { lat: 52.37, lon: 4.9 }, "Europe/Berlin": { lat: 52.52, lon: 13.4 }, "Europe/Madrid": { lat: 40.42, lon: -3.7 },
  "Europe/Lisbon": { lat: 38.72, lon: -9.14 }, "Europe/Rome": { lat: 41.9, lon: 12.5 }, "Europe/Zurich": { lat: 47.38, lon: 8.54 },
  "Europe/Luxembourg": { lat: 49.61, lon: 6.13 }, "Europe/Monaco": { lat: 43.74, lon: 7.42 }, "Europe/Vienna": { lat: 48.21, lon: 16.37 },
  "Europe/Prague": { lat: 50.08, lon: 14.44 }, "Europe/Warsaw": { lat: 52.23, lon: 21.01 }, "Europe/Stockholm": { lat: 59.33, lon: 18.07 },
  "Europe/Oslo": { lat: 59.91, lon: 10.75 }, "Europe/Copenhagen": { lat: 55.68, lon: 12.57 }, "Europe/Helsinki": { lat: 60.17, lon: 24.94 },
  "Europe/Dublin": { lat: 53.35, lon: -6.26 }, "Europe/Athens": { lat: 37.98, lon: 23.73 }, "Europe/Istanbul": { lat: 41.01, lon: 28.98 },
  "Europe/Moscow": { lat: 55.76, lon: 37.62 }, "Europe/Kyiv": { lat: 50.45, lon: 30.52 }, "Europe/Bucharest": { lat: 44.43, lon: 26.1 },
  "Europe/Budapest": { lat: 47.5, lon: 19.04 }, "America/New_York": { lat: 40.71, lon: -74.01 }, "America/Chicago": { lat: 41.88, lon: -87.63 },
  "America/Denver": { lat: 39.74, lon: -104.99 }, "America/Los_Angeles": { lat: 34.05, lon: -118.24 }, "America/Phoenix": { lat: 33.45, lon: -112.07 },
  "America/Toronto": { lat: 43.65, lon: -79.38 }, "America/Montreal": { lat: 45.5, lon: -73.57 }, "America/Vancouver": { lat: 49.28, lon: -123.12 },
  "America/Mexico_City": { lat: 19.43, lon: -99.13 }, "America/Sao_Paulo": { lat: -23.55, lon: -46.63 }, "America/Argentina/Buenos_Aires": { lat: -34.6, lon: -58.38 },
  "America/Martinique": { lat: 14.6, lon: -61.07 }, "America/Guadeloupe": { lat: 16.24, lon: -61.53 }, "Indian/Reunion": { lat: -20.88, lon: 55.45 },
  "Africa/Casablanca": { lat: 33.57, lon: -7.59 }, "Africa/Algiers": { lat: 36.75, lon: 3.06 }, "Africa/Tunis": { lat: 36.81, lon: 10.18 },
  "Africa/Dakar": { lat: 14.72, lon: -17.47 }, "Africa/Abidjan": { lat: 5.36, lon: -4.01 }, "Africa/Cairo": { lat: 30.04, lon: 31.24 },
  "Africa/Lagos": { lat: 6.52, lon: 3.38 }, "Africa/Johannesburg": { lat: -26.2, lon: 28.05 }, "Asia/Dubai": { lat: 25.2, lon: 55.27 },
  "Asia/Tokyo": { lat: 35.68, lon: 139.69 }, "Asia/Shanghai": { lat: 31.23, lon: 121.47 }, "Asia/Hong_Kong": { lat: 22.32, lon: 114.17 },
  "Asia/Singapore": { lat: 1.35, lon: 103.82 }, "Asia/Kolkata": { lat: 28.61, lon: 77.21 }, "Asia/Seoul": { lat: 37.57, lon: 126.98 },
  "Australia/Sydney": { lat: -33.87, lon: 151.21 }, "Pacific/Auckland": { lat: -36.85, lon: 174.76 }, "Pacific/Tahiti": { lat: -17.54, lon: -149.57 },
};

export function guessPlace(timeZone: string | undefined, utcOffsetMin: number): Place {
  const city = timeZone ? ZONE_CITY[timeZone] : undefined;
  if (city) return city;
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
