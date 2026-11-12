import { describe, expect, it } from "vitest";
import {
  EARLY_JOIN_MS,
  ENDED_GRACE_MS,
  insideEvent,
  isMeetingEvent,
  pickCurrentMeeting,
} from "@/lib/calendar/current-meeting";
import type { CalendarEvent, CalendarParticipant } from "@/types";

const NOW = Date.UTC(2026, 8, 2, 14, 0, 0); // 2026-09-02T14:00:00Z
const MIN = 60_000;

function participant(
  address: string,
  over: Partial<CalendarParticipant> = {}
): CalendarParticipant {
  return { address, name: null, type: "required", isOrganizer: false, ...over };
}

function event(over: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: "e1",
    subject: "Client sync",
    startMs: NOW - 5 * MIN,
    endMs: NOW + 25 * MIN,
    isCancelled: false,
    isAllDay: false,
    ownResponse: "accepted",
    participants: [
      participant("me@corp.test", { isOrganizer: true }),
      participant("cfo@acme.example"),
    ],
    ...over,
  };
}

describe("pickCurrentMeeting", () => {
  it("returns none for an empty calendar", () => {
    expect(pickCurrentMeeting([], NOW)).toEqual({ kind: "none" });
  });

  it("returns the single live meeting", () => {
    const result = pickCurrentMeeting([event()], NOW);
    expect(result).toEqual({ kind: "one", event: expect.objectContaining({ id: "e1" }) });
  });

  it.each([
    ["cancelled", { isCancelled: true }],
    ["all-day", { isAllDay: true }],
    ["declined", { ownResponse: "declined" }],
  ])("rejects a %s event", (_label, over) => {
    expect(pickCurrentMeeting([event(over)], NOW)).toEqual({ kind: "none" });
  });

  // `declined` is the ONLY value that rejects. A regression that rewrote the
  // rule as an allow-list of known-good values would still reject "declined"
  // correctly, and pass every test above, while silently dropping every
  // meeting where responseStatus.response carries something outside the
  // accepted/declined/tentativelyAccepted/notResponded/none set. The live
  // tenant probe returned the literal "organizer" for a self-organized
  // meeting; that value must still resolve to "one", not "none".
  it.each([
    "notResponded",
    "none",
    "tentativelyAccepted",
    "accepted",
    "organizer",
  ])("still selects a live meeting when ownResponse is %s", (ownResponse) => {
    const result = pickCurrentMeeting([event({ ownResponse })], NOW);
    expect(result).toEqual({ kind: "one", event: expect.objectContaining({ id: "e1" }) });
  });

  // Focus blocks and reminders. This filter alone collapses most apparent
  // overlaps.
  it("rejects an event whose only participant is the user", () => {
    const solo = event({
      participants: [participant("me@corp.test", { isOrganizer: true })],
    });
    expect(pickCurrentMeeting([solo], NOW)).toEqual({ kind: "none" });
  });

  // The room is not a participant: without the resource drop, user + room = 2
  // and the focus block survives as a candidate.
  it("still rejects a focus block that has a room resource attached", () => {
    const solo = event({
      participants: [
        participant("me@corp.test", { isOrganizer: true }),
        participant("room3@corp.test", { type: "resource" }),
      ],
    });
    expect(pickCurrentMeeting([solo], NOW)).toEqual({ kind: "none" });
  });

  // The issue opening scenario. The CLIENT organized, so `attendees` is just
  // the user, and a naive rule discards this as a focus block.
  it("keeps a client-organized 1:1 where the only attendee is the user", () => {
    const clientCall = event({
      participants: [
        participant("cfo@acme.example", { isOrganizer: true }),
        participant("me@corp.test"),
      ],
    });
    expect(pickCurrentMeeting([clientCall], NOW)).toMatchObject({ kind: "one" });
  });

  describe("acceptance window", () => {
    it("accepts a meeting starting inside the 5-minute early-join window", () => {
      const soon = event({ startMs: NOW + 4 * MIN, endMs: NOW + 34 * MIN });
      expect(pickCurrentMeeting([soon], NOW)).toMatchObject({ kind: "one" });
    });

    it("rejects a meeting starting beyond the early-join window", () => {
      const later = event({ startMs: NOW + 6 * MIN, endMs: NOW + 36 * MIN });
      expect(pickCurrentMeeting([later], NOW)).toEqual({ kind: "none" });
    });

    // Pinned to the exact boundary via the exported constant, not a
    // re-derived number: a `>` -> `>=` flip at the implementation check
    // `startMs > nowMs + EARLY_JOIN_MS` would reject this, and the
    // +4min/+6min cases above (both off the line) would not catch it.
    it("accepts a meeting starting exactly at the early-join boundary", () => {
      const atBoundary = event({
        startMs: NOW + EARLY_JOIN_MS,
        endMs: NOW + EARLY_JOIN_MS + 30 * MIN,
      });
      expect(pickCurrentMeeting([atBoundary], NOW)).toEqual({
        kind: "one",
        event: expect.objectContaining({ id: "e1" }),
      });
    });

    it("accepts a meeting that ended inside the 10-minute grace", () => {
      const justEnded = event({ startMs: NOW - 40 * MIN, endMs: NOW - 9 * MIN });
      expect(pickCurrentMeeting([justEnded], NOW)).toMatchObject({ kind: "one" });
    });

    it("rejects a meeting that ended outside the grace", () => {
      const over = event({ startMs: NOW - 60 * MIN, endMs: NOW - 11 * MIN });
      expect(pickCurrentMeeting([over], NOW)).toEqual({ kind: "none" });
    });

    // Pinned to the exact boundary via the exported constant: a `<` -> `<=`
    // flip at the implementation check `endMs < nowMs - ENDED_GRACE_MS`
    // would reject this, and the -9min/-11min cases above (both off the
    // line) would not catch it.
    it("accepts a meeting that ended exactly at the grace boundary", () => {
      const atBoundary = event({
        startMs: NOW - ENDED_GRACE_MS - 30 * MIN,
        endMs: NOW - ENDED_GRACE_MS,
      });
      expect(pickCurrentMeeting([atBoundary], NOW)).toEqual({
        kind: "one",
        event: expect.objectContaining({ id: "e1" }),
      });
    });

    // The window is anchored on `now`, not on when recording started, so
    // joining late needs no special handling.
    it("accepts a long meeting joined late", () => {
      const joinedLate = event({ startMs: NOW - 50 * MIN, endMs: NOW + 10 * MIN });
      expect(pickCurrentMeeting([joinedLate], NOW)).toMatchObject({ kind: "one" });
    });
  });

  // Order is significant: soonest-starting first, ties broken by id. Asserts
  // the exact sequence (a starts at NOW-5min, b starts at NOW) rather than a
  // sorted comparison, so a regression that reversed or randomized the
  // implementation own sort is caught.
  it("returns every survivor when more than one qualifies", () => {
    const a = event({ id: "a" });
    const b = event({ id: "b", subject: "Other", startMs: NOW, endMs: NOW + 30 * MIN });
    const result = pickCurrentMeeting([a, b], NOW);
    expect(result.kind).toBe("several");
    if (result.kind === "several") {
      expect(result.candidates.map((c) => c.id)).toEqual(["a", "b"]);
    }
  });

  // The whole reason Rust normalizes to epoch ms at the boundary. If a caller
  // ever regressed to `new Date(dateTime)` on an offset-bearing string, this
  // window arithmetic would shift by the local UTC offset. Feeding the same
  // instant expressed via a non-UTC offset must land identically.
  it("evaluates the window on epoch milliseconds, not a locally-parsed string", () => {
    const startMs = Date.parse("2026-09-02T16:55:00+03:00"); // == 13:55Z
    const endMs = Date.parse("2026-09-02T17:25:00+03:00"); // == 14:25Z
    const shifted = event({ startMs, endMs });
    expect(pickCurrentMeeting([shifted], NOW)).toMatchObject({ kind: "one" });
  });
});

