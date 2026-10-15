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
   `conversationHistoryRef.current` carries an `audioSource`, **and**
   `meetingTranscript` is empty (lines not yet autosaved live only there). This
   is what makes a mid-call capture restart (detection flapping, a paused mic)
   and a back-to-back meeting inside the 30-minute window skip.

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

1. **Exactly one current meeting.** `pickCurrentMeeting(events, now)` must return
   `one`. `none` and `several` skip. Never guess between overlapping meetings.
2. **Match.** `matchAttendees` with the existing exclusions: the user's own
   address (best effort, see Limits), `isColleague` contacts, inactive contacts.
3. **Add** = `matched` contacts not already in `targets` (the existing "writable"
   rule). An already-selected match is never re-upserted — that would rewrite its
   `selected_at` and `conversation_id`.
4. **Create** = `unmatched` entries with reason `no-contact` (never `archived`:
   creating one would duplicate the archived record) where all of these hold:
   - the participant has a display name that is non-blank and is not just the
     address;
   - `similarContacts({ name, address, contacts })` is empty. A similar name is
     probably the same person under another address, which is the user's call;
   - the address domain is not a colleague domain. Colleague domains are the
     domain of `ownAddress` plus the domains of contacts with
     `isColleague === true`, with free-mail domains removed from that set (one
     colleague on gmail must not block every gmail attendee). `FREE_MAIL` in
     `similar-contacts.ts` is exported for this.

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

1. If a run is already in flight, ignore the event (a ref, set synchronously).
2. Read the setting. Off: stop.
3. Fetch with the shared `fetchCurrentMeetings()` (below). Any error: stop.
4. `planAutoSelect`. `skip`: stop.
5. Write **sequentially** (`for...of` with `await`, never `Promise.all` —
   `addSelectedTarget` is a non-atomic check-then-act, see the 2026-09-01 spec's
   "The write"):
   - each `add` contact: `addTarget({ model: "res.partner", resId, name })`;
   - each `create`: `onCreateContact(participant, { name, parentId })`. On
     `created` or `adopted-active`, `addTarget` the returned contact. Every
     other outcome (`adopted-archived`, `created-invisible`, `cached-failed`,
     `failed`, `abandoned`, `busy`) skips that attendee and continues.
   - Stop at the first `{ ok: false, reason: "cap" }`.

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
The clear's own error path (toast) is unchanged; `addTarget` waits on a promise
that never rejects (the ref holds the block's settled result).

### `useCalendarProposal` — share the fetch

The config load plus the `graph_current_meetings` invoke inside `fetchNow`
moves to `fetchCurrentMeetings()` in `src/lib/calendar/`, returning
`{ events, ownAddress }` or a typed failure (`absent` config, or a
`GraphErrorCode`). `fetchNow` keeps its generation guard and state mapping and
calls the shared function. Same ±15-minute `QUERY_WINDOW_MS`.

## Visibility

No new UI beyond the setting. The picker trigger already names the selected
targets, and the meeting-log strip's 30-second hold still offers Cancel before
anything posts. Failures are silent by design: the outcome of a failed run is
exactly today's behaviour, and the confirm block is still there when the picker
opens. (Console logging would not help: release builds have no visible
console.)

## Limits, accepted

- **Own address.** The exclusion is best effort (UPN vs SMTP, per the 2026-09-01
  spec). If the user's own partner is in Odoo, not flagged colleague, and the
  claim does not match the attendee address, the user's own record is
  auto-added. The colleague-domain rule stops the user being *created*, but not
  an existing record being *added*.
- **Early start.** Capture started more than `EARLY_JOIN_MS` (5 min) before the
  event finds no meeting, and there is no retry.
- **Back-to-back meetings** inside the 30-minute window share a conversation, so
  the second one is skipped by condition 3 under "When it runs".

## Testing

- `src/tests/calendar-auto-select.test.ts` — `planAutoSelect`, table-driven, one
  case per rule: none/several meetings, already-targeted match, archived
  unmatched, blank name, name equal to address, similar-name contact,
  own-domain and colleague-domain attendee, free-mail colleague not blocking,
  slot overflow skipping everything, exact fit, inferred and blank company.
- `useCalendarAutoSelect` — mocked `invoke` and handlers: no event, no run;
  setting `"false"`, no fetch; Graph error, no writes; writes are sequential
  (a parked first `addTarget` holds the second); a create outcome of each kind;
  a cap rejection stops the loop; an event during a run is ignored.
- `useCompletion` — event fires on a fresh capture; fires only after a rollover's
  `startNewConversation` resolves; does not fire when history holds a meeting
  line or `meetingTranscript` is non-empty.
- `useOdooTarget` — an `addTarget` issued while `handleNewChat`'s clear is
  parked survives the clear. Must fail on today's code.
- Manual: a real Teams call with a matching Outlook event, setting on — targets
  appear without opening the picker; one attendee not in Odoo gets created; the
  setting off restores the confirm-only flow.
