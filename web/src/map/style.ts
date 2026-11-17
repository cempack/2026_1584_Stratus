// Basemap: a muted, custom style on OpenFreeMap vector tiles (OpenMapTiles schema), drawn on a globe.
//
// Things worth knowing when touching this file:
// - OpenFreeMap's low-zoom tiles are huge (a z2 tile is ~600 KB gzipped, ~1.3 MB decoded), so for a few seconds after a
//   long flyTo the globe has no data. A tiny bundled Natural Earth 110 m land layer (`land-fb`) is drawn below the vector
//   layers up to z5 so the globe is never blank; above z5 the background switches to the land colour and the (accurate)
//   vector water polygons carve the sea out of it.
// - The vector `aerodrome_label` layer only exists from z8, so mid zooms use a bundled list of airports (`airports`,
//   OurAirports, public domain) with the same look; the vector one takes over at z8.
// - Atmosphere: MapLibre's globe atmosphere is a physical scattering shader, independent of sky colours; the canvas is
//   transparent around the globe so the CSS space background (and stars) show through.
import type { ExpressionSpecification, GeoJSONSourceSpecification, LayerSpecification, StyleSpecification } from "maplibre-gl";
import airportList from "./airports.json";
import land110 from "./land110.json";

export type Theme = "dark" | "light";
export interface BasemapOptions { satellite?: boolean; /** satellite tile size in CSS px (128 = sharp on dense screens) */ satTileSize?: number }

export const ACCENT = { dark: "#F5B544", light: "#D4900F" } as const;

const P = {
  dark: { bg: "#0e1117", land: "#1a1e27", water: "#090c12", wood: "#1c222b", park: "#1c232b", road: "#272c37", roadMajor: "#323847",
    border: "#4a5263", borderState: "#2b313d", label: "#8d96a7", labelStrong: "#c3cad6", halo: "#0e1117", runway: "#343b49", night: "#02040a" },
  light: { bg: "#e9ecf0", land: "#f2f3f5", water: "#cdd5de", wood: "#e5e9e6", park: "#e3e8e3", road: "#ffffff", roadMajor: "#ffffff",
    border: "#aeb4bd", borderState: "#cfd3d8", label: "#656c76", labelStrong: "#363c44", halo: "#f2f3f5", runway: "#d4d8de", night: "#0a1226" },
};

const name: ExpressionSpecification = ["coalesce", ["get", "name:fr"], ["get", "name:latin"], ["get", "name"]];
const FONT = ["Noto Sans Regular"];
const FONT_BOLD = ["Noto Sans Bold"];

const EMPTY_FC = { type: "FeatureCollection", features: [] } as const;

/** Bundled airports as GeoJSON points: props `iata`, `tier` (0 = global hubs … 2 = regional). */
const AIRPORTS_GEOJSON = {
  type: "FeatureCollection",
  features: (airportList as [string, number, number, number][]).map(([iata, lat, lon, tier]) => ({
    type: "Feature", geometry: { type: "Point", coordinates: [lon, lat] }, properties: { iata, tier },
  })),
} as const;

/** Layers that disappear when the satellite imagery is shown. */
const VECTOR_FILL_LAYERS = ["land-fb", "wood", "ice", "park", "residential", "water", "waterway", "aeroway-area"] as const;

/** Colours for labels/borders that must stay legible on imagery. */
function satColors(sat: boolean, c: (typeof P)["dark"]) {
  return sat
    ? { label: "#f1f4f8", labelStrong: "#ffffff", halo: "rgba(8,12,20,0.78)", border: "rgba(255,255,255,0.55)", borderState: "rgba(255,255,255,0.28)" }
    : { label: c.label, labelStrong: c.labelStrong, halo: c.halo, border: c.border, borderState: c.borderState };
}

