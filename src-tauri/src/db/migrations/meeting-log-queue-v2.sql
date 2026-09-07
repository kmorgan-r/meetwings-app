-- Migration 16: meeting_summaries (keyed by conversation_id) replaces
-- meeting_log_queue.summary_json as the one cache/source of truth for a
-- meeting's AI summary.
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
  -- q.summary_json is AI-generated text written via setSummaryJson with no
  -- schema validation at write time. json_extract() RAISES on malformed JSON,
  -- and this migration runs inside sqlx's one transaction per file - any
  -- error here rolls back the WHOLE migration and it is never recorded as
  -- applied, permanently breaking Database.load() for that user on every
  -- future launch. json_valid() excludes malformed rows before json_extract
  -- ever runs on them (SQLite only evaluates the SELECT list for rows that
  -- already passed WHERE).
  AND json_valid(q.summary_json)
  -- meeting_summaries.summary is NOT NULL. Valid JSON with no "summary" key
  -- (or an explicit null) makes json_extract(...,'$.summary') return NULL,
  -- which would fail that NOT NULL constraint and abort the migration exactly
  -- as above - guard it the same way.
  AND json_extract(q.summary_json, '$.summary') IS NOT NULL
  -- session_key, not conversation_id, is what's UNIQUE on this table - one
  -- conversation can own several queue rows. meeting_summaries.conversation_id
  -- IS UNIQUE, so backfilling every matching row would violate it on the
  -- second row for a repeat conversation. Keep only the newest cached row
  -- per conversation (rowid tiebreak so two rows with an identical
  -- created_at still resolve to exactly one) - considering only rows that
  -- pass the same two guards, so a malformed or summary-less newest row never
  -- shadows a usable older one.
  AND q.rowid = (
    SELECT q2.rowid FROM meeting_log_queue q2
    WHERE q2.conversation_id = q.conversation_id
      AND q2.summary_json IS NOT NULL
      AND json_valid(q2.summary_json)
      AND json_extract(q2.summary_json, '$.summary') IS NOT NULL
    ORDER BY q2.created_at DESC, q2.rowid DESC LIMIT 1
  )
  AND NOT EXISTS (
    SELECT 1 FROM meeting_summaries s WHERE s.conversation_id = q.conversation_id
  );

ALTER TABLE meeting_log_queue DROP COLUMN summary_json;
