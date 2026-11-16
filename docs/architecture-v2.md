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
  feeds/sweep.py    background coverage sweep: ~124 fixed 250 NM circles, adsb.lol / adsb.fi alternating
  estimate.py       estimated positions (great circle to the destination) + the rules that allow them
  enrich.py         adsbdb (aircraft + route), planespotters photos, background route prefetch
  fr24.py           optional Flightradar24 API (env FR24_API_TOKEN): route, live position, full track
  airports.py       OurAirports catalog (airports + runways), cached daily
  board.py          airport arrivals / departures derived from the plane store
  metar.py          aviationweather.gov METAR, decoded
  winds.py          wind grid aloft from open-meteo
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
| open-meteo | weather at the selected plane; wind grid aloft (`/api/winds`) | free. Grid: one batched request per miss, cached 30 min per cell. |
| aviationweather.gov `/api/data/metar?ids=..&format=json` | METAR | free, cached 10 min per station. |
| OurAirports `airports.csv`, `runways.csv` (davidmegginson.github.io/ourairports-data) | airport catalog, runways | free, downloaded at most once a day, cached in `data/cache/ourairports.json.gz`. |
| Flightradar24 API `https://fr24api.flightradar24.com` (optional) | route / live position / full track of the SELECTED plane | needs `FR24_API_TOKEN`; credits, see "Flightradar24" below. |
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
- Strictly keyed by ICAO hex: readsb `~`-prefixed (non-ICAO / TIS-B) hexes and malformed hexes are ignored, never merged.
- A readsb position with `seen_pos` > 60 s (or half a position) is not a fix: only its metadata is used. No ghost planes.
- Position quality: `pos_type` mlat / tisb_* / mode_s / asterix / flarm is lower quality than ADS-B, and so is any fix whose
  radius of containment `rc` > 1852 m. A lower-quality fix never replaces a stored better one that is < 30 s older than it.
- Metadata from a lower-quality message (e.g. an MLAT callsign or a TIS-B squawk) fills blanks but never overwrites a value
  set by a better message in the last 10 min (this also keeps a garbled 7700 from raising an alert).
- Altitude: barometric feet, fall back to geometric. `gnd=true` when on ground (OpenSky `on_ground`, readsb `alt_baro=="ground"`).
- Sanity: drop positions implying > 1200 kt since the previous (real) fix, whatever the sources (unless the gap is > 30 min),
  lat/lon outside range, ts in the future. The stored fix is only replaced after 3 rejected fixes that agree with each other
  (not 3 arbitrary ones). Any rejection cancels an active estimate (see below).
- Units in the API: altitude ft, speed kt, vertical rate ft/min, track degrees true. Never mix with metres.
- Expiry: airborne planes with no position for 15 min and ground planes for 5 min are dropped, except planes that qualify
  for an estimated position (below).
- Trail: every accepted position appended (min 10 s and 200 m apart), kept 3 h, Douglas-Peucker-thinned past 20 min.

## API (all JSON, gzip, `Cache-Control: no-store` unless stated)

### `GET /api/planes`
Full compact snapshot. The encoded and gzipped body is built once per store version, never per request. Supports
`ETag`/`If-None-Match` → `304`.

