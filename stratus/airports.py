"""OurAirports catalog (airports + runways), downloaded once a day and cached in data/cache."""

from __future__ import annotations

import csv
import io
import logging
import threading
import time

from .util import haversine_nm, num, read_json, write_json_gz_atomic

log = logging.getLogger(__name__)

AIRPORTS_URL = "https://davidmegginson.github.io/ourairports-data/airports.csv"
RUNWAYS_URL = "https://davidmegginson.github.io/ourairports-data/runways.csv"
TTL_S = 24 * 3600
RETRY_S = 600
KEEP_TYPES = {"large_airport": "large", "medium_airport": "medium", "small_airport": "small"}
SEARCH_TYPES = ("large", "medium")


def _s(v) -> str | None:
    v = (v or "").strip()
    return v or None


def parse_airports(text: str) -> list[dict]:
    """Keep large + medium airports, and small ones with scheduled service (needed to resolve route endpoints)."""
    out = []
    for row in csv.DictReader(io.StringIO(text)):
        typ = KEEP_TYPES.get(row.get("type") or "")
        if typ is None or (typ == "small" and row.get("scheduled_service") != "yes"):
            continue
        lat, lon = num(row.get("latitude_deg")), num(row.get("longitude_deg"))
        icao = _s(row.get("icao_code")) or _s(row.get("gps_code")) or _s(row.get("ident"))
        if lat is None or lon is None or not icao or len(icao) != 4 or not icao.isalnum():
            continue
        elev = num(row.get("elevation_ft"))
        out.append({"icao": icao.upper(), "iata": _s(row.get("iata_code")), "name": _s(row.get("name")),
                    "city": _s(row.get("municipality")), "country": _s(row.get("iso_country")),
                    "lat": round(lat, 5), "lon": round(lon, 5), "elev_ft": None if elev is None else int(elev),
                    "type": typ})
    return out


def parse_runways(text: str, known: set[str]) -> dict[str, list[dict]]:
    out: dict[str, list[dict]] = {}
    for row in csv.DictReader(io.StringIO(text)):
        ident = (row.get("airport_ident") or "").strip().upper()
        if ident not in known or row.get("closed") == "1":
            continue
        length, width = num(row.get("length_ft")), num(row.get("width_ft"))
        out.setdefault(ident, []).append({
            "le_ident": _s(row.get("le_ident")), "he_ident": _s(row.get("he_ident")),
            "le_heading": num(row.get("le_heading_degT")), "he_heading": num(row.get("he_heading_degT")),
            "length_ft": None if length is None else int(length), "width_ft": None if width is None else int(width),
            "surface": _s(row.get("surface")), "lighted": row.get("lighted") == "1",
            "le_lat": num(row.get("le_latitude_deg")), "le_lon": num(row.get("le_longitude_deg")),
            "he_lat": num(row.get("he_latitude_deg")), "he_lon": num(row.get("he_longitude_deg")),
        })
    for lst in out.values():
        lst.sort(key=lambda r: -(r["length_ft"] or 0))
    return out


