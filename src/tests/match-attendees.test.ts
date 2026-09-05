import { describe, expect, it } from "vitest";
import { matchAttendees, normalizeAddress, participantsOf } from "@/lib/calendar/match-attendees";
import type { CalendarEvent, CalendarParticipant } from "@/types";
import type { OdooContact } from "@/types";

function participant(
  address: string,
  over: Partial<CalendarParticipant> = {}
): CalendarParticipant {
  return { address, name: null, type: "required", isOrganizer: false, ...over };
}

function contact(id: number, email: string | null, over: Partial<OdooContact> = {}): OdooContact {
  return {
    id,
    name: `Contact ${id}`,
    email,
    phone: null,
    companyName: null,
    parentId: null,
    isCompany: false,
    active: true,
    writeDate: "2026-09-01 00:00:00",
    isColleague: false,
    lastMeetingAt: null,
    ...over,
  };
}

function event(participants: CalendarParticipant[]): CalendarEvent {
  return {
    id: "e1",
    subject: "Sync",
    startMs: 0,
    endMs: 0,
    isCancelled: false,
    isAllDay: false,
    ownResponse: "accepted",
    participants,
  };
}

describe("normalizeAddress", () => {
  it("trims and lowercases", () => {
    expect(normalizeAddress("  CFO@Acme.Example ")).toBe("cfo@acme.example");
  });
});

describe("participantsOf", () => {
  it("drops resource attendees", () => {
    const out = participantsOf(
      event([participant("a@x.test"), participant("room3@x.test", { type: "resource" })])
    );
    expect(out.map((p) => p.address)).toEqual(["a@x.test"]);
  });

  // Graph generally does NOT repeat the organizer in attendees, but it may.
  // The union-and-dedupe rule is correct either way.
  it("counts an organizer who also appears in attendees once, keeping the organizer flag", () => {
    const out = participantsOf(
      event([
        participant("Host@x.test", { isOrganizer: true, name: "Host" }),
        participant("host@x.test"),
      ])
    );
    expect(out).toHaveLength(1);
    expect(out[0].isOrganizer).toBe(true);
  });

  it("dedupes duplicate addresses on one event", () => {
    const out = participantsOf(event([participant("a@x.test"), participant("A@X.test")]));
    expect(out).toHaveLength(1);
  });
});

describe("matchAttendees", () => {
  const own = "me@corp.test";

  it("matches on normalized email", () => {
    const result = matchAttendees({
      participants: [participant(" CFO@Acme.Example ")],
      contacts: [contact(7, "cfo@acme.example")],
      ownAddress: own,
    });
    expect(result.matched.map((m) => m.contact.id)).toEqual([7]);
    expect(result.unmatched).toHaveLength(0);
  });

  it("excludes the signed-in user's own address", () => {
    const result = matchAttendees({
      participants: [participant("ME@corp.test"), participant("cfo@acme.example")],
      contacts: [contact(7, "cfo@acme.example"), contact(8, "me@corp.test")],
      ownAddress: own,
    });
    expect(result.excluded.map((e) => e.reason)).toEqual(["self"]);
    expect(result.matched.map((m) => m.contact.id)).toEqual([7]);
  });

  // The safe failure. Both claims are UPN-shaped and often differ from the
  // primary SMTP address; an extra visible row beats a silently dropped one.
  it("proposes the user's own row when the claim resolves to nothing", () => {
    const result = matchAttendees({
      participants: [participant("me@corp.test")],
      contacts: [contact(8, "me@corp.test")],
      ownAddress: null,
    });
    expect(result.excluded).toHaveLength(0);
    expect(result.matched.map((m) => m.contact.id)).toEqual([8]);
  });

  it("excludes colleagues entirely - not even a greyed row", () => {
    const result = matchAttendees({
      participants: [participant("mate@corp.test")],
      contacts: [contact(9, "mate@corp.test", { isColleague: true })],
      ownAddress: own,
    });
    expect(result.matched).toHaveLength(0);
    expect(result.unmatched).toHaveLength(0);
    expect(result.excluded.map((e) => e.reason)).toEqual(["colleague"]);
  });

  // listContacts runs a bare SELECT with no `active` filter
  // (odoo-contacts.action.ts:122), so archived partners ARE in the cache.
  it("treats an archived contact as unmatched, shown and labelled", () => {
    const result = matchAttendees({
      participants: [participant("old@acme.example")],
      contacts: [contact(10, "old@acme.example", { active: false })],
      ownAddress: own,
    });
    expect(result.matched).toHaveLength(0);
    expect(result.unmatched.map((u) => u.reason)).toEqual(["archived"]);
  });

  it("retains an unmatched attendee rather than dropping it", () => {
    const result = matchAttendees({
      participants: [participant("nobody@acme.example")],
      contacts: [],
      ownAddress: own,
    });
    expect(result.unmatched.map((u) => u.reason)).toEqual(["no-contact"]);
  });

  it("returns three empty buckets for no participants", () => {
    const result = matchAttendees({ participants: [], contacts: [], ownAddress: own });
    expect(result).toEqual({ matched: [], unmatched: [], excluded: [] });
  });

  // A cache row with a null or blank email must never match a blank address.
  it("never matches on a null or blank contact email", () => {
    const result = matchAttendees({
      participants: [participant("  ")],
      contacts: [contact(11, null), contact(12, "   ")],
      ownAddress: own,
    });
    expect(result.matched).toHaveLength(0);
  });

  /**
   * Two cached contacts sharing an email is ROUTINE in Odoo - a person and
   * their company, or the same person under two parents. `listContacts` runs a
   * bare `SELECT * FROM odoo_contacts WHERE instance = ?` with no ORDER BY
   * (odoo-contacts.action.ts:122), so "whichever row came back first" is not a
   * rule, it is whatever SQLite happened to return.
   *
   * The user sees only a NAME on the proposal row, so if the wrong record wins
   * the substitution is invisible at confirm time - and the confirm button is
   * the whole safety gate. Deterministic beats arbitrary even when both are
   * imperfect.
   */
  it("breaks a duplicate-email tie deterministically, whatever the cache order", () => {
    const person = contact(20, "shared@acme.example", { name: "Zoe Person" });
    const company = contact(21, "shared@acme.example", {
      name: "Acme Ltd",
      isCompany: true,
    });
    const forwards = matchAttendees({
      participants: [participant("shared@acme.example")],
      contacts: [company, person],
      ownAddress: own,
    });
    const backwards = matchAttendees({
      participants: [participant("shared@acme.example")],
      contacts: [person, company],
      ownAddress: own,
    });
    // Same winner both ways round, and it is the PERSON, not the company.
    expect(forwards.matched[0].contact.id).toBe(20);
    expect(backwards.matched[0].contact.id).toBe(20);
  });

  it("breaks a person-vs-person duplicate by lowest id", () => {
    const result = matchAttendees({
      participants: [participant("shared@acme.example")],
      contacts: [
        contact(31, "shared@acme.example", { name: "Bee" }),
        contact(30, "shared@acme.example", { name: "Ay" }),
      ],
      ownAddress: own,
    });
    expect(result.matched[0].contact.id).toBe(30);
  });
});
