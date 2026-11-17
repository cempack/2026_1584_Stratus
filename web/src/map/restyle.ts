// In-place restyle: apply the paint/layout differences between two style specs to the live map.
//
// Switching theme or satellite used to call setStyle(..., { diff: false }), which throws away every source, tile and
// runtime layer (planes, radar…) and rebuilds them: a visible blink and seconds of reloading. Both styles come from
// the same builder and share their layer ids, so only property values differ; setting those is instant.
import type { LayerSpecification, Map as MLMap } from "maplibre-gl";

type Props = Record<string, unknown>;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export interface PropChange { id: string; kind: "paint" | "layout"; prop: string; value: unknown }

/** Property changes turning `from` into `to`, for the layers present in both (matched by id). */
export function styleChanges(from: LayerSpecification[], to: LayerSpecification[]): PropChange[] {
  const old = new Map(from.map((l) => [l.id, l]));
  const out: PropChange[] = [];
  for (const l of to) {
    const o = old.get(l.id);
    if (!o) continue;
    for (const kind of ["paint", "layout"] as const) {
      const a = ((o as { [k: string]: unknown })[kind] ?? {}) as Props, b = ((l as { [k: string]: unknown })[kind] ?? {}) as Props;
      for (const prop of new Set([...Object.keys(a), ...Object.keys(b)])) {
        if (same(a[prop], b[prop])) continue;
        // a property dropped from the new spec goes back to its default; visibility defaults to visible
        const value = prop in b ? b[prop] : kind === "layout" && prop === "visibility" ? "visible" : undefined;
        out.push({ id: l.id, kind, prop, value });
      }
    }
  }
  return out;
}

/** Apply `styleChanges(from, to)` to `map`. Returns false if anything failed (the caller can fall back to setStyle). */
export function restyle(map: MLMap, from: LayerSpecification[], to: LayerSpecification[]): boolean {
  try {
    for (const c of styleChanges(from, to)) {
      if (!map.getLayer(c.id)) continue;
      if (c.kind === "paint") map.setPaintProperty(c.id, c.prop, c.value);
      else map.setLayoutProperty(c.id, c.prop, c.value);
    }
    return true;
  } catch {
    return false;
  }
}
