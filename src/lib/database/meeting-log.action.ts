import type {
  DbMeetingLogRow,
  MeetingLogListRow,
  MeetingLogStatus,
  MeetingLogTarget,
  SelectedTargets,
  TranscriptEntry,
} from "@/types";
import {
  ESCALATE_AFTER_ATTEMPTS,
  HOLD_MS,
  MAX_TARGETS,
  STALE_CLAIM_MS,
  pruneCutoff,
} from "@/lib/odoo/meeting-log";
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
 * whole concurrency design. Ordering replaces it - see the target statements
 * below, which DO write rows that must agree (a queue row and its targets),
 * in an order chosen so a crash mid-write leaves the system inert rather than
 * inconsistent.
 */

export interface NewQueueRow {
  id: string;
  sessionKey: string;
  conversationId: string | null;
  instance: string;
  targets: SelectedTargets;
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

  // CAS, not an unconditional write. Every caller reaches this only after
  // successfully claiming the row, so the predicate never refuses a
  // legitimate write - what it refuses is a zombie writer whose claim was
  // reclaimed by the stale-claim sweep and re-claimed by a later attempt,
  // flipping an already-terminal row back to 'pending'. A refused write
  // leaves the row 'sending', which the stale-claim reclaim already recovers.
  toPending: `
UPDATE meeting_log_queue
   SET status = 'pending', last_error_code = ?, last_error = ?, claimed_at = NULL
 WHERE id = ? AND status = 'sending'`,

  // CAS. See toPending's comment - same zombie-writer rationale.
  toFailed: `
UPDATE meeting_log_queue
   SET status = 'failed', last_error_code = ?, last_error = ?, claimed_at = NULL
 WHERE id = ? AND status = 'sending'`,

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

  // CAS, like toPending and toFailed. Clears the error columns, like
  // finishSync does (odoo-contacts.action.ts:190-221).
  toSent: `
UPDATE meeting_log_queue
   SET status = 'sent', sent_at = ?, last_error = NULL, last_error_code = NULL,
       claimed_at = NULL
 WHERE id = ? AND status = 'sending'`,

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

  // Slice 3. Routes through `pending` rather than widening `claim` to accept
  // `failed`: the claim is the statement the sweep and the hold timer both
  // depend on, and widening it to serve a button changes their behaviour.
  // Clears the error columns because a stale error rendered beside a running
  // retry reads as a fresh failure - `toSent` clears them for the same reason.
  // `attempts` is deliberately NOT reset: it is the escalation record.
  retryRow: `
UPDATE meeting_log_queue
   SET status = 'pending', last_error = NULL, last_error_code = NULL
 WHERE id = ? AND status IN ('failed','pending')`,

  // `failed` is accepted so a meeting whose Odoo target was archived can be
  // retargeted instead of only deleted. Targets themselves are no longer
  // written here - contact_id/lead_id are pre-migration-14 history, and the
  // real target set lives in meeting_log_targets, written by
  // assignQueueRow's own steps 1 and 2 BEFORE this statement runs.
  //
  // `attempts` is deliberately NOT reset - retryRow's own comment says why: it
  // is the escalation record. Resetting it also makes attemptsBefore === 0 on
  // the next push, which DISABLES BOTH ADOPT-SEARCHES, so a retained child
  // whose message_post succeeded but whose setTargetMessage failed gets
  // re-posted as a duplicate customer-visible note.
  //
  // `NOT EXISTS` is the authoritative backstop for the Global Constraint that
  // a sent target is immutable. assignQueueRow's own read-then-write check
  // runs before the child inserts so a refused retarget never rewrites the
  // child set - this predicate is what makes that check safe against the
  // residual TOCTOU, not the only thing enforcing it.
  assignRow: `
UPDATE meeting_log_queue
   SET status = 'pending', last_error = NULL, last_error_code = NULL
 WHERE id = ?
   AND status IN ('unassigned','failed')
   AND NOT EXISTS (SELECT 1 FROM meeting_log_targets
                    WHERE row_id = meeting_log_queue.id AND status = 'sent')`,

