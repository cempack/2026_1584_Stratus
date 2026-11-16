// RainViewer precipitation radar as a raster overlay, inserted under borders and labels.
import type maplibregl from "maplibre-gl";
import type { RasterTileSource } from "maplibre-gl";

interface Frames { host: string; radar: { past: { time: number; path: string }[] } }

export class Radar {
  enabled = false;
  private tiles: string | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  constructor(private map: maplibregl.Map) {}

  private async load(): Promise<string> {
    const r = await fetch("https://api.rainviewer.com/public/weather-maps.json");
    if (!r.ok) throw new Error(`${r.status}`);
    const j = (await r.json()) as Frames;
    const last = j.radar.past[j.radar.past.length - 1];
    return `${j.host}${last.path}/256/{z}/{x}/{y}/2/1_1.png`;
  }

  /** Returns false when the radar could not be loaded. */
  async set(on: boolean): Promise<boolean> {
    if (!on) {
      this.enabled = false;
      clearInterval(this.timer);
      this.remove();
      return true;
    }
    try { this.tiles = await this.load(); } catch { return false; }
    this.enabled = true;
    this.install();
    clearInterval(this.timer);
    this.timer = setInterval(() => { if (!document.hidden) void this.refresh(); }, 5 * 60_000);
    return true;
  }

  private async refresh() {
    try {
      this.tiles = await this.load();
      (this.map.getSource("radar") as RasterTileSource | undefined)?.setTiles([this.tiles]);
    } catch { /* keep the previous frame */ }
  }

  /** Re-add after a style change. */
  install() {
    const m = this.map;
    if (!this.enabled || !this.tiles || m.getSource("radar")) return;
    m.addSource("radar", { type: "raster", tiles: [this.tiles], tileSize: 256, maxzoom: 7, attribution: '<a href="https://www.rainviewer.com">RainViewer</a>' });
    m.addLayer({ id: "radar", type: "raster", source: "radar", paint: { "raster-opacity": 0.62, "raster-fade-duration": 300 } }, m.getLayer("border-state") ? "border-state" : undefined);
  }

  private remove() {
    const m = this.map;
    if (m.getLayer("radar")) m.removeLayer("radar");
    if (m.getSource("radar")) m.removeSource("radar");
  }
}
