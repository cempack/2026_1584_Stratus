import { describe, expect, it } from "vitest";
import { type Plane, type Track, decodeRows, mergePlane, reckon } from "./core";

const base: Plane = { hex: "abc123", cs: "AFR1", lat: 40, lon: 0, alt: 36000, gs: 450, trk: 90, vr: 0, gnd: false, ts: 1000, src: "opensky", type: "A320", reg: null, cat: null, sqk: null };

describe("estimated planes", () => {
  it("decodes the est field and stamps the snapshot time as the position time", () => {
    const rows = decodeRows({ v: 1, t: 5000, fields: ["hex", "lat", "lon", "ts", "est"], rows: [["aaa111", 1, 2, 1000, true], ["bbb222", 1, 2, 1000, false], ["ccc333", 1, 2, 1000]] });
    expect(rows[0]).toMatchObject({ est: true, rts: 5000, ts: 1000 });
    expect(rows[1].est).toBeUndefined();
    expect(rows[2].est).toBeUndefined();
  });

  it("dead-reckons from rts, never from the old real fix", () => {
    const est: Plane = { ...base, est: true, rts: 5000 };
    const at = reckon(est, 5000);
    expect(at[0]).toBeCloseTo(40, 9);
    expect(at[1]).toBeCloseTo(0, 9);
    const [, lon] = reckon(est, 5010);
    expect(lon).toBeGreaterThan(0);
    // without rts we cannot know when the position holds: stay put rather than jump ahead by 90 s
    expect(reckon({ ...base, est: true }, 5010)).toEqual([40, 0]);
  });

  it("accepts a newer estimate although ts did not change, and a real fix always wins", () => {
    const store = new Map<string, Track>();
    mergePlane(store, { ...base, est: true, rts: 5000, lat: 41 }, 5000);
    expect(mergePlane(store, { ...base, est: true, rts: 5010, lat: 41.1 }, 5010)).toBe(true);
    expect(store.get("abc123")!.lat).toBe(41.1);
    expect(mergePlane(store, { ...base, est: true, rts: 5005, lat: 99 }, 5011)).toBe(false);
    expect(mergePlane(store, { ...base, ts: 5011, lat: 41.2 }, 5012)).toBe(true);
    const t = store.get("abc123")!;
    expect(t.est).toBe(false);
    expect(t.rts).toBeUndefined();
  });

  it("an old real row does not clear a newer estimate", () => {
    const store = new Map<string, Track>();
    mergePlane(store, { ...base, est: true, rts: 5000 }, 5000);
    expect(mergePlane(store, { ...base, ts: 900 }, 5001)).toBe(false);
    expect(store.get("abc123")!.est).toBe(true);
  });
});