```json
{
  "v": 1842,
  "t": 1794834556.2,
  "fields": ["hex","cs","lat","lon","alt","gs","trk","vr","gnd","ts","src","type","reg","cat","sqk","est"],
  "rows": [["3c6444","DLH4AB",48.12345,11.54321,36000,452,271.5,-64,false,1794834550.0,"opensky","A320","D-AIZB","A3","1000",false]]
}
```
`lat`/`lon` 5 decimals, `alt`/`gs`/`vr` ints or null, `trk` 1 decimal or null, `ts` 1 decimal, `src` one of
`opensky` | `adsb.lol` | `adsb.fi` | `fr24` (selected plane only, when FR24 is configured). Unknown values are `null`.
**`est` (new, last field, boolean)**: `true` when the row is an ESTIMATED position (see "Estimated positions"). Always read
fields by name through `fields`; `est` is appended at the end so older clients that index by position keep working.

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
             "type":"A320","reg":"D-AIZB","cat":"A3","sqk":"1000","est":false,"pos_type":"adsb_icao","country":"Germany" },
  "estimated_since": null,
  "trail": [[lat, lon, alt_ft_or_null, ts], ...],
  "aircraft": { "registration":"D-AIZB","type":"A320","type_name":"Airbus A320-214","manufacturer":"Airbus",
                "operator":"Lufthansa","operator_icao":"DLH","owner":"..","country":"Germany" } | null,
  "route": { "callsign":"DLH4AB","airline":"Lufthansa",
             "origin": {"icao":"EDDM","iata":"MUC","name":"..","city":"..","country":"..","lat":..,"lon":..},
             "destination": {...},
             "plausible": true,
             "source": "adsbdb" } | null,
  "photo": { "thumb":"https://..","large":"https://..","photographer":"..","link":"https://www.planespotters.net/.." } | null,
  "fr24": null,
  "full_track": { "available": false, "cost": 40, "reason": "disabled" }
}
```
New fields:
- `plane.est`: `true` while the position is estimated; then `plane.lat/lon/trk` are the ESTIMATED position and heading,
  `plane.ts` / `plane.src` / `plane.alt` / `plane.gs` stay those of the last REAL fix (`now - ts` = how long ago it was seen).
  `trail` only ever contains real fixes.
- `estimated_since`: epoch seconds when the estimate started (`null` unless `plane.est`).
- `route.source`: `"adsbdb"` | `"fr24"`. `route.fr24_id` is present when `source` is `"fr24"`. Airport objects from FR24 are
  filled from OurAirports (`country` is then an ISO code instead of a name).
- `route.plausible` is evaluated at the last REAL fix.
- `fr24`: `null` when `FR24_API_TOKEN` is not set (hide every FR24 UI). Otherwise
  `{ "state": "ok|rate_limited|exhausted|auth_error", "credits_remaining": 812, "credits_daily": 900 }`.
- `full_track`: `{ "available": bool, "cost": 40, "reason": null | "disabled" | "auth_error" | "budget" }`. Show the
  "full track" button only when `available`; show `cost` credits and `fr24.credits_remaining` next to it.
`route.plausible` is false when the plane's position is far off the great circle between origin and destination
(adsbdb routes are often stale); the UI then shows the route as unconfirmed.
`aircraft`, `route`, `photo` may arrive as `null` on the first call while lookups run in the background; the frontend
polls this endpoint every 3 s while a plane is selected, so they fill in. With FR24 configured, the route of the selected plane
is asked from FR24 first and falls back to adsbdb (`route.source` tells which; it may switch from `adsbdb` to `fr24` after a
poll or two).

### `GET /api/aircraft/<hex>/full-track`
Only with FR24 configured, and only when the user explicitly asks (40 credits; cached 1 h per flight, a repeat is free).
Resolves the FR24 flight id (1 credit if not already known), then returns the whole track since takeoff.
```json
{ "hex":"3c6444", "fr24_id":"391fdd79", "cached":false,
  "points": [[lat, lon, alt_ft_or_null, ts], ...],
  "fr24": { "state":"ok", "credits_remaining": 859, "credits_daily": 900 } }
