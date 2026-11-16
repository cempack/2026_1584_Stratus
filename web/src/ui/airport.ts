// Airport card: name, decoded METAR with the flight-category badge, runways and the live arrivals / departures board
// (derived by the backend from the plane store). Same dock, same look as the flight card.
import type { AirportBoard, BoardPlane } from "../api";
import { fmtInt } from "../lib/core";
import {
  CATEGORY_HINT, PHASE_LABEL, categoryOf, ceilingText, cloudsText, fmtEta, qnhText, runwayText, tempText, visibilityText, windText,
} from "../lib/airport";
import { Sheet } from "./sheet";
import { swap } from "./motion";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const text = (id: string, v: string) => { const el = $(id); if (el.textContent !== v) el.textContent = v; };
const clock = (ts: number) => new Date(ts * 1000).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });

export interface AirportHooks {
  onClose(): void;
  onPickFlight(hex: string): void;
  onRadio(icao: string): void;
  hasRadio(icao: string): boolean;
}
export interface AirportHint { icao?: string; iata?: string | null; name?: string | null; city?: string | null; country?: string | null }

const apt = (a: { iata?: string | null; icao?: string | null; city?: string | null } | null | undefined) =>
  a ? [a.iata ?? a.icao, a.city].filter(Boolean).join(" · ") : "";

export class AirportPanel {
  private sheet: Sheet;
  private tab: "arr" | "dep" = "arr";
  private board: AirportBoard | null = null;
  private icao = "";

