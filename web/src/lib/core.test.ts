import { describe, expect, it } from "vitest";
import {
  type Plane, type Track, decodeRows, destination, distanceNm, fmtAlt, fmtSpeed, fmtVr, fmtTrack, formatUrl, greatCircle,
  mergePlane, parseUrl, reckon, renderPos, search, shapeOf, oklchToHex,
} from "./core";

const base: Plane = { hex: "3c6444", cs: "DLH4AB", lat: 48, lon: 2, alt: 36000, gs: 450, trk: 90, vr: 0, gnd: false, ts: 1000, src: "opensky", type: "A320", reg: null, cat: "A3", sqk: null };

describe("decode", () => {
  it("maps rows by field names and drops rows without position", () => {
    const rows = decodeRows({ v: 1, t: 0, fields: ["hex", "lat", "lon", "ts", "gnd"], rows: [["ABC123", 1, 2, 3, true], ["x", null, 2, 3, false]] });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ hex: "abc123", lat: 1, lon: 2, ts: 3, gnd: true, alt: null });
  });
});

describe("dead reckoning", () => {
  it("moves along track at ground speed", () => {
    const [lat, lon] = reckon(base, 1000 + 60);
    expect(distanceNm([48, 2], [lat, lon])).toBeCloseTo(7.5, 1);
    expect(lon).toBeGreaterThan(2);
  });
  it("caps extrapolation at 90 s and ignores ground planes", () => {
    expect(reckon(base, 1000 + 600)).toEqual(reckon(base, 1090));
    expect(reckon({ ...base, gnd: true }, 1060)).toEqual([48, 2]);
  });
});

describe("merge by ts", () => {
  it("only replaces position with newer ts, fills metadata, eases small corrections", () => {
    const store = new Map<string, Track>();
    mergePlane(store, { ...base, cs: null }, 1000);
    expect(mergePlane(store, { ...base, ts: 900, lat: 10, cs: "AFR1" }, 1001)).toBe(false);
    expect(store.get(base.hex)!.lat).toBe(48);
    expect(store.get(base.hex)!.cs).toBe("AFR1");
    expect(mergePlane(store, { ...base, ts: 1005, lat: 48.01 }, 1005)).toBe(true);
    const t = store.get(base.hex)!;
    expect(t.ey).not.toBe(0);
    expect(renderPos(t, 1005)[0]).toBeCloseTo(48, 4); // starts where it was drawn
    expect(renderPos(t, 1006.5)[0]).toBeCloseTo(48.01, 4); // eased in after 1 s
  });
});

describe("geo", () => {
  it("great circle endpoints and continuous longitudes across the antimeridian", () => {
    const pts = greatCircle([35, 170], [35, -170], 10);
    expect(pts[0][0]).toBeCloseTo(170);
    expect(pts[10][0]).toBeCloseTo(190);
    for (let i = 1; i < pts.length; i++) expect(Math.abs(pts[i][0] - pts[i - 1][0])).toBeLessThan(10);
  });
  it("destination round-trips distance", () => {
    expect(distanceNm([0, 0], destination(0, 0, 45, 100))).toBeCloseTo(100, 3);
  });
});

describe("format", () => {
  it("uses aviation units consistently", () => {
    expect(fmtAlt(36000)).toBe("36 000 ft");
    expect(fmtAlt(0, true)).toBe("Au sol");
    expect(fmtSpeed(452.4)).toBe("452 kt");
    expect(fmtVr(-1200)).toBe("−1 200 ft/min");
    expect(fmtVr(30)).toBe("Palier");
    expect(fmtTrack(5)).toBe("005°");
  });
  it("oklch white", () => expect(oklchToHex(1, 0, 0)).toBe("#ffffff"));
});

describe("shape", () => {
  it("classifies", () => {
    expect(shapeOf("A5", "B77W")).toBe("heavy");
    expect(shapeOf("A3", "A320")).toBe("jet");
    expect(shapeOf("A2", "AT76")).toBe("turboprop");
    expect(shapeOf("A7", null)).toBe("heli");
    expect(shapeOf("A1", "C172")).toBe("light");
    expect(shapeOf("B1", null)).toBe("other");
  });
});

describe("search", () => {
  const items = [
    { key: "a", kind: "plane" as const, fields: [{ value: "AFR123", label: "Vol", weight: 10 }, { value: "A320", label: "Type", weight: 3 }] },
    { key: "b", kind: "plane" as const, fields: [{ value: "AFR1234", label: "Vol", weight: 10 }] },
    { key: "c", kind: "plane" as const, fields: [{ value: "F-GKXA", label: "Immat", weight: 9 }] },
  ];
  it("ranks exact above prefix and ignores punctuation", () => {
    expect(search(items, "afr123").map((h) => h.key)).toEqual(["a", "b"]);
    expect(search(items, "fgkxa")[0].key).toBe("c");
    expect(search(items, "")).toEqual([]);
  });
});

describe("url", () => {
  it("round-trips", () => {
    const s = parseUrl("?ll=48.85,2.35&z=7", "#/flight/3C6444");
    expect(s).toEqual({ hex: "3c6444", apt: null, ll: [48.85, 2.35], z: 7 });
    expect(formatUrl(s)).toBe("?ll=48.8500,2.3500&z=7.00#/flight/3c6444");
    expect(parseUrl("?ll=999,1", "#nope")).toEqual({ hex: null, apt: null, ll: null, z: null });
    expect(parseUrl("", "#/airport/lfpg").apt).toBe("LFPG");
    expect(formatUrl({ hex: null, apt: "LFPG", ll: null, z: null })).toBe("#/airport/LFPG");
  });
});
