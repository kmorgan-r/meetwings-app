import { describe, expect, it } from "vitest";
import {
  MAX_ATTENDEES,
  MAX_ATTENDEE_TEXT,
  MAX_SUBJECT,
  buildSnapshot,
  groupAttendees,
  parseSnapshot,
} from "@/lib/calendar/calendar-snapshot";
import type { CalendarEvent, CalendarParticipant } from "@/types";

const START = Date.UTC(2026, 8, 2, 14, 0, 0); // 2026-09-02T14:00:00Z
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
    startMs: START,
    endMs: START + 30 * MIN,
    isCancelled: false,
    isAllDay: false,
    ownResponse: "accepted",
    participants: [],
    ...over,
  };
}

/** team + external + otherGuests, the number the note will actually render. */
function keptCount(groups: ReturnType<typeof groupAttendees>): number {
  return (
    groups.team.length +
    groups.external.reduce((n, e) => n + e.people.length, 0) +
    groups.otherGuests.length
  );
}

describe("groupAttendees", () => {
  it("the user and same-domain guests are the team", () => {
    const snap = buildSnapshot(
      event({
        participants: [
          participant("me@example.org", { name: "Me", isOrganizer: true }),
          participant("ann@example.org"),
          participant("bob@acme.com"),
        ],
      }),
      "me@example.org"
    );
    const groups = groupAttendees(snap);
    expect(groups.teamLabel).toBe("Team (example.org)");
    expect(groups.team).toEqual(["Me", "ann@example.org"]);
  });

  it("external guests are grouped by domain, sorted", () => {
    const snap = buildSnapshot(
      event({
        participants: [
          participant("zoe@beta.io"),
          participant("amy@acme.com"),
          participant("sam@beta.io"),
          participant("lee@acme.com"),
        ],
      }),
      null
    );
    const groups = groupAttendees(snap);
    expect(groups.external).toEqual([
      { domain: "acme.com", people: ["amy@acme.com", "lee@acme.com"] },
      { domain: "beta.io", people: ["zoe@beta.io", "sam@beta.io"] },
    ]);
    expect(groups.omitted).toBe(0);
  });

  it("free-mail guests land in Other guests, never a company", () => {
    const snap = buildSnapshot(
      event({
        participants: [
          participant("me@example.org", { name: "Me", isOrganizer: true }),
          participant("x@gmail.com"),
          participant("y@acme.com"),
          participant("z@gmail.com"),
        ],
      }),
      "me@example.org"
    );
    const groups = groupAttendees(snap);
    expect(groups.otherGuests).toEqual(["x@gmail.com", "z@gmail.com"]);
    expect(groups.external.some((e) => e.domain === "gmail.com")).toBe(false);
  });

  it('a free-mail own address gives the label "Team" and only the user in it', () => {
    const snap = buildSnapshot(
      event({
        participants: [
          participant("me@gmail.com", { name: "Me" }),
          participant("peer@gmail.com"),
          participant("boss@acme.com"),
        ],
      }),
      "me@gmail.com"
    );
    const groups = groupAttendees(snap);
    expect(groups.teamLabel).toBe("Team");
    expect(groups.team).toEqual(["Me"]);
    expect(groups.otherGuests).toEqual(["peer@gmail.com"]);
    expect(groups.external).toEqual([{ domain: "acme.com", people: ["boss@acme.com"] }]);
  });

  it("display text is capped at MAX_ATTENDEE_TEXT", () => {
    const exact = "A".repeat(MAX_ATTENDEE_TEXT);
    const over = "B".repeat(MAX_ATTENDEE_TEXT + 1);
    const snap = buildSnapshot(
      event({
        participants: [
          participant("a@gmail.com", { name: exact }),
          participant("b@gmail.com", { name: over }),
          participant("c@gmail.com", { name: "  Cady  " }),
          participant("d@gmail.com"),
        ],
      }),
      null
    );
    const groups = groupAttendees(snap);
    expect(groups.otherGuests).toEqual([
      exact,
      "B".repeat(MAX_ATTENDEE_TEXT - 1) + "…",
      "Cady",
      "d@gmail.com",
    ]);
    expect(groups.otherGuests[1].length).toBe(MAX_ATTENDEE_TEXT);
  });

  it("caps a 300-guest invite at MAX_ATTENDEES and counts the rest", () => {
    const snap = buildSnapshot(
      event({
        participants: Array.from({ length: 300 }, (_unused, i) =>
          participant(`guest${i}@acme.com`)
        ),
      }),
      null
    );
    const groups = groupAttendees(snap);
    expect(keptCount(groups)).toBe(MAX_ATTENDEES);
    expect(groups.omitted).toBe(250);
  });

  it("the cap keeps team, then external A-Z, then other guests, regardless of invite order", () => {
    const participants = [
      ...Array.from({ length: 5 }, (_unused, i) => participant(`g${i}@gmail.com`)),
      ...Array.from({ length: 30 }, (_unused, i) => participant(`z${i}@zeta.io`)),
      ...Array.from({ length: 30 }, (_unused, i) => participant(`a${i}@acme.com`)),
      participant("t0@example.org"),
      participant("t1@example.org"),
    ];
    const snap = buildSnapshot(event({ participants }), "me@example.org");
    const groups = groupAttendees(snap);
    expect(groups.team).toHaveLength(2);
    expect(groups.external).toEqual([
      {
        domain: "acme.com",
        people: Array.from({ length: 30 }, (_unused, i) => `a${i}@acme.com`),
      },
      {
        domain: "zeta.io",
        people: Array.from({ length: 18 }, (_unused, i) => `z${i}@zeta.io`),
      },
    ]);
    expect(groups.otherGuests).toEqual([]);
    expect(groups.omitted).toBe(17);
  });

  it("the own address matches case-insensitively", () => {
    const snap = buildSnapshot(
      event({
        participants: [
          participant("me@gmail.com", { name: "Me" }),
          participant("x@gmail.com"),
        ],
      }),
      "ME@gmail.com"
    );
    const groups = groupAttendees(snap);
    expect(groups.teamLabel).toBe("Team");
    expect(groups.team).toEqual(["Me"]);
    expect(groups.otherGuests).toEqual(["x@gmail.com"]);
  });

  it("the MAX_ATTENDEES boundary is exact", () => {
    const at = (n: number) =>
      groupAttendees(
        buildSnapshot(
          event({
            participants: Array.from({ length: n }, (_unused, i) =>
              participant(`g${i}@acme.com`)
            ),
          }),
          null
        )
      );
    const atCap = at(50);
    expect(keptCount(atCap)).toBe(50);
    expect(atCap.omitted).toBe(0);
    const overCap = at(51);
    expect(keptCount(overCap)).toBe(50);
    expect(overCap.omitted).toBe(1);
  });
});

