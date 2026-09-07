import { readFileSync } from "node:fs";
import initSqlJs, { type Database } from "sql.js";
import path from "node:path";
import { MIGRATIONS, readMigration } from "./migration-14";

const WASM_BINARY = path.resolve(__dirname, "../../../node_modules/sql.js/dist/sql-wasm.wasm");
export const INSTANCE = "http://h:8069|odoo";

// Every migration through 15, in registration order, so the pre-16 database
// this helper builds matches what a real app has on disk before v16 runs.
const PRE_16_FILES = [
  "system-prompts.sql",
  "chat-history.sql",
  "api-usage.sql",
  "api-usage-v2.sql",
  "api-usage-v3.sql",
  "meeting-context.sql",
  "meeting-context-v7.sql",
  "chat-history-v8.sql",
  "meeting-context-v9.sql",
  "meeting-context-v10.sql",
  "odoo-contacts.sql",
  "meeting-log-queue.sql",
  "odoo-lead-only-target.sql",
  "odoo-multi-target.sql",
  "conversation-title-source.sql",
];

async function freshDbThrough15(): Promise<Database> {
  const wasmBinary = readFileSync(WASM_BINARY);
  const SQL = await initSqlJs({ wasmBinary });
  const db = new SQL.Database();
  for (const file of PRE_16_FILES) db.run(readMigration(file));
  return db;
}

export function applyMigration16(db: Database) {
  db.exec(readMigration("meeting-log-queue-v2.sql"));
}

export function rows(db: Database, sql: string): Record<string, unknown>[] {
  const stmt = db.prepare(sql);
  const out: Record<string, unknown>[] = [];
  while (stmt.step()) out.push(stmt.getAsObject());
  stmt.free();
  return out;
}

interface PreQueueRow16 {
  id: string;
  conversationId: string | null;
  summaryJson: string | null;
  createdAt?: number;
}

/** Inserts a meeting_log_queue row in the pre-16 shape (summary_json still a
 * real column at this point). Each call needs a unique session_key, which is
 * derived from id so callers don't have to think about it. */
function insertPreQueueRow(db: Database, r: PreQueueRow16, seq: number) {
  db.run(
    `INSERT INTO meeting_log_queue
       (id, session_key, conversation_id, instance, contact_id, lead_id,
        transcript, transcript_start_at, transcript_end_at, summary_json,
        attachment_id, message_id, status, attempts, claimed_at, last_error,
        last_error_code, meeting_started_at, created_at, sent_at)
     VALUES (?, ?, ?, ?, NULL, NULL, 't', 1, 2, ?, NULL, NULL, 'sent', 1,
             NULL, NULL, NULL, 1, ?, NULL)`,
    [
      r.id,
      `session-${r.id}-${seq}`,
      r.conversationId,
      INSTANCE,
      r.summaryJson,
      r.createdAt ?? 1_700_000_000_000 + seq,
    ]
  );
}

export async function seedPre16(queueRows: PreQueueRow16[]): Promise<Database> {
  const db = await freshDbThrough15();
  queueRows.forEach((r, i) => insertPreQueueRow(db, r, i));
  return db;
}

export async function seedPre16WithExistingSummary(
  conversationId: string,
  existingTitle: string
): Promise<Database> {
  const db = await freshDbThrough15();
  db.run(
    `INSERT INTO meeting_summaries
       (id, conversation_id, summary, title, exchange_count, created_at, updated_at)
     VALUES ('existing', ?, 'already here', ?, 0, 1, 1)`,
    [conversationId, existingTitle]
  );
  return db;
}
