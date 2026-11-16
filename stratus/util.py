"""Small shared helpers: HTTP session, geo math, rate limiting, request coalescing, TTL cache."""

from __future__ import annotations

import gzip
import json
import math
import os
import tempfile
import threading
import time
from collections import OrderedDict
from concurrent.futures import Future
from pathlib import Path
from typing import Any, Callable

import requests

from .config import USER_AGENT

EARTH_RADIUS_NM = 3440.065
EARTH_RADIUS_M = 6_371_008.8
FT_PER_M = 3.280839895
KT_PER_MS = 1.943844492
FPM_PER_MS = 196.8503937


def make_session() -> requests.Session:
    session = requests.Session()
    session.headers["User-Agent"] = USER_AGENT
    session.headers["Accept-Encoding"] = "gzip, deflate"
    adapter = requests.adapters.HTTPAdapter(pool_connections=8, pool_maxsize=32)
    session.mount("https://", adapter)
    session.mount("http://", adapter)
    return session


def haversine_nm(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1 = math.radians(lat1)
    p2 = math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_RADIUS_NM * math.asin(min(1.0, math.sqrt(a)))


def num(value: Any) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value) if math.isfinite(value) else None
    try:
        out = float(value)
    except (TypeError, ValueError):
        return None
    return out if math.isfinite(out) else None


def iround(value: float | None) -> int | None:
    return None if value is None else int(round(value))


def norm_hex(value: Any) -> str | None:
    text = str(value or "").strip().lower()
    if len(text) != 6:
        return None
    try:
        int(text, 16)
    except ValueError:
        return None
    return text


def norm_callsign(value: Any) -> str | None:
    text = "".join(str(value or "").split()).upper()
    return text or None


def write_json_gz_atomic(path: Path, payload: Any, level: int = 3) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    data = gzip.compress(json.dumps(payload, separators=(",", ":")).encode(), compresslevel=level)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=path.name, suffix=".tmp")
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(data)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    return len(data)


def write_json_atomic(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=path.name, suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as fh:
            json.dump(payload, fh)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def read_json(path: Path) -> Any:
    try:
        if path.suffix == ".gz":
            with gzip.open(path, "rt") as fh:
                return json.load(fh)
        with path.open() as fh:
            return json.load(fh)
    except (OSError, ValueError, EOFError):
        return None


class RateLimiter:
    """Global spacing between calls (min_interval seconds). Callers reserve a slot and sleep until it."""

    def __init__(self, min_interval: float, clock: Callable[[], float] = time.monotonic,
                 sleep: Callable[[float], None] = time.sleep):
        self.min_interval = min_interval
        self._clock = clock
        self._sleep = sleep
        self._next = 0.0
        self._lock = threading.Lock()

    def acquire(self, max_wait: float = 5.0) -> bool:
        with self._lock:
            now = self._clock()
            slot = max(now, self._next)
            if slot - now > max_wait:
                return False
            self._next = slot + self.min_interval
        delay = slot - now
        if delay > 0:
            self._sleep(delay)
        return True


class SingleFlight:
    """Coalesce concurrent calls with the same key into one execution."""

    def __init__(self):
        self._lock = threading.Lock()
        self._inflight: dict[Any, Future] = {}

    def do(self, key: Any, fn: Callable[[], Any], timeout: float | None = 30.0) -> Any:
        with self._lock:
            fut = self._inflight.get(key)
            owner = fut is None
            if owner:
                fut = Future()
                self._inflight[key] = fut
        if not owner:
            return fut.result(timeout=timeout)
        try:
            result = fn()
            fut.set_result(result)
            return result
        except BaseException as exc:
            fut.set_exception(exc)
            raise
        finally:
            with self._lock:
                self._inflight.pop(key, None)


_MISSING = object()


class TTLCache:
    """Thread-safe bounded cache with per-entry TTL."""

    def __init__(self, max_size: int = 20_000, clock: Callable[[], float] = time.time):
        self._data: OrderedDict[Any, tuple[float, Any]] = OrderedDict()
        self._lock = threading.Lock()
        self._max = max_size
        self._clock = clock

    def get(self, key: Any, default: Any = _MISSING) -> Any:
        with self._lock:
            item = self._data.get(key)
            if item is None:
                return default
            expires, value = item
            if expires < self._clock():
                del self._data[key]
                return default
            self._data.move_to_end(key)
            return value

    def has(self, key: Any) -> bool:
        return self.get(key, _MISSING) is not _MISSING

    def set(self, key: Any, value: Any, ttl: float) -> None:
        with self._lock:
            self._data[key] = (self._clock() + ttl, value)
            self._data.move_to_end(key)
            while len(self._data) > self._max:
                self._data.popitem(last=False)

    def __len__(self) -> int:
        return len(self._data)


MISSING = _MISSING
