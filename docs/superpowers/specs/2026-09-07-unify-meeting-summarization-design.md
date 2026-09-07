# Unify meeting summarization into one transcript-sourced pass

Date: 2026-09-07
Status: design approved, plan not yet written

Two independent AI summarization passes exist for the same meeting today, and
this spec collapses them into one. As a side effect it also unblocks the
originally-requested feature: an expand button on each meeting row in the
dashboard (`/meetings`) that shows that meeting's summary inline, without a
trip to Context Memory.

## Why

`generateConversationSummary` (`src/lib/functions/meeting-summarizer.ts:251`)
and `generateMeetingLogSummary` (`:446`) both run the same
`SUMMARIZATION_PROMPT` (`:58`) against the same meeting, from two different
callers, and write to two different places:

- The **Odoo note** path: triggered from inside `pushQueuedRow`
  (`src/lib/odoo/meeting-log-push.ts:211-237`) via the `deps.summarize`
  dependency, fed the meeting's transcript (`renderTranscript`, real speaker
  labels), cached as `summary_json` on the `meeting_log_queue` row
  (`setSummaryJson`, `src/lib/database/meeting-log.action.ts:776`). Only runs
  for meetings that get pushed to Odoo (Odoo configured, has an assigned
  target).
- The **Context Memory** path: triggered from `summarizeCurrentConversation`
  (`src/hooks/useCompletion.ts:1358`) on every conversation switch/end, fed
  `conversationHistory` and labeled by `formatConversationForSummary` as
  User/Assistant (`:96`), gated on `shouldSummarize` (≥2 exchanges,
  `meeting-summarizer.ts:420`), saved to the `meeting_summaries` table.

These are not actually two different sources. `conversationHistory` is not a
separate "what you typed to the AI" stream — `addMeetingTranscript` and
`addMeetingTranscriptEntries` (`useCompletion.ts:615-690`) push every
transcript entry into `meetingTranscript` (the Odoo source) **and** into
`conversationHistory` (the Context Memory source) as a `role: "user"`
`ChatMessage`, same timestamp/speaker/audioSource. So the chat-based summary
is the transcript, mislabeled, with the AI's own replies and any typed
questions mixed in — the exact framing `meeting-log.ts:9` already documents as
wrong ("meaningless when both sides are human").

Net effect today: up to two AI calls per meeting, two summaries that can read
differently for the same meeting, and Context Memory's summary/entity
extraction is silently absent for any meeting where the user never typed a
question to the assistant.

## What this design settles

- **One AI call, one summary per meeting**, sourced from the transcript with
  real speaker labels (`renderTranscript`), not chat role labels.
- **`meeting_summaries` is the canonical store** (already exists, already
  Odoo-independent, already has entity extraction, knowledge-profile
  compaction, and title-adoption wired to it). Not a new table.
- **Generation is decoupled from Odoo entirely.** It runs at meeting end
  whether or not Odoo is configured, matching Context Memory's current
  breadth of coverage — not narrowed to only Odoo-assigned meetings.
- **Typed AI Q&A during a meeting is not preserved as its own summary.** It's
  dropped; the raw chat is still visible in Chats history if needed.
- Dashboard expand button reads the same `meeting_summaries` row the Odoo
  note and Context Memory both already draw from — one summary shown
  everywhere.
- **Retention widens, deliberately.** `meeting_summaries` has no prune sweep,
  unlike `meeting_log_queue`'s `transcript`/`summary_json` columns
  (`RETENTION_MS` — 30 days, `meeting-log.ts`). Moving the Odoo path's summary
  into `meeting_summaries` means an Odoo-only meeting's summary now persists
  indefinitely instead of being scrubbed after 30 days alongside its
  transcript — the same retention Context Memory's own summaries already get
  today. That's intentional, not incidental: Context Memory's whole purpose
  is a durable knowledge base, and this design extends that durability to
  every meeting's summary, Odoo-configured or not, rather than reproducing
  the queue's shorter-lived policy in a second place.

## Data model

