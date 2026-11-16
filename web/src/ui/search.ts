// Search box: "/" to focus, arrows to move, Enter to pick, Esc to clear. Ranking lives in lib/core.
import { type Hit, type Searchable, search } from "../lib/core";
import { icon } from "./icons";
import { hide, show, shown } from "./motion";

export interface Row { kind: "plane" | "airport"; title: string; sub: string; side: string }
export interface SearchDeps {
  items(): Iterable<Searchable>;
  describe(hit: Hit): Row | null;
  pick(hit: Hit): void;
  /** Optional slower source (the airport catalogue): merged in once it answers. */
  remote?(q: string, signal: AbortSignal): Promise<Hit[]>;
}

export function initSearch(deps: SearchDeps) {
  const input = document.getElementById("q") as HTMLInputElement;
  const list = document.getElementById("results") as HTMLUListElement;
  let hits: Hit[] = [], active = 0, timer: ReturnType<typeof setTimeout> | undefined;
  let pending = false, seq = 0, ctl: AbortController | undefined;

  const close = () => { hide(list); input.setAttribute("aria-expanded", "false"); input.removeAttribute("aria-activedescendant"); };
  const mark = () => {
    [...list.children].forEach((li, i) => li.setAttribute("aria-selected", String(i === active)));
    const cur = list.children[active] as HTMLElement | undefined;
    if (cur?.id) input.setAttribute("aria-activedescendant", cur.id);
    cur?.scrollIntoView({ block: "nearest" });
  };
  const render = (keep = false) => {
    list.replaceChildren();
    if (!input.value.trim()) return close();
    if (!hits.length) {
      const li = document.createElement("li");
      li.className = "empty"; li.textContent = pending ? "Recherche…" : "Aucun résultat";
      list.append(li);
    }
    hits.forEach((h, i) => {
      const row = deps.describe(h);
      if (!row) return;
      const li = document.createElement("li");
      li.id = `res-${i}`; li.setAttribute("role", "option");
      li.innerHTML = `<span class="ico">${icon(row.kind === "plane" ? "plane" : "pin")}</span><span class="main"><b></b><span></span></span><span class="side"></span>`;
      li.querySelector("b")!.textContent = row.title;
      (li.querySelector(".main span") as HTMLElement).textContent = row.sub;
      (li.querySelector(".side") as HTMLElement).textContent = row.side;
      li.addEventListener("mousedown", (e) => e.preventDefault());
      li.addEventListener("click", () => choose(i));
      li.addEventListener("mousemove", () => { if (active !== i) { active = i; mark(); } });
      list.append(li);
    });
    show(list); input.setAttribute("aria-expanded", "true");
    if (!keep || active >= hits.length) active = 0;
    mark();
  };
  const choose = (i: number) => {
    const h = hits[i];
    if (!h) return;
    input.value = ""; hits = []; close(); input.blur();
    deps.pick(h);
  };
  const run = () => {
    hits = search(deps.items(), input.value, 8);
    const q = input.value.trim();
    ctl?.abort(); pending = false;
    if (deps.remote && q.length >= 2) {
      pending = true; ctl = new AbortController();
      const my = ++seq;
      deps.remote(q, ctl.signal).then((extra) => {
        if (my !== seq || input.value.trim() !== q) return;
        pending = false;
        const seen = new Set(hits.map((h) => h.key));
        hits = [...hits, ...extra.filter((h) => !seen.has(h.key))].slice(0, 8);
        render(true);
      }, () => { if (my === seq) { pending = false; if (!hits.length) render(true); } });
    }
    render();
  };

  input.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(run, 60); });
  input.addEventListener("focus", () => { if (input.value.trim()) run(); });
  input.addEventListener("blur", close);
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!shown(list) && input.value.trim()) return run();
      if (hits.length) { active = (active + (e.key === "ArrowDown" ? 1 : hits.length - 1)) % hits.length; mark(); }
    } else if (e.key === "Enter") {
      e.preventDefault();
      clearTimeout(timer);
      if (!hits.length || !shown(list)) run();
      choose(active);
    } else if (e.key === "Escape") {
      e.stopPropagation();
      input.value = ""; hits = []; close(); input.blur();
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey) return;
    const el = document.activeElement as HTMLElement | null;
    if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable)) return;
    e.preventDefault();
    input.focus(); input.select();
  });
}
