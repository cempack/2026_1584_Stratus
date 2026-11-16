// Map filters (altitude range, category, callsign prefix). Pure, so the plane layer can call it for every plane
// without allocating and the tests can pin the rules down.
import type { Shape } from "./core";

export type Cat = "light" | "jet" | "heavy" | "heli";
export const CATS: { id: Cat; label: string }[] = [
  { id: "light", label: "Léger" },
  { id: "jet", label: "Jet" },
  { id: "heavy", label: "Gros porteur" },
  { id: "heli", label: "Hélico" },
];
export const ALT_MAX = 45_000;

export interface Filters {
  /** Altitude range in feet. `altMax === ALT_MAX` means "no upper bound", `altMin === 0` "no lower bound". */
  altMin: number;
  altMax: number;
  /** Empty = every category. */
  cats: Cat[];
  /** Callsign prefixes, comma or space separated ("AFR, BAW"). Empty = everything. */
  prefix: string;
}
export const NO_FILTERS: Filters = { altMin: 0, altMax: ALT_MAX, cats: [], prefix: "" };

export function catOfShape(s: Shape): Cat {
  if (s === "heavy") return "heavy";
  if (s === "heli") return "heli";
  return s === "jet" || s === "turboprop" ? "jet" : "light";
}

/** "afr, BAW  ez" -> ["AFR", "BAW", "EZ"] */
export function prefixes(raw: string): string[] {
  return raw.toUpperCase().split(/[\s,;]+/).map((p) => p.replace(/[^A-Z0-9]/g, "")).filter(Boolean);
}

export const altFiltered = (f: Filters) => f.altMin > 0 || f.altMax < ALT_MAX;
/** Number of active criteria (for the badge on the layers button). */
export function activeCount(f: Filters): number {
  return (altFiltered(f) ? 1 : 0) + (f.cats.length ? 1 : 0) + (prefixes(f.prefix).length ? 1 : 0);
}

export interface Compiled {
  active: boolean;
  /** `alt` in feet (null = unknown); `shape` from shapeOf. */
  test(alt: number | null, gnd: boolean, cs: string | null, shape: Shape): boolean;
}
const PASS: Compiled = { active: false, test: () => true };

export function compileFilters(f: Filters): Compiled {
  if (!activeCount(f)) return PASS;
  const pre = prefixes(f.prefix);
  const cats = new Set<Cat>(f.cats);
  const min = f.altMin, max = f.altMax, hasMin = min > 0, hasMax = max < ALT_MAX;
  return {
    active: true,
    test(alt, gnd, cs, shape) {
      if (cats.size && !cats.has(catOfShape(shape))) return false;
      const a = gnd ? 0 : alt;
      if (hasMin && (a == null || a < min)) return false;
      if (hasMax && a != null && a > max) return false;
      if (pre.length) {
        if (!cs) return false;
        const c = cs.toUpperCase();
        if (!pre.some((p) => c.startsWith(p))) return false;
      }
      return true;
    },
  };
}

/** Tolerant parse of what was stored (never trust localStorage). */
export function parseFilters(raw: string | null): Filters {
  try {
    const j = JSON.parse(raw ?? "null") as Partial<Filters> | null;
    if (!j || typeof j !== "object") return { ...NO_FILTERS };
    const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(ALT_MAX, Math.max(0, Math.round(v))) : d);
    let altMin = num(j.altMin, 0), altMax = num(j.altMax, ALT_MAX);
    if (altMin > altMax) [altMin, altMax] = [altMax, altMin];
    const ids = new Set(CATS.map((c) => c.id));
    const cats = Array.isArray(j.cats) ? [...new Set(j.cats.filter((c): c is Cat => ids.has(c as Cat)))] : [];
    return { altMin, altMax, cats, prefix: typeof j.prefix === "string" ? j.prefix.slice(0, 40) : "" };
  } catch { return { ...NO_FILTERS }; }
}

export const heavyOnly = (f: Filters) => f.cats.length === 1 && f.cats[0] === "heavy";
