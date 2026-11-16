// Flight panel: docked right on desktop, bottom sheet on mobile. Fixed DOM (index.html), text patched in place
// so photos and scroll position survive the 3 s refreshes.
import type { Detail, Weather } from "../api";
import { serverNow } from "../api";
import { type Track, distanceNm, fmtAgo, fmtAlt, fmtAltM, fmtInt, fmtSpeed, fmtSpeedKmh, fmtTrack, fmtVr, renderPos } from "../lib/core";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const text = (id: string, v: string) => { const el = $(id); if (el.textContent !== v) el.textContent = v; };

const EMERGENCY: Record<string, string> = { "7500": "Détournement (7500)", "7600": "Panne radio (7600)", "7700": "Urgence (7700)" };
const POS_TYPE: Record<string, string> = { adsb_icao: "ADS-B", adsb_icao_nt: "ADS-B", adsr_icao: "ADS-R", mlat: "MLAT", mode_s: "Mode S", tisb_icao: "TIS-B", tisb_other: "TIS-B", adsc: "ADS-C" };
const CARDINALS = ["N", "NE", "E", "SE", "S", "SO", "O", "NO"];
const cardinal = (deg: number) => CARDINALS[Math.round((((deg % 360) + 360) % 360) / 45) % 8];

export interface PanelHandlers { onClose(): void; onFollow(on: boolean): void; onShare(): void }

export class Panel {
  private sheetOpen = false;
  private photoUrl = "";
  private lastDetail: Detail | null = null;
  private isMobile = () => matchMedia("(max-width: 719px)").matches;

  constructor(h: PanelHandlers) {
    $("p-close").addEventListener("click", () => h.onClose());
    $("p-share").addEventListener("click", () => h.onShare());
    $("p-follow").addEventListener("click", () => h.onFollow($("p-follow").getAttribute("aria-pressed") !== "true"));
    $("p-img").addEventListener("error", () => ($("p-photo").hidden = true));
    this.initSheet();
  }

  get isOpen() { return document.body.classList.contains("panel-open"); }

  show(t: Track | undefined, hex: string) {
    this.lastDetail = null;
    this.photoUrl = "";
    $("p-photo").hidden = true;
    $("p-route").hidden = false;
    $("p-route").classList.remove("unconfirmed");
    for (const id of ["p-airline", "r-oc", "r-dc", "r-flown", "r-left", "w-temp", "w-wind", "w-cloud", "a-type", "a-op", "a-country"]) text(id, "");
    for (const id of ["r-o", "r-d", "w-temp", "w-wind", "w-cloud", "a-type", "a-op", "a-country"]) text(id, "—");
    ($("r-fill") as HTMLElement).style.width = "0%";
    this.setFollow(false);
    this.setSheet(false);
    document.body.classList.add("panel-open");
    $("panel").setAttribute("aria-hidden", "false");
    text("p-cs", t?.cs ?? hex.toUpperCase());
    this.render(t, null);
    $("panel-scroll").scrollTop = 0;
  }

  hide() {
    document.body.classList.remove("panel-open", "sheet-open");
    $("panel").setAttribute("aria-hidden", "true");
  }

  setFollow(on: boolean) {
    $("p-follow").setAttribute("aria-pressed", String(on));
  }

  /** Full refresh from the live track and (optionally) the latest detail response. */
  render(t: Track | undefined, d: Detail | null) {
    if (d) this.lastDetail = d;
    d = this.lastDetail;
    if (!t) return;
    const route = d?.route ?? null, ac = d?.aircraft ?? null;
    text("p-cs", route?.callsign ?? t.cs ?? t.reg ?? t.hex.toUpperCase());
    text("p-airline", route?.airline ?? ac?.operator ?? "");

    const badges: string[] = [];
    if (t.sqk && EMERGENCY[t.sqk]) badges.push(`!${EMERGENCY[t.sqk]}`);
    if (t.gnd) badges.push("Au sol");
    if (route && !route.plausible) badges.push("Itinéraire non confirmé");
    if (serverNow() - t.ts > 300) badges.push("Position ancienne");
    const bEl = $("p-badges"), key = badges.join("|");
    if (bEl.dataset.key !== key) {
      bEl.dataset.key = key;
      bEl.replaceChildren(...badges.map((b) => {
        const s = document.createElement("span");
        s.className = b.startsWith("!") ? "badge bad" : "badge";
        s.textContent = b.replace(/^!/, "");
        return s;
      }));
    }

    text("v-alt", fmtAlt(t.alt, t.gnd)); text("v-alt2", t.gnd ? "" : fmtAltM(t.alt));
    text("v-gs", fmtSpeed(t.gs)); text("v-gs2", fmtSpeedKmh(t.gs));
    text("v-vr", fmtVr(t.vr)); text("v-vr2", t.vr != null && Math.abs(t.vr) >= 64 ? `${(t.vr > 0 ? "+" : "−")}${(Math.abs(t.vr) * 0.00508).toFixed(1).replace(".", ",")} m/s` : "");
    text("v-trk", fmtTrack(t.trk)); text("v-trk2", t.trk == null ? "" : cardinal(t.trk));
    text("v-sqk", t.sqk ?? "—"); text("v-sqk2", t.sqk && EMERGENCY[t.sqk] ? EMERGENCY[t.sqk].replace(/ \(\d+\)/, "") : "");
    text("v-hex", t.hex.toUpperCase()); text("v-pos", POS_TYPE[d?.plane.pos_type ?? ""] ?? d?.plane.pos_type ?? "");

    text("a-type", ac?.type_name ?? ac?.type ?? t.type ?? "—");
    text("a-reg", ac?.registration ?? t.reg ?? "—");
    text("a-op", ac?.operator ?? ac?.owner ?? "—");
    text("a-country", ac?.country ?? d?.plane.country ?? "—");

    if (d) {
      const o = route?.origin, dst = route?.destination;
      $("p-route").hidden = !(o && dst);
      if (o && dst) {
        text("r-o", o.iata ?? o.icao); text("r-oc", o.city ?? o.name ?? "");
        text("r-d", dst.iata ?? dst.icao); text("r-dc", dst.city ?? dst.name ?? "");
        $("p-route").classList.toggle("unconfirmed", !route!.plausible);
      }
      const p = d.photo;
      $("p-photo").hidden = !p;
      if (p && p.large !== this.photoUrl) {
        this.photoUrl = p.large;
        ($("p-img") as HTMLImageElement).src = p.large;
        ($("p-img") as HTMLImageElement).alt = `${ac?.type_name ?? t.type ?? "Avion"} ${ac?.registration ?? t.reg ?? ""}`.trim();
        ($("p-photo-link") as HTMLAnchorElement).href = p.link;
        ($("p-credit-link") as HTMLAnchorElement).href = p.link;
        text("p-photographer", p.photographer);
      }
    }
    this.tick(t);
  }

