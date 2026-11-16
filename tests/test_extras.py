"""METAR, winds aloft, airport catalog / board, emergencies. Offline: every HTTP call is scripted."""

import time

import pytest
from conftest import FakeClock, FakeResp, FakeSession

from stratus.airports import Airports, parse_airports, parse_runways
from stratus.api import create_app
from stratus.metar import decode, flight_category, parse_visibility_sm
from stratus.store import Obs
from stratus.util import bearing_deg, destination_point
from stratus.winds import plan_grid, to_uv

NOW = time.time()

AIRPORTS_CSV = """id,ident,type,name,latitude_deg,longitude_deg,elevation_ft,continent,iso_country,iso_region,municipality,scheduled_service,icao_code,iata_code,gps_code,local_code,home_link,wikipedia_link,keywords
1,LFPG,large_airport,Paris Charles de Gaulle Airport,49.0097,2.5479,392,EU,FR,FR-J,Paris,yes,LFPG,CDG,LFPG,,,,
2,EDDM,large_airport,Munich Airport,48.3538,11.7861,1487,EU,DE,DE-BY,Munich,yes,EDDM,MUC,EDDM,,,,
3,LFPB,medium_airport,Paris Le Bourget,48.9694,2.4414,218,EU,FR,FR-J,Paris,no,LFPB,LBG,LFPB,,,,
4,LFXX,small_airport,Tiny strip,48.0,2.0,100,EU,FR,FR-J,Nowhere,no,,,LFXX,,,,
5,LFSM,small_airport,Small with service,47.0,2.0,100,EU,FR,FR-J,Town,yes,,SMX,LFSM,,,,
6,00AA,small_airport,US small,30,-90,10,NA,US,US-LA,Town,no,,,,00AA,,,
7,LFHX,heliport,Heli,48,2,10,EU,FR,FR-J,Paris,no,,,,,,,
8,NZAA,large_airport,Auckland,-37.0081,174.792,23,OC,NZ,NZ-AUK,Auckland,yes,NZAA,AKL,NZAA,,,,
"""
RUNWAYS_CSV = """id,airport_ref,airport_ident,length_ft,width_ft,surface,lighted,closed,le_ident,le_latitude_deg,le_longitude_deg,le_elevation_ft,le_heading_degT,le_displaced_threshold_ft,he_ident,he_latitude_deg,he_longitude_deg,he_elevation_ft,he_heading_degT,he_displaced_threshold_ft
1,1,LFPG,8858,148,ASP,1,0,08R,49.0,2.5,,85.0,,26L,49.01,2.6,,265.0,
2,1,LFPG,13829,148,ASP,1,0,08L,49.02,2.5,,85.0,,26R,49.03,2.6,,265.0,
3,1,LFPG,5000,100,GRS,0,1,09,49.0,2.5,,90.0,,27,49.0,2.6,,270.0,
4,2,EDDM,13123,197,CON,1,0,08L,48.35,11.7,,82.0,,26R,48.36,11.8,,262.0,
"""
METAR_LFPG = {"icaoId": "LFPG", "obsTime": 1794820000, "temp": 9.0, "dewp": 7.0, "wdir": 240, "wspd": 12, "wgst": 22,
              "visib": "6+", "altim": 1012.0, "rawOb": "METAR LFPG 160900Z 24012G22KT 9999 FEW015 BKN025 09/07 Q1012",
              "lat": 49.01, "lon": 2.55, "name": "Paris/Charles de Gaulle", "fltCat": "MVFR",
              "clouds": [{"cover": "FEW", "base": 1500}, {"cover": "BKN", "base": 2500}]}
METAR_EDDM = {"icaoId": "EDDM", "obsTime": 1794820000, "temp": 3.0, "dewp": 2.5, "wdir": "VRB", "wspd": 3, "wgst": None,
              "visib": "1/2", "altim": 29.92, "rawOb": "METAR EDDM ...", "lat": 48.35, "lon": 11.79, "name": "Munich",
              "wxString": "FG", "vertVis": 2, "clouds": [{"cover": "OVX", "base": None}]}


