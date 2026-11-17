// Pure logic: types, merge-by-ts, dead reckoning, geo, formatting, search ranking, URL state. Unit-tested.

export interface Plane {
  hex: string; cs: string | null; lat: number; lon: number; alt: number | null; gs: number | null; trk: number | null;
  vr: number | null; gnd: boolean; ts: number; src: string; type: string | null; reg: string | null; cat: string | null; sqk: string | null;
  /** Estimated position (the backend moved the plane along its route after losing it). `ts` stays the last REAL fix. */
  est?: boolean;
  /** For estimated planes: the time (server epoch s) the position is valid for; dead reckoning starts there, never at `ts`. */
  rts?: number;
}
export interface Snapshot { v: number; t: number; fields: string[]; rows: unknown[][] }

/** Live plane state: last fix + an easing offset so corrections glide instead of jumping. */
export interface Track extends Plane { ex: number; ey: number; easeStart: number }

export function decodeRows(s: Snapshot): Plane[] {
  const idx = (f: string) => s.fields.indexOf(f);
  const I = Object.fromEntries(["hex", "cs", "lat", "lon", "alt", "gs", "trk", "vr", "gnd", "ts", "src", "type", "reg", "cat", "sqk", "est"].map((f) => [f, idx(f)]));
  const g = (r: unknown[], f: string) => (I[f] < 0 ? null : r[I[f]]);
  const out: Plane[] = [];
  for (const r of s.rows) {
    const lat = g(r, "lat"), lon = g(r, "lon"), ts = g(r, "ts");
    if (typeof lat !== "number" || typeof lon !== "number" || typeof ts !== "number") continue;
    const est = g(r, "est") === true;
    out.push({
      hex: String(g(r, "hex")).toLowerCase(), cs: (g(r, "cs") as string | null) ?? null, lat, lon,
      alt: (g(r, "alt") as number | null) ?? null, gs: (g(r, "gs") as number | null) ?? null, trk: (g(r, "trk") as number | null) ?? null,
      vr: (g(r, "vr") as number | null) ?? null, gnd: g(r, "gnd") === true, ts, src: String(g(r, "src") ?? ""),
      type: (g(r, "type") as string | null) ?? null, reg: (g(r, "reg") as string | null) ?? null,
      cat: (g(r, "cat") as string | null) ?? null, sqk: (g(r, "sqk") as string | null) ?? null,
      ...(est ? { est: true, rts: s.t } : {}),
    });
  }
  return out;
}

export const MAX_DR_S = 90;
export const EASE_S = 2.5; // long enough that a correction reads as a slight speed change, never a jump back
export const STALE_S = 300;

export const R_NM = 3440.065;
const rad = Math.PI / 180;

/** Destination point from (lat, lon) moving `nm` nautical miles on bearing `brg` (deg). */
export function destination(lat: number, lon: number, brg: number, nm: number): [number, number] {
  const d = nm / R_NM, b = brg * rad, p1 = lat * rad, l1 = lon * rad;
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
  const l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return [p2 / rad, ((l2 / rad + 540) % 360) - 180];
}