  constructor(private h: AirportHooks) {
    this.sheet = new Sheet($("apanel"));
    $("ap-close").addEventListener("click", () => h.onClose());
    $("ap-radio").addEventListener("click", () => { if (this.icao) h.onRadio(this.icao); });
    const tabs: [string, "arr" | "dep"][] = [["tab-arr", "arr"], ["tab-dep", "dep"]];
    for (const [id, t] of tabs) $(id).addEventListener("click", () => { this.tab = t; this.renderBoard(); });
    $("ap-list").addEventListener("click", (e) => this.pick(e.target as HTMLElement));
    $("ap-list").addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); this.pick(e.target as HTMLElement); } });
  }

  get isOpen() { return $("apanel").dataset.open === "1"; }
  get code() { return this.icao; }

  private pick(el: HTMLElement) {
    const li = el.closest<HTMLElement>("li[data-hex]");
    if (li) this.h.onPickFlight(li.dataset.hex!);
  }

  /** Open the card right away (with whatever is known) while the board loads. */
  show(code: string, hint: AirportHint = {}) {
    if (this.icao !== code.toUpperCase() || !this.isOpen) {
      this.board = null; this.tab = "arr";
      this.icao = (hint.icao ?? code).toUpperCase();
      text("ap-code", hint.iata ?? this.icao);
      text("ap-name", hint.name ?? this.icao);
      text("ap-sub", [hint.icao ?? this.icao, [hint.city, hint.country].filter(Boolean).join(", ")].filter(Boolean).join(" · "));
      $("ap-radio").hidden = !this.h.hasRadio(this.icao);
      $("ap-cat").hidden = true;
      $("ap-metar-empty").hidden = true; $("ap-metar").hidden = false;
      for (const id of ["m-wind", "m-vis", "m-ceil", "m-clouds", "m-temp", "m-qnh"]) text(id, "—");
      text("m-raw", "");
      $("ap-rwy").replaceChildren();
      $("ap-rwy-block").hidden = true;
      text("n-arr", "0"); text("n-dep", "0");
      this.renderBoard(true);
      text("ap-fresh", "Chargement…");
      $("ap-dot").className = "dot";
      $("apanel-scroll").scrollTop = 0;
    }
    this.sheet.set(false);
    if ($("apanel").dataset.open === "1") swap($("apanel-scroll"));
    $("apanel").dataset.open = "1";
    $("apanel").setAttribute("aria-hidden", "false");
  }

  hide() {
    this.sheet.set(false);
    $("apanel").dataset.open = "0";
    $("apanel").setAttribute("aria-hidden", "true");
    this.icao = "";
  }

  update(b: AirportBoard) {
    this.board = b;
    const a = b.airport;
    this.icao = a.icao.toUpperCase();
    text("ap-code", a.iata ?? a.icao);
    text("ap-name", a.name);
    text("ap-sub", [a.icao, [a.city, a.country].filter(Boolean).join(", "), a.elev_ft != null ? `${fmtInt(a.elev_ft)} ft` : ""].filter(Boolean).join(" · "));
    $("ap-radio").hidden = !this.h.hasRadio(a.icao);

    const m = b.metar, cat = categoryOf(m);
    $("ap-metar-empty").hidden = !!m; $("ap-metar").hidden = !m;
    const badge = $("ap-cat");
    badge.hidden = !cat;
    if (cat) { badge.textContent = cat; badge.dataset.cat = cat; badge.title = CATEGORY_HINT[cat]; }
    if (m) {
      text("m-wind", windText(m)); text("m-vis", visibilityText(m)); text("m-ceil", ceilingText(m)); text("m-clouds", cloudsText(m));
      text("m-temp", tempText(m)); text("m-qnh", qnhText(m)); text("m-raw", m.raw ?? "");
    } else text("m-raw", "");

    const rw = (a.runways ?? []).slice(0, 6);
    $("ap-rwy-block").hidden = !rw.length;
    $("ap-rwy").replaceChildren(...rw.map((r) => {
      const t = runwayText(r), li = document.createElement("li");
      li.innerHTML = "<b></b><span></span>";
      li.firstElementChild!.textContent = t.ident;
      li.lastElementChild!.textContent = [t.length, t.detail].filter(Boolean).join(" · ");
      return li;
    }));

    text("n-arr", String(b.arrivals.length)); text("n-dep", String(b.departures.length));
    this.renderBoard();
    text("ap-fresh", `Trafic dans un rayon de 60 NM · mis à jour à ${new Date().toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`);
    $("ap-dot").className = "dot ok";
  }

  private renderBoard(loading = false) {
    const arr = this.tab === "arr";
    $("tab-arr").setAttribute("aria-selected", String(arr)); $("tab-dep").setAttribute("aria-selected", String(!arr));
    const list = $("ap-list");
    const rows = this.board ? (arr ? this.board.arrivals : this.board.departures) : [];
    if (!rows.length) {
      const li = document.createElement("li");
      li.className = "b-empty";
      li.textContent = loading || !this.board ? "Chargement du trafic…" : arr ? "Aucune arrivée en vue pour le moment." : "Aucun départ en vue pour le moment.";
      list.replaceChildren(li);
      return;
    }
    list.replaceChildren(...rows.slice(0, 40).map((p) => this.row(p, arr)));
  }

  private row(p: BoardPlane, arrival: boolean): HTMLElement {
    const li = document.createElement("li");
    li.dataset.hex = p.hex; li.tabIndex = 0;
    li.innerHTML = '<div class="b-main"><b></b><span></span></div><div class="b-side"><b></b><span></span></div>';
    const [name, sub] = [li.querySelector(".b-main b")!, li.querySelector(".b-main span")!];
    const [big, small] = [li.querySelector(".b-side b")!, li.querySelector(".b-side span")!];
    name.textContent = p.cs ?? p.reg ?? p.hex.toUpperCase();
    const other = arrival ? p.origin : p.destination;
    sub.textContent = [p.type, other ? apt(other) : arrival ? "origine inconnue" : "destination inconnue"].filter(Boolean).join(" · ");
    if (arrival) {
      big.textContent = fmtEta(p.eta_s);
      small.textContent = [PHASE_LABEL[p.phase] ?? p.phase, p.eta_ts ? clock(p.eta_ts) : ""].filter(Boolean).join(" · ");
    } else {
      big.textContent = PHASE_LABEL[p.phase] ?? p.phase;
      small.textContent = p.gnd ? "" : `${fmtInt(p.dist_nm)} NM`;
    }
    if (p.est) small.textContent = [small.textContent, "estimée"].filter(Boolean).join(" · ");
    return li;
  }
}
