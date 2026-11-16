// Status chip: plane count, with a red dot when there are alerts. The popover has the feed health, the credits and the alert list.
import { type Alert, type Feed, type Status, fetchAlerts, fetchStatus, Loop, serverNow } from "../api";
import { fmtAgo, fmtAlt, fmtInt } from "../lib/core";
import { closeOthers, registerPopover } from "./popovers";
import { hide, setShown, show, shown } from "./motion";

const STATE: Record<string, string> = { ok: "Opérationnel", degraded: "Dégradé", rate_limited: "Limite atteinte", idle: "En veille", disabled: "Désactivé", exhausted: "Crédits épuisés", auth_error: "Clé refusée" };
const NAMES: Record<string, string> = { opensky: "OpenSky", "adsb.lol": "adsb.lol", "adsb.fi": "adsb.fi", fr24: "Flightradar24" };
const KIND: Record<string, string> = { hijack: "Détournement", radio_failure: "Panne radio", emergency: "Urgence" };
type Level = "ok" | "warn" | "bad";

function feedLevel(f: Pick<Feed, "state">): Level {
  if (f.state === "ok" || f.state === "idle") return "ok";
  return f.state === "disabled" || f.state === "rate_limited" || f.state === "degraded" || f.state === "exhausted" ? "warn" : "bad";
}

function health(s: Status | null): Level {
  if (!s) return "bad";
  const feeds = Object.values(s.feeds);
  if (!feeds.some((f) => f.state === "ok" || f.state === "idle")) return "bad";
  const o = s.feeds.opensky;
  if (o && (feedLevel(o) !== "ok" || (o.credits_remaining != null && o.credits_daily && o.credits_remaining / o.credits_daily < 0.08))) return "warn";
  return "ok";
}

export interface StatusHooks {
  /** Viewport is small enough for the 5 s area refresh. */
  areaActive(): boolean;
  /** Planes squawking an emergency code, whenever the list changes. */
  onAlerts(alerts: Alert[]): void;
  onPick(hex: string): void;
}

export class StatusChip {
  private status: Status | null = null;
  private alerts: Alert[] = [];
  private failed = false;
  private chip = document.getElementById("chip") as HTMLButtonElement;
  private pop = document.getElementById("status-pop") as HTMLElement;
  private loop: Loop;
  private alertLoop: Loop;

  constructor(private hooks: StatusHooks) {
    registerPopover({ el: this.pop, trigger: this.chip, isOpen: () => this.isOpen, close: () => this.close(), outside: true });
    this.loop = new Loop(async () => {
      try { this.status = await fetchStatus(); this.failed = false; } catch { this.failed = true; }
      this.render();
      if ((this.status?.alerts ?? 0) !== this.alerts.length) this.alertLoop.kick();
    }, () => 20_000);
    // alerts are only fetched while the backend says there are some (and once more to clear the list when they end)
    this.alertLoop = new Loop(async () => {
      this.alerts = (this.status?.alerts ?? 0) > 0 ? await fetchAlerts() : [];
      this.hooks.onAlerts(this.alerts);
      this.render();
    }, () => ((this.status?.alerts ?? 0) > 0 || this.alerts.length ? 15_000 : null));
    this.chip.addEventListener("click", () => this.toggle());
    this.pop.querySelector("[data-close]")!.addEventListener("click", () => this.close());
    setInterval(() => { if (!this.pop.hidden) this.render(); }, 1000);
    this.loop.start(); this.alertLoop.start();
  }

  get isOpen() { return shown(this.pop); }
  toggle() { if (!shown(this.pop)) { closeOthers(this.pop); show(this.pop); this.chip.setAttribute("aria-expanded", "true"); this.render(); } else this.close(); }
  close() { hide(this.pop); this.chip.setAttribute("aria-expanded", "false"); }

