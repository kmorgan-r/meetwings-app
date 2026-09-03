import { describe, expect, it } from "vitest";
import { pickCurrentMeeting } from "@/lib/calendar/current-meeting";
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

  // The issue's opening scenario. The CLIENT organized, so `attendees` is just
  // the user - a naive rule discards this as a focus block.
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

    it("accepts a meeting that ended inside the 10-minute grace", () => {
      const justEnded = event({ startMs: NOW - 40 * MIN, endMs: NOW - 9 * MIN });
      expect(pickCurrentMeeting([justEnded], NOW)).toMatchObject({ kind: "one" });
    });

    it("rejects a meeting that ended outside the grace", () => {
      const over = event({ startMs: NOW - 60 * MIN, endMs: NOW - 11 * MIN });
      expect(pickCurrentMeeting([over], NOW)).toEqual({ kind: "none" });
    });

    // The window is anchored on `now`, not on when recording started, so
    // joining late needs no special handling.
    it("accepts a long meeting joined late", () => {
      const joinedLate = event({ startMs: NOW - 50 * MIN, endMs: NOW + 10 * MIN });
      expect(pickCurrentMeeting([joinedLate], NOW)).toMatchObject({ kind: "one" });
    });
  });

  it("returns every survivor when more than one qualifies", () => {
    const a = event({ id: "a" });
    const b = event({ id: "b", subject: "Other", startMs: NOW, endMs: NOW + 30 * MIN });
    const result = pickCurrentMeeting([a, b], NOW);
    expect(result.kind).toBe("several");
    if (result.kind === "several") {
      expect(result.candidates.map((c) => c.id).sort()).toEqual(["a", "b"]);
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
