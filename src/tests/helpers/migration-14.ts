import { readFileSync } from "node:fs";
import path from "node:path";
import initSqlJs, { type Database } from "sql.js";

// Shared by meeting-log.action.test.ts and odoo-contacts.action.test.ts (Task
// 4), which each build their own sql.js database. Declaring these as
// unexported top-level consts in one test file would leave the other unable
// to import them.

export const MIGRATIONS = path.resolve(__dirname, "../../../src-tauri/src/db/migrations");

const WASM_BINARY = path.resolve(__dirname, "../../../node_modules/sql.js/dist/sql-wasm.wasm");

const INSTANCE = "http://h:8069|odoo";
const NOW = 1_700_000_000_000;

// Use this everywhere a migration file is read - never a bare relative path -
// so every load goes through the one MIGRATIONS constant.
export const readMigration = (name: string) => readFileSync(path.join(MIGRATIONS, name), "utf8");

// Reads the real migration file, so the test can never drift from what ships.
export function applyMigration14(db: Database) {
  db.exec(readMigration("odoo-multi-target.sql"));
}

/** Reads a query back as plain row objects, for asserting on tables no
 * exported action function reads (meeting_log_targets, odoo_selected_targets). */
export function rows(db: Database, sql: string): Record<string, unknown>[] {
  const stmt = db.prepare(sql);
  const out: Record<string, unknown>[] = [];
  while (stmt.step()) out.push(stmt.getAsObject());
  stmt.free();
  return out;
}

// Mirrors the shared beforeEach in meeting-log.action.test.ts (chat-history,
// chat-history-v8, odoo-contacts = migration 11, meeting-log-queue =
// migration 12) so seedPre14's database matches what the app actually has
// applied before migration 14 ever runs.
async function freshDb(): Promise<Database> {
  const wasmBinary = readFileSync(WASM_BINARY);
  const SQL = await initSqlJs({ wasmBinary });
  const db = new SQL.Database();
  db.run(readMigration("chat-history.sql"));
  db.run(readMigration("chat-history-v8.sql"));
  db.run(readMigration("odoo-contacts.sql"));
  db.run(readMigration("meeting-log-queue.sql"));
  return db;
}

interface PreQueueRow {
  id: string;
  contact_id: number | null;
  lead_id: number | null;
  status: string;
  attachment_id?: number | null;
  message_id?: number | null;
}

/** Raw INSERT into meeting_log_queue in the pre-14 shape - the same style as
 * meeting-log.action.test.ts's own seed(), which inserts into already-existing
 * tables and applies no migrations of its own. */
function insertPreQueueRow(db: Database, r: PreQueueRow) {
  const row = {
    id: r.id,
    session_key: `session-${r.id}`,
    conversation_id: null,
    instance: INSTANCE,
    contact_id: r.contact_id,
    lead_id: r.lead_id,
    transcript: "t",
    transcript_start_at: 1,
    transcript_end_at: 2,
    summary_json: null,
    attachment_id: r.attachment_id ?? null,
    message_id: r.message_id ?? null,
    status: r.status,
    attempts: 0,
    claimed_at: null,
    last_error: null,
    last_error_code: null,
    meeting_started_at: 1,
    created_at: NOW,
    sent_at: null,
  };
  db.run(
    `INSERT INTO meeting_log_queue (${Object.keys(row).join(",")}) ` +
      `VALUES (${Object.keys(row).map(() => "?").join(",")})`,
    Object.values(row) as never[],
  );
}

// Migrations 11 and 12 come from freshDb(). Migration 13 does NOT - and
// migration 14's singleton backfill reads lead_name, which only 13 creates.
export async function seedPre14(queueRows: PreQueueRow[]): Promise<Database> {
  const db = await freshDb();
  db.exec(readMigration("odoo-lead-only-target.sql")); // migration 13
  for (const r of queueRows) insertPreQueueRow(db, r);
  return db;
}

interface PreSingletonRow {
  instance: string;
  contact_id: number | null;
  lead_id: number | null;
  lead_name: string | null;
}

export async function seedPre14Singleton(row: PreSingletonRow): Promise<Database> {
  const db = await seedPre14([]);
  db.run(
    `INSERT INTO odoo_selected_target
       (id, instance, contact_id, lead_id, lead_name, conversation_id, selected_at)
     VALUES ('current', ?, ?, ?, ?, NULL, 0)`,
    [row.instance, row.contact_id, row.lead_id, row.lead_name],
  );
  return db;
}
