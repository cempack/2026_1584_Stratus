"""Cross-source merge hardening: no duplicates, no ghosts, no stale or low-quality overwrites."""

from conftest import FakeClock, readsb_payload

from stratus.feeds.opensky import parse_states
from stratus.feeds.readsb import parse_readsb
from stratus.store import META_STALE_S, Obs, Store, pos_quality

T0 = 1_800_000_000.0


def mk(t=T0 + 100):
    return Store(FakeClock(t))


def ob(ts, lat=48.0, lon=11.0, hex_="3c6444", src="opensky", **kw):
    kw.setdefault("alt", 30000)
    kw.setdefault("gs", 450)
    return Obs(hex=hex_, ts=ts, lat=lat, lon=lon, src=src, **kw)


# ---- parsing -------------------------------------------------------------------------------------
def test_readsb_stale_positions_are_not_fixes_but_keep_metadata():
    ac = {"hex": "3c6444", "flight": "DLH4AB", "lat": 48.0, "lon": 11.0, "alt_baro": 30000, "t": "A320"}
    obs = {o.hex: o for o in parse_readsb(readsb_payload(T0, [
        {**ac, "seen_pos": 59.0}, {**ac, "hex": "aaaaaa", "seen_pos": 61.0},
        {"hex": "bbbbbb", "flight": "X1", "lastPosition": {"lat": 1.0, "lon": 2.0, "seen_pos": 300}},
        {"hex": "cccccc", "lat": 5.0, "seen_pos": 1}]), "adsb.fi")}  # lon missing: half a position
    assert obs["3c6444"].lat == 48.0 and obs["3c6444"].ts == T0 - 59
    for hx in ("aaaaaa", "bbbbbb", "cccccc"):
        assert obs[hx].lat is None and obs[hx].ts is None
    assert obs["aaaaaa"].cs == "DLH4AB" and obs["aaaaaa"].type == "A320"
    s = mk()
    s.apply(list(obs.values()))
    assert set(s.planes) == {"3c6444"}  # stale ones never became ghost planes


def test_non_icao_and_malformed_hex_are_ignored_everywhere():
    lines = [{"hex": "~a1b2c3", "lat": 1, "lon": 1, "seen_pos": 1}, {"hex": "a1b2c", "lat": 1, "lon": 1},
             {"hex": "ZZZZZZ", "lat": 1, "lon": 1}, {"hex": "", "lat": 1, "lon": 1}]
    assert parse_readsb(readsb_payload(T0, lines), "adsb.lol") == []
    row = ["~a1b2c3", "TEST", "X", T0, T0, 11.0, 48.0, 9000.0, False, 200.0, 90.0, 0.0, None, None, "1000", False, 0, 4]
    assert parse_states({"time": T0, "states": [row]}) == []


def test_readsb_reports_radius_of_containment():
    o = parse_readsb(readsb_payload(T0, [{"hex": "3c6444", "lat": 1.0, "lon": 1.0, "rc": 3704, "seen_pos": 1,
                                          "type": "mlat"}]), "adsb.lol")[0]
    assert o.rc == 3704 and pos_quality(o.pos_type, o.rc) == 0
    assert pos_quality("adsb_icao") == 2 and pos_quality("mlat") == 1 and pos_quality("tisb_icao") == 1
    assert pos_quality(None) == 2 and pos_quality("adsb_icao", 100) == 2


# ---- one plane per hex ------------------------------------------------------------------------------
def test_three_sources_one_hex_one_plane_newest_wins():
    s = mk()
    s.apply([ob(T0, src="opensky"), ob(T0 + 3, lat=48.01, src="adsb.fi"), ob(T0 + 6, lat=48.02, src="adsb.lol")])
    s.apply([ob(T0 + 4, lat=48.015, src="opensky")])  # older than the stored fix
    assert len(s.planes) == 1 and s.get("3c6444").lat == 48.02 and s.get("3c6444").src == "adsb.lol"
    assert s.snapshot()[0] == s.version and len(s.area(48, 11, 50)["rows"]) == 1


# ---- sanity across sources ------------------------------------------------------------------------------
def test_impossible_jump_from_another_source_is_rejected_until_repeated():
    s = mk()
    s.apply([ob(T0, src="opensky")])
    s.apply([ob(T0 + 5, lat=60.0, src="adsb.fi")])
    assert s.get("3c6444").lat == 48.0 and s.get("3c6444").src == "opensky"
    s.apply([ob(T0 + 10, lat=60.0, src="adsb.lol")])  # second consistent report: still not enough
    assert s.get("3c6444").lat == 48.0
    s.apply([ob(T0 + 15, lat=60.0, src="adsb.fi")])
    assert s.get("3c6444").lat == 60.0  # third agreeing report: the stored fix was the outlier


