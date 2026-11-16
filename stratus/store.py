"""Plane store: merge rules, sanity filter, expiry, trails, precomputed gzipped snapshot."""

from __future__ import annotations

import gzip
import hashlib
import json
import math
import threading
import time
from dataclasses import dataclass
from pathlib import Path

from .util import haversine_nm, read_json, write_json_gz_atomic

FIELDS = ["hex", "cs", "lat", "lon", "alt", "gs", "trk", "vr", "gnd", "ts", "src", "type", "reg", "cat", "sqk"]
MAX_KT = 1200.0
SANITY_GAP_S = 1800.0
FUTURE_SLACK_S = 10.0
EXPIRE_AIR_S = 15 * 60
EXPIRE_GND_S = 5 * 60
TRAIL_MIN_S = 10.0
TRAIL_MIN_NM = 200 / 1852
TRAIL_KEEP_S = 3 * 3600
TRAIL_FULL_S = 20 * 60
DP_EPS_NM = 0.05
RESTORE_MAX_AGE = 45 * 60


@dataclass(slots=True)
class Obs:
    hex: str
    ts: float | None = None
    lat: float | None = None
    lon: float | None = None
    alt: int | None = None
    gs: int | None = None
    trk: float | None = None
    vr: int | None = None
    gnd: bool = False
    src: str = ""
    cs: str | None = None
    type: str | None = None
    reg: str | None = None
    cat: str | None = None
    sqk: str | None = None
    pos_type: str | None = None
    country: str | None = None


class Plane:
    __slots__ = ("hex", "cs", "lat", "lon", "alt", "gs", "trk", "vr", "gnd", "ts", "src", "type", "reg",
                 "cat", "sqk", "pos_type", "country", "trail", "thinned_until", "rejects", "row")

    def __init__(self, hex_: str):
        self.hex = hex_
        self.cs = self.lat = self.lon = self.alt = self.gs = self.trk = self.vr = None
        self.ts = 0.0
        self.gnd = False
        self.src = None
        self.type = self.reg = self.cat = self.sqk = self.pos_type = self.country = None
        self.trail: list[list] = []
        self.thinned_until = 0.0
        self.rejects = 0
        self.row = None

    def as_row(self) -> list:
        if self.row is None:
            self.row = [self.hex, self.cs, round(self.lat, 5), round(self.lon, 5), self.alt, self.gs,
                        None if self.trk is None else round(self.trk, 1), self.vr, self.gnd, round(self.ts, 1),
                        self.src, self.type, self.reg, self.cat, self.sqk]
        return self.row

    def as_dict(self) -> dict:
        d = dict(zip(FIELDS, self.as_row()))
        d["pos_type"] = self.pos_type
        d["country"] = self.country
        return d


def _dp(points: list[list], eps: float) -> list[list]:
    """Douglas-Peucker on [lat, lon, alt, ts] points with equirectangular distance in NM."""
    if len(points) < 3:
        return points
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        a, b = stack.pop()
        la, lo = points[a][0], points[a][1]
        k = math.cos(math.radians(la))
        bx, by = (points[b][1] - lo) * k * 60, (points[b][0] - la) * 60
        seg = math.hypot(bx, by)
        best, idx = 0.0, -1
        for i in range(a + 1, b):
            px, py = (points[i][1] - lo) * k * 60, (points[i][0] - la) * 60
            d = abs(bx * py - by * px) / seg if seg > 1e-9 else math.hypot(px, py)
            if d > best:
                best, idx = d, i
        if best > eps and idx > 0:
            keep[idx] = True
            stack.append((a, idx))
            stack.append((idx, b))
    return [p for p, k in zip(points, keep) if k]