describe("buildSnapshot", () => {
  it("a declined guest is left out of the snapshot", () => {
    const snap = buildSnapshot(
      event({
        participants: [
          participant("gone@acme.com", { response: "declined" }),
          participant("maybe@acme.com", { response: "tentative" }),
          participant("here@acme.com"),
        ],
      }),
      null
    );
    expect(snap.participants.map((p) => p.address)).toEqual([
      "maybe@acme.com",
      "here@acme.com",
    ]);
  });

  it("resources and duplicate addresses are dropped", () => {
    const snap = buildSnapshot(
      event({
        participants: [
          participant("conf@example.org", { type: "resource" }),
          participant("a@acme.com"),
          participant("  A@ACME.com "),
          participant("b@beta.io", { isOrganizer: true }),
          participant("b@beta.io"),
        ],
      }),
      null
    );
    expect(snap.participants.map((p) => p.address)).toEqual(["a@acme.com", "b@beta.io"]);
  });

  it("the subject is cut to MAX_SUBJECT", () => {
    const snap = buildSnapshot(event({ subject: "S".repeat(300) }), null);
    expect(snap.subject?.length).toBe(MAX_SUBJECT);
    expect(buildSnapshot(event({ subject: null }), null).subject).toBeNull();
  });
});

describe("parseSnapshot", () => {
  it("parseSnapshot round-trips buildSnapshot and returns null for junk", () => {
    const snap = buildSnapshot(
      event({
        participants: [
          participant("me@example.org", { name: "Me", isOrganizer: true }),
          participant("amy@acme.com"),
        ],
      }),
      "me@example.org"
    );
    expect(parseSnapshot(JSON.stringify(snap))).toEqual(snap);
    expect(parseSnapshot(null)).toBeNull();
    expect(parseSnapshot("{")).toBeNull();
    expect(parseSnapshot('{"key":1}')).toBeNull();
    expect(parseSnapshot('{"key":"e1","startMs":1,"endMs":2}')).toBeNull();
    expect(
      parseSnapshot(
        '{"key":"e1","startMs":1,"endMs":2,"participants":[{"address":1,"name":null}]}'
      )
    ).toBeNull();
    expect(
      parseSnapshot(
        '{"key":"e1","startMs":1,"endMs":2,"participants":[{"address":"a@b.c","name":5}]}'
      )
    ).toBeNull();
    expect(
      parseSnapshot('{"key":"e1","startMs":1,"endMs":2,"participants":[null]}')
    ).toBeNull();
  });
});
