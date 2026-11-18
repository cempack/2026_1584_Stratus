// Low-latency MP3 radio playback through Media Source Extensions.
//
// Why: with `<audio src=stream>` the browser buffers a large chunk before starting, which at 8-32 kbps is 10-30 s
// of "connecting". Here we fetch() the stream ourselves and append each chunk to a SourceBuffer, so playback starts
// as soon as the first frames arrive. The server sends a burst of recent audio first; we start ~LIVE_LAG_S behind
// its end so the listener hears live traffic, not the past 15 s.

const MIME = "audio/mpeg";
export const LIVE_LAG_S = 2.5;
/** With subtitles on, play further behind live so each caption is ready when its call is heard (Whisper ~1-3 s). */
export const CAPTION_LAG_S = 6;
const MAX_LAG_S = 10; // after a stall, jump back to the live edge instead of drifting further behind
const KEEP_S = 20; // seconds of played audio kept in the SourceBuffer

type MS = typeof MediaSource;
const MSE: MS | undefined = (globalThis as unknown as { ManagedMediaSource?: MS }).ManagedMediaSource ?? globalThis.MediaSource;

export const mseSupported = (): boolean => {
  try { return !!MSE && MSE.isTypeSupported(MIME); } catch { return false; }
};

export class MseStream {
  private abort = new AbortController();
  private queue: Uint8Array[] = [];
  private sb?: SourceBuffer;
  private objectUrl: string;
  private ms: MediaSource;
  private stopped = false;
  private synced = false;
  private lag = LIVE_LAG_S;

  /** `onEnd(error)` fires once when the stream ends (null = closed by the server) or fails; never after stop(). */
  constructor(private audio: HTMLAudioElement, private url: string, private onEnd: (error: string | null) => void) {
    const ms = new MSE!();
    this.ms = ms;
    this.objectUrl = URL.createObjectURL(ms);
    // ManagedMediaSource (Safari) only streams when remote playback is disabled
    (audio as HTMLAudioElement & { disableRemotePlayback: boolean }).disableRemotePlayback = true;
    audio.src = this.objectUrl;
    ms.addEventListener("sourceopen", () => this.open(ms), { once: true });
  }

  private async open(ms: MediaSource) {
    if (this.stopped) return;
    try {
      this.sb = ms.addSourceBuffer(MIME);
      this.sb.mode = "sequence";
      this.sb.addEventListener("updateend", () => this.pump());
      const res = await fetch(this.url, { signal: this.abort.signal, cache: "no-store" });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value?.byteLength) { this.queue.push(value); this.pump(); }
      }
      this.finish(null);
    } catch (e) {
      this.finish((e as Error)?.name === "AbortError" ? null : String((e as Error)?.message ?? e));
    }
  }

  private pump() {
    const sb = this.sb, au = this.audio;
    if (!sb || sb.updating || this.stopped) return;
    if (au.src !== this.objectUrl) { this.stop(); return; } // the element plays something else now: this stream is orphaned
    const b = sb.buffered;
    if (b.length) {
      const end = b.end(b.length - 1);
      if (!this.synced || end - au.currentTime > Math.max(MAX_LAG_S, this.lag + 4)) { // a chosen delay is not a stall
        // first data (the burst) or after a long stall: sit just behind the live edge
        const target = Math.max(b.start(0), end - this.lag);
        if (target > au.currentTime + 0.5 || !this.synced) au.currentTime = target;
        this.synced = true;
      }
      const start = b.start(0);
      if (au.currentTime - start > KEEP_S * 1.5) {
        sb.remove(start, au.currentTime - KEEP_S);
        return; // updateend calls pump() again
      }
    }
    if (!this.queue.length) return;
    const total = this.queue.reduce((n, c) => n + c.byteLength, 0);
    const chunk = new Uint8Array(total);
    let o = 0;
    for (const c of this.queue) { chunk.set(c, o); o += c.byteLength; }
    this.queue = [];
    try {
      sb.appendBuffer(chunk);
    } catch (e) {
      if ((e as DOMException)?.name === "QuotaExceededError" && b.length) {
        this.queue.unshift(chunk);
        sb.remove(b.start(0), Math.max(b.start(0) + 1, au.currentTime - 2));
      } else this.finish(String(e));
    }
  }

  /**
   * Target distance to the live edge (s). Before anything is heard, the first sync jumps straight there. Once audio
   * is playing it is NEVER reached by jumping (a jump back replays seconds of audio): adjust() eases into it.
   */
  setLag(seconds: number) {
    const shrink = this.synced && seconds < this.lag - 3;
    this.lag = seconds;
    // much less delay wanted (subtitles switched off): jump forward, which skips audio but never repeats it
    const b = this.sb?.buffered;
    if (shrink && b?.length) this.audio.currentTime = Math.max(this.audio.currentTime, b.end(b.length - 1) - seconds);
  }

  /**
   * Called a few times a second: steer the playback rate toward the target delay. More delay is gained mostly in the
   * silences between calls (0.8x on silence is inaudible), barely during speech (0.95x, pitch preserved); too far
   * behind, catch up at 1.06x.
   */
  adjust(quiet: boolean) {
    const behind = this.behind;
    if (behind == null || !this.synced) return;
    const err = this.lag - behind;
    const rate = err > 0.25 ? (quiet ? 0.8 : 0.95) : err < -2 ? 1.06 : 1;
    const au = this.audio as HTMLAudioElement & { preservesPitch?: boolean };
    if (au.playbackRate !== rate) { au.preservesPitch = true; au.playbackRate = rate; }
  }

  /** How far behind the live edge playback is right now (s); null before data arrives. */
  get behind(): number | null {
    const b = this.sb?.buffered;
    return b?.length ? Math.max(0, b.end(b.length - 1) - this.audio.currentTime) : null;
  }

  private finish(error: string | null) {
    if (this.stopped) return;
    this.stopped = true;
    this.onEnd(error);
  }

  stop() {
    this.stopped = true;
    this.abort.abort();
    this.queue = [];
    try { if (this.ms.readyState === "open" && !this.sb?.updating) this.ms.endOfStream(); } catch { /* already detached */ }
    URL.revokeObjectURL(this.objectUrl);
  }
}
