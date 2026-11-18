"""open-meteo weather at a point, at the pressure level nearest the plane's altitude."""

from __future__ import annotations

from .util import TTLCache, num

METEO_URL = "https://api.open-meteo.com/v1/forecast"
# pressure level -> approx. ISA altitude (ft)
LEVELS = [(925, 2500), (850, 4800), (700, 9900), (600, 13800), (500, 18300), (400, 23600), (300, 30100),
          (250, 34000), (200, 38700), (150, 44600)]
TTL = 600


def pick_level(alt_ft: float | None) -> str:
    if alt_ft is None or alt_ft < 1500:
        return "surface"
    return "%dhPa" % min(LEVELS, key=lambda lv: abs(lv[1] - alt_ft))[0]


class Weather:
    def __init__(self, session):
        self.http = session
        self.cache = TTLCache(5000)

    def contribute(self, lat: float, lon: float, value: dict, ttl: float = TTL) -> bool:
        """Fill a gap with a browser's Open-Meteo answer (already validated). Never overrides the cache."""
        key = (round(lat * 4) / 4, round(lon * 4) / 4, value["level"])
        if self.cache.has(key):
            return False
        self.cache.set(key, value, ttl)
        return True

    def at(self, lat: float, lon: float, alt_ft: float | None) -> dict:
        level = pick_level(alt_ft)
        clat, clon = round(lat * 4) / 4, round(lon * 4) / 4
        key = (clat, clon, level)
        cached = self.cache.get(key, None)
        if cached:
            return cached
        if level == "surface":
            names = ["temperature_2m", "wind_speed_10m", "wind_direction_10m", "cloud_cover"]
        else:
            names = [f"temperature_{level}", f"wind_speed_{level}", f"wind_direction_{level}", f"cloud_cover_{level}"]
        resp = self.http.get(METEO_URL, params={"latitude": clat, "longitude": clon, "current": ",".join(names),
                                                "wind_speed_unit": "kn", "timeformat": "unixtime"}, timeout=(5, 10))
        resp.raise_for_status()
        cur = resp.json().get("current") or {}
        out = {"temp_c": num(cur.get(names[0])), "wind_kt": num(cur.get(names[1])),
               "wind_dir": num(cur.get(names[2])), "cloud_pct": num(cur.get(names[3])), "level": level,
               "time": num(cur.get("time"))}
        self.cache.set(key, out, TTL)
        return out
