import type { DbMeetingLogRow, MeetingLogStatus, TranscriptEntry } from "@/types";
import { ESCALATE_AFTER_ATTEMPTS, HOLD_MS, STALE_CLAIM_MS } from "@/lib/odoo/meeting-log";
import { getDatabase } from "./config";

/**
 * All SQLite access for the meeting log queue.
 *
 * NO `BEGIN` / `COMMIT` ANYWHERE IN THIS FILE, DELIBERATELY. Do not "improve"
 * any of these into a transaction - it is a correctness regression, not an
 * optimisation. `getDatabase()` returns a plugin-sql handle whose every
 * `db.execute` is an independent IPC call run against a `Pool<Sqlite>` with no
 * JS-side connection pinning, so BEGIN and COMMIT can land on DIFFERENT
 * connections: COMMIT throws, and the connection that ran BEGIN returns to the
 * pool holding an open write transaction, giving every later write in the app
 * SQLITE_BUSY until restart. The full reasoning is at
 * odoo-contacts.action.ts:72-100. The sql.js harness is a single in-process
 * connection and can never catch it, which is why QUEUE_SQL is exported and
 * scanned statically instead.
 *
 * Atomicity is not needed: the write-ahead row plus the per-row CAS is the
 * whole concurrency design. Nothing here writes two rows that must agree.
 */

export interface NewQueueRow {
  id: string;
  sessionKey: string;
  conversationId: string | null;
  instance: string;
  contactId: number | null;
  leadId: number | null;
  transcript: string;
  transcriptStartAt: number;
  transcriptEndAt: number;
  meetingStartedAt: number;
  status: Extract<MeetingLogStatus, "held" | "unassigned">;
  createdAt: number;
}

export interface QueueCounts {
  waiting: number;
  needsAttention: number;
  unassigned: number;
  otherInstance: number;
  lastError: string | null;
}

/**
 * Every statement, exported so the no-transaction guard can scan these VALUES.
 * A test that scanned the file text would fail on the warning comment above.
 */
