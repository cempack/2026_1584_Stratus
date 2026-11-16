"""Flightradar24 API (optional, enabled by env FR24_API_TOKEN), used for SELECTED planes only.

Three calls share one daily credit budget with a persisted counter and a hard stop (`FR24_DAILY_CREDITS`):
  - route      GET /api/flight-summary/light        1 credit per call (+1 per extra result)
  - position   GET /api/live/flight-positions/light 6 credits, only for an estimated / stale plane, <= 1 per 60 s/plane
  - full track GET /api/flight-tracks              40 credits, only on explicit request, cached per flight
At most 9 requests per minute (the plan allows 10). A 401/403 disables FR24 until restart (logged once); without a
token nothing here ever touches the network.
"""

from __future__ import annotations

import logging
import threading
import time
from collections import deque
from datetime import datetime, timezone
from pathlib import Path

from .store import Obs
from .util import MISSING, TTLCache, iround, norm_callsign, norm_hex, num, parse_iso, read_json, write_json_atomic

log = logging.getLogger(__name__)

BASE_URL = "https://fr24api.flightradar24.com"
COST_ROUTE, COST_POSITION, COST_TRACK = 1, 6, 40
MAX_REQ_PER_MIN = 9
POSITION_EVERY_S = 60.0
ROUTE_TTL_OK, ROUTE_TTL_MISS = 6 * 3600, 3600
TRACK_TTL_S = 3600
RATE_LIMIT_COOLDOWN_S = 60.0
POS_TYPES = {"ADSB": "adsb_icao", "UAT": "adsb_uat", "MLAT": "mlat"}  # ESTIMATED is FR24's own guess: never merged


class Fr24Unavailable(Exception):
    """FR24 cannot be used right now (disabled, auth error, budget, rate limit). `reason` is a short code."""

    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


def _utc_day(ts: float) -> str:
    return datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m-%d")


