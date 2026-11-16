// Light / dark: follows the system until the user picks one; picking the system's own value clears the override.
import type { Theme } from "../map/style";
import { icon } from "./icons";

const KEY = "stratus.theme";
const mq = matchMedia("(prefers-color-scheme: dark)");
const system = (): Theme => (mq.matches ? "dark" : "light");
const read = (): Theme | null => { try { const v = localStorage.getItem(KEY); return v === "light" || v === "dark" ? v : null; } catch { return null; } };

export const currentTheme = (): Theme => (document.documentElement.dataset.theme === "light" ? "light" : "dark");

export function initTheme(onChange: (t: Theme) => void) {
  const btn = document.getElementById("btn-theme")!;
  const apply = (t: Theme, notify: boolean) => {
    document.documentElement.dataset.theme = t;
    btn.innerHTML = icon(t === "dark" ? "sun" : "moon");
    btn.setAttribute("aria-label", t === "dark" ? "Passer au thème clair" : "Passer au thème sombre");
    if (notify) onChange(t);
  };
  apply(read() ?? system(), false);
  btn.addEventListener("click", () => {
    const next: Theme = currentTheme() === "dark" ? "light" : "dark";
    try { if (next === system()) localStorage.removeItem(KEY); else localStorage.setItem(KEY, next); } catch { /* private mode */ }
    apply(next, true);
  });
  mq.addEventListener("change", () => { if (!read()) apply(system(), true); });
}
