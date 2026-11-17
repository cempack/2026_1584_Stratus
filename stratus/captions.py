"""Live English subtitles for ATC feeds: Whisper transcribes and translates each transmission.

Engine: Whisper large-v3-turbo on Cloudflare Workers AI (worker `stratus-asr`, only callable from the Stratus server's
IP), with the local faster-whisper model as a fallback. The 2-CPU server can only run Whisper "base" in real time,
which is too weak for radio audio; large-v3-turbo is far better and answers in ~1-3 s.

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

import io
import logging
import os
import queue
import re
import threading
import time
import wave
from collections import Counter, deque
from collections.abc import Iterator
from pathlib import Path

import requests

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
REMOTE_URL = "https://stratus-asr.elliotmoreau19.workers.dev/"  # Workers AI, Whisper large-v3-turbo (IP-allowlisted)
REMOTE_PAUSE_S = 600  # after 3 failures in a row, use the local model for this long
WORKERS = 3  # remote calls run in parallel (local ones are serialised by local_lock)
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


def decode_available() -> bool:
    try:
        import av  # noqa: F401
        import numpy  # noqa: F401
        return True
    except Exception:
        return False


def local_available() -> bool:
    try:
        import faster_whisper  # noqa: F401
        return True
    except Exception:
        return False


def to_wav(pcm) -> bytes:
    """16-bit mono WAV of 16 kHz float PCM (what the Worker uploads to Whisper: ~32 KB per second)."""
    import numpy as np
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes((np.clip(pcm, -1, 1) * 32767).astype("<i2").tobytes())
    return buf.getvalue()


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
        self.lock = threading.Lock()
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
    """Engines, in order: the Workers AI Worker (Whisper large-v3-turbo, `remote_url`), then the local faster-whisper
    model if the Worker keeps failing (or locally, where the Worker refuses the caller's IP)."""

    def __init__(self, audio, cache_dir: Path, model: str = "", enabled: bool = True, remote_url: str = REMOTE_URL):
        self.audio = audio
        self.cache_dir = Path(cache_dir) / "whisper"
        self.auto = not model
        self.model_name = model or self._remembered() or "small"
        self.ratio: float | None = None  # EMA of local processing time / audio duration
        self.calls = 0
        self.remote_url = remote_url
        self.remote_off_until = 0.0
        self.remote_fails = 0
        self.remote_ms: float | None = None
        self.http = requests.Session()
        self.enabled = enabled and decode_available() and (bool(remote_url) or local_available())
        self.feeds: dict[str, _Feed] = {}
        self.lock = threading.Lock()
        self.local_lock = threading.Lock()  # one local transcription at a time (CPU bound)
        self.work: queue.Queue = queue.Queue()
        self.model = None
        self.model_state = "ready" if remote_url else "idle"  # idle | loading | ready | error
        self._workers: list[threading.Thread] = []

    def _remembered(self) -> str | None:
        """Model chosen by the automatic fallback on an earlier run (kept on the cache volume)."""
        try:
            name = (self.cache_dir / "auto-model.txt").read_text().strip()
            return name if name in ("small", FALLBACK_MODEL) else None
        except OSError:
            return None

    @property
    def engine(self) -> str:
        return "workers-ai" if self.remote_url and time.monotonic() >= self.remote_off_until else f"local:{self.model_name}"

    def status(self) -> dict:
        return {"enabled": self.enabled, "engine": self.engine, "state": self.model_state, "feeds": len(self.feeds),
                "remote_ms": None if self.remote_ms is None else int(self.remote_ms), "remote_fails": self.remote_fails,
                "local_threads": CPU_THREADS, "cpus": os.cpu_count(),
                "local_speed_ratio": None if self.ratio is None else round(self.ratio, 2)}

    def _drop(self, feed: _Feed) -> None:
        with self.lock:
            if self.feeds.get(feed.url) is feed:
                del self.feeds[feed.url]

    def enqueue(self, feed: _Feed, start: float, pcm) -> None:
        feed.pending.append((start, pcm))
        while len(feed.pending) > BACKLOG:
            feed.pending.popleft()  # stay live: drop the oldest calls rather than fall behind
        self.work.put(feed)

    def _broadcast(self, state: str, detail: str | None = None) -> None:
        for f in list(self.feeds.values()):
            f.publish({"type": "status", "state": state, **({"detail": detail} if detail else {})})

    # ---- local engine ----
    def _load(self) -> bool:
        if self.model is not None:
            return True
        if not local_available():
            return False
        from faster_whisper import WhisperModel
        self.model_state = "loading"
        self._broadcast("loading")
        try:
            self.cache_dir.mkdir(parents=True, exist_ok=True)
            self.model = WhisperModel(self.model_name, device="cpu", compute_type="int8", cpu_threads=CPU_THREADS,
                                      download_root=str(self.cache_dir))
        except Exception as exc:
            log.exception("whisper model load failed")
            self.model_state = "error"
            self._broadcast("error", str(exc)[:120])
            return False
        self.model_state = "ready"
        self._broadcast("ready")
        return True

    def _local(self, pcm, language: str | None) -> tuple[list[str], str | None, float]:
        with self.local_lock:
            if not self._load():
                raise RuntimeError("no local model")
            t0 = time.monotonic()
            segs, info = self.model.transcribe(
                pcm, task="translate", language=language, beam_size=1, temperature=0.0, condition_on_previous_text=False,
                initial_prompt=PROMPT, no_repeat_ngram_size=3, vad_filter=False)
            parts = [s.text for s in segs if not (s.no_speech_prob > 0.6 and s.avg_logprob < -1.0)]
            r = (time.monotonic() - t0) / max(1.0, len(pcm) / RATE)
            self.ratio = r if self.ratio is None else 0.7 * self.ratio + 0.3 * r
            self.calls += 1
            if self.auto and self.model_name != FALLBACK_MODEL and self.calls >= 3 and self.ratio > SLOW_RATIO:
                log.warning("whisper %s too slow here (x%.1f real time): switching to %s", self.model_name, self.ratio, FALLBACK_MODEL)
                self.model_name, self.ratio, self.calls, self.model = FALLBACK_MODEL, None, 0, None
                try:
                    self.cache_dir.mkdir(parents=True, exist_ok=True)
                    (self.cache_dir / "auto-model.txt").write_text(FALLBACK_MODEL)
                except OSError:
                    pass
            return parts, info.language, info.language_probability

    # ---- remote engine (Workers AI) ----
    def _remote(self, pcm, language: str | None) -> tuple[list[str], str | None, float]:
        t0 = time.monotonic()
        params = {"task": "translate", "prompt": PROMPT, **({"language": language} if language else {})}
        resp = self.http.post(self.remote_url, params=params, data=to_wav(pcm), timeout=(5, 30),
                              headers={"Content-Type": "audio/wav", "User-Agent": "Stratus/2.0"})
        resp.raise_for_status()
        d = resp.json()
        ms = (time.monotonic() - t0) * 1000
        self.remote_ms = ms if self.remote_ms is None else 0.7 * self.remote_ms + 0.3 * ms
        segs = d.get("segments") or []
        parts = [s.get("text", "") for s in segs
                 if not ((s.get("no_speech_prob") or 0) > 0.6 and (s.get("avg_logprob") or 0) < -1.0)
                 and (s.get("compression_ratio") or 0) < 2.6] if segs else [d.get("text", "")]
        info = d.get("info") or {}
        return parts, info.get("language"), float(info.get("language_probability") or 0)

    def _transcribe(self, pcm, language: str | None) -> tuple[list[str], str | None, float]:
        if self.remote_url and time.monotonic() >= self.remote_off_until:
            try:
                out = self._remote(pcm, language)
                self.remote_fails = 0
                return out
            except Exception as exc:
                self.remote_fails += 1
                log.info("workers-ai transcription failed (%d): %s", self.remote_fails, exc)
                if self.remote_fails >= 3:
                    log.warning("workers-ai unavailable: local model for %d s", REMOTE_PAUSE_S)
                    self.remote_off_until = time.monotonic() + REMOTE_PAUSE_S
                    self.remote_fails = 0
                if not local_available():
                    raise
        return self._local(pcm, language)

    def _work(self) -> None:
        while True:
            feed = self.work.get()
            with feed.lock:  # one call at a time per feed: captions stay in order
                if not feed.pending:
                    continue
                start, pcm = feed.pending.popleft()
                t0 = time.monotonic()
                known = feed.language
                try:
                    parts, lang, prob = self._transcribe(pcm, known)
                except Exception:
                    log.exception("transcription failed")
                    continue
                if known is None and lang and prob >= 0.7:
                    feed.langs[lang] += 1
                text = _ECHO.sub("", _JUNK.sub(" ", " ".join(parts))).strip(" ,.")
                if not plausible(text):
                    continue
                feed.seq += 1
                feed.publish({"type": "caption", "id": feed.seq, "t": round(start, 1), "dur": round(len(pcm) / RATE, 1),
                              "text": text, "lang": known or feed.language or lang, "ms": int((time.monotonic() - t0) * 1000)})

    def subscribe(self, url: str) -> Iterator[dict]:
        """Events for one feed: the model state, the recent captions, then live ones. Ends when the client leaves."""
        q: queue.Queue = queue.Queue(maxsize=50)
        with self.lock:
            feed = self.feeds.get(url)
            if feed is None:
                feed = self.feeds[url] = _Feed(self, url)
            feed.subs.add(q)
            if not self._workers:
                for i in range(WORKERS):
                    t = threading.Thread(target=self._work, name=f"captions-{i}", daemon=True)
                    t.start()
                    self._workers.append(t)
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
