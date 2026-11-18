import { describe, expect, it } from "vitest";
import { glossFor } from "./glossary";

describe("ATC glossary", () => {
  it("explains the phrases in a call, longest first, in order", () => {
    const g = glossFor("Delta 2775, runway 4L, cleared for takeoff, contact departure, good day");
    expect(g.map((x) => x.term)).toEqual(["cleared for takeoff", "contact departure", "good day"]);
    expect(g[0].meaning).toBe("autorisé à décoller");
  });
  it("matches across punctuation and ignores words inside other words", () => {
    expect(glossFor("Line up, and wait runway 22")[0].term).toBe("line up and wait"); // transcripts add stray commas
    expect(glossFor("hold short of runway 4L")[0].term).toBe("hold short");
    expect(glossFor("heavyweight")).toEqual([]);
  });
});
