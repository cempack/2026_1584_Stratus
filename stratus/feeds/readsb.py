"""adsb.lol (primary) / adsb.fi (fallback) readsb feeds for the viewed area and the selected plane."""

from __future__ import annotations

import logging
import threading
import time

from ..store import Obs, Store
from ..util import RateLimiter, SingleFlight, TTLCache, haversine_nm, iround, norm_callsign, norm_hex, num

log = logging.getLogger(__name__)

MAX_RADIUS_NM = 250.0
AREA_FRESH_S = 4.0
HEX_FRESH_S = 2.0
MAX_QUEUE_WAIT_S = 3.0
MAX_POS_AGE_S = 60.0  # a position older than this is not a fix: never merge it
RATE_LIMIT_COOLDOWN_S = 60.0
BASE_INTERVAL_S = 1.0  # per-provider spacing; a 429 widens it (x1.5, up to MAX_INTERVAL_S), successes narrow it back
MAX_INTERVAL_S = 4.0


class Provider:
    """One readsb-style API. `daily_limit`: hard cap per UTC day (None = only the per-second pace applies);
    a capped provider is a fallback, never used by the background sweep."""

    def __init__(self, name: str, point_url: str, hex_url: str, headers: dict | None = None,
                 daily_limit: int | None = None):
        self.name = name
        self.point_url = point_url
        self.hex_url = hex_url
        self.headers = headers or {}
        self.daily_limit = daily_limit
        self.hourly_limit = None if daily_limit is None else max(1, daily_limit * 280 // 680)
        self.day = ""
        self.used = 0
        self.hour: list[float] = []
        self.limiter = RateLimiter(BASE_INTERVAL_S)
        self.cooldown_until = 0.0
        self.state = "ok"
        self.last_ok: float | None = None
        self.last_error: str | None = None

    def status(self) -> dict:
        out = {"state": self.state, "last_ok": self.last_ok, "last_error": self.last_error,
               "interval_s": round(self.limiter.min_interval, 2)}
        if self.daily_limit is not None:
            out["today"] = {"used": self.used, "limit": self.daily_limit, "key": bool(self.headers)}
        return out

    def take(self) -> bool:
        """Count one request against the daily cap; False when today's budget is spent."""
        if self.daily_limit is None:
            return True
        now = time.time()
        day = time.strftime("%Y-%m-%d", time.gmtime(now))
        if day != self.day:
            self.day, self.used = day, 0
        self.hour = [t for t in self.hour if now - t < 3600]
        if self.used >= self.daily_limit or len(self.hour) >= (self.hourly_limit or 0):
            self.state, self.last_error = "budget", f"{self.used}/{self.daily_limit} today, {len(self.hour)}/{self.hourly_limit} this hour"
            return False
        self.used += 1
        self.hour.append(now)
        return True

    def rate_limited(self, now: float, retry_after: float | None = None) -> None:
        """429: back off for a while and keep a slower pace afterwards. A keyed (budgeted) provider backs off for
        at least 15 min: repeated 429s can get a free adsb.lol key revoked."""
        floor = 900.0 if self.daily_limit is not None else RATE_LIMIT_COOLDOWN_S
        self.cooldown_until = now + max(floor, retry_after or 0)
        self.limiter.min_interval = min(MAX_INTERVAL_S, self.limiter.min_interval * 1.5)
        self.state, self.last_error = "rate_limited", "429"

    def succeeded(self, now: float) -> None:
        self.state, self.last_ok, self.last_error = "ok", now, None
        self.limiter.min_interval = max(BASE_INTERVAL_S, self.limiter.min_interval * 0.97)


def default_providers(adsblol_key: str = "") -> list[Provider]:
    """adsb.fi first (per-second limit, no daily cap); adsb.lol as a budgeted fallback: 500 requests/day per IP
    without a key; with the free key 20/30 s, 120/min, 300/h, 1,000/day, 5,000/week. We stay under all of them."""
    return [
        Provider("adsb.fi", "https://opendata.adsb.fi/api/v2/lat/{lat}/lon/{lon}/dist/{r}",
                 "https://opendata.adsb.fi/api/v2/hex/{hex}"),
        Provider("adsb.lol", "https://api.adsb.lol/v2/point/{lat}/{lon}/{r}", "https://api.adsb.lol/v2/hex/{hex}",
                 headers={"x-api-key": adsblol_key} if adsblol_key else None,
                 daily_limit=680 if adsblol_key else 450),  # key: 1,000/day but 5,000/week -> ~700/day
    ]


def parse_readsb(payload: dict, src: str) -> list[Obs]:
    now_s = (num(payload.get("now")) or time.time() * 1000) / 1000.0
    items = payload.get("ac")
    if items is None:
        items = payload.get("aircraft")
    out = []
    for a in items or ():
        hx = norm_hex(a.get("hex"))  # '~' prefixed (non-ICAO) addresses are rejected here
        if not hx:
            continue
        lat, lon, seen = num(a.get("lat")), num(a.get("lon")), num(a.get("seen_pos"))
        if lat is None and isinstance(a.get("lastPosition"), dict):
            lp = a["lastPosition"]
            lat, lon, seen = num(lp.get("lat")), num(lp.get("lon")), num(lp.get("seen_pos"))
        if lat is not None and (lon is None or (seen or 0.0) > MAX_POS_AGE_S):
            lat = lon = None  # stale or half a position: keep the metadata, drop the fix
        baro = a.get("alt_baro")
        gnd = baro == "ground"
        alt = None if gnd else iround(num(baro) if num(baro) is not None else num(a.get("alt_geom")))
        gs = iround(num(a.get("gs")))
        if gs is not None and gs > 1500:
            gs = None
        vr = num(a.get("baro_rate"))
        if vr is None:
            vr = num(a.get("geom_rate"))
        trk = num(a.get("track"))
        out.append(Obs(
            hex=hx, ts=None if lat is None else now_s - (seen or 0.0), lat=lat, lon=lon, alt=alt, gs=gs,
            trk=None if trk is None else trk % 360, vr=iround(vr), gnd=gnd, src=src,
            cs=norm_callsign(a.get("flight")), type=(a.get("t") or None), reg=(a.get("r") or None),
            cat=(a.get("category") or None), sqk=(a.get("squawk") or None), pos_type=(a.get("type") or None),
            rc=num(a.get("rc")),
        ))
    return out


class ReadsbFeed:
    def __init__(self, store: Store, session, providers: list[Provider] | None = None, clock=time.time,
                 adsblol_key: str = ""):
        self.store = store
        self.http = session
        self.providers = providers or default_providers(adsblol_key)
        self.clock = clock
        self.flight = SingleFlight()
        self.hex_cache = TTLCache(5000)
        self._areas: list[tuple[float, float, float, float]] = []  # lat, lon, r, fetched_at
        self._lock = threading.Lock()

    def _fetch(self, kind: str, **fmt) -> list[Obs] | None:
        # providers cooling down after a 429 go last instead of being hammered first
        now = self.clock()
        for prov in sorted(self.providers, key=lambda p: now < p.cooldown_until):
            if now < prov.cooldown_until and prov.daily_limit is not None:
                continue  # a keyed provider is never retried while cooling down
            if not prov.limiter.acquire(MAX_QUEUE_WAIT_S) or not prov.take():
                continue
            url = (prov.point_url if kind == "point" else prov.hex_url).format(**fmt)
            try:
                resp = self.http.get(url, timeout=(5, 10), **({"headers": prov.headers} if prov.headers else {}))
                if resp.status_code == 429:
                    prov.rate_limited(self.clock(), num(resp.headers.get("Retry-After")) if hasattr(resp, "headers") else None)
                    continue
                resp.raise_for_status()
                obs = parse_readsb(resp.json(), prov.name)
                prov.succeeded(self.clock())
                return obs
            except Exception as exc:
                prov.state, prov.last_error = "degraded", str(exc)[:300]
                log.info("%s %s failed: %s", prov.name, kind, exc)
        return None

    def fetch_point_from(self, prov: Provider, lat: float, lon: float, r: float, max_wait: float = 0.5):
        """One circle from one specific provider, for the background sweep. None when the provider is cooling
        down, busy serving viewers (rate-limit slot too far away) or failed; never raises."""
        now = self.clock()
        if prov.daily_limit is not None:
            return None  # capped providers are kept for viewers, never spent by the background sweep
        if now < prov.cooldown_until or not prov.limiter.acquire(max_wait):
            return None
        url = prov.point_url.format(lat=round(lat, 3), lon=round(lon, 3), r=int(r))
        try:
            resp = self.http.get(url, timeout=(5, 10))
            if resp.status_code == 429:
                prov.rate_limited(now)
                return None
            resp.raise_for_status()
            obs = parse_readsb(resp.json(), prov.name)
            prov.succeeded(self.clock())
            return obs
        except Exception as exc:
            prov.cooldown_until = now + 10.0
            prov.state, prov.last_error = "degraded", str(exc)[:300]
            log.info("%s sweep failed: %s", prov.name, exc)
            return None

    def _covered(self, lat: float, lon: float, r: float, now: float) -> bool:
        with self._lock:
            self._areas = [a for a in self._areas if now - a[3] < AREA_FRESH_S]
            return any(haversine_nm(lat, lon, a[0], a[1]) + r <= a[2] + 0.01 for a in self._areas)

    def refresh_area(self, lat: float, lon: float, r: float) -> None:
        r = max(1.0, min(MAX_RADIUS_NM, r))
        if self._covered(lat, lon, r, self.clock()):
            return
        # Quantize so neighbouring viewers coalesce; enlarge radius to keep the requested circle covered.
        qlat, qlon = round(lat * 10) / 10, round(lon * 10) / 10
        qr = min(MAX_RADIUS_NM, float(int(r + haversine_nm(lat, lon, qlat, qlon) + 5) // 5 * 5 + 5))

        def run():
            if self._covered(qlat, qlon, qr, self.clock()):
                return
            obs = self._fetch("point", lat=qlat, lon=qlon, r=int(qr))
            if obs is not None:
                self.store.apply(obs)
                with self._lock:
                    self._areas.append((qlat, qlon, qr, self.clock()))

        self.flight.do(("area", qlat, qlon, qr), run)

    def refresh_hex(self, hx: str) -> None:
        if self.hex_cache.has(hx):
            return

        def run():
            obs = self._fetch("hex", hex=hx)
            if obs:
                self.store.apply(obs)
            self.hex_cache.set(hx, True, HEX_FRESH_S)

        self.flight.do(("hex", hx), run)

    def status(self) -> dict:
        return {p.name: p.status() for p in self.providers}