  private render() {
    const s = this.failed ? null : this.status;
    const lvl = health(s);
    (document.getElementById("chip-dot") as HTMLElement).className = `dot ${lvl}`;
    document.getElementById("chip-text")!.textContent = s ? `${fmtInt(s.planes)} avions` : this.status ? "Connexion perdue" : "— avions";
    const n = s?.alerts ?? 0;
    setShown(document.getElementById("chip-alert") as HTMLElement, n > 0);
    this.chip.setAttribute("aria-label", `${s ? `${fmtInt(s.planes)} avions` : "État des flux"}${n ? `, ${n} alerte${n > 1 ? "s" : ""}` : ""}`);
    if (this.pop.hidden) return;
    const body = document.getElementById("status-body")!;
    if (!s) { body.textContent = "Le serveur ne répond pas."; return; }
    const parts: HTMLElement[] = [];
    if (this.alerts.length) parts.push(this.alertsEl());
    const feeds: [string, Feed | (Feed & { credits_used?: number })][] = Object.entries(s.feeds);
    if (s.fr24 && s.fr24.state !== "disabled") feeds.push(["fr24", { last_ok: null, last_error: null, ...s.fr24 } as Feed]);
    parts.push(...feeds.map(([k, f]) => this.feedEl(k, f)), this.noteEl(s));
    body.replaceChildren(...parts);
  }

  private alertsEl(): HTMLElement {
    const box = document.createElement("div");
    box.className = "alerts";
    for (const a of this.alerts) {
      const b = document.createElement("button");
      b.type = "button"; b.className = "alert-row";
      b.innerHTML = '<i class="dot"></i><b></b><span></span><span></span>';
      const [name, kind, alt] = [b.querySelector("b")!, b.children[2] as HTMLElement, b.children[3] as HTMLElement];
      name.textContent = a.cs ?? a.reg ?? a.hex.toUpperCase();
      kind.textContent = `${KIND[a.kind] ?? "Alerte"} · ${a.squawk}`;
      alt.textContent = fmtAlt(a.alt, a.gnd);
      b.addEventListener("click", () => { this.close(); this.hooks.onPick(a.hex); });
      box.append(b);
    }
    return box;
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
    if ((key === "opensky" || key === "fr24") && f.credits_remaining != null && f.credits_daily) {
      const pct = Math.max(0, Math.min(100, (f.credits_remaining / f.credits_daily) * 100));
      const m = document.createElement("div");
      m.className = `meter${pct < 8 ? " low" : ""}`;
      m.innerHTML = `<i style="width:${pct.toFixed(1)}%"></i>`;
      el.append(m);
    }
    const small = document.createElement("small");
    const parts: string[] = [];
    if (key === "opensky" || key === "fr24") {
      if (f.credits_remaining != null) parts.push(`${fmtInt(f.credits_remaining)} / ${fmtInt(f.credits_daily ?? 0)} crédits`);
      if (key === "opensky" && f.mode) parts.push(f.mode === "oauth" ? "authentifié" : "anonyme");
      if (key === "opensky" && f.interval) parts.push(`toutes les ${fmtInt(f.interval)} s`);
    }
    if (f.last_ok) parts.push(`dernier relevé ${fmtAgo(serverNow() - f.last_ok)}`);
    if (f.last_error) parts.push(f.last_error);
    small.textContent = parts.join(" · ") || "Aucune donnée";
    el.append(small);
    return el;
  }

  private noteEl(s: Status): HTMLElement {
    const el = document.createElement("div");
    el.className = "feed";
    const small = document.createElement("small");
    const est = s.estimated ? `${fmtInt(s.estimated)} position${s.estimated > 1 ? "s" : ""} estimée${s.estimated > 1 ? "s" : ""}. ` : "";
    small.textContent = est + (this.hooks.areaActive()
      ? "Zone visible rafraîchie toutes les 5 s."
      : "Zoomez sur une zone de 250 NM ou moins pour un rafraîchissement toutes les 5 s.");
    el.append(small);
    return el;
  }
}
