// Adaptive render resolution: on machines where the globe can't keep up, draw it at a lower pixel ratio.
//
// The map's cost is mostly fill rate (globe, imagery, ~12k symbols) and scales with the pixel count: going from a
// pixel ratio of 2 to 1.5 removes ~44% of the pixels. While the map renders continuously (a pan, a zoom, follow mode),
// frame intervals are sampled; if the median of a window stays above SLOW_MS, the ratio steps down one notch. The
// level reached is remembered so the next visit starts there instead of re-learning it with stutters.
import type maplibregl from "maplibre-gl";

const SLOW_MS = 24; // ~40 fps
const WINDOW = 90;
const KEY = "stratus.pxr";

const get = () => { try { return Number(localStorage.getItem(KEY)) || null; } catch { return null; } };
const set = (v: number) => { try { localStorage.setItem(KEY, String(v)); } catch { /* private mode */ } };

/** Pixel ratio to create the map with: the device's (capped at 2), or the lower level learned on a previous visit. */
export function initialPixelRatio(): number {
  const max = Math.min(2, window.devicePixelRatio || 1);
  const learned = get();
  return learned && learned < max ? learned : max;
}

export function adaptQuality(map: maplibregl.Map) {
  const steps = [2, 1.5, 1.25, 1];
  let last = 0, samples: number[] = [], holdUntil = 0;
  map.on("render", () => {
    const now = performance.now();
    const dt = now - last;
    last = now;
    if (dt > 120 || now < holdUntil) return; // not continuous rendering, or settling after a change
    samples.push(dt);
    if (samples.length < WINDOW) return;
    const median = samples.sort((a, b) => a - b)[samples.length >> 1];
    samples = [];
    if (median <= SLOW_MS) return;
    const cur = map.getPixelRatio();
    const next = steps.find((s) => s < cur - 0.01);
    if (!next) return;
    map.setPixelRatio(next);
    set(next);
    holdUntil = now + 3000;
  });
}
