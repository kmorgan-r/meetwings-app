-- Lead-only selections (migration 13).
--
-- NEVER EDIT THIS FILE AFTER RELEASE. sqlx checksums applied migrations; a
-- changed checksum fails Database.load, which is the single gate for chat
-- history, prompts, cost tracking and meeting context - the whole app's
-- persistence, not just this feature.
--
-- Migration 11 declared `contact_id INTEGER NOT NULL`, which was true of every
-- target the picker could produce: you chose a res.partner, and only then an
-- optional crm.lead hanging off it. It is not true of a LEAD. Odoo's default
-- for an unconverted lead is free-text contact details and no partner at all,
-- so a meeting about one has a crm.lead to land on and no res.partner behind
-- it - and NOT NULL made that selection unstorable, not merely unrepresented.
--
-- `lead_name` exists because nothing else can name such a target. A contact
-- target is named from the synced contact cache; a lead is not in that cache
-- by definition, and the opportunity list is in-memory state that a
-- <Completion /> remount destroys. Without the name persisted beside the id,
-- a rehydrated lead-only target renders as "Who are you meeting?" while a
-- meeting is queued against it.
--
-- SQLite cannot drop a NOT NULL constraint in place, so this is the standard
-- rebuild. Rows are carried across rather than dropped: the row holds the
-- contact for the NEXT meeting, and losing it on upgrade would silently
-- unassign a meeting the user had already set up.

CREATE TABLE IF NOT EXISTS odoo_selected_target_v13 (
  id              TEXT NOT NULL PRIMARY KEY,
  instance        TEXT NOT NULL,
  contact_id      INTEGER,
  lead_id         INTEGER,
  lead_name       TEXT,
  conversation_id TEXT,
  selected_at     INTEGER NOT NULL
);

INSERT OR REPLACE INTO odoo_selected_target_v13
  (id, instance, contact_id, lead_id, lead_name, conversation_id, selected_at)
SELECT id, instance, contact_id, lead_id, NULL, conversation_id, selected_at
FROM odoo_selected_target;

DROP TABLE IF EXISTS odoo_selected_target;

ALTER TABLE odoo_selected_target_v13 RENAME TO odoo_selected_target;
