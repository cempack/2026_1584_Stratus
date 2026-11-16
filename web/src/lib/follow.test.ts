import { describe, expect, it } from "vitest";
import { endsFollow, lerpBearing, smoothing } from "./follow";

describe("follow mode", () => {
  it("turns the short way round 0/360", () => {
    expect(lerpBearing(350, 10, 0.5)).toBeCloseTo(0, 5);
    expect(lerpBearing(10, 350, 0.5)).toBeCloseTo(0, 5);
    expect(lerpBearing(90, 180, 1)).toBeCloseTo(180, 5);
    expect(lerpBearing(90, 180, 0)).toBeCloseTo(90, 5);
  });

  it("smooths independently of the frame rate", () => {
    const two = 1 - (1 - smoothing(16)) ** 2;
    expect(smoothing(32)).toBeCloseTo(two, 6);
    expect(smoothing(0)).toBe(0);
  });

  it("ends on a drag or touch but not on a wheel zoom or a programmatic move", () => {
    expect(endsFollow("mousemove")).toBe(true);
    expect(endsFollow("touchmove")).toBe(true);
    expect(endsFollow("wheel")).toBe(false);
    expect(endsFollow(undefined)).toBe(false);
  });
});
