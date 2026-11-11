import type { DbNotionSend } from "@/types";
import { getDatabase } from "./config";
import { NOTION_LANE_OPEN } from "./meeting-log.action";

/**
 * All SQLite access for the Notion send record (`notion_sends`) and the
 * row-to-send linking. NO `BEGIN` / `COMMIT` here, for the reason given at the
 * top of meeting-log.action.ts: plugin-sql has no connection pinning, so a JS
 * transaction can strand an open write lock. Ordering plus per-send CAS
 * replaces atomicity. NOTION_SQL is exported so the guard test scans its values.
 */

const AUTH_CODES = [
  "NOTION_UNAUTHORIZED",
  "NOTION_NO_ACCESS",
  "NOTION_NOT_FOUND",
  "NOTION_KEYCHAIN_UNAVAILABLE",
  "NOTION_NOT_CONFIGURED",
];

export const NOTION_SQL = {
  waitingRows: `
SELECT id, conversation_id, transcript_start_at, transcript_end_at, created_at
  FROM meeting_log_queue
 WHERE notion_status = 'waiting' AND notion_send_id IS NULL
 ORDER BY conversation_id, transcript_start_at`,

  lastSpoken: `SELECT MAX(timestamp) FROM messages WHERE conversation_id = ? AND audio_source IS NOT NULL`,

  liveSends: `
SELECT DISTINCT conversation_id FROM notion_sends
 WHERE status = 'sending' AND claimed_at > ? AND conversation_id IS NOT NULL`,

  insertSend: `
INSERT INTO notion_sends (id, conversation_id, status, next_at, span_start_at, span_end_at, created_at)
VALUES (?, ?, 'retry', 0, ?, ?, ?)
ON CONFLICT(id) DO NOTHING`,

  // Open-ended placeholders are appended per call: `id IN (?, ?, ...)`.
  linkRowsPrefix: `
UPDATE meeting_log_queue SET notion_status = 'joined', notion_send_id = ?
 WHERE notion_status = 'waiting' AND notion_send_id IS NULL AND id IN `,

  claim: `
UPDATE notion_sends SET status = 'sending', claimed_at = ?, attempts = attempts + 1
 WHERE id = ? AND ((status = 'retry' AND COALESCE(next_at, 0) <= ?)
                   OR (status = 'sending' AND claimed_at <= ?))`,

  restamp: `
UPDATE notion_sends SET claimed_at = ?
 WHERE id = ? AND status = 'sending' AND claimed_at = ?`,

  finish: `
UPDATE notion_sends
   SET status = ?, error_code = ?, practices_error_code = ?, next_at = ?, sent_at = ?, claimed_at = NULL
 WHERE id = ? AND status = 'sending' AND claimed_at = ?`,

  byId: `SELECT * FROM notion_sends WHERE id = ?`,

  due: `
SELECT * FROM notion_sends
 WHERE (status = 'retry' AND COALESCE(next_at, 0) <= ?)
    OR (status = 'sending' AND claimed_at <= ?)
 ORDER BY created_at, id`,

  sendRows: `
SELECT transcript, transcript_start_at, transcript_end_at FROM meeting_log_queue
 WHERE notion_send_id = ? ORDER BY transcript_start_at`,

  retry: `
UPDATE notion_sends
   SET status = 'retry', next_at = 0, error_code = NULL,
       summary_failures = CASE WHEN status = 'no_summary' THEN 0 ELSE summary_failures END
 WHERE id = ? AND status IN ('failed', 'no_summary', 'retry')`,

  // Second arm is "Stop and keep page": a failed send with a page must still be closable.
  cancel: `
UPDATE notion_sends SET status = 'cancelled', error_code = NULL
 WHERE id = ? AND ((status IN ('retry', 'failed', 'no_summary') AND page_id IS NULL)
                   OR (status = 'failed' AND page_id IS NOT NULL))`,

  offerPrefix: `
UPDATE meeting_log_queue SET notion_status = 'waiting'
 WHERE notion_status = 'offered' AND id IN `,

  cancelOfferedPrefix: `
UPDATE meeting_log_queue SET notion_status = 'cancelled'
 WHERE notion_status IN ('offered', 'waiting') AND notion_send_id IS NULL AND id IN `,

  requeueAuth: `
UPDATE notion_sends SET status = 'retry', next_at = 0
 WHERE status = 'failed' AND error_code IN (${AUTH_CODES.map((c) => `'${c}'`).join(", ")})`,

  listSends: `
SELECT * FROM notion_sends WHERE NOT (status = 'cancelled' AND page_id IS NULL)
 ORDER BY created_at, id`,

  sendRowIds: `
SELECT id, notion_send_id FROM meeting_log_queue
 WHERE notion_send_id IS NOT NULL ORDER BY transcript_start_at`,

  unjoinedRows: `
SELECT id, conversation_id, notion_status, transcript_start_at, transcript_end_at
  FROM meeting_log_queue
 WHERE notion_status IN ('held', 'offered', 'waiting') AND notion_send_id IS NULL
 ORDER BY transcript_start_at`,

  // NOTION_LANE_OPEN reads `meeting_log_queue.notion_send_id`, so the table stays unaliased.
  conversationRows: `
SELECT meeting_log_queue.id AS id, meeting_log_queue.status AS status,
       meeting_log_queue.notion_status AS notion_status,
       meeting_log_queue.notion_send_id AS notion_send_id,
       meeting_log_queue.transcript AS transcript,
       ${NOTION_LANE_OPEN} AS lane_open,
       ns.status AS send_status, ns.page_id AS send_page_id
  FROM meeting_log_queue
  LEFT JOIN notion_sends ns ON ns.id = meeting_log_queue.notion_send_id
 WHERE meeting_log_queue.conversation_id = ?`,

  waitPrefix: `
UPDATE meeting_log_queue SET notion_status = 'waiting'
 WHERE (notion_status IS NULL OR notion_status = 'offered') AND notion_send_id IS NULL AND id IN `,
} as const;

