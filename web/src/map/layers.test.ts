import { validateStyleMin } from "@maplibre/maplibre-gl-style-spec";
import { describe, expect, it } from "vitest";
import { SOURCE_IDS, buildOverlay } from "./layers";
import { buildStyle } from "./style";

describe("overlay layers (planes, estimates, trails, airports, METAR, alerts)", () => {
  it.each([
    ["light", false, false, false],
    ["dark", false, false, false],
    ["light", true, true, true],
    ["dark", true, true, true],
  ] as const)("%s style + overlay is valid (satellite %s, ATC %s, METAR %s)", (theme, sat, atc, metar) => {
    const style = buildStyle(theme, { satellite: sat });
    const ov = buildOverlay(theme, { atcVisible: atc, metarVisible: metar });
    Object.assign(style.sources, ov.sources);
    style.layers.push(...ov.layers);
    expect(validateStyleMin(style).map((e) => e.message)).toEqual([]);
  });

  it("every layer reads a declared source, ids are unique, and estimated planes have their own layers", () => {
    const ov = buildOverlay("light");
    const ids = ov.layers.map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const l of ov.layers) expect(Object.keys(ov.sources)).toContain((l as { source: string }).source);
    expect(Object.keys(ov.sources).sort()).toEqual([...SOURCE_IDS].sort());
    expect(ids).toEqual(expect.arrayContaining(["planes", "planes-est", "planes-est-ring", "trail-est", "alert-ring", "metar-dots", "fulltrack", "apt-rwy"]));
  });

  it("starts with the optional layers hidden", () => {
    const ov = buildOverlay("light");
    const vis = (id: string) => (ov.layers.find((l) => l.id === id)?.layout as { visibility?: string } | undefined)?.visibility;
    expect(vis("metar-dots")).toBe("none");
    expect(vis("atc-dots")).toBe("none");
  });
});
