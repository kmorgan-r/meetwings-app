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
target. Only `Add N to log` adds targets, and it never writes to Odoo.

The one deliberate exception is the `Use <name>` button in Layer 2 below, which
adds an existing contact as a target and writes nothing to Odoo. That click *is*
its own confirm — see that section for why a second step there would be
ceremony rather than safety.

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

Three new units, one moved helper, and four files of wiring.

| Unit | File | Depends on | Job |
| --- | --- | --- | --- |
| `createOrAdoptContact` | `src/lib/odoo/create-contact.ts` (new) | `OdooClient`, `parsePartnerRow`, `expectInt`/`firstId` | One Odoo round trip set: find-by-email, create on miss, read back a full partner row. Pure of React and of the database. |
| `similarContacts`, `inferCompany` | `src/lib/calendar/similar-contacts.ts` (new) | `OdooContact` only | Pure functions over the cached contact list. No I/O. |
| `expectInt`, `firstId` | `src/lib/odoo/expect.ts` (new) | `odooError` | Moved out of `meeting-log-push.ts`; see below. |
| `byRecency` | `src/lib/odoo/contact-ordering.ts` (existing) | `OdooContact` only | Moved out of `CalendarProposal.tsx`; see below. |
| `onCreateContact` | `src/hooks/useOdooTarget.ts` | the above + `upsertContacts` + `reload` | Owns the client, the instance, the Odoo call, the cache write, the re-entry guard and the instance guard. |
| create form | `CalendarProposal.tsx` | props only | Renders the form, holds its draft state and its own button-disabled state, calls the prop. |
| prop forwarding | `ContactPicker.tsx` | — | Accepts `onCreateContact` and forwards it into `<CalendarProposal>`, exactly as it already does for `targets`/`onAddTarget`. |

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

### The prop path, named hop by hop

`onCreateContact` does **not** ride on `calendarProps`. That object is built in
`completion/index.tsx:88-98` from `useCalendarProposal` alone, and its
dependency array lists only `calendar.present`, `calendar.state`,
`calendar.onPickCandidate` and `calendar.onRetry`. The callback comes from
`useOdooTarget`, a different hook, so putting it there would mean widening a
memo whose whole stated purpose is to stay narrow.

It takes the route `targets` and `onAddTarget` already take:

1. `useOdooTarget` returns it and puts it in `pickerProps`
   (`useOdooTarget.ts:1178-1217`).
2. `<Completion />` spreads `pickerProps` onto `ContactPicker`
   (`completion/index.tsx:197`) — no change needed at this hop.
3. `ContactPickerProps` gains `onCreateContact` as a **top-level** prop, beside
   `onAddTarget` (`ContactPicker.tsx:137`), not inside the optional `calendar`
   object. The comment at `ContactPicker.tsx:169-172` gives the reason the
   existing pair is placed this way, and it applies unchanged.
4. `ContactPicker` forwards it into `<CalendarProposal>`
   (`ContactPicker.tsx:343-351`).

**It must be a `useCallback` with permanently stable dependencies** —
`getClient`, `resolveInstance`, `reload`, `applyTargets`, all of which are
already stable — mirroring `addTarget` at `useOdooTarget.ts:1038-1061`.
`ContactPicker` is `React.memo`'d and `<Completion />` re-renders on every
streamed AI token; an unstable function here defeats that memo for the whole
session. This is not hypothetical: the codebase's own comments record a memo
defect on this exact component that a plan review caught once already.

### The callback's signature

`onAddTarget` declares its result shape (`CalendarProposal.tsx:111`) precisely
so the component can branch on it. `onCreateContact` needs the same, and needs
more room, because the component must distinguish six outcomes to pick a
message and decide whether to close the form:

```ts
type CreateContactResult =
  | { kind: "created"; contact: OdooContact }
  | { kind: "adopted-active"; contact: OdooContact }
  | { kind: "adopted-archived"; contact: OdooContact }
  | { kind: "created-invisible" }        // written, read-back returned no row
  | { kind: "cached-failed" }            // written and read back, cache write failed
  | { kind: "failed"; code: OdooErrorCode }
  | { kind: "abandoned" };               // instance changed; render nothing

onCreateContact: (
  participant: CalendarParticipant,
  draft: { name: string; parentId: number | null }
) => Promise<CreateContactResult>;
```

