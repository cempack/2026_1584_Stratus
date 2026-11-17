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

from . import board
from .airports import Airports
from .atc import AUDIO_HEADERS, AtcCatalog
from .audiohub import AudioHub, Unavailable
from .config import Config
from .enrich import Enricher, observed_departure, reconcile_route
from .feeds.opensky import OpenSkyPoller
from .feeds.readsb import MAX_RADIUS_NM, ReadsbFeed
from .feeds.sweep import Sweeper
from .fr24 import Fr24, Fr24Unavailable
from .metar import BBOX_CAP, ICAO_RE, Metar
from .store import EMERGENCY_SQUAWKS, Store
from .util import make_session, norm_hex, num
from .weather import Weather
from .winds import LEVELS as WIND_LEVELS
from .winds import Winds

log = logging.getLogger(__name__)

PERSIST_EVERY_S = 60.0
MAINTAIN_EVERY_S = 10.0  # also the refresh rate of estimated positions
ROUTE_PREFETCH_EVERY_S = 2.0
FIRST_WAIT_S = 1.5  # max wait for a just-opened plane's aircraft/route/photo lookups
HASHED_ASSET = re.compile(r"[-.][A-Za-z0-9_-]{8,}\.(js|css|woff2?|png|svg|jpg|webp|avif)$")
PLACEHOLDER = (b"<!doctype html><meta charset=utf-8><title>Stratus</title>"
               b"<p>Stratus backend is running. Frontend not built yet (web/dist missing).</p>")


class Runtime:
    def __init__(self, cfg: Config, session=None, clock=time.time):
        self.cfg = cfg
        self.clock = clock
        self.http = session or make_session()
        self.store = Store(clock)
        self.opensky = OpenSkyPoller(cfg, self.store, self.http, clock)
        self.readsb = ReadsbFeed(self.store, self.http, clock=clock)
        self.airports = Airports(self.http, cfg.cache_dir, clock)
        self.fr24 = Fr24(cfg.fr24_token, cfg.fr24_daily_credits, self.http, self.airports,
                         cfg.cache_dir / "fr24-credits.json", clock)
        self.enrich = Enricher(self.http, fr24=self.fr24)
        self.weather = Weather(self.http)
        self.metar = Metar(self.http)
        self.winds = Winds(self.http)
        self.sweeper = Sweeper(self.readsb, self.store, interval=cfg.sweep_interval, clock=clock,
                               enabled=cfg.sweep_enabled)
        self.atc = AtcCatalog(cfg.atc_dir)
        self.audio = AudioHub(AUDIO_HEADERS)
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
        threads = [("opensky", self.opensky.run, (self.stop,)), ("housekeeping", self._housekeeping, ()),
                   ("routes", self._route_prefetch, ()), ("airports", self.airports.ensure, ())]
        if self.cfg.sweep_enabled:
            threads.append(("sweep", self.sweeper.run, (self.stop,)))
        for name, fn, args in threads:
            threading.Thread(target=fn, args=args, name=name, daemon=True).start()

    def _housekeeping(self) -> None:
        last_persist = time.time()
        route_for = self.enrich.cached_route if self.cfg.estimates_enabled else None
        while not self.stop.wait(MAINTAIN_EVERY_S):
            try:
                self.store.maintain(route_for=route_for)
                self.store.snapshot()  # prebuild so requests do not pay for it
                if time.time() - last_persist >= PERSIST_EVERY_S:
                    self.store.save(self.snapshot_path)
                    last_persist = time.time()
            except Exception:
                log.exception("housekeeping failed")

    def _route_prefetch(self) -> None:
        """Rate-limited background route lookups (<= 1.5/s) so estimation has routes before planes vanish."""
        while not self.stop.wait(ROUTE_PREFETCH_EVERY_S):
            try:
                if self.cfg.estimates_enabled and not self.opensky.idle(self.clock()):
                    self.enrich.prefetch(self.store, self.clock(), limit=3)
            except Exception:
                log.exception("route prefetch failed")

    def fr24_refresh_position(self, hx: str, cs: str | None, reg: str | None) -> None:
        """Selected plane is estimated / stale: ask FR24 for a real fix (6 credits, <= 1 per minute per plane)."""
        try:
            obs = self.fr24.position(hx, cs, reg)
            if obs is not None:
                self.store.apply([obs])
        except Fr24Unavailable as exc:
            log.debug("fr24 position skipped: %s", exc.reason)
        except Exception:
            log.exception("fr24 position failed")


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


