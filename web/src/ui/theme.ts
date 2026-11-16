// Light / dark. Light is the default; the user's explicit choice is remembered (the system preference does not decide).
import type { Theme } from "../map/style";
import { icon } from "./icons";

const KEY = "stratus.theme";
const read = (): Theme => { try { return localStorage.getItem(KEY) === "dark" ? "dark" : "light"; } catch { return "light"; } };

export const currentTheme = (): Theme => (document.documentElement.dataset.theme === "dark" ? "dark" : "light");

export function initTheme(onChange: (t: Theme) => void) {
  const btn = document.getElementById("btn-theme")!;
  const apply = (t: Theme, notify: boolean) => {
    document.documentElement.dataset.theme = t;
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", t === "dark" ? "#070a11" : "#eef1f6");
    btn.innerHTML = icon(t === "dark" ? "sun" : "moon");
    btn.setAttribute("aria-label", t === "dark" ? "Passer au thème clair" : "Passer au thème sombre");
    if (notify) onChange(t);
  };
  apply(read(), false);
  btn.addEventListener("click", () => {
    const next: Theme = currentTheme() === "dark" ? "light" : "dark";
    try { localStorage.setItem(KEY, next); } catch { /* private mode */ }
    apply(next, true);
  });
}