`abandoned` is a distinct member rather than a null return: the component must
be able to tell "nothing to say, the popover reset underneath you" apart from
"something failed", and silently rendering nothing for an unrecognised result is
how a real failure becomes invisible.

The `email` is not in `draft`. It is read-only and derived from
`participant.address` (see Fields), so passing it would create a second source
for the one value the whole match depends on.

## The create form

### Affordance

Unmatched rows currently render as a `<p>`. Rows with `reason === "no-contact"`
gain a trailing text button, styled like the existing `Try again` /
`Open Settings` buttons in the same file (`text-[10px] uppercase tracking-wide
text-muted-foreground hover:text-foreground`). Rows with `reason ===
"archived"` render exactly as they do today.

Adding a button inside what is currently a bare `<p>` means that element becomes
a flex row wrapping the text and the button. **The row's existing
`data-testid={`calendar-unmatched-${address}`}` and its `text-muted-foreground`
class must stay on the element that carries the text**, because
`CalendarProposal.states.test.tsx:84-96` asserts both on exactly that node.

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

### Which row's form is open

`CalendarProposal` holds `openForm: string | null` — the **normalized address**
of the row whose form is open, never an array index. `useCalendarProposal`'s
re-projection effect (`useCalendarProposal.ts:323-354`) rebuilds `unmatched`
whenever the contact cache changes, so an index would silently point at a
different attendee. The address is the same key
`CalendarProposal.tsx:564` already uses for the row's React key.

### Draft state is snapshotted at open, not derived

The draft (`name`, `parentId`) is initialised **once**, in the click handler
that opens the form, into component state. It is not derived from
`entry.participant` during render.

`project()` calls `participantsOf(picked.event)` fresh on every re-projection
(`useCalendarProposal.ts:250-251`), so `entry.participant` is a new object
reference each time an unrelated contact-cache change fires that effect. A
prefill derived reactively would be the standard props-into-state overwrite
bug: the user's edits discarded by a re-projection they did not cause.

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

The filtered list is computed in a `useMemo` keyed on the cache and the typed
query, exactly as `ContactPicker.tsx:262-265` does. This component re-renders
on every parent render; filtering thousands of rows inline would run on all of
them.

The displayed label is the selected contact's own `name` from the cache. There
is no second source for it — see the inference rule below for why the inferred
value is resolved to a cached row before it can be shown.

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
if winner is not the id of a cached contact
   with isCompany === true             → no inference, field blank
```

The final check is not defensive padding. `parentId` and `isCompany` are
independent fields (`src/types/odoo.ts:32-33`) and a person can be another
partner's parent in Odoo, so the winning id is not guaranteed to name a row the
Company control can display or re-select. `companyName` on the cached row is
derived from the many2one label (`contacts-sync.ts:55-57`), not from an
`isCompany` test, so it cannot stand in for this either. Prefilling a value the
control cannot render is worse than prefilling nothing.

Ties break on lowest id for the same reason `preferForDuplicateEmail`
(`src/lib/calendar/match-attendees.ts:52-55`) does: stable across syncs in a way
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
res.partner search_read
  domain: [["email", "=ilike", <normalized address>]]
  fields: PARTNER_FIELDS
  kwargs: { context: { active_test: false } }
```

`=ilike` because Odoo's `=` on a char field is case-sensitive and
`normalizeAddress` lowercases both sides everywhere else in this feature.
`active_test: false` because an archived partner with that email is
emphatically not an invitation to create a second one.

**No `limit: 1`.** Two partners sharing one email is routine in Odoo — a person
and their company, or the same person under two parents — and this codebase
already treats that as load-bearing rather than rare
(`match-attendees.ts:52-55`, with two tests pinning it at
`match-attendees.test.ts:170-201`). With `limit: 1` and no `order`, which row
comes back is arbitrary, so an archived duplicate can win over a live active
partner and the user is told to go un-archive somebody who does not need it.
Fetch the matches and pick deterministically:

**active over archived, then person over company, then lowest id.**

The first clause is this rule's own; the last two are `preferForDuplicateEmail`'s,
for the reasons stated there. `search_read` rather than `search` because the
adopt path needs the full row anyway, and a second round trip to fetch what the
first could have returned buys nothing.

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
- **Hit, archived** → do not create. **Upsert the found partner into the cache
  anyway**, then report `This person is already in Odoo but archived.
  Un-archive them there to log this meeting to them.`

