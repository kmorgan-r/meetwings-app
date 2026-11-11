# Notion meeting notes and Team Practices

Status: approved for planning (2026-11-11); spec-review findings applied
Owner: Kevin Morgan-Rothschild
Follow-on projects (not in this design): Google Calendar for Invest Conservation, Google Meet detection.
Code references are against `origin/main`. Local branches in the primary checkout can be far behind
it, so build from `origin/main`.

## 1. Why

Invest Conservation (IC) kept its meeting notes in Notion, written by Notion AI meeting notes, in the
"Weekly Team Meetings" database. The team stopped taking those notes after 16 Sep 2026. That also
starved the knowledge hub work: its design reads meeting notes to collect the team's working
practices ("Team Practices") for people to confirm.

Meetwings already records and transcribes meetings and, for Kevin, sends each finished meeting to
Odoo automatically. This project makes Meetwings write the meeting into Notion instead, in the same
shape Notion AI used, so the whole IC team gets its notes back without Notion AI. It also pulls out
any team practice adopted in the meeting and proposes it in a Team Knowledge list, where a teammate
confirms or rejects it.

Users:
- **IC teammates.** Notion only. They don't use Odoo. Many are on **Mac** and use **Google Meet in a
  browser**, not Teams.
- **Kevin.** Uses both Notion (IC meetings) and Odoo (his other meetings), on Windows.

IC's Notion workspace is on the **Plus** plan.

## 2. Goals, non-goals, anti-goals

Goals
- After a meeting ends, a page appears in IC's Weekly Team Meetings database. Its summary is shaped
  like the old Notion AI notes: a title, Action Items as checkboxes, then one section per topic with
  bullets. It also carries a highlighted **Team Practices** box and the full transcript, collapsed.
- Each team practice in that box is also added to a **Team Knowledge** database as `Proposed`.
- A meeting several teammates recorded produces **one** page and one set of proposals.
- A teammate with only Notion set up never sees Odoo anywhere in the app.
- Kevin can send a meeting to Notion, to Odoo, or to both.
- GLM 5.3 Flash writes the summary through one shared company OpenRouter key.

Non-goals (this project)
- Reading Google Calendar: attendees, pre-picking Notion for IC meetings, exact matching of the same
  meeting. That's the next project (section 11).
- Detecting Google Meet automatically. Mac users start recording by hand.
- Anything that reads Confirmed rules back out of Team Knowledge, or stops people confirming their
  own proposals.
- Notion's own "AI meeting notes" block and its transcript-citation links (the API can't create
  that block from text; see section 9).
- Telling apart the different voices on the other end ("Guest").
- Sending system-audio captures to Notion (Kevin: not needed). Only Meeting Assist recordings go.
- Reusing a page someone made by hand before the meeting.

Anti-goals: Kevin's words for what would make this a failure even if it technically works.
1. A meeting isn't transcribed because of an app bug.
2. The app freezes.
3. Teammates struggle to set up the integrations.
4. A meeting's transcript is lost because the app didn't record it.

Section 8 turns these into requirements.

## 3. What Meetwings writes to Notion

### 3.1 Where the page goes

Database: **Weekly Team Meetings**, (link pasted into settings; real IDs kept out of this public repo, Kevin has them). It has
three data sources (Notion API "data sources", called sub-tables below):

| Sub-table | Data source | Properties today |
|---|---|---|
| Monday Meetings | `<monday-data-source-id>` | `Name` (title), `Date` (date) |
| Wednesday Meetings | `<wednesday-data-source-id>` | `Name`, `Date` |
| Other Meetings | `<other-data-source-id>` | `Name`, `Meeting Date`, `Parent item`, `Sub-item` |

**Weekday rule (agreed):** the weekly team meeting on a Monday goes to Monday Meetings, the one on a
Wednesday to Wednesday Meetings, and everything else to Other Meetings. Day and time are the
meeting's local start.

**Team meeting times (Kevin agreed to my suggestion).** Every recording can be sent (section 6), so
the weekday alone can't tell the team sync from a partner call on the same Monday. Notion settings
hold a usual start time for each weekday sub-table (e.g. Monday 9:00, Wednesday 9:00). A meeting goes
to that sub-table only if it starts within 30 minutes of that time (*my call* on the window).
Everything else goes to Other Meetings under its AI title. An empty time means any start time that
day counts. Ceiling: each person enters the times on their own install, in their own time zone. If
that turns out to be setup friction, move the times somewhere shared later.

