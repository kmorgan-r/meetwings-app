import { beforeEach, describe, expect, it, vi } from "vitest";
import { isCalendarAutoSelectEnabled, planAutoSelect } from "@/lib/calendar/auto-select";
import type { CalendarEvent, CalendarParticipant, OdooContact, SelectedTarget } from "@/types";

const NOW = Date.UTC(2026, 9, 15, 10, 0, 0);
const MIN = 60_000;

function contact(id: number, email: string | null, over: Partial<OdooContact> = {}): OdooContact {
  return {
    id, name: `Contact ${id}`, email, phone: null, companyName: null, parentId: null,
    isCompany: false, active: true, writeDate: "2026-10-01 00:00:00", isColleague: false,
    lastMeetingAt: null, ...over,
  };
}

function person(address: string, name: string | null = null): CalendarParticipant {
  return { address, name, type: "required", isOrganizer: false };
}

/** The user, as the organizer row Graph returns under their SMTP address. */
const ME: CalendarParticipant = { address: "me@corp.test", name: "Me", type: "required", isOrganizer: true };

function meeting(people: CalendarParticipant[], over: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: "ev1", subject: "Sync", startMs: NOW - 5 * MIN, endMs: NOW + 25 * MIN,
    isCancelled: false, isAllDay: false, ownResponse: "accepted",
    participants: [ME, ...people],
    ...over,
  };
}

function lead(resId: number): SelectedTarget {
  return { model: "crm.lead", resId, name: `Lead ${resId}` };
}

function plan(over: Partial<Parameters<typeof planAutoSelect>[0]> = {}) {
  return planAutoSelect({ events: [], ownAddress: "me@corp.test", contacts: [], targets: [], now: NOW, ...over });
}

const CFO = contact(7, "cfo@acme.example", { name: "Cleo Cfo" });

