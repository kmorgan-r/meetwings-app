import type { DbOdooContact, OdooContact, ResolvedTarget } from "@/types";
import { getDatabase } from "./config";

/**
 * All SQLite access for the Odoo cache.
 *
 * Every read is scoped to an `instance` fingerprint. See
 * odoo-config.storage.ts for why.
 */

const CLAIM_TIMEOUT_MS = 10 * 60 * 1000;

export interface DbSyncState {
  last_write_date: string | null;
  last_sync_at: number | null;
  last_error_code: string | null;
  last_error_at: number | null;
  skipped_rows: number;
  running_since: number | null;
}

function toContact(row: DbOdooContact): OdooContact {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    companyName: row.company_name,
    parentId: row.parent_id,
    isCompany: row.is_company === 1,
    active: row.active === 1,
    writeDate: row.write_date,
    isColleague: row.is_colleague === 1,
    lastMeetingAt: row.last_meeting_at,
  };
}

/**
 * THE UPSERT NAMES ITS COLUMNS, AND is_colleague / last_meeting_at ARE NOT
 * AMONG THEM. Do not "simplify" this to INSERT OR REPLACE.
 *
 * INSERT OR REPLACE deletes the conflicting row and inserts a fresh one, so
 * every colleague mark and every recency stamp is erased on the next sync -
 * silently, and only for the contacts that happened to be edited in Odoo. That
 * is the hardest possible version of the bug to notice, which is why
 * src/tests/odoo-contacts.action.test.ts pins it against a real engine.
 *
 * The trailing WHERE is what makes Refresh's count honest: the sync
 * deliberately re-pulls the boundary second on every run (see the watermark
 * rule), so a blind DO UPDATE would report rows changed when nothing changed
 * in Odoo. IS NOT rather than <> so it is also correct against NULLs.
 */
const UPSERT_SQL = `
INSERT INTO odoo_contacts (instance, id, name, email, phone, company_name,
                           parent_id, is_company, active, write_date, synced_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(instance, id) DO UPDATE SET
  name=excluded.name, email=excluded.email, phone=excluded.phone,
  company_name=excluded.company_name, parent_id=excluded.parent_id,
  is_company=excluded.is_company, active=excluded.active,
  write_date=excluded.write_date, synced_at=excluded.synced_at
WHERE odoo_contacts.write_date IS NOT excluded.write_date`;

/** Returns the number of rows whose write_date actually changed. */
export async function upsertContacts(
  instance: string,
  rows: OdooContact[],
  syncedAt: number
): Promise<number> {
  const db = await getDatabase();

  // NO `BEGIN` / `COMMIT` HERE, DELIBERATELY. Do not "improve" this into a
  // transaction - it is a correctness regression, not an optimisation.
  //
  // `getDatabase()` returns a plugin-sql handle whose every `db.execute` is an
  // independent IPC call, and the Rust side runs each one against a POOL, not a
  // connection: tauri-plugin-sql 2.3.0 holds a `Pool<Sqlite>` built by
  // `Pool::connect` (sqlx default max_connections = 10) and does
  // `pool.execute(query)` per call. There is no connection pinning on the JS
  // surface. So `BEGIN`, the row upserts and `COMMIT` can each land on a
  // DIFFERENT connection as soon as any other DB work is in flight - and there
  // is plenty: chat-history writes on every streamed message, and the dashboard
  // window shares the same file. The failure modes are all worse than the
  // problem: COMMIT throws "cannot commit - no transaction is active", and the
  // connection that ran BEGIN returns to the pool holding an OPEN WRITE
  // TRANSACTION, so every later write in the app gets SQLITE_BUSY until
  // restart. A page-level test cannot see any of it - sql.js is a single
  // in-process connection, so BEGIN/COMMIT always pair there.
  //
  // Atomicity is not needed anyway: a half-written page is safe because
  // `finishSync` runs only after the WHOLE run, so a failed run leaves the
  // watermark unadvanced and the page is simply re-pulled. This is also why
  // the rest of this codebase uses no SQL transactions either - see
  // chat-history.action.ts:128-196, which uses a compensating delete.
  //
  // The per-row loop is required regardless: the guarded upsert's
  // `WHERE ... IS NOT excluded...` needs per-row `rowsAffected` to count what
  // genuinely CHANGED, and a multi-row VALUES form reports one total that
  // cannot tell a changed row from a skipped one. That count is what the
  // settings page reports.
  let changed = 0;
  for (const row of rows) {
    const result = await db.execute(UPSERT_SQL, [
      instance,
      row.id,
      row.name,
      row.email,
      row.phone,
      row.companyName,
      row.parentId,
      row.isCompany ? 1 : 0,
      row.active ? 1 : 0,
      row.writeDate,
      syncedAt,
    ]);
    changed += result.rowsAffected ?? 0;
  }
  return changed;
}

