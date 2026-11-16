from conftest import DAY0, FakeResp, FakeSession, opensky_state

from stratus.feeds.opensky import Budget, OpenSkyPoller, parse_states
from stratus.store import Store

NOON = DAY0 + 12 * 3600


# ---- budget pacing (pure logic, fake clock) -----------------------------------------------------

def test_unknown_remaining_spreads_the_allowance():
    assert Budget(4000).interval(NOON) == 86.4
    assert Budget(400).interval(NOON) == 864.0


def test_interval_spreads_remainder_until_midnight():
    b = Budget(4000)
    b.observe(4000, DAY0)
    # reserve 200 -> 3800 usable / 4 = 950 calls over 86400 s
    assert abs(b.interval(DAY0) - 86400 / 950) < 0.01
    b.observe(1000, NOON)
    assert abs(b.interval(NOON) - 43200 / 200) < 0.01


def test_interval_never_below_floor():
    b = Budget(4000)
    b.observe(3900, DAY0 + 86400 - 100)  # lots of credit, 100 s to midnight
    assert b.interval(DAY0 + 86400 - 100) == 20.0


def test_reserve_is_never_spent():
    b = Budget(400)  # reserve 20
    b.observe(23, NOON)
    assert not b.usable(NOON)  # 23 - 20 < 4
    b.observe(24, NOON)
    assert b.usable(NOON)


def test_stale_value_from_previous_day_means_reset():
    b = Budget(400)
    b.observe(0, DAY0 + 3600)
    assert not b.usable(DAY0 + 3600)
    assert b.usable(DAY0 + 86400 + 60)
    assert b.interval(DAY0 + 86400 + 60) == 864.0


def test_increase_is_accepted_as_reset_and_missing_header_decrements():
    b = Budget(400)
    b.observe(100, NOON)
    b.observe(396, NOON + 10)
    assert b.remaining == 396
    b.observe(None, NOON + 20)
    assert b.remaining == 392


def test_rate_limit_blocks_for_retry_after_or_fallback():
    b = Budget(400)
    b.rate_limited(120, NOON)
    assert b.blocked_until == NOON + 120
    assert not b.usable(NOON + 121)  # pool is considered empty until the next UTC day
    assert b.usable(DAY0 + 86400 + 1)
    b2 = Budget(400)
    b2.rate_limited(None, NOON)
    assert b2.blocked_until == NOON + 600


# ---- parsing --------------------------------------------------------------------------------------

def test_parse_states_units_and_fields():
    obs = parse_states({"time": NOON, "states": [
        opensky_state(baro_m=10000.0, vel=230.0, vr=-3.0, trk=271.5, cat=4),
        opensky_state(hex_="abcdef", cs="", gnd=True, baro_m=0.0),
        opensky_state(hex_="bad", lat=1.0),
        ["short"],
        opensky_state(hex_="aaaaaa", lat=None, lon=None),
    ]})
    by = {o.hex: o for o in obs}
    assert set(by) == {"3c6444", "abcdef", "aaaaaa"}
    a = by["3c6444"]
    assert a.alt == 32808 and a.gs == 447 and a.vr == -591 and a.trk == 271.5
    assert a.cs == "DLH4AB" and a.cat == "A3" and a.pos_type == "adsb_icao" and a.src == "opensky"
    assert a.country == "Germany" and a.sqk == "1000" and not a.gnd
    g = by["abcdef"]
    assert g.gnd and g.alt is None and g.cs is None
    assert by["aaaaaa"].lat is None  # kept for metadata, never creates a plane


def test_parse_states_falls_back_to_geometric_altitude():
    row = opensky_state()
    row[7], row[13] = None, 5000.0
    assert parse_states({"time": NOON, "states": [row]})[0].alt == 16404


# ---- poller ---------------------------------------------------------------------------------------

def make_poller(cfg, clock, session):
    store = Store(clock)
    return OpenSkyPoller(cfg, store, session, clock), store


def states_resp(remaining="396", **kw):
    return FakeResp({"time": NOON, "states": [opensky_state(**kw)]}, headers={"X-Rate-Limit-Remaining": remaining})


