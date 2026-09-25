# Issue 74 — Assign dialog shows no Odoo opportunities/leads: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the meetings-page Assign dialog reach every deal the overlay can reach — a company's deals filed on its people (`child_of`), unlinked leads by their normalized email, any lead by free-text search, and a contact's deals the moment it is added — plus a permanent ids-only lookup log.

**Architecture:** One pure-function change in `src/lib/odoo/opportunities.ts` (`searchDomain`), and three wiring changes in `src/pages/meetings/components/AssignDialog.tsx`: a debounced lead search driven by the dialog's existing "Search contacts" query with its own state and token, `+ add` on a contact also previewing its deals plus a zero-rows hint, and a `console.info` per lookup. No new modules, no schema changes, no changes to the overlay (`useOdooTarget`, `ContactPicker`) or to `searchLeads`/`leadSearchDomain`.

**Tech Stack:** React 19 + TypeScript (strict), Vitest 4 + @testing-library/react + user-event (happy-dom, `src/tests/setup.ts`), Odoo 17 XML-RPC domains (prefix notation), Tauri 2.

**Spec:** `docs/superpowers/specs/2026-09-21-issue-74-assign-dialog-no-odoo-opportunities-leads-shown-for-selected-contact-design.md`

## Global Constraints

- Linked clause: single-id `child_of` plus an explicit `|` for the parent — company `[["partner_id", "child_of", id]]`, person `["|", ["partner_id", "child_of", id], ["partner_id", "=", parentId]]`, **spread** into the domain. Never `child_of` over a list, never `child_of` the parent (that reaches siblings), never `partner_id in`.
- Email identity clause: `["email_normalized", "=", normalizeAddress(contact.email)]` using `normalizeAddress` from `@/lib/calendar/match-attendees`; a null/blank/whitespace-only email emits **no** email clause. Never `=ilike` on the email. `contact_name =ilike name` and the `partner_id = false` / `type = lead` gate are unchanged.
- `LEAD_SEARCH_DEBOUNCE_MS = 350` is restated (and exported) in `AssignDialog.tsx`, never imported from `ContactPicker.tsx`. `LEAD_SEARCH_MIN_CHARS` is imported from `@/lib/odoo/opportunities`; `LEAD_SEARCH_LIMIT` is **not** imported by the dialog.
- Exact copy: section heading `Leads & opportunities`; states `Searching…`, `No matches`, `Search failed (<CODE>).`; hint `Expecting a deal? Search for it by name in the box above.`; the existing `No open opportunities or leads for this contact.` stays byte-for-byte and in its own `<p>`.
- Log line: `console.info("[assign-dialog]", "opportunities", { contactId, parentId, isCompany, hasEmail, rows, code })` — no `import.meta.env.DEV` gate, never a contact name/email or lead name.
- Search state (`leadResults`/`leadSearchError`/`isSearchingLeads`/`leadSearchToken`) is never read or written by `selectContact`; `selectionToken` is never bumped by the search.
- No new npm dependencies. Path alias `@/`. Files kebab-case (test files: `src/tests/*.test.ts[x]`).
- This repo has **no** `check:types` script. The gate is `npm run lint`, `npx tsc --noEmit` (the type pass `npm run build` runs first; clean on this branch as of 2026-09-25; `tsconfig.json` excludes `src/tests/**`, so it checks source only) and the scoped `npx vitest run <files>`.
- `docs/superpowers/*` is gitignored: files under it need `git add -f`.
- Commits are conventional (`feat:`/`fix:`/`test:`/`docs:`) and end with the line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **The user clears or shortens the box while a search is in flight** — the late response must not paint results for a query that is no longer there. Pinned in Task 2 ("drops a search that lands after the box was cleared").
2. **The same lead appears in the contact's deals and in the search results** — adding it from either list stages it once, and both rows read `✓ added`. Pinned in Task 2 ("stages a lead once when it shows in both lists").
3. **A cached email that is whitespace-only or mixed-case** — a blank must emit no `email_normalized` clause at all (never `= ""`), and a mixed-case one must be lowercased and trimmed. Pinned in Task 1.
4. **An address containing `_` or `%`** (`jane_doe@acme.example`) — compared literally with `=`, never as a wildcard pattern that reaches `jane.doe@…`'s lead. Pinned in Task 1.
5. **The dialog closes with a keystroke's debounce timer still pending** — no search may go on the wire after close. Pinned in Task 2 ("never searches after the dialog closes with a keystroke pending").

---

### Task 1: `searchDomain` — `child_of` linked clause and `email_normalized` identity arm

**Files:**
- Modify: `src/lib/odoo/opportunities.ts:1-113` (imports, `searchDomain` doc comment and body)
- Test: `src/tests/odoo-opportunities.test.ts:153-256` (the `describe("searchDomain")` block is replaced whole)

**Interfaces:**
- Consumes: `normalizeAddress(address: string): string` from `@/lib/calendar/match-attendees` (trim + lowercase; already imported the same way by `src/lib/odoo/create-contact.ts:1`).
- Produces: `searchDomain(contact: OpportunityLookupContact): XmlRpcValue[]` — signature unchanged; output composition changes as below. `fetchOpportunities`, `LEAD_FIELDS`, `searchLeads`, `leadSearchDomain` are untouched.

- [ ] **Step 1: Replace the `searchDomain` describe block with the new expectations**

In `src/tests/odoo-opportunities.test.ts`, replace everything from the doc comment `/**\n * The domain is asserted WHOLE, not clause by clause.` (line 153) through the closing `});` of `describe("searchDomain", ...)` (line 256) with:

```ts
/**
 * The domain is asserted WHOLE, not clause by clause.
 *
 * Odoo domains are prefix notation, so the operators and their operand counts
 * are as load-bearing as the leaves themselves - a `toContainEqual` per clause
 * passes happily against a domain whose "&"/"|" nesting means something else
 * entirely.
 */
describe("searchDomain", () => {
  const BASE = [
    ["active", "=", true],
    ["type", "in", ["lead", "opportunity"]],
    // The won filter, scoped to opportunities: a lead is never won.
    "|",
    ["type", "=", "lead"],
    ["probability", "<", 100],
  ];

  it("builds the whole thing for a person: linked records, or an unlinked lead by identity", () => {
    expect(searchDomain(ada({ parentId: 9 }))).toEqual([
      ...BASE,
      // Reachability: Odoo's own link, OR an unlinked lead that names this
      // contact itself.
      "|",
      // The link, FLATTENED: the person (and anything under them), or their
      // own company. Three prefix items - never one nested ["|", a, b].
      "|",
      ["partner_id", "child_of", 1],
      ["partner_id", "=", 9],
      "&",
      "&",
      ["type", "=", "lead"],
      ["partner_id", "=", false],
      "|",
      ["email_normalized", "=", "ada@analytical.example"],
      ["contact_name", "=ilike", "Ada Lovelace"],
    ]);
  });

  // Issue #74, C1. Odoo routinely files a company's deals on the PERSON under
  // it. `partner_id in [company]` found none of them, and the dialog said "No
  // open opportunities or leads" for a company with open deals.
  it("builds the whole thing for a company: child_of reaches the people under it", () => {
    expect(searchDomain(ada())).toEqual([
      ...BASE,
      "|",
      ["partner_id", "child_of", 1],
      "&",
      "&",
      ["type", "=", "lead"],
      ["partner_id", "=", false],
      "|",
      ["email_normalized", "=", "ada@analytical.example"],
      ["contact_name", "=ilike", "Ada Lovelace"],
    ]);
  });

  // In Odoo an opportunity for a person at a company is very commonly held on
  // the COMPANY partner. Searching only partner_id = contactId returns zero
  // rows for exactly the human you are meeting, the "None" branch fires
  // silently, and slice 2 posts to the contact record while open deals sit on
  // the parent.
  it("searches the parent company as well as the contact", () => {
    const domain = searchDomain(ada({ parentId: 9 }));
    expect(domain).toContainEqual(["partner_id", "child_of", 1]);
    expect(domain).toContainEqual(["partner_id", "=", 9]);
  });

  // Invariant 2. `child_of` on the PARENT would reach every sibling person at
  // that company, and their deals belong to them, not to this contact.
  it("never walks down from the parent, so a sibling's deals stay hidden", () => {
    const flat = JSON.stringify(searchDomain(ada({ parentId: 9 })));
    expect(flat).not.toContain('["partner_id","child_of",9]');
    expect(flat).not.toContain('"child_of",[');
    expect(flat).not.toContain('"partner_id","in"');
  });

  // active = false means LOST in Odoo; WON opportunities stay active = true
  // forever, so without this the list grows with every deal ever closed.
  it("keeps lost records out", () => {
    expect(searchDomain(ada())).toContainEqual(["active", "=", true]);
  });

  // THE BUG THIS CLAUSE EXISTS FOR. Odoo's default for an unconverted lead is
  // free-text contact details and NO partner, so a partner_id-only search finds
  // none of them - a real Leads list looked empty here.
  it("finds an unlinked lead by the contact's own name and normalized email", () => {
    const domain = searchDomain(ada());
    expect(domain).toContainEqual(["contact_name", "=ilike", "Ada Lovelace"]);
    expect(domain).toContainEqual(["email_normalized", "=", "ada@analytical.example"]);
    // A lead already pointed at a DIFFERENT partner belongs to that partner,
    // whatever name it carries.
    expect(domain).toContainEqual(["partner_id", "=", false]);
    // Issue #74, C2: Odoo fills email_from with `"Ada" <ada@...>`, which no
    // whole-value comparison against a bare address can match.
    expect(JSON.stringify(domain)).not.toContain("email_from");
  });

  it("normalizes the address it compares", () => {
    expect(searchDomain(ada({ email: "  Ada@Analytical.EXAMPLE " }))).toContainEqual([
      "email_normalized",
      "=",
      "ada@analytical.example",
    ]);
  });

  // `=ilike` is SQL ILIKE with no escaping: `_` matches any character, so
  // "jane_doe@..." would also reach "jane.doe@..."'s lead - a meeting posted
  // to a stranger.
  it("compares the address exactly, so SQL wildcard characters stay literal", () => {
    const domain = searchDomain(ada({ email: "jane_doe@acme.example" }));
    expect(domain).toContainEqual(["email_normalized", "=", "jane_doe@acme.example"]);
    expect(JSON.stringify(domain)).not.toContain('"email_normalized","=ilike"');
  });

  // `ilike` wraps its value in %...%, so "Ada" would also match "Adam Smith".
  it("never uses a substring operator for the identity match", () => {
    const flat = JSON.stringify(searchDomain(ada()));
    expect(flat).toContain('"=ilike"');
    expect(flat).not.toContain('"ilike"');
    expect(flat).not.toContain('"like"');
  });

  // A blank address is no address: `email_normalized = ""` must never reach
  // the wire.
  it("drops the email clause for a contact that has none, blank included", () => {
    for (const email of [null, "", "   "]) {
      const domain = searchDomain(ada({ email }));
      const flat = JSON.stringify(domain);
      expect(flat).not.toContain("email_normalized");
      expect(flat).not.toContain("email_from");
      expect(domain).toContainEqual(["contact_name", "=ilike", "Ada Lovelace"]);
    }
  });

  // Nothing to recognise an unlinked lead BY. Widening the search on a blank
  // value would match every unlinked lead in the database.
  it("asks only for linked records when the contact has no identity at all", () => {
    expect(searchDomain(ada({ name: "   ", email: null }))).toEqual([
      ...BASE,
      ["partner_id", "child_of", 1],
    ]);
  });

  it("flattens the person link on the identity-less path too", () => {
    expect(searchDomain(ada({ parentId: 9, name: "   ", email: null }))).toEqual([
      ...BASE,
      "|",
      ["partner_id", "child_of", 1],
      ["partner_id", "=", 9],
    ]);
  });

  // `probability` is nullable in Postgres and NULL < 100 is NULL, i.e.
  // excluded - so a probability filter applied to leads can silently drop every
  // one of them. It buys nothing either way: a lead is converted (which flips
  // `type`) or lost (which clears `active`), never won.
  it("scopes the won filter to opportunities so no lead is caught by it", () => {
    const domain = searchDomain(ada());
    const wonAt = domain.findIndex(
      (t) => JSON.stringify(t) === JSON.stringify(["probability", "<", 100])
    );
    expect(wonAt).toBeGreaterThan(0);
    expect(domain[wonAt - 1]).toEqual(["type", "=", "lead"]);
    expect(domain[wonAt - 2]).toBe("|");
  });
});
```

- [ ] **Step 2: Run the file to verify the new expectations fail**

Run: `npx vitest run src/tests/odoo-opportunities.test.ts`
Expected: FAIL — the two whole-domain `toEqual`s, "searches the parent company", "never walks down" (`"partner_id","in"` is still there), the three email tests, "drops the email clause" (`email_from` present), and both identity-less `toEqual`s fail. `fetchOpportunities` and `searchLeads` describes still PASS.

- [ ] **Step 3: Implement the new `searchDomain`**

In `src/lib/odoo/opportunities.ts`, add this import after line 1 (`import type { OdooContact, OdooOpportunity } from "@/types";`):

```ts
import { normalizeAddress } from "@/lib/calendar/match-attendees";
```

Then replace lines 41-113 (the `searchDomain` doc comment through its closing `}`) with:

```ts
/**
 * The search domain, in Odoo PREFIX notation: an operator applies to the
 * sub-expressions that follow it, "&" and "|" are binary, and the top-level
 * items are implicitly AND-ed together.
 *
 * A crm.lead reaches this list two ways, and they are not the same kind of
 * claim:
 *
 *  1. `partner_id` is `child_of` the contact - the contact itself or any
 *     partner below it in Odoo's company tree - or is the contact's direct
 *     parent company. AUTHORITATIVE - Odoo itself says this record belongs to
 *     that partner. Both kinds of crm.lead are found this way, and it is the
 *     only way an opportunity is.
 *
 *     `child_of` is what lets a selected COMPANY reach the deals Odoo filed on
 *     the people under it (issue #74) - `partner_id in [company]` found none
 *     of them. It walks DOWN only, and the parent clause names one id, so a
 *     person's SIBLING's deals are never reached from the person: they belong
 *     to someone else. A `child_of` on the parent would reach them.
 *
 *  2. An UNLINKED lead whose own `contact_name` or `email_normalized` matches
 *     the contact. A HEURISTIC, and the reason it exists is that Odoo default
 *     for an unconverted lead is exactly this: free-text contact details and
 *     NO partner at all. Rule 1 finds none of those, which is why a real Leads
 *     list looked empty here the first time leads were offered.
 *
 *     Narrowed to `partner_id = false` deliberately. A lead already pointed
 *     at a DIFFERENT partner belongs to that partner whatever name it
 *     carries, and must not surface under this contact.
 *
 * `email_normalized`, never `email_from`: Odoo fills `email_from` with the
 * formatted `"Jane Doe" <jane@x.com>` string, which no whole-value comparison
 * against a bare address can match. `email_normalized` is Odoo's own stored,
 * lowercased bare address (Odoo 13+), compared with `=` against our own
 * normalized value - NOT `=ilike`, which is SQL ILIKE with no escaping: `_`
 * matches any character, so "jane_doe@x.com" would also match
 * "jane.doe@x.com", a meeting posted to a stranger's lead.
 *
 * `=ilike` on `contact_name`, never `ilike`: Odoo wraps a bare `ilike` value
 * in `%...%`, so "Ada" would also match "Adam Smith". `=ilike` has no
 * wrapping `%` and is case-insensitive, which is the comparison wanted for a
 * free-text name.
 *
 * The won filter is scoped to opportunities. `probability < 100` means "not
 * won", and a LEAD is never won - it is converted (which flips `type`) or
 * lost (which clears `active`). Applying it to leads buys nothing and risks
 * dropping every one of them: `probability` is nullable in Postgres, and
 * NULL < 100 is NULL, i.e. excluded.
 */
export function searchDomain(contact: OpportunityLookupContact): XmlRpcValue[] {
  // PREFIX ITEMS, spread at both use sites below. The person case is three
  // items ("|" and its two operands), not one nested element: a nested
  // ["|", a, b] would be an invalid domain.
  const linked: XmlRpcValue[] =
    contact.parentId === null
      ? [["partner_id", "child_of", contact.id]]
      : ["|", ["partner_id", "child_of", contact.id], ["partner_id", "=", contact.parentId]];

  // At most two, so at most one "|" is ever needed to join them.
  const identity: XmlRpcValue[] = [];
  // Normalized BEFORE the emptiness check: a whitespace-only address is no
  // address, and `email_normalized = ""` must never go on the wire.
  const email = contact.email ? normalizeAddress(contact.email) : "";
  if (email) identity.push(["email_normalized", "=", email]);
  const name = contact.name.trim();
  if (name) identity.push(["contact_name", "=ilike", name]);

  const base: XmlRpcValue[] = [
    ["active", "=", true],
    // `type` has exactly these two values in stock Odoo, so this is a
    // statement of intent rather than a filter - and a guard if an install
    // ever adds a third.
    ["type", "in", ["lead", "opportunity"]],
    "|",
    ["type", "=", "lead"],
    ["probability", "<", 100],
  ];

  // Nothing to recognise an unlinked lead BY. Ask only for what Odoo can
  // answer authoritatively rather than widening the search on a blank value.
  if (identity.length === 0) return [...base, ...linked];

  const identityExpr: XmlRpcValue[] =
    identity.length === 2 ? ["|", identity[0], identity[1]] : [identity[0]];

  return [
    ...base,
    "|",
    ...linked,
    "&",
    "&",
    ["type", "=", "lead"],
    ["partner_id", "=", false],
    ...identityExpr,
  ];
}
```