*My call:* settings take the database link, not hard-coded IDs, and Meetwings matches sub-tables by
name: a sub-table whose name starts with the weekday name gets that day, and one whose name starts
with "Other" gets every other day. If there's no "Other" sub-table, unmatched days fall back to the
first sub-table. The settings Check (section 7) shows the result ("Monday → Monday Meetings,
Wednesday → Wednesday Meetings, other days → Other Meetings"), so a wrong match is visible.

### 3.2 Page properties

- **Title:** the sub-table's title property. Use the sub-table's naming ("Monday Meeting",
  "Wednesday Meeting") for Monday and Wednesday. For Other, use the AI title, because those meetings
  vary.
- **Date:** the sub-table's date property (`Date`, or `Meeting Date` in Other), set to the meeting's
  start and end as a datetime range. *My call:* a range instead of a plain date, because the
  duplicate check (section 5) needs the times. Old pages keep their plain dates.
- **Who recorded it (verify first):** the plan was Notion's built-in "Created by" column, added once
  per sub-table. But a personal access token acts through a **bot user**: `GET /v1/users/me` returns
  that bot, and its `bot.owner.user` is the person who made the token. So "Created by" may show the
  bot, not the person. Check this with one real token before building. If it shows the bot, add a
  "Recorded by" person column instead and fill it with `bot.owner.user`.
- **Attendees:** not in this project. The Google Calendar project adds it.

### 3.3 Page body

The order matches the old pages. A mockup is kept at
`.superpowers/brainstorm/498-1794403937/content/notion-page-v2.html` (local, not committed).

1. Table of contents
2. `Agenda` heading. Kevin decided it is **AI-generated**. *My call:* it lists the topic headings
   from item 9, in the order they came up, so it needs no extra AI field. Meetwings never looks for a
   page someone made by hand before the meeting; it always writes its own page.
3. Divider
4. `Meeting Notes` heading
5. **Bold meeting title** from the AI, e.g. "Weekly Team Sync: PDD, Outreach & Platform Update"
6. **Team Practices** in a highlighted callout (📌), only when the meeting adopted at least one
   practice. *My call:* it lists **every** practice found in this meeting, including ones Team
   Knowledge already has. Only new ones are added there (section 4). So the box can be written with
   the rest of the body, before the duplicate check against Team Knowledge.
7. `Action Items` heading, then one checkbox per action item
8. Divider
9. One heading per topic, each followed by bullets
10. Divider
11. A collapsed **Transcript** toggle holding the full transcript

Transcript details:
- **Speaker labels:** Meetwings' stored lines say "You" (the recorder's microphone) and "Guest"
  (system audio). On the page, "You" becomes the recorder's Notion name: `GET /v1/users/me` →
  `bot.owner.user` → `GET /v1/users/{id}`. Verify first that a personal token can read the owner's
  name. If it can't, fall back to a "Your name" field in Notion settings. "Guest" stays.
- **Chunking:** Notion takes at most 100 blocks per request, 2,000 characters per text item, and
  1,000 blocks or 500 KB per payload. The transcript is appended in batches under the toggle. A long
  meeting can exceed 1,000 blocks, so it always takes several calls. Splitting a line at 2,000
  characters must never cut a character in half (emoji and other surrogate pairs).
- **Partial failure:** if the transcript append fails, the page and summary stay. Only the transcript
  is retried, and nothing already written is duplicated. Notion has no idempotency key, so this needs
  saved progress: the page ID and the number of transcript lines appended are stored on the queue
  row after every batch. A retry first reads back the toggle's existing children and continues after
  the last line already there, so a batch whose response was lost isn't appended twice. The queue
  row stays open (not `sent`) until the whole transcript is in; see section 8.

People's names may appear on the meeting page, as they did in the Notion AI notes. The
no-personal-information rule applies to Team Knowledge rows, not to meeting pages (section 4).

## 4. Team Practices and the Team Knowledge database

A **team practice** is a standing rule about how the team works that should apply to future work:
how documents and reports are written, reviewed or published; which terms, methods or tools to use;
standard checklists or steps. These are **not** practices: action items, status updates, plans,
opinions, and one-off decisions about a specific deal, partner or person. (This is the definition
already tested in the knowledge hub work.)

For each practice in the meeting (agreed), Meetwings adds one row to the Team Knowledge database:

