"""Live English subtitles for ATC feeds: Whisper (faster-whisper, CPU) transcribes and translates each transmission.

Pipeline, per feed (shared by every subscriber, like the audio relay):
  relay MP3 bytes -> PyAV incremental decode -> 16 kHz mono PCM -> squelch splitter -> one Whisper worker -> subscribers

- Splitting: ATC audio is squelched, so the carrier is near-silent between calls. A transmission starts when the frame
  energy rises above an adaptive threshold and ends after SILENCE_S of quiet (or at MAX_TX_S). One subtitle = one call.
- Whisper's `translate` task outputs English from any language (Russian, German...) and transcribes English as is.
- Cost control: nothing runs until someone turns subtitles on; one global worker thread with CPU_THREADS threads serves
  every feed, a feed with a backlog drops its oldest calls to stay live, and a feed stops IDLE_S after its last
  subscriber. The model loads on first use (downloaded once into the cache dir).
"""

from __future__ import annotations

import logging
import os
import queue
import re
import threading
import time
from collections import Counter, deque
from collections.abc import Iterator
from pathlib import Path

log = logging.getLogger("stratus.captions")

RATE = 16000
FRAME = 480  # 30 ms
SILENCE_S = 0.7
MAX_TX_S = 12.0
MIN_TX_S = 0.5
PRE_ROLL_S = 0.25
IDLE_S = 20.0
HISTORY = 6
BACKLOG = 3
CPU_THREADS = max(2, min(4, (os.cpu_count() or 2) // 2))
FALLBACK_MODEL = "base"  # ~3x faster than "small": used when "small" can't keep up with real time on this machine
SLOW_RATIO = 1.0  # processing time / audio duration above which the model is too slow
PROMPT = ("Air traffic control radio. Runway, cleared for takeoff, cleared to land, line up and wait, contact departure, "
          "climb and maintain, descend, heading, flight level, squawk, roger, wilco, tower, ground, approach.")
_JUNK = re.compile(r"_{2,}|\s{2,}")
_WORD = re.compile(r"[a-z]+")
_ECHO = re.compile(r"^\s*air traffic control radio[.,]?\s*", re.I)  # the prompt's opening, echoed on unclear audio
_PROMPT_WORDS = set(_WORD.findall(PROMPT.lower()))


def plausible(text: str) -> bool:
    """Reject the usual Whisper failure modes on radio noise: non-English output (the task is translate-to-English),
    the vocabulary prompt echoed back, and stock filler."""
    letters = [c for c in text if c.isalpha()]
    if not letters or sum(c.isascii() for c in letters) / len(letters) < 0.8:
        return False
    words = _WORD.findall(text.lower())
    if not words or text.lower().strip(" .!") in {"you", "thank you", "thanks for watching", "bye"}:
        return False
    if len(words) == 1 and words[0] in {"the", "a", "uh", "um", "so", "and", "okay"}:
        return False
    if len(words) >= 4 and sum(w in _PROMPT_WORDS for w in words) / len(words) > 0.85 and "air traffic control radio" in text.lower():
        return False
    return True


def available() -> bool:
    try:
        import av  # noqa: F401
        import faster_whisper  # noqa: F401
        return True
    except Exception:
        return False


class Splitter:
    """Squelch-based transmission splitter over 16 kHz float PCM. `push` returns finished transmissions."""

    def __init__(self):
        import numpy as np
        self.np = np
        self.rest = np.zeros(0, dtype=np.float32)
        self.pre: deque = deque(maxlen=max(1, int(PRE_ROLL_S * RATE / FRAME)))
        self.cur: list = []
        self.quiet = 0
        self.recent: deque = deque(maxlen=300)  # ~9 s of frame energies
        self.floor = 0.002
        self.started_at = 0.0

    def push(self, pcm, now: float) -> list[tuple[float, object]]:
        np = self.np
        buf = np.concatenate([self.rest, pcm])
        n = len(buf) // FRAME
        self.rest = buf[n * FRAME:]
        out = []
        for fr in buf[: n * FRAME].reshape(-1, FRAME) if n else ():
            e = float(np.sqrt(np.mean(fr * fr)))
            # noise floor = a low percentile of the last seconds, whatever the state: some feeds hiss between calls
            self.recent.append(e)
            if len(self.recent) % 25 == 0 or len(self.recent) < 25:
                self.floor = float(np.percentile(self.recent, 20))
            loud = e > max(0.012, self.floor * 2.5)
            if not self.cur:
                if loud:
                    self.cur = list(self.pre) + [fr]
                    self.quiet = 0
                    self.started_at = now
                else:
                    self.pre.append(fr)
                continue
            self.cur.append(fr)
            self.quiet = 0 if loud else self.quiet + 1
            dur = len(self.cur) * FRAME / RATE
            if self.quiet * FRAME / RATE >= SILENCE_S or dur >= MAX_TX_S:
                speech = dur - self.quiet * FRAME / RATE
                if speech >= MIN_TX_S:
                    out.append((self.started_at, np.concatenate(self.cur)))
                self.cur, self.quiet = [], 0
                self.pre.clear()
        return out


class _Feed:
    def __init__(self, hub: "CaptionHub", url: str):
        self.hub, self.url = hub, url
        self.subs: set[queue.Queue] = set()
        self.history: deque = deque(maxlen=HISTORY)
        self.pending: deque = deque()
        self.last_sub = time.monotonic()
        self.stop = threading.Event()
        self.seq = 0
        self.langs: Counter = Counter()  # confident language detections: the feed's language once it is clear
        threading.Thread(target=self._run, name=f"captions:{url[-24:]}", daemon=True).start()

    @property
    def language(self) -> str | None:
        if not self.langs:
            return None
        lang, n = self.langs.most_common(1)[0]
        return lang if n >= 3 and n >= 0.6 * sum(self.langs.values()) else None

    def publish(self, event: dict) -> None:
        if event.get("type") == "caption":
            self.history.append(event)
        for q in list(self.subs):
            try:
                q.put_nowait(event)
            except queue.Full:
                pass

    def _run(self) -> None:
        import av
        import numpy as np
        try:
            relay = self.hub.audio.open(self.url)
        except Exception as exc:
            self.publish({"type": "status", "state": "error", "detail": str(exc)[:120]})
            self.hub._drop(self)
            return
        codec = av.CodecContext.create("mp3", "r")
        resampler = av.AudioResampler(format="flt", layout="mono", rate=RATE)
        split = Splitter()
        try:
            for chunk in relay.stream():
                if self.stop.is_set():
                    break
                if not self.subs and time.monotonic() - self.last_sub > IDLE_S:
                    break
                now = time.time()
                try:
                    for pkt in codec.parse(chunk):
                        for frame in codec.decode(pkt):
                            for f in resampler.resample(frame):
                                for start, pcm in split.push(f.to_ndarray().reshape(-1).astype(np.float32), now):
                                    self.hub.enqueue(self, start, pcm)
                except av.error.FFmpegError:
                    codec = av.CodecContext.create("mp3", "r")  # corrupt frame: restart the decoder
        except Exception:
            log.exception("caption feed %s failed", self.url)
        finally:
            self.hub._drop(self)
            if self.subs:
                self.publish({"type": "status", "state": "ended"})  # the client reconnects


class CaptionHub:
    def __init__(self, audio, cache_dir: Path, model: str = "", enabled: bool = True):
        """`model` empty = automatic: "small", stepping down to FALLBACK_MODEL if it is slower than real time."""
        self.audio = audio
        self.cache_dir = Path(cache_dir) / "whisper"
        self.auto = not model
        self.model_name = model or "small"
        self.ratio: float | None = None  # EMA of processing time / audio duration
        self.calls = 0
        self.enabled = enabled and available()
        self.feeds: dict[str, _Feed] = {}
        self.lock = threading.Lock()
        self.work: queue.Queue = queue.Queue()
        self.model = None
        self.model_state = "idle"  # idle | loading | ready | error
        self._worker: threading.Thread | None = None

    def status(self) -> dict:
        return {"enabled": self.enabled, "model": self.model_name, "auto": self.auto, "state": self.model_state,
                "feeds": len(self.feeds), "threads": CPU_THREADS, "cpus": os.cpu_count(),
                "speed_ratio": None if self.ratio is None else round(self.ratio, 2)}

    def _drop(self, feed: _Feed) -> None:
        with self.lock:
            if self.feeds.get(feed.url) is feed:
                del self.feeds[feed.url]

    def enqueue(self, feed: _Feed, start: float, pcm) -> None:
        feed.pending.append((start, pcm))
        while len(feed.pending) > BACKLOG:
            feed.pending.popleft()  # stay live: drop the oldest calls rather than fall behind
        self.work.put(feed)

    def _load(self) -> None:
        from faster_whisper import WhisperModel
        self.model_state = "loading"
        for f in list(self.feeds.values()):
            f.publish({"type": "status", "state": "loading"})
        try:
            self.cache_dir.mkdir(parents=True, exist_ok=True)
            self.model = WhisperModel(self.model_name, device="cpu", compute_type="int8", cpu_threads=CPU_THREADS,
                                      download_root=str(self.cache_dir))
            self.model_state = "ready"
        except Exception as exc:
            log.exception("whisper model load failed")
            self.model_state = "error"
            for f in list(self.feeds.values()):
                f.publish({"type": "status", "state": "error", "detail": str(exc)[:120]})
            return
        for f in list(self.feeds.values()):
            f.publish({"type": "status", "state": "ready"})

    def _work(self) -> None:
        self._load()
        while True:
            feed = self.work.get()
            if not feed.pending or self.model is None:
                continue
            start, pcm = feed.pending.popleft()
            t0 = time.monotonic()
            try:
                known = feed.language
                segs, info = self.model.transcribe(
                    pcm, task="translate", language=known, beam_size=1, temperature=0.0, condition_on_previous_text=False,
                    initial_prompt=PROMPT, no_repeat_ngram_size=3, vad_filter=False)
                parts = [s.text for s in segs if not (s.no_speech_prob > 0.6 and s.avg_logprob < -1.0)]
            except Exception:
                log.exception("transcription failed")
                continue
            if known is None and info.language_probability >= 0.7:
                feed.langs[info.language] += 1
            text = _ECHO.sub("", _JUNK.sub(" ", " ".join(parts))).strip(" ,.")
            if not plausible(text):
                continue
            took = time.monotonic() - t0
            r = took / max(1.0, len(pcm) / RATE)
            self.ratio = r if self.ratio is None else 0.7 * self.ratio + 0.3 * r
            self.calls += 1
            if self.auto and self.model_name != FALLBACK_MODEL and self.calls >= 3 and self.ratio > SLOW_RATIO:
                log.warning("whisper %s too slow here (x%.1f real time): switching to %s", self.model_name, self.ratio, FALLBACK_MODEL)
                self.model_name, self.ratio, self.calls = FALLBACK_MODEL, None, 0
                self._load()
            feed.seq += 1
            feed.publish({"type": "caption", "id": feed.seq, "t": round(start, 1), "dur": round(len(pcm) / RATE, 1),
                          "text": text, "lang": known or feed.language or info.language, "ms": int((time.monotonic() - t0) * 1000)})

    def subscribe(self, url: str) -> Iterator[dict]:
        """Events for one feed: the model state, the recent captions, then live ones. Ends when the client leaves."""
        q: queue.Queue = queue.Queue(maxsize=50)
        with self.lock:
            feed = self.feeds.get(url)
            if feed is None:
                feed = self.feeds[url] = _Feed(self, url)
            feed.subs.add(q)
            if self._worker is None:
                self._worker = threading.Thread(target=self._work, name="whisper", daemon=True)
                self._worker.start()
        try:
            yield {"type": "status", "state": self.model_state if self.model_state != "idle" else "loading"}
            for ev in list(feed.history):
                yield ev
            while True:
                try:
                    yield q.get(timeout=15)
                except queue.Empty:
                    yield {"type": "ping"}
        finally:
            with self.lock:
                feed.subs.discard(q)
                feed.last_sub = time.monotonic()