- [ ] **Step 4: Run the file to verify it passes**

Run: `npx vitest run src/tests/odoo-opportunities.test.ts`
Expected: PASS (all three describes).

- [ ] **Step 5: Mutation checks — each mutant must turn the named test red**

Apply each mutant to `src/lib/odoo/opportunities.ts`, run `npx vitest run src/tests/odoo-opportunities.test.ts`, confirm the named test FAILS, then revert the mutant before the next one. Record each result (mutant → failing test name) in your report. If any mutant stays green, the test is not pinning what it claims: fix the test, not the mutant.

| # | Mutant | Must fail |
|---|---|---|
| M1 | company branch `[["partner_id", "child_of", contact.id]]` → `[["partner_id", "in", [contact.id]]]` | "builds the whole thing for a company…" |
| M2 | `["email_normalized", "=", email]` → `["email_from", "=ilike", email]` | "compares the address exactly…" and "finds an unlinked lead…" |
| M3 | person branch parent clause `["partner_id", "=", contact.parentId]` → `["partner_id", "child_of", contact.parentId]` | "never walks down from the parent…" |
| M4 | `...linked` in the final `return` → `linked` (unspread) | "builds the whole thing for a person…" |
| M5 | `const email = contact.email ? normalizeAddress(contact.email) : "";` → `const email = contact.email ?? "";` | "normalizes the address it compares" |
| M6 | operator only: `["email_normalized", "=", email]` → `["email_normalized", "=ilike", email]` | "compares the address exactly…" |

After the last revert, run the file once more: Expected PASS.

- [ ] **Step 6: Lint and type-check**

Run: `npm run lint`
Expected: no new errors or warnings in `src/lib/odoo/opportunities.ts` or `src/tests/odoo-opportunities.test.ts`.

Run: `npx tsc --noEmit`
Expected: no output (exit 0).

- [ ] **Step 7: Commit**

```bash
git add src/lib/odoo/opportunities.ts src/tests/odoo-opportunities.test.ts
git commit -m "fix(odoo): reach a company's deals via child_of, match leads on email_normalized" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Dialog lead search, driven by the "Search contacts" query

**Files:**
- Modify: `src/pages/meetings/components/AssignDialog.tsx` (import line 21; constants after line 66; new `OpportunityRow` after `joinWithAnd` at line 144; state after line 222; token after line 264; `onSearchLeads` + debounce effect after `selectContact` ends at line 377; replacing filter after `atCap` at line 427; render: new block after the contact list's closing `</div>` at line 735, deals list at lines 766-803)
- Modify: `src/tests/meeting-log-page.test.tsx:83-91` (opportunities mock) and `:329` (beforeEach default)
- Create: `src/tests/assign-dialog-deals.test.tsx`

**Interfaces:**
- Consumes: `searchLeads(client: OdooClient, query: string): Promise<OdooOpportunity[]>`, `LEAD_SEARCH_MIN_CHARS: number` from `@/lib/odoo/opportunities`; the dialog's existing `getClient`, `addTarget`, `removeTarget`, `query`, `replacing`, `atCap`, `targets`, `opportunities`.
- Produces (later tasks rely on these):
  - `export const LEAD_SEARCH_DEBOUNCE_MS = 350;` in `AssignDialog.tsx`.
  - `shownOpportunities: OdooOpportunity[] | null` — `opportunities` minus a replaced crm.lead; the deals list renders from it (Task 3 edits its empty branch).
  - Module-scope `OpportunityRow({ opp, targets, atCap, onAdd, onRemove })` component.
  - Test file `src/tests/assign-dialog-deals.test.tsx` with module mocks `storage`, `contacts`, `client`, `opportunities`, `meetwings`, and helpers `contact()`, `deal()`, `lead()`, `deferred<T>()`, `props()`, `renderReady()`, `searchBox()`, `search(value)`. Tasks 3 and 4 append `describe` blocks to this file and use these helpers.

- [ ] **Step 1: Teach the existing page suite's mock the new exports**

The dialog is about to import `searchLeads` and `LEAD_SEARCH_MIN_CHARS`. `src/tests/meeting-log-page.test.tsx` mocks `@/lib/odoo/opportunities` wholesale, and vitest throws on any read of an export a mock factory leaves out — the dialog's debounce effect reads `LEAD_SEARCH_MIN_CHARS` 350 ms after every open, so without this every dialog test there breaks. Replace lines 83-90 with:

```ts
const opportunities = vi.hoisted(() => ({
  fetchOpportunities: vi.fn(),
  // AssignDialog's lead search (issue #74). Both are read on every dialog
  // open - the debounce effect compares against LEAD_SEARCH_MIN_CHARS - and
  // vitest throws on a read of any export this factory omits.
  searchLeads: vi.fn(),
  OPPORTUNITY_LIMIT: 20,
  LEAD_SEARCH_LIMIT: 10,
  LEAD_SEARCH_MIN_CHARS: 2,
  // NOT a spy. It is a pure string function the dialog calls during render, and
  // a `vi.fn()` returning undefined renders every row with a blank kind - the
  // one thing these rows now have to state.
  kindLabel: (type: string) => (type === "lead" ? "Lead" : "Opportunity"),
}));
```

and directly after line 329 (`opportunities.fetchOpportunities.mockResolvedValue([]);`) add:

```ts
  opportunities.searchLeads.mockResolvedValue([]);
```

- [ ] **Step 2: Create the new test file with the lead-search tests**

Create `src/tests/assign-dialog-deals.test.tsx`:

```tsx
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Issue #74: AssignDialog's deals panel and lead search, rendered DIRECTLY.
// `vi.hoisted` for the reason src/tests/meeting-log-page.test.tsx:6-9 gives.
// Mocked at the LEAF, as that file does. These six are the minimum that lets
// the dialog render under happy-dom (verified 2026-09-25 with a probe file).
const storage = vi.hoisted(() => ({ requireOdooConfig: vi.fn() }));
vi.mock("@/lib/storage/odoo-config.storage", () => storage);

const contacts = vi.hoisted(() => ({ listContacts: vi.fn(), upsertContacts: vi.fn() }));
vi.mock("@/lib/database/odoo-contacts.action", () => contacts);

const client = vi.hoisted(() => ({ createOdooClient: vi.fn(), DEFAULT_TIMEOUT_MS: 30_000 }));
vi.mock("@/lib/odoo/client", () => client);

const opportunities = vi.hoisted(() => ({
  fetchOpportunities: vi.fn(),
  searchLeads: vi.fn(),
  OPPORTUNITY_LIMIT: 20,
  LEAD_SEARCH_LIMIT: 10,
  LEAD_SEARCH_MIN_CHARS: 2,
  // NOT a spy - see meeting-log-page.test.tsx's own opportunities mock.
  kindLabel: (type: string) => (type === "lead" ? "Lead" : "Opportunity"),
}));
vi.mock("@/lib/odoo/opportunities", () => opportunities);

