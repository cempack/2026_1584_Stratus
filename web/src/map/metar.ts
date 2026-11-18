// METAR dots: flight categories for the large airports in view, from /api/metar?bbox. Fetched when the camera settles.
import type maplibregl from "maplibre-gl";
import { type Metar, fetchMetars } from "../api";
import { bboxKey, viewBbox } from "../lib/bbox";

const MIN_ZOOM = 3.6;
const TTL_MS = 10 * 60_000;

export class MetarFeed {
  enabled = false;
  private stations = new Map<string, Metar>();
  private seen = new Map<string, number>(); // bbox key -> fetched at
  private timer: ReturnType<typeof setTimeout> | undefined;
  private ctl: AbortController | null = null;

  constructor(private map: maplibregl.Map, private onData: (s: Metar[]) => void) {
    map.on("moveend", (e) => { if (this.enabled && !(e as { stratusFollow?: boolean }).stratusFollow) this.schedule(700); });
  }

  set(on: boolean) {
    this.enabled = on;
    if (on) this.schedule(0); else { clearTimeout(this.timer); this.ctl?.abort(); }
  }

  /** Latest report we hold for a station (for the airport card, if it wants one before its own request answers). */
  get(icao: string) { return this.stations.get(icao); }

  private schedule(ms: number) { clearTimeout(this.timer); this.timer = setTimeout(() => void this.fetch(), ms); }

  private async fetch() {
    if (!this.enabled || this.map.getZoom() < MIN_ZOOM) return;
    const b = this.map.getBounds();
    const bbox = viewBbox({ south: b.getSouth(), west: b.getWest(), north: b.getNorth(), east: b.getEast() }, 0.1);
    const key = bboxKey(bbox, 1);
    if (Date.now() - (this.seen.get(key) ?? 0) < TTL_MS) return;
    this.ctl?.abort();
    this.ctl = new AbortController();
    try {
      const list = await fetchMetars(bbox, this.ctl.signal);
      if (!this.enabled) return;
      this.seen.set(key, Date.now());
      for (const s of list) this.stations.set(s.icao, s);
      if (this.stations.size > 900) for (const k of [...this.stations.keys()].slice(0, this.stations.size - 900)) this.stations.delete(k);
      this.onData([...this.stations.values()]);
    } catch { /* the next move retries */ }
  }

  /** Push what we hold again (after a style reload recreated the source). */
  replay() { if (this.stations.size) this.onData([...this.stations.values()]); }
}
