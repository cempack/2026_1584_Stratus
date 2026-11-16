"""Flightradar24 integration: disabled without a token, credit budget, auth errors, route/position/full-track."""

import json
import time
from pathlib import Path

import pytest
from conftest import FakeClock, FakeResp, FakeSession, readsb_payload

from stratus.airports import Airports
from stratus.api import create_app
from stratus.config import Config
from stratus.fr24 import Fr24
from stratus.store import Obs
from test_api import ADSBDB_ROUTE, AC, seed  # noqa: F401  (reuse the adsbdb fixtures)

NOW = time.time()
APT = [{"icao": "LFPG", "iata": "CDG", "name": "Paris CDG", "city": "Paris", "country": "FR", "lat": 49.0097,
        "lon": 2.5479, "elev_ft": 392, "type": "large"},
       {"icao": "EDDM", "iata": "MUC", "name": "Munich", "city": "Munich", "country": "DE", "lat": 48.3538,
        "lon": 11.7861, "elev_ft": 1487, "type": "large"}]


def summary(cs="DLH4AB", hex_="3C6444", ended=False, fid="391fdd79", orig="LFPG", dest="EDDM"):
    return {"data": [{"fr24_id": fid, "flight": "LH400", "callsign": cs, "operating_as": "DLH", "painted_as": "DLH",
                      "type": "A320", "reg": "D-AIZB", "orig_icao": orig, "dest_icao": dest, "dest_icao_actual": None,
                      "hex": hex_, "flight_ended": ended, "first_seen": "2026-11-16T09:00:00Z",
                      "last_seen": "2026-11-16T10:00:00Z", "datetime_takeoff": "2026-11-16T09:10:00Z",
                      "datetime_landed": None}]}


def position(hex_="3C6444", source="ADSB", lat=48.21, lon=4.1, ts="2026-11-16T10:00:00Z", cs="DLH4AB"):
    return {"data": [{"fr24_id": "391fdd79", "hex": hex_, "callsign": cs, "lat": lat, "lon": lon, "track": 90,
                      "alt": 36000, "gspeed": 450, "vspeed": 0, "squawk": "1000", "timestamp": ts, "source": source}]}


def make_fr24(session, token="test-token", cap=900, tmp_path=None, clock=None):
    clock = clock or FakeClock(1_794_823_200.0)  # 2026-11-16 10:00:00 UTC
    airports = Airports(session, tmp_path or Path("/nonexistent"), clock)
    airports._set(APT, {})
    airports.airports_at = clock()
    state = (tmp_path / "fr24.json") if tmp_path else None
    return Fr24(token, cap, session, airports, state, clock), clock


# ---- without a key: nothing changes -----------------------------------------------------------------------------
def test_without_token_everything_works_without_fr24(cfg):
    session = FakeSession({"api.adsb.lol": FakeResp(readsb_payload(NOW, [AC])),
                           "adsbdb.com/v0/aircraft": FakeResp({}, 404), "adsbdb.com/v0/callsign": FakeResp(ADSBDB_ROUTE),
                           "planespotters": FakeResp({}, 404)})
    client = create_app(cfg, session, start_feeds=False).test_client()
    seed(client, hex="3c6444", lat=48.2, lon=4.0, cs="DLH4AB", ts=NOW - 100)
    assert client.get("/api/status").get_json()["fr24"] == {"state": "disabled"}
    d = {}
    deadline = time.time() + 5
    while time.time() < deadline and not d.get("route"):
        d = client.get("/api/aircraft/3c6444").get_json()
        time.sleep(0.05)
    assert d["route"]["source"] == "adsbdb"
    assert d["fr24"] is None
    assert d["full_track"] == {"available": False, "cost": 40, "reason": "disabled"}
    r = client.get("/api/aircraft/3c6444/full-track")
    assert r.status_code == 503 and r.get_json()["reason"] == "disabled"
    assert session.count("fr24api") == 0  # never touched the network, no error either