def test_scattered_bogus_fixes_never_add_up_to_acceptance():
    s = mk()
    s.apply([ob(T0, src="opensky")])
    for i, lat in enumerate([60.0, -30.0, 10.0, 70.0, -50.0, 20.0]):  # each rejected, none agrees with the previous
        s.apply([ob(T0 + 5 + i, lat=lat, lon=100.0 + 40 * i, src="adsb.fi" if i % 2 else "adsb.lol")])
    p = s.get("3c6444")
    assert (p.lat, p.src) == (48.0, "opensky")


def test_a_real_move_after_a_long_gap_is_accepted():
    s = mk(T0 + 7000)
    s.apply([ob(T0)])
    s.apply([ob(T0 + 3600, lat=60.0, src="adsb.fi")])
    assert s.get("3c6444").lat == 60.0


# ---- MLAT / low quality ------------------------------------------------------------------------------------
def test_mlat_never_overwrites_a_newer_adsb_fix_but_fills_gaps():
    s = mk()
    s.apply([ob(T0, src="opensky", pos_type="adsb_icao")])
    s.apply([ob(T0 + 5, lat=48.003, src="adsb.lol", pos_type="mlat")])  # newer than ADS-B, but only MLAT
    p = s.get("3c6444")
    assert (p.lat, p.src, p.ts) == (48.0, "opensky", T0)
    s.apply([ob(T0 + 29, lat=48.004, src="adsb.lol", pos_type="tisb_icao")])
    assert p.lat == 48.0
    s.apply([ob(T0 + 40, lat=48.008, src="adsb.lol", pos_type="mlat")])  # ADS-B went silent for 40 s: MLAT fills
    assert (p.lat, p.src, p.pos_type) == (48.008, "adsb.lol", "mlat")
    s.apply([ob(T0 + 45, lat=48.009, src="adsb.fi", pos_type="adsb_icao")])  # ADS-B is back and wins at once
    assert (p.lat, p.src, p.pos_type) == (48.009, "adsb.fi", "adsb_icao")


def test_poor_accuracy_fix_does_not_overwrite_a_good_one():
    s = mk()
    s.apply([ob(T0, src="adsb.lol", pos_type="adsb_icao", rc=186)])
    s.apply([ob(T0 + 10, lat=48.02, src="adsb.fi", pos_type="adsb_icao", rc=9260)])
    assert s.get("3c6444").lat == 48.0
    s.apply([ob(T0 + 11, lat=48.003, src="adsb.fi", pos_type="adsb_icao", rc=186)])
    assert s.get("3c6444").lat == 48.003


# ---- metadata reliability ---------------------------------------------------------------------------------------
def test_metadata_from_a_better_source_is_not_overwritten_by_a_worse_one():
    s = mk()
    s.apply([ob(T0, src="opensky", pos_type="adsb_icao", cs="DLH4AB", sqk="1000", type="A320")])
    s.apply([ob(T0 + 40, lat=48.01, src="adsb.lol", pos_type="mlat", cs="GARBLE1", sqk="7700", reg="D-AIZB")])
    p = s.get("3c6444")
    assert (p.cs, p.sqk) == ("DLH4AB", "1000")  # no bogus emergency from an MLAT/TIS-B message
    assert p.reg == "D-AIZB" and p.type == "A320"  # blanks are still filled
    s.apply([ob(T0 + 50, lat=48.02, src="adsb.fi", pos_type="adsb_icao", cs="DLH4AC", sqk="2000")])
    assert (p.cs, p.sqk) == ("DLH4AC", "2000")  # equal or better quality overwrites
    s.clock.t = T0 + 100 + META_STALE_S + 5
    s.apply([ob(T0 + 90 + META_STALE_S, lat=48.03, src="adsb.lol", pos_type="mlat", cs="LATE1")])
    assert p.cs == "LATE1"  # stale better metadata no longer protects the field


def test_metadata_only_observation_cannot_create_a_plane_or_move_one():
    s = mk()
    s.apply([Obs(hex="3c6444", cs="X", src="adsb.fi", pos_type="mlat")])
    assert not s.planes
    s.apply([ob(T0)])
    s.apply([Obs(hex="3c6444", cs="DLH4AB", pos_type="mlat", src="adsb.fi")])
    assert (s.get("3c6444").lat, s.get("3c6444").cs) == (48.0, "DLH4AB")
