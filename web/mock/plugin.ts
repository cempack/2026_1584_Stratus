// Dev-only mock of the v2 API (docs/architecture-v2.md). Real readsb rows around Paris (fixture) plus
// synthetic planes worldwide so rendering is tested at ~12k planes. Positions advance with wall time.
import { readFileSync } from "node:fs";
import type { Plugin } from "vite";

const FIELDS = ["hex", "cs", "lat", "lon", "alt", "gs", "trk", "vr", "gnd", "ts", "src", "type", "reg", "cat", "sqk"];
type Row = (string | number | boolean | null)[];
interface Seed { hex: string; cs: string | null; lat: number; lon: number; alt: number | null; gs: number | null; trk: number | null; vr: number | null; gnd: boolean; type: string | null; reg: string | null; cat: string | null; sqk: string | null }

const AIRPORTS = [
  { icao: "LFPG", iata: "CDG", name: "Paris-Charles de Gaulle", city: "Paris", country: "France", lat: 49.0097, lon: 2.5479 },
  { icao: "EGLL", iata: "LHR", name: "Heathrow", city: "Londres", country: "Royaume-Uni", lat: 51.47, lon: -0.4543 },
  { icao: "EDDF", iata: "FRA", name: "Francfort", city: "Francfort", country: "Allemagne", lat: 50.0379, lon: 8.5622 },
  { icao: "LEMD", iata: "MAD", name: "Adolfo Suárez Madrid-Barajas", city: "Madrid", country: "Espagne", lat: 40.4983, lon: -3.5676 },
  { icao: "KJFK", iata: "JFK", name: "John F. Kennedy", city: "New York", country: "États-Unis", lat: 40.6413, lon: -73.7781 },
  { icao: "LIRF", iata: "FCO", name: "Rome Fiumicino", city: "Rome", country: "Italie", lat: 41.8003, lon: 12.2389 },
];

function rng(seed: number) {
  return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
}

function load(): Seed[] {
  const raw = JSON.parse(readFileSync(new URL("./fixtures/readsb-paris.json", import.meta.url), "utf8"));
  const seeds: Seed[] = raw.ac
    .filter((a: any) => typeof a.lat === "number")
    .map((a: any) => ({
      hex: String(a.hex).replace("~", ""), cs: a.flight ? String(a.flight).trim() : null,
      lat: a.lat, lon: a.lon, gnd: a.alt_baro === "ground",
      alt: a.alt_baro === "ground" ? 0 : (a.alt_baro ?? a.alt_geom ?? null), gs: a.gs ?? null, trk: a.track ?? null,
      vr: a.baro_rate ?? a.geom_rate ?? null, type: a.t ?? null, reg: a.r ?? null, cat: a.category ?? null, sqk: a.squawk ?? null,
    }));
  const r = rng(42);
  const types = [["A320", "A3"], ["B738", "A3"], ["B77W", "A5"], ["A359", "A5"], ["AT76", "A2"], ["C172", "A1"], ["E190", "A3"], ["EC35", "A7"]];
  for (let i = 0; i < 11000; i++) {
    const [type, cat] = types[Math.floor(r() * types.length)];
    const light = cat === "A1" || cat === "A7";
    seeds.push({
      hex: (0x100000 + i).toString(16), cs: `SYN${i}`, lat: Math.asin(r() * 1.6 - 0.8) * 57.3, lon: r() * 360 - 180,
      alt: light ? Math.round(r() * 6000) : Math.round(20000 + r() * 21000), gs: light ? 100 + r() * 40 : 380 + r() * 120,
      trk: r() * 360, vr: 0, gnd: false, type, reg: null, cat, sqk: null,
    });
  }
  return seeds;
}

const R_NM = 3440.065;
function advance(s: Seed, dt: number): [number, number] {
  if (s.gnd || !s.gs || s.trk == null) return [s.lat, s.lon];
  const d = (s.gs * dt) / 3600 / R_NM, b = (s.trk * Math.PI) / 180, p1 = (s.lat * Math.PI) / 180, l1 = (s.lon * Math.PI) / 180;
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
  const l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return [(p2 * 180) / Math.PI, ((((l2 * 180) / Math.PI) + 540) % 360) - 180];
}

