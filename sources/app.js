const originalWarn = console.warn;
console.warn = (...args) => {
  if (
    typeof args[0] === "string" &&
    (args[0].includes("Multiple instances of Three.js") ||
      args[0].includes("THREE.Clock:"))
  )
    return;
  originalWarn.apply(console, args);
};

import {
  classifyAircraftVariant,
  computeVariantRenderMetrics,
  DEFAULT_PICK_RADIUS,
} from "./client/aircraft-visuals.mjs";
import {
  deriveConnectionStatus,
  deriveLoadState,
  sourceInfoText,
} from "./client/scan-state.mjs";
import * as THREE from "/vendor/three.module.js";

window.THREE = THREE;

await loadScript("/vendor/globe.gl.js");

const GlobeFactory = window.Globe;

const API_URL = "/api/flights";
const TRAJECTORY_URL = "/api/trajectory";
const PHOTO_URL = "/api/aircraft-photo";
const WX_URL = "/api/weather";
const WX_MAP_URL = "/api/weather-map";
const SETTINGS_URL = "/api/settings/opensky";
const LIVE_ATC_AIRPORTS_URL = "/api/liveatc/airports";
const LIVE_ATC_AUDIO_URL = "/api/liveatc/audio";
const RADIO_AUDIO_SOURCE_LABEL = "Source audio: liveatc.net";
const GENERIC_AIRCRAFT_IMAGE = "/assets/aircraft-placeholder.svg";
const EARTH_R = 6_371_000;
const MIN_POLL_MS = 15_000;
const MAX_POLL_MS = 45_000;
const WEATHER_REFRESH_MS = 75_000;
const SELECTED_WEATHER_REFRESH_MS = 75_000;
const SELECTED_WEATHER_MOVE_KM = 30;
const INITIAL_PLANE_CAPACITY = 30_000;
const TRAJECTORY_BASE_STROKE = 2.2;
const SELECTED_TRAIL_STROKE = 5.8;
const INFERRED_TRAIL_STROKE = 4.6;
const ALTITUDE_FLOOR = 0.00008;
const TRAIL_ALTITUDE_BOOST = 0.00014;
const TRAIL_ENDPOINT_MIN_GAP_M = 1_500;
const TRAIL_ENDPOINT_MAX_GAP_M = 8_000;
const TRAIL_COLOR_CHUNK_SPAN = 30;
const INFERRED_TRAIL_COLOR_CHUNK_SPAN = 12;
const ADSB_ROUTE_COLOR_CHUNK_SPAN = 14;
const PLANE_PREDICTION_LIMIT_S = 12;
const STALE_PREDICTION_SOFT_LIMIT_S = 10;
const STALE_PREDICTION_HARD_LIMIT_S = 22;
const SELECTION_ALTITUDE = 0.74;
const HOVER_PICK_MS = 70;
const POINTER_PICK_RADIUS = DEFAULT_PICK_RADIUS;
const MAX_RENDERED_PLANES = 12_000;
const MAX_ZONE_PENDING_POINTS = 160;
const MAX_ZONE_LOADING_POINTS = 60;
const BOOT_CAMERA_START = { lat: 14, lng: -132, altitude: 5.8 };
const BOOT_CAMERA_MID = { lat: 29, lng: -44, altitude: 3.25 };
const BOOT_CAMERA_END = { lat: 35, lng: 8, altitude: 2.1 };
const PERF_DEBUG_STORAGE_KEY = "stratus:perf-debug";
const DETAIL_TIERS = [
  {
    id: "world",
    minAltitude: 1.9,
    maxPlanes: 1_250,
    airportBudget: 24,
    weatherBudget: 0,
    overlaySyncMs: 520,
    instanceUpdateMs: 120,
    hoverPickMs: 180,
    trailRebuildMs: 1_800,
    trailStride: 4,
    pathResolution: 2,
    airportVariant: "far",
    airportMinGap: 42,
    weatherMinGap: 54,
    airportMaxDistance: 0,
  },
  {
    id: "regional",
    minAltitude: 0.92,
    maxPlanes: 3_000,
    airportBudget: 64,
    weatherBudget: 6,
    overlaySyncMs: 280,
    instanceUpdateMs: 72,
    hoverPickMs: 110,
    trailRebuildMs: 1_050,
    trailStride: 2,
    pathResolution: 3,
    airportVariant: "mid",
    airportMinGap: 28,
    weatherMinGap: 38,
    airportMaxDistance: 0,
  },
  {
    id: "local",
    minAltitude: 0,
    maxPlanes: 6_000,
    airportBudget: 160,
    weatherBudget: 14,
    overlaySyncMs: 140,
    instanceUpdateMs: 42,
    hoverPickMs: HOVER_PICK_MS,
    trailRebuildMs: 650,
    trailStride: 1,
    pathResolution: 4,
    airportVariant: "full",
    airportMinGap: 18,
    weatherMinGap: 24,
    airportMaxDistance: 26,
  },
];

const planeMap = new Map();
let planeArr = [];
let flightsLoaded = false;
let selectedHex = null;
let hoveredHex = null;
let fetchTimer = null;
let derivedVisualsDirty = true;
let weatherAbort = null;
let photoAbort = null;
let trajectoryAbort = null;
let weatherOverlayTimer = null;
let lastWeatherOverlayAt = 0;
let weatherOverlayKey = "";
let pointerDown = null;
let hoverPointer = null;
let lastHoverPickAt = 0;
let pickPlanes = [];
let activePhotoRequestKey = "";
let activeTrajectoryRequestHex = "";
let lastHealth = null;
let planeDataVersion = 0;
let sceneInteractionVersion = 0;
let selectedWeatherState = {
  hex: "",
  lat: null,
  lng: null,
  fetchedAt: 0,
  pending: false,
};
let selectedPhotoState = {
  hex: "",
  registration: "",
  pending: false,
};
let selectedTrajectoryState = {
  hex: "",
  pending: false,
};
let lastAppliedFlightsUpdated = 0;
let searchResultState = {
  query: "",
  results: [],
  total: 0,
  activeIndex: -1,
};
let focusSearchSelection = null;
const SEARCH_STATUS_DEFAULT = "";
const SEARCH_HINT_DEFAULT = "Ex: AFR6712, F-GSQJ, 4CA9C2 ou France";
const SEARCH_RESULT_LIMIT = 24;
const RADIO_AIRPORT_MARKER_ALTITUDE = 0.0042;
const RADIO_AIRPORT_ACTIVE_ALTITUDE = 0.0064;
let liveAtcAirports = [];
let liveAtcFeeds = [];
let weatherOverlayPoints = [];
let syncSceneHtmlOverlay = null;
let perfDebugEnabled = false;
const regionNameFormatter =
  typeof Intl !== "undefined" && typeof Intl.DisplayNames === "function"
    ? new Intl.DisplayNames(["en"], { type: "region" })
    : null;

const $ = (id) => document.getElementById(id);

const altColor0 = new THREE.Color("#ffee00"); // 0 ft - yellow
const altColor1 = new THREE.Color("#00ff88"); // ~8k ft - green
const altColor2 = new THREE.Color("#00ccff"); // ~16k ft - cyan
const altColor3 = new THREE.Color("#3366ff"); // ~24k ft - blue
const altColor4 = new THREE.Color("#9933ff"); // ~32k ft - purple
const altColor5 = new THREE.Color("#ff44cc"); // 40k+ ft - magenta/pink
const workingColor = new THREE.Color();
const surfaceVector = new THREE.Vector3();
const targetVector = new THREE.Vector3();
const upVector = new THREE.Vector3();
const lookMatrix = new THREE.Matrix4();
const workingQuat = new THREE.Quaternion();
const workingMatrix = new THREE.Matrix4();
const workingScale = new THREE.Vector3();
const screenVector = new THREE.Vector3();
const projectionMatrix = new THREE.Matrix4();
const frustum = new THREE.Frustum();
const pointerVector = new THREE.Vector2();
const raycaster = new THREE.Raycaster();
const axisOffset = new THREE.Quaternion();

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function lerp(start, end, amount) {
  return start + (end - start) * amount;
}

function easeInOutCubic(value) {
  const t = clamp01(value);
  return t < 0.5 ? 4 * t * t * t : 1 - ((-2 * t + 2) ** 3) / 2;
}

function readStoredPerfDebugFlag() {
  try {
    return window.localStorage.getItem(PERF_DEBUG_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function writeStoredPerfDebugFlag(enabled) {
  try {
    window.localStorage.setItem(PERF_DEBUG_STORAGE_KEY, enabled ? "1" : "0");
  } catch {
    // Ignore localStorage failures in restrictive environments.
  }
}

function setPerfDebugEnabled(enabled) {
  perfDebugEnabled = !!enabled;
  writeStoredPerfDebugFlag(perfDebugEnabled);
  $("perf-debug")?.toggleAttribute("hidden", !perfDebugEnabled);
}

function bumpSceneInteractionVersion() {
  sceneInteractionVersion += 1;
}

function searchPrimaryLabel(plane) {
  if (!plane) return "—";
  return plane.flight || plane.registration || plane.hex?.toUpperCase() || "—";
}

function searchSecondaryLabel(plane) {
  if (!plane) return SEARCH_HINT_DEFAULT;
  const parts = [];
  if (plane.registration && plane.registration !== searchPrimaryLabel(plane)) {
    parts.push(plane.registration);
  }
  if (plane.country) parts.push(plane.country);
  if (!parts.length && plane.hex) parts.push(plane.hex.toUpperCase());
  return parts.join(" • ");
}

function normalizeSearchText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .trim();
}

function tokenizeSearchText(value) {
  return normalizeSearchText(value)
    .split(/[^A-Z0-9]+/g)
    .filter(Boolean);
}

function getCountryDisplayName(countryCode) {
  const normalized = normalizeSearchText(countryCode);
  if (normalized.length !== 2 || !regionNameFormatter) return normalized;
  try {
    return regionNameFormatter.of(normalized) || normalized;
  } catch {
    return normalized;
  }
}

function normalizeMapCoordinate(value) {
  if (value == null || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function normalizeHexId(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^0-9a-f]/g, "");
  return normalized || null;
}

function hasRenderableAirportPosition(feed) {
  const lat = feed?.lat;
  const lng = feed?.lng;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return false;
  return !(Math.abs(lat) < 0.25 && Math.abs(lng) < 0.25);
}

function scoreSearchField(value, query, { allowContains = false } = {}) {
  const normalized = normalizeSearchText(value);
  if (!normalized) return -1;
  if (normalized === query) return 120;
  if (normalized.startsWith(query)) return 100;
  const tokens = tokenizeSearchText(normalized);
  if (tokens.includes(query)) return 92;
  if (tokens.some((token) => token.startsWith(query))) return 74;
  if (allowContains && normalized.includes(query)) return 28;
  return -1;
}

function filterLiveAtcFeeds(rawQuery) {
  const query = normalizeSearchText(rawQuery);
  if (!query) return liveAtcFeeds.slice();
  return liveAtcFeeds
    .map((feed) => {
      const score = Math.max(
        scoreSearchField(feed.icao, query) * 100,
        scoreSearchField(feed.countryLabel, query) * 80,
        scoreSearchField(feed.country, query) * 76,
        scoreSearchField(feed.city, query) * 64,
        scoreSearchField(feed.name, query, { allowContains: query.length >= 5 }) * 48,
        scoreSearchField(feed.label, query, { allowContains: query.length >= 5 }) * 40,
        scoreSearchField(feed.serviceLabel, query) * 24,
      );
      return { feed, score };
    })
    .filter(({ score }) => score > 0)
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return left.feed.icao.localeCompare(right.feed.icao);
    })
    .map(({ feed }) => feed);
}

function getRadioFeedTraits(feed) {
  const text = normalizeSearchText([feed?.label, feed?.name].filter(Boolean).join(" "));
  const hasTower = /TOWER|TWR|TCA/.test(text);
  const hasRadar = /RADAR/.test(text);
  return {
    text,
    hasAtis: /ATIS|AWOS|ASOS|INFORMATION/.test(text),
    hasGround: /GROUND|GND/.test(text),
    hasTower,
    hasApproach: /APPROACH|APP(?:\b|\/)|FINAL|DIRECTOR/.test(text),
    hasArrival: /ARRIVAL/.test(text),
    hasDeparture: /DEPARTURE|(?:^|[^A-Z])DEP(?:[^A-Z]|$)|APP\/DEP/.test(text),
    hasDelivery: /CLEARANCE|DELIVERY|(?:^|[^A-Z])DEL(?:[^A-Z]|$)/.test(text),
    hasRadar,
    hasCenter: !hasTower && /(?:^|[^A-Z])(CENTER|CENTRE|CONTROL)(?:[^A-Z]|$)/.test(text),
    hasCtaf: /CTAF|UNICOM/.test(text),
  };
}

function classifyRadioFeedService(feed) {
  const traits = getRadioFeedTraits(feed);
  if (!traits.text) return { label: "Radio", tone: "default" };
  if (traits.hasAtis) {
    return { label: "ATIS", tone: "atis" };
  }
  if (traits.hasCtaf) {
    return { label: "CTAF", tone: "ctaf" };
  }

  const majorCount = [
    traits.hasDelivery,
    traits.hasGround,
    traits.hasTower,
    traits.hasApproach || traits.hasArrival || traits.hasDeparture,
    traits.hasRadar || traits.hasCenter,
  ].filter(Boolean).length;

  if (majorCount > 1) {
    return { label: "Mixte", tone: "mixed" };
  }
  if (traits.hasTower) {
    return { label: "Tour", tone: "tower" };
  }
  if (traits.hasGround) {
    return { label: "Sol", tone: "ground" };
  }
  if (traits.hasApproach || traits.hasArrival) {
    return { label: "Approche", tone: "approach" };
  }
  if (traits.hasDeparture) {
    return { label: "Depart", tone: "approach" };
  }
  if (traits.hasDelivery) {
    return { label: "Delivrance", tone: "delivery" };
  }
  if (traits.hasCenter && !traits.hasRadar) {
    return { label: "Centre", tone: "radar" };
  }
  if (traits.hasRadar || traits.hasCenter) {
    return { label: "Radar", tone: "radar" };
  }
  return { label: "Radio", tone: "default" };
}

function describeRadioFeed(feed) {
  const traits = getRadioFeedTraits(feed);
  if (!traits.text) {
    return {
      badge: "Radio",
      summary: "Canal radio en direct autour de l'aeroport.",
      priority: 60,
    };
  }
  if (traits.hasAtis) {
    return {
      badge: "Infos",
      summary: "Message automatique avec meteo, pistes en service et infos utiles.",
      priority: 34,
    };
  }
  if (traits.hasCtaf) {
    return {
      badge: "Auto-info",
      summary: "Frequence d'auto-information pour le trafic local.",
      priority: 40,
    };
  }

  const mixedLabels = [];
  if (traits.hasDelivery) mixedLabels.push("Del");
  if (traits.hasGround) mixedLabels.push("Sol");
  if (traits.hasTower) mixedLabels.push("Tour");
  if (traits.hasApproach || traits.hasArrival) mixedLabels.push("App");
  if (traits.hasDeparture) mixedLabels.push("Dep");
  if (traits.hasRadar || traits.hasCenter) mixedLabels.push("Radar");
  if (mixedLabels.length > 1) {
    return {
      badge: mixedLabels.slice(0, 3).join(" + "),
      summary: "Un canal polyvalent pour entendre plusieurs phases d'un meme vol.",
      priority: 5,
    };
  }
  if (traits.hasTower) {
    return {
      badge: "Piste",
      summary: "Le plus vivant: decollages, atterrissages et autorisations piste.",
      priority: 0,
    };
  }
  if (traits.hasGround) {
    return {
      badge: "Taxi",
      summary: "Les avions roulent entre les portes et les pistes.",
      priority: 10,
    };
  }
  if (traits.hasArrival || /FINAL|DIRECTOR/.test(traits.text)) {
    return {
      badge: "Arrivees",
      summary: "Les avions descendent, s'alignent et entrent dans la zone de l'aeroport.",
      priority: 20,
    };
  }
  if (traits.hasDeparture) {
    return {
      badge: "Departs",
      summary: "Les avions quittent l'aeroport et montent vers leur route.",
      priority: 24,
    };
  }
  if (traits.hasApproach) {
    return {
      badge: "Approche",
      summary: "Les avions descendent, s'alignent et entrent dans la zone de l'aeroport.",
      priority: 20,
    };
  }
  if (traits.hasDelivery) {
    return {
      badge: "Avant depart",
      summary: "Clairances de route et consignes avant le demarrage.",
      priority: 28,
    };
  }
  if (traits.hasRadar || traits.hasCenter) {
    return {
      badge: "Regional",
      summary: "Trafic regional autour de l'aeroport, moins centre sur la piste.",
      priority: 50,
    };
  }
  if (/APRON|RAMP|COMPANY|OPS|ARINC|EMERGENCY|ARFF/.test(traits.text)) {
    return {
      badge: "Specialise",
      summary: "Canal specialise, utile quand on a deja pris ses reperes.",
      priority: 70,
    };
  }
  return {
    badge: "Radio",
    summary: "Canal radio en direct autour de l'aeroport.",
    priority: 60,
  };
}

function getRadioFeedLocality(feed) {
  return [feed?.city, feed?.countryLabel || feed?.country]
    .filter(Boolean)
    .join(", ");
}

function getRadioCountryBucketLabel(feed) {
  const label = (feed?.countryLabel || feed?.country || "").trim();
  if (label) return label;
  return "Code local ou region non renseignee";
}

function normalizeRadioFeedEntry(airport, rawFeed = {}, feedIndex = 0) {
  const icao = normalizeSearchText(airport?.icao || "");
  const feedId = String(rawFeed?.feed_id || rawFeed?.mount || airport?.feed_id || "").trim();
  if (!icao || !feedId) return null;
  const country = String(airport?.country || "").trim();
  const countryLabel = getCountryDisplayName(country);
  const label = String(
    rawFeed?.label || rawFeed?.name || airport?.label || airport?.name || feedId,
  ).trim();
  const service = classifyRadioFeedService({
    label,
    name: airport?.name,
  });
  const listenerGuide = describeRadioFeed({
    label,
    name: airport?.name,
  });
  return {
    key: `${icao}:${feedId}`,
    icao,
    feedId,
    feedIndex,
    label,
    name: String(airport?.name || airport?.label || icao).trim(),
    city: String(airport?.city || "").trim(),
    country,
    countryName: countryLabel,
    countryLabel,
    serviceLabel: service.label,
    serviceTone: service.tone,
    listenerBadge: listenerGuide.badge,
    listenerSummary: listenerGuide.summary,
    listenerPriority: listenerGuide.priority,
    lat: normalizeMapCoordinate(airport?.lat),
    lng: normalizeMapCoordinate(airport?.lng),
    pageUrl:
      String(rawFeed?.page_url || airport?.page_url || "").trim() ||
      `https://www.liveatc.net/search/?icao=${encodeURIComponent(icao)}`,
    streamUrl: String(rawFeed?.stream_url || airport?.stream_url || "").trim(),
  };
}