def make_session(**extra):
    routes = {"ourairports-data/airports.csv": FakeResp(text=AIRPORTS_CSV),
              "ourairports-data/runways.csv": FakeResp(text=RUNWAYS_CSV),
              "adsbdb.com": FakeResp({}, 404), "planespotters": FakeResp({}, 404), "api.adsb.lol": FakeResp({}, 500),
              "api.adsb.fi": FakeResp({}, 500), "opendata.adsb.fi": FakeResp({}, 500),
              "aviationweather": FakeResp([METAR_LFPG, METAR_EDDM])}
    routes.update(extra)
    return FakeSession(routes)


@pytest.fixture
def client(cfg):
    return create_app(cfg, make_session(), start_feeds=False).test_client()


def seed(client, **kw):
    rt = client.application.config["RUNTIME"]
    base = dict(hex="4b187b", ts=NOW - 5, lat=48.5, lon=2.5, alt=34000, gs=400, trk=280.0, vr=0, src="opensky",
                cs="SWR1LE")
    rt.store.apply([Obs(**{**base, **kw})])
    return rt


# ---- airports catalog ---------------------------------------------------------------------------------------
def test_parse_airports_keeps_large_medium_and_scheduled_small_only():
    airports = {a["icao"]: a for a in parse_airports(AIRPORTS_CSV)}
    assert set(airports) == {"LFPG", "EDDM", "LFPB", "LFSM", "NZAA"} or set(airports) == {"LFPG", "EDDM", "LFPB", "NZAA"}
    assert airports["LFPG"] == {"icao": "LFPG", "iata": "CDG", "name": "Paris Charles de Gaulle Airport",
                                "city": "Paris", "country": "FR", "lat": 49.0097, "lon": 2.5479, "elev_ft": 392,
                                "type": "large"}
    assert "LFXX" not in airports and "00AA" not in airports and "LFHX" not in airports  # strips, no ICAO, heliports


def test_runways_sorted_longest_first_and_closed_ones_dropped():
    r = parse_runways(RUNWAYS_CSV, {"LFPG", "EDDM"})
    assert [x["le_ident"] for x in r["LFPG"]] == ["08L", "08R"] and r["LFPG"][0]["length_ft"] == 13829
    assert r["LFPG"][0]["he_heading"] == 265.0 and r["LFPG"][0]["lighted"] is True and "EDDM" in r


def test_catalog_is_cached_daily_on_disk_and_survives_being_offline(tmp_path):
    clock = FakeClock(NOW)
    session = make_session()
    a = Airports(session, tmp_path, clock)
    assert a.get("cdg")["icao"] == "LFPG" and a.get("EDDM")["iata"] == "MUC" and a.get("zzzz") is None
    assert session.count("airports.csv") == 1
    a.get("LFPG")
    assert session.count("airports.csv") == 1  # cached in memory
    assert [r["le_ident"] for r in a.runways("LFPG")] == ["08L", "08R"] and session.count("runways.csv") == 1
    b = Airports(FakeSession({}), tmp_path, clock)  # restart without network: disk cache
    assert b.get("LFPG")["name"].startswith("Paris") and b.runways("LFPG")
    clock.advance(25 * 3600)  # stale + offline: keep serving the old data, retry later
    offline = FakeSession({"ourairports": FakeResp({}, 500)})
    c = Airports(offline, tmp_path, clock)
    assert c.get("LFPG") and offline.count("airports.csv") == 1
    c.get("LFPG")
    assert offline.count("airports.csv") == 1  # backs off instead of hammering
    fresh = Airports(make_session(), tmp_path, clock)  # online again: refreshed
    fresh.get("LFPG")
    assert fresh.airports_at == clock()


