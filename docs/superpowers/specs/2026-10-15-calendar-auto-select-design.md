# Auto-select Odoo targets from the Outlook meeting

Date: 2026-10-15
Status: design approved, plan not yet written
Builds on: `2026-09-01-calendar-target-proposal-design.md` (PR #51),
`2026-09-05-create-odoo-contact-from-attendee-design.md` (#53)

When meeting capture starts, read the current Outlook meeting, and without
asking, add its attendees' Odoo contacts as targets — creating a contact for an
attendee who has none — whenever the case is unambiguous. Anything ambiguous is
left to the existing confirm block in the ContactPicker.

## Why

The calendar proposal only runs when the user opens the picker, and every row
needs a confirm click. A user who is in the meeting and not watching the overlay
never opens it, the meeting enqueues `unassigned`, and the log has to be fixed by
hand afterwards. The calendar already says who the meeting is with.

## What this overrides

Two binding rules from earlier specs:

- 2026-09-01: "no write to `odoo_selected_targets` happens without an explicit
  user confirm action."
- 2026-09-05: "no `res.partner` is created without an explicit user confirm
  action distinct from the one that adds targets."

This feature is a deliberate, user-requested exception to both, for one path
only: the unambiguous case below, behind a setting. The confirm block, the
create form and every manual path are unchanged. With the setting off, both
rules hold exactly as before.

The cost is stated plainly because nothing else will surface it: at meeting end
the transcript and AI summary post to every target after the 30-second hold
(`HOLD_MS`, `src/lib/odoo/meeting-log.ts`). With auto-select on, a wrong match
reaches a customer's CRM record with no human having looked at it. The rules
below exist to keep "wrong match" rare; they do not make it impossible.

## Setting

`STORAGE_KEYS.CALENDAR_AUTO_SELECT_ENABLED`, read through `safeLocalStorage`.
**Default on**: enabled unless the stored value is the string `"false"`. A Switch
on the `/odoo` page, under the Outlook connection, labelled "Add meeting
attendees automatically".

The `/odoo` page runs in the `dashboard` webview and the hook in `main`. Both
share localStorage (same pattern as `MEETING_AUTO_RECORD_ENABLED`), and the hook
reads the key at the moment capture starts, so no cross-window broadcast is
needed.

## When it runs

Once per meeting, at the meeting-capture rising edge (`meetingAssistMode &&
enableVAD` turning true — the edge PR #82's rollover already watches), and only
when all of these hold:

1. The setting is on.
2. The rollover has finished. If the 30-minute gap rule decides a new
   conversation is due, `startNewConversation()` is **awaited** first. That call
   dispatches `newConversationStarted`, whose `handleNewChat` empties the
   targets; auto-select must land after it or it is wiped seconds later.
3. The conversation has no meeting yet: no message in
   `conversationHistoryRef.current` carries an `audioSource`. Every transcript
   line is pushed into that ref with its `audioSource` as soon as it arrives
   (`addMeetingTranscript`, `addMeetingTranscriptEntries`,
   `addSystemAudioTranscript`), autosaved or not, so this one check covers
   unsaved lines too. This is what makes a mid-call capture restart (detection
   flapping, a paused mic) and a back-to-back meeting inside the 30-minute
   window skip.

   Do **not** test `meetingTranscript` here: it is a session-wide buffer, never
   cleared per conversation (`useCompletion.ts` comment on
   `conversationTranscriptStartRef`; `startNewConversation` leaves it alone), so
   "transcript empty" is false after the first meeting of an app session and
   would block every rollover.

Then `useCompletion` dispatches a `meetingCaptureStarted` window event. It
carries no payload; the event firing is the decision.

Outlook not connected, Odoo not configured, or an empty contact cache: the run
ends silently. These are the same static-absence conditions the proposal block
uses.

## The plan: `planAutoSelect`

A pure function in `src/lib/calendar/auto-select.ts`:

```ts
planAutoSelect({ events, ownAddress, contacts, targets, now }):
  | { kind: "skip"; reason: AutoSelectSkip }
  | { kind: "apply"; add: OdooContact[]; create: AutoCreate[] }

interface AutoCreate {
  participant: CalendarParticipant;
  name: string;
  parentId: number | null;
}
```

It reuses, and does not copy: `pickCurrentMeeting`, `participantsOf`,
`matchAttendees`, `similarContacts`, `inferCompany`, `MAX_TARGETS`.

Rules, in order:

0. **Own address known.** `ownAddress` null: skip. Without it there is no own
   domain, and every coworker on an internal call who has no partner record
   would be created.
1. **Exactly one current meeting.** `pickCurrentMeeting(events, now)` must return
   `one`. `none` and `several` skip. Never guess between overlapping meetings.
2. **Match.** `matchAttendees` with the existing exclusions: the user's own
   address (best effort, see Limits), `isColleague` contacts, inactive contacts.
   **Colleague domains** (used by rules 3 and 4): the domain of `ownAddress`
   plus the domains of contacts with `isColleague === true`, with free-mail
   domains removed from that set (one colleague on gmail must not block every
   gmail attendee). Compared lowercased. `FREE_MAIL` and `domainOf` in
   `similar-contacts.ts` are module-private today and get exported for this.
3. **Add** = `matched` contacts not already in `targets` (the existing "writable"
   rule) and whose attendee address is not on a colleague domain. An
   already-selected match is never re-upserted — that would rewrite its
   `selected_at` and `conversation_id`. A coworker who has a partner record but
   is not flagged `isColleague` is therefore left to the proposal block, not
   auto-added (and does not use up a slot under rule 5).
4. **Create** = `unmatched` entries with reason `no-contact` (never `archived`:
   creating one would duplicate the archived record) where all of these hold:
   - the participant has a display name that is non-blank and is not just the
     address;
   - `similarContacts({ name, address, contacts })` is empty. A similar name is
     probably the same person under another address, which is the user's call;
   - the address domain is not a colleague domain.

   `parentId` = `inferCompany({ address, contacts })`, null when it cannot tell.
5. **Slot rule.** If `add.length + create.length > MAX_TARGETS - targets.length`,
   skip entirely. Never pick a subset. That is the same rule the proposal block
   applies, and a subset is exactly the guess "clear cases only" rules out.
6. Both lists empty: skip.

Attendees that fail rule 4 are not lost. They still appear in the proposal block
the next time the picker opens, as today.

## Executing the plan: `useCalendarAutoSelect`

`src/hooks/useCalendarAutoSelect.ts`, mounted in `<Completion />` beside
`useCalendarProposal`. Inputs: the contact cache rows, `targetsRef`, and
`useOdooTarget`'s `addTarget` and `onCreateContact` — the same handlers the
confirm block and the create form call, so the hook-owned `targets` list, the
picker and the "Logging to" box stay in step with the database.

On `meetingCaptureStarted`:

1. If a run is already in flight, ignore the event (a ref, set synchronously,
   released in a `finally` so a run that throws cannot block later meetings).
2. Read the setting. Off: stop.
3. Contacts `null` (cache not ready) or empty: stop. Without this, every
   attendee comes back `no-contact`, `similarContacts` has nothing to compare
   against, and every named outside attendee would be created. The cache is
   also stale after an Odoo instance change: `handleInstanceChanged` leaves the
   contact rows of the OUTGOING instance in place until the resync resolves
   (`src/types/calendar.ts`, `CalendarProposalState` `idle` doc). The hook
   listens to `odoo-instance-changed` (same listener as `useCalendarProposal`)
   and treats the cache as stale until the `contacts` array reference changes;
   stale: stop.
4. Record the run's generation (a counter the hook bumps on
   `newConversationStarted` and on `odoo-instance-changed`).
5. Fetch with the shared `fetchCurrentMeetings()` (below). Any error: stop.
6. `planAutoSelect`. `skip`: stop.
7. Write **sequentially** (`for...of` with `await`, never `Promise.all` —
   `addSelectedTarget` is a non-atomic check-then-act, see the 2026-09-01 spec's
   "The write"). Before every write, if the generation changed (the user hit
   Clear, a new chat started, the instance changed), stop: the targets now
   belong to a different conversation.
   - each `add` contact: `addTarget({ model: "res.partner", resId, name })`;
   - each `create`: `onCreateContact(participant, { name, parentId })`. On
     `created` or `adopted-active`, `addTarget` the returned contact. Every
     other outcome (`adopted-archived`, `created-invisible`, `cached-failed`,
     `failed`, `abandoned`, `busy`) skips that attendee and continues.
   - Stop at the first `addTarget` that returns `{ ok: false }`, whatever the
     reason (`cap`, or an error with no reason). Continuing would repeat the
     same failure, and its toast, for every remaining attendee.

Matched contacts are added before any create, so an Odoo failure on a create
cannot cost the matches that needed no Odoo write.

A second run racing the first cannot duplicate: the in-flight ref drops it, an
added target is excluded by plan rule 3 on any later run, and `createOrAdoptContact`
adopts by exact email live in Odoo.

## Changes to existing code

### `useCompletion` — the rollover effect

The effect at the capture edge becomes:

- rising edge only, as today;
- if history is non-empty and the gap rule fires, `await startNewConversation()`;
- then, if the conversation has no meeting (condition 3 under "When it runs"),
  dispatch `meetingCaptureStarted`.

Today the effect returns early on an empty history; that early return must not
also skip the dispatch, since an empty conversation is the commonest fresh case.
The rollover decision itself (gap measured from the last meeting line) is
unchanged.

### `useOdooTarget.addTarget` — wait for an in-flight clear

`handleNewChat` empties the UI list synchronously, then deletes from the
database in a detached async block (`clearTargets(instance)`). An `addTarget`
whose upsert lands before that delete is wiped by it. Auto-select hits this
every time a rollover runs, and a manual pick made right after a new chat can
hit it today.

`handleNewChat` stores its clear promise in a ref; `addTarget` awaits that ref
before its own write. Fixed in the shared function, so every caller is covered.
The ref holds the whole detached `async` block, which already catches its own
errors, so it never rejects: the clear's error path (toast) is unchanged, and
the superseded-token early return (`if (token !== selectionToken.current)
return;`) resolves it too. The ref starts as a resolved promise so an
`addTarget` before any new chat does not wait.

### `useCalendarProposal` — share the fetch

The config load plus the `graph_current_meetings` invoke inside `fetchNow`
moves to `fetchCurrentMeetings()` in `src/lib/calendar/`, returning
`{ events, ownAddress }` or a typed failure (`absent` config, or a
`GraphErrorCode`). `fetchNow` keeps its generation guard and state mapping and
calls the shared function. Same ±15-minute `QUERY_WINDOW_MS`.

## Visibility

No new UI beyond the setting. The picker trigger already names the selected
targets, and the meeting-log strip's 30-second hold still offers Cancel before
anything posts. Auto-select adds no messages of its own: a skipped or failed
run leaves exactly today's behaviour, and the confirm block is still there when
the picker opens. The handlers it reuses keep their existing error toasts
(`addTarget` on a write error, after which the run stops; `onCreateContact` on
`cached-failed`, after which it moves to the next attendee). (Console logging
would not help: release builds have no visible console.)

## Limits, accepted

- **Own address.** The exclusion is best effort (UPN vs SMTP, per the 2026-09-01
  spec). The colleague-domain rule now covers both adds and creates, so the
  user's own record is only auto-added when its address is on a domain that is
  not a colleague domain (for example a personal free-mail address) and the
  claim does not match it.
- **UPN domain ≠ mail domain.** `ownAddress` comes from the ID token's
  `preferred_username`/`upn`. In a tenant where that domain differs from the
  mail domain (e.g. `corp.onmicrosoft.com` vs `corp.com`) and no coworker is
  flagged colleague, coworkers, the user included (the claim no longer
  excludes their SMTP row), are added when they have a partner record and
  created when they do not. Flagging
  any one coworker as colleague puts the mail domain on the colleague list and
  stops it.
- **Early start.** Capture started more than `EARLY_JOIN_MS` (5 min) before the
  event finds no meeting, and there is no retry.
- **Cache not ready.** Capture that starts before the contact cache is ready
  (auto-record at app launch) or during an instance resync is skipped, with no
  retry.
- **Grace windows.** `pickCurrentMeeting` also counts events that ended within
  the last 10 minutes or start within the next 5. A meeting that ran over, or an
  adjacent event, makes the result `several`, and the run skips.
- **Back-to-back meetings** inside the 30-minute window share a conversation, so
  the second one is skipped by condition 3 under "When it runs".

## Testing

- `src/tests/calendar-auto-select.test.ts` — `planAutoSelect`, table-driven, one
  case per rule: none/several meetings, already-targeted match, archived
  unmatched, blank name, name equal to address, similar-name contact,
  own-domain and colleague-domain attendee, free-mail colleague not blocking,
  slot overflow skipping everything, exact fit, inferred and blank company,
  a matched contact on a colleague domain not added.
- `fetchCurrentMeetings` — `ok`, `absent` config, and a Graph error mapped to
  its `GraphErrorCode`. The existing `useCalendarProposal` tests pass unchanged
  after the refactor.
- `useCalendarAutoSelect` — mocked `invoke` and handlers: no event, no run;
  setting `"false"`, no fetch; contacts `null` or empty, no fetch; stale cache
  after `odoo-instance-changed`, no fetch; Graph error, no writes; writes are
  sequential (a parked first `addTarget` holds the second); every `add` is
  written before the first `onCreateContact`; one row per create outcome with
  the expected call (`created` and `adopted-active` → `addTarget`; the other
  six → no `addTarget`, loop continues); `{ ok: false }` from `addTarget` (with
  `reason: "cap"`, and with no reason) stops the loop, including during the
  create phase; `newConversationStarted` during a parked write stops the loop
  before the next write; an event during a run is ignored; an event after a
  completed run, and after a run that threw, is processed.
- Setting — missing key, `"true"` and any other value read as on; only
  `"false"` reads as off. The `/odoo` page Switch writes the key.
- Wiring — `<Completion />` mounts `useCalendarAutoSelect`, in the style of
  `src/tests/completion-calendar-wiring.test.tsx` (a mutant that deletes the
  mount must fail it).
- `useCompletion` — drive the capture edge by flipping `meetingAssistMode` /
  `enableVAD` after mount. Event fires on a fresh capture with an empty history
  (today's early return); fires only after a rollover's `startNewConversation`
  has finished (window events arrive in the order `newConversationStarted`,
  then `meetingCaptureStarted` — `startNewConversation` dispatches the former
  as its last statement, after the flush), with a NON-EMPTY `meetingTranscript`
  left from the earlier meeting; does not fire when history holds an
  `audioSource` line. (Capture cannot be active at mount: `enableVAD` always
  starts `false`.)
- `useOdooTarget` — an `addTarget` issued while `handleNewChat`'s clear is
  parked survives the clear: assert `clearTargets` runs before
  `addSelectedTarget` (or check the database rows), not the in-memory
  `targets` list, which passes on today's code. Must fail on today's code. Also:
  a rejecting `clearTargets` still lets `addTarget` write; a second
  `handleNewChat` superseding the first still lets `addTarget` resolve.
- Manual: a real Teams call with a matching Outlook event, setting on — targets
  appear without opening the picker; one attendee not in Odoo gets created; the
  setting off restores the confirm-only flow.
