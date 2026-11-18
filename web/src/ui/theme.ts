// Theme: Auto (follows the sun where the user is; the default), Light, Dark or System (the OS setting).
// The resolved light/dark is applied at import time so the map is built with the right palette; later changes
// cross-fade the interface (and the map, through MapLibre paint transitions) instead of snapping.
import type { Theme } from "../map/style";
import { isNight, localPlace, nextSwitch } from "../lib/daylight";

export type ThemeMode = "auto" | "light" | "dark" | "system";
const KEY = "stratus.theme.mode";
const MODES: ThemeMode[] = ["auto", "light", "dark", "system"];

const readMode = (): ThemeMode => {
  try { const v = localStorage.getItem(KEY) as ThemeMode | null; return v && MODES.includes(v) ? v : "auto"; } catch { return "auto"; }
};
const systemDark = () => matchMedia("(prefers-color-scheme: dark)").matches;

export function resolveTheme(mode: ThemeMode, now = new Date()): Theme {
  if (mode === "light" || mode === "dark") return mode;
  if (mode === "system") return systemDark() ? "dark" : "light";
  return isNight(now, localPlace(now)) ? "dark" : "light";
}

export const currentTheme = (): Theme => (document.documentElement.dataset.theme === "dark" ? "dark" : "light");

function setRoot(t: Theme) {
  document.documentElement.dataset.theme = t;
  // the splash (index.html) reuses this, so a reload never flashes the other theme before this module runs
  try { localStorage.setItem("stratus.theme.resolved", t); } catch { /* private mode */ }
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", t === "dark" ? "#070a11" : "#eef1f6");
}

let mode = readMode();
setRoot(resolveTheme(mode)); // before the map is created

const hhmm = (d: Date) => d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });

/** One line under the switch: what the current mode does right now. */
export function themeHint(m: ThemeMode, now = new Date()): string {
  if (m === "system") return `Suit le réglage de l’appareil · ${systemDark() ? "sombre" : "clair"}`;
  if (m !== "auto") return m === "dark" ? "Toujours sombre" : "Toujours clair";
  const next = nextSwitch(now, localPlace(now));
  const dark = isNight(now, localPlace(now));
  return next ? `Suit le soleil · ${dark ? "clair" : "sombre"} à ${hhmm(next)}` : `Suit le soleil · ${dark ? "nuit polaire" : "jour polaire"}`;
}

export function initTheme(onChange: (t: Theme) => void) {
  const buttons = [...document.querySelectorAll<HTMLElement>("[data-theme-mode]")];
  const hint = document.getElementById("theme-hint");
  let fadeTimer: ReturnType<typeof setTimeout> | undefined;

  const sync = (animate: boolean) => {
    for (const b of buttons) b.setAttribute("aria-checked", String(b.dataset.themeMode === mode));
    if (hint) hint.textContent = themeHint(mode);
    const t = resolveTheme(mode);
    if (t === currentTheme()) return;
    if (animate && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
      // a short-lived class turns on colour transitions everywhere, only for the switch itself
      document.documentElement.classList.add("theme-fade");
      clearTimeout(fadeTimer);
      fadeTimer = setTimeout(() => document.documentElement.classList.remove("theme-fade"), 800);
    }
    setRoot(t);
    onChange(t);
  };

  sync(false);
  for (const b of buttons) {
    b.addEventListener("click", () => {
      const m = b.dataset.themeMode as ThemeMode;
      if (!MODES.includes(m) || m === mode) return;
      mode = m;
      try { localStorage.setItem(KEY, m); } catch { /* private mode */ }
      sync(true);
    });
  }
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { if (mode === "system") sync(true); });
  // the sun moves: re-check every minute and whenever the tab comes back
  setInterval(() => { if (!document.hidden) sync(true); }, 60_000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) sync(true); });
}