  deleteTargetById: `DELETE FROM meeting_log_targets WHERE id = ?`,

  // A STATUS FLIP, never a hard DELETE. The watermark is MAX(transcript_end_at)
  // with no status predicate, so deleting the row holding that maximum makes it
  // regress and the next trigger re-slices the entries this row consumed -
  // reposting the deleted meeting under whatever contact is selected by then. A
  // hard delete also frees the session_key and drops the UNIQUE race backstop.
  //
  // `sending` is the one status refused. `sent` and `cancelled` are accepted
  // even though the page never lists them: the predicate's job is to name what
  // must be refused, and narrowing it to today's reachable statuses would make
  // a future history view - or a row that reaches `sent` between render and
  // click - fail for no stated reason.
  // TWO STATEMENTS, NOT ONE. The spec's single predicate also accepted
  // 'sent'/'cancelled', which made a successful delete unable to say whether
  // anything reached Odoo - and the page's copy asserts that it did not. The
  // dashboard window only re-reads on focus, mount and action, so a `held` row
  // it is still rendering can already be `sent` on disk: one CAS matched it,
  // the delete succeeded, and the user was told "Nothing was sent to Odoo."
  // about a note already on the customer's chatter, with the local transcript
  // blanked in the same statement.
  //
  // Splitting the predicate makes that impossible rather than unlikely.
  // deleteRow matching PROVES the row was not terminal at the instant of the
  // write - no read, no window between a check and a change. A terminal row
  // falls through to deleteTerminalRow, which removes it just as the spec
  // intended, under copy that does not claim anything about what was sent.
  //
  // `NOT EXISTS (... status = 'sent')` extends the same proof to a row with
  // MULTIPLE targets: a parent can derive `pending` or `failed` while one of
  // its children already reached Odoo, and matching here would blank the
  // transcript under "Nothing was sent to Odoo." while a note is live on that
  // customer's chatter. A row with a sent child falls through to
  // deleteTerminalRow instead, under the honest deleted-after-send copy.
  deleteRow: `
UPDATE meeting_log_queue SET status = 'deleted', transcript = '', summary_json = NULL
 WHERE id = ? AND status IN ('held','pending','unassigned','failed')
   AND NOT EXISTS (SELECT 1 FROM meeting_log_targets
                    WHERE row_id = meeting_log_queue.id AND status = 'sent')`,

  // Complement of deleteRow, widened the same way and for the same reason: a
  // partially-sent row derives `pending` or `failed`, so without the OR arm
  // BOTH statements refuse it and deleteMeetingLog returns `conflict` forever
  // - the row becomes permanently undeletable.
  //
  // THE PARENTHESES ARE LOAD-BEARING. `AND` binds tighter than `OR`, so a bare
  // `... AND status IN (...) OR EXISTS (...)` parses as
  // `(id = ? AND status IN (...)) OR EXISTS (...)` - the `id` scope is gone,
  // and one Delete click sets status='deleted', transcript='',
  // summary_json=NULL on EVERY queue row that has a sent target, which after
  // migration 14's backfill is the user's entire sent history. Never append a
  // bare `OR EXISTS (...)` fragment to this WHERE - rewrite it whole.
  //
  // `status <> 'sending'` is required even with the parentheses: without it
  // the new OR arm admits a mid-push row, which both delete statements
  // deliberately refuse today - a stale dashboard's Delete would blank the
  // transcript while the loop keeps posting notes to the remaining targets.
  deleteTerminalRow: `
UPDATE meeting_log_queue SET status = 'deleted', transcript = '', summary_json = NULL
 WHERE id = ?
   AND status <> 'sending'
   AND (status IN ('sent','cancelled')
        OR EXISTS (SELECT 1 FROM meeting_log_targets
                    WHERE row_id = meeting_log_queue.id AND status = 'sent'))`,

