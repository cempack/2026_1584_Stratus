export const SEARCH_HINT_DEFAULT = "Ex: AFR6712, F-GSQJ, 4CA9C2 ou France";
export const SEARCH_RESULT_LIMIT = 24;
export const DEFAULT_POLL_DELAYS_MS = Object.freeze({
  default: 20_000,
  min: 15_000,
  max: 45_000,
});

export function searchPrimaryLabel(plane) {
  if (!plane) return "—";
  return plane.flight || plane.registration || plane.hex?.toUpperCase() || "—";
}

export function normalizeSearchText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .trim();
}

export function tokenizeSearchText(value) {
  return normalizeSearchText(value)
    .split(/[^A-Z0-9]+/g)
    .filter(Boolean);
}

export function levenshteinWithinLimit(left, right, limit) {
  if (left === right) return 0;
  if (Math.abs(left.length - right.length) > limit) return limit + 1;

  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  let current = new Array(right.length + 1);

  for (let row = 1; row <= left.length; row += 1) {
    current[0] = row;
    let rowBest = current[0];

    for (let col = 1; col <= right.length; col += 1) {
      const cost = left[row - 1] === right[col - 1] ? 0 : 1;
      current[col] = Math.min(
        previous[col] + 1,
        current[col - 1] + 1,
        previous[col - 1] + cost,
      );
      rowBest = Math.min(rowBest, current[col]);
    }

    if (rowBest > limit) return limit + 1;
    [previous, current] = [current, previous];
  }

  return previous[right.length];
}

export function applyPhotoMetadataToPlane(
  plane,
  payload,
  { hasSearchResults = false, onSearchResultsChange = null } = {},
) {
  if (!plane || !payload) return false;

  let changed = false;
  for (const [planeKey, payloadKey] of [
    ["mode_s", "mode_s"],
    ["registration", "registration"],
    ["manufacturer", "manufacturer"],
    ["aircraft_model", "aircraft_model"],
    ["aircraft_type", "aircraft_type"],
    ["aircraft_description", "aircraft_description"],
    ["owner", "owner"],
    ["operator_code", "operator_code"],
    ["country", "country"],
  ]) {
    const nextValue = payload[payloadKey];
    if (!nextValue || plane[planeKey] === nextValue) continue;
    plane[planeKey] = nextValue;
    changed = true;
  }

  if (changed && hasSearchResults && typeof onSearchResultsChange === "function") {
    onSearchResultsChange();
  }
  return changed;
}

export function nextFlightsPollDelayMs(
  health,
  delays = DEFAULT_POLL_DELAYS_MS,
) {
  const serverPollMs = Number(health?.poll_interval_seconds || 0) * 1000;
  if (!Number.isFinite(serverPollMs) || serverPollMs <= 0) {
    return delays.default;
  }
  return Math.max(
    delays.min,
    Math.min(delays.max, Math.round(serverPollMs / 4)),
  );
}

export function buildSearchResultsFragment(
  document,
  state,
  { metaBuilder, titleBuilder = searchPrimaryLabel } = {},
) {
  const fragment = document.createDocumentFragment();
  for (let index = 0; index < (state?.results || []).length; index += 1) {
    const result = state.results[index];
    const button = document.createElement("button");
    button.type = "button";
    button.className = "search-result";
    button.dataset.index = String(index);
    button.dataset.active = String(index === state.activeIndex);

    const copy = document.createElement("span");
    copy.className = "search-result__copy";

    const title = document.createElement("span");
    title.className = "search-result__title";
    title.textContent = titleBuilder(result.plane);

    const meta = document.createElement("span");
    meta.className = "search-result__meta";
    meta.textContent = metaBuilder(result.plane);

    const kind = document.createElement("span");
    kind.className = "search-result__kind";
    kind.textContent = result.kind;

    copy.append(title, meta);
    button.append(copy, kind);
    fragment.appendChild(button);
  }
  return fragment;
}

export function syncFlightsState(
  {
    planeMap,
    payload,
    receivedAt,
    applyPlanePresentation,
    normalizeHexId,
    planeDataVersion,
  },
) {
  const flights = Array.isArray(payload?.flights) ? payload.flights : [];
  const nextPlaneArr = [];
  const nextHexes = new Set();
  const seenIncomingHexes = new Set();

  for (const incoming of flights) {
    const incomingHex = normalizeHexId(incoming?.hex);
    if (!incomingHex || seenIncomingHexes.has(incomingHex)) continue;
    seenIncomingHexes.add(incomingHex);
    nextHexes.add(incomingHex);
    const existing = planeMap.get(incomingHex);
    if (existing) {
      Object.assign(existing, incoming);
      existing.hex = incomingHex;
      existing.trail = incoming.trail || [];
      applyPlanePresentation(existing, receivedAt);
      nextPlaneArr.push(existing);
      continue;
    }

    const plane = { ...incoming, hex: incomingHex, trail: incoming.trail || [] };
    applyPlanePresentation(plane, receivedAt);
    planeMap.set(incomingHex, plane);
    nextPlaneArr.push(plane);
  }

  for (const hex of [...planeMap.keys()]) {
    if (!nextHexes.has(hex)) planeMap.delete(hex);
  }

  return {
    planeArr: nextPlaneArr,
    flightsLoaded: true,
    planeDataVersion: planeDataVersion + 1,
  };
}

export function pickProjectedPlane(
  pickPlanes,
  { pointerX, pointerY, defaultPickRadius },
) {
  let bestPlane = null;
  let bestDistance = Infinity;

  for (const plane of pickPlanes) {
    if (!plane.screenVisible) continue;
    const pickRadius = plane.pickRadius ?? defaultPickRadius;
    const maxDistance = pickRadius * pickRadius;
    const dx = plane.screenX - pointerX;
    const dy = plane.screenY - pointerY;
    const distance = dx * dx + dy * dy;
    if (distance >= maxDistance || distance >= bestDistance) continue;
    bestDistance = distance;
    bestPlane = plane;
  }

  return bestPlane;
}

export function buildDashedPathSegments(
  points,
  {
    dashSpan = 8,
    gapSpan = 5,
    color = "rgba(226, 73, 255, 0.92)",
    stroke,
  } = {},
) {
  if (points.length < 2) return [];

  const segments = [];
  for (let startIndex = 0; startIndex < points.length - 1; ) {
    const endIndex = Math.min(points.length - 1, startIndex + dashSpan);
    const segment = points.slice(startIndex, endIndex + 1);
    if (segment.length >= 2) {
      segments.push({ points: segment, color, stroke });
    }
    startIndex = endIndex + gapSpan;
  }
  return segments;
}

export function buildWeatherUrl(baseUrl, plane) {
  const lat = (plane.cLat ?? plane.lat).toFixed(2);
  const lng = (plane.cLng ?? plane.lng).toFixed(2);
  return `${baseUrl}?lat=${lat}&lng=${lng}`;
}

export async function fetchWeatherForPlaneData({
  fetchImpl,
  url,
  plane,
  signal,
}) {
  const response = await fetchImpl(buildWeatherUrl(url, plane), { signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const payload = await response.json();
  const current = payload.current;
  if (!current) throw new Error("Aucune donnée disponible");
  return current;
}

export async function loadLiveAtcAirportsData({ fetchImpl, url }) {
  const response = await fetchImpl(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const payload = await response.json();
  return payload.airports || [];
}
