// Wind field helpers for the particle layer: bilinear sampling of the /api/winds grid and the advection step.

export interface WindGrid {
  lats: number[]; lons: number[]; nx: number; ny: number;
  u: (number | null)[]; v: (number | null)[];
}

/** Longitudes made monotonic (a grid that crosses the antimeridian lists 170, 175, -180, -175...). */
export function unwrapLons(lons: number[]): number[] {
  const out: number[] = [];
  let add = 0;
  for (let i = 0; i < lons.length; i++) {
    if (i && lons[i] + add < out[i - 1]) add += 360;
    out.push(lons[i] + add);
  }
  return out;
}

/** Index i such that xs[i] <= x <= xs[i+1] (xs ascending), or -1 outside. */
function bracket(xs: number[], x: number): number {
  if (xs.length < 2 || x < xs[0] || x > xs[xs.length - 1]) return -1;
  let i = 0;
  while (i < xs.length - 2 && xs[i + 1] < x) i++;
  return i;
}

/** Wind (u east, v north, knots) at a point; null outside the grid or when every surrounding cell is missing. */
export function sampleWind(g: WindGrid, lat: number, lon: number): [number, number] | null {
  if (g.nx < 2 || g.ny < 2 || g.u.length < g.nx * g.ny || g.v.length < g.nx * g.ny) return null;
  const xs = unwrapLons(g.lons);
  let x = lon;
  while (x < xs[0]) x += 360;
  while (x >= xs[0] + 360) x -= 360;
  // latitudes run north to south; flip to ascending for the search
  const ys = g.lats.map((l) => -l);
  const ix = bracket(xs, x), iy = bracket(ys, -lat);
  if (ix < 0 || iy < 0) return null;
  const fx = (x - xs[ix]) / (xs[ix + 1] - xs[ix] || 1), fy = (-lat - ys[iy]) / (ys[iy + 1] - ys[iy] || 1);
  let su = 0, sv = 0, sw = 0;
  for (const [dx, dy, w] of [[0, 0, (1 - fx) * (1 - fy)], [1, 0, fx * (1 - fy)], [0, 1, (1 - fx) * fy], [1, 1, fx * fy]] as const) {
    const k = (iy + dy) * g.nx + ix + dx, u = g.u[k], v = g.v[k];
    if (u == null || v == null || w <= 0) continue;
    su += u * w; sv += v * w; sw += w;
  }
  return sw > 1e-6 ? [su / sw, sv / sw] : null;
}

/** Degrees of longitude covered by one CSS pixel at `zoom` (512 px world tiles). */
export const degPerPixel = (zoom: number) => 360 / (512 * 2 ** zoom);

/**
 * One animation step: a particle moves `pxPerKt` screen pixels per knot of wind, whatever the zoom, so a
 * 100 kt jet stream always looks equally fast. Returns the new [lat, lon].
 */
export function advance(lat: number, lon: number, u: number, v: number, degPerPx: number, pxPerKt: number): [number, number] {
  const cos = Math.max(0.15, Math.cos((lat * Math.PI) / 180));
  const nlat = Math.max(-85, Math.min(85, lat + v * pxPerKt * degPerPx));
  let nlon = lon + (u * pxPerKt * degPerPx) / cos;
  if (nlon > 180) nlon -= 360; else if (nlon < -180) nlon += 360;
  return [nlat, nlon];
}

/** Number of particles for a canvas: sparse on purpose (light streaks, not a screensaver). */
export function particleCount(w: number, h: number, phone: boolean): number {
  const n = Math.round((w * h) / (phone ? 2400 : 1800));
  return Math.max(200, Math.min(phone ? 900 : 1500, n));
}

export const WIND_LEVELS: { id: string; label: string; hint: string }[] = [
  { id: "surface", label: "Sol", hint: "10 m" },
  { id: "850", label: "1 500 m", hint: "850 hPa" },
  { id: "500", label: "5 500 m", hint: "500 hPa" },
  { id: "250", label: "10 000 m", hint: "250 hPa" },
];
