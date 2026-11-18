import { describe, expect, it } from "vitest";
import { Meter, chipLabels, feedKind, parseFreq, primaryFreq, stripIcao } from "./radio";

describe("parseFreq", () => {
  it("reads VHF frequencies out of feed labels exactly as written (no invented digits)", () => {
    expect(parseFreq("KJFK Tower 119.1")).toBe("119.1");
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
    expect(chipLabels("KJFK", ["KJFK Tower 119.1", "KJFK Tower 123.9"])).toEqual(["119.1", "123.9"]);
  });
});

describe("primary frequency", () => {
  const listed = [{ mhz: "121.650", name: "JFK Ground" }, { mhz: "119.100", name: "JFK Tower (4R/22L)" }];
  it("headlines the listed frequency matching the channel kind, else the first listed", () => {
    expect(primaryFreq("KJFK Tower", listed)?.mhz).toBe("119.100");
    expect(primaryFreq("KJFK Del/Gnd", listed)?.mhz).toBe("121.650");
    expect(primaryFreq("KJFK Radio", listed)?.mhz).toBe("121.650");
  });
  it("falls back to a frequency written in the label, else nothing", () => {
    expect(primaryFreq("KJFK Tower 119.1", [])).toEqual({ mhz: "119.1", name: "KJFK Tower 119.1" });
    expect(primaryFreq("KJFK Tower", undefined)).toBeNull();
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