`meeting_summaries` (`src-tauri/src/db/migrations/meeting-context.sql`,
`conversation_id TEXT NOT NULL UNIQUE`) is unchanged in shape. Only its input
changes.

`meeting_log_queue.summary_json` (added in `meeting-log-queue.sql`) is
dropped. It exists purely as a per-row cache duplicating what
`meeting_summaries` now owns keyed by `conversation_id`. New migration
`meeting-log-queue-v2.sql`, registered as version 16 in
`src-tauri/src/db/main.rs`:

```sql
-- Migration 16: meeting_summaries (keyed by conversation_id) replaces this
-- column as the one cache/source of truth for a meeting's AI summary.
INSERT INTO meeting_summaries (
  id, conversation_id, summary, title, topics, goals, action_items,
  next_steps, decisions, team_updates, participants, exchange_count,
  meeting_started_at, meeting_ended_at, created_at, updated_at
)
SELECT
  lower(hex(randomblob(16))), q.conversation_id,
  json_extract(q.summary_json, '$.summary'),
  json_extract(q.summary_json, '$.title'),
  json_extract(q.summary_json, '$.topics'),
  json_extract(q.summary_json, '$.goals'),
  json_extract(q.summary_json, '$.actionItems'),
  json_extract(q.summary_json, '$.nextSteps'),
  json_extract(q.summary_json, '$.decisions'),
  json_extract(q.summary_json, '$.teamUpdates'),
  json_extract(q.summary_json, '$.participants'),
  0, q.meeting_started_at, q.transcript_end_at, q.created_at, q.created_at
FROM meeting_log_queue q
WHERE q.summary_json IS NOT NULL
  AND q.conversation_id IS NOT NULL
  -- `session_key`, not `conversation_id`, is what's UNIQUE on this table —
  -- one conversation can own several queue rows (several pushed slices, see
  -- the Trigger section). `meeting_summaries.conversation_id` IS UNIQUE, so
  -- backfilling every matching row would violate it on the second row for a
  -- repeat conversation. Keep only the newest cached row per conversation —
  -- the same choice `ensureMeetingSummary`'s cache-first read effectively
  -- makes going forward (see "Cache scope is per-conversation, not
  -- per-slice" under Trigger).
  AND q.created_at = (
    SELECT MAX(q2.created_at) FROM meeting_log_queue q2
    WHERE q2.conversation_id = q.conversation_id AND q2.summary_json IS NOT NULL
  )
  AND NOT EXISTS (
    SELECT 1 FROM meeting_summaries s WHERE s.conversation_id = q.conversation_id
  );

ALTER TABLE meeting_log_queue DROP COLUMN summary_json;
```

(`id` here is a raw hex blob, not app's dashed `crypto.randomUUID()` format —
cosmetic only, `id` is an opaque `TEXT PRIMARY KEY`; fine to leave or fix to
match at implementation time. `meeting_started_at`/`meeting_ended_at` are
backfilled from the queue row's own `meeting_started_at`/`transcript_end_at`
rather than left NULL, so a backfilled row's meeting-window display in
`SummaryDetail.tsx` renders the same way a live-written row's does.
`exchange_count` stays a literal `0` for these backfilled rows, deliberately:
under the new meaning of that column (see the shared summarization helper's
step 4 — a transcript entry count, not a chat exchange count), the original
entry count was never stored anywhere `summary_json` or the queue row can
recover it from, so `0` is an honest "unknown" rather than a fabricated
number. Live rows written going forward always carry a real count.)

Backfill exists so a row mid-retry at upgrade time (queued with a cached
summary, not yet sent) doesn't lose that cache and trigger a second AI call
right after the upgrade. Rows whose `conversation_id IS NULL` (the rare
recovery-path case, see Error handling) are not backfilled — nothing to key
them on — and simply regenerate on next push, same as today.

