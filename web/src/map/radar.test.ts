import { validateStyleMin } from "@maplibre/maplibre-gl-style-spec";
import { describe, expect, it } from "vitest";
import { OPACITY, type RadarFrame, lookahead, radarFrameSpec, radarId, radarUrl } from "./radar";
import { buildStyle } from "./style";

const frames: RadarFrame[] = [
  { time: 1700000000, path: "/v2/radar/1700000000", forecast: false },
  { time: 1700000600, path: "/v2/radar/1700000600", forecast: true },
];

describe("radar layers", () => {
  it.each(["light", "dark"] as const)("%s radar frames are valid in the basemap style", (theme) => {
    const style = buildStyle(theme);
    const at = style.layers.findIndex((l) => l.id === "runway");
    expect(at).toBeGreaterThan(0);
    frames.forEach((f, i) => {
      const spec = radarFrameSpec(f, "https://tilecache.rainviewer.com", theme, i === 0, i === 0);
      style.sources[spec.id] = spec.source;
      style.layers.splice(at, 0, spec.layer as never);
    });
    expect(validateStyleMin(style).map((e) => e.message)).toEqual([]);
  });

  it("is subtle and requests 512 px tiles by timestamp-stable ids", () => {
    expect(OPACITY.light).toBeLessThanOrEqual(0.45);
    expect(OPACITY.dark).toBeLessThanOrEqual(0.45);
    expect(radarId(frames[0])).toBe("radar-1700000000");
    expect(radarUrl("https://h", frames[0])).toContain("/512/{z}/{x}/{y}/");
    const hidden = radarFrameSpec(frames[1], "https://h", "light", false, false);
    expect(hidden.layer.layout.visibility).toBe("none");
    expect(hidden.layer.paint["raster-opacity"]).toBe(0);
  });

  it("looks ahead cyclically without repeating the current frame", () => {
    expect(lookahead(0, 2, 9)).toEqual([1, 2]);
    expect(lookahead(8, 2, 9)).toEqual([0, 1]);
    expect(lookahead(0, 2, 2)).toEqual([1]);
    expect(lookahead(0, 2, 1)).toEqual([]);
  });
});
