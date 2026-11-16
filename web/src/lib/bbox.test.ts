import { describe, expect, it } from "vitest";
import { bboxContains, bboxKey, viewBbox } from "./bbox";

describe("viewport boxes", () => {
  it("pads the view and clamps the latitude", () => {
    const b = viewBbox({ south: 40, west: 0, north: 50, east: 10 }, 0.1);
    expect(b).toEqual([39, -1, 51, 11]);
    expect(viewBbox({ south: -89, west: 0, north: 89, east: 10 }, 0)[0]).toBe(-85);
  });

  it("turns a world-wide view into the whole world", () => {
    expect(viewBbox({ south: -60, west: -250, north: 70, east: 250 }, 0.1)).toEqual([-60 - 13, -180, 70 + 13, 180]);
  });

  it("normalises longitudes when the view crosses the antimeridian", () => {
    const b = viewBbox({ south: 0, west: 170, north: 10, east: 200 }, 0);
    expect(b).toEqual([0, 170, 10, -160]);
    expect(b[1]).toBeGreaterThan(b[3]);
  });

  it("builds stable cache keys and checks containment", () => {
    expect(bboxKey([39.4, -0.9, 50.6, 10.2])).toBe(bboxKey([40, 0, 50, 10]));
    expect(bboxContains([0, -10, 60, 20], [10, 0, 50, 10])).toBe(true);
    expect(bboxContains([0, -10, 60, 20], [10, 0, 70, 10])).toBe(false);
    expect(bboxContains([-85, -180, 85, 180], [10, 170, 50, -170])).toBe(true);
    expect(bboxContains([0, -10, 60, 20], [-85, -180, 85, 180])).toBe(false);
  });
});