def test_fr24_object_without_token_is_inert():
    session = FakeSession({})
    fr, _ = make_fr24(session, token="")
    assert not fr.enabled and fr.status() == {"state": "disabled"} and fr.budget() is None and not fr.usable()
    with pytest.raises(Exception) as e:
        fr.route("DLH4AB")
    assert getattr(e.value, "reason", None) == "disabled"
    assert fr.position("3c6444", "DLH4AB", None) is None and session.calls == []


# ---- route ------------------------------------------------------------------------------------------------------------
def test_route_request_shape_source_cache_and_credit_counter(tmp_path):
    session = FakeSession({"flight-summary/light": FakeResp(summary())})
    fr, clock = make_fr24(session, tmp_path=tmp_path)
    r = fr.route("dlh4ab", "3c6444")
    assert r["source"] == "fr24" and r["fr24_id"] == "391fdd79" and r["callsign"] == "DLH4AB"
    assert r["origin"]["icao"] == "LFPG" and r["origin"]["lat"] == 49.0097 and r["destination"]["iata"] == "MUC"
    method, url, kw = session.calls[0]
    assert url == "https://fr24api.flightradar24.com/api/flight-summary/light"
    assert kw["headers"]["Authorization"] == "Bearer test-token" and kw["headers"]["Accept-Version"] == "v1"
    p = kw["params"]
    assert p["callsigns"] == "DLH4AB" and p["flight_datetime_from"] == "2026-11-15T10:00:00Z"
    assert p["flight_datetime_to"] == "2026-11-16T11:00:00Z"
    assert fr.route("DLH4AB", "3c6444") == r and len(session.calls) == 1  # cached 6 h
    st = fr.status()
    assert st == {"state": "ok", "credits_used": 1, "credits_daily": 900, "credits_remaining": 899,
                  "last_ok": clock(), "last_error": None}
    assert json.loads((tmp_path / "fr24.json").read_text()) == {"day": "2026-11-16", "used": 1}
    fr2, _ = make_fr24(session, tmp_path=tmp_path, clock=clock)  # restart: the counter survives
    assert fr2.remaining == 899
    clock.advance(86400)  # next UTC day
    assert fr2.remaining == 900


def test_route_ignores_ended_flights_and_other_airframes():
    session = FakeSession({"flight-summary/light": [FakeResp(summary(ended=True)),
                                                    FakeResp(summary(hex_="AAAAAA", cs="DLH9ZZ"))]})
    fr, _ = make_fr24(session)
    assert fr.route("DLH4AB") is None  # only a finished flight
    assert fr.route("DLH9ZZ", hex_="3c6444") is None  # live but flown by another hex


def test_selected_route_prefers_fr24_then_falls_back_to_adsbdb(cfg):
    session = FakeSession({
        "api.adsb.lol": FakeResp(readsb_payload(NOW, [AC])), "adsbdb.com/v0/aircraft": FakeResp({}, 404),
        "planespotters": FakeResp({}, 404), "adsbdb.com/v0/callsign": FakeResp(ADSBDB_ROUTE),
        "flight-summary/light": FakeResp(summary(cs="DLH4AB"))})
    cfg.fr24_token = "test-token"
    app = create_app(cfg, session, start_feeds=False)
    rt = app.config["RUNTIME"]
    rt.airports._set(APT, {})
    rt.airports.airports_at = time.time()
    client = app.test_client()
    seed(client, hex="3c6444", lat=48.2, lon=4.0, cs="DLH4AB", ts=NOW - 5)
    d = {}
    deadline = time.time() + 5
    while time.time() < deadline and (d.get("route") or {}).get("source") != "fr24":
        d = client.get("/api/aircraft/3c6444").get_json()
        time.sleep(0.05)
    assert d["route"]["source"] == "fr24" and d["route"]["plausible"] is True
    assert d["fr24"]["state"] == "ok" and d["fr24"]["credits_remaining"] == 899 and d["fr24"]["credits_daily"] == 900
    assert d["full_track"] == {"available": True, "cost": 40, "reason": None}
    assert client.get("/api/status").get_json()["fr24"]["credits_used"] == 1
    # an unrelated callsign: FR24 has no live flight -> adsbdb answers
    seed(client, hex="4b187b", lat=48.5, lon=2.5, cs="SWR1LE", ts=NOW - 5)
    session.routes["flight-summary/light"] = FakeResp({"data": []})
    d = {}
    deadline = time.time() + 5
    while time.time() < deadline and not d.get("route"):
        d = client.get("/api/aircraft/4b187b").get_json()
        time.sleep(0.05)
    assert d["route"]["source"] == "adsbdb"
    # background (non-selected) lookups never spend FR24 credits
    before = session.count("fr24api")
    rt.enrich.route("BAW1", selected=False)
    time.sleep(0.2)
    assert session.count("fr24api") == before


