import { describe, expect, it } from "vitest";
import { fmtShift, loadZones, localInfo, zoneAt, zoneOffsetMin } from "./localtime";

describe("local time", () => {
  it("formats offsets from the viewer", () => {
    expect(fmtShift(0)).toBe("");
    expect(fmtShift(480)).toBe("+8 h");
    expect(fmtShift(-90)).toBe("−1 h 30");
    expect(fmtShift(30)).toBe("+30 min");
  });
  it("finds zones and offsets", async () => {
    await loadZones();
    expect(zoneAt(35.55, 139.78)).toBe("Asia/Tokyo"); // Haneda
    expect(zoneAt(49.01, 2.55)).toBe("Europe/Paris"); // CDG
    expect(zoneOffsetMin("Asia/Tokyo", new Date("2026-11-18T12:00:00Z"))).toBe(540);
    expect(zoneOffsetMin("Europe/Paris", new Date("2026-07-01T12:00:00Z"))).toBe(120);
  });
  it("gives the next sunrise and sunset", async () => {
    await loadZones();
    const i = localInfo(49.01, 2.55, new Date("2026-11-18T12:00:00Z"))!; // Paris, winter noon
    expect(i.night).toBe(false);
    expect(i.set!.getUTCHours()).toBe(16); // ~17:00 local
    expect(i.rise!.getUTCHours()).toBe(7); // ~08:10 local, next morning
  });
});
