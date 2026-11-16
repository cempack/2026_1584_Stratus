import { describe, expect, it } from "vitest";
import { categoryOf, ceilingText, cloudsText, fmtEta, qnhText, runwayText, tempText, visibilityText, windText } from "./airport";

const sp = (s: string) => s.replace(/[\u202f\u00a0]/g, " ");

describe("airport panel formatting", () => {
  it("formats ETA", () => {
    expect(fmtEta(null)).toBe("—");
    expect(fmtEta(30)).toBe("imminente");
    expect(fmtEta(432)).toBe("dans 7 min");
    expect(sp(fmtEta(3900))).toBe("dans 1 h 05");
  });

  it("decodes wind, visibility, ceiling and clouds in French", () => {
    expect(windText({ wind_dir: 240, wind_kt: 12, gust_kt: 22 })).toBe("240° · 12 kt, rafales 22 kt");
    expect(windText({ wind_dir: null, wind_kt: 5, gust_kt: null })).toBe("Variable · 5 kt");
    expect(windText({ wind_dir: 0, wind_kt: 0, gust_kt: null })).toBe("Calme");
    expect(visibilityText({ vis_km: 9.7 })).toBe("9,7 km");
    expect(visibilityText({ vis_km: 0.8 })).toBe("800 m");
    expect(visibilityText({ vis_km: 16 })).toBe("10 km et plus");
    expect(ceilingText({ ceiling_ft: null })).toBe("Aucun");
    expect(sp(ceilingText({ ceiling_ft: 2500 }))).toBe("2 500 ft");
    expect(sp(cloudsText({ clouds: [{ cover: "FEW", base_ft: 1500 }, { cover: "BKN", base_ft: 2500 }] }))).toBe("Peu 1 500 ft · Fragmenté 2 500 ft");
    expect(cloudsText({ clouds: [] })).toBe("Dégagé");
    expect(tempText({ temp_c: -2, dew_c: -4 })).toBe("−2 °C · rosée −4 °C");
    expect(sp(qnhText({ qnh_hpa: 1012 }))).toBe("1 012 hPa");
  });

  it("only accepts the four flight categories", () => {
    expect(categoryOf({ flight_category: "MVFR" })).toBe("MVFR");
    expect(categoryOf({ flight_category: "xx" })).toBeNull();
    expect(categoryOf(null)).toBeNull();
  });

  it("describes runways in metres", () => {
    const r = runwayText({ le_ident: "08L", he_ident: "26R", le_heading: 85, he_heading: 265, length_ft: 13829, width_ft: 148, surface: "ASP", lighted: true, le_lat: null, le_lon: null, he_lat: null, he_lon: null });
    expect(r.ident).toBe("08L / 26R");
    expect(sp(r.length)).toBe("4 215 m");
    expect(r.detail).toBe("asphalte · balisée");
  });
});
