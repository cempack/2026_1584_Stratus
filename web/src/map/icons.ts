// Plane silhouettes (nose up, 64×64 viewBox) rasterised and converted to signed distance fields so a single
// symbol layer can recolour them (icon-color) and outline them (icon-halo) per feature.
//
// Each airliner is drawn as its right half (fuselage, swept wing, tailplane) plus engine pods, then mirrored: one
// closed outline, so it is exactly symmetric and the fill never leaves holes where parts overlap.
import type { Shape } from "../lib/core";

type Pt = [number, number];
interface Spec { half: Pt[]; parts?: Pt[][] }

const SPECS: Partial<Record<Shape, Spec>> = {
  // narrowbody (A320 / 737): slim fuselage, 25° swept wing, an engine under each wing
  jet: {
    half: [[32, 2.5], [33.3, 3.7], [34.3, 6.2], [34.9, 9.8], [35, 13.5], [35, 23.5], [57.5, 35.6], [58.4, 38.4], [35.2, 32.8],
      [35, 46], [34.4, 50.2], [44.6, 56.2], [44.6, 59], [33.7, 57.2], [33, 60.6], [32, 61.6]],
    parts: [[[40.2, 24.4], [42.8, 24.4], [42.8, 31.2], [40.2, 31.2]]],
  },
  // widebody (777 / A350 / 787): wider body, longer and more swept wing, big engines
  heavy: {
    half: [[32, 1], [33.9, 2.4], [35.3, 5.2], [36.1, 9.4], [36.2, 14], [36.2, 21.5], [61.2, 37.2], [61.6, 40.6], [36.3, 32.4],
      [36.1, 48], [35.1, 52.6], [47.4, 58.7], [47.4, 61.6], [34.2, 59.6], [33.1, 62.4], [32, 63]],
    parts: [[[42.3, 23.6], [45.9, 23.6], [45.9, 32.2], [42.3, 32.2]]],
  },
  // turboprop (ATR / Dash 8): straight high wing, nacelles reaching forward, propeller blades
  turboprop: {
    half: [[32, 4], [33.4, 5.6], [34.2, 9], [34.4, 13], [34.4, 21.6], [60.4, 22.4], [60.4, 26.8], [34.4, 28.6], [34.2, 46],
      [33.6, 51.6], [42.6, 53], [42.6, 56.4], [33.2, 57], [32.8, 60], [32, 60.6]],
    parts: [[[40.4, 15.6], [43.6, 15.6], [43.6, 30.6], [40.4, 30.6]], [[38.4, 14.4], [45.6, 14.4], [45.6, 15.8], [38.4, 15.8]]],
  },
  // light single (Cessna): short body, long straight wing, propeller across the nose
  light: {
    half: [[32, 9.4], [33.7, 10.4], [34.6, 13.4], [34.7, 19.6], [59.4, 20.2], [59.4, 25.4], [34.7, 26], [33.9, 40], [33.3, 47.6],
      [41.4, 48.8], [41.4, 52.8], [33, 53.4], [32.6, 56], [32, 56.4]],
    parts: [[[32, 8.4], [37, 8.4], [37, 9.9], [32, 9.9]]],
  },
};

const RAW: Partial<Record<Shape, string>> = {
  // teardrop cabin, tail boom with tail rotor, two crossed main-rotor blades (all clockwise: no holes where they overlap)
  heli: "M32 15a7.5 10.5 0 1 1 0 21a7.5 10.5 0 1 1 0-21z" + "M30.8 33h2.4v22h-2.4z" + "M26.5 53.2h11v2.4h-11z"
    + "M9 7.7L10.7 6L55 50.3L53.3 52z" + "M53.3 6L55 7.7L10.7 52L9 50.3z",
  other: "M32 8 46 52 32 44 18 52z",
};

const f = (n: number) => +n.toFixed(2);
const poly = (pts: Pt[]) => `M${pts.map(([x, y]) => `${f(x)} ${f(y)}`).join("L")}z`;
const mirror = (pts: Pt[]): Pt[] => pts.map(([x, y]) => [64 - x, y] as Pt).reverse(); // reversed: same winding