export function distanceNm(a: [number, number], b: [number, number]): number {
  const dp = (b[0] - a[0]) * rad, dl = (b[1] - a[1]) * rad;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(dl / 2) ** 2;
  return 2 * R_NM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Great-circle points [lon, lat] with continuous (unwrapped) longitudes, for line layers. */
export function greatCircle(a: [number, number], b: [number, number], n = 64): [number, number][] {
  const [p1, l1, p2, l2] = [a[0] * rad, a[1] * rad, b[0] * rad, b[1] * rad];
  const d = distanceNm(a, b) / R_NM;
  const pts: [number, number][] = [];
  if (d < 1e-9) return [[a[1], a[0]], [b[1], b[0]]];
  for (let i = 0; i <= n; i++) {
    const f = i / n, A = Math.sin((1 - f) * d) / Math.sin(d), B = Math.sin(f * d) / Math.sin(d);
    const x = A * Math.cos(p1) * Math.cos(l1) + B * Math.cos(p2) * Math.cos(l2);
    const y = A * Math.cos(p1) * Math.sin(l1) + B * Math.cos(p2) * Math.sin(l2);
    const z = A * Math.sin(p1) + B * Math.sin(p2);
    pts.push([Math.atan2(y, x) / rad, Math.atan2(z, Math.hypot(x, y)) / rad]);
  }
  return unwrap(pts);
}

export function unwrap(pts: [number, number][]): [number, number][] {
  for (let i = 1; i < pts.length; i++) {
    let lon = pts[i][0];
    while (lon - pts[i - 1][0] > 180) lon -= 360;
    while (lon - pts[i - 1][0] < -180) lon += 360;
    pts[i] = [lon, pts[i][1]];
  }
  return pts;
}

/** Dead-reckoned raw position (no easing): airborne only, capped at MAX_DR_S. */
export function reckon(p: Plane, now: number): [number, number] {
  if (p.gnd || !p.gs || p.trk == null) return [p.lat, p.lon];
  if (p.est && p.rts == null) return [p.lat, p.lon];
  const dt = Math.min(MAX_DR_S, Math.max(0, now - (p.est ? p.rts! : p.ts)));
  return destination(p.lat, p.lon, p.trk, (p.gs * dt) / 3600);
}

/** Render position = reckoned + easing offset that decays linearly over EASE_S. */
export function renderPos(t: Track, now: number): [number, number] {
  const [lat, lon] = reckon(t, now);
  const k = Math.max(0, 1 - (now - t.easeStart) / EASE_S);
  return k > 0 ? [lat + t.ey * k, lon + t.ex * k] : [lat, lon];
}

/**
 * Merge an observation into the store. Position replaced only when `ts` is newer; metadata filled from
 * whichever source has it. Returns true if the plane changed.
 */
/** Does observation `p` replace the stored position `cur`? Estimated rows keep the last real `ts`, so they compare on `rts`. */
export function isNewer(p: Plane, cur: Plane): boolean {
  if (p.est) return cur.est ? (p.rts ?? p.ts) > (cur.rts ?? cur.ts) : p.ts >= cur.ts;
  return p.ts > cur.ts;
}

export function mergePlane(store: Map<string, Track>, p: Plane, now: number, ease = true): boolean {
  const cur = store.get(p.hex);
  if (!cur) {
    store.set(p.hex, { ...p, ex: 0, ey: 0, easeStart: 0 });
    return true;
  }
  if (!isNewer(p, cur)) {
    cur.cs ??= p.cs; cur.type ??= p.type; cur.reg ??= p.reg; cur.cat ??= p.cat; cur.sqk ??= p.sqk;
    return false;
  }
  const [oldLat, oldLon] = renderPos(cur, now);
  Object.assign(cur, {
    ...p, cs: p.cs ?? cur.cs, type: p.type ?? cur.type, reg: p.reg ?? cur.reg, cat: p.cat ?? cur.cat, sqk: p.sqk ?? cur.sqk,
    est: !!p.est, rts: p.rts,
  });
  const [newLat, newLon] = reckon(cur, now);
  let dx = oldLon - newLon;
  if (dx > 180) dx -= 360; else if (dx < -180) dx += 360;
  const dy = oldLat - newLat;
  // Ease only small corrections; big jumps (gaps, teleports) snap.
  if (ease && Math.abs(dy) < 0.5 && Math.abs(dx) < 0.5) { cur.ex = dx; cur.ey = dy; cur.easeStart = now; }
  else { cur.ex = 0; cur.ey = 0; }
  return true;
}

// ---------- formatting (fr-FR, aviation units with metric secondary; never mixed) ----------
const nf = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 });
export const fmtInt = (n: number) => nf.format(Math.round(n)).replace(/ | /g, " ");
export function fmtAlt(ft: number | null, gnd = false): string {
  if (gnd) return "Au sol";
  return ft == null ? "—" : `${fmtInt(ft)} ft`;
}
export const fmtAltM = (ft: number | null) => (ft == null ? "" : `${fmtInt(ft * 0.3048)} m`);
export const fmtSpeed = (kt: number | null) => (kt == null ? "—" : `${fmtInt(kt)} kt`);
export const fmtSpeedKmh = (kt: number | null) => (kt == null ? "" : `${fmtInt(kt * 1.852)} km/h`);
export function fmtVr(fpm: number | null): string {
  if (fpm == null) return "—";
  if (Math.abs(fpm) < 64) return "Palier";
  return `${fpm > 0 ? "+" : "−"}${fmtInt(Math.abs(fpm))} ft/min`;
}
export const fmtTrack = (deg: number | null) => (deg == null ? "—" : `${String(Math.round(deg) % 360).padStart(3, "0")}°`);
export function fmtAgo(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `il y a ${s} s`;
  if (s < 3600) return `il y a ${Math.floor(s / 60)} min`;
  return `il y a ${Math.floor(s / 3600)} h`;
}

// ---------- altitude colour ramp (OKLCH, low chroma, constant lightness) ----------
export function oklchToHex(l: number, c: number, h: number): string {
  const a = c * Math.cos(h * rad), b = c * Math.sin(h * rad);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const lin = [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ];
  return "#" + lin.map((v) => {
    const x = v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
    return Math.round(Math.min(1, Math.max(0, x)) * 255).toString(16).padStart(2, "0");
  }).join("");
}
/** Altitude stops (ft → hue). Hues avoid the amber selection accent (50–100°). */
export const ALT_STOPS: [number, number][] = [[0, 150], [10000, 195], [20000, 235], [30000, 270], [40000, 315]];
export const altRamp = (dark: boolean): [number, string][] =>
  ALT_STOPS.map(([ft, h]) => [ft, oklchToHex(dark ? 0.8 : 0.56, dark ? 0.1 : 0.12, h)]);