def test_poll_applies_states_tracks_remaining_and_persists(cfg, clock):
    session = FakeSession({"opensky-network.org/api/states": states_resp()})
    poller, store = make_poller(cfg, clock, session)
    assert poller.poll_once()
    assert "3c6444" in store.planes
    assert poller.anon.remaining == 396 and poller.status()["credits_remaining"] == 396
    assert session.calls[0][2]["params"] == {"extended": 1}
    assert "Authorization" not in session.calls[0][2]["headers"]
    # a restart reads the persisted budget instead of starting blind
    poller2, _ = make_poller(cfg, clock, FakeSession())
    assert poller2.anon.remaining == 396 and poller2.last_ok == poller.last_ok


def test_429_waits_retry_after_and_stops_polling(cfg, clock):
    session = FakeSession({"opensky-network.org/api/states": FakeResp({}, 429, {"X-Rate-Limit-Retry-After-Seconds": "3600"})})
    poller, store = make_poller(cfg, clock, session)
    assert not poller.poll_once()
    assert poller.state == "rate_limited" and poller.anon.blocked_until == clock() + 3600
    assert poller.compute_next(clock()) >= clock() + 3600
    assert not poller.poll_once()  # nothing usable: no HTTP call is made
    assert session.count("states") == 1


def test_5xx_backs_off_exponentially_between_15s_and_5min(cfg, clock):
    session = FakeSession({"opensky-network.org/api/states": FakeResp({}, 503)})
    poller, _ = make_poller(cfg, clock, session)
    seen = []
    for _ in range(8):
        poller.poll_once()
        seen.append(poller.backoff)
    assert seen[0] == 15.0 and seen[1] == 30.0 and seen[-1] == 300.0
    assert poller.state == "degraded" and poller.compute_next(clock()) == clock() + 300


def test_pacing_between_polls_follows_budget_and_idle_mode(cfg, clock):
    session = FakeSession({"opensky-network.org/api/states": states_resp(remaining="396")})
    poller, store = make_poller(cfg, clock, session)
    store.last_client_hit = clock()
    poller.poll_once()
    expected = poller.anon.interval(clock())
    assert expected == (86400 - 12 * 3600) / ((396 - 20) / 4)
    assert poller.compute_next(clock()) == clock() + expected
    clock.advance(11 * 60)  # nobody looked for 10+ minutes
    assert poller.idle(clock())
    assert poller.compute_next(clock()) >= poller.last_attempt + 600
    assert poller.status()["state"] == "idle"
    poller.note_client_hit()
    assert poller.wake.is_set() and not poller.idle(clock())


def test_no_bootstrap_when_restored_snapshot_is_fresh(cfg, clock):
    session = FakeSession({"opensky-network.org/api/states": states_resp()})
    poller, store = make_poller(cfg, clock, session)
    poller.poll_once()
    clock.advance(60)
    poller2, store2 = make_poller(cfg, clock, session)
    store2.apply(parse_states({"time": NOON, "states": [opensky_state()]}), now=clock())
    poller2.schedule_first()
    assert poller2.last_attempt == poller2.last_ok  # wait for the normal interval
    clock.advance(600)  # snapshot older than 3 min: a bootstrap poll is allowed
    poller2.schedule_first()
    assert poller2.last_attempt == 0.0


def test_oauth_mode_uses_bearer_token_and_falls_back_to_anonymous(cfg, clock):
    cfg.opensky_client_id, cfg.opensky_client_secret = "id", "secret"
    session = FakeSession({
        "openid-connect/token": FakeResp({"access_token": "tok", "expires_in": 1800}),
        "opensky-network.org/api/states": states_resp(remaining="3000"),
    })
    poller, _ = make_poller(cfg, clock, session)
    assert poller.poll_once() and poller.mode == "oauth"
    assert session.calls[1][2]["headers"]["Authorization"] == "Bearer tok"
    assert poller.status()["credits_daily"] == 4000
    # rejected credentials: the anonymous pool takes over instead of failing
    session2 = FakeSession({
        "openid-connect/token": FakeResp({}, 401),
        "opensky-network.org/api/states": states_resp(remaining="390"),
    })
    poller2, _ = make_poller(cfg, clock, session2)
    assert poller2.poll_once() and poller2.mode == "anonymous"
    assert poller2.state == "degraded"
