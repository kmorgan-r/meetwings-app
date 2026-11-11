-- Migration 17: a second, Notion lane on the Odoo queue, plus the send record.
--
-- meeting_log_queue.notion_status (NULL = not Notion-bound):
--   held | offered | waiting | joined | cancelled
-- notion_sends.status:
--   retry | sending | failed | no_summary | sent | already | cancelled
-- No BEGIN/COMMIT: the migration runner wraps each file in a transaction.

ALTER TABLE meeting_log_queue ADD COLUMN notion_status TEXT;
ALTER TABLE meeting_log_queue ADD COLUMN notion_send_id TEXT;
CREATE INDEX IF NOT EXISTS idx_mlq_notion ON meeting_log_queue(notion_status, conversation_id);
CREATE INDEX IF NOT EXISTS idx_mlq_notion_send ON meeting_log_queue(notion_send_id);

CREATE TABLE IF NOT EXISTS notion_sends (
  id TEXT PRIMARY KEY,              -- the earliest joined row's id
  conversation_id TEXT,
  status TEXT NOT NULL,             -- retry|sending|failed|no_summary|sent|already|cancelled
  span_start_at INTEGER NOT NULL, span_end_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0, summary_failures INTEGER NOT NULL DEFAULT 0,
  claimed_at INTEGER, next_at INTEGER,
  error_code TEXT, practices_error_code TEXT,
  summary_json TEXT,
  create_started_at INTEGER, page_id TEXT, page_url TEXT, page_created_time TEXT,
  lost_to_url TEXT,
  body_done INTEGER NOT NULL DEFAULT 0, toggle_block_id TEXT,
  transcript_done INTEGER NOT NULL DEFAULT 0, practices_done INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, sent_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_notion_sends_due ON notion_sends(status, next_at);