**Every other reference to `summary_json` has to move too, not just the
column.** `QUEUE_SQL` in `meeting-log.action.ts` names it in five places
beyond the `DbMeetingLogRow` field: `setSummary` (`:140`, the statement
`setSummaryJson` runs — deleted along with that function, see below),
`deleteRow` and `deleteTerminalRow` (`:305`, `:328`, each sets
`summary_json = NULL` as part of blanking a deleted row — drop the clause),
`prune` (`:399-401`, sets it NULL and tests `OR summary_json IS NOT NULL` in
its WHERE — drop both), and `listActionable` (`:346`, selects it as an
explicit column, not via `SELECT *` — drop it from the column list). Left in
place, every one of these becomes `no such column: summary_json` the moment
migration 16 runs — `listActionable` in particular is the query that
populates the meetings dashboard this same spec adds an expand button to, so
an unfixed reference there breaks the dashboard outright, not just Odoo.

`setSummaryJson` (`meeting-log.action.ts:776`) and the `summary_json` field on
`NewQueueRow`/`DbMeetingLogRow` are removed. `pushQueuedRow`'s own row-level
cache check that reads `row.summary_json` and calls `setSummaryJson` on a
miss (`meeting-log-push.ts`, the `if (row.summary_json) {...} else {...}`
block around the `deps.summarize` call) is deleted in the same change — it
reads/writes a column that no longer exists, and the caching it did at the
row level is superseded by `ensureMeetingSummary`'s own conversation-keyed
cache-first read (step 1 below). The replacement call site is a plain,
unconditional `summary = await deps.summarize(row.conversationId, slice)`
(see Trigger).

Note for the implementer: this repo's dev DB has a known `_sqlx_migrations`
checksum-drift issue on schema changes — patch the checksum via `node:sqlite`
across all versions per existing project practice, don't hand-edit with
`sql.js`.

## The shared summarization helper

New function in `meeting-summarizer.ts`, replacing both
`generateConversationSummary` and `generateMeetingLogSummary`:

```ts
export async function ensureMeetingSummary(
  conversationId: string | null,
  entries: TranscriptEntry[],
  providerConfig?: ProviderConfig,
  minEntries: number = 4
): Promise<SummarizationResult | null>
```

Behavior:
1. If `conversationId` is non-null, look up `getMeetingSummaryByConversation`
   first. A hit returns its fields as `SummarizationResult` — no AI call.
2. On a miss (or `conversationId === null`), gate on `entries.length >=
   minEntries`. **`minEntries` is a parameter, not a constant, because the two
   callers need different floors.** The Context Memory trigger uses the
   default (4, an even trade for today's `MIN_EXCHANGES_FOR_SUMMARY = 2`
   exchanges / 4 messages). The Odoo trigger passes `minEntries: 1`, matching
   `generateMeetingLogSummary`'s floor today (`entries.length === 0` is the
   only skip, `meeting-summarizer.ts` — "a short meeting still gets logged").
   A uniform gate of 4 would silently regress Odoo: a 1-3 line meeting would
   fall through to `buildNoteBody`'s no-summary branch, whose copy says
   "Summarization failed" — false for a meeting that was simply short, not one
   the AI choked on. Below the gate, return `null` without calling the AI.
3. Build the prompt from `renderTranscript(entries)` (speaker-labeled), same
   as today's Odoo path — not `formatConversationForSummary`.
4. On a successful result: if `conversationId` is non-null, persist via
   `saveSummarizationResult` (unchanged — this is what drives entity
   extraction, knowledge-profile compaction, and title-adoption), passing
   `entries.length` as its `exchangeCount` argument. `exchangeCount` was
   always a count of `Message[]` user/assistant pairs (`countExchanges`) —
   with no `Message[]` left in this path, the closest surviving concept is
   the number of transcript entries that went in, so the column is
   repurposed to mean "how many transcript lines," not dropped. `SummaryDetail.tsx`'s
   footer already just prints this number ("N exchanges"); it keeps rendering
   a real, meaningful count rather than a hardcoded 0. **If the
   persist itself fails** (`saveSummarizationResult` returns `null` — a DB
   write error), `ensureMeetingSummary` still returns the generated `result`,
   not `null`. This is new behavior the two functions being merged never had
   to define, because generation and persistence used to be two different
   functions on two different call paths: today a persist failure only ever
   happened on the Context Memory path, silently, with no other consumer
   waiting on the result. Now the SAME call can feed the Odoo note, and a
   generated-but-unpersisted result must still reach `buildNoteBody` — the
   alternative (returning `null`) would make a working AI call look like a
   summarization failure and trigger the transcript-excerpt fallback body for
   a note that has a perfectly good summary sitting in memory. If
   `conversationId` is null, return the result without persisting (unchanged).
