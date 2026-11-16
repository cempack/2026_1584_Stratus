// Light / dark, chosen in the layers menu. Light is the default; the user's explicit choice is remembered (the system preference does not decide).
import type { Theme } from "../map/style";

const KEY = "stratus.theme";
const read = (): Theme => { try { return localStorage.getItem(KEY) === "dark" ? "dark" : "light"; } catch { return "light"; } };

export const currentTheme = (): Theme => (document.documentElement.dataset.theme === "dark" ? "dark" : "light");

export function initTheme(onChange: (t: Theme) => void) {
  const buttons = [...document.querySelectorAll<HTMLElement>("[data-theme-set]")];
  const apply = (t: Theme, notify: boolean) => {
    document.documentElement.dataset.theme = t;
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", t === "dark" ? "#070a11" : "#eef1f6");
    for (const b of buttons) b.setAttribute("aria-checked", String(b.dataset.themeSet === t));
    if (notify) onChange(t);
  };
  apply(read(), false);
  for (const b of buttons) {
    b.addEventListener("click", () => {
      const next: Theme = b.dataset.themeSet === "dark" ? "dark" : "light";
      if (next === currentTheme()) return;
      try { localStorage.setItem(KEY, next); } catch { /* private mode */ }
      apply(next, true);
    });
  }
}