const meetwings = vi.hoisted(() => ({ shouldUseMeetwingsAPI: vi.fn() }));
vi.mock("@/lib/functions/meetwings.api", () => meetwings);

vi.mock("@/contexts", () => ({
  useApp: () => ({
    allAiProviders: [{ id: "openai", name: "OpenAI" }],
    selectedAIProvider: { provider: "openai", model: "gpt-4o", variables: {} },
    meetwingsApiEnabled: false,
  }),
}));

import { AssignDialog, LEAD_SEARCH_DEBOUNCE_MS } from "@/pages/meetings/components/AssignDialog";
import type { MeetingLogListRow, MeetingLogTarget, OdooContact, OdooOpportunity } from "@/types";

const INSTANCE = "http://h:8069|odoo";
const CONFIG = { url: "http://h:8069", db: "odoo", login: "bob", apiKey: "sk-live-key" };
/** Held module-wide so a test can assert the SAME client reached a call. */
const CLIENT = { authenticate: vi.fn(), execute: vi.fn() };

function row(): MeetingLogListRow {
  return {
    id: "un",
    session_key: "s1",
    conversation_id: null,
    instance: INSTANCE,
    contact_id: null,
    lead_id: null,
    transcript_start_at: 1_700_000_000_000,
    transcript_end_at: 1_700_000_060_000,
    attachment_id: null,
    message_id: null,
    status: "unassigned",
    attempts: 0,
    claimed_at: null,
    last_error: null,
    last_error_code: null,
    meeting_started_at: 1_700_000_000_000,
    created_at: 1_600_000_000_000,
    sent_at: null,
  };
}

function contact(over: Partial<OdooContact> = {}): OdooContact {
  return {
    id: 7,
    name: "Ada Lovelace",
    email: null,
    phone: null,
    companyName: null,
    parentId: null,
    isCompany: false,
    active: true,
    writeDate: "2026-01-01 00:00:00",
    isColleague: false,
    lastMeetingAt: null,
    ...over,
  };
}

/** A deal LINKED to the contact, as `fetchOpportunities` returns it. */
function deal(over: Partial<OdooOpportunity> = {}): OdooOpportunity {
  return {
    id: 500,
    name: "Heat pumps for the north wing",
    type: "opportunity",
    stageName: "Proposal",
    partnerId: 7,
    partnerName: "Ada Lovelace",
    contactName: null,
    email: null,
    ...over,
  };
}