# ---- failure modes -----------------------------------------------------------------------------------------------------------
@pytest.mark.parametrize("code", [401, 403])
def test_invalid_key_disables_fr24_until_restart_and_never_raises_elsewhere(code, caplog):
    session = FakeSession({"fr24api": FakeResp({}, code)})
    fr, _ = make_fr24(session)
    for _ in range(3):
        with pytest.raises(Exception) as e:
            fr.route("DLH4AB")
        assert e.value.reason == "auth_error"
    assert len(session.calls) == 1  # one try, then FR24 is off
    assert fr.status()["state"] == "auth_error" and fr.status()["credits_used"] == 0  # failed call not charged
    assert fr.budget()["state"] == "auth_error" and not fr.usable()
    assert fr.full_track_capability() == {"available": False, "cost": 40, "reason": "auth_error"}
    assert sum(1 for r in caplog.records if "rejected the API token" in r.message) == 1  # logged once
    assert "test-token" not in caplog.text and "test-token" not in json.dumps(fr.status())


def test_auth_error_over_the_api_degrades_to_adsbdb(cfg):
    session = FakeSession({"api.adsb.lol": FakeResp(readsb_payload(NOW, [AC])), "adsbdb.com/v0/aircraft": FakeResp({}, 404),
                           "planespotters": FakeResp({}, 404), "adsbdb.com/v0/callsign": FakeResp(ADSBDB_ROUTE),
                           "fr24api": FakeResp({"message": "Unauthenticated"}, 401)})
    cfg.fr24_token = "expired"
    client = create_app(cfg, session, start_feeds=False).test_client()
    seed(client, hex="3c6444", lat=48.2, lon=4.0, cs="DLH4AB", ts=NOW - 100)
    d = {}
    deadline = time.time() + 5
    while time.time() < deadline and not (d.get("route") and d["fr24"]["state"] == "auth_error"):
        d = client.get("/api/aircraft/3c6444").get_json()
        time.sleep(0.05)
    assert d["route"]["source"] == "adsbdb" and d["fr24"]["state"] == "auth_error"
    assert d["full_track"]["available"] is False and d["full_track"]["reason"] == "auth_error"
    assert client.get("/api/status").get_json()["fr24"]["state"] == "auth_error"
    r = client.get("/api/aircraft/3c6444/full-track")
    assert r.status_code == 503 and r.get_json()["reason"] == "auth_error"
    assert client.get("/api/planes").status_code == 200  # everything else keeps working


def test_daily_budget_is_a_hard_stop():
    session = FakeSession({"flight-summary/light": FakeResp(summary()),
                           "flight-positions/light": FakeResp(position())})
    fr, clock = make_fr24(session, cap=8)
    fr.route("DLH4AB")  # 1
    assert fr.position("3c6444", "DLH4AB", None) is not None  # +6 = 7
    assert fr.status()["credits_remaining"] == 1 and fr.status()["state"] == "ok"
    clock.advance(61)
    n = len(session.calls)
    with pytest.raises(Exception) as e:
        fr.position("3c6444", "DLH4AB", None)  # 7 + 6 > 8: refused before any request
    assert e.value.reason == "budget"
    with pytest.raises(Exception) as e:
        fr.track("3c6444", "DLH4AB")
    assert e.value.reason == "budget" and len(session.calls) == n
    assert fr.full_track_capability()["reason"] == "budget"
    fr.route("OTHER1")  # the last credit can still buy a route
    assert fr.status()["state"] == "exhausted"


