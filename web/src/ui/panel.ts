// Flight card: docked right on desktop, bottom sheet on mobile. Fixed DOM (index.html), text patched in place
// so photos and scroll position survive the 3 s refreshes.
//
// Photos: the card owns a small state machine (loading skeleton -> ready | none). The old code hid the figure for good on
// the first image error, never re-set an image whose URL it had already seen, and showed nothing while the backend was
// still looking the photo up (it answers `photo: null` on the first poll). Now the skeleton shows until a photo arrives or
// ~9 s pass, a failed image falls back to the thumbnail and then to a tasteful placeholder, and a photo that shows up
// later still replaces the placeholder.
import type { Detail, Weather } from "../api";
import { serverNow } from "../api";
import { type Track, distanceNm, fmtAgo, fmtAltM, fmtInt, fmtSpeedKmh, fmtTrack, fmtVr, renderPos } from "../lib/core";
import { sparkline } from "../lib/spark";
import { Sheet } from "./sheet";
import { swap } from "./motion";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const text = (id: string, v: string) => { const el = $(id); if (el.textContent !== v) el.textContent = v; };

const EMERGENCY: Record<string, string> = { "7500": "Détournement (7500)", "7600": "Panne radio (7600)", "7700": "Urgence (7700)" };
const POS_TYPE: Record<string, string> = { adsb_icao: "ADS-B", adsb_icao_nt: "ADS-B", adsr_icao: "ADS-R", mlat: "MLAT", mode_s: "Mode S", tisb_icao: "TIS-B", tisb_other: "TIS-B", adsc: "ADS-C" };
const CARDINALS = ["N", "NE", "E", "SE", "S", "SO", "O", "NO"];
const cardinal = (deg: number) => CARDINALS[Math.round((((deg % 360) + 360) % 360) / 45) % 8];
const PHOTO_PATIENCE_S = 9;
const AIRLINE_CS = /^[A-Z]{3}\d/;

export interface PanelHandlers { onClose(): void; onFollow(on: boolean): void; onShare(): void; onFullTrack(): void }
export type FullTrackState = "idle" | "loading" | "shown";

export function fmtDuration(hours: number): string {
  const m = Math.max(0, Math.round(hours * 60));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")}`;
}

export class Panel {
  private sheet: Sheet;
  private ftState: FullTrackState = "idle";
  private photoUrl = "";
  private photoTried = new Set<string>();
  private photoRetryAt = 0;
  private shownAt = 0;
  private logoIata = "";
  private lastDetail: Detail | null = null;

  constructor(h: PanelHandlers) {
    this.sheet = new Sheet($("panel"));
    $("p-fulltrack").addEventListener("click", () => h.onFullTrack());
    $("p-close").addEventListener("click", () => h.onClose());
    $("p-share").addEventListener("click", () => h.onShare());
    $("p-follow").addEventListener("click", () => h.onFollow($("p-follow").getAttribute("aria-pressed") !== "true"));
    const img = $<HTMLImageElement>("p-img");
    img.addEventListener("load", () => { if (img.currentSrc && img.getAttribute("src")) this.setHero("ready"); });
    img.addEventListener("error", () => this.photoFailed());
    const logo = $<HTMLImageElement>("p-logo-img");
    logo.addEventListener("load", () => ($("p-logo").dataset.state = "img"));
    logo.addEventListener("error", () => { $("p-logo").dataset.state = "mono"; });
  }

  get isOpen() { return $("panel").dataset.open === "1"; }

  private setHero(s: "loading" | "ready" | "none") { const f = $("p-photo"); if (f.dataset.state !== s) f.dataset.state = s; }