5. Never throws — same contract `generateMeetingLogSummary` documents today
   (`meeting-summarizer.ts:437-440`): a summarization failure must not become
   a push failure or a lost meeting.

`generateConversationSummary`, `saveSummarizationResult`'s standalone export
surface, `summarizeConversation`, `shouldSummarize`, and
`formatConversationForSummary` collapse into this one function plus its
existing DB-layer dependencies (`createMeetingSummary`,
`createOrUpdateKnowledgeEntity`, `createEntityMention`,
`applySummaryTitleToConversation` — all unchanged, still called from inside
the save step).

**`summarizeConversation` has two more callers beyond `useCompletion.ts`,
neither mentioned above, and both need to move to `ensureMeetingSummary`:**
`src/lib/functions/knowledge-compactor.ts:113` (the "Update Knowledge"
backfill button — iterates DB-loaded conversations via
`getUnsummarizedConversations`, converting each `conv.messages` to
`Message[]`) and `src/hooks/useSystemAudio.ts:669` (the system-audio-capture
completion handler, converting `conversation.messages` the same way). Both
only have `ChatMessage[]` in hand — DB-loaded history, not a live
`TranscriptEntry[]` — because both summarize AFTER the fact, not from an
in-memory `meetingTranscript` that was never persisted. Both need a small
adapter, `ChatMessage[] → TranscriptEntry[]`, mapping `content → original`,
plus `timestamp`, `speaker`, and `audioSource` straight across — `ChatMessage`
already carries all three (`src/types/completion.ts:46-60`), because
`addMeetingTranscript`/`addMeetingTranscriptEntries` stamped them there from
the same `TranscriptEntry` in the first place (see Why). Neither caller has
a live "meeting" concept, so both call `ensureMeetingSummary` with
`minEntries: 4` (Context Memory's floor, not Odoo's) — a short, mostly-empty
old conversation should stay silently unsummarized on backfill, exactly as
`shouldSummarize` already gates it today.

## Trigger

`summarizeCurrentConversation` (`useCompletion.ts:1358`) keeps its existing
call sites — `loadConversation` (`:1401`) and `startNewConversation`
(`:1430`) — because those already fire at the right lifecycle point (leaving
a conversation), independent of Odoo. Its body changes from building
`messages` out of `conversationHistory` to calling `ensureMeetingSummary`
with a slice of `meetingTranscript` and `state.currentConversationId` — a
slice, not the raw array, for the reason below.

**`meetingTranscript` is not conversation-scoped, and that has to be fixed
here, not assumed away.** `meeting-log.ts`'s own doc comment already explains
why the Odoo side needs a watermark instead of using this array directly:
`meetingTranscript` is a session-wide buffer that is never cleared on a
conversation switch (`setMeetingTranscript([])` appears in exactly one place,
`clearMeetingTranscript`) — only `conversationHistory` is reset per
conversation (`loadConversation` and `startNewConversation` both replace it
wholesale, `:1418`/`:1444`). Summarizing the RAW `meetingTranscript` on every
switch would summarize every meeting held so far this session as if it were
the one just left, and — because `saveSummarizationResult` also renames the
conversation from the summary's title — silently retitle whichever
conversation happens to be current using content from a DIFFERENT one.