  // Every column EXCEPT transcript - loading a whole meeting's text for every
  // row to render a COLLAPSED list is invisible with three rows and painful
  // with forty.
  //
  // GROUP RANK FIRST, then newest-first within a group. Sorting by created_at
  // alone starves needs-attention: those rows are by nature the OLDEST
  // actionable rows, and a backlog of newer unassigned rows would push every
  // one of them past the cap. LIMIT 201 renders 200 and proves at least one
  // more exists, without a second COUNT.
  listActionable: `
SELECT id, session_key, conversation_id, instance, contact_id, lead_id,
       transcript_start_at, transcript_end_at, summary_json, attachment_id,
       message_id, status, attempts, claimed_at, last_error, last_error_code,
       meeting_started_at, created_at, sent_at
  FROM meeting_log_queue
 WHERE status IN ('held','pending','sending','unassigned','failed')
 ORDER BY CASE
            WHEN instance <> ?1 THEN 3
            WHEN status = 'failed' THEN 0
            WHEN status = 'pending' AND attempts >= ?2 THEN 0
            WHEN status = 'unassigned' THEN 1
            ELSE 2
          END,
          created_at DESC
 LIMIT 201`,

  transcriptOf: `SELECT transcript FROM meeting_log_queue WHERE id = ?`,

  // NOT countAll. That one is scoped to ('held','pending','sending') because
  // the sentence it feeds on /odoo promises those rows will be sent once the
  // credentials are finished - false for `failed` and `unassigned`. This page
  // lists both, so reusing countAll would show a user with only those rows a
  // count of zero and therefore a blank page.
  countActionable: `
SELECT COUNT(*) AS n FROM meeting_log_queue
 WHERE status IN ('held','pending','sending','unassigned','failed')`,

  // Retention. Only the two terminal statuses that can still hold text: the
  // other five may all still be pushed, and a pushed row with a blanked
  // transcript uploads an empty attachment to a customer record. `deleted` is
  // deliberately absent - the delete action blanks both columns in the same
  // statement that sets the status, so the clause would be dead.
  //
  // Never deletes a row and never touches a timestamp, so the watermark and the
  // session_key dedup are unaffected. The OR guard keeps it idempotent and its
  // rowsAffected meaningful - `transcript <> ''` alone would skip a row whose
  // transcript was already blank but whose digest was not.
  prune: `
UPDATE meeting_log_queue SET transcript = '', summary_json = NULL
 WHERE status IN ('sent','cancelled')
   AND (transcript <> '' OR summary_json IS NOT NULL)
   AND created_at < ?`,

  // Children of a queue row. Ordering replaces atomicity: these are written
  // BEFORE the parent, because the watermark reads the parent table and a
  // child without a parent is inert.
  insertTarget: `INSERT INTO meeting_log_targets
      (id, row_id, model, res_id, name, status, created_at)
    VALUES (?, ?, ?, ?, ?, 'pending', ?)
    ON CONFLICT(row_id, model, res_id) DO UPDATE SET
      status = 'pending', last_error = NULL, last_error_code = NULL
    WHERE meeting_log_targets.status <> 'sent'`,

  deleteTargetsByRow: `DELETE FROM meeting_log_targets WHERE row_id = ?`,

  targetsByRow: `SELECT * FROM meeting_log_targets
    WHERE row_id = ? ORDER BY created_at, id`,

  // Orphans only. The NOT IN half is as load-bearing as the age gate: a
  // cancelled row's children are NOT orphans, because the parent still exists.
  sweepOrphanTargets: `DELETE FROM meeting_log_targets
    WHERE created_at < ?
      AND row_id NOT IN (SELECT id FROM meeting_log_queue)`,

