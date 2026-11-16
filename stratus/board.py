"""Airport board: live arrivals / departures derived from the plane store (no extra network calls)."""

from __future__ import annotations

from .enrich import route_plausible
from .util import angle_diff, bearing_deg, haversine_nm

RADIUS_NM = 60.0
PROFILE_ARRIVAL_NM = 40.0
PROFILE_DEPARTURE_NM = 25.0
LOW_AGL_FT = 8000
MIN_ETA_GS_KT = 100.0
MAX_PER_LIST = 40


def _entry(p, apt: dict, dist: float, basis: str, route: dict | None, kind: str) -> dict:
    lat, lon = p.pos()
    other = None
    if route:
        other = route["origin"] if kind == "arrival" else route["destination"]
    out = {"hex": p.hex, "cs": p.cs, "type": p.type, "reg": p.reg, "lat": round(lat, 5), "lon": round(lon, 5),
           "alt": p.alt, "gs": p.gs, "trk": p.trk, "vr": p.vr, "gnd": p.gnd, "est": p.est, "ts": round(p.ts, 1),
           "dist_nm": round(dist, 1), "basis": basis,
           "origin" if kind == "arrival" else "destination":
               None if other is None else {"icao": other.get("icao"), "iata": other.get("iata"),
                                           "name": other.get("name"), "city": other.get("city")},
           "phase": None, "eta_s": None, "eta_ts": None}
    return out


def build(store, enrich, apt: dict, now: float) -> tuple[list[dict], list[dict]]:
    """(arrivals, departures) for airport record `apt` ({icao, lat, lon, elev_ft, ...})."""
    icao, alat, alon = apt["icao"], apt["lat"], apt["lon"]
    elev = apt.get("elev_ft") or 0
    arrivals, departures = [], []
    with store.lock:
        near = []
        for p in store.planes.values():
            plat, plon = p.pos()
            if abs(plat - alat) > RADIUS_NM / 60.0 + 0.5:
                continue
            d = haversine_nm(alat, alon, plat, plon)
            if d <= RADIUS_NM:
                near.append((p, d))
    for p, d in near:
        route = enrich.route(p.cs) if p.cs else None  # cache hit or background lookup; never blocks
        lat, lon = p.pos()
        confirmed = bool(route) and route_plausible(route, p.lat, p.lon, p.gnd)
        dest = (route or {}).get("destination", {}).get("icao") if confirmed else None
        orig = (route or {}).get("origin", {}).get("icao") if confirmed else None
        if p.gnd:
            if d <= 5.0 and orig == icao:
                e = _entry(p, apt, d, "route", route, "departure")
                e["phase"] = "ground"
                departures.append(e)
            continue
        if dest == icao:
            e = _entry(p, apt, d, "route", route, "arrival")
            arrivals.append(e)
            continue
        if orig == icao:
            e = _entry(p, apt, d, "route", route, "departure")
            e["phase"] = "climbing" if (p.vr or 0) > 300 or (p.alt or 0) - elev < 10000 else "enroute"
            departures.append(e)
            continue
        if confirmed:
            continue  # a plausible route to/from another airport: not ours, whatever its profile
        # No usable route: profile heuristics for planes low and moving along a flight path near the airport.
        if p.est or p.alt is None or p.alt - elev > LOW_AGL_FT or p.vr is None:
            continue
        toward = angle_diff(bearing_deg(lat, lon, alat, alon), p.trk) if p.trk is not None else 180.0
        if p.vr <= -300 and d <= PROFILE_ARRIVAL_NM and toward <= 70:
            arrivals.append(_entry(p, apt, d, "profile", None, "arrival"))
        elif p.vr >= 500 and d <= PROFILE_DEPARTURE_NM and toward >= 90:
            e = _entry(p, apt, d, "profile", None, "departure")
            e["phase"] = "climbing"
            departures.append(e)
    for e in arrivals:
        e["phase"] = "final" if e["dist_nm"] <= 10 else "approach" if e["dist_nm"] <= 30 else "inbound"
        gs = e["gs"]
        if gs is not None:
            e["eta_s"] = int(e["dist_nm"] / max(float(gs), MIN_ETA_GS_KT) * 3600)
            e["eta_ts"] = round(now + e["eta_s"], 1)
    arrivals.sort(key=lambda e: (e["eta_s"] is None, e["eta_s"] or 0, e["dist_nm"]))
    departures.sort(key=lambda e: (e["phase"] != "ground", e["dist_nm"]))
    return arrivals[:MAX_PER_LIST], departures[:MAX_PER_LIST]