The fix: track a new ref (e.g. `conversationTranscriptStartRef`) holding the
index into `meetingTranscript` at which the CURRENT conversation's own live
activity begins. Set it every time `currentConversationIdRef` starts pointing
at a different conversation — in `loadConversation` and
`startNewConversation`, to `meetingTranscript.length` at that moment, and
where `ensureConversationId` mints a fresh id inside
`addMeetingTranscript`/`addMeetingTranscriptEntries` for a conversation that
had none yet, to the length immediately BEFORE that call's own entry/entries
are appended (so the entry that started the conversation is included in its
own summary — the exact index arithmetic is an implementation detail for the
plan). `summarizeCurrentConversation` then passes
`meetingTranscript.slice(conversationTranscriptStartRef.current)` to
`ensureMeetingSummary`, not `meetingTranscript` itself. Its `useCallback`
dependency array (`:1394-1399`) must swap `state.conversationHistory` for
`meetingTranscript` (today's array lists `conversationHistory` specifically
because the body reads it) — leaving the old array while changing the body's
data source is a stale-closure bug the callback would silently carry.

One consequence worth stating explicitly: a conversation reopened from Chats
history with no NEW live transcript activity this session now slices to
`entries.length === 0`, so `ensureMeetingSummary` returns `null` without an
AI call — where today's `conversationHistory`-based version would re-run a
full re-summarization of the conversation's ENTIRE historical content on
every such reopen-then-switch-away, even with zero new activity. This is a
deliberate narrowing in the same direction as the rest of this design (see
Why: chat role labels are not a meaningful summary source), not a regression
of anything that currently works correctly — an EXISTING `meeting_summaries`
row for that conversation is untouched and still shown via the cache-hit path
and the dashboard/Context Memory. A historical conversation with no row yet
and no new activity stays unsummarized until the knowledge-compactor backfill
reaches it (see the shared helper section above).

`useMeetingLog.ts`'s Odoo `trigger` (around `:269-408`) is untouched in
structure — it still does its own watermark-sliced transcript for the Odoo
push/attachment. What changes is `PushDeps.summarize`'s signature and every
one of its call sites: `PushDeps.summarize` is typed
`(slice: TranscriptSlice) => Promise<SummarizationResult | null>` today,
`TranscriptSlice` has no `conversationId` field, and the closure that becomes
`deps.summarize` is built in `useMeetingLog.ts` OUTSIDE any per-row scope —
`row` exists only inside `pushQueuedRow`. Concretely:
- `PushDeps.summarize` widens to
  `(conversationId: string | null, slice: TranscriptSlice) => Promise<SummarizationResult | null>`.
- `pushQueuedRow`'s call site changes from `deps.summarize(slice)` to
  `deps.summarize(row.conversationId, slice)`, replacing the deleted
  `row.summary_json`/`setSummaryJson` cache block entirely (see Data model).
- `useMeetingLog.ts`'s `summarize` `useCallback` (`:197-201`) widens to
  `(conversationId: string | null, entries: TranscriptEntry[]) =>
  ensureMeetingSummary(conversationId, entries, providerConfigRef.current, 1)`
  — `minEntries: 1`, matching the Odoo floor the shared helper section
  describes.
- Both current call sites of `summarize` update to match: `pushHeldRow`
  (`:203-217`) already has `row` in scope and passes `row.conversationId`
  directly; the single closure built at `:483` and handed into
  `runMeetingLogSweep` is defined ONCE, before that function's own per-row
  loop runs, so it must accept `conversationId` as an argument rather than
  close over one — `runMeetingLogSweep`'s `summarize` parameter type
  (`PushDeps["summarize"]`) needs no separate change once `PushDeps` widens,
  since it is threaded straight into `pushQueuedRow` unmodified.