  /** Once a second: progress, remaining distance and the freshness line. */
  tick(t: Track | undefined) {
    if (!t) return;
    const route = this.lastDetail?.route;
    if (route?.origin && route.destination && !$("p-route").hidden) {
      const [lat, lon] = renderPos(t, serverNow());
      const flown = distanceNm([route.origin.lat, route.origin.lon], [lat, lon]);
      const left = distanceNm([lat, lon], [route.destination.lat, route.destination.lon]);
      const pct = Math.max(0, Math.min(100, (flown / Math.max(1, flown + left)) * 100));
      ($("r-fill") as HTMLElement).style.width = `${pct.toFixed(1)}%`;
      $("r-bar").setAttribute("aria-valuenow", String(Math.round(pct)));
      text("r-flown", `${fmtInt(flown)} NM parcourus`); text("r-left", `${fmtInt(left)} NM restants`);
    }
    const age = serverNow() - t.ts;
    text("f-text", `Position ${fmtAgo(age)} · ${t.src || "source inconnue"}`);
    $("f-dot").className = `dot ${age < 20 ? "ok" : age < 120 ? "warn" : "bad"}`;
  }

  setWeather(w: Weather | null) {
    if (!w) return;
    text("w-temp", w.temp_c == null ? "—" : `${w.temp_c.toFixed(0).replace("-", "−")} °C`);
    text("w-wind", w.wind_kt == null ? "—" : `${fmtInt(w.wind_kt)} kt${w.wind_dir == null ? "" : ` · ${fmtTrack(w.wind_dir)}`}`);
    text("w-cloud", w.cloud_pct == null ? "—" : `${fmtInt(w.cloud_pct)} %${w.level ? ` · ${w.level}` : ""}`);
  }

  // ----- mobile bottom sheet -----
  private setSheet(open: boolean) {
    this.sheetOpen = open;
    document.body.classList.toggle("sheet-open", open);
  }

  private initSheet() {
    const panel = $("panel"), handle = $("sheet-handle");
    let startY = 0, base = 0, moved = false, active = false;
    const collapsed = () => panel.offsetHeight - parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--peek"));
    handle.addEventListener("pointerdown", (e) => {
      active = true; moved = false; startY = e.clientY;
      base = this.sheetOpen ? 0 : collapsed();
      handle.setPointerCapture(e.pointerId);
      document.body.classList.add("sheet-drag");
    });
    handle.addEventListener("pointermove", (e) => {
      if (!active) return;
      const dy = e.clientY - startY;
      if (Math.abs(dy) > 6) moved = true;
      if (moved) panel.style.transform = `translateY(${Math.max(0, Math.min(collapsed(), base + dy))}px)`;
    });
    const end = (e: PointerEvent) => {
      if (!active) return;
      active = false;
      document.body.classList.remove("sheet-drag");
      panel.style.transform = "";
      const dy = e.clientY - startY;
      if (!moved) this.setSheet(!this.sheetOpen);
      else this.setSheet(dy < -40 ? true : dy > 40 ? false : this.sheetOpen);
    };
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
    panel.addEventListener("click", (e) => {
      if (this.isMobile() && !this.sheetOpen && !(e.target as HTMLElement).closest("button, a")) this.setSheet(true);
    });
  }
}
