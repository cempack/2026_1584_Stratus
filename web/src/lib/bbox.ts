// Viewport -> [south, west, north, east] for the winds and METAR endpoints (west > east = crosses the antimeridian).

export type Bbox = [south: number, west: number, north: number, east: number];
const wrap = (lon: number) => ((((lon + 180) % 360) + 360) % 360) - 180;

/**
 * `b` are the map bounds (west may be < -180 or east > 180 when the view wraps). The box is padded by `pad` of its size so a
 * small pan does not need a new request; a view that spans (almost) the whole world becomes the whole world.
 */
export function viewBbox(b: { south: number; west: number; north: number; east: number }, pad = 0.15): Bbox {
  const dLat = (b.north - b.south) * pad;
  const south = Math.max(-85, b.south - dLat), north = Math.min(85, b.north + dLat);
  const span = b.east - b.west;
  if (!(span < 330)) return [south, -180, north, 180];
  const dLon = span * pad;
  return [south, wrap(b.west - dLon), north, wrap(b.east + dLon)];
}

/** Coarse cache key: boxes that differ by less than `step` degrees share the same key. */
export function bboxKey(b: Bbox, step = 2): string {
  return b.map((v) => Math.round(v / step) * step).join(",");
}

/** Does `inner` fit inside `outer` (antimeridian-aware for the longitudes)? */
export function bboxContains(outer: Bbox, inner: Bbox): boolean {
  if (inner[0] < outer[0] || inner[2] > outer[2]) return false;
  const full = (b: Bbox) => b[1] === -180 && b[3] === 180;
  if (full(outer)) return true;
  if (full(inner)) return false;
  const cross = (b: Bbox) => b[1] > b[3];
  if (cross(outer) === cross(inner)) return inner[1] >= outer[1] && inner[3] <= outer[3];
  return false;
}