  show(t: Track | undefined, hex: string) {
    this.lastDetail = null;
    this.photoUrl = ""; this.photoTried.clear(); this.photoRetryAt = 0; this.logoIata = "";
    this.shownAt = serverNow();
    const img = $<HTMLImageElement>("p-img");
    img.removeAttribute("src"); img.alt = "";
    this.setHero("loading");
    $("p-logo").dataset.state = "mono";
    $<HTMLImageElement>("p-logo-img").removeAttribute("src");
    $("p-route").hidden = false;
    $("p-route").classList.remove("unconfirmed");
    $("p-spark-wrap").hidden = true;
    $("r-eta").hidden = true;
    for (const id of ["p-airline", "r-oc", "r-dc", "r-flown", "r-left", "a-type", "a-op", "a-country", "w-temp", "w-wind", "w-cloud", "p-fb-type"]) text(id, "");
    for (const id of ["r-o", "r-d", "w-temp", "w-wind", "w-cloud", "a-type", "a-op", "a-country"]) text(id, "—");
    ($("r-fill") as HTMLElement).style.width = "0%";
    ($("r-glyph") as HTMLElement).style.left = "0%";
    this.setFollow(false);
    this.setFullTrack("idle");
    $("p-est").hidden = true;
    text("r-src", "");
    this.sheet.set(false);
    if ($("panel").dataset.open === "1") swap($("panel-scroll"));
    $("panel").dataset.open = "1";
    $("panel").setAttribute("aria-hidden", "false");
    text("p-cs", t?.cs ?? hex.toUpperCase());
    this.monogram(t?.cs ?? null, null);
    this.render(t, null);
    $("panel-scroll").scrollTop = 0;
  }

  hide() {
    this.sheet.set(false);
    $("panel").dataset.open = "0";
    $("panel").setAttribute("aria-hidden", "true");
  }

  /** The FR24 full-track button: idle (offer it), loading, or shown (offer to hide it). */
  setFullTrack(s: FullTrackState) {
    this.ftState = s;
    const b = $<HTMLButtonElement>("p-fulltrack");
    b.setAttribute("aria-pressed", String(s === "shown"));
    b.disabled = s === "loading";
    if (s === "loading") text("p-ft-text", "Chargement de la trajectoire…");
    else if (s === "shown") { b.hidden = false; text("p-ft-text", "Masquer la trajectoire complète"); }
    else this.renderFullTrackButton();
  }

  private renderFullTrackButton() {
    const b = $<HTMLButtonElement>("p-fulltrack"), ft = this.lastDetail?.full_track;
    if (this.ftState === "shown") return;
    b.hidden = !(ft?.available);
    if (ft?.available) {
      text("p-ft-text", `Trajectoire complète (${fmtInt(ft.cost)} crédits)`);
      const left = this.lastDetail?.fr24?.credits_remaining;
      b.title = left != null ? `${fmtInt(left)} crédits Flightradar24 restants aujourd’hui` : "Flightradar24";
    }
  }

  setFollow(on: boolean) {
    $("p-follow").setAttribute("aria-pressed", String(on));
  }

  private monogram(cs: string | null, airline: string | null) {
    const el = $("p-logo-fb");
    let k = "", txt = "";
    if (airline) {
      const w = airline.replace(/[^\p{L}\s]/gu, "").split(/\s+/).filter(Boolean);
      txt = (w.length > 1 ? w[0][0] + w[1][0] : (w[0] ?? "").slice(0, 2)).toUpperCase();
      k = `t:${txt}`;
    } else if (cs && AIRLINE_CS.test(cs)) { txt = cs.slice(0, 3); k = `t:${txt}`; }
    else k = "plane";
    if (el.dataset.k === k) return;
    el.dataset.k = k;
    if (k === "plane") el.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2c.8 0 1.2 1.1 1.2 2.2v5.3l8 4.5v2l-8-2.3v5l2.6 1.8v1.5L12 21.2l-3.8 1V20.5l2.6-1.8v-5l-8 2.3v-2l8-4.5V4.2C10.8 3.1 11.2 2 12 2z"/></svg>';
    else el.textContent = txt;
  }

  private loadPhoto(url: string, thumb: string | null) {
    const img = $<HTMLImageElement>("p-img");
    this.photoUrl = url;
    this.photoTried.add(url);
    this.setHero("loading");
    img.dataset.thumb = thumb ?? "";
    img.src = url;
  }

  private photoFailed() {
    const img = $<HTMLImageElement>("p-img");
    if (!img.getAttribute("src")) return;
    const thumb = img.dataset.thumb;
    if (thumb && !this.photoTried.has(thumb)) { this.photoTried.add(thumb); img.src = thumb; return; }
    this.setHero("none");
    text("p-fb-note", "Photo indisponible");
    this.photoRetryAt = serverNow() + 30; // a flaky CDN: try the same photo again later
  }

