-- Odoo contact cache (migration 11).
--
-- NEVER EDIT THIS FILE AFTER RELEASE. sqlx checksums applied migrations; a
-- changed checksum fails Database.load, which is the single gate for chat
-- history, prompts, cost tracking and meeting context - the whole app's
-- persistence, not just this feature.
--
-- `instance` is a 'normalizedUrl|db' fingerprint. Without it, pointing the app
-- at a staging database and back leaves a cache of ids that name different
-- partners, and the advanced watermark means it is never re-pulled.

CREATE TABLE IF NOT EXISTS odoo_contacts (
  instance        TEXT NOT NULL,
  id              INTEGER NOT NULL,
  name            TEXT NOT NULL,
  email           TEXT,
  phone           TEXT,
  company_name    TEXT,
  parent_id       INTEGER,
  is_company      INTEGER NOT NULL DEFAULT 0,
  active          INTEGER NOT NULL DEFAULT 1,
  write_date      TEXT NOT NULL,
  is_colleague    INTEGER NOT NULL DEFAULT 0,
  last_meeting_at INTEGER,
  synced_at       INTEGER NOT NULL,
  PRIMARY KEY (instance, id)
);
CREATE INDEX IF NOT EXISTS idx_odoo_contacts_name  ON odoo_contacts(instance, name);
CREATE INDEX IF NOT EXISTS idx_odoo_contacts_email ON odoo_contacts(instance, email);

CREATE TABLE IF NOT EXISTS odoo_sync_state (
  instance        TEXT NOT NULL,
  model           TEXT NOT NULL,
  last_write_date TEXT,
  last_sync_at    INTEGER,
  last_error_code TEXT,
  last_error_at   INTEGER,
  skipped_rows    INTEGER NOT NULL DEFAULT 0,
  running_since   INTEGER,
  PRIMARY KEY (instance, model)
);

-- Exactly one row, id = 'current'. NOT NULL is explicit because in SQLite a
-- non-INTEGER PRIMARY KEY does NOT imply it, and null-keyed ghost rows would
-- accumulate silently.
CREATE TABLE IF NOT EXISTS odoo_selected_target (
  id              TEXT NOT NULL PRIMARY KEY,
  instance        TEXT NOT NULL,
  contact_id      INTEGER NOT NULL,
  lead_id         INTEGER,
  conversation_id TEXT,
  selected_at     INTEGER NOT NULL
);
