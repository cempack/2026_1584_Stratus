"""Background coverage sweep: walks a fixed list of 250 NM circles over traffic areas on adsb.lol / adsb.fi.

OpenSky sometimes misses planes that adsb.fi sees. The sweep fills those gaps. Providers alternate request by request
(and swap roles on the next cycle), so each one sees at most half of the overall rate, which itself stays at
<= 1 request per `interval` (default 1.5 s => a full cycle of ~124 circles takes about 3 minutes). Observations go
through Store.apply, i.e. the exact same merge rules as every other source (strict hex key, stale fixes dropped at
parse time, speed sanity across sources, MLAT never overwrites newer ADS-B...). No viewers for 10 minutes -> paused.
"""

from __future__ import annotations

import logging
import threading
import time

from ..store import Store
from .readsb import ReadsbFeed

log = logging.getLogger(__name__)

RADIUS_NM = 250
IDLE_AFTER_S = 600.0

# (name, lat, lon). Chosen over areas with traffic, spread over all continents (not just EU/US).
CIRCLES: list[tuple[str, float, float]] = [
    # Europe
    ("London", 51.5, -0.5), ("Scotland", 55.0, -3.5), ("Ireland", 53.4, -7.5), ("Paris", 48.9, 2.5),
    ("Benelux", 52.0, 5.0), ("Frankfurt", 50.0, 8.5), ("Berlin", 52.5, 13.4), ("Warsaw", 52.2, 21.0),
    ("Denmark", 56.0, 11.5), ("Stockholm", 59.5, 16.0), ("Vienna", 48.3, 16.5), ("Munich-Zurich", 47.5, 10.0),
    ("Milan", 45.0, 9.0), ("Rome", 41.9, 12.5), ("Madrid", 40.4, -3.7), ("Lisbon", 38.8, -9.1),
    ("Athens", 38.0, 23.7), ("Istanbul", 41.0, 29.0), ("Moscow", 55.7, 37.6), ("Canaries", 28.0, -15.5),
    ("Barcelona", 41.5, 2.5),
    # North Atlantic
    ("Iceland", 64.5, -21.0), ("Azores", 38.5, -28.0), ("Mid-Atlantic", 53.0, -30.0), ("Newfoundland", 48.5, -54.0),
    # North America
    ("New York", 40.7, -74.0), ("Washington", 38.9, -77.0), ("Atlanta", 33.6, -84.4), ("Miami", 26.5, -80.5),
    ("Tampa", 28.0, -82.0), ("Houston", 30.0, -92.0), ("Dallas", 32.9, -97.0), ("Denver", 39.8, -104.7),
    ("Chicago", 41.9, -87.9), ("Cleveland", 41.5, -82.0), ("Minneapolis", 44.9, -93.2), ("Salt Lake", 40.8, -111.9),
    ("Phoenix", 33.4, -112.0), ("Los Angeles", 34.0, -118.4), ("San Francisco", 37.6, -122.4),
    ("Seattle", 47.4, -122.3), ("Vancouver", 49.2, -123.2), ("Calgary", 51.1, -114.0), ("Toronto", 43.7, -79.6),
    ("Montreal", 45.5, -73.7), ("Halifax", 44.9, -63.5), ("Anchorage", 61.2, -150.0), ("Hawaii", 21.3, -157.9),
    ("Mexico City", 19.4, -99.1), ("Cancun", 21.0, -87.0), ("Puerto Rico", 18.4, -66.0),
    # Central / South America
    ("Havana", 23.1, -82.4), ("Panama", 9.0, -79.4), ("Bogota", 4.7, -74.1), ("Caracas", 10.6, -66.9),
    ("Quito", 0.0, -78.5), ("Lima", -12.0, -77.1), ("Sao Paulo", -23.5, -46.6), ("Rio", -22.8, -43.2),
    ("Brasilia", -15.9, -47.9), ("Recife", -8.1, -34.9), ("Buenos Aires", -34.6, -58.5), ("Santiago", -33.4, -70.8),
    # Africa
    ("Casablanca", 33.5, -7.6), ("Algiers", 36.7, 3.0), ("Cairo", 30.1, 31.4), ("Lagos", 6.6, 3.3),
    ("Dakar", 14.7, -17.5), ("Khartoum", 15.6, 32.5), ("Addis Ababa", 9.0, 38.8), ("Nairobi", -1.3, 36.9),
    ("Luanda", -8.9, 13.2), ("Johannesburg", -26.1, 28.2), ("Cape Town", -33.9, 18.6), ("Mauritius", -20.4, 57.5),
    # Middle East
    ("Dubai", 25.3, 55.4), ("Doha", 25.3, 51.5), ("Riyadh", 24.9, 46.7), ("Jeddah", 21.7, 39.2),
    ("Tel Aviv", 31.5, 35.5), ("Tehran", 35.7, 51.3), ("Baghdad", 33.3, 44.4), ("Muscat", 23.6, 58.3),
    ("Karachi", 24.9, 67.1),
    # South / Central Asia
    ("Delhi", 28.6, 77.1), ("Mumbai", 19.1, 72.9), ("Chennai", 13.0, 78.0), ("Kolkata", 22.6, 88.4),
    ("Colombo", 7.2, 79.9), ("Almaty", 43.3, 77.0), ("Tashkent", 41.3, 69.3),
    # East / South-East Asia
    ("Beijing", 40.1, 116.6), ("Shenyang", 41.6, 123.5), ("Shanghai", 31.1, 121.8), ("Wuhan", 30.8, 114.2),
    ("Chengdu", 30.6, 104.0), ("Guangzhou", 23.4, 113.3), ("Taipei", 25.1, 121.2), ("Seoul", 37.5, 127.0),
    ("Tokyo", 35.5, 139.8), ("Osaka", 34.4, 135.2), ("Sapporo", 43.0, 141.4), ("Vladivostok", 43.4, 132.1),
    ("Manila", 14.5, 121.0), ("Hanoi", 21.0, 105.8), ("Ho Chi Minh", 10.8, 106.7), ("Bangkok", 13.7, 100.7),
    ("Singapore", 2.0, 103.0), ("Medan", 3.6, 98.7), ("Jakarta", -6.2, 106.8), ("Bali", -8.0, 114.0),
    # Oceania
    ("Sydney", -33.9, 151.2), ("Melbourne", -37.7, 144.8), ("Brisbane", -27.4, 153.1), ("Adelaide", -34.9, 138.5),
    ("Perth", -31.9, 115.9), ("Cairns", -16.9, 145.8), ("Darwin", -12.4, 130.9), ("Port Moresby", -9.4, 147.2),
    ("Auckland", -37.0, 174.8), ("Wellington", -41.3, 174.8), ("Fiji", -17.8, 177.5), ("Tahiti", -17.5, -149.6),
    ("Guam", 13.5, 144.8),
]


