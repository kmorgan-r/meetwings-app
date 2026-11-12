CREATE TABLE IF NOT EXISTS calendar_snapshots (
  conversation_id TEXT PRIMARY KEY,
  snapshot_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
ALTER TABLE notion_sends ADD COLUMN calendar_json TEXT;
