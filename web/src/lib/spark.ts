// Altitude profile sparkline from the trail: pure geometry, rendered as inline SVG by the panel.
import type { TrailPoint } from "../api";

export interface Spark {
  line: string; area: string; last: [number, number]; maxAlt: number; minutes: number; points: number;
}

/** Downsample to at most `max` points keeping first/last, then map time to x and altitude to y (0 ft at the bottom). */
export function sparkline(trail: TrailPoint[], now: { alt: number | null; ts: number } | null, w: number, h: number, max = 90): Spark | null {
  const pts: [number, number][] = [];
  for (const p of trail) if (p[2] != null && Number.isFinite(p[2])) pts.push([p[3], p[2]]);
  if (now?.alt != null && (!pts.length || now.ts > pts[pts.length - 1][0])) pts.push([now.ts, now.alt]);
  if (pts.length < 3) return null;
  const t0 = pts[0][0], t1 = pts[pts.length - 1][0];
  if (t1 - t0 < 30) return null;
  const step = Math.max(1, Math.ceil(pts.length / max));
  const s = pts.filter((_, i) => i % step === 0 || i === pts.length - 1);
  const maxAlt = Math.max(...s.map((p) => p[1]));
  const top = Math.max(5000, Math.ceil(maxAlt / 5000) * 5000);
  const pad = 3;
  const xy = s.map(([t, a]): [number, number] => [((t - t0) / (t1 - t0)) * w, pad + (1 - a / top) * (h - pad * 2)]);
  const f = (n: number) => n.toFixed(1);
  const line = xy.map(([x, y], i) => `${i ? "L" : "M"}${f(x)} ${f(y)}`).join("");
  const last = xy[xy.length - 1];
  return { line, area: `${line}L${f(last[0])} ${h}L0 ${h}Z`, last, maxAlt, minutes: (t1 - t0) / 60, points: s.length };
}