export async function listContacts(instance: string): Promise<OdooContact[]> {
  const db = await getDatabase();
  const rows = await db.select<DbOdooContact[]>(
    "SELECT * FROM odoo_contacts WHERE instance = ?",
    [instance]
  );
  return rows.map(toContact);
}

export async function setColleague(
  instance: string,
  id: number,
  isColleague: boolean
): Promise<void> {
  const db = await getDatabase();
  await db.execute(
    "UPDATE odoo_contacts SET is_colleague = ? WHERE instance = ? AND id = ?",
    [isColleague ? 1 : 0, instance, id]
  );
}

export async function stampLastMeeting(
  instance: string,
  id: number,
  at: number
): Promise<void> {
  const db = await getDatabase();
  await db.execute(
    "UPDATE odoo_contacts SET last_meeting_at = ? WHERE instance = ? AND id = ?",
    [at, instance, id]
  );
}

export async function getSyncState(instance: string): Promise<DbSyncState | null> {
  const db = await getDatabase();
  const rows = await db.select<DbSyncState[]>(
    "SELECT last_write_date, last_sync_at, last_error_code, last_error_at, skipped_rows, running_since FROM odoo_sync_state WHERE instance = ? AND model = 'res.partner'",
    [instance]
  );
  return rows[0] ?? null;
}

/**
 * Cross-window single-flight. An UPSERT, not a bare UPDATE: on the first sync
 * for an instance no row exists, so a conditional UPDATE would match zero rows
 * and the very first sync would refuse itself forever.
 */
export async function claimSync(instance: string, now: number): Promise<boolean> {
  const db = await getDatabase();
  const result = await db.execute(
    `INSERT INTO odoo_sync_state (instance, model, running_since)
     VALUES (?, 'res.partner', ?)
     ON CONFLICT(instance, model) DO UPDATE SET running_since = excluded.running_since
     WHERE odoo_sync_state.running_since IS NULL
        OR odoo_sync_state.running_since < ?`,
    [instance, now, now - CLAIM_TIMEOUT_MS]
  );
  return (result.rowsAffected ?? 0) > 0;
}

/** Called in a `finally`, on success AND on failure. */
export async function releaseSync(instance: string): Promise<void> {
  const db = await getDatabase();
  await db.execute(
    "UPDATE odoo_sync_state SET running_since = NULL WHERE instance = ? AND model = 'res.partner'",
    [instance]
  );
}

/**
 * A completed run advances the watermark AND clears the error markers.
 *
 * `watermark` is `string | null` and NOT `string`. A first run that legitimately
 * returns zero partners has no max(write_date) and no previous watermark, so
 * there is nothing to store - and the empty string is not a stand-in for that.
 * Storing `''` makes the NEXT run send `["write_date", ">", ""]`, which Odoo
 * null-normalizes only for `=`/`!=` leaves, so it reaches PostgreSQL as an
 * invalid timestamp cast and faults - permanently, since a faulting run never
 * advances past it. `NULL` is the state that means "no watermark yet", and it
 * is the state the domain builder already tests for.
 */
