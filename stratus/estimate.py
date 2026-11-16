"""Estimated positions for planes that left coverage (oceans), with strict no-false-positive rules.

A plane is only estimated when ALL of these hold at its last real fix:
  - airborne, cruise-ish (alt >= 10 000 ft, gs >= 200 kt), level (|vr| <= 1000 fpm), callsign known;
  - stable track: bearing from an earlier fix 30..600 s before agrees with the reported track (<= 15 deg) and the
    altitude did not change by more than 1500 ft;
  - a route is known, its callsign matches the plane's, and `route_plausible` holds at the last fix and the plane is within ~6 % of the leg of the great circle;
  - the destination is ahead (bearing to it within 60 deg of the track), >= 80 NM away; the origin is >= 40 NM behind.
The estimate follows the great circle from the last fix to the destination at the last ground speed, and ends
(the plane is dropped) when it would reach 10 NM from the destination or after 10 h. Real fixes always win; a fix
rejected by the sanity filter also cancels the estimate (see Store._merge).
"""

from __future__ import annotations

from dataclasses import dataclass

import math

from .enrich import _xyz, route_plausible
from .util import EARTH_RADIUS_NM, angle_diff, bearing_deg, destination_point, haversine_nm

EST_AFTER_S = 120.0
EST_MAX_S = 10 * 3600.0
MIN_ALT_FT = 10_000
MIN_GS_KT = 200
MAX_VR_FPM = 1000
MAX_BEARING_OFF_DEG = 60.0
TRACK_STABLE_DEG = 15.0
HISTORY_MIN_S, HISTORY_MAX_S = 30.0, 600.0
HISTORY_MIN_NM = 2.0
HISTORY_MAX_ALT_DELTA_FT = 1500
MIN_DEST_NM = 80.0
MIN_ORIGIN_NM = 40.0
ARRIVE_NM = 10.0
XTD_FRACTION, XTD_MIN_NM, XTD_MAX_NM = 0.06, 60.0, 200.0


@dataclass(slots=True)
class Fix:
    lat: float
    lon: float
    ts: float
    alt: int | None
    gs: int | None
    trk: float | None
    vr: int | None
    gnd: bool
    cs: str | None
    trail: list


def reject_reason(fix: Fix, route: dict | None, now: float) -> str | None:
    """None when the plane may be estimated, else a short reason code."""
    if fix.gnd:
        return "ground"
    if fix.alt is None or fix.alt < MIN_ALT_FT:
        return "low_altitude"
    if fix.gs is None or fix.gs < MIN_GS_KT:
        return "slow"
    if fix.trk is None:
        return "no_track"
    if fix.vr is not None and abs(fix.vr) > MAX_VR_FPM:
        return "climbing_or_descending"
    if not fix.cs:
        return "no_callsign"
    if now - fix.ts > EST_MAX_S:
        return "too_old"
    if not route:
        return "no_route"
    o, d = route.get("origin") or {}, route.get("destination") or {}
    if None in (o.get("lat"), o.get("lon"), d.get("lat"), d.get("lon")):
        return "route_incomplete"
    rcs = route.get("callsign")
    if rcs and rcs != fix.cs:
        return "callsign_mismatch"
    if not route_plausible(route, fix.lat, fix.lon, False) or not _on_route(route, fix.lat, fix.lon):
        return "route_implausible"
    if haversine_nm(fix.lat, fix.lon, d["lat"], d["lon"]) < MIN_DEST_NM:
        return "near_destination"
    if haversine_nm(fix.lat, fix.lon, o["lat"], o["lon"]) < MIN_ORIGIN_NM:
        return "near_origin"
    if angle_diff(bearing_deg(fix.lat, fix.lon, d["lat"], d["lon"]), fix.trk) > MAX_BEARING_OFF_DEG:
        return "destination_not_ahead"
    return _track_history_reason(fix)


def _on_route(route: dict, lat: float, lon: float) -> bool:
    """Stricter than route_plausible (which tolerates 15 % of the leg): within ~6 % of the leg of the great circle."""
    o, d = route["origin"], route["destination"]
    total = haversine_nm(o["lat"], o["lon"], d["lat"], d["lon"])
    if total < 200:
        return False
    a, b, p = _xyz(o["lat"], o["lon"]), _xyz(d["lat"], d["lon"]), _xyz(lat, lon)
    n = (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])
    nn = math.sqrt(sum(c * c for c in n)) or 1.0
    xtd = abs(math.asin(max(-1.0, min(1.0, sum(n[i] * p[i] for i in range(3)) / nn)))) * EARTH_RADIUS_NM
    limit = min(XTD_MAX_NM, max(XTD_MIN_NM, XTD_FRACTION * total))
    d_o, d_d = haversine_nm(lat, lon, o["lat"], o["lon"]), haversine_nm(lat, lon, d["lat"], d["lon"])
    return xtd <= limit and d_o + d_d <= total + 2 * limit


def _track_history_reason(fix: Fix) -> str | None:
    cands = sorted((pt for pt in fix.trail
                    if fix.ts - HISTORY_MAX_S <= pt[3] <= fix.ts - HISTORY_MIN_S), key=lambda pt: -pt[3])
    ref = next((pt for pt in cands if haversine_nm(pt[0], pt[1], fix.lat, fix.lon) >= HISTORY_MIN_NM), None)
    if ref is None:
        return "no_history"
    if angle_diff(bearing_deg(ref[0], ref[1], fix.lat, fix.lon), fix.trk) > TRACK_STABLE_DEG:
        return "unstable_track"
    if ref[2] is not None and abs(fix.alt - ref[2]) > HISTORY_MAX_ALT_DELTA_FT:
        return "altitude_changing"
    return None


def project(fix_lat: float, fix_lon: float, fix_ts: float, gs: float, dest: tuple[float, float],
            now: float) -> tuple[float, float, float] | None:
    """(lat, lon, track) along the great circle fix -> destination, or None when the estimate must end."""
    dt = now - fix_ts
    if dt < 0:
        dt = 0.0
    if dt > EST_MAX_S:
        return None
    remaining = haversine_nm(fix_lat, fix_lon, dest[0], dest[1])
    travelled = gs * dt / 3600.0
    if travelled >= remaining - ARRIVE_NM:
        return None
    brg = bearing_deg(fix_lat, fix_lon, dest[0], dest[1])
    lat, lon = destination_point(fix_lat, fix_lon, brg, travelled)
    return lat, lon, bearing_deg(lat, lon, dest[0], dest[1])