The cache write on the archived branch is not optional. `matchAttendees`
produces `reason: "archived"` only when a cached contact for that email exists
with `active === false` (`match-attendees.ts:97-99`); with no cache row the
attendee still resolves to `no-contact` and the row would sit there claiming
there is no contact for somebody the search just proved exists — sending the
user to create the duplicate this whole layer exists to prevent. "Nothing is
written to Odoo" on this branch refers to the **Odoo** write only; the local
cache is written on all three outcomes.

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

The name it compares is the **same normalised prefill the Name field is seeded
with**, including the local-part fallback — not `participant.name` raw.
`CalendarParticipant.name` is nullable (`src/types/calendar.ts:36-38`), and an
attendee with no display name is exactly the population most likely to be
unmatched; comparing against the raw field would switch Layer 2 off for them
while the fallback gives it real tokens to work with.

The search runs on the seeded value at open and **does not re-run as the user
edits the name**. It is a warning shown at the moment of decision, not a live
search; re-running it per keystroke would make the button list flicker
underneath a user who is typing in a 112px scroll region.

Each button calls `onAddTarget` with that contact — the same cap-checked path
the proposal's own confirm uses — and closes the form.

**On a successful add, the row must stop being an open invitation to create.**
`matchAttendees` keys on normalized email and never reads `targets`, so the
attendee stays in `unmatched` with `reason: "no-contact"` no matter what was
just added. Left alone, the greyed line and its `Create in Odoo` button both
remain, and the user is invited to create precisely the duplicate this layer
exists to prevent — the same standard this spec applies to colleagues two
paragraphs down.

`CalendarProposal` therefore holds `resolvedByHand: ReadonlySet<string>`, keyed
on normalized address. An address enters it only when `onAddTarget` resolves
`{ ok: true }` — a cap rejection must not mark anything resolved, because
nothing was added. A row whose address is in that set renders as
`Jane Doe — added Jane Doe (Acme)` with **no create affordance**, and it is
cleared by the idle-reset effect and whenever `proposalEventId` changes, beside
`checked`.

The click *is* the confirm; there is no second step, because adding an existing
contact as a target is exactly what the `Add N to log` gate already authorises
the user to do one row at a time.

`Create contact` stays enabled below the warning. Two people genuinely do share
a name, and a hard block would make that unresolvable from this UI.

**The similarity rule:**

```
normalize(name):
  NFD, drop combining marks              (José → Jose)
  lowercase
  remove apostrophes and periods         (O'Brien → OBrien, J. → J)
  replace every other non-alphanumeric with a space
  split on whitespace
  drop tokens of length 1                (initials: "J" must not match every J-name)
  return the set of remaining tokens

similar(a, b):
  |normalize(a) ∩ normalize(b)| >= 2
  or (both sets have exactly one token and those tokens are equal)
```

**The two punctuation classes are the rule, not an implementation detail.**
Elision marks (apostrophe, period) are *removed* so `O'Brien` and `OBrien` both
normalise to `{obrien}`; every other non-alphanumeric becomes a *space* so
`Jane Doe-Smith` and `Jane Doe` share two tokens. Collapsing the two classes
into one breaks whichever case it is not chosen for: replacing apostrophes with
spaces makes `O'Brien` `{brien}` against `OBrien`'s `{obrien}` — no intersection
at all — and stripping hyphens makes `Doe-Smith` the single token `doesmith`,
which shares only `jane` with `Jane Doe`.

Curly apostrophes (`’`) count as apostrophes. Graph returns display names as the
directory holds them, and a smart-quoted `O’Brien` is common enough that
treating it as a separator would silently disable the rule for that name.

Two shared tokens is the threshold because one is worthless — every `Jane` in
the CRM would surface for every `Jane`. The single-token clause covers
mononyms and the local-part fallback, where an exact equal token is the whole
name. It requires **both** sets to be single-token: relaxing it to "either" makes
a one-token candidate match every multi-token name containing that token, which
is the one-shared-token case the threshold exists to reject.

Candidates are filtered before comparison: `active`, not `isColleague`, and
email not equal to the attendee's normalized address. Colleagues are excluded
because `matchAttendees` routes them to `excluded` — a `Use` button for one
would add a target the matcher considers noise, and the row would not resolve.
The email exclusion is belt and braces: such a contact would have matched
already and the row would not be unmatched.

