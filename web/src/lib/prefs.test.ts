import { describe, expect, it } from "vitest";
import { credits } from "./attribution";
import { DEFAULT_PREFS, parsePrefs } from "./prefs";

describe("layer preferences", () => {
  it("defaults to radar and estimated positions on, everything else off", () => {
    expect(parsePrefs(null)).toEqual(DEFAULT_PREFS);
    expect(DEFAULT_PREFS).toMatchObject({ radar: true, est: true, winds: false, metar: false, satellite: false });
  });
  it("migrates the old satellite / radar keys and survives garbage", () => {
    expect(parsePrefs(null, { sat: "1", radar: "0" })).toMatchObject({ satellite: true, radar: false });
    expect(parsePrefs("{oops")).toEqual(DEFAULT_PREFS);
    expect(parsePrefs(JSON.stringify({ winds: true, windLevel: "bogus", radar: "yes" }))).toMatchObject({ winds: true, windLevel: "250", radar: true });
  });
});

describe("attribution", () => {
  it("lists the base data and adds a credit only for the layers that are on", () => {
    const base = credits({ satellite: false, radar: false, winds: false, metar: false }).map((c) => c.name);
    expect(base).toContain("OpenFreeMap");
    expect(base).not.toContain("RainViewer");
    const all = credits({ satellite: true, radar: true, winds: true, metar: true }).map((c) => c.name);
    expect(all).toEqual(expect.arrayContaining(["RainViewer", "Open-Meteo", "aviationweather.gov"]));
    expect(all.some((n) => n.startsWith("Esri"))).toBe(true);
  });
});
