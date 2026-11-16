// Radar time pill (bottom centre). Collapsed it only shows the time of the image on the map; it expands on hover,
// focus or tap to reveal play and the scrubber, and folds back by itself.
import type { RadarUi } from "../map/radar";
import { icon } from "./icons";

const fmtClock = (s: number) => new Date(s * 1000).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });

export function initRadarPill(handlers: { onSeek(i: number): void; onToggle(): void }) {
  const root = document.getElementById("rpill") as HTMLElement;
  const main = document.getElementById("rpill-main") as HTMLButtonElement;
  const scrub = document.getElementById("radar-scrub") as HTMLInputElement;
  const time = document.getElementById("radar-time") as HTMLElement;
  const play = document.getElementById("radar-play") as HTMLButtonElement;
  const load = document.getElementById("rp-load") as HTMLElement;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let playing = false;

  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (!root.classList.contains("open")) return;
      if (playing || root.matches(":hover, :focus-within")) arm(); else setOpen(false);
    }, 6000);
  };
  const setOpen = (open: boolean) => {
    root.classList.toggle("open", open);
    main.setAttribute("aria-expanded", String(open));
    if (open) arm(); else clearTimeout(timer);
  };
  main.addEventListener("click", () => setOpen(!root.classList.contains("open")));
  document.addEventListener("pointerdown", (e) => { if (root.classList.contains("open") && !root.contains(e.target as Node)) setOpen(false); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && root.classList.contains("open")) setOpen(false); });
  scrub.addEventListener("input", () => { handlers.onSeek(Number(scrub.value)); setOpen(true); });
  play.addEventListener("click", () => { handlers.onToggle(); setOpen(true); });

  return {
    /** Show or hide the whole pill (radar layer on/off). */
    setVisible(v: boolean) { root.hidden = !v; if (!v) setOpen(false); },
    update(s: RadarUi) {
      playing = s.playing;
      scrub.max = String(Math.max(0, s.frames - 1)); scrub.value = String(s.index);
      scrub.style.setProperty("--v", `${s.frames > 1 ? (s.index / (s.frames - 1)) * 100 : 0}%`);
      time.textContent = s.time ? fmtClock(s.time) : "—";
      time.classList.toggle("fc", s.forecast);
      time.title = s.forecast ? "Prévision" : "Observé";
      play.innerHTML = icon(s.playing ? "pause" : "play");
      play.setAttribute("aria-label", s.playing ? "Pause" : "Lecture");
      play.disabled = s.frames < 2;
      load.hidden = !s.loading;
    },
  };
}