def _bbox() -> tuple[float, float, float, float] | None:
    """?bbox=south,west,north,east (degrees); None when missing or invalid."""
    parts = request.args.get("bbox", "").split(",")
    vals = [num(x) for x in parts] if len(parts) == 4 else []
    if len(vals) != 4 or None in vals:
        return None
    s_, w, n, e = vals
    if not (-90 <= s_ <= n <= 90 and -180 <= w <= 180 and -180 <= e <= 180):
        return None
    return s_, w, n, e


def create_app(config: Config | None = None, session=None, start_feeds: bool = True, clock=time.time) -> Flask:
    if not logging.getLogger().handlers:
        logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    cfg = config or Config.from_env()
    rt = Runtime(cfg, session, clock)
    app = Flask(__name__, static_folder=None)
    app.config["RUNTIME"] = rt
    if start_feeds:
        rt.start()

    @app.get("/api/planes")
    def planes():
        rt.opensky.note_client_hit()
        _, raw, gz, etag = rt.store.snapshot()
        if etag.strip('"') in request.if_none_match:
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
            fix_lat, fix_lon, est_since, fix_ts, reg = p.lat, p.lon, p.est_since, p.ts, p.reg
        if rt.fr24.enabled and not plane["gnd"] and (plane["est"] or rt.clock() - fix_ts > 60) \
                and rt.fr24.position_due(hx):
            rt.enrich.pool.submit(rt.fr24_refresh_position, hx, plane["cs"], reg)
        route = rt.enrich.route(plane["cs"], selected=True, hx=hx)
        aircraft, photo = rt.enrich.aircraft(hx), rt.enrich.photo(hx)
        if route is None or aircraft is None or photo is None:
            # first look at this plane: lookups were just started; a short wait fills the card in one go
            # (cached afterwards, so later polls never wait; a slow upstream costs at most FIRST_WAIT_S once)
            rt.enrich.wait(hx, plane["cs"], FIRST_WAIT_S)
            route = rt.enrich.route(plane["cs"], selected=True, hx=hx)
            aircraft, photo = rt.enrich.aircraft(hx), rt.enrich.photo(hx)
        departed = observed_departure(trail, rt.airports.nearest) if rt.airports.list else None
        route = reconcile_route(route, departed, fix_lat, fix_lon, plane["gnd"])
        return _json({"plane": plane, "trail": trail, "aircraft": aircraft, "route": route,
                      "photo": photo, "estimated_since": est_since, "fr24": rt.fr24.budget(),
                      "full_track": rt.fr24.full_track_capability()})

    @app.get("/api/aircraft/<hx>/full-track")
    def full_track(hx):
        hx = norm_hex(hx)
        if not hx:
            return _json({"error": "invalid hex"}, 400)
        if not rt.fr24.enabled:
            return _json({"error": "Flightradar24 is not configured", "reason": "disabled", "fr24": None}, 503)
        with rt.store.lock:
            p = rt.store.get(hx)
            cs = p.cs if p else None
        if p is None:
            return _json({"error": "unknown aircraft"}, 404)
        try:
            res = rt.fr24.track(hx, cs)
        except Fr24Unavailable as exc:
            code = 429 if exc.reason in ("budget", "rate") else 503
            return _json({"error": f"Flightradar24 unavailable: {exc.reason}", "reason": exc.reason,
                          "fr24": rt.fr24.budget()}, code)
        if res is None:
            return _json({"error": "no live Flightradar24 flight for this aircraft", "reason": "not_found",
                          "fr24": rt.fr24.budget()}, 404)
        return _json({"hex": hx, **res, "fr24": rt.fr24.budget()})

    @app.get("/api/status")
    def status():
        with rt.store.lock:
            n, v = len(rt.store.planes), rt.store.version
        return _json({"planes": n, "v": v, "t": round(time.time(), 1),
                      "estimated": rt.store.estimated_count(), "alerts": len(rt.store.emergencies()),
                      "feeds": {"opensky": rt.opensky.status(), **rt.readsb.status()},
                      "sweep": rt.sweeper.status(), "fr24": rt.fr24.status()})

    @app.get("/api/alerts")
    def alerts():
        rows = []
        for p in rt.store.emergencies():
            rows.append({"hex": p.hex, "cs": p.cs, "squawk": p.sqk, "kind": EMERGENCY_SQUAWKS[p.sqk],
                         "lat": round(p.lat, 5), "lon": round(p.lon, 5), "alt": p.alt, "gs": p.gs, "trk": p.trk,
                         "vr": p.vr, "gnd": p.gnd, "ts": round(p.ts, 1), "src": p.src, "type": p.type,
                         "reg": p.reg})
        return _json({"t": round(time.time(), 1), "count": len(rows), "alerts": rows})

    @app.get("/api/metar")
    def metar():
        icao, bbox = request.args.get("icao", "").strip(), _bbox()
        if icao:
            if not ICAO_RE.match(icao):
                return _json({"error": "icao must be 4 letters/digits"}, 400)
            m = rt.metar.get(icao)
            return _json({"metar": m}) if m else _json({"error": f"no METAR for {icao.upper()}"}, 404)
        if bbox is None:
            return _json({"error": "icao or bbox=south,west,north,east required"}, 400)
        if not rt.airports.ensure():
            return _json({"error": "airport catalog not loaded yet"}, 503)
        limit = int(max(1, min(BBOX_CAP, num(request.args.get("limit")) or 40)))
        airports = rt.airports.in_bbox(*bbox, limit=limit, types=("large",))
        stations = rt.metar.many([a["icao"] for a in airports])
        return _json({"t": round(time.time(), 1), "count": len(stations), "stations": stations})

    @app.get("/api/winds")
    def winds():
        bbox = _bbox()
        if bbox is None:
            return _json({"error": "bbox=south,west,north,east required"}, 400)
        raw = request.args.get("level", "250").strip().lower()
        level = "surface" if raw == "surface" else (int(raw) if raw.isdigit() else None)
        if level != "surface" and level not in WIND_LEVELS:
            return _json({"error": "level must be one of %s or surface" % sorted(WIND_LEVELS)}, 400)
        try:
            return _json({"t": round(time.time(), 1), **rt.winds.grid(*bbox, level=level)})
        except Exception as exc:
            return _json({"error": f"winds unavailable: {exc}"}, 502)

    @app.get("/api/airports")
    def airports():
        if not rt.airports.ensure():
            return _json({"error": "airport catalog not loaded yet"}, 503)
        limit = int(max(1, min(500, num(request.args.get("limit")) or 20)))
        types = ("large",) if request.args.get("type") == "large" else ("large", "medium")
        q, bbox = request.args.get("q", "").strip(), _bbox()
        if q:
            rows = rt.airports.search(q, limit, types)
        elif bbox:
            rows = rt.airports.in_bbox(*bbox, limit=limit, types=types)
        else:
            rows = rt.airports.in_bbox(-90, -180, 90, 180, limit=limit, types=("large",))
        return _json({"count": len(rows), "airports": rows})

    @app.get("/api/airport/<code>")
    def airport(code):
        if not re.match(r"^[A-Za-z0-9]{3,4}$", code):
            return _json({"error": "invalid airport code"}, 400)
        if not rt.airports.ensure():
            return _json({"error": "airport catalog not loaded yet"}, 503)
        apt = rt.airports.get(code)
        if apt is None:
            return _json({"error": "unknown airport"}, 404)
        now = time.time()
        arrivals, departures = board.build(rt.store, rt.enrich, apt, now)
        try:
            metar_ = rt.metar.get(apt["icao"])
        except Exception:
            metar_ = None
        return _json({"t": round(now, 1), "airport": {**apt, "runways": rt.airports.runways(apt["icao"])},
                      "arrivals": arrivals, "departures": departures, "metar": metar_})

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
            relay = rt.audio.open(feed["url"])
        except Unavailable as exc:
            return _json({"error": f"audio stream unavailable: {exc}"}, 502)

        resp = Response(stream_with_context(relay.stream()), mimetype=relay.content_type)
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
            # no-store: a CDN must not cache a miss during a deploy rollover.
            return Response("not found", 404, {"Cache-Control": "no-store"}, mimetype="text/plain")
        resp = send_from_directory(dist, "index.html")
        resp.headers["Cache-Control"] = "no-cache"
        return resp

    return app