export const QUEUE_SQL = {
  insert: `
INSERT INTO meeting_log_queue (id, session_key, conversation_id, instance, contact_id,
                               lead_id, transcript, transcript_start_at, transcript_end_at,
                               meeting_started_at, status, created_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(session_key) DO NOTHING`,

  // GLOBAL: no conversation_id predicate and no status predicate. See the
  // migration's header comment and sliceTranscript's doc comment.
  watermark: `SELECT COALESCE(MAX(transcript_end_at), 0) AS mark FROM meeting_log_queue`,

  byId: `SELECT * FROM meeting_log_queue WHERE id = ?`,

  // The claim. `attempts` moves HERE, before the first wire call - incrementing
  // afterwards under-reports exactly the failure mode that hard-kills the app.
  claim: `
UPDATE meeting_log_queue
   SET status = 'sending', claimed_at = ?, attempts = attempts + 1
 WHERE id = ? AND status IN ('pending', 'held')`,

  cancelHeld: `
UPDATE meeting_log_queue SET status = 'cancelled' WHERE id = ? AND status = 'held'`,

  toPending: `
UPDATE meeting_log_queue
   SET status = 'pending', last_error_code = ?, last_error = ?, claimed_at = NULL
 WHERE id = ?`,

  toFailed: `
UPDATE meeting_log_queue
   SET status = 'failed', last_error_code = ?, last_error = ?, claimed_at = NULL
 WHERE id = ?`,

  // Records WHY without moving the status. The pre-wire path needs this: it
  // never claims, so `attempts` never increments and the row can never reach
  // the "needs attention" group on its own - without the reason recorded, a
  // half-filled config leaves N meetings stuck and unexplained.
  recordError: `
UPDATE meeting_log_queue SET last_error_code = ?, last_error = ? WHERE id = ?`,

  // The sweep's not-configured case, in one statement rather than a loop.
  // Scoped to rows that could still be sent, so it cannot overwrite the
  // actionable error on a `failed` row that a user is trying to diagnose.
  recordErrorOnUnsent: `
UPDATE meeting_log_queue SET last_error_code = ?, last_error = ?
 WHERE status IN ('held','pending','sending')`,

  // The base of the stale-claim reclaim. It lives in QUEUE_SQL rather than
  // being built entirely inline so the static no-BEGIN/COMMIT guard - the only
  // check that exists for that rule - can see it. Only the generated
  // `AND id NOT IN (...)` fragment is appended at call time.
  reclaimBase: `
UPDATE meeting_log_queue SET status = 'pending'
 WHERE status = 'sending' AND claimed_at < ?`,

  // Clears the error columns, like finishSync does (odoo-contacts.action.ts:190-221).
  toSent: `
UPDATE meeting_log_queue
   SET status = 'sent', sent_at = ?, last_error = NULL, last_error_code = NULL,
       claimed_at = NULL
 WHERE id = ?`,

  setAttachment: `UPDATE meeting_log_queue SET attachment_id = ? WHERE id = ?`,
  setMessage: `UPDATE meeting_log_queue SET message_id = ? WHERE id = ?`,
  setSummary: `UPDATE meeting_log_queue SET summary_json = ? WHERE id = ?`,

  sweepable: `
SELECT * FROM meeting_log_queue
 WHERE instance = ?
   AND (status = 'pending' OR (status = 'held' AND created_at <= ?))
 ORDER BY created_at ASC`,

  heldInWindow: `
SELECT * FROM meeting_log_queue
 WHERE instance = ? AND status = 'held' AND created_at > ?
 ORDER BY created_at DESC LIMIT 1`,

  counts: `
SELECT
  SUM(CASE WHEN instance = ?1 AND status IN ('pending','held') AND attempts < ?2
           THEN 1 ELSE 0 END) AS waiting,
  SUM(CASE WHEN instance = ?1 AND (status = 'failed'
            OR (status = 'pending' AND attempts >= ?2)) THEN 1 ELSE 0 END) AS needs_attention,
  SUM(CASE WHEN instance = ?1 AND status = 'unassigned' THEN 1 ELSE 0 END) AS unassigned,
  -- The status predicate is NOT optional here. Nothing ever deletes queue rows
  -- (meeting_log_queue is deliberately exempt from purgeOtherInstances), so
  -- without it every historically 'sent' and 'cancelled' row from a previous
  -- database counts, and this number grows monotonically with the user's whole
  -- logging history.
  SUM(CASE WHEN instance <> ?1
            AND status IN ('held','pending','sending','unassigned')
           THEN 1 ELSE 0 END) AS other_instance
FROM meeting_log_queue`,

  // Only the statuses the sweep will ACTUALLY push, because the line this
  // feeds promises "finish setting Odoo up and they will be sent". `failed` is
  // terminal until slice 3's manual retry and `unassigned` needs a contact, not
  // credentials - counting either would make that promise routinely false.
  countAll: `
SELECT COUNT(*) AS n FROM meeting_log_queue
 WHERE status IN ('held','pending','sending')`,

  lastError: `
SELECT last_error FROM meeting_log_queue
 WHERE instance = ? AND last_error IS NOT NULL
   AND (status = 'failed' OR (status = 'pending' AND attempts >= ?))
 ORDER BY created_at DESC LIMIT 1`,

  meetingMessages: `
SELECT content, timestamp, speaker, audio_source FROM messages
 WHERE conversation_id = ? AND audio_source IS NOT NULL AND timestamp > ?
 ORDER BY timestamp ASC`,
} as const;

function toRow(raw: Record<string, unknown>): DbMeetingLogRow {
  return raw as unknown as DbMeetingLogRow;
}

