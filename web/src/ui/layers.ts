// The "Calques" menu: one place for every map layer, the theme, the altitude legend and the filters.
import { ALT_MAX, CATS, type Cat, type Filters, activeCount, heavyOnly, parseFilters } from "../lib/filters";
import { fmtInt } from "../lib/core";
import { type LayerPrefs, parsePrefs } from "../lib/prefs";
import { WIND_LEVELS } from "../lib/winds";
import { closeOthers, registerPopover } from "./popovers";
import { hide, show, shown } from "./motion";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const get = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const set = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } };

// v2: weather back to off by default; the new key drops prefs saved under the old radar-on default
const PREFS_KEY = "stratus.layers.v2", FILTERS_KEY = "stratus.filters";
export const loadPrefs = () => parsePrefs(get(PREFS_KEY), { sat: get("stratus.sat"), radar: get("stratus.radar") });
export const loadFilters = () => parseFilters(get(FILTERS_KEY));

export interface LayersHooks {
  onPrefs(p: LayerPrefs, key: keyof LayerPrefs): void;
  onFilters(f: Filters): void;
}

const altText = (f: Filters) => {
  const lo = f.altMin > 0, hi = f.altMax < ALT_MAX;
  if (!lo && !hi) return "Toutes";
  if (lo && hi) return `${fmtInt(f.altMin)} – ${fmtInt(f.altMax)} ft`;
  return lo ? `≥ ${fmtInt(f.altMin)} ft` : `≤ ${fmtInt(f.altMax)} ft`;
};

export class LayersMenu {
  private prefs: LayerPrefs;
  private filters: Filters;
  private menu = $("layers");
  private btn = $("btn-layers");
  private prefixTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private hooks: LayersHooks) {
    this.prefs = loadPrefs();
    this.filters = loadFilters();
    registerPopover({ el: this.menu, trigger: this.btn, isOpen: () => this.isOpen, close: () => this.close(), outside: true });
    this.btn.addEventListener("click", () => this.toggle());
    this.menu.querySelector("[data-close]")!.addEventListener("click", () => this.close());

    const bind = (id: string, key: Exclude<keyof LayerPrefs, "windLevel">) => {
      const el = $<HTMLInputElement>(id);
      el.checked = this.prefs[key];
      el.addEventListener("change", () => this.setPref(key, el.checked));
    };
    bind("lay-radar", "radar"); bind("lay-winds", "winds"); bind("lay-metar", "metar"); bind("lay-sat", "satellite"); bind("lay-est", "est");

    const levels = $("wind-levels");
    levels.replaceChildren(...WIND_LEVELS.map((l) => {
      const b = document.createElement("button");
      b.type = "button"; b.dataset.level = l.id; b.setAttribute("role", "radio"); b.textContent = l.label; b.title = `${l.hint}`;
      return b;
    }));
    levels.addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>("button[data-level]");
      if (b) this.setPref("windLevel", b.dataset.level!);
    });
    this.paintWind();

    this.initFilters();
  }

  get isOpen() { return shown(this.menu); }
  get state(): { prefs: LayerPrefs; filters: Filters } { return { prefs: this.prefs, filters: this.filters }; }
  open() { closeOthers(this.menu); show(this.menu); this.btn.setAttribute("aria-expanded", "true"); }
  close() { hide(this.menu); this.btn.setAttribute("aria-expanded", "false"); }
  toggle() { this.isOpen ? this.close() : this.open(); }

  /** Change a preference (from the UI or, e.g., when the radar could not load). */
  setPref<K extends keyof LayerPrefs>(key: K, value: LayerPrefs[K], notify = true) {
    this.prefs = { ...this.prefs, [key]: value };
    if (notify) set(PREFS_KEY, JSON.stringify(this.prefs)); // a silent change (e.g. the radar failed to load) is not the user's choice
    const ids: Partial<Record<keyof LayerPrefs, string>> = { radar: "lay-radar", winds: "lay-winds", metar: "lay-metar", satellite: "lay-sat", est: "lay-est" };
    const id = ids[key];
    if (id) $<HTMLInputElement>(id).checked = Boolean(value);
    this.paintWind();
    if (notify) this.hooks.onPrefs(this.prefs, key);
  }

  private paintWind() {
    $("wind-levels").hidden = !this.prefs.winds;
    for (const b of $("wind-levels").querySelectorAll<HTMLElement>("button")) b.setAttribute("aria-checked", String(b.dataset.level === this.prefs.windLevel));
  }

  // ----- filters -----
  private initFilters() {
    const cats = $("f-cats");
    cats.replaceChildren(...CATS.map((c) => {
      const b = document.createElement("button");
      b.type = "button"; b.dataset.cat = c.id; b.textContent = c.label;
      return b;
    }));
    cats.addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>("button[data-cat]");
      if (!b) return;
      const id = b.dataset.cat as Cat;
      this.setFilters({ ...this.filters, cats: this.filters.cats.includes(id) ? this.filters.cats.filter((x) => x !== id) : [...this.filters.cats, id] });
    });
    $<HTMLInputElement>("f-heavy").addEventListener("change", (e) => {
      this.setFilters({ ...this.filters, cats: (e.target as HTMLInputElement).checked ? ["heavy"] : [] });
    });
    const min = $<HTMLInputElement>("f-alt-min"), max = $<HTMLInputElement>("f-alt-max");
    min.addEventListener("input", () => this.setFilters({ ...this.filters, altMin: Number(min.value), altMax: Math.max(Number(min.value), this.filters.altMax) }));
    max.addEventListener("input", () => this.setFilters({ ...this.filters, altMax: Number(max.value), altMin: Math.min(Number(max.value), this.filters.altMin) }));
    $<HTMLInputElement>("f-prefix").addEventListener("input", (e) => {
      const v = (e.target as HTMLInputElement).value;
      clearTimeout(this.prefixTimer);
      this.prefixTimer = setTimeout(() => this.setFilters({ ...this.filters, prefix: v }, false), 180);
    });
    $("f-reset").addEventListener("click", () => this.setFilters({ altMin: 0, altMax: ALT_MAX, cats: [], prefix: "" }));
    this.paintFilters(true);
    if (activeCount(this.filters)) $<HTMLDetailsElement>("filters").open = true;
  }

  private setFilters(f: Filters, repaint = true) {
    this.filters = f;
    set(FILTERS_KEY, JSON.stringify(f));
    this.paintFilters(repaint);
    this.hooks.onFilters(f);
  }

  private paintFilters(inputs: boolean) {
    const f = this.filters, n = activeCount(f);
    for (const b of $("f-cats").querySelectorAll<HTMLElement>("button")) b.setAttribute("aria-pressed", String(f.cats.includes(b.dataset.cat as Cat)));
    $<HTMLInputElement>("f-heavy").checked = heavyOnly(f);
    const min = $<HTMLInputElement>("f-alt-min"), max = $<HTMLInputElement>("f-alt-max");
    min.value = String(f.altMin); max.value = String(f.altMax);
    min.style.setProperty("--v", `${(f.altMin / ALT_MAX) * 100}%`); max.style.setProperty("--v", `${(f.altMax / ALT_MAX) * 100}%`);
    $("f-alt-text").textContent = altText(f);
    if (inputs) $<HTMLInputElement>("f-prefix").value = f.prefix;
    const badge = $("filters-count");
    badge.hidden = !n; badge.textContent = String(n);
    $("f-reset").hidden = !n;
    this.btn.dataset.badge = n ? "1" : "0";
  }
}
