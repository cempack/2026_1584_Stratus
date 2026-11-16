import threading

from conftest import FakeClock, FakeResp, FakeSession, readsb_payload

from stratus.feeds.readsb import Provider, ReadsbFeed
from stratus.feeds.sweep import CIRCLES, RADIUS_NM, Sweeper
from stratus.store import Store

NOW = 1_800_000_000.0


def ac(hex_, lat, lon, **kw):
    return {"hex": hex_, "flight": "TST1", "lat": lat, "lon": lon, "alt_baro": 30000, "gs": 400, "track": 90,
            "seen_pos": 1.0, "type": "adsb_icao", **kw}


def make(session, circles=None, clock=None):
    clock = clock or FakeClock(NOW)
    provs = [Provider("adsb.lol", "https://lol/point/{lat}/{lon}/{r}", "https://lol/hex/{hex}"),
             Provider("adsb.fi", "https://fi/point/{lat}/{lon}/{r}", "https://fi/hex/{hex}")]
    for p in provs:
        p.limiter._sleep = lambda s: None
        p.limiter.min_interval = 0.0
    store = Store(clock)
    feed = ReadsbFeed(store, session, provs, clock)
    return Sweeper(feed, store, circles, interval=1.5, clock=clock), store, feed


def test_circle_list_is_global_and_valid():
    assert 100 <= len(CIRCLES) <= 140 and RADIUS_NM == 250
    assert len({c[0] for c in CIRCLES}) == len(CIRCLES)
    lats = [c[1] for c in CIRCLES]
    lons = [c[2] for c in CIRCLES]
    assert all(-90 <= la <= 90 for la in lats) and all(-180 <= lo <= 180 for lo in lons)
    # every inhabited continent is covered, not just Europe / the US
    boxes = {"africa": (-35, 35, -18, 52), "south america": (-55, 12, -82, -34), "asia": (5, 55, 60, 145),
             "middle east": (12, 40, 34, 60), "oceania": (-47, -9, 110, 180)}
    for name, (la0, la1, lo0, lo1) in boxes.items():
        assert sum(1 for la, lo in zip(lats, lons) if la0 <= la <= la1 and lo0 <= lo <= lo1) >= 5, name


def test_providers_alternate_and_cycle_stats_are_exposed():
    session = FakeSession({
        "lol/point": FakeResp(readsb_payload(NOW, [ac("aaaaaa", 10.0, 10.0)])),
        "fi/point": FakeResp(readsb_payload(NOW, [ac("bbbbbb", 20.0, 20.0)], key="aircraft"))})
    sw, store, _ = make(session, circles=[("a", 10, 10), ("b", 20, 20), ("c", 30, 30), ("d", 40, 40)])
    for _ in range(4):
        sw.clock.advance(1.5)
        assert sw.step()
    urls = [c[1] for c in session.calls]
    assert [("lol" in u) for u in urls] == [True, False, True, False]  # alternating
    assert all(u.endswith("/250") for u in urls)
    st = sw.status()
    assert st["cycles"] == 1 and st["index"] == 0 and st["requests"] == 4 and st["errors"] == 0
    assert st["last_cycle_s"] == 4.5 and st["last_cycle_new_planes"] == 2 and st["new_planes_total"] == 2
    assert set(store.planes) == {"aaaaaa", "bbbbbb"}
    sw.step()  # second cycle: the same circle now goes to the other provider
    assert "fi/point" in session.calls[-1][1]


def test_failing_provider_falls_back_to_the_other_and_cools_down():
    session = FakeSession({"lol/point": FakeResp({}, 429),
                           "fi/point": FakeResp(readsb_payload(NOW, [ac("bbbbbb", 20.0, 20.0)], key="aircraft"))})
    sw, store, feed = make(session, circles=[("a", 10, 10), ("b", 20, 20)])
    assert sw.step() and sw.step()
    assert set(store.planes) == {"bbbbbb"}
    assert session.count("lol/point") == 1  # 429: adsb.lol is left alone for 60 s
    assert feed.providers[0].state == "rate_limited" and sw.status()["errors"] == 1
    sw.clock.advance(61)
    sw.step()
    sw.step()
    assert session.count("lol/point") == 2


def test_sweep_merges_with_the_normal_rules_and_counts_only_new_planes():
    session = FakeSession({"point": FakeResp(readsb_payload(NOW, [
        ac("aaaaaa", 10.0, 10.0), ac("cccccc", 11.0, 11.0, seen_pos=90.0),  # stale fix: ignored
        {"hex": "~dddddd", "lat": 1, "lon": 1, "seen_pos": 1}]))})
    sw, store, _ = make(session, circles=[("a", 10, 10)])
    from stratus.store import Obs
    store.apply([Obs(hex="aaaaaa", ts=NOW - 2, lat=10.0, lon=10.0, alt=30000, src="opensky")])
    sw.step()
    assert set(store.planes) == {"aaaaaa"} and sw.new_planes_total == 0  # already known: not "new"
    assert store.get("aaaaaa").src == "adsb.lol"  # fresher fix from the sweep wins by timestamp


def test_both_providers_busy_is_not_fatal_and_idle_pauses_the_loop():
    session = FakeSession({})
    sw, store, feed = make(session, circles=[("a", 10, 10)])
    for p in feed.providers:
        p.cooldown_until = NOW + 100
    assert not sw.step() and sw.index == 0 and sw.cycles == 1
    assert sw.idle()  # nobody has looked at the map yet -> the loop would wait
    stop = threading.Event()
    sw.idle = lambda: (stop.set() or True)
    sw.run(stop)  # returns immediately when idle and stop is set, without any request
    assert session.calls == [] and sw.status()["state"] == "idle"