/** An UNLINKED lead, as `searchLeads` returns it - no partner at all. */
function lead(over: Partial<OdooOpportunity> = {}): OdooOpportunity {
  return {
    id: 90,
    name: "Partnership with ECS",
    type: "lead",
    stageName: "New",
    partnerId: null,
    partnerName: null,
    contactName: "Christian Carron",
    email: null,
    ...over,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function props(over: { replacing?: MeetingLogTarget } = {}) {
  return { row: row(), instance: INSTANCE, onConfirm: vi.fn(), onCancel: vi.fn(), ...over };
}

/** Renders and waits for step 0 to settle, so the picker is live. */
async function renderReady(p = props()) {
  const view = render(<AssignDialog {...p} />);
  await screen.findByPlaceholderText("Search contacts");
  return { ...view, props: p };
}

function searchBox() {
  return screen.getByPlaceholderText("Search contacts");
}

/**
 * ONE change event. `userEvent.type` sends a keystroke per character, and on
 * a slow runner a gap between two of them can outlast the debounce and put an
 * intermediate query on the wire - which would make every call-count
 * assertion below flaky.
 */
function search(value: string) {
  fireEvent.change(searchBox(), { target: { value } });
}

beforeEach(() => {
  // A test that fakes timers restores them itself; this is the net for one
  // that throws first. A leaked fake clock hangs every later waitFor.
  vi.useRealTimers();
  vi.clearAllMocks();
  storage.requireOdooConfig.mockResolvedValue(CONFIG);
  client.createOdooClient.mockReturnValue(CLIENT);
  contacts.listContacts.mockResolvedValue([contact()]);
  contacts.upsertContacts.mockResolvedValue(1);
  meetwings.shouldUseMeetwingsAPI.mockResolvedValue(false);
  opportunities.fetchOpportunities.mockResolvedValue([]);
  opportunities.searchLeads.mockResolvedValue([]);
});

describe("AssignDialog lead search (issue #74)", () => {
  // THE point of the port: an unconverted lead has no res.partner, so a
  // search that waited for a contact selection could never reach it.
  it("finds a lead with no contact selected first", async () => {
    opportunities.searchLeads.mockResolvedValue([lead()]);
    await renderReady();

    search("carron");

    const name = await screen.findByText("Partnership with ECS");
    expect(name.textContent).toMatch(/^Lead ·/);
    expect(screen.getByText("Leads & opportunities")).toBeInTheDocument();
    expect(opportunities.searchLeads).toHaveBeenCalledWith(CLIENT, "carron");
    expect(opportunities.fetchOpportunities).not.toHaveBeenCalled();
  });

  // One live XML-RPC round trip per keystroke is what the debounce prevents.
  it("sends ONE search for a burst of typing, with the last query", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await renderReady();
      for (const value of ["c", "ca", "car", "carr"]) search(value);
      expect(opportunities.searchLeads).not.toHaveBeenCalled();

      act(() => {
        vi.advanceTimersByTime(LEAD_SEARCH_DEBOUNCE_MS);
      });

      await waitFor(() => expect(opportunities.searchLeads).toHaveBeenCalledTimes(1));
      expect(opportunities.searchLeads).toHaveBeenCalledWith(CLIENT, "carr");
    } finally {
      vi.useRealTimers();
    }
  });

  // The dialog is mounted only while open; the effect cleanup is what stops a
  // pending timer from outliving it.
  it("never searches after the dialog closes with a keystroke pending", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { unmount } = await renderReady();
      search("carron");
      unmount();

      act(() => {
        vi.advanceTimersByTime(LEAD_SEARCH_DEBOUNCE_MS * 2);
      });
      await act(async () => {
        await Promise.resolve();
      });

      expect(opportunities.searchLeads).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  // `null`, not []: [] would say "No matches" for a query nobody ran.
  it("does not search below two characters, and clears earlier results", async () => {
    opportunities.searchLeads.mockResolvedValue([lead()]);
    await renderReady();

    search("carron");
    expect(await screen.findByText("Partnership with ECS")).toBeInTheDocument();

    search("c");
    await waitFor(() => expect(screen.queryByText("Partnership with ECS")).toBeNull());

    expect(opportunities.searchLeads).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("No matches")).toBeNull();
    expect(screen.queryByTestId("lead-search-section")).toBeNull();
  });

  // Review Focus 1. The in-flight search for "carron" lands after the user
  // emptied the box; painting it would show results for a query that is gone.
  it("drops a search that lands after the box was cleared", async () => {
    const gate = deferred<OdooOpportunity[]>();
    opportunities.searchLeads.mockReturnValue(gate.promise);
    await renderReady();

    search("carron");
    await waitFor(() => expect(opportunities.searchLeads).toHaveBeenCalledTimes(1));
    search("");
    await waitFor(() => expect(screen.queryByTestId("lead-search-section")).toBeNull());

    await act(async () => {
      gate.resolve([lead()]);
    });

    expect(screen.queryByText("Partnership with ECS")).toBeNull();
    expect(screen.queryByTestId("lead-search-section")).toBeNull();
  });

  it("stages a searched lead as a crm.lead target, worded neutrally", async () => {
    opportunities.searchLeads.mockResolvedValue([lead()]);
    const { props: p } = await renderReady();

    search("carron");
    await userEvent.click(await screen.findByRole("button", { name: "add Partnership with ECS" }));

    // The ROW says "Lead"; the destination sentence cannot - SelectedTarget
    // carries `model`, not `type` (see describeTargetForSentence).
    expect(
      screen.getByText(
        "This meeting will be logged on 1 record: the lead or opportunity Partnership with ECS."
      )
    ).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Log this meeting" }));
    expect(p.onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({
        targets: [{ model: "crm.lead", resId: 90, name: "Partnership with ECS" }],
      })
    );
  });

  it("counts a searched lead against the cap", async () => {
    const letters = ["A", "B", "C", "D", "E"];
    contacts.listContacts.mockResolvedValue(letters.map((n, i) => contact({ id: i + 1, name: n })));
    opportunities.searchLeads.mockResolvedValue([lead()]);
    await renderReady();

    for (const n of letters) {
      await userEvent.click(screen.getByRole("button", { name: `add ${n}` }));
    }
    search("carron");

    expect(
      await screen.findByRole("button", { name: "add Partnership with ECS" })
    ).toHaveAttribute("aria-disabled", "true");
  });

  it("takes a searched lead back off through the same toggle", async () => {
    opportunities.searchLeads.mockResolvedValue([lead()]);
    await renderReady();

    search("carron");
    await userEvent.click(await screen.findByRole("button", { name: "add Partnership with ECS" }));
    expect(screen.getByRole("button", { name: "Log this meeting" })).toBeEnabled();

    await userEvent.click(screen.getByRole("button", { name: "added Partnership with ECS" }));
    expect(screen.getByRole("button", { name: "Log this meeting" })).toBeDisabled();
  });

  // The two failures must stay distinguishable on screen: a failed SEARCH
  // says nothing about whether the picked contact has deals.
  it("shows a failed search as its own error, never as the contact's lookup failure", async () => {
    opportunities.searchLeads.mockRejectedValue(new Error("crm.lead blew up"));
    await renderReady();

    await userEvent.click(screen.getByRole("button", { name: "Ada Lovelace" }));
    expect(
      await screen.findByText("No open opportunities or leads for this contact.")
    ).toBeInTheDocument();

    search("carron");

    expect(await screen.findByText("Search failed (ODOO_INTERNAL).")).toBeInTheDocument();
    expect(screen.queryByText(/could not be read/)).toBeNull();
    expect(screen.getByText("No open opportunities or leads for this contact.")).toBeInTheDocument();
    // The code only - never the raw thrown text.
    expect(document.body.textContent).not.toContain("crm.lead blew up");
  });

  // Searches are superseded by later SEARCHES, not by selections.
  it("keeps search results that land after a contact is picked", async () => {
    const gate = deferred<OdooOpportunity[]>();
    opportunities.searchLeads.mockReturnValue(gate.promise);
    opportunities.fetchOpportunities.mockResolvedValue([deal()]);
    await renderReady();

    search("ada");
    await waitFor(() => expect(opportunities.searchLeads).toHaveBeenCalledTimes(1));
    await userEvent.click(screen.getByRole("button", { name: "Ada Lovelace" }));
    expect(await screen.findByText("Heat pumps for the north wing")).toBeInTheDocument();

    await act(async () => {
      gate.resolve([lead()]);
    });

    expect(await screen.findByText("Partnership with ECS")).toBeInTheDocument();
    expect(screen.getByText("Heat pumps for the north wing")).toBeInTheDocument();
  });

  // Review Focus 2. addTarget dedups by model+resId; both rows read the same
  // `targets`, so both must flip together.
  it("stages a lead once when it shows in both lists", async () => {
    const shared = lead({ partnerId: 7, partnerName: "Ada Lovelace", contactName: null });
    opportunities.fetchOpportunities.mockResolvedValue([shared]);
    opportunities.searchLeads.mockResolvedValue([shared]);
    const { props: p } = await renderReady();

    await userEvent.click(screen.getByRole("button", { name: "Ada Lovelace" }));
    await screen.findByText("Partnership with ECS");
    search("ecs");
    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: "add Partnership with ECS" })).toHaveLength(2)
    );

    await userEvent.click(screen.getAllByRole("button", { name: "add Partnership with ECS" })[0]);

    expect(screen.getAllByRole("button", { name: "added Partnership with ECS" })).toHaveLength(2);
    await userEvent.click(screen.getByRole("button", { name: "Log this meeting" }));
    expect(p.onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({
        targets: [{ model: "crm.lead", resId: 90, name: "Partnership with ECS" }],
      })
    );
  });

  describe("replacing a crm.lead target", () => {
    const DEAD_LEAD: MeetingLogTarget = {
      id: "t-90",
      rowId: "un",
      model: "crm.lead",
      resId: 90,
      name: "Partnership with ECS",
      status: "failed",
      attachmentId: 3265,
      messageId: null,
      lastError: "ODOO_FAULT",
      lastErrorCode: "ODOO_FAULT",
      createdAt: 1,
      sentAt: null,
    };

    // Dead or wrong by definition - the same rule `visible` applies to a
    // replaced res.partner.
    it("does not offer the lead it is replacing, in either list", async () => {
      opportunities.fetchOpportunities.mockResolvedValue([
        lead({ partnerId: 7, partnerName: "Ada Lovelace" }),
        deal(),
      ]);
      opportunities.searchLeads.mockResolvedValue([lead(), lead({ id: 91, name: "Solar retrofit" })]);
      await renderReady(props({ replacing: DEAD_LEAD }));

      await userEvent.click(screen.getByRole("button", { name: "Ada Lovelace" }));
      expect(await screen.findByText("Heat pumps for the north wing")).toBeInTheDocument();
      search("re");
      expect(await screen.findByText("Solar retrofit")).toBeInTheDocument();

      expect(screen.queryByText("Partnership with ECS")).toBeNull();
    });

    it("keeps one choice: a second searched lead replaces the first", async () => {
      opportunities.searchLeads.mockResolvedValue([
        lead({ id: 91, name: "Solar retrofit" }),
        lead({ id: 93, name: "Wind audit" }),
      ]);
      const { props: p } = await renderReady(props({ replacing: DEAD_LEAD }));

      search("re");
      await userEvent.click(await screen.findByRole("button", { name: "add Solar retrofit" }));
      await userEvent.click(screen.getByRole("button", { name: "add Wind audit" }));
      await userEvent.click(screen.getByRole("button", { name: "Log this meeting" }));

      expect(p.onConfirm).toHaveBeenCalledWith(
        expect.objectContaining({
          targets: [{ model: "crm.lead", resId: 93, name: "Wind audit" }],
        })
      );
    });
  });
});
```

- [ ] **Step 3: Run the new file to verify it fails**

Run: `npx vitest run src/tests/assign-dialog-deals.test.tsx`
Expected: FAIL — the file cannot import `LEAD_SEARCH_DEBOUNCE_MS` from `AssignDialog` (it is `undefined`), and every search test fails to find `Leads & opportunities` / the lead rows.

- [ ] **Step 4: Implement the search in `AssignDialog.tsx`**

4a. Replace the import on line 21:

```ts
import {
  fetchOpportunities,
  kindLabel,
  LEAD_SEARCH_MIN_CHARS,
  searchLeads,
} from "@/lib/odoo/opportunities";
```

4b. Directly after `const MAX_CONTACT_ROWS = 100;` (line 66), add:

```ts
/**
 * The overlay picker's lead-search debounce (`ContactPicker.LEAD_SEARCH_DEBOUNCE_MS`),
 * restated rather than imported for the reason MAX_CONTACT_ROWS above gives.
 * One live XML-RPC round trip per keystroke is what it exists to prevent.
 */
export const LEAD_SEARCH_DEBOUNCE_MS = 350;
```

4c. Directly after the `joinWithAnd` function (ends line 144), add:

```tsx
/**
 * One crm.lead row, shared by the selected contact's deals and the lead
 * search, so the two lists can never drift apart in what they say about a
 * record. The kind is spelled out on the row (`kindLabel`); the destination
 * sentence words it neutrally instead - see `describeTargetForSentence`.
 */
