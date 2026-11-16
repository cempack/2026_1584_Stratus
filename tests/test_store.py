import json
import gzip

from conftest import FakeClock

from stratus.store import FIELDS, Obs, Store

T0 = 1_800_000_000.0


def obs(ts, lat=48.0, lon=11.0, hex_="3c6444", **kw):
    kw.setdefault("alt", 30000)
    kw.setdefault("src", "opensky")
    return Obs(hex=hex_, ts=ts, lat=lat, lon=lon, **kw)


def make(t=T0 + 100):
    clock = FakeClock(t)
    return Store(clock), clock


def test_newer_position_wins_older_is_ignored_but_metadata_is_filled():
    s, _ = make()
    s.apply([obs(T0, cs="DLH4AB")])
    s.apply([obs(T0 - 5, lat=10.0, reg="D-AIZB", type="A320", src="adsb.lol")])
    p = s.get("3c6444")
    assert (p.lat, p.src, p.ts) == (48.0, "opensky", T0)
    assert (p.reg, p.type, p.cs) == ("D-AIZB", "A320", "DLH4AB")
    s.apply([obs(T0 + 5, lat=48.01, src="adsb.lol")])
    assert (p.lat, p.src, p.reg) == (48.01, "adsb.lol", "D-AIZB")


def test_metadata_only_observation_does_not_create_a_plane():
    s, _ = make()
    s.apply([Obs(hex="3c6444", cs="X")])
    assert not s.planes


def test_sanity_rejects_impossible_jumps_but_accepts_after_repeated_outliers():
    s, _ = make()
    s.apply([obs(T0)])
    v = s.version
    s.apply([obs(T0 + 10, lat=49.0)])  # ~60 NM in 10 s = 21600 kt
    assert s.get("3c6444").lat == 48.0 and s.version == v
    s.apply([obs(T0 + 11, lat=49.0)])
    s.apply([obs(T0 + 12, lat=49.0)])  # third consistent reject: the stored fix was the outlier
    assert s.get("3c6444").lat == 49.0
    assert len(s.get("3c6444").trail) == 1  # trail restarted


def test_sanity_does_not_apply_after_a_long_gap_and_checks_ranges_and_future():
    s, _ = make(T0 + 4000)
    s.apply([obs(T0)])
    s.apply([obs(T0 + 1900, lat=60.0)])  # 12 deg after > 30 min: plausible
    assert s.get("3c6444").lat == 60.0
    s.apply([obs(T0 + 1950, lat=95.0), obs(T0 + 1950, lon=181.0), obs(T0 + 4000 + 60, lat=61.0)])
    assert s.get("3c6444").lat == 60.0
    s.apply([obs(T0, hex_="aaaaaa", lat=-91.0)])
    assert "aaaaaa" not in s.planes


def test_expiry_air_15min_ground_5min():
    s, _ = make()
    s.apply([obs(T0, hex_="aaaaaa"), obs(T0, hex_="bbbbbb", gnd=True, alt=None)])
    assert s.maintain(T0 + 4 * 60) == 0
    assert s.maintain(T0 + 6 * 60) == 1 and "bbbbbb" not in s.planes
    assert s.maintain(T0 + 14 * 60) == 0
    assert s.maintain(T0 + 16 * 60) == 1 and not s.planes


def test_trail_spacing_and_thinning():
    s, _ = make(T0 + 10_000)
    # 4 s and 5 s apart or <200 m: not appended; every 10 s at 450 kt (~1.25 NM) appended
    s.apply([obs(T0, lat=48.0), obs(T0 + 4, lat=48.0005)])
    assert len(s.get("3c6444").trail) == 1
    s.apply([obs(T0 + 12, lat=48.01)])
    s.apply([obs(T0 + 13, lat=48.0100001)])
    assert len(s.get("3c6444").trail) == 2
    # straight line, one point every 10 s for 30 min: old part is thinned by Douglas-Peucker
    for i in range(1, 181):
        s.apply([obs(T0 + 100 + i * 10, lat=48.02 + i * 0.002)])
    p = s.get("3c6444")
    assert len(p.trail) == 182
    now = T0 + 100 + 180 * 10
    s.maintain(now)
    old = [pt for pt in p.trail if pt[3] < now - 20 * 60]
    assert len(old) <= 3 and len(p.trail) < 130  # collinear old points collapse, the last 20 min stay full
    assert p.trail[0][3] == T0 and p.trail[-1][3] == T0 + 100 + 1800


def test_snapshot_is_built_once_per_version_and_etag_changes():
    s, _ = make()
    s.apply([obs(T0, cs="DLH4AB", reg="D-AIZB", type="A320", cat="A3", sqk="1000")])
    a = s.snapshot()
    assert s.snapshot() is a
    v, raw, gz, etag = a
    body = json.loads(raw)
    assert gzip.decompress(gz) == raw and body["v"] == v and body["fields"] == FIELDS
    assert body["rows"] == [["3c6444", "DLH4AB", 48.0, 11.0, 30000, None, None, None, False, T0, "opensky", "A320",
                             "D-AIZB", "A3", "1000", False]]
    s.apply([obs(T0 + 10, lat=48.01)])
    assert s.snapshot()[3] != etag
    s.apply([obs(T0 + 10, lat=40.0)])  # ignored (not newer): version and snapshot unchanged
    assert s.snapshot()[0] == s.version


def test_area_filters_by_circle_and_wraps_antimeridian():
    s, _ = make()
    s.apply([obs(T0, hex_="aaaaaa", lat=48.85, lon=2.35), obs(T0, hex_="bbbbbb", lat=50.0, lon=2.35),
             obs(T0, hex_="cccccc", lat=0.0, lon=179.9), obs(T0, hex_="dddddd", lat=0.0, lon=-179.9)])
    rows = s.area(48.85, 2.35, 100)["rows"]
    assert [r[0] for r in rows] == ["aaaaaa", "bbbbbb"]  # 1.15 deg = 69 NM
    rows = s.area(48.85, 2.35, 60)["rows"]
    assert [r[0] for r in rows] == ["aaaaaa"]
    assert sorted(r[0] for r in s.area(0.0, 180.0, 30)["rows"]) == ["cccccc", "dddddd"]


def test_save_and_load_roundtrip_and_stale_snapshot_is_ignored(tmp_path):
    s, clock = make()
    s.apply([obs(T0, cs="DLH4AB", pos_type="adsb_icao", country="Germany")])
    s.apply([obs(T0 + 20, lat=48.05)])
    path = tmp_path / "store.json.gz"
    s.save(path)
    s2, _ = make()
    assert s2.load(path)
    p = s2.get("3c6444")
    assert (p.cs, p.lat, p.pos_type, p.country, len(p.trail)) == ("DLH4AB", 48.05, "adsb_icao", "Germany", 2)
    s3, c3 = make()
    c3.advance(3 * 3600)
    assert s3.load(path) is None and not s3.planes