```
`points` has the same layout as `trail`, sorted by time. Errors (JSON `{ "error", "reason", "fr24" }`): `400` bad hex,
`404` unknown aircraft or `reason:"not_found"` (FR24 has no live flight for it), `429` `reason:"budget"|"rate"`,
`503` `reason:"disabled"|"auth_error"|"network"|"error"`.
### `GET /api/status`
```json
{
  "planes": 11234, "v": 1842, "t": ..,
  "feeds": {
    "opensky": { "state":"ok|degraded|rate_limited|idle|disabled", "mode":"oauth|anonymous", "last_ok":.., "next_poll":..,
                 "interval":86.4, "credits_remaining":3120, "credits_daily":4000, "last_error":null },
    "adsb.lol": { "state":"ok", "last_ok":.., "last_error":null },
    "adsb.fi":  { "state":"ok", "last_ok":.., "last_error":null }
  },
  "estimated": 37,
  "alerts": 1,
  "sweep": { "state":"running|idle|disabled", "circles":124, "radius_nm":250, "interval_s":1.5, "index":42, "progress":0.336,
             "cycles":3, "last_cycle_s":188.4, "last_cycle_at":.., "last_cycle_new_planes":212, "new_planes_total":640,
             "requests":380, "errors":2, "planes_seen":91234 },
  "fr24": { "state":"disabled" }
}
```
`adsb.*` `state` can also be `rate_limited` (a provider that answered 429 is left alone for 60 s).
`estimated` = number of planes currently shown with `est:true`; `alerts` = number of planes in `/api/alerts`.
`sweep.state` is `idle` while nobody has used the API for 10 min (the sweep pauses); `last_cycle_new_planes` = planes the sweep
found that were not in the store yet (i.e. missed by OpenSky and everything else) during the last complete cycle.
`fr24` is exactly `{"state":"disabled"}` without `FR24_API_TOKEN`; otherwise
`{ "state":"ok|rate_limited|exhausted|auth_error", "credits_used", "credits_daily", "credits_remaining", "last_ok", "last_error" }`
(`auth_error` = the key was rejected: FR24 stays off until restart, everything else keeps working).

### `GET /api/weather?lat=&lon=&alt=`
`{ "temp_c":.., "wind_kt":.., "wind_dir":.., "cloud_pct":.., "level": "surface|850hPa|...", "time":.. }`. Cache 10 min per 0.25° cell.

### `GET /api/alerts`
Planes squawking 7500 / 7600 / 7700 with a real fix less than 10 min old (estimated planes are never listed), worst first
(7500, 7700, 7600).
```json
{ "t": 1794834556.2, "count": 1, "alerts": [
  { "hex":"3c6444","cs":"DLH4AB","squawk":"7700","kind":"emergency","lat":..,"lon":..,"alt":..,"gs":..,"trk":..,"vr":..,
    "gnd":false,"ts":..,"src":"opensky","type":"A320","reg":"D-AIZB" } ] }
```
`kind`: `hijack` (7500) | `radio_failure` (7600) | `emergency` (7700). Poll it every ~15 s; the count is also in `/api/status`.

### `GET /api/metar?icao=XXXX` and `GET /api/metar?bbox=south,west,north,east[&limit=40]`
`icao`: `{ "metar": {...} }` (404 `{error}` when the station has no report). `bbox`: `{ "t", "count", "stations": [ {...}, ... ] }` for
the LARGE airports in the box (at most `limit`, max 60) that have a report, for flight-category dots. Cached 10 min.
```json
{ "icao":"LFPG","name":"Paris/Charles de Gaulle","lat":49.01,"lon":2.55,"time":1794820000,
  "raw":"METAR LFPG 160900Z 24012G22KT ...",
  "wind_dir":240,"wind_variable":false,"wind_kt":12,"gust_kt":22,
  "vis_sm":6.0,"vis_km":9.7,"ceiling_ft":2500,"clouds":[{"cover":"FEW","base_ft":1500},{"cover":"BKN","base_ft":2500}],
  "weather":null,"temp_c":9.0,"dew_c":7.0,"qnh_hpa":1012.0,"flight_category":"MVFR" }
```
`flight_category`: `VFR` | `MVFR` | `IFR` | `LIFR` (`null` if unknown). `wind_dir` is `null` for variable wind. `ceiling_ft` is
the lowest BKN/OVC/vertical-visibility layer, `null` if none. Any value may be `null`.

### `GET /api/winds?bbox=south,west,north,east&level=250`
Coarse wind grid for an animated particle layer. `level`: pressure level in hPa (`1000 925 850 700 600 500 400 300 250 200 150 100`,
default 250) or `surface` (10 m). `bbox` may cross the antimeridian (`west > east`). At most 15 x 10 points; the backend picks the
finest aligned step (`step` degrees) that fits. Cached 30 min per cell; one batched open-meteo request per miss.
```json
{ "t":.., "level":250, "unit":"kt", "bbox":[s,w,n,e], "step":5, "nx":9, "ny":4,
  "lats":[55,50,45,40], "lons":[-10,-5,0,5,10,15,20,25,30], "lat0":55, "lon0":-10, "dlat":5, "dlon":5,
  "u":[...nx*ny...], "v":[...nx*ny...] }