def test_airports_search_and_map_endpoint(client):
    d = client.get("/api/airports?q=cdg").get_json()
    assert [a["icao"] for a in d["airports"]] == ["LFPG"] and d["airports"][0]["iata"] == "CDG"
    assert [a["icao"] for a in client.get("/api/airports?q=lfp").get_json()["airports"]] == ["LFPG", "LFPB"]
    assert [a["icao"] for a in client.get("/api/airports?q=Paris").get_json()["airports"]] == ["LFPG", "LFPB"]
    assert [a["icao"] for a in client.get("/api/airports?q=paris&type=large").get_json()["airports"]] == ["LFPG"]
    assert client.get("/api/airports?q=Town").get_json()["airports"] == []  # small airports are not searchable
    assert client.get("/api/airports?q=zzzz").get_json() == {"count": 0, "airports": []}
    box = client.get("/api/airports?bbox=45,0,52,15").get_json()
    assert [a["icao"] for a in box["airports"]] == ["EDDM", "LFPG", "LFPB"]  # large first
    assert [a["icao"] for a in client.get("/api/airports?bbox=45,0,52,15&limit=1").get_json()["airports"]] == ["EDDM"]
    wrap = client.get("/api/airports?bbox=-45,170,-30,-170").get_json()  # crosses the antimeridian
    assert [a["icao"] for a in wrap["airports"]] == ["NZAA"]
    default = client.get("/api/airports").get_json()
    assert {a["icao"] for a in default["airports"]} == {"LFPG", "EDDM", "NZAA"}


def test_airports_503_while_the_catalog_cannot_be_loaded(cfg):
    session = make_session(**{"ourairports-data/airports.csv": FakeResp({}, 500)})
    c = create_app(cfg, session, start_feeds=False).test_client()
    assert c.get("/api/airports?q=cdg").status_code == 503 and c.get("/api/airport/LFPG").status_code == 503


# ---- METAR --------------------------------------------------------------------------------------------------------------
def test_flight_categories_at_the_boundaries():
    assert flight_category(10, None) == "VFR" and flight_category(6, 5000) == "VFR"
    assert flight_category(5, 9000) == "MVFR" and flight_category(10, 3000) == "MVFR"
    assert flight_category(2.9, 9000) == "IFR" and flight_category(10, 999) == "IFR" and flight_category(3, 1000) == "MVFR"
    assert flight_category(0.9, 9000) == "LIFR" and flight_category(10, 499) == "LIFR" and flight_category(1, 500) == "IFR"
    assert flight_category(None, None) is None


def test_visibility_parsing():
    assert [parse_visibility_sm(v) for v in ("10+", "1/2", "1 1/2", 7, None, "x")] == [10.0, 0.5, 1.5, 7.0, None, None]


def test_metar_decoding():
    m = decode(METAR_LFPG)
    assert m["icao"] == "LFPG" and m["wind_dir"] == 240 and m["wind_kt"] == 12 and m["gust_kt"] == 22
    assert m["vis_sm"] == 6.0 and m["vis_km"] == 9.7 and m["ceiling_ft"] == 2500
    assert (m["temp_c"], m["dew_c"], m["qnh_hpa"]) == (9.0, 7.0, 1012.0) and m["flight_category"] == "MVFR"
    assert m["clouds"][0] == {"cover": "FEW", "base_ft": 1500} and m["raw"].startswith("METAR LFPG")
    assert m["time"] == 1794820000
    v = decode(METAR_EDDM)  # variable wind, inHg, vertical visibility 200 ft, no fltCat given
    assert v["wind_dir"] is None and v["wind_variable"] is True and v["qnh_hpa"] == 1013.2
    assert v["ceiling_ft"] == 200 and v["vis_sm"] == 0.5 and v["flight_category"] == "LIFR" and v["weather"] == "FG"


