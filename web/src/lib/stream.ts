// Low-latency MP3 radio playback through Media Source Extensions.
//
// Why: with `<audio src=stream>` the browser buffers a large chunk before starting, which at 8-32 kbps is 10-30 s
// of "connecting". Here we fetch() the stream ourselves and append each chunk to a SourceBuffer, so playback starts
// as soon as the first frames arrive. The server sends a burst of recent audio first; we start ~LIVE_LAG_S behind
// its end so the listener hears live traffic, not the past 15 s.

const MIME = "audio/mpeg";
const LIVE_LAG_S = 2.5;
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
  private stopped = false;
  private synced = false;

  /** `onEnd(error)` fires once when the stream ends (null = closed by the server) or fails; never after stop(). */
  constructor(private audio: HTMLAudioElement, private url: string, private onEnd: (error: string | null) => void) {
    const ms = new MSE!();
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
    const b = sb.buffered;
    if (b.length) {
      const end = b.end(b.length - 1);
      if (!this.synced || end - au.currentTime > MAX_LAG_S) {
        // first data (the burst) or after a long stall: sit just behind the live edge
        const target = Math.max(b.start(0), end - LIVE_LAG_S);
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

  private finish(error: string | null) {
    if (this.stopped) return;
    this.stopped = true;
    this.onEnd(error);
  }

  stop() {
    this.stopped = true;
    this.abort.abort();
    this.queue = [];
    URL.revokeObjectURL(this.objectUrl);
  }
}
