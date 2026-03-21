import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "sources"))

if "requests" not in sys.modules:
    class _DummySession:
        def __init__(self):
            self.headers = {}

        def get(self, *args, **kwargs):  # pragma: no cover - guardrail only
            raise RuntimeError("requests.Session.get should not be used in these tests")

        def head(self, *args, **kwargs):  # pragma: no cover - guardrail only
            raise RuntimeError("requests.Session.head should not be used in these tests")

    sys.modules["requests"] = types.SimpleNamespace(
        Session=_DummySession,
        RequestException=Exception,
        compat=types.SimpleNamespace(urlencode=lambda params: "&".join(
            f"{key}={value}" for key, value in params.items()
        )),
    )

if "flask" not in sys.modules:
    class _DummyFlask:
        def __init__(self, *args, **kwargs):
            self.static_folder = kwargs.get("static_folder")
            self.static_url_path = kwargs.get("static_url_path")

        def route(self, *args, **kwargs):
            def decorator(func):
                return func
            return decorator

        def before_request(self, func):
            return func

        def run(self, *args, **kwargs):  # pragma: no cover - guardrail only
            raise RuntimeError("Flask.run should not be used in these tests")

    class _DummyResponse(dict):
        def __init__(self, response=None, mimetype=None, content_type=None):
            super().__init__()
            self.response = response
            self.mimetype = mimetype
            self.content_type = content_type
            self.headers = {}

    sys.modules["flask"] = types.SimpleNamespace(
        Flask=_DummyFlask,
        Response=_DummyResponse,
        jsonify=lambda payload=None, *args, **kwargs: payload,
        request=types.SimpleNamespace(
            headers={},
            args=types.SimpleNamespace(get=lambda *args, **kwargs: None),
            endpoint=None,
            method="GET",
            get_json=lambda silent=True: {},
        ),
        send_from_directory=lambda *args, **kwargs: None,
        stream_with_context=lambda generator: generator,
    )

import server  # noqa: E402