function OpportunityRow({
  opp,
  targets,
  atCap,
  onAdd,
  onRemove,
}: {
  opp: OdooOpportunity;
  targets: SelectedTargets;
  atCap: boolean;
  onAdd: (t: SelectedTarget) => Promise<{ ok: boolean; reason?: "cap" }>;
  onRemove: (model: SelectedTarget["model"], resId: number) => Promise<void>;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="flex-1 text-left text-xs">
        <span className="text-muted-foreground">{`${kindLabel(opp.type)} · `}</span>
        {opp.name}
        {opp.stageName && <span className="text-muted-foreground">{` · ${opp.stageName}`}</span>}
        {/* Partner, or an unlinked lead free text - see ContactPicker. */}
        {(opp.partnerName ?? opp.contactName ?? opp.email) && (
          <span className="text-muted-foreground">
            {` · ${opp.partnerName ?? opp.contactName ?? opp.email}`}
          </span>
        )}
      </span>
      <AddToggle
        model="crm.lead"
        resId={opp.id}
        name={opp.name}
        targets={targets}
        atCap={atCap}
        onAdd={onAdd}
        onRemove={onRemove}
      />
    </div>
  );
}
```

4d. Directly after `const [isLookingUp, setIsLookingUp] = useState(false);` (line 222), add:

```ts
  /**
   * The lead SEARCH - a different read from the opportunity lookup, with its
   * own state for the reason `useOdooTarget.ts:218-227` gives: sharing one
   * error slot would paint a failed search as a failed lookup under a contact
   * the user already picked successfully.
   */
  const [leadResults, setLeadResults] = useState<OdooOpportunity[] | null>(null);
  const [leadSearchError, setLeadSearchError] = useState<string | null>(null);
  const [isSearchingLeads, setIsSearchingLeads] = useState(false);
```

4e. Directly after `const selectionToken = useRef(0);` (line 264), add:

```ts
  /**
   * Its OWN token, not `selectionToken`: searches are superseded by later
   * searches, not by selections, and picking a contact while a search is in
   * flight must not discard the results the user is about to pick from.
   */
  const leadSearchToken = useRef(0);
```

4f. Directly after the `selectContact` `useCallback` (ends `[getClient]\n  );` at line 377), add:

```ts
  /**
   * NEVER REJECTS - the debounce effect below calls it from a timer, where a
   * rejection is unhandled by construction. Mirrors `useOdooTarget`'s own
   * `onSearchLeads`.
   */
  const onSearchLeads = useCallback(
    async (q: string) => {
      leadSearchToken.current += 1;
      const token = leadSearchToken.current;
      const trimmed = q.trim();

      if (trimmed.length < LEAD_SEARCH_MIN_CHARS) {
        // Not an empty RESULT - no search at all. `null` renders as "nothing
        // asked for yet"; [] would say "No matches" for a query nobody ran.
        setLeadResults(null);
        setLeadSearchError(null);
        setIsSearchingLeads(false);
        return;
      }

      setLeadSearchError(null);
      setIsSearchingLeads(true);
      try {
        const client = await getClient();
        const rows = await searchLeads(client, trimmed);
        if (token !== leadSearchToken.current) return;
        setLeadResults(rows);
        setIsSearchingLeads(false);
      } catch (err) {
        if (token !== leadSearchToken.current) return;
        setLeadSearchError(reportOdooError(err, "search leads").code);
        setIsSearchingLeads(false);
      }
    },
    [getClient]
  );

  /**
   * The live half of the "Search contacts" box, exactly as the overlay picker
   * drives its own (`ContactPicker.tsx:280-285`): one box filters the cached
   * contacts and searches Odoo's leads. The cleanup is what makes this a
   * debounce rather than a delay, and what stops a pending timer outliving
   * the dialog.
   */
  useEffect(() => {
    const timer = setTimeout(() => {
      void onSearchLeads(query);
    }, LEAD_SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, onSearchLeads]);
```

4g. Directly after `const atCap = !replacing && targets.length >= MAX_TARGETS;` (line 427), add:

```ts
  /**
   * The crm.lead being replaced, if any - dead or wrong by definition, so it
   * is offered in neither list, exactly as `visible` above drops a replaced
   * res.partner.
   */
  const replacedLeadId = replacing?.model === "crm.lead" ? replacing.resId : null;
  const shownOpportunities = opportunities?.filter((o) => o.id !== replacedLeadId) ?? null;
  const shownLeadResults = leadResults?.filter((o) => o.id !== replacedLeadId) ?? null;
```

4h. In the render, directly after the contact list's closing `</div>` (line 735 — the `</div>` that closes `<div className="flex max-h-56 flex-col gap-1 overflow-y-auto">`) and before the `</div>` that closes the ready block's `flex flex-col gap-2`, add:

```tsx
            {/*
              THE ONLY WAY TO REACH AN UNCONVERTED LEAD from this dialog: it has
              no res.partner, so there is no contact to select first - which is
              why this lives here and not in the `selected !== null` section.
            */}
            {(isSearchingLeads || leadSearchError !== null || leadResults !== null) && (
              <div className="flex flex-col gap-1 border-t pt-2" data-testid="lead-search-section">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">
                  Leads &amp; opportunities
                </p>
                {leadSearchError !== null ? (
                  <p className="text-xs text-destructive">{`Search failed (${leadSearchError}).`}</p>
                ) : isSearchingLeads ? (
                  <p className="text-xs text-muted-foreground">Searching…</p>
                ) : shownLeadResults !== null && shownLeadResults.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No matches</p>
                ) : (
                  <div
                    className="flex max-h-40 flex-col gap-1 overflow-y-auto"
                    data-testid="lead-search-results"
                  >
                    {(shownLeadResults ?? []).map((lead) => (
                      <OpportunityRow
                        key={lead.id}
                        opp={lead}
                        targets={targets}
                        atCap={atCap}
                        onAdd={addTarget}
                        onRemove={removeTarget}
                      />
                    ))}
                  </div>
                )}
              </div>
            )}
```

4i. Replace the deals list (lines 766-803, from `{opportunityError === null && opportunities !== null && (` through its closing `)}`) with:

```tsx
            {opportunityError === null && shownOpportunities !== null && (
              shownOpportunities.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No open opportunities or leads for this contact.
                </p>
              ) : (
                <div className="flex flex-col gap-1">
                  {shownOpportunities.map((opp) => (
                    <OpportunityRow
                      key={opp.id}
                      opp={opp}
                      targets={targets}
                      atCap={atCap}
                      onAdd={addTarget}
                      onRemove={removeTarget}
                    />
                  ))}
                </div>
              )
            )}
```

- [ ] **Step 5: Run both dialog suites to verify they pass**

Run: `npx vitest run src/tests/assign-dialog-deals.test.tsx src/tests/meeting-log-page.test.tsx`
Expected: PASS. If a `meeting-log-page` AssignDialog test times out, re-run that file alone (`npx vitest run src/tests/meeting-log-page.test.tsx`) before debugging — its dialog tests are known to time out under parallel load and pass alone.

- [ ] **Step 6: Mutation checks — each mutant must turn the named test red**

Apply each to `AssignDialog.tsx`, run `npx vitest run src/tests/assign-dialog-deals.test.tsx`, confirm the named test FAILS, revert. Record each result in your report; a mutant that stays green means the test is not pinning what it claims — fix the test.

| # | Mutant | Must fail |
|---|---|---|
| S1 | delete `return () => clearTimeout(timer);` from the debounce effect | "sends ONE search for a burst of typing…" and "never searches after the dialog closes…" |
| S2 | add `leadSearchToken.current += 1;` as the first line of `selectContact`'s callback (a shared token) | "keeps search results that land after a contact is picked" |
| S3 | delete `if (token !== leadSearchToken.current) return;` from `onSearchLeads`' `try` branch | "drops a search that lands after the box was cleared" |
| S4 | in `onSearchLeads`' `catch`, replace `setLeadSearchError(...)` with `setOpportunityError(reportOdooError(err, "search leads").code)` | "shows a failed search as its own error…" |
| S5 | `shownLeadResults = leadResults` (drop the replaced-lead filter) | "does not offer the lead it is replacing, in either list" |
| S6 | short-query branch sets `setLeadResults([])` instead of `null` | "does not search below two characters…" |

After the last revert, re-run: Expected PASS.

- [ ] **Step 7: Lint and type-check**

Run: `npm run lint`
Expected: no new errors or warnings in the three touched files.

Run: `npx tsc --noEmit`
Expected: no output (exit 0).

- [ ] **Step 8: Commit**

```bash
git add src/pages/meetings/components/AssignDialog.tsx src/tests/assign-dialog-deals.test.tsx src/tests/meeting-log-page.test.tsx
git commit -m "feat(meetings): search leads from the assign dialog" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: `+ add` previews the contact's deals; zero-rows hint