  /** Full refresh from the live track and (optionally) the latest detail response. */
  render(t: Track | undefined, d: Detail | null) {
    if (d) this.lastDetail = d;
    d = this.lastDetail;
    if (!t) return;
    const route = d?.route ?? null, ac = d?.aircraft ?? null;
    const cs = route?.callsign ?? t.cs ?? t.reg ?? t.hex.toUpperCase();
    text("p-cs", cs);
    const airline = route?.airline ?? ac?.operator ?? "";
    text("p-airline", airline);

    // airline logo (kiwi CDN, keyed by IATA); monogram when unknown or on error
    const iata = (route?.airline_iata ?? "").toUpperCase();
    if (iata !== this.logoIata) {
      this.logoIata = iata;
      const img = $<HTMLImageElement>("p-logo-img");
      if (iata) { $("p-logo").dataset.state = "mono"; img.src = `https://images.kiwi.com/airlines/64/${iata}.png`; }
      else { img.removeAttribute("src"); $("p-logo").dataset.state = "mono"; }
    }
    this.monogram(t.cs, airline || null);

    const badges: string[] = [];
    if (t.sqk && EMERGENCY[t.sqk]) badges.push(`!${EMERGENCY[t.sqk]}`);
    if (t.gnd) badges.push("Au sol");
    if (!t.est && serverNow() - t.ts > 300) badges.push("Position ancienne");
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

    // stat tiles
    if (t.gnd) { text("v-alt", "Au sol"); text("v-alt-u", ""); text("v-alt2", ""); }
    else { text("v-alt", t.alt == null ? "—" : fmtInt(t.alt)); text("v-alt-u", t.alt == null ? "" : "ft"); text("v-alt2", fmtAltM(t.alt)); }
    text("v-gs", t.gs == null ? "—" : fmtInt(t.gs)); text("v-gs-u", t.gs == null ? "" : "kt"); text("v-gs2", fmtSpeedKmh(t.gs));
    const level = t.vr == null || Math.abs(t.vr) < 64;
    text("v-vr", level ? fmtVr(t.vr) : `${t.vr! > 0 ? "+" : "−"}${fmtInt(Math.abs(t.vr!))}`);
    text("v-vr-u", level ? "" : "ft/min");
    text("v-vr2", !level ? `${(t.vr! > 0 ? "+" : "−")}${(Math.abs(t.vr!) * 0.00508).toFixed(1).replace(".", ",")} m/s` : "");
    const ico = $("v-vr-ico"), dir = level ? "" : t.vr! > 0 ? "up" : "down";
    if (ico.dataset.dir !== dir) { ico.dataset.dir = dir; ico.innerHTML = dir ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="${dir === "up" ? "M12 19V5.5M6.5 11 12 5.5l5.5 5.5" : "M12 5v13.5M6.5 13 12 18.5l5.5-5.5"}"/></svg>` : ""; }
    $("t-vr").dataset.dir = dir;

    text("v-trk", fmtTrack(t.trk)); text("v-trk2", t.trk == null ? "" : cardinal(t.trk));
    text("v-sqk", t.sqk ?? "—"); text("v-sqk2", t.sqk && EMERGENCY[t.sqk] ? EMERGENCY[t.sqk].replace(/ \(\d+\)/, "") : "");
    text("v-hex", t.hex.toUpperCase()); text("v-pos", POS_TYPE[d?.plane.pos_type ?? ""] ?? d?.plane.pos_type ?? "");

    const typeName = ac?.type_name ?? ac?.type ?? t.type ?? "—";
    text("a-type", typeName);
    text("p-fb-type", typeName === "—" ? "" : typeName);
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
      const src = route?.source === "fr24" ? "Itinéraire : FR24" : route?.source === "adsbdb" ? `Itinéraire : adsbdb${route.plausible ? "" : ", non confirmé"}` : "";
      text("r-src", o && dst ? src : "");
      this.renderFullTrackButton();
      this.renderPhoto(d, ac?.registration ?? t.reg ?? "", ac?.type_name ?? t.type ?? "Avion");
      this.renderSpark(d, t);
    }
    this.tick(t);
  }

  private renderPhoto(d: Detail, reg: string, type: string) {
    const p = d.photo;
    if (p) {
      const link = p.link ?? "https://www.planespotters.net";
      ($("p-photo-link") as HTMLAnchorElement).href = link;
      ($("p-credit-link") as HTMLAnchorElement).href = link;
      text("p-photographer", p.photographer ?? "");
      $<HTMLImageElement>("p-img").alt = `${type} ${reg}`.trim();
      if (p.large !== this.photoUrl) this.loadPhoto(p.large, p.thumb && p.thumb !== p.large ? p.thumb : null);
    } else if (!this.photoUrl && serverNow() - this.shownAt > PHOTO_PATIENCE_S) {
      text("p-fb-note", "Pas de photo disponible");
      this.setHero("none");
    }
  }

  private renderSpark(d: Detail, t: Track) {
    const sp = sparkline(d.trail, t.gnd ? null : { alt: t.alt, ts: t.ts }, 320, 64);
    $("p-spark-wrap").hidden = !sp;
    if (!sp) return;
    $("spark-line").setAttribute("d", sp.line);
    $("spark-area").setAttribute("d", sp.area);
    const dot = $("spark-dot");
    dot.style.left = `${(sp.last[0] / 320) * 100}%`; dot.style.top = `${(sp.last[1] / 64) * 100}%`;
    text("spark-meta", `${fmtInt(sp.minutes)} min · max ${fmtInt(sp.maxAlt)} ft`);
  }

  /** Once a second: progress, remaining distance, ETA and the freshness line. */
  tick(t: Track | undefined) {
    if (!t) return;
    const route = this.lastDetail?.route;
    if (route?.origin && route.destination && !$("p-route").hidden) {
      const [lat, lon] = renderPos(t, serverNow());
      const flown = distanceNm([route.origin.lat, route.origin.lon], [lat, lon]);
      const left = distanceNm([lat, lon], [route.destination.lat, route.destination.lon]);
      const pct = Math.max(0, Math.min(100, (flown / Math.max(1, flown + left)) * 100));
      ($("r-fill") as HTMLElement).style.width = `${pct.toFixed(2)}%`;
      ($("r-glyph") as HTMLElement).style.left = `${pct.toFixed(2)}%`;
      $("r-bar").setAttribute("aria-valuenow", String(Math.round(pct)));
      text("r-flown", `${fmtInt(flown)} NM parcourus`); text("r-left", `${fmtInt(left)} NM restants`);
      const eta = $("r-eta");
      if (t.gs && t.gs > 60 && !t.gnd && route.plausible) {
        const h = left / t.gs;
        eta.hidden = false;
        text("r-eta-t", new Date(Date.now() + h * 3_600_000).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" }));
        text("r-eta-in", `dans ${fmtDuration(h)}`);
      } else eta.hidden = true;
    }
    if (this.photoRetryAt && serverNow() > this.photoRetryAt && this.lastDetail?.photo) {
      this.photoRetryAt = 0; this.photoTried.clear();
      this.loadPhoto(this.lastDetail.photo.large, this.lastDetail.photo.thumb);
    }
    const age = serverNow() - t.ts;
    const est = $("p-est");
    est.hidden = !t.est;
    if (t.est) {
      text("p-est-t", `Position estimée depuis ${fmtDuration(age / 3600)}`);
      text("p-est-s", `Dernier signal reçu à ${new Date(t.ts * 1000).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}. La position est calculée le long de l’itinéraire.`);
      text("f-text", `Estimation · dernier signal ${fmtAgo(age)}`);
      $("f-dot").className = "dot warn";
      return;
    }
    text("f-text", `Position ${fmtAgo(age)} · ${t.src || "source inconnue"}`);
    $("f-dot").className = `dot ${age < 20 ? "ok" : age < 120 ? "warn" : "bad"}`;
  }

  setWeather(w: Weather | null) {
    if (!w) return;
    text("w-temp", w.temp_c == null ? "—" : `${w.temp_c.toFixed(0).replace("-", "−")} °C`);
    text("w-wind", w.wind_kt == null ? "—" : `${fmtInt(w.wind_kt)} kt${w.wind_dir == null ? "" : ` · ${fmtTrack(w.wind_dir)}`}`);
    text("w-cloud", w.cloud_pct == null ? "—" : `${fmtInt(w.cloud_pct)} %${w.level ? ` · ${w.level}` : ""}`);
  }
}