const marks = (ids: string[]) => `(${ids.map(() => "?").join(", ")})`;

export interface WaitingRow {
  id: string;
  conversation_id: string | null;
  transcript_start_at: number;
  transcript_end_at: number;
  created_at: number;
}

export async function listWaitingRows(): Promise<WaitingRow[]> {
  const db = await getDatabase();
  return db.select<WaitingRow[]>(NOTION_SQL.waitingRows);
}

export async function lastSpokenLineAt(conversationId: string): Promise<number | null> {
  const db = await getDatabase();
  const r = await db.select<Record<string, number | null>[]>(NOTION_SQL.lastSpoken, [conversationId]);
  return Object.values(r[0] ?? {})[0] ?? null;
}

export async function conversationsWithLiveSend(staleBefore: number): Promise<Set<string>> {
  const db = await getDatabase();
  const r = await db.select<{ conversation_id: string }[]>(NOTION_SQL.liveSends, [staleBefore]);
  return new Set(r.map((x) => x.conversation_id));
}

/** Insert first, link second; the link runs even if the insert was a no-op so a crash between them heals. */
export async function createSendAndLink(
  s: { id: string; conversationId: string | null; spanStartAt: number; spanEndAt: number; createdAt: number },
  rowIds: string[]
): Promise<void> {
  const db = await getDatabase();
  await db.execute(NOTION_SQL.insertSend, [s.id, s.conversationId, s.spanStartAt, s.spanEndAt, s.createdAt]);
  if (rowIds.length === 0) return;
  await db.execute(NOTION_SQL.linkRowsPrefix + marks(rowIds), [s.id, ...rowIds]);
}

export async function claimSend(id: string, now: number, staleBefore: number): Promise<number | null> {
  const db = await getDatabase();
  const r = await db.execute(NOTION_SQL.claim, [now, id, now, staleBefore]);
  return (r.rowsAffected ?? 0) > 0 ? now : null;
}

/** Returns the new stamp; callers carry it forward. null = another attempt owns the send. */
export async function restampSend(id: string, prevClaimedAt: number, now: number): Promise<number | null> {
  const db = await getDatabase();
  const r = await db.execute(NOTION_SQL.restamp, [now, id, prevClaimedAt]);
  return (r.rowsAffected ?? 0) > 0 ? now : null;
}

export interface SendPatch {
  summary_json?: string | null;
  summary_failures?: number;
  create_started_at?: number | null;
  page_id?: string | null;
  page_url?: string | null;
  page_created_time?: string | null;
  lost_to_url?: string | null;
  body_done?: number;
  toggle_block_id?: string | null;
  transcript_done?: number;
  practices_done?: number;
}

const PATCH_COLUMNS: ReadonlySet<string> = new Set([
  "summary_json", "summary_failures", "create_started_at", "page_id", "page_url",
  "page_created_time", "lost_to_url", "body_done", "toggle_block_id",
  "transcript_done", "practices_done",
]);

export async function patchSend(id: string, claimedAt: number, patch: SendPatch): Promise<boolean> {
  const keys = Object.keys(patch).filter((k) => (patch as Record<string, unknown>)[k] !== undefined);
  for (const k of keys) {
    if (!PATCH_COLUMNS.has(k)) throw new Error(`patchSend: column not allowed: ${k}`);
  }
  // Nothing defined: still run as a pure ownership check (false = lost the claim).
  const set = keys.length ? keys.map((k) => `${k} = ?`).join(", ") : "claimed_at = claimed_at";
  const db = await getDatabase();
  const r = await db.execute(
    `UPDATE notion_sends SET ${set} WHERE id = ? AND status = 'sending' AND claimed_at = ?`,
    [...keys.map((k) => (patch as Record<string, unknown>)[k]), id, claimedAt]
  );
  return (r.rowsAffected ?? 0) > 0;
}

