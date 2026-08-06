-- Adopt Summary Titles (Migration v10)
-- Backfills the rename that saveSummarizationResult now performs when a summary
-- is created, for the summaries that already exist.
--
-- Without it the same meeting keeps two unrelated names: the conversation is
-- titled from whatever text started it (a quick action's own label, hence every
-- old conversation called "What should I say?") or by the AI titler reading only
-- the opening messages, while its summary is named from the whole conversation.
-- Neither page can then be used to find the meeting in the other.
--
-- Safe to overwrite because every conversation title in the system is
-- machine-generated — conversation creation and the AI titler are the only
-- writers, there is no manual rename.

UPDATE conversations
SET title = (
  SELECT s.title FROM meeting_summaries s
  WHERE s.conversation_id = conversations.id
    AND s.title IS NOT NULL
    AND TRIM(s.title) <> ''
  ORDER BY s.created_at DESC
  LIMIT 1
)
WHERE EXISTS (
  SELECT 1 FROM meeting_summaries s
  WHERE s.conversation_id = conversations.id
    AND s.title IS NOT NULL
    AND TRIM(s.title) <> ''
);
