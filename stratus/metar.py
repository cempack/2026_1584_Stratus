"""METAR from aviationweather.gov (JSON), decoded, cached 10 minutes."""

from __future__ import annotations

import logging
import re

from .util import MISSING, SingleFlight, TTLCache, num, parse_iso

log = logging.getLogger(__name__)

URL = "https://aviationweather.gov/api/data/metar"
TTL_S = 600
TTL_ERROR_S = 60
MAX_IDS_PER_REQUEST = 60
BBOX_CAP = 60
ICAO_RE = re.compile(r"^[A-Za-z0-9]{4}$")
INHG_TO_HPA = 33.8639
SM_TO_KM = 1.609344


def parse_visibility_sm(value) -> float | None:
    """'10+' -> 10, '1/2' -> 0.5, '1 1/2' -> 1.5, numbers as is (statute miles)."""
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value).strip().rstrip("+")
    try:
        total = 0.0
        for part in text.split():
            if "/" in part:
                a, b = part.split("/")
                total += float(a) / float(b)
            else:
                total += float(part)
        return total
    except (ValueError, ZeroDivisionError):
        return None


def flight_category(vis_sm: float | None, ceiling_ft: float | None) -> str | None:
    if vis_sm is None and ceiling_ft is None:
        return None
    vis = 99.0 if vis_sm is None else vis_sm
    ceil = 99999.0 if ceiling_ft is None else ceiling_ft
    if ceil < 500 or vis < 1:
        return "LIFR"
    if ceil < 1000 or vis < 3:
        return "IFR"
    if ceil <= 3000 or vis <= 5:
        return "MVFR"
    return "VFR"


def decode(item: dict) -> dict | None:
    if not isinstance(item, dict) or not item.get("icaoId"):
        return None
    clouds = []
    ceiling = None
    for c in item.get("clouds") or []:
        if not isinstance(c, dict):
            continue
        base = num(c.get("base"))
        clouds.append({"cover": c.get("cover"), "base_ft": None if base is None else int(base)})
        if c.get("cover") in ("BKN", "OVC", "OVX") and base is not None:
            ceiling = base if ceiling is None else min(ceiling, base)
    vv = num(item.get("vertVis"))
    if vv is not None:  # vertical visibility in hundreds of feet when the sky is obscured
        ceiling = vv * 100 if ceiling is None else min(ceiling, vv * 100)
    vis_sm = parse_visibility_sm(item.get("visib"))
    altim = num(item.get("altim"))
    if altim is not None and altim < 100:  # inHg
        altim *= INHG_TO_HPA
    wdir = item.get("wdir")
    wdir = None if wdir is None or str(wdir).upper() == "VRB" else num(wdir)
    obs = num(item.get("obsTime")) or parse_iso(str(item.get("reportTime") or "").replace(" ", "T"))
    cat = item.get("fltCat")
    cat = cat if cat in ("VFR", "MVFR", "IFR", "LIFR") else flight_category(vis_sm, ceiling)
    return {
        "icao": str(item["icaoId"]).upper(), "name": item.get("name"), "lat": num(item.get("lat")),
        "lon": num(item.get("lon")), "raw": item.get("rawOb"), "time": obs,
        "wind_dir": wdir, "wind_variable": str(item.get("wdir")).upper() == "VRB",
        "wind_kt": num(item.get("wspd")), "gust_kt": num(item.get("wgst")),
        "vis_sm": None if vis_sm is None else round(vis_sm, 2),
        "vis_km": None if vis_sm is None else round(vis_sm * SM_TO_KM, 1),
        "ceiling_ft": None if ceiling is None else int(ceiling), "clouds": clouds,
        "weather": item.get("wxString") or None,
        "temp_c": num(item.get("temp")), "dew_c": num(item.get("dewp")),
        "qnh_hpa": None if altim is None else round(altim, 1), "flight_category": cat,
    }


class Metar:
    def __init__(self, session, clock=None):
        self.http = session
        self.cache = TTLCache(5000, *([clock] if clock else []))
        self.flight = SingleFlight()

    def _fetch(self, ids: list[str]) -> dict[str, dict]:
        resp = self.http.get(URL, params={"ids": ",".join(ids), "format": "json"}, timeout=(5, 10))
        if resp.status_code == 204:
            return {}
        resp.raise_for_status()
        body = resp.json()
        out = {}
        for item in body if isinstance(body, list) else []:
            d = decode(item)
            if d:
                out[d["icao"]] = d
        return out

    def _fill(self, ids: list[str]) -> None:
        """Fetch every id missing from the cache in one request."""
        missing = [i for i in ids if self.cache.get(i, MISSING) is MISSING]
        for k in range(0, len(missing), MAX_IDS_PER_REQUEST):
            chunk = missing[k:k + MAX_IDS_PER_REQUEST]
            try:
                found = self._fetch(chunk)
            except Exception as exc:
                log.info("metar fetch failed: %s", exc)
                for i in chunk:
                    self.cache.set(i, None, TTL_ERROR_S)
                continue
            for i in chunk:
                self.cache.set(i, found.get(i), TTL_S)

    def get(self, icao: str) -> dict | None:
        icao = icao.upper()
        self.flight.do(("metar", icao), lambda: self._fill([icao]))
        return self.cache.get(icao, None)

    def many(self, icaos: list[str]) -> list[dict]:
        icaos = [i.upper() for i in icaos][:BBOX_CAP]
        self._fill(icaos)
        return [m for m in (self.cache.get(i, None) for i in icaos) if m]
