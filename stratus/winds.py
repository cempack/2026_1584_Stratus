"""Coarse wind grid at a pressure level (open-meteo, batched, cached 30 min per cell) for the particle layer."""

from __future__ import annotations

import math

from .util import TTLCache, num

METEO_URL = "https://api.open-meteo.com/v1/forecast"
TTL_S = 1800
MAX_NX, MAX_NY = 15, 10
STEPS = [0.25, 0.5, 1, 2, 2.5, 5, 10, 15, 20, 30, 45, 60]
LEVELS = {1000, 925, 850, 700, 600, 500, 400, 300, 250, 200, 150, 100}


def plan_grid(south: float, west: float, north: float, east: float):
    """Pick the finest aligned grid covering the bbox with at most MAX_NX x MAX_NY points.

    Returns (step, lats north->south, lons west->east). Longitudes are normalised to [-180, 180); a bbox that
    crosses the antimeridian has west > east.
    """
    south, north = max(-90.0, min(south, north)), min(90.0, max(south, north))
    span_lon = (east - west) % 360.0 if east != west else 0.0
    if span_lon == 0.0 and east != west:
        span_lon = 360.0
    for step in STEPS:
        lat0, lat1 = math.floor(south / step) * step, math.ceil(north / step) * step
        lon0 = math.floor(west / step) * step
        nx = int(math.ceil((west - lon0 + span_lon) / step - 1e-9)) + 1
        ny = int(round((min(90.0, lat1) - max(-90.0, lat0)) / step)) + 1
        if nx <= MAX_NX and ny <= MAX_NY:
            break
    lats = [round(min(90.0, lat1) - i * step, 4) for i in range(ny)]
    lons = [round((lon0 + i * step + 180.0) % 360.0 - 180.0, 4) for i in range(nx)]
    return step, lats, lons


def to_uv(speed_kt: float | None, from_deg: float | None) -> tuple[float | None, float | None]:
    """Meteorological (speed, direction wind comes FROM) -> u eastward / v northward components, same unit."""
    if speed_kt is None or from_deg is None:
        return None, None
    r = math.radians(from_deg)
    return round(-speed_kt * math.sin(r), 1), round(-speed_kt * math.cos(r), 1)


class Winds:
    def __init__(self, session, clock=None):
        self.http = session
        self.cache = TTLCache(20_000, *([clock] if clock else []))

    def _vars(self, level) -> tuple[str, str]:
        return ("wind_speed_10m", "wind_direction_10m") if level == "surface" else \
            (f"wind_speed_{level}hPa", f"wind_direction_{level}hPa")

    def _fetch(self, level, points: list[tuple[float, float]]) -> None:
        sp, di = self._vars(level)
        resp = self.http.get(METEO_URL, params={
            "latitude": ",".join(str(p[0]) for p in points), "longitude": ",".join(str(p[1]) for p in points),
            "current": f"{sp},{di}", "wind_speed_unit": "kn", "timeformat": "unixtime"}, timeout=(5, 20))
        resp.raise_for_status()
        body = resp.json()
        items = body if isinstance(body, list) else [body]
        for pt, item in zip(points, items):
            cur = (item or {}).get("current") or {}
            u, v = to_uv(num(cur.get(sp)), num(cur.get(di)))
            self.cache.set((level, *pt), None if u is None else (u, v), TTL_S)

    def grid(self, south: float, west: float, north: float, east: float, level=250) -> dict:
        """Wind grid for the bbox. Raises on total failure (no cached cell and the upstream call failed)."""
        step, lats, lons = plan_grid(south, west, north, east)
        points = [(la, lo) for la in lats for lo in lons]
        missing = [pt for pt in points if self.cache.get((level, *pt), False) is False]
        err = None
        if missing:
            try:
                self._fetch(level, missing)
            except Exception as exc:
                err = exc
        u, v = [], []
        for pt in points:
            cell = self.cache.get((level, *pt), None)
            u.append(None if cell is None else cell[0])
            v.append(None if cell is None else cell[1])
        if err is not None and all(x is None for x in u):
            raise err
        return {"level": level, "unit": "kt", "bbox": [south, west, north, east], "step": step,
                "nx": len(lons), "ny": len(lats), "lats": lats, "lons": lons, "u": u, "v": v,
                "lat0": lats[0], "lon0": lons[0], "dlat": step, "dlon": step}
