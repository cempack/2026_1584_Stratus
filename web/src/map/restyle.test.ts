import { describe, expect, it } from "vitest";
import { buildOverlay } from "./layers";
import { styleChanges } from "./restyle";
import { buildStyle } from "./style";

describe("in-place restyle", () => {
  it("turning satellite on shows the imagery, hides the vector fills and recolours labels", () => {
    const ch = styleChanges(buildStyle("light").layers, buildStyle("light", { satellite: true }).layers);
    expect(ch).toContainEqual({ id: "sat", kind: "layout", prop: "visibility", value: "visible" });
    expect(ch).toContainEqual({ id: "water", kind: "layout", prop: "visibility", value: "none" });
    expect(ch.some((c) => c.id === "place-city" && c.prop === "text-color")).toBe(true);
    // and back: dropped properties return to their defaults
    const back = styleChanges(buildStyle("light", { satellite: true }).layers, buildStyle("light").layers);
    expect(back).toContainEqual({ id: "water", kind: "layout", prop: "visibility", value: "visible" });
  });
  it("same style: nothing to do; theme switch touches the overlay colours", () => {
    expect(styleChanges(buildStyle("dark").layers, buildStyle("dark").layers)).toEqual([]);
    const ov = styleChanges(buildOverlay("light").layers, buildOverlay("dark").layers);
    expect(ov.some((c) => c.id === "planes" && c.prop === "icon-color")).toBe(true);
  });
});
