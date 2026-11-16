"""OpenSky global baseline poller with a credit budget that must never run out."""

from __future__ import annotations

import logging
import math
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

from ..store import Obs, Store
from ..util import FPM_PER_MS, FT_PER_M, KT_PER_MS, iround, norm_callsign, norm_hex, num, read_json, write_json_atomic

log = logging.getLogger(__name__)

STATES_URL = "https://opensky-network.org/api/states/all"
TOKEN_URL = "https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token"
COST = 4
FLOOR_S = 20.0
IDLE_AFTER_S = 600.0
IDLE_INTERVAL_S = 600.0
RATE_LIMIT_FALLBACK_S = 600.0
BACKOFF_MIN, BACKOFF_MAX = 15.0, 300.0
FRESH_SNAPSHOT_S = 180.0

# OpenSky extended category index -> ADS-B emitter category
CATEGORIES = {2: "A1", 3: "A2", 4: "A3", 5: "A4", 6: "A5", 7: "A6", 8: "A7", 9: "B1", 10: "B2", 11: "B3",
              12: "B4", 13: "B5", 14: "B6", 15: "B7", 16: "C1", 17: "C2", 18: "C3", 19: "C4", 20: "C5"}
POS_SOURCES = {0: "adsb_icao", 1: "asterix", 2: "mlat", 3: "flarm"}


def seconds_to_utc_midnight(now: float) -> float:
    day = math.floor(now / 86400) * 86400
    return max(1.0, day + 86400 - now)


class Budget:
    """Credit pacing for one OpenSky pool (oauth or anonymous). Pure logic, clock passed in."""

    def __init__(self, allowance: int, cost: int = COST, floor: float = FLOOR_S):
        self.allowance = allowance
        self.cost = cost
        self.floor = floor
        self.reserve = 0.05 * allowance
        self.remaining: float | None = None
        self.remaining_at = 0.0
        self.blocked_until = 0.0

    def observe(self, remaining: float | None, now: float) -> None:
        if remaining is None:
            if self.remaining is not None:
                self.remaining = max(0.0, self.remaining - self.cost)
                self.remaining_at = now
            return
        # An increase is treated as a reset (accepted as is).
        self.remaining = float(remaining)
        self.remaining_at = now

    def rate_limited(self, retry_after: float | None, now: float) -> None:
        self.blocked_until = now + (retry_after if retry_after and retry_after > 0 else RATE_LIMIT_FALLBACK_S)
        self.remaining = 0.0
        self.remaining_at = now

    def _current_remaining(self, now: float) -> float | None:
        if self.remaining is None:
            return None
        # Value from a previous UTC day is stale: the pool has reset since.
        if math.floor(self.remaining_at / 86400) != math.floor(now / 86400):
            return None
        return self.remaining

    def usable(self, now: float) -> bool:
        if now < self.blocked_until:
            return False
        rem = self._current_remaining(now)
        return rem is None or rem - self.reserve >= self.cost

    def interval(self, now: float) -> float:
        rem = self._current_remaining(now)
        if rem is None:
            return max(self.floor, 86400 / (self.allowance / self.cost))
        calls = max(1.0, (rem - self.reserve) / self.cost)
        return max(self.floor, seconds_to_utc_midnight(now) / calls)

    def to_json(self) -> dict:
        return {"remaining": self.remaining, "at": self.remaining_at, "blocked_until": self.blocked_until}

    def load(self, data: dict | None) -> None:
        if isinstance(data, dict):
            self.remaining = num(data.get("remaining"))
            self.remaining_at = num(data.get("at")) or 0.0
            self.blocked_until = num(data.get("blocked_until")) or 0.0