```
`u` / `v` are the eastward / northward components of the wind (direction it blows TOWARDS) in knots, row-major, rows from
north to south (`lats`), columns from west to east (`lons`, normalised to -180..180). `null` where unavailable. `502` when
open-meteo is down and nothing is cached.

### `GET /api/airports?q=&bbox=&limit=&type=`
OurAirports large + medium airports (`type=large` restricts to large). `q` (IATA/ICAO exact first, then prefix, then
name/city substring), or `bbox=south,west,north,east` for the map (large first, then by ICAO; `limit` default 20, max 500), or
neither (all large airports, up to `limit`). `503` while the catalog is still downloading (first start only; retry).
```json
{ "count": 1, "airports": [ { "icao":"LFPG","iata":"CDG","name":"Paris Charles de Gaulle Airport","city":"Paris",
    "country":"FR","lat":49.0097,"lon":2.5479,"elev_ft":392,"type":"large" } ] }
```

### `GET /api/airport/<icao or iata>`
Airport board, derived from the live plane store (no extra upstream calls except the METAR).
```json
{ "t":.., "airport": { "icao","iata","name","city","country","lat","lon","elev_ft","type",
                       "runways": [ {"le_ident":"08L","he_ident":"26R","le_heading":85,"he_heading":265,"length_ft":13829,
                                     "width_ft":148,"surface":"ASP","lighted":true,"le_lat":..,"le_lon":..,"he_lat":..,"he_lon":..} ] },
  "arrivals":   [ { "hex","cs","type","reg","lat","lon","alt","gs","trk","vr","gnd","est","ts","dist_nm","basis","phase",
                    "origin": {"icao","iata","name","city"} | null, "eta_s": 432, "eta_ts": 1794834990.0 } ],
  "departures": [ { ...same..., "destination": {...} | null, "phase":"ground|climbing|enroute", "eta_s":null,"eta_ts":null } ],
  "metar": { ...as /api/metar... } | null }
