import { describe, expect, it } from "vitest";
import { capRing, nightPolygons, subSolarPoint } from "./sun";

describe("sun", () => {
  it("sub-solar point at the June solstice noon UTC", () => {
    const p = subSolarPoint(new Date("2026-06-21T12:00:00Z"));
    expect(p.lat).toBeGreaterThan(23.2);
    expect(p.lat).toBeLessThan(23.7);
    expect(Math.abs(p.lon)).toBeLessThan(3);
  });
  it("sun is over the other side of the globe 12 h later", () => {
    const a = subSolarPoint(new Date("2026-03-01T00:00:00Z")), b = subSolarPoint(new Date("2026-03-01T12:00:00Z"));
    const diff = (((a.lon - b.lon) % 360) + 360) % 360;
    expect(Math.abs(diff - 180)).toBeLessThan(2);
  });
  it("cap rings are closed and polygons are well formed for any date", () => {
    for (const d of ["2026-03-20T14:46:00Z", "2026-06-21T12:00:00Z", "2026-12-21T03:00:00Z", "2026-09-23T00:30:00Z"]) {
      const night = nightPolygons(new Date(d));
      expect(night.features).toHaveLength(4);
      for (const f of night.features) {
        const ring = f.geometry.coordinates[0];
        expect(ring[0]).toEqual(ring[ring.length - 1]);
        expect(ring.every(([lo, la]) => Number.isFinite(lo) && Math.abs(la) <= 90)).toBe(true);
      }
    }
  });
  it("a cap around a high-latitude point encloses the pole (ring closes through it)", () => {
    const ring = capRing(60, 10, 90);
    expect(ring.some(([, la]) => la === 90)).toBe(true);
  });
});
