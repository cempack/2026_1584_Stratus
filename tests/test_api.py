import gzip
import json
import time

import pytest
from conftest import FakeResp, FakeSession, readsb_payload

from stratus.api import create_app
from stratus.store import FIELDS, Obs

NOW = time.time()
AC = {"hex": "3c6444", "flight": "DLH4AB", "lat": 48.2, "lon": 2.4, "alt_baro": 36000, "gs": 450, "track": 90,
      "seen_pos": 1.0, "t": "A320", "r": "D-AIZB", "category": "A3", "squawk": "1000", "type": "adsb_icao"}
ADSBDB_AIRCRAFT = {"response": {"aircraft": {"type": "A320-214", "icao_type": "A320", "manufacturer": "Airbus",
                                             "registration": "D-AIZB", "registered_owner": "Lufthansa",
                                             "registered_owner_operator_flag_code": "DLH",
                                             "registered_owner_country_name": "Germany"}}}
ADSBDB_ROUTE = {"response": {"flightroute": {"callsign": "DLH4AB", "airline": {"name": "Lufthansa"},
    "origin": {"icao_code": "LFPG", "iata_code": "CDG", "name": "Paris CDG", "municipality": "Paris",
               "country_name": "France", "latitude": 49.0097, "longitude": 2.5479},
    "destination": {"icao_code": "EDDM", "iata_code": "MUC", "name": "Munich", "municipality": "Munich",
                    "country_name": "Germany", "latitude": 48.3538, "longitude": 11.7861}}}}
PHOTO = {"photos": [{"thumbnail": {"src": "https://t/x.jpg"}, "thumbnail_large": {"src": "https://t/x_l.jpg"},
                     "photographer": "Jane", "link": "https://www.planespotters.net/photo/1"}]}
METEO = {"current": {"time": 1800000000, "temperature_250hPa": -54.0, "wind_speed_250hPa": 91.0,
                     "wind_direction_250hPa": 297, "cloud_cover_250hPa": 100}}


@pytest.fixture
def session():
    return FakeSession({
        "api.adsb.lol/v2/point": FakeResp(readsb_payload(NOW, [AC])),
        "api.adsb.lol/v2/hex": FakeResp(readsb_payload(NOW, [AC])),
        "adsbdb.com/v0/aircraft": FakeResp(ADSBDB_AIRCRAFT),
        "adsbdb.com/v0/callsign": FakeResp(ADSBDB_ROUTE),
        "planespotters": FakeResp(PHOTO),
        "open-meteo": FakeResp(METEO),
    })


@pytest.fixture
def atc_dir(cfg):
    d = cfg.atc_dir / "EHAM"
    d.mkdir(parents=True)
    (d / "airport.json").write_text(json.dumps({"icao": "EHAM", "name": "Schiphol", "city": "Amsterdam",
                                                "country": "NL", "lat": 52.3, "lng": 4.76,
                                                "order": ["eham_twr.pls"]}))
    (d / "eham_twr.pls").write_text("[playlist]\nFile1=https://d.liveatc.net/eham_twr\nTitle1=EHAM Tower\n")


@pytest.fixture
def client(cfg, session, atc_dir):
    app = create_app(cfg, session, start_feeds=False)
    return app.test_client()


def seed(client_or_app, **kw):
    rt = client_or_app.application.config["RUNTIME"]
    base = dict(hex="4b187b", ts=NOW - 5, lat=48.5, lon=2.5, alt=34000, gs=400, trk=280.0, vr=0, src="opensky",
                cs="SWR1LE")
    rt.store.apply([Obs(**{**base, **kw})])
    return rt


def test_planes_snapshot_shape_gzip_and_etag(client):
    seed(client)
    r = client.get("/api/planes", headers={"Accept-Encoding": "gzip"})
    assert r.status_code == 200 and r.headers["Content-Encoding"] == "gzip"
    assert r.headers["Cache-Control"] == "no-store"
    body = json.loads(gzip.decompress(r.data))
    assert body["fields"] == FIELDS and len(body["rows"]) == 1 and len(body["rows"][0]) == len(FIELDS)
    assert isinstance(body["v"], int) and isinstance(body["t"], float)
    etag = r.headers["ETag"]
    again = client.get("/api/planes", headers={"If-None-Match": etag})
    assert again.status_code == 304 and again.data == b"" and again.headers["ETag"] == etag
    seed(client, hex="aaaaaa", lat=10.0)  # store changed -> new body
    assert client.get("/api/planes", headers={"If-None-Match": etag}).status_code == 200
    plain = client.get("/api/planes")
    assert "Content-Encoding" not in plain.headers and len(plain.get_json()["rows"]) == 2