At most three are shown, ordered by `byRecency` (`lastMeetingAt` descending,
nulls last, ties by name) so the most plausible candidate is first.

**`byRecency` moves.** It is currently a module-private function in
`CalendarProposal.tsx:116-126` with no `export`. A pure module under `src/lib`
importing it would be a **value** import from `src/lib` into `src/pages`, while
`CalendarProposal.tsx:4` already value-imports `MAX_TARGETS` from `@/lib/odoo` —
a genuine runtime cycle, and exactly the widening `src/types/calendar.ts:95-104`
warns against. Move it to `src/lib/odoo/contact-ordering.ts` beside
`compareContacts` (`contact-ordering.ts:19-31`), which is the same kind of
comparator over the same type, and have `CalendarProposal.tsx` import it from
there.

## The write path

`onCreateContact(participant, draft)` in `useOdooTarget`:

1. **Before any await, as the first synchronous statements:** capture
   `instanceToken.current` (see Guards) and take the re-entry guard
   (`creatingRef`). Both must precede `resolveInstance` and `getClient`, which
   are themselves awaits (`useOdooTarget.ts:368-374`, `:383-388`) — a token read
   after them captures whatever landed *during* them, so the later check would
   compare the new value against itself and never fire. Every other guarded path
   in this hook captures before its first await (`:654-655`, `:762-763`,
   `:1103-1104`).
2. Resolve the instance and the client with `resolveInstance` / `getClient`.
3. **Layer 1** — search by email. On a hit, skip to step 6 with the found row
   (which `search_read` already returned in full).
4. **Create:**
   ```
   res.partner create
     { name, email, is_company: false, type: "contact", parent_id: <id | false> }
   ```
   `type: "contact"` is written **explicitly**, not left to Odoo's default. The
   sync domain excludes `type` in `delivery`, `invoice` and `other`
   (`contacts-sync.ts:118-124`), so a partner created with any of those types is
   invisible to this app forever — the user would create a contact, watch the
   row stay greyed, and create another. Writing the field turns a dependency on
   an Odoo default into a non-issue.

   `parent_id` is `false` when no company is selected. Odoo reads `false` as
   unset for a many2one; `null` is not a valid XML-RPC value here.
5. **Read back** — `search_read` on `[["id", "=", <id>]]` with `PARTNER_FIELDS`
   and `context: { active_test: false }`, through `parsePartnerRow`. Reading
   back rather than synthesising a row is what guarantees the cached record
   matches what Odoo actually stored, including the real `write_date` and any
   server-side normalisation of the name or email.
6. **Re-check `instanceToken`**, then **cache** — `upsertContacts(instance,
   [row], Date.now())`.
7. **Reload** — call the existing `reload(token)`
   (`useOdooTarget.ts:535`) with the current `selectionToken.current`;
   it re-reads `listContacts` into `cache` and never rejects.
   **Not** `runSync("refresh")`: that claims the sync lock, hits Odoo for a
   full incremental pull, and can fail with `ODOO_SYNC_BUSY` for a reason that
   has nothing to do with this write.
8. The `cache` change flows to `useCalendarProposal`'s `contacts` prop, whose
   re-projection effect re-runs `matchAttendees` against the same `eventId`.
   The attendee moves from `unmatched` to `matched`; `CalendarProposal`'s
   pre-check effect sees a same-`eventId` proposal, takes the intersect branch,
   and adds nothing to `checked`. The row renders unchecked, as specified.

`reload` takes `selectionToken.current` and not the captured `instanceToken`:
it is the hook's own existing contract, it uses that token only to decide
whether its archival-cleanup writes are still current, and passing anything else
would break an unrelated invariant. The create's own guard is separate and is
already spent by step 6.

**The watermark is untouched**, deliberately. The next incremental sync will
re-pull this partner (its `write_date` is above the stored watermark) and the
guarded upsert in `upsertContacts` will find nothing changed and count zero.
Advancing the watermark from a single-record write would risk skipping
concurrent edits to other partners.

### expectInt / firstId

`create` returns an id and a search returns a list; both need the same
validation `meeting-log-push.ts` already does privately at `:93` and `:100`.
Move `expectInt` and `firstId` into a shared `src/lib/odoo/expect.ts` and have
both callers import them. This is a two-function move in code this change is
already touching, not a refactor of the push module.

## Guards and lifecycle

### Which side owns which guard