def test_metar_endpoint_single_cached_and_errors(cfg):
    session = make_session()
    c = create_app(cfg, session, start_feeds=False).test_client()
    d = c.get("/api/metar?icao=lfpg").get_json()
    assert d["metar"]["icao"] == "LFPG" and d["metar"]["flight_category"] == "MVFR"
    c.get("/api/metar?icao=LFPG")
    assert session.count("aviationweather") == 1  # cached 10 min
    call = [x for x in session.calls if "aviationweather" in x[1]][0]
    assert call[2]["params"] == {"ids": "LFPG", "format": "json"}
    assert c.get("/api/metar").status_code == 400 and c.get("/api/metar?icao=TOOLONG").status_code == 400
    session.routes["aviationweather"] = FakeResp(None, 204)  # no report for this station
    assert c.get("/api/metar?icao=ZZZZ").status_code == 404
    session.routes["aviationweather"] = FakeResp({}, 500)
    assert c.get("/api/metar?icao=YYYY").status_code == 404  # upstream down: no crash, short negative cache


def test_metar_bbox_returns_large_airports_in_view_with_a_cap(cfg):
    session = make_session()
    c = create_app(cfg, session, start_feeds=False).test_client()
    d = c.get("/api/metar?bbox=40,-5,55,15").get_json()
    assert d["count"] == 2 and {s["icao"] for s in d["stations"]} == {"LFPG", "EDDM"}  # LFPB is only medium
    assert [x for x in session.calls if "aviationweather" in x[1]][0][2]["params"]["ids"] == "EDDM,LFPG"
    assert c.get("/api/metar?bbox=40,-5,55,15&limit=1").get_json()["count"] == 1
    assert c.get("/api/metar?bbox=1,2,3").status_code == 400 and c.get("/api/metar?bbox=50,0,40,10").status_code == 400
    assert c.get("/api/metar?bbox=-60,100,-50,110").get_json() == {"t": pytest.approx(time.time(), abs=5), "count": 0,
                                                                    "stations": []}


# ---- winds --------------------------------------------------------------------------------------------------------------
def meteo(url, **kw):
    n = len(str(kw["params"]["latitude"]).split(","))
    cur = {"time": 1794820000, "wind_speed_250hPa": 100.0, "wind_direction_250hPa": 270.0}
    items = [{"latitude": 0, "longitude": 0, "current": cur} for _ in range(n)]
    return FakeResp(items if n > 1 else items[0])


def test_grid_planning_respects_the_point_cap_and_alignment():
    for bbox in [(40, -10, 55, 20), (-60, -180, 80, 180), (0, 170, 20, -170), (48.8, 2.2, 48.9, 2.4), (-90, -180, 90, 180)]:
        step, lats, lons = plan_grid(*bbox)
        assert len(lons) <= 15 and len(lats) <= 10, bbox
        assert lats == sorted(lats, reverse=True) and all(-90 <= la <= 90 for la in lats)
        assert all(-180 <= lo < 180 for lo in lons)
    step, lats, lons = plan_grid(40, -10, 55, 20)
    assert lons[0] <= -10 and lons[-1] >= 20 - 1e-6 and lats[0] >= 55 and lats[-1] <= 40
    _, _, lons = plan_grid(0, 170, 20, -170)
    assert lons[0] <= 170 and lons[-1] >= -170 + 0 and any(lo > 170 for lo in lons) and any(lo < -170 for lo in lons)


def test_wind_components_follow_the_meteorological_convention():
    assert to_uv(100, 270) == (100.0, pytest.approx(0, abs=1e-6))  # from the west -> blowing east
    assert to_uv(50, 180)[1] == 50.0 and to_uv(50, 0)[1] == -50.0  # from the south -> northward
    assert to_uv(None, 10) == (None, None)


