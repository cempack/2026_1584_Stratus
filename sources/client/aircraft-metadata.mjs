export function applyPhotoMetadataToPlane(plane, payload, onMetadataApplied) {
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

  if (typeof onMetadataApplied === "function") {
    onMetadataApplied();
  }
}
