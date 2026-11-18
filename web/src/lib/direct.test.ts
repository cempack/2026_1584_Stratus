import { describe, expect, it } from "vitest";
import { parseAdsbdbAircraft, pickLevel } from "./direct";

describe("direct lookups", () => {
  it("picks the pressure level nearest the altitude, like the server", () => {
    expect(pickLevel(null)).toBe("surface");
    expect(pickLevel(800)).toBe("surface");
    expect(pickLevel(36000)).toBe("250hPa");
    expect(pickLevel(39000)).toBe("200hPa");
    expect(pickLevel(5000)).toBe("850hPa");
  });
  it("parses adsbdb aircraft like the server", () => {
    const a = parseAdsbdbAircraft({ response: { aircraft: { registration: "F-HPJA", icao_type: "A388", manufacturer: "Airbus", type: "A380 861",
      registered_owner: "Air France", registered_owner_operator_flag_code: "AFR", registered_owner_country_name: "France" } } });
    expect(a).toMatchObject({ registration: "F-HPJA", type: "A388", type_name: "Airbus A380 861", operator: "Air France", operator_icao: "AFR", country: "France" });
    expect(parseAdsbdbAircraft({ response: "unknown aircraft" })).toBeNull();
  });
});
