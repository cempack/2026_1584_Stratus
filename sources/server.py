"""
Stratus backend powered by OpenSky state vectors.

The app keeps a local in-memory cache of aircraft and short trails, polls the
global OpenSky `GET /states/all` endpoint, and falls back to anonymous access
whenever OAuth credentials are missing or temporarily unavailable.
"""

from __future__ import annotations

import atexit
import copy
import gzip
import html
import json
import math
import os
import re
import tempfile
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import quote

import requests
from flask import Flask, Response, jsonify, request, send_from_directory


OPENSKY_STATES_URL = "https://opensky-network.org/api/states/all"
OPENSKY_TOKEN_URL = (
    "https://auth.opensky-network.org/auth/realms/opensky-network/"
    "protocol/openid-connect/token"
)
METEO_URL = "https://api.open-meteo.com/v1/forecast"
ADSBDB_AIRCRAFT_URL = "https://api.adsbdb.com/v0/aircraft/{hex_id}"
ADSBDB_CALLSIGN_URL = "https://api.adsbdb.com/v0/callsign/{callsign}"
LIVEATC_SEARCH_URL = "https://www.liveatc.net/search/"
LIVEATC_STREAM_BASE_URL = "https://d.liveatc.net"
LIVEATC_CACHE_TTL_SECONDS = 6 * 60 * 60

DATA_PROVIDER = "opensky"
DATA_SOURCE_LABEL = "OpenSky Network"
DATA_USER_AGENT = "Stratus-FlightRadar/4.0"
COMMUNITY_URL = "https://openskynetwork.github.io/opensky-api/rest.html"
COMMUNITY_NOTE_FR = "Synchronisation mondiale OpenSky via /states/all avec cache local."
API_KEY_NOTICE_FR = (
    "Aucun API client OpenSky configure. Ouvrez Reglages pour ajouter votre "
    "client_id et client_secret; ils seront stockes dans .env."
)
API_KEY_INVALID_NOTICE_FR = (
    "Les identifiants OpenSky semblent invalides. Ouvrez Reglages pour mettre a jour "
    "le client_id ou le client_secret."
)
API_KEY_RATE_LIMIT_NOTICE_FR = (
    "Le quota OpenSky est temporairement serre. La cadence baisse automatiquement "
    "pour rester sous la limite journaliere."
)
API_KEY_NOTICE_URL = "https://opensky-network.org/my-opensky/account"
PLANESPOTTERS_PHOTO_URL = "https://www.planespotters.net/photos/reg/{registration}"

AUTH_FETCH_INTERVAL = 90.0
ANON_FETCH_INTERVAL = 15 * 60.0
MAX_BALANCED_FETCH_INTERVAL = 30 * 60.0
FETCH_BACKOFF_BASE = 18.0
FETCH_BACKOFF_MAX = 180.0
STALE_TTL = 18 * 60
MAX_TRAIL = 1_500
TRAIL_RETENTION_SECONDS = 4 * 60 * 60
TRAIL_FULL_RES_WINDOW_SECONDS = 25 * 60
TRAIL_COMPRESSED_MIN_SECONDS = 30
WARMUP_OBSERVED_POINTS = 18
WARMUP_MIN_TRAIL_SECONDS = 90
INFERRED_TRAIL_POINTS = 6
INFERRED_STEP_SECONDS = 12
ROUTE_FALLBACK_MIN_DISTANCE_NM = 55
ROUTE_FALLBACK_POINTS = 26
ROUTE_FALLBACK_ASSUMED_KNOTS = 440
HISTORY_MIN_SECONDS = 3
HISTORY_MIN_DISTANCE_M = 220
MAX_RESPONSE_PLANES = 20_000
PHOTO_CACHE_TTL = 12 * 60 * 60
JSON_GZIP_MIN_BYTES = 2_048
TOKEN_REFRESH_MARGIN = 30
CACHE_DIR = Path("data/cache")
CACHE_SNAPSHOT_PATH = CACHE_DIR / "opensky-cache.json.gz"
CACHE_SCHEMA_VERSION = 1
CACHE_PERSIST_INTERVAL = 12.0
CACHE_MIN_WRITE_INTERVAL = 8.0
CACHE_MAX_RESTORE_AGE = 45 * 60
ROOT_ENV_PATH = Path(".env")
PROCESS_STARTED_AT = time.time()
FULL_WORLD_CREDITS = 4

FULL_RESPONSE_FIELDS = (
    "hex",
    "flight",
    "registration",
    "aircraft_type",
    "aircraft_category",
    "aircraft_description",
    "country",
    "time_position",
    "last_contact",
    "lat",
    "lng",
    "alt",
    "alt_baro",
    "alt_geom",
    "gs",
    "trk",
    "baro_rate",
    "squawk",
    "spi",
    "position_source",
    "on_ground",
    "src",
)
COMPACT_RESPONSE_FIELDS = (
    "hex",
    "flight",
    "registration",
    "aircraft_type",
    "aircraft_category",
    "aircraft_description",
    "country",
    "last_contact",
    "lat",
    "lng",
    "alt",
    "alt_baro",
    "gs",
    "trk",
    "baro_rate",
    "position_source",
    "on_ground",
    "src",
)
POSITION_SOURCE_LABELS = {
    0: "ADS-B",
    1: "ASTERIX",
    2: "MLAT",
    3: "FLARM",
}


class OpenSkyRateLimitError(RuntimeError):
    def __init__(self, mode, retry_after=None, response=None):
        self.mode = mode
        self.retry_after = float(retry_after or 0.0)
        self.response = response
        super().__init__(f"{mode} rate limit")


planes = {}
planes_lock = threading.Lock()
poller_lock = threading.Lock()
health_lock = threading.Lock()
photo_lock = threading.Lock()
cache_state_lock = threading.Lock()
credentials_lock = threading.Lock()
token_lock = threading.Lock()

http = requests.Session()
http.headers.update({"User-Agent": DATA_USER_AGENT})

poller_started = False
cache_snapshot_started = False
cache_loaded_from_disk = False
cache_restore_attempted = False
cache_dirty = False
cache_last_saved_at = 0.0
opensky_credentials = None
oauth_token = None
oauth_token_expires_at = 0.0
auth_rate_limited_until = 0.0
anonymous_rate_limited_until = 0.0
auth_warning = None

source_health = {
    "provider": DATA_PROVIDER,
    "state": "starting",
    "degraded": True,
    "rate_limited": False,
    "auth_mode": "anonymous",
    "configured_api_key": False,
    "last_success": 0.0,
    "last_error": None,
    "retry_at": 0.0,
    "backoff_seconds": 0.0,
    "last_request": 0.0,
    "coverage_scope": "global",
    "last_snapshot_count": 0,
    "credits_remaining": None,
    "credits_per_request": FULL_WORLD_CREDITS,
    "poll_interval_seconds": AUTH_FETCH_INTERVAL,
    "using_anonymous_fallback": False,
    "user_message": API_KEY_NOTICE_FR,
}
photo_cache = {}
liveatc_cache = {"airports": [], "fetched_at": 0.0}
liveatc_lock = threading.Lock()

app = Flask(__name__, static_folder=".", static_url_path="")


def clamp(value, minimum, maximum):
    return max(minimum, min(maximum, value))


def wrap_lng(value):
    return ((value + 180.0) % 360.0) - 180.0


def unwrap_lng(reference, value):
    while value - reference > 180.0:
        value -= 360.0
    while value - reference < -180.0:
        value += 360.0
    return value


def haversine_nm(lat1, lng1, lat2, lng2):
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(wrap_lng(lng2 - lng1))
    a = (
        math.sin(dphi / 2) ** 2
        + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2
    )
    return 3440.065 * (2 * math.atan2(math.sqrt(a), math.sqrt(max(0.0, 1 - a))))


def haversine_m(lat1, lng1, lat2, lng2):
    return haversine_nm(lat1, lng1, lat2, lng2) * 1852.0


def clone_trail_point(point):
    return {
        "lat": point["lat"],
        "lng": point["lng"],
        "alt": point.get("alt", 0),
        "ts": point["ts"],
        "kind": point.get("kind", "observed"),
    }