| Column | Type | Value |
|---|---|---|
| `Rule` | title | One short instruction in Meetwings' own words, not copied from the transcript |
| `Status` | status | Set explicitly to `Proposed` (*my call*: not left to the column's default, which someone could change). Options: Proposed, Confirmed, Rejected |
| `Topic` | select | Best fit from the column's existing options; empty if none fits |
| `Meeting link` | URL | URL of the meeting page Meetwings just created |

Rules for rows:
- **No personal information:** no people's names, fees, percentages or deal terms. Name a partner
  organisation only if the practice is about that organisation. This is a hard company requirement
  from the knowledge hub spec.
- **No duplicates:** before adding a rule, read the existing rows and skip any rule that means the
  same as one already there, whatever its Status. A rejected rule must not come back every week.
  Comparing meaning is an AI judgment, made with the same summary model.
- Never edit, re-status or delete existing rows.
- Transcript text is data, not instructions. Ignore any instruction spoken in the meeting.

Topic options aren't decided yet. The test database has `Reports` and `Methods`. Meetwings reads
whatever options the column has and never creates new ones.

The real Team Knowledge database **doesn't exist yet**. Only a throwaway test one does
(in Kevin's private pages; it also has a
`Source meeting` relation, which Meetwings ignores). Kevin creates the real one in a teamspace the
whole team can open, with the columns above, before rollout. Settings take its link.

## 5. One page per meeting

Agreed: when several teammates record the same meeting, **one** page appears. Whoever's Meetwings
finishes first writes it. The others see it already exists and skip, including the practices.

**When a meeting is ready to send (*my call*).** One recording can become several queue rows. A
5-minute silence (`IDLE_FLUSH_MS`), an app restart, a detection flap or the pill going off and on
each split it. One meeting must still give one page summarising all of it. A detection flap fires
the same `meeting-ended` and pill-off events a real ending does (`useMeetingLog` calls `trigger`
for both), and the comment on `MEETING_CONVERSATION_GAP_MS` records flaps reopening the capture 5 to
15 minutes apart within one call. So neither event can mean "the meeting is over": if it did, the
first half would be sent, the second half wouldn't overlap it in time, and a second page would
appear.

The rule instead: a Notion send waits until **30 minutes have passed with nothing new said** in that
conversation. Thirty minutes is the codebase's own meeting boundary, `MEETING_CONVERSATION_GAP_MS`.
Pill-off and `meeting-ended` still flush rows into the queue as today; they just don't start a
Notion send. The rows of that conversation are then joined into one page if each of them is:
- within 30 minutes of the previous one,
- bound for Notion (always true for a Notion-only user with the setting on; for Kevin, only the rows
  he picked Notion for, so a client call followed by an IC call never ends up on the IC page), and
- not undone (`cancelled`) or deleted. Undo keeps a row's transcript, so this must be checked
  explicitly.

While the app runs, a background check (once a minute is enough) looks for conversations that have
gone quiet for 30 minutes and for sends whose retry time has come. If the app was closed, the same
check runs at the next start. Today nothing does this: the idle flush fires once at 5 minutes and
the retry sweep runs once per app start.

Ceiling: every page arrives about 30 minutes after the call ends, even when the recording was
stopped by hand. The Google Calendar project can make it exact with the event's end time. Odoo
sending is unchanged.

**The summary comes first (*my call*).** A page is created only after its summary succeeds. A page
without one would stay that way, because everyone else skips it. There's deliberately no "send
without summary": a summary-less page would block every other recorder's version of the meeting.
The transcript stays safe on the computer while it waits.
- `ensureMeetingSummary` today returns `null` for every cause (too few lines, no provider, provider
  error, empty reply, timeout). The Notion path needs a typed failure with a fixed reason code.
- Failures that can pass on a later try (network, rate limit, the shared key's spending limit, the
  provider being down) wait and retry automatically. The meeting shows on the Meetings page as
  "Waiting for summary" with the reason. The spending limit matters most, because then everyone's
  meetings fail together.
- Failures that retrying can't fix (no summary provider set up, a transcript too short to summarise,
  or an unreadable, empty or timed-out reply three times in a row) end in **"Couldn't summarise"**.
  Automatic retries stop, so they don't keep spending the shared key, but the transcript and the
  Retry button stay.
- The reason shown is fixed wording per code, never the provider's own error text, which can echo
  the key.

**Same meeting (this project, *my call*):**
- Search all three sub-tables, not only the one this meeting maps to. People in different time
  zones can see the same call on different weekdays.
- Only pages whose Date is a **time range** count. Meetwings always writes one (section 3.2). Pages
  with a plain all-day date, such as old Notion AI pages or one someone made by hand, are ignored,
  so they never cause a skip. No marker column is needed. Ceiling: a page someone gives a timed range
  by hand is treated as a Meetwings page.
