import { describe, expect, it } from "vitest";
import { type WindGrid, advance, degPerPixel, particleCount, sampleWind, unwrapLons } from "./winds";

// 3 columns x 2 rows; rows run north to south.
const grid: WindGrid = {
  nx: 3, ny: 2, lats: [50, 40], lons: [0, 10, 20],
  u: [0, 10, 20, 0, 10, 20], v: [0, 0, 0, 10, 10, 10],
};

describe("wind sampling", () => {
  it("returns grid values at nodes and interpolates between them", () => {
    expect(sampleWind(grid, 50, 0)).toEqual([0, 0]);
    expect(sampleWind(grid, 40, 20)).toEqual([20, 10]);
    const mid = sampleWind(grid, 45, 5)!;
    expect(mid[0]).toBeCloseTo(5, 6);
    expect(mid[1]).toBeCloseTo(5, 6);
  });

  it("is null outside the grid and ignores missing cells", () => {
    expect(sampleWind(grid, 60, 5)).toBeNull();
    expect(sampleWind(grid, 45, 30)).toBeNull();
    const holes: WindGrid = { ...grid, u: [null, 10, 20, 0, 10, 20] };
    expect(sampleWind(holes, 50, 0)).toBeNull();
    const near = sampleWind(holes, 49, 1)!;
    expect(near).not.toBeNull();
    expect(Number.isFinite(near[0])).toBe(true);
  });

  it("handles a grid that crosses the antimeridian", () => {
    expect(unwrapLons([170, 175, -180, -175])).toEqual([170, 175, 180, 185]);
    const g: WindGrid = { nx: 4, ny: 2, lats: [10, 0], lons: [170, 175, -180, -175], u: [1, 2, 3, 4, 1, 2, 3, 4], v: new Array(8).fill(0) };
    expect(sampleWind(g, 5, -177.5)![0]).toBeCloseTo(3.5, 6);
    expect(sampleWind(g, 5, 172.5)![0]).toBeCloseTo(1.5, 6);
  });
});

describe("advection", () => {
  it("moves a constant number of pixels per knot whatever the zoom", () => {
    for (const z of [2, 6, 10]) {
      const dpp = degPerPixel(z);
      const [, lon] = advance(0, 0, 100, 0, dpp, 0.012);
      expect(lon / dpp).toBeCloseTo(1.2, 6);
    }
  });

  it("goes north with a positive v and east with a positive u, widening longitude steps at high latitude", () => {
    const [lat] = advance(10, 0, 0, 50, 0.01, 0.01);
    expect(lat).toBeGreaterThan(10);
    const eq = advance(0, 0, 50, 0, 0.01, 0.01)[1], hi = advance(60, 0, 50, 0, 0.01, 0.01)[1];
    expect(hi).toBeGreaterThan(eq);
  });

  it("wraps the antimeridian and clamps the poles", () => {
    expect(advance(0, 179.99, 500, 0, 0.1, 0.1)[1]).toBeLessThan(0);
    expect(advance(84.99, 0, 0, 500, 0.1, 0.1)[0]).toBe(85);
  });

  it("keeps the particle count light", () => {
    expect(particleCount(1920, 1080, false)).toBeLessThanOrEqual(2200);
    expect(particleCount(360, 740, true)).toBeLessThanOrEqual(1100);
    expect(particleCount(100, 100, false)).toBeGreaterThanOrEqual(200);
  });
});