export async function finishSync(
  instance: string,
  watermark: string | null,
  syncedAt: number,
  skipped: number
): Promise<void> {
  const db = await getDatabase();
  await db.execute(
    `INSERT INTO odoo_sync_state (instance, model, last_write_date, last_sync_at,
                                  last_error_code, last_error_at, skipped_rows)
     VALUES (?, 'res.partner', ?, ?, NULL, NULL, ?)
     ON CONFLICT(instance, model) DO UPDATE SET
       last_write_date = excluded.last_write_date,
       last_sync_at    = excluded.last_sync_at,
       last_error_code = NULL,
       last_error_at   = NULL,
       skipped_rows    = excluded.skipped_rows`,
    [instance, watermark, syncedAt, skipped]
  );
}

/** A failed run leaves last_write_date untouched. */
export async function failSync(
  instance: string,
  code: string,
  at: number
): Promise<void> {
  const db = await getDatabase();
  await db.execute(
    `INSERT INTO odoo_sync_state (instance, model, last_error_code, last_error_at)
     VALUES (?, 'res.partner', ?, ?)
     ON CONFLICT(instance, model) DO UPDATE SET
       last_error_code = excluded.last_error_code,
       last_error_at   = excluded.last_error_at`,
    [instance, code, at]
  );
}

export async function purgeOtherInstances(instance: string): Promise<void> {
  const db = await getDatabase();
  // meeting_log_queue is DELIBERATELY NOT PURGED HERE. It is the one table
  // whose other-instance rows must survive a credentials change: a queued
  // meeting is unlogged WORK, not a cache, and this function runs on every sync
  // (contacts-sync.ts:106). Deleting those rows would destroy exactly what the
  // write-ahead queue exists to protect, on a routine credentials edit. The
  // push re-checks `instance` before every write instead, and the /odoo page
  // surfaces the stranded rows under their own wording.
  await db.execute("DELETE FROM odoo_contacts WHERE instance <> ?", [instance]);
  await db.execute("DELETE FROM odoo_sync_state WHERE instance <> ?", [instance]);
  await db.execute("DELETE FROM odoo_selected_target WHERE instance <> ?", [instance]);
}

/**
 * The selected target is a SINGLETON row, id = 'current'.
 *
 * It is deliberately not keyed on a conversation id: currentConversationId
 * lives inside useCompletion (useCompletion.ts:118), starts null, is minted
 * lazily on the first submit, is reset by "new chat", and dies with the very
 * <Completion /> unmount this row exists to survive.
 *
 * contact_id and lead_id are always written TOGETHER. Patching one without the
 * other is how a target ends up naming two different customers.
 */
export async function saveTarget(
  target: ResolvedTarget & { instance: string; conversationId: string | null },
  at: number
): Promise<void> {
  const db = await getDatabase();
  await db.execute(
    `INSERT INTO odoo_selected_target (id, instance, contact_id, lead_id, lead_name, conversation_id, selected_at)
     VALUES ('current', ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       instance        = excluded.instance,
       contact_id      = excluded.contact_id,
       lead_id         = excluded.lead_id,
       lead_name       = excluded.lead_name,
       conversation_id = excluded.conversation_id,
       selected_at     = excluded.selected_at`,
    [
      target.instance,
      target.contactId,
      target.leadId,
      target.leadName,
      target.conversationId,
      at,
    ]
  );
}

export async function loadTarget(instance: string): Promise<ResolvedTarget | null> {
  const db = await getDatabase();
  const rows = await db.select<
    { contact_id: number | null; lead_id: number | null; lead_name: string | null }[]
  >(
    "SELECT contact_id, lead_id, lead_name FROM odoo_selected_target WHERE id = 'current' AND instance = ?",
    [instance]
  );
  const row = rows[0];
  if (!row) return null;
  // A row with NEITHER id is not a target. It cannot be written by this app -
  // `commit` clears instead - but reading it back as a target would hand slice
  // 2 something it can only file as unassigned while the picker claims a
  // selection.
  if (row.contact_id === null && row.lead_id === null) return null;
  return {
    contactId: row.contact_id,
    leadId: row.lead_id,
    leadName: row.lead_name,
  };
}

export async function clearTarget(): Promise<void> {
  const db = await getDatabase();
  await db.execute("DELETE FROM odoo_selected_target WHERE id = 'current'");
}
