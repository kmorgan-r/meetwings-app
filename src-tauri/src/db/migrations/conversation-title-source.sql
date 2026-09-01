-- Conversation title provenance (migration 15).
--
-- NEVER EDIT THIS FILE AFTER RELEASE. sqlx checksums applied migrations; a
-- changed checksum fails Database.load, which is the single gate for chat
-- history, prompts, cost tracking and meeting context - the whole app's
-- persistence, not just this feature.
--
-- DEFAULT 'auto' leaves every existing row behaving exactly as it does now:
-- the automatic titlers keep winning until a human renames a conversation.
ALTER TABLE conversations ADD COLUMN title_source TEXT NOT NULL DEFAULT 'auto';