def test_winds_endpoint_batches_caches_and_validates(cfg):
    session = make_session(**{"api.open-meteo.com": meteo})
    c = create_app(cfg, session, start_feeds=False).test_client()
    d = c.get("/api/winds?bbox=40,-10,55,20&level=250").get_json()
    assert d["level"] == 250 and d["nx"] <= 15 and d["ny"] <= 10 and len(d["u"]) == d["nx"] * d["ny"] == len(d["v"])
    assert d["u"][0] == 100.0 and d["v"][0] == pytest.approx(0, abs=1e-6) and d["unit"] == "kt"
    assert len(d["lats"]) == d["ny"] and len(d["lons"]) == d["nx"] and d["lat0"] == d["lats"][0]
    assert session.count("open-meteo") == 1  # one batched request for the whole grid
    p = session.calls[-1][2]["params"]
    assert len(p["latitude"].split(",")) == d["nx"] * d["ny"] and p["current"] == "wind_speed_250hPa,wind_direction_250hPa"
    assert p["wind_speed_unit"] == "kn"
    c.get("/api/winds?bbox=40,-10,55,20&level=250")
    assert session.count("open-meteo") == 1  # cached 30 min per cell
    c.get("/api/winds?bbox=40,-10,55,20&level=300")
    assert session.count("open-meteo") == 2  # other level, other cells
    assert c.get("/api/winds?bbox=40,-10,55,20&level=999").status_code == 400
    assert c.get("/api/winds?level=250").status_code == 400
    assert c.get("/api/winds?bbox=40,-10,55,20&level=surface").status_code == 200
    assert "wind_speed_10m" in session.calls[-1][2]["params"]["current"]


def test_winds_degrades_to_nulls_or_502(cfg):
    session = make_session(**{"api.open-meteo.com": FakeResp({}, 500)})
    c = create_app(cfg, session, start_feeds=False).test_client()
    assert c.get("/api/winds?bbox=40,-10,55,20").status_code == 502


# ---- emergencies ------------------------------------------------------------------------------------------------------------
def test_alerts_list_fresh_emergency_squawks_only_worst_first(client):
    seed(client, hex="aaaaaa", cs="AAA1", sqk="7700", ts=NOW - 30)
    seed(client, hex="bbbbbb", cs="BBB1", sqk="7600", ts=NOW - 20)
    seed(client, hex="cccccc", cs="CCC1", sqk="7500", ts=NOW - 100)
    seed(client, hex="dddddd", cs="DDD1", sqk="1200", ts=NOW - 5)
    seed(client, hex="eeeeee", cs="EEE1", sqk="7700", ts=NOW - 700)  # last seen long ago: not an alert any more
    d = client.get("/api/alerts").get_json()
    assert d["count"] == 3
    assert [(a["hex"], a["squawk"], a["kind"]) for a in d["alerts"]] == [
        ("cccccc", "7500", "hijack"), ("aaaaaa", "7700", "emergency"), ("bbbbbb", "7600", "radio_failure")]
    a = d["alerts"][1]
    assert {"hex", "cs", "squawk", "kind", "lat", "lon", "alt", "gs", "trk", "vr", "gnd", "ts", "src", "type", "reg"} <= set(a)
    s = client.get("/api/status").get_json()
    assert s["alerts"] == 3 and s["estimated"] == 0 and s["sweep"]["circles"] >= 100
    assert s["sweep"]["state"] in ("running", "idle") and s["fr24"] == {"state": "disabled"}


# ---- airport board ----------------------------------------------------------------------------------------------------------
def route(cs, o, d):
    ap = {"LFPG": ("CDG", 49.0097, 2.5479), "EDDM": ("MUC", 48.3538, 11.7861), "EGLL": ("LHR", 51.4706, -0.4619)}
    mk = lambda i: {"icao": i, "iata": ap[i][0], "name": i, "city": i, "country": "X", "lat": ap[i][1], "lon": ap[i][2]}
    return {"callsign": cs, "airline": None, "origin": mk(o), "destination": mk(d), "source": "adsbdb"}


