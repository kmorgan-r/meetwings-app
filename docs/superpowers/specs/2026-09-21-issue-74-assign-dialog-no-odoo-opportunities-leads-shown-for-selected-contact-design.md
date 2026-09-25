# Assign dialog: no Odoo opportunities/leads shown for the selected contact

Issue: [#74](https://github.com/kmorgan-r/meetwings-app/issues/74)
Part of: [#71](https://github.com/kmorgan-r/meetwings-app/issues/71)
Date: 2026-09-21
Status: design written, plan not yet written

The meetings page's Assign dialog lists Odoo contacts fine, but the reporter
says opportunities and leads "don't show up after selecting one" — for
contacts the reporter knows have open deals. The same reporter can reach
those deals from the overlay during a meeting. The dialog's deal lookup must
find what the overlay can find.

"Don't show up" fits two different screens, and the issue does not say which
one the reporter saw: the deals panel reading "No open opportunities or leads
for this contact." (C1/C2 below), or no deals panel at all (C0). This spec
fixes both rather than guess.

## What the issue already settled — design inputs, not open questions

These are constraints this spec builds on. Do not re-derive them.

- **No transport failure.** Both surfaces call the same primitive —
  `fetchOpportunities` (`src/lib/odoo/opportunities.ts:141-152`) — from
  `useOdooTarget.ts:870` in the overlay and `AssignDialog.tsx:365` in the
  dialog. A meetings-page-specific failure mode is ruled out.
- **The contacts fed to both calls come from the same cache.** The overlay's
  `onSelect` passes the `OdooContact` it was clicked with
  (`useOdooTarget.ts:836-882`); the dialog passes a row from `listContacts`
  (`src/lib/database/odoo-contacts.action.ts:122-129`). Same shape, same
  source, same domain inputs — so any theory of the form "the domain gets bad
  input" must explain why the overlay still shows the reporter's deals.
- **Errors are not silently swallowed.** The dialog renders
  `opportunityError` with a Retry button
  (`src/pages/meetings/components/AssignDialog.tsx:745-764`), and
  `src/tests/meeting-log-page.test.tsx:1988-2016` pins that a failed fetch
  must never read as "no open deals". The "silent error handling" candidate in
  the issue is dead on arrival.
- **The zero-rows state is distinguishable from a failure.** The dialog shows
  `No open opportunities or leads for this contact.`
  (`AssignDialog.tsx:766-770`) only when the fetch succeeded and returned
  nothing. What is *not* distinguishable is "the domain could never have found
  these records" from "the contact genuinely has none" — that gap is this
  spec's real subject.
- **`SelectedTarget` already carries `model: "crm.lead"`.** The database layer,
  the cap check and the dialog's own `addTarget`/`removeTarget` are generic
  over model (`odoo-contacts.action.test.ts:234` round-trips a `crm.lead`
  row; `AssignDialog.tsx:133-138`'s `describeTargetForSentence` already
  words one neutrally). Adding a lead target from the dialog is wiring, not
  schema work.

## Why the overlay works and the dialog does not

The divergence is the tell. Both surfaces run the identical domain over the
identical contact, so the difference must live in what each surface can reach
*around* the lookup:

- The overlay has **free-text lead search** — `searchLeads`
  (`opportunities.ts:195-213`), driven by the **same query as the contact
  filter** (`ContactPicker.tsx:280-285`, debounced 350 ms), with its own
  `searchToken` in `useOdooTarget`. It needs no contact selected first.
  `leadSearchDomain` (`opportunities.ts:177-193`) matches on `name`,
  `contact_name`, `partner_name` and `email_from` with wrapping `ilike` and
  **no partner-link restriction at all** — it reaches records the
  contact-first lookup structurally cannot.
- In the overlay, clicking a contact both selects it and fetches its deals
  (`useOdooTarget.ts:836-882`).
- The dialog has nothing but the contact-first lookup, and only behind a click
  on the contact's *name*: its `+ add` toggle stages the contact without ever
  showing its deals (`AssignDialog.tsx:341-344`, `:723-731`; the panel is
  gated on `selected !== null` at `:739`).

So the reporter's experience composes: either the deals panel never opened
(C0), or it opened and the contact-first domain missed the deals for a reason
below (C1/C2) — and in both cases the overlay's search box finds them anyway.

## Root-cause candidates, ranked, with the code evidence

### C0 — adding a contact never shows its deals

In the dialog, `+ add` on a contact row calls `addTarget` only; the deals
panel appears solely after a separate click on the contact's name
(`AssignDialog.tsx:704-731`, `:739`). A user who adds a contact — the dialog's
prominent action — sees no opportunities or leads at all, which matches
"don't show up after selecting one" without any Odoo-side cause. The overlay
has no such split: selecting a contact is what fetches its deals.

### C1 — selecting a company misses deals linked to its child contacts

`searchDomain` builds `partnerIds` as
`parentId === null ? [contact.id] : [contact.id, contact.parentId]`
(`opportunities.ts:74-75`). For a **person** this covers the person and their
company. For a **company** — `parentId === null` in every real cache row — it
covers only the company itself, and Odoo CRMs routinely link the opportunity
to the *person* partner under that company. Selecting the company then finds
nothing: the contact *is* listed, its deals are not.

The overlay is not immune to C1 either — but its search box rescues the user,
which is why the surfaces diverge in practice.

### C2 — the unlinked-lead identity arm cannot match Odoo 17's `email_from`

The second OR branch of `searchDomain` (`opportunities.ts:100-113`) reaches
**unlinked leads only** — it is gated on `["partner_id", "=", false]` and
`["type", "=", "lead"]`, and matches them by
`["email_from", "=ilike", contact.email]` and
`["contact_name", "=ilike", contact.name]`.

`email_from` on `crm.lead` is a free-text char field that stock Odoo fills
with the formatted `"Jane Doe" <jane@acme.example>` string, not the bare
address. `=ilike` is exact-and-case-insensitive — a raw address never matches
a formatted value. Stock Odoo 13+ also carries `email_normalized`, a stored,
lowercase copy of `email_from` built precisely for this comparison. The arm
matches against the one representation the field is least likely to hold.

This candidate affects unlinked leads only; C1 remains the primary
explanation for missing *opportunities*. It is fixed here because the fix is
one clause and the issue asks the identity arm be inspected against real Odoo
17 data regardless.

### C3 — stale cache ids

The lookup runs `partner_id in <cached ids>` against a cache as fresh as the
last sync, and there is no live partner search anywhere. This is unlikely to
be the reporter's cause — the overlay works off the same cache — but it is a
standing gap the issue names, and it belongs in follow-up work, not in this
change: a live re-read on the zero-rows path is a second round trip whose
value nobody has measured yet.

## The invariant

**"No open opportunities or leads" is a claim about the user's CRM, and it may
only be made when the search could actually have found the records.**

Concretely, two rules:

1. **Coverage parity.** Every record reachable from the overlay's deal
   surfaces must be reachable from the dialog: a contact's deals from the
   action that stages it (C0's fix), partner-linked records under the
   contact's own row of the company tree (C1's fix), and free-text reachable
   leads with no contact selected first (the search port). After this change,
   the one remaining overlay-only surface is nothing.
2. **No silent misattribution.** Broadening coverage must not drag in records
   that belong to *other* contacts. A sibling person's deals must stay hidden
   under a person's row; only self, descendants (children of the selected
   company) and the direct parent (the person's own company) may appear
   partner-linked, and the identity arm must match one exact address — never
   an SQL wildcard pattern.

## Scope

### In

- **C0 fix** — adding a contact through its row's `+ add` also previews its
  deals, exactly as clicking its name does.
- **C1 fix** — `searchDomain`'s linked clause becomes `child_of`-based so a
  selected company reaches deals linked to its child contacts, and a selected
  person keeps today's parent coverage.
- **C2 fix** — the unlinked-lead identity arm matches `email_normalized` by
  exact `=` on the normalized address, instead of raw `email_from`.
- **Search port** — the dialog gains the same free-text lead search the
  overlay has: `searchLeads`, driven by the dialog's existing "Search
  contacts" query, debounced, with its own state and its own token, results
  addable as `crm.lead` targets through the dialog's existing `addTarget`.
- **Diagnostics** — a `console.info` in the dialog's lookup path, following
  the issue #72 `[odoo-targets]` precedent (`useOdooTarget.ts:255-269`), so
  the reporter can confirm which candidate bit them.
- **Zero-rows hint** — when the contact-first lookup returns zero rows, a
  separate line under the empty state points at the search box, because after
  this change "no deals" and "try the search" are both true statements the
  user can act on.

### Out, and why

- **No live partner re-read / cache-refresh on zero rows (C3).** The overlay's
  success on the same cache argues against stale ids, and the added round trip
  needs data before it earns its place. Follow-up.
- **No record-rule visibility handling.** When the XML-RPC user cannot read
  `crm.lead` rows, Odoo returns `[]` and the dialog says "no open deals". This
  is indistinguishable from a genuine empty CRM without server-side evidence;
  surfacing it needs the diagnostics output first. Follow-up.
- **`QueueRow` hiding Assign once any target is `sent`**
  (`src/pages/meetings/components/QueueRow.tsx:537-546`) is deliberate
  behaviour with its own rationale, not part of this bug.
- **No changes to `leadSearchDomain` or `searchLeads`' overlay behaviour.**
  The overlay path works; this change adds consumers, not edits.
- **No schema changes.** `SelectedTarget`, the cap table and the dialog's
  staged-target machinery are reused as-is.

## Architecture

Two changed units, one new wiring block. No new modules.

| Unit | File | Job |
| --- | --- | --- |
| `searchDomain` | `src/lib/odoo/opportunities.ts:73-113` | Broaden the linked clause to `child_of`; swap the identity arm's email clause to `email_normalized =`. Pure function; its existing test file pins composition. |
| dialog search state | `src/pages/meetings/components/AssignDialog.tsx` | Own `leadResults`/`leadSearchError`/`isSearchingLeads` state trio and a `leadSearchToken` ref, mirroring `useOdooTarget.ts`'s split between lookup and search state; a debounced effect on the existing `query`. |
| search UI + C0 wiring | same file | A "Leads & opportunities" results block under the contact list, outside the `selected !== null` section, rendering results through `AddToggle` rows; the contact rows' `onAdd` also previews. |

**Why the dialog keeps its own search state instead of sharing a hook.**
`useOdooTarget`'s search state is deliberately private to the overlay's
picker flow, and its doc comment (`useOdooTarget.ts:218-227`) explains why it
is separate from the lookup state — the same reasoning applies *within* the
dialog: a failed search must not paint as a failed lookup under a contact the
user already picked, and vice versa. The dialog already holds both halves of
this pattern (`opportunities`/`opportunityError` beside the create-form's
independent states); the search states join them, not replace them.

**Why a separate token, not `selectionToken`.** Same reasoning as
`useOdooTarget.ts:273-280`'s `searchToken`: searches are superseded by later
searches, not by selections, and a selection made while a search is in flight
must not silently discard the results the user is about to pick from. The
dialog gets a `leadSearchToken` ref bumped by the search handler only;
`selectContact` never reads or writes it and never touches the search state
trio — the same as the overlay's `onSelect` (`useOdooTarget.ts:836-849`).

## The domain changes

### Linked clause: `child_of`

`linked` changes type from one `XmlRpcValue` to an `XmlRpcValue[]` and is
**spread** at both of its insertion points (the identity-less early return at
`opportunities.ts:98` and the `|` branch at `:106`). Pushing the person case
as one nested element would produce an invalid prefix domain — the operator
arity is load-bearing (`odoo-opportunities.test.ts:153-160`).

Replace

```
["partner_id", "in", partnerIds]
```

with, when `contact.parentId !== null`, the three prefix items:

```
"|", ["partner_id", "child_of", contact.id], ["partner_id", "=", contact.parentId]
```

and when `contact.parentId === null`, the one item:

```
["partner_id", "child_of", contact.id]
```

`child_of` is a core Odoo expression operator over the target model's
hierarchy; on `res.partner` (Odoo 13+, `parent_path`-backed) it resolves to
"this partner or any partner below it". The two cases:

- **Company selected** (`parentId === null` in practice): `child_of` reaches
  the company itself *and* its child person partners — C1's whole gap.
- **Person selected** (`parentId !== null`): `child_of` resolves to the person
  alone (they have no children), and the parent clause keeps today's
  company-linked coverage. Net behaviour change: none for persons.

**`child_of` with a list is deliberately not used.** Odoo accepts it, but the
single-id form with an explicit OR reads as exactly the two relationships this
feature recognises — self-and-descendants, or the direct parent — and matches
the existing `|`-composition style of `searchDomain`. If a third relation ever
matters, the domain grows a clause, not a cleverness.

**What this must NOT surface:** a person's sibling's deals. `child_of` walks
*down* only, and the parent clause names one id. A deal linked to a sibling
person matches neither arm — correct, per invariant 2.

### Identity arm: `email_normalized`

Replace `["email_from", "=ilike", contact.email]` with
`["email_normalized", "=", normalizeAddress(contact.email)]`, reusing
`normalizeAddress` (`src/lib/calendar/match-attendees.ts:4`, trim +
lowercase), which `create-contact.ts` already imports for the same job.

`email_normalized` is a stored, lowercase, computed char field on `crm.lead`
in stock Odoo since 13 — the reporter is on 17 — and it exists precisely
because `email_from`'s raw text carries display-name formatting.

**Exact `=`, not `=ilike`.** `=ilike` is SQL `ILIKE` with no escaping: `_`
matches any single character and `%` any sequence
(`create-contact.ts:79-88`). Once the arm actually matches, `=ilike` on
`jane_doe@acme.example` would also surface an unlinked lead for
`jane.doe@acme.example` — a misattribution invariant 2 forbids. The field is
already lowercase, so normalizing our side and comparing with `=` is both
exact and case-insensitive in effect.

The `contact_name =ilike name` arm stays as the second identity path, and the
arm stays gated on `partner_id = false` and `type = lead`: it exists to reach
unlinked leads, and broadening it would violate invariant 2.

**Known limitation, accepted:** a customised install that drops
`email_normalized` makes `search_read` fault. That surfaces as
`ODOO_FAULT` in the dialog's existing error row — visible, retryable, and
diagnosable from the new log line — rather than as a silent empty list.

## The dialog search

Driven by the dialog's existing `query` — the "Search contacts" input at
`AssignDialog.tsx:617-626` — exactly as the overlay drives its lead search off
the contact filter's query (`ContactPicker.tsx:280-285`). No second input:
one box filters the cached contacts and, live, searches Odoo's leads.

- **Debounced.** A `useEffect` on `[query, onSearchLeads]` sets a
  `setTimeout(..., LEAD_SEARCH_DEBOUNCE_MS)` and clears it in the cleanup, so
  only the last keystroke of a burst goes on the wire, and a pending timer
  dies with the dialog (which is mounted only while open). The handler is
  called with `void` from the timer and is documented and written **never to
  reject** — every await inside a try, as `useOdooTarget.ts:934-969`'s
  `onSearchLeads` does.
- **Constants.** `LEAD_SEARCH_LIMIT` and `LEAD_SEARCH_MIN_CHARS` are imported
  from `@/lib/odoo/opportunities` (shared lib, the two surfaces must not
  drift). `LEAD_SEARCH_DEBOUNCE_MS` (350) is **restated** locally, not
  imported from `ContactPicker.tsx` — the same rule `MAX_CONTACT_ROWS`
  follows at `AssignDialog.tsx:57-66`: it is the overlay picker's own
  contract, and importing across page trees would drag the overlay component
  into the dialog's module graph.
- **Below two characters** no request fires and the state resets to
  `leadResults = null` (nothing asked for yet), `leadSearchError = null`,
  `isSearchingLeads = false` — `null`, never `[]`, which would render "No
  matches" for a query nobody ran (`useOdooTarget.ts:944-951`).
- **Placement.** A "Leads & opportunities" block rendered under the contact
  list whenever `preflight.state === "ready"` and the search has something to
  show (`isSearchingLeads || leadSearchError !== null || leadResults !==
  null`, as `ContactPicker.tsx:651`) — **not** inside the `selected !== null`
  deals section. An unlinked lead has no contact to select first, so a search
  gated on a selection could never reach it.
- **Rows** use the same shape the contact's own deal rows use
  (`AssignDialog.tsx:773-800`): `kindLabel(lead.type)` prefix, name, stage,
  partner-or-contact text. `AddToggle` is wired to the dialog's existing
  `addTarget`/`removeTarget` with `{ model: "crm.lead", resId: <lead id>,
  name: <lead name> }`. The staged-target list, `MAX_TARGETS` cap and Confirm
  gate are untouched; a lead takes a slot like any target, and the
  destination sentence words it neutrally via `describeTargetForSentence`.
- **Replacing mode.** When `replacing` is set, `addTarget` replaces the list
  with the one pick (`AssignDialog.tsx:441`) and `atCap` is `false`
  (`:427`) — search results obey this unchanged. When
  `replacing.model === "crm.lead"`, the replaced `resId` is filtered out of
  the search results **and** out of the contact's own deal rows, mirroring the
  contact list's `res.partner` exclusion at `:413-415`: the record being
  replaced is dead or wrong by definition.
- **Errors** surface as a one-line row in the block, from `reportOdooError`'s
  code — the same code-only rule the lookup error follows at
  `AssignDialog.tsx:754`. A search error never sets `opportunityError`.
- **Scope.** The search state lives and dies with the dialog session, as every
  other state in the dialog already does.

### C0: add previews

The contact rows' `AddToggle` `onAdd` becomes: `addTarget(t)`, then
`selectContact(c)` unless `selected?.id === c.id` already. Removing a contact
does not change the preview. The existing `selectContact` token ordering
covers a preview fired this way exactly as it covers a name click.

### Zero-rows hint

When `opportunityError === null && opportunities !== null &&
opportunities.length === 0`, the existing line (`AssignDialog.tsx:766-770`)
stays **byte-for-byte unchanged**, and a second, separate `<p>` follows it:

> Expecting a deal? Search for it by name in the box above.

A separate element, not a sentence appended to the first: the exact-text
assertions `meeting-log-page.test.tsx:2008` and `:2030` match that line's
whole text, and `:2008` is the "a failed fetch must never read as no open
deals" pin — appending to it would make that `queryByText(...).toBeNull()`
pass whichever branch renders. The hint does **not** render when
`opportunityError !== null`; the error branch's "Whether … has open deals is
unknown" wording stays exactly as pinned.

## Diagnostics

One `console.info` inside `selectContact`, after the fetch resolves and in the
catch, following the #72 `[odoo-targets]` precedent (`useOdooTarget.ts:255-269`
— unguarded, ids and counts only):

```
[assign-dialog] opportunities { contactId, parentId, isCompany, hasEmail, rows, code }
```

`code` is `null` on success and the `reportOdooError` code on failure. It logs
ids, booleans, codes and counts — **never the contact's name or email, never
lead names or subjects**. Not gated on `import.meta.env.DEV`: the reporter
runs the release build, and a dev-only line would never reach them. It reaches
exactly where #72's lines already reach.

What it tells apart in one run: C0 (no line at all — no lookup ran), C1
(`isCompany: true`, `parentId: null`, `rows: 0`) and C2 (`hasEmail: true`,
`rows: 0` with an unlinked lead known to exist in Odoo). It cannot detect C3
— it logs only the cached id — which stays follow-up work.

## Testing

Vitest, extending `src/tests/odoo-opportunities.test.ts` (pure domain
composition) and a new dialog-level test file for the search, following
`src/tests/meeting-log-page.test.tsx`'s dialog harness.

**`odoo-opportunities.test.ts` — existing assertions that must be rewritten**

These pin the pre-fix composition and fail once C1/C2 land; they are
rewritten to the new shape, not left beside contradictory new tests:

- `:162-182` whole-domain `toEqual` (person) → the new `|`/`child_of`/`=`
  composition and `["email_normalized", "=", ...]`
- `:189-195` `["partner_id", "in", ...]` `toContainEqual` pair → the
  `child_of` forms
- `:206-213` `email_from =ilike` → `email_normalized =`
- `:217-222` "never uses a substring operator" → still asserts no `"ilike"`
  / `"like"`; `=ilike` now appears only on `contact_name`
- `:226` `not.toContain("email_from")` → retargeted to `email_normalized`,
  otherwise it becomes vacuously true and stops guarding the no-email path
- `:232-241` identity-less whole-domain `toEqual` → `child_of` form

**`odoo-opportunities.test.ts` — new**

- a company contact (`parentId === null`) composes, **whole-domain
  `toEqual`**, `["partner_id", "child_of", <id>]` — no `in`, no parent clause
- a person contact composes, **whole-domain `toEqual`**, the flattened
  `"|", child_of(person), ["partner_id", "=", parentId]` — pinning the spread
  (a nested `["|", ...]` element fails it) and **not** a `child_of` over both
  ids
- the identity-less early return for a person is also flattened (whole-domain)
- the identity arm names `email_normalized` with `=` and a normalized value:
  a contact email `"  Ada@Analytical.EXAMPLE "` composes
  `["email_normalized", "=", "ada@analytical.example"]`
- the identity arm stays gated on `partner_id = false` and `type = lead`
- a **mutant check**: replacing `child_of` with `in [contact.id]` must fail
  the company fixture — C1's regression pin
- a **mutant check**: swapping the field back to `email_from`, or the
  operator back to `=ilike`, must fail the identity-arm assertion

**Dialog tests — harness**

- `@/lib/odoo/opportunities` is mocked wholesale at
  `meeting-log-page.test.tsx:83-91`, and vitest throws on access to any export
  a mock factory omits. Once `AssignDialog` imports the new names, **every**
  existing dialog test there breaks unless that mock gains
  `searchLeads: vi.fn(async () => [])`, `LEAD_SEARCH_LIMIT: 10` and
  `LEAD_SEARCH_MIN_CHARS: 2`, with `searchLeads`' default re-established in
  that file's `beforeEach` (`:304-339`), as `fetchOpportunities`' is. The new
  test file carries the same mock.
- Existing tests that type into "Search contacts" now also fire the (mocked)
  lead search after the debounce; with the `[]` default they are unaffected.

**Dialog tests — new**

- the debounce, with fake timers: a burst of keystrokes inside
  `LEAD_SEARCH_DEBOUNCE_MS` calls `searchLeads` exactly once, with the final
  query; closing the dialog with a timer pending calls it zero times
- below 2 characters, `searchLeads` is **not called** and no "No matches"
  state renders; a prior result set is cleared
- lead results render with **no contact selected**
- a search result adds `{ model: "crm.lead", resId, name }` through
  `addTarget` and counts against the cap; its row carries the `kindLabel`
  prefix ("Lead ·" / "Opportunity ·"), and the destination sentence words it
  neutrally ("the lead or opportunity X") — asserted separately
- removing a searched-in lead target works through the existing
  `removeTarget` path
- a failed search renders its error code and does **not** set
  `opportunityError` — the two failures must stay distinguishable on screen
- selecting a contact while a search is in flight does **not** discard the
  search results when they land, and the contact's own deal list renders
  beside them
- replacing mode: picking a search result replaces the single choice; with
  `replacing.model === "crm.lead"`, the replaced lead is absent from both the
  search results and the contact's deal rows
- C0: clicking `+ add` on a contact fetches and shows its deals without a name
  click; `+ add` on the already-selected contact does not re-fetch
- the zero-rows hint renders as its own element on an empty successful lookup,
  the original "No open opportunities or leads for this contact." line still
  matches exactly, and the hint does not render in the error branch
- the `[assign-dialog]` line fires on success and on failure with
  `{ contactId, parentId, isCompany, hasEmail, rows, code }`, and its payload
  contains neither the contact's name nor its email

## Follow-up work

Not in this change:

- Live partner re-read on zero rows (C3) — needs the diagnostics output to
  justify the round trip.
- Surfacing record-rule invisibility (Odoo returns `[]` for a user who cannot
  read `crm.lead`) — same dependency.
- A shared search component if a third consumer appears; two call sites do
  not yet pay for the abstraction.
- The reporter's confirmation that the fixed domain finds their deals, before
  #74 closes.
