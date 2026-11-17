import requests
from conftest import FakeResp, FakeSession, readsb_payload

from stratus.feeds.readsb import Provider, ReadsbFeed, parse_readsb
from stratus.store import Store

NOW = 1_800_000_000.0

AC = {"hex": "3C6444", "flight": "DLH4AB  ", "lat": 48.12345678, "lon": 11.5, "alt_baro": 36000, "alt_geom": 36300,
      "gs": 452.3, "track": 271.54, "baro_rate": -64, "seen_pos": 2.5, "t": "A320", "r": "D-AIZB", "category": "A3",
      "squawk": "1000", "type": "adsb_icao"}


def test_parse_readsb_fields_and_position_time():
    o = parse_readsb(readsb_payload(NOW, [AC]), "adsb.lol")[0]
    assert (o.hex, o.cs, o.alt, o.gs, o.vr, o.gnd) == ("3c6444", "DLH4AB", 36000, 452, -64, False)
    assert o.ts == NOW - 2.5  # position time = now - seen_pos
    assert (o.type, o.reg, o.cat, o.sqk, o.pos_type, o.src) == ("A320", "D-AIZB", "A3", "1000", "adsb_icao", "adsb.lol")


def test_parse_readsb_ground_geom_fallback_and_junk():
    ground = {**AC, "hex": "aaaaaa", "alt_baro": "ground"}
    geom = {**AC, "hex": "bbbbbb", "alt_baro": None, "baro_rate": None, "geom_rate": 128}
    nopos = {"hex": "cccccc", "flight": "XYZ1"}
    lastpos = {"hex": "dddddd", "lastPosition": {"lat": 1.0, "lon": 2.0, "seen_pos": 30}}
    junk = [{"hex": "~123456", "lat": 1, "lon": 1}, {"hex": "zzz"}, {"lat": 1, "lon": 1}]
    obs = {o.hex: o for o in parse_readsb(readsb_payload(NOW, [ground, geom, nopos, lastpos, *junk]), "adsb.fi")}
    assert set(obs) == {"aaaaaa", "bbbbbb", "cccccc", "dddddd"}
    assert obs["aaaaaa"].gnd and obs["aaaaaa"].alt is None
    assert obs["bbbbbb"].alt == 36300 and obs["bbbbbb"].vr == 128
    assert obs["cccccc"].lat is None and obs["cccccc"].ts is None
    assert obs["dddddd"].lat == 1.0 and obs["dddddd"].ts == NOW - 30


def test_parse_readsb_accepts_adsb_fi_aircraft_key():
    assert [o.hex for o in parse_readsb(readsb_payload(NOW, [AC], key="aircraft"), "adsb.fi")] == ["3c6444"]


def make_feed(session, clock):
    provs = [Provider("adsb.lol", "https://lol/point/{lat}/{lon}/{r}", "https://lol/hex/{hex}"),
             Provider("adsb.fi", "https://fi/point/{lat}/{lon}/{r}", "https://fi/hex/{hex}")]
    for p in provs:
        p.limiter._sleep = lambda s: None
    store = Store(clock)
    return ReadsbFeed(store, session, provs, clock), store


def test_area_refresh_is_cached_and_covers_the_request(clock):
    clock.t = NOW
    session = FakeSession({"lol/point": FakeResp(readsb_payload(NOW, [AC]))})
    feed, store = make_feed(session, clock)
    feed.refresh_area(48.85, 2.35, 100)
    feed.refresh_area(48.86, 2.36, 80)  # inside the area just fetched
    assert session.count("lol/point") == 1 and "3c6444" in store.planes
    assert store.planes["3c6444"].src == "adsb.lol"
    clock.advance(5)  # older than 4 s: refetch
    feed.refresh_area(48.85, 2.35, 100)
    assert session.count("lol/point") == 2


def test_area_falls_back_to_adsb_fi_and_reports_state(clock):
    clock.t = NOW
    session = FakeSession({"lol/point": FakeResp({}, 503),
                           "fi/point": FakeResp(readsb_payload(NOW, [AC], key="aircraft"))})
    feed, store = make_feed(session, clock)
    feed.refresh_area(48.0, 11.0, 50)
    assert store.planes["3c6444"].src == "adsb.fi"
    st = feed.status()
    assert st["adsb.lol"]["state"] == "degraded" and st["adsb.lol"]["last_error"]
    assert st["adsb.fi"]["state"] == "ok" and st["adsb.fi"]["last_ok"] == NOW


def test_hex_refresh_is_cached_two_seconds_and_survives_errors(clock):
    clock.t = NOW

    def boom(url, **kw):
        raise requests.ConnectionError("down")

    session = FakeSession({"lol/hex": FakeResp(readsb_payload(NOW, [AC])), "fi/hex": boom})
    feed, store = make_feed(session, clock)
    feed.refresh_hex("3c6444")
    feed.refresh_hex("3c6444")
    assert session.count("lol/hex") == 1 and "3c6444" in store.planes
    feed.refresh_hex("abcdef")  # lol 200 with no aircraft: fine
    session.routes["lol/hex"] = boom
    feed.refresh_hex("123456")  # both down: no exception


def test_rate_limited_provider_is_skipped_then_slowed(monkeypatch):
    from stratus.feeds import readsb as rs
    from stratus.store import Store

    calls = []

    class Resp:
        def __init__(self, code):
            self.status_code = code

        def raise_for_status(self):
            pass

        def json(self):
            return {"now": 0, "ac": []}

    class Session:
        def get(self, url, timeout=None):
            calls.append(url)
            return Resp(429 if "adsb.lol" in url else 200)

    feed = rs.ReadsbFeed(Store(), Session())
    for p in feed.providers:
        p.limiter.acquire = lambda max_wait=0: True
    assert feed._fetch("hex", hex="abc123") == []
    lol = feed.providers[0]
    assert lol.state == "rate_limited" and lol.limiter.min_interval > rs.BASE_INTERVAL_S
    calls.clear()
    feed._fetch("hex", hex="abc124")
    assert "adsb.fi" in calls[0]  # the cooling-down provider is no longer asked first