**Cache scope is per-conversation, not per-slice.** `ensureMeetingSummary`'s
cache (the shared helper's step 1) is keyed on `conversationId` alone, but one
conversation can generate more than one `meeting_log_queue` row over time —
`sessionKeyFor` keys each row on `conversationId:startAt`, not
`conversationId` alone. Under the cache-first read, only the first slice's
push ever calls the AI; a later slice for the SAME conversation hits the
cache and posts the FIRST slice's summary text to Odoo, describing the wrong
part of the meeting. This is accepted as a deliberate, bounded limitation:
reworking the Odoo watermark/dedup logic to key summaries per-slice is out of
scope (see Out of scope), and a conversation producing a second queue row is
the exception, not the common case. No code change is needed in
`buildNoteBody` for this — a cache hit still returns a normal
`SummarizationResult`, not `null`, so the note it produces reads like any
other successful summary, not like the "Summarization failed" fallback.

Because `summarizeCurrentConversation` fires fire-and-forget
(`useCompletion.ts:1379-1393`, never awaited) and an AI call takes real time,
the Context Memory trigger and the Odoo push can both miss the cache
concurrently and both generate a summary for the same conversation — one wins
the persist (`meeting_summaries.conversation_id` is `UNIQUE`), the other's
insert fails, is swallowed by `saveSummarizationResult`'s existing catch
(logged, returns `null`, never thrown), and its API call was spent for
nothing. The STORED result therefore converges regardless of order, but
"either order is idempotent" overstates it — this is a real, if narrow, race
on API spend, not a correctness bug, and it is no worse than what the two
separate functions already had today.

## Entity extraction / knowledge profile

No design change — `createOrUpdateKnowledgeEntity` /`createEntityMention`
(`meeting-context.action.ts:409`, `:550`) stay wired exactly where they are,
inside the save step `ensureMeetingSummary` now shares. The only behavioral
change is coverage: entities now get extracted for every summarized meeting,
including ones where the user never typed a chat question — previously those
were invisible to Context Memory entirely.

## Dashboard expand button

`QueueRow.tsx` / `ConversationRow.tsx` (`src/pages/meetings/components/`)
already carry `conversation_id` per row (`MeetingLogListRow`'s
`conversation_id: string | null`, inherited from `DbMeetingLogRow`). Add an
expand affordance that, on open, calls
`getMeetingSummaryByConversation(conversationId)` and renders the result
inline — but only when `conversation_id` is non-null. A null
`conversation_id` (the same rare recovery-path gap Error handling documents
below) hides the expand affordance entirely rather than offering a toggle
that can only ever show "No summary available," mirroring how
`SummaryDetail.tsx`'s own "open conversation" button is already disabled on
`!summary.conversationId`.

**Expand/fetch state is row-local, not parent-owned — deliberately, so
neither row component's memoization contract needs to change.** `QueueRow` is
a `memo` with a hand-written `propsAreEqual` (`QueueRow.tsx:599-636`) that
enumerates every rendered prop, including its existing
`transcript: TranscriptView | null` (parent-owned, toggled via
`onToggleTranscript`); any NEW parent-owned prop has to be added there or the
memo silently swallows its updates — a bug class the file's own comment
already warns about. `ConversationRow` goes further: it deliberately accepts
ONLY primitives so it can rely on `memo`'s default shallow compare with no
custom comparator at all (`ConversationRow.tsx:54-68`); a fetched summary
object passed down as a prop would break that contract outright. Keeping the
expand toggle, the fetch, the loading/error state, and the rendered
`SummaryContent` entirely inside each row's OWN `useState`/`useEffect` — fired
on click, never threaded down as a prop — sidesteps both constraints:
`QueueRow`'s comparator and `ConversationRow`'s primitives-only prop list stay
exactly as they are today.

Extract a small presentational `SummaryContent` component from the guts of
`SummaryDetail.tsx` (title/summary/topics/decisions/action items/next
steps/participants rendering — it's already source-agnostic, no chat-specific
framing to strip) so the full Context Memory detail view and the new inline
dashboard expand share one renderer instead of duplicating JSX.
`SummaryDetail.tsx` keeps its own edit/save/copy chrome around that shared
piece; the dashboard expand is read-only.

No summary yet (never generated, or below the entry-count gate) renders a
plain "No summary available" state, not an error — this is an expected state
for short or `unassigned`/`held` meetings, not a failure.

## Error handling

- **`conversationId === null`** (rare recovery-path case documented at
  `useMeetingLog.ts` around the `insertQueueRow` call): `ensureMeetingSummary`
  generates without persisting. The Odoo note still gets a real summary; there
  is nothing for the dashboard expand or Context Memory to show for that row,
  same as today's equivalent gap.
- **AI provider failure or timeout**: `ensureMeetingSummary` returns `null`,
  same contract as today's two functions. Odoo push falls back to its
  existing transcript-excerpt note body (`buildNoteBody`'s no-summary branch,
  `meeting-log.ts:264-271`); dashboard/Context Memory show "no summary."
- **Migration**: covered above — backfill before drop, guarded by `NOT
  EXISTS` so re-running the migration (or a row that already has a
  `meeting_summaries` entry from the new trigger beating the migration to it)
  never double-inserts.

## Testing

- `meeting-summarizer.ts`: new tests for `ensureMeetingSummary` — cache hit
  (no AI call), cache miss + gate below `minEntries` (no AI call, returns
  null; cover both the default gate of 4 and the Odoo-path gate of 1 — a
  2-entry transcript must skip under the former and generate under the
  latter), cache miss + gate met (AI call, persists, entity extraction
  fires), `conversationId === null` (AI call, no persist), AI failure
  (returns null, never throws), **and generate-succeeds-but-persist-fails**
  (`saveSummarizationResult` returns null — `ensureMeetingSummary` must still
  return the generated `result`, not `null`, per the shared helper's step 4).
- `odoo-meeting-log-push.test.ts`: update the `summarize` dependency's shape
  in test fakes to match the new `(conversationId, slice)` signature and
  "look up or generate," not "always generate" — existing assertions on
  `subtype_xmlid`/`body_is_html` etc. are unaffected. Add a test that no
  longer reads/writes `row.summary_json` (the deleted cache block), and a
  sweep-path test (not just a single held-row push) proving the correct
  per-row `conversationId` reaches `ensureMeetingSummary` for each of several
  rows in one sweep — the bug this signature change exists to fix would
  otherwise pass a single-row test and fail silently on real multi-row
  sweeps.
- Migration test: seed a `meeting_log_queue` row with `summary_json` and no
  matching `meeting_summaries` row, run the migration, assert the row lands in
  `meeting_summaries` and the column is gone. Two more migration test cases,
  both exercised by the guards the migration's `WHERE` clause adds: (a) a
  `meeting_log_queue` row with `summary_json` set but `conversation_id IS
  NULL` — assert it is skipped, not backfilled, and the migration still
  completes; (b) a `meeting_log_queue` row with `summary_json` set whose
  `conversation_id` ALREADY has a `meeting_summaries` row — assert no second
  row is inserted (the `NOT EXISTS` guard) — and a fourth case, (c) TWO
  `meeting_log_queue` rows sharing one `conversation_id`, both with
  `summary_json` set — assert exactly one `meeting_summaries` row results,
  from the newer of the two (the `MAX(created_at)` guard added to fix the
  `UNIQUE` violation described in Data model).
- New render test for the dashboard expand: renders summary content when
  present, "no summary" state when absent, doesn't fetch until expanded, and
  renders no expand affordance at all when `conversation_id` is null.

## Out of scope

- Reworking `buildNoteBody`'s HTML rendering (already fixed separately, PR
  #56).
- Any change to the Odoo watermark/dedup logic in `useMeetingLog.ts`'s
  `trigger` — that machinery is specific to not double-posting Odoo notes and
  is untouched here.
- Reworking `ensureMeetingSummary`'s cache to be per-slice instead of
  per-conversation (see "Cache scope is per-conversation, not per-slice"
  under Trigger) — a conversation producing a second `meeting_log_queue` row
  is the exception, and slice-scoped caching would need the same watermark
  machinery this bullet already excludes.
- Backfilling entity extraction retroactively for `meeting_summaries` rows
  that existed BEFORE this change and were created via the old Context Memory
  chat path (`generateConversationSummary`/`saveSummarizationResult`) — those
  already ran extraction, no gap to fill. **This does not cover migration
  16's own backfilled rows** (see Data model): those come from
  `meeting_log_queue.summary_json`, written by the Odoo path, which never
  called `saveSummarizationResult` and so never ran entity extraction in the
  first place — the migration's own column list has no `entities` field to
  draw from. Those rows land with zero entity mentions and stay that way;
  re-running extraction against their stored `summary` text (the original
  transcript is gone by the time the migration runs) is a real, open gap this
  design does not close, not an already-covered one.
