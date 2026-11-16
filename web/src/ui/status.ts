// Status chip: feed health and OpenSky credits from /api/status; click for details.
import { type Feed, type Status, fetchStatus, Loop, serverNow } from "../api";
import { fmtAgo, fmtInt } from "../lib/core";

const STATE: Record<string, string> = { ok: "Opérationnel", degraded: "Dégradé", rate_limited: "Limite atteinte", idle: "En veille", disabled: "Désactivé" };
const NAMES: Record<string, string> = { opensky: "OpenSky", "adsb.lol": "adsb.lol", "adsb.fi": "adsb.fi" };
type Level = "ok" | "warn" | "bad";

function feedLevel(f: Feed): Level {
  if (f.state === "ok" || f.state === "idle") return "ok";
  return f.state === "disabled" ? "warn" : f.state === "rate_limited" || f.state === "degraded" ? "warn" : "bad";
}

function health(s: Status | null): Level {
  if (!s) return "bad";
  const feeds = Object.values(s.feeds);
  if (!feeds.some((f) => f.state === "ok" || f.state === "idle")) return "bad";
  const o = s.feeds.opensky;
  if (o && (feedLevel(o) !== "ok" || (o.credits_remaining != null && o.credits_daily && o.credits_remaining / o.credits_daily < 0.08))) return "warn";
  return "ok";
}

export class StatusChip {
  private status: Status | null = null;
  private failed = false;
  private chip = document.getElementById("chip") as HTMLButtonElement;
  private pop = document.getElementById("status-pop") as HTMLElement;
  private loop: Loop;

  constructor(private areaActive: () => boolean, private onOpen: () => void) {
    this.loop = new Loop(async () => {
      try { this.status = await fetchStatus(); this.failed = false; } catch { this.failed = true; }
      this.render();
    }, () => 20_000);
    this.chip.addEventListener("click", () => this.toggle());
    this.pop.querySelector("[data-close]")!.addEventListener("click", () => this.close());
    setInterval(() => { if (!this.pop.hidden) this.render(); }, 1000);
    this.loop.start();
  }

  get isOpen() { return !this.pop.hidden; }
  toggle() { if (this.pop.hidden) { this.onOpen(); this.pop.hidden = false; this.chip.setAttribute("aria-expanded", "true"); this.render(); } else this.close(); }
  close() { this.pop.hidden = true; this.chip.setAttribute("aria-expanded", "false"); }

  private render() {
    const s = this.failed ? null : this.status;
    const lvl = health(s);
    (document.getElementById("chip-dot") as HTMLElement).className = `dot ${lvl}`;
    const o = s?.feeds.opensky;
    const credits = o?.credits_remaining != null ? `<span class="credits"> · ${fmtInt(o.credits_remaining)} crédits</span>` : "";
    document.getElementById("chip-text")!.innerHTML = s ? `${fmtInt(s.planes)} avions${credits}` : this.status ? "Connexion perdue" : "Connexion…";
    if (this.pop.hidden) return;
    const body = document.getElementById("status-body")!;
    if (!s) { body.textContent = "Le serveur ne répond pas."; return; }
    body.replaceChildren(...Object.entries(s.feeds).map(([k, f]) => this.feedEl(k, f)), this.noteEl());
  }

  private feedEl(key: string, f: Feed): HTMLElement {
    const el = document.createElement("div");
    el.className = "feed";
    const top = document.createElement("div");
    top.className = "feed-top";
    top.innerHTML = `<i class="dot ${feedLevel(f)}"></i><b></b><span></span>`;
    top.querySelector("b")!.textContent = NAMES[key] ?? key;
    top.querySelector("span")!.textContent = STATE[f.state] ?? f.state;
    el.append(top);
    if (key === "opensky" && f.credits_remaining != null && f.credits_daily) {
      const pct = Math.max(0, Math.min(100, (f.credits_remaining / f.credits_daily) * 100));
      const m = document.createElement("div");
      m.className = `meter${pct < 8 ? " low" : ""}`;
      m.innerHTML = `<i style="width:${pct.toFixed(1)}%"></i>`;
      el.append(m);
    }
    const small = document.createElement("small");
    const parts: string[] = [];
    if (key === "opensky") {
      if (f.credits_remaining != null) parts.push(`${fmtInt(f.credits_remaining)} / ${fmtInt(f.credits_daily ?? 0)} crédits`);
      if (f.mode) parts.push(f.mode === "oauth" ? "authentifié" : "anonyme");
      if (f.interval) parts.push(`toutes les ${fmtInt(f.interval)} s`);
    }
    if (f.last_ok) parts.push(`dernier relevé ${fmtAgo(serverNow() - f.last_ok)}`);
    if (f.last_error) parts.push(f.last_error);
    small.textContent = parts.join(" · ") || "Aucune donnée";
    el.append(small);
    return el;
  }

  private noteEl(): HTMLElement {
    const el = document.createElement("div");
    el.className = "feed";
    const small = document.createElement("small");
    small.textContent = this.areaActive()
      ? "Zone visible rafraîchie toutes les 5 s."
      : "Zoomez sur une zone de 250 NM ou moins pour un rafraîchissement toutes les 5 s.";
    el.append(small);
    return el;
  }
}
