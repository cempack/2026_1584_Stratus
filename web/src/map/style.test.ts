import { validateStyleMin } from "@maplibre/maplibre-gl-style-spec";
import { describe, expect, it } from "vitest";
import { buildStyle } from "./style";

describe("basemap style", () => {
  it.each([["dark", false], ["light", false], ["dark", true], ["light", true]] as const)("%s theme (satellite %s) is a valid MapLibre style", (theme, satellite) => {
    const errors = validateStyleMin(buildStyle(theme, { satellite })).map((e) => e.message);
    expect(errors).toEqual([]);
  });

  it("has airports at mid zoom (bundled) and from z8 (vector tiles)", () => {
    const ids = buildStyle("light").layers.map((l) => l.id);
    expect(ids).toEqual(expect.arrayContaining(["airport-s0-label", "airport-s1-label", "airport-s2-label", "airport-label", "land-fb", "night", "sat"]));
  });
});
