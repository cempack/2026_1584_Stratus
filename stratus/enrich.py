"""adsbdb aircraft/route and planespotters photo lookups, cached, run in the background."""

from __future__ import annotations

import logging
import math
import re
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
AIRLINE_CALLSIGN = re.compile(r"^[A-Z]{3}[0-9]{1,4}[A-Z]{0,2}$")  # worth a route lookup (not a registration)


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
            "origin": origin, "destination": dest, "source": "adsbdb"}


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
    def __init__(self, session, workers: int = 4, fr24=None):
        self.http = session
        self.fr24 = fr24 if fr24 is not None and fr24.enabled else None
        self.cache = TTLCache(30_000)
        self.pool = ThreadPoolExecutor(max_workers=workers, thread_name_prefix="enrich")
        self._pending: set = set()
        self._lock = threading.Lock()
        self._done = threading.Condition(self._lock)

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
                self._done.notify_all()

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

    def _fr24_lookup(self, cs: str, hx: str | None) -> None:
        try:
            self.cache.set(("route-fr24", cs), self.fr24.route(cs, hx), 6 * 3600)  # fr24 also caches its own TTLs
        except Exception as exc:  # Fr24Unavailable (budget, rate, auth...) or network: fall back to adsbdb
            log.debug("fr24 route %s skipped: %s", cs, exc)
            self.cache.set(("route-fr24", cs), None, 30 if getattr(exc, "reason", "") in ("rate", "network") else 300)
        finally:
            with self._lock:
                self._pending.discard(("route-fr24", cs))
                self._done.notify_all()

    def route(self, cs: str | None, selected: bool = False, hx: str | None = None):
        """Route for a callsign. With FR24 configured and `selected` (the user opened this plane) FR24 is asked first;
        otherwise, or when FR24 has nothing, adsbdb. Never blocks: unknown results are filled in the background."""
        if not cs:
            return None
        if selected and self.fr24 is not None and self.fr24.usable():
            val = self.cache.get(("route-fr24", cs), MISSING)
            if val is MISSING:
                with self._lock:
                    first = ("route-fr24", cs) not in self._pending
                    self._pending.add(("route-fr24", cs))
                if first:
                    self.pool.submit(self._fr24_lookup, cs, hx)
            elif val:
                return val
        return self._get("route", cs, CALLSIGN_URL.format(cs=quote(cs)), parse_route)

    def cached_route(self, cs: str | None) -> dict | None:
        """Best route already in the cache (FR24 first), never triggers a lookup. Used by estimation."""
        if not cs:
            return None
        return self.cache.get(("route-fr24", cs), None) or self.cache.get(("route", cs), None)

    def route_known(self, cs: str) -> bool:
        return self.cache.has(("route", cs)) or ("route", cs) in self._pending

    def prefetch_candidates(self, store, now: float, limit: int) -> list[str]:
        """Callsigns worth a background route lookup: airborne planes at cruise-ish level, planes not seen for more
        than 60 s first (they are the ones estimation needs a route for)."""
        with store.lock:
            rows = [(p.cs, now - p.ts) for p in store.planes.values()
                    if p.cs and not p.gnd and p.alt is not None and p.alt >= 10_000 and not p.est]
        prio = sorted((r for r in rows if r[1] > 60), key=lambda r: r[1])
        rest = [r for r in rows if r[1] <= 60]
        out: list[str] = []
        for cs, _ in prio + rest:
            if len(out) >= limit:
                break
            if cs in out or not AIRLINE_CALLSIGN.match(cs) or self.route_known(cs):
                continue
            out.append(cs)
        return out

    def prefetch(self, store, now: float, limit: int = 3) -> int:
        if len(self._pending) > 12:
            return 0
        cands = self.prefetch_candidates(store, now, limit)
        for cs in cands:
            self.route(cs)
        return len(cands)

    def wait(self, hx: str, cs: str | None, timeout: float) -> bool:
        """Block up to `timeout` s while lookups for this plane (aircraft, photo, route) are in flight, so a freshly
        opened flight card can get everything in its first response. True when nothing is pending any more."""
        keys = {("aircraft", hx), ("photo", hx)}
        if cs:
            keys |= {("route", cs), ("route-fr24", cs)}
        with self._done:
            return self._done.wait_for(lambda: not (keys & self._pending), timeout)

    def photo(self, hx: str):
        return self._get("photo", hx, PHOTO_URL.format(hex=hx), parse_photo)


DEPART_MAX_ALT_FT = 2500  # first observed point at or below this (or on the ground)...
DEPART_CLIMB_FT = 4000  # ...followed by a climb of at least this much
DEPART_RADIUS_NM = 8.0


def observed_departure(trail: list, nearest) -> dict | None:
    """Airport the plane was seen taking off from, or None.

    `trail` is the stored track ([lat, lon, alt|None, ts], oldest first; None altitude = on the ground). It counts as an
    observed departure when it starts on the ground or low and then climbs, within DEPART_RADIUS_NM of an airport.
    `nearest(lat, lon, nm)` returns airport dicts (OurAirports shape). Large/medium airports win over small fields.
    """
    if len(trail) < 3:
        return None
    lat, lon, alt0 = trail[0][0], trail[0][1], trail[0][2]
    base = 0 if alt0 is None else alt0
    if base > DEPART_MAX_ALT_FT:
        return None
    if max((pt[2] or 0) for pt in trail) - base < DEPART_CLIMB_FT:
        return None
    cands = nearest(lat, lon, DEPART_RADIUS_NM)
    if not cands:
        return None
    rank = {"large": 0, "medium": 1}
    best = min(cands, key=lambda a: (rank.get(a.get("type"), 2), haversine_nm(lat, lon, a["lat"], a["lon"])))
    return best


def reconcile_route(route: dict | None, departed: dict | None, lat: float, lon: float, gnd: bool) -> dict | None:
    """One route the client can show as is.

    - database route that fits the position (and, if we saw the take-off, starts there): kept, plausible
    - observed take-off elsewhere: the database describes another leg of that flight number; show the observed origin
      with an unknown destination instead of a wrong pair
    - database route that does not fit and nothing observed: dropped (a wrong route is worse than none)
    """
    if departed is not None:
        origin = {"icao": departed["icao"], "iata": departed.get("iata"), "name": departed.get("name"),
                  "city": departed.get("city"), "country": departed.get("country"),
                  "lat": departed["lat"], "lon": departed["lon"]}
        if route and route["origin"].get("icao") == departed["icao"] and route_plausible(route, lat, lon, gnd):
            return {**route, "plausible": True, "observed": True}
        base = {k: route.get(k) for k in ("callsign", "airline", "airline_iata", "airline_icao")} if route else {}
        return {**base, "origin": origin, "destination": None, "source": "observed", "plausible": False, "observed": True}
    if route and route_plausible(route, lat, lon, gnd):
        return {**route, "plausible": True}
    return None