def test_area_refreshes_from_adsb_lol_and_filters_circle(client, session):
    seed(client)
    seed(client, hex="aaaaaa", lat=10.0, lon=100.0)
    r = client.get("/api/planes/area?lat=48.85&lon=2.35&r=100")
    assert r.status_code == 200
    body = r.get_json()
    assert body["fields"] == FIELDS
    rows = {row[0]: row for row in body["rows"]}
    assert set(rows) == {"3c6444", "4b187b"}  # the one seeded in Asia is outside the circle
    assert rows["3c6444"][10] == "adsb.lol"
    assert session.count("api.adsb.lol/v2/point") == 1


def test_area_validates_and_clamps(client, session):
    assert client.get("/api/planes/area?lat=x&lon=2").status_code == 400
    assert client.get("/api/planes/area?lat=91&lon=2").status_code == 400
    assert client.get("/api/planes/area?lat=48&lon=2&r=9999").status_code == 200
    assert session.calls[0][1].endswith("/250")


def test_aircraft_detail_fills_in_background(client):
    assert client.get("/api/aircraft/zzzzzz").status_code == 400
    assert client.get("/api/aircraft/abcdef").status_code == 404  # unknown to the store and to adsb.lol
    rt = seed(client, hex="3c6444", lat=48.2, lon=4.0, cs="DLH4AB", ts=NOW - 30)
    d = client.get("/api/aircraft/3c6444").get_json()
    assert set(d) == {"plane", "trail", "aircraft", "route", "photo", "estimated_since", "fr24", "full_track"}
    assert d["plane"]["src"] == "adsb.lol" and d["plane"]["pos_type"] == "adsb_icao"
    assert d["trail"] and len(d["trail"][0]) == 4
    deadline = time.time() + 5
    while time.time() < deadline:
        d = client.get("/api/aircraft/3c6444").get_json()
        if d["aircraft"] and d["route"] and d["photo"]:
            break
        time.sleep(0.05)
    assert d["aircraft"]["registration"] == "D-AIZB" and d["aircraft"]["operator"] == "Lufthansa"
    assert d["route"]["origin"]["icao"] == "LFPG" and d["route"]["plausible"] is True
    assert d["photo"]["photographer"] == "Jane"
    assert rt.store.get("3c6444")


def test_status_shape(client):
    seed(client)
    s = client.get("/api/status").get_json()
    assert s["planes"] == 1 and isinstance(s["v"], int)
    assert set(s["feeds"]) == {"opensky", "adsb.lol", "adsb.fi"}
    for key in ("state", "mode", "last_ok", "next_poll", "interval", "credits_remaining", "credits_daily",
                "last_error"):
        assert key in s["feeds"]["opensky"]
    assert s["feeds"]["opensky"]["mode"] == "anonymous" and s["feeds"]["opensky"]["credits_daily"] == 400
    assert set(s["feeds"]["adsb.lol"]) == {"state", "last_ok", "last_error", "interval_s"}


def test_weather_picks_level_and_caches(client, session):
    r = client.get("/api/weather?lat=48.85&lon=2.35&alt=36000")
    assert r.get_json() == {"temp_c": -54.0, "wind_kt": 91.0, "wind_dir": 297.0, "cloud_pct": 100.0,
                            "level": "250hPa", "time": 1800000000.0}
    client.get("/api/weather?lat=48.86&lon=2.36&alt=36000")
    assert session.count("open-meteo") == 1
    assert client.get("/api/weather?lat=48.85").status_code == 400


def test_atc_airports(client):
    d = client.get("/api/atc/airports").get_json()
    assert d == {"airports": [{"icao": "EHAM", "name": "Schiphol", "city": "Amsterdam", "country": "NL",
                               "lat": 52.3, "lon": 4.76, "feeds": [{"id": "eham_twr", "label": "EHAM Tower"}]}]}
    assert client.get("/api/atc/audio?icao=ZZZZ").status_code == 404


def test_unknown_api_is_json_404_and_static_fallback(client, cfg):
    assert client.get("/api/nope").status_code == 404
    assert b"Frontend not built" in client.get("/").data  # no web/dist yet
    (cfg.web_dist / "assets").mkdir(parents=True)
    (cfg.web_dist / "index.html").write_text("<html>app</html>")
    (cfg.web_dist / "assets" / "index-AbCd1234.js").write_text("1")
    assert client.get("/flight/3c6444").data == b"<html>app</html>"
    js = client.get("/assets/index-AbCd1234.js")
    assert js.headers["Cache-Control"] == "public, max-age=31536000, immutable"
    assert client.get("/assets/missing.js").status_code == 404


def test_create_app_starts_feeds_once(cfg, session, monkeypatch):
    started = []
    monkeypatch.setattr("stratus.api.threading.Thread.start", lambda self: started.append(self.name))
    app = create_app(cfg, session)
    app.config["RUNTIME"].start()
    app.config["RUNTIME"].start()
    assert sorted(started) == ["airports", "housekeeping", "opensky", "routes", "sweep"]
