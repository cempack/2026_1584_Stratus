// Satellite tiles through a custom protocol (`esri://z/y/x`): full-quality Esri World Imagery, sharded, cached in
// memory and prefetched around the view.
//
// - Quality: the classic host (server/services.arcgisonline.com). The HTTP/2 "Clarity" host was faster but compresses
//   harder; tiles looked visibly softer.
// - Parallelism: the classic host is HTTP/1.1 (6 connections per hostname), so tiles are spread over its two
//   hostnames by a stable hash (a tile always maps to the same URL, so the HTTP cache keeps working): 12 at a time.
// - Precache: decoded-ready bytes are kept in an in-memory LRU, and after each move the next zoom level of the centre
//   and a ring around the view are fetched in the background, at low priority, so zooming in or panning shows
//   imagery at once instead of waiting on the network.
import maplibregl from "maplibre-gl";

const HOSTS = [
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile",
  "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile",
];
const MAX_Z = 18;
const CACHE_TILES = 900; // ~20 MB of JPEG
const PREFETCH_CONCURRENCY = 4;
const PREFETCH_MAX = 64;

/** On a dense screen tiles are requested one level deeper (128 CSS px each = 256 device px): sharp imagery. */
export const imageryTileSize = () => ((window.devicePixelRatio || 1) >= 1.5 ? 128 : 256);

const cache = new Map<string, Promise<ArrayBuffer>>();
const url = (z: number, y: number, x: number) => `${HOSTS[(x + y) % HOSTS.length]}/${z}/${y}/${x}`;

function get(z: number, y: number, x: number, signal?: AbortSignal): Promise<ArrayBuffer> {
  const key = `${z}/${y}/${x}`;
  const hit = cache.get(key);
  if (hit) { cache.delete(key); cache.set(key, hit); return hit; } // LRU touch
  const p = fetch(url(z, y, x), { signal }).then((r) => {
    if (!r.ok) throw new Error(`imagery ${r.status}`);
    return r.arrayBuffer();
  });
  cache.set(key, p);
  p.catch(() => cache.delete(key)); // never cache failures (or aborts)
  while (cache.size > CACHE_TILES) cache.delete(cache.keys().next().value!);
  return p;
}

let installed = false;
export function installImagery(map?: maplibregl.Map) {
  if (!installed) {
    installed = true;
    maplibregl.setMaxParallelImageRequests(24);
    maplibregl.addProtocol("esri", async (params) => {
      const [z, y, x] = params.url.slice("esri://".length).split("/").map(Number);
      // no abort signal: an aborted view still warms the cache for the next one
      return { data: (await get(z, y, x)).slice(0) };
    });
  }
  if (map) watch(map);
}

// ---------- prefetch ----------
const lon2x = (lon: number, n: number) => Math.floor(((lon + 180) / 360) * n);
const lat2y = (lat: number, n: number) => {
  const r = (Math.max(-85, Math.min(85, lat)) * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n);
};

let queue: [number, number, number][] = [];
let running = 0;
function pump() {
  while (running < PREFETCH_CONCURRENCY && queue.length) {
    const [z, y, x] = queue.shift()!;
    if (cache.has(`${z}/${y}/${x}`)) continue;
    running++;
    get(z, y, x).catch(() => undefined).finally(() => { running--; pump(); });
  }
}

/** Tiles of zoom `z` covering lon/lat bounds, nearest to the centre first, capped. */
function tilesFor(z: number, w: number, s: number, e: number, n: number, cx: number, cy: number, cap: number) {
  const N = 2 ** z;
  const x0 = lon2x(w, N), x1 = lon2x(e, N), y0 = lat2y(n, N), y1 = lat2y(s, N);
  const out: [number, number, number][] = [];
  for (let y = Math.max(0, y0); y <= Math.min(N - 1, y1); y++) for (let x = x0; x <= x1; x++) out.push([z, y, ((x % N) + N) % N]);
  const tcx = lon2x(cx, N), tcy = lat2y(cy, N);
  out.sort((a, b) => Math.hypot(a[2] - tcx, a[1] - tcy) - Math.hypot(b[2] - tcx, b[1] - tcy));
  return out.slice(0, cap);
}

function watch(map: maplibregl.Map) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const plan = () => {
    if (!map.getLayer("sat") || map.getLayoutProperty("sat", "visibility") === "none") return;
    const zoom = map.getZoom();
    if (zoom < 3) return; // the globe view is a handful of tiles, already loaded
    const tz = Math.min(MAX_Z, Math.round(zoom + Math.log2(512 / imageryTileSize())));
    const b = map.getBounds(), c = map.getCenter();
    const w = b.getWest(), e = b.getEast(), s = b.getSouth(), n = b.getNorth();
    const dw = (e - w) * 0.35, dh = (n - s) * 0.35;
    // 1) one level deeper, central half of the view (the likely zoom-in)  2) a ring around the view (the likely pan)
    const deeper = tz < MAX_Z ? tilesFor(tz + 1, c.lng - (e - w) / 4, c.lat - (n - s) / 4, c.lng + (e - w) / 4, c.lat + (n - s) / 4, c.lng, c.lat, PREFETCH_MAX / 2) : [];
    const ring = tilesFor(tz, w - dw, s - dh, e + dw, n + dh, c.lng, c.lat, PREFETCH_MAX * 2).filter(([, y, x]) => !cache.has(`${tz}/${y}/${x}`));
    queue = [...deeper, ...ring].slice(0, PREFETCH_MAX);
    pump();
  };
  map.on("movestart", () => { clearTimeout(timer); queue = []; });
  // after the visible tiles had their turn
  map.on("moveend", () => { clearTimeout(timer); timer = setTimeout(plan, 700); });
}
