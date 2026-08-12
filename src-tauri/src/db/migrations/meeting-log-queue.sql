-- Meeting log queue (migration 12).
--
-- NEVER EDIT THIS FILE AFTER RELEASE. sqlx checksums applied migrations; a
-- changed checksum fails Database.load, which is the single gate for chat
-- history, prompts, cost tracking and meeting context - the whole app's
-- persistence, not just this feature.
--
-- Write-ahead queue for meetings logged to Odoo. The row is written BEFORE any
-- operation that can fail, so a crash leaves a recoverable row rather than a
-- vanished meeting.
--
-- transcript_start_at / transcript_end_at are the MIN/MAX timestamps of the
-- transcript slice this row consumed. MAX(transcript_end_at) across the WHOLE
-- table is the watermark that separates one meeting from the next: the
-- in-memory meetingTranscript array is never cleared when a meeting ends
-- (setMeetingTranscript([]) exists only in clearMeetingTranscript), so without
-- this two consecutive meetings would share a first timestamp and the UNIQUE
-- index below would dedup two DIFFERENT meetings into one row.
--
-- status is one of: held, pending, sending, unassigned, sent, failed, cancelled.

CREATE TABLE IF NOT EXISTS meeting_log_queue (
  id                  TEXT NOT NULL PRIMARY KEY,
  session_key         TEXT NOT NULL UNIQUE,
  conversation_id     TEXT,
  instance            TEXT NOT NULL,
  contact_id          INTEGER,
  lead_id             INTEGER,
  transcript          TEXT NOT NULL,
  transcript_start_at INTEGER NOT NULL,
  transcript_end_at   INTEGER NOT NULL,
  summary_json        TEXT,
  attachment_id       INTEGER,
  message_id          INTEGER,
  status              TEXT NOT NULL DEFAULT 'held',
  attempts            INTEGER NOT NULL DEFAULT 0,
  claimed_at          INTEGER,
  last_error          TEXT,
  last_error_code     TEXT,
  meeting_started_at  INTEGER,
  created_at          INTEGER NOT NULL,
  sent_at             INTEGER
);

CREATE INDEX IF NOT EXISTS idx_meeting_log_queue_status
  ON meeting_log_queue (instance, status);
CREATE INDEX IF NOT EXISTS idx_meeting_log_queue_watermark
  ON meeting_log_queue (transcript_end_at);
