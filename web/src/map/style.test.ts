import { validateStyleMin } from "@maplibre/maplibre-gl-style-spec";
import { describe, expect, it } from "vitest";
import { buildStyle } from "./style";

describe("basemap style", () => {
  it.each(["dark", "light"] as const)("%s theme is a valid MapLibre style", (theme) => {
    const errors = validateStyleMin(buildStyle(theme)).map((e) => e.message);
    expect(errors).toEqual([]);
  });
});
