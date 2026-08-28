-- Odoo multi-target assignment (migration 14).
--
-- NEVER EDIT THIS FILE AFTER RELEASE. sqlx checksums applied migrations; a
-- changed checksum fails Database.load, which is the single gate for chat
-- history, prompts, cost tracking and meeting context - the whole app's
-- persistence, not just this feature.
--
-- Replaces the odoo_selected_target singleton with a set, and gives each
-- queued meeting a child row per Odoo record it must reach.

CREATE TABLE IF NOT EXISTS odoo_selected_targets (
  instance        TEXT NOT NULL,
  model           TEXT NOT NULL,      -- 'res.partner' | 'crm.lead'
  res_id          INTEGER NOT NULL,
  name            TEXT,
  conversation_id TEXT,
  selected_at     INTEGER NOT NULL,
  PRIMARY KEY (instance, model, res_id)
);

CREATE TABLE IF NOT EXISTS meeting_log_targets (
  id              TEXT NOT NULL PRIMARY KEY,
  row_id          TEXT NOT NULL,
  model           TEXT NOT NULL,
  res_id          INTEGER NOT NULL,
  name            TEXT,
  status          TEXT NOT NULL DEFAULT 'pending',   -- pending | sent | failed
  attachment_id   INTEGER,
  message_id      INTEGER,
  last_error      TEXT,
  last_error_code TEXT,
  created_at      INTEGER NOT NULL,
  sent_at         INTEGER,
  UNIQUE (row_id, model, res_id)
);

-- No separate index on row_id: UNIQUE (row_id, model, res_id) already creates
-- one with row_id leftmost, which serves every WHERE row_id = ? lookup.

-- Backfill the queue. A row with NEITHER id set is an unassigned meeting and
-- produces NO target - sending it down the res.partner branch would write
-- res_id = NULL against NOT NULL and abort the whole migration.
INSERT OR IGNORE INTO meeting_log_targets (id, row_id, model, res_id, name, status,
                                           attachment_id, message_id, created_at, sent_at)
SELECT hex(randomblob(16)),
       id,
       CASE WHEN lead_id IS NOT NULL THEN 'crm.lead' ELSE 'res.partner' END,
       COALESCE(lead_id, contact_id),
       NULL,
       CASE status WHEN 'sent' THEN 'sent' WHEN 'failed' THEN 'failed'
                   ELSE 'pending' END,
       attachment_id, message_id, created_at, sent_at
  FROM meeting_log_queue
 WHERE contact_id IS NOT NULL OR lead_id IS NOT NULL;

-- Migrate the singleton by the same coalesce rule and the same gate. A
-- both-NULL singleton cannot be written by this app, but loadTarget already
-- guards against reading one back, so the gate costs one clause and the
-- absence of it costs Database.load.
INSERT OR IGNORE INTO odoo_selected_targets (instance, model, res_id, name,
                                             conversation_id, selected_at)
SELECT instance,
       CASE WHEN lead_id IS NOT NULL THEN 'crm.lead' ELSE 'res.partner' END,
       COALESCE(lead_id, contact_id),
       CASE WHEN lead_id IS NOT NULL THEN lead_name ELSE NULL END,
       conversation_id,
       selected_at
  FROM odoo_selected_target
 WHERE contact_id IS NOT NULL OR lead_id IS NOT NULL;

DROP TABLE IF EXISTS odoo_selected_target;