def test_http_402_exhausts_the_budget_and_429_cools_down():
    session = FakeSession({"flight-summary/light": [FakeResp({}, 429), FakeResp(summary()), FakeResp({}, 402)]})
    fr, clock = make_fr24(session)
    with pytest.raises(Exception) as e:
        fr.route("DLH4AB")
    assert e.value.reason == "rate" and fr.status()["credits_used"] == 0 and fr.state == "rate_limited"
    with pytest.raises(Exception):
        fr.route("DLH4AB")
    assert len(session.calls) == 1  # cooling down: no hammering
    clock.advance(61)
    assert fr.route("DLH4AB") is not None
    with pytest.raises(Exception) as e:
        fr.route("XXX1")
    assert e.value.reason == "budget" and fr.state == "exhausted"


def test_ten_requests_per_minute_plan_limit_is_respected():
    session = FakeSession({"flight-summary/light": FakeResp({"data": []})})
    fr, clock = make_fr24(session)
    for i in range(9):
        fr.route(f"AAA{i}")
    with pytest.raises(Exception) as e:
        fr.route("AAA99")
    assert e.value.reason == "rate" and len(session.calls) == 9
    clock.advance(61)
    fr.route("AAA99")
    assert len(session.calls) == 10


def test_network_errors_are_refunded_and_never_propagate_as_crashes():
    def boom(url, **kw):
        raise ConnectionError("down")
    session = FakeSession({"fr24api": boom})
    fr, _ = make_fr24(session)
    with pytest.raises(Exception) as e:
        fr.route("DLH4AB")
    assert e.value.reason == "network" and fr.status()["credits_used"] == 0 and fr.state == "ok"


# ---- live position ---------------------------------------------------------------------------------------------------------------
def test_position_is_merged_as_a_real_fr24_fix_with_the_usual_rules():
    session = FakeSession({"flight-positions/light": FakeResp(position(ts="2026-11-16T09:59:50Z"))})
    fr, clock = make_fr24(session)
    ob = fr.position("3c6444", None, "D-AIZB")
    assert session.calls[0][2]["params"] == {"registrations": "D-AIZB"} and fr.status()["credits_used"] == 6
    assert (ob.hex, ob.src, ob.pos_type, ob.alt, ob.gs, ob.vr, ob.sqk) == ("3c6444", "fr24", "adsb_icao", 36000, 450, 0, "1000")
    assert ob.ts == clock() - 10 and not ob.gnd
    assert fr.position("3c6444", "DLH4AB", None) is None and len(session.calls) == 1  # <= once per 60 s per plane
    clock.advance(60)
    fr.position("3c6444", "DLH4AB", None)
    assert session.calls[1][2]["params"] == {"callsigns": "DLH4AB"}


@pytest.mark.parametrize("payload", [position(hex_="AAAAAA"), position(source="ESTIMATED"),
                                     {"data": [{**position()["data"][0], "hex": None}]}, {"data": []},
                                     position(ts="garbage")])
def test_position_rejects_other_airframes_estimates_and_junk(payload):
    session = FakeSession({"flight-positions/light": FakeResp(payload)})
    fr, _ = make_fr24(session)
    assert fr.position("3c6444", "DLH4AB", None) is None


def test_position_goes_through_the_store_sanity_filter_and_wakes_up_an_estimated_plane(cfg):
    session = FakeSession({"api.adsb.lol": FakeResp({}, 500), "api.adsb.fi": FakeResp({}, 500),
                           "adsbdb.com": FakeResp({}, 404), "planespotters": FakeResp({}, 404),
                           "flight-positions/light": FakeResp(position(ts="2026-11-16T09:59:50Z"))})
    cfg.fr24_token = "test-token"
    clock = FakeClock(1_794_823_200.0)
    rt_app = create_app(cfg, session, start_feeds=False, clock=clock)
    rt = rt_app.config["RUNTIME"]
    client = rt_app.test_client()
    t = clock() - 600
    rt.store.apply([Obs(hex="3c6444", ts=t, lat=48.2, lon=3.0, alt=36000, gs=450, trk=90.0, vr=0, src="opensky",
                        cs="DLH4AB")], now=clock())
    # stale (10 min) -> the selected-plane request asks FR24 once
    client.get("/api/aircraft/3c6444")
    deadline = time.time() + 5
    while time.time() < deadline and rt.store.get("3c6444").src != "fr24":
        time.sleep(0.05)
    p = rt.store.get("3c6444")
    assert (p.src, p.lat, p.lon) == ("fr24", 48.21, 4.1) and p.ts == clock() - 10
    client.get("/api/aircraft/3c6444")  # fresh now and within 60 s: no second paid call
    time.sleep(0.2)
    assert session.count("flight-positions/light") == 1
    # an impossible FR24 position (other end of the world) is rejected by the same sanity rules as any source
    clock.advance(120)
    session.routes["flight-positions/light"] = FakeResp(position(lat=-30.0, lon=150.0, ts="2026-11-16T10:01:50Z"))
    rt.fr24_refresh_position("3c6444", "DLH4AB", None)
    assert rt.store.get("3c6444").lat == 48.21


