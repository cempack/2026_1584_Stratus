import test from "node:test";
import assert from "node:assert/strict";

import {
  applyPhotoMetadataToPlane,
  buildDashedPathSegments,
  fetchWeatherForPlaneData,
  loadLiveAtcAirportsData,
  nextFlightsPollDelayMs,
  pickProjectedPlane,
  searchPrimaryLabel,
  syncFlightsState,
  levenshteinWithinLimit,
} from "../sources/client/app-core.mjs";

test("searchPrimaryLabel handles null, priority order, and uppercase hex fallbacks", () => {
  assert.equal(searchPrimaryLabel(null), "—");
  assert.equal(
    searchPrimaryLabel({ flight: "AFR10", registration: "F-GSQJ", hex: "abc123" }),
    "AFR10",
  );
  assert.equal(
    searchPrimaryLabel({ registration: "F-GSQJ", hex: "abc123" }),
    "F-GSQJ",
  );
  assert.equal(searchPrimaryLabel({ hex: "abc123" }), "ABC123");
  assert.equal(searchPrimaryLabel({}), "—");
});

test("levenshteinWithinLimit returns limit+1 for clearly distant values", () => {
  assert.equal(levenshteinWithinLimit("plane", "plane", 1), 0);
  assert.equal(levenshteinWithinLimit("plane", "plans", 1), 1);
  assert.equal(levenshteinWithinLimit("plane", "airport", 1), 2);
});

test("applyPhotoMetadataToPlane updates known fields and refreshes search results only on change", () => {
  const plane = { hex: "abc123", registration: "OLD1" };
  let refreshCount = 0;

  const changed = applyPhotoMetadataToPlane(
    plane,
    {
      registration: "NEW1",
      manufacturer: "Airbus",
      owner: "Demo Air",
    },
    {
      hasSearchResults: true,
      onSearchResultsChange: () => {
        refreshCount += 1;
      },
    },
  );

  assert.equal(changed, true);
  assert.equal(plane.registration, "NEW1");
  assert.equal(plane.manufacturer, "Airbus");
  assert.equal(plane.owner, "Demo Air");
  assert.equal(refreshCount, 1);

  const unchanged = applyPhotoMetadataToPlane(
    plane,
    { registration: "NEW1" },
    {
      hasSearchResults: true,
      onSearchResultsChange: () => {
        refreshCount += 1;
      },
    },
  );
  assert.equal(unchanged, false);
  assert.equal(refreshCount, 1);
});

test("syncFlightsState deduplicates incoming aircraft and removes stale entries", () => {
  const planeMap = new Map([
    ["stale01", { hex: "stale01", trail: [] }],
    ["keep01", { hex: "keep01", existing: true, trail: [] }],
  ]);
  const presented = [];

  const state = syncFlightsState({
    planeMap,
    payload: {
      flights: [
        { hex: "KEEP01", trail: [{ ts: 1 }] },
        { hex: "keep01", trail: [{ ts: 2 }] },
        { hex: "new002", trail: [] },
        { hex: null },
      ],
    },
    receivedAt: 123,
    applyPlanePresentation: (plane, receivedAt) => {
      plane.presentedAt = receivedAt;
      presented.push(plane.hex);
    },
    normalizeHexId: (value) => String(value || "").trim().toLowerCase() || null,
    planeDataVersion: 4,
  });

  assert.deepEqual(presented, ["keep01", "new002"]);
  assert.equal(state.flightsLoaded, true);
  assert.equal(state.planeDataVersion, 5);
  assert.deepEqual(
    state.planeArr.map((plane) => plane.hex),
    ["keep01", "new002"],
  );
  assert.equal(planeMap.has("stale01"), false);
  assert.equal(planeMap.has("keep01"), true);
});

test("fetchWeatherForPlaneData returns current weather data and surfaces empty payloads", async () => {
  let requestedUrl = "";
  const current = await fetchWeatherForPlaneData({
    fetchImpl: async (url, options) => {
      requestedUrl = url;
      assert.equal(options.signal, "signal-token");
      return {
        ok: true,
        async json() {
          return {
            current: { temperature_2m: 18.1, wind_speed_10m: 21, cloud_cover: 42 },
          };
        },
      };
    },
    url: "/api/weather",
    plane: { lat: 48.85661, lng: 2.35222 },
    signal: "signal-token",
  });
  assert.equal(
    requestedUrl,
    "/api/weather?lat=48.86&lng=2.35",
  );
  assert.equal(current.temperature_2m, 18.1);

  await assert.rejects(
    () =>
      fetchWeatherForPlaneData({
        fetchImpl: async () => ({
          ok: true,
          async json() {
            return {};
          },
        }),
        url: "/api/weather",
        plane: { lat: 0, lng: 0 },
      }),
    /Aucune donnée disponible/,
  );
});

test("loadLiveAtcAirportsData throws on HTTP errors", async () => {
  await assert.rejects(
    () =>
      loadLiveAtcAirportsData({
        fetchImpl: async () => ({ ok: false, status: 503 }),
        url: "/api/liveatc/airports",
      }),
    /HTTP 503/,
  );
});

test("pickProjectedPlane returns the closest visible candidate inside the radius", () => {
  const picked = pickProjectedPlane(
    [
      { hex: "far", screenVisible: true, screenX: 10, screenY: 10, pickRadius: 4 },
      { hex: "near", screenVisible: true, screenX: 13, screenY: 13, pickRadius: 10 },
      { hex: "hidden", screenVisible: false, screenX: 12, screenY: 12, pickRadius: 30 },
    ],
    { pointerX: 12, pointerY: 12, defaultPickRadius: 8 },
  );
  assert.equal(picked?.hex, "near");
});

test("buildDashedPathSegments skips gaps while keeping valid segments", () => {
  const segments = buildDashedPathSegments(
    [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }],
    { dashSpan: 2, gapSpan: 1, color: "red", stroke: 3 },
  );
  assert.equal(segments.length, 2);
  assert.equal(segments[0].points.length, 3);
  assert.equal(segments[0].color, "red");
});

test("nextFlightsPollDelayMs clamps server poll intervals into the allowed window", () => {
  assert.equal(nextFlightsPollDelayMs(null), 20_000);
  assert.equal(nextFlightsPollDelayMs({ poll_interval_seconds: 20 }), 15_000);
  assert.equal(nextFlightsPollDelayMs({ poll_interval_seconds: 240 }), 45_000);
});