def parse_states(payload: dict) -> list[Obs]:
    out = []
    t = num(payload.get("time")) or time.time()
    for row in payload.get("states") or ():
        if not isinstance(row, list) or len(row) < 17:
            continue
        hx = norm_hex(row[0])
        lon, lat = num(row[5]), num(row[6])
        if not hx:
            continue
        gnd = bool(row[8])
        baro, geo = num(row[7]), num(row[13])
        alt_m = baro if baro is not None else geo
        alt = None if gnd or alt_m is None else iround(alt_m * FT_PER_M)
        vel = num(row[9])
        gs = None if vel is None else iround(vel * KT_PER_MS)
        if gs is not None and gs > 1500:
            gs = None
        vr = num(row[11])
        trk = num(row[10])
        cat = row[17] if len(row) > 17 else None
        out.append(Obs(
            hex=hx, ts=num(row[3]) or num(row[4]) or t, lat=lat, lon=lon, alt=alt, gs=gs,
            trk=None if trk is None else trk % 360, vr=None if vr is None else iround(vr * FPM_PER_MS),
            gnd=gnd, src="opensky", cs=norm_callsign(row[1]), sqk=(row[14] or None),
            cat=CATEGORIES.get(cat) if isinstance(cat, int) else None,
            pos_type=POS_SOURCES.get(row[16]), country=(row[2] or None),
        ))
    return out


