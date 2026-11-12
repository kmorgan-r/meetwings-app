# Google Calendar attendees for Notion meeting notes

Status: design, awaiting approval (2026-11-12)
Owner: Kevin Morgan-Rothschild
Builds on: `2026-11-11-notion-meeting-notes-design.md` (PR #91), section 11 item 1.
Mirrors: `2026-09-01-calendar-target-proposal-design.md` (Outlook, PR #51) and
`2026-10-15-calendar-auto-select-design.md` (PR #87, #89).
Follow-ups, each its own issue and its own design: #92 attendees in Odoo notes, #94 pick between
overlapping meetings, #95 Google Meet detection. (#93, Outlook guests to Notion, was closed: Kevin does
not want Outlook calls in Notion.)

Code references are against `origin/main` at `eed2258`.

## 1. Why

IC teammates send meeting notes to Notion (PR #91), but the page never says who was in the meeting,
and the summary model cannot tell the IC team from outside people. IC runs on Google Workspace, so
the Outlook integration does not help them.

Two things are wanted:

1. **Who was there.** Each meeting's guests, marked **internal** (same organisation as the user) or
   **external**, fed into the AI summary and shown on the Notion page.
2. **One page per meeting, exactly.** When several teammates record the same call, Notion gets one
   page. PR #91 already does this with a time-overlap check plus an AI judge. The calendar event makes
   it exact, and a duplicate recording should be caught before its AI summary is paid for.

Users:
- **IC teammates.** Notion only, no Odoo. Many on Mac, Google Meet in a browser.
- **Kevin.** Windows. Outlook for Odoo meetings, Google (IC account) for IC meetings, **both connected
  at once**.

## 2. Goals, non-goals, anti-goals

Goals
- A user connects their own Google calendar with read-only access.
- When recording starts, Meetwings reads the current Google meeting by the same rules Outlook uses
  today, and saves its guest list with the conversation.
- The Notion summary gets the guest list, split internal/external, and the page shows it.
- Team Practices come from the IC team, not from external guests' suggestions.
- Each Notion page stores the meeting's calendar key. A teammate whose meeting already has a page
  skips before any AI call. Racing creates settle by key, with no AI judge.
- On Kevin's machine, a current Google meeting at recording start ticks Notion in the overlay picker,
  unless Outlook has a meeting too (8.3).
- Outlook and Google connect independently, and neither can stop a recording or the other's
  connection. On Kevin's machine the Notion tick deliberately depends on both (8.3).

Non-goals (this project; issues exist for the first three)
- Google Meet detection (#95).
- Attendees in Odoo notes (#92).
- Choosing between two meetings that overlap the recording start (#94).
- Writing to Google Calendar in any way.
- Telling apart voices on the far end. The transcript still says "Guest".

Anti-goals: Kevin's words.
- **"I don't want Outlook calls going to Notion."** An automatic tick needs a Google meeting and no
  Outlook meeting, and it covers only the Google event's time (8.3). Every uncertain case resolves
  toward not sending. 8.3 names the cases nothing can see (calls on no calendar at all).

The four from the Notion design (section 2 there) apply unchanged, and the first two bind this project
hardest:
1. A meeting isn't transcribed because of an app bug. **The calendar read must never delay, block or
   fail a recording.** It runs after capture has started, in the background, and any failure means
   "no attendees", nothing more.
2. The app freezes.
3. Teammates struggle to set up the integrations.
4. A meeting's transcript is lost because the app didn't record it.

## 3. How it works today (Outlook), and what this mirrors

So the builder can check the mirror is faithful:

- **Read time.** `useCompletion` dispatches `meetingCaptureStarted` at the capture rising edge, after
  an awaited rollover, and only when the conversation has no meeting line yet
  (`useCompletion.ts:1569-1581`). `useCalendarAutoSelect` listens and calls
  `fetchCurrentMeetings()` (`src/lib/calendar/fetch-current-meetings.ts`). The picker's proposal
  block does a second read when the picker opens.
- **Query.** ±15 minutes around now (`QUERY_WINDOW_MS`).
- **Which event.** `pickCurrentMeeting` (`src/lib/calendar/current-meeting.ts`): drops cancelled,
  all-day, declined and solo events (`participantsOf(event).length < 2`), and keeps events starting
  within 5 minutes or ended under 10 minutes ago. Exactly one → `one`. More → `several`, and
  auto-select skips. It never guesses.
- **Internal.** "Colleague domains" in `auto-select.ts`: domain of `ownAddress`, plus `isColleague`
  contact domains, minus free-mail (`FREE_MAIL`, `domainOf` in `similar-contacts.ts`).
- **Stored.** Nothing. The proposal lives in React state.
- **Credentials.** `src-tauri/src/graph/`: PKCE, loopback listener on an ephemeral port, state and
  nonce checked, refresh token in the OS keychain via `keyring` with a session-only fallback, typed
  `GRAPH_*` error codes, and a cargo test that fails if a listed return struct gains a credential
  field. The list is kept by hand (`graph/mod.rs:863-869`): a new command's return type is covered
  only once someone adds it.
- **Setup.** Calendar card on `/odoo`. Each user pastes their own Azure app client ID. Notion-only
  users see it only behind "Show other integrations".

## 4. Decided in conversation (Kevin, 2026-11-12)

- Google side **never** touches Odoo contacts.
- Internal vs external is tracked and fed to the Notion summaries.
- Several internal teammates recording one meeting produce **one** Notion upload.
- The summary uses the split like this: an Attendees block (IC team, then external people grouped by
  company), action items name an owner where the transcript makes it clear, and Team Practices come
  only from the IC team.
- Same read moment and same event rules as Outlook. **Two meetings at once → no attendees**, not a
  guess.
- On Kevin's machine, a current Google meeting ticks Notion, **but Outlook calls never go to Notion**.
  So there's no tick when Outlook also has a meeting, and a second Outlook check runs at meeting end
  (8.3). An IC meeting that is also on his Outlook calendar is ticked by hand.
- Each teammate connects their own Google account to **one shared Google app** that Kevin creates in
  IC's Google Cloud org (Kevin has access and the gcloud CLI).
- The four out-of-scope items are important and tracked as #92-#95.

## 5. Google sign-in

### 5.1 The Google app (one per organisation, made once)

Made by someone with an IC Workspace account. Kevin will do it.

1. `gcloud projects create <id> --organization=<IC org id>`
2. `gcloud services enable calendar-json.googleapis.com --project=<id>`
3. Cloud Console → Google Auth Platform → Audience: **Internal**. Scopes: `openid`, `email`,
   `https://www.googleapis.com/auth/calendar.events.readonly`.
4. Clients → Create client → **Desktop app**. This yields a Client ID and a Client secret.

Steps 3 and 4 are console-only: gcloud has no command for standard OAuth clients. **Internal** is what
makes this cheap: no Google verification, only IC Workspace accounts can sign in, and refresh tokens
don't expire after 7 days as they do for unverified External apps in testing mode.

If IC's Workspace admin restricts third-party apps, the app also needs marking as trusted in the Admin
console (Security → API controls).

*My call:* these steps go in `docs/google-calendar-setup.md` (force-added, since `docs/` is ignored),
and the settings card links to it.

### 5.2 What a teammate enters

*My call* (Kevin may override with "built-in"): **pasted**, like Outlook. The card has Client ID and
Client secret fields. Kevin sends both values to teammates once. Reason: it matches Outlook, works for
any organisation, and keeps IC's values out of a public repo that non-IC users also build.

Google's desktop flow treats the client secret as non-confidential: every installed copy carries it,
and the token endpoint still requires it alongside PKCE. Store it with the client ID in secure storage,
as `graph-config.storage.ts` stores the Graph config, never in plain localStorage.

### 5.3 The flow

Mirror `src-tauri/src/graph/` in a sibling module, with commands `google_connect`, `google_disconnect`,
`google_status` and `google_current_meetings`. **Reuse, don't copy,** the provider-neutral parts of
`graph/auth.rs` (loopback listener, PKCE, random tokens, state check, nonce check), the listener's
`ListenerGuard` (it lives in `graph/mod.rs:653`, not `auth.rs`) and `graph/keychain.rs`. They are not
neutral as they stand: `auth.rs` returns `GRAPH_*` strings (`graph/mod.rs:62-70`) and `keychain.rs`
hard-codes `SERVICE`/`ACCOUNT` (`keychain.rs:15-16`). The shared parts take the keychain service name
as a parameter and return provider-neutral errors that each module maps to its own codes, so no
`GRAPH_*` code ever reaches the Google UI. How to share them is otherwise the builder's call.

Google specifics:
- Authorize: `https://accounts.google.com/o/oauth2/v2/auth` with `access_type=offline` and
  `prompt=consent`, or Google returns no refresh token. Loopback redirect `http://127.0.0.1:<port>`;
  Desktop clients accept any port.
- Token: `https://oauth2.googleapis.com/token`, with the code, verifier and client secret.
- Own address: the ID token's `email` claim, validated with the nonce. Google gives the real address,
  so the UPN-vs-SMTP limit Outlook has does not apply.
- Error codes: a `GOOGLE_*` set shaped like `GraphErrorCode`, fixed user copy, and response bodies are
  never read into logs or UI (PR #91's rule).
- The Google commands' return types are added by hand to the credential-field cargo test's list.
  Nothing adds them automatically.
- Disconnect forgets the refresh token and clears memory, as Graph does. *My call:* no revoke call to
  Google. Revoking is a network step that can fail, and the user can revoke from their Google account.

### 5.4 The settings card

A **Google Calendar** card on `/odoo`, directly under `NotionSettingsCard`. It is **visible to
Notion-only users**, not behind "Show other integrations"; the Outlook card stays where it is.
Contents: Client ID, Client secret, Connect, Disconnect when connected, a status line, the
session-only note when it applies, and the setup link. *My call:* no on/off switch. Google never writes
to Odoo, so the risk the Outlook switch guards against isn't present, and Notion stays untickable per
meeting.

Connect and disconnect broadcast an event the overlay listens for, as
`notifyCalendarConnectionChanged` does for Graph.

## 6. Reading the meeting

### 6.1 When

On the same `meetingCaptureStarted` event, a second listener beside `useCalendarAutoSelect` (or a
shared one; builder's call) reads Google. It runs in parallel with the Outlook read and is independent
of it: either calendar may be absent, failing or slow.

It must not be able to affect capture (anti-goal 1). Fire and forget, never awaited by anything on the
recording path, with any error swallowed into "no attendees". A generation guard like auto-select's
(bumped on `newConversationStarted`) drops a result that resolves after the conversation changed.

The event fires at **every** capture rising edge until the conversation has a meeting line
(`useCompletion.ts:1580-1581`), so toggling capture before anyone speaks starts several reads. The
**newest read wins**: each read takes its own generation, and a newer read replaces any pending result,
never first-wins (auto-select's `inFlight` drop, `useCalendarAutoSelect.ts:89`, would keep the older).

### 6.2 Which event

`google_current_meetings` returns events normalized by Rust into the existing `CalendarEvent` shape,
so `pickCurrentMeeting` and `participantsOf` are reused unchanged:

| `CalendarEvent` | from Google `events.list` on `primary`, `singleEvents=true`, ±15 min |
|---|---|
| `id` | the **meeting key** (6.4), not Google's per-calendar `id` |
| `subject` | `summary` |
| `startMs`/`endMs` | `start.dateTime`/`end.dateTime`, RFC 3339 with offset, to epoch ms in Rust |
| `isAllDay` | `start.date` present and `start.dateTime` absent |
| `isCancelled` | `status == "cancelled"` |
| `ownResponse` | the attendee with `self: true`, its `responseStatus`; the organizer with no attendee row → `"accepted"`; neither → `"needsAction"` (never `"declined"`, so the event stays a candidate) |
| `participants` | `organizer` (flagged) plus `attendees[]`; `resource: true` → type `"resource"`, `optional: true` → `"optional"`; each guest's `responseStatus` → the new `response` field |

Google's `"declined"` is the same string `isDeclined` compares, lowercased.

`CalendarParticipant` (TS `src/types/calendar.ts:35-45`, Rust `graph/mod.rs:18-26`) has no per-guest
response today. It gains an optional `response` (string or null). Google fills it. Graph leaves it null,
so Outlook behaviour is unchanged. `pickCurrentMeeting` still sees declined guests, so its solo rule is
unchanged. Declined guests are dropped only when the snapshot is built (6.3).

`pickCurrentMeeting(events, now)`: `one` → snapshot it. `none` or `several` → no snapshot (#94 covers
`several`).

### 6.3 What is saved

A **calendar snapshot** per conversation: the meeting key, subject, start, end, the user's own address,
and the participants (resources dropped, deduped by `participantsOf`, declined guests dropped).
Internal/external is **derived at use**, not stored: a participant is internal when their domain equals
the own address's domain, and the own address's domain counts only when it is not free-mail (reuse
`domainOf`, `FREE_MAIL`). The user themself is internal.

**A snapshot belongs to its event's time window, not to the whole conversation.** The capture-start
event only fires while the conversation has no meeting line (6.1), so in practice it is read for the
conversation's first meeting. A conversation can still hold several meetings: Meeting Assist left on,
or a back-to-back call inside the 30-minute gap. `joinSets` (`join.ts:16-31`) and the manual send
(`actions.ts:70-91`) may split such a conversation into several sends, or join two back-to-back
meetings into one.

**The inside-the-event rule.** A span (a send's, or in 8.3 a meeting-end row's) counts as inside the
event when it shares **at least half of its own length** with the event. A snapshot applies to a send
only when the send is inside the event. Any other send in that conversation has no snapshot and runs
exactly as today. Without this rule, the later meeting's send would match the earlier page by key and
finish `already` with no page of its own. That would be a new way to lose a meeting.

This is **not** `overlapEnough` (`same-meeting.ts:58-67`), which measures against the shorter span: a
joined send 10:00-11:30 over an event 10:00-10:30 shares all 30 minutes of the shorter span and would
pass, then key-match a teammate's 10:00-10:30 page and finish `already` with no summary, losing the
10:35 meeting. Under this rule it shares 30 of its own 90 minutes, gets no snapshot, and runs as
today. A late joiner (10:20-10:30 of that event) is still inside. *Accepted cost:* a back-to-back
meeting joined onto the end of the event and no longer than it (event 10:00-11:00, send 10:00-11:30)
still passes, as it would pass today's AI judge on overlap.

Constraints on where it lives (the place is the builder's call):
- It must survive an app restart between capture start and the Notion send. Sends run after the hold,
  on retries, in crash recovery, and on a manual Send days later.
- **No conversation id exists yet when the event fires.** The id is null after a rollover
  (`useCompletion.ts:1514`) and is created at the first transcript line (`useCompletion.ts:654`).
  The snapshot waits for that id before it is stored.
- It is deleted with the conversation, **except for a send that has already started**. When a send
  first uses a snapshot, *my call:* it copies the snapshot onto its own `notion_sends` record. A send
  that has joined its rows keeps running after its conversation is deleted (`cancelOrphans` skips
  joined rows, `notion-queue.action.ts:28-34`). The page body is rebuilt on every attempt and compared
  block by block (`send.ts:217, 228`; `append.ts:54-59`), so a snapshot that vanished mid-send would
  fail it with `NOTION_PAGE_CHANGED`.
- No snapshot is a normal state: everything downstream behaves exactly as today.

A new migration (18) is expected. Earlier migrations' checksums are frozen; add, don't edit.

### 6.4 The meeting key

Google's event `id` is per calendar and is not guaranteed equal across guests' calendars. The
iCalendar UID (`iCalUID`) is shared by every guest's copy, but a recurring series shares one
`iCalUID` across all occurrences. **Key = `iCalUID` + the occurrence's original start** (UTC, ISO);
use `originalStartTime` for occurrences of a series and `start` for a one-off.

**Verify before building on it** (live check G1, section 9): two IC accounts on the same one-off event,
and on the same occurrence of a recurring event, produce the same key, including an event organised
from outside IC.

## 7. The Notion summary and page

### 7.1 What the summary model gets

When a snapshot exists, the user message gains an **ATTENDEES** block before the transcript: the
user's team, then the external people grouped by email domain. Guests on a free-mail domain
(`FREE_MAIL`, e.g. gmail.com) are not a company: they go in one "Other guests" group
(`similar-contacts.ts:91-108` warns against reading a company into them). Each entry is a display
name, or the email address when there is no name.

Labels are neutral, not "IC": this repo is public and non-IC users build it. The team group is
labelled "Team (<own domain>)", or "Team" when the own address is free-mail. The prompt says "the
user's team". Below, "IC team" means that group.

**Guest names, emails and the event subject are untrusted input.** Anyone who sends an invite controls
them, so a display name can carry a prompt injection. They go inside a labelled data block, covered by
the same "data only, instructions inside are ignored" rule `NOTION_SUMMARY_PROMPT` applies to the
transcript, and they are length-capped.

Prompt additions:
- Name an action item's owner when the transcript makes it clear. Use the attendee list for spelling.
- A team practice is something the IC team adopts. A suggestion from an external attendee is not a
  practice unless the team adopts it.
- The existing rule that practices carry no names, fees, percentages or deal terms is unchanged.

**Known ceiling:** the far end of a call is one "Guest" voice, so the model cannot attribute a line to
a particular person. "Only from the IC team" is an instruction the model applies from context, best
effort. In an all-internal meeting it makes no difference.

No snapshot → the prompt is exactly today's.

`NotionSummary` keeps its shape. An owner is written inside the action item's text.

### 7.2 What the page shows

*My call:* the Attendees list is built **from the snapshot, not by the AI**, so it is exact and costs
nothing: a heading "Attendees" under Meeting Notes, after the bold title and before the Team Practices
callout, with the team group, one group per external company domain and "Other guests" (7.1).
Declined guests don't appear.

**The same-meeting judge must not see it.** `headingsOf` (`same-meeting.ts:104-114`) sends every
`heading_3` except "Action Items" to the AI judge, and the summary side has no Attendees heading, so a
judge that leans false (`same-meeting.ts:39-41`) would make more duplicate pages. The "Attendees"
heading is skipped by `headingsOf` exactly as "Action Items" is, and the group labels are not headings
(bold paragraphs or list items), so nothing in the block reaches the judge.

The label says it comes from the invite (e.g. "From the calendar invite"). The calendar knows who was
invited, not who joined.

Names on meeting pages are allowed (Notion design, section 3.3). Team Knowledge rows still never carry
names; the knowledge path is unchanged.

## 8. One page per meeting

### 8.1 The new column

Each of the three meeting sub-tables gets a text property, *my call* named **"Calendar event"**. Kevin
adds it once. Notion **Check** reports a sub-table missing it, or carrying it with a type other than
`rich_text`, as a warning, not a failure. The decision is **per sub-table**, like the existing optional
people column (`page-blocks.ts:198-200`): the key is queried and written only in sub-tables where the
property exists as `rich_text`. Filtering on or writing a property a sub-table lacks makes Notion reject
the request, so a sub-table without it works exactly as today, minus the exact match. A page created
when the snapshot has a key writes the key into that property.

### 8.2 The send, changed

Against `runNotionSend` (`src/lib/notion/send.ts`), when the send has a snapshot key, in each sub-table
that carries the column (8.1):

A **key match** means both conditions hold: the page's Calendar event equals the key, **and** the
page's date range passes `overlapEnough` with the send's span. The key alone is never enough.

1. **Pre-check, before the summary.** It runs only on a send that has never started a create
   (`create_started_at` null). A send resuming after a lost create response needs today's own-page
   recovery first. That recovery (`isThisSendsPage`, `send.ts:186-192`) needs `summary.title`, so
   before the summary the send cannot recognise its own page, and a pre-check would make it lose to
   itself. The pre-check queries every sub-table for a non-trashed page that key-matches. Found →
   `lost_to_url` = that page, finish `already`. **No summary call.** This needs the sub-table mapping
   (today step 3) to run before the summary (today step 1); the builder reorders the steps without
   breaking resumability.
2. **Find (step 4).** Of the time-overlap candidates: a key match → `already`, no AI. Anything else
   (a different key, or none) → today's AI judge.
3. **Create.** Writes the key.
4. **Recheck (step 6).** A key match → a rival, no AI. Anything else → today's AI judge. The earliest
   `created_time` wins, ties to the lowest page ID, and a loser trashes its own page: `pickWinner`
   unchanged.

*My call:* a **different** key falls back to the AI judge, never to "different meeting". The key adds
exact matches and never removes one today's check would make. If G1 (section 9) shows the key is
unstable for some kind of event, the result is fewer exact matches, never a duplicate page today's
judge would have caught. So section 8 can be planned before G1 runs.

Without a key (no Google, no current event, or two at once) every step is exactly today's. A teammate
with no Google is still caught: their page has no key, so the other side's overlap + AI check finds it.

Kept from PR #91: whoever finishes first wins, even if another recording is longer.

### 8.3 Kevin's machine: Notion ticked

This applies when both Odoo and Notion are set up. The binding rule is Kevin's: **Outlook calls never
go to Notion** unless he ticks Notion by hand. The Notion spec's promise (section 6 there) is the same:
pre-pick only for meetings on his IC Google calendar.

**The tick remembers who set it.** `useNotionPick` gains an automatic set, plus a persisted source
(`auto` or `hand`) next to `NOTION_PICKED`. Today the hook has only `toggle` and `clear`. Any toggle by
Kevin makes the source `hand`. Clearing works as today: wherever the Odoo targets are cleared.
- **One write for both.** The hook's `set` (`useNotionPick.ts:17-19`) writes the ref before
  `setState` so a same-tick trigger sees the new value. It becomes `set(next, source)`, writing the
  pick ref and a source ref together, then state and both localStorage keys. `useMeetingLog`'s
  `trigger` snapshots pick and source together in its synchronous snapshot (`useMeetingLog.ts:320-327`).
- **Missing source.** A stored `NOTION_PICKED === "true"` with no source key (written before this
  change) reads as `hand`, so an upgrade never subjects an existing hand tick to the checks below.
- **The automatic set never overrides Kevin.** It only turns an unticked Notion on. It is a no-op when
  Notion is already ticked, and a no-op when Kevin toggled or cleared after check 1 began (a hand-touch
  counter captured at the event). Its generation guard bumps on `newConversationStarted` **and**
  `odooTargetsCleared`, as auto-select's does (`useCalendarAutoSelect.ts:54-63`).

**Outlook's state, for both checks.** "Outlook absent" means `loadGraphConfigState()` returns
`absent` (`fetchCurrentMeetings` → `absent`), which includes a stored config whose client ID is blank
(`graph-config.storage.ts:55-58`): a half-finished setup has no calendar to read. A config with a
client ID whose read fails for any reason, including `GRAPH_NOT_CONNECTED` and `GRAPH_AUTH_EXPIRED`,
counts as an **error**, and an error never allows Notion. If Kevin disconnects or lets Outlook expire,
nothing is ticked automatically until it's back.

**Check 1, at recording start.** On `meetingCaptureStarted` the Google read and **its own Outlook
read** run. It cannot reuse auto-select's read: `useCalendarAutoSelect` returns before fetching when
its setting is off or the contact cache is empty or stale. "No read happened" is not `none`. Notion is
ticked automatically only when:
- Google returns `one`, **and**
- Outlook is absent, or its read returns `none`.

Outlook `one` or `several`, or an Outlook error, means no tick. The rule is a pure function with unit
tests. The tick lands after the rollover (the event fires after `await startNewConversation()`),
behind the same generation guard as 6.1.

**The automatic tick only covers the Google event's time.** The tick lasts the whole conversation, but
an `auto` tick counts for a meeting-end row only when that row is inside the saved Google event (6.3's
inside-the-event rule: at least half of the row's own length). An `auto` tick with no saved Google event
(the snapshot was never stored) covers no row. A later row in the same conversation, mostly outside the
IC event's time, isn't sent even when Outlook can't see it (an ad-hoc call). A single row that holds the
IC call and then an ad-hoc call is sent when the ad-hoc part is no longer than the IC part: no overlap
rule can tell that from an IC meeting running over (see Accepted costs).

**Check 2, when a meeting-end row is written.** A row is written per trigger: the detector's
`meeting-ended`, the pill turning off, or the idle flush (`useMeetingLog.ts:504, 528, 569`).
Detection can flap into several rows per call. For each row with an `auto` tick and Outlook not
absent, Meetwings reads Outlook once more for that row's span. If any event overlaps the span at all,
the row's pick goes to `decideDestinations` as **false**. The events counted are those passing
`pickCurrentMeeting`'s filters: not cancelled, not all-day, not declined, not solo. The same happens
if the read errors or doesn't answer within a short timeout (*my call:* 5 seconds). Check 2 catches
what the window rule can't: one long row that runs from the IC call straight into a client call.
- `isCandidate` (`current-meeting.ts:30-40`) bundles those filters with the now-relative window.
  Split the filters out so the span check reuses them without the window.
- The span read reuses `graph_current_meetings` with the row's span as its window.
- **Timing inside `trigger`.** Check 2 runs after `trigger`'s synchronous snapshot (transcript,
  targets, pick, source and conversation id are all read before any await, `useMeetingLog.ts:320-327`)
  and before `decideDestinations`. Only the read's result is applied after the await, so a toggle or
  rollover during the check cannot change what is enqueued. The check lengthens the in-flight window,
  and a trigger arriving while one is in flight is dropped today (`useMeetingLog.ts:318`). So a trigger
  dropped while a check runs is re-run once when the in-flight one finishes (a pending flag); otherwise
  a pill-off during the check would leave the meeting's tail to startup recovery.
- A `hand` tick skips both the window rule and check 2. Kevin chose it explicitly.
- Where a row that wasn't sent ends up: its conversation row on the Meetings page offers **Send to
  Notion** (`ConversationRow.tsx:350-354`), which accepts rows whose Notion status is null or offered
  (`actions.ts:58-66`). That button returns "already" once any row of the conversation has a Notion
  page. It sends **every** unsent row of the conversation, including rows the window rule or check 2
  withheld, so pressing it on a conversation that also held an Outlook call sends that call too.
  Accepted: pressing it is Kevin's hand choice for the whole conversation.
- **Ceiling, per row.** Each row is decided on its own, and detection flaps into several rows per call.
  Rows of an IC call can be withheld with no failure at all: an edge row wholly or mostly before the
  event's start (early-join chatter) or after its end (the meeting running over), since the window rule
  does not pad the event. A check 2 read failure on one row withholds it too. Either way that part is
  left off the Notion page, and since the conversation then counts as "already" sent, the button can't
  add it later. The transcript stays complete on Kevin's machine. Accepted: padding the event would
  widen the ad-hoc-call leak above, and every uncertain case resolves toward not sending.
- **Outlook token streak.** Graph forgets its credential after 3 consecutive `invalid_grant` responses
  (`graph/mod.rs:72-90`), sized for one read per picker open. Check 1's own read and one check 2 read
  per row can reach 3 within one meeting, so a dead Outlook credential moves from "reconnect" to "not
  connected" sooner. Accepted: both states already mean "no automatic Notion tick", and reconnecting
  fixes both.
- Crash safety: if the app dies during the check, the meeting is recovered by the existing recovery
  path, and recovery never auto-sends to Notion (`decideDestinations`, `source: "recovery"`). That is
  the safe direction.
- The Odoo lane's hold starts at most the timeout later. *My call:* checking before the enqueue is
  simpler than checking during the hold. During the hold, a crash would need new recovery state to stop
  a held Notion row from being promoted unchecked (`useMeetingLog.ts:251`).

`decideDestinations` is unchanged: a ticked pick still gives `notionStatus: "held"`. Notion-only users
are unaffected: they have no Outlook, and their meetings already go to Notion when auto-send is on.

Accepted costs:
- An IC meeting that also sits on Kevin's Outlook calendar is never ticked automatically. He ticks it
  by hand.
- Cases nothing can see, all calls that aren't on Outlook in the same conversation: one held
  **inside** the IC event's time (Kevin leaves the IC call early for an ad-hoc one), and one that
  follows the IC call in the **same row** and is no longer than the IC part (the window rule above).
  The 30-second hold and the untick are the guard.
- Edge rows of an IC call (before its start or after its end) are withheld (Ceiling, per row).

A meeting on both calendars still gets Outlook auto-select's Odoo targets, which are independent of
Notion.

## 9. Checks before rollout

Unit tests (Vitest, `src/tests`; cargo tests in the new Rust module):
- Google → `CalendarEvent` normalization: offsets, all-day, cancelled, `self` response, organizer
  without an attendee row, neither (→ `"needsAction"`), resources, optional guests, the recurring key.
- Rust: the cargo credential-field test's list includes every Google command return type; state and
  nonce mismatch are rejected; a shared helper's error never surfaces as a `GRAPH_*` code from a
  Google command; a Google error response maps to its fixed code without its body.
- The client ID and secret are saved through secure storage only, never plain localStorage.
- Internal/external derivation, including a free-mail own address; free-mail guests land in "Other
  guests"; declined guests are left out of both the prompt and the page.
- The inside-the-event rule: exactly half of the span's own length passes, just under fails; a joined
  send 10:00-11:30 over a 10:00-10:30 event gets no snapshot; a late joiner inside the event gets it.
- The snapshot: a result arriving before the conversation id exists is held, then stored; it survives
  a restart; it is deleted with the conversation when no send has started; a newer capture-start read
  replaces a pending older one.
- The send's key paths: pre-check hit makes no summary call and sets `lost_to_url`; same, different and
  absent keys in find and recheck; **same key with a non-overlapping range** (another occurrence) creates
  its own page in all three paths; a trashed key-matching page is ignored; a recheck key match settles
  by `pickWinner` and the loser trashes its own page; a sub-table without the column, or with a
  non-`rich_text` one, behaves as today and Check warns.
- The reordered send: a crash at each step, then resume, finishes correctly (mapping now runs before
  the summary).
- A conversation holding two meetings: the second send gets no snapshot and gets its own page.
- A send resuming after a lost create skips the pre-check and recovers its own page.
- Deleting the conversation mid-send leaves the send's copied snapshot, and the send finishes.
- The prompt with and without attendees, an injection inside a display name staying inside the
  data block, and the length caps at their boundary.
- The Attendees page block, and the same-meeting judge's headings for a page carrying it are the same
  as without it.
- Kevin's tick, check 1: Google `one` with Outlook absent or `none` ticks. Google `none` or
  `several` doesn't. Outlook `one`, `several` or an error doesn't. A late result after a new
  conversation is dropped.
- Kevin's tick, check 1, with Outlook config stored but `GRAPH_NOT_CONNECTED` or `GRAPH_AUTH_EXPIRED`
  → no tick. Check 1 still reads Outlook when the auto-select setting is off.
- Kevin's tick, source: any toggle sets `hand`; the automatic set does nothing when Notion is already
  ticked or Kevin toggled or cleared after check 1 began; Clear (`odooTargetsCleared`) drops a late
  check 1 result; a stored tick with no source key reads `hand`; `trigger` sees pick and source from
  one snapshot.
- Kevin's tick, window rule: an `auto` tick on a row mostly outside the Google event's time → not
  sent; an `auto` tick with no saved Google event → not sent; an edge row after the event's end → not
  sent.
- Kevin's tick, check 2: an `auto` tick with an Outlook meeting overlapping the row's span, even by a
  minute → not sent to Notion. A cancelled, all-day, declined or solo Outlook event overlapping it →
  still sent. Read error → not sent. Timeout → not sent. A `hand` tick → sent, with no Outlook read.
  Three rows of one call with mixed Outlook outcomes are each decided on their own. A second trigger
  arriving mid-check is re-run after it, and a toggle mid-check does not change the enqueued row.
- `pickCurrentMeeting` gives the same results before and after its filters are split out of
  `isCandidate`.
- `decideDestinations` with `source: "recovery"` never gives a held Notion lane.
- A Google failure or hang at capture start leaves recording untouched.

Live checks: add to `.livecheck/`, skipping cleanly without credentials, as `notion-live.live.ts` does.
- **G1** Same key from two IC accounts for a one-off, a recurring occurrence, and an externally
  organised invite.
- **G2** What `attendees[]` looks like when the organiser hid the guest list. *Expected:* only the user
  themself, so the event reads as solo and gets no snapshot. Accept, or surface; decide after seeing it.
  Also record the `organizer` of an event created on a shared or secondary calendar: if Google reports
  the calendar, not a person, a solo block reads as two people. Decide then whether to drop non-person
  organizers.
- **G3** Sign-in, refresh and disconnect on **macOS** (Keychain, browser loopback). The Outlook flow
  has only run on Windows, and most teammates are on Mac.
- PR #91's still-unrun Notion **check 5** (how long until a just-created page shows up in a query) now
  carries the exact-key recheck too. Run it before relying on the 5-second recheck.

## 10. What's left to the builder

- How `graph/auth.rs` and `keychain.rs` are shared with the Google module.
- Where the snapshot lives, within 6.3's constraints, and its migration.
- How the send steps are reordered so the pre-check runs before the summary, keeping every crash point
  resumable.
- One listener or two on `meetingCaptureStarted`.
- Exact prompt wording, the data block format and the length caps.
- Card copy and the setup doc's wording.
