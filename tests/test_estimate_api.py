"""Background route lookups feeding the estimator, and the est fields in the HTTP API."""

import time

from conftest import FakeClock, FakeResp, FakeSession
from test_api import ADSBDB_ROUTE
from test_estimate import JFK, LHR, ROUTE, T0, mid_atlantic

from stratus.api import create_app
from stratus.enrich import Enricher
from stratus.store import Obs, Store
from stratus.util import bearing_deg, destination_point


def store_with_planes():
    clock = FakeClock(T0 + 1000)
    s = Store(clock)

    def add(hx, cs, ts_age, alt=36000, gnd=False):
        s.apply([Obs(hex=hx, ts=clock() - ts_age, lat=50.0, lon=-30.0, alt=alt, gs=450, trk=80.0, vr=0, gnd=gnd,
                     src="opensky", cs=cs)])

    add("a00001", "AFR1", 200)       # lost 200 s ago: top priority
    add("a00002", "AFR2", 10)        # fresh
    add("a00003", "AFR3", 5, alt=5000)   # low
    add("a00004", "AFR4", 5, gnd=True, alt=None)
    add("a00005", "N123AB", 300)     # registration used as callsign: no route exists
    add("a00006", "AFR6", 400)       # route already cached
    add("a00007", "AFR7", 100)
    return s, clock


def test_prefetch_prioritises_lost_planes_and_skips_useless_lookups():
    s, clock = store_with_planes()
    session = FakeSession({"adsbdb.com/v0/callsign": FakeResp(ADSBDB_ROUTE)})
    e = Enricher(session)
    e.cache.set(("route", "AFR6"), None, 3600)
    assert e.prefetch_candidates(s, clock(), 10) == ["AFR7", "AFR1", "AFR2"]  # lost ones first (most recent first)
    assert e.prefetch_candidates(s, clock(), 2) == ["AFR7", "AFR1"]
    assert e.prefetch(s, clock(), limit=2) == 2
    deadline = time.time() + 5
    while time.time() < deadline and session.count("adsbdb.com/v0/callsign") < 2:
        time.sleep(0.02)
    assert session.count("adsbdb.com/v0/callsign") == 2
    time.sleep(0.1)
    assert e.prefetch_candidates(s, clock(), 10) == ["AFR2"]  # looked up ones are cached (6 h), not asked twice
    assert e.cached_route("AFR1")["source"] == "adsbdb" and e.cached_route("NOPE") is None


def test_prefetch_stops_when_many_lookups_are_pending():
    s, clock = store_with_planes()
    e = Enricher(FakeSession({}))
    e._pending.update(("route", f"X{i}") for i in range(13))
    assert e.prefetch(s, clock()) == 0


def test_estimated_plane_in_planes_aircraft_and_status(cfg):
    clock = FakeClock(T0 + 10)
    session = FakeSession({"api.adsb": FakeResp({}, 500), "opendata.adsb.fi": FakeResp({}, 500),
                           "adsbdb.com": FakeResp({}, 404), "planespotters": FakeResp({}, 404)})
    app = create_app(cfg, session, start_feeds=False, clock=clock)
    rt = app.config["RUNTIME"]
    client = app.test_client()
    lat, lon = mid_atlantic()
    trk = bearing_deg(lat, lon, LHR["lat"], LHR["lon"])
    plat, plon = destination_point(lat, lon, (trk + 180) % 360, 450 * 90 / 3600)
    for ts, la, lo in ((T0 - 90, plat, plon), (T0, lat, lon)):
        rt.store.apply([Obs(hex="406abc", ts=ts, lat=la, lon=lo, alt=37000, gs=450, trk=trk, vr=0, src="opensky",
                            cs="BAW178")])
    rt.enrich.cache.set(("route", "BAW178"), ROUTE, 3600)
    clock.t = T0 + 600
    rt.store.maintain(route_for=rt.enrich.cached_route)  # what the housekeeping thread does every 10 s

    body = client.get("/api/planes").get_json()
    assert body["fields"][-1] == "est"
    row = dict(zip(body["fields"], body["rows"][0]))
    assert row["est"] is True and row["ts"] == T0 and row["src"] == "opensky" and (row["lat"], row["lon"]) != (lat, lon)

    d = client.get("/api/aircraft/406abc").get_json()
    assert d["plane"]["est"] is True and d["estimated_since"] == T0 + 600
    assert d["plane"]["lat"] == row["lat"]  # the estimated position, while `ts` stays the last real fix
    assert d["route"]["plausible"] is True  # judged from the last real fix, not from the estimate
    assert d["fr24"] is None and d["trail"][-1][:2] == [round(lat, 5), round(lon, 5)]  # trail stays real fixes only
    assert client.get("/api/status").get_json()["estimated"] == 1

    area = client.get(f"/api/planes/area?lat={row['lat']}&lon={row['lon']}&r=20").get_json()
    assert [r[0] for r in area["rows"]] == ["406abc"] and area["rows"][0][-1] is True

    # a real fix from any source ends it
    rt.store.apply([Obs(hex="406abc", ts=T0 + 590, lat=row["lat"], lon=row["lon"], alt=37000, gs=450, trk=trk,
                        vr=0, src="adsb.lol", cs="BAW178")], now=clock())
    d = client.get("/api/aircraft/406abc").get_json()
    assert d["plane"]["est"] is False and d["estimated_since"] is None and d["plane"]["src"] == "adsb.lol"


def test_estimates_can_be_disabled_in_config(cfg):
    cfg.estimates_enabled = False
    rt = create_app(cfg, FakeSession({}), start_feeds=False).config["RUNTIME"]
    assert rt.cfg.estimates_enabled is False
    s, _ = store_with_planes()
    assert s.maintain(route_for=None) == 0
