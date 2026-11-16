// Formatting for the airport panel (METAR decoded in French, ETA, runways). Pure and unit-tested.
import type { Metar, Runway } from "../api";
import { fmtInt } from "./core";

const dec = (n: number, d = 1) => n.toFixed(d).replace(".", ",");

export type FlightCategory = "VFR" | "MVFR" | "IFR" | "LIFR";
export const CATEGORY_HINT: Record<FlightCategory, string> = {
  VFR: "Conditions visuelles", MVFR: "Visuelles marginales", IFR: "Vol aux instruments", LIFR: "Instruments, très bas",
};
/** Calm, desaturated colours (shared by the map dots and the badge). */
export const CATEGORY_COLOR: Record<FlightCategory | "none", string> = { VFR: "#3fa56f", MVFR: "#4a86d6", IFR: "#d8584b", LIFR: "#a45bc4", none: "#9aa3b2" };
export const categoryOf = (m: { flight_category?: string | null } | null | undefined): FlightCategory | null => {
  const c = m?.flight_category;
  return c === "VFR" || c === "MVFR" || c === "IFR" || c === "LIFR" ? c : null;
};

export function fmtEta(etaS: number | null | undefined): string {
  if (etaS == null || !Number.isFinite(etaS)) return "—";
  if (etaS < 60) return "imminente";
  const m = Math.round(etaS / 60);
  return m < 60 ? `dans ${m} min` : `dans ${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")}`;
}

export function windText(m: Pick<Metar, "wind_dir" | "wind_kt" | "gust_kt">): string {
  if (m.wind_kt == null) return "—";
  if (m.wind_kt < 1) return "Calme";
  const dir = m.wind_dir == null ? "Variable" : `${String(Math.round(m.wind_dir) % 360).padStart(3, "0")}°`;
  const gust = m.gust_kt != null && m.gust_kt > m.wind_kt ? `, rafales ${fmtInt(m.gust_kt)} kt` : "";
  return `${dir} · ${fmtInt(m.wind_kt)} kt${gust}`;
}

export function visibilityText(m: Pick<Metar, "vis_km">): string {
  if (m.vis_km == null) return "—";
  if (m.vis_km >= 10) return "10 km et plus";
  if (m.vis_km < 1) return `${fmtInt(m.vis_km * 1000)} m`;
  return `${dec(m.vis_km)} km`;
}

export const ceilingText = (m: Pick<Metar, "ceiling_ft">) => (m.ceiling_ft == null ? "Aucun" : `${fmtInt(m.ceiling_ft)} ft`);

const COVER: Record<string, string> = { FEW: "Peu", SCT: "Épars", BKN: "Fragmenté", OVC: "Couvert", VV: "Ciel obscurci", CLR: "Dégagé", SKC: "Dégagé", NSC: "Dégagé", CAVOK: "Dégagé" };
export function cloudsText(m: Pick<Metar, "clouds">): string {
  const c = m.clouds ?? [];
  if (!c.length) return "Dégagé";
  return c.map((l) => `${COVER[l.cover] ?? l.cover}${l.base_ft != null ? ` ${fmtInt(l.base_ft)} ft` : ""}`).join(" · ");
}

export const tempText = (m: Pick<Metar, "temp_c" | "dew_c">) =>
  m.temp_c == null ? "—" : `${Math.round(m.temp_c)} °C${m.dew_c != null ? ` · rosée ${Math.round(m.dew_c)} °C` : ""}`.replace(/-/g, "−");
export const qnhText = (m: Pick<Metar, "qnh_hpa">) => (m.qnh_hpa == null ? "—" : `${fmtInt(m.qnh_hpa)} hPa`);

const SURFACE: Record<string, string> = { ASP: "asphalte", CON: "béton", GRS: "herbe", GRE: "gravillons", GVL: "gravier", DIRT: "terre", TURF: "gazon", SAND: "sable", WATER: "eau", SNOW: "neige", ICE: "glace" };
export function runwayText(r: Runway): { ident: string; length: string; detail: string } {
  const surface = r.surface ? SURFACE[r.surface.toUpperCase()] ?? r.surface.toLowerCase() : "";
  return {
    ident: [r.le_ident, r.he_ident].filter(Boolean).join(" / "),
    length: r.length_ft ? `${fmtInt(r.length_ft * 0.3048)} m` : "—",
    detail: [surface, r.lighted ? "balisée" : ""].filter(Boolean).join(" · "),
  };
}

export const PHASE_LABEL: Record<string, string> = {
  inbound: "En route", approach: "Approche", final: "Finale", ground: "Au sol", climbing: "Montée", enroute: "En route",
};