  // Parameter order is (code, text, id), matching the parent toPending/toFailed
  // these are named to mirror. Do NOT reverse it: two statements with mirrored
  // names and reversed parameters is swap-bait, and a swap silently puts
  // ODOO_FAULT into the user-visible message field.
  // `AND status <> 'sent'` on BOTH. Without it a stale dashboard's Retry - or the
  // push's own record() after a stolen claim - flips a sent target back to
  // pending. No duplicate note results (message_id is still stored), but
  // deleteRow's `NOT EXISTS (... status='sent')` gate then PASSES, and the user
  // deletes the row under "Nothing was sent to Odoo." while a note is live on a
  // customer's chatter. Also the Global Constraint: a sent target is immutable.
  targetToPending: `UPDATE meeting_log_targets
    SET status = 'pending', last_error_code = ?, last_error = ?
    WHERE id = ? AND status <> 'sent'`,
  targetToFailed: `UPDATE meeting_log_targets
    SET status = 'failed', last_error_code = ?, last_error = ?
    WHERE id = ? AND status <> 'sent'`,
  // Clearing the error columns matters: a stale error rendered beside a green
  // sent target reads as a fresh failure.
  //
  // `AND status <> 'sent'` guards the Global Constraint that a sent target is
  // immutable: a duplicate or late-arriving success reprocessing an
  // already-sent target must not silently rewrite sent_at. It cannot refuse a
  // legitimate write - 'sent' is already this statement's own end state, and
  // a retry (failed -> pending -> sent) reaches it untouched by the guard. A
  // 0-rowsAffected result from THIS statement means "already sent", not a
  // failure.
  targetToSent: `UPDATE meeting_log_targets
    SET status = 'sent', sent_at = ?, last_error = NULL, last_error_code = NULL
    WHERE id = ? AND status <> 'sent'`,

  setTargetAttachment: `UPDATE meeting_log_targets SET attachment_id = ? WHERE id = ?`,
  setTargetMessage: `UPDATE meeting_log_targets SET message_id = ? WHERE id = ?`,

  // The parent-status derivation. A CAS on the status the caller OBSERVED -
  // 'sending' for the push, the 'pending' or 'failed' a queue-page action
  // read - so a row that moved between the read and this write is left alone
  // rather than overwritten out from under whoever moved it. See
  // deriveRowStatus's doc comment for the precedence this statement encodes.
  //
  // Fully numbered, matching QUEUE_SQL.counts' style, because ?1 is reused
  // three times. Clearing claimed_at is part of the reduction to today's
  // toSent/toFailed/toPending, all three of which set it NULL.
  deriveStatus: `UPDATE meeting_log_queue
    SET status = ?1,
        last_error      = CASE WHEN ?1 = 'sent' THEN NULL ELSE COALESCE(?2, last_error) END,
        last_error_code = CASE WHEN ?1 = 'sent' THEN NULL ELSE COALESCE(?3, last_error_code) END,
        sent_at    = COALESCE(?4, sent_at),
        claimed_at = NULL
    WHERE id = ?5 AND status = ?6`,
} as const;

function toRow(raw: Record<string, unknown>): DbMeetingLogRow {
  return raw as unknown as DbMeetingLogRow;
}

// Unlike toRow, a real field-by-field mapping: MeetingLogTarget is camelCase
// and QUEUE_SQL.targetsByRow returns the table's snake_case columns as-is.
function toMeetingLogTarget(raw: Record<string, unknown>): MeetingLogTarget {
  return {
    id: raw.id as string,
    rowId: raw.row_id as string,
    model: raw.model as MeetingLogTarget["model"],
    resId: raw.res_id as number,
    name: (raw.name as string | null) ?? null,
    status: raw.status as MeetingLogTarget["status"],
    attachmentId: (raw.attachment_id as number | null) ?? null,
    messageId: (raw.message_id as number | null) ?? null,
    lastError: (raw.last_error as string | null) ?? null,
    lastErrorCode: (raw.last_error_code as string | null) ?? null,
    createdAt: raw.created_at as number,
    sentAt: (raw.sent_at as number | null) ?? null,
  };
}

/**
 * Writes the children, then the parent, with no transaction - see the file
 * header. `rowId` is a client-side crypto.randomUUID(), so every child's
 * foreign key is valid before the parent row exists; a crash between the two
 * steps leaves an orphaned set of children and no parent, which
 * sweepOrphanTargets below reclaims and the watermark (MAX(transcript_end_at)
 * over meeting_log_queue, unmoved by an absent row) re-slices correctly on
 * the next trigger.
 *
 * Overflow past MAX_TARGETS is CAPPED, not rejected - the opposite of
 * addSelectedTarget's rule. Throwing here would escape into `trigger`'s
 * catch, which calls skipUnwritten() and advances the skip watermark,
 * destroying the whole meeting instead of one stale target.
 */