function buildRadioAirportRecord(rawAirport = {}) {
  const icao = normalizeSearchText(rawAirport?.icao || "");
  if (icao.length < 2 || icao.length > 8) return null;

  const rawFeeds = Array.isArray(rawAirport?.feeds) && rawAirport.feeds.length
    ? rawAirport.feeds
    : [rawAirport];
  const feeds = [];
  const seenFeedIds = new Set();
  rawFeeds.forEach((rawFeed, feedIndex) => {
    const normalized = normalizeRadioFeedEntry(rawAirport, rawFeed, feedIndex);
    if (!normalized) return;
    if (seenFeedIds.has(normalized.feedId)) return;
    seenFeedIds.add(normalized.feedId);
    feeds.push(normalized);
  });
  if (!feeds.length) return null;

  const country = String(rawAirport?.country || "").trim();
  const countryLabel = getCountryDisplayName(country);
  feeds.sort((left, right) => {
    if (left.listenerPriority !== right.listenerPriority) {
      return left.listenerPriority - right.listenerPriority;
    }
    if (left.feedIndex !== right.feedIndex) {
      return left.feedIndex - right.feedIndex;
    }
    return left.label.localeCompare(right.label);
  });
  const rankedPrimaryFeed = feeds[0];
  return {
    icao,
    label: String(rawAirport?.label || rawAirport?.name || icao).trim(),
    name: String(rawAirport?.name || rawAirport?.label || icao).trim(),
    description: String(rawAirport?.description || "").trim(),
    city: String(rawAirport?.city || "").trim(),
    country,
    countryName: countryLabel,
    countryLabel,
    lat: normalizeMapCoordinate(rawAirport?.lat),
    lng: normalizeMapCoordinate(rawAirport?.lng),
    pageUrl: String(rawAirport?.page_url || rankedPrimaryFeed.pageUrl || "").trim(),
    streamUrl: String(rawAirport?.stream_url || rankedPrimaryFeed.streamUrl || "").trim(),
    feedId: rankedPrimaryFeed.feedId,
    feeds,
  };
}

function mergeLiveAtcAirportCatalog(airports = []) {
  if (!Array.isArray(airports) || !airports.length) {
    liveAtcAirports = [];
    liveAtcFeeds = [];
    return;
  }
  const mergedAirports = [];
  const mergedFeeds = [];
  for (const rawAirport of airports) {
    const airport = buildRadioAirportRecord(rawAirport);
    if (!airport) continue;
    mergedAirports.push(airport);
    mergedFeeds.push(...airport.feeds);
  }
  liveAtcAirports = mergedAirports.sort((left, right) => {
    const leftCity = left.city || left.name || left.icao;
    const rightCity = right.city || right.name || right.icao;
    if (leftCity !== rightCity) {
      return leftCity.localeCompare(rightCity);
    }
    return left.icao.localeCompare(right.icao);
  });
  liveAtcFeeds = mergedFeeds.sort((left, right) => {
    const leftCountry = left.countryLabel || left.country || "";
    const rightCountry = right.countryLabel || right.country || "";
    if (leftCountry !== rightCountry) {
      return leftCountry.localeCompare(rightCountry);
    }
    if (left.icao !== right.icao) {
      return left.icao.localeCompare(right.icao);
    }
    if (left.feedIndex !== right.feedIndex) {
      return left.feedIndex - right.feedIndex;
    }
    return left.icao.localeCompare(right.icao);
  });
}

function filterLiveAtcAirports(rawQuery) {
  const query = normalizeSearchText(rawQuery);
  if (!query) {
    return liveAtcAirports.map((airport) => ({
      airport,
      feeds: airport.feeds.slice(),
      score: 0,
    }));
  }

  return liveAtcAirports
    .map((airport) => {
      const airportScore = Math.max(
        scoreSearchField(airport.icao, query) * 100,
        scoreSearchField(airport.countryLabel, query) * 80,
        scoreSearchField(airport.country, query) * 76,
        scoreSearchField(airport.city, query) * 64,
        scoreSearchField(airport.name, query, { allowContains: query.length >= 5 }) * 48,
      );
      const matchedFeeds = [];
      let bestFeedScore = -1;
      for (const feed of airport.feeds) {
        const score = Math.max(
          scoreSearchField(feed.label, query, { allowContains: query.length >= 5 }) * 42,
          scoreSearchField(feed.serviceLabel, query) * 24,
        );
        if (score > 0) {
          matchedFeeds.push(feed);
          if (score > bestFeedScore) bestFeedScore = score;
        }
      }

      const score = Math.max(airportScore, bestFeedScore);
      if (score <= 0) return null;
      return {
        airport,
        feeds: airportScore > 0 ? airport.feeds.slice() : matchedFeeds,
        score,
      };
    })
    .filter(Boolean)
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return left.airport.icao.localeCompare(right.airport.icao);
    });
}

function levenshteinWithinLimit(left, right, limit) {
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

function scoreSearchValue(query, value, scores) {
  if (!value) return null;
  const normalized = normalizeSearchText(value);
  if (!normalized) return null;
  if (normalized === query) return { score: scores.exact, match: "exact" };
  if (normalized.startsWith(query))
    return { score: scores.prefix, match: "prefix" };
  if (normalized.includes(` ${query}`) || normalized.includes(`-${query}`)) {
    return { score: scores.word, match: "word" };
  }
  if (normalized.includes(query)) return { score: scores.contains, match: "contains" };
  return null;
}

function fuzzySearchValue(query, value, baseScore) {
  if (!value || query.length < 4) return null;
  const normalized = normalizeSearchText(value);
  if (!normalized) return null;

  const directDistance = levenshteinWithinLimit(normalized, query, 1);
  if (directDistance <= 1) {
    return { score: baseScore - (directDistance * 25), match: "fuzzy" };
  }

  const tokens = normalized.split(/[\s-/]+/).filter(Boolean);
  for (const token of tokens) {
    if (token.length < Math.max(3, query.length - 2)) continue;
    const distance = levenshteinWithinLimit(token, query, 1);
    if (distance <= 1) {
      return { score: baseScore - 35 - (distance * 20), match: "fuzzy" };
    }
  }

  return null;
}

function manufacturerAliasForPlane(plane) {
  const type = normalizeSearchText(plane.aircraft_type);
  if (!type) return "";
  if (/^B[0-9]/.test(type)) return "BOEING";
  if (/^A(2|3|4|5|6)/.test(type)) return "AIRBUS";
  if (/^AT/.test(type)) return "ATR";
  if (/^(E|ERJ)/.test(type)) return "EMBRAER";
  if (/^(CRJ|CL)/.test(type)) return "BOMBARDIER";
  if (/^GL/.test(type)) return "GULFSTREAM";
  if (/^(F9|FA)/.test(type)) return "DASSAULT";
  if (/^PC/.test(type)) return "PILATUS";
  if (/^DH/.test(type)) return "DE HAVILLAND";
  if (/^AN/.test(type)) return "ANTONOV";
  return "";
}

function rankPlaneForSearch(plane, rawQuery) {
  const query = normalizeSearchText(rawQuery);
  if (!query) return null;

  const candidates = [
    {
      value: plane.hex,
      kind: "Hex",
      autoFocus: true,
      scores: { exact: 1600, prefix: 1320, word: 1180, contains: 1040 },
    },
    {
      value: plane.registration,
      kind: "Immat",
      autoFocus: true,
      scores: { exact: 1540, prefix: 1260, word: 1120, contains: 980 },
    },
    {
      value: plane.flight,
      kind: "Vol",
      autoFocus: true,
      scores: { exact: 1480, prefix: 1220, word: 1080, contains: 940 },
    },
    {
      value: plane.country,
      kind: "Pays",
      autoFocus: false,
      scores: { exact: 620, prefix: 520, word: 470, contains: 400 },
    },
    {
      value: plane.aircraft_description,
      kind: "Modèle",
      autoFocus: false,
      scores: { exact: 520, prefix: 420, word: 350, contains: 290 },
    },
    {
      value: manufacturerAliasForPlane(plane),
      kind: "Constructeur",
      autoFocus: false,
      scores: { exact: 700, prefix: 560, word: 440, contains: 360 },
    },
    {
      value: plane.owner,
      kind: "Compagnie",
      autoFocus: false,
      scores: { exact: 560, prefix: 420, word: 360, contains: 300 },
    },
    {
      value: plane.aircraft_type,
      kind: "Type",
      autoFocus: false,
      scores: { exact: 460, prefix: 360, word: 320, contains: 260 },
    },
    {
      value: plane.variantLabel,
      kind: "Catégorie",
      autoFocus: false,
      scores: { exact: 360, prefix: 300, word: 260, contains: 220 },
    },
  ];

  let best = null;
  for (const candidate of candidates) {
    const hit =
      scoreSearchValue(query, candidate.value, candidate.scores) ||
      fuzzySearchValue(query, candidate.value, candidate.scores.contains);
    if (!hit) continue;
    if (!best || hit.score > best.score) {
      best = {
        plane,
        score: hit.score,
        kind: candidate.kind,
        autoFocus: candidate.autoFocus && hit.match !== "contains",
      };
    }
  }

  return best;
}

function buildSearchMatches(rawQuery) {
  const matches = [];

  for (const plane of planeArr) {
    const ranked = rankPlaneForSearch(plane, rawQuery);
    if (!ranked) continue;
    matches.push(ranked);
  }

  matches.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    if ((right.plane.last_contact || 0) !== (left.plane.last_contact || 0)) {
      return (right.plane.last_contact || 0) - (left.plane.last_contact || 0);
    }
    return searchPrimaryLabel(left.plane).localeCompare(searchPrimaryLabel(right.plane));
  });

  const results = matches.slice(0, SEARCH_RESULT_LIMIT);
  const first = results[0];
  const second = results[1];
  const autoFocus =
    !!first &&
    first.autoFocus &&
    (!second || first.score - second.score >= 220 || first.score >= 1450);

  return {
    query: rawQuery.trim(),
    total: matches.length,
    results,
    autoFocus,
  };
}

function renderSearchResults() {
  const container = $("search-results");
  const box = $("search-box");
  if (!container || !box) return;

  container.innerHTML = "";
  box.classList.toggle("has-results", searchResultState.results.length > 0);

  if (!searchResultState.results.length) {
    container.hidden = true;
    return;
  }

  for (let index = 0; index < searchResultState.results.length; index += 1) {
    const result = searchResultState.results[index];
    const button = document.createElement("button");
    button.type = "button";
    button.className = "search-result";
    button.dataset.index = String(index);
    button.dataset.active = String(index === searchResultState.activeIndex);

    const copy = document.createElement("span");
    copy.className = "search-result__copy";

    const title = document.createElement("span");
    title.className = "search-result__title";
    title.textContent = searchPrimaryLabel(result.plane);

    const meta = document.createElement("span");
    meta.className = "search-result__meta";
    meta.textContent = searchResultMeta(result.plane);

    const kind = document.createElement("span");
    kind.className = "search-result__kind";
    kind.textContent = result.kind;

    copy.append(title, meta);
    button.append(copy, kind);
    container.appendChild(button);
  }

  container.hidden = false;
}

function setSearchResults(state) {
  searchResultState = {
    query: state.query || "",
    results: state.results || [],
    total: state.total || 0,
    activeIndex: state.results?.length ? 0 : -1,
  };
  renderSearchResults();
}

function clearSearchResults() {
  setSearchResults({ query: "", results: [], total: 0 });
}

function selectSearchResult(index) {
  const result = searchResultState.results[index];
  if (!result || !focusSearchSelection) return;
  focusSearchSelection(result.plane);
  clearSearchResults();
  setSearchFeedback({
    query: $("search-input")?.value?.trim() || "",
    plane: result.plane,
  });
}

function moveSearchResultSelection(step) {
  if (!searchResultState.results.length) return;
  const length = searchResultState.results.length;
  const nextIndex =
    searchResultState.activeIndex < 0
      ? 0
      : (searchResultState.activeIndex + step + length) % length;
  searchResultState.activeIndex = nextIndex;
  renderSearchResults();
}

function updateSearchFromInput() {
  const rawQuery = $("search-input")?.value?.trim() || "";
  if (!rawQuery) {
    clearSearchResults();
    setSearchFeedback();
    return;
  }

  const matches = buildSearchMatches(rawQuery);
  if (!matches.results.length) {
    clearSearchResults();
    setSearchFeedback({ query: rawQuery, tone: "error" });
    return;
  }

  if (matches.autoFocus) {
    clearSearchResults();
    const [first] = matches.results;
    if (focusSearchSelection) focusSearchSelection(first.plane);
    setSearchFeedback({ query: rawQuery, plane: first.plane });
    return;
  }

  setSearchResults(matches);
  setSearchFeedback({ query: rawQuery, totalMatches: matches.total });
}

function setSearchFeedback({
  query = "",
  plane = null,
  tone = "",
  totalMatches = 0,
} = {}) {
  const box = $("search-box");
  const statusNode = $("search-status");
  const hintNode = $("search-hint");
  const activeQuery = String(query || $("search-input")?.value || "").trim();
  const selectedPlane = getPlaneByHex(selectedHex);
  const activePlane = plane || (!activeQuery ? selectedPlane : null);
  const suppressStatus = document.body.classList.contains("popup-open");

  let status = SEARCH_STATUS_DEFAULT;
  let hint = SEARCH_HINT_DEFAULT;
  let nextTone = tone;

  if (activeQuery && tone === "error") {
    status = `Aucun appareil visible pour "${activeQuery}"`;
    hint = "Essayez un vol, une immatriculation, un hex ICAO ou un pays.";
  } else if (activeQuery && plane) {
    status = `Ciblage : ${searchPrimaryLabel(plane)}`;
    hint = searchSecondaryLabel(plane);
    nextTone = "active";
  } else if (activeQuery && totalMatches > 0) {
    status = `${totalMatches} résultats pour "${activeQuery}"`;
    hint = "Choisissez un appareil dans la liste.";
  } else if (activePlane) {
    status = `Ciblage actif : ${searchPrimaryLabel(activePlane)}`;
    hint = searchSecondaryLabel(activePlane);
    nextTone = "active";
  }

  box?.classList.toggle("has-query", Boolean(activeQuery));
  box?.classList.toggle("has-selection", Boolean(selectedPlane));

  if (statusNode) {
    statusNode.textContent = suppressStatus ? "" : status;
    statusNode.hidden = suppressStatus || !status;
    if (nextTone) statusNode.dataset.tone = nextTone;
    else delete statusNode.dataset.tone;
  }
  if (hintNode) hintNode.textContent = hint;
}

function clearSearch({ keepFocus = false } = {}) {
  const input = $("search-input");
  if (input) {
    input.value = "";
    if (keepFocus) input.focus();
    else input.blur();
  }
  clearSearchResults();
  selectedHex = null;
  bumpSceneInteractionVersion();
  updatePopup(null);
  derivedVisualsDirty = true;
  setSearchFeedback();
}

function easeInOutSine(value) {
  const t = clamp01(value);
  return -(Math.cos(Math.PI * t) - 1) / 2;
}

function lerpPov(from, to, amount) {
  return {
    lat: lerp(from.lat, to.lat, amount),
    lng: lerp(from.lng, to.lng, amount),
    altitude: lerp(from.altitude, to.altitude, amount),
  };
}

function createBootSequence(world, controls) {
  const boot = $("boot-sequence");
  const skipButton = $("boot-skip");
  const state = {
    active: !!boot,
    exiting: false,
    startedAt: performance.now(),
    lastFrameAt: performance.now(),
    readyAt: 0,
    exitAt: 0,
    minDurationMs: 1250,
    revealHoldMs: 220,
    fadeDurationMs: 520,
    targetProgress: 6,
    displayedProgress: 0,
    loadComplete: false,
    loadSweeping: false,
    label: "Initialisation du globe",
    note: "Preparation du snapshot OpenSky et stabilisation de la camera.",
    smoothedPov: { ...BOOT_CAMERA_START },
  };

  if (!boot) {
    return {
      dismiss() {},
      markReady() {},
      applyLoadState() {},
      update() {},
    };
  }

  document.body.classList.add("intro-active");
  document.body.classList.remove("intro-complete");
  world.pointOfView(BOOT_CAMERA_START);
  if ("enabled" in controls) controls.enabled = false;

  function finish() {
    if (!state.active) return;
    state.active = false;
    document.body.classList.remove("intro-active");
    if ("enabled" in controls) controls.enabled = true;
    setTimeout(() => {
      boot.hidden = true;
      document.body.classList.remove("intro-complete");
    }, 1050);
  }

  function beginExit(now, immediate = false) {
    if (!state.active || state.exiting) return;
    state.exiting = true;
    state.exitAt = now + (immediate ? 360 : state.fadeDurationMs);
    document.body.classList.add("intro-complete");
    world.pointOfView(BOOT_CAMERA_END, immediate ? 1200 : 2200);
  }

  function markReady(now = performance.now()) {
    if (!state.active || state.readyAt) return;
    state.readyAt = now;
  }

  function applyLoadState(loadStateInfo) {
    if (!state.active || !loadStateInfo) return;
    state.loadComplete = !!loadStateInfo.complete;
    state.loadSweeping = !!loadStateInfo.sweeping;
    state.label = state.loadComplete
      ? "Flux mondial verrouille"
      : loadStateInfo.label;
    state.note = state.loadComplete
      ? "Trafic mondial acquis. Stabilisation de la camera avant prise en main."
      : loadStateInfo.note ||
        "Preparation du snapshot OpenSky et synchronisation des couches temps reel.";
    state.targetProgress = state.loadComplete
      ? 100
      : Math.max(8, Math.min(loadStateInfo.fillPercent || 0, 94));
  }

  function dismiss() {
    if (!state.active) return;
    markReady(performance.now());
    beginExit(performance.now(), true);
  }

  skipButton?.addEventListener("click", dismiss);

  return {
    dismiss,
    markReady,
    applyLoadState,
    update(now) {
      if (!state.active) return;
      if (state.exiting) {
        if (now >= state.exitAt) finish();
        return;
      }

      const frameDelta = Math.min(64, Math.max(16, now - state.lastFrameAt));
      state.lastFrameAt = now;
      const elapsed = now - state.startedAt;
      const progress = clamp01(elapsed / 7_500);
      const segment =
        progress < 0.66
          ? lerpPov(
              BOOT_CAMERA_START,
              BOOT_CAMERA_MID,
              easeInOutSine(progress / 0.66),
            )
          : lerpPov(
              BOOT_CAMERA_MID,
              BOOT_CAMERA_END,
              easeInOutSine((progress - 0.66) / 0.34),
            );
      const driftFade = 1 - clamp01(progress / 0.92);
      const targetPov = {
        lat: segment.lat + Math.sin(elapsed * 0.00024) * 0.75 * driftFade,
        lng:
          segment.lng +
          Math.sin(elapsed * 0.00017 + 0.9) * 1.45 * driftFade,
        altitude:
          Math.max(
            BOOT_CAMERA_END.altitude,
            segment.altitude +
              Math.sin(elapsed * 0.00019 + 1.4) * 0.045 * driftFade,
          ) + Math.cos(elapsed * 0.00011) * 0.02 * driftFade,
      };
      const cameraCatchUp = 1 - Math.exp(-frameDelta / 680);
      state.smoothedPov = lerpPov(
        state.smoothedPov,
        targetPov,
        cameraCatchUp,
      );
      world.pointOfView(state.smoothedPov);

      const progressCatchUp = state.loadComplete
        ? 1 - Math.exp(-frameDelta / 240)
        : 1 - Math.exp(-frameDelta / 620);
      state.displayedProgress = lerp(
        state.displayedProgress,
        state.targetProgress,
        progressCatchUp,
      );
      if (Math.abs(state.displayedProgress - state.targetProgress) < 0.18) {
        state.displayedProgress = state.targetProgress;
      }

      const displayPercent = state.loadComplete
        ? Math.round(Math.min(100, state.displayedProgress))
        : Math.round(Math.min(99, state.displayedProgress));
      $("intro-label").textContent = state.label;
      $("intro-note").textContent = state.note;
      $("intro-percent").textContent = `${displayPercent}%`;
      $("intro-progress").style.width = `${Math.min(100, state.displayedProgress)}%`;
      boot.classList.toggle("is-complete", state.loadComplete);
      boot.classList.toggle("is-sweeping", state.loadSweeping);

      if (
        state.readyAt &&
        elapsed >= state.minDurationMs &&
        now - state.readyAt >= state.revealHoldMs &&
        state.displayedProgress >= 99.4
      ) {
        beginExit(now);
      }
    },
  };
}