export async function insertQueueRow(row: NewQueueRow): Promise<boolean> {
  const db = await getDatabase();
  const result = await db.execute(QUEUE_SQL.insert, [
    row.id, row.sessionKey, row.conversationId, row.instance, row.contactId,
    row.leadId, row.transcript, row.transcriptStartAt, row.transcriptEndAt,
    row.meetingStartedAt, row.status, row.createdAt,
  ]);
  // 0 means the other trigger already enqueued this meeting. That is a NORMAL
  // outcome, not an error: the caller returns silently - no hold, no push, no
  // recorded failure.
  return (result.rowsAffected ?? 0) > 0;
}

export async function getTranscriptWatermark(): Promise<number> {
  const db = await getDatabase();
  const rows = await db.select<{ mark: number }[]>(QUEUE_SQL.watermark);
  return rows[0]?.mark ?? 0;
}

export async function getQueueRow(id: string): Promise<DbMeetingLogRow | null> {
  const db = await getDatabase();
  const rows = await db.select<Record<string, unknown>[]>(QUEUE_SQL.byId, [id]);
  return rows[0] ? toRow(rows[0]) : null;
}

export async function claimRow(id: string, now: number): Promise<boolean> {
  const db = await getDatabase();
  const result = await db.execute(QUEUE_SQL.claim, [now, id]);
  return (result.rowsAffected ?? 0) === 1;
}

export async function cancelHeldRow(id: string): Promise<boolean> {
  const db = await getDatabase();
  const result = await db.execute(QUEUE_SQL.cancelHeld, [id]);
  return (result.rowsAffected ?? 0) === 1;
}

export async function releaseRowToPending(
  id: string, code: string, text: string
): Promise<void> {
  const db = await getDatabase();
  await db.execute(QUEUE_SQL.toPending, [code, text, id]);
}

export async function failRow(id: string, code: string, text: string): Promise<void> {
  const db = await getDatabase();
  await db.execute(QUEUE_SQL.toFailed, [code, text, id]);
}

/** Records a reason WITHOUT moving the status. */
export async function recordAttemptError(
  id: string, code: string, text: string
): Promise<void> {
  const db = await getDatabase();
  await db.execute(QUEUE_SQL.recordError, [code, text, id]);
}

/**
 * The same, across every row that could still be sent.
 *
 * For the sweep's not-configured case: that path never claims, so `attempts`
 * never increments and no row can escalate into "needs attention" on its own.
 * Scoped away from `failed` so it cannot overwrite the actionable error a user
 * is already trying to act on.
 */
export async function recordErrorOnUnsent(code: string, text: string): Promise<void> {
  const db = await getDatabase();
  await db.execute(QUEUE_SQL.recordErrorOnUnsent, [code, text]);
}

export async function markSent(id: string, at: number): Promise<void> {
  const db = await getDatabase();
  await db.execute(QUEUE_SQL.toSent, [at, id]);
}

export async function setAttachmentId(id: string, attachmentId: number): Promise<void> {
  const db = await getDatabase();
  await db.execute(QUEUE_SQL.setAttachment, [attachmentId, id]);
}

export async function setMessageId(id: string, messageId: number): Promise<void> {
  const db = await getDatabase();
  await db.execute(QUEUE_SQL.setMessage, [messageId, id]);
}

export async function setSummaryJson(id: string, json: string): Promise<void> {
  const db = await getDatabase();
  await db.execute(QUEUE_SQL.setSummary, [json, id]);
}

/**
 * An app killed mid-push leaves a row `sending` forever.
 *
 * `excludeIds` is NOT optional caution. A <Completion /> remount mid-session is
 * documented reachable (useOdooTarget.ts:72-81, useMeetingAutoRecord.ts:96-108),
 * and a remount's sweep running this against a LIVE in-flight push - one sitting
 * in the seconds-long summarize step - would re-claim and re-push it: two
 * attachments and two customer-visible chatter notes.
 *
 * The age gate is the second half: it is what recovers a genuinely dead claim
 * from a process that is gone and therefore has no `claimed` set to consult.
 */
export async function reclaimStaleSending(
  now: number, excludeIds: string[]
): Promise<void> {
  const db = await getDatabase();
  const placeholders = excludeIds.map(() => "?").join(",");
  const notIn = excludeIds.length > 0 ? ` AND id NOT IN (${placeholders})` : "";
  await db.execute(QUEUE_SQL.reclaimBase + notIn, [now - STALE_CLAIM_MS, ...excludeIds]);
}