export async function finishSend(
  id: string,
  claimedAt: number,
  o: {
    status: "retry" | "failed" | "no_summary" | "sent" | "already";
    errorCode?: string | null;
    practicesErrorCode?: string | null;
    nextAt?: number | null;
    sentAt?: number | null;
  }
): Promise<boolean> {
  const db = await getDatabase();
  const r = await db.execute(NOTION_SQL.finish, [
    o.status, o.errorCode ?? null, o.practicesErrorCode ?? null, o.nextAt ?? null, o.sentAt ?? null,
    id, claimedAt,
  ]);
  return (r.rowsAffected ?? 0) > 0;
}

export async function getSend(id: string): Promise<DbNotionSend | null> {
  const db = await getDatabase();
  const r = await db.select<DbNotionSend[]>(NOTION_SQL.byId, [id]);
  return r[0] ?? null;
}

export async function listDueSends(now: number, staleBefore: number): Promise<DbNotionSend[]> {
  const db = await getDatabase();
  return db.select<DbNotionSend[]>(NOTION_SQL.due, [now, staleBefore]);
}

export async function readSendLines(
  sendId: string
): Promise<{ lines: string[]; startAt: number; endAt: number }> {
  const db = await getDatabase();
  const rows = await db.select<
    { transcript: string; transcript_start_at: number; transcript_end_at: number }[]
  >(NOTION_SQL.sendRows, [sendId]);
  const lines = rows.flatMap((r) => r.transcript.split("\n")).filter((l) => l.trim() !== "");
  return {
    lines,
    startAt: rows.length ? Math.min(...rows.map((r) => r.transcript_start_at)) : 0,
    endAt: rows.length ? Math.max(...rows.map((r) => r.transcript_end_at)) : 0,
  };
}

async function one(sql: string, params: unknown[]): Promise<boolean> {
  const db = await getDatabase();
  return ((await db.execute(sql, params)).rowsAffected ?? 0) > 0;
}

export const retrySend = (id: string) => one(NOTION_SQL.retry, [id]);
export const cancelSend = (id: string) => one(NOTION_SQL.cancel, [id]);

export const offerRowsToWaiting = (rowIds: string[]) =>
  rowIds.length ? one(NOTION_SQL.offerPrefix + marks(rowIds), rowIds) : Promise.resolve(false);

export const cancelOfferedRows = (rowIds: string[]) =>
  rowIds.length ? one(NOTION_SQL.cancelOfferedPrefix + marks(rowIds), rowIds) : Promise.resolve(false);

export const markRowsWaiting = (rowIds: string[]) =>
  rowIds.length ? one(NOTION_SQL.waitPrefix + marks(rowIds), rowIds) : Promise.resolve(false);

export interface ConversationNotionRow {
  id: string;
  status: string;
  notion_status: string | null;
  notion_send_id: string | null;
  transcript: string;
  lane_open: number;
  send_status: string | null;
  send_page_id: string | null;
}

export async function listConversationNotionRows(conversationId: string): Promise<ConversationNotionRow[]> {
  const db = await getDatabase();
  return db.select<ConversationNotionRow[]>(NOTION_SQL.conversationRows, [conversationId]);
}

export const requeueAuthFailures = () => one(NOTION_SQL.requeueAuth, []);

export type NotionItem =
  | {
      kind: "rows";
      conversationId: string | null;
      rowIds: string[];
      status: "offered" | "waiting" | "held";
      startAt: number;
      endAt: number;
    }
  | { kind: "send"; send: DbNotionSend; rowIds: string[] };

export async function listNotionItems(): Promise<NotionItem[]> {
  const db = await getDatabase();
  const sends = await db.select<DbNotionSend[]>(NOTION_SQL.listSends);
  const joined = await db.select<{ id: string; notion_send_id: string }[]>(NOTION_SQL.sendRowIds);
  const bySend = new Map<string, string[]>();
  for (const r of joined) bySend.set(r.notion_send_id, [...(bySend.get(r.notion_send_id) ?? []), r.id]);

  const items: NotionItem[] = sends.map((send) => ({ kind: "send", send, rowIds: bySend.get(send.id) ?? [] }));

  const unjoined = await db.select<
    { id: string; conversation_id: string | null; notion_status: "offered" | "waiting" | "held";
      transcript_start_at: number; transcript_end_at: number }[]
  >(NOTION_SQL.unjoinedRows);
  const groups = new Map<string, Extract<NotionItem, { kind: "rows" }>>();
  for (const r of unjoined) {
    // A NULL conversation id never groups: each such row is its own item.
    const key = r.conversation_id === null ? `\0${r.id}` : `${r.conversation_id}\0${r.notion_status}`;
    const g = groups.get(key);
    if (g) {
      g.rowIds.push(r.id);
      g.startAt = Math.min(g.startAt, r.transcript_start_at);
      g.endAt = Math.max(g.endAt, r.transcript_end_at);
    } else {
      groups.set(key, {
        kind: "rows", conversationId: r.conversation_id, rowIds: [r.id], status: r.notion_status,
        startAt: r.transcript_start_at, endAt: r.transcript_end_at,
      });
    }
  }
  return [...items, ...groups.values()];
}
