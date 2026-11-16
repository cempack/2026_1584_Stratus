"""Flask app factory and routes."""

from __future__ import annotations

import gzip
import json
import logging
import re
import threading
import time

import requests
from flask import Flask, Response, abort, jsonify, request, send_from_directory, stream_with_context

from .atc import AUDIO_HEADERS, AtcCatalog
from .config import Config
from .enrich import Enricher, route_plausible
from .feeds.opensky import OpenSkyPoller
from .feeds.readsb import MAX_RADIUS_NM, ReadsbFeed
from .store import Store
from .util import make_session, norm_hex, num
from .weather import Weather

log = logging.getLogger(__name__)

PERSIST_EVERY_S = 60.0
MAINTAIN_EVERY_S = 30.0
HASHED_ASSET = re.compile(r"[-.][A-Za-z0-9_-]{8,}\.(js|css|woff2?|png|svg|jpg|webp|avif)$")
PLACEHOLDER = (b"<!doctype html><meta charset=utf-8><title>Stratus</title>"
               b"<p>Stratus backend is running. Frontend not built yet (web/dist missing).</p>")


class Runtime:
    def __init__(self, cfg: Config, session=None, clock=time.time):
        self.cfg = cfg
        self.http = session or make_session()
        self.store = Store(clock)
        self.opensky = OpenSkyPoller(cfg, self.store, self.http, clock)
        self.readsb = ReadsbFeed(self.store, self.http, clock=clock)
        self.enrich = Enricher(self.http)
        self.weather = Weather(self.http)
        self.atc = AtcCatalog(cfg.atc_dir)
        self.stop = threading.Event()
        self.started = False
        self._start_lock = threading.Lock()

    @property
    def snapshot_path(self):
        return self.cfg.cache_dir / "store.json.gz"

    def start(self) -> None:
        with self._start_lock:
            if self.started:
                return
            self.started = True
        if self.store.load(self.snapshot_path):
            log.info("restored %d planes from snapshot", len(self.store.planes))
        threading.Thread(target=self.opensky.run, args=(self.stop,), name="opensky", daemon=True).start()
        threading.Thread(target=self._housekeeping, name="housekeeping", daemon=True).start()

    def _housekeeping(self) -> None:
        last_persist = time.time()
        while not self.stop.wait(MAINTAIN_EVERY_S):
            try:
                self.store.maintain()
                self.store.snapshot()  # prebuild so requests do not pay for it
                if time.time() - last_persist >= PERSIST_EVERY_S:
                    self.store.save(self.snapshot_path)
                    last_persist = time.time()
            except Exception:
                log.exception("housekeeping failed")


def _json(data, status: int = 200) -> Response:
    raw = json.dumps(data, separators=(",", ":")).encode()
    return _body(raw, None, status)


def _body(raw: bytes, gz: bytes | None, status: int = 200, etag: str | None = None) -> Response:
    accepts_gzip = "gzip" in request.headers.get("Accept-Encoding", "")
    if accepts_gzip and (gz is not None or len(raw) > 1024):
        resp = Response(gz if gz is not None else gzip.compress(raw, 5), status, mimetype="application/json")
        resp.headers["Content-Encoding"] = "gzip"
    else:
        resp = Response(raw, status, mimetype="application/json")
    resp.headers["Vary"] = "Accept-Encoding"
    resp.headers["Cache-Control"] = "no-store"
    if etag:
        resp.headers["ETag"] = etag
    return resp