function build(s: Spec): string {
  const outline = [...s.half, ...mirror(s.half).slice(1, -1)]; // nose and tail points are on the axis: once each
  return [poly(outline), ...(s.parts ?? []).flatMap((p) => [poly(p), poly(mirror(p))])].join("");
}

/** SVG path per shape (64×64 viewBox), also used by the selected-plane marker. */
export const PATHS = Object.fromEntries(
  (["jet", "heavy", "turboprop", "light", "heli", "other"] as Shape[]).map((k) => [k, SPECS[k] ? build(SPECS[k]!) : RAW[k]!]),
) as Record<Shape, string>;

// Rendered at 4× (120 px for a 30 CSS px icon): clean edges at every zoom and on dense screens.
export const ICON_PIXEL_RATIO = 4;
const SIZE = 96, BUF = 12;
const INF = 1e20;

/** 1-D squared Euclidean distance transform (Felzenszwalb & Huttenlocher), in place over `f` (length n). */
function edt1d(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array) {
  let k = 0;
  v[0] = 0; z[0] = -INF; z[1] = INF;
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) { k--; s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
    k++; v[k] = q; z[k] = s; z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
  }
  for (let q = 0; q < n; q++) f[q] = d[q];
}

/** Squared distance from every pixel to the nearest pixel where `seed` is true. */
function edt(seed: (i: number) => boolean, w: number, h: number): Float64Array {
  const g = new Float64Array(w * h);
  for (let i = 0; i < w * h; i++) g[i] = seed(i) ? 0 : INF;
  const n = Math.max(w, h), f = new Float64Array(n), d = new Float64Array(n), v = new Int32Array(n), z = new Float64Array(n + 1);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = g[y * w + x];
    edt1d(f, h, d, v, z);
    for (let y = 0; y < h; y++) g[y * w + x] = f[y];
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) f[x] = g[y * w + x];
    edt1d(f, w, d, v, z);
    for (let x = 0; x < w; x++) g[y * w + x] = f[x];
  }
  return g;
}

/**
 * Signed distance field in MapLibre's convention (edge at 192/255, 255/8 per texel), from the antialiased coverage:
 * the sub-pixel offset of edge pixels comes from their alpha, which keeps diagonal edges smooth.
 */
function toSdf(alpha: Uint8ClampedArray, w: number, h: number): Uint8ClampedArray {
  const a = (i: number) => alpha[i * 4 + 3] / 255;
  const outside = edt((i) => a(i) >= 0.5, w, h); // distance to the shape
  const inside = edt((i) => a(i) < 0.5, w, h); // distance to the background
  const out = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const cov = a(i);
    // pixel centres: subtract the half pixel, nudge by coverage for antialiased edge pixels
    const dist = cov >= 0.5 ? Math.sqrt(inside[i]) - 0.5 + (cov - 0.5) : -(Math.sqrt(outside[i]) - 0.5) + (cov - 0.5) * (cov > 0 ? 1 : 0);
    out[i * 4 + 3] = Math.max(0, Math.min(255, Math.round(192 + dist * (255 / 8))));
  }
  return out;
}

/** `outline`: the silhouette drawn as a thin stroke only (estimated planes read as hollow). */
export function makeIcon(shape: Shape, outline = false): { width: number; height: number; data: Uint8ClampedArray } {
  const w = SIZE + BUF * 2;
  const cv = document.createElement("canvas");
  cv.width = cv.height = w;
  const ctx = cv.getContext("2d")!;
  ctx.translate(BUF, BUF);
  ctx.scale(SIZE / 64, SIZE / 64);
  const path = new Path2D(PATHS[shape]);
  if (outline) { ctx.lineWidth = 4.2; ctx.lineJoin = "round"; ctx.stroke(path); } else ctx.fill(path, "nonzero");
  return { width: w, height: w, data: toSdf(ctx.getImageData(0, 0, w, w).data, w, w) };
}

export const SHAPES = Object.keys(PATHS) as Shape[];