The Architecture table says the hook owns the lifecycle guards, and that is only
half true — a component effect cannot reset a ref declared inside a hook. Split
explicitly:

| Guard | Lives in | Job |
| --- | --- | --- |
| `creatingRef` | `useOdooTarget` | Refuses re-entry: one create at a time, across all rows. |
| `instanceToken` | `useOdooTarget` | Invalidates a create whose instance changed underneath it. |
| `creating` state | `CalendarProposal` | Disables the `Create contact` button while one is in flight. |
| `epochRef` | `CalendarProposal` | Refuses to set result state after an idle reset. |

Each side resets only what it declares. The hook clears `creatingRef` in a
`finally`; the component clears `creating`, the draft, `openForm` and the create
result in its own paths.

### `creatingRef` is its own ref, not `writingRef`

`writingRef` exists to stop the pre-check effect re-deriving `checked`
mid-write — the defect documented at length in `CalendarProposal.tsx:220-238` —
and a create legitimately *does* change `writable` in a way the intersect branch
must see. Entangling them reopens the re-tick hazard from the other side.

No deferred-unlock effect is needed for `creating`, unlike `writing`
(`CalendarProposal.tsx:282-300`). That deferral exists because a successful
`onAddTarget` mutates `targets` — a direct prop — in the *same* commit as
`confirm`'s own `setWriting(false)`. A create's effect on `writable` instead
routes through `useCalendarProposal`'s re-projection effect
(`useCalendarProposal.ts:323-354`), which always lands on a later render, so the
flag is already false before the pre-check effect can observe the widened set.

### `instanceToken`, not `selectionToken`

The cache is scoped to the **instance**; `selectionToken` is scoped to the
**selection**, and the two are not the same thing. `selectionToken` is bumped by
`onSelect` (`:762`), `onSelectLead` (`:841`), `handleNewChat` (`:736`) and
`clearAllTargets` (`:1103`) as well as by `handleInstanceChanged` (`:654`), and
none of the first four invalidate a single cached contact.

Guarding the cache write on it would mean: the user opens a create form, clicks
`Create contact`, and while it is in flight picks a different contact in the
single-select part of the same popover. The token bumps, the post-await check
fails, and a partner **successfully created in Odoo** is silently dropped from
the cache write — the row stays greyed after a write that worked, which is the
one outcome the scope section promises cannot happen. It self-heals only if the
user retries and Layer 1 adopts.

So the hook gains `instanceToken`, bumped **only** in `handleInstanceChanged`.
This is the same reasoning, and the same shape, as `searchToken`, whose doc
comment at `useOdooTarget.ts:241-247` already says why a second token beats
overloading the first.

`CalendarProposal` keeps its own `epochRef` check before setting any result
state, exactly as `confirm` does at `CalendarProposal.tsx:453` and `:468`.

On a mismatch on either side: abandon silently — the hook returns
`{ kind: "abandoned" }`, the component renders nothing for it. The popover has
already reset to idle underneath.

### Resetting on every exit

`creating` and `creatingRef` are reset on **every** path out of a create attempt
— success, each error outcome, and abandonment — not only by the idle-reset
effect.

The idle-reset effect (`CalendarProposal.tsx:322-329`) fires only when
`state.kind` becomes `"idle"`, and an inline create failure leaves it at
`"proposal"` throughout. Relying on it alone would leave `Create contact`
permanently disabled on a form the Errors table promises stays open with the
draft intact for a retry — an affordance that cannot be used. The hook's
`creatingRef` reset belongs in a `finally`, the same shape as `confirm`'s
(`CalendarProposal.tsx:479-504`).

The idle-reset effect still gains the create's state, for the instance-change
case it does cover: `setCreating(false)`, close the form, clear the draft, clear
the create result, clear `resolvedByHand`.

### Closing the form when its row goes away

The open form is hosted by an `unmatched` entry, and two ordinary outcomes
destroy that entry while `state.kind` stays `"proposal"` — so no existing effect
cleans up after either:

- a successful create moves the attendee to `matched`;
- an archived-hit adoption flips its `reason` to `"archived"`, which renders
  with no create affordance at all.

`useCalendarProposal`'s re-projection produces a genuinely new `unmatched` array
whenever any entry's `reason` differs (`useCalendarProposal.ts:345-351`). So
`CalendarProposal` gets an effect keyed on `openForm` and `proposal?.unmatched`
that closes the form and clears the draft when the open address is no longer
present in `unmatched` with `reason === "no-contact"`.

