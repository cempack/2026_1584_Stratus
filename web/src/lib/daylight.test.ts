import { describe, expect, it } from "vitest";
import { guessPlace, isNight, nextSwitch, sunElevation } from "./daylight";

const PARIS = { lat: 48.85, lon: 2.35 };

describe("auto theme daylight", () => {
  it("guesses a place from the time zone", () => {
    expect(guessPlace("Europe/Paris", -60)).toEqual({ lat: 48, lon: 15 });
    expect(guessPlace("Australia/Sydney", -600).lat).toBeLessThan(0);
    expect(guessPlace(undefined, 300)).toEqual({ lat: 45, lon: -75 });
  });
  it("noon is day, midnight is night, in Paris in June", () => {
    expect(sunElevation(new Date("2026-06-21T11:50:00Z"), PARIS)).toBeGreaterThan(60);
    expect(isNight(new Date("2026-06-21T12:00:00Z"), PARIS)).toBe(false);
    expect(isNight(new Date("2026-06-21T23:00:00Z"), PARIS)).toBe(true);
  });
  it("finds the next switch around a Paris winter sunset (~16:00 UTC)", () => {
    const t = nextSwitch(new Date("2026-12-15T12:00:00Z"), PARIS)!;
    expect(t.getUTCHours()).toBe(16);
    expect(isNight(t, PARIS)).toBe(true);
  });
});
