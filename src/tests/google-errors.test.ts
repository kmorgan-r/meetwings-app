import { describe, expect, it } from "vitest";
import { GOOGLE_COPY, toGoogleCode } from "@/lib/calendar/google-errors";

describe("toGoogleCode", () => {
  it("keeps a known Google code", () => {
    expect(toGoogleCode("GOOGLE_THROTTLED")).toBe("GOOGLE_THROTTLED");
  });

  it("maps a Graph code to the network code", () => {
    expect(toGoogleCode(new Error("GRAPH_NETWORK"))).toBe("GOOGLE_NETWORK");
  });

  it("drops unknown text", () => {
    expect(toGoogleCode("boom: a@b.com")).toBe("GOOGLE_NETWORK");
  });

  it("has copy for every code", () => {
    const entries = Object.entries(GOOGLE_COPY);
    expect(entries).toHaveLength(9);
    for (const [, copy] of entries) expect(copy.length).toBeGreaterThan(0);
  });
});