def test_airport_board_arrivals_departures_profile_and_metar(client):
    rt = client.application.config["RUNTIME"]
    cdg = (49.0097, 2.5479)
    brg_muc = bearing_deg(*cdg, 48.3538, 11.7861)
    brg_lhr = bearing_deg(*cdg, 51.4706, -0.4619)
    on_leg = destination_point(*cdg, brg_muc, 30.0)          # 30 NM east of CDG on the MUC-CDG line
    behind = destination_point(*cdg, brg_lhr, 38.0)          # 38 NM towards London
    rt.enrich.cache.set(("route", "AFR1"), route("AFR1", "EDDM", "LFPG"), 3600)
    rt.enrich.cache.set(("route", "AFR2"), route("AFR2", "LFPG", "EDDM"), 3600)
    rt.enrich.cache.set(("route", "AFR3"), route("AFR3", "LFPG", "EDDM"), 3600)
    rt.enrich.cache.set(("route", "AFR4"), route("AFR4", "EDDM", "EGLL"), 3600)
    seed(client, hex="a00001", cs="AFR1", lat=on_leg[0], lon=on_leg[1], alt=6000, gs=250, trk=(brg_muc + 180) % 360,
         vr=-1200)                                           # route says CDG -> arrival, ETA 30/250 h
    seed(client, hex="a00002", cs="ZZZ1", lat=behind[0], lon=behind[1], alt=3500, gs=180,
         trk=(brg_lhr + 180) % 360, vr=-700)                  # no route, low + descending towards CDG -> profile
    seed(client, hex="a00003", cs="AFR2", lat=destination_point(*cdg, brg_muc, 12.0)[0],
         lon=destination_point(*cdg, brg_muc, 12.0)[1], alt=5000, gs=260, trk=brg_muc, vr=2200)  # from CDG
    seed(client, hex="a00004", cs="AFR3", lat=49.0, lon=2.56, alt=None, gs=0, trk=90.0, vr=0, gnd=True)  # at the gate
    seed(client, hex="a00005", cs="AFR4", lat=on_leg[0], lon=on_leg[1] + 0.1, alt=5000, gs=250, trk=250.0,
         vr=-900)                                            # confirmed EDDM->EGLL?? not on that line: route implausible
    seed(client, hex="a00006", cs="OVR1", lat=49.2, lon=2.7, alt=36000, gs=470, trk=90.0, vr=0)  # overflight
    seed(client, hex="a00007", cs="FAR1", lat=10.0, lon=100.0, alt=3000, gs=200, trk=90.0, vr=-900)  # far away
    d = client.get("/api/airport/cdg").get_json()
    apt = d["airport"]
    assert apt["icao"] == "LFPG" and apt["iata"] == "CDG" and apt["city"] == "Paris" and apt["lat"] == 49.0097
    assert [r["le_ident"] for r in apt["runways"]] == ["08L", "08R"] and apt["runways"][0]["length_ft"] == 13829
    arr = {e["hex"]: e for e in d["arrivals"]}
    dep = {e["hex"]: e for e in d["departures"]}
    assert set(arr) == {"a00001", "a00002"} and set(dep) == {"a00003", "a00004"}
    a1 = arr["a00001"]
    assert a1["basis"] == "route" and a1["dist_nm"] == pytest.approx(30.0, abs=0.5)
    assert a1["eta_s"] == pytest.approx(30 / 250 * 3600, abs=10) and a1["eta_ts"] == pytest.approx(d["t"] + a1["eta_s"], abs=1)
    assert a1["origin"]["icao"] == "EDDM" and a1["phase"] == "approach" and a1["est"] is False
    assert arr["a00002"]["basis"] == "profile" and arr["a00002"]["origin"] is None and arr["a00002"]["eta_s"] > 0
    assert d["arrivals"][0]["hex"] == "a00001"  # sorted by ETA
    assert dep["a00003"]["basis"] == "route" and dep["a00003"]["phase"] == "climbing" and dep["a00003"]["destination"]["icao"] == "EDDM"
    assert dep["a00004"]["phase"] == "ground" and d["departures"][0]["hex"] == "a00004"
    assert d["metar"]["icao"] == "LFPG" and d["metar"]["wind_kt"] == 12


def test_airport_board_errors_and_empty_board(client):
    assert client.get("/api/airport/ab").status_code == 400
    assert client.get("/api/airport/ZZZZ").status_code == 404
    d = client.get("/api/airport/EDDM").get_json()
    assert d["arrivals"] == [] and d["departures"] == [] and d["airport"]["name"] == "Munich Airport"
    assert d["metar"]["flight_category"] == "LIFR"