class Sweeper:
    def __init__(self, feed: ReadsbFeed, store: Store, circles=None, interval: float = 1.5, clock=time.time,
                 enabled: bool = True):
        self.feed = feed
        self.store = store
        self.circles = list(circles if circles is not None else CIRCLES)
        self.interval = max(0.5, interval)
        self.clock = clock
        self.enabled = enabled
        self.index = 0
        self.cycles = 0
        self.requests = 0
        self.errors = 0
        self.planes_seen = 0
        self.new_planes_total = 0
        self.cycle_started = 0.0
        self.cycle_new = 0
        self.last_cycle_new: int | None = None
        self.last_cycle_s: float | None = None
        self.last_cycle_at: float | None = None
        self.last_step_at: float | None = None
        self.paused = False

    def step(self) -> bool:
        """Sweep one circle. Returns True when a provider answered."""
        if not self.circles:
            return False
        now = self.clock()
        if self.index == 0:
            self.cycle_started, self.cycle_new = now, 0
        _, lat, lon = self.circles[self.index]
        provs = self.feed.providers
        ok = False
        for k in range(len(provs)):
            prov = provs[(self.index + self.cycles + k) % len(provs)]  # alternate, fall back to the other one
            obs = self.feed.fetch_point_from(prov, lat, lon, RADIUS_NM)
            self.requests += 1
            if obs is None:
                self.errors += 1
                continue
            fresh = {o.hex for o in obs if o.lat is not None and o.hex not in self.store.planes}
            self.store.apply(obs)
            new = sum(1 for hx in fresh if hx in self.store.planes)
            self.planes_seen += sum(1 for o in obs if o.lat is not None)
            self.new_planes_total += new
            self.cycle_new += new
            ok = True
            break
        self.last_step_at = self.clock()
        self.index += 1
        if self.index >= len(self.circles):
            self.index = 0
            self.cycles += 1
            self.last_cycle_s = round(self.clock() - self.cycle_started, 1)
            self.last_cycle_at = self.clock()
            self.last_cycle_new = self.cycle_new
        return ok

    def idle(self) -> bool:
        return self.clock() - self.store.last_client_hit > IDLE_AFTER_S

    def run(self, stop: threading.Event) -> None:
        while not stop.is_set():
            if self.idle():
                self.paused = True
                stop.wait(5.0)
                continue
            self.paused = False
            t0 = time.monotonic()
            try:
                self.step()
            except Exception:
                log.exception("sweep step failed")
            stop.wait(max(0.0, self.interval - (time.monotonic() - t0)))

    def status(self) -> dict:
        state = "disabled" if not self.enabled else ("idle" if self.paused else "running")
        return {
            "state": state, "circles": len(self.circles), "radius_nm": RADIUS_NM, "interval_s": self.interval,
            "index": self.index, "progress": round(self.index / max(1, len(self.circles)), 3),
            "cycles": self.cycles, "last_cycle_s": self.last_cycle_s, "last_cycle_at": self.last_cycle_at,
            "last_cycle_new_planes": self.last_cycle_new, "new_planes_total": self.new_planes_total,
            "requests": self.requests, "errors": self.errors, "planes_seen": self.planes_seen,
        }
