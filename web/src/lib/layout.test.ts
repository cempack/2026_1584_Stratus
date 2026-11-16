import { describe, expect, it } from "vitest";
import { dockWidth, isPhone, mapPadding, peekHeight, slotMode } from "./layout";

describe("layout", () => {
  it("switches to the phone layout at 720 px", () => {
    expect(isPhone(360)).toBe(true);
    expect(isPhone(719)).toBe(true);
    expect(isPhone(720)).toBe(false);
  });

  it.each([[360, 0], [768, 328], [1280, 384], [1920, 392]])("dock width at %i px is %i", (w, d) => {
    expect(dockWidth(w)).toBe(d);
  });

  it("never lets the dock take more than half of a 720 px tablet", () => {
    expect(dockWidth(720)).toBeLessThanOrEqual(360);
  });

  it("reserves map padding for the card: right on desktop, bottom on phones, none when closed", () => {
    expect(mapPadding({ w: 1280, h: 800, panel: false })).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
    expect(mapPadding({ w: 1280, h: 800, panel: true })).toEqual({ top: 0, right: 384 + 32, bottom: 0, left: 0 });
    const phone = mapPadding({ w: 360, h: 740, panel: true });
    expect(phone.right).toBe(0);
    expect(phone.bottom).toBe(peekHeight(740));
    expect(peekHeight(300)).toBe(168);
    expect(peekHeight(2000)).toBe(216);
  });

  it("puts one thing in the bottom slot: the mini-player beats the radar pill, phones with a sheet get nothing", () => {
    expect(slotMode({ mini: true, radar: true, phone: false, panel: false })).toBe("mini");
    expect(slotMode({ mini: false, radar: true, phone: false, panel: true })).toBe("radar");
    expect(slotMode({ mini: false, radar: false, phone: false, panel: false })).toBe("none");
    expect(slotMode({ mini: true, radar: true, phone: true, panel: true })).toBe("none");
    expect(slotMode({ mini: false, radar: true, phone: true, panel: false })).toBe("radar");
  });
});
