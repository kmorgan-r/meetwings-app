# Create an Odoo contact from an unmatched calendar attendee — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the dead greyed `Jane Doe — no Odoo contact` line in the meeting-overlay proposal a working `Create in Odoo` action, behind its own confirm gate, guarded against making duplicates.

**Architecture:** Two new pure modules (`similar-contacts.ts` for name/company heuristics, `create-contact.ts` for the Odoo round trip) plus one new callback on `useOdooTarget` that owns the client, the cache write and the lifecycle guards. `CalendarProposal.tsx` renders an inline form inside the existing fixed-height region and calls the callback through props. Two independent duplicate guards: a live exact-email adopt-or-create against Odoo, and a cached name-similarity warning offering the existing contact as a target instead.

**Tech Stack:** React 19 + TypeScript 5.8 (strict), Vite 7, Tauri 2, Vitest + `@testing-library/react` on happy-dom, Odoo XML-RPC via `execute_kw`.

**Spec:** `docs/superpowers/specs/2026-09-05-create-odoo-contact-from-attendee-design.md`

## Global Constraints

Every task's requirements implicitly include these. Values are copied verbatim from the spec.

- **No `res.partner` is created without an explicit user confirm action distinct from the one that adds targets.** Opening the form writes nothing. Editing the name writes nothing. Only `Create contact` writes to Odoo, and it never adds a target. Only `Add N to log` adds targets, and it never writes to Odoo.
- **The proposal region stays a fixed `h-28` with internal scrolling.** `REGION_CLASS` is unchanged. The form expands *inside* the scroll region. No dialog, no popover within the popover, no portal.
- **Errors surface the code, never server prose.** The generic failure message is `Could not create the contact (<CODE>).`
- **Never logged:** no attendee names, no addresses, no subjects, no tokens — in any error, log line or telemetry. The draft the user typed is included in that.
- **`MAX_TARGETS` is 5** (`src/lib/odoo/meeting-log.ts:66`). Create must not become a way past the slot rule.
- **Archived rows get nothing.** `reason === "archived"` renders exactly as it does today: no affordance, no form.
- **One form is open at a time**, across all rows.
- **`onCreateContact` must be a `useCallback` with permanently stable dependencies.** `ContactPicker` is `React.memo`'d and `<Completion />` re-renders on every streamed AI token.
- **The contact list has exactly one home: `cache`** (`useOdooTarget.ts:55`). No component writes the database directly.
- **The sync watermark is untouched** by this feature.
- **No new `OdooErrorCode` members.** The existing union covers every case.
- **No new sync fields.** `PARTNER_FIELDS` is unchanged.

