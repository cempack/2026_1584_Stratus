# Stratus v2 — architecture and API contract

This is the contract between the backend (`stratus/`, Python) and the frontend (`web/`, TypeScript + MapLibre).
Both sides build against this file. Change it only together with both sides.

## Layout

```
stratus/            Python package (backend)
  __main__.py       `python -m stratus` → serves API + built frontend (web/dist)
  config.py         env-driven settings
  store.py          plane store, merge rules, trails, snapshot encoding
  feeds/opensky.py  global baseline poller with credit budget
  feeds/readsb.py   adsb.lol / adsb.fi regional + per-hex refresh
  enrich.py         adsbdb (aircraft + route), planespotters photos
  weather.py        open-meteo at a point
  atc.py            LiveATC catalog / stream resolution / audio proxy
  api.py            Flask app factory, routes
tests/              pytest (backend)
web/                Vite + TypeScript + MapLibre GL app (frontend)
  src/…             modules; vitest tests next to them or in web/test
  dist/             build output (git-ignored), served by the backend at `/`
data/atc/           LiveATC feed definitions (kept as is)
data/cache/         runtime cache (volume in prod)
```

Production: one container, `gunicorn -w 1 --threads 16 'stratus.api:create_app()'` (one worker because feeds run in-process),
port 8090. Docker multi-stage: node builds `web/dist`, python image serves it.

## Data sources

| Source | Role | Cost / limits |
| --- | --- | --- |
| OpenSky `/api/states/all?extended=1` | global baseline, every plane worldwide | 4 credits per global call; 4000 credits/day authenticated (OAuth client credentials from env `OPENSKY_CLIENT_ID`/`OPENSKY_CLIENT_SECRET`), 400/day anonymous. Live remaining in `X-Rate-Limit-Remaining`; on 429 `X-Rate-Limit-Retry-After-Seconds`. |
| adsb.lol `https://api.adsb.lol/v2/point/{lat}/{lon}/{nm}` and `/v2/hex/{hex}` | fresh positions for the viewed area and the selected plane | free, no key, ODbL. Be polite: ≤1 req/s. Max radius 250 NM. |
| adsb.fi `https://opendata.adsb.fi/api/v2/lat/{lat}/lon/{lon}/dist/{nm}` and `/api/v2/hex/{hex}` | fallback for adsb.lol | free, no key, 1 req/s. Same readsb JSON (`aircraft` instead of `ac`). |
| adsbdb `https://api.adsbdb.com/v0/aircraft/{hex}`, `/v0/callsign/{cs}` | registration, type, operator, route | free, cache hard (hours). |
| planespotters `https://api.planespotters.net/pub/photos/hex/{hex}` | photo + photographer credit | free, cache 12 h, must show credit + link. |
| open-meteo | weather at the selected plane | free. |
| RainViewer `https://api.rainviewer.com/public/weather-maps.json` | precipitation radar raster layer (frontend only) | free. |

readsb fields: `seen_pos` is the age of the position in seconds at response time `now` (ms). Position time = `now/1000 - seen_pos`.
`alt_baro` can be the string `"ground"`. `gs` knots, `track` deg, `baro_rate`/`geom_rate` ft/min, `t` type, `r` registration,
`category` (A1..A7, B*, C*), `squawk`, `type` (`adsb_icao`, `mlat`, `tisb_*`, `mode_s`, …).

### OpenSky credit budget (must never run out)

- Track `remaining` from every response header and persist it (with timestamp) in `data/cache`, so a restart does not burn
  extra credits or start blind. No unconditional bootstrap fetch on startup if the restored snapshot is fresh (< 3 min).
- Interval = `max(floor, time_to_reset / max(1, (remaining − reserve) / cost))`, reserve = 5 % of the daily allowance.
  `time_to_reset` = to next 00:00 UTC (OpenSky resets daily); if remaining increases unexpectedly, treat it as a reset.
  Unknown remaining → `86400 / (allowance / cost)` (~86 s). Floor 20 s (OpenSky resolution for authenticated users is 5 s).
- Idle mode: no client hit `/api/planes` or `/api/planes/area` for 10 min → poll every 10 min. Banked credits are spent
  automatically when viewers come back because the formula spreads the remainder.
- 429 → wait `X-Rate-Limit-Retry-After-Seconds` (fallback 10 min). 5xx/timeouts → exponential backoff 15 s → 5 min.
- The anonymous pool (400/day) is a separate budget used only when OAuth is unavailable or exhausted.
- Credentials come only from env. No HTTP endpoint can read, write or delete credentials.

### Merge rules

- Planes are keyed by lowercase 24-bit ICAO hex.
- Each observation carries `ts` (position time, epoch seconds) and `src`. An observation replaces the stored position only
  if its `ts` is newer. Metadata fields (callsign, type, registration, category, squawk) are filled from whichever source has them.