describe("planAutoSelect", () => {
  it("skips without an own address, so coworkers are never created blind", () => {
    expect(plan({ ownAddress: null, events: [meeting([person("new@acme.example", "New Person")])] }))
      .toEqual({ kind: "skip", reason: "no-own-address" });
  });

  it("skips when no meeting is current", () => {
    expect(plan()).toEqual({ kind: "skip", reason: "no-meeting" });
  });

  it("skips when two meetings overlap, rather than guess", () => {
    const events = [meeting([person("cfo@acme.example")]), meeting([person("x@beta.example")], { id: "ev2" })];
    expect(plan({ events, contacts: [CFO] })).toEqual({ kind: "skip", reason: "several-meetings" });
  });

  it("adds a matched contact", () => {
    expect(plan({ events: [meeting([person("cfo@acme.example", "Cleo")])], contacts: [CFO] }))
      .toEqual({ kind: "apply", add: [CFO], create: [] });
  });

  it("adds a matched contact even when a lead shares its id", () => {
    expect(plan({ events: [meeting([person("cfo@acme.example")])], contacts: [CFO], targets: [lead(7)] }))
      .toEqual({ kind: "apply", add: [CFO], create: [] });
  });

  it("does not create an attendee whose address has no domain", () => {
    expect(plan({ events: [meeting([person("no-at-sign", "Some Name")])], contacts: [CFO] }))
      .toEqual({ kind: "skip", reason: "nothing-to-do" });
  });

  it("does not re-add a contact that is already a target", () => {
    const targets: SelectedTarget[] = [{ model: "res.partner", resId: 7, name: "Cleo Cfo" }];
    expect(plan({ events: [meeting([person("cfo@acme.example")])], contacts: [CFO], targets }))
      .toEqual({ kind: "skip", reason: "nothing-to-do" });
  });

  it("does not add a matched contact on a colleague domain", () => {
    const coworker = contact(9, "pat@corp.test", { name: "Pat Coworker" });
    expect(plan({ events: [meeting([person("pat@corp.test", "Pat")])], contacts: [coworker] }))
      .toEqual({ kind: "skip", reason: "nothing-to-do" });
  });

  it("never creates over an archived contact", () => {
    const archived = contact(3, "old@acme.example", { active: false, name: "Old Timer" });
    expect(plan({ events: [meeting([person("old@acme.example", "Old Timer")])], contacts: [archived] }))
      .toEqual({ kind: "skip", reason: "nothing-to-do" });
  });

  it("creates a named attendee with no contact", () => {
    const ana = person("ana@newco.example", "Ana Newco");
    expect(plan({ events: [meeting([ana])], contacts: [CFO] }))
      .toEqual({ kind: "apply", add: [], create: [{ participant: ana, name: "Ana Newco", parentId: null }] });
  });

  it.each([
    ["no name", null],
    ["a blank name", "   "],
    ["the address as its name, in another case", "New@Acme.example"],
  ])("does not create an attendee with %s", (_label, name) => {
    expect(plan({ events: [meeting([person("new@acme.example", name)])], contacts: [CFO] }))
      .toEqual({ kind: "skip", reason: "nothing-to-do" });
  });

  it("does not create an attendee whose name matches an existing contact", () => {
    const jane = contact(4, "jane@other.example", { name: "Jane Doe" });
    expect(plan({ events: [meeting([person("jane.doe@acme.example", "Jane Doe")])], contacts: [jane] }))
      .toEqual({ kind: "skip", reason: "nothing-to-do" });
  });

  it("skips with an own address that has no domain", () => {
    expect(plan({ ownAddress: "kmorgan", events: [meeting([person("new@acme.example", "New Person")])] }))
      .toEqual({ kind: "skip", reason: "no-own-address" });
  });

  it("does not create an attendee whose name matches an archived contact", () => {
    const john = contact(6, "john@old.example", { active: false, name: "John Smith" });
    expect(plan({ events: [meeting([person("john@new.example", "John Smith")])], contacts: [john] }))
      .toEqual({ kind: "skip", reason: "nothing-to-do" });
  });

  it("does not create a coworker invited at a personal address", () => {
    const jane = contact(4, "jane@corp.test", { isColleague: true, name: "Jane Doe" });
    expect(plan({ events: [meeting([person("jane.doe@gmail.com", "Jane Doe")])], contacts: [jane] }))
      .toEqual({ kind: "skip", reason: "nothing-to-do" });
  });

  it("creates neither of two attendees who share a name under different addresses", () => {
    const events = [meeting([person("ana@newco.example", "Ana Newco"), person("ana.newco@gmail.com", "Ana Newco")])];
    expect(plan({ events, contacts: [CFO] })).toEqual({ kind: "skip", reason: "nothing-to-do" });
  });

  it("does not create an attendee on the user's own domain, whatever the case", () => {
    expect(plan({ events: [meeting([person("Al@CORP.test", "Al Coworker")])], contacts: [CFO] }))
      .toEqual({ kind: "skip", reason: "nothing-to-do" });
  });

  it("does not create an attendee on a flagged colleague's domain", () => {
    const bo = contact(5, "bo@partner.test", { isColleague: true, name: "Bo Colleague" });
    expect(plan({ events: [meeting([person("al@partner.test", "Al Partner")])], contacts: [bo] }))
      .toEqual({ kind: "skip", reason: "nothing-to-do" });
  });

  it("does not let a colleague on free mail block other free-mail attendees", () => {
    const bo = contact(5, "bo@gmail.com", { isColleague: true, name: "Bo Colleague" });
    const al = person("al@gmail.com", "Al Gmail");
    expect(plan({ events: [meeting([al])], contacts: [bo] }))
      .toEqual({ kind: "apply", add: [], create: [{ participant: al, name: "Al Gmail", parentId: null }] });
  });

  it("pins the accepted limit: a UPN domain unlike the mail domain lets coworkers, the user included, be created", () => {
    const pat = person("pat@corp.test", "Pat Coworker");
    expect(plan({ ownAddress: "me@corp.onmicrosoft.com", events: [meeting([pat])], contacts: [CFO] }))
      .toEqual({
        kind: "apply",
        add: [],
        create: [
          { participant: ME, name: "Me", parentId: null },
          { participant: pat, name: "Pat Coworker", parentId: null },
        ],
      });
  });

  it("prefills the company inferred from the address domain", () => {
    const acme = contact(50, null, { isCompany: true, name: "Acme" });
    const ops = contact(51, "ops@acme.example", { parentId: 50, name: "Ops Desk" });
    const neu = person("new@acme.example", "New Person");
    expect(plan({ events: [meeting([neu])], contacts: [acme, ops] }))
      .toEqual({ kind: "apply", add: [], create: [{ participant: neu, name: "New Person", parentId: 50 }] });
  });

  it("skips everything when the adds and creates do not all fit", () => {
    const events = [meeting([person("cfo@acme.example"), person("ana@newco.example", "Ana Newco")])];
    expect(plan({ events, contacts: [CFO], targets: [lead(1), lead(2), lead(3), lead(4)] }))
      .toEqual({ kind: "skip", reason: "over-cap" });
  });

  it("applies when they fit exactly", () => {
    const ana = person("ana@newco.example", "Ana Newco");
    const events = [meeting([person("cfo@acme.example"), ana])];
    expect(plan({ events, contacts: [CFO], targets: [lead(1), lead(2), lead(3)] }))
      .toEqual({ kind: "apply", add: [CFO], create: [{ participant: ana, name: "Ana Newco", parentId: null }] });
  });
});

describe("isCalendarAutoSelectEnabled", () => {
  beforeEach(() => {
    vi.mocked(localStorage.getItem).mockReset();
  });

  it.each([
    [null, true],
    ["true", true],
    ["garbage", true],
    ["false", false],
  ])("reads stored %s as %s", (stored, expected) => {
    vi.mocked(localStorage.getItem).mockImplementation((key: string) =>
      key === "calendar_auto_select_enabled" ? stored : null
    );
    expect(isCalendarAutoSelectEnabled()).toBe(expected);
  });
});
