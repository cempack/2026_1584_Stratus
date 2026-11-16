// Plane silhouettes (nose up, 64×64 viewBox) rasterised and converted to signed distance fields so a single
// symbol layer can recolour them (icon-color) and outline them (icon-halo) per feature.
import type { Shape } from "../lib/core";

const PATHS: Record<Shape, string> = {
  jet: "M32 4c2 0 3 3 3 6v14l21 12v5l-21-6v13l7 5v4l-10-3-10 3v-4l7-5V35L8 41v-5l21-12V10c0-3 1-6 3-6z",
  heavy: "M32 2c2.4 0 3.5 3.5 3.5 7v14l24 14v6l-24-7v15l8 6v4l-11.5-3L20.5 61v-4l8-6V36l-24 7v-6l24-14V9c0-3.5 1.1-7 3.5-7z",
  turboprop: "M32 6c1.8 0 2.6 2.5 2.6 5v11h24v6l-24 3v16l7 4v4l-9.6-2-9.6 2v-4l7-4V31l-24-3v-6h24V11c0-2.5.8-5 2.6-5z",
  light: "M32 10c1.6 0 2.4 2 2.4 4v8h22v5l-22 2v15l6 2v4h-16.8v-4l6-2V29l-22-2v-5h22v-8c0-2 .8-4 2.4-4z",
  heli: "M32 14a8 9 0 0 1 8 9v5a8 9 0 0 1-6 8.7V54h5v3H25v-3h5V36.7A8 9 0 0 1 24 28v-5a8 9 0 0 1 8-9zM6 21l52 0v2.6L6 23.6z",
  other: "M32 8 46 52 32 44 18 52z",
};

const SIZE = 48, BUF = 6, RADIUS = 6;

/** Brute-force SDF (small images, run once): 192/255 at the edge, as MapLibre expects. */
function toSdf(alpha: Uint8ClampedArray, w: number, h: number): Uint8ClampedArray {
  const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && alpha[(y * w + x) * 4 + 3] > 127;
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const ins = inside(x, y);
    let best = RADIUS;
    for (let dy = -RADIUS; dy <= RADIUS; dy++) for (let dx = -RADIUS; dx <= RADIUS; dx++) {
      if (inside(x + dx, y + dy) !== ins) { const d = Math.hypot(dx, dy) - 0.5; if (d < best) best = d; }
    }
    const signed = ins ? best : -best;
    const v = Math.round(192 + (signed / RADIUS) * 63);
    out[(y * w + x) * 4 + 3] = Math.max(0, Math.min(255, v));
  }
  return out;
}

export function makeIcon(shape: Shape): { width: number; height: number; data: Uint8ClampedArray } {
  const w = SIZE + BUF * 2;
  const cv = document.createElement("canvas");
  cv.width = cv.height = w;
  const ctx = cv.getContext("2d")!;
  ctx.translate(BUF, BUF);
  ctx.scale(SIZE / 64, SIZE / 64);
  ctx.fill(new Path2D(PATHS[shape]), "nonzero");
  return { width: w, height: w, data: toSdf(ctx.getImageData(0, 0, w, w).data, w, w) };
}

export const SHAPES = Object.keys(PATHS) as Shape[];
