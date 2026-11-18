"""Data fetched by browsers (lib/direct.ts), shared back so every visitor benefits.

Browsers look some public APIs up themselves (adsbdb registry, Open-Meteo weather) and post the results here. That is
untrusted input shown to other people, so:
- every field is validated (types, lengths, patterns, physical ranges); anything odd drops the whole item
- contributions only fill gaps: they never replace what the server fetched or what is already cached
- they expire sooner than server lookups (CONTRIB_TTL)
- aircraft contributions are only taken for planes the server currently tracks
- each client IP is rate-limited (RateGate)
"""

from __future__ import annotations

import re
import threading
import time

from .util import norm_hex, num

CONTRIB_TTL = 6 * 3600
MISS_TTL = 3600  # "adsbdb has no record": short, so a false claim can only hide registry data briefly
MAX_ITEMS = 20
TYPE_CODE = re.compile(r"^[A-Z0-9]{2,4}$")
REG = re.compile(r"^[A-Z0-9][A-Z0-9-]{1,9}$")
LEVEL = re.compile(r"^(surface|\d{3}hPa)$")
AIRCRAFT_TEXT = ("type_name", "manufacturer", "operator", "owner", "country")


def _text(v, max_len: int = 80) -> str | None:
    if v is None:
        return None
    if not isinstance(v, str):
        raise ValueError
    v = " ".join(v.split())
    if len(v) > max_len or any(c in v for c in "<>{}"):
        raise ValueError
    return v or None


def clean_aircraft(d) -> dict | None:
    """The `Aircraft` shape of enrich.parse_aircraft, validated; None if anything is off."""
    if not isinstance(d, dict):
        return None
    try:
        out = {k: _text(d.get(k)) for k in AIRCRAFT_TEXT}
        reg, typ, op = _text(d.get("registration"), 12), _text(d.get("type"), 4), _text(d.get("operator_icao"), 3)
    except ValueError:
        return None
    if (reg and not REG.match(reg.upper())) or (typ and not TYPE_CODE.match(typ)) or (op and not re.fullmatch(r"[A-Z]{3}", op)):
        return None
    if not (reg or typ or out["type_name"]):
        return None
    return {"registration": reg, "type": typ, "operator_icao": op, **out}


def clean_weather(d) -> dict | None:
    if not isinstance(d, dict) or not isinstance(d.get("level"), str) or not LEVEL.match(d["level"]):
        return None
    t, w, wd, c = (num(d.get(k)) for k in ("temp_c", "wind_kt", "wind_dir", "cloud_pct"))
    for v, lo, hi in ((t, -95, 60), (w, 0, 300), (wd, 0, 360), (c, 0, 100)):
        if v is not None and not lo <= v <= hi:
            return None
    if t is None and w is None:
        return None
    tm = num(d.get("time"))
    if tm is not None and abs(tm - time.time()) > 3 * 3600:  # a "current" observation must be current
        return None
    return {"temp_c": t, "wind_kt": w, "wind_dir": wd, "cloud_pct": c, "level": d["level"], "time": tm}


class RateGate:
    """At most `limit` accepted items per client IP per `window` seconds."""

    def __init__(self, limit: int = 60, window: float = 60.0, clock=time.monotonic):
        self.limit, self.window, self.clock = limit, window, clock
        self.hits: dict[str, list[float]] = {}
        self.lock = threading.Lock()

    def take(self, ip: str, n: int) -> int:
        """How many of `n` items this IP may submit now (and count them)."""
        now = self.clock()
        with self.lock:
            if len(self.hits) > 5000:
                self.hits = {k: v for k, v in self.hits.items() if v and now - v[-1] < self.window}
            ts = [t for t in self.hits.get(ip, []) if now - t < self.window]
            ok = max(0, min(n, self.limit - len(ts)))
            self.hits[ip] = ts + [now] * ok
            return ok


def is_hex(hx) -> str | None:
    return norm_hex(hx) if isinstance(hx, str) else None
