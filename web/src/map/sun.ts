// Day/night terminator: sub-solar point from the date (NOAA-style low-precision formulas, ~0.01° — plenty here) and
// nested twilight bands as polygons: the set of points where the sun is lower than altitude `a` is the spherical
// cap of angular radius 90° + a (a ≤ 0) around the anti-solar point.
import { R_NM, destination, unwrap } from "../lib/core";

const rad = Math.PI / 180;

export interface SunPoint { lat: number; lon: number }

/** Sub-solar point (where the sun is at the zenith). */
export function subSolarPoint(date: Date): SunPoint {
  const n = date.getTime() / 86_400_000 + 2440587.5 - 2451545.0; // days since J2000.0
  const L = (280.46 + 0.9856474 * n) % 360;
  const g = ((357.528 + 0.9856003 * n) % 360) * rad;
  const lambda = (L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * rad;
  const eps = (23.439 - 4e-7 * n) * rad;
  const dec = Math.asin(Math.sin(eps) * Math.sin(lambda));
  const ra = Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda));
  const gmst = (280.46061837 + 360.98564736629 * n) % 360;
  let lon = ra / rad - gmst;
  lon = ((((lon + 180) % 360) + 360) % 360) - 180;
  return { lat: dec / rad, lon };
}

type Ring = [number, number][];

/** Closed ring (lon, lat) of the circle of angular radius `rDeg` around a point; encloses the nearer pole when needed. */
export function capRing(lat0: number, lon0: number, rDeg: number, steps = 144): Ring {
  const nm = rDeg * rad * R_NM;
  const pts: Ring = [];
  for (let i = 0; i <= steps; i++) {
    const [la, lo] = destination(lat0, lon0, (i / steps) * 360, nm);
    pts.push([lo, la]);
  }
  unwrap(pts);
  const sweep = pts[pts.length - 1][0] - pts[0][0];
  if (Math.abs(sweep) > 180) {
    // the circle goes around a pole: close the ring through that pole
    const pole = lat0 >= 0 ? 90 : -90;
    return [...pts, [pts[pts.length - 1][0], pole], [pts[0][0], pole], pts[0]];
  }
  pts[pts.length - 1] = pts[0];
  return pts;
}

/** Opacity per twilight band (sunset, civil/nautical, astronomical, night); summed where bands overlap. */
const BANDS: { alt: number; o: number }[] = [{ alt: 0, o: 0.16 }, { alt: -6, o: 0.1 }, { alt: -12, o: 0.1 }, { alt: -18, o: 0.1 }];

export interface Night { type: "FeatureCollection"; features: { type: "Feature"; geometry: { type: "Polygon"; coordinates: Ring[] }; properties: { o: number; alt: number } }[] }

/** Night-side polygons for `date`; `scale` lets the light theme use a weaker shade. */
export function nightPolygons(date: Date, scale = 1): Night {
  const sun = subSolarPoint(date);
  let lat = -sun.lat;
  if (Math.abs(lat) < 0.05) lat = lat < 0 ? -0.05 : 0.05; // the pole closure needs a side
  const lon = sun.lon > 0 ? sun.lon - 180 : sun.lon + 180;
  return {
    type: "FeatureCollection",
    features: BANDS.map((b) => ({
      type: "Feature", properties: { o: b.o * scale, alt: b.alt },
      geometry: { type: "Polygon", coordinates: [capRing(lat, lon, 90 + b.alt)] },
    })),
  };
}