export function mockApi(): Plugin {
  const seeds = load();
  const t0 = Date.now() / 1000;
  const rowOf = (s: Seed, now: number, src = "opensky"): Row => {
    const ts = Math.floor(now / 5) * 5 - 2; // observations quantised like a real feed
    const [lat, lon] = advance(s, ts - t0);
    return [s.hex, s.cs, +lat.toFixed(5), +lon.toFixed(5), s.alt, s.gs == null ? null : Math.round(s.gs), s.trk == null ? null : +s.trk.toFixed(1),
      s.vr, s.gnd, ts, src, s.type, s.reg, s.cat, s.sqk];
  };
  const json = (res: any, body: unknown, code = 200) => {
    res.statusCode = code;
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-store");
    res.end(JSON.stringify(body));
  };
  return {
    name: "stratus-mock-api",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url ?? "/", "http://x");
        if (!url.pathname.startsWith("/api/")) return next();
        const now = Date.now() / 1000;
        const v = Math.floor(now / 5);
        const p = url.pathname;
        if (p === "/api/planes") {
          const etag = `"v${v}"`;
          if (req.headers["if-none-match"] === etag) { res.statusCode = 304; return res.end(); }
          res.setHeader("ETag", etag);
          return json(res, { v, t: now, fields: FIELDS, rows: seeds.map((s) => rowOf(s, now - 30)) });
        }
        if (p === "/api/planes/area") {
          const lat = +url.searchParams.get("lat")!, lon = +url.searchParams.get("lon")!, r = Math.min(250, +url.searchParams.get("r")!);
          const rows = seeds.map((s) => rowOf(s, now, "adsb.lol")).filter((row) => {
            const dlat = ((row[2] as number) - lat) * 60, dlon = ((row[3] as number) - lon) * 60 * Math.cos((lat * Math.PI) / 180);
            return Math.hypot(dlat, dlon) <= r;
          });
          return json(res, { v, t: now, fields: FIELDS, rows });
        }
        const m = p.match(/^\/api\/aircraft\/([0-9a-f]{6})$/);
        if (m) {
          const s = seeds.find((x) => x.hex === m[1]);
          if (!s) return json(res, { error: "not found" }, 404);
          const row = rowOf(s, now, "adsb.lol");
          const plane = Object.fromEntries(FIELDS.map((f, i) => [f, row[i]]));
          const trail: [number, number, number | null, number][] = [];
          for (let k = 40; k >= 1; k--) {
            const [la, lo] = advance(s, now - t0 - k * 30);
            trail.push([la, lo, s.alt == null ? null : Math.max(0, s.alt - k * 400), now - k * 30]);
          }
          const h = parseInt(s.hex, 16);
          const o = AIRPORTS[h % AIRPORTS.length], d = AIRPORTS[(h + 1 + (h >> 3) % 5) % AIRPORTS.length];
          let photo = null;
          try {
            const r = await fetch(`https://api.planespotters.net/pub/photos/hex/${s.hex}`, { signal: AbortSignal.timeout(3000) });
            const ph = (await r.json()).photos?.[0];
            if (ph) photo = { thumb: ph.thumbnail.src, large: ph.thumbnail_large.src, photographer: ph.photographer, link: ph.link };
          } catch { /* offline */ }
          return json(res, {
            plane: { ...plane, pos_type: "adsb_icao", country: "France" }, trail,
            aircraft: s.type ? { registration: s.reg, type: s.type, type_name: s.type, manufacturer: null, operator: s.cs?.slice(0, 3) ?? null, operator_icao: s.cs?.slice(0, 3) ?? null, owner: null, country: null } : null,
            route: s.cs && !s.gnd ? { callsign: s.cs, airline: null, origin: o, destination: d, plausible: h % 3 !== 0 } : null,
            photo,
          });
        }
        if (p === "/api/status") {
          return json(res, { planes: seeds.length, v, t: now, feeds: {
            opensky: { state: "ok", mode: "oauth", last_ok: now - 40, next_poll: now + 46, interval: 86.4, credits_remaining: 3120, credits_daily: 4000, last_error: null },
            "adsb.lol": { state: "ok", last_ok: now - 2, last_error: null },
            "adsb.fi": { state: "idle", last_ok: null, last_error: null },
          } });
        }
        if (p === "/api/weather") {
          return json(res, { temp_c: -44, wind_kt: 38, wind_dir: 280, cloud_pct: 35, level: "250hPa", time: now });
        }
        if (p === "/api/atc/airports") {
          return json(res, { airports: [{ icao: "KJFK", name: "John F. Kennedy International Airport", city: "New York", country: "US", lat: 40.6394, lon: -73.7793, feeds: [{ id: "kjfk_twr_1191", label: "KJFK Tower 119.1" }] }] });
        }
        return json(res, { error: "mock: not implemented" }, 404);
      });
    },
  };
}
