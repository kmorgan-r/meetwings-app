import { describe, expect, it } from "vitest";
// `reportGraphError` is deliberately NOT imported here - it is exercised in
// graph-redact.test.ts. An unused import fails the `npm run lint` this task's
// own verification step expects to be clean.
import { GraphError, graphError, toGraphError } from "@/lib/calendar/errors";

describe("graphError", () => {
  it("carries the code and non-identifying details only", () => {
    const err = graphError("GRAPH_BAD_RESPONSE", { eventCount: 3 });
    expect(err).toBeInstanceOf(GraphError);
    expect(err.code).toBe("GRAPH_BAD_RESPONSE");
    // `message` IS the code. There is no free-text message parameter to pass a
    // subject or an address through.
    expect(err.message).toBe("GRAPH_BAD_RESPONSE");
    expect(err.details).toEqual({ eventCount: 3 });
  });

  /**
   * "Respect Retry-After; do not retry in a loop" holds BY CONSTRUCTION here,
   * so no seconds value is carried and none is needed.
   *
   * This feature has exactly one automatic retry anywhere - the single
   * refresh-and-retry on a 401 (Task 11) - and a 429 is not it: calendar.rs
   * returns GRAPH_THROTTLED straight to the caller, useCalendarProposal puts
   * it in an error state, and the only thing that issues another request is a
   * user clicking Try again. A stored Retry-After would have nothing to gate.
   */
  it("carries no retry hint on GRAPH_THROTTLED, because nothing auto-retries", () => {
    expect(graphError("GRAPH_THROTTLED").details).toEqual({});
  });
});

describe("toGraphError", () => {
  // Rust returns a bare GRAPH_* code string as its Err value.
  it("maps a bare code string thrown by the IPC boundary", () => {
    expect(toGraphError("GRAPH_BAD_RESPONSE").code).toBe("GRAPH_BAD_RESPONSE");
    expect(toGraphError(new Error("GRAPH_AUTH_EXPIRED")).code).toBe("GRAPH_AUTH_EXPIRED");
  });

  it("maps anything unrecognized to GRAPH_NETWORK", () => {
    expect(toGraphError(new Error("connection reset")).code).toBe("GRAPH_NETWORK");
    expect(toGraphError(undefined).code).toBe("GRAPH_NETWORK");
  });

  it("passes a GraphError through unchanged", () => {
    const original = graphError("GRAPH_NO_KEYCHAIN");
    expect(toGraphError(original)).toBe(original);
  });
});
