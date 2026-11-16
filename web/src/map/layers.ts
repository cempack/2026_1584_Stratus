// Sources and layers drawn above the basemap: planes (live + estimated), the selected plane, trails, routes, airports,
// METAR dots, alerts. Kept as pure specs so the tests can run every one of them through the style-spec validator
// (an invalid expression once took production down).
import type { ExpressionSpecification, GeoJSONSourceSpecification, LayerSpecification } from "maplibre-gl";
import { CATEGORY_COLOR } from "../lib/airport";
import { altRamp } from "../lib/core";
import { ACCENT, type Theme } from "./style";

export const EMPTY = { type: "FeatureCollection", features: [] } as const;

export const PAL = {
  dark: { halo: "#06080c", label: "#aab2c0", labelHalo: "#0e1117", route: "#F5B544", dot: "#0e1117", casing: "#05070b", alert: "#ff7a66" },
  light: { halo: "#ffffff", label: "#4b5159", labelHalo: "#f2f3f5", route: "#D4900F", dot: "#ffffff", casing: "#ffffff", alert: "#d3432f" },
};

export const SOURCE_IDS = ["planes", "planes-est", "sel", "trail", "route", "points", "atc", "atc-live", "alerts", "metar", "apt", "fulltrack"] as const;

export interface Overlay {
  sources: Record<string, GeoJSONSourceSpecification>;
  layers: LayerSpecification[];
}

const FONT = ["Noto Sans Regular"];

