"""Shared ATC audio relay with burst-on-connect.

LiveATC feeds are 8-32 kbps MP3. A browser needs several KB before it starts playing, which at 2.5 KB/s means a long
"connecting" wait. The hub keeps one upstream connection per feed, shared by every listener, plus a ring of the last
~BURST bytes: a new listener receives that ring at once (a few seconds of real audio) and then the live bytes. That is
what Icecast calls burst-on-connect. The upstream is dropped IDLE_S after its last listener leaves.
"""

from __future__ import annotations

import logging
import threading
import time
from collections.abc import Iterator

import requests

log = logging.getLogger("stratus.audio")

BURST = 48 * 1024  # ~15 s at 24 kbps
IDLE_S = 20.0
FIRST_BYTE_S = 12.0


def mp3_sync(buf: bytes | bytearray, start: int = 0) -> int:
    """Offset of the first plausible MPEG audio frame header at or after `start`, or `start` when none is found."""
    n = len(buf)
    i = start
    while i < n - 1:
        if buf[i] == 0xFF and (buf[i + 1] & 0xE0) == 0xE0 and (buf[i + 1] & 0x06) != 0:
            return i
        i += 1
    return start


class Unavailable(Exception):
    pass


class _Relay:
    def __init__(self, url: str, headers: dict, on_done):
        self.url = url
        self.headers = headers
        self.on_done = on_done
        self.cond = threading.Condition()
        self.ring = bytearray()
        self.end = 0  # absolute offset of the byte after the last one received
        self.listeners = 0
        self.idle_since = time.monotonic()
        self.closed = False
        self.error: str | None = None
        self.content_type = "audio/mpeg"
        threading.Thread(target=self._run, name=f"audio-relay {url[-24:]}", daemon=True).start()

    def _run(self):
        try:
            with requests.get(self.url, headers=self.headers, timeout=(8, 20), stream=True) as up:
                up.raise_for_status()
                self.content_type = up.headers.get("Content-Type", "audio/mpeg").split(";")[0] or "audio/mpeg"
                for chunk in up.iter_content(1024):
                    if not chunk:
                        continue
                    with self.cond:
                        self.ring += chunk
                        if len(self.ring) > BURST:
                            del self.ring[: len(self.ring) - BURST]
                        self.end += len(chunk)
                        self.cond.notify_all()
                        if self.listeners == 0 and time.monotonic() - self.idle_since > IDLE_S:
                            break
        except requests.RequestException as exc:
            self.error = str(exc)
            log.info("audio upstream %s: %s", self.url, exc)
        finally:
            with self.cond:
                self.closed = True
                self.cond.notify_all()
            self.on_done(self)

    def wait_ready(self, timeout: float) -> None:
        with self.cond:
            self.cond.wait_for(lambda: self.end > 0 or self.closed, timeout)
            if self.end == 0:
                raise Unavailable(self.error or "no audio from upstream")

    def stream(self) -> Iterator[bytes]:
        with self.cond:
            self.listeners += 1
            burst = bytes(self.ring)
            pos = self.end
        try:
            cut = mp3_sync(burst)
            if burst[cut:]:
                yield burst[cut:]
            while True:
                with self.cond:
                    self.cond.wait_for(lambda: self.end > pos or self.closed, 30)
                    if self.end <= pos:
                        return  # closed, or 30 s without a byte
                    first = self.end - len(self.ring)
                    if pos < first:  # this listener fell behind the ring: skip ahead
                        pos = first
                    data = bytes(self.ring[pos - first :])
                    pos = self.end
                yield data
        finally:
            with self.cond:
                self.listeners -= 1
                if self.listeners == 0:
                    self.idle_since = time.monotonic()


class AudioHub:
    def __init__(self, headers: dict):
        self.headers = headers
        self.lock = threading.Lock()
        self.relays: dict[str, _Relay] = {}

    def _done(self, relay: _Relay):
        with self.lock:
            if self.relays.get(relay.url) is relay:
                del self.relays[relay.url]

    def open(self, url: str) -> _Relay:
        """Relay for `url`, started if needed and holding at least one byte; raises Unavailable otherwise."""
        with self.lock:
            relay = self.relays.get(url)
            if relay is None or relay.closed:
                relay = self.relays[url] = _Relay(url, self.headers, self._done)
        relay.wait_ready(FIRST_BYTE_S)
        return relay

    def status(self) -> dict:
        with self.lock:
            return {"relays": len(self.relays), "listeners": sum(r.listeners for r in self.relays.values())}
