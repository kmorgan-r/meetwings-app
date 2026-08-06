-- Persist who spoke each message.
--
-- Meeting transcripts capture a speaker per segment (you via the microphone,
-- others via system audio), but messages only ever stored role/content, so a
-- saved conversation collapsed every participant into an indistinguishable
-- role:"user". These columns keep that distinction on disk.
--
-- speaker holds the SpeakerInfo object as JSON, matching how attached_files
-- already stores structured data on this table. Both are nullable: rows written
-- before this migration have no speaker to record, and typed chat messages
-- never have one.
ALTER TABLE messages ADD COLUMN speaker TEXT;
ALTER TABLE messages ADD COLUMN audio_source TEXT;
