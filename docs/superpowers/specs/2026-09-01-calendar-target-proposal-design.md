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
  (`src/lib/database/odoo-contacts.action.ts:331`) returns
  `{ ok: false, reason: "cap" }` at `MAX_TARGETS`. This feature is a caller
  like any other and inherits it.

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

**Therefore: the only thing in this feature that writes
`odoo_selected_targets` is a user click on a proposal row.** The matcher
produces a proposal; the click produces a selection. There is no path between
them that does not pass through the user.

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
  join — cheaper to recompute than to store. It lives in React state and dies
  with the picker.
- **No auto-popup.** The proposal is computed when the picker opens, not
  pushed at the user mid-call. Confirmation is mandatory either way, so
  pushing saves no interaction while interrupting a live meeting.
- **Google Calendar or any non-Outlook provider.**
- **Creating Odoo contacts for unmatched attendees.**
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

`offline_access` plus **one** of `Calendars.ReadBasic` or `Calendars.Read` —
see the probes below. Not `Calendars.Read.Shared`: this feature reads the
signed-in user's own calendar only. Not `User.Read`, unless the connect UI
ends up displaying the connected account's address, in which case it is added
with that reason stated.

### Token handling

**No token ever crosses the Tauri IPC boundary.**

- Refresh token: OS keychain.
- Access token: Rust process memory, with its expiry; refreshed on demand.
- Never written to `plugin-store`, `localStorage`, or any log.

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

1. **Does `Calendars.ReadBasic` return `attendees`?** Microsoft documents it
   as excluding "properties such as body, attachments, and extensions" —
   which is not an exhaustive list, and the community permission tables do not
   filter the event property list by scope. Both scopes are no-admin-consent,
   so this is purely data minimization: ReadBasic additionally withholds the
   meeting body, text this feature never needs and would rather not hold. One
   Graph Explorer call with a ReadBasic-consented token settles it. If
   `attendees` is absent, the scope is `Calendars.Read`. The same call also
   confirms whether the organizer is repeated inside `attendees` — the
   union-and-dedupe rule below is correct either way, so this is confirmation
   rather than a branch point.
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

Rejected candidates:

- cancelled events,
- all-day events,
- events the signed-in user has declined,
- events whose only participant — organizer included, per above — is the user.
  Focus blocks and reminders. This filter alone collapses most apparent
  overlaps.

Acceptance window, on the union'd candidate set:

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
  (falling back to `upn`) claim of the ID token** returned by the auth flow —
  `openid` is implicit in the code+PKCE exchange, so this costs no extra
  scope. It is specified here because the obvious alternatives, adding
  `User.Read` or calling `/me`, both widen the grant for a value the flow
  already hands over.
- contacts flagged `is_colleague`. Logging a meeting onto a coworker's partner
  record is noise. Under multi-target `is_colleague` no longer gates
  selection, only the deal lookup — this is a proposal-time filter layered on
  top, and the user can still add a colleague manually.

Attendees with no match are **shown, greyed, labelled "no Odoo contact"**.
They are never silently dropped: silent dropping is how a user fails to notice
that the one person who mattered is missing from the list. No create-contact
action.

## The confirmation surface

The window is 600px wide and non-resizable (`src-tauri/tauri.conf.json:17-22`)
and `resizeWindow` changes height only, so this is a compact block at the top
of the ContactPicker popover — the meeting subject, then one checkbox row per
matched contact — not a new page or dialog.

It lives in `CalendarProposal.tsx` rather than inside `ContactPicker.tsx`,
which is already 785 lines.

**Pre-check rule**, against `MAX_TARGETS` (`src/lib/odoo/meeting-log.ts:66`,
currently 5) — read from the constant, never a literal, so the rule follows
the cap if it ever moves:

- **`MAX_TARGETS` or fewer matches** — all pre-checked. One click adds them.
- **More than `MAX_TARGETS` matches** — **nothing** pre-checked, above the
  line "8 attendees matched — Odoo logging allows 5. Pick up to five."
  Auto-selecting an arbitrary five is precisely the wrong-record risk this
  feature exists to avoid, and the cap makes some choice unavoidable, so the
  choice is the user's.

Ordering in both cases: `lastMeetingAt` descending, with nulls last and ties
broken by name — the field is nullable (`src/types/odoo.ts:37`) and a contact
never logged to before must not sort ahead of one that was. Recency of prior
logging is a real signal and the app already stamps it via `stampLastMeeting`.

Confirming calls the existing `addSelectedTarget` once per checked row. The
action-layer cap remains the backstop; a `{ ok: false, reason: "cap" }` is
surfaced, not swallowed.

## Errors

`src/lib/calendar/errors.ts`, mirroring the shape of `src/lib/odoo/errors.ts`:

| Code | Meaning | User-facing behaviour |
|---|---|---|
| `GRAPH_NOT_CONNECTED` | No account connected | Proposal block absent; connect link on `/odoo` |
| `GRAPH_CONSENT_REQUIRED` | Tenant requires admin consent | Its own sentence, pointing at the client-ID override fields |
| `GRAPH_AUTH_EXPIRED` | Refresh failed or revoked | Prompt to reconnect; stored refresh token cleared |
| `GRAPH_THROTTLED` | 429 | Respect `Retry-After`; do not retry in a loop |
| `GRAPH_NETWORK` | Transport failure | Retry affordance |
| `GRAPH_NO_KEYCHAIN` | No keychain service (Linux) | Session-only connection, stated plainly |

`GRAPH_CONSENT_REQUIRED` is treated as an expected outcome, not an edge case.
In a tenant that blocks third-party consent it is the *normal* first result,
and the override fields are the main path rather than an advanced one.

Never logged, at any level: tokens, meeting subjects, attendee addresses. This
extends the redaction discipline already in `src/lib/odoo/redact.ts`.

## Testing

Vitest, following the existing `src/tests/*.test.ts` layout:

- `current-meeting.ts` — overlapping entries, declined, cancelled, all-day,
  solo/focus blocks, ended-within-grace, ended-outside-grace, starts-inside-
  and outside-the-early-join window, joined-late, empty calendar, several
  survivors, and **a client-organized 1:1 where the only `attendees` entry is
  the user** — that one must survive as a candidate and propose the organizer.
- `match-attendees.ts` — case and whitespace normalization, own address
  excluded, colleague excluded, unmatched retained and labelled, more than
  `MAX_TARGETS` matches, zero matches, duplicate addresses on one event, and
  an organizer who also appears in `attendees` counted once.
- Error mapping — each Graph failure to its `GRAPH_*` code.
- `CalendarProposal.tsx` — pre-check rule at 5 and at 6 matches, ordering,
  `addSelectedTarget` called once per checked row, cap rejection surfaced.

Cargo tests:

- PKCE verifier/challenge derivation.
- `state` generation and validation, including that a mismatched `state` is
  rejected without redeeming the code.
- Loopback callback URL parsing, including the error-response form.

Manual acceptance, because a loopback browser round-trip cannot be proven in
jsdom — the same acknowledgement `MeetingLogStrip.tsx` already makes about
window bounds:

- Full connect flow in a real tenant, ending in a proposal.
- Disconnect clears the keychain entry.
- The `GRAPH_CONSENT_REQUIRED` path in a tenant that blocks consent.

## Follow-up work

- Migrate the Odoo API key from plaintext `plugin-store` to the same keychain
  path. Shipping a hardened Graph credential story next to a plaintext Odoo
  key invites a justified audit finding. Its own issue.
- Meetwings-owned multi-tenant registration, once there is a user base for it.
- Name-similarity proposals, if the unmatched list proves insufficient.
