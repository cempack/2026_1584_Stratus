"""Estimated positions: the happy path and every rejection rule (zero false positives)."""

import pytest
from conftest import FakeClock

from stratus import estimate
from stratus.store import Obs, Store
from stratus.util import bearing_deg, destination_point, haversine_nm

T0 = 1_800_000_000.0
JFK = {"icao": "KJFK", "lat": 40.6398, "lon": -73.7789}
LHR = {"icao": "EGLL", "lat": 51.4706, "lon": -0.4619}
ROUTE = {"callsign": "BAW178", "origin": JFK, "destination": LHR, "source": "adsbdb"}


def mid_atlantic(dist_nm=1500.0):
    brg = bearing_deg(JFK["lat"], JFK["lon"], LHR["lat"], LHR["lon"])
    return destination_point(JFK["lat"], JFK["lon"], brg, dist_nm)


def make(history=True, route_gap=0.0, **kw):
    """Store with one cruising plane whose last fix is at T0 (the clock is set by the caller)."""
    lat, lon = mid_atlantic()
    trk = kw.pop("trk", None)
    hist_trk, hist_alt = kw.pop("hist_trk", None), kw.pop("hist_alt", None)
    if trk is None:
        trk = bearing_deg(lat, lon, LHR["lat"], LHR["lon"])
    base = dict(hex="406abc", ts=T0, lat=lat, lon=lon, alt=37000, gs=450, trk=trk, vr=0, gnd=False,
                src="opensky", cs="BAW178")
    base.update(kw)
    s = Store(FakeClock(T0 + 10))
    if history:
        back = (base["trk"] if hist_trk is None else hist_trk) + 180
        plat, plon = destination_point(base["lat"], base["lon"], back % 360, 450 * 90 / 3600)
        s.apply([Obs(**{**base, "ts": T0 - 90, "lat": plat, "lon": plon,
                        "alt": base["alt"] if hist_alt is None else hist_alt})])
    s.apply([Obs(**base)])
    return s


def run(s, route=ROUTE, dt=300.0):
    now = T0 + dt
    s.clock.t = now
    s.maintain(now, route_for=lambda cs: route)
    return s.get("406abc"), now


def test_cruising_plane_over_the_ocean_is_estimated_along_the_great_circle():
    s = make()
    p, now = run(s)
    assert p.est and p.est_since == now and p.no_est is False
    row = p.as_row()
    assert row[-1] is True and row[10] == "opensky" and row[9] == T0  # ts stays the last real fix
    moved = haversine_nm(p.lat, p.lon, row[2], row[3])
    assert moved == pytest.approx(450 * 300 / 3600, abs=0.5)  # gs * dt along the track
    # heading is the bearing to the destination from the estimated point
    assert row[6] == pytest.approx(bearing_deg(row[2], row[3], LHR["lat"], LHR["lon"]), abs=0.2)
    assert s.estimated_count() == 1
    # keeps moving on the next tick and bumps the snapshot version
    v = s.version
    s.maintain(now + 60, route_for=lambda cs: ROUTE)
    assert s.version > v
    assert haversine_nm(row[2], row[3], p.as_row()[2], p.as_row()[3]) == pytest.approx(450 * 60 / 3600, abs=0.2)
    assert s.snapshot()[1] and b'"est"' in s.snapshot()[1]


def test_recent_fix_is_not_estimated_yet():
    s = make()
    p, _ = run(s, dt=100)  # < 2 min
    assert not p.est and p.as_row()[-1] is False


@pytest.mark.parametrize("name,kw,route", [
    ("on ground", dict(gnd=True, alt=None), ROUTE),
    ("low altitude", dict(alt=9000), ROUTE),
    ("unknown altitude", dict(alt=None), ROUTE),
    ("slow", dict(gs=150), ROUTE),
    ("climbing out", dict(vr=2500), ROUTE),
    ("descending", dict(vr=-1800), ROUTE),
    ("no callsign", dict(cs=None), ROUTE),
    ("callsign mismatch", {}, {**ROUTE, "callsign": "DLH400"}),
    ("no route", {}, None),
    ("route without coordinates", {}, {**ROUTE, "destination": {"icao": "EGLL", "lat": None, "lon": None}}),
    ("implausible route", {}, {**ROUTE, "origin": {"icao": "YSSY", "lat": -33.9, "lon": 151.2}}),
])
def test_rejections_keep_the_plane_a_plain_stale_plane(name, kw, route):
    s = make(**kw)
    p, _ = run(s, route)
    assert p is not None and not p.est, name
    assert p.as_row()[-1] is False


def test_unstable_track_and_missing_or_changing_history_are_rejected():
    lat, lon = mid_atlantic()
    brg = bearing_deg(lat, lon, LHR["lat"], LHR["lon"])
    cases = {
        "turning": make(trk=(brg + 40) % 360, hist_trk=brg),  # reported track disagrees with where it came from
        "no history": make(history=False),                   # nothing proves the track is stable
        "climbing": make(hist_alt=33000),                    # 4000 ft gained within 90 s
    }
    for name, s in cases.items():
        p, _ = run(s)
        assert not p.est, name
    p, _ = run(make())
    assert p.est  # same construction without the defect is accepted