export async function insertQueueRow(row: NewQueueRow): Promise<boolean> {
  const db = await getDatabase();

  const capped = row.targets.slice(0, MAX_TARGETS);
  const overflowed = row.targets.length > MAX_TARGETS;

  // Children first. The watermark reads the parent table, so a crash here
  // leaves the meeting un-queued and the next trigger re-slices it.
  for (const t of capped) {
    await db.execute(QUEUE_SQL.insertTarget, [
      crypto.randomUUID(), row.id, t.model, t.resId, t.name, row.createdAt,
    ]);
  }

  // QUEUE_SQL.insert's column order: (id, session_key, conversation_id,
  // instance, contact_id, lead_id, transcript, transcript_start_at,
  // transcript_end_at, meeting_started_at, status, created_at). Only the two
  // id columns changed to null here - the target rows are the source of
  // truth now, and these two stay on disk purely as pre-migration-14 history.
  const result = await db.execute(QUEUE_SQL.insert, [
    row.id, row.sessionKey, row.conversationId, row.instance,
    null, null, // contact_id, lead_id
    row.transcript, row.transcriptStartAt, row.transcriptEndAt,
    row.meetingStartedAt, row.status, row.createdAt,
  ]);
  // 0 means the other trigger already enqueued this meeting. That is a NORMAL
  // outcome, not an error: the caller returns silently - no hold, no push, no
  // recorded failure.
  const created = (result.rowsAffected ?? 0) > 0;

  // Guarded: both writes below run AFTER the parent insert already succeeded,
  // and an escaping throw would reject out of insertQueueRow into trigger's
  // catch - which toasts a failure, skips the watermark and never starts the
  // hold, for a meeting that IS queued.
  try {
    if (!created) {
      // The other trigger won ON CONFLICT(session_key). Take our children back.
      await db.execute(QUEUE_SQL.deleteTargetsByRow, [row.id]);
    } else if (overflowed) {
      // recordError, NOT recordErrorOnUnsent - that one has no id predicate
      // and would stamp TARGET_CAP across every unsent row in the queue.
      await db.execute(QUEUE_SQL.recordError, [
        "TARGET_CAP", `Only the first ${MAX_TARGETS} targets were queued.`, row.id,
      ]);
    }
  } catch (e) {
    console.warn("[meeting-log] enqueue bookkeeping failed", e);
  }

  return created;
}

export async function listTargets(rowId: string): Promise<MeetingLogTarget[]> {
  const db = await getDatabase();
  const rows = await db.select<Record<string, unknown>[]>(QUEUE_SQL.targetsByRow, [rowId]);
  return rows.map(toMeetingLogTarget);
}

/**
 * Reclaims children whose parent never got written - the crash window
 * insertQueueRow's write order leaves behind. Age-gated so a row genuinely
 * mid-insert (children written, parent write still in flight) is never
 * touched; the NOT IN half is equally load-bearing, because a parent that
 * still exists (cancelled, sent, whatever) means its children are not
 * orphans at all, however old.
 */
export async function sweepOrphanTargets(olderThan: number): Promise<number> {
  const db = await getDatabase();
  const res = await db.execute(QUEUE_SQL.sweepOrphanTargets, [olderThan]);
  return res.rowsAffected ?? 0; // ?? 0 matches every other read in this file
}

// A parent already in one of these is not re-derived. `sent`, `cancelled` and
// `deleted` are terminal; `unassigned` needs a contact, not a re-derive. This
// is an EXCLUSION list, not "only from `sending`": Remove and Retry (Task 10)
// call this from a `pending` or `failed` parent, and a `sending`-only gate
// would match zero rows for either of them, by construction.
const DERIVE_FORBIDDEN: MeetingLogStatus[] = ["cancelled", "deleted", "sent", "unassigned"];

