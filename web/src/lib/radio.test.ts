import { describe, expect, it } from "vitest";
import { Meter, chipLabels, feedKind, parseFreq, stripIcao } from "./radio";

describe("parseFreq", () => {
  it("reads VHF frequencies out of feed labels", () => {
    expect(parseFreq("KJFK Tower 119.1")).toBe("119.100");
    expect(parseFreq("EHAM Approach 118,275 MHz")).toBe("118.275");
    expect(parseFreq("LFPG Tower (Rwy 08L/26R) 119.250")).toBe("119.250");
  });
  it("ignores things that are not frequencies", () => {
    expect(parseFreq("EHAM Tower (Rwy 18R/36L)")).toBeNull();
    expect(parseFreq("KSFO Ground")).toBeNull();
    expect(parseFreq("v2 feed 1234.5")).toBeNull();
  });
});

describe("channels", () => {
  it("classifies channel kinds", () => {
    expect(feedKind("KJFK Tower 119.1").kind).toBe("tower");
    expect(feedKind("EGLL Ground").kind).toBe("ground");
    expect(feedKind("EGLL Approach/Departure").kind).toBe("approach");
    expect(feedKind("KLAX ATIS").kind).toBe("atis");
    expect(feedKind("KLAX Clearance Delivery").kind).toBe("clearance");
    expect(feedKind("something else").kind).toBe("radio");
  });
  it("strips the ICAO prefix and disambiguates duplicate kinds", () => {
    expect(stripIcao("EHAM Tower (Rwy 18R)", "EHAM")).toBe("Tower (Rwy 18R)");
    expect(chipLabels("KJFK", ["KJFK Tower 119.1", "KJFK Ground 121.9"])).toEqual(["Tour", "Sol"]);
    expect(chipLabels("KJFK", ["KJFK Tower 119.1", "KJFK Tower 123.9"])).toEqual(["119.100", "123.900"]);
  });
});

describe("Meter", () => {
  it("stays shut on steady noise and opens on a voice burst", () => {
    const m = new Meter();
    let t = 0;
    for (let i = 0; i < 100; i++) m.push(0.02, (t += 50));
    expect(m.open).toBe(false);
    for (let i = 0; i < 5; i++) m.push(0.25, (t += 50));
    expect(m.open).toBe(true);
    expect(m.level).toBeGreaterThan(0.5);
    for (let i = 0; i < 20; i++) m.push(0.02, (t += 50));
    expect(m.open).toBe(false);
  });
});