def test_destination_must_be_ahead_far_enough_and_origin_behind():
    lat, lon = mid_atlantic()
    to_origin = bearing_deg(lat, lon, JFK["lat"], JFK["lon"])
    s = make(trk=to_origin)
    p, _ = run(s)
    assert not p.est  # flying back towards the origin: the destination is behind
    lat3, lon3 = destination_point(LHR["lat"], LHR["lon"], 280.0, 60.0)
    s = make(lat=lat3, lon=lon3, trk=bearing_deg(lat3, lon3, LHR["lat"], LHR["lon"]))
    p, _ = run(s)
    assert not p.est  # last seen close to the destination: it landed, no estimate
    brg0 = bearing_deg(JFK["lat"], JFK["lon"], LHR["lat"], LHR["lon"])
    lat4, lon4 = destination_point(JFK["lat"], JFK["lon"], brg0, 20)
    s = make(lat=lat4, lon=lon4, trk=bearing_deg(lat4, lon4, LHR["lat"], LHR["lon"]))
    p, _ = run(s)
    assert not p.est  # still next to the origin airport


def test_estimate_stops_when_the_plane_would_reach_the_destination():
    s = make()
    p, now = run(s)
    assert p.est
    remaining = haversine_nm(p.lat, p.lon, LHR["lat"], LHR["lon"])
    hours = (remaining - estimate.ARRIVE_NM + 1) / 450
    s.maintain(T0 + hours * 3600, route_for=lambda cs: ROUTE)
    assert s.get("406abc") is None and s.estimated_count() == 0  # dropped immediately, no lingering ghost


def test_projection_ends_after_ten_hours_and_never_goes_backwards():
    far = (-33.9, 151.2)
    assert estimate.project(10.0, 0.0, T0, 450, far, T0 + 3600) is not None
    assert estimate.project(10.0, 0.0, T0, 220, far, T0 + estimate.EST_MAX_S + 1) is None
    assert estimate.project(10.0, 0.0, T0, 450, far, T0 - 50) is not None  # clock skew: treated as no movement
    s = make()
    s.maintain(T0 + estimate.EST_MAX_S + 5, route_for=lambda cs: ROUTE)
    assert s.get("406abc") is None  # past 10 h: plain expiry, not estimated


def test_a_real_fix_always_wins_and_clears_the_estimate():
    s = make()
    p, now = run(s)
    assert p.est
    lat, lon = p.elat, p.elon
    s.clock.t = now + 5
    s.apply([Obs(hex="406abc", ts=now + 2, lat=lat + 0.02, lon=lon, alt=37000, gs=451, trk=60.0, vr=0,
                 src="adsb.fi", cs="BAW178", pos_type="adsb_icao")])
    assert not p.est and p.est_since is None and p.src == "adsb.fi"
    assert p.as_row()[2] == round(lat + 0.02, 5) and p.as_row()[-1] is False


def test_a_fix_elsewhere_cancels_the_estimate_for_good():
    s = make()
    p, now = run(s)
    assert p.est
    s.clock.t = now + 5
    # another source reports the hex 1500 NM away only 4 minutes after the last real fix: impossible jump
    far = destination_point(p.lat, p.lon, 0.0, 1500.0)
    s.apply([Obs(hex="406abc", ts=T0 + 240, lat=far[0], lon=far[1], alt=30000, gs=400, trk=10.0, src="adsb.lol")])
    assert not p.est and p.no_est
    s.maintain(now + 10, route_for=lambda cs: ROUTE)
    assert not p.est  # never estimated again from that stale fix
    s.maintain(T0 + 16 * 60, route_for=lambda cs: ROUTE)
    assert s.get("406abc") is None  # ordinary 15 min expiry


def test_estimated_planes_are_found_by_area_and_not_persisted_as_real_fixes(tmp_path):
    s = make()
    p, now = run(s)
    area = s.area(p.elat, p.elon, 10)
    assert [r[0] for r in area["rows"]] == ["406abc"] and area["rows"][0][-1] is True
    assert s.area(p.lat, p.lon, 5)["rows"] == []  # the stale real position is no longer where it is drawn
    path = tmp_path / "store.json.gz"
    s.save(path)
    s2 = Store(FakeClock(now))
    assert s2.load(path)
    q = s2.get("406abc")
    assert (q.lat, q.lon, q.ts, q.est) == (pytest.approx(p.lat, abs=1e-4), pytest.approx(p.lon, abs=1e-4), p.ts, False)  # restored with its REAL fix


def test_estimation_can_be_switched_off_by_not_providing_routes():
    s = make()
    s.maintain(T0 + 300)
    assert not s.get("406abc").est
