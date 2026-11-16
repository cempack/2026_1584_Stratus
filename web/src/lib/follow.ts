// Follow mode: the camera trails the selected plane with a gentle pitch and a bearing that eases toward the track.

export const FOLLOW_PITCH = 45;

const wrap180 = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;

/** Move `cur` toward `target` (degrees) along the short way by fraction `k`; result in 0..360. */
export function lerpBearing(cur: number, target: number, k: number): number {
  return (((cur + wrap180(target - cur) * Math.min(1, Math.max(0, k))) % 360) + 360) % 360;
}

/** Per-update smoothing factor for a camera updated every `dtMs`, with a time constant of `tauMs` (frame-rate independent). */
export function smoothing(dtMs: number, tauMs = 900): number {
  return 1 - Math.exp(-Math.max(0, dtMs) / tauMs);
}

/** A user gesture ends follow mode, except a wheel zoom (zooming while following is natural). */
export function endsFollow(originalEventType: string | null | undefined): boolean {
  return !!originalEventType && originalEventType !== "wheel";
}
