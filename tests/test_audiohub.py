import threading
import time

import pytest
import requests

from stratus import audiohub
from stratus.audiohub import AudioHub, Unavailable, mp3_sync

FRAME = b"\xff\xf3\x44\xc4" + b"\x00" * 60  # MPEG-2 layer III header + payload


class FakeUpstream:
    """Context-manager response whose iter_content yields frames until `stop` is set."""

    opened = 0

    def __init__(self, stop: threading.Event):
        FakeUpstream.opened += 1
        self.stop = stop
        self.headers = {"Content-Type": "audio/mpeg"}

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def raise_for_status(self):
        pass

    def iter_content(self, _n):
        yield b"\x12\x34junk" + FRAME  # starts mid-frame, like a real stream
        while not self.stop.is_set():
            time.sleep(0.01)
            yield FRAME


@pytest.fixture
def upstream(monkeypatch):
    stop = threading.Event()
    FakeUpstream.opened = 0
    monkeypatch.setattr(audiohub.requests, "get", lambda *a, **k: FakeUpstream(stop))
    yield stop
    stop.set()


def test_mp3_sync_skips_partial_frame():
    assert mp3_sync(b"\x12\x34junk" + FRAME) == 6
    assert mp3_sync(b"no sync here") == 0


def test_burst_then_live_and_shared_upstream(upstream):
    hub = AudioHub({})
    relay = hub.open("http://feed/a")
    time.sleep(0.1)  # let the ring fill with a few frames
    first = next(relay.stream())
    assert first.startswith(b"\xff\xf3"), "burst must start on a frame header"
    assert len(first) > len(FRAME), "a new listener gets the buffered audio at once"
    again = hub.open("http://feed/a")
    assert again is relay and FakeUpstream.opened == 1
    gen = again.stream()
    next(gen)
    assert next(gen).startswith(b"\xff")  # live bytes keep coming
    assert hub.status()["relays"] == 1


def test_unavailable_upstream_raises(monkeypatch):
    def boom(*a, **k):
        raise requests.ConnectionError("refused")

    monkeypatch.setattr(audiohub.requests, "get", boom)
    with pytest.raises(Unavailable):
        AudioHub({}).open("http://feed/down")
