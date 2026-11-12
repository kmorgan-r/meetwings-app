import { afterEach, describe, expect, it, vi } from "vitest";
import { OUTLOOK_CHECK_TIMEOUT_MS, decideCheckOne, withTimeout } from "@/lib/calendar/auto-notion";
import type { CalendarEvent } from "@/types";

const MIN = 60_000;
const NOW = Date.now();

function eventWith(id: string): CalendarEvent {
  return {
    id,
    subject: `Meeting ${id}`,
    startMs: NOW - 5 * MIN,
    endMs: NOW + 25 * MIN,
    isCancelled: false,
    isAllDay: false,
    ownResponse: "accepted",
    participants: [
      { address: "me@example.org", name: "Me", type: "required", isOrganizer: true },
      { address: `${id}@guest.example`, name: `Guest ${id}`, type: "required", isOrganizer: false },
    ],
  };
}

const ok = (...ids: string[]) => ({
  kind: "ok" as const,
  ownAddress: "me@example.org",
  events: ids.map(eventWith),
});

describe("decideCheckOne", () => {
  it.each([
    ["Google one + Outlook absent", ok("G"), { kind: "absent" as const }, "tick"],
    ["Google one + Outlook none", ok("G"), ok(), "tick"],
    ["Google none", ok(), ok(), "refuse"],
    ["Google several", ok("G1", "G2"), ok(), "refuse"],
    ["Google absent", { kind: "absent" as const }, ok(), "refuse"],
    ["Google error", { kind: "error" as const, code: "GOOGLE_NETWORK" as const }, ok(), "refuse"],
    ["Outlook one", ok("G"), ok("O"), "refuse"],
    ["Outlook several", ok("G"), ok("O1", "O2"), "refuse"],
    [
      "Outlook GRAPH_NOT_CONNECTED",
      ok("G"),
      { kind: "error" as const, code: "GRAPH_NOT_CONNECTED" as const },
      "refuse",
    ],
    [
      "Outlook GRAPH_AUTH_EXPIRED",
      ok("G"),
      { kind: "error" as const, code: "GRAPH_AUTH_EXPIRED" as const },
      "refuse",
    ],
    [
      "Outlook GRAPH_NETWORK",
      ok("G"),
      { kind: "error" as const, code: "GRAPH_NETWORK" as const },
      "refuse",
    ],
    ["Outlook timeout", ok("G"), "timeout" as const, "refuse"],
  ])("%s", (_name, google, outlook, expected) => {
    expect(decideCheckOne(google, outlook, NOW)).toBe(expected);
  });
});

describe("withTimeout", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("gives the value before the deadline and leaves no timer", async () => {
    vi.useFakeTimers();
    await expect(withTimeout(Promise.resolve("v"), OUTLOOK_CHECK_TIMEOUT_MS)).resolves.toBe("v");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("gives timeout when nothing settles by the deadline", async () => {
    vi.useFakeTimers();
    const p = withTimeout(new Promise<string>(() => {}), OUTLOOK_CHECK_TIMEOUT_MS);
    await vi.advanceTimersByTimeAsync(OUTLOOK_CHECK_TIMEOUT_MS);
    await expect(p).resolves.toBe("timeout");
  });

  it("gives timeout on a rejection, without rejecting, and leaves no timer", async () => {
    vi.useFakeTimers();
    await expect(
      withTimeout(Promise.reject(new Error("boom")), OUTLOOK_CHECK_TIMEOUT_MS)
    ).resolves.toBe("timeout");
    expect(vi.getTimerCount()).toBe(0);
  });
});