class Airports:
    def __init__(self, session, cache_dir, clock=time.time):
        self.http = session
        self.path = cache_dir / "ourairports.json.gz"
        self.clock = clock
        self._lock = threading.Lock()
        self.list: list[dict] = []
        self.by_icao: dict[str, dict] = {}
        self.by_iata: dict[str, dict] = {}
        self.runway_data: dict[str, list[dict]] = {}
        self.airports_at = 0.0
        self.runways_at = 0.0
        self._retry_at = 0.0
        self._rwy_retry_at = 0.0
        self._index: list[tuple[str, dict]] = []
        self._loaded_disk = False

    # ---- loading ---------------------------------------------------------------
    def _set(self, airports: list[dict], runways: dict[str, list[dict]]) -> None:
        self.list = airports
        self.by_icao = {a["icao"]: a for a in airports}
        self.by_iata = {a["iata"].upper(): a for a in airports if a["iata"] and a["type"] != "small"}
        for a in airports:  # small airports only claim an IATA code nobody bigger has
            if a["iata"] and a["iata"].upper() not in self.by_iata:
                self.by_iata[a["iata"].upper()] = a
        self.runway_data = runways
        self._index = [(" ".join(x for x in (a["icao"], a["iata"], a["name"], a["city"]) if x).lower(), a)
                       for a in airports]

    def _load_disk(self) -> None:
        if self._loaded_disk:
            return
        self._loaded_disk = True
        data = read_json(self.path)
        if isinstance(data, dict) and data.get("airports"):
            self.airports_at = float(data.get("airports_at") or 0)
            self.runways_at = float(data.get("runways_at") or 0)
            self._set(data["airports"], data.get("runways") or {})

    def _download(self, url: str) -> str:
        resp = self.http.get(url, timeout=(10, 60))
        resp.raise_for_status()
        text = getattr(resp, "text", None)
        if not isinstance(text, str) or not text:
            raise ValueError("empty response")
        return text

    def _persist(self) -> None:
        try:
            write_json_gz_atomic(self.path, {"airports_at": self.airports_at, "runways_at": self.runways_at,
                                             "airports": self.list, "runways": self.runway_data})
        except OSError as exc:
            log.warning("cannot cache OurAirports: %s", exc)

    def ensure(self) -> bool:
        """Make sure the airport list is loaded and fresh (< 24 h). Falls back to a stale cache when offline."""
        if self.list and self.clock() - self.airports_at < TTL_S:
            return True
        with self._lock:
            self._load_disk()
            now = self.clock()
            if (not self.list or now - self.airports_at >= TTL_S) and now >= self._retry_at:
                try:
                    airports = parse_airports(self._download(AIRPORTS_URL))
                    if not airports:
                        raise ValueError("no airports parsed")
                    self.airports_at = now
                    self._set(airports, self.runway_data)
                    self._persist()
                except Exception as exc:
                    self._retry_at = now + RETRY_S
                    log.warning("OurAirports download failed: %s", exc)
        return bool(self.list)

    def ensure_runways(self) -> bool:
        if not self.ensure():
            return False
        if self.runways_at and self.clock() - self.runways_at < TTL_S:
            return True
        with self._lock:
            now = self.clock()
            if (not self.runways_at or now - self.runways_at >= TTL_S) and now >= self._rwy_retry_at:
                try:
                    self.runway_data = parse_runways(self._download(RUNWAYS_URL), {a["icao"] for a in self.list})
                    self.runways_at = now
                    self._persist()
                except Exception as exc:
                    self._rwy_retry_at = now + RETRY_S
                    log.warning("OurAirports runways download failed: %s", exc)
        return bool(self.runways_at)

    # ---- queries ---------------------------------------------------------------
    def get(self, code: str | None) -> dict | None:
        if not code or not self.ensure():
            return None
        code = code.strip().upper()
        return self.by_icao.get(code) or (self.by_iata.get(code) if len(code) == 3 else None)

    def runways(self, icao: str) -> list[dict]:
        self.ensure_runways()
        return self.runway_data.get(icao.upper(), [])

    def route_airport(self, icao: str | None, iata: str | None = None, name: str | None = None) -> dict | None:
        """Airport dict in the shape used by `route.origin` / `route.destination`."""
        if not icao:
            return None
        a = self.by_icao.get(icao.upper()) if self.list else None
        return {"icao": icao.upper(), "iata": (a or {}).get("iata") or iata, "name": (a or {}).get("name") or name,
                "city": (a or {}).get("city"), "country": (a or {}).get("country"),
                "lat": (a or {}).get("lat"), "lon": (a or {}).get("lon")}

    def search(self, q: str, limit: int = 20, types=SEARCH_TYPES) -> list[dict]:
        if not self.ensure():
            return []
        q = q.strip().lower()
        if not q:
            return []
        scored = []
        for hay, a in self._index:
            if a["type"] not in types:
                continue
            icao, iata = a["icao"].lower(), (a["iata"] or "").lower()
            if q == iata or q == icao:
                score = 0
            elif icao.startswith(q) or (iata and iata.startswith(q)):
                score = 1
            elif (a["city"] or "").lower().startswith(q) or (a["name"] or "").lower().startswith(q):
                score = 2
            elif q in hay:
                score = 3
            else:
                continue
            scored.append((score, 0 if a["type"] == "large" else 1, a["icao"], a))
        scored.sort(key=lambda t: t[:3])
        return [t[3] for t in scored[:limit]]

    def in_bbox(self, south: float, west: float, north: float, east: float, limit: int = 300,
                types=SEARCH_TYPES) -> list[dict]:
        if not self.ensure():
            return []
        wraps = west > east
        out = [a for a in self.list if a["type"] in types and south <= a["lat"] <= north
               and ((a["lon"] >= west or a["lon"] <= east) if wraps else west <= a["lon"] <= east)]
        out.sort(key=lambda a: (a["type"] != "large", a["icao"]))
        return out[:limit]

    def nearest(self, lat: float, lon: float, nm: float) -> list[dict]:
        return [a for a in self.list if haversine_nm(lat, lon, a["lat"], a["lon"]) <= nm]
