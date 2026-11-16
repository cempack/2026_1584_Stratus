// Layout rules shared by the TypeScript side and mirrored in CSS (breakpoints). One place for the numbers.

export const PHONE_MAX = 719;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export const isPhone = (w: number) => w <= PHONE_MAX;

/** Width of the docked flight/airport card on desktop and tablet (0 on phones, where it is a bottom sheet). */
export function dockWidth(w: number): number {
  return isPhone(w) ? 0 : clamp(Math.round(w * 0.3), 328, 392);
}

/** Visible height of the bottom sheet when collapsed (phones). */
export function peekHeight(h: number): number {
  return clamp(Math.round(h * 0.3), 168, 216);
}

export interface Pad { top: number; right: number; bottom: number; left: number }

/** Map padding so the camera centres on the part of the map the open card leaves visible. */
export function mapPadding(o: { w: number; h: number; panel: boolean }): Pad {
  const none = { top: 0, right: 0, bottom: 0, left: 0 };
  if (!o.panel) return none;
  return isPhone(o.w) ? { ...none, bottom: peekHeight(o.h) } : { ...none, right: dockWidth(o.w) + 32 };
}

export type SlotMode = "none" | "radar" | "mini";
/**
 * What lives in the bottom-centre slot. The ATC mini-player wins over the radar pill (never both); on phones the slot
 * is empty while the flight sheet is open, because the sheet owns the bottom of the screen.
 */
export function slotMode(o: { mini: boolean; radar: boolean; phone: boolean; panel: boolean }): SlotMode {
  if (o.phone && o.panel) return "none";
  if (o.mini) return "mini";
  return o.radar ? "radar" : "none";
}