export function buildStyle(theme: Theme, opts: BasemapOptions = {}): StyleSpecification {
  const c = P[theme];
  const sat = !!opts.satellite;
  const s = satColors(sat, c);
  const src = { source: "omt" } as const;
  const vis = (hidden: boolean) => ({ visibility: hidden ? "none" : "visible" }) as const;

  const airportTiers: LayerSpecification[] = [
    { tier: 0, min: 3.2 }, { tier: 1, min: 5.2 }, { tier: 2, min: 6.8 },
  ].flatMap(({ tier, min }): LayerSpecification[] => [
    { id: `airport-s${tier}-dot`, type: "circle", source: "airports", minzoom: min, maxzoom: 8, filter: ["==", ["get", "tier"], tier],
      paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 3, 1.6, 8, 2.6], "circle-color": s.labelStrong, "circle-opacity": 0.85,
        "circle-stroke-color": s.halo, "circle-stroke-width": 1 } },
    { id: `airport-s${tier}-label`, type: "symbol", source: "airports", minzoom: min + 0.4, maxzoom: 8, filter: ["==", ["get", "tier"], tier],
      layout: { "text-field": ["get", "iata"], "text-font": FONT_BOLD, "text-size": ["interpolate", ["linear"], ["zoom"], 3, 9, 8, 11],
        "text-letter-spacing": 0.08, "text-anchor": "top", "text-offset": [0, 0.55], "text-optional": true, "symbol-sort-key": tier },
      paint: { "text-color": s.label, "text-halo-color": s.halo, "text-halo-width": 1.4 } },
  ]);

  const layers: LayerSpecification[] = [
    { id: "bg", type: "background", paint: { "background-color": ["interpolate", ["linear"], ["zoom"], 4.6, c.water, 5.4, c.land] } },
    { id: "land-fb", type: "fill", source: "land", paint: { "fill-color": c.land, "fill-opacity": ["interpolate", ["linear"], ["zoom"], 4.6, 1, 5.4, 0], "fill-antialias": true } },
    { id: "sat", type: "raster", source: "sat", layout: vis(!sat), paint: { "raster-fade-duration": 120, "raster-saturation": -0.08, "raster-brightness-max": 0.92 } },
    { id: "wood", type: "fill", ...src, "source-layer": "landcover", filter: ["in", ["get", "class"], ["literal", ["wood", "forest"]]], paint: { "fill-color": c.wood, "fill-opacity": 0.6 } },
    { id: "ice", type: "fill", ...src, "source-layer": "landcover", filter: ["in", ["get", "subclass"], ["literal", ["glacier", "ice_shelf"]]], paint: { "fill-color": c.bg } },
    { id: "park", type: "fill", ...src, "source-layer": "park", minzoom: 8, paint: { "fill-color": c.park } },
    { id: "residential", type: "fill", ...src, "source-layer": "landuse", minzoom: 9, filter: ["==", ["get", "class"], "residential"], paint: { "fill-color": c.bg, "fill-opacity": 0.5 } },
    { id: "water", type: "fill", ...src, "source-layer": "water", filter: ["!=", ["get", "brunnel"], "tunnel"], paint: { "fill-color": c.water } },
    { id: "waterway", type: "line", ...src, "source-layer": "waterway", minzoom: 8, paint: { "line-color": c.water, "line-width": 1 } },
    { id: "aeroway-area", type: "fill", ...src, "source-layer": "aeroway", minzoom: 10, filter: ["match", ["geometry-type"], ["Polygon", "MultiPolygon"], true, false], paint: { "fill-color": c.bg } },
    // Day/night: nested twilight bands (see ui/sun.ts), drawn over land and sea, under everything else.
    { id: "night", type: "fill", source: "night", paint: { "fill-color": c.night, "fill-opacity": ["get", "o"], "fill-antialias": false } },
    { id: "runway", type: "line", ...src, "source-layer": "aeroway", minzoom: 10, filter: ["in", ["get", "class"], ["literal", ["runway", "taxiway"]]],
      paint: { "line-color": sat ? "rgba(255,255,255,0.5)" : c.runway, "line-width": ["interpolate", ["exponential", 1.5], ["zoom"], 10, ["match", ["get", "class"], "runway", 2, 0.5], 16, ["match", ["get", "class"], "runway", 40, 8]] } },
    { id: "road-minor", type: "line", ...src, "source-layer": "transportation", minzoom: 12, filter: ["in", ["get", "class"], ["literal", ["minor", "service", "tertiary"]]], paint: { "line-color": sat ? "rgba(255,255,255,0.22)" : c.road, "line-width": 1 } },
    { id: "road-major", type: "line", ...src, "source-layer": "transportation", minzoom: 6, filter: ["in", ["get", "class"], ["literal", ["motorway", "trunk", "primary", "secondary"]]],
      layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": sat ? "rgba(255,255,255,0.32)" : c.roadMajor, "line-width": ["interpolate", ["linear"], ["zoom"], 6, 0.5, 14, 3], "line-opacity": ["interpolate", ["linear"], ["zoom"], 6, 0.5, 9, 1] } },
    { id: "border-state", type: "line", ...src, "source-layer": "boundary", minzoom: 4, filter: ["all", ["==", ["get", "admin_level"], 4], ["!=", ["get", "maritime"], 1]], paint: { "line-color": s.borderState, "line-width": 0.75, "line-dasharray": [2, 2] } },
    { id: "border-country", type: "line", ...src, "source-layer": "boundary", filter: ["all", ["==", ["get", "admin_level"], 2], ["!=", ["get", "maritime"], 1]], paint: { "line-color": s.border, "line-width": ["interpolate", ["linear"], ["zoom"], 1, 0.6, 8, 1.4] } },
    ...airportTiers,
    { id: "airport-dot", type: "circle", ...src, "source-layer": "aerodrome_label", minzoom: 8, filter: ["has", "iata"],
      paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 8, 2.6, 13, 4], "circle-color": s.labelStrong, "circle-opacity": 0.9, "circle-stroke-color": s.halo, "circle-stroke-width": 1.2 } },
    { id: "airport-label", type: "symbol", ...src, "source-layer": "aerodrome_label", minzoom: 8, filter: ["has", "iata"],
      layout: { "text-field": ["step", ["zoom"], ["get", "iata"], 10.5, ["concat", ["get", "iata"], "  ·  ", name]],
        "text-font": FONT_BOLD, "text-size": ["interpolate", ["linear"], ["zoom"], 8, 11, 13, 13], "text-letter-spacing": 0.06,
        "text-anchor": "top", "text-offset": [0, 0.7], "text-optional": true, "text-max-width": 12 },
      paint: { "text-color": s.label, "text-halo-color": s.halo, "text-halo-width": 1.4 } },
    { id: "place-city", type: "symbol", ...src, "source-layer": "place", minzoom: 4, filter: ["in", ["get", "class"], ["literal", ["city", "town"]]],
      layout: { "text-field": name, "text-font": FONT, "text-size": ["interpolate", ["linear"], ["zoom"], 4, 10, 10, 14], "text-max-width": 8, "symbol-sort-key": ["get", "rank"] },
      paint: { "text-color": s.label, "text-halo-color": s.halo, "text-halo-width": 1.2 } },
    { id: "place-country", type: "symbol", ...src, "source-layer": "place", maxzoom: 7, filter: ["==", ["get", "class"], "country"],
      layout: { "text-field": name, "text-font": FONT_BOLD, "text-size": ["interpolate", ["linear"], ["zoom"], 1, 10, 5, 14], "text-max-width": 6 },
      paint: { "text-color": s.labelStrong, "text-halo-color": s.halo, "text-halo-width": 1.2, "text-opacity": 0.85 } },
  ];

  const fillIds = new Set<string>(VECTOR_FILL_LAYERS);
  if (sat) for (const l of layers) if (fillIds.has(l.id)) l.layout = { ...(l.layout ?? {}), visibility: "none" } as typeof l.layout;

  return {
    version: 8,
    projection: { type: "globe" },
    glyphs: "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf",
    sky: { "atmosphere-blend": ["interpolate", ["linear"], ["zoom"], 0, 1, 4, 0.85, 7, 0] },
    sources: {
      // maxzoom is explicit: the TileJSON says 14 and a missing value would trigger needless requests above it.
      omt: { type: "vector", url: "https://tiles.openfreemap.org/planet", maxzoom: 14,
        attribution: '<a href="https://openfreemap.org">OpenFreeMap</a> © <a href="https://www.openmaptiles.org/">OpenMapTiles</a> © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' },
      // maxzoom 4: 110 m data gains nothing from finer tiles, and z4-5.4 then reuse drawn tiles instead of queueing new ones
      // behind the plane updates on the workers (a queued tile showed as a sea-coloured square over land).
      land: { type: "geojson", data: land110 as unknown as GeoJSONSourceSpecification["data"], tolerance: 0.4, maxzoom: 4, buffer: 64 },
      airports: { type: "geojson", data: AIRPORTS_GEOJSON as unknown as GeoJSONSourceSpecification["data"], maxzoom: 8 },
      night: { type: "geojson", data: EMPTY_FC as unknown as GeoJSONSourceSpecification["data"] },
      // esri:// is a protocol registered in imagery.ts (sharded, cached, prefetched)
      sat: { type: "raster", tiles: ["esri://{z}/{y}/{x}"], tileSize: opts.satTileSize ?? 256, maxzoom: 18,
        attribution: "Imagery © Esri, Maxar, Earthstar Geographics" },
    },
    layers,
  };
}