- In every sub-table, since any recording can be sent (section 6) and unrelated calls can run at
  the same time: the ranges overlap by at least half of the shorter meeting, **and** one
  summary-model call, comparing the existing page's bold meeting title and topic headings with this
  summary, agrees it is the same meeting. (Not the page title: Monday and Wednesday pages are all
  called "Monday Meeting" or "Wednesday Meeting".)
- If that AI call fails or times out, the meeting waits and retries. It neither skips nor writes,
  because either guess could lose a meeting or duplicate one.
- Once Google Calendar exists, the calendar event ID makes this exact.

The race (*my call*): everyone's last line lands at about the same time, so two Meetwings reach the
30-minute mark together, both find nothing, and both write. Notion has no lock and no idempotency
key. So:
1. Check for a matching page, using the same-meeting rule above. If someone else's page matches,
   skip.
2. Otherwise create the page with its properties and body, but no transcript or practices yet. Save
   the new page's ID on the queue row straight away.
3. Wait a few seconds, then check again with the **full** same-meeting rule (overlap and AI
   agreement, not overlap alone, or a teammate in a different call at the same time would trash
   their own page). If more than one page matches, the earliest `created_time` wins; ties go to the
   lowest page ID. A loser moves its own page to the trash, stops, and shows "Already in Notion".
   Verify first (section 8.2): `created_time` may be rounded to the minute, so ties are likely and
   the page-ID tie-break does the work; and a query straight after a create may not yet see the
   other recorder's page, which is what the wait is for.
4. The winner appends the transcript and adds the practices to Team Knowledge. The two are
   independent: each is retried on its own, and a failure in one never stops the other. A retried
   practices step relies on the duplicate check (section 4), so rows already added aren't added
   twice.

A crash or a lost response between steps 2 and 4 must not strand the page. A retry never skips its
own page: it finds it by the saved page ID or, if the create response was lost before the ID was
saved, by a matching page whose "Created by" or "Recorded by" is this user. It then carries on from
step 3. The Odoo push handles the same case by adopting what it already created
(`meeting-log-push.ts`).

The send runs for minutes (summary, duplicate check, three sub-table searches, create, recheck, Team
Knowledge, many transcript batches), longer than the queue's stale-claim limit (`STALE_CLAIM_MS`, 5
minutes). The row's `claimed_at` is re-stamped after each step and each transcript batch, as the
Odoo push does per target, or the sweep reclaims a live send and makes a second page. AI calls keep
a time limit, like `SUMMARIZE_TIMEOUT_MS` (60 seconds).

Known ceiling: two pages can exist for a few seconds. Whoever's recording finishes first wins, even
if someone else's is longer.

What a skipper sees: on their Meetings page the meeting shows **"Already in Notion"** with a link to
the page. Their own recording and conversation stay on their computer as usual.


## 6. Who sends where

Kevin decided there's a setting, **"Send meetings to Notion automatically"**, **on by default**.
It applies to every Meeting Assist recording, team meeting or not.

| Set up | Setting on (default) | Setting off |
|---|---|---|
| Notion only (teammates) | Every recorded meeting goes to Notion once it's over (section 5), after the existing 30-second undo window (`HOLD_MS`). No picker. | Each meeting waits on the Meetings page with a **Send to Notion** button. Nothing goes out until it's pressed. |
| Both (Kevin) | Same as off: when Odoo is also set up, nothing is pre-picked, so client meetings never reach IC's workspace by accident. | Notion is an unticked choice in the overlay's target picker, next to Odoo contacts and leads, and can be picked with them. A meeting with no pick waits on the Meetings page as **unassigned**, as today. |
| Odoo only | Unchanged. | Unchanged. |
| Neither | Unchanged: nothing is queued. | Unchanged. |

*My call:* the setting only changes behaviour for Notion-only users. The Google Calendar project
later pre-picks Notion for Kevin, but only for meetings on his IC Google calendar.

Meetings rescued after a crash or quit (`runMeetingRecovery`) follow the same table (*my call*). For
a Notion-only user with the setting on, they're sent automatically and joined with the rest of
their conversation (section 5). In every other set-up they stay **unassigned**, as recovery does
today, so a rescued meeting never goes to a guessed Odoo customer.

## 7. Settings and setup