**Files:**
- Modify: `src/pages/meetings/components/AssignDialog.tsx` (`selectContact` doc comment at lines 341-351; the contact row `AddToggle` at lines 723-731; the empty branch of the deals list written in Task 2 Step 4i)
- Test: `src/tests/assign-dialog-deals.test.tsx` (append two `describe` blocks)

**Interfaces:**
- Consumes: from Task 2 — `shownOpportunities`, and the test helpers `renderReady()`, `deal()`, `contact()`, module mocks `opportunities`/`contacts`.
- Produces: no new names. Behaviour: a contact row's `onAdd` calls `addTarget(t)` and then `selectContact(c)` (unless `selected?.id === c.id`), returning `addTarget`'s promise.

- [ ] **Step 1: Append the failing tests**

Append to the end of `src/tests/assign-dialog-deals.test.tsx`:

```tsx
describe("AssignDialog: adding a contact previews its deals (issue #74, C0)", () => {
  // `+ add` is the dialog's prominent action. It used to stage the contact
  // and show no deals at all - "they don't show up after selecting one".
  it("shows a contact's deals when it is added, without a name click", async () => {
    opportunities.fetchOpportunities.mockResolvedValue([deal()]);
    await renderReady();

    await userEvent.click(screen.getByRole("button", { name: "add Ada Lovelace" }));

    expect(await screen.findByText("Heat pumps for the north wing")).toBeInTheDocument();
    expect(opportunities.fetchOpportunities).toHaveBeenCalledTimes(1);
    expect(opportunities.fetchOpportunities.mock.calls[0][1]).toMatchObject({ id: 7 });
    expect(screen.getByRole("button", { name: "Ada Lovelace" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    expect(screen.getByRole("button", { name: "added Ada Lovelace" })).toBeInTheDocument();
  });

  it("does not re-fetch a contact that is already previewed", async () => {
    await renderReady();

    await userEvent.click(screen.getByRole("button", { name: "Ada Lovelace" }));
    await waitFor(() => expect(opportunities.fetchOpportunities).toHaveBeenCalledTimes(1));
    await userEvent.click(screen.getByRole("button", { name: "add Ada Lovelace" }));
    expect(screen.getByRole("button", { name: "added Ada Lovelace" })).toBeInTheDocument();
    // Let a wrongly-fired lookup reach the mock before counting.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(opportunities.fetchOpportunities).toHaveBeenCalledTimes(1);
  });

  it("leaves the preview alone when a contact is taken back off", async () => {
    opportunities.fetchOpportunities.mockResolvedValue([deal()]);
    await renderReady();

    await userEvent.click(screen.getByRole("button", { name: "add Ada Lovelace" }));
    expect(await screen.findByText("Heat pumps for the north wing")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "added Ada Lovelace" }));

    expect(screen.getByRole("button", { name: "add Ada Lovelace" })).toBeInTheDocument();
    expect(screen.getByText("Heat pumps for the north wing")).toBeInTheDocument();
    expect(opportunities.fetchOpportunities).toHaveBeenCalledTimes(1);
  });
});

describe("AssignDialog: zero-rows hint (issue #74)", () => {
  it("points at the search box as its own line under an empty lookup", async () => {
    await renderReady();

    await userEvent.click(screen.getByRole("button", { name: "Ada Lovelace" }));

    // The original line, matched WHOLE: the hint must not be appended to it,
    // or meeting-log-page.test.tsx's "a failed fetch never reads as no open
    // deals" pin would pass whichever branch rendered.
    expect(
      await screen.findByText("No open opportunities or leads for this contact.")
    ).toBeInTheDocument();
    expect(
      screen.getByText("Expecting a deal? Search for it by name in the box above.")
    ).toBeInTheDocument();
  });

  it("never shows the hint when the lookup failed", async () => {
    opportunities.fetchOpportunities.mockRejectedValue(new Error("crm.lead blew up"));
    await renderReady();

    await userEvent.click(screen.getByRole("button", { name: "Ada Lovelace" }));

    expect(await screen.findByText(/could not be read/)).toBeInTheDocument();
    expect(
      screen.queryByText("Expecting a deal? Search for it by name in the box above.")
    ).toBeNull();
    expect(screen.queryByText("No open opportunities or leads for this contact.")).toBeNull();
  });
});
```

- [ ] **Step 2: Run the file to verify the new tests fail**

Run: `npx vitest run src/tests/assign-dialog-deals.test.tsx`
Expected: FAIL — "shows a contact's deals when it is added" (no lookup fires on add), "leaves the preview alone…" (no deal ever shows), and "points at the search box…" (hint absent). "does not re-fetch…" and "never shows the hint…" PASS already; the Task 2 tests still PASS.

- [ ] **Step 3: Implement**

3a. Replace the first paragraph of `selectContact`'s doc comment (lines 341-344):

```ts
  /**
   * Previews a contact's open opportunities/leads below the list - it does
   * NOT add anything. Adding is the row's own `AddToggle`, independent of
   * whether this contact's deals happen to be on screen.
```

with:

```ts
  /**
   * Previews a contact's open opportunities/leads below the list - it does
   * NOT add anything. Adding is the row's own `AddToggle`, which also calls
   * this, so an added contact's deals are on screen (issue #74: `+ add`
   * used to stage a contact and show no deals at all). Previewing still
   * never adds.
```

(leave the `TOKEN-ORDERED on both branches.` paragraph after it unchanged).

3b. Replace the contact row's `AddToggle` (lines 723-731):

```tsx
                    <AddToggle
                      model="res.partner"
                      resId={c.id}
                      name={c.name}
                      targets={targets}
                      atCap={atCap}
                      onAdd={addTarget}
                      onRemove={removeTarget}
                    />
```

with:

```tsx
                    <AddToggle
                      model="res.partner"
                      resId={c.id}
                      name={c.name}
                      targets={targets}
                      atCap={atCap}
                      onAdd={(t) => {
                        const added = addTarget(t);
                        // Adding previews too - see selectContact. A contact
                        // already on screen is not fetched again.
                        if (selected?.id !== c.id) selectContact(c);
                        return added;
                      }}
                      onRemove={removeTarget}
                    />
```

3c. In the deals list from Task 2 Step 4i, replace the empty branch:

```tsx
              shownOpportunities.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No open opportunities or leads for this contact.
                </p>
              ) : (
```

with:

```tsx
              shownOpportunities.length === 0 ? (
                <>
                  <p className="text-xs text-muted-foreground">
                    No open opportunities or leads for this contact.
                  </p>
                  {/*
                    Its OWN element: the line above is matched whole by the
                    "a failed fetch must never read as no open deals" pin
                    (meeting-log-page.test.tsx), which appending would defeat.
                  */}
                  <p className="text-xs text-muted-foreground">
                    Expecting a deal? Search for it by name in the box above.
                  </p>
                </>
              ) : (
```

- [ ] **Step 4: Run both dialog suites to verify they pass**