def mark_cache_dirty():
    global cache_dirty
    with cache_state_lock:
        cache_dirty = True


def numeric_or_none(value):
    return value if isinstance(value, (int, float)) else None


def normalize_hex_id(value):
    normalized = (value or "").strip().lower()
    return normalized or None


def normalize_callsign(value):
    normalized = re.sub(r"\s+", "", (value or "").upper())
    return normalized or None


def parse_liveatc_airports_from_search_page(page_text):
    airports = {}
    for value, label in re.findall(
        r'<option[^>]*value="([^"]+)"[^>]*>(.*?)</option>',
        page_text,
        flags=re.IGNORECASE | re.DOTALL,
    ):
        icao = re.sub(r"[^A-Z0-9]", "", value.upper())
        if len(icao) != 4:
            continue
        pretty_label = html.unescape(re.sub(r"<[^>]+>", "", label or "")).strip()
        if not pretty_label:
            continue
        name = pretty_label
        if " - " in pretty_label:
            left, right = pretty_label.split(" - ", 1)
            if left.strip().upper() == icao:
                name = right.strip() or pretty_label
        airport = {
            "icao": icao,
            "label": pretty_label,
            "name": name,
            "city": "",
            "country": "",
            "page_url": f"{LIVEATC_SEARCH_URL}?icao={quote(icao)}",
        }
        airports[icao] = airport
    return sorted(airports.values(), key=lambda item: item["icao"])


def parse_liveatc_stream_id(page_text):
    match = re.search(r"/archive\.php\?m=([a-zA-Z0-9_]+)", page_text)
    if match:
        return match.group(1)
    match = re.search(r"/listen\.php\?m=([a-zA-Z0-9_]+)", page_text)
    if match:
        return match.group(1)
    return None


def get_liveatc_airports(force_refresh=False):
    now = time.time()
    with liveatc_lock:
        cached_airports = list(liveatc_cache.get("airports") or [])
        cached_at = float(liveatc_cache.get("fetched_at") or 0.0)
    if cached_airports and not force_refresh and now - cached_at < LIVEATC_CACHE_TTL_SECONDS:
        return cached_airports, True
    response = http.get(LIVEATC_SEARCH_URL, timeout=(8, 15))
    response.raise_for_status()
    airports = parse_liveatc_airports_from_search_page(response.text)
    if not airports:
        raise ValueError("No LiveATC airports detected")
    with liveatc_lock:
        liveatc_cache["airports"] = airports
        liveatc_cache["fetched_at"] = now
    return airports, False


def meters_to_feet(value):
    numeric = numeric_or_none(value)
    if numeric is None:
        return None
    return round(numeric * 3.28084)


def ms_to_knots(value):
    numeric = numeric_or_none(value)
    if numeric is None:
        return None
    return round(numeric * 1.943844, 2)


def ms_to_fpm(value):
    numeric = numeric_or_none(value)
    if numeric is None:
        return None
    return round(numeric * 196.850394)


def sanitize_env_value(value):
    if value is None:
        return None
    cleaned = value.strip().strip("\"'`")
    cleaned = cleaned.rstrip("»").strip()
    return cleaned or None


def load_simple_env_file(path):
    values = {}
    if not path.exists():
        return values

    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, raw_value = stripped.split("=", 1)
        values[key.strip()] = sanitize_env_value(raw_value)
    return values


def write_simple_env_file(path, values):
    path.parent.mkdir(parents=True, exist_ok=True)
    lines = [
        "# OpenSky API credentials for Stratus",
    ]
    for key in sorted(values.keys()):
        value = sanitize_env_value(values.get(key))
        if value is None:
            continue
        lines.append(f"{key}={value}")
    lines.append("")
    path.write_text("\n".join(lines), encoding="utf-8")


def load_opensky_env_candidates():
    merged = {}
    configured_path = None

    for path in (ROOT_ENV_PATH,):
        values = load_simple_env_file(path)
        if values and configured_path is None:
            configured_path = str(path)
        for key, value in values.items():
            if merged.get(key) is None and value is not None:
                merged[key] = value

    return merged, configured_path


def save_opensky_credentials(client_id=None, client_secret=None, clear=False):
    current = resolve_opensky_credentials(force_reload=True)
    existing = load_simple_env_file(ROOT_ENV_PATH)
    if "OPENSKY_CLIENT_ID" not in existing:
        existing["OPENSKY_CLIENT_ID"] = current.get("client_id")
    if "OPENSKY_CLIENT_SECRET" not in existing:
        existing["OPENSKY_CLIENT_SECRET"] = current.get("client_secret")

    if clear:
        existing.pop("OPENSKY_CLIENT_ID", None)
        existing.pop("OPENSKY_CLIENT_SECRET", None)
    else:
        normalized_client_id = sanitize_env_value(client_id)
        normalized_client_secret = sanitize_env_value(client_secret)

        if normalized_client_id:
            existing["OPENSKY_CLIENT_ID"] = normalized_client_id
        elif "OPENSKY_CLIENT_ID" not in existing:
            existing["OPENSKY_CLIENT_ID"] = None

        if normalized_client_secret:
            existing["OPENSKY_CLIENT_SECRET"] = normalized_client_secret
        elif "OPENSKY_CLIENT_SECRET" not in existing:
            existing["OPENSKY_CLIENT_SECRET"] = None

    filtered = {key: value for key, value in existing.items() if sanitize_env_value(value)}
    if filtered:
        write_simple_env_file(ROOT_ENV_PATH, filtered)
    elif ROOT_ENV_PATH.exists():
        ROOT_ENV_PATH.unlink()

    reset_opensky_auth_state()
    return resolve_opensky_credentials(force_reload=True)


def resolve_opensky_credentials(force_reload=False):
    global opensky_credentials

    with credentials_lock:
        if opensky_credentials is not None and not force_reload:
            return dict(opensky_credentials)

        file_values, configured_path = load_opensky_env_candidates()
        client_id = sanitize_env_value(
            os.environ.get("OPENSKY_CLIENT_ID") or file_values.get("OPENSKY_CLIENT_ID")
        )
        client_secret = sanitize_env_value(
            os.environ.get("OPENSKY_CLIENT_SECRET")
            or file_values.get("OPENSKY_CLIENT_SECRET")
        )

        opensky_credentials = {
            "client_id": client_id,
            "client_secret": client_secret,
            "configured": bool(client_id and client_secret),
            "path": configured_path or str(ROOT_ENV_PATH),
        }
        return dict(opensky_credentials)


def has_api_credentials():
    return resolve_opensky_credentials().get("configured", False)


def reset_opensky_auth_state():
    global opensky_credentials
    global oauth_token, oauth_token_expires_at
    global auth_rate_limited_until, anonymous_rate_limited_until, auth_warning

    opensky_credentials = None
    oauth_token = None
    oauth_token_expires_at = 0.0
    auth_rate_limited_until = 0.0
    anonymous_rate_limited_until = 0.0
    auth_warning = None


def build_user_notice():
    if not has_api_credentials():
        return API_KEY_NOTICE_FR
    if auth_warning == "oauth_credentials_invalid":
        return API_KEY_INVALID_NOTICE_FR
    if auth_warning:
        return API_KEY_RATE_LIMIT_NOTICE_FR
    now = time.time()
    if now < auth_rate_limited_until or now < anonymous_rate_limited_until:
        return API_KEY_RATE_LIMIT_NOTICE_FR
    return None


def public_opensky_settings():
    credentials = resolve_opensky_credentials()
    return {
        "configured": bool(credentials.get("configured")),
        "client_id": credentials.get("client_id"),
        "credential_path": credentials.get("path") or str(ROOT_ENV_PATH),
        "account_url": API_KEY_NOTICE_URL,
    }


def snapshot_health():
    with health_lock:
        health = dict(source_health)
    with planes_lock:
        active_count = len(planes)

    now = time.time()
    health["provider"] = DATA_PROVIDER
    health["last_snapshot_count"] = active_count
    health["cache_loaded_from_disk"] = cache_loaded_from_disk
    health["cache_snapshot_age"] = (
        round(now - cache_last_saved_at, 1) if cache_last_saved_at else None
    )
    health["last_success_age"] = (
        round(now - health["last_success"], 1) if health["last_success"] else None
    )
    health["retry_in"] = (
        round(max(0.0, health["retry_at"] - now), 1) if health.get("retry_at") else 0.0
    )
    health["configured_api_key"] = has_api_credentials()
    health["user_message"] = build_user_notice()
    health["auth_warning"] = auth_warning
    health["credential_path"] = resolve_opensky_credentials().get("path")
    health.update(build_scan_state())
    return health