A **Notion** settings page, alongside the Odoo one:
- **Notion token:** each person makes a personal access token (Plus lets every full member do this)
  and pastes it here. The token acts as that person and can reach everything they can see in
  Notion, so it is treated like a password:
  - stored in the OS keychain through the `keyring` crate, as `src-tauri/src/graph/keychain.rs`
    already does for the Outlook refresh token, never in the plaintext plugin-store file;
  - never shown in logs, toasts, error text or the queue's `last_error`. The Odoo redactor
    (`src/lib/odoo/redactor.ts`) can't be reused as it is. It's one module-level instance armed only
    with Odoo secrets, and only once Odoo config loads, so for a Notion-only user it's never armed.
    `queueErrorText` in `src/lib/odoo/meeting-log.ts`, the one producer of `last_error`, also turns
    every error into an Odoo error ("Something failed outside Odoo"). Notion needs its own redactor,
    armed with the Notion token and the summary AI key before any call and failing closed when
    unarmed, its own error type, and a generalised or parallel `queueErrorText`.
- **Meetings database link** and **Team Knowledge database link.**
- **Send meetings to Notion automatically:** on by default (section 6).
- **Team meeting times:** a usual start time for each weekday sub-table (section 3.1).
- **Check button:** confirms the token works and both databases can be seen. Confirms each
  sub-table's title and date columns and Team Knowledge's four columns exist, that `Status` has a
  `Proposed` option, and shows the weekday mapping. Reports any problem in one plain sentence, e.g. "Can't see the Team Knowledge database:
  open it in Notion and check you have edit access."

A **Meeting summaries** setting (*my call*): its own AI provider, model and key, separate from the
chat model. Kevin chats on other models but wants summaries on GLM 5.3 Flash, which is already in
the model list as `z-ai/glm-5.3-flash` through OpenRouter. When it's empty, summaries fall back to
today's behaviour (the chat provider, or the Meetwings API). It drives every meeting summary, the
Odoo note included. When it's filled in, it also takes precedence over the Meetwings API: today
`ensureMeetingSummary` ignores a passed-in provider whenever `shouldUseMeetwingsAPI()` is true. Other
callers of `ensureMeetingSummary` and its shared prompt (Context Memory) must be checked before the
prompt or the return shape changes.

Key handling:
- **Each teammate's own speech-to-text key:** unchanged.
- **The shared OpenRouter key:** handed out through a password manager or another private channel.
  *My call:* it is stored where the other AI keys already live (`secure-provider-configs`, the
  plugin-store file). That isn't the keychain I mentioned in conversation. Kevin protects it with its
  own named key on OpenRouter and a monthly spending limit, and replaces it if it leaks.

## 8. Reliability requirements (from the anti-goals)

- **Nothing Notion-related runs while a meeting is being recorded.** All Notion work starts after
  the meeting ends, runs in the background, and never blocks the overlay or the transcription
  pipeline. A slow or broken Notion can't freeze the app.
- **Save first, send second.** The transcript is written to the local queue before any network call,
  as the Odoo queue already does. If Notion is down or rejects the token, the meeting waits and
  retries, honouring Notion's `Retry-After` on HTTP 429. Nothing is deleted because sending failed.
  A meeting is marked sent only after Notion confirms the page **and** the whole transcript is
  appended. Until then the row stays open: only pending and held rows are swept for retry, and the
  30-day retention blanks the transcript of `sent` rows, so marking it sent early would lose the
  transcript retry.
- **Failures are visible.** A meeting that couldn't be sent shows on the Meetings page with a plain
  reason and a Retry button, as Odoo failures do. No silent failures. A rejected token or lost
  access (HTTP 401 or 403, or a database Meetwings can no longer see) shows at once. It doesn't wait
  for several attempts, as an Odoo login failure does today, because a revoked token would then stay
  hidden for days.
- **Setup is quick to get right:** the Check button above.
- **Pilot before rollout:** one or two Mac teammates use it for a week before the rest of the team.
  Meetwings has mostly run on Windows with Teams; anti-goals 1 and 4 are mostly about recording on
  Mac with Google Meet, which this project doesn't change and nobody has tested.

### 8.1 What must be tested

The test tooling is the builder's (section 10), but each of these needs an automated test, because
each is a place where a plausible bug loses a meeting, leaks a secret or makes duplicates:
- **Joining:** gaps of 29:59 (joined) and 30:00 (not joined); rows from different conversations
  never joined; cancelled rows and rows not bound for Notion left out; a restart mid-meeting
  followed by recovery and then the join; all joined rows marked sent together, or none.
