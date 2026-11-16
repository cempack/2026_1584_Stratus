// Layer preferences kept in localStorage. Parsing is tolerant: anything odd falls back to the defaults.

export interface LayerPrefs { radar: boolean; winds: boolean; windLevel: string; metar: boolean; satellite: boolean; est: boolean }
export const DEFAULT_PREFS: LayerPrefs = { radar: true, winds: false, windLevel: "250", metar: false, satellite: false, est: true };
const LEVELS = ["surface", "850", "500", "250"];

/** `legacy` carries the pre-menu keys (stratus.sat = "1", stratus.radar = "0"). */
export function parsePrefs(raw: string | null, legacy: { sat?: string | null; radar?: string | null } = {}): LayerPrefs {
  const d: LayerPrefs = { ...DEFAULT_PREFS, satellite: legacy.sat === "1", radar: legacy.radar !== "0" };
  try {
    const j = JSON.parse(raw ?? "null") as Partial<LayerPrefs> | null;
    if (!j || typeof j !== "object") return d;
    const b = (v: unknown, def: boolean) => (typeof v === "boolean" ? v : def);
    return {
      radar: b(j.radar, d.radar), winds: b(j.winds, d.winds), metar: b(j.metar, d.metar), satellite: b(j.satellite, d.satellite), est: b(j.est, d.est),
      windLevel: typeof j.windLevel === "string" && LEVELS.includes(j.windLevel) ? j.windLevel : d.windLevel,
    };
  } catch { return d; }
}