### Where the result message renders

Not inside the row. A successful create unmounts the very entry that hosts the
form, so a message nested there is destroyed by the re-projection it is
announcing — `Already in Odoo — added to the list below.` would never be seen.

The create result renders at **region level**, beside `writeResult`
(`CalendarProposal.tsx:586-590`), and holds the address it refers to so the text
can name the right person after their row has gone. It is cleared on the same
triggers as `writeResult`.

A successful create (or an adoption) **closes the form**. The error outcomes
leave it open with the draft intact.

### At cap

Create stays available. The Odoo record has value independent of whether a slot
is free, and the alternative — hiding create when the log is full — makes the
affordance appear and disappear for a reason unrelated to the attendee. The
resulting row renders disabled like every other row while `atCap`, under the
existing `The log is full` notice.

Layer 2's `Use <name>` buttons are the exception: `onAddTarget` genuinely can
reject with `reason: "cap"` there, and that rejection surfaces in the create
result area without marking the address resolved.

## Errors

Every failure surfaces inline in the create form area, using the same rule the
rest of this feature follows: **the code, never server prose**. `odooError`
already redacts at construction, and `CALENDAR_SETTINGS_REMEDY` exists
precisely so this region is not the one place that rule gets relaxed.

| Case | Code | Surface |
| --- | --- | --- |
| Odoo rejects the write (access rights, a required field a customisation added, a validation) | `ODOO_FAULT` | `Odoo refused to create the contact (ODOO_FAULT). Check your Odoo permissions.` Form stays open with the draft intact. |
| Network / transport | `ODOO_UNREACHABLE` | `Could not reach Odoo. Try again.` Form stays open; retry adopts if the first attempt landed. |
| `create` returns a non-integer, or a row fails `parsePartnerRow` | `ODOO_UNEXPECTED_ROW` | Generic failure message. Nothing cached. |
| Credentials gone since the last sync | `ODOO_NOT_CONFIGURED` | Generic failure message. `getClient` raises this (`useOdooTarget.ts:368-374`). |
| Credentials rejected | `ODOO_AUTH_FAILED` | Generic failure message. `client.authenticate` raises this (`client.ts:128-134`). |
| **Any other `OdooErrorCode`** | — | Generic failure message, naming the code. This row is the default arm; the table above names the cases worth their own wording, not the whole union. |
| Read-back returns no row | — | `Created in Odoo, but it isn't visible to this connection.` **No cache row is fabricated.** Record rules can hide a record from the API user that created it; a synthesised cache row would produce a proposal row whose target write then fails, or worse, silently succeeds against a record the user cannot see. |
| Instance changed mid-create | — | Silent abandon. |
| `upsertContacts` fails | reported via `reportOdooError` | The Odoo write succeeded — say so: `Created in Odoo. Refresh to see them here.` |

The generic failure message is `Could not create the contact (<CODE>).`

**`reload` failing is deliberately not in this table.** It is contractually
`NEVER REJECTS` (`useOdooTarget.ts:530-535`) and catches everything into its own
toast (`:589-592`), so the create flow cannot observe it and must not claim to.
A failed reload after a successful upsert surfaces as that toast, and the row
resolves on the next thing that reloads the cache. Only the `upsertContacts`
failure is the create flow's to report.

### Never logged

Same list as PR #51's feature: no attendee names, no addresses, no subjects, no
tokens in any error, log line or telemetry. The draft the user typed is
included in that — it is a person's name and email.

## Testing

Vitest, following `src/tests/match-attendees.test.ts` for the pure modules and
`src/tests/useCalendarProposal.test.tsx` for the wired ones.

### An existing test changes, and it is not optional

`src/tests/CalendarProposal.states.test.tsx` fails as written the moment this
ships. Three specific amendments:

- `:101` asserts `expect(screen.queryByRole("button", { name: /create/i }))
  .toBeNull()` on a fixture containing a `no-contact` row, under the comment
  "no create-contact escape hatch either". **Retarget it**: render the two
  reasons separately, assert the affordance is present on the `no-contact` row
  and still absent on the `archived` row.
- `:84-96` asserts the row's testid and `text-muted-foreground` class. Keep
  both on the text node (see Affordance) and keep these assertions.
