// Custom, muted basemap on OpenFreeMap vector tiles (OpenMapTiles schema). Dark and light palettes.
import type { StyleSpecification, LayerSpecification, ExpressionSpecification } from "maplibre-gl";

export type Theme = "dark" | "light";

const P = {
  dark: { bg: "#16181c", land: "#1b1e23", water: "#0f1114", wood: "#1e2126", park: "#1d2024", road: "#2a2e35", roadMajor: "#33383f",
    border: "#3b4049", borderState: "#2c3037", label: "#8a9099", labelStrong: "#b4b9c1", halo: "#16181c", runway: "#2f343b", space: "#0b0c0e" },
  light: { bg: "#eef0f2", land: "#f3f4f6", water: "#cfd6de", wood: "#e6e9e7", park: "#e4e8e4", road: "#ffffff", roadMajor: "#ffffff",
    border: "#b3b8bf", borderState: "#cfd3d8", label: "#6b7179", labelStrong: "#3c4148", halo: "#f3f4f6", runway: "#d7dbe0", space: "#dfe3e8" },
};

const name: ExpressionSpecification = ["coalesce", ["get", "name:fr"], ["get", "name:latin"], ["get", "name"]];

export function buildStyle(theme: Theme): StyleSpecification {
  const c = P[theme];
  const src = { source: "omt" } as const;
  const layers: LayerSpecification[] = [
    { id: "bg", type: "background", paint: { "background-color": c.land } },
    { id: "wood", type: "fill", ...src, "source-layer": "landcover", filter: ["in", ["get", "class"], ["literal", ["wood", "forest"]]], paint: { "fill-color": c.wood, "fill-opacity": 0.6 } },
    { id: "ice", type: "fill", ...src, "source-layer": "landcover", filter: ["in", ["get", "subclass"], ["literal", ["glacier", "ice_shelf"]]], paint: { "fill-color": c.bg } },
    { id: "park", type: "fill", ...src, "source-layer": "park", minzoom: 8, paint: { "fill-color": c.park } },
    { id: "residential", type: "fill", ...src, "source-layer": "landuse", minzoom: 9, filter: ["==", ["get", "class"], "residential"], paint: { "fill-color": c.bg, "fill-opacity": 0.5 } },
    { id: "water", type: "fill", ...src, "source-layer": "water", filter: ["!=", ["get", "brunnel"], "tunnel"], paint: { "fill-color": c.water } },
    { id: "waterway", type: "line", ...src, "source-layer": "waterway", minzoom: 8, paint: { "line-color": c.water, "line-width": 1 } },
    { id: "aeroway-area", type: "fill", ...src, "source-layer": "aeroway", minzoom: 10, filter: ["match", ["geometry-type"], ["Polygon", "MultiPolygon"], true, false], paint: { "fill-color": c.bg } },
    { id: "runway", type: "line", ...src, "source-layer": "aeroway", minzoom: 10, filter: ["in", ["get", "class"], ["literal", ["runway", "taxiway"]]],
      paint: { "line-color": c.runway, "line-width": ["interpolate", ["exponential", 1.5], ["zoom"], 10, ["match", ["get", "class"], "runway", 2, 0.5], 16, ["match", ["get", "class"], "runway", 40, 8]] } },
    { id: "road-minor", type: "line", ...src, "source-layer": "transportation", minzoom: 12, filter: ["in", ["get", "class"], ["literal", ["minor", "service", "tertiary"]]], paint: { "line-color": c.road, "line-width": 1 } },
    { id: "road-major", type: "line", ...src, "source-layer": "transportation", minzoom: 6, filter: ["in", ["get", "class"], ["literal", ["motorway", "trunk", "primary", "secondary"]]],
      layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": c.roadMajor, "line-width": ["interpolate", ["linear"], ["zoom"], 6, 0.5, 14, 3], "line-opacity": ["interpolate", ["linear"], ["zoom"], 6, 0.5, 9, 1] } },
    { id: "border-state", type: "line", ...src, "source-layer": "boundary", minzoom: 4, filter: ["all", ["==", ["get", "admin_level"], 4], ["!=", ["get", "maritime"], 1]], paint: { "line-color": c.borderState, "line-width": 0.75, "line-dasharray": [2, 2] } },
    { id: "border-country", type: "line", ...src, "source-layer": "boundary", filter: ["all", ["==", ["get", "admin_level"], 2], ["!=", ["get", "maritime"], 1]], paint: { "line-color": c.border, "line-width": ["interpolate", ["linear"], ["zoom"], 1, 0.6, 8, 1.4] } },
    { id: "airport-label", type: "symbol", ...src, "source-layer": "aerodrome_label", minzoom: 8, filter: ["has", "iata"],
      layout: { "text-field": ["concat", ["get", "iata"], ["case", [">=", ["zoom"], 11], ["concat", " · ", name], ""]], "text-font": ["Noto Sans Regular"], "text-size": 11 },
      paint: { "text-color": c.label, "text-halo-color": c.halo, "text-halo-width": 1.2 } },
    { id: "place-city", type: "symbol", ...src, "source-layer": "place", minzoom: 4, filter: ["in", ["get", "class"], ["literal", ["city", "town"]]],
      layout: { "text-field": name, "text-font": ["Noto Sans Regular"], "text-size": ["interpolate", ["linear"], ["zoom"], 4, 10, 10, 14], "text-max-width": 8,
        "symbol-sort-key": ["get", "rank"] },
      paint: { "text-color": c.label, "text-halo-color": c.halo, "text-halo-width": 1.2 } },
    { id: "place-country", type: "symbol", ...src, "source-layer": "place", maxzoom: 7, filter: ["==", ["get", "class"], "country"],
      layout: { "text-field": name, "text-font": ["Noto Sans Bold"], "text-size": ["interpolate", ["linear"], ["zoom"], 1, 10, 5, 14], "text-max-width": 6 },
      paint: { "text-color": c.labelStrong, "text-halo-color": c.halo, "text-halo-width": 1.2, "text-opacity": 0.85 } },
  ];
  return {
    version: 8,
    projection: { type: "globe" },
    glyphs: "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf",
    sky: { "atmosphere-blend": ["interpolate", ["linear"], ["zoom"], 0, 0.6, 5, 0.2, 7, 0], "sky-color": c.space, "horizon-color": c.bg, "fog-color": c.bg },
    sources: { omt: { type: "vector", url: "https://tiles.openfreemap.org/planet", attribution: '<a href="https://openfreemap.org">OpenFreeMap</a> © <a href="https://www.openmaptiles.org/">OpenMapTiles</a> © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' } },
    layers,
  };
}
