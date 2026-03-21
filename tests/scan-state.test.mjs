import test from "node:test";
import assert from "node:assert/strict";

import { deriveLoadState } from "../sources/client/scan-state.mjs";

test("deriveLoadState returns the initial loading state when health is missing", () => {
  assert.deepEqual(deriveLoadState(null), {
    hidden: false,
    label: "Initialisation du flux mondial OpenSky",
    percentText: "0%",
    fillPercent: 0,
    note: "",
    complete: false,
    sweeping: false,
  });
});

test("deriveLoadState hides the loader once data is available", () => {
  const state = deriveLoadState({ last_success: 1234 });
  assert.equal(state.hidden, true);
  assert.equal(state.complete, true);
  assert.equal(state.percentText, "OK");
  assert.equal(state.fillPercent, 100);
});

test("deriveLoadState clamps and rounds progress for ongoing validation", () => {
  const configured = deriveLoadState({
    scan_label: "Validation",
    session_validation_percent: 151.3,
    configured_api_key: true,
  });
  assert.equal(configured.label, "Validation");
  assert.equal(configured.percentText, "100%");
  assert.equal(configured.fillPercent, 100);
  assert.match(configured.note, /Connexion au snapshot mondial OpenSky en cours/);

  const anonymous = deriveLoadState({
    session_validation_percent: -5,
    configured_api_key: false,
  });
  assert.equal(anonymous.percentText, "0%");
  assert.match(anonymous.note, /Mode anonyme actif/);
});
