import { describe, expect, it } from "vitest";
import { normalizeName, similar, similarContacts } from "@/lib/calendar/similar-contacts";
import type { OdooContact } from "@/types";

function contact(id: number, name: string, over: Partial<OdooContact> = {}): OdooContact {
  return {
    id,
    name,
    email: `c${id}@acme.example`,
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

const like = (a: string, b: string) => similar(normalizeName(a), normalizeName(b));

describe("normalizeName", () => {
  it("drops single-character tokens so an initial cannot match every name", () => {
    expect([...normalizeName("J Doe")]).toEqual(["doe"]);
  });

  it("folds diacritics", () => {
    expect([...normalizeName("José García")].sort()).toEqual(["garcia", "jose"]);
  });

  // Elision marks are REMOVED. Spacing them instead splits O'Brien into
  // {brien}, which shares nothing with OBrien's {obrien}.
  it("removes apostrophes rather than spacing them", () => {
    expect([...normalizeName("O'Brien")]).toEqual(["obrien"]);
    expect([...normalizeName("O’Brien")]).toEqual(["obrien"]);
    expect([...normalizeName("J. Doe")]).toEqual(["doe"]);
  });

  // Everything else becomes a space. Stripping hyphens instead would make
  // Doe-Smith the single token "doesmith".
  it("spaces hyphens rather than removing them", () => {
    expect([...normalizeName("Jane Doe-Smith")].sort()).toEqual(["doe", "jane", "smith"]);
  });

  it("returns an empty set for a name with nothing usable in it", () => {
    expect(normalizeName("  -  ").size).toBe(0);
  });
});

describe("similar", () => {
  it("matches on two shared tokens and not on one", () => {
    expect(like("Jane Doe", "Jane Doe")).toBe(true);
    expect(like("Jane Doe", "Jane Roe")).toBe(false);
  });

  it("does not match two different single-letter first names", () => {
    expect(like("J Doe", "J Smith")).toBe(false);
  });

  it("matches O'Brien against OBrien, alone and in a full name", () => {
    expect(like("O'Brien", "OBrien")).toBe(true);
    expect(like("Jane O'Brien", "Jane OBrien")).toBe(true);
  });

  it("matches a curly apostrophe against a straight one", () => {
    expect(like("O’Brien", "O'Brien")).toBe(true);
  });

  it("matches a hyphenated surname against its unhyphenated half", () => {
    expect(like("Jane Doe-Smith", "Jane Doe")).toBe(true);
  });

  it("matches equal mononyms and rejects unequal ones", () => {
    expect(like("Cher", "Cher")).toBe(true);
    expect(like("Cher", "Prince")).toBe(false);
  });

  // The clause requires BOTH sets to be single-token. Relaxing it to "either"
  // makes a one-token candidate match every multi-token name containing that
  // token - the one-shared-token case the >= 2 threshold exists to reject.
  it("does not match a one-token name against a two-token name sharing it", () => {
    expect(like("Jane", "Jane Doe")).toBe(false);
  });

  it("never matches when either side normalises to nothing", () => {
    expect(like("", "Jane Doe")).toBe(false);
    expect(like("-", "-")).toBe(false);
  });
});

describe("similarContacts", () => {
  const args = (contacts: OdooContact[]) => ({
    name: "Jane Doe",
    address: "jane.doe@acme.example",
    contacts,
  });

  it("returns the similar contacts", () => {
    const out = similarContacts(args([contact(1, "Jane Doe"), contact(2, "Bob Stone")]));
    expect(out.map((c) => c.id)).toEqual([1]);
  });

  it("filters out colleagues, archived contacts and the attendee's own email", () => {
    const out = similarContacts(
      args([
        contact(1, "Jane Doe", { isColleague: true }),
        contact(2, "Jane Doe", { active: false }),
        contact(3, "Jane Doe", { email: "JANE.DOE@Acme.Example" }),
        contact(4, "Jane Doe"),
      ])
    );
    expect(out.map((c) => c.id)).toEqual([4]);
  });

  it("keeps a candidate whose email is null", () => {
    const out = similarContacts(args([contact(1, "Jane Doe", { email: null })]));
    expect(out.map((c) => c.id)).toEqual([1]);
  });

  it("caps at three and orders by recency with nulls last", () => {
    const out = similarContacts(
      args([
        contact(1, "Jane Doe", { lastMeetingAt: null }),
        contact(2, "Jane Doe", { lastMeetingAt: 100 }),
        contact(3, "Jane Doe", { lastMeetingAt: 300 }),
        contact(4, "Jane Doe", { lastMeetingAt: 200 }),
      ])
    );
    expect(out.map((c) => c.id)).toEqual([3, 4, 2]);
  });

  it("does not mutate the caller's array", () => {
    const rows = [contact(2, "Jane Doe", { lastMeetingAt: 1 }), contact(1, "Jane Doe", { lastMeetingAt: 9 })];
    const before = rows.map((r) => r.id);
    similarContacts(args(rows));
    expect(rows.map((r) => r.id)).toEqual(before);
  });

  it("returns nothing when the attendee name normalises to nothing", () => {
    const out = similarContacts({ name: "  ", address: "x@y.test", contacts: [contact(1, "Jane Doe")] });
    expect(out).toEqual([]);
  });
});
