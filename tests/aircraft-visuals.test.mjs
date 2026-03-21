import test from "node:test";
import assert from "node:assert/strict";

import {
  classifyAircraftVariant,
  computeVariantRenderMetrics,
  DEFAULT_PICK_RADIUS,
} from "../sources/client/aircraft-visuals.mjs";

test("classifyAircraftVariant detects heavy aircraft from category and flight profile", () => {
  assert.equal(
    classifyAircraftVariant({ aircraft_category: "A5", aircraft_type: "C172" }),
    "heavy",
  );
  assert.equal(
    classifyAircraftVariant({ aircraft_type: "B77W", gs: 520, alt: 12_000 }),
    "heavy",
  );
});

test("classifyAircraftVariant detects light aircraft edge cases", () => {
  assert.equal(
    classifyAircraftVariant({ aircraft_type: "C172", gs: 120, alt: 1_500 }),
    "light",
  );
  assert.equal(
    classifyAircraftVariant({
      aircraft_description: "Pilatus PC-12 NG",
      gs: 90,
      alt: 2_000,
    }),
    "light",
  );
  assert.equal(
    classifyAircraftVariant({ on_ground: true, gs: 45, alt: 0 }),
    "light",
  );
});

test("classifyAircraftVariant detects regional aircraft without misclassifying jets", () => {
  assert.equal(
    classifyAircraftVariant({ aircraft_type: "DH8D", gs: 240, alt: 7_800 }),
    "regional",
  );
  assert.equal(
    classifyAircraftVariant({
      aircraft_description: "CRJ-900 Regional Jet",
      gs: 280,
      alt: 9_000,
    }),
    "regional",
  );
  assert.equal(
    classifyAircraftVariant({ aircraft_type: "A320", gs: 430, alt: 10_500 }),
    "jet",
  );
});

test("computeVariantRenderMetrics applies minimum render and hit scales", () => {
  const lightMetrics = computeVariantRenderMetrics({
    variantId: "light",
    baseScale: 1,
    variantScale: 0.6,
  });
  assert.equal(lightMetrics.renderScale, 1.24);
  assert.equal(lightMetrics.hitScale, Math.max(1.24 * 3.7, 2.5));
  assert.equal(lightMetrics.pickRadius, 34);

  const fallbackMetrics = computeVariantRenderMetrics({
    variantId: "unknown",
    baseScale: 1,
    variantScale: 1,
    scaleBoost: 1.1,
  });
  assert.equal(fallbackMetrics.pickRadius, DEFAULT_PICK_RADIUS);
  assert.equal(fallbackMetrics.renderScale, 1.1);
});