# ---- full track --------------------------------------------------------------------------------------------------------------------
def test_full_track_costs_40_credits_once_and_is_cached_per_flight(cfg):
    tracks = {"fr24_id": "391fdd79", "tracks": [
        {"timestamp": "2026-11-16T09:20:00Z", "lat": 48.9, "lon": 2.7, "alt": 8000, "gspeed": 300, "track": 90},
        {"timestamp": "2026-11-16T09:10:00Z", "lat": 49.0, "lon": 2.55, "alt": 0, "gspeed": 0, "track": 90},
        {"timestamp": "bad", "lat": 1, "lon": 1}]}
    session = FakeSession({"api.adsb.lol": FakeResp(readsb_payload(NOW, [AC])), "adsbdb.com": FakeResp({}, 404),
                           "planespotters": FakeResp({}, 404), "flight-summary/light": FakeResp(summary()),
                           "flight-tracks": FakeResp(tracks)})
    cfg.fr24_token = "test-token"
    app = create_app(cfg, session, start_feeds=False)
    app.config["RUNTIME"].airports._set(APT, {})
    app.config["RUNTIME"].airports.airports_at = time.time()
    client = app.test_client()
    assert client.get("/api/aircraft/zzzzzz/full-track").status_code == 400
    assert client.get("/api/aircraft/abcdef/full-track").status_code == 404
    seed(client, hex="3c6444", lat=48.2, lon=4.0, cs="DLH4AB", ts=NOW - 5)
    r = client.get("/api/aircraft/3c6444/full-track")
    assert r.status_code == 200
    body = r.get_json()
    assert body["fr24_id"] == "391fdd79" and body["cached"] is False
    assert body["points"] == [[49.0, 2.55, 0, 1794820200.0], [48.9, 2.7, 8000, 1794820800.0]]  # sorted, junk dropped
    assert body["fr24"]["credits_remaining"] == 900 - 1 - 40
    call = [c for c in session.calls if "flight-tracks" in c[1]][0]
    assert call[2]["params"] == {"flight_id": "391fdd79"}
    again = client.get("/api/aircraft/3c6444/full-track").get_json()
    assert again["cached"] is True and session.count("flight-tracks") == 1
    assert client.get("/api/status").get_json()["fr24"]["credits_used"] == 41


def test_full_track_without_a_live_fr24_flight_is_404_and_budget_is_429(cfg):
    session = FakeSession({"api.adsb.lol": FakeResp(readsb_payload(NOW, [AC])), "adsbdb.com": FakeResp({}, 404),
                           "planespotters": FakeResp({}, 404), "flight-summary/light": FakeResp({"data": []})})
    cfg.fr24_token, cfg.fr24_daily_credits = "test-token", 30
    client = create_app(cfg, session, start_feeds=False).test_client()
    seed(client, hex="3c6444", lat=48.2, lon=4.0, cs="DLH4AB", ts=NOW - 5)
    r = client.get("/api/aircraft/3c6444/full-track")
    assert r.status_code == 404 and r.get_json()["reason"] == "not_found"
    session.routes["flight-summary/light"] = FakeResp(summary())
    r = client.get("/api/aircraft/3c6444/full-track")
    assert r.status_code == 429 and r.get_json()["reason"] == "budget" and session.count("flight-tracks") == 0
