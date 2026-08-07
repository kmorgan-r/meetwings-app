import { describe, expect, it } from "vitest";
import { compareContacts, filterContacts } from "@/lib/odoo/contact-ordering";
import { decideSync } from "@/lib/odoo/sync-decisions";
import { computeWatermark, minusOneSecond } from "@/lib/odoo/watermark";
import type { OdooContact } from "@/types";

describe("minusOneSecond", () => {
  it("subtracts one second in UTC", () => {
    expect(minusOneSecond("2026-08-04 12:00:00")).toBe("2026-08-04 11:59:59");
  });

  it("crosses a day boundary", () => {
    expect(minusOneSecond("2026-08-05 00:00:00")).toBe("2026-08-04 23:59:59");
  });

  // new Date("2026-08-04 12:00:00") is parsed by V8 as LOCAL time, so a naive
  // parse -> subtract -> reformat on a UTC+2 machine moves the watermark two
  // hours FORWARD and permanently skips every partner written in that window.
  // On a UTC CI runner that bug passes and fails nowhere.
  it("is unchanged under a non-UTC TZ", () => {
    const original = process.env.TZ;
    process.env.TZ = "Pacific/Auckland";
    try {
      expect(minusOneSecond("2026-08-04 12:00:00")).toBe("2026-08-04 11:59:59");
    } finally {
      // `process.env.TZ = undefined` writes the STRING "undefined", leaving an
      // invalid timezone in the worker for every later test file. TZ is
      // normally unset on Windows, so that is the common path, not the edge.
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  });
});

describe("computeWatermark", () => {
  it("returns null when the run returned no rows, so the cursor does not move", () => {
    expect(computeWatermark(null, "2026-08-04 12:00:00")).toBeNull();
  });

  it("is max(write_date) minus one second when the max is behind run start", () => {
    expect(computeWatermark("2026-08-04 11:00:00", "2026-08-04 12:00:00")).toBe(
      "2026-08-04 10:59:59"
    );
  });

  // A record edited at T BEHIND the keyset cursor, plus any record ahead of the
  // cursor edited at T+2, gives max = T+2 and a watermark of T+1 - so the
  // record at T is skipped PERMANENTLY. Clamping to run start is what stops it.
  it("clamps to run start so an edit behind the cursor is caught next run", () => {
    expect(computeWatermark("2026-08-04 12:00:02", "2026-08-04 12:00:00")).toBe(
      "2026-08-04 11:59:59"
    );
  });

  it("skips the clamp when the server Date header was absent", () => {
    expect(computeWatermark("2026-08-04 12:00:02", null)).toBe("2026-08-04 12:00:01");
  });
});

describe("decideSync", () => {
  const base = {
    trigger: "app-start" as const,
    hasCredentials: true,
    lastSyncAt: null,
    now: 10_000_000,
    meetingMode: false,
  };
  const HOUR = 60 * 60 * 1000;

  it("runs on app start when nothing has ever synced", () => {
    expect(decideSync(base)).toBe("run");
  });

  it("skips without credentials, whatever the trigger", () => {
    expect(decideSync({ ...base, hasCredentials: false })).toBe("skip-no-credentials");
    expect(decideSync({ ...base, trigger: "refresh", hasCredentials: false })).toBe(
      "skip-no-credentials"
    );
  });

  it("skips an app-start sync that is under an hour old, and runs one over", () => {
    expect(decideSync({ ...base, lastSyncAt: base.now - HOUR + 1 })).toBe("skip-recent");
    expect(decideSync({ ...base, lastSyncAt: base.now - HOUR - 1 })).toBe("run");
  });

  // A several-thousand-row first pull during a live call is not something to
  // schedule for the user.
  it("refuses an app-start sync during a meeting", () => {
    expect(decideSync({ ...base, meetingMode: true })).toBe("skip-in-meeting");
  });

  it.each(["refresh", "settings"] as const)(
    "lets %s override both the one-hour rule and the meeting refusal",
    (trigger) => {
      expect(
        decideSync({ ...base, trigger, meetingMode: true, lastSyncAt: base.now })
      ).toBe("run");
    }
  );
});

function c(over: Partial<OdooContact>): OdooContact {
  return {
    id: 1,
    name: "Zed",
    email: null,
    phone: null,
    companyName: null,
    parentId: null,
    isCompany: false,
    active: true,
    writeDate: "2026-08-01 10:00:00",
    isColleague: false,
    lastMeetingAt: null,
    ...over,
  };
}

describe("compareContacts", () => {
  it("puts colleagues above everyone", () => {
    const sorted = [c({ name: "Ann" }), c({ name: "Bob", isColleague: true })].sort(
      compareContacts
    );
    expect(sorted.map((x) => x.name)).toEqual(["Bob", "Ann"]);
  });

  it("puts recent meetings above never-met, then falls back to name", () => {
    const sorted = [
      c({ name: "Cara" }),
      c({ name: "Ann" }),
      c({ name: "Bob", lastMeetingAt: 500 }),
    ].sort(compareContacts);
    expect(sorted.map((x) => x.name)).toEqual(["Bob", "Ann", "Cara"]);
  });

  // SQLite sorts NULLs last under DESC; a hand-written JS comparator on null
  // does not, unless told to. Every contact you have never met is this case.
  it("sorts a null last_meeting_at last, not first", () => {
    const sorted = [c({ name: "Ann" }), c({ name: "Bob", lastMeetingAt: 1 })].sort(
      compareContacts
    );
    expect(sorted.map((x) => x.name)).toEqual(["Bob", "Ann"]);
  });

  it("orders more recent above less recent", () => {
    const sorted = [
      c({ name: "Ann", lastMeetingAt: 1 }),
      c({ name: "Bob", lastMeetingAt: 9 }),
    ].sort(compareContacts);
    expect(sorted.map((x) => x.name)).toEqual(["Bob", "Ann"]);
  });
});

describe("filterContacts", () => {
  const list = [
    c({ id: 1, name: "Øyvind Berg", email: "oy@nord.no", companyName: "Nord AS" }),
    // FORM MATTERS HERE, and it is invisible in a rendered diff: this fixture is
    // PRECOMPOSED U+00E9 / U+00ED, while the query in the NFD case below is
    // "Jose" + U+0301, the combining acute. Verified by codepoint, not by
    // eyeballing - the two render identically. Do not let an editor or a
    // formatter normalize either side; if both end up in the same form the NFD
    // test passes with .normalize() removed and stops testing anything.
    c({ id: 2, name: "José García", email: null, companyName: null }),
    c({ id: 3, name: "Plain Person", email: null, companyName: "100% Cotton" }),
  ];

  it("returns everything for an empty query", () => {
    expect(filterContacts(list, "  ")).toHaveLength(3);
  });

  // The picker sorts filterContacts' output in place. Returning the caller's
  // own array on the empty-query path - which is the DEFAULT state every time
  // the popover opens - therefore reorders the cache during render. That exact
  // bug already shipped once in this repo; see
  // src/tests/message-list.no-mutation.test.tsx.
  it("never returns the caller's own array, so a caller may sort it", () => {
    const out = filterContacts(list, "  ");
    expect(out).not.toBe(list);
    out.sort((a, b) => b.id - a.id);
    expect(list.map((x) => x.id)).toEqual([1, 2, 3]);
  });

  // SQLite's LIKE is case-insensitive for ASCII only, which is why this is
  // filtered in JS rather than in SQL.
  it("folds case on a non-ASCII name", () => {
    expect(filterContacts(list, "øyvind").map((x) => x.id)).toEqual([1]);
  });

  // The Ø case alone does NOT exercise NFD: U+00D8 has no canonical
  // decomposition, so a build that dropped .normalize() stays green.
  //
  // This query is "Jose" + U+0301 (combining acute) against a PRECOMPOSED
  // U+00E9 fixture - different forms, which is the whole point. Both render as
  // "José", so a reviewer reading the rendered text cannot tell them apart;
  // check codepoints before concluding this case is vacuous.
  it("matches a precomposed name from a decomposed query", () => {
    expect(filterContacts(list, "José").map((x) => x.id)).toEqual([2]);
  });

  it("matches on email and company name", () => {
    expect(filterContacts(list, "nord.no").map((x) => x.id)).toEqual([1]);
    expect(filterContacts(list, "cotton").map((x) => x.id)).toEqual([3]);
  });

  // Unescaped in a LIKE pattern, a typed % matches the entire cache. Here it
  // is just a character.
  it("treats % and _ literally", () => {
    expect(filterContacts(list, "%").map((x) => x.id)).toEqual([3]);
    expect(filterContacts(list, "_")).toEqual([]);
  });

  it("does not throw on rows with a null email or company name", () => {
    expect(() => filterContacts(list, "z")).not.toThrow();
  });
});