const T = Date.UTC(2026, 10, 12, 10); // 2026-11-12T10:00:00Z

describe("insideEvent", () => {
  const ev = { startMs: T, endMs: T + 30 * MIN }; // 10:00-10:30
  it("exactly half of the span's own length passes", () => {
    expect(insideEvent({ start: T + 10 * MIN, end: T + 50 * MIN }, ev)).toBe(true); // 20 of 40
  });
  it("just under half fails", () => {
    expect(insideEvent({ start: T + 10 * MIN + 1, end: T + 50 * MIN + 1 }, { startMs: T, endMs: T + 30 * MIN })).toBe(false);
  });
  it("a joined 10:00-11:30 send over a 10:00-10:30 event is not inside", () => {
    expect(insideEvent({ start: T, end: T + 90 * MIN }, ev)).toBe(false);
  });
  it("a late joiner 10:20-10:30 is inside", () => {
    expect(insideEvent({ start: T + 20 * MIN, end: T + 30 * MIN }, ev)).toBe(true);
  });
  it("a zero-length span is never inside", () => {
    expect(insideEvent({ start: T + 5 * MIN, end: T + 5 * MIN }, ev)).toBe(false);
  });
});

describe("isMeetingEvent", () => {
  // An event hours outside every window still passes: this export carries only
  // the per-event filters, no acceptance window at all.
  const farOutside = { startMs: T - 8 * 60 * 60 * 1000, endMs: T - 7 * 60 * 60 * 1000 };

  it.each([
    ["cancelled", { isCancelled: true }],
    ["all-day", { isAllDay: true }],
    ["declined", { ownResponse: "declined" }],
    ["solo", { participants: [participant("me@corp.test", { isOrganizer: true })] }],
  ])("rejects a %s event", (_label, over) => {
    expect(isMeetingEvent(event(over))).toBe(false);
  });

  it("accepts a two-person accepted event", () => {
    expect(isMeetingEvent(event())).toBe(true);
  });

  it("accepts an event far outside any window, because it has no window", () => {
    expect(isMeetingEvent(event(farOutside))).toBe(true);
  });
});