```
Planes within 60 NM. `basis`: `route` (a plausible route has this airport as destination / origin) or `profile` (no usable route; low
and descending towards the airport within 40 NM = arrival, low and climbing away within 25 NM = departure). Planes with a plausible route
to or from another airport are never listed. `phase` (arrivals): `inbound` > 30 NM, `approach` <= 30 NM, `final` <= 10 NM. `eta_s` =
distance / max(gs, 100 kt) (`null` without speed). Arrivals sorted by ETA, departures: on the ground first, then by distance. Runways: longest
first, closed ones omitted. `404` unknown airport, `503` catalog not loaded yet.

### ATC
- `GET /api/atc/airports` → `{ "airports": [ { "icao","name","city","country","lat","lon","feeds":[{"id","label"}] } ] }`
- `GET /api/atc/audio?icao=&feed=` → proxied audio stream (existing behaviour, keep it working).

### Static
`GET /` and assets: `web/dist`. Unknown non-`/api` paths fall back to `index.html` (client-side routing / deep links).
Static assets with hashed names: `Cache-Control: public, max-age=31536000, immutable`.

## Estimated positions

Like Flightradar24 over oceans: when a plane stops being received it can keep moving on the map, flagged `est:true`.

A plane is estimated only if, at its LAST REAL fix, ALL of this holds (every rule has a unit test):
- airborne, altitude >= 10 000 ft, ground speed >= 200 kt, `|vr|` <= 1000 ft/min (never climbing out / descending), callsign known;
- stable track: the bearing from an earlier fix (30..600 s before, >= 2 NM away) agrees with the reported track within 15 deg
  and the altitude changed by <= 1500 ft;
- a route with coordinates is known (cache only), `route.callsign` equals the plane's callsign, `route.plausible` holds AND the
  plane is within ~6 % of the leg (max 200 NM, min 60 NM) of the origin-destination great circle;
- the destination is ahead (bearing to it within 60 deg of the track), >= 80 NM away, the origin >= 40 NM behind;
- no fix was ever rejected by the sanity filter since (a fix elsewhere cancels the estimate for good).

It starts when the last fix is older than 2 min (re-evaluated every 10 s, which is also the refresh rate of the position). The estimated point
moves along the great circle from the last real fix to the destination at the last ground speed; `trk` is the bearing to the
destination. It ENDS (the plane is removed) when the predicted position is within 10 NM of the destination, or 10 h after the last fix
(this deliberately replaces "arrival + 20 min"), or as soon as any accepted real fix arrives (real fixes always win and clear `est`).
Planes that do not qualify keep the old behaviour (dropped after 15 min).

Rows with `est:true`: `lat/lon/trk` are estimated, `ts` is the time of the last REAL fix (so `now - ts` = time since last seen),
`alt/gs/vr` are the last real values, `src` the last real source. Frontend: do NOT dead-reckon them from `ts` (the backend already
moved them; interpolate between snapshots, from the snapshot time `t`), draw them dashed / faded, show "estimated position, last seen X ago".

Routes are looked up in the background (adsbdb, cached 6 h, <= 1.5 lookups/s, only airborne planes with an airline-style callsign at >= 10 000 ft,
planes not seen for > 60 s first) so a route is known before the plane vanishes. Disable with env `STRATUS_ESTIMATES=0`.

## Coverage sweep

OpenSky sometimes misses planes that adsb.fi sees. A background thread walks a fixed list of ~124 circles (250 NM, `feeds/sweep.py`
`CIRCLES`, all continents) on adsb.lol / adsb.fi, alternating provider on every request (and swapping on the next cycle), at most 1 request
per 1.5 s (`STRATUS_SWEEP_INTERVAL`) in total, so a full cycle takes ~3 min. A provider that answers 429 is left alone for 60 s; a request is
skipped when its provider slot is busy serving viewers. Observations go through `Store.apply`, i.e. exactly the merge rules above. Progress is in
`/api/status` `sweep`. It pauses when nobody used the API for 10 min and can be disabled with `STRATUS_SWEEP=0`.

## Flightradar24 (optional)

Env `FR24_API_TOKEN` (Explorer plan: 30 000 credits/month, 10 requests/min, 20 results per response) and `FR24_DAILY_CREDITS` (hard cap, default 900,
counter persisted in `data/cache/fr24-credits.json`, reset at 00:00 UTC; a call that would exceed it is refused before any request). Only for the
SELECTED plane (calls come from `/api/aircraft/<hex>` and `/full-track`), never in the background:

| Use | Endpoint | Credits | When |
| --- | --- | --- | --- |
| route | `/api/flight-summary/light?callsigns=CS&flight_datetime_from/to=YYYY-MM-DDTHH:MM:SSZ&sort=desc&limit=3` | 1 | route of the selected plane, cached 6 h (miss 1 h); the live (`flight_ended:false`) flight with the same callsign and hex; falls back to adsbdb |
| live position | `/api/live/flight-positions/light?registrations=REG` (or `callsigns=CS`) | 6 | selected plane is `est` or its last real fix is > 60 s old; at most once per 60 s per plane. Only a row whose `hex` is the plane's hex and whose `source` is ADSB/UAT/MLAT is merged (as `src:"fr24"`, normal sanity rules); FR24's own `ESTIMATED` positions are never used |
| full track | `/api/flight-tracks?flight_id=ID` | 40 (+1 if the id is unknown) | only `GET /api/aircraft/<hex>/full-track`, cached 1 h per flight |

At most 9 requests per minute (plan limit 10). Without the token nothing changes: no FR24 request, no log noise, `/api/status.fr24` is
`{"state":"disabled"}`, `aircraft.fr24` is `null`, `aircraft.full_track.available` is `false`. A 401/403 sets `state:"auth_error"` (logged once, FR24 off until restart,
other features unaffected); 402 empties the day's budget; 429 pauses FR24 for 60 s; network errors are not charged.

## Frontend behaviour (summary)
- Load `/api/planes` on start, then every 15 s (cheap thanks to ETag). Viewport area every 5 s when zoomed in. Selected plane
  detail every 3 s.
- Dead reckoning: render each airborne plane at `pos + gs·(now − ts)` along `trk`, capped at 90 s of extrapolation; when a
  newer fix arrives, ease toward it over ~1 s instead of jumping. Ground planes are not extrapolated.
- Planes whose `ts` is older than 5 min are drawn faded; `est` planes are drawn estimated (dashed / faded, no dead reckoning, see above).
- URL holds state: `#/flight/<hex>` and `?ll=lat,lon&z=zoom` so links are shareable.
