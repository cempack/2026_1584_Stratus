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
  computeRenderSamplingOffset,
  computeRenderSamplingStep,
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
    minDurationMs: 4200,
    revealHoldMs: 950,
    fadeDurationMs: 1250,
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
      const progress = clamp01(elapsed / 15_500);
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
  const nextPlaneArr = [];

  for (const incoming of payload.flights) {
    const existing = planeMap.get(incoming.hex);
    if (existing) {
      Object.assign(existing, incoming);
      existing.trail = incoming.trail || [];
      applyPlanePresentation(existing, receivedAt);
      nextPlaneArr.push(existing);
      continue;
    }

    const plane = { ...incoming, trail: incoming.trail || [] };
    applyPlanePresentation(plane, receivedAt);
    planeMap.set(plane.hex, plane);
    nextPlaneArr.push(plane);
  }

  planeMap.clear();
  for (const plane of nextPlaneArr) {
    planeMap.set(plane.hex, plane);
  }

  planeArr = nextPlaneArr;
  flightsLoaded = true;
}

function focusPlane(world, camera, plane) {
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
  rebuildDerivedVisuals(world, camera);
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
    world.htmlElementsData(
      (payload.points || []).filter((point) => point.temperature != null),
    );
  } catch (error) {
    console.warn("[Stratus] couche meteo indisponible:", error);
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

function rebuildDerivedVisuals(world, camera) {
  if (!flightsLoaded) return;

  const traces = [];
  const selectedPlane = getPlaneByHex(selectedHex);

  if (selectedPlane && selectedPlane.trail && selectedPlane.trail.length >= 1) {
    const trail = normalizeTrailPoints(selectedPlane.trail);
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
  const world = GlobeFactory()($("globeViz"))
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
    .htmlElementsData([])
    .htmlLat((point) => point.lat)
    .htmlLng((point) => point.lng)
    .htmlAltitude(() => 0.0008)
    .htmlElement((point) => styleWeatherNode(point))
    .htmlTransitionDuration(0);

  const scene = world.scene();
  const camera = world.camera();
  const renderer = world.renderer();
  const controls = world.controls();
  const globeGroup = scene;

  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.35));
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
    scheduleWeatherOverlay(world);
  });

  const bootSequence = createBootSequence(world, controls);
  bootSequence.applyLoadState(deriveLoadState(lastHealth));
  const TRAIL_REBUILD_INTERVAL = 650;

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
      rebuildDerivedVisuals(world, camera);
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
    focusPlane(world, camera, plane);
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
  let renderSamplingTick = 0;

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
    projectionMatrix.multiplyMatrices(
      camera.projectionMatrix,
      camera.matrixWorldInverse,
    );
    frustum.setFromProjectionMatrix(projectionMatrix);

    for (const layer of variantLayers.values()) {
      layer.count = 0;
    }

    const baseScale = basePlaneScale(world);
    const globeBounds = $("globeViz").getBoundingClientRect();
    pickPlanes = [];
    let pickCount = 0;
    const count = planeArr.length;
    const samplingStep = computeRenderSamplingStep(count, MAX_RENDERED_PLANES);
    const samplingOffset = computeRenderSamplingOffset(
      count,
      samplingStep,
      renderSamplingTick,
    );
    renderSamplingTick += 1;
    const renderMetricsCache = new Map();
    const renderedHexes = new Set();

    const onlySelected = !!selectedHex;

    const renderPlaneInstance = (plane) => {
      if (onlySelected && plane.hex !== selectedHex) {
        plane.screenVisible = false;
        return;
      }
      updatePlanePose(world, plane, now);
      surfaceVector.set(plane.wx, plane.wy, plane.wz);
      if (
        !isPlaneFacingCamera(camera, plane) ||
        !frustum.containsPoint(surfaceVector)
      ) {
        plane.screenVisible = false;
        return;
      }

      screenVector.set(plane.wx, plane.wy, plane.wz).project(camera);
      plane.screenX = (screenVector.x + 1) * 0.5 * globeBounds.width;
      plane.screenY = (1 - screenVector.y) * 0.5 * globeBounds.height;
      plane.screenVisible = screenVector.z >= -1 && screenVector.z <= 1;

      const layer = variantLayers.get(
        `${plane.variantId}-${plane.variantShapeIndex ?? 0}`,
      );
      if (!layer || layer.count >= renderPlaneCapacity) return;

      const scaleBoost =
        plane.hex === selectedHex ? 1.34 : plane.hex === hoveredHex ? 1.18 : 1;
      const metricsKey = `${plane.variantId}:${plane.variantScale}:${scaleBoost}`;
      let renderMetrics = renderMetricsCache.get(metricsKey);
      if (!renderMetrics) {
        renderMetrics = computeVariantRenderMetrics({
          variantId: plane.variantId,
          baseScale,
          variantScale: plane.variantScale,
          scaleBoost,
        });
        renderMetricsCache.set(metricsKey, renderMetrics);
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
      renderedHexes.add(plane.hex);
    };

    for (let i = samplingOffset; i < count; i += samplingStep) {
      renderPlaneInstance(planeArr[i]);
    }

    const forcedHexes = [];
    if (selectedHex) forcedHexes.push(selectedHex);
    if (hoveredHex && hoveredHex !== selectedHex) forcedHexes.push(hoveredHex);
    for (const forcedHex of forcedHexes) {
      const forcedPlane = planeMap.get(forcedHex);
      if (!forcedPlane || renderedHexes.has(forcedPlane.hex)) continue;
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
  }

  function updateHover() {
    if (!hoverPointer || performance.now() - lastHoverPickAt < HOVER_PICK_MS)
      return;
    lastHoverPickAt = performance.now();
    if (!planeArr.length) return;

    const plane = pickPlane(camera, hitMesh, hoverPointer);
    const tooltip = $("tooltip");
    if (!plane) {
      hoveredHex = null;
      tooltip.classList.remove("visible");
      $("globeViz").style.cursor = "grab";
      return;
    }

    hoveredHex = plane.hex;
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
    $("globeViz").style.cursor = "pointer";
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
    tickFps(now);
    bootSequence.update(now);
    if (zoneLoadingMesh.visible) {
      const pulse = 0.5 + 0.5 * Math.sin(now * 0.0055);
      zoneLoadingMesh.material.opacity = 0.45 + 0.28 * pulse;
      zoneLoadingMesh.material.size = 0.2 + 0.05 * pulse;
    }
    updateInstances(now);
    updateTether();
    updateHover();
    if (selectedHex && now - lastTrailRebuild > TRAIL_REBUILD_INTERVAL) {
      derivedVisualsDirty = true;
    }
    if (
      derivedVisualsDirty &&
      (!selectedHex || now - lastTrailRebuild > TRAIL_REBUILD_INTERVAL)
    ) {
      rebuildDerivedVisuals(world, camera);
      lastTrailRebuild = now;
    }
    requestAnimationFrame(animate);
  }

  async function fetchFlights() {
    setStatus("conn", flightsLoaded ? "Actualisation" : "Chargement");
    try {
      const response = await fetch(buildFlightsUrl());
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      const now = performance.now();
      syncFlights(payload, now);
      ensureRenderCapacity(payload.returned || planeArr.length);

      $("count-cache").textContent = (payload.count || 0).toLocaleString(
        "fr-FR",
      );
      $("count-rendered").textContent = (payload.returned || 0).toLocaleString(
        "fr-FR",
      );
      $("upd").textContent = payload.updated
        ? new Date(payload.updated * 1000).toLocaleTimeString("fr-FR")
        : "—";
      updateSourceStatus(payload);

      if (selectedHex && planeMap.has(selectedHex)) refreshSelectedPopup();
      else if (selectedHex) {
        selectedHex = null;
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
      updatePopup(null);
      derivedVisualsDirty = true;
      return;
    }

    focusPlaneWithTrajectory(plane);
  });

  $("globeViz").addEventListener("mousemove", (event) => {
    hoverPointer = event;
  });

  $("globeViz").addEventListener("mouseleave", () => {
    hoverPointer = null;
    if (hoveredHex !== null) derivedVisualsDirty = true;
    hoveredHex = null;
    $("tooltip").classList.remove("visible");
    $("globeViz").style.cursor = "grab";
  });

  $("p-close").addEventListener("click", () => {
    selectedHex = null;
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
    if (event.key === "Escape") {
      if ($("settings-modal")?.classList.contains("visible")) {
        closeSettingsModalShell();
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

  setSearchFeedback();

  window.addEventListener("resize", () => {
    world.width(window.innerWidth);
    world.height(window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    derivedVisualsDirty = true;
    scheduleWeatherOverlay(world);
  });

  setInterval(() => {
    derivedVisualsDirty = !!selectedHex;
  }, 1000);

  setWeatherState("La météo visible sur la carte est en cours de chargement…");
  fetchFlights();
  scheduleWeatherOverlay(world);
  requestAnimationFrame(animate);
}

main().catch((error) => {
  console.error("[Stratus] echec du demarrage:", error);
  setStatus("err", "Erreur JS");
});
