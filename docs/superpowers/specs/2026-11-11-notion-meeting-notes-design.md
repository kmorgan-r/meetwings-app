# Notion meeting notes and Team Practices

Status: design, awaiting approval (2026-11-11)
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
  1,000 blocks or 500 KB per payload. The transcript is appended in batches under the toggle.
- **Partial failure:** if the transcript append fails, the page and summary stay. Only the transcript
  is retried, and nothing already written is duplicated.

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
| `Status` | status | Left unset, so it defaults to `Proposed`. Options: Proposed, Confirmed, Rejected |
| `Topic` | select | Best fit from the column's existing options; empty if none fits |
| `Meeting link` | URL | URL of the meeting page Meetwings just created |

Rules for rows:
- **No personal information:** no people's names, fees, percentages or deal terms. Name a partner
  organisation only if the practice is about that organisation. This is a hard company requirement
  from the knowledge hub spec.
- **No duplicates:** before adding a rule, read the existing rows and skip any rule that means the
  same as one already there, whatever its Status. A rejected rule must not come back every week.
  Comparing meaning is an AI judgment, made with the same summary model.
- Never edit, re-status or delete existing rows, except the clean-up of Meetwings' *own* rows in
  section 5.
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
each split it. One meeting must still give one page summarising all of it. So a Notion send waits
until the meeting is over: either the recording was stopped (pill off, or the meeting-ended event),
or 30 minutes pass with nothing new said. Thirty minutes is the codebase's own meeting boundary,
`MEETING_CONVERSATION_GAP_MS`. All rows of the same conversation with gaps under 30 minutes are
joined into one page. Ceiling: someone who never stops the recording gets their page about 30
minutes after the call. Odoo sending is unchanged.

**The summary comes first (*my call*).** A page is created only after its summary succeeds. A page
without one would stay that way, because everyone else skips it. If summarising fails, the meeting
waits and retries, and shows on the Meetings page as "Waiting for summary" with the reason. The
reason matters most when the shared key's spending limit is hit, because then everyone's meetings
fail together. The Meetings page offers Retry. There's deliberately no "send without summary": a
summary-less page would block every other recorder's version of the meeting. The transcript stays
safe on the computer while it waits.

**Same meeting (this project, *my call*):**
- Search all three sub-tables, not only the one this meeting maps to. People in different time
  zones can see the same call on different weekdays.
- Only pages whose Date is a **time range** count. Meetwings always writes one (section 3.2). Pages
  with a plain all-day date, such as old Notion AI pages or one someone made by hand, are ignored,
  so they never cause a skip. No marker column is needed. Ceiling: a page someone gives a timed range
  by hand is treated as a Meetwings page.
- In every sub-table, since any recording can be sent (section 6) and unrelated calls can run at
  the same time: the ranges overlap by at least half of the shorter meeting, **and** one
  summary-model call, comparing the existing page's title and topic headings with this summary,
  agrees it is the same meeting.
- Once Google Calendar exists, the calendar event ID makes this exact.

The race (*my call*): calls end for everyone together, so two Meetwings can check at the same moment,
both find nothing, and both write. Notion has no lock and no idempotency key. So:
1. Check for a matching page. If one exists, skip.
2. Otherwise create the page with its properties and body, but no transcript or practices yet.
3. Check again. If there's more than one overlapping page from this flow, the earliest
   `created_time` wins (ties go to the lowest page ID). A loser moves its own page to the trash and
   stops.
4. The winner adds the practices to Team Knowledge, then appends the transcript.

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

## 7. Settings and setup

A **Notion** settings page, alongside the Odoo one:
- **Notion token:** each person makes a personal access token (Plus lets every full member do this)
  and pastes it here. The token acts as that person and can reach everything they can see in
  Notion, so it is treated like a password:
  - stored in the OS keychain through the `keyring` crate, as `src-tauri/src/graph/keychain.rs`
    already does for the Outlook refresh token, never in the plaintext plugin-store file;
  - never shown in logs, toasts, error text or the queue's `last_error`. Reuse the Odoo redactor
    pattern (`src/lib/odoo/redactor.ts`).
- **Meetings database link** and **Team Knowledge database link.**
- **Send meetings to Notion automatically:** on by default (section 6).
- **Team meeting times:** a usual start time for each weekday sub-table (section 3.1).
- **Check button:** confirms the token works and both databases can be seen. Confirms each
  sub-table's title and date columns and Team Knowledge's four columns exist, and shows the weekday
  mapping. Reports any problem in one plain sentence, e.g. "Can't see the Team Knowledge database:
  open it in Notion and check you have edit access."

A **Meeting summaries** setting (*my call*): its own AI provider, model and key, separate from the
chat model. Kevin chats on other models but wants summaries on GLM 5.3 Flash, which is already in
the model list as `z-ai/glm-5.3-flash` through OpenRouter. When it's empty, summaries fall back to
today's behaviour (the chat provider, or the Meetwings API). It drives every meeting summary, the
Odoo note included.

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
  A meeting is marked sent only after Notion confirms the page.
- **Failures are visible.** A meeting that couldn't be sent shows on the Meetings page with a plain
  reason and a Retry button, as Odoo failures do. No silent failures.
- **Setup is quick to get right:** the Check button above.
- **Pilot before rollout:** one or two Mac teammates use it for a week before the rest of the team.
  Meetwings has mostly run on Windows with Teams; anti-goals 1 and 4 are mostly about recording on
  Mac with Google Meet, which this project doesn't change and nobody has tested.

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
- `meeting_log_queue.instance` is `NOT NULL` and holds an Odoo instance fingerprint.
  `pushQueuedRow` returns early when it doesn't match. `runMeetingLogSweep` stops (and records an
  error on every unsent row) when `requireOdooConfig()` fails. Notion destinations need to work with
  no Odoo config at all.
- Startup crash recovery (`runMeetingRecovery`, `src/lib/odoo/meeting-log-recovery.ts`) also calls
  `loadOdooConfigState()` and fingerprints the Odoo instance. Without a change, a Notion-only user who
  quits or crashes mid-meeting loses that meeting: anti-goal 4. Recovery must work with Notion alone.
- `meeting_log_targets` rows are Odoo records (`model` = `res.partner` | `crm.lead`, `res_id`).
  Notion is a new kind of destination.
- Migrations are **never edited after release** (sqlx checksums them; see the header of
  `src-tauri/src/db/migrations/odoo-multi-target.sql`). Any schema change is a new migration file.
- `ensureMeetingSummary` (`src/lib/functions/meeting-summarizer.ts`) returns a **cached** summary per
  conversation, rebuilt from stored columns. The new fields (topic sections, team practices) have to
  be stored and returned there too, or every cached path loses them. A conversation can span more
  than one meeting (see `meetingTranscript` notes in the codebase). The Notion page must summarise
  this meeting's transcript span, as the Odoo note does.
- The existing summary JSON (`SummarizationResult`) has a paragraph summary plus decisions, action
  items and next steps. It needs topic sections (`heading` + `bullets`) and team practices
  (`rule` + `topic`) as well. The Odoo note body (`buildNoteBody`) keeps using today's fields.
- The Meetings page (`src/pages/meetings/`), queue rows and settings use Odoo wording throughout. A
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
- Test approach. The repo has Vitest under `src/tests`.

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
