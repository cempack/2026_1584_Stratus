// Regenerates the static geodata bundled with the app (run manually, output is committed):
//   node scripts/gen-geodata.mjs <ourairports airports.csv> <world-atlas land-110m.json>
// needs `topojson-client` resolvable (e.g. NODE_PATH=/path/to/node_modules).
// - src/map/airports.json : [iata, lat, lon, tier] for large + scheduled medium airports (OurAirports, public domain)
// - src/map/land110.json  : Natural Earth 110 m land polygons, quantised (fallback while vector tiles load)
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { feature } = require("topojson-client");

const [csvPath, landPath] = process.argv.slice(2);
const TOP = new Set(("ATL PEK DXB LAX HND ORD LHR PVG CDG DFW CAN AMS FRA IST DEL CGK SIN ICN BKK DEN JFK KUL SFO LAS MAD MIA CLT SEA MUC MEX EWR " +
  "BOM MCO YYZ SYD HKG DOH SVO FCO BCN GRU PHX LGW ZRH VIE CPH OSL ARN HEL DUB LIS MAN BRU MEL YVR SCL EZE BOG LIM JED RUH CAI JNB CPT ADD NBO LOS CMN " +
  "TLV AUH KIX NRT TPE MNL SGN HAN BNA DCA BOS IAD YUL PHL SAN IAH DTW MSP ORY NCE").split(" "));

function parseCsv(text) {
  const rows = []; let row = [], cur = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(cur); cur = ""; }
    else if (c === "\n") { row.push(cur); rows.push(row); row = []; cur = ""; }
    else if (c !== "\r") cur += c;
  }
  return rows;
}

const [head, ...rows] = parseCsv(readFileSync(csvPath, "utf8"));
const ix = Object.fromEntries(head.map((h, i) => [h, i]));
const out = [];
for (const r of rows) {
  const iata = r[ix.iata_code];
  if (!iata || iata.length !== 3) continue;
  const type = r[ix.type], sched = r[ix.scheduled_service] === "yes";
  if (type !== "large_airport" && !(type === "medium_airport" && sched)) continue;
  const tier = TOP.has(iata) ? 0 : type === "large_airport" ? 1 : 2;
  out.push([iata, Math.round(+r[ix.latitude_deg] * 1e3) / 1e3, Math.round(+r[ix.longitude_deg] * 1e3) / 1e3, tier]);
}
out.sort((a, b) => a[3] - b[3] || a[0].localeCompare(b[0]));
writeFileSync(new URL("../src/map/airports.json", import.meta.url), JSON.stringify(out));
console.log("airports", out.length, "tiers", [0, 1, 2].map((t) => out.filter((o) => o[3] === t).length));

const topo = JSON.parse(readFileSync(landPath, "utf8"));
const q = (c) => (typeof c[0] === "number" ? [Math.round(c[0] * 20) / 20, Math.round(c[1] * 20) / 20] : c.map(q));
const land = feature(topo, topo.objects.land);
const json = JSON.stringify(land, (k, v) => (k === "coordinates" ? q(v) : v));
writeFileSync(new URL("../src/map/land110.json", import.meta.url), json);
console.log("land bytes", json.length);