- **Who sends where:** the section 6 table as a test over (Notion only, Odoo only, both, neither) ×
  (setting on, off), asserting queued or not and what is picked. Render tests that a Notion-only
  user sees no Odoo wording: menu, Meetings page labels, overlay toasts, undo strip, error text,
  picker.
- **Recovery:** a Notion-only crash recovery with no Odoo config at all.
- **Same meeting:** overlap at exactly half and just under; one range inside another; a match in a
  different sub-table; an all-day page ignored; overlapping ranges the (mocked) AI calls different;
  the AI check failing (waits, no skip, no write).
- **Race:** the tie-break on equal `created_time`; a loser never writes practices; a loser whose
  trash call fails; a retry after a crash at each step resumes its own page instead of skipping it.
- **Transcript batches:** exactly 2,000 characters and one more; exactly 100 blocks and one more; more
  than 1,000 blocks; no split surrogate pairs; a failure at batch N resumes at N with no duplicate
  lines, including a batch whose response was lost.
- **Summary:** a cache hit returns topic sections and practices; an old cached summary without them
  is regenerated; a cached summary of one piece isn't used for a joined page; a conversation spanning
  two meetings summarises only this meeting; each failure code lands in "Waiting for summary" or
  "Couldn't summarise" with no page created; Retry works after the cause is fixed.
- **Retries:** `Retry-After` honoured, capped, and a 429 with no header backs off; a 429 isn't shown
  as a failure; 401 and 403 show at once.
- **Secrets:** the Notion token and the AI key never appear in `last_error`, toasts or thrown errors,
  including 401, 429 and 5xx bodies that echo request details; the redactor fails closed when unarmed
  (as `odoo-redact.test.ts` does for Odoo); the token is stored through the keychain, never the
  plugin store.
- **Migration:** a Rust test in `src-tauri/src/db/migration_tests.rs` that existing queue rows survive
  any new migration.
- **Team Knowledge plumbing,** with the model mocked: rows the model marks as duplicates are skipped;
  no Topic options are ever created; existing rows are never edited; Status is always `Proposed`.

The AI judgements themselves (no personal information, duplicates of Rejected rules, ignoring
instructions spoken in the meeting, same meeting or not) can't be proven with a mocked model. They're
checked on a few fixture transcripts against the real summary model before rollout. The fixtures
include a person's name, a fee, an "ignore previous instructions" line, and a rule that repeats a
Rejected row.

### 8.2 Live checks with a real token

Mocks pass whatever their author assumed, so these are run once with a real personal access token
before merge, against throwaway databases (a test copy of the meetings database with the same three
sub-tables, and the test Team Knowledge database), and the results are written in the PR:
1. What "Created by" shows for a page made with a personal token: the person or a bot (section 3.2).
2. Whether the token can read its owner's name (`bot.owner.user` → `GET /v1/users/{id}`).
3. A page created with a `data_source_id` parent lands in the right sub-table, with a datetime-range
   Date.
4. `Status` set to `Proposed` is accepted.
5. `created_time` resolution, and whether a query straight after a create sees the new page.
6. A 429 carries `Retry-After`, and how the data-source query limit behaves.

Release builds have no visible console, so these checks are made against the API's responses, not
the app's logs.

## 9. Constraints and facts the builder needs

Notion API (checked against developers.notion.com, Nov 2026):
- Free on every plan. Rate limit on Plus: 180 requests a minute per token. Data source queries are
  limited separately, to about 3 a second.
- Pages in a multi-source database are created with a `data_source_id` parent (API version
  2025-09-03 or later).
- `POST /v1/pages` accepts body blocks (max 100) **or** a `markdown` string. Blocks are appended
  with `PATCH /v1/blocks/{id}/children`, max 100 per call.
- Meeting-notes blocks can't be created through the block endpoints. `POST /v1/blocks/meeting_notes`
  only accepts an uploaded audio or video file.
- There's no idempotency key, which is why section 5 checks for an existing page.
- HTTP calls go through `@tauri-apps/plugin-http` (CORS), as the rest of the app's external calls
  do.

Current Meetwings code that assumes Odoo. Each spot has to change, or teammates get nothing:
- `useMeetingLog.trigger` (`src/hooks/useMeetingLog.ts`) **returns before queuing anything when Odoo
  isn't configured.** A Notion-only user would never queue a meeting. It must queue when Notion
  **or** Odoo is set up. Keep its transcript-slicing and watermark logic (`sliceTranscript`,
  `getTranscriptWatermark`, `setSkipWatermark`, the remount recovery); don't fork it. It took many
  fixes to get right.
