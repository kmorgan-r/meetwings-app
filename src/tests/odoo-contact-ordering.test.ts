import { describe, expect, it } from "vitest";
import { byRecency } from "@/lib/odoo/contact-ordering";
import type { OdooContact } from "@/types";

function contact(over: Partial<OdooContact> = {}): OdooContact {
  return {
    id: 1,
    name: "Contact",
    email: null,
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

describe("byRecency", () => {
  it("sorts most recently met first", () => {
    const rows = [
      contact({ id: 1, name: "Older", lastMeetingAt: 100 }),
      contact({ id: 2, name: "Newer", lastMeetingAt: 200 }),
    ].sort(byRecency);
    expect(rows.map((r) => r.name)).toEqual(["Newer", "Older"]);
  });

  // The field is nullable and "never met" is the common case; a contact never
  // logged to must not sort ahead of one that was.
  it("puts nulls last, whichever side they start on", () => {
    const never = contact({ id: 1, name: "Never", lastMeetingAt: null });
    const met = contact({ id: 2, name: "Met", lastMeetingAt: 5 });
    expect([never, met].sort(byRecency).map((r) => r.name)).toEqual(["Met", "Never"]);
    expect([met, never].sort(byRecency).map((r) => r.name)).toEqual(["Met", "Never"]);
  });

  it("breaks ties by name", () => {
    const rows = [
      contact({ id: 1, name: "Zoe", lastMeetingAt: 10 }),
      contact({ id: 2, name: "Ada", lastMeetingAt: 10 }),
    ].sort(byRecency);
    expect(rows.map((r) => r.name)).toEqual(["Ada", "Zoe"]);
  });
});