/**
 * Derives a queue row's status from its children under a CAS on the status
 * the caller observed, and writes it. The one mechanism both the push
 * (Task 9, observing `sending`) and the queue-page actions (Task 10,
 * observing `pending` or `failed`) use to fold N target outcomes into the
 * parent's single status.
 *
 * Precedence, in order - 0 first, and 1-before-2 load-bearing:
 *   0. zero targets            -> unassigned (else "all sent" is vacuously
 *      true of an empty set)
 *   1. any target still pending -> pending
 *   2. else any target failed   -> failed
 *   3. else every target sent   -> sent
 * `selectSweepable` only picks up `pending` and `held` parents, so a
 * failed-wins ordering would strand a retryable target forever.
 *
 * `now` is injected, never `Date.now()` read here, so the push can pass
 * `deps.now()` and a test can drive the clock.
 */
export async function deriveRowStatus(
  rowId: string,
  observedStatus: MeetingLogStatus,
  now: number,
): Promise<{ changed: boolean; status: MeetingLogStatus }> {
  if (DERIVE_FORBIDDEN.includes(observedStatus)) {
    return { changed: false, status: observedStatus };
  }

  const targets = await listTargets(rowId);
  // Only targets carrying a reason. Without this, "first pending target" would
  // pick an EARLIER but error-free target over a later one that actually
  // failed a send, and mirror NULL into last_error_code - blanking the error
  // surface in the app on every retryable row that has more than one target.
  const withError = targets.filter((t) => t.lastErrorCode !== null);

  let next: MeetingLogStatus;
  let source: MeetingLogTarget | undefined;

  if (targets.length === 0) {
    next = "unassigned";
  } else if (targets.some((t) => t.status === "pending")) {
    next = "pending";
    source = withError.find((t) => t.status === "pending");
  } else if (targets.some((t) => t.status === "failed")) {
    next = "failed";
    source = withError.find((t) => t.status === "failed");
  } else {
    next = "sent";
  }

  const db = await getDatabase();
  const res = await db.execute(QUEUE_SQL.deriveStatus, [
    next,
    next === "sent" ? null : (source?.lastError ?? null),
    next === "sent" ? null : (source?.lastErrorCode ?? null),
    next === "sent" ? now : null,
    rowId,
    observedStatus,
  ]);
  // ?? 0 matches every other rowsAffected read in this file.
  return { changed: (res.rowsAffected ?? 0) > 0, status: next };
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

export async function retryQueueRow(id: string): Promise<boolean> {
  const db = await getDatabase();
  const result = await db.execute(QUEUE_SQL.retryRow, [id]);
  return (result.rowsAffected ?? 0) === 1;
}

/**
 * Retargets a row to a new set of Odoo targets, as three ordered steps -
 * insert the new children, delete the complement, then flip the parent -
 * with no transaction, per the file header.
 *
 * GATED FIRST, before any write. Evaluating the sent-target check only at the
 * parent flip (step 3) would mean a REFUSED retarget has already rewritten
 * the child set: on {A(sent), B(failed)} retargeted to {A, C}, B would already
 * be deleted and C already inserted by the time the CAS refuses, and step 2's
 * deletes are unrecoverable. Step 3's own `NOT EXISTS` stays as the
 * authoritative backstop for the Global Constraint that a sent target is
 * immutable - the residual TOCTOU between this read and step 2 is safe,
 * because step 2 below never deletes a sent child.
 */
export async function assignQueueRow(id: string, targets: SelectedTargets): Promise<boolean> {
  const db = await getDatabase();

  const currentTargets = await listTargets(id);
  if (currentTargets.some((t) => t.status === "sent")) return false;

  const capped = targets.slice(0, MAX_TARGETS);
  const overflowed = targets.length > MAX_TARGETS;

  // 1. Insert the new children. ON CONFLICT is what stops an overlapping set
  //    from aborting on UNIQUE (row_id, model, res_id), and DO UPDATE resets a
  //    retained child to pending so the push loop does not skip it. It does
  //    NOT touch attachment_id / message_id: preserving those is what makes a
  //    concurrently-sent retained child converge instead of re-posting. The
  //    `WHERE status <> 'sent'` on the DO UPDATE is what keeps a sent target
  //    immutable even here: without it, a stale dashboard whose new set
  //    contains a target just marked sent would un-send it in this step, and
  //    both step 2's skip and step 3's gate would then see nothing sent.
  for (const t of capped) {
    await db.execute(QUEUE_SQL.insertTarget, [
      crypto.randomUUID(), id, t.model, t.resId, t.name, Date.now(),
    ]);
  }

  // 2. Delete only the COMPLEMENT of the new set, and never a sent child.
  //    Deleting by bare row_id would remove the child step 1 just upserted.
  //    Dropping the sent skip would destroy a child that reached Odoo between
  //    the gate's read above and this loop - after which step 3's gate finds
  //    nothing sent and passes, which is exactly what the gate exists to
  //    prevent.
  const keep = capped.map((t) => `${t.model}:${t.resId}`);
  for (const existing of await listTargets(id)) {
    if (existing.status === "sent") continue;
    if (keep.includes(`${existing.model}:${existing.resId}`)) continue;
    await db.execute(QUEUE_SQL.deleteTargetById, [existing.id]);
  }

  // 3. Flip the parent last, under the gate. Returns boolean, like today. A
  //    crash after step 1, or a flip refused here by the CAS, leaves extra
  //    `pending` children on a row whose parent status has not changed - the
  //    orphan sweep does not touch them (the parent exists) and the next
  //    retarget's ON CONFLICT absorbs them. There is no separate
  //    reconciliation step: after step 2 the old target set no longer exists
  //    to reconcile against.
  const res = await db.execute(QUEUE_SQL.assignRow, [id]);
  const ok = (res.rowsAffected ?? 0) > 0;

  // The retarget path caps like the enqueue path does (insertQueueRow above),
  // and records why rather than truncating silently.
  if (ok && overflowed) {
    try {
      await db.execute(QUEUE_SQL.recordError, [
        "TARGET_CAP", `Only the first ${MAX_TARGETS} targets were assigned.`, id,
      ]);
    } catch (e) {
      console.warn("[meeting-log] retarget cap note failed", e);
    }
  }
  return ok;
}

/**
 * Removes a row that has already reached Odoo, or was cancelled.
 *
 * Separate from deleteQueueRow so that one's success is proof the row was
 * still unsent. Only reached after deleteQueueRow declines.
 */
export async function deleteTerminalQueueRow(id: string): Promise<boolean> {
  const db = await getDatabase();
  const result = await db.execute(QUEUE_SQL.deleteTerminalRow, [id]);
  return (result.rowsAffected ?? 0) === 1;
}

export async function deleteQueueRow(id: string): Promise<boolean> {
  const db = await getDatabase();
  const result = await db.execute(QUEUE_SQL.deleteRow, [id]);
  return (result.rowsAffected ?? 0) === 1;
}

export async function listActionableRows(instance: string): Promise<MeetingLogListRow[]> {
  const db = await getDatabase();
  const rows = await db.select<Record<string, unknown>[]>(QUEUE_SQL.listActionable, [
    instance,
    ESCALATE_AFTER_ATTEMPTS,
  ]);
  return rows as unknown as MeetingLogListRow[];
}

/** `null` means NO ROW. `""` means the transcript was removed. Not the same thing. */
export async function getQueueTranscript(id: string): Promise<string | null> {
  const db = await getDatabase();
  const rows = await db.select<{ transcript: string }[]>(QUEUE_SQL.transcriptOf, [id]);
  return rows[0] ? rows[0].transcript : null;
}

export async function countActionableQueued(): Promise<number> {
  const db = await getDatabase();
  const rows = await db.select<{ n: number }[]>(QUEUE_SQL.countActionable);
  return rows[0]?.n ?? 0;
}

/** Retention. Returns how many rows it blanked. */
export async function pruneTranscripts(now: number): Promise<number> {
  const db = await getDatabase();
  const result = await db.execute(QUEUE_SQL.prune, [pruneCutoff(now)]);
  return result.rowsAffected ?? 0;
}
