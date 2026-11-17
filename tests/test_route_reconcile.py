import time

from stratus.enrich import Enricher, observed_departure, reconcile_route
from stratus.util import haversine_nm

CDG = {"icao": "LFPG", "iata": "CDG", "name": "Paris CDG", "city": "Paris", "country": "FR", "lat": 49.0097, "lon": 2.5479, "type": "large"}
LBG = {"icao": "LFPB", "iata": "LBG", "name": "Le Bourget", "city": "Paris", "country": "FR", "lat": 48.9694, "lon": 2.4414, "type": "medium"}
JFK = {"icao": "KJFK", "iata": "JFK", "name": "JFK", "city": "New York", "country": "US", "lat": 40.6398, "lon": -73.7789, "type": "large"}
NCE = {"icao": "LFMN", "iata": "NCE", "name": "Nice", "city": "Nice", "country": "FR", "lat": 43.6584, "lon": 7.2159, "type": "large"}
AIRPORTS = [CDG, LBG, JFK, NCE]


def nearest(lat, lon, nm):
    return [a for a in AIRPORTS if haversine_nm(lat, lon, a["lat"], a["lon"]) <= nm]


def climb_from(apt, alts=(None, 1500, 6000, 15000)):
    return [[apt["lat"] + i * 0.02, apt["lon"] + i * 0.02, a, 1000.0 + i * 30] for i, a in enumerate(alts)]


def route(o, d):
    ap = lambda a: {k: a[k] for k in ("icao", "iata", "name", "city", "country", "lat", "lon")}  # noqa: E731
    return {"callsign": "AFR6", "airline": "Air France", "origin": ap(o), "destination": ap(d), "source": "adsbdb"}


def test_take_off_is_observed_and_large_airport_wins():
    assert observed_departure(climb_from(CDG), nearest)["icao"] == "LFPG"


def test_no_departure_without_a_climb_or_from_cruise():
    assert observed_departure(climb_from(CDG, (None, 800, 1200, 1500)), nearest) is None
    assert observed_departure(climb_from(CDG, (35000, 35000, 36000, 41000)), nearest) is None
    assert observed_departure(climb_from(CDG)[:2], nearest) is None


def test_route_confirmed_by_observed_take_off():
    r = reconcile_route(route(CDG, JFK), CDG, 49.3, 1.0, False)
    assert r["plausible"] and r["observed"] and r["destination"]["icao"] == "KJFK"


def test_other_leg_replaced_by_observed_origin():
    # database says CDG -> JFK, but we saw it leave Nice (another leg of the same flight number)
    r = reconcile_route(route(CDG, JFK), NCE, 44.0, 7.0, False)
    assert r["origin"]["icao"] == "LFMN" and r["destination"] is None and r["source"] == "observed"
    assert r["airline"] == "Air France"


def test_implausible_database_route_is_dropped():
    assert reconcile_route(route(CDG, JFK), None, 10.0, 100.0, False) is None
    assert reconcile_route(route(CDG, JFK), None, 49.3, 1.0, False)["plausible"] is True


def test_wait_returns_once_lookups_finish():
    class SlowSession:
        def get(self, url, timeout=None):
            time.sleep(0.2)

            class R:
                status_code = 404
            return R()

    e = Enricher(SlowSession())
    assert e.photo("abc123") is None  # lookup started
    t0 = time.monotonic()
    assert e.wait("abc123", None, 2.0) is True
    assert time.monotonic() - t0 < 1.0
    assert e.wait("abc123", None, 0.01) is True  # nothing pending: immediate
