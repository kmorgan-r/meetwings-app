-- Meeting Summary Timing (Migration v9)
-- Records when the meeting itself happened, separately from when its summary
-- row was written.
--
-- created_at is the write time and must stay that way: knowledge compaction
-- uses it as a watermark (`created_at > last_compacted`), so repurposing it
-- would re-compact or silently skip summaries. But the write time is a poor
-- date for the UI, because the "Update Knowledge" backfill summarizes
-- arbitrarily old conversations at today's timestamp — a January meeting can
-- carry a July created_at.

ALTER TABLE meeting_summaries ADD COLUMN meeting_started_at INTEGER;
ALTER TABLE meeting_summaries ADD COLUMN meeting_ended_at INTEGER;

-- Backfill from the conversation's own messages. Summaries whose conversation
-- was deleted, or that never had messages, keep NULL and fall back to
-- created_at wherever they're displayed or ordered.
UPDATE meeting_summaries
SET
  meeting_started_at = (
    SELECT MIN(m.timestamp) FROM messages m
    WHERE m.conversation_id = meeting_summaries.conversation_id
  ),
  meeting_ended_at = (
    SELECT MAX(m.timestamp) FROM messages m
    WHERE m.conversation_id = meeting_summaries.conversation_id
  );

-- duration_seconds has existed since v7 but nothing ever wrote it, so every
-- row is NULL and the duration badge never rendered. The window supplies it.
-- +500 rounds to the nearest second, matching createMeetingSummary.
UPDATE meeting_summaries
SET duration_seconds = (meeting_ended_at - meeting_started_at + 500) / 1000
WHERE duration_seconds IS NULL
  AND meeting_started_at IS NOT NULL
  AND meeting_ended_at > meeting_started_at;

CREATE INDEX IF NOT EXISTS idx_meeting_summaries_meeting_started_at
  ON meeting_summaries(meeting_started_at);