// ---------- aircraft category → silhouette ----------
export type Shape = "light" | "jet" | "heavy" | "turboprop" | "heli" | "other";
const HEAVY = /^(A3[3-9]|A35|A38|B74|B76|B77|B78|IL96|MD11|A124|C17$|KC10|DC10)/;
const TURBOPROP = /^(AT[4-7]|DH8|DHC|SF34|JS|C130|A400|SW4|PC12|BE20|B350|C208|L410|E120|F50|Q400)/;
export function shapeOf(cat: string | null, type: string | null): Shape {
  const t = (type ?? "").toUpperCase();
  if (cat === "A7" || /^(EC|AS|H\d|R44|R22|B06|A109|AW|S76|S92|MI)/.test(t)) return "heli";
  if (cat === "A5" || cat === "A4" || HEAVY.test(t)) return "heavy";
  if (TURBOPROP.test(t)) return "turboprop";
  if (cat === "B1" || cat === "B4" || cat === "B6" || (cat ?? "").startsWith("C")) return "other";
  if (cat === "A1" || /^(C1\d\d|C2\d\d|PA\d|DR\d|SR2|DA\d|TB\d|P28|BE\d)/.test(t)) return "light";
  return "jet";
}

// ---------- search ----------
const normMemo = new Map<string, string>();
export function norm(s: string | null | undefined): string {
  if (!s) return "";
  let v = normMemo.get(s);
  if (v === undefined) {
    v = s.normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();
    if (normMemo.size > 80_000) normMemo.clear();
    normMemo.set(s, v);
  }
  return v;
}

export interface Searchable { key: string; kind: "plane" | "airport"; fields: { value: string | null; label: string; weight: number }[] }
export interface Hit { key: string; kind: Searchable["kind"]; score: number; label: string }

/** Score one field: exact > prefix > word prefix > contains (long queries only). Weighted per field. */
export function scoreField(value: string | null, q: string, weight: number): number {
  const v = norm(value);
  if (!v || !q) return 0;
  const compact = v.replace(/ /g, ""), qc = q.replace(/ /g, "");
  if (v === q || compact === qc) return 100 * weight;
  if (v.startsWith(q) || compact.startsWith(qc)) return 80 * weight;
  if (v.split(" ").some((w) => w.startsWith(q))) return 60 * weight;
  if (q.length >= 3 && v.includes(q)) return 30 * weight;
  return 0;
}

export function search(items: Iterable<Searchable>, raw: string, limit = 8): Hit[] {
  const q = norm(raw);
  if (!q) return [];
  const hits: Hit[] = [];
  for (const it of items) {
    let best = 0, label = "";
    for (const f of it.fields) {
      const s = scoreField(f.value, q, f.weight);
      if (s > best) { best = s; label = f.label; }
    }
    if (best > 0) hits.push({ key: it.key, kind: it.kind, score: best, label });
  }
  hits.sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));
  return hits.slice(0, limit);
}

// ---------- URL state: #/flight/<hex> and ?ll=lat,lon&z=zoom ----------
export interface UrlState { hex: string | null; ll: [number, number] | null; z: number | null; /** Airport card: #/airport/LFPG (ICAO or IATA). */ apt?: string | null }
export function parseUrl(search: string, hash: string): UrlState {
  const p = new URLSearchParams(search);
  const ll = (p.get("ll") ?? "").split(",").map(Number);
  const z = Number(p.get("z"));
  const m = hash.match(/^#\/flight\/([0-9a-fA-F]{6})$/);
  const a = hash.match(/^#\/airport\/([A-Za-z0-9]{3,4})$/);
  return {
    hex: m ? m[1].toLowerCase() : null,
    apt: a ? a[1].toUpperCase() : null,
    ll: ll.length === 2 && ll.every(Number.isFinite) && Math.abs(ll[0]) <= 90 && Math.abs(ll[1]) <= 180 ? [ll[0], ll[1]] : null,
    z: p.has("z") && Number.isFinite(z) ? Math.min(20, Math.max(0, z)) : null,
  };
}
export function formatUrl(s: UrlState): string {
  const q = s.ll ? `?ll=${s.ll[0].toFixed(4)},${s.ll[1].toFixed(4)}&z=${(s.z ?? 2).toFixed(2)}` : "";
  return `${q}${s.hex ? `#/flight/${s.hex}` : s.apt ? `#/airport/${s.apt}` : ""}`;
}