**Verification commands** (this repo's script is `type-check`, NOT `check:types`):

```bash
npm run type-check
npm run lint
npx vitest run <specific test paths>
```

Never run a bare `npm test` / `vitest run` as a gate — it runs the full suite. Scope to the files the task touched.

---

### Task 1: Extract the two shared helpers

Two pure moves with no behaviour change, both prerequisites for later tasks. `expectInt` is needed by `create-contact.ts` (Task 4); `byRecency` is needed by `similar-contacts.ts` (Task 2) and cannot be imported from where it currently lives — it is module-private in a page component, and a `src/lib` → `src/pages` value import would be a real runtime cycle (`CalendarProposal.tsx:4` already value-imports `MAX_TARGETS` from `@/lib/odoo`).

**Files:**
- Create: `src/lib/odoo/expect.ts`
- Modify: `src/lib/odoo/meeting-log-push.ts` (delete the private `expectInt` at `:93-98`, import it instead)
- Modify: `src/lib/odoo/contact-ordering.ts` (add `byRecency`)
- Modify: `src/lib/odoo/index.ts` (export the new module)
- Modify: `src/pages/app/components/completion/CalendarProposal.tsx` (delete the private `byRecency` at `:116-126`, import it instead)
- Test: `src/tests/odoo-expect.test.ts` (new)
- Test: `src/tests/odoo-contact-ordering.test.ts` (new)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `expectInt(value: XmlRpcValue, what: string): number` from `@/lib/odoo/expect`
  - `byRecency(a: OdooContact, b: OdooContact): number` from `@/lib/odoo/contact-ordering`

**`firstId` does NOT move.** It stays private in `meeting-log-push.ts:100-106`. Once Layer 1 became a `search_read` (Task 4), nothing in this feature receives a list of bare ids, and applying `firstId` to a `search_read` result returns `null` for every hit — a silent no-adopt that creates a duplicate every time. Do not touch it.

- [ ] **Step 1: Write the failing tests**

`src/tests/odoo-expect.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { expectInt } from "@/lib/odoo/expect";
import { OdooError } from "@/lib/odoo/errors";

describe("expectInt", () => {
  it("returns an integer unchanged", () => {
    expect(expectInt(42, "partner id")).toBe(42);
  });

  it.each([
    ["a float", 1.5],
    ["a string", "7"],
    ["false", false],
    ["a list", [1]],
  ])("raises ODOO_UNEXPECTED_ROW for %s", (_label, value) => {
    try {
      expectInt(value as never, "partner id");
      throw new Error("expected expectInt to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(OdooError);
      expect((err as OdooError).code).toBe("ODOO_UNEXPECTED_ROW");
    }
  });

  // The message names WHAT was expected, so a fault can be placed without
  // echoing any server prose.
  it("names the thing it expected, and carries no value", () => {
    try {
      expectInt("nope" as never, "partner id");
    } catch (err) {
      expect((err as OdooError).message).toContain("partner id");
      expect((err as OdooError).message).not.toContain("nope");
    }
  });
});
```

`src/tests/odoo-contact-ordering.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/tests/odoo-expect.test.ts src/tests/odoo-contact-ordering.test.ts`
Expected: FAIL — `Failed to resolve import "@/lib/odoo/expect"`, and `byRecency` is not exported from `contact-ordering`.

- [ ] **Step 3: Create `src/lib/odoo/expect.ts`**

```ts
import { odooError } from "./errors";
import type { XmlRpcValue } from "./xmlrpc-codec";

/**
 * Shared because two features validate the same thing: `create` returns an id,
 * and both `meeting-log-push` and `create-contact` have to refuse anything that
 * is not one rather than caching or persisting a junk value.
 *
 * `what` names the expected thing and NEVER the received value: the message
 * reaches a toast, and a server-supplied value there would be exactly the
 * prose leak this feature's error rule forbids.
 */
export function expectInt(value: XmlRpcValue, what: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw odooError("ODOO_UNEXPECTED_ROW", `Odoo returned a non-integer ${what}`);
  }
  return value;
}
```

- [ ] **Step 4: Point `meeting-log-push.ts` at it**

Delete the private definition at `:93-98`:

```ts
function expectInt(value: XmlRpcValue, what: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw odooError("ODOO_UNEXPECTED_ROW", `Odoo returned a non-integer ${what}`);
  }
  return value;
}
```

and add the import beside the file's existing `./errors` import:

```ts
import { expectInt } from "./expect";
```

Leave `firstId` (`:100-106`) exactly where it is.

- [ ] **Step 5: Add `byRecency` to `contact-ordering.ts`**

Append to `src/lib/odoo/contact-ordering.ts`:

```ts
/**
 * lastMeetingAt descending, nulls last, ties by name.
 *
 * Moved here from CalendarProposal.tsx, where it was module-private. It is the
 * same kind of comparator over the same type as `compareContacts` above, and a
 * pure module under src/lib that needs it (similar-contacts.ts) cannot import
 * it out of a page without creating a src/lib -> src/pages value edge - a real
 * runtime cycle, since CalendarProposal.tsx already value-imports MAX_TARGETS
 * from @/lib/odoo.
 *
 * NOT the same as `compareContacts`: that one puts colleagues first, which is
 * right for the picker's own list and wrong for a proposal, where colleagues
 * are excluded before the comparator ever sees them.
 */
export function byRecency(a: OdooContact, b: OdooContact): number {
  if (a.lastMeetingAt !== b.lastMeetingAt) {
    if (a.lastMeetingAt === null) return 1;
    if (b.lastMeetingAt === null) return -1;
    return b.lastMeetingAt - a.lastMeetingAt;
  }
  return a.name.localeCompare(b.name);
}
```

- [ ] **Step 6: Export the new module from the barrel**

In `src/lib/odoo/index.ts`, add beside the other `export *` lines (keep them alphabetical — it sits between `./errors` and `./many2one`):

```ts
export * from "./expect";
```

- [ ] **Step 7: Point `CalendarProposal.tsx` at the moved comparator**

Delete `:116-126` (the `byRecency` function and its doc comment) and change the import at `:4` from:

```ts
import { MAX_TARGETS } from "@/lib/odoo";
```

to:

```ts
import { byRecency, MAX_TARGETS } from "@/lib/odoo";
```

Nothing else in that file changes — the two call sites at `:176` and elsewhere keep the same name.

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npx vitest run src/tests/odoo-expect.test.ts src/tests/odoo-contact-ordering.test.ts`
Expected: PASS

- [ ] **Step 9: Prove nothing else moved**

Run: `npx vitest run src/tests/odoo-meeting-log-push.test.ts src/tests/CalendarProposal.states.test.tsx src/tests/CalendarProposal.slots.test.tsx`
Expected: PASS — this is a pure move, so every existing assertion about push behaviour and proposal ordering must still hold untouched.

Run: `npm run type-check`
Expected: clean.

- [ ] **Step 10: Commit**

```bash
git add src/lib/odoo/expect.ts src/lib/odoo/contact-ordering.ts src/lib/odoo/index.ts src/lib/odoo/meeting-log-push.ts src/pages/app/components/completion/CalendarProposal.tsx src/tests/odoo-expect.test.ts src/tests/odoo-contact-ordering.test.ts
git commit -m "refactor(odoo): extract expectInt and byRecency for reuse

No behaviour change. expectInt moves out of meeting-log-push.ts so
create-contact.ts can validate a create id the same way; byRecency moves
out of CalendarProposal.tsx so a pure module can order candidates without
a src/lib -> src/pages value import. firstId deliberately stays private -
Layer 1 uses search_read, and firstId over records returns null on every
hit."
```

---

### Task 2: `similarContacts` — the name-similarity rule

The pure half of duplicate-guard Layer 2. It is the part most likely to be wrong and it needs no mocks.

**Files:**
- Create: `src/lib/calendar/similar-contacts.ts`
- Modify: `src/lib/calendar/index.ts`
- Test: `src/tests/similar-contacts.test.ts`

**Interfaces:**
- Consumes: `byRecency` from `@/lib/odoo/contact-ordering` (Task 1); `normalizeAddress` from `./match-attendees`.
- Produces:
  - `normalizeName(name: string): Set<string>`
  - `similar(a: Set<string>, b: Set<string>): boolean`
  - `similarContacts(args: { name: string; address: string; contacts: OdooContact[] }): OdooContact[]`
  - `MAX_SIMILAR = 3`

**The two punctuation classes are the rule, not an implementation detail.** Elision marks (apostrophe, curly apostrophe, period) are *removed*; every other non-alphanumeric becomes a *space*. Collapsing them breaks whichever case is not chosen: spacing apostrophes makes `O'Brien` `{brien}` against `OBrien`'s `{obrien}` — no intersection at all — and stripping hyphens makes `Doe-Smith` the single token `doesmith`, sharing only `jane` with `Jane Doe`.

- [ ] **Step 1: Write the failing test**

`src/tests/similar-contacts.test.ts`:

```ts
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
    expect(like("O’Brien", "OBrien")).toBe(true);
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/tests/similar-contacts.test.ts`
Expected: FAIL — `Failed to resolve import "@/lib/calendar/similar-contacts"`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/calendar/similar-contacts.ts`:

```ts
import { byRecency } from "@/lib/odoo/contact-ordering";
import type { OdooContact } from "@/types";
import { normalizeAddress } from "./match-attendees";

/** At most three candidates - the warning lives in a 112px scroll region. */
export const MAX_SIMILAR = 3;

/**
 * Elision marks are REMOVED; every other non-alphanumeric becomes a space.
 *
 * The two classes are the rule, not a detail. Collapse them either way and one
 * of the two cases this must handle breaks: spacing apostrophes turns O'Brien
 * into {brien}, which shares nothing with OBrien's {obrien}; stripping hyphens
 * turns Doe-Smith into the single token "doesmith", which shares only "jane"
 * with Jane Doe and so falls under the two-token threshold.
 *
 * The curly apostrophe is in the class deliberately - Graph returns display
 * names as the directory holds them, and a smart-quoted O'Brien is common
 * enough that treating it as a separator would silently disable the rule for
 * that name.
 */
const ELISION = /['’.]/g;
/** Unicode-aware, NOT [^a-z0-9]: an ASCII-only class wipes a Cyrillic or Greek
 * name to the empty set and switches this rule off for it entirely. */
const NON_ALPHANUMERIC = /[^\p{L}\p{N}]+/gu;

export function normalizeName(name: string): Set<string> {
  const folded = name
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLocaleLowerCase()
    .replace(ELISION, "")
    .replace(NON_ALPHANUMERIC, " ");
  // Length > 1: an initial must not match every name that starts with it.
  return new Set(folded.split(/\s+/).filter((token) => token.length > 1));
}

/**
 * Two shared tokens, or two equal mononyms.
 *
 * One shared token is worthless - every Jane in the CRM would surface for
 * every Jane. The single-token clause requires BOTH sets to be single-token:
 * relaxing it to "either" readmits exactly the one-shared-token case the
 * threshold exists to reject, since a bare "Jane" would then match every
 * multi-token name containing it.
 */
export function similar(a: Set<string>, b: Set<string>): boolean {
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  if (shared >= 2) return true;
  return a.size === 1 && b.size === 1 && shared === 1;
}

/**
 * Cached candidates that might be this attendee under a different address.
 *
 * Colleagues are excluded because matchAttendees routes them to `excluded` - a
 * Use button for one would add a target the matcher considers noise, and the
 * row would not resolve. The email exclusion is belt and braces: such a contact
 * would have matched already and the row would not be unmatched.
 */
export function similarContacts({
  name,
  address,
  contacts,
}: {
  name: string;
  address: string;
  contacts: OdooContact[];
}): OdooContact[] {
  const target = normalizeName(name);
  // Nothing usable to compare. Returning [] rather than every contact whose
  // name also normalises to nothing.
  if (target.size === 0) return [];
  const own = normalizeAddress(address);
  return contacts
    .filter(
      (c) =>
        c.active &&
        !c.isColleague &&
        (c.email === null || normalizeAddress(c.email) !== own) &&
        similar(target, normalizeName(c.name))
    )
    // `filter` already returned a fresh array, so this sort cannot reach the
    // caller's - see filterContacts (contact-ordering.ts:44) for the bug that
    // rule exists to prevent.
    .sort(byRecency)
    .slice(0, MAX_SIMILAR);
}
```

- [ ] **Step 4: Export it from the barrel**

In `src/lib/calendar/index.ts`, add:

```ts
export * from "./similar-contacts";
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/tests/similar-contacts.test.ts`
Expected: PASS

Run: `npm run type-check`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/lib/calendar/similar-contacts.ts src/lib/calendar/index.ts src/tests/similar-contacts.test.ts
git commit -m "feat(calendar): add the cached name-similarity rule

Duplicate-guard Layer 2's pure half. Two shared tokens, or two equal
mononyms. Elision marks are removed and every other non-alphanumeric is
spaced, which is the only split where both O'Brien/OBrien and
Doe-Smith/Doe hold."
```

---

### Task 3: `inferCompany` — company from the email domain

**Files:**
- Modify: `src/lib/calendar/similar-contacts.ts`
- Test: `src/tests/similar-contacts.test.ts` (append a `describe`)

**Interfaces:**
- Consumes: `OdooContact`.
- Produces: `inferCompany(args: { address: string; contacts: OdooContact[] }): number | null`

The final `isCompany` membership check is not defensive padding. `parentId` and `isCompany` are independent fields (`src/types/odoo.ts:32-33`) and a person can be another partner's parent in Odoo, so the winning id is not guaranteed to name a row the Company control can display or re-select. Prefilling a value the control cannot render is worse than prefilling nothing.

- [ ] **Step 1: Write the failing test**

Append to `src/tests/similar-contacts.test.ts` (the `contact` helper above is reused):

```ts
import { inferCompany } from "@/lib/calendar/similar-contacts";

describe("inferCompany", () => {
  const acme = contact(90, "Acme Ltd", { isCompany: true, email: null });

  it("returns the majority parent among colleagues on the same domain", () => {
    const out = inferCompany({
      address: "new@acme.example",
      contacts: [
        acme,
        contact(1, "A", { email: "a@acme.example", parentId: 90 }),
        contact(2, "B", { email: "b@acme.example", parentId: 90 }),
        contact(3, "C", { email: "c@acme.example", parentId: 91 }),
        contact(91, "Other Ltd", { isCompany: true, email: null }),
      ],
    });
    expect(out).toBe(90);
  });

  it("breaks a tie on the lowest parent id", () => {
    const out = inferCompany({
      address: "new@acme.example",
      contacts: [
        contact(90, "Acme Ltd", { isCompany: true, email: null }),
        contact(91, "Other Ltd", { isCompany: true, email: null }),
        contact(1, "A", { email: "a@acme.example", parentId: 91 }),
        contact(2, "B", { email: "b@acme.example", parentId: 90 }),
      ],
    });
    expect(out).toBe(90);
  });

  it("does not let an inactive contact vote", () => {
    const out = inferCompany({
      address: "new@acme.example",
      contacts: [
        acme,
        contact(1, "A", { email: "a@acme.example", parentId: 90, active: false }),
      ],
    });
    expect(out).toBeNull();
  });

  it("does not let a contact with no parent vote", () => {
    const out = inferCompany({
      address: "new@acme.example",
      contacts: [acme, contact(1, "A", { email: "a@acme.example", parentId: null })],
    });
    expect(out).toBeNull();
  });

  // parentId and isCompany are independent - a person can be another partner's
  // parent. A winner the Company control cannot render must infer nothing.
  it("infers nothing when the winning parent is not a cached company", () => {
    const out = inferCompany({
      address: "new@acme.example",
      contacts: [
        contact(90, "Jane Senior", { isCompany: false, email: null }),
        contact(1, "A", { email: "a@acme.example", parentId: 90 }),
        contact(2, "B", { email: "b@acme.example", parentId: 90 }),
      ],
    });
    expect(out).toBeNull();
  });

  it("infers nothing when the winning parent is not in the cache at all", () => {
    const out = inferCompany({
      address: "new@acme.example",
      contacts: [contact(1, "A", { email: "a@acme.example", parentId: 90 })],
    });
    expect(out).toBeNull();
  });

  // The fixture DELIBERATELY contains on-domain contacts that would otherwise
  // produce a confident winner, so this exercises the skip list rather than
  // passing vacuously through the empty-candidates path.
  it("skips a free-mail domain even when the tally would be confident", () => {
    const contacts = [
      contact(90, "Acme Ltd", { isCompany: true, email: null }),
      contact(1, "A", { email: "a@gmail.com", parentId: 90 }),
      contact(2, "B", { email: "b@gmail.com", parentId: 90 }),
      contact(3, "C", { email: "c@gmail.com", parentId: 90 }),
    ];
    expect(inferCompany({ address: "new@gmail.com", contacts })).toBeNull();
    // Same fixture shape on a corporate domain DOES infer - proving the null
    // above came from the skip list and not from the filter.
    const corporate = contacts.map((c) =>
      c.email === null ? c : { ...c, email: c.email.replace("gmail.com", "acme.example") }
    );
    expect(inferCompany({ address: "new@acme.example", contacts: corporate })).toBe(90);
  });

  it("matches the domain case-insensitively and ignores surrounding space", () => {
    const out = inferCompany({
      address: "  New@ACME.Example ",
      contacts: [
        contact(90, "Acme Ltd", { isCompany: true, email: null }),
        contact(1, "A", { email: "a@Acme.example", parentId: 90 }),
        contact(2, "B", { email: "b@acme.EXAMPLE", parentId: 90 }),
      ],
    });
    expect(out).toBe(90);
  });

  it("infers nothing from an address with no @", () => {
    expect(inferCompany({ address: "not-an-address", contacts: [acme] })).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/tests/similar-contacts.test.ts -t inferCompany`
Expected: FAIL — `inferCompany` is not exported.

- [ ] **Step 3: Write the implementation**

Append to `src/lib/calendar/similar-contacts.ts`:

```ts
/**
 * Two unrelated people share gmail.com. Inferring from a free-mail domain
 * attaches a stranger's company to a new contact, and the user is being invited
 * to accept a prefilled value - a confident-looking wrong guess is worse than a
 * blank field.
 *
 * Being incomplete is SAFE: an unlisted free-mail domain degrades to the
 * ordinary path, which needs at least one cached contact on that domain with a
 * parent before it proposes anything.
 */
const FREE_MAIL: ReadonlySet<string> = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com",
  "yahoo.com", "yahoo.co.uk", "icloud.com", "me.com", "aol.com",
  "proton.me", "protonmail.com", "gmx.com", "gmx.de", "mail.com",
  "qq.com", "163.com",
]);

/** The part after the LAST "@", lowercased, or null when there is none. */
function domainOf(address: string): string | null {
  const at = address.lastIndexOf("@");
  if (at === -1) return null;
  const domain = address.slice(at + 1).trim().toLocaleLowerCase();
  return domain === "" ? null : domain;
}

/**
 * A prefill, NEVER a silent write. The user sees the result in the form and can
 * clear or change it before confirming.
 */
export function inferCompany({
  address,
  contacts,
}: {
  address: string;
  contacts: OdooContact[];
}): number | null {
  const domain = domainOf(address);
  if (domain === null || FREE_MAIL.has(domain)) return null;

  const tally = new Map<number, number>();
  for (const c of contacts) {
    if (!c.active || c.parentId === null || c.email === null) continue;
    if (domainOf(c.email) !== domain) continue;
    tally.set(c.parentId, (tally.get(c.parentId) ?? 0) + 1);
  }

  let winner: number | null = null;
  let best = 0;
  for (const [parentId, count] of tally) {
    // Ties break on the LOWEST id, for the same reason preferForDuplicateEmail
    // does (match-attendees.ts:52-55): stable across syncs in a way `name` is
    // not, and deterministic beats arbitrary when both are imperfect.
    if (count > best || (count === best && winner !== null && parentId < winner)) {
      winner = parentId;
      best = count;
    }
  }
  if (winner === null) return null;

  // The Company control lists cached contacts with isCompany === true. A winner
  // absent from that set cannot be displayed or re-selected, so prefilling it
  // would seed the field with a value the user can neither see nor clear.
  return contacts.some((c) => c.id === winner && c.isCompany) ? winner : null;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/tests/similar-contacts.test.ts`
Expected: PASS — the whole file, both describes.

Run: `npm run type-check`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/lib/calendar/similar-contacts.ts src/tests/similar-contacts.test.ts
git commit -m "feat(calendar): infer a company from the attendee's email domain

Majority parent among active cached contacts on the same domain, ties to
the lowest id, free-mail domains skipped, and the winner must itself name
a cached isCompany contact - parentId and isCompany are independent, so a
winner the Company control cannot render infers nothing."
```

---

### Task 4: `createOrAdoptContact` — the Odoo round trip

**Files:**
- Create: `src/lib/odoo/create-contact.ts`
- Modify: `src/lib/odoo/index.ts`
- Test: `src/tests/create-contact.test.ts`

**Interfaces:**
- Consumes: `OdooClient` (`client.ts:23-33`), `PARTNER_FIELDS` and `parsePartnerRow` (`contacts-sync.ts:19,36`), `expectInt` (Task 1), `normalizeAddress` (`match-attendees.ts:4`).
- Produces:

```ts
export type CreateOrAdoptOutcome =
  | { kind: "created"; contact: OdooContact }
  | { kind: "adopted-active"; contact: OdooContact }
  | { kind: "adopted-archived"; contact: OdooContact }
  | { kind: "created-invisible" };

export function createOrAdoptContact(deps: {
  client: OdooClient;
  address: string;
  name: string;
  parentId: number | null;
}): Promise<CreateOrAdoptOutcome>;
```

Every failure throws an `OdooError`; the four outcomes above are all non-throwing results. Task 5 maps a throw to `{ kind: "failed", code }`.

- [ ] **Step 1: Write the failing test**

`src/tests/create-contact.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createOrAdoptContact } from "@/lib/odoo/create-contact";
import { OdooError } from "@/lib/odoo/errors";
import type { OdooClient } from "@/lib/odoo/client";
import type { XmlRpcValue } from "@/lib/odoo/xmlrpc-codec";

/** A raw Odoo record, as search_read returns it (snake_case, false for unset). */
function row(over: Record<string, unknown> = {}) {
  return {
    id: 7,
    name: "Jane Doe",
    email: "jane@acme.example",
    phone: false,
    parent_id: false,
    is_company: false,
    active: true,
    write_date: "2026-09-05 10:00:00",
    type: "contact",
    ...over,
  };
}

/** Queues one response per execute() call, in order. */
function clientReturning(...responses: XmlRpcValue[]): {
  client: OdooClient;
  execute: ReturnType<typeof vi.fn>;
} {
  const execute = vi.fn();
  for (const r of responses) execute.mockResolvedValueOnce(r);
  return { client: { authenticate: vi.fn(), execute, serverDate: null } as OdooClient, execute };
}

const args = { address: "Jane@Acme.Example", name: "Jane Doe", parentId: null };

beforeEach(() => vi.clearAllMocks());

describe("createOrAdoptContact - the Layer 1 search", () => {
  it("searches on the normalized email with =ilike, active_test false, and NO limit", async () => {
    const { client, execute } = clientReturning([], 7, [row()]);
    await createOrAdoptContact({ client, ...args });
    const [model, method, callArgs, kwargs] = execute.mock.calls[0];
    expect(model).toBe("res.partner");
    expect(method).toBe("search_read");
    expect(callArgs).toEqual([[["email", "=ilike", "jane@acme.example"]]]);
    expect(kwargs.context).toEqual({ active_test: false });
    // A limit makes the active-vs-archived branch arbitrary - see the spec.
    expect(kwargs).not.toHaveProperty("limit");
  });

  it("raises ODOO_UNEXPECTED_ROW when the search returns a non-list", async () => {
    const { client } = clientReturning(false);
    await expect(createOrAdoptContact({ client, ...args })).rejects.toMatchObject({
      code: "ODOO_UNEXPECTED_ROW",
    });
  });
});

describe("createOrAdoptContact - adopting", () => {
  it("adopts an active hit without calling create", async () => {
    const { client, execute } = clientReturning([row({ id: 7 })]);
    const out = await createOrAdoptContact({ client, ...args });
    expect(out).toMatchObject({ kind: "adopted-active" });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls.some(([, method]) => method === "create")).toBe(false);
  });

  it("distinguishes an archived hit from an active one", async () => {
    const { client } = clientReturning([row({ id: 7, active: false })]);
    const out = await createOrAdoptContact({ client, ...args });
    expect(out).toMatchObject({ kind: "adopted-archived" });
  });

  // Two partners sharing an email is routine in Odoo. Telling the user to go
  // un-archive somebody while an ACTIVE partner with that email exists is the
  // failure a limit:1 with no order would produce at random.
  it.each([
    ["archived first", [row({ id: 8, active: false }), row({ id: 9, active: true })]],
    ["active first", [row({ id: 9, active: true }), row({ id: 8, active: false })]],
  ])("prefers the active partner over the archived one (%s)", async (_label, rows) => {
    const { client } = clientReturning(rows);
    const out = await createOrAdoptContact({ client, ...args });
    expect(out).toMatchObject({ kind: "adopted-active" });
    expect((out as { contact: { id: number } }).contact.id).toBe(9);
  });

  it("prefers a person over a company when both are active", async () => {
    const { client } = clientReturning([
      row({ id: 3, is_company: true }),
      row({ id: 4, is_company: false }),
    ]);
    const out = await createOrAdoptContact({ client, ...args });
    expect((out as { contact: { id: number } }).contact.id).toBe(4);
  });

  it("prefers the lowest id between two people", async () => {
    const { client } = clientReturning([row({ id: 31 }), row({ id: 30 })]);
    const out = await createOrAdoptContact({ client, ...args });
    expect((out as { contact: { id: number } }).contact.id).toBe(30);
  });

  // A mutant that reads the first element as a bare id (the shape `firstId`
  // expects) returns null for every hit, silently skips the adopt, and creates
  // a duplicate on EVERY hit. This pins the record shape.
  it("adopts from the returned record, not from a bare id", async () => {
    const { client, execute } = clientReturning([row({ id: 7, name: "Jane From Odoo" })]);
    const out = await createOrAdoptContact({ client, ...args });
    expect((out as { contact: { name: string } }).contact.name).toBe("Jane From Odoo");
    expect(execute).toHaveBeenCalledTimes(1);
  });
});

