# Assign dialog: no Odoo opportunities/leads shown for the selected contact

Issue: [#74](https://github.com/kmorgan-r/meetwings-app/issues/74)
Part of: [#71](https://github.com/kmorgan-r/meetwings-app/issues/71)
Date: 2026-09-21
Status: design written, plan not yet written

The meetings page's Assign dialog lists Odoo contacts fine, but after clicking
a contact's name the deals panel reads "No open opportunities or leads for this
contact." for contacts the reporter knows have open deals. The same reporter
can reach those deals from the overlay during a meeting. The dialog's deal
lookup must find what the overlay can find.

## What the issue already settled — design inputs, not open questions

These are constraints this spec builds on. Do not re-derive them.

- **No transport failure.** Both surfaces call the same primitive —
  `fetchOpportunities` (`src/lib/odoo/opportunities.ts:141-152`) — from
  `useOdooTarget.ts:830` in the overlay and `AssignDialog.tsx:359` in the
  dialog. A meetings-page-specific failure mode is ruled out.
- **The contacts fed to both calls come from the same cache.** The overlay's
  `onSelect` passes the `OdooContact` it was clicked with
  (`useOdooTarget.ts:796-842`); the dialog passes a row from `listContacts`
  (`src/lib/database/odoo-contacts.action.ts:122-129`). Same shape, same
  source, same domain inputs — so any theory of the form "the domain gets bad
  input" must explain why the overlay still shows the reporter's deals.
- **Errors are not silently swallowed.** The dialog renders
  `opportunityError` with a Retry button
  (`src/pages/meetings/components/AssignDialog.tsx:737-756`), and
  `src/tests/meeting-log-page.test.tsx:1880` pins that a failed fetch must
  never read as "no open deals". The "silent error handling" candidate in the
  issue is dead on arrival.
- **The zero-rows state is distinguishable from a failure.** The dialog shows
  `No open opportunities or leads for this contact.`
  (`AssignDialog.tsx:759-762`) only when the fetch succeeded and returned
  nothing. What is *not* distinguishable is "the domain could never have found
  these records" from "the contact genuinely has none" — that gap is this
  spec's real subject.
- **`SelectedTarget` already carries `model: "crm.lead"`.** The database layer,
  the cap check and the dialog's own `addTarget`/`removeTarget` are generic
  over model (`odoo-contacts.action.test.ts:234` round-trips a `crm.lead`
  row; `AssignDialog.tsx:108-111` already renders neutral wording for one).
  Adding a lead target from the dialog is wiring, not schema work.

## Why the overlay works and the dialog does not

The divergence is the tell. Both surfaces run the identical domain over the
identical contact, so the difference must live in what each surface can reach
*around* the lookup:

- The overlay has **free-text lead search** — `searchLeads`
  (`opportunities.ts:195-213`), reached from `useOdooTarget`'s own search box
  with its own `searchToken`. `leadSearchDomain`
  (`opportunities.ts:177-193`) matches on `name`, `contact_name`,
  `partner_name` and `email_from` with wrapping `ilike` and **no partner-link
  restriction at all** — it reaches records the contact-first lookup
  structurally cannot.
- The dialog has nothing but the contact-first lookup.

So the reporter's experience composes: the deals exist, the contact-first
domain misses them for a reason below, and the overlay's search box finds them
anyway. On the meetings page the same miss renders as an absolute sentence —
"No open opportunities or leads for this contact." — which is what got
reported.

## Root-cause candidates, ranked, with the code evidence

### C1 — selecting a company misses deals linked to its child contacts

`searchDomain` builds `partnerIds` as
`parentId === null ? [contact.id] : [contact.id, contact.parentId]`
(`opportunities.ts:74-75`). For a **person** this covers the person and their
company. For a **company** — `parentId === null` in every real cache row — it
covers only the company itself, and Odoo CRMs routinely link the opportunity
to the *person* partner under that company. Selecting the company then finds
nothing, and this is exactly the shape the reporter describes: the contact
*is* listed, its deals are not.

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
   surfaces must be reachable from the dialog: partner-linked records under
   the contact's own row of the company tree (C1's fix), and free-text
   reachable leads (the search port). After this change, the one remaining
   overlay-only surface is nothing.
2. **No silent misattribution.** Broadening coverage must not drag in records
   that belong to *other* contacts. A sibling person's deals must stay hidden
   under a person's row; only self, descendants (children of the selected
   company) and the direct parent (the person's own company) may appear
   partner-linked.

## Scope

### In

- **C1 fix** — `searchDomain`'s linked clause becomes `child_of`-based so a
  selected company reaches deals linked to its child contacts, and a selected
  person keeps today's parent coverage.
- **C2 fix** — the unlinked-lead identity arm matches `email_normalized`
  instead of raw `email_from`.
- **Search port** — the dialog's deals section gains the same free-text lead
  search the overlay has: `searchLeads`, its own state, its own token, results
  addable as `crm.lead` targets through the dialog's existing `addTarget`.
- **Dev-only diagnostics** — a `console.debug` in the dialog's lookup path
  logging the domain, the contact's `{id, parentId, email, name}` and the row
  count, so the reporter can confirm which candidate bit them without another
  release cycle.
- **Zero-rows hint** — when the contact-first lookup returns zero rows, the
  empty-state line points at the search box, because after this change "no
  deals" and "try the search" are both true statements the user can act on.

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
| `searchDomain` | `src/lib/odoo/opportunities.ts:73-113` | Broaden the linked clause to `child_of`; swap the identity arm's email field. Pure function; its existing test file pins composition. |
| dialog search state | `src/pages/meetings/components/AssignDialog.tsx` | Own `leadResults`/`leadSearchError`/`isSearchingLeads` state trio and a `searchToken` ref, mirroring `useOdooTarget.ts`'s split between lookup and search state. |
| search UI | same file | A search input in the deals section under `selected !== null`, rendering results through the existing `AddToggle` rows. |

**Why the dialog keeps its own search state instead of sharing a hook.**
`useOdooTarget`'s search state is deliberately private to the overlay's
picker flow, and its doc comment (`useOdooTarget.ts:216-226`) explains why it
is separate from the lookup state — the same reasoning applies *within* the
dialog: a failed search must not paint as a failed lookup under a contact the
user already picked, and vice versa. The dialog already holds both halves of
this pattern (`opportunities`/`opportunityError` beside the create-form's
independent states); the search states join them, not replace them.

**Why a separate token, not `selectionToken`.** Same reasoning as
`useOdooTarget.ts`'s `searchToken`: searches are superseded by later
searches, not by selections, and a selection made while a search is in flight
must not silently discard the results the user is about to pick from. The
dialog gets a `leadSearchToken` ref bumped by the search input's handler
only.

## The domain changes

### Linked clause: `child_of`

Replace

```
["partner_id", "in", partnerIds]
```

with, when `contact.parentId !== null`:

```
["|", ["partner_id", "child_of", contact.id], ["partner_id", "=", contact.parentId]]
```

and when `contact.parentId === null`:

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
`["email_normalized", "=ilike", contact.email]`.

`email_normalized` is a stored, lowercase, computed char field on `crm.lead`
in stock Odoo since 13 — the reporter is on 17 — and it exists precisely
because `email_from`'s raw text carries display-name formatting. `=ilike`
rather than `=` keeps the house pattern (`create-contact.ts` matches partners
the same way) and costs nothing on a field that is already lowercase.

The `contact_name =ilike name` arm stays as the second identity path, and the
arm stays gated on `partner_id = false` and `type = lead`: it exists to reach
unlinked leads, and broadening it would violate invariant 2.

**Known limitation, accepted:** a customised install that drops
`email_normalized` makes `search_read` fault. That surfaces as
`ODOO_FAULT` in the dialog's existing error row — visible, retryable, and
diagnosable from the new debug log — rather than as a silent empty list.

## The dialog search

Placement: inside the `selected !== null` deals section
(`AssignDialog.tsx:731`), below the contact's own results, so the
contact-first flow keeps primacy.

- One text input, one row of results, cap `LEAD_SEARCH_LIMIT` (10,
  `opportunities.ts:154`), min length `LEAD_SEARCH_MIN_CHARS` (2,
  `opportunities.ts:156`) — the constants and `searchLeads` itself are
  imported, not copied. Below two characters the local state clears and no
  request fires, exactly as the overlay behaves.
- Results render through the same row shape the contact's own deals use,
  labelled by the neutral target wording `nameForTarget` already produces for
  `crm.lead` (`AssignDialog.tsx:108-111`), with `AddToggle` wired to the
  dialog's existing `addTarget`/`removeTarget` — `{ model: "crm.lead", resId:
  <lead id>, name: <lead name> }`. The staged-target list, `MAX_TARGETS` cap
  and Confirm gate are untouched; a lead takes a slot like any target.
- Errors surface as a one-line row under the input, from `reportOdooError`'s
  code — the same code-only rule the lookup error follows at
  `AssignDialog.tsx:746`.
- The search is scoped to the dialog session: closing the dialog discards its
  state, as every other state in the dialog already does.

### Zero-rows hint

When `opportunities !== null && opportunities.length === 0`, the existing line
(`AssignDialog.tsx:759-762`) gains one sentence:

> No open opportunities or leads for this contact. Try searching for a lead by
> name below.

It stays a claim the dialog has earned — the fetch succeeded — and now says
what to do about it. It does **not** render when `opportunityError !== null`;
the error branch's "Whether … has open deals is unknown" wording stays exactly
as pinned by `meeting-log-page.test.tsx:1880`.

## Diagnostics

A single `console.debug` inside `selectContact`'s try-block, after the fetch
resolves, and in the catch:

```
[assign-dialog] opportunities { contactId, parentId, email, name, rows, error }
```

Guarded by `import.meta.env.DEV` — it never ships to a production console —
and logging ids, codes and counts, **never lead names or subjects**. The
reporter's repro then answers, in one run, whether C1 (domain composition
visible, rows 0), C2 (rows 0 with an unlinked lead in Odoo) or C3 (live partner
id differs) fired. This is the issue's "instrument the call" step, made
permanent-but-dev-only so it survives until the bug is confirmed closed.

## Testing

Vitest, extending `src/tests/odoo-opportunities.test.ts` (pure domain
composition) and a new dialog-level test file for the search, following
`src/tests/meeting-log-page.test.tsx`'s dialog harness.

**`odoo-opportunities.test.ts`**

- a company contact (`parentId === null`) composes
  `["partner_id", "child_of", <id>]` — no `in`, no parent clause
- a person contact composes the `|` of `child_of(person)` and
  `["partner_id", "=", parentId]` — and **not** a `child_of` over both ids
- the identity arm names `email_normalized`, not `email_from`
- the identity arm stays gated on `partner_id = false` and `type = lead`
- a contact with no email and a blank name still emits the linked clause only
  (the existing early-return path, unchanged)
- a **mutant check**: replacing `child_of` with `in [contact.id]` must fail
  the company fixture — this is C1's regression pin
- a **mutant check**: swapping `email_normalized` back to `email_from` must
  fail the formatted-email fixture

**Dialog tests**

- the search input renders only when a contact is selected
- typing below 2 characters fires no `client.execute` and clears prior results
- a search result adds `{ model: "crm.lead", resId, name }` through
  `addTarget`, counts against the cap, and shows the neutral lead wording
- removing a searched-in lead target works through the existing
  `removeTarget` path
- a failed search renders the error code and does **not** set
  `opportunityError` — the two failures must stay distinguishable on screen
- selecting a different contact while a search is in flight discards the
  search results (token check) but keeps the contact's own deal list intact
- the zero-rows hint renders on an empty successful lookup and does not
  render in the error branch
- the debug line is absent under a production `import.meta.env`

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