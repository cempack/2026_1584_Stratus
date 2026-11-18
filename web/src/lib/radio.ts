// Pure helpers for the ATC radio: frequency parsing, channel kinds, level metering.

/** A frequency written in the label ("KJFK Tower 119.1" -> "119.1"), exactly as written; null when there is none. */
export function parseFreq(label: string): string | null {
  const m = /(?<![\d.,])(\d{3})[.,](\d{1,3})(?![\d])/.exec(label);
  if (!m) return null;
  const mhz = Number(m[1]);
  if (!((mhz >= 108 && mhz <= 137) || (mhz >= 225 && mhz <= 400))) return null;
  return `${m[1]}.${m[2]}`;
}

export interface Freq { mhz: string; name: string }

/** LiveATC facility names as people read them: "ACC_Novosibirsk-Control [Southeast]" -> "Novosibirsk Control · Southeast". */
export function prettyFacility(name: string): string {
  let s = name.replace(/^(ACC|APP|TWR|GND|GPA|MIL|DEL|CTR|FIS|INFO)_/i, "").replace(/_/g, " ");
  s = s.replace(/(\p{L})-(\p{L})/gu, "$1 $2"); // Novosibirsk-Control -> Novosibirsk Control (not 4L/22R or 1-6)
  s = s.replace(/\s*[[(]([^\])]+)[\])]\s*$/, " · $1");
  return s.replace(/\s+/g, " ").trim() || name;
}

/**
 * The frequency to headline for a feed: among the ones LiveATC lists, the first whose facility matches the channel
 * kind (a "Tower" feed headlines a tower frequency), else the first listed; else one written in the label; else null.
 * Nothing is ever derived or padded.
 */
export function primaryFreq(label: string, freqs: Freq[] | undefined): Freq | null {
  const list = freqs ?? [];
  if (list.length) {
    const kind = feedKind(label).kind;
    const re = KINDS.find(([k]) => k === kind)?.[1];
    return (re && list.find((f) => re.test(f.name))) || list[0];
  }
  const inLabel = parseFreq(label);
  return inLabel ? { mhz: inLabel, name: label } : null;
}

export type FeedKind = "atis" | "clearance" | "ground" | "tower" | "approach" | "departure" | "center" | "radio";
const KINDS: [FeedKind, RegExp, string][] = [
  ["atis", /\b(atis|metar|volmet|weather)\b/i, "ATIS"],
  ["clearance", /\b(clearance|delivery|clnc|cd)\b/i, "Clairance"],
  ["ground", /\b(ground|gnd|apron|ramp|taxi)\b/i, "Sol"],
  ["tower", /\b(tower|twr)\b/i, "Tour"],
  ["approach", /\b(approach|app|arrival|arr|terminal|tracon)\b/i, "Approche"],
  ["departure", /\b(departure|dep)\b/i, "Départ"],
  ["center", /\b(center|centre|ctr|control|acc)\b/i, "Centre"],
];

export function feedKind(label: string): { kind: FeedKind; name: string } {
  for (const [kind, re, name] of KINDS) if (re.test(label)) return { kind, name };
  return { kind: "radio", name: "Radio" };
}

/** Icon name (see ui/icons) for a channel kind. */
export const KIND_ICON: Record<FeedKind, string> = {
  atis: "atis", clearance: "clearance", ground: "runway", tower: "tower", approach: "approach", departure: "departure", center: "center", radio: "radio",
};

/** Label without the ICAO prefix: "EHAM Tower (Rwy 18R/36L)" -> "Tower (Rwy 18R/36L)". */
export function stripIcao(label: string, icao: string | null): string {
  return (icao && label.toUpperCase().startsWith(icao.toUpperCase()) ? label.slice(icao.length).trim() : label) || label;
}

/** Short chip texts for one airport's feeds: the French channel name, or the frequency / cleaned label when two channels share a kind. */
export function chipLabels(icao: string, labels: string[], freqs: (Freq[] | undefined)[] = []): string[] {
  const kinds = labels.map((l) => feedKind(l));
  return labels.map((l, i) => {
    const dup = kinds.filter((k) => k.name === kinds[i].name).length > 1;
    if (!dup) return kinds[i].name;
    return primaryFreq(l, freqs[i])?.mhz ?? (stripIcao(l, icao).replace(/\s*\(.*\)\s*$/, "") || kinds[i].name);
  });
}

/**
 * Voice-activity meter. Feed it the RMS of each audio block: it tracks a slow noise floor and a decaying peak, so
 * quiet 8 kbps streams still move the meter, and reports a 0..1 level plus a hold-time "squelch open" flag.
 */
export class Meter {
  private floor = 0.02;
  private peak = 0.08;
  private openUntil = 0;
  level = 0;
  open = false;

  push(rms: number, now: number): number {
    this.floor = rms < this.floor ? rms : this.floor + (rms - this.floor) * 0.004;
    const sig = Math.max(0, rms - this.floor * 1.25);
    this.peak = Math.max(0.05, sig > this.peak ? sig : this.peak * 0.995);
    const raw = Math.min(1, sig / this.peak);
    this.level = raw > this.level ? raw : this.level * 0.82 + raw * 0.18;
    if (sig > 0.012 && raw > 0.22) this.openUntil = now + 320;
    this.open = now < this.openUntil;
    return this.level;
  }

  reset() { this.floor = 0.02; this.peak = 0.08; this.level = 0; this.open = false; this.openUntil = 0; }
}
