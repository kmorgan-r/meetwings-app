# Create an Odoo contact from an unmatched calendar attendee

Issue: [#53](https://github.com/kmorgan-r/meetwings-app/issues/53)
Follows: [#47](https://github.com/kmorgan-r/meetwings-app/issues/47) / PR #51
Date: 2026-09-05
Status: design approved, plan not yet written

An attendee with no matching Odoo contact renders today as a dead, greyed
line — `Jane Doe — no Odoo contact`
(`src/pages/app/components/completion/CalendarProposal.tsx:562-572`). Give that
line an action: create the partner in Odoo, from the popover, behind its own
confirm gate, and let the row become a normal selectable proposal row.

## Why

The proposal's whole value is removing the manual lookup. An unmatched row
puts the lookup back and adds a context switch — the user leaves the meeting
overlay, opens Odoo in a browser, creates a partner, comes back, and re-syncs.
The data needed to create the record (name, email, and enough signal to guess
the company) is already on screen.

## What the issue settled — design inputs, not open questions

These are constraints this spec builds on. Do not re-derive them.

- **The write needs its own confirm gate.** Creating a partner is a different
  write from `odoo_selected_targets` and must not ride on `Add N to log`.
- **A created contact must not auto-tick.** The reconciliation in
  `CalendarProposal.tsx:255-257` is intersect-only by design; it never adds an
  id back to `checked`. A freshly created contact appears as a selectable,
  **unchecked** row the user ticks. This is the correct behaviour, not a gap.
- **`MAX_TARGETS` (5, `src/lib/odoo/meeting-log.ts:66`) still applies.** Create
  must not become a way past the slot rule.
- **Editing or archiving existing contacts is out of scope.** Read-only contact
  sync is unchanged.

## The invariant, and the second gate

PR #51's design states the binding rule:

> no write to `odoo_selected_targets` happens without an explicit user confirm
> action.

This feature adds a *second* write, to a different system, and therefore a
second gate. Stated as its own rule:

**No `res.partner` is created without an explicit user confirm action distinct
from the one that adds targets.**

Concretely: opening the create form writes nothing. Editing the name writes
nothing. Only the `Create contact` button writes to Odoo, and it never adds a
target. Only `Add N to log` adds targets, and it never writes to Odoo. Two
buttons, two writes, no path where one implies the other.

The asymmetry is deliberate. A wrong target posts a customer's transcript onto
the wrong CRM record. A wrong create leaves a junk partner in the customer's
CRM that someone has to find and merge. Different blast radii, same rule.

## Scope

### In

- A `Create in Odoo` affordance on unmatched rows whose reason is
  `no-contact`.
- An inline create form (name, read-only email, company) inside the existing
  proposal region.
- A duplicate guard with two independent layers: a live exact-email
  adopt-or-create against Odoo, and a cached name-similarity warning that
  offers the existing contact as a target instead.
- Company (`parent_id`) inference from the attendee's email domain.
- Landing the created contact in the contact cache so the proposal
  re-projects and the row becomes selectable without a full sync.

### Out, and why

- **Archived rows get nothing.** `reason === "archived"` means the partner
  exists. Offering create there manufactures exactly the duplicate the
  archived/no-contact split was introduced to prevent
  (`CalendarProposal.tsx:557-560`).
- **No company creation.** A miss on the company guess leaves `parent_id`
  blank. Creating company partners doubles the write surface in a namespace
  this app does not match on at all.
- **No editing or un-archiving.** Reactivating an archived partner is a
  different decision with different consequences in the user's CRM.
- **No bulk create.** One attendee at a time, one form at a time.
- **No new sync fields.** `website` would make company matching better and is
  not in `PARTNER_FIELDS` (`src/lib/odoo/contacts-sync.ts:19`); adding it
  means a schema change and a re-sync, and belongs in its own change.

## Architecture

Three new pieces, plus wiring.

| Unit | File | Depends on | Job |
| --- | --- | --- | --- |
| `createOrAdoptContact` | `src/lib/odoo/create-contact.ts` (new) | `OdooClient`, `parsePartnerRow` | One Odoo round trip set: find-by-email, create on miss, read back a full partner row. Pure of React and of the database. |
| `similarContacts`, `inferCompany` | `src/lib/calendar/similar-contacts.ts` (new) | `OdooContact` only | Pure functions over the cached contact list. No I/O. |
| `onCreateContact` | `src/hooks/useOdooTarget.ts` | the above + `upsertContacts` + `reload` | Owns the client, the instance, the cache write and the lifecycle guards. |
| create form | `CalendarProposal.tsx` | props only | Renders the form, holds its draft state, calls the prop. |

**Why the callback lives in `useOdooTarget` and not in the component.**
`useOdooTarget.ts:55` states the rule: the contact list has exactly one home,
`cache`. `CalendarProposalProps` already documents the same reasoning for
`onAddTarget` — a component calling the database layer bypasses the hook that
owns the state and leaves the picker stale. A create that wrote the cache from
the component would leave `cache`, the picker's list, and `atCap` disagreeing.

**Why a separate pure module for similarity.** It is the part most likely to
be wrong, and it is testable with no mocks. `match-attendees.ts` set the
precedent: matching logic is a pure function with its own test file, and the
hook only calls it.

## The create form

### Affordance

Unmatched rows currently render as a `<p>`. Rows with `reason === "no-contact"`
gain a trailing text button, styled like the existing `Try again` /
`Open Settings` buttons in the same file (`text-[10px] uppercase tracking-wide
text-muted-foreground hover:text-foreground`). Rows with `reason ===
"archived"` render exactly as they do today.

### It must not change the region's height

The proposal region is a **fixed** `h-28` with internal scrolling
(`REGION_CLASS`), not a max-height, because `resizeWindow(true)` is driven by
a flag list observed when the popover opens and the main window is pinned
600x54 with `"resizable": false`. The form therefore expands **inside** the
scroll region, replacing nothing and growing nothing. No dialog, no popover
within the popover, no portal.

Only one form is open at a time. Opening a second row's form closes the first
and discards its draft; a draft is three fields the user can retype, and two
open forms in a 112px scroll region is not a surface worth designing.

### Fields

**Name** — editable text input. Required; a value that trims to empty disables
the create button. Prefilled from `participant.name`, with two normalisations:
a single leading `"Last, First"` comma is flipped to `"First Last"`, and
surrounding whitespace is collapsed. When `participant.name` is null or trims
to empty, the prefill falls back to the address local-part with `.`, `_` and
`-` replaced by spaces. The prefill is a starting point — the user is expected
to fix it, which is the point of making it editable.

**Email** — displayed, read-only. It is the key the row was matched on and the
key the created partner will be matched on next time. An editable email lets
the user create a partner that still does not match the attendee, leaving the
row greyed after a successful write with no explanation.

**Company** — a filter input over cached contacts with `isCompany === true`,
prefilled with the inferred company (below) and clearable to "No company". Not
a `<select>`: the cache routinely holds thousands of partners, and
`ContactPicker` already solved this shape with `filterContacts` + a capped
render (`MAX_RENDERED_ROWS`). Here the cap is **5** rows, because the control
lives in a 112px scroll region beside two other fields. Typing filters;
clicking a row selects it and collapses the list back to the chosen name.

### Buttons

`Create contact` (primary, disabled while a create is in flight or the name is
empty) and `Cancel` (closes the form, discards the draft, writes nothing).

## Company inference

```
domain(address)                        → the part after the last "@", lowercased
if domain is a known free-mail domain  → no inference, field blank
candidates = cached contacts where
    active
    and email domain === domain
    and parentId !== null
if candidates is empty                 → no inference, field blank
tally parentId across candidates
winner = highest count, ties broken by lowest parentId
```

Ties break on lowest id for the same reason `preferForDuplicateEmail`
(`src/lib/calendar/match-attendees.ts`) does: stable across syncs in a way
`name` is not, and deterministic beats arbitrary when both are imperfect.

**Free-mail domains are skipped, not inferred.** `gmail.com`, `googlemail.com`,
`outlook.com`, `hotmail.com`, `live.com`, `yahoo.com`, `yahoo.co.uk`,
`icloud.com`, `me.com`, `aol.com`, `proton.me`, `protonmail.com`, `gmx.com`,
`gmx.de`, `mail.com`, `qq.com`, `163.com`. Two unrelated people share
`gmail.com`; inferring from it attaches a stranger's company to a new contact
and the user is being invited to accept a prefilled value, so a confident-
looking wrong guess is worse than a blank field. The list lives beside the
function as a `Set`, and being incomplete is safe: an unlisted free-mail
domain degrades to the ordinary inference path, which needs at least one
cached contact on that domain with a parent before it proposes anything.

The inferred value is a **prefill, never a silent write**. The user sees it in
the form and can clear or change it before confirming.

## The duplicate guard

Two layers, because they catch different failures.

### Layer 1 — live exact-email adopt-or-create

Matching runs against the cache, which is as stale as the last sync. If the
partner was created in Odoo ten minutes ago — by a colleague, by a web form,
by this app in another window — the row still reads `no Odoo contact` and a
create makes a duplicate on an email that is supposed to be unique enough to
match on.

Before any create, search live:

```
res.partner search
  domain: [["email", "=ilike", <normalized address>]]
  kwargs: { limit: 1, context: { active_test: false } }
```

`=ilike` because Odoo's `=` on a char field is case-sensitive and
`normalizeAddress` lowercases both sides everywhere else in this feature.
`active_test: false` because an archived partner with that email is
emphatically not an invitation to create a second one.

This is the same shape as `createOrAdoptAttachment`
(`src/lib/odoo/meeting-log-push.ts:270-287`), and it buys the same second
thing: `create` is not idempotent, and the commit-then-timeout window means a
create that appears to fail may have landed. A retry after a timeout adopts
rather than duplicating.

Outcomes:

- **Miss** → proceed to create.
- **Hit, active** → do not create. Upsert the found partner into the cache and
  report `Already in Odoo — added to the list below.` The row re-projects to a
  matched, unchecked row; the user ticks it as normal.
- **Hit, archived** → do not create. Report `This person is already in Odoo but
  archived. Un-archive them there to log this meeting to them.` The row
  re-projects to the `archived in Odoo` state, which is now the truth. Nothing
  is written to Odoo.

### Layer 2 — cached name similarity

Layer 1 cannot see the case the issue actually names: the person is in Odoo
under a *different* address. Only a name can find them.

`similarContacts` runs against the cache when the form opens — synchronously,
no I/O — and on a non-empty result renders above the form. It does not block
or disable anything:

```
Already in Odoo?
  [ Use Jane Doe · jane@acme.example ]
  [ Use J. Doe · jdoe@acme-group.example ]
```

Each button calls `onAddTarget` with that contact — the same cap-checked path
the proposal's own confirm uses — and closes the form. One click both resolves
the row correctly and writes nothing to Odoo. The click *is* the confirm; there
is no second step, because adding an existing contact as a target is exactly
what the `Add N to log` gate already authorises the user to do one row at a
time.

`Create contact` stays enabled below the warning. Two people genuinely do share
a name, and a hard block would make that unresolvable from this UI.

**The similarity rule:**

```
normalize(name):
  lowercase
  strip diacritics (NFD, drop combining marks)
  replace non-alphanumeric with space
  split on whitespace
  drop tokens of length 1        (initials: "J" must not match every J-name)
  return the set of remaining tokens

similar(a, b):
  |normalize(a) ∩ normalize(b)| >= 2
  or (both sets have exactly one token and those tokens are equal)
```

Two shared tokens is the threshold because one is worthless — every `Jane` in
the CRM would surface for every `Jane`. The single-token clause covers
mononyms and the local-part fallback, where an exact equal token is the whole
name.

Candidates are filtered before comparison: `active`, not `isColleague`, and
email not equal to the attendee's normalized address. Colleagues are excluded
because `matchAttendees` routes them to `excluded` — a `Use` button for one
would add a target the matcher considers noise, and the row would not resolve.
The email exclusion is belt and braces: such a contact would have matched
already and the row would not be unmatched.

At most three are shown, ordered by the proposal's existing `byRecency`
comparator (`lastMeetingAt` descending, nulls last, ties by name) so the most
plausible candidate is first.

## The write path

`onCreateContact(participant, draft)` in `useOdooTarget`:

1. Resolve the instance and the client with the existing `resolveInstance` /
   `getClient` helpers. Capture `selectionToken.current` (see Guards).
2. **Layer 1** — search by email. On a hit, skip to step 4 with the found id.
3. **Create:**
   ```
   res.partner create
     { name, email, is_company: false, type: "contact", parent_id: <id | false> }
   ```
   `type: "contact"` is written **explicitly**, not left to Odoo's default. The
   sync domain excludes `type` in `delivery`, `invoice` and `other`
   (`contacts-sync.ts`), so a partner created with any of those types is
   invisible to this app forever — the user would create a contact, watch the
   row stay greyed, and create another. Writing the field turns a dependency on
   an Odoo default into a non-issue.

   `parent_id` is `false` when no company is selected. Odoo reads `false` as
   unset for a many2one; `null` is not a valid XML-RPC value here.
4. **Read back** — `search_read` on `[["id", "=", <id>]]` with `PARTNER_FIELDS`
   and `context: { active_test: false }`, through `parsePartnerRow`. Reading
   back rather than synthesising a row is what guarantees the cached record
   matches what Odoo actually stored, including the real `write_date` and any
   server-side normalisation of the name or email.
5. **Cache** — `upsertContacts(instance, [row], Date.now())`.
6. **Reload** — call the existing `reload(token)`
   (`useOdooTarget.ts:535`) with the same `selectionToken` captured in step 1;
   it re-reads `listContacts` into `cache` and never rejects.
   **Not** `runSync("refresh")`: that claims the sync lock, hits Odoo for a
   full incremental pull, and can fail with `ODOO_SYNC_BUSY` for a reason that
   has nothing to do with this write.
7. The `cache` change flows to `useCalendarProposal`'s `contacts` prop, whose
   re-projection effect re-runs `matchAttendees` against the same `eventId`.
   The attendee moves from `unmatched` to `matched`; `CalendarProposal`'s
   pre-check effect sees a same-`eventId` proposal, takes the intersect branch,
   and adds nothing to `checked`. The row renders unchecked, as specified.

**The watermark is untouched**, deliberately. The next incremental sync will
re-pull this partner (its `write_date` is above the stored watermark) and the
guarded upsert in `upsertContacts` will find nothing changed and count zero.
Advancing the watermark from a single-record write would risk skipping
concurrent edits to other partners.

### expectInt / firstId

`create` returns an id and `search` returns a list; both need the same
validation `meeting-log-push.ts` already does privately at `:93` and `:100`.
Move `expectInt` and `firstId` into a shared `src/lib/odoo/expect.ts` and have
both callers import them. This is a two-function move in code this change is
already touching, not a refactor of the push module.

## Guards and lifecycle

**Its own in-flight ref.** The create flow gets `creatingRef` (and a `creating`
state for the button). It must **not** reuse `writingRef`. That ref exists to
stop the pre-check effect re-deriving `checked` mid-write — the defect
documented at length in `CalendarProposal.tsx` — and a create legitimately
*does* change `writable` in a way the intersect branch must see. Entangling
them reopens the re-tick hazard from the other side.

**One create at a time**, across all rows. `creatingRef` guards re-entry the
same way `confirm` does.

**Instance-guarded, on both sides.** The two layers already have their own
mechanisms and each keeps its own:

- In `useOdooTarget`, the create captures `selectionToken.current` before its
  first await and re-checks it before the cache write. `handleInstanceChanged`
  (`useOdooTarget.ts:653-655`) bumps that token, and every other async path in
  the hook is guarded the same way. A partner id created against the
  *previous* instance must never be upserted into the new instance's cache —
  it points at nothing there.
- In `CalendarProposal`, the create captures `epochRef.current` alongside
  `confirm`'s existing use of it, and re-checks before setting any result
  state.

On a mismatch either side: abandon silently, write no cache row, show no
message — the popover has already reset to idle underneath.

The `state.kind === "idle"` reset effect gains the create's state alongside the
write's: `creatingRef.current = false`, `setCreating(false)`, close the form,
clear the draft and any create result.

**At cap.** Create stays available. The Odoo record has value independent of
whether a slot is free, and the alternative — hiding create when the log is
full — makes the affordance appear and disappear for a reason unrelated to the
attendee. The resulting row renders disabled like every other row while
`atCap`, under the existing `The log is full` notice.

## Errors

Every failure surfaces inline in the create form area, using the same rule the
rest of this feature follows: **the code, never server prose**. `odooError`
already redacts at construction, and `CALENDAR_SETTINGS_REMEDY` exists
precisely so this region is not the one place that rule gets relaxed.

| Case | Code | Surface |
| --- | --- | --- |
| Odoo rejects the write (access rights, a required field a customisation added, a validation) | `ODOO_FAULT` | `Odoo refused to create the contact (ODOO_FAULT). Check your Odoo permissions.` Form stays open with the draft intact. |
| Network / transport | `ODOO_UNREACHABLE` | `Could not reach Odoo. Try again.` Form stays open; retry adopts if the first attempt landed. |
| `create` returns a non-integer | `ODOO_UNEXPECTED_ROW` | Generic failure message. Nothing cached. |
| Read-back returns no row | — | `Created in Odoo, but it isn't visible to this connection.` **No cache row is fabricated.** Record rules can hide a record from the API user that created it; a synthesised cache row would produce a proposal row whose target write then fails, or worse, silently succeeds against a record the user cannot see. |
| Instance changed mid-create | — | Silent abandon. |
| Cache upsert or reload fails | reported via `reportOdooError` | The Odoo write succeeded — say so: `Created in Odoo. Refresh to see them here.` |

No new `OdooErrorCode` members. The existing union covers every case.

### Never logged

Same list as PR #51's feature: no attendee names, no addresses, no subjects, no
tokens in any error, log line or telemetry. The draft the user typed is
included in that — it is a person's name and email.

## Testing

Vitest, following `src/tests/match-attendees.test.ts` for the pure modules and
`src/tests/useCalendarProposal.test.tsx` for the wired ones.

**`similar-contacts.test.ts`** (pure, no mocks)
- two shared tokens match; one shared token does not
- single-character tokens are dropped: `J Doe` does not match `J Smith`
- diacritics fold: `José García` matches `Jose Garcia`
- punctuation folds: `O'Brien` matches `OBrien`; `Jane Doe-Smith` matches
  `Jane Doe`
- mononym equality matches; mononym inequality does not
- colleagues, archived contacts and the attendee's own email are filtered out
- result is capped at three and ordered by `byRecency`, nulls last
- company inference: majority parent wins; tie breaks to the lowest id; a
  free-mail domain infers nothing; no cached contact on the domain infers
  nothing; contacts with a null `parentId` do not vote

**`create-contact.test.ts`** (mocked `OdooClient`)
- miss → `create` is called once with `type: "contact"` and
  `is_company: false`, then read back
- hit on an active partner → **no `create` call**, the found row is returned
- hit on an archived partner → no `create`, and the archived outcome is
  distinguishable from the active one by the caller
- `=ilike` and `active_test: false` are present in the search
- no company selected → `parent_id: false`, not `null` and not omitted
- non-integer create result → `ODOO_UNEXPECTED_ROW`
- read-back empty → the "created but invisible" outcome, and no partner row
  returned to cache

**`useOdooTarget` create tests** (mocked client and database)
- success upserts exactly one row and calls `reload`, never `runSync`
- an instance change mid-create writes no cache row
- a second create while one is in flight is a no-op
- a cache-write failure still reports the Odoo write as succeeded

**`CalendarProposal` component tests**
- the affordance renders on `no-contact` rows and **not** on `archived` rows
- opening the form writes nothing; `Cancel` writes nothing
- `Create contact` calls `onCreateContact` and does **not** call `onAddTarget`
- `Add N to log` does **not** call `onCreateContact`
- after a successful create and re-projection, the new row is present,
  enabled, and **unchecked** — and rows the user had unchecked before the
  create stay unchecked
- a `Use <name>` button calls `onAddTarget` with that contact and no create
  occurs
- the name prefill flips `"Doe, Jane"`, falls back to the local-part, and an
  empty trimmed name disables the button
- the region keeps its fixed height with the form open (the `h-28` class is
  unchanged and the form renders inside it)
- at cap, create is still offered and the created row renders disabled

## Follow-up work

Not in this change:

- Un-archiving an archived match from the proposal.
- Company creation when the domain guess misses.
- Adding `website` to `PARTNER_FIELDS` for stronger company inference.
- Fuzzy (edit-distance) name matching. The token rule is deliberately crude
  and explainable; a scored matcher needs a threshold nobody can justify
  without data on this user's CRM.
- The three PR #51 follow-ups (account switch leaves a stale proposal, freeing
  a slot does not re-tick, a renamed contact shows stale until the next fetch)
  remain separate.