const VARIANTS = [
  {
    id: "light",
    label: "Avion léger",
    scale: 1.06,
    shapes: [
      {
        depth: 0.11,
        half: [
          [0.0, 1.75],
          [0.12, 1.36],
          [0.18, 0.82],
          [0.78, 0.28],
          [0.54, 0.06],
          [0.2, -0.02],
          [0.22, -0.78],
          [0.42, -1.28],
          [0.16, -1.18],
          [0.08, -1.74],
          [0.0, -1.92],
        ],
      },
      {
        depth: 0.11,
        half: [
          [0.0, 1.72],
          [0.08, 1.48],
          [0.28, 0.94],
          [0.68, 0.32],
          [0.48, 0.02],
          [0.18, -0.06],
          [0.26, -0.72],
          [0.38, -1.22],
          [0.14, -1.14],
          [0.06, -1.68],
          [0.0, -1.88],
        ],
      },
      {
        depth: 0.1,
        half: [
          [0.0, 1.68],
          [0.14, 1.28],
          [0.22, 0.76],
          [0.72, 0.22],
          [0.52, 0.0],
          [0.22, -0.04],
          [0.2, -0.82],
          [0.46, -1.32],
          [0.18, -1.2],
          [0.1, -1.78],
          [0.0, -1.96],
        ],
      },
    ],
  },
  {
    id: "regional",
    label: "Régional",
    scale: 1.0,
    shapes: [
      {
        depth: 0.12,
        half: [
          [0.0, 1.88],
          [0.14, 1.42],
          [0.18, 0.92],
          [1.04, 0.34],
          [0.78, 0.1],
          [0.24, -0.02],
          [0.3, -1.04],
          [0.66, -1.46],
          [0.2, -1.34],
          [0.1, -1.82],
          [0.0, -1.98],
        ],
      },
      {
        depth: 0.12,
        half: [
          [0.0, 1.92],
          [0.1, 1.5],
          [0.22, 0.98],
          [0.94, 0.38],
          [0.72, 0.08],
          [0.26, -0.04],
          [0.28, -1.0],
          [0.72, -1.5],
          [0.22, -1.38],
          [0.12, -1.86],
          [0.0, -2.02],
        ],
      },
      {
        depth: 0.11,
        half: [
          [0.0, 1.84],
          [0.16, 1.38],
          [0.16, 0.88],
          [1.12, 0.3],
          [0.82, 0.12],
          [0.22, -0.02],
          [0.32, -1.08],
          [0.62, -1.44],
          [0.18, -1.3],
          [0.08, -1.78],
          [0.0, -1.94],
        ],
      },
    ],
  },
  {
    id: "jet",
    label: "Jet",
    scale: 1.08,
    shapes: [
      {
        depth: 0.13,
        half: [
          [0.0, 2.04],
          [0.16, 1.58],
          [0.2, 1.0],
          [1.34, 0.26],
          [1.02, 0.02],
          [0.26, -0.06],
          [0.42, -1.08],
          [0.82, -1.56],
          [0.24, -1.44],
          [0.1, -1.92],
          [0.0, -2.1],
        ],
      },
      {
        depth: 0.13,
        half: [
          [0.0, 2.08],
          [0.12, 1.62],
          [0.24, 1.04],
          [1.28, 0.28],
          [0.98, 0.0],
          [0.28, -0.08],
          [0.38, -1.04],
          [0.88, -1.6],
          [0.26, -1.48],
          [0.12, -1.96],
          [0.0, -2.14],
        ],
      },
      {
        depth: 0.12,
        half: [
          [0.0, 2.0],
          [0.18, 1.54],
          [0.18, 0.96],
          [1.38, 0.24],
          [1.06, 0.04],
          [0.24, -0.04],
          [0.44, -1.12],
          [0.78, -1.52],
          [0.22, -1.4],
          [0.08, -1.88],
          [0.0, -2.06],
        ],
      },
    ],
  },
  {
    id: "heavy",
    label: "Long-courrier",
    scale: 1.18,
    shapes: [
      {
        depth: 0.15,
        half: [
          [0.0, 2.18],
          [0.18, 1.72],
          [0.24, 1.08],
          [1.62, 0.34],
          [1.18, 0.08],
          [0.32, -0.04],
          [0.48, -1.16],
          [0.96, -1.7],
          [0.26, -1.56],
          [0.12, -2.02],
          [0.0, -2.22],
        ],
      },
      {
        depth: 0.15,
        half: [
          [0.0, 2.22],
          [0.16, 1.76],
          [0.28, 1.12],
          [1.56, 0.36],
          [1.14, 0.06],
          [0.34, -0.06],
          [0.44, -1.12],
          [1.0, -1.74],
          [0.28, -1.6],
          [0.14, -2.06],
          [0.0, -2.26],
        ],
      },
      {
        depth: 0.14,
        half: [
          [0.0, 2.14],
          [0.2, 1.68],
          [0.22, 1.04],
          [1.68, 0.32],
          [1.22, 0.1],
          [0.3, -0.02],
          [0.5, -1.18],
          [0.92, -1.66],
          [0.24, -1.52],
          [0.1, -1.98],
          [0.0, -2.18],
        ],
      },
    ],
  },
];
const VARIANT_MAP = new Map(VARIANTS.map((variant) => [variant.id, variant]));

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.onload = resolve;
    script.onerror = () => reject(new Error(`Impossible de charger ${src}`));
    document.head.appendChild(script);
  });
}

function setStatus(mode, label) {
  $("status").className = `badge ${mode}`;
  $("status").textContent = label;
}

function getAltitudeColor(altMeters) {
  const altFt = (altMeters || 0) * 3.28084;
  const t = Math.max(0, Math.min(altFt / 45000, 1));
  if (t < 0.18) {
    workingColor.copy(altColor0).lerp(altColor1, t / 0.18);
  } else if (t < 0.36) {
    workingColor.copy(altColor1).lerp(altColor2, (t - 0.18) / 0.18);
  } else if (t < 0.54) {
    workingColor.copy(altColor2).lerp(altColor3, (t - 0.36) / 0.18);
  } else if (t < 0.72) {
    workingColor.copy(altColor3).lerp(altColor4, (t - 0.54) / 0.18);
  } else {
    workingColor.copy(altColor4).lerp(altColor5, (t - 0.72) / 0.28);
  }
  return workingColor;
}

function realAltitude(altMeters) {
  const meters = Math.max(0, altMeters || 0);
  const normalized = meters / EARTH_R;
  const emphasized = normalized * 10;
  return Math.max(ALTITUDE_FLOOR, ALTITUDE_FLOOR + emphasized);
}

function unwrapLongitude(reference, value) {
  let lng = value;
  while (lng - reference > 180) lng -= 360;
  while (lng - reference < -180) lng += 360;
  return lng;
}

function wrapLongitude(value) {
  return ((((value + 180) % 360) + 360) % 360) - 180;
}

function angularDistanceDegrees(from, to) {
  const latDelta = Math.abs((from?.lat || 0) - (to?.lat || 0));
  const lngDelta = Math.abs(
    wrapLongitude((to?.lng || 0) - (from?.lng || 0)),
  );
  return latDelta + lngDelta * Math.max(0.32, Math.cos(((from?.lat || 0) * Math.PI) / 180));
}

function detailTierIndexForAltitude(altitude) {
  for (let index = 0; index < DETAIL_TIERS.length; index += 1) {
    if (altitude >= DETAIL_TIERS[index].minAltitude) return index;
  }
  return DETAIL_TIERS.length - 1;
}

function detailTierByIndex(index) {
  return DETAIL_TIERS[Math.max(0, Math.min(index, DETAIL_TIERS.length - 1))];
}

function samplePolylinePoints(points, stride = 1) {
  const safeStride = Math.max(1, Math.floor(stride || 1));
  if (safeStride <= 1 || points.length <= 2) return points.slice();
  const sampled = [];
  for (let index = 0; index < points.length; index += safeStride) {
    sampled.push(points[index]);
  }
  const lastPoint = points[points.length - 1];
  if (sampled[sampled.length - 1] !== lastPoint) sampled.push(lastPoint);
  return sampled;
}

function planeVisibilityPriority(plane) {
  if (!plane) return 0;
  const speed = Math.max(0, Number(plane.gs) || 0);
  const altitude = Math.max(0, Number(plane.alt) || 0);
  return speed * 0.08 + altitude * 0.0002;
}