Run: `npx vitest run src/tests/assign-dialog-deals.test.tsx src/tests/meeting-log-page.test.tsx`
Expected: PASS. (Existing page tests that click `+ add` now also fire a mocked lookup: `meeting-log-page.test.tsx:2223-2225` adds Ada and then clicks Ada's name, which re-fetches and supersedes the first lookup by token; `:2250-2251` and `:2279-2280` click the name first, so the add does not re-fetch. None counts lookups after an add. Same timeout note as Task 2 Step 5.)

- [ ] **Step 5: Mutation checks — each mutant must turn the named test red**

Apply each to `AssignDialog.tsx`, run `npx vitest run src/tests/assign-dialog-deals.test.tsx`, confirm the named test FAILS, revert. Record each result in your report.

| # | Mutant | Must fail |
|---|---|---|
| A1 | contact row back to `onAdd={addTarget}` | "shows a contact's deals when it is added, without a name click" |
| A2 | drop the guard: `selectContact(c);` unconditionally | "does not re-fetch a contact that is already previewed" |
| A3 | merge the hint into the first line: `No open opportunities or leads for this contact. Expecting a deal? Search for it by name in the box above.` in ONE `<p>` | "points at the search box as its own line under an empty lookup" |

After the last revert, re-run: Expected PASS.

- [ ] **Step 6: Lint and type-check**

Run: `npm run lint`
Expected: no new errors or warnings in the touched files.

Run: `npx tsc --noEmit`
Expected: no output (exit 0).

- [ ] **Step 7: Commit**

```bash
git add src/pages/meetings/components/AssignDialog.tsx src/tests/assign-dialog-deals.test.tsx
git commit -m "feat(meetings): show a contact's deals when it is added, hint at search on none" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: `[assign-dialog]` lookup log

**Files:**
- Modify: `src/pages/meetings/components/AssignDialog.tsx` (new module-scope `logLookup` after `OpportunityRow`; `selectContact` try/catch at lines 363-373)
- Test: `src/tests/assign-dialog-deals.test.tsx` (vitest import line; append one `describe`)

**Interfaces:**
- Consumes: from Task 2 — test helpers `renderReady()`, `contact()`, `deal()`, mocks `contacts`/`opportunities`.
- Produces: module-scope `logLookup(contact: OdooContact, rows: number | null, code: string | null): void` (not exported).

- [ ] **Step 1: Write the failing tests**

In `src/tests/assign-dialog-deals.test.tsx`, change the vitest import line to:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
```

and append to the end of the file:

```tsx
describe("[assign-dialog] lookup log (issue #74)", () => {
  let info: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    info = vi.spyOn(console, "info").mockImplementation(() => {});
  });
  afterEach(() => {
    info.mockRestore();
  });

  const lines = () => info.mock.calls.filter((c) => c[0] === "[assign-dialog]");

  // Tells C1 (a company: isCompany, parentId null, rows 0) from C2 (hasEmail,
  // rows 0) in one run - and names nobody.
  it("logs ids, flags and the row count on success, never a name or email", async () => {
    contacts.listContacts.mockResolvedValue([
      contact({ id: 3, name: "Bentley AS", email: "post@bentley.example", isCompany: true }),
    ]);
    opportunities.fetchOpportunities.mockResolvedValue([deal(), deal({ id: 501 })]);
    await renderReady();

    await userEvent.click(screen.getByRole("button", { name: "Bentley AS" }));

    await waitFor(() => expect(lines()).toHaveLength(1));
    expect(lines()[0]).toEqual([
      "[assign-dialog]",
      "opportunities",
      { contactId: 3, parentId: null, isCompany: true, hasEmail: true, rows: 2, code: null },
    ]);
    const flat = JSON.stringify(lines());
    expect(flat).not.toContain("Bentley");
    expect(flat).not.toContain("bentley.example");
    expect(flat).not.toContain("Heat pumps");
  });

  it("logs the error code, and no row count, on failure", async () => {
    opportunities.fetchOpportunities.mockRejectedValue(new Error("crm.lead blew up"));
    await renderReady();

    await userEvent.click(screen.getByRole("button", { name: "Ada Lovelace" }));

    await waitFor(() => expect(lines()).toHaveLength(1));
    expect(lines()[0][2]).toEqual({
      contactId: 7,
      parentId: null,
      isCompany: false,
      hasEmail: false,
      rows: null,
      code: "ODOO_INTERNAL",
    });
  });

  it("counts a whitespace-only email as no email", async () => {
    contacts.listContacts.mockResolvedValue([contact({ email: "   " })]);
    await renderReady();

    await userEvent.click(screen.getByRole("button", { name: "Ada Lovelace" }));

    await waitFor(() => expect(lines()).toHaveLength(1));
    expect(lines()[0][2]).toMatchObject({ hasEmail: false, rows: 0 });
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/tests/assign-dialog-deals.test.tsx`
Expected: FAIL — the three log tests time out on `lines()` having length 0. Every earlier test still PASSES.

- [ ] **Step 3: Implement**

3a. Directly after the `OpportunityRow` component (added in Task 2 Step 4c), add:

```ts
/**
 * Issue #74 instrumentation: one line per contact lookup, so a report of
 * "deals don't show up" can be told apart in one run - C1 (a company:
 * `isCompany`, `parentId: null`, `rows: 0`) from C2 (`hasEmail`, `rows: 0`
 * with an unlinked lead known to exist in Odoo). Follows the #72
 * `[odoo-targets]` precedent (useOdooTarget.ts:255-269): unguarded, and ids,
 * flags, codes and counts only - NEVER the contact's name or email, never a
 * lead's name.
 */
function logLookup(contact: OdooContact, rows: number | null, code: string | null): void {
  console.info("[assign-dialog]", "opportunities", {
    contactId: contact.id,
    parentId: contact.parentId,
    isCompany: contact.isCompany,
    hasEmail: Boolean(contact.email?.trim()),
    rows,
    code,
  });
}
```

3b. In `selectContact`, replace the try/catch (lines 363-373):

```ts
        try {
          const client = await getClient();
          const rows = await fetchOpportunities(client, contact);
          if (token !== selectionToken.current) return;
          setOpportunities(rows);
          setIsLookingUp(false);
        } catch (err) {
          if (token !== selectionToken.current) return;
          setOpportunityError(reportOdooError(err, "fetch opportunities").code);
          setIsLookingUp(false);
        }
```

with:

```ts
        try {
          const client = await getClient();
          const rows = await fetchOpportunities(client, contact);
          if (token !== selectionToken.current) return;
          logLookup(contact, rows.length, null);
          setOpportunities(rows);
          setIsLookingUp(false);
        } catch (err) {
          if (token !== selectionToken.current) return;
          const code = reportOdooError(err, "fetch opportunities").code;
          logLookup(contact, null, code);
          setOpportunityError(code);
          setIsLookingUp(false);
        }
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run src/tests/assign-dialog-deals.test.tsx src/tests/meeting-log-page.test.tsx`
Expected: PASS (same timeout note as Task 2 Step 5).

- [ ] **Step 5: Mutation checks — each mutant must turn the named test red**

Apply each to `AssignDialog.tsx`, run `npx vitest run src/tests/assign-dialog-deals.test.tsx`, confirm the named test FAILS, revert. Record each result in your report.

| # | Mutant | Must fail |
|---|---|---|
| L1 | add `name: contact.name,` to the logged object | "logs ids, flags and the row count on success, never a name or email" |
| L2 | `hasEmail: contact.email !== null` | "counts a whitespace-only email as no email" |
| L3 | delete the `logLookup(contact, null, code);` call in the `catch` | "logs the error code, and no row count, on failure" |

After the last revert, re-run: Expected PASS.

- [ ] **Step 6: Lint and type-check**

Run: `npm run lint`
Expected: no new errors or warnings in the touched files.

Run: `npx tsc --noEmit`
Expected: no output (exit 0).

- [ ] **Step 7: Commit**

```bash
git add src/pages/meetings/components/AssignDialog.tsx src/tests/assign-dialog-deals.test.tsx
git commit -m "feat(meetings): log each assign-dialog deal lookup, ids and counts only" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Final verification

- [ ] Run: `npx vitest run src/tests/odoo-opportunities.test.ts src/tests/assign-dialog-deals.test.tsx src/tests/meeting-log-page.test.tsx src/tests/odoo-contact-picker.test.tsx src/tests/useOdooTarget.test.tsx`
  Expected: PASS. The last two are untouched overlay suites, run to prove the overlay is unchanged.
- [ ] Run: `npm run lint` — Expected: no new errors.
- [ ] Run: `npx tsc --noEmit` — Expected: no output (exit 0).

## Reporter verification (manual, not a task — before closing #74)

The release build has no webview devtools (no `devtools` feature in `src-tauri/Cargo.toml` / `src-tauri/tauri.conf.json`), so the `[assign-dialog]` line is read from a dev build, the same way #72's `[odoo-targets]` lines are: run `npm run tauri dev`, open the meetings page's devtools console, open Assign on a queued meeting, and `+ add` the contact whose deals were missing. Deals now showing closes C0/C1/C2; `rows: 0` persisting with `isCompany`/`hasEmail` recorded is the input for the C3 / record-rule follow-ups.

## Notes for the PR description

Two behaviour choices were made hands-off during automated spec review, between alternatives the reviewers offered — name them in the PR so a human sees them:

1. **`+ add` on a contact also previews its deals** (C0). The alternative was to leave the UI and only document the candidate; there was no evidence to rule C0 out.
2. **The lead search is driven by the existing "Search contacts" box**, not a second input inside the deals section — matching the overlay, and reachable with no contact selected.
