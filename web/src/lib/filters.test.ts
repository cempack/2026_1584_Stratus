import { describe, expect, it } from "vitest";
import { ALT_MAX, NO_FILTERS, activeCount, catOfShape, compileFilters, heavyOnly, parseFilters, prefixes } from "./filters";

describe("filters", () => {
  it("is a no-op by default", () => {
    const c = compileFilters(NO_FILTERS);
    expect(c.active).toBe(false);
    expect(activeCount(NO_FILTERS)).toBe(0);
    expect(c.test(null, false, null, "jet")).toBe(true);
  });

  it("maps shapes to the four public categories", () => {
    expect(catOfShape("turboprop")).toBe("jet");
    expect(catOfShape("other")).toBe("light");
    expect(catOfShape("heavy")).toBe("heavy");
    expect(catOfShape("heli")).toBe("heli");
  });

  it("filters by category and keeps 'gros porteurs uniquement' as heavy only", () => {
    const f = { ...NO_FILTERS, cats: ["heavy" as const] };
    const c = compileFilters(f);
    expect(heavyOnly(f)).toBe(true);
    expect(c.test(35000, false, "AFR1", "heavy")).toBe(true);
    expect(c.test(35000, false, "AFR1", "jet")).toBe(false);
    expect(activeCount(f)).toBe(1);
  });

  it("applies the altitude range: ground counts as 0 ft, unknown altitude only passes an upper-bound-only filter", () => {
    const high = compileFilters({ ...NO_FILTERS, altMin: 30000 });
    expect(high.test(35000, false, null, "jet")).toBe(true);
    expect(high.test(12000, false, null, "jet")).toBe(false);
    expect(high.test(null, false, null, "jet")).toBe(false);
    expect(high.test(0, true, null, "jet")).toBe(false);
    const low = compileFilters({ ...NO_FILTERS, altMax: 10000 });
    expect(low.test(0, true, null, "jet")).toBe(true);
    expect(low.test(null, false, null, "jet")).toBe(true);
    expect(low.test(20000, false, null, "jet")).toBe(false);
    expect(compileFilters({ ...NO_FILTERS, altMax: ALT_MAX }).active).toBe(false);
  });

  it("matches callsign prefixes, several at once, case-insensitively", () => {
    expect(prefixes(" afr, BAW  ez-y;")).toEqual(["AFR", "BAW", "EZY"]);
    const c = compileFilters({ ...NO_FILTERS, prefix: "afr, baw" });
    expect(c.test(1, false, "AFR123", "jet")).toBe(true);
    expect(c.test(1, false, "baw9", "jet")).toBe(true);
    expect(c.test(1, false, "DLH1", "jet")).toBe(false);
    expect(c.test(1, false, null, "jet")).toBe(false);
  });

  it("counts each active criterion once", () => {
    expect(activeCount({ altMin: 1000, altMax: 20000, cats: ["jet", "heli"], prefix: "AF" })).toBe(3);
  });

  it("parses stored values defensively", () => {
    expect(parseFilters(null)).toEqual(NO_FILTERS);
    expect(parseFilters("{not json")).toEqual(NO_FILTERS);
    const f = parseFilters(JSON.stringify({ altMin: 90000, altMax: -5, cats: ["jet", "bogus", "jet"], prefix: 12 }));
    expect(f.altMin).toBeLessThanOrEqual(f.altMax);
    expect(f.cats).toEqual(["jet"]);
    expect(f.prefix).toBe("");
  });
});