def set_health(**updates):
    with health_lock:
        source_health.update(updates)


def parse_rate_limit_headers(response):
    remaining = response.headers.get("X-Rate-Limit-Remaining")
    retry_after = response.headers.get("X-Rate-Limit-Retry-After-Seconds")

    remaining_value = None
    if remaining is not None:
        try:
            remaining_value = int(float(remaining))
        except ValueError:
            remaining_value = None

    retry_value = 0.0
    if retry_after is not None:
        try:
            retry_value = float(retry_after)
        except ValueError:
            retry_value = 0.0

    return remaining_value, retry_value


def seconds_until_next_utc_midnight(now=None):
    ts = float(now if now is not None else time.time())
    current = datetime.fromtimestamp(ts, tz=timezone.utc)
    tomorrow = (current + timedelta(days=1)).date()
    midnight = datetime.combine(tomorrow, datetime.min.time(), tzinfo=timezone.utc)
    return max(1.0, (midnight - current).total_seconds())


def compute_balanced_interval(mode, credits_remaining):
    base = AUTH_FETCH_INTERVAL if mode == "oauth" else ANON_FETCH_INTERVAL
    if credits_remaining is None:
        return base

    remaining_world_requests = max(1, int(float(credits_remaining) // FULL_WORLD_CREDITS))
    budget_interval = seconds_until_next_utc_midnight() / remaining_world_requests
    return round(clamp(max(base, budget_interval), base, MAX_BALANCED_FETCH_INTERVAL), 1)


def get_oauth_token(force_refresh=False):
    global oauth_token, oauth_token_expires_at, auth_warning

    credentials = resolve_opensky_credentials()
    if not credentials.get("configured"):
        return None

    now = time.time()
    with token_lock:
        if (
            not force_refresh
            and oauth_token
            and now < max(0.0, oauth_token_expires_at - TOKEN_REFRESH_MARGIN)
        ):
            return oauth_token

        response = http.post(
            OPENSKY_TOKEN_URL,
            data={
                "grant_type": "client_credentials",
                "client_id": credentials["client_id"],
                "client_secret": credentials["client_secret"],
            },
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            timeout=(8, 15),
        )
        if response.status_code in {400, 401, 403}:
            auth_warning = "oauth_credentials_invalid"
        response.raise_for_status()
        payload = response.json()
        oauth_token = payload["access_token"]
        oauth_token_expires_at = now + float(payload.get("expires_in", 1800))
        auth_warning = None
        return oauth_token


def request_states(params, mode, retry_on_401=True):
    headers = {}
    if mode == "oauth":
        token = get_oauth_token(force_refresh=False)
        if not token:
            raise RuntimeError("OpenSky OAuth credentials are unavailable")
        headers["Authorization"] = f"Bearer {token}"

    response = http.get(OPENSKY_STATES_URL, params=params, headers=headers, timeout=(8, 20))
    remaining, retry_after = parse_rate_limit_headers(response)

    if response.status_code == 401 and mode == "oauth" and retry_on_401:
        get_oauth_token(force_refresh=True)
        return request_states(params, mode, retry_on_401=False)

    if response.status_code == 429:
        raise OpenSkyRateLimitError(
            mode,
            retry_after=retry_after or (AUTH_FETCH_INTERVAL if mode == "oauth" else ANON_FETCH_INTERVAL),
            response=response,
        )

    response.raise_for_status()
    payload = response.json()
    poll_interval_seconds = compute_balanced_interval(mode, remaining)
    return payload, {
        "mode": mode,
        "credits_remaining": remaining,
        "credits_per_request": FULL_WORLD_CREDITS,
        "request_interval_seconds": poll_interval_seconds,
    }


def parse_opensky_states(payload, mode):
    payload_time = numeric_or_none(payload.get("time")) or time.time()
    rows = payload.get("states") or []
    entries = []

    for row in rows:
        if not isinstance(row, list) or len(row) < 17:
            continue

        hex_id = normalize_hex_id(row[0])
        lon = numeric_or_none(row[5])
        lat = numeric_or_none(row[6])
        if not hex_id or lat is None or lon is None:
            continue

        baro_altitude_m = numeric_or_none(row[7])
        geo_altitude_m = numeric_or_none(row[13]) if len(row) > 13 else None
        velocity_ms = numeric_or_none(row[9])
        vertical_rate_ms = numeric_or_none(row[11])
        position_source = POSITION_SOURCE_LABELS.get(row[16], "Unknown")
        category = row[17] if len(row) > 17 else None

        altitude_m = geo_altitude_m if geo_altitude_m is not None else baro_altitude_m
        altitude_m = max(0.0, altitude_m or 0.0)

        entries.append(
            {
                "hex": hex_id,
                "flight": (row[1] or "").strip() or None,
                "registration": None,
                "aircraft_type": None,
                "aircraft_category": category,
                "aircraft_description": None,
                "country": row[2] or None,
                "time_position": numeric_or_none(row[3]),
                "last_contact": numeric_or_none(row[4]) or payload_time,
                "lat": lat,
                "lng": wrap_lng(lon),
                "alt": round(altitude_m),
                "alt_baro": meters_to_feet(baro_altitude_m),
                "alt_geom": meters_to_feet(geo_altitude_m),
                "gs": ms_to_knots(velocity_ms),
                "trk": round(row[10], 2) if numeric_or_none(row[10]) is not None else None,
                "baro_rate": ms_to_fpm(vertical_rate_ms),
                "squawk": row[14] or None,
                "spi": bool(row[15]) if row[15] is not None else False,
                "position_source": position_source,
                "on_ground": bool(row[8]),
                "src": DATA_SOURCE_LABEL if mode == "oauth" else f"{DATA_SOURCE_LABEL} (anonyme)",
                "observed_at": payload_time,
            }
        )

    return entries


def build_inferred_segment(entry, anchor_point, points=INFERRED_TRAIL_POINTS, step_s=INFERRED_STEP_SECONDS):
    lat = anchor_point.get("lat")
    lng = anchor_point.get("lng")
    alt = entry.get("alt")
    trk = entry.get("trk")
    gs = entry.get("gs")

    if lat is None or lng is None or alt is None or trk is None or gs is None:
        return []
    if entry.get("on_ground") or gs < 80:
        return []

    gs_ms = gs * 0.514444
    heading_rad = math.radians(trk)
    inferred = []
    base_lng = lng

    for index in range(points, 0, -1):
        dist_m = gs_ms * step_s * index
        cos_lat = max(0.05, math.cos(math.radians(lat)))
        point_lat = lat - (dist_m * math.cos(heading_rad)) / 111_320.0
        point_lng = base_lng - (dist_m * math.sin(heading_rad)) / (111_320.0 * cos_lat)
        inferred.append(
            {
                "lat": point_lat,
                "lng": point_lng,
                "alt": alt,
                "ts": round(anchor_point["ts"] - step_s * index, 3),
                "kind": "inferred",
            }
        )
    return inferred


def should_append_history(trail, entry, observed_at):
    if not trail:
        return True

    last = trail[-1]
    candidate_lng = unwrap_lng(last["lng"], entry["lng"])
    distance_m = haversine_m(last["lat"], last["lng"], entry["lat"], candidate_lng)
    elapsed = observed_at - last["ts"]
    altitude_delta = abs((entry.get("alt") or 0) - (last.get("alt") or 0))

    if distance_m >= HISTORY_MIN_DISTANCE_M:
        return True
    if elapsed >= HISTORY_MIN_SECONDS and (distance_m >= 180 or altitude_delta >= 120):
        return True
    return elapsed >= HISTORY_MIN_SECONDS * 2.5


def prune_trail(trail, newest_ts=None):
    if not trail:
        return

    latest_ts = newest_ts if newest_ts is not None else trail[-1]["ts"]
    cutoff_ts = latest_ts - TRAIL_RETENTION_SECONDS
    full_res_cutoff_ts = latest_ts - TRAIL_FULL_RES_WINDOW_SECONDS

    kept = []
    last_kept_ts = None
    last_index = len(trail) - 1

    for index, point in enumerate(trail):
        point_ts = point.get("ts")
        if point_ts is None or point_ts < cutoff_ts:
            continue

        keep_full_resolution = point_ts >= full_res_cutoff_ts
        is_last_point = index == last_index

        if not kept or keep_full_resolution:
            kept.append(point)
            last_kept_ts = point_ts
            continue

        if is_last_point or point_ts - last_kept_ts >= TRAIL_COMPRESSED_MIN_SECONDS:
            kept.append(point)
            last_kept_ts = point_ts

    if len(kept) > MAX_TRAIL:
        del kept[:-MAX_TRAIL]

    trail[:] = kept


def reconcile_entries(entries):
    changed = False
    seen_hexes = set()
    with planes_lock:
        for entry in entries:
            hex_id = normalize_hex_id(entry.get("hex"))
            if not hex_id:
                continue
            entry["hex"] = hex_id
            seen_hexes.add(hex_id)

            observed_at = numeric_or_none(entry.get("observed_at")) or time.time()
            current_point = {
                "lat": entry["lat"],
                "lng": entry["lng"],
                "alt": entry["alt"],
                "ts": observed_at,
                "kind": "observed",
            }

            if hex_id in planes:
                existing = planes[hex_id]
                trail = existing.setdefault("trail", [])
                if should_append_history(trail, entry, observed_at):
                    if trail:
                        current_point["lng"] = unwrap_lng(trail[-1]["lng"], current_point["lng"])
                    trail.append(current_point)
                    prune_trail(trail, observed_at)
                    changed = True

                for key, value in entry.items():
                    if key in {"trail", "observed_at"}:
                        continue
                    if value is not None and existing.get(key) != value:
                        existing[key] = value
                        changed = True
                existing["ts"] = observed_at
                existing["seen_in_session"] = True
            else:
                new_entry = {k: v for k, v in entry.items() if k != "observed_at"}
                new_entry["trail"] = [current_point]
                new_entry["ts"] = observed_at
                new_entry["seen_in_session"] = True
                planes[hex_id] = new_entry
                changed = True

        removed_hexes = [hex_id for hex_id in planes.keys() if hex_id not in seen_hexes]
        for hex_id in removed_hexes:
            del planes[hex_id]
            changed = True

    if changed:
        mark_cache_dirty()


def clean_stale():
    cutoff = time.time() - STALE_TTL
    removed = False
    with planes_lock:
        stale = [
            hex_id
            for hex_id, plane in planes.items()
            if plane.get("ts", 0) < cutoff
            or (
                plane.get("ts", 0) < PROCESS_STARTED_AT
                and not plane.get("seen_in_session", True)
            )
        ]
        for hex_id in stale:
            del planes[hex_id]
            removed = True
    if removed:
        mark_cache_dirty()


def build_weather_map_points(center_lat, center_lng, span=42.0, rows=3, cols=5):
    lat_span = clamp(float(span), 18.0, 70.0)
    lng_span = lat_span * 1.35
    lat_step = lat_span / max(rows - 1, 1)
    lng_step = lng_span / max(cols - 1, 1)
    snapped_center_lat = round(center_lat / max(lat_step, 1.0)) * lat_step
    snapped_center_lng = round(center_lng / max(lng_step, 1.0)) * lng_step
    lat_origin = snapped_center_lat - lat_step * (rows - 1) / 2
    lng_origin = snapped_center_lng - lng_step * (cols - 1) / 2

    points = []
    for row in range(rows):
        for col in range(cols):
            points.append(
                {
                    "lat": round(clamp(lat_origin + row * lat_step, -70.0, 70.0), 2),
                    "lng": round(wrap_lng(lng_origin + col * lng_step), 2),
                }
            )
    return points


def parse_weather_map_payload(payload, points):
    if isinstance(payload, list):
        weather_points = []
        for item in payload:
            current = item.get("current", {})
            weather_points.append(
                {
                    "lat": item.get("latitude"),
                    "lng": item.get("longitude"),
                    "temperature": current.get("temperature_2m"),
                    "wind_speed": current.get("wind_speed_10m"),
                    "wind_direction": current.get("wind_direction_10m"),
                    "cloud_cover": current.get("cloud_cover"),
                }
            )
        return weather_points

    if len(points) == 1:
        current = payload.get("current", {})
        return [
            {
                "lat": payload.get("latitude", points[0]["lat"]),
                "lng": payload.get("longitude", points[0]["lng"]),
                "temperature": current.get("temperature_2m"),
                "wind_speed": current.get("wind_speed_10m"),
                "wind_direction": current.get("wind_direction_10m"),
                "cloud_cover": current.get("cloud_cover"),
            }
        ]

    return []


def snapshot_state_for_disk():
    with planes_lock:
        planes_copy = copy.deepcopy(planes)
    with health_lock:
        health_copy = copy.deepcopy(source_health)
    with photo_lock:
        photo_copy = copy.deepcopy(photo_cache)

    return {
        "schema_version": CACHE_SCHEMA_VERSION,
        "saved_at": time.time(),
        "planes": planes_copy,
        "source_health": health_copy,
        "photo_cache": photo_copy,
    }


def persist_cache_snapshot(force=False):
    global cache_dirty, cache_last_saved_at

    with cache_state_lock:
        dirty = cache_dirty
        last_saved = cache_last_saved_at

    now = time.time()
    if not force and not dirty:
        return False
    if not force and last_saved and now - last_saved < CACHE_MIN_WRITE_INTERVAL:
        return False

    snapshot = snapshot_state_for_disk()
    CACHE_DIR.mkdir(parents=True, exist_ok=True)

    fd, tmp_path = tempfile.mkstemp(prefix="opensky-cache-", suffix=".json.gz.tmp", dir=str(CACHE_DIR))
    try:
        with os.fdopen(fd, "wb") as raw_stream:
            with gzip.GzipFile(fileobj=raw_stream, mode="wb") as gzip_stream:
                gzip_stream.write(json.dumps(snapshot, separators=(",", ":")).encode("utf-8"))
        os.replace(tmp_path, CACHE_SNAPSHOT_PATH)
    finally:
        if os.path.exists(tmp_path):
            os.unlink(tmp_path)

    with cache_state_lock:
        cache_last_saved_at = snapshot["saved_at"]
        cache_dirty = False
    return True


def load_cache_snapshot():
    global cache_loaded_from_disk, cache_last_saved_at, cache_dirty

    if not CACHE_SNAPSHOT_PATH.exists():
        return False

    try:
        with gzip.open(CACHE_SNAPSHOT_PATH, "rt", encoding="utf-8") as stream:
            snapshot = json.load(stream)
    except Exception:
        return False

    if snapshot.get("schema_version") != CACHE_SCHEMA_VERSION:
        return False

    saved_at = numeric_or_none(snapshot.get("saved_at")) or 0.0
    if saved_at and time.time() - saved_at > CACHE_MAX_RESTORE_AGE:
        return False

    with planes_lock:
        planes.clear()
        for hex_id, plane in (snapshot.get("planes") or {}).items():
            normalized_hex = normalize_hex_id((plane or {}).get("hex") or hex_id)
            if not normalized_hex:
                continue
            normalized_plane = dict(plane or {})
            normalized_plane["hex"] = normalized_hex
            normalized_plane["seen_in_session"] = False
            trail = normalized_plane.get("trail")
            if isinstance(trail, list):
                prune_trail(trail)
            planes[normalized_hex] = normalized_plane

    cached_health = snapshot.get("source_health") or {}
    if cached_health:
        with health_lock:
            source_health.update(cached_health)

    with photo_lock:
        photo_cache.clear()
        photo_cache.update(snapshot.get("photo_cache") or {})

    with cache_state_lock:
        cache_loaded_from_disk = True
        cache_last_saved_at = saved_at
        cache_dirty = False
    return True


def cache_persist_loop():
    while True:
        try:
            persist_cache_snapshot(force=False)
        except Exception as exc:  # pragma: no cover
            print(f"[cache] echec de sauvegarde: {exc}", flush=True)
        time.sleep(CACHE_PERSIST_INTERVAL)


def build_response_trail(plane, selected_hex):
    if plane.get("hex") != selected_hex:
        return []

    return build_selected_plane_payload(plane).get("trail", [])


def build_route_skeleton(route_payload, anchor_point):
    if not route_payload or not anchor_point:
        return []

    origin = route_payload.get("origin") or {}
    midpoint = route_payload.get("midpoint") or {}
    anchor_lat = numeric_or_none(anchor_point.get("lat"))
    anchor_lng = numeric_or_none(anchor_point.get("lng"))
    if anchor_lat is None or anchor_lng is None:
        return []

    skeleton = []
    start_lat = numeric_or_none(origin.get("latitude"))
    start_lng = numeric_or_none(origin.get("longitude"))
    if start_lat is not None and start_lng is not None:
        skeleton.append({"lat": start_lat, "lng": start_lng})

    mid_lat = numeric_or_none(midpoint.get("latitude"))
    mid_lng = numeric_or_none(midpoint.get("longitude"))
    if mid_lat is not None and mid_lng is not None and skeleton:
        start = skeleton[0]
        distance_to_anchor = haversine_nm(
            start["lat"], start["lng"], anchor_lat, anchor_lng
        )
        distance_to_mid = haversine_nm(start["lat"], start["lng"], mid_lat, mid_lng)
        distance_mid_to_anchor = haversine_nm(mid_lat, mid_lng, anchor_lat, anchor_lng)
        if (
            distance_to_mid > 18
            and distance_mid_to_anchor > 18
            and distance_to_mid <= distance_to_anchor * 1.25
        ):
            skeleton.append({"lat": mid_lat, "lng": mid_lng})

    skeleton.append({"lat": anchor_lat, "lng": anchor_lng})
    if len(skeleton) < 2:
        return []

    unwrapped = [dict(skeleton[0])]
    for point in skeleton[1:]:
        unwrapped.append(
            {
                "lat": point["lat"],
                "lng": unwrap_lng(unwrapped[-1]["lng"], point["lng"]),
            }
        )
    return unwrapped


def build_route_fallback_segment(route_payload, anchor_point):
    skeleton = build_route_skeleton(route_payload, anchor_point)
    if len(skeleton) < 2:
        return []

    anchor_alt = numeric_or_none(anchor_point.get("alt")) or 0
    anchor_ts = numeric_or_none(anchor_point.get("ts")) or time.time()
    leg_distances = []
    total_distance_nm = 0.0

    for index in range(len(skeleton) - 1):
        start = skeleton[index]
        end = skeleton[index + 1]
        distance_nm = haversine_nm(start["lat"], start["lng"], end["lat"], end["lng"])
        leg_distances.append(distance_nm)
        total_distance_nm += distance_nm

    if total_distance_nm <= 0:
        return []

    duration_seconds = clamp(
        (total_distance_nm / ROUTE_FALLBACK_ASSUMED_KNOTS) * 3600.0,
        8 * 60.0,
        TRAIL_RETENTION_SECONDS - 5 * 60.0,
    )
    point_budget = int(
        clamp(
            round(max(total_distance_nm, ROUTE_FALLBACK_MIN_DISTANCE_NM) / 85.0) + 6,
            6,
            ROUTE_FALLBACK_POINTS,
        )
    )

    route_points = []
    traversed_nm = 0.0
    points_used = 0
    for leg_index, distance_nm in enumerate(leg_distances):
        start = skeleton[leg_index]
        end = skeleton[leg_index + 1]
        remaining_legs = len(leg_distances) - leg_index
        remaining_points = max(2, point_budget - points_used)
        if leg_index == len(leg_distances) - 1:
            steps = remaining_points
        else:
            ratio = distance_nm / total_distance_nm if total_distance_nm else 0
            steps = int(clamp(round(point_budget * ratio), 2, remaining_points - (remaining_legs - 1)))

        start_step = 0 if not route_points else 1
        for step in range(start_step, steps + 1):
            t = step / steps
            progress = (traversed_nm + distance_nm * t) / total_distance_nm
            altitude = anchor_alt * min(1.0, max(0.0, (progress - 0.08) / 0.72))
            route_points.append(
                {
                    "lat": round(start["lat"] + (end["lat"] - start["lat"]) * t, 6),
                    "lng": round(start["lng"] + (end["lng"] - start["lng"]) * t, 6),
                    "alt": round(altitude, 2),
                    "ts": round(anchor_ts - duration_seconds * (1.0 - progress), 3),
                    "kind": "route",
                }
            )

        traversed_nm += distance_nm
        points_used = len(route_points)

    return route_points


def resolve_route_payload_for_plane(plane):
    route_payload = lookup_adsbdb_flightroute(plane.get("flight"), use_cache=False)
    if route_payload and not route_payload.get("error"):
        return route_payload
    return None


def build_selected_plane_payload(plane):
    adsbdb_payload = lookup_adsbdb_aircraft(plane.get("hex"), use_cache=False)
    if adsbdb_payload and not adsbdb_payload.get("error"):
        for key in (
            "mode_s",
            "registration",
            "manufacturer",
            "aircraft_model",
            "aircraft_type",
            "aircraft_description",
            "owner",
            "operator_code",
            "country",
        ):
            if adsbdb_payload.get(key):
                plane[key] = adsbdb_payload.get(key)

    observed = [clone_trail_point(point) for point in plane.get("trail", [])[-MAX_TRAIL:]]
    observed_span = observed[-1]["ts"] - observed[0]["ts"] if len(observed) >= 2 else 0.0
    needs_fallback = (
        len(observed) < WARMUP_OBSERVED_POINTS or observed_span < WARMUP_MIN_TRAIL_SECONDS
    )

    current_anchor = None
    if plane.get("lat") is not None and plane.get("lng") is not None:
        current_anchor = {
            "lat": plane.get("lat"),
            "lng": plane.get("lng"),
            "alt": plane.get("alt") or 0,
            "ts": numeric_or_none(plane.get("ts")) or time.time(),
            "kind": "observed",
        }

    route_payload = resolve_route_payload_for_plane(plane)
    anchor_point = current_anchor if route_payload and current_anchor else (observed[0] if observed else current_anchor)

    route_prefix = build_route_fallback_segment(route_payload, anchor_point)
    if route_payload and route_prefix:
        trail = route_prefix + ([anchor_point] if anchor_point else [])
    elif not observed:
        trail = route_prefix + ([anchor_point] if anchor_point else [])
    else:
        inferred = build_inferred_segment(plane, observed[0]) if needs_fallback and not route_prefix else []
        trail = route_prefix + inferred + observed

    payload = {
        "trail": trail,
    }
    for key in (
        "mode_s",
        "registration",
        "manufacturer",
        "aircraft_model",
        "aircraft_type",
        "aircraft_description",
        "owner",
        "operator_code",
        "country",
    ):
        if plane.get(key):
            payload[key] = plane.get(key)
    if route_payload:
        payload["route_origin"] = route_payload.get("origin")
        payload["route_destination"] = route_payload.get("destination")
        payload["route_source"] = route_payload.get("source")
    return payload


def serialize_plane_for_response(plane, selected_hex):
    fields = FULL_RESPONSE_FIELDS if plane.get("hex") == selected_hex else COMPACT_RESPONSE_FIELDS
    payload = {field: plane.get(field) for field in fields if plane.get(field) is not None}
    if plane.get("hex") == selected_hex:
        payload.update(build_selected_plane_payload(plane))
    else:
        payload["trail"] = []
    return payload


def json_response(data):
    payload = json.dumps(data, separators=(",", ":"), ensure_ascii=False)
    accepts_gzip = "gzip" in (request.headers.get("Accept-Encoding") or "").lower()
    if accepts_gzip and len(payload) >= JSON_GZIP_MIN_BYTES:
        compressed = gzip.compress(payload.encode("utf-8"), compresslevel=5)
        response = Response(compressed, mimetype="application/json")
        response.headers["Content-Encoding"] = "gzip"
        response.headers["Content-Length"] = str(len(compressed))
        response.headers["Vary"] = "Accept-Encoding"
        return response

    response = Response(payload, mimetype="application/json")
    response.headers["Content-Length"] = str(len(payload.encode("utf-8")))
    response.headers["Vary"] = "Accept-Encoding"
    return response


def build_ranked_planes(limit, selected_hex=None):
    with planes_lock:
        candidates = [dict(plane) for plane in planes.values()]

    if not candidates:
        return []

    limit = max(0, min(limit, len(candidates)))
    candidates.sort(
        key=lambda plane: (
            plane.get("hex") == selected_hex,
            plane.get("ts", 0.0),
            not plane.get("on_ground", False),
            plane.get("gs") or 0.0,
        ),
        reverse=True,
    )
    return [
        serialize_plane_for_response(plane, selected_hex)
        for plane in candidates[:limit]
    ]


def record_success(meta):
    set_health(
        state="live",
        degraded=False,
        rate_limited=False,
        auth_mode=meta["mode"],
        configured_api_key=has_api_credentials(),
        last_success=time.time(),
        last_error=None,
        retry_at=0.0,
        backoff_seconds=0.0,
        coverage_scope=meta.get("coverage_scope", "global"),
        last_snapshot_count=meta.get("snapshot_count", 0),
        credits_remaining=meta.get("credits_remaining"),
        credits_per_request=meta.get("credits_per_request", FULL_WORLD_CREDITS),
        poll_interval_seconds=meta.get("request_interval_seconds", pick_interval()),
        using_anonymous_fallback=meta.get("using_anonymous_fallback", False),
        user_message=build_user_notice(),
    )


def record_failure(exc, retry_at, backoff_seconds, rate_limited=False):
    set_health(
        state="rate_limited" if rate_limited else "degraded",
        degraded=True,
        rate_limited=rate_limited,
        configured_api_key=has_api_credentials(),
        last_error=str(exc),
        retry_at=retry_at,
        backoff_seconds=round(backoff_seconds, 2),
        user_message=build_user_notice(),
    )


def pick_interval():
    with health_lock:
        current = source_health.get("poll_interval_seconds")
        auth_mode = source_health.get("auth_mode")

    if isinstance(current, (int, float)) and current > 0:
        return float(current)
    if auth_mode == "oauth" and has_api_credentials() and time.time() >= auth_rate_limited_until:
        return AUTH_FETCH_INTERVAL
    return ANON_FETCH_INTERVAL


def build_scan_state():
    live = bool(source_health.get("last_success"))
    with planes_lock:
        last_snapshot_count = len(planes)
    return {
        "scan_phase": "live" if live else "bootstrapping",
        "scan_label": "Flux mondial OpenSky actif" if live else "Initialisation du flux mondial OpenSky",
        "session_validation_percent": 100 if live else 0,
        "zone_pending_points": [],
        "zone_loading_points": [],
        "last_snapshot_count": last_snapshot_count,
    }


def fetch_global_states():
    global auth_rate_limited_until, anonymous_rate_limited_until, auth_warning

    params = {
        "extended": 1,
    }

    attempts = []
    now = time.time()

    if has_api_credentials() and now >= auth_rate_limited_until:
        try:
            payload, meta = request_states(params, "oauth")
            auth_warning = None
            return payload, meta
        except OpenSkyRateLimitError as exc:
            auth_rate_limited_until = time.time() + max(1.0, exc.retry_after or AUTH_FETCH_INTERVAL)
            attempts.append(exc)
        except Exception as exc:
            auth_warning = str(exc)
            attempts.append(exc)

    if now >= anonymous_rate_limited_until:
        try:
            payload, meta = request_states(params, "anonymous")
            return payload, meta
        except OpenSkyRateLimitError as exc:
            anonymous_rate_limited_until = time.time() + max(1.0, exc.retry_after or ANON_FETCH_INTERVAL)
            attempts.append(exc)
        except Exception as exc:
            attempts.append(exc)

    if attempts:
        for exc in attempts:
            if isinstance(exc, OpenSkyRateLimitError):
                raise exc
        raise attempts[-1]
    raise RuntimeError("OpenSky access is cooling down")


def fetch_states_cycle():
    payload, meta = fetch_global_states()
    entries = parse_opensky_states(payload, meta["mode"])
    using_anonymous_fallback = has_api_credentials() and meta["mode"] == "anonymous"
    return entries, {
        "mode": meta["mode"],
        "coverage_scope": "global",
        "snapshot_count": len(entries),
        "credits_remaining": meta.get("credits_remaining"),
        "credits_per_request": meta.get("credits_per_request", FULL_WORLD_CREDITS),
        "using_anonymous_fallback": using_anonymous_fallback,
        "request_interval_seconds": meta.get("request_interval_seconds", pick_interval()),
    }
 

def opensky_fetch_loop():
    backoff_seconds = 0.0

    while True:
        wait_for = max(0.0, backoff_seconds)
        if wait_for:
            time.sleep(wait_for)

        started_at = time.time()
        try:
            entries, meta = fetch_states_cycle()
            reconcile_entries(entries)
            clean_stale()
            set_health(last_request=time.time())
            record_success(meta)
            backoff_seconds = 0.0
        except OpenSkyRateLimitError as exc:  # pragma: no cover
            retry_after = max(1.0, exc.retry_after or pick_interval())
            retry_at = time.time() + retry_after
            record_failure(exc, retry_at, retry_after, rate_limited=True)
            backoff_seconds = min(retry_after, FETCH_BACKOFF_MAX)
        except Exception as exc:  # pragma: no cover
            next_backoff = backoff_seconds * 1.8 if backoff_seconds else FETCH_BACKOFF_BASE
            backoff_seconds = clamp(next_backoff, FETCH_BACKOFF_BASE, FETCH_BACKOFF_MAX)
            retry_at = time.time() + backoff_seconds
            record_failure(exc, retry_at, backoff_seconds, rate_limited=False)

        elapsed = time.time() - started_at
        time.sleep(max(0.0, pick_interval() - elapsed))


def bootstrap_initial_snapshot():
    with planes_lock:
        if planes:
            return

    entries, meta = fetch_states_cycle()
    reconcile_entries(entries)
    clean_stale()
    set_health(last_request=time.time())
    record_success(meta)


def photo_cache_get(key):
    with photo_lock:
        cached = photo_cache.get(key)
        if cached and time.time() - cached["cached_at"] < PHOTO_CACHE_TTL:
            return copy.deepcopy(cached["payload"])
    return None


def photo_cache_put(key, payload):
    with photo_lock:
        photo_cache[key] = {
            "cached_at": time.time(),
            "payload": copy.deepcopy(payload),
        }


def normalize_model_key(icao_type=None, manufacturer=None, aircraft_type=None):
    parts = [
        sanitize_env_value((icao_type or "").upper()),
        sanitize_env_value((manufacturer or "").upper()),
        sanitize_env_value((aircraft_type or "").upper()),
    ]
    parts = [part for part in parts if part]
    return "::".join(parts) or None


def build_adsbdb_payload(aircraft):
    if not aircraft:
        return None

    registration = sanitize_env_value(aircraft.get("registration"))
    manufacturer = sanitize_env_value(aircraft.get("manufacturer"))
    aircraft_type = sanitize_env_value(aircraft.get("icao_type"))
    description = sanitize_env_value(aircraft.get("type"))
    image_url = sanitize_env_value(
        aircraft.get("url_photo_thumbnail") or aircraft.get("url_photo")
    )
    title_parts = [manufacturer, description or aircraft_type, registration]
    title = " · ".join(part for part in title_parts if part)
    model_key = normalize_model_key(aircraft_type, manufacturer, description)

    return {
        "mode_s": sanitize_env_value(aircraft.get("mode_s")),
        "registration": registration,
        "manufacturer": manufacturer,
        "aircraft_model": description,
        "aircraft_type": aircraft_type,
        "aircraft_description": (
            " ".join(part for part in [manufacturer, description] if part) or None
        ),
        "owner": sanitize_env_value(aircraft.get("registered_owner")),
        "operator_code": sanitize_env_value(
            aircraft.get("registered_owner_operator_flag_code")
        ),
        "country": sanitize_env_value(aircraft.get("registered_owner_country_name")),
        "thumbnail_url": image_url,
        "page_url": sanitize_env_value(aircraft.get("url_photo")) or image_url,
        "title": title or registration or aircraft_type or "Avion",
        "model_key": model_key,
    }


def build_adsbdb_airport_payload(airport):
    if not airport:
        return None

    latitude = numeric_or_none(airport.get("latitude"))
    longitude = numeric_or_none(airport.get("longitude"))
    icao_code = sanitize_env_value(airport.get("icao_code"))
    if latitude is None or longitude is None or not icao_code:
        return None

    return {
        "icao_code": icao_code,
        "iata_code": sanitize_env_value(airport.get("iata_code")),
        "name": sanitize_env_value(airport.get("name")),
        "municipality": sanitize_env_value(airport.get("municipality")),
        "country_name": sanitize_env_value(airport.get("country_name")),
        "country_iso_name": sanitize_env_value(airport.get("country_iso_name")),
        "latitude": round(latitude, 6),
        "longitude": round(longitude, 6),
    }


def build_adsbdb_flightroute_payload(flightroute):
    if not flightroute:
        return None

    origin = build_adsbdb_airport_payload(flightroute.get("origin"))
    destination = build_adsbdb_airport_payload(flightroute.get("destination"))
    midpoint = build_adsbdb_airport_payload(flightroute.get("midpoint"))
    if not origin and not destination:
        return None

    return {
        "callsign": normalize_callsign(flightroute.get("callsign")),
        "callsign_icao": normalize_callsign(flightroute.get("callsign_icao")),
        "callsign_iata": normalize_callsign(flightroute.get("callsign_iata")),
        "origin": origin,
        "midpoint": midpoint,
        "destination": destination,
        "source": "ADSBDB",
    }


def lookup_adsbdb_aircraft(hex_id, use_cache=True):
    normalized_hex = normalize_hex_id(hex_id)
    if not normalized_hex:
        return None

    cache_key = f"adsbdb:{normalized_hex}"
    if use_cache:
        cached = photo_cache_get(cache_key)
        if cached is not None:
            return cached

    try:
        response = http.get(
            ADSBDB_AIRCRAFT_URL.format(hex_id=normalized_hex),
            timeout=(8, 15),
        )
        response.raise_for_status()
        payload = response.json()
        aircraft = (payload.get("response") or {}).get("aircraft") or {}
        result = build_adsbdb_payload(aircraft)
    except Exception as exc:
        result = {
            "error": str(exc),
        }

    if use_cache:
        photo_cache_put(cache_key, result)
    return copy.deepcopy(result)


def lookup_adsbdb_flightroute(callsign, use_cache=True):
    normalized_callsign = normalize_callsign(callsign)
    if not normalized_callsign:
        return None

    cache_key = f"flightroute:{normalized_callsign}"
    if use_cache:
        cached = photo_cache_get(cache_key)
        if cached is not None:
            return cached

    try:
        response = http.get(
            ADSBDB_CALLSIGN_URL.format(callsign=quote(normalized_callsign)),
            timeout=(8, 15),
        )
        if response.status_code == 404:
            result = {"callsign": normalized_callsign, "error": "unknown callsign"}
        else:
            response.raise_for_status()
            payload = response.json()
            flightroute = (payload.get("response") or {}).get("flightroute") or {}
            result = build_adsbdb_flightroute_payload(flightroute) or {
                "callsign": normalized_callsign,
                "error": "route unavailable",
            }
    except Exception as exc:
        result = {
            "callsign": normalized_callsign,
            "error": str(exc),
        }

    if use_cache:
        photo_cache_put(cache_key, result)
    return copy.deepcopy(result)


def planespotters_fallback(registration):
    return {
        "status": "unavailable",
        "match_level": "generic",
        "thumbnail_url": None,
        "page_url": PLANESPOTTERS_PHOTO_URL.format(registration=quote(registration)),
        "credit": "Photos via Planespotters.net",
        "reason": "thumbnail_unavailable",
    }


def lookup_planespotters_photo(registration):
    registration = (registration or "").strip().upper()
    if not registration:
        return planespotters_fallback("")

    cache_key = f"planespotters:{registration}"
    cached = photo_cache_get(cache_key)
    if cached is not None:
        return cached

    result = planespotters_fallback(registration)
    url = result["page_url"]
    try:
        response = http.get(
            url,
            timeout=(8, 15),
            headers={
                "User-Agent": (
                    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36"
                )
            },
        )
        html = response.text or ""
        if response.status_code in {403, 429} or "cf_chl_opt" in html or "Just a moment" in html:
            result["status"] = "blocked"
            result["reason"] = "challenge"
        else:
            image_match = re.search(
                r'property=["\']og:image["\'][^>]*content=["\']([^"\']+)["\']',
                html,
                re.IGNORECASE,
            )
            if image_match:
                result["status"] = "ok"
                result["match_level"] = "exact"
                result["thumbnail_url"] = image_match.group(1)
                title_match = re.search(
                    r'property=["\']og:title["\'][^>]*content=["\']([^"\']+)["\']',
                    html,
                    re.IGNORECASE,
                )
                if title_match:
                    result["title"] = title_match.group(1)
            else:
                result["status"] = "unavailable"
    except Exception as exc:
        result["status"] = "error"
        result["reason"] = str(exc)

    photo_cache_put(cache_key, result)
    return copy.deepcopy(result)


def build_same_model_payload(payload):
    result = copy.deepcopy(payload)
    result["status"] = "ok"
    result["match_level"] = "model"
    result["credit"] = "Photo d'un appareil du meme modele via ADSBDB / Airport-Data.com"
    if result.get("title"):
        result["title"] = f"{result['title']} (meme modele)"
    return result


def lookup_aircraft_photo(hex_id=None, registration=None):
    normalized_hex = normalize_hex_id(hex_id)
    normalized_registration = (registration or "").strip().upper() or None
    request_key = f"photo:{normalized_hex or '-'}:{normalized_registration or '-'}"
    cached = photo_cache_get(request_key)
    if cached is not None:
        return cached

    result = planespotters_fallback(normalized_registration or "")
    adsbdb = lookup_adsbdb_aircraft(normalized_hex) if normalized_hex else None
    if adsbdb and not adsbdb.get("error"):
        result.update(
            {
                key: adsbdb.get(key)
                for key in (
                    "mode_s",
                    "registration",
                    "manufacturer",
                    "aircraft_model",
                    "aircraft_type",
                    "aircraft_description",
                    "owner",
                    "operator_code",
                    "country",
                    "model_key",
                )
                if adsbdb.get(key)
            }
        )
        normalized_registration = result.get("registration") or normalized_registration

        if adsbdb.get("thumbnail_url"):
            result.update(
                {
                    "status": "ok",
                    "match_level": "exact",
                    "thumbnail_url": adsbdb.get("thumbnail_url"),
                    "page_url": adsbdb.get("page_url"),
                    "title": adsbdb.get("title"),
                    "credit": "Photo exacte via ADSBDB / Airport-Data.com",
                }
            )
            if result.get("model_key"):
                photo_cache_put(
                    f"model:{result['model_key']}",
                    build_same_model_payload(result),
                )
            photo_cache_put(request_key, result)
            return copy.deepcopy(result)

    if normalized_registration:
        exact_result = lookup_planespotters_photo(normalized_registration)
        result.update(
            {
                key: exact_result.get(key)
                for key in (
                    "status",
                    "match_level",
                    "thumbnail_url",
                    "page_url",
                    "credit",
                    "reason",
                    "title",
                )
                if exact_result.get(key) is not None
            }
        )
        if result.get("status") == "ok" and result.get("model_key"):
            photo_cache_put(
                f"model:{result['model_key']}",
                build_same_model_payload(result),
            )
            photo_cache_put(request_key, result)
            return copy.deepcopy(result)

    model_key = result.get("model_key")
    if model_key:
        model_payload = photo_cache_get(f"model:{model_key}")
        if model_payload is not None:
            model_payload.update(
                {
                    key: result.get(key)
                    for key in (
                        "mode_s",
                        "registration",
                        "manufacturer",
                        "aircraft_model",
                        "aircraft_type",
                        "aircraft_description",
                        "owner",
                        "operator_code",
                        "country",
                        "model_key",
                    )
                    if result.get(key)
                }
            )
            photo_cache_put(request_key, model_payload)
            return copy.deepcopy(model_payload)

    photo_cache_put(request_key, result)
    return copy.deepcopy(result)


def start_pollers():
    global poller_started, cache_snapshot_started, cache_restore_attempted
    with poller_lock:
        if not cache_restore_attempted:
            load_cache_snapshot()
            cache_restore_attempted = True

        with planes_lock:
            has_planes = bool(planes)
        if not has_planes:
            try:
                bootstrap_initial_snapshot()
            except Exception:
                pass

        if not cache_snapshot_started:
            cache_worker = threading.Thread(target=cache_persist_loop, daemon=True)
            cache_worker.start()
            cache_snapshot_started = True

        if poller_started:
            return

        worker = threading.Thread(target=opensky_fetch_loop, daemon=True)
        worker.start()
        poller_started = True


@app.before_request
def ensure_pollers():
    if request.endpoint in {"static"}:
        return
    start_pollers()


@app.route("/")
def index():
    return send_from_directory(".", "index.html")


@app.route("/api/flights")
def api_flights():
    selected_hex = (request.args.get("selected") or "").strip().lower() or None

    with planes_lock:
        total_count = len(planes)
    response_planes = build_ranked_planes(
        min(MAX_RESPONSE_PLANES, total_count if total_count else MAX_RESPONSE_PLANES),
        selected_hex=selected_hex,
    )
    health = snapshot_health()

    return json_response(
        {
            "flights": response_planes,
            "count": total_count,
            "returned": len(response_planes),
            "sources": [DATA_SOURCE_LABEL],
            "updated": health.get("last_success", 0.0),
            "health": health,
            "error": health.get("last_error"),
            "coverage_note": COMMUNITY_NOTE_FR,
            "coverage_note_url": COMMUNITY_URL,
            "notice_message": health.get("user_message"),
            "notice_url": API_KEY_NOTICE_URL,
        }
    )


@app.route("/api/trajectory")
def api_trajectory():
    hex_id = normalize_hex_id(request.args.get("hex"))
    if not hex_id:
        return jsonify({"error": "hex required"}), 400

    with planes_lock:
        plane = dict(planes.get(hex_id) or {})

    if not plane:
        return jsonify({"error": "plane not found"}), 404

    requested_callsign = normalize_callsign(request.args.get("flight"))
    if requested_callsign:
        plane["flight"] = requested_callsign

    payload = build_selected_plane_payload(plane)
    payload["hex"] = hex_id
    return json_response(payload)


@app.route("/api/liveatc/airports")
def api_liveatc_airports():
    refresh = (request.args.get("refresh") or "").strip().lower() in {"1", "true", "yes"}
    try:
        airports, from_cache = get_liveatc_airports(force_refresh=refresh)
    except Exception as exc:
        with liveatc_lock:
            fallback = list(liveatc_cache.get("airports") or [])
        if fallback:
            return json_response(
                {
                    "airports": fallback,
                    "cached": True,
                    "warning": f"LiveATC indisponible: {exc}",
                }
            )
        return jsonify({"error": f"LiveATC indisponible: {exc}"}), 502
    return json_response({"airports": airports, "cached": from_cache})


@app.route("/api/liveatc/stream")
def api_liveatc_stream():
    icao = re.sub(r"[^A-Z0-9]", "", (request.args.get("icao") or "").upper())
    if len(icao) != 4:
        return jsonify({"error": "Invalid ICAO code"}), 400
    page_url = f"{LIVEATC_SEARCH_URL}?icao={quote(icao)}"
    try:
        response = http.get(page_url, timeout=(8, 15))
        response.raise_for_status()
    except requests.RequestException as exc:
        return jsonify({"error": f"LiveATC indisponible: {exc}"}), 502
    feed_id = parse_liveatc_stream_id(response.text)
    if not feed_id:
        return jsonify({"error": f"Aucun flux actif trouvé pour {icao}", "icao": icao}), 404
    return json_response(
        {
            "icao": icao,
            "feed_id": feed_id,
            "stream_url": f"{LIVEATC_STREAM_BASE_URL}/{feed_id}",
            "page_url": page_url,
        }
    )


@app.route("/api/settings/opensky", methods=["GET", "POST", "DELETE"])
def api_opensky_settings():
    if request.method == "GET":
        return jsonify(public_opensky_settings())

    if request.method == "DELETE":
        save_opensky_credentials(clear=True)
        set_health(
            configured_api_key=False,
            poll_interval_seconds=ANON_FETCH_INTERVAL,
            user_message=build_user_notice(),
        )
        return jsonify(
            {
                "ok": True,
                "settings": public_opensky_settings(),
                "health": snapshot_health(),
            }
        )

    payload = request.get_json(silent=True) or {}
    client_id = sanitize_env_value(payload.get("client_id"))
    client_secret = sanitize_env_value(payload.get("client_secret"))

    current = resolve_opensky_credentials(force_reload=True)
    if not client_id and not current.get("client_id"):
        return jsonify({"error": "client_id required"}), 400
    if not client_secret and not current.get("client_secret"):
        return jsonify({"error": "client_secret required"}), 400

    save_opensky_credentials(client_id=client_id, client_secret=client_secret)

    error = None
    try:
        get_oauth_token(force_refresh=True)
    except Exception as exc:
        error = str(exc)
        if auth_warning is None:
            set_health(user_message=build_user_notice())

    set_health(
        configured_api_key=has_api_credentials(),
        poll_interval_seconds=AUTH_FETCH_INTERVAL if has_api_credentials() else ANON_FETCH_INTERVAL,
        user_message=build_user_notice(),
    )

    response_payload = {
        "ok": error is None,
        "settings": public_opensky_settings(),
        "health": snapshot_health(),
    }
    if error is not None:
        response_payload["error"] = error
        return jsonify(response_payload), 400
    return jsonify(response_payload)


@app.route("/api/aircraft-photo")
def api_aircraft_photo():
    hex_id = request.args.get("hex", "").strip()
    registration = request.args.get("registration", "").strip()
    if not registration and not hex_id:
        return jsonify({"error": "registration or hex required"}), 400
    return jsonify(lookup_aircraft_photo(hex_id=hex_id, registration=registration))


@app.route("/api/weather")
def api_weather():
    lat = request.args.get("lat")
    lng = request.args.get("lng")
    if not lat or not lng:
        return jsonify({"error": "lat and lng required"}), 400

    try:
        response = http.get(
            METEO_URL,
            params={
                "latitude": lat,
                "longitude": lng,
                "current": "temperature_2m,wind_speed_10m,wind_direction_10m,cloud_cover",
                "timezone": "auto",
            },
            timeout=8,
        )
        response.raise_for_status()
        return jsonify(response.json())
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500


@app.route("/api/weather-map")
def api_weather_map():
    lat = request.args.get("lat", type=float)
    lng = request.args.get("lng", type=float)
    span = request.args.get("span", default=42.0, type=float)
    if lat is None or lng is None:
        return jsonify({"error": "lat and lng required"}), 400

    try:
        points = build_weather_map_points(lat, lng, span=span)
        response = http.get(
            METEO_URL,
            params={
                "latitude": ",".join(str(point["lat"]) for point in points),
                "longitude": ",".join(str(point["lng"]) for point in points),
                "current": "temperature_2m,wind_speed_10m,wind_direction_10m,cloud_cover",
                "timezone": "auto",
            },
            timeout=15,
        )
        response.raise_for_status()
        payload = response.json()
        return jsonify({"points": parse_weather_map_payload(payload, points)})
    except Exception as exc:
        return jsonify({"error": str(exc), "points": []}), 500


atexit.register(lambda: persist_cache_snapshot(force=True))


if __name__ == "__main__":
    print("=" * 50)
    print("  Stratus -- Starting OpenSky server")
    print("=" * 50)

    start_pollers()
    print("[Stratus] OpenSky /states/all poller started")
    print("[Stratus] Open http://localhost:8090")

    app.run(host="0.0.0.0", port=8090, debug=False, threaded=True)