export function buildOverlay(theme: Theme, opts: { atcVisible?: boolean; metarVisible?: boolean } = {}): Overlay {
  const c = PAL[theme], accent = ACCENT[theme];
  const vis = (on: boolean | undefined) => ({ visibility: on ? "visible" : "none" }) as const;
  const sources: Overlay["sources"] = {};
  for (const id of SOURCE_IDS) sources[id] = { type: "geojson", data: EMPTY as unknown as GeoJSONSourceSpecification["data"] };

  const ramp = altRamp(theme === "dark").flat();
  const altColor = ["interpolate", ["linear"], ["get", "alt"], ...ramp] as ExpressionSpecification;
  const size = (k: number) => ["interpolate", ["linear"], ["zoom"], 2, ["*", 0.36 * k, ["get", "sz"]], 5, ["*", 0.5 * k, ["get", "sz"]], 8, ["*", 0.66 * k, ["get", "sz"]], 11, ["*", 0.85 * k, ["get", "sz"]], 15, ["*", 1.05 * k, ["get", "sz"]]] as ExpressionSpecification;
  const iconLayout = (k: number, image: ExpressionSpecification = ["get", "icon"]) => ({
    "icon-image": image, "icon-rotate": ["get", "trk"], "icon-size": size(k), "icon-allow-overlap": true, "icon-ignore-placement": true,
    "icon-rotation-alignment": "map", "icon-pitch-alignment": "map", "symbol-z-order": "source",
  }) as NonNullable<Extract<LayerSpecification, { type: "symbol" }>["layout"]>;
  const notEst: ExpressionSpecification = ["!=", ["coalesce", ["get", "est"], false], true];
  const isEst: ExpressionSpecification = ["==", ["coalesce", ["get", "est"], false], true];
  const catColor = ["match", ["get", "cat"], "VFR", CATEGORY_COLOR.VFR, "MVFR", CATEGORY_COLOR.MVFR, "IFR", CATEGORY_COLOR.IFR, "LIFR", CATEGORY_COLOR.LIFR, CATEGORY_COLOR.none] as ExpressionSpecification;

  const layers: LayerSpecification[] = [
    { id: "route-line", type: "line", source: "route", layout: { "line-cap": "round" }, paint: { "line-color": c.route, "line-width": 1.6, "line-dasharray": [1.5, 2.5], "line-opacity": 0.85 } },
    // FR24 full track: drawn under the live trail, a touch softer
    { id: "fulltrack-casing", type: "line", source: "fulltrack", layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": c.casing, "line-opacity": 0.45, "line-width": ["interpolate", ["linear"], ["zoom"], 2, 3.6, 10, 5.4] } },
    { id: "fulltrack", type: "line", source: "fulltrack", layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": ["interpolate", ["linear"], ["coalesce", ["get", "alt"], 0], ...ramp] as ExpressionSpecification, "line-opacity": 0.8,
        "line-width": ["interpolate", ["linear"], ["zoom"], 2, 1.8, 10, 2.8] } },
    { id: "trail-casing", type: "line", source: "trail", filter: notEst, layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": c.casing, "line-opacity": 0.55, "line-width": ["interpolate", ["linear"], ["zoom"], 2, 4, 10, 6] } },
    { id: "trail", type: "line", source: "trail", filter: notEst, layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": ["interpolate", ["linear"], ["coalesce", ["get", "alt"], 0], ...ramp] as ExpressionSpecification,
        "line-width": ["interpolate", ["linear"], ["zoom"], 2, 2, 10, 3.2] } },
    // the predicted stretch between the last real fix and the estimated position
    { id: "trail-est", type: "line", source: "trail", filter: isEst, layout: { "line-cap": "butt", "line-join": "round" },
      paint: { "line-color": accent, "line-width": ["interpolate", ["linear"], ["zoom"], 2, 1.6, 10, 2.4], "line-dasharray": [1.4, 1.8], "line-opacity": 0.9 } },
    { id: "apt-rwy", type: "line", source: "apt", filter: ["==", ["geometry-type"], "LineString"], layout: { "line-cap": "round" },
      paint: { "line-color": accent, "line-width": ["interpolate", ["linear"], ["zoom"], 8, 2, 14, 5], "line-opacity": 0.85 } },
    { id: "apt-ring", type: "circle", source: "apt", filter: ["==", ["geometry-type"], "Point"],
      paint: { "circle-radius": 15, "circle-color": accent, "circle-opacity": 0.1, "circle-stroke-color": accent, "circle-stroke-width": 1.4, "circle-stroke-opacity": 0.85 } },
    { id: "metar-dots", type: "circle", source: "metar", layout: vis(opts.metarVisible),
      paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 3, 3.4, 8, 5.4, 12, 7], "circle-color": catColor, "circle-opacity": 0.92, "circle-opacity-transition": { duration: 500, delay: 0 },
        "circle-stroke-color": c.dot, "circle-stroke-width": 1.6, "circle-stroke-opacity": 0.95 } },
    { id: "metar-labels", type: "symbol", source: "metar", minzoom: 6, layout: { ...vis(opts.metarVisible), "text-field": ["get", "cat"], "text-font": ["Noto Sans Bold"], "text-size": 10, "text-letter-spacing": 0.06, "text-offset": [0, 1.0], "text-anchor": "top", "text-optional": true },
      paint: { "text-color": c.label, "text-halo-color": c.labelHalo, "text-halo-width": 1.3 } },
    { id: "alert-ring", type: "circle", source: "alerts",
      paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 2, 9, 8, 14, 12, 18], "circle-color": c.alert, "circle-opacity": 0.08, "circle-stroke-color": c.alert, "circle-stroke-width": 1.5, "circle-stroke-opacity": 0.7 } },
    // estimated planes: the same silhouette, dimmed, plus a thin outline so they read as "hollow"
    { id: "planes-est", type: "symbol", source: "planes-est", layout: iconLayout(1),
      paint: { "icon-color": altColor, "icon-opacity": ["*", 0.26, ["get", "op"]] } },
    { id: "planes-est-ring", type: "symbol", source: "planes-est", layout: iconLayout(1, ["get", "ring"]),
      paint: { "icon-color": altColor, "icon-opacity": ["*", 0.95, ["get", "op"]] } },
    { id: "planes", type: "symbol", source: "planes", layout: iconLayout(1),
      paint: { "icon-color": altColor, "icon-opacity": ["get", "op"], "icon-halo-color": c.halo, "icon-halo-width": 0.8, "icon-halo-blur": 0 } },
    { id: "plane-labels", type: "symbol", source: "planes", minzoom: 8,
      layout: { "text-field": ["get", "cs"], "text-font": FONT, "text-size": 11, "text-anchor": "left", "text-offset": [1.1, 0], "text-optional": true },
      paint: { "text-color": c.label, "text-halo-color": c.labelHalo, "text-halo-width": 1.2, "text-opacity": ["get", "op"] } },
    { id: "airport-dots", type: "circle", source: "points", paint: { "circle-radius": 4.5, "circle-color": c.dot, "circle-stroke-color": accent, "circle-stroke-width": 1.8 } },
    { id: "airport-names", type: "symbol", source: "points",
      layout: { "text-field": ["get", "name"], "text-font": ["Noto Sans Bold"], "text-size": 12, "text-letter-spacing": 0.06, "text-offset": [0, -1.2], "text-anchor": "bottom", "text-allow-overlap": true },
      paint: { "text-color": accent, "text-halo-color": c.labelHalo, "text-halo-width": 1.6 } },
    { id: "atc-dots", type: "circle", source: "atc", minzoom: 2, layout: vis(opts.atcVisible),
      paint: { "circle-radius": 3.6, "circle-color": accent, "circle-opacity": 0.85, "circle-stroke-color": c.dot, "circle-stroke-width": 1.4 } },
    { id: "atc-names", type: "symbol", source: "atc", minzoom: 4, layout: { "text-field": ["get", "icao"], "text-font": FONT, "text-size": 11, "text-offset": [0, 0.9], "text-anchor": "top", ...vis(opts.atcVisible) },
      paint: { "text-color": c.label, "text-halo-color": c.labelHalo, "text-halo-width": 1.2 } },
    { id: "atc-live", type: "circle", source: "atc-live", paint: { "circle-radius": 5.5, "circle-color": accent, "circle-stroke-color": c.dot, "circle-stroke-width": 2 } },
    { id: "sel-ring", type: "circle", source: "sel", paint: { "circle-radius": 19, "circle-color": accent, "circle-opacity": 0.1, "circle-stroke-color": accent, "circle-stroke-width": 1.4, "circle-stroke-opacity": 0.9, "circle-pitch-alignment": "viewport" } },
    { id: "sel-icon", type: "symbol", source: "sel", layout: iconLayout(1.35),
      paint: { "icon-color": altColor, "icon-opacity": ["get", "op"], "icon-halo-color": accent, "icon-halo-width": 1.6 } },
  ];
  return { sources, layers };
}
