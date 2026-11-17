// Satellite tiles through a custom protocol (`esri://z/y/x`).
//
// The classic Esri host (server.arcgisonline.com) only speaks HTTP/1.1, so a browser fetches at most 6 tiles at a
// time from it and a fresh view trickles in. The "Clarity" host serves the same World Imagery (often newer) over
// HTTP/2 from CloudFront: every visible tile is requested at once on one connection. It has holes over open ocean
// (404 where the classic host returns plain blue), so a 404 falls back to the classic host.
import maplibregl from "maplibre-gl";

const CLARITY = "https://clarity.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tile";
const CLASSIC = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile";

let installed = false;

export function installImagery() {
  if (installed) return;
  installed = true;
  // HTTP/2 makes extra parallel requests cheap; the default (16) leaves a cold z6+ view waiting on the queue
  maplibregl.setMaxParallelImageRequests(32);
  maplibregl.addProtocol("esri", async (params, abort) => {
    const path = params.url.slice("esri://".length);
    let res = await fetch(`${CLARITY}/${path}`, { signal: abort.signal });
    if (res.status === 404) res = await fetch(`${CLASSIC}/${path}`, { signal: abort.signal });
    if (!res.ok) throw new Error(`imagery ${res.status}`);
    return { data: await res.arrayBuffer(), cacheControl: res.headers.get("cache-control"), expires: res.headers.get("expires") };
  });
}