class OpenSkyPoller:
    def __init__(self, config, store: Store, session, clock=time.time):
        self.cfg = config
        self.store = store
        self.http = session
        self.clock = clock
        self.oauth = Budget(config.opensky_daily_credits)
        self.anon = Budget(config.opensky_anon_daily_credits)
        self.state_path: Path = config.cache_dir / "opensky-budget.json"
        self.token: str | None = None
        self.token_exp = 0.0
        self.oauth_broken_until = 0.0
        self.mode = "oauth" if config.opensky_oauth else "anonymous"
        self.state = "ok"
        self.last_ok: float | None = None
        self.last_attempt = 0.0
        self.next_poll = 0.0
        self.last_error: str | None = None
        self.backoff = 0.0
        self.last_parse_ms: float | None = None
        self.wake = threading.Event()
        self._load()

    # ---- persistence ---------------------------------------------------------
    def _load(self) -> None:
        data = read_json(self.state_path) or {}
        self.oauth.load(data.get("oauth"))
        self.anon.load(data.get("anon"))
        self.last_ok = num(data.get("last_ok"))
        self.last_attempt = self.last_ok or 0.0

    def _save(self) -> None:
        try:
            write_json_atomic(self.state_path, {"oauth": self.oauth.to_json(), "anon": self.anon.to_json(),
                                                "last_ok": self.last_ok})
        except OSError as exc:
            log.warning("cannot persist OpenSky budget: %s", exc)

    # ---- scheduling ----------------------------------------------------------
    def idle(self, now: float) -> bool:
        return now - self.store.last_client_hit > IDLE_AFTER_S

    def pick(self, now: float) -> tuple[str, Budget] | None:
        if self.cfg.opensky_oauth and now >= self.oauth_broken_until and self.oauth.usable(now):
            return "oauth", self.oauth
        if self.anon.usable(now):
            return "anonymous", self.anon
        return None

    def compute_next(self, now: float) -> float:
        if self.backoff:
            return self.last_attempt + self.backoff
        choice = self.pick(now)
        if choice is None:
            pools = [self.anon] + ([self.oauth] if self.cfg.opensky_oauth else [])
            wake = min(max(b.blocked_until, now + b.interval(now)) for b in pools)
            return wake
        interval = choice[1].interval(now)
        if self.idle(now):
            interval = max(interval, IDLE_INTERVAL_S)
        return self.last_attempt + interval

    def note_client_hit(self) -> None:
        now = self.clock()
        was_idle = self.idle(now)
        self.store.last_client_hit = now
        if was_idle:
            self.wake.set()

    # ---- HTTP ------------------------------------------------------------------
    def _get_token(self, now: float) -> str:
        if self.token and now < self.token_exp - 60:
            return self.token
        resp = self.http.post(TOKEN_URL, data={"grant_type": "client_credentials",
                                               "client_id": self.cfg.opensky_client_id,
                                               "client_secret": self.cfg.opensky_client_secret}, timeout=(8, 15))
        if resp.status_code in (400, 401, 403):
            self.oauth_broken_until = now + 1800
            raise RuntimeError(f"OpenSky OAuth rejected credentials ({resp.status_code})")
        resp.raise_for_status()
        body = resp.json()
        self.token = body["access_token"]
        self.token_exp = now + float(body.get("expires_in", 1800))
        return self.token

    def poll_once(self) -> bool:
        now = self.clock()
        self.last_attempt = now
        choice = self.pick(now)
        if choice is None:
            self.state = "rate_limited"
            return False
        mode, budget = choice
        self.mode = mode
        try:
            headers = {}
            if mode == "oauth":
                try:
                    headers["Authorization"] = f"Bearer {self._get_token(now)}"
                except Exception as exc:
                    self.last_error = str(exc)
                    if now < self.oauth_broken_until:
                        return self.poll_once()
                    raise
            resp = self.http.get(STATES_URL, params={"extended": 1}, headers=headers, timeout=(8, 30))
            if resp.status_code == 401 and mode == "oauth":
                self.token = None
            remaining = num(resp.headers.get("X-Rate-Limit-Remaining"))
            if resp.status_code == 429:
                budget.rate_limited(num(resp.headers.get("X-Rate-Limit-Retry-After-Seconds")), now)
                self.state = "rate_limited"
                self.last_error = "429 rate limited"
                self.backoff = 0.0
                log.warning("OpenSky %s pool rate limited", mode)
                return False
            resp.raise_for_status()
            budget.observe(remaining, now)
            t0 = time.perf_counter()
            obs = parse_states(resp.json())
            self.store.apply(obs)
            self.last_parse_ms = round((time.perf_counter() - t0) * 1000, 1)
            self.last_ok = self.clock()
            self.state = "ok" if mode == "oauth" or not self.cfg.opensky_oauth else "degraded"
            self.last_error = None
            self.backoff = 0.0
            log.info("OpenSky %s: %d states, parse+merge %.0f ms, remaining %s", mode, len(obs),
                     self.last_parse_ms, budget.remaining)
            return True
        except Exception as exc:
            self.backoff = min(BACKOFF_MAX, max(BACKOFF_MIN, self.backoff * 2))
            self.state = "degraded"
            self.last_error = str(exc)[:300]
            log.warning("OpenSky poll failed (%s), retry in %.0fs", exc, self.backoff)
            return False
        finally:
            self._save()

    def schedule_first(self) -> None:
        """No unconditional bootstrap: if the last successful poll is recent, wait for the normal interval."""
        now = self.clock()
        if self.last_ok and now - self.last_ok < FRESH_SNAPSHOT_S and self.store.planes:
            self.last_attempt = self.last_ok
        else:
            self.last_attempt = 0.0

    def run(self, stop: threading.Event) -> None:
        self.schedule_first()
        while not stop.is_set():
            now = self.clock()
            self.next_poll = self.compute_next(now)
            delay = self.next_poll - now
            if delay > 0:
                self.wake.wait(min(delay, 60.0))
                self.wake.clear()
                continue
            self.poll_once()

    def status(self) -> dict:
        now = self.clock()
        choice = self.pick(now)
        budget = self.oauth if self.mode == "oauth" else self.anon
        state = self.state
        if state == "ok" and self.idle(now):
            state = "idle"
        return {
            "state": state, "mode": self.mode, "last_ok": self.last_ok, "next_poll": round(self.next_poll, 1),
            "interval": round((choice[1] if choice else budget).interval(now), 1),
            "credits_remaining": None if budget.remaining is None else int(budget.remaining),
            "credits_daily": budget.allowance, "last_error": self.last_error, "parse_ms": self.last_parse_ms,
        }
