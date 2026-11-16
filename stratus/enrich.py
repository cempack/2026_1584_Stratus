"""adsbdb aircraft/route and planespotters photo lookups, cached, run in the background."""

from __future__ import annotations

import logging
import math
import threading
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import quote

from .util import MISSING, TTLCache, haversine_nm, norm_callsign, num

log = logging.getLogger(__name__)

AIRCRAFT_URL = "https://api.adsbdb.com/v0/aircraft/{hex}"
CALLSIGN_URL = "https://api.adsbdb.com/v0/callsign/{cs}"
PHOTO_URL = "https://api.planespotters.net/pub/photos/hex/{hex}"
TTL_OK = {"aircraft": 24 * 3600, "route": 6 * 3600, "photo": 12 * 3600}
TTL_MISS = {"aircraft": 6 * 3600, "route": 3600, "photo": 6 * 3600}
TTL_ERROR = 120


def _s(v):
    v = str(v).strip() if v is not None else ""
    return v or None


def parse_aircraft(body: dict) -> dict | None:
    a = (body or {}).get("response")
    a = a.get("aircraft") if isinstance(a, dict) else None
    if not isinstance(a, dict):
        return None
    manu = _s(a.get("manufacturer"))
    model = _s(a.get("type"))
    owner = _s(a.get("registered_owner"))
    return {
        "registration": _s(a.get("registration")), "type": _s(a.get("icao_type")),
        "type_name": " ".join(x for x in (manu, model) if x) or None, "manufacturer": manu,
        "operator": owner, "operator_icao": _s(a.get("registered_owner_operator_flag_code")),
        "owner": owner, "country": _s(a.get("registered_owner_country_name")),
    }


def _airport(a) -> dict | None:
    if not isinstance(a, dict):
        return None
    return {"icao": _s(a.get("icao_code")), "iata": _s(a.get("iata_code")), "name": _s(a.get("name")),
            "city": _s(a.get("municipality")), "country": _s(a.get("country_name")),
            "lat": num(a.get("latitude")), "lon": num(a.get("longitude"))}


def parse_route(body: dict) -> dict | None:
    r = (body or {}).get("response")
    r = r.get("flightroute") if isinstance(r, dict) else None
    if not isinstance(r, dict):
        return None
    origin, dest = _airport(r.get("origin")), _airport(r.get("destination"))
    if not origin or not dest:
        return None
    airline = r.get("airline") if isinstance(r.get("airline"), dict) else {}
    return {"callsign": norm_callsign(r.get("callsign")), "airline": _s(airline.get("name")),
            "airline_iata": _s(airline.get("iata")), "airline_icao": _s(airline.get("icao")),
            "origin": origin, "destination": dest}


def parse_photo(body: dict) -> dict | None:
    photos = (body or {}).get("photos") or []
    if not photos or not isinstance(photos[0], dict):
        return None
    p = photos[0]
    large = (p.get("thumbnail_large") or {}).get("src")
    thumb = (p.get("thumbnail") or {}).get("src") or large
    if not thumb:
        return None
    return {"thumb": thumb, "large": large or thumb, "photographer": _s(p.get("photographer")),
            "link": _s(p.get("link"))}


def _xyz(lat, lon):
    la, lo = math.radians(lat), math.radians(lon)
    return (math.cos(la) * math.cos(lo), math.cos(la) * math.sin(lo), math.sin(la))


def route_plausible(route: dict, lat: float, lon: float, gnd: bool = False) -> bool:
    """False when the plane is far off the great circle origin -> destination."""
    o, d = route["origin"], route["destination"]
    if None in (o["lat"], o["lon"], d["lat"], d["lon"]):
        return False
    d_o = haversine_nm(lat, lon, o["lat"], o["lon"])
    d_d = haversine_nm(lat, lon, d["lat"], d["lon"])
    if gnd:
        return min(d_o, d_d) <= 10
    total = haversine_nm(o["lat"], o["lon"], d["lat"], d["lon"])
    if total < 1:
        return min(d_o, d_d) < 150
    a, b, p = _xyz(o["lat"], o["lon"]), _xyz(d["lat"], d["lon"]), _xyz(lat, lon)
    n = (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])
    nn = math.sqrt(sum(c * c for c in n)) or 1.0
    xtd = abs(math.asin(max(-1.0, min(1.0, sum(n[i] * p[i] for i in range(3)) / nn)))) * 3440.065
    limit = max(100.0, 0.15 * total)
    # Along-track check: the sum of distances to both ends must not exceed the leg by much.
    return xtd <= limit and d_o + d_d <= total + 2 * limit


class Enricher:
    def __init__(self, session, workers: int = 4):
        self.http = session
        self.cache = TTLCache(30_000)
        self.pool = ThreadPoolExecutor(max_workers=workers, thread_name_prefix="enrich")
        self._pending: set = set()
        self._lock = threading.Lock()

    def _lookup(self, kind: str, key: str, url: str, parser) -> None:
        try:
            resp = self.http.get(url, timeout=(5, 10))
            if resp.status_code == 404:
                value = None
            else:
                resp.raise_for_status()
                value = parser(resp.json())
            self.cache.set((kind, key), value, TTL_OK[kind] if value else TTL_MISS[kind])
        except Exception as exc:
            log.info("%s lookup %s failed: %s", kind, key, exc)
            self.cache.set((kind, key), None, TTL_ERROR)
        finally:
            with self._lock:
                self._pending.discard((kind, key))

    def _get(self, kind: str, key: str, url: str, parser):
        val = self.cache.get((kind, key), MISSING)
        if val is not MISSING:
            return val
        with self._lock:
            if (kind, key) in self._pending:
                return None
            self._pending.add((kind, key))
        self.pool.submit(self._lookup, kind, key, url, parser)
        return None

    def aircraft(self, hx: str):
        return self._get("aircraft", hx, AIRCRAFT_URL.format(hex=hx), parse_aircraft)

    def route(self, cs: str | None):
        if not cs:
            return None
        return self._get("route", cs, CALLSIGN_URL.format(cs=quote(cs)), parse_route)

    def photo(self, hx: str):
        return self._get("photo", hx, PHOTO_URL.format(hex=hx), parse_photo)