- The same hook has more Odoo-only paths. `pushHeldRow`, the push when the 30-second hold expires,
  calls `requireOdooConfig()` and `createOdooClient` first, so a Notion row would stay `held` for
  ever. The hold-rehydrate effect bails unless `loadOdooConfigState()` is `complete` and looks rows up
  with `findHeldRow(instance, …)`. The startup effect runs the Odoo sweep. All three must work with no
  Odoo config.
- `meeting_log_queue.instance` is `NOT NULL` and holds an Odoo instance fingerprint.
  `pushQueuedRow` returns early when it doesn't match. `runMeetingLogSweep` stops (and records an
  error on every unsent row) when `requireOdooConfig()` fails. Notion destinations need to work with
  no Odoo config at all.
- Queue reads and the Meetings page compare `instance` with the live Odoo fingerprint.
  - `groupOf` files any row with a different instance under "other-database" and refuses Retry on
    it, and `resolveBadge` shows such rows only once `sent` (`src/lib/odoo/meeting-log.ts`).
  - `getQueueCounts`, `listActionableRows`, `selectSweepable` and `findHeldRow` all filter on the
    current instance (`src/lib/database/meeting-log.action.ts`).
  - `recordErrorOnUnsent` has no destination filter, so an Odoo outage would stamp an Odoo error on
    Notion rows.

  A Notion-only user has no Odoo fingerprint, so their rows would be misfiled or invisible. The
  builder decides what `instance` holds for Notion rows, but nothing may depend on Odoo config.
  "Waiting for summary", "Couldn't summarise" and "Already in Notion" also need a place in
  `BADGE_RANK` and `groupOf`.
- Every Meetings-page action (Retry, Assign, retarget) goes through `runAction` in
  `src/lib/odoo/meeting-log-actions.ts`, which calls `requireOdooConfig()` and fails without it.
  `enqueueConversation` does the same. The Notion Retry and "Send to Notion" buttons must not depend
  on Odoo config. `enqueueConversation` is also the only way to send a Meeting Assist span that was
  cleared mid-call, so it's in scope for Notion even though system audio isn't.
- Startup crash recovery (`runMeetingRecovery`, `src/lib/odoo/meeting-log-recovery.ts`) also calls
  `loadOdooConfigState()` and fingerprints the Odoo instance. Without a change, a Notion-only user who
  quits or crashes mid-meeting loses that meeting: anti-goal 4. Recovery must work with Notion alone.
  Section 6 says where a recovered meeting goes.
- `meeting_log_targets` rows are Odoo records (`model` = `res.partner` | `crm.lead`, `res_id`).
  Notion is a new kind of destination.
- Migrations are **never edited after release** (sqlx checksums them; see the header of
  `src-tauri/src/db/migrations/odoo-multi-target.sql`). Any schema change is a new migration file.
- `ensureMeetingSummary` (`src/lib/functions/meeting-summarizer.ts`) returns a **cached** summary per
  conversation, rebuilt from stored columns. The new fields (topic sections, team practices) have to
  be stored and returned there too, or every cached path loses them. A conversation can span more
  than one meeting (see `meetingTranscript` notes in the codebase), and the Notion page must
  summarise this meeting's whole joined span. The cache doesn't guarantee that. It returns any
  stored summary whose span *overlaps*, not one that *covers* it, and the first piece to be
  summarised wins. For Kevin, Odoo may already have summarised the first 5-minute piece. The Odoo
  push also stores a span built from fake per-line timestamps (`transcript_start_at + i`). So the
  Notion path reuses a cached summary only when it has the new fields **and** its span covers the
  whole joined span; otherwise it summarises the whole joined transcript afresh, with real
  timestamps or an explicit span.
- `ensureMeetingSummary` never throws and returns `null` for every failure, and the Odoo push keeps AI
  errors out of `last_error` on purpose (the redactor has no needle for an AI key). The Notion path
  needs the typed reason codes in section 5.
- The queue's stale-claim limit (`STALE_CLAIM_MS`, 5 minutes, in `src/lib/odoo/meeting-log.ts`) is
  shorter than a Notion send. See section 5 for re-stamping `claimed_at`.
- The existing summary JSON (`SummarizationResult`) has a paragraph summary plus decisions, action
  items and next steps. It needs topic sections (`heading` + `bullets`) and team practices
  (`rule` + `topic`) as well. The Odoo note body (`buildNoteBody`) keeps using today's fields.