def _iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class Fr24:
    def __init__(self, token: str, daily_cap: int, session, airports=None, state_path: Path | None = None,
                 clock=time.time):
        self._token = (token or "").strip()
        self.cap = max(0, daily_cap)
        self.http = session
        self.airports = airports
        self.state_path = state_path
        self.clock = clock
        self.enabled = bool(self._token)
        self.auth_failed = False
        self.cooldown_until = 0.0
        self.last_ok: float | None = None
        self.last_error: str | None = None
        self._lock = threading.RLock()
        self._calls: deque[float] = deque()
        self._day = _utc_day(clock())
        self._used = 0
        self._pos_last: dict[str, float] = {}
        self._routes = TTLCache(5000, clock)
        self._tracks = TTLCache(200, clock)
        self._ids = TTLCache(5000, clock)  # hex -> fr24_id learnt from route / position answers
        if self.enabled and state_path is not None:
            data = read_json(state_path)
            if isinstance(data, dict) and data.get("day") == self._day:
                self._used = int(num(data.get("used")) or 0)

    # ---- state -------------------------------------------------------------------
    def _roll_day(self) -> None:
        day = _utc_day(self.clock())
        if day != self._day:
            self._day, self._used = day, 0

    def _save(self) -> None:
        if self.state_path is None:
            return
        try:
            write_json_atomic(self.state_path, {"day": self._day, "used": self._used})
        except OSError as exc:
            log.warning("cannot persist FR24 credit counter: %s", exc)

    @property
    def remaining(self) -> int:
        with self._lock:
            self._roll_day()
            return max(0, self.cap - self._used)

    @property
    def state(self) -> str:
        if not self.enabled:
            return "disabled"
        if self.auth_failed:
            return "auth_error"
        if self.remaining <= 0:
            return "exhausted"
        if self.clock() < self.cooldown_until:
            return "rate_limited"
        return "ok"

    def usable(self) -> bool:
        return self.state in ("ok", "rate_limited")

    def status(self) -> dict:
        if not self.enabled:
            return {"state": "disabled"}
        with self._lock:
            self._roll_day()
            used = self._used
        return {"state": self.state, "credits_used": used, "credits_daily": self.cap,
                "credits_remaining": max(0, self.cap - used), "last_ok": self.last_ok,
                "last_error": self.last_error}

    def budget(self) -> dict | None:
        """Small block for the aircraft response; None when FR24 is not configured."""
        if not self.enabled:
            return None
        return {"state": self.state, "credits_remaining": self.remaining, "credits_daily": self.cap}

    def full_track_capability(self) -> dict:
        if not self.enabled:
            return {"available": False, "cost": COST_TRACK, "reason": "disabled"}
        state = self.state
        if state == "auth_error":
            return {"available": False, "cost": COST_TRACK, "reason": "auth_error"}
        if self.remaining < COST_TRACK + COST_ROUTE:
            return {"available": False, "cost": COST_TRACK, "reason": "budget"}
        return {"available": True, "cost": COST_TRACK, "reason": None}

    # ---- HTTP --------------------------------------------------------------------
    def _reserve(self, cost: int) -> None:
        with self._lock:
            self._roll_day()
            if self._used + cost > self.cap:
                raise Fr24Unavailable("budget")
            now = self.clock()
            while self._calls and now - self._calls[0] > 60:
                self._calls.popleft()
            if len(self._calls) >= MAX_REQ_PER_MIN:
                raise Fr24Unavailable("rate")
            self._calls.append(now)
            self._used += cost
            self._save()

    def _adjust(self, delta: int) -> None:
        with self._lock:
            self._used = max(0, self._used + delta)
            self._save()

    def _call(self, path: str, params: dict, cost: int) -> dict:
        if not self.enabled:
            raise Fr24Unavailable("disabled")
        if self.auth_failed:
            raise Fr24Unavailable("auth_error")
        if self.clock() < self.cooldown_until:
            raise Fr24Unavailable("rate")
        self._reserve(cost)
        try:
            resp = self.http.get(BASE_URL + path, params=params, timeout=(5, 15), headers={
                "Authorization": f"Bearer {self._token}", "Accept": "application/json", "Accept-Version": "v1"})
        except Exception as exc:
            self._adjust(-cost)
            self.last_error = f"network: {type(exc).__name__}"
            raise Fr24Unavailable("network") from exc
        code = resp.status_code
        if code in (401, 403):
            self._adjust(-cost)
            if not self.auth_failed:
                log.error("FR24 rejected the API token (HTTP %s): FR24 disabled until restart", code)
            self.auth_failed, self.last_error = True, f"HTTP {code}"
            raise Fr24Unavailable("auth_error")
        if code == 402:  # credits exhausted on FR24's side
            with self._lock:
                self._used = self.cap
                self._save()
            self.last_error = "HTTP 402"
            raise Fr24Unavailable("budget")
        if code == 429:
            self._adjust(-cost)
            self.cooldown_until = self.clock() + RATE_LIMIT_COOLDOWN_S
            self.last_error = "HTTP 429"
            raise Fr24Unavailable("rate")
        if code >= 400:
            self._adjust(-cost)
            self.last_error = f"HTTP {code}"
            raise Fr24Unavailable("error")
        try:
            body = resp.json()
        except Exception as exc:
            self._adjust(-cost)
            self.last_error = "invalid JSON"
            raise Fr24Unavailable("error") from exc
        self.last_ok, self.last_error = self.clock(), None
        return body if isinstance(body, dict) else {}

    # ---- route ---------------------------------------------------------------------
    def _summary(self, callsign: str) -> list[dict]:
        now = self.clock()
        body = self._call("/api/flight-summary/light", {
            "callsigns": callsign, "flight_datetime_from": _iso(now - 24 * 3600),
            "flight_datetime_to": _iso(now + 3600), "sort": "desc", "limit": 3}, COST_ROUTE)
        data = [d for d in (body.get("data") or []) if isinstance(d, dict)]
        if len(data) > 1:
            self._adjust(len(data) - 1)  # priced per result
        return data

    def _remember_id(self, d: dict) -> None:
        hx, fid = norm_hex(d.get("hex")), d.get("fr24_id")
        if hx and fid:
            self._ids.set(hx, str(fid), 6 * 3600)

    def route(self, callsign: str, hex_: str | None = None) -> dict | None:
        """Live route for `callsign` (cached 6 h). None when FR24 has no live flight for it. Raises Fr24Unavailable."""
        cs = norm_callsign(callsign)
        if not cs:
            return None
        cached = self._routes.get(cs, MISSING)
        if cached is not MISSING:
            return cached
        live = [d for d in self._summary(cs)
                if not d.get("flight_ended") and norm_callsign(d.get("callsign")) == cs
                and (not hex_ or norm_hex(d.get("hex")) in (None, hex_))]  # same callsign on another airframe: skip
        route = None
        if live:
            d = live[0]
            self._remember_id(d)
            o, dest = d.get("orig_icao"), d.get("dest_icao_actual") or d.get("dest_icao")
            if o and dest and self.airports is not None:
                route = {"callsign": cs, "airline": d.get("operating_as"),
                         "origin": self.airports.route_airport(o), "destination": self.airports.route_airport(dest),
                         "source": "fr24", "fr24_id": d.get("fr24_id")}
        self._routes.set(cs, route, ROUTE_TTL_OK if route else ROUTE_TTL_MISS)
        return route

    def cached_route(self, callsign: str | None):
        """(found, route) from the cache only; never touches the network."""
        cs = norm_callsign(callsign)
        val = self._routes.get(cs, MISSING) if cs else MISSING
        return (val is not MISSING), (None if val is MISSING else val)

    # ---- live position ---------------------------------------------------------------
    def position_due(self, hex_: str) -> bool:
        return self.usable() and self.clock() - self._pos_last.get(hex_, 0.0) >= POSITION_EVERY_S

    def position(self, hex_: str, callsign: str | None, registration: str | None) -> Obs | None:
        """Latest real FR24 fix for this airframe as an observation (src 'fr24'), max once per 60 s per plane."""
        if not callsign and not registration:
            return None
        with self._lock:  # claim the slot atomically: concurrent requests must not both spend 6 credits
            now = self.clock()
            if now - self._pos_last.get(hex_, 0.0) < POSITION_EVERY_S or not self.usable():
                return None
            self._pos_last[hex_] = now
        params = {"registrations": registration} if registration else {"callsigns": callsign}
        body = self._call("/api/live/flight-positions/light", params, COST_POSITION)
        best = None
        for d in body.get("data") or []:
            if not isinstance(d, dict) or norm_hex(d.get("hex")) != hex_:
                continue  # strictly keyed by ICAO hex; no hex or another hex = not this plane
            src = str(d.get("source") or "").upper()
            ts, lat, lon = parse_iso(d.get("timestamp")), num(d.get("lat")), num(d.get("lon"))
            if src not in POS_TYPES or None in (ts, lat, lon):
                continue
            if best is None or ts > best[0]:
                best = (ts, lat, lon, d, src)
        if best is None:
            return None
        ts, lat, lon, d, src = best
        self._remember_id(d)
        alt, gs, trk = iround(num(d.get("alt"))), iround(num(d.get("gspeed"))), num(d.get("track"))
        gnd = alt == 0 and (gs or 0) < 60
        sqk = (d.get("squawk") or "").strip() or None
        return Obs(hex=hex_, ts=ts, lat=lat, lon=lon, alt=None if gnd else alt, gs=gs,
                   trk=None if trk is None or (trk == 0 and not gs) else trk % 360, vr=iround(num(d.get("vspeed"))),
                   gnd=gnd, src="fr24", cs=norm_callsign(d.get("callsign")), sqk=sqk, pos_type=POS_TYPES[src])

    # ---- full track ------------------------------------------------------------------
    def flight_id(self, hex_: str, callsign: str | None) -> str | None:
        fid = self._ids.get(hex_, None)
        if fid:
            return fid
        found, route = self.cached_route(callsign)
        if found and route and route.get("fr24_id"):
            return route["fr24_id"]
        if not callsign:
            return None
        data = self._summary(norm_callsign(callsign))
        for d in data:
            if not d.get("flight_ended") and norm_hex(d.get("hex")) == hex_:
                self._remember_id(d)
                return str(d.get("fr24_id"))
        return None

    def track(self, hex_: str, callsign: str | None) -> dict | None:
        """Full track since takeoff: {"fr24_id", "points": [[lat, lon, alt, ts], ...], "cached"}. 40 credits, cached."""
        if not self.enabled:
            raise Fr24Unavailable("disabled")
        if self.auth_failed:
            raise Fr24Unavailable("auth_error")
        fid = self.flight_id(hex_, callsign)
        if not fid:
            return None
        cached = self._tracks.get(fid, None)
        if cached is not None:
            return {**cached, "cached": True}
        body = self._call("/api/flight-tracks", {"flight_id": fid}, COST_TRACK)
        points = []
        for t in body.get("tracks") or []:
            ts, lat, lon = parse_iso(t.get("timestamp")), num(t.get("lat")), num(t.get("lon"))
            if None in (ts, lat, lon):
                continue
            points.append([round(lat, 5), round(lon, 5), iround(num(t.get("alt"))), round(ts, 1)])
        points.sort(key=lambda pt: pt[3])
        out = {"fr24_id": fid, "points": points}
        self._tracks.set(fid, out, TRACK_TTL_S)
        return {**out, "cached": False}