class Store:
    def __init__(self, clock=time.time):
        self.clock = clock
        self.planes: dict[str, Plane] = {}
        self.lock = threading.RLock()
        self.version = 0
        self._snap_lock = threading.Lock()
        self._snap: tuple[int, bytes, bytes, str] | None = None
        self.last_client_hit = 0.0

    # ---- merge -------------------------------------------------------------
    def apply(self, observations, now: float | None = None) -> int:
        now = self.clock() if now is None else now
        changed = 0
        with self.lock:
            planes = self.planes
            for ob in observations:
                p = planes.get(ob.hex)
                if p is None:
                    p = Plane(ob.hex)
                    fresh = True
                else:
                    fresh = False
                if self._merge(p, ob, now):
                    p.row = None
                    changed += 1
                    if fresh:
                        if p.lat is None:
                            continue
                        planes[ob.hex] = p
            if changed:
                self.version += 1
        return changed

    def _merge(self, p: Plane, ob: Obs, now: float) -> bool:
        changed = False
        for name in ("cs", "type", "reg", "cat", "sqk", "pos_type", "country"):
            val = getattr(ob, name)
            if val is not None and getattr(p, name) != val:
                setattr(p, name, val)
                changed = True
        if ob.lat is None or ob.lon is None or ob.ts is None:
            return changed
        if not (-90 <= ob.lat <= 90 and -180 <= ob.lon <= 180) or ob.ts > now + FUTURE_SLACK_S:
            return changed
        if ob.ts <= p.ts:
            return changed
        if p.lat is not None:
            dt = ob.ts - p.ts
            if dt <= SANITY_GAP_S:
                dist = haversine_nm(p.lat, p.lon, ob.lat, ob.lon)
                if dist / max(dt, 1.0) * 3600 > MAX_KT:
                    p.rejects += 1
                    if p.rejects < 3:
                        return changed
                    p.trail = []  # stored fix was the outlier: start over
        p.rejects = 0
        p.lat, p.lon, p.ts, p.src = ob.lat, ob.lon, ob.ts, ob.src
        p.alt, p.gs, p.trk, p.vr, p.gnd = ob.alt, ob.gs, ob.trk, ob.vr, ob.gnd
        trail = p.trail
        if not trail or (ob.ts - trail[-1][3] >= TRAIL_MIN_S
                         and haversine_nm(trail[-1][0], trail[-1][1], ob.lat, ob.lon) >= TRAIL_MIN_NM):
            trail.append([round(ob.lat, 5), round(ob.lon, 5), ob.alt, round(ob.ts, 1)])
        return True

    # ---- maintenance -------------------------------------------------------
    def maintain(self, now: float | None = None) -> int:
        """Expire planes and thin trails. Returns number of planes removed."""
        now = self.clock() if now is None else now
        removed = 0
        with self.lock:
            for hx in list(self.planes):
                p = self.planes[hx]
                age = now - p.ts
                if age > (EXPIRE_GND_S if p.gnd else EXPIRE_AIR_S):
                    del self.planes[hx]
                    removed += 1
                    continue
                tr = p.trail
                if tr and tr[0][3] < now - TRAIL_KEEP_S:
                    p.trail = tr = [pt for pt in tr if pt[3] >= now - TRAIL_KEEP_S]
                cutoff = now - TRAIL_FULL_S
                if len(tr) > 3 and tr[0][3] < cutoff and cutoff - p.thinned_until > 120:
                    start = next((i for i, pt in enumerate(tr) if pt[3] >= p.thinned_until), 0)
                    end = next((i for i, pt in enumerate(tr) if pt[3] >= cutoff), len(tr))
                    if end - start > 2:
                        p.trail = tr[:start] + _dp(tr[start:end], DP_EPS_NM) + tr[end:]
                    p.thinned_until = cutoff
            if removed:
                self.version += 1
        return removed

    # ---- reads -------------------------------------------------------------
    def get(self, hx: str) -> Plane | None:
        return self.planes.get(hx)

    def snapshot(self) -> tuple[int, bytes, bytes, str]:
        """(version, raw json, gzipped json, etag) — built once per store version."""
        snap = self._snap
        if snap and snap[0] == self.version:
            return snap
        with self._snap_lock:
            snap = self._snap
            if snap and snap[0] == self.version:
                return snap
            with self.lock:
                version = self.version
                rows = [p.as_row() for p in self.planes.values()]
            raw = json.dumps({"v": version, "t": round(self.clock(), 1), "fields": FIELDS, "rows": rows},
                             separators=(",", ":")).encode()
            gz = gzip.compress(raw, compresslevel=5)
            etag = '"%s"' % hashlib.blake2b(raw, digest_size=8).hexdigest()
            self._snap = (version, raw, gz, etag)
            return self._snap

    def area(self, lat: float, lon: float, r_nm: float) -> dict:
        dlat = r_nm / 60.0
        dlon = r_nm / (60.0 * max(0.01, math.cos(math.radians(lat))))
        rows = []
        with self.lock:
            for p in self.planes.values():
                if abs(p.lat - lat) > dlat:
                    continue
                dl = abs(p.lon - lon)
                if dl > 180:
                    dl = 360 - dl
                if dl > dlon:
                    continue
                if haversine_nm(lat, lon, p.lat, p.lon) <= r_nm:
                    rows.append(p.as_row())
            version = self.version
        return {"v": version, "t": round(self.clock(), 1), "fields": FIELDS, "rows": rows}

    # ---- persistence -------------------------------------------------------
    def save(self, path: Path, extra: dict | None = None) -> int:
        with self.lock:
            planes = [[*p.as_row(), p.pos_type, p.country, p.trail, p.thinned_until] for p in self.planes.values()]
        return write_json_gz_atomic(path, {"saved_at": self.clock(), "planes": planes, "extra": extra or {}})

    def load(self, path: Path) -> dict | None:
        data = read_json(path)
        if not isinstance(data, dict) or self.clock() - float(data.get("saved_at") or 0) > RESTORE_MAX_AGE:
            return None
        with self.lock:
            for item in data.get("planes") or []:
                try:
                    p = Plane(item[0])
                    (p.cs, p.lat, p.lon, p.alt, p.gs, p.trk, p.vr, p.gnd, p.ts, p.src, p.type, p.reg, p.cat,
                     p.sqk, p.pos_type, p.country, p.trail, p.thinned_until) = item[1:]
                    self.planes[p.hex] = p
                except (ValueError, TypeError, IndexError):
                    continue
            self.version += 1
        self.maintain()
        return data