- `:15-24`'s `renderState` helper supplies a fixed handler set. Adding a
  required `onCreateContact` to `CalendarProposalProps` breaks type-checking for
  every `render` in the file until the helper supplies a stub.

**`similar-contacts.test.ts`** (pure, no mocks)
- two shared tokens match; one shared token does not
- single-character tokens are dropped: `J Doe` does not match `J Smith`
- diacritics fold: `José García` matches `Jose Garcia`
- apostrophes are removed, not spaced: `O'Brien` matches `OBrien`, and
  `Jane O'Brien` matches `Jane OBrien`
- a curly apostrophe behaves as a straight one: `O’Brien` matches `OBrien`
- hyphens separate, not vanish: `Jane Doe-Smith` matches `Jane Doe`
- a one-token name and a two-token name sharing that token do **not** match
  (`Jane` vs `Jane Doe`) — the clause requires both sets to be single-token
- mononym equality matches; mononym inequality does not
- colleagues, archived contacts and the attendee's own email are filtered out
- result is capped at three and ordered by `byRecency`, nulls last
- company inference: majority parent wins; tie breaks to the lowest id; an
  **inactive** contact on the matching domain does not vote; a contact with a
  null `parentId` does not vote; a winning `parentId` that names no cached
  `isCompany` contact infers nothing
- company inference, free-mail: with cached on-domain contacts that **would**
  otherwise produce a confident winner, a free-mail domain still infers nothing
  — the fixture must make the skip do real work rather than passing through the
  empty-candidates path

**`create-contact.test.ts`** (mocked `OdooClient`)
- miss → `create` is called once with `type: "contact"` and
  `is_company: false`, then read back
- hit on an active partner → **no `create` call**, the found row is returned
- hit on an archived partner → no `create`, and the archived outcome is
  distinguishable from the active one by the caller
- both an active and an archived partner share the email → the **active** one
  wins, whatever order Odoo returns them in
- a person and a company share the email → the person wins; two people → lowest
  id wins
- the search carries `=ilike`, `active_test: false`, and **no `limit`**
- no company selected → `parent_id: false`, not `null` and not omitted
- non-integer create result → `ODOO_UNEXPECTED_ROW`
- `client.execute` throws `ODOO_FAULT` → the code reaches the caller unchanged
- `client.execute` throws `ODOO_UNREACHABLE` → same
- read-back empty → the "created but invisible" outcome, and no partner row
  returned to cache

**`useOdooTarget` create tests** (mocked client and database)
- create-path success upserts exactly one row and calls `reload`, never
  `runSync`
- hit-active adopts: upserts the **found** row, makes no `create` call, returns
  the adopted-active outcome
- hit-archived: upserts the found row, makes no `create` call, returns the
  adopted-archived outcome — this is the case a "nothing is written" reading
  would get wrong
- an **instance** change mid-create writes no cache row
- a **selection** change mid-create (`onSelect` on another contact) still writes
  the cache row — the regression the `instanceToken` split exists to prevent
- a second create while one is in flight is a no-op
- `creatingRef` is released after a failure, so a second attempt runs
- a cache-write failure still reports the Odoo write as succeeded

**`CalendarProposal` component tests**
- the affordance renders on `no-contact` rows and **not** on `archived` rows
- opening the form writes nothing; `Cancel` writes nothing
- `Create contact` calls `onCreateContact` and does **not** call `onAddTarget`
- `Add N to log` does **not** call `onCreateContact`
- opening a second row's form closes the first and discards its draft
- after a successful create and re-projection, the new row is present,
  enabled, and **unchecked** — and rows the user had unchecked before the
  create stay unchecked
- the create result message survives the re-projection that removes the row it
  refers to
- a `Use <name>` button calls `onAddTarget` with that contact, no create
  occurs, and the row stops offering `Create in Odoo`
- a `Use <name>` button whose `onAddTarget` returns `{ ok: false, reason: "cap" }`
  reports the cap and leaves the row unresolved, still offering create
- an `ODOO_FAULT` result leaves the form open with the typed draft intact and
  `Create contact` **re-enabled**
- an idle reset mid-create sets no result state and leaves no disabled button
- the form closes when its row's `reason` flips to `archived` underneath it
- the name prefill flips `"Doe, Jane"`, falls back to the local-part, and an
  empty trimmed name disables the button
- a re-projection while the form is open does not overwrite the user's edited
  name
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