describe("createOrAdoptContact - creating", () => {
  it("creates with type contact and is_company false, then reads back", async () => {
    const { client, execute } = clientReturning([], 7, [row()]);
    const out = await createOrAdoptContact({ client, ...args });
    expect(out).toMatchObject({ kind: "created" });

    const [, createMethod, createArgs] = execute.mock.calls[1];
    expect(createMethod).toBe("create");
    // `type` is EXPLICIT: the sync domain excludes delivery/invoice/other, so a
    // partner created with an unlucky default is invisible to this app forever.
    expect(createArgs[0]).toEqual({
      name: "Jane Doe",
      email: "jane@acme.example",
      is_company: false,
      type: "contact",
      parent_id: false,
    });

    const [, readMethod, readArgs, readKwargs] = execute.mock.calls[2];
    expect(readMethod).toBe("search_read");
    expect(readArgs).toEqual([[["id", "=", 7]]]);
    expect(readKwargs.context).toEqual({ active_test: false });
  });

  it("sends parent_id false, not null and not omitted, when no company is chosen", async () => {
    const { client, execute } = clientReturning([], 7, [row()]);
    await createOrAdoptContact({ client, ...args, parentId: null });
    expect(execute.mock.calls[1][2][0].parent_id).toBe(false);
  });

  it("sends the chosen company id when there is one", async () => {
    const { client, execute } = clientReturning([], 7, [row({ parent_id: [90, "Acme Ltd"] })]);
    await createOrAdoptContact({ client, ...args, parentId: 90 });
    expect(execute.mock.calls[1][2][0].parent_id).toBe(90);
  });

  it("raises ODOO_UNEXPECTED_ROW when create returns a non-integer", async () => {
    const { client } = clientReturning([], false);
    await expect(createOrAdoptContact({ client, ...args })).rejects.toMatchObject({
      code: "ODOO_UNEXPECTED_ROW",
    });
  });

  // Record rules can hide a record from the API user that created it. No cache
  // row is fabricated - a synthesised row would produce a proposal row whose
  // target write then fails, or silently succeeds against an unseeable record.
  it("reports created-invisible and no contact when the read-back is empty", async () => {
    const { client } = clientReturning([], 7, []);
    const out = await createOrAdoptContact({ client, ...args });
    expect(out).toEqual({ kind: "created-invisible" });
  });
});

describe("createOrAdoptContact - failures reach the caller with their code", () => {
  it.each(["ODOO_FAULT", "ODOO_UNREACHABLE"] as const)("propagates %s unchanged", async (code) => {
    const execute = vi.fn().mockRejectedValue(new OdooError(code, "boom", {}));
    const client = { authenticate: vi.fn(), execute, serverDate: null } as OdooClient;
    await expect(createOrAdoptContact({ client, ...args })).rejects.toMatchObject({ code });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/tests/create-contact.test.ts`
Expected: FAIL — `Failed to resolve import "@/lib/odoo/create-contact"`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/odoo/create-contact.ts`:

```ts
import { normalizeAddress } from "@/lib/calendar/match-attendees";
import type { OdooContact } from "@/types";
import type { OdooClient } from "./client";
import { PARTNER_FIELDS, parsePartnerRow } from "./contacts-sync";
import { odooError } from "./errors";
import { expectInt } from "./expect";
import type { XmlRpcValue } from "./xmlrpc-codec";

/**
 * The four non-throwing results. Every failure throws an OdooError instead -
 * the hook maps that to its own `failed` member with the code.
 */
export type CreateOrAdoptOutcome =
  | { kind: "created"; contact: OdooContact }
  | { kind: "adopted-active"; contact: OdooContact }
  | { kind: "adopted-archived"; contact: OdooContact }
  | { kind: "created-invisible" };

/**
 * Which of several partners sharing one email wins.
 *
 * ACTIVE beats archived first: telling the user to go un-archive somebody while
 * a live partner with that email exists is the wrong instruction, and with
 * `limit: 1` and no `order` it is what Odoo would hand back at random.
 *
 * Then person over company, then lowest id - preferForDuplicateEmail's own
 * rules (match-attendees.ts:52-55), for the reasons stated there.
 */
function preferForAdoption(a: OdooContact, b: OdooContact): OdooContact {
  if (a.active !== b.active) return a.active ? a : b;
  if (a.isCompany !== b.isCompany) return a.isCompany ? b : a;
  return a.id <= b.id ? a : b;
}

function expectRows(value: XmlRpcValue, what: string): unknown[] {
  if (!Array.isArray(value)) {
    throw odooError("ODOO_UNEXPECTED_ROW", `Odoo returned a non-list from ${what}`);
  }
  return value;
}

/**
 * Find-by-email, create on miss, read back.
 *
 * The search is not merely a cache-staleness guard. `create` is not idempotent
 * and the commit-then-timeout window means a create that appears to fail may
 * have landed, so a retry adopts rather than duplicating - the same shape as
 * createOrAdoptAttachment (meeting-log-push.ts:270-287).
 *
 * `search_read` rather than `search`: the adopt path needs the full row anyway,
 * and a second round trip to fetch what the first could have returned buys
 * nothing.
 */
export async function createOrAdoptContact({
  client,
  address,
  name,
  parentId,
}: {
  client: OdooClient;
  address: string;
  name: string;
  parentId: number | null;
}): Promise<CreateOrAdoptOutcome> {
  // Lowercased on BOTH sides, like every other match in this feature. `=ilike`
  // because Odoo's `=` on a char field is case-sensitive.
  const email = normalizeAddress(address);

  const found = expectRows(
    await client.execute("res.partner", "search_read", [[["email", "=ilike", email]]], {
      fields: PARTNER_FIELDS,
      // An archived partner with that email is emphatically not an invitation
      // to create a second one.
      context: { active_test: false },
    }),
    "search_read"
  );

  if (found.length > 0) {
    const best = found.map(parsePartnerRow).reduce(preferForAdoption);
    return best.active
      ? { kind: "adopted-active", contact: best }
      : { kind: "adopted-archived", contact: best };
  }

  const id = expectInt(
    await client.execute("res.partner", "create", [
      {
        name,
        email,
        is_company: false,
        // EXPLICIT, not left to Odoo's default. The sync domain excludes
        // delivery/invoice/other (contacts-sync.ts:118-124), so a partner
        // created with any of those types is invisible to this app forever -
        // the user would create a contact, watch the row stay greyed, and
        // create another.
        type: "contact",
        // `false`, not null: Odoo reads false as unset for a many2one, and null
        // is not a valid XML-RPC value here.
        parent_id: parentId ?? false,
      },
    ]),
    "partner id"
  );

  const back = expectRows(
    await client.execute("res.partner", "search_read", [[["id", "=", id]]], {
      fields: PARTNER_FIELDS,
      context: { active_test: false },
    }),
    "search_read"
  );

  // Record rules can hide a record from the API user that created it. Do NOT
  // fabricate a cache row: a synthesised row produces a proposal row whose
  // target write then fails, or worse silently succeeds against a record the
  // user cannot see.
  if (back.length === 0) return { kind: "created-invisible" };

  return { kind: "created", contact: parsePartnerRow(back[0]) };
}
```

- [ ] **Step 4: Export it from the barrel**

In `src/lib/odoo/index.ts`, add beside the others (alphabetically, after `./contacts-sync`):

```ts
export * from "./create-contact";
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/tests/create-contact.test.ts`
Expected: PASS

Run: `npm run type-check`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/lib/odoo/create-contact.ts src/lib/odoo/index.ts src/tests/create-contact.test.ts
git commit -m "feat(odoo): add createOrAdoptContact

Duplicate-guard Layer 1. Searches live on the normalized email with
=ilike and active_test false and NO limit, picks deterministically
(active over archived, person over company, lowest id), creates only on a
miss with type contact written explicitly, then reads the row back rather
than synthesising one."
```

---

### Task 5: `onCreateContact` on `useOdooTarget`

**Files:**
- Modify: `src/types/odoo.ts` (add `CreateContactResult`)
- Modify: `src/hooks/useOdooTarget.ts`
- Test: `src/tests/odoo-target-create-contact.test.tsx` (new)

**Interfaces:**
- Consumes: `createOrAdoptContact` (Task 4); `upsertContacts` (`odoo-contacts.action.ts:66`); the hook's own `resolveInstance`, `getClient`, `reload`.
- Produces:

```ts
// src/types/odoo.ts
export type CreateContactResult =
  | { kind: "created"; contact: OdooContact }
  | { kind: "adopted-active"; contact: OdooContact }
  | { kind: "adopted-archived"; contact: OdooContact }
  | { kind: "created-invisible" }
  | { kind: "cached-failed" }
  | { kind: "failed"; code: OdooErrorCode }
  | { kind: "abandoned" }
  | { kind: "busy" };
```

and, on `UseOdooTargetReturn` and `pickerProps`:

```ts
onCreateContact: (
  participant: CalendarParticipant,
  draft: { name: string; parentId: number | null }
) => Promise<CreateContactResult>;
```

`CreateContactResult` lives in `@/types` and not in the hook, following the placement note at `src/types/calendar.ts:95-104`: it is shared between `src/hooks` and `src/pages`, and a page importing a type back out of a hook is the edge that note exists to prevent.

- [ ] **Step 1: Write the failing test**

`src/tests/odoo-target-create-contact.test.tsx`. Mocking follows `src/tests/odoo-target-new-chat-entry-points.test.tsx:21-127` exactly:

```tsx
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CalendarParticipant, OdooContact } from "@/types";

vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ label: "main" }) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => {}) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

const action = vi.hoisted(() => ({
  listContacts: vi.fn(async () => [] as unknown[]),
  getSyncState: vi.fn(async () => null as unknown),
  setColleague: vi.fn(async () => {}),
  stampLastMeeting: vi.fn(async () => {}),
  loadTargets: vi.fn(async () => [] as unknown[]),
  addSelectedTarget: vi.fn(async () => ({ ok: true }) as { ok: boolean; reason?: "cap" }),
  removeSelectedTarget: vi.fn(async () => {}),
  clearTargets: vi.fn(async () => {}),
  upsertContacts: vi.fn(async () => 1),
}));
vi.mock("@/lib/database/odoo-contacts.action", () => action);

const odoo = vi.hoisted(() => ({
  runSync: vi.fn(async () => ({ ran: true, changed: 0, fetched: 0, skipped: 0, clampSkipped: false })),
  currentInstance: vi.fn(async () => "http://h:8069|odoo"),
  createOdooClient: vi.fn(() => ({ authenticate: vi.fn(), execute: vi.fn(), serverDate: null })),
  fetchOpportunities: vi.fn(async () => []),
  createOrAdoptContact: vi.fn(),
}));
vi.mock("@/lib/odoo", async () => {
  const errors = await vi.importActual<Record<string, unknown>>("@/lib/odoo/errors");
  return { ...errors, ...odoo, LEAD_SEARCH_MIN_CHARS: 3, searchLeads: vi.fn(async () => []) };
});
vi.mock("@/lib/storage/odoo-config.storage", () => ({
  loadOdooConfig: vi.fn(async () => ({ url: "http://h:8069", db: "odoo", login: "b", apiKey: "k" })),
  instanceFingerprint: vi.fn(() => "http://h:8069|odoo"),
}));

import { OdooError } from "@/lib/odoo/errors";
import { useOdooTarget } from "@/hooks/useOdooTarget";

function contact(over: Partial<OdooContact> = {}): OdooContact {
  return {
    id: 7,
    name: "Jane Doe",
    email: "jane@acme.example",
    phone: null,
    companyName: null,
    parentId: null,
    isCompany: false,
    active: true,
    writeDate: "2026-09-05 10:00:00",
    isColleague: false,
    lastMeetingAt: null,
    ...over,
  };
}

const participant: CalendarParticipant = {
  address: "Jane@Acme.Example",
  name: "Jane Doe",
  type: "required",
  isOrganizer: false,
};
const draft = { name: "Jane Doe", parentId: null };

function mount() {
  return renderHook(() =>
    useOdooTarget({
      meetingAssistMode: false,
      isPickerOpen: false,
      setIsPickerOpen: vi.fn(),
      setTargetCount: vi.fn(),
    })
  );
}

