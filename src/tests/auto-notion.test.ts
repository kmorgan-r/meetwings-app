import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OUTLOOK_CHECK_TIMEOUT_MS,
  autoNotionAllowed,
  decideCheckOne,
  withTimeout,
} from "@/lib/calendar/auto-notion";
import type { CalendarSnapshot } from "@/lib/calendar/calendar-snapshot";
import type { FetchCurrentMeetingsResult } from "@/lib/calendar/fetch-current-meetings";
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
      "Outlook GRAPH_AUTH_REJECTED",
      ok("G"),
      { kind: "error" as const, code: "GRAPH_AUTH_REJECTED" as const },
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

describe("autoNotionAllowed", () => {
  const T10 = Date.UTC(2026, 10, 12, 10, 0);
  const at = (min: number) => T10 + min * MIN;
  /** The saved Google event: 10:00-10:30. */
  const SNAPSHOT: CalendarSnapshot = {
    key: "g-1",
    subject: "Planning",
    startMs: at(0),
    endMs: at(30),
    ownAddress: "me@example.org",
    participants: [],
  };

  type Read = (startMs: number, endMs: number) => Promise<FetchCurrentMeetingsResult>;
  type Input = Parameters<typeof autoNotionAllowed>[0];

  const outlookAt = (startMin: number, endMin: number, over: Partial<CalendarEvent> = {}) => ({
    ...eventWith("O"),
    startMs: at(startMin),
    endMs: at(endMin),
    ...over,
  });
  const outlookOk = (...events: CalendarEvent[]): FetchCurrentMeetingsResult => ({
    kind: "ok",
    ownAddress: "me@example.org",
    events,
  });

  /** A 10:00-10:30 row with Outlook set up and empty, unless overridden. */
  function check(over: Partial<Input> = {}) {
    const readOutlook = vi.fn<Read>(async () => outlookOk());
    const input: Input = {
      span: { start: at(0), end: at(30) },
      snapshot: SNAPSHOT,
      outlookAbsent: false,
      readOutlook,
      ...over,
    };
    return { result: autoNotionAllowed(input), readOutlook: input.readOutlook };
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it("passes a row inside the Google event when Outlook has nothing", async () => {
    await expect(check().result).resolves.toBe(true);
  });

  it.each([true, false])(
    "an auto tick on a row mostly outside the Google event is withheld (outlookAbsent %s)",
    async (outlookAbsent) => {
      const readOutlook = vi.fn<Read>(async () => outlookOk());
      const run = check({ span: { start: at(20), end: at(60) }, outlookAbsent, readOutlook });
      await expect(run.result).resolves.toBe(false);
      expect(readOutlook).not.toHaveBeenCalled();
    }
  );

  it.each([true, false])("no saved Google event withholds (outlookAbsent %s)", async (outlookAbsent) => {
    const readOutlook = vi.fn<Read>(async () => outlookOk());
    await expect(check({ snapshot: null, outlookAbsent, readOutlook }).result).resolves.toBe(false);
    expect(readOutlook).not.toHaveBeenCalled();
  });

  it("an edge row after the event's end is withheld", async () => {
    await expect(
      check({ span: { start: at(31), end: at(40) }, outlookAbsent: true }).result
    ).resolves.toBe(false);
  });

  it("Outlook absent passes on the window rule alone", async () => {
    const readOutlook = vi.fn<Read>(async () => outlookOk(outlookAt(0, 30)));
    await expect(check({ outlookAbsent: true, readOutlook }).result).resolves.toBe(true);
    expect(readOutlook).not.toHaveBeenCalled();
  });

  it("an Outlook meeting overlapping the row by one minute withholds", async () => {
    const readOutlook = vi.fn<Read>(async () => outlookOk(outlookAt(29, 60)));
    await expect(check({ readOutlook }).result).resolves.toBe(false);
  });

  it("an Outlook meeting overlapping the row by one millisecond withholds", async () => {
    const event = { ...outlookAt(-30, 0), endMs: at(0) + 1 };
    const readOutlook = vi.fn<Read>(async () => outlookOk(event));
    await expect(check({ readOutlook }).result).resolves.toBe(false);
  });

  it("an Outlook meeting that starts exactly at the row's end still sends", async () => {
    const readOutlook = vi.fn<Read>(async () => outlookOk(outlookAt(30, 60)));
    await expect(check({ readOutlook }).result).resolves.toBe(true);
    expect(readOutlook).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["cancelled", { isCancelled: true }],
    ["all-day", { isAllDay: true }],
    ["declined", { ownResponse: "declined" }],
    [
      "solo",
      {
        participants: [
          { address: "me@example.org", name: "Me", type: "required" as const, isOrganizer: true },
        ],
      },
    ],
  ])(
    "an Outlook event that is %s, overlapping it, still sends",
    async (_name, over: Partial<CalendarEvent>) => {
      const readOutlook = vi.fn<Read>(async () => outlookOk(outlookAt(0, 30, over)));
      await expect(check({ readOutlook }).result).resolves.toBe(true);
    }
  );

  it.each([
    ["a read error", { kind: "error", code: "GRAPH_NETWORK" }],
    ["an Outlook expiry", { kind: "error", code: "GRAPH_AUTH_EXPIRED" }],
    ["a config that vanished mid-check", { kind: "absent" }],
  ] as [string, FetchCurrentMeetingsResult][])("%s withholds", async (_name, outcome) => {
    await expect(check({ readOutlook: async () => outcome }).result).resolves.toBe(false);
  });

  it("a read that rejects, or throws before returning, withholds without rejecting", async () => {
    await expect(
      check({ readOutlook: () => Promise.reject(new Error("boom")) }).result
    ).resolves.toBe(false);
    await expect(
      check({
        readOutlook: () => {
          throw new Error("sync boom");
        },
      }).result
    ).resolves.toBe(false);
  });

  it("a timeout withholds", async () => {
    vi.useFakeTimers();
    const run = check({ readOutlook: () => new Promise(() => {}), timeoutMs: 5000 });
    let settled: boolean | undefined;
    void run.result.then((v) => (settled = v));
    await vi.advanceTimersByTimeAsync(4999);
    expect(settled).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(false);
  });

  it("reads Outlook for exactly the row's span", async () => {
    const readOutlook = vi.fn<Read>(async () => outlookOk());
    await check({ span: { start: at(2), end: at(28) }, readOutlook }).result;
    expect(readOutlook).toHaveBeenCalledTimes(1);
    expect(readOutlook).toHaveBeenCalledWith(at(2), at(28));
  });
});
