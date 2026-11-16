"""Shared fixtures: fake clock and a scripted HTTP session (no network in tests)."""

from __future__ import annotations

import pytest
import requests

from stratus.config import Config

DAY0 = 86400 * 20000  # a UTC midnight


class FakeClock:
    def __init__(self, t: float = DAY0 + 12 * 3600):
        self.t = t

    def __call__(self) -> float:
        return self.t

    def advance(self, dt: float) -> None:
        self.t += dt


class FakeResp:
    def __init__(self, body=None, status: int = 200, headers: dict | None = None):
        self.body = body
        self.status_code = status
        self.headers = headers or {}

    def json(self):
        return self.body

    def raise_for_status(self):
        if self.status_code >= 400:
            raise requests.HTTPError(str(self.status_code))


class FakeSession:
    """Routes: substring of URL -> FakeResp, list of FakeResp (consumed in order, last repeats) or callable(url, **kw)."""

    def __init__(self, routes: dict | None = None):
        self.routes = routes or {}
        self.calls: list[tuple[str, str, dict]] = []

    def _dispatch(self, method: str, url: str, **kw):
        self.calls.append((method, url, kw))
        for key, val in self.routes.items():
            if key in url:
                if callable(val):
                    return val(url, **kw)
                if isinstance(val, list):
                    return val.pop(0) if len(val) > 1 else val[0]
                return val
        return FakeResp({}, 404)

    def get(self, url, **kw):
        return self._dispatch("GET", url, **kw)

    def post(self, url, **kw):
        return self._dispatch("POST", url, **kw)

    def count(self, needle: str) -> int:
        return sum(1 for _, url, _ in self.calls if needle in url)


@pytest.fixture
def clock():
    return FakeClock()


@pytest.fixture
def cfg(tmp_path):
    return Config(data_dir=tmp_path / "data", web_dist=tmp_path / "dist")


def opensky_state(hex_="3c6444", cs="DLH4AB", lat=48.0, lon=11.0, t=DAY0 + 12 * 3600, baro_m=10000.0, gnd=False,
                  vel=230.0, trk=271.5, vr=-3.0, cat=4, pos_src=0):
    return [hex_, cs + " ", "Germany", t, t, lon, lat, baro_m, gnd, vel, trk, vr, None, None, "1000", False,
            pos_src, cat]


def readsb_payload(now_s: float, aircraft: list[dict], key: str = "ac") -> dict:
    return {"now": int(now_s * 1000), key: aircraft, "total": len(aircraft)}
