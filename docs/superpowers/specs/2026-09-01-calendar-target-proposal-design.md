# Calendar-proposed Odoo targets

Issue: [#47](https://github.com/kmorgan-r/meetwings-app/issues/47)
Date: 2026-09-01
Status: design approved, plan not yet written

Read the signed-in user's Outlook calendar, work out which meeting is
happening now, match that meeting's attendees against the cached Odoo
contacts by email, and present the matches as a proposal the user confirms
before anything is selected.

## Why

The contact picker starts empty every meeting. The user searches for the
person they are already on a call with — information the calendar already
holds. On a recurring client call that is the same manual lookup every week.

## Corrections to the issue text

The issue was written before its dependency shipped. Two of its statements
are stale, and this spec proceeds on the corrected facts:

- **Multi-target assignment is implemented and merged** (PR #48). Migration
  14 created `odoo_selected_targets` and `meeting_log_targets`; both are on
  `main`. The issue's "designed but not yet implemented" no longer holds, and
  nothing here is blocked on it.
- **The cap is enforced today.** `addSelectedTarget`
  (`src/lib/database/odoo-contacts.action.ts:319-331`) returns
  `{ ok: false, reason: "cap" }` at `MAX_TARGETS`. This feature inherits it —
  but *not* as "a caller like any other". It is the first **bulk** caller, and
  the check is a non-atomic select-then-upsert. Inheriting the cap safely is
  conditional on the sequential-write rule in "The confirmation surface"; issued
  concurrently, the cap does not hold at all.

## The invariant this feature is built around

From the multi-target design's forward-compatibility section, marked binding:

> enqueue trusts every row in `odoo_selected_targets` and performs no
> confirmation of its own. That is sound today only because each row got
> there by an explicit click. Any automated writer must therefore land its
> results somewhere a human confirms first, and must not write into
> `odoo_selected_targets` directly.

A wrong match does not waste a note. It posts one customer's meeting
transcript into a different customer's CRM record, on up to five records at
once, under a `mail.mt_note` that customer's account manager will read.

**Therefore: no write to `odoo_selected_targets` happens without an explicit
user confirm action.**

The control is a single confirm button, labelled with the exact count it will
write — "Add 4 to log". Checking and unchecking proposal rows writes nothing;
the button is the only thing that does. There is no path from a Graph response
to a database row that does not pass through it.

This is deliberately not phrased as "a click on a proposal row". A pre-checked
row (below) is written without ever being clicked, so a per-row formulation
would be contradicted by the pre-check rule in the same document. The confirm
click is the gate; the checkboxes are how the user tells the gate what to
write.

## Scope

### In

Connect an Outlook account over Microsoft Graph; find the meeting happening
now; exact-email-match its attendees against `odoo_contacts`; render the
matches as a confirmable block inside the existing ContactPicker.

### Out, and why

- **Name similarity matching — not implemented.** The issue frames it as
  propose-only. An attendee whose Odoo record carries a blank or different
  email already surfaces in the "no Odoo contact" list, where the user
  resolves them with the picker that exists today. Fuzzy matching would add a
  scoring subsystem plus a second, weaker confidence state in the UI to serve
  a case that is already covered. Deferred until the unmatched list proves
  insufficient in practice.
- **No migration; no `source` column.** Confirmation happens *before* the
  write, so every row in `odoo_selected_targets` is user-confirmed by
  construction — provenance is not a safety property here, and no v1
  behaviour branches on it. Staying off the migration surface also keeps the
  frozen checksums of 11–14 untouched. What would force it later: wanting to
  re-run the proposal mid-meeting and replace calendar-sourced rows without
  disturbing manually added ones.
- **No proposal persistence.** A proposal is one Graph call plus a local
  join — cheaper to recompute than to store. It lives in React state and is
  discarded when the picker closes. Note "discarded", not "dies": `ContactPicker`
  stays mounted when the popover closes, so this costs an explicit reset rather
  than coming free with unmounting. See "Lifecycle".
- **No auto-popup.** The proposal is computed when the picker opens, not
  pushed at the user mid-call. Confirmation is mandatory either way, so
  pushing saves no interaction while interrupting a live meeting.
- **Google Calendar or any non-Outlook provider.**
- **Creating Odoo contacts for unmatched attendees.** Deferred to
  [#50](https://github.com/kmorgan-r/meetwings-app/issues/50) — see
  "Follow-up work".
- **Migrating the Odoo API key to the keychain.** Correct to do, but it is
  its own issue — see "Follow-up work".

## Architecture

Rust does IO and holds credentials. Every decision is a pure TypeScript
function with unit tests. This mirrors the pattern already in the codebase:
`classify` in `src-tauri/src/meeting_detect/mod.rs`,
`src/lib/odoo/sync-decisions.ts`, and
`src/lib/functions/meeting-auto-record.ts`.

```
src-tauri/src/graph/
  mod.rs        graph_connect, graph_disconnect, graph_status,
                graph_current_meetings
  auth.rs       PKCE + state, loopback listener, refresh, keychain
  calendar.rs   GET /me/calendarView

src/lib/calendar/
  current-meeting.ts   pure: events -> one | candidates | none
  match-attendees.ts   pure: (attendees, contacts, ownAddress) -> matched /
                       unmatched / excluded
  errors.ts            GRAPH_* codes, mirroring src/lib/odoo/errors.ts

src/hooks/useCalendarProposal.ts
src/pages/app/components/completion/CalendarProposal.tsx
src/pages/odoo/  (calendar connect section added)
```

### Where matching runs, and why not in Rust

`src-tauri/src/db/mod.rs` declares migrations and nothing else; every query in
this app runs in the webview through `tauri-plugin-sql`. Rust has no handle on
`odoo_contacts`, so the match cannot happen there without inventing a second
database path.

Rust therefore returns attendee names and addresses to the webview, and
`match-attendees.ts` joins them against the contact cache. This does not
weaken the token boundary below: attendee addresses are not credentials, and
the webview already renders full meeting transcripts derived from the same
meetings.

Rust normalizes every `start` and `end` to **epoch milliseconds** before
returning them. Graph sends `dateTime` as a string with no offset suffix
alongside a separate `timeZone` field, so `new Date(ev.start.dateTime)` in the
webview would read it as *local* time and shift the entire acceptance window by
the UTC offset — selecting the wrong meeting, or none. Normalizing at the
boundary keeps `current-meeting.ts` taking plain numbers, which is what makes
its window arithmetic testable without a timezone harness.

### Where the proposal mounts

`ContactPicker` is wrapped in `React.memo` and is fully controlled: it owns no
data, only local UI state, and every one of its ~30 props comes from
`useOdooTarget` through `<Completion />` (`ContactPicker.tsx:90`, `:159`).
The proposal follows that existing shape rather than working around it:

- **`useCalendarProposal` is called in `<Completion />`**, beside
  `useOdooTarget`. Not inside `ContactPicker` — a hook there would re-run on
  every keystroke in the search box, and could not survive the popover's
  lifecycle rules below.
- **`CalendarProposal` receives props**, exactly like every other part of this
  popover. It fetches nothing itself.
- **`ContactPicker.tsx` is edited**, minimally: new props threaded through, and
  `<CalendarProposal />` rendered at the top of the popover content. Keeping the
  block's own markup and logic in a separate file is what avoids growing a
  785-line component further; it does not mean that file goes untouched. Any
  plan that plans otherwise is planning something that cannot render.

## Authentication

### Flow

Authorization code + PKCE (S256) with `state`, in the **system browser**, with
a single-use loopback listener.

- Bind **literal `127.0.0.1`** — not `localhost`, not `0.0.0.0`.
- Random ephemeral port, chosen per attempt.
- The listener is single-use and times out.
- `state` is validated before the code is accepted; a mismatch is rejected
  without redeeming anything.
- The browser response is a static "you can close this tab" page that never
  echoes the code.
- **Device code flow is not implemented**, and "Allow public client flows"
  stays disabled on the registration. Device-code phishing is an active
  campaign class — the attacker generates the code and the victim types it at
  `microsoft.com/devicelogin` — and enabling the grant would let those lures
  carry this app's name. Separately, Conditional Access commonly blocks the
  device grant, so it breaks in exactly the tenants this feature targets.

Loopback interception is the standard objection to this flow and PKCE is the
standard answer: a local process that races for the port cannot redeem the
code without the verifier. A same-user malicious process could run its own
flow, but that is local compromise, which no flow choice survives.

### Registration ownership

A public client ID is **not a secret** — it travels in every authorize URL and
is trivially extracted from any native binary. Ownership is therefore an
operational choice, not a security one, and both options carry the same
consent-phishing exposure. What actually mitigates that exposure is
registration hygiene, which this spec fixes:

- Loopback-only redirect URIs. No web/https redirect, no wildcard.
- "Allow public client flows" = No.
- `/organizations` authority, not `/common` — personal MSA accounts are out of
  scope for this feature.
- Minimum scopes (below).

**v1 ships no client ID.** The client ID and authority are config strings with
constant defaults, and the defaults are empty, so setup is two fields on the
`/odoo` page. This is how Odoo credentials already work: the user brings their
own.

The alternative — shipping a Meetwings-owned multi-tenant registration — is
where this goes when there is a user base to justify it, and it costs nothing
extra to get there because the code shape is identical. It is not v1 because
Microsoft restricts user consent to unverified multi-tenant apps, publisher
verification needs a Microsoft Partner account, and the maintainer would own
that registration and its consent surface permanently. At that point today's
fields become the admin override, which is the correct enterprise answer
anyway: a tenant admin registers a single-tenant app they control and points
Meetwings at it.

### Scopes

`openid profile offline_access` plus **one** of `Calendars.ReadBasic` or
`Calendars.Read` — see the probes below.

`openid` and `profile` are **requested explicitly**. An earlier draft claimed
`openid` was implicit in the code+PKCE exchange and that the ID token therefore
came for free; that is an assumption, and it is load-bearing — the own-address
exclusion depends on the ID token existing and carrying a username claim. It
costs nothing to ask for the two scopes that guarantee it, and both are
no-consent. A `nonce` is sent on the authorize request and validated in the
returned ID token.

Not `Calendars.Read.Shared`: this feature reads the signed-in user's own
calendar only. Not `User.Read`, unless the connect UI ends up displaying the
connected account's address, in which case it is added with that reason stated.

### Token handling

**No token ever crosses the Tauri IPC boundary.**

- Refresh token: OS keychain.
- Access token: Rust process memory, with its expiry; refreshed on demand.
- Never written to `plugin-store`, `localStorage`, or any log.

**Lifecycle rules.** These are specified because the wrong ones destroy a
working ~90-day credential over a transient failure, and re-authentication is
not always available — in a consent-blocked tenant it may need an administrator.

- **Clear the stored refresh token only on an explicit `invalid_grant`** from
  the token endpoint. That is the one response meaning the token is genuinely
  dead (revoked, expired, password changed). A transport failure or a timeout
  during refresh maps to `GRAPH_NETWORK` and **retains** the token.
- **One refresh-and-retry on a 401** from a data call, then give up. The access
  token can expire mid-session; a single silent refresh is the normal path, and
  a second 401 after a fresh token is a real authorization failure.
- **Rotation writes the new refresh token before deleting the old one.** Entra
  rotates the refresh token on every redemption; deleting first and then failing
  the keychain write leaves the user with no credential and no way back.
- **Disconnect clears the keychain entry, zeroes the in-memory access token, and
  aborts in-flight calls.** Clearing only the keychain leaves a live token in
  Rust memory that keeps working until its expiry — a disconnect that does not
  disconnect.

This rule is stricter than the app's existing habit on purpose. Meetwings
renders markdown and transcripts derived from untrusted meeting content in the
React layer; one XSS in that path, with a token reachable from JS, silently
exfiltrates a credential that reads a corporate mailbox for roughly ninety
days. `src/lib/secure-storage.ts` is plaintext JSON on disk and says so in its
own doc comment — that is the one existing pattern this feature must not copy.

On Linux with no keychain service available: **refuse to persist** and
re-authenticate each launch. A silent plaintext fallback is not acceptable.

### Probes, resolved before implementation begins

Two questions are unresolved and cheap to answer. Both are plan tasks, not
assumptions, because each can move a module boundary:

1. **Does `Calendars.ReadBasic` return every property the filters read?**
   Microsoft documents it as excluding "properties such as body, attachments,
   and extensions" — which is not an exhaustive list, and the community
   permission tables do not filter the event property list by scope. Both scopes
   are no-admin-consent, so this is purely data minimization: ReadBasic
   additionally withholds the meeting body, text this feature never needs and
   would rather not hold. One Graph Explorer call with a ReadBasic-consented
   token settles it. If any required property is absent, the scope is
   `Calendars.Read`.

   The probe covers **the whole set the rules below consume**, not just
   `attendees`: `attendees`, `organizer`, `subject`, `start`, `end`,
   `isCancelled`, `isAllDay`, and the signed-in user's `responseStatus`. Asking
   only about `attendees` would be a trap — if ReadBasic withholds `isCancelled`
   or `responseStatus` under the same undocumented "properties such as…" clause,
   the cancelled and declined filters silently no-op and a meeting the user
   *declined* proposes its attendees.

   **The Rust layer fails loudly on an absent filter property** rather than
   defaulting the event to included. A missing `isCancelled` is not "false"; it
   is an unusable response, and it maps to an error rather than a proposal.

   The same call also confirms whether the organizer is repeated inside
   `attendees` — the union-and-dedupe rule below is correct either way, so this
   is confirmation rather than a branch point.
2. **Does `tauri-plugin-keychain` (already in `src-tauri/Cargo.toml`, unused)
   expose a Rust-side API?** If it is JS-facing only, it cannot hold the
   refresh token without putting that token back in the webview, which the
   boundary above forbids. Fallback: the `keyring` crate used directly from
   Rust. This is checked **first**, before any auth code is written.

## Selecting the meeting

`GET /me/calendarView` over `[now − 15 min, now + 15 min]`. Everything after
the response is `current-meeting.ts`, pure and unit-tested. The query window
is deliberately wider than the acceptance window below, so the pure function
sees the events either side of the boundary rather than having them filtered
away by the query.

**The organizer is a participant.** Graph carries the organizer in a separate
`organizer` property and generally does *not* repeat them in `attendees`.
Every rule below, and the matcher in the next section, operates on the union
of `organizer.emailAddress` and `attendees[].emailAddress`, deduped by
normalized address. Getting this wrong breaks the issue's opening scenario
outright: on a 1:1 client call the *client* organized, `attendees` is just the
user, and a naive rule discards the meeting as a focus block.

**Rooms and equipment are not participants.** Graph puts them in the same
`attendees[]` array, distinguished only by `type: "resource"`. They are dropped
from the union *before* any rule sees it, which fixes two separate bugs at once:
a booked room would otherwise defeat the solo/focus-block filter below (user +
room = two participants, so a focus block with a room held survives as a
candidate), and every room-booked meeting would render a permanent greyed
"Conf Room 3 — no Odoo contact" row that no user can ever resolve.

Rejected candidates:

- cancelled events,
- all-day events,
- events the signed-in user has declined,
- events whose only participant — organizer included, per above — is the user.
  Focus blocks and reminders. This filter alone collapses most apparent
  overlaps.

Acceptance window, on the union'd candidate set, evaluated against the epoch
milliseconds Rust normalized at the boundary (see Architecture):

- `start <= now + 5 min` — an event further out than that is not the meeting
  you are in, even when the 15-minute query returns it. Five minutes covers
  the normal early join.
- `end >= now - 10 min` — an event that ended within ten minutes still counts
  when nothing else is live. Meetings run over, and users start logging after
  the fact.

Joining late needs no special handling: the window is anchored on *now*, not
on when recording started.

Outcomes:

- **exactly one survivor** — propose from it.
- **several survivors** — do not guess. The proposal block instead renders one
  row per candidate meeting, subject and start–end time; picking one replaces
  the block with that meeting's attendee proposal.
- **none** — the picker behaves exactly as it does today, with no proposal
  block.

The block is also absent, with no error, when Odoo is not configured or the
contact cache is empty — there is nothing to match against, and the user's
next step is the Odoo sync, not this feature.

The proposal does not re-run when the calendar entry changes mid-meeting. It
is recomputed each time the picker opens, which covers the realistic case
without a watcher.

## Matching attendees

Exact match on normalized email — trim and lowercase both sides — against
`odoo_contacts`, **scoped to the current instance fingerprint**, via the
existing `listContacts(instance)`. The `(instance, email)` index from
migration 11 serves this directly; the sync needs no change. The instance
scope is not optional: matching across instances would resolve an address to
an id that names a different partner in the database currently configured.

The matcher's input is the same organizer-plus-attendees union described
above, so a client who organized the meeting is matched like any other
participant.

Excluded from the **proposal** (not from what the user may select by hand):

- the signed-in user's own address. **Its source is the `preferred_username`
  (falling back to `upn`) claim of the ID token**, which the explicit `openid
  profile` scopes above guarantee. It is specified here because the obvious
  alternative — adding `User.Read` or calling `/me` — widens the grant for a
  value the flow already hands over.

  **This exclusion is best-effort, and the spec says so rather than pretending
  otherwise.** Both claims are UPN-shaped and in many tenants differ from the
  primary SMTP address that appears in `attendees[]`
  (`k.morgan@corp.contoso.com` vs `kevin.morgan@contoso.com`). When the claim
  matches no address in the union, or neither claim is present, **the user's own
  row is proposed like any other** — greyed and labelled if it has no Odoo
  contact, checkable if it does. That is the safe failure: an extra row the user
  can see and uncheck, never a silently dropped attendee. The alternative,
  guessing at identity by name, is the fuzzy matching this spec already declined.
- contacts flagged `is_colleague`. Logging a meeting onto a coworker's partner
  record is noise. Under multi-target `is_colleague` no longer gates
  selection, only the deal lookup — this is a proposal-time filter layered on
  top, and the user can still add a colleague manually.
- contacts with `active: false` (`src/types/odoo.ts:34`). `listContacts` runs a
  bare `SELECT * FROM odoo_contacts WHERE instance = ?`
  (`src/lib/database/odoo-contacts.action.ts:122`) with no `active` filter, so
  archived partners are in the cache and would otherwise be proposed. An
  archived attendee is treated exactly like an unmatched one: shown, greyed,
  labelled — the record exists but is not somewhere new notes should land.

Attendees with no match are **shown, greyed, labelled "no Odoo contact"**.
They are never silently dropped: silent dropping is how a user fails to notice
that the one person who mattered is missing from the list. No create-contact
action.

## The confirmation surface

The window is 600px wide and non-resizable (`src-tauri/tauri.conf.json:17-22`)
and `resizeWindow` changes height only, so this is a compact block at the top
of the ContactPicker popover — the meeting subject, then one checkbox row per
matched contact, then the confirm button — not a new page or dialog.

The block's own markup and logic live in `CalendarProposal.tsx` rather than
inside `ContactPicker.tsx`, which is already 785 lines. `ContactPicker.tsx` is
still edited to render it and thread its props; see "Where the proposal mounts".

### It must not change the popover's height

`resizeWindow(true)` is driven by a **fixed flag list observed when the popover
opens**, not by measured content height, and it is the only thing that grows a
window `tauri.conf.json` pins at 600x54 with `"resizable": false`. The proposal
arrives *after* the popover opens, because the Graph call is async. Content that
appears later has nothing to grow the window around it.

Therefore the proposal renders inside a **fixed max-height, internally
scrollable region**, sized so the popover's total footprint is identical whether
the block is absent, loading, showing two rows or showing twelve. A block that
changed the popover's height would need the resize effect to re-run on data
arrival, which it has no mechanism to do.

jsdom has no window bounds, so no test can prove this is visible — the same
acknowledgement `MeetingLogStrip.tsx` already makes. It is a required manual
acceptance item.

### Slot rule

The cap is **not** "five matches". `addSelectedTarget` counts every *other* row
already in `odoo_selected_targets` for the instance and rejects at
`>= MAX_TARGETS` (`src/lib/database/odoo-contacts.action.ts:319-331`, using
`SELECTED_TARGET_SQL.countOthers` at `:279`). Targets the user picked by hand
before the proposal ran consume slots. `ContactPicker` already computes exactly
this quantity for its own use: `atCap = targets.length >= MAX_TARGETS`
(`:284`).

Two definitions, both read from `MAX_TARGETS`
(`src/lib/odoo/meeting-log.ts:66`, currently 5) and never from a literal:

- **Writable matches** — matched contacts *not already in `targets`*. A match
  that is already a selected target is rendered as already-selected, is not
  checkable, and is **excluded from the write entirely**. Re-upserting it would
  overwrite that row's `conversation_id` (possibly to `null`) and its
  `selected_at`, which reorders `loadTargets` — that query sorts by
  `selected_at` (`SELECTED_TARGET_SQL.list`). Silently rewriting a row the user
  chose by hand is precisely the "without disturbing manually added ones"
  problem this spec cites as the thing that would force a `source` column.
- **Free slots** — `MAX_TARGETS - targets.length`.

The rule:

- **Writable matches ≤ free slots** — all pre-checked. Confirming adds them.
- **Writable matches > free slots** — **nothing** pre-checked, above a line
  naming the real remaining count: "8 attendees matched — 2 slots left. Pick up
  to two." Auto-selecting an arbitrary subset is precisely the wrong-record risk
  this feature exists to avoid, and the cap makes some choice unavoidable, so
  the choice is the user's. The copy must state free slots, not `MAX_TARGETS`:
  "Pick up to five" when two slots remain is a promise the database will break.
- **Free slots = 0** — nothing pre-checked, nothing checkable, one line saying
  the log is full and pointing at the existing "Logging to" box to remove
  something.

Ordering in all cases: `lastMeetingAt` descending, with nulls last and ties
broken by name — the field is nullable (`src/types/odoo.ts:37`) and a contact
never logged to before must not sort ahead of one that was. Recency of prior
logging is a real signal and the app already stamps it via `stampLastMeeting`.

### The write

Confirming writes through **`ContactPicker`'s existing `onAddTarget` prop**, the
`useOdooTarget`-owned handler, once per checked row — **not** through the
`addSelectedTarget` action directly. Calling the database layer from a component
would bypass the hook that owns `targets`, leaving the picker's own list, its
`atCap` at `:284`, and the "Logging to" box stale against the database until
something else forced a reload.

**The calls are sequential — `for...of` with `await`, never `Promise.all`.**
`addSelectedTarget` is a non-atomic check-then-act: a `db.select(countOthers)`
followed by a separate `db.execute(upsert)`, with no transaction around them
(`:319-331`). This feature is its first *bulk* caller. Issued concurrently,
every call's count runs before any insert commits, all of them see room under
the cap, and more than `MAX_TARGETS` rows land — silently defeating the backstop
this spec leans on. Sequential execution is what makes each call observe the
previous one's write.

The loop stops at the first `{ ok: false, reason: "cap" }` and surfaces it,
naming which rows were written and which were not. The action-layer cap remains
the backstop; a rejection is surfaced, never swallowed.

### Lifecycle

`ContactPicker` **stays mounted when the popover closes** — that is why
`confirmingClear` needs an explicit reset effect keyed on `open`
(`ContactPicker.tsx:205-206`). "Dies with the picker" would therefore be false
if taken literally: without a reset, the previous meeting's matches, checked
boxes, and errors are what the user sees on reopen, and the feature's own
motivating case is the *same* attendees recurring week to week.

So, explicitly:

- **Reset on the `open` → false transition**: matches, checked state, chosen
  candidate meeting, loading and error state, mirroring `:206`.
- **Reset on an Odoo instance change**, for the same reason the matcher is
  instance-scoped: an id from one instance names a different partner in another.
- **A request-generation guard** on the fetch. React 19 StrictMode double-invokes
  effects in dev, and a close-then-reopen can leave two Graph calls in flight;
  without a generation counter or cancellation flag the *older* response can
  overwrite the newer. This codebase already works around the same class of bug
  (`ContactPicker.tsx:233`'s debounce cleanup, and the `toggleExpand` comment on
  why a side effect must not live inside a state updater).

## Errors

`src/lib/calendar/errors.ts`, mirroring the shape of `src/lib/odoo/errors.ts`:

| Code | Meaning | User-facing behaviour |
|---|---|---|
| `GRAPH_NOT_CONNECTED` | No account connected | Proposal block absent; connect link on `/odoo` |
| `GRAPH_CONSENT_REQUIRED` | Tenant requires admin consent | Its own sentence; admin-consent instruction (see below) |
| `GRAPH_AUTH_CANCELLED` | `access_denied`, listener timeout, or an abandoned flow | Connect returns to its idle state, no error styling |
| `GRAPH_AUTH_EXPIRED` | `invalid_grant` from the token endpoint — and only that | Prompt to reconnect; stored refresh token cleared |
| `GRAPH_THROTTLED` | 429 | Respect `Retry-After`; do not retry in a loop |
| `GRAPH_NETWORK` | Transport failure, including a refresh that failed to transmit | Retry affordance; refresh token **retained** |
| `GRAPH_NO_KEYCHAIN` | No keychain service (Linux) | Session-only connection, stated plainly |

`GRAPH_AUTH_CANCELLED` covers the commonest outcome of a loopback flow: the user
closes the browser tab, clicks Cancel on the consent screen, or walks away until
the single-use listener times out. It is not a failure and must not be dressed
as one. The cargo tests already parse this response form; the table previously
had nowhere to put it.

The `GRAPH_AUTH_EXPIRED` / `GRAPH_NETWORK` split is load-bearing, not
bookkeeping — see "Lifecycle rules". A refresh that fails to transmit must not
discard a working ~90-day credential.

`GRAPH_CONSENT_REQUIRED` is treated as an expected outcome, not an edge case.
In a tenant that blocks third-party consent it is the *normal* first result.
**In v1 the remedy is an admin-consent instruction for the registration the user
supplied** — the admin-consent URL for their own client ID, to hand to whoever
administers their tenant. Pointing them at the client-ID override fields would
be circular: v1 ships no client ID and the defaults are empty, so they had
already filled those fields in to reach this error at all. The override-fields
wording becomes correct only once a Meetwings-owned registration exists to
override.

### Never logged

Tokens, meeting subjects, and attendee addresses are never logged, at any level.

**This is a construction-site rule, not a redaction rule**, and the distinction
matters because the mechanism it would otherwise claim to extend cannot deliver
it. `buildRedactor` (`src/lib/odoo/redact.ts`) takes a **fixed list of secrets
known at initialisation** and builds a needle set from them; meeting subjects and
attendee addresses are per-event values that no pre-built needle list can cover,
and mutating the `getRedactor()` singleton per meeting would fight
`isRedactorInitialised`'s contract in `reportOdooError`.

So: subjects and attendee addresses are **never passed into a `GraphError`'s
message or details in the first place**. Errors carry the code, the operation,
and non-identifying counts. The redactor still applies to credentials, exactly as
it does for Odoo.

## Testing

Vitest, in the flat `src/tests/` layout with its `<subject>.<aspect>.test.ts[x]`
naming (hook tests follow `useOdooTarget.test.tsx`):

- `current-meeting.ts` — overlapping entries, declined, cancelled, all-day,
  solo/focus blocks, ended-within-grace, ended-outside-grace, starts-inside-
  and outside-the-early-join window, joined-late, empty calendar, several
  survivors, **a client-organized 1:1 where the only `attendees` entry is
  the user** (must survive and propose the organizer), **a focus block with a
  room resource attached** (must still be rejected — the room is not a
  participant), and **an event whose times carry a non-UTC offset**, proving the
  window is evaluated on normalized epoch milliseconds rather than a
  locally-parsed string.
- `match-attendees.ts` — case and whitespace normalization, own address
  excluded, **own address unresolvable so the user's row is proposed rather than
  dropped**, colleague excluded, `active: false` contact treated as unmatched,
  resource attendees absent from the union, unmatched retained and labelled,
  zero matches, duplicate addresses on one event, and an organizer who also
  appears in `attendees` counted once.
- `useCalendarProposal` — the hook that orchestrates all of the above, and the
  one piece with no coverage in the first draft of this section. No block when
  Odoo is unconfigured or the contact cache is empty; recompute on picker-open
  and *not* on a calendar-data change; the several-survivors → single-proposal
  transition; state cleared on the `open` → false transition; state cleared on
  an instance change; and a superseded in-flight response discarded rather than
  overwriting a newer one.
- Error mapping — each Graph failure to its `GRAPH_*` code, including the split
  that matters: `invalid_grant` → `GRAPH_AUTH_EXPIRED` **and the stored refresh
  token cleared**, versus a transport failure during refresh → `GRAPH_NETWORK`
  **with the refresh token retained**. A test that only asserts "auth failure
  clears the token" would lock in the defect this spec corrected.
- Throttling — a 429 carrying `Retry-After` does not trigger an immediate or
  looping retry.
- Redaction — a token, a meeting subject, and an attendee address embedded in a
  raw thrown error do not survive into the reported message or details. The
  analogue of `odoo-redact.test.ts`, and the executable form of the
  construction-site rule above.
- `CalendarProposal.tsx` — the **slot rule**, not a bare match count: matches
  ≤ free slots with `targets` non-empty (all pre-checked), matches > free slots
  (nothing pre-checked, copy names the real remaining count), zero free slots, a
  match already present in `targets` rendered as already-selected and **absent
  from the write**, ordering, `onAddTarget` called once per checked row, calls
  **sequential rather than concurrent**, and a `{ ok: false, reason: "cap" }`
  surfaced naming what was and was not written.

The cap tests must exercise the real `countOthers` semantics with `targets`
pre-populated. Stubbing a blanket cap rejection proves only that a stub was
returned, and would pass against exactly the match-count rule this review
corrected.

Cargo tests:

- PKCE verifier/challenge derivation.
- `state` generation and validation, including that a mismatched `state` is
  rejected without redeeming the code.
- `nonce` validation in the returned ID token.
- Own-address claim extraction: `preferred_username` when present, `upn` as the
  fallback, and neither present. This happens in Rust —
  `match-attendees.ts` takes `ownAddress` as an already-resolved input, so its
  own tests cannot cover it.
- Loopback callback URL parsing, including the error-response form, and the
  listener's **single-use and timeout** behaviour: a second callback to a
  consumed or stale listener is rejected, not redeemed.
- The IPC return shape: `graph_current_meetings` and every other exposed command
  serializes no token or credential field. This is the executable form of the
  spec's central security invariant — a future edit that widens the struct
  should fail a test rather than ship.
- Absent filter properties (`isCancelled`, `isAllDay`, `responseStatus`) produce
  an error rather than an event that defaults to included.

Manual acceptance, because a loopback browser round-trip cannot be proven in
jsdom — the same acknowledgement `MeetingLogStrip.tsx` already makes about
window bounds:

- Full connect flow in a real tenant, ending in a proposal.
- Disconnect clears the keychain entry, and a subsequent call fails rather than
  succeeding on a still-live in-memory access token.
- The `GRAPH_CONSENT_REQUIRED` path in a tenant that blocks consent.
- **Linux with no keychain service**: the connection is session-only, nothing is
  written to disk, and relaunching requires re-authentication. The
  refuse-to-persist rule is a stated security requirement and this is the only
  place it can be exercised.
- **The popover's height is unchanged** whether the proposal block is absent,
  loading, showing two rows, or showing twelve — jsdom has no window bounds, so
  nothing automated can prove the block is visible at all.

## Follow-up work

- Migrate the Odoo API key from plaintext `plugin-store` to the same keychain
  path. Shipping a hardened Graph credential story next to a plaintext Odoo
  key invites a justified audit finding. Its own issue.
- Resolving unmatched attendees into Odoo —
  [#50](https://github.com/kmorgan-r/meetwings-app/issues/50). Its own issue
  because "create a contact" is the wrong action for an attendee who exists
  only as an unlinked `crm.lead`, because the watermarked contact cache cannot
  be trusted for a dedupe check (the search must hit the server), and because
  it is this app's first master-data write to Odoo. The greyed unmatched row
  specified above is its hook point, so deferring costs no rework.
- Meetwings-owned multi-tenant registration, once there is a user base for it.
- Name-similarity proposals, if the unmatched list proves insufficient.