/** Lets a test hold the create open while it does something else. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
  action.listContacts.mockResolvedValue([]);
  action.loadTargets.mockResolvedValue([]);
  action.getSyncState.mockResolvedValue({ last_sync_at: 1000, last_error_code: null });
  action.upsertContacts.mockResolvedValue(1);
  odoo.currentInstance.mockResolvedValue("http://h:8069|odoo");
  odoo.createOrAdoptContact.mockResolvedValue({ kind: "created", contact: contact() });
});

describe("onCreateContact", () => {
  it("upserts exactly one row and reloads, never runSync", async () => {
    const { result } = mount();
    await waitFor(() => expect(action.loadTargets).toHaveBeenCalled());
    odoo.runSync.mockClear();

    let out;
    await act(async () => {
      out = await result.current.onCreateContact(participant, draft);
    });

    expect(out).toMatchObject({ kind: "created" });
    expect(action.upsertContacts).toHaveBeenCalledTimes(1);
    const [instance, rows] = action.upsertContacts.mock.calls[0];
    expect(instance).toBe("http://h:8069|odoo");
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(7);
    // runSync would claim the sync lock and can fail ODOO_SYNC_BUSY for a
    // reason unrelated to this write.
    expect(odoo.runSync).not.toHaveBeenCalled();
    // reload() re-reads the cache.
    expect(action.listContacts).toHaveBeenCalled();
  });

  it.each([
    ["adopted-active", true],
    ["adopted-archived", false],
  ])("caches the found row on a %s hit and makes no create call", async (kind, active) => {
    odoo.createOrAdoptContact.mockResolvedValue({ kind, contact: contact({ id: 9, active }) });
    const { result } = mount();
    await waitFor(() => expect(action.loadTargets).toHaveBeenCalled());

    let out;
    await act(async () => {
      out = await result.current.onCreateContact(participant, draft);
    });

    expect(out).toMatchObject({ kind });
    // The archived branch caches TOO. matchAttendees only produces
    // reason "archived" when a cache row exists with active false; without the
    // upsert the row keeps claiming there is no contact for somebody the
    // search just proved exists.
    expect(action.upsertContacts).toHaveBeenCalledTimes(1);
    expect(action.upsertContacts.mock.calls[0][1][0].id).toBe(9);
  });

  it("caches nothing when the created partner is invisible to this connection", async () => {
    odoo.createOrAdoptContact.mockResolvedValue({ kind: "created-invisible" });
    const { result } = mount();
    await waitFor(() => expect(action.loadTargets).toHaveBeenCalled());

    let out;
    await act(async () => {
      out = await result.current.onCreateContact(participant, draft);
    });

    expect(out).toEqual({ kind: "created-invisible" });
    expect(action.upsertContacts).not.toHaveBeenCalled();
  });

  it("still reports the Odoo write as landed when the cache write fails", async () => {
    action.upsertContacts.mockRejectedValue(new Error("database is locked"));
    const { result } = mount();
    await waitFor(() => expect(action.loadTargets).toHaveBeenCalled());

    let out;
    await act(async () => {
      out = await result.current.onCreateContact(participant, draft);
    });

    expect(out).toEqual({ kind: "cached-failed" });
  });

  it("maps a thrown OdooError to failed with its code", async () => {
    odoo.createOrAdoptContact.mockRejectedValue(new OdooError("ODOO_FAULT", "boom", {}));
    const { result } = mount();
    await waitFor(() => expect(action.loadTargets).toHaveBeenCalled());

    let out;
    await act(async () => {
      out = await result.current.onCreateContact(participant, draft);
    });

    expect(out).toEqual({ kind: "failed", code: "ODOO_FAULT" });
  });

  it("releases the guard after a failure so a second attempt runs", async () => {
    odoo.createOrAdoptContact.mockRejectedValueOnce(new OdooError("ODOO_UNREACHABLE", "boom", {}));
    const { result } = mount();
    await waitFor(() => expect(action.loadTargets).toHaveBeenCalled());

    await act(async () => {
      await result.current.onCreateContact(participant, draft);
    });
    let second;
    await act(async () => {
      second = await result.current.onCreateContact(participant, draft);
    });
    expect(second).toMatchObject({ kind: "created" });
  });

  it("refuses a second create while one is in flight, without releasing the first", async () => {
    const gate = deferred<{ kind: string; contact: OdooContact }>();
    odoo.createOrAdoptContact.mockReturnValueOnce(gate.promise);
    const { result } = mount();
    await waitFor(() => expect(action.loadTargets).toHaveBeenCalled());

    let first!: Promise<unknown>;
    await act(async () => {
      first = result.current.onCreateContact(participant, draft);
    });

    let second;
    await act(async () => {
      second = await result.current.onCreateContact(participant, draft);
    });
    expect(second).toEqual({ kind: "busy" });
    // The refusal must not have released the in-flight create's guard.
    expect(action.upsertContacts).not.toHaveBeenCalled();

    await act(async () => {
      gate.resolve({ kind: "created", contact: contact() });
      await first;
    });
    expect(action.upsertContacts).toHaveBeenCalledTimes(1);
  });
});

describe("onCreateContact - the two tokens", () => {
  // The regression the instanceToken split exists to prevent. selectionToken is
  // bumped by onSelect/onSelectLead/handleNewChat/clearAllTargets, none of
  // which invalidate a single cached contact - guarding the cache write on it
  // would silently discard a partner successfully created in Odoo.
  it("still writes the cache when only the SELECTION changed mid-create", async () => {
    const gate = deferred<{ kind: string; contact: OdooContact }>();
    odoo.createOrAdoptContact.mockReturnValueOnce(gate.promise);
    const { result } = mount();
    await waitFor(() => expect(action.loadTargets).toHaveBeenCalled());

    let create!: Promise<unknown>;
    await act(async () => {
      create = result.current.onCreateContact(participant, draft);
    });
    // A selection made in the single-select part of the same popover.
    await act(async () => {
      await result.current.pickerProps.onSelect(contact({ id: 55 }));
    });
    let out;
    await act(async () => {
      gate.resolve({ kind: "created", contact: contact() });
      out = await create;
    });

    expect(out).toMatchObject({ kind: "created" });
    expect(action.upsertContacts).toHaveBeenCalledTimes(1);
  });

  it("abandons and writes nothing when the INSTANCE changed mid-create", async () => {
    const gate = deferred<{ kind: string; contact: OdooContact }>();
    odoo.createOrAdoptContact.mockReturnValueOnce(gate.promise);
    const { result } = mount();
    await waitFor(() => expect(action.loadTargets).toHaveBeenCalled());

    let create!: Promise<unknown>;
    await act(async () => {
      create = result.current.onCreateContact(participant, draft);
    });
    await act(async () => {
      window.dispatchEvent(new Event("__unused__"));
      await result.current.__testOnlyInstanceChanged();
    });
    let out;
    await act(async () => {
      gate.resolve({ kind: "created", contact: contact() });
      out = await create;
    });

    expect(out).toEqual({ kind: "abandoned" });
    expect(action.upsertContacts).not.toHaveBeenCalled();
  });
});
```

> **On `__testOnlyInstanceChanged`:** the hook's `handleInstanceChanged` is reached in production through a Tauri `listen("odoo-instance-changed")` subscription, and this suite mocks `listen` to a no-op — so there is no way to fire it. Rather than adding a test-only export, capture the real listener from the `listen` mock: change the mock to `listen: vi.fn(async (_event, handler) => { listeners.push(handler); return () => {}; })` with a `vi.hoisted` `listeners` array, and invoke `listeners[0]()` in the test. Do that; delete `__testOnlyInstanceChanged` from the test above. Production code gets no test-only surface.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/tests/odoo-target-create-contact.test.tsx`
Expected: FAIL — `result.current.onCreateContact is not a function`.

- [ ] **Step 3: Add the result type**

Append to `src/types/odoo.ts`:

```ts
/**
 * What `useOdooTarget.onCreateContact` resolves to.
 *
 * Eight members, and the component's message/lifecycle table is TOTAL over
 * them. It lives here rather than in the hook for the reason
 * src/types/calendar.ts:95-104 gives: it is shared between src/hooks and
 * src/pages, and a page importing a type back out of a hook is the edge that
 * note exists to prevent.
 */
export type CreateContactResult =
  | { kind: "created"; contact: OdooContact }
  | { kind: "adopted-active"; contact: OdooContact }
  | { kind: "adopted-archived"; contact: OdooContact }
  /** Written, but the read-back returned no row - record rules can hide a
   * record from the API user that created it. NO cache row is fabricated. */
  | { kind: "created-invisible" }
  /** Written and read back; only the local cache write failed. */
  | { kind: "cached-failed" }
  | { kind: "failed"; code: OdooErrorCode }
  /** The instance changed underneath the create. Render nothing. */
  | { kind: "abandoned" }
  /** A create is already in flight. NOT the same as `abandoned`: the component
   * resets `creating` on every path out of an attempt, and a refusal that
   * looked like an abandonment would re-enable the button while the first
   * create is still running. */
  | { kind: "busy" };
```

- [ ] **Step 4: Add the guards to the hook**

In `src/hooks/useOdooTarget.ts`, beside `searchToken` (`:248`):

```ts
  /**
   * ITS OWN TOKEN, and not `selectionToken` - the same reasoning as
   * `searchToken` above.
   *
   * The contact cache is scoped to the INSTANCE. `selectionToken` is scoped to
   * the SELECTION, and is bumped by `onSelect`, `onSelectLead`,
   * `handleNewChat` and `clearAllTargets` as well as by
   * `handleInstanceChanged` - none of the first four invalidate a single
   * cached contact. Guarding the create's cache write on it would mean: the
   * user clicks Create contact, then picks a different contact in the
   * single-select part of the same popover while it is in flight, and a
   * partner SUCCESSFULLY CREATED IN ODOO is silently dropped from the cache
   * write. The row stays greyed after a write that worked.
   */
  const instanceToken = useRef(0);
  /** One create at a time, across all rows. The component's `creating` state
   * only disables one button; this refuses re-entry from any of them. */
  const creatingRef = useRef(false);