// Pinned as fixed expectations over one fixture list, since a before/after the
// split comparison cannot live in a single test. Seven events: one per filter
// (cancelled, all-day, declined, solo), one out-of-window, and two in-window.
// If the split ever changed pickCurrentMeeting's behaviour, either the kind or
// the surviving ids move.
describe("pickCurrentMeeting is unchanged by the split", () => {
  it("returns several with exactly the two in-window ids over seven events", () => {
    const nowMs = T + 10 * MIN;
    const events = [
      event({ id: "cancelled", isCancelled: true, startMs: T, endMs: T + 30 * MIN }),
      event({ id: "allday", isAllDay: true, startMs: T, endMs: T + 30 * MIN }),
      event({ id: "declined", ownResponse: "declined", startMs: T, endMs: T + 30 * MIN }),
      event({
        id: "solo",
        participants: [participant("me@corp.test", { isOrganizer: true })],
        startMs: T,
        endMs: T + 30 * MIN,
      }),
      event({ id: "out-of-window", subject: "Later", startMs: T + 20 * MIN, endMs: T + 50 * MIN }),
      event({ id: "in-a", subject: "First", startMs: T, endMs: T + 30 * MIN }),
      event({ id: "in-b", subject: "Second", startMs: T + 2 * MIN, endMs: T + 32 * MIN }),
    ];
    const result = pickCurrentMeeting(events, nowMs);
    expect(result.kind).toBe("several");
    if (result.kind === "several") {
      expect(result.candidates.map((c) => c.id)).toEqual(["in-a", "in-b"]);
    }
  });
});
