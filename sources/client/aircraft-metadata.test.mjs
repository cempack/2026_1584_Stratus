import { test } from "node:test";
import assert from "node:assert";
import { applyPhotoMetadataToPlane } from "./aircraft-metadata.mjs";

test("applyPhotoMetadataToPlane - happy path with full payload", () => {
  const plane = { hex: "4CA9C2" };
  const payload = {
    mode_s: "4CA9C2",
    registration: "F-GSQJ",
    manufacturer: "BOEING",
    aircraft_model: "777-328(ER)",
    aircraft_type: "B77W",
    aircraft_description: "Boeing 777-300",
    owner: "Air France",
    operator_code: "AFR",
    country: "France",
  };

  let callbackCalled = false;
  applyPhotoMetadataToPlane(plane, payload, () => {
    callbackCalled = true;
  });

  assert.strictEqual(plane.mode_s, "4CA9C2");
  assert.strictEqual(plane.registration, "F-GSQJ");
  assert.strictEqual(plane.manufacturer, "BOEING");
  assert.strictEqual(plane.aircraft_model, "777-328(ER)");
  assert.strictEqual(plane.aircraft_type, "B77W");
  assert.strictEqual(plane.aircraft_description, "Boeing 777-300");
  assert.strictEqual(plane.owner, "Air France");
  assert.strictEqual(plane.operator_code, "AFR");
  assert.strictEqual(plane.country, "France");
  assert.strictEqual(callbackCalled, true);
});

test("applyPhotoMetadataToPlane - partial payload", () => {
  const plane = { hex: "4CA9C2", registration: "OLD-REG" };
  const payload = {
    registration: "F-GSQJ",
    manufacturer: "BOEING",
  };

  applyPhotoMetadataToPlane(plane, payload);

  assert.strictEqual(plane.registration, "F-GSQJ");
  assert.strictEqual(plane.manufacturer, "BOEING");
  assert.strictEqual(plane.hex, "4CA9C2");
  assert.strictEqual(plane.owner, undefined);
});

test("applyPhotoMetadataToPlane - null inputs", () => {
  const plane = { hex: "4CA9C2" };

  // Should not throw
  applyPhotoMetadataToPlane(null, { registration: "TEST" });
  applyPhotoMetadataToPlane(plane, null);

  assert.strictEqual(plane.registration, undefined);
});

test("applyPhotoMetadataToPlane - callback only called when function", () => {
  const plane = { hex: "4CA9C2" };
  const payload = { registration: "TEST" };

  // Should not throw if callback is not a function
  applyPhotoMetadataToPlane(plane, payload, "not a function");
  assert.strictEqual(plane.registration, "TEST");
});
