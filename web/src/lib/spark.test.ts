import { describe, expect, it } from "vitest";
import type { TrailPoint } from "../api";
import { sparkline } from "./spark";

const trail = (n: number): TrailPoint[] => Array.from({ length: n }, (_, i) => [48, 2 + i * 0.01, 1000 + i * 300, 1000 + i * 60]);

describe("sparkline", () => {
  it("needs enough points", () => expect(sparkline(trail(2), null, 320, 64)).toBeNull());
  it("maps a climb to a rising path inside the box", () => {
    const s = sparkline(trail(40), { alt: 12800, ts: 1000 + 40 * 60 }, 320, 64)!;
    expect(s.maxAlt).toBe(12800);
    expect(s.last[0]).toBeCloseTo(320, 0);
    expect(s.last[1]).toBeLessThan(64);
    expect(s.line.startsWith("M0.0")).toBe(true);
  });
  it("downsamples", () => expect(sparkline(trail(500), null, 320, 64, 60)!.points).toBeLessThanOrEqual(61));
});
