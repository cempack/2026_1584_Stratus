// Credits shown behind the "i" button. Always the base data; the rest only while the matching layer is on.

export interface Credit { name: string; href: string; note?: string }
export interface CreditOpts { satellite: boolean; radar: boolean; winds: boolean; metar: boolean }

export function credits(o: CreditOpts): Credit[] {
  const out: Credit[] = [
    { name: "OpenFreeMap", href: "https://openfreemap.org", note: "fond de carte" },
    { name: "© OpenMapTiles", href: "https://www.openmaptiles.org/" },
    { name: "© OpenStreetMap", href: "https://www.openstreetmap.org/copyright" },
    { name: "OpenSky Network", href: "https://opensky-network.org", note: "positions" },
    { name: "adsb.lol", href: "https://adsb.lol", note: "positions" },
    { name: "adsb.fi", href: "https://adsb.fi", note: "positions" },
    { name: "adsbdb", href: "https://www.adsbdb.com", note: "appareils, itinéraires" },
    { name: "Planespotters.net", href: "https://www.planespotters.net", note: "photos" },
    { name: "OurAirports", href: "https://ourairports.com", note: "aéroports" },
  ];
  if (o.satellite) out.push({ name: "Esri, Maxar, Earthstar Geographics", href: "https://www.esri.com", note: "imagerie satellite" });
  if (o.radar) out.push({ name: "RainViewer", href: "https://www.rainviewer.com", note: "radar météo" });
  if (o.winds) out.push({ name: "Open-Meteo", href: "https://open-meteo.com", note: "vents en altitude" });
  if (o.metar) out.push({ name: "aviationweather.gov", href: "https://aviationweather.gov", note: "METAR" });
  return out;
}