class ServerTests(unittest.TestCase):
    def test_runtime_paths_are_rooted_at_project_level(self):
        self.assertEqual(server.PROJECT_ROOT, ROOT)
        self.assertEqual(server.SOURCES_DIR, ROOT / "sources")
        self.assertEqual(server.DATA_DIR, ROOT / "data")
        self.assertEqual(server.APP_ASSETS_DIR, ROOT / "data" / "assets" / "app")
        self.assertEqual(server.RADIO_FEEDS_DIR, ROOT / "data" / "atc")
        self.assertEqual(server.CACHE_DIR, ROOT / "data" / "cache")
        self.assertEqual(server.ROOT_ENV_PATH, ROOT / ".env")

    def test_clamp_limits_values(self):
        self.assertEqual(server.clamp(-1, 0, 10), 0)
        self.assertEqual(server.clamp(5, 0, 10), 5)
        self.assertEqual(server.clamp(12, 0, 10), 10)

    def test_unwrap_lng_handles_dateline_crossings(self):
        self.assertEqual(server.unwrap_lng(179.0, -179.5), 180.5)
        self.assertEqual(server.unwrap_lng(-179.0, 179.5), -180.5)
        self.assertEqual(server.unwrap_lng(10.0, 15.0), 15.0)

    def test_haversine_nm_returns_expected_distances(self):
        self.assertAlmostEqual(server.haversine_nm(0, 0, 0, 0), 0.0, places=6)
        self.assertAlmostEqual(server.haversine_nm(0, 0, 0, 1), 60.04, places=2)

    def test_parse_liveatc_airports_from_search_page_handles_edge_cases(self):
        page = """
        <option value="LFPG">LFPG - Paris Charles de Gaulle</option>
        <option value="lfpg">LFPG - Duplicate ignored by key</option>
        <option value="EGLL"><b>EGLL</b> - London Heathrow</option>
        <option value="BAD">Too short</option>
        <option value="KJFK"></option>
        """
        airports = server.parse_liveatc_airports_from_search_page(
            page,
            airports_by_icao={
                "LFPG": {"city": "Paris", "country": "FR", "lat": 49.0, "lng": 2.5},
            },
        )
        self.assertEqual([airport["icao"] for airport in airports], ["EGLL", "LFPG"])
        self.assertEqual(airports[1]["name"], "Duplicate ignored by key")
        self.assertEqual(airports[1]["city"], "Paris")
        self.assertEqual(airports[1]["lat"], 49.0)

    def test_extract_icao_from_live_audio_label_returns_empty_when_unresolvable(self):
        self.assertEqual(
            server.extract_icao_from_live_audio_label("Tower North", "https://d.liveatc.net/archive"),
            "",
        )
        self.assertEqual(
            server.extract_icao_from_live_audio_label("Arrival (KJFK)", ""),
            "KJFK",
        )

    def test_load_simple_env_file_parses_and_sanitizes_values(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            env_path = Path(tmpdir) / ".env"
            env_path.write_text(
                "\n".join(
                    [
                        "# comment",
                        "OPENSKY_CLIENT_ID=' client-id '",
                        "OPENSKY_CLIENT_SECRET=`secret`»",
                        "BROKEN",
                    ]
                ),
                encoding="utf-8",
            )
            self.assertEqual(
                server.load_simple_env_file(env_path),
                {
                    "OPENSKY_CLIENT_ID": "client-id",
                    "OPENSKY_CLIENT_SECRET": "secret",
                },
            )

    def test_save_opensky_credentials_writes_and_clears_env_file(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            env_path = Path(tmpdir) / ".env"
            original_path = server.ROOT_ENV_PATH
            original_credentials = server.opensky_credentials
            try:
                server.ROOT_ENV_PATH = env_path
                server.opensky_credentials = None
                with mock.patch.dict(os.environ, {}, clear=True):
                    saved = server.save_opensky_credentials(
                        client_id=" demo-id ",
                        client_secret=" demo-secret ",
                    )
                    self.assertEqual(saved["client_id"], "demo-id")
                    self.assertTrue(env_path.exists())
                    written = env_path.read_text(encoding="utf-8")
                    self.assertIn("OPENSKY_CLIENT_ID=demo-id", written)
                    self.assertIn("OPENSKY_CLIENT_SECRET=demo-secret", written)

                    cleared = server.save_opensky_credentials(clear=True)
                    self.assertFalse(env_path.exists())
                    self.assertFalse(cleared["configured"])
            finally:
                server.ROOT_ENV_PATH = original_path
                server.opensky_credentials = original_credentials
                server.reset_opensky_auth_state()

    def test_parse_opensky_states_maps_and_filters_rows(self):
        payload = {
            "time": 1700000000,
            "states": [
                [
                    "abc123",
                    " AFR10 ",
                    "France",
                    1699999990,
                    1699999995,
                    181.2,
                    48.8,
                    1000.0,
                    False,
                    210.0,
                    90.0,
                    -1.2,
                    None,
                    1200.0,
                    "7000",
                    True,
                    0,
                    "A3",
                ],
                ["bad"],
            ],
        }
        entries = server.parse_opensky_states(payload, "oauth")
        self.assertEqual(len(entries), 1)
        entry = entries[0]
        self.assertEqual(entry["hex"], "abc123")
        self.assertEqual(entry["flight"], "AFR10")
        self.assertEqual(entry["alt"], 1200)
        self.assertEqual(entry["alt_baro"], round(1000.0 * 3.28084))
        self.assertEqual(entry["trk"], 90.0)
        self.assertEqual(entry["position_source"], "ADS-B")
        self.assertEqual(entry["src"], server.DATA_SOURCE_LABEL)

    def test_prune_trail_keeps_recent_points_and_drops_stale_entries(self):
        latest = 10_000
        trail = [
            {"ts": latest - server.TRAIL_RETENTION_SECONDS - 1, "lat": 0, "lng": 0},
            {"ts": latest - server.TRAIL_FULL_RES_WINDOW_SECONDS - 90, "lat": 1, "lng": 1},
            {"ts": latest - server.TRAIL_FULL_RES_WINDOW_SECONDS - 70, "lat": 2, "lng": 2},
            {"ts": latest - 5, "lat": 3, "lng": 3},
            {"ts": latest, "lat": 4, "lng": 4},
        ]
        server.prune_trail(trail, newest_ts=latest)
        self.assertEqual([point["lat"] for point in trail], [1, 3, 4])

    def test_run_server_uses_requested_binding_and_starts_pollers(self):
        with mock.patch.object(server, "start_pollers") as start_mock:
            with mock.patch.object(server.app, "run") as run_mock:
                server.run_server(host="127.0.0.1", port=9001, debug=True)

        start_mock.assert_called_once_with()
        run_mock.assert_called_once_with(
            host="127.0.0.1",
            port=9001,
            debug=True,
            threaded=True,
            use_reloader=False,
        )


if __name__ == "__main__":
    unittest.main()