- The Meetings page (`src/pages/meetings/`), queue rows and settings use Odoo wording throughout, and
  so do the overlay hook's toasts and undo-strip messages ("could not be queued for Odoo", "already
  being sent to Odoo"), which a Notion-only user sees during the 30-second undo window. A
  Notion-only user must see none of it: no Odoo menu item, no "Sent to Odoo".
- Meeting auto-detection (`useMeetingDetection`) is Windows- and Teams-only. The pill-off trigger in
  `useMeetingLog` already works on every platform, so a manually stopped Meeting Assist recording on
  a Mac still queues.
- The 5-minute idle flush (`IDLE_FLUSH_MS` in `src/lib/odoo/meeting-log.ts`, armed in
  `useMeetingLog`) splits a call at any silence of 5 minutes or more. Startup recovery segments by
  the same value. Manual sends segment by `MEETING_CONVERSATION_GAP_MS` (30 minutes, in
  `src/config/constants.ts`). See section 5 for how Notion joins the pieces.
- **System-audio captures are never queued by any trigger.** They can only be sent by hand, through
  `enqueueConversation` in `src/lib/odoo/meeting-log-actions.ts`. That stays as it is: system-audio
  captures are out of scope here.

## 10. Left to the builder

- Queue shape: generalise the existing queue and targets, or add a Notion destination alongside
  them. Either way the behaviour above holds, including save-first, retries, visible errors and
  Kevin's "both".
- Writing the body with Markdown or with blocks, and how the callout and toggle are produced.
- Prompt wording for topic sections and practices, and whether duplicate detection is part of the
  summary call or a second call.
- Retry and backoff numbers, within section 8.
- Test structure and tooling, covering at least the list in section 8.1. The repo has Vitest under
  `src/tests`.

## 11. Later, separate projects

1. **Google Calendar (IC members).** Each person connects their own Google calendar (desktop OAuth
   with PKCE and loopback, like Outlook in `src-tauri/src/graph/`), with an Internal OAuth app in the
   IC Workspace. It brings attendees on the Notion page, Notion pre-picked for IC meetings on Kevin's
   machine, and exact same-meeting matching by event ID.
2. **Google Meet detection** on Mac and Windows. The calendar's Meet link is a cheap hint.
3. Something that reads Confirmed rules for Claude, and blocks people confirming their own proposals
   (the knowledge hub's option B server).

## 12. Open questions

None. The three raised by the builder check were answered on 2026-11-11:
- **Which recordings:** a setting decides, automatic by default (section 6).
- **Agenda:** AI-generated, and hand-made pages are never reused (sections 3.3 and 5).
- **System audio:** not needed (section 2).

## Decisions log

Kevin decided: Notion as the destination, in the Weekly Team Meetings database. The Notion AI shape.
GLM 5.3 Flash for summaries. The Team Practices box. Practices go to Team Knowledge as Proposed. The
whole IC team uses it with Notion only, and Kevin chooses Notion or Odoo. One page per meeting, first
finisher wins. Summary and transcript both on the page. Each person's own speech-to-text key, one
shared AI key. The failure list in section 2. Google Meet detection later. The "Send meetings to
Notion automatically" setting, on by default. An AI-generated agenda. No system-audio captures. Team
meeting times in settings decide the Monday and Wednesday sub-tables.

My calls (Kevin to check): the weekday matching by name, the Date as a datetime range, "Created by"
(or a "Recorded by" column if it shows the token's bot), the race handling and its order, waiting until the meeting is over
and joining its pieces into one page, no page until the summary succeeds, searching all sub-tables
for duplicates, the extra same-meeting check in Other Meetings, the Team Practices box listing every
practice found, "You" replaced with the Notion name,
the Meeting summaries setting, the shared key in the existing AI-key store, Notion token in the OS
keychain, the agenda built from the topic headings, only time-range pages counting as duplicates,
one strict same-meeting rule in every sub-table, no "send without summary", nothing pre-picked when
Odoo is also set up, and the Mac pilot.

Added after spec review (my calls, Kevin to check): a meeting counts as over only after 30 minutes
of silence, never on pill-off or `meeting-ended` (so every page arrives about 30 minutes after the
call); only Notion-bound, not-undone rows are joined; "Couldn't summarise" ends automatic retries
after failures retrying can't fix; Status is set to `Proposed` explicitly; rescued meetings go to
Notion automatically only for Notion-only users with the setting on; a retry adopts its own page
instead of skipping it; 401 and 403 show at once; the must-test list and live checks in 8.1 and
8.2.