export async function selectSweepable(
  instance: string, now: number
): Promise<DbMeetingLogRow[]> {
  const db = await getDatabase();
  const rows = await db.select<Record<string, unknown>[]>(QUEUE_SQL.sweepable, [
    instance,
    now - HOLD_MS,
  ]);
  return rows.map(toRow);
}

export async function findHeldRow(
  instance: string, now: number
): Promise<DbMeetingLogRow | null> {
  const db = await getDatabase();
  const rows = await db.select<Record<string, unknown>[]>(QUEUE_SQL.heldInWindow, [
    instance,
    now - HOLD_MS,
  ]);
  return rows[0] ? toRow(rows[0]) : null;
}

/**
 * Every non-terminal row, regardless of instance.
 *
 * For the /odoo page when the credentials are absent or half-filled: there is no
 * fingerprint to scope by, and every queued row is stuck for the same reason.
 * Without this the backlog is invisible exactly when it is largest, because a
 * not-configured push never claims and therefore never escalates either.
 */
export async function countAllQueued(): Promise<number> {
  const db = await getDatabase();
  const rows = await db.select<{ n: number }[]>(QUEUE_SQL.countAll);
  return rows[0]?.n ?? 0;
}

export async function getQueueCounts(instance: string): Promise<QueueCounts> {
  const db = await getDatabase();
  const rows = await db.select<Record<string, number | null>[]>(QUEUE_SQL.counts, [
    instance,
    ESCALATE_AFTER_ATTEMPTS,
  ]);
  const errors = await db.select<{ last_error: string }[]>(QUEUE_SQL.lastError, [
    instance,
    ESCALATE_AFTER_ATTEMPTS,
  ]);
  const row = rows[0] ?? {};
  return {
    waiting: Number(row.waiting ?? 0),
    needsAttention: Number(row.needs_attention ?? 0),
    unassigned: Number(row.unassigned ?? 0),
    otherInstance: Number(row.other_instance ?? 0),
    lastError: errors[0]?.last_error ?? null,
  };
}

/**
 * The remount fallback.
 *
 * `audio_source IS NOT NULL` is load-bearing: without it, TYPED chat messages
 * are rendered into a customer-visible Odoo attachment. Both columns come from
 * migration 8 (chat-history-v8.sql).
 */
/**
 * KNOWN LIMITATION, inherited from useCompletion and not fixed here:
 * `addMeetingTranscriptEntries` (useCompletion.ts:591-624, the diarization path)
 * builds its ChatMessages with no `speaker` and no `audioSource`, unlike
 * `addMeetingTranscript` (:566-573) which sets both. Those rows persist with
 * `audio_source = NULL`, so this recovery read returns nothing for a diarized
 * meeting. Dropping the filter is NOT the fix - it would sweep typed chat
 * messages into a customer-visible Odoo attachment. The fix belongs in
 * useCompletion, and is out of scope for this slice.
 */
export async function readMeetingMessages(
  conversationId: string, watermark: number
): Promise<TranscriptEntry[]> {
  const db = await getDatabase();
  const rows = await db.select<
    { content: string; timestamp: number; speaker: string | null; audio_source: string | null }[]
  >(QUEUE_SQL.meetingMessages, [conversationId, watermark]);
  return rows.map((row) => {
    let speaker: TranscriptEntry["speaker"];
    if (row.speaker) {
      try {
        speaker = JSON.parse(row.speaker) as TranscriptEntry["speaker"];
      } catch {
        // One unreadable blob must not fail the whole recovery read - the
        // point of this path is that the meeting is otherwise LOST.
        speaker = undefined;
      }
    }
    return {
      original: row.content,
      timestamp: row.timestamp,
      speaker,
      audioSource: (row.audio_source as TranscriptEntry["audioSource"]) ?? undefined,
    };
  });
}