function chooseVisiblePlaneSet(candidates, budget, profile, viewportState) {
  const limit = Math.max(1, Math.floor(budget || 1));
  if (candidates.length <= limit) return candidates;

  const cellSize =
    profile.id === "world"
      ? 84
      : profile.id === "regional"
        ? 56
        : 34;
  const chosen = [];
  const chosenHexes = new Set();
  const buckets = new Map();

  for (const candidate of candidates) {
    const plane = candidate.plane;
    if (!plane) continue;
    if (plane.hex === selectedHex || plane.hex === hoveredHex) {
      if (!chosenHexes.has(plane.hex)) {
        chosen.push(candidate);
        chosenHexes.add(plane.hex);
      }
      continue;
    }

    const cellX = Math.max(
      0,
      Math.min(
        Math.floor(candidate.screenX / cellSize),
        Math.max(0, Math.floor(viewportState.width / cellSize)),
      ),
    );
    const cellY = Math.max(
      0,
      Math.min(
        Math.floor(candidate.screenY / cellSize),
        Math.max(0, Math.floor(viewportState.height / cellSize)),
      ),
    );
    const key = `${cellX}:${cellY}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(candidate);
  }

  const bucketEntries = [...buckets.values()];
  for (const bucket of bucketEntries) {
    bucket.sort((left, right) => right.priority - left.priority);
  }

  bucketEntries.sort((left, right) => {
    if (right.length !== left.length) return right.length - left.length;
    return right[0].priority - left[0].priority;
  });

  for (const bucket of bucketEntries) {
    if (chosen.length >= limit) break;
    const candidate = bucket[0];
    if (!candidate || chosenHexes.has(candidate.plane.hex)) continue;
    chosen.push(candidate);
    chosenHexes.add(candidate.plane.hex);
    candidate.bucketIndex = 1;
  }

  if (chosen.length >= limit) {
    return chosen.slice(0, limit);
  }

  const overflow = [];
  for (const bucket of bucketEntries) {
    for (let index = 1; index < bucket.length; index += 1) {
      const candidate = bucket[index];
      if (!candidate || chosenHexes.has(candidate.plane.hex)) continue;
      overflow.push(candidate);
    }
  }
  overflow.sort((left, right) => right.priority - left.priority);

  for (const candidate of overflow) {
    if (chosen.length >= limit) break;
    if (chosenHexes.has(candidate.plane.hex)) continue;
    chosen.push(candidate);
    chosenHexes.add(candidate.plane.hex);
  }

  return chosen.slice(0, limit);
}

function normalizeTrailPoints(points) {
  let lastLng = null;
  return points.map((point) => {
    const lng =
      lastLng == null ? point.lng : unwrapLongitude(lastLng, point.lng);
    lastLng = lng;
    return { ...point, lng };
  });
}

function toRenderTrailPoint(point) {
  const altMeters = point.alt || 0;
  return {
    lat: point.lat,
    lng: point.lng,
    alt: realAltitude(altMeters) + TRAIL_ALTITUDE_BOOST,
    altMeters,
  };
}

function densifyPolyline(points) {
  if (points.length < 2) return points.slice();

  const dense = [points[0]];
  for (let index = 0; index < points.length - 1; index += 1) {
    const start = points[index];
    const end = points[index + 1];
    const latSpan = Math.abs(end.lat - start.lat);
    const lngSpan = Math.abs(end.lng - start.lng);
    const steps = Math.max(
      2,
      Math.min(12, Math.ceil(Math.max(latSpan, lngSpan) / 1.75)),
    );

    for (let step = 1; step <= steps; step += 1) {
      const t = step / steps;
      dense.push({
        lat: start.lat + (end.lat - start.lat) * t,
        lng: start.lng + (end.lng - start.lng) * t,
        alt: start.alt + (end.alt - start.alt) * t,
        altMeters:
          (start.altMeters ?? 0) +
          ((end.altMeters ?? 0) - (start.altMeters ?? 0)) * t,
      });
    }
  }
  return dense;
}

function buildDashedPaths(
  points,
  {
    dashSpan = 8,
    gapSpan = 5,
    color = "rgba(226, 73, 255, 0.92)",
    stroke = SELECTED_TRAIL_STROKE,
  } = {},
) {
  if (points.length < 2) return [];

  const segments = [];
  let startIndex = 0;
  while (startIndex < points.length - 1) {
    const endIndex = Math.min(points.length - 1, startIndex + dashSpan);
    const segment = points.slice(startIndex, endIndex + 1);
    if (segment.length >= 2) {
      segments.push({
        points: segment,
        color,
        stroke,
      });
    }
    startIndex = endIndex + gapSpan;
  }
  return segments;
}

function altitudeColorCss(altMeters, alpha = 0.94) {
  const color = getAltitudeColor(altMeters || 0);
  const r = Math.round(color.r * 255);
  const g = Math.round(color.g * 255);
  const b = Math.round(color.b * 255);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function buildAltitudeColoredPaths(
  points,
  {
    stroke = SELECTED_TRAIL_STROKE,
    alpha = 0.94,
    dashSpan = null,
    gapSpan = 0,
    colorChunkSpan = TRAIL_COLOR_CHUNK_SPAN,
  } = {},
) {
  if (points.length < 2) return [];

  const segments = [];
  let startIndex = 0;
  while (startIndex < points.length - 1) {
    const endIndex =
      dashSpan == null
        ? points.length - 1
        : Math.min(points.length - 1, startIndex + dashSpan);

    let colorStart = startIndex;
    while (colorStart < endIndex) {
      const colorEnd = Math.min(endIndex, colorStart + colorChunkSpan);
      const slice = points.slice(colorStart, colorEnd + 1);
      if (slice.length >= 2) {
        let altSum = 0;
        for (const point of slice) altSum += point.altMeters ?? 0;
        const altMeters = altSum / slice.length;
        segments.push({
          points: slice,
          color: altitudeColorCss(altMeters, alpha),
          stroke,
        });
      }
      colorStart = colorEnd;
    }

    if (dashSpan == null) break;
    startIndex = endIndex + gapSpan;
  }
  return segments;
}

function relativeTime(epochSeconds) {
  if (!epochSeconds) return null;
  const delta = Math.max(0, Math.round(Date.now() / 1000 - epochSeconds));
  if (delta < 60) return `il y a ${delta}s`;
  if (delta < 3600) return `il y a ${Math.round(delta / 60)} min`;
  return `il y a ${Math.round(delta / 3600)} h`;
}

function headingLabel(track) {
  if (track == null) return null;
  const dirs = ["N", "NE", "E", "SE", "S", "SO", "O", "NO"];
  const normalized = ((track % 360) + 360) % 360;
  return `${Math.round(normalized)}° ${dirs[Math.round(normalized / 45) % 8]}`;
}

function haversineKm(lat1, lng1, lat2, lng2) {
  const phi1 = (lat1 * Math.PI) / 180;
  const phi2 = (lat2 * Math.PI) / 180;
  const dPhi = ((lat2 - lat1) * Math.PI) / 180;
  const dLambda = (wrapLongitude(lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dPhi / 2) ** 2 +
    Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLambda / 2) ** 2;
  return 6371 * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a))));
}

function buildTrailEndpoint(plane, anchorLng) {
  const lat = plane.cLat ?? plane.lat;
  let lng = unwrapLongitude(anchorLng, plane.cLng ?? plane.lng);
  let endpointLat = lat;
  let endpointLng = lng;

  if (plane.trk != null) {
    const gapM =
      plane.gs != null
        ? Math.max(
            TRAIL_ENDPOINT_MIN_GAP_M,
            Math.min(TRAIL_ENDPOINT_MAX_GAP_M, plane.gs * 0.514444 * 10),
          )
        : 3_000;
    const headingRad = (plane.trk * Math.PI) / 180;
    const cosLat = Math.max(0.05, Math.cos((lat * Math.PI) / 180));
    endpointLat -= (gapM * Math.cos(headingRad)) / 111_320;
    endpointLng -= (gapM * Math.sin(headingRad)) / (111_320 * cosLat);
  }

  return {
    lat: endpointLat,
    lng: endpointLng,
    alt: realAltitude(plane.alt || 0) + TRAIL_ALTITUDE_BOOST,
    altMeters: plane.alt || 0,
  };
}

function setPopupField(name, value, { html = false, loading = false } = {}) {
  const row = document.querySelector(`[data-row="${name}"]`);
  const target = row?.querySelector(".field-value");
  if (!row || !target) return;
  const isEmpty = value == null || value === "";
  row.hidden = isEmpty && !loading;
  target.classList.toggle("loading", loading);
  if (loading) {
    target.innerHTML = "&nbsp;";
    return;
  }
  if (isEmpty) {
    target.textContent = "";
    return;
  }
  if (html) target.innerHTML = value;
  else target.textContent = value;
}

function setTextIfPresent(id, value) {
  const node = $(id);
  if (!node) return;
  node.textContent = value;
}

function setWeatherLoading(isLoading) {
  $("wx-status").classList.toggle("loading", isLoading);
  document.querySelectorAll("#wx-grid .wx-card").forEach((card) => {
    card.classList.toggle("loading", isLoading);
  });
}

function setWeatherState(label, showGrid = false, loading = false) {
  $("wx-status").textContent = label;
  $("wx-grid").hidden = !showGrid;
  setWeatherLoading(loading);
}

function buildBadge(text, alert = false) {
  const badge = document.createElement("span");
  badge.className = `popup-badge${alert ? " alert" : ""}`;
  badge.textContent = text;
  return badge;
}

function photoRequestKeyForPlane(plane) {
  return plane ? `${plane.hex || ""}:${plane.registration || ""}` : "";
}

function applyPhotoMetadataToPlane(plane, payload) {
  if (!plane || !payload) return;
  if (payload.mode_s) plane.mode_s = payload.mode_s;
  if (payload.registration) plane.registration = payload.registration;
  if (payload.manufacturer) plane.manufacturer = payload.manufacturer;
  if (payload.aircraft_model) plane.aircraft_model = payload.aircraft_model;
  if (payload.aircraft_type) plane.aircraft_type = payload.aircraft_type;
  if (payload.aircraft_description) {
    plane.aircraft_description = payload.aircraft_description;
  }
  if (payload.owner) plane.owner = payload.owner;
  if (payload.operator_code) plane.operator_code = payload.operator_code;
  if (payload.country) plane.country = payload.country;
  if (searchResultState.results.length) renderSearchResults();
}

function searchResultMeta(plane) {
  const lead = plane.registration || plane.hex?.toUpperCase() || "—";
  const tail =
    plane.country ||
    plane.owner ||
    plane.aircraft_type ||
    plane.variantLabel ||
    plane.src ||
    "";
  return tail ? `${lead} • ${tail}` : lead;
}

function nextFlightsPollDelayMs(health) {
  const serverPollMs = Number(health?.poll_interval_seconds || 0) * 1000;
  if (!Number.isFinite(serverPollMs) || serverPollMs <= 0) return 20_000;
  return Math.max(
    MIN_POLL_MS,
    Math.min(MAX_POLL_MS, Math.round(serverPollMs / 4)),
  );
}

function photoLinkLabel(link) {
  if (!link || link === "#") return "Ouvrir la source";
  if (link.includes("planespotters.net")) return "Ouvrir Planespotters";
  if (link.includes("airport-data.com")) return "Ouvrir Airport-Data";
  return "Ouvrir la source";
}

function setSettingsStatus(message = "", tone = "") {
  const node = $("settings-status");
  if (!node) return;
  node.textContent = message;
  node.dataset.tone = tone;
}

function openSettingsModalShell() {
  $("settings-modal")?.classList.add("visible");
  $("settings-modal")?.setAttribute("aria-hidden", "false");
}

function closeSettingsModalShell() {
  $("settings-modal")?.classList.remove("visible");
  $("settings-modal")?.setAttribute("aria-hidden", "true");
  setSettingsStatus("");
}

function weatherSpan(world) {
  const altitude = world.pointOfView().altitude;
  if (altitude < 0.55) return 18;
  if (altitude < 0.95) return 30;
  if (altitude < 1.45) return 42;
  return 56;
}

function weatherOverlayKeyFor(world) {
  const pov = world.pointOfView();
  return [
    Math.round(pov.lat / 6),
    Math.round(pov.lng / 6),
    Math.round(pov.altitude * 10),
  ].join(":");
}

function styleWeatherNode(point) {
  const container = document.createElement("div");
  container.className = "wx-node";
  const cloud = Math.round(point.cloud_cover ?? 0);
  const temperature =
    point.temperature != null ? `${Math.round(point.temperature)}°` : "—";
  const wind = point.wind_direction ?? 0;
  container.innerHTML = `
        <span class="wx-node__arrow" style="transform: rotate(${wind}deg)">↑</span>
        <span class="wx-node__meta">${temperature} · ${cloud}%</span>
    `;
  container.style.opacity = `${0.44 + Math.min(cloud / 180, 0.42)}`;
  return container;
}

function styleSceneNode(point) {
  if (point?.kind !== "airport") return styleWeatherNode(point);

  const variant = point.visualVariant || "full";
  const button = document.createElement("button");
  button.type = "button";
  button.className = `airport-node airport-node--${variant}${point.active ? " is-active" : ""}`;
  button.setAttribute(
    "aria-label",
    [point.code, point.name, point.city, point.countryName || point.country]
      .filter(Boolean)
      .join(" · "),
  );
  button.title = [point.code, point.name].filter(Boolean).join(" · ");
  const codeLabel =
    variant === "far" && !point.active
      ? ""
      : `<span class="airport-node__code">${point.code || ""}</span>`;
  button.innerHTML = `
    <span class="airport-node__pin" aria-hidden="true"></span>
    ${codeLabel}
  `;
  const stop = (event) => {
    event.preventDefault();
    event.stopPropagation();
  };
  button.addEventListener("pointerdown", stop);
  button.addEventListener("click", (event) => {
    stop(event);
    void point.onSelect?.();
  });
  return button;
}

function classifyVariant(plane) {
  const variantId = classifyAircraftVariant(plane);
  return VARIANT_MAP.get(variantId) || VARIANTS[2];
}

function shapeIndexForPlane(plane, variant) {
  let h = 0;
  const hex = plane.hex || "";
  for (let i = 0; i < hex.length; i += 1)
    h = (h * 31 + hex.charCodeAt(i)) >>> 0;
  return h % variant.shapes.length;
}

function buildFlatPlaneGeometry(variantId) {
  // Clean FR24-style flat airplane silhouette
  let s = 1.0;
  if (variantId === "jet") s = 1.2;
  if (variantId === "heavy") s = 1.5;
  if (variantId === "light") s = 1.05;
  if (variantId === "regional") s = 1.0;

  const shape = new THREE.Shape();
  // Nose
  shape.moveTo(0, 2.0 * s);
  // Right fuselage to wing
  shape.lineTo(0.15 * s, 1.4 * s);
  shape.lineTo(0.15 * s, 0.5 * s);
  // Right wing
  shape.lineTo(1.5 * s, 0.1 * s);
  shape.lineTo(1.5 * s, -0.15 * s);
  shape.lineTo(0.15 * s, -0.05 * s);
  // Body to tail
  shape.lineTo(0.12 * s, -1.1 * s);
  // Right stabilizer
  shape.lineTo(0.65 * s, -1.5 * s);
  shape.lineTo(0.65 * s, -1.7 * s);
  shape.lineTo(0.1 * s, -1.35 * s);
  // Tail tip
  shape.lineTo(0.06 * s, -1.9 * s);
  shape.lineTo(0, -2.0 * s);
  // Mirror left side
  shape.lineTo(-0.06 * s, -1.9 * s);
  shape.lineTo(-0.1 * s, -1.35 * s);
  shape.lineTo(-0.65 * s, -1.7 * s);
  shape.lineTo(-0.65 * s, -1.5 * s);
  shape.lineTo(-0.12 * s, -1.1 * s);
  shape.lineTo(-0.15 * s, -0.05 * s);
  shape.lineTo(-1.5 * s, -0.15 * s);
  shape.lineTo(-1.5 * s, 0.1 * s);
  shape.lineTo(-0.15 * s, 0.5 * s);
  shape.lineTo(-0.15 * s, 1.4 * s);
  shape.closePath();

  const geometry = new THREE.ShapeGeometry(shape).toNonIndexed();
  geometry.rotateX(Math.PI / 2);
  geometry.rotateY(Math.PI);
  geometry.scale(0.28, 0.28, 0.28);
  geometry.computeVertexNormals();
  return geometry;
}

function basePlaneScale(world) {
  const altitude = world.pointOfView().altitude;
  if (altitude < 0.55) return 0.44;
  if (altitude < 0.95) return 0.82;
  if (altitude < 1.45) return 1.18;
  return 1.6;
}

function isPlaneFacingCamera(camera, plane) {
  surfaceVector.set(plane.wx, plane.wy, plane.wz).normalize();
  targetVector.copy(camera.position).normalize();
  return surfaceVector.dot(targetVector) > 0.05;
}

function predictionLeadSeconds(plane, nowMs) {
  const sincePayload = Math.max(0, (nowMs - plane.receivedAt) / 1000);
  if (
    plane.on_ground ||
    plane.gs == null ||
    plane.gs < 15 ||
    plane.trk == null
  ) {
    return 0;
  }

  const contactAge = plane.last_contact
    ? Math.max(0, Date.now() / 1000 - plane.last_contact)
    : 0;
  let damping = 1;
  if (contactAge >= STALE_PREDICTION_HARD_LIMIT_S) damping = 0.2;
  else if (contactAge >= STALE_PREDICTION_SOFT_LIMIT_S) damping = 0.55;

  return Math.min(sincePayload, PLANE_PREDICTION_LIMIT_S) * damping;
}

function updatePlanePose(world, plane, nowMs) {
  const elapsed = predictionLeadSeconds(plane, nowMs);
  let lat = plane.lat;
  let lng = plane.lng;

  if (plane.gs != null && plane.gs > 10 && plane.trk != null) {
    const headingRad = (plane.trk * Math.PI) / 180;
    const distanceM = plane.gs * 0.514444 * elapsed;
    const cosLat = Math.max(0.05, Math.cos((plane.lat * Math.PI) / 180));
    lat += (distanceM * Math.cos(headingRad)) / 111_320;
    lng += (distanceM * Math.sin(headingRad)) / (111_320 * cosLat);
  }

  plane.cLat = lat;
  plane.cLng = lng;
  plane.renderAlt = realAltitude(plane.alt || 0);

  const coords = world.getCoords(lat, lng, plane.renderAlt);
  plane.wx = coords.x;
  plane.wy = coords.y;
  plane.wz = coords.z;

  if (plane.trk != null) {
    const headingRad = (plane.trk * Math.PI) / 180;
    const nextLat = lat + Math.cos(headingRad) * 0.14;
    const nextLng =
      lng +
      (Math.sin(headingRad) / Math.max(0.05, Math.cos((lat * Math.PI) / 180))) *
        0.14;
    const ahead = world.getCoords(nextLat, nextLng, plane.renderAlt);
    targetVector.set(ahead.x, ahead.y, ahead.z);
  } else {
    targetVector.set(coords.x, coords.y, coords.z).multiplyScalar(1.0015);
  }

  surfaceVector.set(coords.x, coords.y, coords.z);
  upVector.copy(surfaceVector).normalize();
  lookMatrix.lookAt(surfaceVector, targetVector, upVector);
  workingQuat.setFromRotationMatrix(lookMatrix);
  workingQuat.multiply(axisOffset);
  plane.qx = workingQuat.x;
  plane.qy = workingQuat.y;
  plane.qz = workingQuat.z;
  plane.qw = workingQuat.w;
}

function updatePopup(plane) {
  if (!plane) {
    activePhotoRequestKey = "";
    activeTrajectoryRequestHex = "";
    selectedWeatherState = {
      hex: "",
      lat: null,
      lng: null,
      fetchedAt: 0,
      pending: false,
    };
    selectedPhotoState = { hex: "", registration: "", pending: false };
    selectedTrajectoryState = { hex: "", pending: false };
    if (photoAbort) photoAbort.abort();
    if (trajectoryAbort) trajectoryAbort.abort();
    $("popup")?.classList.remove("visible");
    document.body.classList.remove("popup-open");
    setWeatherState(
      "Cliquez sur un avion pour afficher la météo locale.",
      false,
      false,
    );
    if ($("photo-card")) $("photo-card").hidden = true;
    setSearchFeedback();
    return;
  }

  setTextIfPresent("p-title", plane.flight || plane.hex.toUpperCase());
  setTextIfPresent("p-sub", plane.hex.toUpperCase());

  const badges = $("p-badges");
  if (!badges) return;
  badges.innerHTML = "";
  badges.appendChild(
    buildBadge(
      (plane.src || "OpenSky").includes("OpenSky") ? "OpenSky" : plane.src,
    ),
  );
  if (plane.variantLabel) badges.appendChild(buildBadge(plane.variantLabel));
  if (plane.position_source)
    badges.appendChild(buildBadge(plane.position_source));
  if (plane.operator_code) badges.appendChild(buildBadge(plane.operator_code));
  if (plane.spi) badges.appendChild(buildBadge("SPI actif", true));

  const metadataPending =
    selectedPhotoState.pending && selectedPhotoState.hex === plane.hex;
  setPopupField("registration", plane.registration, {
    loading: metadataPending && !plane.registration,
  });
  setPopupField("manufacturer", plane.manufacturer, {
    loading: metadataPending && !plane.manufacturer,
  });
  setPopupField(
    "aircraft-model",
    plane.aircraft_model || plane.aircraft_description,
    {
      loading:
        metadataPending && !(plane.aircraft_model || plane.aircraft_description),
    },
  );
  setPopupField("aircraft-type", plane.aircraft_type, {
    loading: metadataPending && !plane.aircraft_type,
  });
  setPopupField("operator", plane.owner, {
    loading: metadataPending && !plane.owner,
  });
  setPopupField("country", plane.country, {
    loading: metadataPending && !plane.country,
  });
  setPopupField("last-contact", relativeTime(plane.last_contact));
  setPopupField(
    "altitude",
    plane.on_ground
      ? "Au sol"
      : plane.alt_baro != null
        ? `${plane.alt_baro.toLocaleString("fr-FR")} ft <span class="subtle">(${(plane.alt || 0).toLocaleString("fr-FR")} m)</span>`
        : `${(plane.alt || 0).toLocaleString("fr-FR")} m`,
    { html: true },
  );
  setPopupField(
    "ground-speed",
    plane.gs != null
      ? `${Math.round(plane.gs)} nd <span class="subtle">(${Math.round(plane.gs * 1.852)} km/h)</span>`
      : null,
    { html: true },
  );
  setPopupField("heading", headingLabel(plane.trk));
  setPopupField(
    "vertical-rate",
    plane.baro_rate != null
      ? `${plane.baro_rate > 0 ? "+" : ""}${Math.round(plane.baro_rate)} ft/min`
      : null,
  );
  setPopupField("squawk", plane.squawk);
  setPopupField("position-source", plane.position_source);
  setPopupField(
    "position",
    `${(plane.cLat ?? plane.lat).toFixed(4)}°, ${(plane.cLng ?? plane.lng).toFixed(4)}°`,
  );
  if ($("photo-card")) $("photo-card").hidden = false;
  const trajectoryPill = $("trajectory-pill");
  if (trajectoryPill) {
    const trajectoryPending =
      selectedTrajectoryState.pending &&
      selectedTrajectoryState.hex === plane.hex;
    trajectoryPill.classList.toggle("loading", trajectoryPending);
    const hasRouteFallback = plane.trail?.some((point) => point.kind === "route");
    const hasInference = plane.trail?.some((point) => point.kind === "inferred");
    if (trajectoryPending) {
      trajectoryPill.textContent = "Chargement de la trajectoire détaillée…";
    } else if (plane.route_source === "ADSBDB" && plane.route_origin?.icao_code) {
      trajectoryPill.textContent = `Trajectoire ADSBDB depuis ${plane.route_origin.icao_code}`;
    } else if (hasRouteFallback && plane.route_origin?.icao_code) {
      trajectoryPill.textContent = `Trajectoire prolongée depuis ${plane.route_origin.icao_code}`;
    } else if (hasInference) {
      trajectoryPill.textContent = "Trajectoire en cours d’affinage";
    } else {
      trajectoryPill.textContent = "Trajectoire confirmée sur le globe";
    }
  }

  $("popup")?.classList.add("visible");
  document.body.classList.add("popup-open");
  setSearchFeedback({ plane });
}

function shouldRefreshSelectedWeather(plane, { force = false } = {}) {
  if (!plane) return false;
  if (selectedWeatherState.pending && selectedWeatherState.hex === plane.hex)
    return false;
  if (force) return true;
  if (selectedWeatherState.hex !== plane.hex) return true;

  const lat = plane.cLat ?? plane.lat;
  const lng = plane.cLng ?? plane.lng;
  const movedKm =
    selectedWeatherState.lat == null || selectedWeatherState.lng == null
      ? Infinity
      : haversineKm(
          selectedWeatherState.lat,
          selectedWeatherState.lng,
          lat,
          lng,
        );

  return (
    movedKm >= SELECTED_WEATHER_MOVE_KM ||
    Date.now() - selectedWeatherState.fetchedAt >= SELECTED_WEATHER_REFRESH_MS
  );
}

function shouldRefreshSelectedPhoto(plane, { force = false } = {}) {
  if (!plane) return false;
  if (selectedPhotoState.pending && selectedPhotoState.hex === plane.hex)
    return false;
  if (force) return true;
  return (
    selectedPhotoState.hex !== plane.hex ||
    selectedPhotoState.registration !== plane.registration
  );
}

function refreshSelectedMedia(plane, { force = false } = {}) {
  if (!plane) return;

  if (shouldRefreshSelectedWeather(plane, { force })) {
    const lat = plane.cLat ?? plane.lat;
    const lng = plane.cLng ?? plane.lng;
    selectedWeatherState = {
      hex: plane.hex,
      lat,
      lng,
      fetchedAt: selectedWeatherState.fetchedAt,
      pending: true,
    };
    fetchWeatherForPlane(plane);
  }

  if (shouldRefreshSelectedPhoto(plane, { force })) {
    selectedPhotoState = {
      hex: plane.hex,
      registration: plane.registration || "",
      pending: true,
    };
    updatePopup(plane);
    fetchPhotoForPlane(plane);
  }
}

function getPlaneByHex(hex) {
  return hex ? planeMap.get(hex) || null : null;
}

function applyPlanePresentation(plane, receivedAt) {
  const variant = classifyVariant(plane);
  plane.variantId = variant.id;
  plane.variantLabel = variant.label;
  plane.variantScale = variant.scale;
  plane.variantShapeIndex = shapeIndexForPlane(plane, variant);
  plane.receivedAt = receivedAt;
  plane.cLat = plane.lat;
  plane.cLng = plane.lng;
  plane.trail = plane.trail || [];
}

function syncFlights(payload, receivedAt) {
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

  for (const hex of planeMap.keys()) {
    if (!nextHexes.has(hex)) planeMap.delete(hex);
  }

  planeArr = nextPlaneArr;
  flightsLoaded = true;
  planeDataVersion += 1;
}

function focusPlane(
  world,
  camera,
  plane,
  detailProfile = DETAIL_TIERS[DETAIL_TIERS.length - 1],
) {
  if (!plane) return;
  selectedHex = plane.hex;
  updatePopup(plane);
  refreshSelectedMedia(plane, { force: true });
  world.pointOfView(
    {
      lat: plane.cLat ?? plane.lat,
      lng: plane.cLng ?? plane.lng,
      altitude: SELECTION_ALTITUDE,
    },
    1100,
  );
  derivedVisualsDirty = true;
  rebuildDerivedVisuals(world, camera, detailProfile);
}

function scheduleWeatherOverlay(world) {
  clearTimeout(weatherOverlayTimer);
  weatherOverlayTimer = setTimeout(() => fetchWeatherOverlay(world), 850);
}

async function fetchWeatherOverlay(world) {
  const key = weatherOverlayKeyFor(world);
  const now = Date.now();
  if (
    key === weatherOverlayKey &&
    now - lastWeatherOverlayAt < WEATHER_REFRESH_MS
  )
    return;

  weatherOverlayKey = key;
  lastWeatherOverlayAt = now;

  try {
    const pov = world.pointOfView();
    const response = await fetch(
      `${WX_MAP_URL}?lat=${pov.lat.toFixed(2)}&lng=${pov.lng.toFixed(2)}&span=${weatherSpan(world)}`,
    );
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    weatherOverlayPoints = (payload.points || [])
      .filter((point) => point.temperature != null)
      .map((point) => ({
        ...point,
        kind: "weather",
        altitude: 0.0008,
      }));
    syncSceneHtmlOverlay?.();
  } catch (error) {
    console.warn("[Stratus] couche meteo indisponible:", error);
    weatherOverlayPoints = [];
    syncSceneHtmlOverlay?.();
  }
}

async function fetchWeatherForPlane(plane) {
  if (!plane) return;
  if (weatherAbort) weatherAbort.abort();
  weatherAbort = new AbortController();
  setWeatherState("Chargement de la météo locale…", false, true);

  try {
    const response = await fetch(
      `${WX_URL}?lat=${(plane.cLat ?? plane.lat).toFixed(2)}&lng=${(plane.cLng ?? plane.lng).toFixed(2)}`,
      { signal: weatherAbort.signal },
    );
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    const current = payload.current;
    if (!current) throw new Error("Aucune donnée disponible");
    if (selectedHex === plane.hex) {
      selectedWeatherState = {
        hex: plane.hex,
        lat: plane.cLat ?? plane.lat,
        lng: plane.cLng ?? plane.lng,
        fetchedAt: Date.now(),
        pending: false,
      };
    }
    $("wx-temp").textContent = `${Math.round(current.temperature_2m)}°C`;
    $("wx-wind").textContent = `${Math.round(current.wind_speed_10m)} km/h`;
    $("wx-cloud").textContent = `${Math.round(current.cloud_cover)}%`;
    setWeatherState("Météo locale de l’avion.", true, false);
  } catch (error) {
    if (error.name === "AbortError") return;
    if (selectedHex === plane.hex) {
      selectedWeatherState = {
        ...selectedWeatherState,
        pending: false,
      };
    }
    setWeatherState(`Météo indisponible : ${error.message}`, false, false);
  }
}

function setPhotoState({
  status = "Recherche d’une photo liée à l’immatriculation…",
  credit = "Source externe: Planespotters.net",
  link = "#",
  image = null,
  empty = "Miniature en préparation",
  emptyDetail = "",
  emptyGlyph = "✈",
  loading = false,
} = {}) {
  $("photo-card").hidden = false;
  $("p-photo-status").textContent = status;
  $("p-photo-credit").textContent = credit;
  $("p-photo-link").href = link;
  $("p-photo-link").textContent = photoLinkLabel(link);
  $("p-photo-link").hidden = !link || link === "#";
  $("p-photo-status").classList.toggle("loading", loading);
  const resolvedImage = image || (!loading ? GENERIC_AIRCRAFT_IMAGE : null);
  const emptyNode = $("p-photo-empty");
  emptyNode.innerHTML = `
        <span class="media-empty__glyph">${emptyGlyph}</span>
        <span class="media-empty__title">${empty}</span>
        ${emptyDetail ? `<span class="media-empty__detail">${emptyDetail}</span>` : ""}
    `;
  $("p-photo-empty").classList.toggle("loading", loading && !resolvedImage);
  $("p-photo-empty").classList.toggle("rich", !loading && !resolvedImage);
  $("p-photo-img").parentElement?.classList.toggle(
    "placeholder",
    !resolvedImage,
  );

  if (resolvedImage) {
    const img = $("p-photo-img");
    img.onerror = () => {
      if (img.src.endsWith("aircraft-placeholder.svg")) {
        img.onerror = null;
        img.hidden = true;
        img.removeAttribute("src");
        $("p-photo-empty").hidden = false;
        $("p-photo-empty").classList.add("rich");
        img.parentElement?.classList.add("placeholder");
        return;
      }
      img.onerror = null;
      img.src = GENERIC_AIRCRAFT_IMAGE;
    };
    img.src = resolvedImage;
    img.alt = image
      ? "Miniature de l’appareil"
      : "Illustration de remplacement de l’appareil";
    img.hidden = false;
    $("p-photo-empty").hidden = true;
    $("p-photo-empty").classList.remove("rich");
    img.parentElement?.classList.toggle("placeholder", !image);
  } else {
    $("p-photo-img").hidden = true;
    $("p-photo-img").removeAttribute("src");
    $("p-photo-empty").hidden = false;
  }
}

async function fetchPhotoForPlane(plane) {
  if (!plane?.hex) {
    return;
  }

  const requestKey = photoRequestKeyForPlane(plane);
  activePhotoRequestKey = requestKey;
  if (photoAbort) photoAbort.abort();
  photoAbort = new AbortController();
  const searchUrl = plane.registration
    ? `https://www.planespotters.net/photos/reg/${encodeURIComponent(plane.registration)}`
    : "https://openskynetwork.github.io/opensky-api/rest.html";
  setPhotoState({
    status: plane.registration
      ? `Recherche d’une photo pour ${plane.registration} ou un appareil du meme modele…`
      : "Recherche d’une photo de ce modele d’appareil…",
    credit: "Sources externes: ADSBDB, Airport-Data.com et Planespotters.net",
    link: searchUrl,
    image: null,
    empty: "Chargement photo",
    emptyDetail:
      plane.aircraft_description ||
      plane.aircraft_type ||
      "Recherche d’une source visuelle…",
    emptyGlyph: "◌",
    loading: true,
  });

  try {
    const params = new URLSearchParams({ hex: plane.hex });
    if (plane.registration) params.set("registration", plane.registration);
    const response = await fetch(`${PHOTO_URL}?${params.toString()}`, {
      signal: photoAbort.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    if (activePhotoRequestKey !== requestKey) return;
    applyPhotoMetadataToPlane(plane, payload);
    if (selectedHex === plane.hex) {
      selectedPhotoState = {
        hex: plane.hex,
        registration: plane.registration || payload.registration || "",
        pending: false,
      };
      updatePopup(plane);
    }

    if (payload.status === "ok" && payload.thumbnail_url) {
      setPhotoState({
        status:
          payload.match_level === "model"
            ? payload.title || "Photo d’un appareil du meme modele"
            : payload.title ||
              `Photo liée à ${plane.registration || plane.hex.toUpperCase()}`,
        credit: payload.credit || "Image externe liée à l’appareil",
        link: payload.page_url || searchUrl,
        image: payload.thumbnail_url,
        empty: "Photo",
        loading: false,
      });
      return;
    }

    const blocked = payload.status === "blocked";
    setPhotoState({
      status: blocked
        ? "Miniature non récupérable automatiquement, mais la page photo est prête."
        : payload.aircraft_description
          ? `Aucune photo automatique trouvée pour ${payload.aircraft_description} pour le moment.`
          : "Miniature indisponible pour cet avion pour le moment.",
      credit: blocked
        ? "Planespotters protège la miniature avec un défi anti-bot."
        : "Aucune photo exploitable n’a encore été trouvée pour cet appareil ou ce modele.",
      link: payload.page_url || searchUrl,
      image: null,
      empty: blocked ? "Page photo prête" : "Photo indisponible",
      emptyDetail:
        payload.aircraft_description ||
        plane.aircraft_description ||
        plane.aircraft_type ||
        plane.variantLabel ||
        "Aperçu non disponible",
      emptyGlyph: blocked ? "↗" : "✈",
      loading: false,
    });
  } catch (error) {
    if (error.name === "AbortError") return;
    if (selectedHex === plane.hex) {
      selectedPhotoState = {
        ...selectedPhotoState,
        pending: false,
      };
    }
    setPhotoState({
      status: "Photo non chargée automatiquement.",
      credit:
        "Vous pouvez ouvrir directement la fiche photo ou réessayer plus tard.",
      link: searchUrl,
      image: null,
      empty: "Photo indisponible",
      emptyDetail:
        plane.aircraft_description ||
        plane.aircraft_type ||
        plane.variantLabel ||
        "Source temporairement indisponible",
      emptyGlyph: "✈",
      loading: false,
    });
  }
}

function rebuildDerivedVisuals(
  world,
  camera,
  detailProfile = DETAIL_TIERS[DETAIL_TIERS.length - 1],
) {
  if (!flightsLoaded) return;

  const traces = [];
  const selectedPlane = getPlaneByHex(selectedHex);

  if (selectedPlane && selectedPlane.trail && selectedPlane.trail.length >= 1) {
    const trail = samplePolylinePoints(
      normalizeTrailPoints(selectedPlane.trail),
      detailProfile.trailStride,
    );
    const route = [];
    const observed = [];
    const inferred = [];
    for (const point of trail) {
      if (point.kind === "route") {
        route.push(point);
      } else if (point.kind === "observed") {
        observed.push(point);
      } else if (point.kind === "inferred") {
        inferred.push(point);
      }
    }
    const anchorLng = trail.length ? trail[trail.length - 1].lng : selectedPlane.cLng;
    const currentPoint = buildTrailEndpoint(selectedPlane, anchorLng);
    const useAdsbRouteOnly =
      selectedPlane.route_source === "ADSBDB" && route.length > 0;
    const routeAnchor = useAdsbRouteOnly
      ? currentPoint
      : observed.length
        ? toRenderTrailPoint(observed[0])
        : inferred.length
          ? toRenderTrailPoint(inferred[0])
          : currentPoint;

    if (route.length) {
      const routePath = densifyPolyline(route.map(toRenderTrailPoint).concat(routeAnchor));
      if (useAdsbRouteOnly) {
        traces.push({
          points: routePath,
          color: "rgba(4, 8, 14, 0.4)",
          stroke: TRAJECTORY_BASE_STROKE + 1.95,
        });
        traces.push(
          ...buildAltitudeColoredPaths(routePath, {
            stroke: TRAJECTORY_BASE_STROKE + 1.05,
            alpha: 0.9,
            colorChunkSpan: ADSB_ROUTE_COLOR_CHUNK_SPAN,
          }),
        );
      } else {
        traces.push({
          points: routePath,
          color: "rgba(5, 8, 14, 0.22)",
          stroke: TRAJECTORY_BASE_STROKE + 0.4,
        });
        traces.push(
          ...buildAltitudeColoredPaths(routePath, {
            stroke: TRAJECTORY_BASE_STROKE + 0.9,
            alpha: 0.74,
            colorChunkSpan: 5,
          }),
        );
      }
    }

    if (observed.length && !useAdsbRouteOnly) {
      const observedRoute = densifyPolyline(
        observed.map(toRenderTrailPoint).concat(currentPoint),
      );
      traces.push({
        points: observedRoute,
        color: "rgba(5, 8, 14, 0.34)",
        stroke: TRAJECTORY_BASE_STROKE + 1.6,
      });
      traces.push(
        ...buildAltitudeColoredPaths(observedRoute, {
          stroke: SELECTED_TRAIL_STROKE,
          alpha: 0.96,
          colorChunkSpan: TRAIL_COLOR_CHUNK_SPAN,
        }),
      );
    }

    if (inferred.length && !useAdsbRouteOnly) {
      const inferredAnchor = observed.length
        ? toRenderTrailPoint(observed[0])
        : currentPoint;
      const inferredRoute = densifyPolyline(
        inferred.map(toRenderTrailPoint).concat(inferredAnchor),
      );
      traces.push({
        points: inferredRoute,
        color: "rgba(5, 8, 14, 0.24)",
        stroke: TRAJECTORY_BASE_STROKE + 0.8,
      });
      traces.push(
        ...buildAltitudeColoredPaths(inferredRoute, {
          stroke: INFERRED_TRAIL_STROKE,
          alpha: 0.88,
          dashSpan: 8,
          gapSpan: 6,
          colorChunkSpan: INFERRED_TRAIL_COLOR_CHUNK_SPAN,
        }),
      );
    }
  }

  world.pathsData(traces);
  derivedVisualsDirty = false;
}

function pickPlane(camera, hitMesh, event) {
  const bounds = $("globeViz").getBoundingClientRect();
  pointerVector.set(
    ((event.clientX - bounds.left) / bounds.width) * 2 - 1,
    -((event.clientY - bounds.top) / bounds.height) * 2 + 1,
  );
  raycaster.setFromCamera(pointerVector, camera);
  raycaster.far = camera.far;
  const hits = raycaster.intersectObject(hitMesh, false);
  if (hits.length) {
    return pickPlanes[hits[0].instanceId] || null;
  }

  let bestPlane = null;
  let bestDistance = Infinity;
  const px = event.clientX - bounds.left;
  const py = event.clientY - bounds.top;
  for (const plane of pickPlanes) {
    if (!plane.screenVisible) continue;
    const pickRadius = plane.pickRadius ?? POINTER_PICK_RADIUS;
    const maxDistance = pickRadius * pickRadius;
    const dx = plane.screenX - px;
    const dy = plane.screenY - py;
    const distance = dx * dx + dy * dy;
    if (distance < maxDistance && distance < bestDistance) {
      bestDistance = distance;
      bestPlane = plane;
    }
  }
  return bestPlane;
}

function refreshSelectedPopup() {
  const plane = getPlaneByHex(selectedHex);
  if (!plane) {
    selectedHex = null;
    updatePopup(null);
    return;
  }
  updatePopup(plane);
  refreshSelectedMedia(plane);
}

function tickFps(now) {
  tickFps.count += 1;
  if (now - tickFps.last >= 1000) {
    $("fps").textContent = String(tickFps.count);
    tickFps.count = 0;
    tickFps.last = now;
  }
}
tickFps.count = 0;
tickFps.last = performance.now();

function createVariantLayers(parent, capacity) {
  const layers = new Map();
  for (const variant of VARIANTS) {
    for (let si = 0; si < variant.shapes.length; si += 1) {
      const mesh = new THREE.InstancedMesh(
        buildFlatPlaneGeometry(variant.id),
        new THREE.MeshBasicMaterial({
          color: 0xffffff,
          transparent: true,
          opacity: 1.0,
          side: THREE.DoubleSide,
          depthWrite: false,
          depthTest: true,
          toneMapped: false,
        }),
        capacity,
      );
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.instanceColor = new THREE.InstancedBufferAttribute(
        new Float32Array(capacity * 3),
        3,
      );
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.renderOrder = 20;
      parent.add(mesh);
      layers.set(`${variant.id}-${si}`, { variant, mesh, count: 0 });
    }
  }
  return layers;
}

function createHitMesh(capacity) {
  const hitMesh = new THREE.InstancedMesh(
    new THREE.SphereGeometry(0.48, 6, 6),
    new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0,
      depthWrite: false,
      depthTest: true,
    }),
    capacity,
  );
  hitMesh.material.colorWrite = false;
  hitMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  hitMesh.count = 0;
  hitMesh.frustumCulled = false;
  return hitMesh;
}

function createZonePointsMesh(color, size) {
  const mesh = new THREE.Points(
    new THREE.BufferGeometry(),
    new THREE.PointsMaterial({
      color,
      size,
      transparent: true,
      opacity: 0.52,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      sizeAttenuation: true,
    }),
  );
  mesh.frustumCulled = false;
  mesh.visible = false;
  return mesh;
}

function updateZonePointsMesh(mesh, world, points, altitude) {
  if (!mesh) return;
  if (!Array.isArray(points) || points.length === 0) {
    mesh.visible = false;
    return;
  }
  const positions = new Float32Array(points.length * 3);
  for (let i = 0; i < points.length; i += 1) {
    const point = points[i];
    const coords = world.getCoords(point.lat, point.lng, altitude);
    const baseIndex = i * 3;
    positions[baseIndex] = coords.x;
    positions[baseIndex + 1] = coords.y;
    positions[baseIndex + 2] = coords.z;
  }
  if (mesh.geometry && !mesh.geometry.isBufferGeometry && mesh.geometry.dispose) {
    mesh.geometry.dispose();
  }
  if (!mesh.geometry || !mesh.geometry.isBufferGeometry) {
    mesh.geometry = new THREE.BufferGeometry();
  }
  const positionAttr = mesh.geometry.getAttribute("position");
  if (
    positionAttr &&
    positionAttr.array instanceof Float32Array &&
    positionAttr.array.length === positions.length
  ) {
    positionAttr.array.set(positions);
    positionAttr.needsUpdate = true;
  } else {
    mesh.geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  }
  mesh.visible = true;
}

function disposeVariantLayers(parent, layers) {
  if (!layers) return;
  for (const layer of layers.values()) {
    parent.remove(layer.mesh);
    layer.mesh.geometry.dispose();
    layer.mesh.material.dispose();
  }
}

async function main() {
  perfDebugEnabled = new URLSearchParams(window.location.search).has("perf");
  setPerfDebugEnabled(perfDebugEnabled);

  const globeVizEl = $("globeViz");
  const world = GlobeFactory()(globeVizEl)
    .globeImageUrl("/assets/earth-blue-marble.jpg")
    .bumpImageUrl("/assets/earth-topology.png")
    .showAtmosphere(true)
    .atmosphereColor("#6cc5ff")
    .atmosphereAltitude(0.095)
    .pointOfView(BOOT_CAMERA_START)
    .pathTransitionDuration(0)
    .pathsData([])
    .pathPoints((path) => path.points)
    .pathPointLat((point) => point.lat)
    .pathPointLng((point) => point.lng)
    .pathPointAlt((point) => point.alt)
    .pathColor((path) => path.color)
    .pathStroke((path) => path.stroke)
    .pathResolution(4)
    .pointsData([])
    .pointLat((point) => point.lat)
    .pointLng((point) => point.lng)
    .pointAltitude((point) => point.altitude || 0.0022)
    .pointRadius((point) => point.radius || 0.22)
    .pointColor((point) => point.color || "rgba(121, 240, 223, 0.92)")
    .pointsMerge(false)
    .ringsData([])
    .ringLat((point) => point.lat)
    .ringLng((point) => point.lng)
    .ringMaxRadius((point) => point.maxRadius || 8.5)
    .ringPropagationSpeed((point) => point.speed || 1.55)
    .ringRepeatPeriod((point) => point.period || 780)
    .ringColor((point) =>
      point.color || ["rgba(255, 191, 102, 0.92)", "rgba(255, 191, 102, 0)"],
    )
    .htmlElementsData([])
    .htmlLat((point) => point.lat)
    .htmlLng((point) => point.lng)
    .htmlAltitude((point) => point.altitude ?? 0.0008)
    .htmlElement((point) => styleSceneNode(point))
    .htmlTransitionDuration(0);

  const scene = world.scene();
  const camera = world.camera();
  const renderer = world.renderer();
  const controls = world.controls();
  const globeGroup = scene;
  const frameBudgetState = {
    avgFrameMs: 16.6,
    qualityPenalty: 0,
    lastAdjustAt: 0,
  };
  const detailState = {
    baseIndex: DETAIL_TIERS.length - 1,
    effectiveIndex: DETAIL_TIERS.length - 1,
    profile: DETAIL_TIERS[DETAIL_TIERS.length - 1],
  };
  const viewportState = {
    width: globeVizEl.clientWidth || window.innerWidth,
    height: globeVizEl.clientHeight || window.innerHeight,
  };
  const sceneState = {
    lastInstanceUpdateAt: 0,
    lastOverlaySyncAt: 0,
    lastFrameAt: performance.now(),
    cameraKey: "",
    overlayKey: "",
    instanceDataVersion: -1,
    interactionVersion: -1,
    renderMetricsKey: "",
    renderMetricsCache: new Map(),
    renderToken: 0,
    overlayDirty: true,
    instanceDirty: true,
    cameraDirty: true,
    perfDirty: true,
    hoverDirty: true,
  };
  const perfStats = {
    renderedPlanes: 0,
    visibleAirports: 0,
    visibleWeather: 0,
    pickablePlanes: 0,
  };
  const airportOverlayCache = new Map();
  const projectedOverlayVector = new THREE.Vector3();
  const overlayWorldVector = new THREE.Vector3();

  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.08;

  controls.enablePan = false;
  controls.minDistance = 105;
  controls.maxDistance = 420;
  controls.rotateSpeed = 0.68;
  controls.zoomSpeed = 0.9;
  controls.addEventListener("change", () => {
    derivedVisualsDirty = true;
    sceneState.overlayDirty = true;
    sceneState.instanceDirty = true;
    sceneState.cameraDirty = true;
    sceneState.hoverDirty = true;
    scheduleWeatherOverlay(world);
  });

  const bootSequence = createBootSequence(world, controls);
  bootSequence.applyLoadState(deriveLoadState(lastHealth));

  function activeDetailProfile() {
    return detailState.profile;
  }

  function updatePerfPanel() {
    const panel = $("perf-debug");
    if (!panel) return;
    panel.hidden = !perfDebugEnabled;
    if (!perfDebugEnabled) return;
    $("perf-tier").textContent = detailState.profile.id;
    $("perf-planes").textContent = perfStats.renderedPlanes.toLocaleString("fr-FR");
    $("perf-airports").textContent = perfStats.visibleAirports.toLocaleString("fr-FR");
    $("perf-weather").textContent = perfStats.visibleWeather.toLocaleString("fr-FR");
    $("perf-frame-ms").textContent = frameBudgetState.avgFrameMs.toFixed(1);
    $("perf-quality").textContent = String(frameBudgetState.qualityPenalty);
  }

  function captureCameraKey() {
    const pov = world.pointOfView();
    return [
      pov.lat.toFixed(2),
      pov.lng.toFixed(2),
      pov.altitude.toFixed(3),
      camera.position.x.toFixed(2),
      camera.position.y.toFixed(2),
      camera.position.z.toFixed(2),
    ].join(":");
  }

  function syncDetailProfile(now) {
    const baseIndex = detailTierIndexForAltitude(world.pointOfView().altitude);
    const effectiveIndex = baseIndex;
    if (
      detailState.baseIndex === baseIndex &&
      detailState.effectiveIndex === effectiveIndex &&
      !sceneState.perfDirty
    ) {
      return detailState.profile;
    }

    detailState.baseIndex = baseIndex;
    detailState.effectiveIndex = effectiveIndex;
    detailState.profile = detailTierByIndex(effectiveIndex);
    world.pathResolution(detailState.profile.pathResolution);
    derivedVisualsDirty = true;
    sceneState.overlayDirty = true;
    sceneState.instanceDirty = true;
    sceneState.hoverDirty = true;
    sceneState.perfDirty = false;
    updatePerfPanel();
    return detailState.profile;
  }

  function projectOverlay(lat, lng, altitude) {
    const coords = world.getCoords(lat, lng, altitude);
    overlayWorldVector.set(coords.x, coords.y, coords.z);
    if (!frustum.containsPoint(overlayWorldVector)) return null;
    projectedOverlayVector.copy(overlayWorldVector).project(camera);
    if (projectedOverlayVector.z < -1 || projectedOverlayVector.z > 1) return null;
    const screenX = (projectedOverlayVector.x + 1) * 0.5 * viewportState.width;
    const screenY = (1 - projectedOverlayVector.y) * 0.5 * viewportState.height;
    if (
      screenX < -28 ||
      screenX > viewportState.width + 28 ||
      screenY < -28 ||
      screenY > viewportState.height + 28
    ) {
      return null;
    }
    return { screenX, screenY };
  }

  function keepSpacedOverlayPoints(points, minGap) {
    const kept = [];
    const minGapSq = minGap * minGap;
    for (const point of points) {
      const collides = kept.some((candidate) => {
        const dx = candidate.screenX - point.screenX;
        const dy = candidate.screenY - point.screenY;
        return dx * dx + dy * dy < minGapSq;
      });
      if (!collides) kept.push(point);
    }
    return kept;
  }

  async function fetchTrajectoryForPlane(plane) {
    if (!plane?.hex) return;

    activeTrajectoryRequestHex = plane.hex;
    selectedTrajectoryState = {
      hex: plane.hex,
      pending: true,
    };
    if (trajectoryAbort) trajectoryAbort.abort();
    trajectoryAbort = new AbortController();
    refreshSelectedPopup();

    try {
      const params = new URLSearchParams({ hex: plane.hex });
      if (plane.flight) params.set("flight", plane.flight);
      const response = await fetch(`${TRAJECTORY_URL}?${params.toString()}`, {
        signal: trajectoryAbort.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      if (
        activeTrajectoryRequestHex !== payload.hex ||
        selectedHex !== payload.hex
      ) {
        return;
      }

      const selectedPlane = getPlaneByHex(payload.hex);
      if (!selectedPlane) return;
      selectedTrajectoryState = {
        hex: payload.hex,
        pending: false,
      };
      applyPhotoMetadataToPlane(selectedPlane, payload);
      selectedPlane.trail = payload.trail || [];
      selectedPlane.route_origin = payload.route_origin || null;
      selectedPlane.route_destination = payload.route_destination || null;
      selectedPlane.route_source = payload.route_source || null;
      refreshSelectedPopup();
      derivedVisualsDirty = true;
      rebuildDerivedVisuals(world, camera, activeDetailProfile());
    } catch (error) {
      if (error.name === "AbortError") return;
      selectedTrajectoryState = {
        hex: plane.hex,
        pending: false,
      };
      console.warn("[Stratus] trajectoire détaillée indisponible:", error);
      refreshSelectedPopup();
    }
  }

  function focusPlaneWithTrajectory(plane) {
    focusPlane(world, camera, plane, activeDetailProfile());
    bumpSceneInteractionVersion();
    sceneState.instanceDirty = true;
    sceneState.hoverDirty = true;
    fetchTrajectoryForPlane(plane);
  }

  focusSearchSelection = focusPlaneWithTrajectory;

  scene.add(new THREE.AmbientLight(0xffffff, 2.0));
  scene.add(new THREE.HemisphereLight(0xcbe5ff, 0x183742, 1.7));

  const keyLight = new THREE.DirectionalLight(0xffffff, 2.25);
  keyLight.position.set(5, 4, 3);
  scene.add(keyLight);

  const fillLight = new THREE.DirectionalLight(0x8ad9ff, 1.0);
  fillLight.position.set(-4, 0, -5);
  scene.add(fillLight);

  const rimLight = new THREE.DirectionalLight(0xffd38f, 0.8);
  rimLight.position.set(-2, 4, 5);
  scene.add(rimLight);

  let renderPlaneCapacity = INITIAL_PLANE_CAPACITY;
  let variantLayers = createVariantLayers(globeGroup, renderPlaneCapacity);
  let hitMesh = createHitMesh(renderPlaneCapacity);
  globeGroup.add(hitMesh);
  const zonePendingMesh = createZonePointsMesh(0xff8ad6, 0.18);
  const zoneLoadingMesh = createZonePointsMesh(0x71e9ff, 0.22);
  globeGroup.add(zonePendingMesh);
  globeGroup.add(zoneLoadingMesh);
  let radioFeedIndex = 0;
  let radioFeed = liveAtcFeeds.length > 0 ? liveAtcFeeds[0] : null;
  let radioEnabled = false;

  function setRadioEnabled(enabled, message = "") {
    radioEnabled = !!enabled;
    $("radio-widget")?.classList.toggle("radio-disabled", !radioEnabled);
    $("radio-open-airports")?.toggleAttribute("disabled", !radioEnabled);
    $("radio-play")?.toggleAttribute("disabled", !radioEnabled);
    if (!radioEnabled) {
      $("radio-airport-code").textContent = "OFF";
      $("radio-airport-name").textContent = "Répertoire ATC indisponible";
      const feedTitle = $("radio-feed-title");
      if (feedTitle) feedTitle.textContent = "Ajoutez des .pls dans le dossier ATC";
    }
    if (message) setRadioStatus(message);
  }

  function focusRadioAirport(feed) {
    if (!feed || !hasRenderableAirportPosition(feed)) return;
    world.pointOfView(
      {
        lat: feed.lat,
        lng: feed.lng,
        altitude: 1.02,
      },
      1050,
    );
  }

  function syncSceneHtmlOverlays() {
    const profile = activeDetailProfile();
    const pov = world.pointOfView();
    projectionMatrix.multiplyMatrices(
      camera.projectionMatrix,
      camera.matrixWorldInverse,
    );
    frustum.setFromProjectionMatrix(projectionMatrix);
    const airportMarkers = [];
    airportOverlayCache.clear();
    if (radioEnabled && radioFeed && hasRenderableAirportPosition(radioFeed)) {
      const projection = projectOverlay(
        radioFeed.lat,
        radioFeed.lng,
        RADIO_AIRPORT_ACTIVE_ALTITUDE,
      );
      if (projection) {
        const marker = {
          kind: "airport",
          code: radioFeed.icao,
          lat: radioFeed.lat,
          lng: radioFeed.lng,
          altitude: RADIO_AIRPORT_ACTIVE_ALTITUDE,
          active: true,
          name: radioFeed.name,
          city: radioFeed.city,
          country: radioFeed.country,
          countryName: radioFeed.countryName,
          visualVariant: "full",
          screenX: projection.screenX,
          screenY: projection.screenY,
          onSelect: () => {
            focusRadioAirport(radioFeed);
            void playRadioAudio({ preserveCurrent: true });
          },
        };
        airportOverlayCache.set(radioFeed.icao, marker);
        airportMarkers.push(marker);
      }
    }

    const weatherMarkers =
      profile.weatherBudget > 0
        ? keepSpacedOverlayPoints(
            weatherOverlayPoints
              .map((point) => {
                const projection = projectOverlay(
                  point.lat,
                  point.lng,
                  point.altitude ?? 0.0008,
                );
                if (!projection) return null;
                return {
                  ...point,
                  priority: angularDistanceDegrees(pov, point),
                  screenX: projection.screenX,
                  screenY: projection.screenY,
                };
              })
              .filter(Boolean)
              .sort((left, right) => left.priority - right.priority)
              .slice(0, profile.weatherBudget * 2),
            profile.weatherMinGap,
          )
            .slice(0, profile.weatherBudget)
            .map(({ screenX, screenY, priority, ...marker }) => marker)
        : [];

    perfStats.visibleAirports = airportMarkers.length;
    perfStats.visibleWeather = weatherMarkers.length;
    updatePerfPanel();
    sceneState.lastOverlaySyncAt = performance.now();
    sceneState.overlayDirty = false;
    world.htmlElementsData([...weatherMarkers, ...airportMarkers]);
  }

  syncSceneHtmlOverlay = () => {
    sceneState.overlayDirty = true;
  };

  function syncRadioAirportPing() {
    syncSceneHtmlOverlays();
    if (!radioEnabled || !liveAtcFeeds.length) {
      world.ringsData([]);
      return;
    }
    const activeRings = [];
    if (radioFeed && hasRenderableAirportPosition(radioFeed)) {
      activeRings.push({
        lat: radioFeed.lat,
        lng: radioFeed.lng,
        maxRadius: 10.8,
        speed: 1.8,
        period: 680,
        color: ["rgba(255, 189, 86, 0.98)", "rgba(255, 189, 86, 0)"],
      });
      activeRings.push({
        lat: radioFeed.lat,
        lng: radioFeed.lng,
        maxRadius: 7.4,
        speed: 1.3,
        period: 540,
        color: ["rgba(123, 224, 255, 0.8)", "rgba(123, 224, 255, 0)"],
      });
    }
    world.ringsData(activeRings);
  }

  function setRadioStatus(text) {
    const node = $("radio-status");
    if (node) node.textContent = text;
  }

  function syncRadioPlayButtonState(isPlaying) {
    const playButton = $("radio-play");
    if (!playButton) return;
    const icon = playButton.querySelector(".btn-icon");
    const label = playButton.querySelector(".btn-label");
    if (icon) icon.textContent = isPlaying ? "⏸" : "▶";
    if (label) label.textContent = isPlaying ? "Pause" : "Lecture";
    playButton.setAttribute("aria-label", isPlaying ? "Pause" : "Lecture");
    playButton.setAttribute("title", isPlaying ? "Pause" : "Lecture");
    playButton.dataset.state = isPlaying ? "pause" : "play";
  }

  function isRadioAirportModalOpen() {
    return $("radio-airport-modal")?.classList.contains("visible");
  }

  function radioAudioUrlForFeed(feed) {
    if (!feed?.icao) return "";
    const params = new URLSearchParams({
      icao: feed.icao,
      v: feed.feedId || feed.icao,
    });
    return `${LIVE_ATC_AUDIO_URL}?${params.toString()}`;
  }

  async function playRadioAudio({ preserveCurrent = false } = {}) {
    const audio = $("radio-audio");
    if (!audio || !radioFeed) return;
    const desiredSource = radioAudioUrlForFeed(radioFeed);
    if (!desiredSource) return;
    if (!preserveCurrent || audio.src !== desiredSource) {
      audio.src = desiredSource;
      audio.load();
    }
    try {
      await audio.play();
    } catch (error) {
      setRadioStatus("Flux prêt. Appuyez sur Lecture si le navigateur demande une confirmation.");
    }
  }

  function getRadioFeedIcon(feed) {
    switch (feed?.serviceTone) {
      case "tower":
        return `
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M9 21h6M10 21v-4l-2-7h8l-2 7v4M10 10V6l2-3 2 3v4" />
          </svg>
        `;
      case "ground":
        return `
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M4 8h7l2 2h7M4 16h7l2-2h7M10 8v8M14 10v4" />
          </svg>
        `;
      case "delivery":
        return `
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M8 4h8l3 3v11a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z" />
            <path d="M14 4v4h4M9 12h6M9 16h4" />
          </svg>
        `;
      case "approach":
        return `
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M5 7h10M15 7l-3-3M15 7l-3 3M19 11l-7 7M12 18v-4M12 18h4" />
          </svg>
        `;
      case "radar":
        return `
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M12 4a8 8 0 1 1-8 8M12 8a4 4 0 1 1-4 4M12 12l5-5" />
          </svg>
        `;
      case "atis":
        return `
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M12 17v-5M12 8h.01M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z" />
          </svg>
        `;
      case "ctaf":
        return `
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M12 12h.01M7.5 8.5a6 6 0 0 1 9 0M5 6a10 10 0 0 1 14 0M7.5 15.5a6 6 0 0 0 9 0" />
          </svg>
        `;
      case "mixed":
        return `
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M5 8h6l2 2h6M5 16h6l2-2h6M12 5v14" />
          </svg>
        `;
      default:
        return `
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M12 4l6 8-6 8-6-8 6-8Z" />
          </svg>
        `;
    }
  }

  function getRadioAirportByIcao(icao) {
    return liveAtcAirports.find((airport) => airport.icao === icao) || null;
  }

  function createRadioFeedButton(feed, { emphasized = false } = {}) {
    const button = document.createElement("button");
    button.className = `radio-feed-option${feed.key === radioFeed?.key ? " is-active" : ""}${emphasized ? " is-emphasized" : ""}`;
    button.type = "button";
    button.dataset.feedKey = feed.key;
    button.title = `${feed.label || feed.icao} · ${getRadioFeedLocality(feed) || feed.icao}`;

    const icon = document.createElement("span");
    icon.className = `radio-feed-option__icon tone-${feed.serviceTone || "default"}`;
    icon.setAttribute("aria-hidden", "true");
    icon.innerHTML = getRadioFeedIcon(feed);
    button.appendChild(icon);

    const body = document.createElement("span");
    body.className = "radio-feed-option__body";

    const titleRow = document.createElement("span");
    titleRow.className = "radio-feed-option__title";

    const title = document.createElement("strong");
    title.textContent = feed.label || feed.icao;
    titleRow.appendChild(title);

    const pill = document.createElement("span");
    pill.className = `radio-feed-option__pill tone-${feed.serviceTone || "default"}`;
    pill.textContent = feed.serviceLabel || "ATC";
    titleRow.appendChild(pill);

    if (
      feed.listenerBadge &&
      normalizeSearchText(feed.listenerBadge) !== normalizeSearchText(feed.serviceLabel)
    ) {
      const tag = document.createElement("span");
      tag.className = "radio-feed-option__tag";
      tag.textContent = feed.listenerBadge;
      titleRow.appendChild(tag);
    }

    body.appendChild(titleRow);

    button.appendChild(body);
    return button;
  }

  function createRadioAirportMenu(airport, feeds, { emphasized = false } = {}) {
    const availableFeeds = Array.isArray(feeds) && feeds.length ? feeds : airport?.feeds || [];
    if (!airport || !availableFeeds.length) return null;
    const selectedFeedForAirport =
      radioFeed?.icao === airport.icao
        ? availableFeeds.find((feed) => feed.key === radioFeed?.key) || radioFeed
        : null;

    const section = document.createElement("section");
    section.className = `radio-airport-menu${emphasized ? " is-emphasized" : ""}`;

    const header = document.createElement("div");
    header.className = "radio-airport-menu__head";

    const code = document.createElement("span");
    code.className = "radio-airport-menu__code";
    code.textContent = airport.icao;
    header.appendChild(code);

    const body = document.createElement("div");
    body.className = "radio-airport-menu__body";

    const titleNode = document.createElement("strong");
    titleNode.textContent = airport.name || airport.icao;
    body.appendChild(titleNode);

    const subtitleNode = document.createElement("span");
    const parts = [];
    if (airport.description) {
      parts.push(airport.description);
    } else {
      const locality = getRadioFeedLocality(airport);
      if (locality) parts.push(locality);
    }
    parts.push(`${availableFeeds.length} canaux`);
    if (selectedFeedForAirport?.label) {
      parts.push(`En ecoute: ${selectedFeedForAirport.label}`);
    } else if (availableFeeds[0]?.label) {
      parts.push(`Le plus simple: ${availableFeeds[0].label}`);
    }
    subtitleNode.textContent = parts.join(" · ");
    body.appendChild(subtitleNode);

    header.appendChild(body);

    const count = document.createElement("span");
    count.className = "radio-airport-menu__count";
    count.textContent = `${availableFeeds.length}`;
    header.appendChild(count);

    section.appendChild(header);

    const list = document.createElement("div");
    list.className = "radio-airport-menu__feeds";
    for (const feed of availableFeeds) {
      list.appendChild(createRadioFeedButton(feed, { emphasized }));
    }
    section.appendChild(list);
    return section;
  }

  function appendRadioAirportSection(container, title, subtitle, airports, options = {}) {
    if (!airports.length) return;
    const section = document.createElement("section");
    section.className = "radio-airport-group";

    const header = document.createElement("div");
    header.className = "radio-airport-group__head";

    const titleNode = document.createElement("strong");
    titleNode.textContent = title;
    header.appendChild(titleNode);

    const subtitleNode = document.createElement("span");
    subtitleNode.textContent = subtitle;
    header.appendChild(subtitleNode);

    section.appendChild(header);

    const list = document.createElement("div");
    list.className = "radio-airport-group__list";
    for (const airport of airports) {
      const menu = createRadioAirportMenu(
        airport,
        options.matchingFeeds?.get(airport.icao) || airport.feeds,
        options,
      );
      if (menu) list.appendChild(menu);
    }
    section.appendChild(list);
    container.appendChild(section);
  }

  function renderRadioAirportGuideOverview(container) {
    container.innerHTML = "";
    const fragment = document.createDocumentFragment();

    const intro = document.createElement("section");
    intro.className = "radio-guide-intro";

    const introTitle = document.createElement("div");
    introTitle.className = "radio-guide-intro__title";
    introTitle.textContent = "Ecouter l'ATC, simplement";
    intro.appendChild(introTitle);

    const introCopy = document.createElement("div");
    introCopy.className = "radio-guide-intro__copy";
    introCopy.textContent =
      "Choisissez un aeroport, puis commencez par Tour pour entendre les decollages et atterrissages. Sol sert au roulage, Approche aux arrivees et Radar donne une vue plus large.";
    intro.appendChild(introCopy);

    const setupCopy = document.createElement("div");
    setupCopy.className = "radio-guide-intro__copy";
    setupCopy.innerHTML =
      "Pour ajouter un flux, posez un fichier <code>.pls</code> dans <code>data/atc/&lt;ICAO&gt;/</code>. Pour un nouvel aeroport, ajoutez aussi un petit <code>airport.json</code> dans ce dossier.";
    intro.appendChild(setupCopy);
    fragment.appendChild(intro);

    if (radioFeed) {
      const currentAirport = getRadioAirportByIcao(radioFeed.icao);
      appendRadioAirportSection(
        fragment,
        "En ecoute",
        radioFeed.label || radioFeed.serviceLabel || "ATC",
        currentAirport ? [currentAirport] : [],
        { emphasized: true },
      );
    }

    const availableAirports = liveAtcAirports.filter(
      (airport) => airport.icao !== radioFeed?.icao,
    );
    appendRadioAirportSection(
      fragment,
      "Aeroports disponibles",
      `${availableAirports.length} aeroports locaux`,
      availableAirports,
    );

    container.appendChild(fragment);
  }

  function syncRadioWidget() {
    const sourceNote = $("radio-source-note");
    const openLabel = $("radio-open-label");
    const openHint = $("radio-open-hint");
    const feedTitle = $("radio-feed-title");
    if (!radioFeed) {
      if (openLabel) openLabel.textContent = "Choisir un aeroport";
      if (openHint) openHint.textContent = "Ouvrez la liste pour choisir une ville et un canal facile a suivre.";
      if (feedTitle) feedTitle.textContent = "Choisissez un canal";
      if (sourceNote) sourceNote.textContent = RADIO_AUDIO_SOURCE_LABEL;
      return;
    }
    $("radio-airport-code").textContent = radioFeed.icao;
    const parts = [radioFeed.name];
    const locality = getRadioFeedLocality(radioFeed);
    if (locality) parts.push(locality);
    $("radio-airport-name").textContent = parts.filter(Boolean).join(" · ");
    if (feedTitle) feedTitle.textContent = radioFeed.label || "Canal radio";
    if (openLabel) openLabel.textContent = "Changer d'aeroport";
    if (openHint) {
      const airport = getRadioAirportByIcao(radioFeed.icao);
      openHint.textContent =
        airport?.description ||
        radioFeed.listenerSummary ||
        radioFeed.serviceLabel ||
        "ATC";
    }
    if (sourceNote) sourceNote.textContent = RADIO_AUDIO_SOURCE_LABEL;
  }

  function renderRadioAirportResults(query = "") {
    const container = $("radio-airport-results");
    if (!container) return;
    const normalizedQuery = String(query || "").trim();
    if (!normalizedQuery) {
      renderRadioAirportGuideOverview(container);
      return;
    }
    const matches = filterLiveAtcAirports(query);
    container.innerHTML = "";
    if (!matches.length) {
      const empty = document.createElement("div");
      empty.className = "radio-airport-empty";
      empty.textContent = "Aucun aéroport disponible pour cette recherche.";
      container.appendChild(empty);
      return;
    }

    const fragment = document.createDocumentFragment();
    const section = document.createElement("section");
    section.className = "radio-airport-group";

    const header = document.createElement("div");
    header.className = "radio-airport-group__head";
    const headerTitle = document.createElement("strong");
    headerTitle.textContent = "Resultats";
    const headerCount = document.createElement("span");
    const airportCount = matches.length;
    const feedCount = matches.reduce((count, match) => count + (match.feeds?.length || 0), 0);
    headerCount.textContent = `${airportCount} aeroports · ${feedCount} flux`;
    header.appendChild(headerTitle);
    header.appendChild(headerCount);
    section.appendChild(header);

    const list = document.createElement("div");
    list.className = "radio-airport-group__list";
    for (const match of matches.slice(0, 40)) {
      const menu = createRadioAirportMenu(match.airport, match.feeds);
      if (menu) list.appendChild(menu);
    }
    section.appendChild(list);
    fragment.appendChild(section);
    container.appendChild(fragment);
  }

  function setRadioFeedByIndex(index, { autoplay = false } = {}) {
    if (!liveAtcFeeds.length) return;
    radioFeedIndex =
      ((index % liveAtcFeeds.length) + liveAtcFeeds.length) %
      liveAtcFeeds.length;
    radioFeed = liveAtcFeeds[radioFeedIndex];
    bumpSceneInteractionVersion();
    sceneState.overlayDirty = true;
    const audio = $("radio-audio");
    if (!audio || !radioFeed) return;
    const desiredSource = radioAudioUrlForFeed(radioFeed);
    if (desiredSource && audio.src !== desiredSource) {
      audio.src = desiredSource;
      audio.load();
    }
    syncRadioWidget();
    syncRadioAirportPing();
    if (isRadioAirportModalOpen()) {
      renderRadioAirportResults($("radio-airport-search")?.value || "");
    }
    if (autoplay) void playRadioAudio({ preserveCurrent: true });
  }

  async function loadLiveAtcAirports() {
    const currentFeedKey = radioFeed?.key || "";
    try {
      const response = await fetch(LIVE_ATC_AIRPORTS_URL);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      mergeLiveAtcAirportCatalog(payload.airports || []);
    } catch (error) {
      liveAtcAirports = [];
      liveAtcFeeds = [];
      setRadioEnabled(
        false,
        "Le répertoire ATC est indisponible pour le moment.",
      );
      return;
    }
    if (liveAtcFeeds.length <= 0) {
      radioFeedIndex = 0;
      radioFeed = null;
      setRadioEnabled(
        false,
        "Aucun flux audio ATC disponible actuellement.",
      );
      return;
    }
    const preservedIndex = currentFeedKey
      ? liveAtcFeeds.findIndex((feed) => feed.key === currentFeedKey)
      : -1;
    radioFeedIndex =
      preservedIndex >= 0
        ? preservedIndex
        : Math.max(0, Math.min(radioFeedIndex, liveAtcFeeds.length - 1));
    radioFeed = liveAtcFeeds[radioFeedIndex];
    setRadioEnabled(true);
    setRadioStatus("Pause");
    sceneState.overlayDirty = true;
    syncRadioWidget();
    syncRadioAirportPing();
    if (isRadioAirportModalOpen()) {
      renderRadioAirportResults($("radio-airport-search")?.value || "");
    }
  }

  function ensureRenderCapacity(requiredCount) {
    if (requiredCount <= renderPlaneCapacity) return;
    renderPlaneCapacity = Math.max(
      requiredCount,
      Math.ceil(renderPlaneCapacity * 1.5),
    );
    disposeVariantLayers(globeGroup, variantLayers);
    globeGroup.remove(hitMesh);
    hitMesh.geometry.dispose();
    hitMesh.material.dispose();
    variantLayers = createVariantLayers(globeGroup, renderPlaneCapacity);
    hitMesh = createHitMesh(renderPlaneCapacity);
    globeGroup.add(hitMesh);
    sceneState.instanceDirty = true;
    derivedVisualsDirty = true;
  }

  const tetherGeometry = new THREE.BufferGeometry();
  tetherGeometry.setAttribute(
    "position",
    new THREE.BufferAttribute(new Float32Array(6), 3),
  );
  const tetherLine = new THREE.Line(
    tetherGeometry,
    new THREE.LineBasicMaterial({
      color: 0x79f0df,
      transparent: true,
      opacity: 0.84,
    }),
  );
  tetherLine.visible = false;
  globeGroup.add(tetherLine);

  function updateTether() {
    const plane = getPlaneByHex(selectedHex);
    if (!plane) {
      tetherLine.visible = false;
      return;
    }
    const ground = world.getCoords(plane.cLat, plane.cLng, ALTITUDE_FLOOR);
    const positions = tetherGeometry.attributes.position.array;
    positions[0] = ground.x;
    positions[1] = ground.y;
    positions[2] = ground.z;
    positions[3] = plane.wx;
    positions[4] = plane.wy;
    positions[5] = plane.wz;
    tetherGeometry.attributes.position.needsUpdate = true;
    tetherLine.visible = true;
  }

  function updateInstances(now) {
    const profile = activeDetailProfile();
    const nextCameraKey = captureCameraKey();
    if (nextCameraKey !== sceneState.cameraKey) {
      sceneState.cameraKey = nextCameraKey;
      sceneState.cameraDirty = true;
      sceneState.overlayDirty = true;
      sceneState.hoverDirty = true;
    }

    const needsInstanceUpload =
      sceneState.instanceDirty ||
      sceneState.cameraDirty ||
      sceneState.instanceDataVersion !== planeDataVersion ||
      sceneState.interactionVersion !== sceneInteractionVersion ||
      now - sceneState.lastInstanceUpdateAt >= profile.instanceUpdateMs;
    if (!needsInstanceUpload) return;

    projectionMatrix.multiplyMatrices(
      camera.projectionMatrix,
      camera.matrixWorldInverse,
    );
    frustum.setFromProjectionMatrix(projectionMatrix);

    for (const layer of variantLayers.values()) {
      layer.count = 0;
    }

    const baseScale = basePlaneScale(world);
    const renderMetricsKey = `${profile.id}:${baseScale.toFixed(2)}`;
    if (sceneState.renderMetricsKey !== renderMetricsKey) {
      sceneState.renderMetricsKey = renderMetricsKey;
      sceneState.renderMetricsCache.clear();
    }
    pickPlanes.length = 0;
    let pickCount = 0;
    const count = planeArr.length;
    sceneState.renderToken += 1;
    const renderToken = sceneState.renderToken;
    let renderedPlaneCount = 0;

    const onlySelected = !!selectedHex;
    const visibleCandidates = [];

    const renderPlaneInstance = (plane) => {
      if (!plane.screenVisible) return;

      const layer = variantLayers.get(
        `${plane.variantId}-${plane.variantShapeIndex ?? 0}`,
      );
      if (!layer || layer.count >= renderPlaneCapacity) return;

      const scaleBoost =
        plane.hex === selectedHex ? 1.34 : plane.hex === hoveredHex ? 1.18 : 1;
      const metricsKey = `${plane.variantId}:${plane.variantScale}:${scaleBoost}`;
      let renderMetrics = sceneState.renderMetricsCache.get(metricsKey);
      if (!renderMetrics) {
        renderMetrics = computeVariantRenderMetrics({
          variantId: plane.variantId,
          baseScale,
          variantScale: plane.variantScale,
          scaleBoost,
        });
        sceneState.renderMetricsCache.set(metricsKey, renderMetrics);
      }
      const scale = renderMetrics.renderScale;
      plane.pickRadius = renderMetrics.pickRadius;

      workingQuat.set(plane.qx, plane.qy, plane.qz, plane.qw);
      surfaceVector.set(plane.wx, plane.wy, plane.wz);
      workingScale.setScalar(scale);
      workingMatrix.compose(surfaceVector, workingQuat, workingScale);
      layer.mesh.setMatrixAt(layer.count, workingMatrix);
      layer.mesh.setColorAt(layer.count, getAltitudeColor(plane.alt || 0));
      layer.count += 1;

      workingScale.setScalar(renderMetrics.hitScale);
      workingMatrix.compose(surfaceVector, workingQuat, workingScale);
      hitMesh.setMatrixAt(pickCount, workingMatrix);
      pickPlanes.push(plane);
      pickCount += 1;
      plane.renderToken = renderToken;
      renderedPlaneCount += 1;
    };

    for (let i = 0; i < count; i += 1) {
      const plane = planeArr[i];
      if (onlySelected && plane.hex !== selectedHex) {
        plane.screenVisible = false;
        continue;
      }
      updatePlanePose(world, plane, now);
      surfaceVector.set(plane.wx, plane.wy, plane.wz);
      if (
        !isPlaneFacingCamera(camera, plane) ||
        !frustum.containsPoint(surfaceVector)
      ) {
        plane.screenVisible = false;
        continue;
      }

      screenVector.set(plane.wx, plane.wy, plane.wz).project(camera);
      plane.screenX = (screenVector.x + 1) * 0.5 * viewportState.width;
      plane.screenY = (1 - screenVector.y) * 0.5 * viewportState.height;
      plane.screenVisible = screenVector.z >= -1 && screenVector.z <= 1;
      if (!plane.screenVisible) continue;

      visibleCandidates.push({
        plane,
        screenX: plane.screenX,
        screenY: plane.screenY,
        priority:
          plane.hex === selectedHex || plane.hex === hoveredHex
            ? Number.POSITIVE_INFINITY
            : planeVisibilityPriority(plane),
      });
    }

    const chosenCandidates = visibleCandidates;

    for (const candidate of chosenCandidates) {
      renderPlaneInstance(candidate.plane);
    }

    const forcedHexes = [];
    if (selectedHex) forcedHexes.push(selectedHex);
    if (hoveredHex && hoveredHex !== selectedHex) forcedHexes.push(hoveredHex);
    for (const forcedHex of forcedHexes) {
      const forcedPlane = planeMap.get(forcedHex);
      if (!forcedPlane || forcedPlane.renderToken === renderToken) continue;
      renderPlaneInstance(forcedPlane);
    }

    hitMesh.count = pickCount;
    hitMesh.instanceMatrix.needsUpdate = pickCount > 0;

    for (const layer of variantLayers.values()) {
      layer.mesh.count = layer.count;
      if (layer.count > 0) {
        layer.mesh.instanceMatrix.needsUpdate = true;
        layer.mesh.instanceColor.needsUpdate = true;
      }
    }

    perfStats.renderedPlanes = renderedPlaneCount;
    perfStats.pickablePlanes = pickCount;
    $("count-rendered").textContent = renderedPlaneCount.toLocaleString("fr-FR");
    sceneState.lastInstanceUpdateAt = now;
    sceneState.instanceDataVersion = planeDataVersion;
    sceneState.interactionVersion = sceneInteractionVersion;
    sceneState.instanceDirty = false;
    sceneState.cameraDirty = false;
    sceneState.hoverDirty = !!hoverPointer;
    updatePerfPanel();
  }

  function updateHover(now) {
    if (
      !hoverPointer ||
      !sceneState.hoverDirty ||
      now - lastHoverPickAt < activeDetailProfile().hoverPickMs
    )
      return;
    lastHoverPickAt = now;
    if (!planeArr.length) {
      sceneState.hoverDirty = false;
      return;
    }

    const plane = pickPlane(camera, hitMesh, hoverPointer);
    const tooltip = $("tooltip");
    if (!plane) {
      if (hoveredHex !== null) {
        hoveredHex = null;
        bumpSceneInteractionVersion();
        sceneState.instanceDirty = true;
      }
      tooltip.classList.remove("visible");
      globeVizEl.style.cursor = "grab";
      sceneState.hoverDirty = false;
      return;
    }

    if (hoveredHex !== plane.hex) {
      hoveredHex = plane.hex;
      bumpSceneInteractionVersion();
      sceneState.instanceDirty = true;
    }
    $("tt-name").textContent = plane.flight || plane.hex.toUpperCase();
    $("tt-sub").textContent =
      plane.country || plane.variantLabel || plane.src || "OpenSky Network";
    $("tt-alt").textContent = plane.on_ground
      ? "Au sol"
      : plane.alt_baro != null
        ? `${plane.alt_baro.toLocaleString("fr-FR")} ft`
        : `${(plane.alt || 0).toLocaleString("fr-FR")} m`;
    tooltip.style.left = `${hoverPointer.clientX + 16}px`;
    tooltip.style.top = `${hoverPointer.clientY - 8}px`;
    tooltip.classList.add("visible");
    globeVizEl.style.cursor = "pointer";
    sceneState.hoverDirty = false;
  }

  let lastTrailRebuild = 0;

  function updateLoadState(health) {
    const loadState = $("load-state");
    if (!loadState) return;
    const loadStateInfo = deriveLoadState(health);
    $("scan-label").textContent = loadStateInfo.label;
    $("scan-percent").textContent = loadStateInfo.percentText;
    $("scan-fill").style.width = `${loadStateInfo.fillPercent}%`;
    $("scan-note").textContent = loadStateInfo.note || "";
    loadState.classList.toggle("complete", loadStateInfo.complete);
    loadState.classList.toggle("sweeping", loadStateInfo.sweeping);
    loadState.hidden = loadStateInfo.hidden;
    bootSequence.applyLoadState(loadStateInfo);
    if (loadStateInfo.complete) bootSequence.markReady();
  }

  function updateSourceStatus(payload) {
    const health = payload.health || {};
    lastHealth = health;
    $("src").textContent = (payload.sources || ["OpenSky Network"]).join(" + ");
    $("src-info").textContent = sourceInfoText(health);
    $("coverage-note").textContent =
      payload.coverage_note ||
      "Synchronisation mondiale OpenSky via /states/all avec cache local.";
    $("coverage-note-link").href =
      payload.coverage_note_url ||
      "https://openskynetwork.github.io/opensky-api/rest.html";
    const notice = payload.notice_message || health.user_message;
    $("opensk-notice").hidden = !notice;
    $("opensk-notice-text").textContent = notice || "";
    $("opensk-notice-link").href =
      payload.notice_url || "https://opensky-network.org/my-opensky/account";
    if ($("opensk-settings-open")) {
      $("opensk-settings-open").textContent = health.configured_api_key
        ? "Modifier"
        : "Configurer";
    }
    updateLoadState(health);
    const status = deriveConnectionStatus(health);
    setStatus(status.mode, status.label);
    const pendingZones = (health.zone_pending_points || []).slice(
      0,
      MAX_ZONE_PENDING_POINTS,
    );
    const loadingZones = (health.zone_loading_points || []).slice(
      0,
      MAX_ZONE_LOADING_POINTS,
    );
    const showZoneOverlay =
      (health.scan_phase || "session_revalidation") === "session_revalidation";
    if (!showZoneOverlay) {
      zonePendingMesh.visible = false;
      zoneLoadingMesh.visible = false;
      return;
    }
    updateZonePointsMesh(zonePendingMesh, world, pendingZones, 0.0004);
    updateZonePointsMesh(zoneLoadingMesh, world, loadingZones, 0.0011);
  }

  function buildFlightsUrl() {
    const params = new URLSearchParams();
    if (selectedHex) params.set("selected", selectedHex);
    const query = params.toString();
    return query ? `${API_URL}?${query}` : API_URL;
  }

  async function loadSettingsIntoModal({ focusSecret = false } = {}) {
    setSettingsStatus("Chargement des réglages…");
    openSettingsModalShell();
    try {
      const response = await fetch(SETTINGS_URL);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      $("settings-client-id").value = payload.client_id || "";
      $("settings-client-secret").value = "";
      $("settings-sub").textContent = payload.configured
        ? `Identifiants enregistrés dans ${payload.credential_path || ".env"}. Vous pouvez mettre à jour le client_id ou remplacer le secret.`
        : "Collez votre client_id et votre client_secret OpenSky. Ils seront enregistrés localement dans `.env`.";
      $("settings-help").textContent = payload.configured
        ? "Laissez le secret vide pour conserver celui déjà enregistré."
        : "Aucun identifiant n’est enregistré pour le moment.";
      setSettingsStatus(
        payload.configured
          ? "Identifiants OpenSky détectés."
          : "Aucun identifiant OpenSky enregistré.",
        "",
      );
      const focusTarget = focusSecret
        ? $("settings-client-secret")
        : $("settings-client-id");
      focusTarget?.focus();
    } catch (error) {
      setSettingsStatus(`Réglages indisponibles : ${error.message}`, "error");
    }
  }

  async function saveSettingsFromModal() {
    const clientId = $("settings-client-id")?.value?.trim() || "";
    const clientSecret = $("settings-client-secret")?.value?.trim() || "";
    setSettingsStatus("Enregistrement des identifiants…");
    try {
      const response = await fetch(SETTINGS_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: clientId,
          client_secret: clientSecret,
        }),
      });
      const payload = await response.json();
      if (!response.ok)
        throw new Error(payload.error || `HTTP ${response.status}`);
      setSettingsStatus("Identifiants enregistrés. Actualisation du flux…");
      closeSettingsModalShell();
      clearTimeout(fetchTimer);
      await fetchFlights();
    } catch (error) {
      setSettingsStatus(`Impossible d’enregistrer : ${error.message}`, "error");
    }
  }

  async function clearSettingsFromModal() {
    setSettingsStatus("Suppression des identifiants…");
    try {
      const response = await fetch(SETTINGS_URL, { method: "DELETE" });
      const payload = await response.json();
      if (!response.ok)
        throw new Error(payload.error || `HTTP ${response.status}`);
      $("settings-client-id").value = "";
      $("settings-client-secret").value = "";
      setSettingsStatus("Identifiants supprimés.");
      closeSettingsModalShell();
      clearTimeout(fetchTimer);
      await fetchFlights();
    } catch (error) {
      setSettingsStatus(`Impossible d’effacer : ${error.message}`, "error");
    }
  }

  function animate(now) {
    const frameDelta = Math.min(120, Math.max(8, now - sceneState.lastFrameAt));
    sceneState.lastFrameAt = now;
    frameBudgetState.avgFrameMs = lerp(frameBudgetState.avgFrameMs, frameDelta, 0.12);
    syncDetailProfile(now);
    tickFps(now);
    bootSequence.update(now);
    if (zoneLoadingMesh.visible) {
      const pulse = 0.5 + 0.5 * Math.sin(now * 0.0055);
      zoneLoadingMesh.material.opacity = 0.45 + 0.28 * pulse;
      zoneLoadingMesh.material.size = 0.2 + 0.05 * pulse;
    }
    updateInstances(now);
    updateTether();
    if (
      sceneState.overlayDirty &&
      now - sceneState.lastOverlaySyncAt >= activeDetailProfile().overlaySyncMs
    ) {
      syncSceneHtmlOverlays();
    }
    updateHover(now);
    if (
      selectedHex &&
      now - lastTrailRebuild > activeDetailProfile().trailRebuildMs
    ) {
      derivedVisualsDirty = true;
    }
    if (
      derivedVisualsDirty &&
      (!selectedHex || now - lastTrailRebuild > activeDetailProfile().trailRebuildMs)
    ) {
      rebuildDerivedVisuals(world, camera, activeDetailProfile());
      lastTrailRebuild = now;
    }
    updatePerfPanel();
    requestAnimationFrame(animate);
  }

  async function fetchFlights() {
    setStatus("conn", flightsLoaded ? "Actualisation" : "Chargement");
    try {
      const response = await fetch(buildFlightsUrl(), {
        cache: "no-store",
        headers: {
          "Cache-Control": "no-store",
          Pragma: "no-cache",
        },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      const payloadUpdated = Number(payload.updated) || 0;
      if (payloadUpdated && payloadUpdated < lastAppliedFlightsUpdated) {
        return;
      }
      const now = performance.now();
      syncFlights(payload, now);
      lastAppliedFlightsUpdated = payloadUpdated || lastAppliedFlightsUpdated;
      ensureRenderCapacity(payload.returned || planeArr.length);
      sceneState.instanceDirty = true;
      sceneState.hoverDirty = true;

      $("count-cache").textContent = (payload.count || 0).toLocaleString(
        "fr-FR",
      );
      $("upd").textContent = payload.updated
        ? new Date(payload.updated * 1000).toLocaleTimeString("fr-FR")
        : "—";
      updateSourceStatus(payload);

      if (selectedHex && planeMap.has(selectedHex)) refreshSelectedPopup();
      else if (selectedHex) {
        selectedHex = null;
        bumpSceneInteractionVersion();
        updatePopup(null);
        derivedVisualsDirty = true;
      }

      derivedVisualsDirty = true;
      scheduleWeatherOverlay(world);
    } catch (error) {
      console.warn("[Stratus] erreur de chargement des vols:", error);
      setStatus("err", "Erreur serveur");
      $("src-info").textContent =
        `Dernière réponse indisponible : ${error.message}`;
      updateLoadState(lastHealth);
    } finally {
      clearTimeout(fetchTimer);
      fetchTimer = setTimeout(fetchFlights, nextFlightsPollDelayMs(lastHealth));
    }
  }

  $("globeViz").addEventListener("pointerdown", (event) => {
    pointerDown = { x: event.clientX, y: event.clientY };
  });

  $("globeViz").addEventListener("pointerup", (event) => {
    if (!pointerDown) return;
    const travel = Math.hypot(
      event.clientX - pointerDown.x,
      event.clientY - pointerDown.y,
    );
    pointerDown = null;
    if (travel > 6) return;

    const plane =
      pickPlane(camera, hitMesh, event) || getPlaneByHex(hoveredHex);
    if (!plane) {
      selectedHex = null;
      bumpSceneInteractionVersion();
      sceneState.instanceDirty = true;
      updatePopup(null);
      derivedVisualsDirty = true;
      return;
    }

    focusPlaneWithTrajectory(plane);
  });

  $("globeViz").addEventListener("mousemove", (event) => {
    hoverPointer = event;
    sceneState.hoverDirty = true;
  });

  $("globeViz").addEventListener("mouseleave", () => {
    hoverPointer = null;
    if (hoveredHex !== null) derivedVisualsDirty = true;
    hoveredHex = null;
    bumpSceneInteractionVersion();
    sceneState.instanceDirty = true;
    sceneState.hoverDirty = false;
    $("tooltip").classList.remove("visible");
    $("globeViz").style.cursor = "grab";
  });

  $("p-close").addEventListener("click", () => {
    selectedHex = null;
    bumpSceneInteractionVersion();
    sceneState.instanceDirty = true;
    updatePopup(null);
    derivedVisualsDirty = true;
  });

  $("open-settings")?.addEventListener("click", () => {
    loadSettingsIntoModal();
  });

  $("opensk-settings-open")?.addEventListener("click", () => {
    loadSettingsIntoModal();
  });

  $("close-settings")?.addEventListener("click", () => {
    closeSettingsModalShell();
  });

  $("cancel-settings")?.addEventListener("click", () => {
    closeSettingsModalShell();
  });

  $("save-settings")?.addEventListener("click", () => {
    saveSettingsFromModal();
  });

  $("clear-settings")?.addEventListener("click", () => {
    clearSettingsFromModal();
  });

  $("settings-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    saveSettingsFromModal();
  });

  $("settings-modal")?.addEventListener("click", (event) => {
    if (event.target === $("settings-modal")) {
      closeSettingsModalShell();
    }
  });

  document.addEventListener("keydown", (event) => {
    if (
      event.altKey &&
      event.shiftKey &&
      event.key.toLowerCase() === "d" &&
      !event.repeat
    ) {
      event.preventDefault();
      setPerfDebugEnabled(!perfDebugEnabled);
      updatePerfPanel();
      return;
    }
    if (event.key === "Escape") {
      if ($("settings-modal")?.classList.contains("visible")) {
        closeSettingsModalShell();
        return;
      }
      if ($("radio-airport-modal")?.classList.contains("visible")) {
        $("radio-airport-modal")?.classList.remove("visible");
        $("radio-airport-modal")?.setAttribute("aria-hidden", "true");
        $("radio-open-airports")?.setAttribute("aria-expanded", "false");
        return;
      }
      clearSearch();
    }
  });

  $("search-input").addEventListener("input", () => {
    updateSearchFromInput();
  });

  $("search-input").addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveSearchResultSelection(1);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      moveSearchResultSelection(-1);
      return;
    }
    if (event.key === "Enter" && searchResultState.results.length) {
      event.preventDefault();
      selectSearchResult(
        searchResultState.activeIndex >= 0 ? searchResultState.activeIndex : 0,
      );
    }
  });

  $("search-clear")?.addEventListener("click", () => {
    clearSearch({ keepFocus: true });
  });

  $("search-results")?.addEventListener("click", (event) => {
    const button =
      event.target instanceof Element
        ? event.target.closest(".search-result")
        : null;
    if (!button) return;
    const index = Number(button.dataset.index);
    if (Number.isNaN(index)) return;
    selectSearchResult(index);
  });

  $("radio-open-airports")?.addEventListener("click", () => {
    if (!radioEnabled) return;
    $("radio-airport-modal")?.classList.add("visible");
    $("radio-airport-modal")?.setAttribute("aria-hidden", "false");
    $("radio-open-airports")?.setAttribute("aria-expanded", "true");
    renderRadioAirportResults($("radio-airport-search")?.value || "");
    $("radio-airport-search")?.focus();
  });

  $("close-radio-airports")?.addEventListener("click", () => {
    $("radio-airport-modal")?.classList.remove("visible");
    $("radio-airport-modal")?.setAttribute("aria-hidden", "true");
    $("radio-open-airports")?.setAttribute("aria-expanded", "false");
  });

  $("radio-airport-modal")?.addEventListener("click", (event) => {
    if (event.target === $("radio-airport-modal")) {
      $("radio-airport-modal")?.classList.remove("visible");
      $("radio-airport-modal")?.setAttribute("aria-hidden", "true");
      $("radio-open-airports")?.setAttribute("aria-expanded", "false");
    }
  });

  $("radio-airport-search")?.addEventListener("input", () => {
    renderRadioAirportResults($("radio-airport-search")?.value || "");
  });

  $("radio-airport-results")?.addEventListener("click", (event) => {
    const filterButton =
      event.target instanceof Element
        ? event.target.closest(".radio-airport-filter")
        : null;
    if (filterButton) {
      const query = filterButton.dataset.query || "";
      if ($("radio-airport-search")) $("radio-airport-search").value = query;
      renderRadioAirportResults(query);
      return;
    }

    const button =
      event.target instanceof Element
        ? event.target.closest(".radio-feed-option")
        : null;
    if (!button) return;
    const feedKey = button.dataset.feedKey || "";
    const index = liveAtcFeeds.findIndex((feed) => feed.key === feedKey);
    if (index < 0) return;
    setRadioFeedByIndex(index, { autoplay: false });
    void playRadioAudio({ preserveCurrent: true });
    $("radio-airport-modal")?.classList.remove("visible");
    $("radio-airport-modal")?.setAttribute("aria-hidden", "true");
    $("radio-open-airports")?.setAttribute("aria-expanded", "false");
  });

  $("radio-play")?.addEventListener("click", async () => {
    if (!radioEnabled) return;
    const audio = $("radio-audio");
    if (!audio) return;
    if (audio.paused) {
      setRadioFeedByIndex(radioFeedIndex, { autoplay: false });
      await playRadioAudio({ preserveCurrent: true });
      return;
    }
    audio.pause();
  });

  $("radio-audio")?.addEventListener("play", () => {
    syncRadioPlayButtonState(true);
    $("radio-widget")?.classList.add("radio-playing");
    setRadioStatus(`Lecture ${radioFeed?.label || radioFeed?.icao || ""}`);
  });

  $("radio-audio")?.addEventListener("pause", () => {
    syncRadioPlayButtonState(false);
    $("radio-widget")?.classList.remove("radio-playing");
    setRadioStatus("Pause");
  });

  $("radio-audio")?.addEventListener("error", () => {
    syncRadioPlayButtonState(false);
    setRadioStatus("Flux audio indisponible pour le moment.");
  });

  setRadioEnabled(false, "Chargement du repertoire ATC…");
  syncRadioPlayButtonState(false);
  setSearchFeedback();
  syncRadioWidget();
  updatePerfPanel();

  window.addEventListener("resize", () => {
    world.width(window.innerWidth);
    world.height(window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1));
    viewportState.width = globeVizEl.clientWidth || window.innerWidth;
    viewportState.height = globeVizEl.clientHeight || window.innerHeight;
    sceneState.overlayDirty = true;
    sceneState.instanceDirty = true;
    sceneState.cameraDirty = true;
    sceneState.hoverDirty = true;
    derivedVisualsDirty = true;
    scheduleWeatherOverlay(world);
  });

  setInterval(() => {
    derivedVisualsDirty = !!selectedHex;
  }, 1000);

  setWeatherState("La météo visible sur la carte est en cours de chargement…");
  fetchFlights();
  requestAnimationFrame(animate);
  setTimeout(() => {
    void loadLiveAtcAirports();
  }, 180);
}

main().catch((error) => {
  console.error("[Stratus] echec du demarrage:", error);
  setStatus("err", "Erreur JS");
});