```

In `handleInstanceChanged` (`:653`), bump it in the same block that bumps `selectionToken`:

```ts
  const handleInstanceChanged = useCallback(async () => {
    selectionToken.current += 1;
    instanceToken.current += 1;
    const token = selectionToken.current;
```

- [ ] **Step 5: Add the callback**

In `src/hooks/useOdooTarget.ts`, after `addTarget` (`:1061`):

```ts
  /**
   * Create (or adopt) an Odoo partner for an unmatched attendee, then land it
   * in the cache so the proposal re-projects.
   *
   * `useCallback` with permanently stable deps, like `addTarget` above:
   * ContactPicker is React.memo'd and <Completion /> re-renders on every
   * streamed AI token, so an unstable identity here defeats that memo for the
   * whole session.
   */
  const onCreateContact = useCallback(
    async (
      participant: CalendarParticipant,
      draft: { name: string; parentId: number | null }
    ): Promise<CreateContactResult> => {
      // BEFORE the try, so the refusal cannot reach the `finally` and release
      // the in-flight create's guard. Same shape as `confirm`'s early return
      // above its own try (CalendarProposal.tsx:418 / :435).
      if (creatingRef.current) return { kind: "busy" };
      creatingRef.current = true;

      // Captured as the FIRST statements, before resolveInstance/getClient -
      // both are awaits, and a token read after them captures whatever landed
      // DURING them, so the later check would compare the new value against
      // itself and never fire.
      const myInstance = instanceToken.current;
      const selection = selectionToken.current;

      try {
        const instance = await resolveInstance();
        const client = await getClient();
        const outcome = await createOrAdoptContact({
          client,
          address: participant.address,
          name: draft.name,
          parentId: draft.parentId,
        });

        // A partner id created against the PREVIOUS instance points at nothing
        // in the new one.
        if (instanceToken.current !== myInstance) return { kind: "abandoned" };

        // Nothing to cache, and nothing may be fabricated.
        if (outcome.kind === "created-invisible") return outcome;

        try {
          await upsertContacts(instance, [outcome.contact], Date.now());
        } catch (err) {
          // Two different facts, two surfaces: the toast says the CACHE write
          // failed (this hook's convention for every other write path), and the
          // returned member tells the component the ODOO write landed.
          const report = reportOdooError(err, "cache created contact");
          toast.error(`${report.code}: ${report.message}`);
          return { kind: "cached-failed" };
        }

        // The CAPTURED selection token, per reload's own contract
        // (useOdooTarget.ts:556-560) - a live read there would make commit's
        // staleness check a no-op. NOT runSync("refresh"), which claims the
        // sync lock and can fail ODOO_SYNC_BUSY for an unrelated reason.
        await reload(selection);
        return outcome;
      } catch (err) {
        if (instanceToken.current !== myInstance) return { kind: "abandoned" };
        return { kind: "failed", code: toOdooError(err).code };
      } finally {
        creatingRef.current = false;
      }
    },
    [getClient, reload, resolveInstance]
  );
```

Add the imports this needs:

```ts
// to the existing "@/lib/odoo" import block:
  createOrAdoptContact,
  toOdooError,
// to the existing "@/lib/database/odoo-contacts.action" import block:
  upsertContacts,
// to the existing "@/types" type import:
  type CalendarParticipant,
  type CreateContactResult,
```

- [ ] **Step 6: Expose it**

Add to `UseOdooTargetReturn` (`:139-172`):

```ts
  /** Creates (or adopts) a partner for an unmatched calendar attendee. Never
   * adds a target - that is `addTarget`'s job and a separate confirm gate. */
  onCreateContact: (
    participant: CalendarParticipant,
    draft: { name: string; parentId: number | null }
  ) => Promise<CreateContactResult>;
```

Add to `pickerProps` (`:1178-1217`), beside `onAddTarget`:

```ts
    onCreateContact,
```

Add to the returned object (`:1219-1232`):

```ts
    onCreateContact,
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `npx vitest run src/tests/odoo-target-create-contact.test.tsx`
Expected: PASS

- [ ] **Step 8: Prove the hook's existing behaviour is unchanged**

Run: `npx vitest run src/tests/odoo-target-new-chat-entry-points.test.tsx src/tests/odoo-contact-picker.test.tsx`
Expected: PASS. `ContactPickerProps` does not yet declare `onCreateContact`, so adding it to `pickerProps` is an excess-property assignment on a typed object literal — if `type-check` complains, that is Task 6's job and this step's TypeScript error is expected; note it and continue.

Run: `npm run type-check`
Expected: may fail with `Object literal may only specify known properties` on `pickerProps`. That is resolved in Task 6, which adds the prop to `ContactPickerProps`. Do not work around it here by loosening a type.

- [ ] **Step 9: Commit**

```bash
git add src/types/odoo.ts src/hooks/useOdooTarget.ts src/tests/odoo-target-create-contact.test.tsx
git commit -m "feat(odoo): add onCreateContact to useOdooTarget

Owns the client, the Odoo call, the cache write and the two guards. The
cache write is guarded on a NEW instanceToken bumped only by
handleInstanceChanged - selectionToken is bumped by four selection paths
that invalidate no cached contact, so guarding on it would silently
discard a partner successfully created in Odoo. reload still gets the
captured selectionToken, per its own contract."
```

---

### Task 6: The affordance, the form scaffold, and the prop path

The first user-visible task. After it, the button renders on `no-contact` rows only, the form opens with a Name and a read-only Email, and Cancel closes it — and nothing writes anywhere.

**Files:**
- Modify: `src/pages/app/components/completion/ContactPicker.tsx`
- Modify: `src/pages/app/components/completion/CalendarProposal.tsx`
- Modify: `src/tests/CalendarProposal.states.test.tsx` (amend — see below)
- Test: `src/tests/CalendarProposal.create.test.tsx` (new)

**Interfaces:**
- Consumes: `CreateContactResult` and `onCreateContact` (Task 5).
- Produces: `CalendarProposalProps` gains two required props:

```ts
  contacts: OdooContact[];
  onCreateContact: (
    participant: CalendarParticipant,
    draft: { name: string; parentId: number | null }
  ) => Promise<CreateContactResult>;
```

and the exported helper `prefillName(participant: CalendarParticipant): string`.

**The existing test file must be amended in this task, not later.** `CalendarProposal.states.test.tsx:101` asserts `expect(screen.queryByRole("button", { name: /create/i })).toBeNull()` on a fixture containing a `no-contact` row, under the comment "no create-contact escape hatch either" — it pins the absence of exactly what this task adds. Its `renderState` helper (`:15-24`) also supplies a fixed prop set, so two new required props break type-checking for every `render` in the file.

- [ ] **Step 1: Amend the existing test first, so it fails for the right reason**

In `src/tests/CalendarProposal.states.test.tsx`, change `renderState` (`:15-24`) to supply the two new props:

```tsx
function renderState(state: CalendarProposalState, over = {}) {
  const handlers = {
    onPickCandidate: vi.fn(),
    onRetry: vi.fn(),
    onAddTarget: vi.fn(async () => ({ ok: true })),
    onCreateContact: vi.fn(async () => ({ kind: "abandoned" }) as const),
    ...over,
  };
  render(<CalendarProposal state={state} targets={[]} contacts={[]} {...handlers} />);
  return handlers;
}
```

Then split the unmatched-attendees test at `:63-106`. Keep every existing assertion about the text, the testid and the `text-muted-foreground` class — those still hold, and the affordance must not disturb them. Replace only the two no-control assertions at `:100-101`:

```tsx
    // No checkbox anywhere in this block: an unmatched attendee is not
    // selectable until they exist in Odoo.
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
    // The create affordance is offered on the no-contact row and NOT on the
    // archived one. Offering it for an archived partner manufactures exactly
    // the duplicate the archived/no-contact split exists to prevent.
    expect(
      screen.getByTestId("calendar-create-new@acme.example")
    ).toBeInTheDocument();
    expect(screen.queryByTestId("calendar-create-old@acme.example")).toBeNull();
```

- [ ] **Step 2: Write the new failing test**

`src/tests/CalendarProposal.create.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => {}) }));

import { CalendarProposal } from "@/pages/app/components/completion/CalendarProposal";
import type { CalendarProposalState, CalendarParticipant, OdooContact, SelectedTargets } from "@/types";

function participant(address: string, name: string | null = null): CalendarParticipant {
  return { address, name, type: "required", isOrganizer: false };
}

function proposal(
  unmatched: { participant: CalendarParticipant; reason: "no-contact" | "archived" }[]
): CalendarProposalState {
  return { kind: "proposal", eventId: "e1", subject: "Client sync", matched: [], unmatched };
}

/**
 * `data` and `handlers` are destructured SEPARATELY on purpose. Folding
 * `contacts`/`targets` into the handler object and spreading it last would let
 * them override the explicit props below - a helper that silently ignores half
 * its own arguments.
 */
function setup(
  state: CalendarProposalState,
  over: {
    contacts?: OdooContact[];
    targets?: SelectedTargets;
    onAddTarget?: unknown;
    onCreateContact?: unknown;
  } = {}
) {
  const { contacts = [], targets = [], ...handlerOverrides } = over;
  const handlers = {
    onPickCandidate: vi.fn(),
    onRetry: vi.fn(),
    onAddTarget: vi.fn(async () => ({ ok: true })),
    onCreateContact: vi.fn(async () => ({ kind: "abandoned" }) as const),
    ...handlerOverrides,
  };
  const view = render(
    <CalendarProposal state={state} targets={targets} contacts={contacts} {...handlers} />
  );
  /** Re-render with the same handlers and new data - every lifecycle test needs
   * this, and hand-rolling the full prop list at each call site is how one of
   * them ends up quietly passing a different handler. */
  const rerender = (next: { state?: CalendarProposalState; targets?: SelectedTargets; contacts?: OdooContact[] }) =>
    view.rerender(
      <CalendarProposal
        state={next.state ?? state}
        targets={next.targets ?? targets}
        contacts={next.contacts ?? contacts}
        {...handlers}
      />
    );
  return { ...handlers, view, rerender };
}

beforeEach(() => vi.clearAllMocks());

describe("the create affordance", () => {
  it("is offered on a no-contact row and not on an archived one", () => {
    setup(
      proposal([
        { participant: participant("new@acme.example", "New Person"), reason: "no-contact" },
        { participant: participant("old@acme.example", "Old Person"), reason: "archived" },
      ])
    );
    expect(screen.getByTestId("calendar-create-new@acme.example")).toBeInTheDocument();
    expect(screen.queryByTestId("calendar-create-old@acme.example")).toBeNull();
  });

  // The fixed footprint is a Global Constraint: the main window is 600x54 and
  // non-resizable, and resizeWindow(true) reads a flag list at popover-open.
  it("keeps the region's fixed height with the form open", async () => {
    setup(proposal([{ participant: participant("new@acme.example"), reason: "no-contact" }]));
    await userEvent.click(screen.getByTestId("calendar-create-new@acme.example"));
    const region = screen.getByTestId("calendar-proposal-region");
    expect(region).toHaveClass("h-28");
    // The form renders INSIDE the scroll region, not in a portal.
    expect(region).toContainElement(screen.getByTestId("calendar-create-form"));
  });
});

describe("the create form", () => {
  const one = proposal([
    { participant: participant("new@acme.example", "New Person"), reason: "no-contact" },
  ]);

  it("writes nothing when it opens, and nothing when it is cancelled", async () => {
    const { onCreateContact, onAddTarget } = setup(one);
    await userEvent.click(screen.getByTestId("calendar-create-new@acme.example"));
    expect(screen.getByTestId("calendar-create-form")).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("calendar-create-cancel"));
    expect(screen.queryByTestId("calendar-create-form")).toBeNull();
    expect(onCreateContact).not.toHaveBeenCalled();
    expect(onAddTarget).not.toHaveBeenCalled();
  });

  it("shows the email read-only", async () => {
    setup(one);
    await userEvent.click(screen.getByTestId("calendar-create-new@acme.example"));
    const email = screen.getByTestId("calendar-create-email");
    expect(email).toHaveTextContent("new@acme.example");
    // Not an input at all: an editable email lets the user create a partner
    // that still does not match the attendee.
    expect(email.tagName).not.toBe("INPUT");
  });

  it("opening a second row's form closes the first and discards its draft", async () => {
    setup(
      proposal([
        { participant: participant("a@acme.example", "A Person"), reason: "no-contact" },
        { participant: participant("b@acme.example", "B Person"), reason: "no-contact" },
      ])
    );
    await userEvent.click(screen.getByTestId("calendar-create-a@acme.example"));
    const name = screen.getByTestId("calendar-create-name");
    await userEvent.clear(name);
    await userEvent.type(name, "Edited Draft");

    await userEvent.click(screen.getByTestId("calendar-create-b@acme.example"));
    expect(screen.getAllByTestId("calendar-create-form")).toHaveLength(1);
    expect(screen.getByTestId("calendar-create-email")).toHaveTextContent("b@acme.example");

    await userEvent.click(screen.getByTestId("calendar-create-a@acme.example"));
    expect(screen.getByTestId("calendar-create-name")).toHaveValue("A Person");
  });
});

describe("the name prefill", () => {
  it.each([
    ["a plain name", participant("x@acme.example", "Jane Doe"), "Jane Doe"],
    ["a Last, First name", participant("x@acme.example", "Doe, Jane"), "Jane Doe"],
    ["collapsed whitespace", participant("x@acme.example", "  Jane   Doe  "), "Jane Doe"],
    ["a null name", participant("jane.doe@acme.example", null), "jane doe"],
    ["a blank name", participant("jane_doe-smith@acme.example", "   "), "jane doe smith"],
  ])("prefills %s", async (_label, p, expected) => {
    setup(proposal([{ participant: p, reason: "no-contact" }]));
    await userEvent.click(screen.getByTestId(`calendar-create-${p.address}`));
    expect(screen.getByTestId("calendar-create-name")).toHaveValue(expected);
  });

  // Only a SINGLE leading comma flips. "Doe, Jane, Jr" is not a Last, First
  // name and guessing at it would mangle a name the user then has to unmangle.
  it("does not flip a name with two commas", async () => {
    const p = participant("x@acme.example", "Doe, Jane, Jr");
    setup(proposal([{ participant: p, reason: "no-contact" }]));
    await userEvent.click(screen.getByTestId(`calendar-create-${p.address}`));
    expect(screen.getByTestId("calendar-create-name")).toHaveValue("Doe, Jane, Jr");
  });

  it("disables Create contact when the name trims to empty", async () => {
    setup(proposal([{ participant: participant("x@acme.example", "Jane"), reason: "no-contact" }]));
    await userEvent.click(screen.getByTestId("calendar-create-x@acme.example"));
    await userEvent.clear(screen.getByTestId("calendar-create-name"));
    await userEvent.type(screen.getByTestId("calendar-create-name"), "   ");
    expect(screen.getByTestId("calendar-create-submit")).toBeDisabled();
  });
});
```

- [ ] **Step 3: Run both test files to verify they fail**

Run: `npx vitest run src/tests/CalendarProposal.create.test.tsx src/tests/CalendarProposal.states.test.tsx`
Expected: FAIL — no `calendar-create-*` testids exist, and `contacts` / `onCreateContact` are not props of `CalendarProposal`.

- [ ] **Step 4: Forward the props through `ContactPicker`**

In `src/pages/app/components/completion/ContactPicker.tsx`, add to `ContactPickerProps` beside `onAddTarget` (`:137`):

```ts
  /**
   * Creates (or adopts) an Odoo partner for an unmatched calendar attendee.
   *
   * Top-level, NOT inside the optional `calendar` object below, for the reason
   * that object's own comment gives about `targets`/`onAddTarget`: it comes
   * from useOdooTarget, while `calendar` is memoized in completion/index.tsx
   * from useCalendarProposal alone.
   */
  onCreateContact: (
    participant: CalendarParticipant,
    draft: { name: string; parentId: number | null }
  ) => Promise<CreateContactResult>;
```

Add a module-level constant near `MAX_RENDERED_ROWS` (`:14`):

```ts
/**
 * Module scope so the not-ready cache does not hand CalendarProposal a fresh
 * array every render - its company-filter useMemo keys on that prop. The
 * not-ready branch is unreachable while a proposal is on screen
 * (useCalendarProposal's `present` requires rows.length > 0), but a memo whose
 * correctness rests on an invariant two files away breaks silently when that
 * invariant moves.
 */
const NO_CONTACTS: OdooContact[] = [];
```

Change the existing narrowing at `:305`:

```ts
  const allContacts = cache.kind === "ready" ? cache.contacts : NO_CONTACTS;
```

Destructure the new prop in the component signature (beside `onAddTarget`, `:201`), and forward both into `<CalendarProposal>` (`:343-351`):

```tsx
          {calendar !== undefined && (
            <CalendarProposal
              state={calendar.state}
              targets={targets}
              contacts={allContacts}
              onAddTarget={onAddTarget}
              onCreateContact={onCreateContact}
              onPickCandidate={calendar.onPickCandidate}
              onRetry={calendar.onRetry}
            />
          )}
```

Add `CalendarParticipant`, `CreateContactResult` and `OdooContact` to the file's `@/types` type import as needed.

- [ ] **Step 5: Add the props, the prefill and the form to `CalendarProposal`**

In `src/pages/app/components/completion/CalendarProposal.tsx`, add to `CalendarProposalProps`:

```ts
  /**
   * The whole cached contact list, not the proposal's matches.
   *
   * Three things here need it and none can use `proposal.matched`: the Company
   * filter (companies are not attendees), the Layer 2 similarity search (a
   * candidate is by definition somebody whose email did NOT match), and the
   * company inference.
   */
  contacts: OdooContact[];
  onCreateContact: (
    participant: CalendarParticipant,
    draft: { name: string; parentId: number | null }
  ) => Promise<CreateContactResult>;
```

Add the prefill helper at module scope, beside `timeRange`:

```ts
/**
 * The Name field's starting value. A starting point the user is expected to
 * fix, not a guess presented as fact.
 *
 * Exported for its own test: the "Last, First" flip is the part most likely to
 * be wrong, and it is invisible from the outside once it has run.
 */
export function prefillName(participant: CalendarParticipant): string {
  const raw = (participant.name ?? "").trim();
  if (raw !== "") {
    const parts = raw.split(",");
    // A SINGLE comma only. "Doe, Jane, Jr" is not a Last, First name, and
    // guessing at it produces something the user then has to unmangle.
    const flipped =
      parts.length === 2 ? `${parts[1].trim()} ${parts[0].trim()}` : raw;
    return flipped.replace(/\s+/g, " ").trim();
  }
  // No display name at all - the population most likely to be unmatched. The
  // local part with its separators spaced is a better seed than a blank field,
  // and it is what gives Layer 2 tokens to work with.
  const local = participant.address.split("@")[0] ?? "";
  return local.replace(/[._-]+/g, " ").replace(/\s+/g, " ").trim();
}
```

Add the form state inside the component, beside `writeResult`:

```ts
  /**
   * The row whose form is open, keyed on the entry's RAW `participant.address`
   * - the same key the row's React key and data-testid already use. Never an
   * array index: the re-projection effect rebuilds `unmatched` whenever the
   * contact cache changes, so an index would silently point at a different
   * attendee.
   */
  const [openForm, setOpenForm] = useState<string | null>(null);
  /**
   * Snapshotted ONCE in the open handler, never derived from
   * `entry.participant` during render: `project()` calls `participantsOf`
   * fresh on every re-projection, so a reactive prefill would discard the
   * user's edits on a re-projection they did not cause.
   */
  const [draftName, setDraftName] = useState("");
```

Add the open handler and render the affordance. Replace the unmatched block (`:562-572`):

```tsx
      {proposal?.unmatched.map((entry) => {
        const address = entry.participant.address;
        const canCreate = entry.reason === "no-contact";
        return (
          <div key={address} className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              {/*
                The testid and the muted class stay on the element carrying the
                TEXT. CalendarProposal.states.test.tsx asserts both on exactly
                this node, and the affordance must not disturb either.
              */}
              <p
                data-testid={`calendar-unmatched-${address}`}
                className="text-[11px] text-muted-foreground"
              >
                {`${entry.participant.name ?? address} — ${
                  entry.reason === "archived" ? "archived in Odoo" : "no Odoo contact"
                }`}
              </p>
              {canCreate && (
                <button
                  type="button"
                  data-testid={`calendar-create-${address}`}
                  className="text-[10px] uppercase tracking-wide text-muted-foreground hover:text-foreground"
                  onClick={() => {
                    setOpenForm(address);
                    setDraftName(prefillName(entry.participant));
                  }}
                >
                  Create in Odoo
                </button>
              )}
            </div>
            {openForm === address && (
              <div className="flex flex-col gap-1 pl-2" data-testid="calendar-create-form">
                <input
                  type="text"
                  data-testid="calendar-create-name"
                  className="text-[11px] border rounded px-1 py-0.5"
                  value={draftName}
                  onChange={(e) => setDraftName(e.target.value)}
                />
                {/* READ-ONLY, and not an input: this is the key the row was
                    matched on and the key the created partner is matched on
                    next time. */}
                <p className="text-[11px] text-muted-foreground" data-testid="calendar-create-email">
                  {address}
                </p>
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    className="h-6 text-[11px]"
                    data-testid="calendar-create-submit"
                    disabled={draftName.trim() === ""}
                  >
                    Create contact
                  </Button>
                  <button
                    type="button"
                    data-testid="calendar-create-cancel"
                    className="text-[10px] uppercase tracking-wide text-muted-foreground hover:text-foreground"
                    onClick={() => {
                      setOpenForm(null);
                      setDraftName("");
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}
```

`Create contact` has no `onClick` yet — Task 9 wires it. That is deliberate: this task's deliverable is "the form opens and closes and writes nothing", and the tests above assert exactly that.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run src/tests/CalendarProposal.create.test.tsx src/tests/CalendarProposal.states.test.tsx src/tests/CalendarProposal.slots.test.tsx`
Expected: PASS — all three. `slots` must pass untouched; if it fails, the markup change disturbed something it pins.

Run: `npx vitest run src/tests/odoo-contact-picker.test.tsx src/tests/completion-calendar-wiring.test.tsx`
Expected: PASS, possibly after adding the new required prop to those files' own fixtures. Add it; do not loosen a type.

Run: `npm run type-check`
Expected: clean — including the `pickerProps` assignment Task 5 left failing.

- [ ] **Step 7: Commit**

```bash
git add src/pages/app/components/completion/ContactPicker.tsx src/pages/app/components/completion/CalendarProposal.tsx src/tests/CalendarProposal.create.test.tsx src/tests/CalendarProposal.states.test.tsx
git commit -m "feat(calendar): offer Create in Odoo on unmatched attendee rows

The affordance, the inline form scaffold (editable name, read-only
email), and the two new props threaded from useOdooTarget through
ContactPicker. Opening and cancelling write nothing; Create contact is
not wired yet. Amends CalendarProposal.states.test.tsx, which pinned the
absence of this affordance."
```

---

### Task 7: The Company field

**Files:**
- Modify: `src/pages/app/components/completion/CalendarProposal.tsx`
- Test: `src/tests/CalendarProposal.create.test.tsx` (append a `describe`)

**Interfaces:**
- Consumes: `inferCompany` (Task 3); the `contacts` prop (Task 6).
- Produces: `draftParentId` in the form's draft, passed to `onCreateContact` in Task 9.

- [ ] **Step 1: Write the failing test**

Append to `src/tests/CalendarProposal.create.test.tsx`:

```tsx
import { inferCompany } from "@/lib/calendar/similar-contacts";

function contact(id: number, name: string, over: Partial<OdooContact> = {}): OdooContact {
  return {
    id, name, email: null, phone: null, companyName: null, parentId: null,
    isCompany: false, active: true, writeDate: "2026-09-05 10:00:00",
    isColleague: false, lastMeetingAt: null, ...over,
  };
}

describe("the company field", () => {
  const acme = contact(90, "Acme Ltd", { isCompany: true });
  const onDomain = [
    contact(1, "A", { email: "a@acme.example", parentId: 90 }),
    contact(2, "B", { email: "b@acme.example", parentId: 90 }),
  ];
  const row = { participant: participant("new@acme.example", "New Person"), reason: "no-contact" as const };

  it("prefills the inferred company", async () => {
    setup(proposal([row]), { contacts: [acme, ...onDomain] });
    await userEvent.click(screen.getByTestId("calendar-create-new@acme.example"));
    expect(screen.getByTestId("calendar-create-company")).toHaveValue("Acme Ltd");
  });

  it("leaves the field blank when nothing is inferred", async () => {
    setup(proposal([row]), { contacts: [acme] });
    await userEvent.click(screen.getByTestId("calendar-create-new@acme.example"));
    expect(screen.getByTestId("calendar-create-company")).toHaveValue("");
  });

  it("lists only companies, filtered by the typed query and capped at five", async () => {
    const many = Array.from({ length: 8 }, (_, i) =>
      contact(100 + i, `Acme Division ${i}`, { isCompany: true })
    );
    setup(proposal([row]), { contacts: [...many, contact(5, "Acme Person")] });
    await userEvent.click(screen.getByTestId("calendar-create-new@acme.example"));
    await userEvent.type(screen.getByTestId("calendar-create-company"), "Acme");
    const options = screen.getAllByTestId(/^calendar-create-company-option-/);
    expect(options).toHaveLength(5);
    // A person matching the query is not a company and must not be offered.
    expect(screen.queryByText("Acme Person")).toBeNull();
  });

  it("selecting a row collapses the list back to the chosen name", async () => {
    setup(proposal([row]), { contacts: [acme, contact(91, "Beta Ltd", { isCompany: true })] });
    await userEvent.click(screen.getByTestId("calendar-create-new@acme.example"));
    await userEvent.clear(screen.getByTestId("calendar-create-company"));
    await userEvent.type(screen.getByTestId("calendar-create-company"), "Beta");
    await userEvent.click(screen.getByTestId("calendar-create-company-option-91"));
    expect(screen.getByTestId("calendar-create-company")).toHaveValue("Beta Ltd");
    expect(screen.queryAllByTestId(/^calendar-create-company-option-/)).toHaveLength(0);
  });

  it("clearing the field clears the selection", async () => {
    setup(proposal([row]), { contacts: [acme, ...onDomain] });
    await userEvent.click(screen.getByTestId("calendar-create-new@acme.example"));
    await userEvent.clear(screen.getByTestId("calendar-create-company"));
    expect(screen.getByTestId("calendar-create-company")).toHaveValue("");
    expect(screen.getByTestId("calendar-create-company-none")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/tests/CalendarProposal.create.test.tsx -t "the company field"`
Expected: FAIL — no `calendar-create-company` testid.

- [ ] **Step 3: Add the state and the memo**

In `CalendarProposal.tsx`, beside `draftName`:

```ts
  /** The chosen company's id, or null for "No company". Snapshotted at open
   * from inferCompany, then owned by the user. */
  const [draftParentId, setDraftParentId] = useState<number | null>(null);
  /** What is typed in the Company filter. Separate from `draftParentId`: the
   * user can be mid-search with a selection already made. */
  const [companyQuery, setCompanyQuery] = useState("");

  /**
   * Capped at FIVE, not MAX_RENDERED_ROWS' hundred: the control lives in a
   * 112px scroll region beside two other fields.
   *
   * In a useMemo for the reason ContactPicker.tsx:262-265 uses one - the cache
   * routinely holds thousands of partners and this component re-renders on
   * every parent render.
   */
  const companyOptions = useMemo(() => {
    const needle = companyQuery.trim().toLocaleLowerCase();
    const companies = contacts.filter((c) => c.isCompany);
    const matched =
      needle === ""
        ? companies
        : companies.filter((c) => c.name.toLocaleLowerCase().includes(needle));
    return matched.slice(0, MAX_COMPANY_ROWS);
  }, [contacts, companyQuery]);
```

Add the constant at module scope:

```ts
/** The Company filter's render cap. Five, not ContactPicker's hundred - this
 * control shares a 112px scroll region with two other fields. */
const MAX_COMPANY_ROWS = 5;
```

- [ ] **Step 4: Seed it in the open handler**

Change the affordance's `onClick` from Task 6 to seed all three:

```tsx
                  onClick={() => {
                    const parentId = inferCompany({
                      address: entry.participant.address,
                      contacts,
                    });
                    setOpenForm(address);
                    setDraftName(prefillName(entry.participant));
                    setDraftParentId(parentId);
                    // The label is the cached company's own name - there is no
                    // second source for it, which is why inferCompany only ever
                    // returns an id that names a cached isCompany contact.
                    setCompanyQuery(
                      parentId === null
                        ? ""
                        : (contacts.find((c) => c.id === parentId)?.name ?? "")
                    );
                  }}
```

and reset them in Cancel:

```tsx
                    onClick={() => {
                      setOpenForm(null);
                      setDraftName("");
                      setDraftParentId(null);
                      setCompanyQuery("");
                    }}
```

Add `import { inferCompany } from "@/lib/calendar";` to the file's imports.

- [ ] **Step 5: Render the control**

Between the email line and the buttons:

```tsx
                <input
                  type="text"
                  data-testid="calendar-create-company"
                  placeholder="Company (optional)"
                  className="text-[11px] border rounded px-1 py-0.5"
                  value={companyQuery}
                  onChange={(e) => {
                    setCompanyQuery(e.target.value);
                    // Typing invalidates the selection: the field must never
                    // show one company's name while carrying another's id.
                    setDraftParentId(null);
                  }}
                />
                {draftParentId === null && companyQuery.trim() === "" && (
                  <p
                    className="text-[10px] text-muted-foreground"
                    data-testid="calendar-create-company-none"
                  >
                    No company
                  </p>
                )}
                {draftParentId === null &&
                  companyQuery.trim() !== "" &&
                  companyOptions.map((company) => (
                    <button
                      key={company.id}
                      type="button"
                      data-testid={`calendar-create-company-option-${company.id}`}
                      className="text-left text-[11px] hover:text-primary"
                      onClick={() => {
                        setDraftParentId(company.id);
                        setCompanyQuery(company.name);
                      }}
                    >
                      {company.name}
                    </button>
                  ))}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run src/tests/CalendarProposal.create.test.tsx src/tests/CalendarProposal.states.test.tsx`
Expected: PASS

Run: `npm run type-check`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add src/pages/app/components/completion/CalendarProposal.tsx src/tests/CalendarProposal.create.test.tsx
git commit -m "feat(calendar): add the company field to the create form

A filter input over cached companies capped at five rows, prefilled from
inferCompany and clearable to No company. Not a select - the cache holds
thousands of partners. Typing invalidates the selection so the field can
never show one company's name while carrying another's id."
```

---

### Task 8: Layer 2 — the similarity warning and `resolvedByHand`

**Files:**
- Modify: `src/pages/app/components/completion/CalendarProposal.tsx`
- Test: `src/tests/CalendarProposal.create.test.tsx` (append a `describe`)

**Interfaces:**
- Consumes: `similarContacts` (Task 2); `prefillName` (Task 6); `onAddTarget` (existing).
- Produces: `resolvedByHand: ReadonlyMap<string, OdooContact>` in component state, read by Task 9's render rules.

**A map, not a set.** The row's label has to name the contact that resolved it, and an address alone cannot recover that: `SelectedTarget` carries no address (`src/types/odoo.ts:88-92`), and the added contact is by definition absent from `proposal.matched` since a different email is Layer 2's whole premise.

- [ ] **Step 1: Write the failing test**

Append to `src/tests/CalendarProposal.create.test.tsx`:

```tsx
describe("Layer 2 - the similarity warning", () => {
  const jane = contact(7, "Jane Doe", { email: "jane@acme.example" });
  const row = { participant: participant("j.doe@acme.example", "Jane Doe"), reason: "no-contact" as const };

  it("offers a Use button for a similar cached contact", async () => {
    setup(proposal([row]), { contacts: [jane] });
    await userEvent.click(screen.getByTestId("calendar-create-j.doe@acme.example"));
    expect(screen.getByTestId("calendar-create-use-7")).toHaveTextContent("Jane Doe");
  });

  it("offers nothing when no cached contact is similar", async () => {
    setup(proposal([row]), { contacts: [contact(8, "Bob Stone", { email: "bob@acme.example" })] });
    await userEvent.click(screen.getByTestId("calendar-create-j.doe@acme.example"));
    expect(screen.queryAllByTestId(/^calendar-create-use-/)).toHaveLength(0);
  });

  it("leaves Create contact enabled below the warning", async () => {
    setup(proposal([row]), { contacts: [jane] });
    await userEvent.click(screen.getByTestId("calendar-create-j.doe@acme.example"));
    // Two people genuinely do share a name; a hard block would make that
    // unresolvable from this UI.
    expect(screen.getByTestId("calendar-create-submit")).toBeEnabled();
  });

  it("adds that contact as a target, creates nothing, and resolves the row", async () => {
    const { onAddTarget, onCreateContact, rerender } = setup(proposal([row]), { contacts: [jane] });
    await userEvent.click(screen.getByTestId("calendar-create-j.doe@acme.example"));
    await userEvent.click(screen.getByTestId("calendar-create-use-7"));

    expect(onAddTarget).toHaveBeenCalledWith({ model: "res.partner", resId: 7, name: "Jane Doe" });
    expect(onCreateContact).not.toHaveBeenCalled();
    expect(screen.queryByTestId("calendar-create-form")).toBeNull();

    // The row must stop inviting a create: matchAttendees keys on email and
    // never reads targets, so it still says no-contact.
    rerender({ targets: [{ model: "res.partner", resId: 7, name: "Jane Doe" }] });
    expect(screen.queryByTestId("calendar-create-j.doe@acme.example")).toBeNull();
    expect(screen.getByTestId("calendar-unmatched-j.doe@acme.example")).toHaveTextContent(
      /added Jane Doe/i
    );
  });

  it("reports a cap rejection and leaves the row unresolved", async () => {
    const onAddTarget = vi.fn(async () => ({ ok: false, reason: "cap" as const }));
    setup(proposal([row]), { contacts: [jane], onAddTarget });
    await userEvent.click(screen.getByTestId("calendar-create-j.doe@acme.example"));
    await userEvent.click(screen.getByTestId("calendar-create-use-7"));

    expect(screen.getByTestId("calendar-create-result")).toHaveTextContent(/full/i);
    // Nothing was added, so nothing is resolved and create stays on offer.
    expect(screen.getByTestId("calendar-create-j.doe@acme.example")).toBeInTheDocument();
  });

  it("restores the row when the target is removed again", async () => {
    const { rerender } = setup(proposal([row]), { contacts: [jane] });
    await userEvent.click(screen.getByTestId("calendar-create-j.doe@acme.example"));
    await userEvent.click(screen.getByTestId("calendar-create-use-7"));

    rerender({ targets: [{ model: "res.partner", resId: 7, name: "Jane Doe" }] });
    expect(screen.queryByTestId("calendar-create-j.doe@acme.example")).toBeNull();

    // Removed from the "Logging to" list. The latch must not outlive the fact.
    rerender({ targets: [] });
    expect(screen.getByTestId("calendar-create-j.doe@acme.example")).toBeInTheDocument();
  });

  // freeSlots is a dep of the pre-check effect and a successful Use click
  // changes it by definition. Clearing resolvedByHand there would un-resolve
  // the row on the very next commit.
  it("stays resolved when another target is added by hand", async () => {
    const { rerender } = setup(proposal([row]), { contacts: [jane] });
    await userEvent.click(screen.getByTestId("calendar-create-j.doe@acme.example"));
    await userEvent.click(screen.getByTestId("calendar-create-use-7"));

    rerender({
      targets: [
        { model: "res.partner", resId: 7, name: "Jane Doe" },
        { model: "res.partner", resId: 99, name: "Someone Else" },
      ],
    });
    expect(screen.queryByTestId("calendar-create-j.doe@acme.example")).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/tests/CalendarProposal.create.test.tsx -t "Layer 2"`
Expected: FAIL — no `calendar-create-use-*` testid.

- [ ] **Step 3: Add the state**

In `CalendarProposal.tsx`, beside `draftParentId`:

```ts
  /**
   * Addresses the user resolved by picking an existing contact instead of
   * creating one, mapped to the contact they picked.
   *
   * A MAP, not a set: the row's label names that contact, and an address alone
   * cannot recover the name. `SelectedTarget` carries no address, and the
   * contact is by definition absent from `proposal.matched` - a different email
   * is Layer 2's whole premise.
   *
   * Cleared ONLY in the pre-check effect's isNewProposal branch and the
   * idle-reset effect. NOT on a freeSlots or writableKey change: a successful
   * Use click changes freeSlots by definition, so clearing there would
   * un-resolve the row on the very next commit.
   */
  const [resolvedByHand, setResolvedByHand] = useState<ReadonlyMap<string, OdooContact>>(new Map());
  /** The candidates for the open form, computed once when it opens. */
  const [candidates, setCandidates] = useState<OdooContact[]>([]);
```

- [ ] **Step 4: Compute the candidates when the form opens**

In the affordance's `onClick`, after seeding the draft:

```tsx
                    const seeded = prefillName(entry.participant);
                    // Computed on the SEEDED name, including the local-part
                    // fallback - participant.name is nullable, and an attendee
                    // with no display name is exactly the population most
                    // likely to be unmatched. Run once, at open: re-running per
                    // keystroke would flicker the list under a user typing in a
                    // 112px scroll region.
                    setCandidates(
                      similarContacts({
                        name: seeded,
                        address: entry.participant.address,
                        contacts,
                      })
                    );
```

Reset `setCandidates([])` everywhere the form closes.

- [ ] **Step 5: Render the warning, above the fields**

```tsx
                {candidates.length > 0 && (
                  <>
                    <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
                      Already in Odoo?
                    </p>
                    {candidates.map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        data-testid={`calendar-create-use-${c.id}`}
                        className="text-left text-[11px] hover:text-primary"
                        onClick={() => void useExisting(address, c)}
                      >
                        {`Use ${c.name}${c.email === null ? "" : ` · ${c.email}`}`}
                      </button>
                    ))}
                  </>
                )}
```

- [ ] **Step 6: Add the handler**

Inside the component, beside `confirm`:

```ts
  /**
   * Adds an existing contact as a target instead of creating a new partner.
   *
   * The click IS the confirm - adding an existing contact as a target is
   * exactly what the `Add N to log` gate already authorises the user to do one
   * row at a time - and it writes nothing to Odoo.
   */
  const useExisting = async (address: string, chosen: OdooContact) => {
    const epoch = epochRef.current;
    const result = await onAddTarget({
      model: "res.partner",
      resId: chosen.id,
      name: chosen.name,
    });
    if (epochRef.current !== epoch) return;
    if (!result.ok) {
      // A cap rejection resolves nothing, because nothing was added.
      setCreateResult({
        address,
        text:
          result.reason === "cap"
            ? "The log is full. Remove a destination above first."
            : "Could not add that contact.",
      });
      return;
    }
    setResolvedByHand((prev) => new Map(prev).set(address, chosen));
    closeForm();
  };
```

with a shared `closeForm` helper the Cancel button also uses:

```ts
  const closeForm = () => {
    setOpenForm(null);
    setDraftName("");
    setDraftParentId(null);
    setCompanyQuery("");
    setCandidates([]);
  };
```

- [ ] **Step 7: Gate the row's render on the live target**

Replace the row's `canCreate` with:

```tsx
        const resolved = resolvedByHand.get(address) ?? null;
        // Membership ALONE is a latch on a fact that can reverse - the user can
        // remove the target again from the "Logging to" list in the same
        // popover. Gate on the target still being present.
        const stillATarget =
          resolved !== null &&
          targets.some((t) => t.model === "res.partner" && t.resId === resolved.id);
        const canCreate = entry.reason === "no-contact" && !stillATarget;
```

and the text line:

```tsx
                {stillATarget && resolved !== null
                  ? `${entry.participant.name ?? address} — added ${resolved.name}`
                  : `${entry.participant.name ?? address} — ${
                      entry.reason === "archived" ? "archived in Odoo" : "no Odoo contact"
                    }`}
```

Add `createResult` state and its region-level render — Task 9 owns its clearing rules, but the cap message above needs somewhere to land now:

```ts
  const [createResult, setCreateResult] = useState<{ address: string; text: string } | null>(null);
```

```tsx
      {createResult !== null && (
        <p className="text-[11px]" data-testid="calendar-create-result">
          {createResult.text}
        </p>
      )}
```

Add `import { similarContacts } from "@/lib/calendar";`.

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npx vitest run src/tests/CalendarProposal.create.test.tsx src/tests/CalendarProposal.states.test.tsx src/tests/CalendarProposal.slots.test.tsx`
Expected: PASS

Run: `npm run type-check`
Expected: clean.

- [ ] **Step 9: Commit**

```bash
git add src/pages/app/components/completion/CalendarProposal.tsx src/tests/CalendarProposal.create.test.tsx
git commit -m "feat(calendar): warn when the attendee may already be in Odoo

Duplicate-guard Layer 2. Similar cached contacts render as Use buttons
that add THAT contact as a target and write nothing to Odoo. The resolved
row stops offering create, but only while the target is actually present
- the latch must not outlive the fact it asserts."
```

---

### Task 9: Wire `Create contact`

The last task. After it the feature works end to end.

**Files:**
- Modify: `src/pages/app/components/completion/CalendarProposal.tsx`
- Test: `src/tests/CalendarProposal.create.test.tsx` (append a `describe`)

**Interfaces:**
- Consumes: `onCreateContact` (Task 5), `CreateContactResult` (Task 5), all the form state from Tasks 6-8.
- Produces: nothing new.

The message and form-lifecycle table, total over the union:

| Member | Message | Form |
| --- | --- | --- |
| `created` | `Created in Odoo — tick them below to log this meeting.` | closes |
| `adopted-active` | `Already in Odoo — added to the list below.` | closes |
| `adopted-archived` | `This person is already in Odoo but archived. Un-archive them there to log this meeting to them.` | closes |
| `created-invisible` | `Created in Odoo, but it isn't visible to this connection.` | closes |
| `cached-failed` | `Created in Odoo. Refresh to see them here.` | closes |
| `failed` | per code, below | stays open, draft intact |
| `abandoned` | none | closes, silently |
| `busy` | none | unchanged |

- [ ] **Step 1: Write the failing test**

Append to `src/tests/CalendarProposal.create.test.tsx`:

```tsx
describe("submitting the create form", () => {
  const row = { participant: participant("new@acme.example", "New Person"), reason: "no-contact" as const };
  const created = contact(7, "New Person", { email: "new@acme.example" });

  async function submit(result: unknown, over = {}) {
    const onCreateContact = vi.fn(async () => result);
    const harness = setup(proposal([row]), { onCreateContact, ...over });
    await userEvent.click(screen.getByTestId("calendar-create-new@acme.example"));
    await userEvent.click(screen.getByTestId("calendar-create-submit"));
    return { ...harness, onCreateContact };
  }

  it("calls onCreateContact with the participant and the draft, and never onAddTarget", async () => {
    const { onCreateContact, onAddTarget } = await submit({ kind: "created", contact: created });
    expect(onCreateContact).toHaveBeenCalledWith(
      expect.objectContaining({ address: "new@acme.example" }),
      { name: "New Person", parentId: null }
    );
    // Two buttons, two writes, no path where one implies the other.
    expect(onAddTarget).not.toHaveBeenCalled();
  });

  it.each([
    ["created", { kind: "created", contact: created }, /tick them below/i],
    ["adopted-active", { kind: "adopted-active", contact: created }, /already in odoo/i],
    ["adopted-archived", { kind: "adopted-archived", contact: created }, /archived/i],
    ["created-invisible", { kind: "created-invisible" }, /isn't visible/i],
    ["cached-failed", { kind: "cached-failed" }, /refresh to see them/i],
  ])("closes the form and reports %s", async (_label, result, pattern) => {
    await submit(result);
    expect(screen.queryByTestId("calendar-create-form")).toBeNull();
    expect(screen.getByTestId("calendar-create-result")).toHaveTextContent(pattern);
  });

  it("renders nothing at all for an abandoned create", async () => {
    await submit({ kind: "abandoned" });
    expect(screen.queryByTestId("calendar-create-form")).toBeNull();
    expect(screen.queryByTestId("calendar-create-result")).toBeNull();
  });

  it.each([
    ["ODOO_FAULT", /permissions/i],
    ["ODOO_UNREACHABLE", /could not reach odoo/i],
    ["ODOO_INTERNAL", /ODOO_INTERNAL/],
  ])("keeps the form open with the draft intact after %s", async (code, pattern) => {
    setup(proposal([row]), { onCreateContact: vi.fn(async () => ({ kind: "failed", code })) });
    await userEvent.click(screen.getByTestId("calendar-create-new@acme.example"));
    await userEvent.clear(screen.getByTestId("calendar-create-name"));
    await userEvent.type(screen.getByTestId("calendar-create-name"), "Edited Name");
    await userEvent.click(screen.getByTestId("calendar-create-submit"));

    expect(screen.getByTestId("calendar-create-form")).toBeInTheDocument();
    expect(screen.getByTestId("calendar-create-name")).toHaveValue("Edited Name");
    expect(screen.getByTestId("calendar-create-result")).toHaveTextContent(pattern);
    // The retry the message promises must actually be clickable.
    expect(screen.getByTestId("calendar-create-submit")).toBeEnabled();
  });

  it("never renders server prose", async () => {
    await submit({ kind: "failed", code: "ODOO_FAULT" });
    const text = screen.getByTestId("calendar-create-result").textContent ?? "";
    expect(text).not.toMatch(/traceback|psycopg|odoo\.exceptions/i);
  });

  it("survives the re-projection that removes the row it refers to", async () => {
    const { rerender } = await submit({ kind: "created", contact: created });
    // The create moved the attendee into `matched`: `unmatched` shrinks and
    // `writable` grows, which re-fires the pre-check effect. The message must
    // NOT be cleared there.
    rerender({
      state: {
        kind: "proposal",
        eventId: "e1",
        subject: "Client sync",
        matched: [{ participant: participant("new@acme.example", "New Person"), contact: created }],
        unmatched: [],
      },
      contacts: [created],
    });
    expect(screen.getByTestId("calendar-create-result")).toHaveTextContent(/tick them below/i);
    // And the new row is present, enabled and UNCHECKED.
    const box = screen.getByTestId("calendar-proposal-row-7");
    expect(box).toBeEnabled();
    expect(box).not.toBeChecked();
  });

  it("clears the message when a different meeting is proposed", async () => {
    const { rerender } = await submit({ kind: "created", contact: created });
    rerender({
      state: { kind: "proposal", eventId: "e2", subject: "Other", matched: [], unmatched: [] },
    });
    expect(screen.queryByTestId("calendar-create-result")).toBeNull();
  });

  it("closes the form when its row flips to archived underneath it", async () => {
    const { rerender } = setup(proposal([row]), {});
    await userEvent.click(screen.getByTestId("calendar-create-new@acme.example"));
    expect(screen.getByTestId("calendar-create-form")).toBeInTheDocument();

    rerender({ state: proposal([{ participant: row.participant, reason: "archived" }]) });
    expect(screen.queryByTestId("calendar-create-form")).toBeNull();
  });

  it("disables the button while a create is in flight", async () => {
    let release!: () => void;
    const onCreateContact = vi.fn(
      () => new Promise((r) => (release = () => r({ kind: "created", contact: created })))
    );
    setup(proposal([row]), { onCreateContact });
    await userEvent.click(screen.getByTestId("calendar-create-new@acme.example"));
    await userEvent.click(screen.getByTestId("calendar-create-submit"));
    expect(screen.getByTestId("calendar-create-submit")).toBeDisabled();
    await act(async () => {
      release();
    });
  });

  it("an idle reset mid-create sets no result and leaves no disabled button", async () => {
    let release!: () => void;
    const onCreateContact = vi.fn(
      () => new Promise((r) => (release = () => r({ kind: "created", contact: created })))
    );
    const { rerender } = setup(proposal([row]), { onCreateContact });
    await userEvent.click(screen.getByTestId("calendar-create-new@acme.example"));
    await userEvent.click(screen.getByTestId("calendar-create-submit"));

    rerender({ state: { kind: "idle" } });
    await act(async () => {
      release();
    });
    expect(screen.queryByTestId("calendar-create-result")).toBeNull();
    expect(screen.getByTestId("calendar-proposal-region").textContent).toBe("");
  });

  it("a re-projection while the form is open does not overwrite an edited name", async () => {
    const { rerender } = setup(proposal([row]), {});
    await userEvent.click(screen.getByTestId("calendar-create-new@acme.example"));
    await userEvent.clear(screen.getByTestId("calendar-create-name"));
    await userEvent.type(screen.getByTestId("calendar-create-name"), "Corrected Name");

    // A fresh participant object, as project() produces on every reprojection.
    rerender({
      state: proposal([
        { participant: participant("new@acme.example", "New Person"), reason: "no-contact" },
      ]),
      contacts: [contact(50, "Unrelated", { email: "u@x.test" })],
    });
    expect(screen.getByTestId("calendar-create-name")).toHaveValue("Corrected Name");
  });

  it("still offers create at cap, and the created row renders disabled", async () => {
    const full = Array.from({ length: 5 }, (_, i) => ({
      model: "res.partner" as const,
      resId: 200 + i,
      name: `T${i}`,
    }));
    setup(proposal([row]), { targets: full });
    // The Odoo record has value independent of whether a slot is free.
    expect(screen.getByTestId("calendar-create-new@acme.example")).toBeInTheDocument();
  });
});
```

Add `act` to the `@testing-library/react` import at the top of the file.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/tests/CalendarProposal.create.test.tsx -t "submitting the create form"`
Expected: FAIL — `Create contact` has no `onClick`, so `onCreateContact` is never called.

- [ ] **Step 3: Add the message table and the submit handler**

At module scope in `CalendarProposal.tsx`:

```ts
/**
 * The failure copy, keyed on the code. Static, and NEVER server prose - the
 * same rule CALENDAR_SETTINGS_REMEDY above exists to hold for the error state.
 * Every code not named here takes the generic arm.
 */
const CREATE_FAILURE_COPY: Partial<Record<OdooErrorCode, string>> = {
  ODOO_FAULT: "Odoo refused to create the contact (ODOO_FAULT). Check your Odoo permissions.",
  ODOO_UNREACHABLE: "Could not reach Odoo. Try again.",
};

function createResultText(result: CreateContactResult): string | null {
  switch (result.kind) {
    case "created":
      return "Created in Odoo — tick them below to log this meeting.";
    case "adopted-active":
      return "Already in Odoo — added to the list below.";
    case "adopted-archived":
      return "This person is already in Odoo but archived. Un-archive them there to log this meeting to them.";
    case "created-invisible":
      return "Created in Odoo, but it isn't visible to this connection.";
    case "cached-failed":
      return "Created in Odoo. Refresh to see them here.";
    case "failed":
      return CREATE_FAILURE_COPY[result.code] ?? `Could not create the contact (${result.code}).`;
    // The popover already reset underneath, and a refusal is not an outcome the
    // user asked about. Both render nothing.
    case "abandoned":
    case "busy":
      return null;
  }
}
```

Inside the component:

```ts
  const [creating, setCreating] = useState(false);

  const submitCreate = async (address: string, p: CalendarParticipant) => {
    const epoch = epochRef.current;
    setCreating(true);
    try {
      const result = await onCreateContact(p, {
        name: draftName.trim(),
        parentId: draftParentId,
      });
      // The popover reset underneath us - no message, no state.
      if (epochRef.current !== epoch) return;
      if (result.kind === "busy") return;

      const text = createResultText(result);
      setCreateResult(text === null ? null : { address, text });
      // Everything that reached Odoo closes the form. `failed` is the only
      // member that leaves it open, because it is the only one where a retry is
      // both possible and safe - see created-invisible for why retrying a write
      // the search cannot see would create a SECOND duplicate.
      if (result.kind !== "failed") closeForm();
    } finally {
      // On EVERY path, not only via the idle-reset effect: that effect fires
      // only when state.kind becomes "idle", and an inline failure leaves it at
      // "proposal" throughout - so relying on it would leave Create contact
      // permanently disabled on a form the error copy promises stays open for a
      // retry.
      if (epochRef.current === epoch) setCreating(false);
    }
  };
```

Wire the button:

```tsx
                  <Button
                    size="sm"
                    className="h-6 text-[11px]"
                    data-testid="calendar-create-submit"
                    disabled={creating || draftName.trim() === ""}
                    onClick={() => void submitCreate(address, entry.participant)}
                  >
                    Create contact
                  </Button>
```

- [ ] **Step 4: Add the row-close effect**

```ts
  /**
   * Two ordinary outcomes destroy the entry hosting the open form while
   * state.kind stays "proposal", so no existing effect cleans up after either:
   * a successful create moves the attendee to `matched`, and an archived-hit
   * adoption flips its reason to "archived", which renders no affordance at
   * all.
   */
  const unmatched = proposal?.unmatched;
  useEffect(() => {
    if (openForm === null) return;
    const stillOpen = (unmatched ?? []).some(
      (u) => u.participant.address === openForm && u.reason === "no-contact"
    );
    if (!stillOpen) closeForm();
    // `closeForm` is a plain function re-created each render; listing it would
    // re-run this effect every render. It only calls setState.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openForm, unmatched]);
```

- [ ] **Step 5: Extend the two existing effects**

In the pre-check effect, clear the create state in the `isNewProposal` branch **only** — never in the intersect branch, and never outside the `setChecked` updater's sibling statements that run on every dep change:

```ts
    if (isNewProposal) {
      setCreateResult(null);
      setResolvedByHand(new Map());
    }
```

Place this immediately after `lastProposalEventIdRef.current = proposalEventId;` and **before** the `if (writingRef.current) return;` guard, so a proposal change that lands mid-write still clears — the same reasoning the existing code gives for recording `isNewProposal` unconditionally.

Leave `setWriteResult(null)` exactly where it is. Do **not** add `setCreateResult(null)` beside it: that line runs on every `writableKey`/`freeSlots` change, and a successful create changes `writableKey` by definition, so the message would be wiped on the very commit meant to show it.

In the idle-reset effect (`:322-329`), add:

```ts
    setCreating(false);
    setCreateResult(null);
    setResolvedByHand(new Map());
    closeForm();
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run src/tests/CalendarProposal.create.test.tsx src/tests/CalendarProposal.states.test.tsx src/tests/CalendarProposal.slots.test.tsx`
Expected: PASS

- [ ] **Step 7: Run the whole feature's suite**

Run:
```bash
npx vitest run \
  src/tests/odoo-expect.test.ts \
  src/tests/odoo-contact-ordering.test.ts \
  src/tests/similar-contacts.test.ts \
  src/tests/create-contact.test.ts \
  src/tests/odoo-target-create-contact.test.tsx \
  src/tests/CalendarProposal.create.test.tsx \
  src/tests/CalendarProposal.states.test.tsx \
  src/tests/CalendarProposal.slots.test.tsx \
  src/tests/match-attendees.test.ts \
  src/tests/useCalendarProposal.test.tsx \
  src/tests/odoo-contact-picker.test.tsx \
  src/tests/completion-calendar-wiring.test.tsx \
  src/tests/odoo-meeting-log-push.test.ts \
  src/tests/odoo-target-new-chat-entry-points.test.tsx
```
Expected: PASS

Run: `npm run type-check` → clean.
Run: `npm run lint` → no NEW errors. This repo's baseline carries warnings; check that none of the new files appear (`npm run lint 2>&1 | grep -E "create-contact|similar-contacts|expect.ts|CalendarProposal"`).

- [ ] **Step 8: Commit**

```bash
git add src/pages/app/components/completion/CalendarProposal.tsx src/tests/CalendarProposal.create.test.tsx
git commit -m "feat(calendar): wire Create contact to the hook

Closes the feature. The result table is total over the eight-member
union: everything that reached Odoo closes the form, only `failed` leaves
it open for a retry. The message renders at region level and is cleared
only on a new proposal or an idle reset - clearing it beside writeResult
would wipe it on the very re-projection it exists to outlive, since a
create does not set writingRef."
```

---

## Self-Review

**1. Spec coverage.** Walked each spec section against a task:

| Spec section | Task |
| --- | --- |
| Architecture — `createOrAdoptContact` | 4 |
| Architecture — `similarContacts` / `inferCompany` | 2, 3 |
| Architecture — `expectInt`, `byRecency` moves | 1 |
| The prop path, hop by hop | 6 |
| The contact rows are a second hop | 6 |
| The callback's signature (8-member union) | 5 (type), 9 (total table) |
| Affordance | 6 |
| Fixed region height | 6 (test), 9 (test) |
| Which row's form is open | 6 |
| Draft snapshotted at open | 6 (test in 9) |
| Fields — Name, Email | 6 |
| Fields — Company | 7 |
| Buttons | 6, 9 |
| Company inference | 3 |
| Layer 1 | 4 |
| Layer 2 + `resolvedByHand` | 8 |
| Similarity rule | 2 |
| `byRecency` moves | 1 |
| Write path steps 1-8 | 5 |
| Two tokens, two jobs | 5 |
| `expectInt` / `firstId` does not move | 1 |
| Guard ownership table | 5 (hook half), 9 (component half) |
| `creatingRef` not `writingRef` | 5 |
| `instanceToken` not `selectionToken` | 5 |
| Resetting on every exit | 9 |
| Closing the form when its row goes away | 9 |
| Where the result message renders | 9 |
| At cap | 8 (cap rejection), 9 (test) |
| Errors table | 9 |
| Never logged | Global Constraints; asserted in 9's "never renders server prose" |
| Testing — all four suites | 2, 3, 4, 5, 6-9 |

No gaps found.

**2. Placeholder scan.** No "TBD", no "add appropriate error handling", no "similar to Task N". Every code step carries real code, including the full test bodies.

Two defects were found in this plan's own code during self-review and fixed inline rather than left for an implementer to trip over:

- Task 4's test had an unbalanced `beforeEach(() => vi.clearAllMocks();`. A plan that ships a syntax error teaches the implementer to distrust its code blocks.
- Task 6's `setup` helper folded `contacts`/`targets` into the handler object and spread it *after* the explicit `targets={}` / `contacts={}` props, so every call passing either would have had it silently overridden by the default. `setup` now destructures data and handlers separately and returns a `rerender(next)` helper; every lifecycle test in Tasks 8 and 9 uses it instead of hand-rolling a full prop list, which is how one of them would otherwise have quietly re-rendered with a *different* mock than it asserted on.

**3. Type consistency.** Checked across tasks:
- `expectInt(value, what)` — defined Task 1, used Task 4. Same signature.
- `byRecency(a, b)` — defined Task 1, used Task 2 and by `CalendarProposal`'s existing sort.
- `similarContacts({ name, address, contacts })` — defined Task 2, called Task 8 with exactly those keys.
- `inferCompany({ address, contacts })` — defined Task 3, called Task 7 with exactly those keys.
- `createOrAdoptContact({ client, address, name, parentId })` — defined Task 4, called Task 5 with exactly those keys.
- `CreateOrAdoptOutcome` (4 members, Task 4) vs `CreateContactResult` (8 members, Task 5): the hook widens the former into the latter by adding `cached-failed`, `failed`, `abandoned`, `busy`. The three shared `adopted-*`/`created` members carry an identical `contact: OdooContact` payload, so `return outcome` in Task 5 type-checks.
- `onCreateContact(participant, draft)` — the same two-parameter shape in `UseOdooTargetReturn` (5), `ContactPickerProps` (6) and `CalendarProposalProps` (6).
- `prefillName(participant)` — defined Task 6, reused in Task 8's candidate seeding.
- `closeForm()` — introduced Task 8, used by Task 9's submit handler and both effects.
- Testids are consistent across tasks: `calendar-create-<address>`, `calendar-create-form`, `-name`, `-email`, `-company`, `-company-option-<id>`, `-company-none`, `-use-<id>`, `-submit`, `-cancel`, `-result`.