- Altitude: barometric feet, fall back to geometric. `gnd=true` when on ground (OpenSky `on_ground`, readsb `alt_baro=="ground"`).
- Sanity: drop positions implying > 1200 kt since the previous fix (unless the gap is > 30 min), lat/lon outside range, ts in the future.
- Units in the API: altitude ft, speed kt, vertical rate ft/min, track degrees true. Never mix with metres.
- Expiry: airborne planes with no position for 15 min and ground planes for 5 min are dropped.
- Trail: every accepted position appended (min 10 s and 200 m apart), kept 3 h, Douglas-Peucker-thinned past 20 min.

## API (all JSON, gzip, `Cache-Control: no-store` unless stated)

### `GET /api/planes`
Full compact snapshot. The encoded and gzipped body is built once per store version, never per request. Supports
`ETag`/`If-None-Match` → `304`.

```json
{
  "v": 1842,
  "t": 1794834556.2,
  "fields": ["hex","cs","lat","lon","alt","gs","trk","vr","gnd","ts","src","type","reg","cat","sqk"],
  "rows": [["3c6444","DLH4AB",48.12345,11.54321,36000,452,271.5,-64,false,1794834550.0,"opensky","A320","D-AIZB","A3","1000"]]
}
```
`lat`/`lon` 5 decimals, `alt`/`gs`/`vr` ints or null, `trk` 1 decimal or null, `ts` 1 decimal, `src` one of
`opensky` | `adsb.lol` | `adsb.fi`. Unknown values are `null`.

### `GET /api/planes/area?lat=&lon=&r=`
`r` = radius in NM, clamped to 250. If the area's freshest regional data is older than 4 s, the backend refreshes it from
adsb.lol (fallback adsb.fi), coalescing concurrent identical requests, and then responds. Response has the same shape as
`/api/planes` but only rows inside the circle. The frontend calls this every 5 s for the viewport when the visible radius
is ≤ 250 NM, and merges the rows by `ts`.

### `GET /api/aircraft/<hex>`
Selected-plane detail. Refreshes the plane from adsb.lol `/v2/hex` (cached 2 s). 404 if unknown.

```json
{
  "plane": { "hex":"3c6444","cs":"DLH4AB","lat":..,"lon":..,"alt":..,"gs":..,"trk":..,"vr":..,"gnd":false,"ts":..,"src":"adsb.lol",
             "type":"A320","reg":"D-AIZB","cat":"A3","sqk":"1000","pos_type":"adsb_icao","country":"Germany" },
  "trail": [[lat, lon, alt_ft_or_null, ts], ...],
  "aircraft": { "registration":"D-AIZB","type":"A320","type_name":"Airbus A320-214","manufacturer":"Airbus",
                "operator":"Lufthansa","operator_icao":"DLH","owner":"..","country":"Germany" } | null,
  "route": { "callsign":"DLH4AB","airline":"Lufthansa",
             "origin": {"icao":"EDDM","iata":"MUC","name":"..","city":"..","country":"..","lat":..,"lon":..},
             "destination": {...},
             "plausible": true } | null,
  "photo": { "thumb":"https://..","large":"https://..","photographer":"..","link":"https://www.planespotters.net/.." } | null
}
```
`route.plausible` is false when the plane's position is far off the great circle between origin and destination
(adsbdb routes are often stale); the UI then shows the route as unconfirmed.
`aircraft`, `route`, `photo` may arrive as `null` on the first call while lookups run in the background; the frontend
polls this endpoint every 3 s while a plane is selected, so they fill in.

### `GET /api/status`
```json
{
  "planes": 11234, "v": 1842, "t": ..,
  "feeds": {
    "opensky": { "state":"ok|degraded|rate_limited|idle|disabled", "mode":"oauth|anonymous", "last_ok":.., "next_poll":..,
                 "interval":86.4, "credits_remaining":3120, "credits_daily":4000, "last_error":null },
    "adsb.lol": { "state":"ok", "last_ok":.., "last_error":null },
    "adsb.fi":  { "state":"ok", "last_ok":.., "last_error":null }
  }
}
```

### `GET /api/weather?lat=&lon=&alt=`
`{ "temp_c":.., "wind_kt":.., "wind_dir":.., "cloud_pct":.., "level": "surface|850hPa|...", "time":.. }`. Cache 10 min per 0.25° cell.

### ATC
- `GET /api/atc/airports` → `{ "airports": [ { "icao","name","city","country","lat","lon","feeds":[{"id","label"}] } ] }`
- `GET /api/atc/audio?icao=&feed=` → proxied audio stream (existing behaviour, keep it working).

### Static
`GET /` and assets: `web/dist`. Unknown non-`/api` paths fall back to `index.html` (client-side routing / deep links).
Static assets with hashed names: `Cache-Control: public, max-age=31536000, immutable`.

## Frontend behaviour (summary)
- Load `/api/planes` on start, then every 15 s (cheap thanks to ETag). Viewport area every 5 s when zoomed in. Selected plane
  detail every 3 s.
- Dead reckoning: render each airborne plane at `pos + gs·(now − ts)` along `trk`, capped at 90 s of extrapolation; when a
  newer fix arrives, ease toward it over ~1 s instead of jumping. Ground planes are not extrapolated.
- Planes whose `ts` is older than 5 min are drawn faded.
- URL holds state: `#/flight/<hex>` and `?ll=lat,lon&z=zoom` so links are shareable.
