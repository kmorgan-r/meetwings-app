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
  created_at, updated_at
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
  0, q.created_at, q.created_at
FROM meeting_log_queue q
WHERE q.summary_json IS NOT NULL
  AND q.conversation_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM meeting_summaries s WHERE s.conversation_id = q.conversation_id
  );

ALTER TABLE meeting_log_queue DROP COLUMN summary_json;
```

(`id` here is a raw hex blob, not app's dashed `crypto.randomUUID()` format —
cosmetic only, `id` is an opaque `TEXT PRIMARY KEY`; fine to leave or fix to
match at implementation time.)

Backfill exists so a row mid-retry at upgrade time (queued with a cached
summary, not yet sent) doesn't lose that cache and trigger a second AI call
right after the upgrade. Rows whose `conversation_id IS NULL` (the rare
recovery-path case, see Error handling) are not backfilled — nothing to key
them on — and simply regenerate on next push, same as today.

`setSummaryJson` (`meeting-log.action.ts:776`) and the `summary_json` field on
`NewQueueRow`/`DbMeetingLogRow` are removed.

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
  providerConfig?: ProviderConfig
): Promise<SummarizationResult | null>
```

Behavior:
1. If `conversationId` is non-null, look up `getMeetingSummaryByConversation`
   first. A hit returns its fields as `SummarizationResult` — no AI call.
2. On a miss (or `conversationId === null`), gate on entry count (proposing
   `entries.length >= 4`, an even trade for today's `MIN_EXCHANGES_FOR_SUMMARY
   = 2` exchanges / 4 messages — tunable, not load-bearing). Below the gate,
   return `null` without calling the AI.
3. Build the prompt from `renderTranscript(entries)` (speaker-labeled), same
   as today's Odoo path — not `formatConversationForSummary`.
4. On a successful result: if `conversationId` is non-null, persist via
   `saveSummarizationResult` (unchanged — this is what drives entity
   extraction, knowledge-profile compaction, and title-adoption). If
   `conversationId` is null, return the result without persisting.
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

## Trigger

`summarizeCurrentConversation` (`useCompletion.ts:1358`) keeps its existing
call sites — `loadConversation` (`:1408`) and `startNewConversation`
(`:1441`) — because those already fire at the right lifecycle point (leaving
a conversation), independent of Odoo. Its body changes from building
`messages` out of `conversationHistory` to calling `ensureMeetingSummary`
with `meetingTranscript` (already in scope in this hook) and
`state.currentConversationId`.

`useMeetingLog.ts`'s Odoo `trigger` (around `:280-400`) is untouched in
structure — it still does its own watermark-sliced transcript for the Odoo
push/attachment — but the `deps.summarize` it hands to `pushQueuedRow` now
simply calls `ensureMeetingSummary(row.conversationId, slice.entries,
providerConfig)`. Because `summarizeCurrentConversation` typically runs first
(meeting end happens before/around the Odoo push claim), the push path
usually hits the cache; if it runs first instead (fast push, slow UI
lifecycle), it generates and persists, and the later
`summarizeCurrentConversation` call then hits the cache instead. Either order
is correct and idempotent — `meeting_summaries.conversation_id` is `UNIQUE`.

## Entity extraction / knowledge profile

No design change — `createOrUpdateKnowledgeEntity` /`createEntityMention`
(`meeting-context.action.ts:409`, `:550`) stay wired exactly where they are,
inside the save step `ensureMeetingSummary` now shares. The only behavioral
change is coverage: entities now get extracted for every summarized meeting,
including ones where the user never typed a chat question — previously those
were invisible to Context Memory entirely.

## Dashboard expand button

`QueueRow.tsx` / `ConversationRow.tsx` (`src/pages/meetings/components/`)
already carry `conversation_id` per row (`MeetingLogListRow`). Add an expand
affordance that, on open, calls `getMeetingSummaryByConversation(conversationId)`
and renders the result inline.

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
  (no AI call), cache miss + gate below threshold (no AI call, returns null),
  cache miss + gate met (AI call, persists, entity extraction fires),
  `conversationId === null` (AI call, no persist), AI failure (returns null,
  never throws).
- `odoo-meeting-log-push.test.ts`: update the `summarize` dependency's shape
  in test fakes to match "look up or generate," not "always generate" —
  existing assertions on `subtype_xmlid`/`body_is_html` etc. are unaffected.
- Migration test: seed a `meeting_log_queue` row with `summary_json` and no
  matching `meeting_summaries` row, run the migration, assert the row lands in
  `meeting_summaries` and the column is gone.
- New render test for the dashboard expand: renders summary content when
  present, "no summary" state when absent, and doesn't fetch until expanded.

## Out of scope

- Reworking `buildNoteBody`'s HTML rendering (already fixed separately, PR
  #56).
- Any change to the Odoo watermark/dedup logic in `useMeetingLog.ts`'s
  `trigger` — that machinery is specific to not double-posting Odoo notes and
  is untouched here.
- Backfilling entity extraction retroactively for old `meeting_summaries` rows
  created before this change (they already ran extraction under the old chat
  path — no gap to fill).
