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


class Provider:
    def __init__(self, name: str, point_url: str, hex_url: str):
        self.name = name
        self.point_url = point_url
        self.hex_url = hex_url
        self.limiter = RateLimiter(1.0)
        self.state = "ok"
        self.last_ok: float | None = None
        self.last_error: str | None = None

    def status(self) -> dict:
        return {"state": self.state, "last_ok": self.last_ok, "last_error": self.last_error}


def default_providers() -> list[Provider]:
    return [
        Provider("adsb.lol", "https://api.adsb.lol/v2/point/{lat}/{lon}/{r}", "https://api.adsb.lol/v2/hex/{hex}"),
        Provider("adsb.fi", "https://opendata.adsb.fi/api/v2/lat/{lat}/lon/{lon}/dist/{r}",
                 "https://opendata.adsb.fi/api/v2/hex/{hex}"),
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
        ))
    return out


class ReadsbFeed:
    def __init__(self, store: Store, session, providers: list[Provider] | None = None, clock=time.time):
        self.store = store
        self.http = session
        self.providers = providers or default_providers()
        self.clock = clock
        self.flight = SingleFlight()
        self.hex_cache = TTLCache(5000)
        self._areas: list[tuple[float, float, float, float]] = []  # lat, lon, r, fetched_at
        self._lock = threading.Lock()

    def _fetch(self, kind: str, **fmt) -> list[Obs] | None:
        for prov in self.providers:
            if not prov.limiter.acquire(MAX_QUEUE_WAIT_S):
                continue
            url = (prov.point_url if kind == "point" else prov.hex_url).format(**fmt)
            try:
                resp = self.http.get(url, timeout=(5, 10))
                resp.raise_for_status()
                obs = parse_readsb(resp.json(), prov.name)
                prov.state, prov.last_ok, prov.last_error = "ok", self.clock(), None
                return obs
            except Exception as exc:
                prov.state, prov.last_error = "degraded", str(exc)[:300]
                log.info("%s %s failed: %s", prov.name, kind, exc)
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