def create_app(config: Config | None = None, session=None, start_feeds: bool = True) -> Flask:
    if not logging.getLogger().handlers:
        logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    cfg = config or Config.from_env()
    rt = Runtime(cfg, session)
    app = Flask(__name__, static_folder=None)
    app.config["RUNTIME"] = rt
    if start_feeds:
        rt.start()

    @app.get("/api/planes")
    def planes():
        rt.opensky.note_client_hit()
        _, raw, gz, etag = rt.store.snapshot()
        if etag in request.if_none_match:
            resp = Response(status=304)
            resp.headers["ETag"] = etag
            resp.headers["Cache-Control"] = "no-store"
            return resp
        return _body(raw, gz, etag=etag)

    @app.get("/api/planes/area")
    def planes_area():
        rt.opensky.note_client_hit()
        lat, lon, r = num(request.args.get("lat")), num(request.args.get("lon")), num(request.args.get("r"))
        if lat is None or lon is None or not (-90 <= lat <= 90 and -180 <= lon <= 180):
            return _json({"error": "lat and lon required"}, 400)
        r = max(1.0, min(MAX_RADIUS_NM, r or 100.0))
        try:
            rt.readsb.refresh_area(lat, lon, r)
        except Exception as exc:
            log.info("area refresh failed: %s", exc)
        return _json(rt.store.area(lat, lon, r))

    @app.get("/api/aircraft/<hx>")
    def aircraft(hx):
        hx = norm_hex(hx)
        if not hx:
            return _json({"error": "invalid hex"}, 400)
        try:
            rt.readsb.refresh_hex(hx)
        except Exception as exc:
            log.info("hex refresh failed: %s", exc)
        with rt.store.lock:
            p = rt.store.get(hx)
            if p is None:
                return _json({"error": "unknown aircraft"}, 404)
            plane, trail = p.as_dict(), [list(pt) for pt in p.trail]
        route = rt.enrich.route(plane["cs"])
        if route:
            route = {**route, "plausible": route_plausible(route, plane["lat"], plane["lon"], plane["gnd"])}
        return _json({"plane": plane, "trail": trail, "aircraft": rt.enrich.aircraft(hx), "route": route,
                      "photo": rt.enrich.photo(hx)})

    @app.get("/api/status")
    def status():
        with rt.store.lock:
            n, v = len(rt.store.planes), rt.store.version
        return _json({"planes": n, "v": v, "t": round(time.time(), 1),
                      "feeds": {"opensky": rt.opensky.status(), **rt.readsb.status()}})

    @app.get("/api/weather")
    def weather():
        lat, lon = num(request.args.get("lat")), num(request.args.get("lon") or request.args.get("lng"))
        if lat is None or lon is None:
            return _json({"error": "lat and lon required"}, 400)
        try:
            return _json(rt.weather.at(lat, lon, num(request.args.get("alt"))))
        except Exception as exc:
            return _json({"error": f"weather unavailable: {exc}"}, 502)

    @app.get("/api/atc/airports")
    def atc_airports():
        return _json(rt.atc.public())

    @app.get("/api/atc/audio")
    def atc_audio():
        feed = rt.atc.resolve(request.args.get("icao", ""), request.args.get("feed"))
        if not feed:
            return _json({"error": "unknown airport or feed"}, 404)
        try:
            upstream = requests.get(feed["url"], headers=AUDIO_HEADERS, timeout=(8, 20), stream=True)
            upstream.raise_for_status()
        except requests.RequestException as exc:
            return _json({"error": f"audio stream unavailable: {exc}"}, 502)

        def generate():
            try:
                for chunk in upstream.iter_content(16384):
                    if chunk:
                        yield chunk
            finally:
                upstream.close()

        resp = Response(stream_with_context(generate()), mimetype=upstream.headers.get("Content-Type", "audio/mpeg"))
        resp.headers["Cache-Control"] = "no-store"
        resp.headers["X-Accel-Buffering"] = "no"
        return resp

    @app.route("/api/<path:_>")
    def api_404(_):
        return _json({"error": "not found"}, 404)

    @app.get("/", defaults={"path": ""})
    @app.get("/<path:path>")
    def static_files(path):
        dist = cfg.web_dist
        if not (dist / "index.html").is_file():
            return Response(PLACEHOLDER, mimetype="text/html")
        if path and (dist / path).is_file():
            resp = send_from_directory(dist, path)
            if HASHED_ASSET.search(path):
                resp.headers["Cache-Control"] = "public, max-age=31536000, immutable"
            return resp
        if path.startswith("assets/"):
            abort(404)
        resp = send_from_directory(dist, "index.html")
        resp.headers["Cache-Control"] = "no-cache"
        return resp

    return app
