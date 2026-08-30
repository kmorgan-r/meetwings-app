import fs from "node:fs";
import path from "node:path";
import initSqlJs, { type Database as SqlJsDatabase } from "sql.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

let db: SqlJsDatabase;

/** The real sql.js reads/writes, unwrapped. Tests call these directly for
 * fixture setup; `execute`/`select` below delegate to them by default. */
async function rawExecute(sql: string, params?: unknown[]) {
  db.run(sql, (params ?? []) as never[]);
  return { rowsAffected: db.getRowsModified(), lastInsertId: 0 };
}

async function rawSelect(sql: string, params?: unknown[]) {
  const stmt = db.prepare(sql);
  stmt.bind((params ?? []) as never[]);
  const rows: Record<string, unknown>[] = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

// vi.mock is hoisted above every top-level statement, so a factory closing
// over a plain `const` reads a binding still in TDZ and throws "Cannot
// access 'execute' before initialization" on import, before any test runs.
// vi.hoisted gives the mock a binding that already exists by then.
//
// A STABLE pair, unlike a factory that built a fresh { execute, select }
// closure on every getDatabase() call: there is now something for
// mockImplementation/spying to attach to across a whole test. Tasks 6 and 8
// need to observe statement order and count against this pair.
const { execute, select } = vi.hoisted(() => ({
  execute: vi.fn(),
  select: vi.fn(),
}));
vi.mock("@/lib/database/config", () => ({
  getDatabase: async () => ({ execute, select }),
}));

/**
 * Wraps `execute` so a test can observe statement order/text without losing
 * the real write - `fn` runs, then the call still lands in sql.js via
 * `rawExecute`. A spy that does not delegate would see every statement pass
 * an empty database, and Task 6's "children before the parent" test - the
 * only proof of the core no-transaction argument - would hold on a no-op.
 */
const spyOnExecute = (fn: (sql: string) => void) => {
  execute.mockImplementation(async (sql: string, args?: unknown[]) => {
    fn(sql);
    return rawExecute(sql, args);
  });
};

/**
 * Same idea as spyOnExecute, but for `select` and returning the captured SQL
 * text directly, rather than taking a callback - Task 8's N+1 test needs to
 * count how many `select` calls mention `meeting_log_targets`, not just
 * observe their order. Delegates to rawSelect for the same reason
 * spyOnExecute delegates to rawExecute: a spy that does not delegate would
 * see listActionableRows read an empty database.
 */
const spyOnSelect = () => {
  const calls: string[] = [];
  select.mockImplementation(async (sql: string, args?: unknown[]) => {
    calls.push(sql);
    return rawSelect(sql, args);
  });
  return { calls };
};

import {
  QUEUE_SQL,
  assignQueueRow,
  cancelHeldRow,
  claimRow,
  countActionableQueued,
  countAllQueued,
  deleteQueueRow,
  deleteTerminalQueueRow,
  deriveRowStatus,
  failRow,
  findHeldRow,
  getQueueCounts,
  getQueueRow,
  getQueueTranscript,
  getTranscriptWatermark,
  insertQueueRow,
  listActionableRows,
  listTargets,
  markSent,
  pruneTranscripts,
  readMeetingMessages,
  reclaimStaleSending,
  recordAttemptError,
  recordErrorOnUnsent,
  releaseRowToPending,
  retryQueueRow,
  selectSweepable,
  sweepOrphanTargets,
} from "@/lib/database/meeting-log.action";
import { SELECTED_TARGET_SQL, purgeOtherInstances } from "@/lib/database/odoo-contacts.action";
import { ESCALATE_AFTER_ATTEMPTS, HOLD_MS, RETENTION_MS, STALE_CLAIM_MS } from "@/lib/odoo/meeting-log";
import { applyMigration14, MIGRATIONS, rows, seedPre14 } from "./helpers/migration-14";

const INSTANCE = "http://h:8069|odoo";
const OTHER = "http://h:8069|staging";
const NOW = 1_700_000_000_000;

function newRow(over: Record<string, unknown> = {}) {
  return {
    id: "row-1",
    sessionKey: "conv-1:1000",
    conversationId: "conv-1",
    instance: INSTANCE,
    targets: [{ model: "res.partner", resId: 42, name: null }],
    transcript: "You: hello",
    transcriptStartAt: 1000,
    transcriptEndAt: 2000,
    meetingStartedAt: 1000,
    status: "held",
    createdAt: NOW,
    ...over,
  } as Parameters<typeof insertQueueRow>[0];
}

/** Straight into the table, for fixtures the public API cannot express. */
function seed(over: Record<string, unknown>) {
  const row = {
    id: "seed", session_key: "seed", conversation_id: null, instance: INSTANCE,
    contact_id: 1, lead_id: null, transcript: "t", transcript_start_at: 1,
    transcript_end_at: 2, summary_json: null, attachment_id: null, message_id: null,
    status: "pending", attempts: 0, claimed_at: null, last_error: null,
    last_error_code: null, meeting_started_at: 1, created_at: NOW, sent_at: null,
    ...over,
  };
  db.run(
    `INSERT INTO meeting_log_queue (${Object.keys(row).join(",")}) ` +
      `VALUES (${Object.keys(row).map(() => "?").join(",")})`,
    Object.values(row) as never[]
  );
}

interface SeedTarget {
  resId: number;
  model?: "res.partner" | "crm.lead";
  name?: string | null;
  status?: "pending" | "sent" | "failed";
  createdAt?: number;
  attachmentId?: number | null;
  messageId?: number | null;
  lastError?: string | null;
  lastErrorCode?: string | null;
}

/**
 * Straight into meeting_log_targets, parallel to seed(). NOT built on
 * QUEUE_SQL.insertTarget: that statement hardcodes status = 'pending' in its
 * ON CONFLICT and cannot set attachmentId, messageId, lastError or
 * lastErrorCode - which nearly every fixture that needs this helper does.
 *
 * Usable directly off the shared beforeEach below: it now applies migrations
 * 13 and 14 (odoo-lead-only-target.sql, odoo-multi-target.sql), so
 * meeting_log_targets already exists before any test body runs. It was added
 * for purgeOtherInstances (repointed at odoo_selected_targets in Task 4),
 * which runs on every contact sync and would otherwise throw "no such table"
 * against this file's schema.
 */
function seedTargets(rowId: string, targets: SeedTarget[]) {
  targets.forEach((t, i) => {
    const row = {
      id: `target-${rowId}-${i}`,
      row_id: rowId,
      model: t.model ?? "res.partner",
      res_id: t.resId,
      name: t.name ?? null,
      status: t.status ?? "pending",
      attachment_id: t.attachmentId ?? null,
      message_id: t.messageId ?? null,
      last_error: t.lastError ?? null,
      last_error_code: t.lastErrorCode ?? null,
      created_at: t.createdAt ?? NOW,
      sent_at: null,
    };
    db.run(
      `INSERT INTO meeting_log_targets (${Object.keys(row).join(",")}) ` +
        `VALUES (${Object.keys(row).map(() => "?").join(",")})`,
      Object.values(row) as never[]
    );
  });
}

/**
 * Writes ONLY the child rows, through the real insertTarget statement -
 * modeling a crash between insertQueueRow's ordered writes, where the
 * children landed and the parent insert never ran.
 */
async function insertTargetsOnly(
  rowId: string,
  targets: { model: "res.partner" | "crm.lead"; resId: number; name: string | null }[],
  createdAt = NOW
) {
  for (const t of targets) {
    await rawExecute(QUEUE_SQL.insertTarget, [
      crypto.randomUUID(), rowId, t.model, t.resId, t.name, createdAt,
    ]);
  }
}

/**
 * Raw read distinguishing "no such row" (undefined) from a real row -
 * getQueueRow instead returns null for a missing row, which the
 * un-queued-meeting assertion below needs to NOT be confused with.
 */
async function readRow(id: string) {
  const rows = await rawSelect("SELECT * FROM meeting_log_queue WHERE id = ?", [id]);
  return rows[0];
}

beforeEach(async () => {
  const wasmBinary = fs.readFileSync(
    path.resolve(__dirname, "../../node_modules/sql.js/dist/sql-wasm.wasm")
  );
  const SQL = await initSqlJs({ wasmBinary });
  db = new SQL.Database();
  db.run(fs.readFileSync(path.join(MIGRATIONS, "chat-history.sql"), "utf8"));
  db.run(fs.readFileSync(path.join(MIGRATIONS, "chat-history-v8.sql"), "utf8"));
  // odoo-contacts.sql is needed only by the purgeOtherInstances exemption test,
  // which deletes from the three tables that migration creates.
  db.run(fs.readFileSync(path.join(MIGRATIONS, "odoo-contacts.sql"), "utf8"));
  db.run(fs.readFileSync(path.join(MIGRATIONS, "meeting-log-queue.sql"), "utf8"));
  // Migrations 13 and 14, in that order (14's singleton backfill reads
  // lead_name, which 13 adds). Needed so purgeOtherInstances - which now
  // deletes from odoo_selected_targets, not the odoo_selected_target singleton
  // - has somewhere to write on every run, including the "leaves the queue
  // alone" test below, which calls the real function.
  db.run(fs.readFileSync(path.join(MIGRATIONS, "odoo-lead-only-target.sql"), "utf8"));
  await applyMigration14(db);
  execute.mockImplementation(async (sql: string, args?: unknown[]) => rawExecute(sql, args));
  select.mockImplementation(async (sql: string, args?: unknown[]) => rawSelect(sql, args));
});

describe("the migration", () => {
  it("applies cleanly and creates the queue table", () => {
    const tables = db
      .exec("SELECT name FROM sqlite_master WHERE type='table' AND name='meeting_log_queue'")[0]
      .values.flat();
    expect(tables).toEqual(["meeting_log_queue"]);
  });
});

describe("no JS transactions", () => {
  it("uses no BEGIN and no COMMIT in any statement", () => {
    // Scans the exported VALUES, not the file text: the module carries a
    // mandated "NO BEGIN / COMMIT HERE, DELIBERATELY" comment and a file scan
    // would fail on its own warning. sql.js is a single connection and cannot
    // catch a real violation at runtime, so this static guard is the only check.
    //
    // SELECTED_TARGET_SQL (odoo-contacts.action.ts, Task 4) is scanned
    // alongside QUEUE_SQL: it is a sibling exported statement object, and this
    // is the only place either one gets checked.
    for (const [name, sql] of Object.entries({ ...QUEUE_SQL, ...SELECTED_TARGET_SQL })) {
      expect(sql, `${name} must not open a transaction`).not.toMatch(/\bBEGIN\b/i);
      expect(sql, `${name} must not commit`).not.toMatch(/\bCOMMIT\b/i);
    }
  });

  it("keeps every target statement inside QUEUE_SQL where the scan can see it", () => {
    const required = [
      "insertTarget", "deleteTargetsByRow", "targetsByRow", "sweepOrphanTargets",
      "targetToPending", "targetToFailed", "targetToSent",
      "setTargetAttachment", "setTargetMessage",
    ];
    for (const key of required) {
      expect(QUEUE_SQL, `QUEUE_SQL is missing ${key}`).toHaveProperty(key);
    }
  });
});

describe("insertQueueRow", () => {
  it("inserts a row and reports that it created it", async () => {
    expect(await insertQueueRow(newRow())).toBe(true);
    expect(await getQueueRow("row-1")).toMatchObject({ status: "held", attempts: 0 });
  });

  it("does NOT throw on a duplicate session_key and reports it did not create", async () => {
    // Both triggers racing. A plain INSERT would reject out of a Tauri event
    // handler as an unhandled rejection, and the loser would have no way to
    // learn it must stop before summarizing and pushing.
    await insertQueueRow(newRow());
    expect(await insertQueueRow(newRow({ id: "row-2" }))).toBe(false);
    expect(db.exec("SELECT COUNT(*) FROM meeting_log_queue")[0].values[0][0]).toBe(1);
  });
});

describe("insertQueueRow: ordered enqueue", () => {
  const baseRow = newRow();

  it("writes children before the parent", async () => {
    const order: string[] = [];
    spyOnExecute((sql) => {
      if (sql.includes("INSERT INTO meeting_log_targets")) order.push("child");
      if (sql.includes("INSERT INTO meeting_log_queue")) order.push("parent");
    });
    await insertQueueRow({
      ...baseRow,
      targets: [
        { model: "res.partner", resId: 1, name: "A" },
        { model: "crm.lead", resId: 9, name: "L" },
      ],
    });
    expect(order).toEqual(["child", "child", "parent"]);
  });

  it("leaves the meeting un-queued when the parent insert never runs", async () => {
    // Crash after the children: the row is absent, so the watermark cannot
    // advance and the next trigger re-slices the same span.
    await insertTargetsOnly("r1", [{ model: "res.partner", resId: 1, name: "A" }]);
    expect(await readRow("r1")).toBeUndefined();
    expect(await listTargets("r1")).toHaveLength(1);
  });

  it("deletes its children when it loses the session_key race", async () => {
    await insertQueueRow({
      ...baseRow, id: "r1", sessionKey: "k",
      targets: [{ model: "res.partner", resId: 1, name: "A" }],
    });
    const second = await insertQueueRow({
      ...baseRow, id: "r2", sessionKey: "k",
      targets: [{ model: "res.partner", resId: 2, name: "B" }],
    });
    // NOTE: this test only means something once the binding array above is
    // right. With `instance` bound into session_key, EVERY meeting on one
    // instance collides and this test passes for the wrong reason.
    expect(second).toBe(false); // insertQueueRow returns Promise<boolean>
    expect(await listTargets("r2")).toHaveLength(0);
    expect(await listTargets("r1")).toHaveLength(1);
  });

  it("caps the child insert at five and records the error, rather than failing the parent", async () => {
    const six = Array.from({ length: 6 }, (_, i) => ({
      model: "res.partner" as const, resId: i + 1, name: `C${i + 1}`,
    }));
    const created = await insertQueueRow({ ...baseRow, id: "r1", targets: six });
    expect(created).toBe(true); // the meeting is NOT lost
    expect(await listTargets("r1")).toHaveLength(5);
    expect(await readRow("r1")).toMatchObject({ last_error_code: "TARGET_CAP" });
  });
});

describe("orphan sweep", () => {
  it("sweeps parentless children older than the gate", async () => {
    await insertTargetsOnly("gone", [{ model: "res.partner", resId: 1, name: "A" }], 0);
    expect(await sweepOrphanTargets(1_000)).toBe(1);
  });

  it("leaves recent parentless children alone", async () => {
    await insertTargetsOnly("gone", [{ model: "res.partner", resId: 1, name: "A" }], 5_000);
    expect(await sweepOrphanTargets(1_000)).toBe(0);
  });

  it("never touches the children of a row that still exists, however old", async () => {
    // The age gate alone does not give you this one: a mutant that drops
    // `row_id NOT IN (SELECT id FROM meeting_log_queue)` and keeps the age
    // gate would pass every other case here while deleting the targets of
    // every aged queued row in the backlog.
    seed({ id: "r1", status: "cancelled" });
    seedTargets("r1", [{ resId: 1, status: "pending", createdAt: 0 }]);
    expect(await sweepOrphanTargets(1_000)).toBe(0);
    expect(await listTargets("r1")).toHaveLength(1);
  });
});

describe("getTranscriptWatermark", () => {
  it("is 0 on an empty queue", async () => {
    expect(await getTranscriptWatermark()).toBe(0);
  });

  it("is the MAX across ALL conversation ids, including NULL ones", async () => {
    // NOT partitioned by conversation_id: loadConversation (useCompletion.ts:1351)
    // and startNewConversation (:1386) both change the id and deliberately leave
    // the transcript intact, so a per-id watermark resets to 0 and the next
    // trigger re-posts the previous meeting under a different contact.
    seed({ id: "a", session_key: "a", conversation_id: "conv-1", transcript_end_at: 500 });
    seed({ id: "b", session_key: "b", conversation_id: "conv-2", transcript_end_at: 900 });
    seed({ id: "c", session_key: "c", conversation_id: null, transcript_end_at: 700 });
    expect(await getTranscriptWatermark()).toBe(900);
  });

  it("counts cancelled, sent and unassigned rows too", async () => {
    // Every one of these CONSUMED its slice of entries. Excluding any of them
    // would re-slice an already-handled meeting into the next one. `sent` -
    // the terminal, common case - is given the highest transcript_end_at so
    // the assertion can only pass if a terminal row is actually included; the
    // other two would otherwise let a naive per-status filter through unseen.
    seed({ id: "a", session_key: "a", status: "cancelled", transcript_end_at: 700 });
    seed({ id: "b", session_key: "b", status: "sent", transcript_end_at: 900 });
    seed({ id: "c", session_key: "c", status: "unassigned", transcript_end_at: 500 });
    expect(await getTranscriptWatermark()).toBe(900);
  });
});

describe("claimRow", () => {
  it("moves held to sending, stamps claimed_at and increments attempts once", async () => {
    await insertQueueRow(newRow());
    expect(await claimRow("row-1", NOW)).toBe(true);
    expect(await getQueueRow("row-1")).toMatchObject({
      status: "sending", attempts: 1, claimed_at: NOW,
    });
  });

  it("claims a pending row too", async () => {
    seed({ id: "p", session_key: "p", status: "pending" });
    expect(await claimRow("p", NOW)).toBe(true);
  });

  it("returns false when the status already moved, and does not touch attempts", async () => {
    seed({ id: "c", session_key: "c", status: "cancelled" });
    expect(await claimRow("c", NOW)).toBe(false);
    expect(await getQueueRow("c")).toMatchObject({ status: "cancelled", attempts: 0 });
  });

  it("refuses a sent row, so nothing is ever re-pushed", async () => {
    seed({ id: "s", session_key: "s", status: "sent" });
    expect(await claimRow("s", NOW)).toBe(false);
  });
});

describe("cancelHeldRow", () => {
  it("cancels a held row", async () => {
    await insertQueueRow(newRow());
    expect(await cancelHeldRow("row-1")).toBe(true);
    expect(await getQueueRow("row-1")).toMatchObject({ status: "cancelled" });
  });

  it("returns false once the timer has already claimed it", async () => {
    // The t=29.9s race. The loser MUST be able to tell it lost - the user
    // clicked Undo and the meeting is posting anyway.
    await insertQueueRow(newRow());
    await claimRow("row-1", NOW);
    expect(await cancelHeldRow("row-1")).toBe(false);
  });
});

describe("markSent", () => {
  it("stamps sent_at and CLEARS the error columns", async () => {
    // finishSync (odoo-contacts.action.ts:190-221) clears its markers for the
    // same reason: otherwise a row that failed twice then succeeded carries a
    // stale error forever and slice 3 renders sent rows with error text.
    seed({
      id: "s", session_key: "s", status: "sending",
      last_error: "boom", last_error_code: "ODOO_FAULT",
    });
    await markSent("s", NOW);
    expect(await getQueueRow("s")).toMatchObject({
      status: "sent", sent_at: NOW, last_error: null, last_error_code: null,
    });
  });

  it("is a CAS: refuses to move a row that already left 'sending'", async () => {
    // A zombie writer - an attempt whose row was reclaimed after
    // STALE_CLAIM_MS and re-claimed by a later attempt - must not flip an
    // already-terminal row back, handing the sweep a second chatter note.
    seed({ id: "s", session_key: "s", status: "cancelled" });
    await markSent("s", NOW);
    expect(await getQueueRow("s")).toMatchObject({ status: "cancelled", sent_at: null });
  });
});

describe("failRow and releaseRowToPending", () => {
  it("failRow records the code and text", async () => {
    seed({ id: "s", session_key: "s", status: "sending" });
    await failRow("s", "ODOO_FAULT", "ODOO_FAULT: rejected");
    expect(await getQueueRow("s")).toMatchObject({
      status: "failed", last_error_code: "ODOO_FAULT", last_error: "ODOO_FAULT: rejected",
    });
  });

  it("failRow is a CAS: refuses to move a row that already left 'sending'", async () => {
    seed({ id: "s", session_key: "s", status: "cancelled" });
    await failRow("s", "ODOO_FAULT", "ODOO_FAULT: rejected");
    expect(await getQueueRow("s")).toMatchObject({
      status: "cancelled", last_error_code: null, last_error: null,
    });
  });

  it("releaseRowToPending records the reason so an escalated row is explicable", async () => {
    seed({ id: "s", session_key: "s", status: "sending" });
    await releaseRowToPending("s", "ODOO_UNREACHABLE", "ODOO_UNREACHABLE: down");
    expect(await getQueueRow("s")).toMatchObject({
      status: "pending", last_error_code: "ODOO_UNREACHABLE",
    });
  });

  it("releaseRowToPending is a CAS: refuses to move a row that already left 'sending'", async () => {
    seed({ id: "s", session_key: "s", status: "cancelled" });
    await releaseRowToPending("s", "ODOO_UNREACHABLE", "ODOO_UNREACHABLE: down");
    expect(await getQueueRow("s")).toMatchObject({
      status: "cancelled", last_error_code: null, last_error: null,
    });
  });
});

describe("reclaimStaleSending", () => {
  it("reclaims a claim older than STALE_CLAIM_MS", async () => {
    seed({ id: "old", session_key: "old", status: "sending", claimed_at: NOW - STALE_CLAIM_MS - 1 });
    await reclaimStaleSending(NOW, []);
    expect(await getQueueRow("old")).toMatchObject({ status: "pending" });
  });

  it("leaves a RECENT claim alone", async () => {
    seed({ id: "new", session_key: "new", status: "sending", claimed_at: NOW - 1000 });
    await reclaimStaleSending(NOW, []);
    expect(await getQueueRow("new")).toMatchObject({ status: "sending" });
  });

  it("never reclaims an id this process is currently pushing", async () => {
    // The remount case: a previous mount's timer push is sitting in the
    // summarize step, seconds long. Blind-reclaiming it gives two attachments
    // and two customer-visible chatter notes.
    seed({ id: "live", session_key: "live", status: "sending", claimed_at: NOW - STALE_CLAIM_MS - 1 });
    await reclaimStaleSending(NOW, ["live"]);
    expect(await getQueueRow("live")).toMatchObject({ status: "sending" });
  });
});

describe("selectSweepable", () => {
  beforeEach(() => {
    for (const status of ["sent", "cancelled", "unassigned", "sending", "failed"]) {
      seed({ id: status, session_key: status, status, created_at: NOW - 10 });
    }
    seed({ id: "pending-old", session_key: "pending-old", status: "pending", created_at: NOW - 3000 });
    seed({ id: "pending-new", session_key: "pending-new", status: "pending", created_at: NOW - 1000 });
    seed({ id: "held-stale", session_key: "held-stale", status: "held", created_at: NOW - HOLD_MS - 1 });
    seed({ id: "held-fresh", session_key: "held-fresh", status: "held", created_at: NOW - 1 });
    seed({ id: "other", session_key: "other", status: "pending", instance: OTHER, created_at: NOW });
  });

  it("selects only pending and stale-held rows for THIS instance, oldest first", async () => {
    const rows = await selectSweepable(INSTANCE, NOW);
    expect(rows.map((r) => r.id)).toEqual(["held-stale", "pending-old", "pending-new"]);
  });

  it("never selects sent, cancelled, unassigned, in-window held, or another instance", async () => {
    const ids = (await selectSweepable(INSTANCE, NOW)).map((r) => r.id);
    for (const excluded of [
      "sent", "cancelled", "unassigned", "held-fresh", "other", "sending", "failed",
    ]) {
      expect(ids).not.toContain(excluded);
    }
  });
});

describe("findHeldRow", () => {
  it("finds an in-window held row for the mount rehydrate", async () => {
    await insertQueueRow(newRow({ createdAt: NOW - 5000 }));
    expect(await findHeldRow(INSTANCE, NOW)).toMatchObject({ id: "row-1" });
  });

  it("ignores a held row whose window already expired - the sweep owns that one", async () => {
    await insertQueueRow(newRow({ createdAt: NOW - HOLD_MS - 1 }));
    expect(await findHeldRow(INSTANCE, NOW)).toBeNull();
  });
});

describe("getQueueCounts", () => {
  it("puts an escalated pending row in needsAttention and NOT in waiting", async () => {
    // The attempts>=5 boundary decides which group a row lands in, and a naive
    // implementation counts it in both while every total still looks plausible.
    seed({ id: "w", session_key: "w", status: "pending", attempts: 4 });
    seed({
      id: "e", session_key: "e", status: "pending", attempts: 5,
      last_error: "ODOO_AUTH_FAILED: bad key",
    });
    const counts = await getQueueCounts(INSTANCE);
    expect(counts.waiting).toBe(1);
    expect(counts.needsAttention).toBe(1);
    expect(counts.lastError).toBe("ODOO_AUTH_FAILED: bad key");
  });

  it("counts held with waiting, and unassigned and other-instance separately", async () => {
    seed({ id: "h", session_key: "h", status: "held" });
    seed({ id: "u", session_key: "u", status: "unassigned" });
    seed({ id: "f", session_key: "f", status: "failed" });
    seed({ id: "o", session_key: "o", status: "pending", instance: OTHER });
    // Terminal rows from a PREVIOUS database must not inflate otherInstance.
    // Nothing ever deletes queue rows, so without a status predicate this
    // number would grow with the user's whole logging history.
    seed({ id: "o-sent", session_key: "o-sent", status: "sent", instance: OTHER });
    seed({ id: "o-undone", session_key: "o-undone", status: "cancelled", instance: OTHER });
    const counts = await getQueueCounts(INSTANCE);
    expect(counts).toMatchObject({
      waiting: 1, unassigned: 1, needsAttention: 1, otherInstance: 1,
    });
  });

  it("is all zeroes on an empty queue", async () => {
    // SQLite's SUM(...) returns NULL, not 0, over no rows - the `?? 0` in the
    // mapper is what makes this pass.
    expect(await getQueueCounts(INSTANCE)).toMatchObject({
      waiting: 0, needsAttention: 0, unassigned: 0, otherInstance: 0, lastError: null,
    });
  });

  it("counts a partly-failed row under needs-attention, not waiting", async () => {
    // Below ESCALATE_AFTER_ATTEMPTS, so the OLD needs-attention arm would
    // miss it entirely and the old waiting arm would claim it - the exact
    // "1 of 3 failed" summary next to "Waiting to be sent" this task exists
    // to remove.
    seed({ id: "r1", session_key: "r1", status: "pending", attempts: 0 });
    seedTargets("r1", [
      { resId: 1, status: "pending" },
      { resId: 2, status: "failed", lastErrorCode: "ODOO_FAULT" },
    ]);
    const c = await getQueueCounts(INSTANCE);
    expect(c.needsAttention).toBe(1);
    expect(c.waiting).toBe(0);
  });

  it("does not let another instance's failed target leak into this instance's needsAttention", async () => {
    // Regression test for the AND/OR precedence trap named in the plan - the
    // same one deleteTerminalRow hit. A bare `OR EXISTS (...)` appended
    // without the enclosing parens escapes the `instance = ?1` scoping
    // entirely, and this row (a different instance, a failed target, a
    // needs-attention-shaped status) is exactly what would leak through.
    seed({ id: "other", session_key: "other", status: "pending", attempts: 0, instance: OTHER });
    seedTargets("other", [
      { resId: 1, status: "pending" },
      { resId: 2, status: "failed", lastErrorCode: "ODOO_FAULT" },
    ]);
    const c = await getQueueCounts(INSTANCE);
    expect(c.needsAttention).toBe(0);
    expect(c.otherInstance).toBe(1);
  });

  it("does not let another instance's partly-failed row leak into lastError", async () => {
    // Same precedence trap, applied to QUEUE_SQL.lastError's own OR group -
    // a malformed parse there drops BOTH `instance = ?` and
    // `last_error IS NOT NULL` from the EXISTS disjunct, surfacing any
    // instance's reason text.
    seed({
      id: "other", session_key: "other", status: "pending", attempts: 0,
      instance: OTHER, last_error: "should not surface",
    });
    seedTargets("other", [
      { resId: 1, status: "pending" },
      { resId: 2, status: "failed", lastErrorCode: "ODOO_FAULT" },
    ]);
    expect((await getQueueCounts(INSTANCE)).lastError).toBeNull();
  });

  it("surfaces a reason for a partly-failed row below the escalation threshold", async () => {
    seed({ id: "r1", session_key: "r1", status: "pending", attempts: 0 });
    seedTargets("r1", [
      { resId: 1, status: "pending" },
      { resId: 2, status: "failed", lastError: "boom", lastErrorCode: "ODOO_FAULT" },
    ]);
    // QUEUE_SQL.lastError selects from meeting_log_queue and filters
    // `last_error IS NOT NULL`, so the PARENT's mirror must exist - seeding
    // the child alone leaves the row excluded however the status predicate is
    // widened. Derive it, which is what the push does.
    await deriveRowStatus("r1", "pending", 1_000);
    expect((await getQueueCounts(INSTANCE)).lastError).toBe("boom");
  });
});

describe("countAllQueued", () => {
  it("counts only what a completed config would actually send, across instances", async () => {
    // The line it feeds says "finish setting Odoo up and they will be sent", so
    // `failed` (terminal until slice 3) and `unassigned` (needs a contact, not
    // credentials) must NOT be counted - otherwise the number never drops after
    // the user does exactly what they were told.
    seed({ id: "a", session_key: "a", status: "held" });
    seed({ id: "b", session_key: "b", status: "pending", instance: OTHER });
    seed({ id: "c", session_key: "c", status: "unassigned" });
    seed({ id: "d", session_key: "d", status: "failed" });
    seed({ id: "gone", session_key: "gone", status: "sent" });
    seed({ id: "undone", session_key: "undone", status: "cancelled" });
    expect(await countAllQueued()).toBe(2);
  });

  it("is 0 on an empty queue", async () => {
    expect(await countAllQueued()).toBe(0);
  });

  it("excludes a partly-failed row from countAllQueued's promise", async () => {
    seed({ id: "r1", session_key: "r1", status: "pending", attempts: 0 });
    seedTargets("r1", [
      { resId: 1, status: "pending" },
      { resId: 2, status: "failed", lastErrorCode: "ODOO_FAULT" },
    ]);
    // countAllQueued takes NO arguments - "regardless of instance", per its
    // own doc comment. QueueCounts has no `all`.
    expect(await countAllQueued()).toBe(0);
  });
});

describe("recordAttemptError", () => {
  it("records the reason without moving the status or attempts", async () => {
    await insertQueueRow(newRow());
    await recordAttemptError("row-1", "ODOO_NOT_CONFIGURED", "ODOO_NOT_CONFIGURED");
    expect(await getQueueRow("row-1")).toMatchObject({
      status: "held", attempts: 0, last_error_code: "ODOO_NOT_CONFIGURED",
    });
  });
});

describe("recordErrorOnUnsent", () => {
  it("stamps every still-sendable row and leaves failed/sent rows untouched", async () => {
    // The sweep's not-configured case. Scoped away from 'failed' so it cannot
    // overwrite the actionable error a user is already trying to diagnose, and
    // away from 'sent' because that row is done.
    seed({ id: "h", session_key: "h", status: "held" });
    seed({ id: "p", session_key: "p", status: "pending" });
    seed({
      id: "f", session_key: "f", status: "failed",
      last_error: "ODOO_FAULT: rejected", last_error_code: "ODOO_FAULT",
    });
    seed({
      id: "sent", session_key: "sent", status: "sent",
      last_error: null, last_error_code: null,
    });
    await recordErrorOnUnsent("ODOO_NOT_CONFIGURED", "ODOO_NOT_CONFIGURED");
    expect(await getQueueRow("h")).toMatchObject({ last_error_code: "ODOO_NOT_CONFIGURED" });
    expect(await getQueueRow("p")).toMatchObject({ last_error_code: "ODOO_NOT_CONFIGURED" });
    expect(await getQueueRow("f")).toMatchObject({
      last_error_code: "ODOO_FAULT", last_error: "ODOO_FAULT: rejected",
    });
    expect(await getQueueRow("sent")).toMatchObject({ last_error_code: null, last_error: null });
  });
});

describe("purgeOtherInstances leaves the queue alone", () => {
  it("does not delete another instance's queued meetings", async () => {
    // The exemption is DOCUMENTED at the purge site, but a comment cannot stop
    // someone adding `DELETE FROM meeting_log_queue WHERE instance <> ?` to
    // match the three tables above it. That change would ship green and
    // silently destroy unlogged work on every credentials edit.
    seed({ id: "other", session_key: "other", instance: OTHER });
    await purgeOtherInstances(INSTANCE);
    expect(await getQueueRow("other")).not.toBeNull();
  });
});

describe("readMeetingMessages", () => {
  function message(over: Record<string, unknown>) {
    const row = {
      id: "m1", conversation_id: "conv-1", role: "user", content: "hello",
      timestamp: 1000, attached_files: null, speaker: null, audio_source: "microphone",
      ...over,
    };
    db.run(
      `INSERT INTO messages (${Object.keys(row).join(",")}) ` +
        `VALUES (${Object.keys(row).map(() => "?").join(",")})`,
      Object.values(row) as never[]
    );
  }

  beforeEach(() => {
    db.run(
      "INSERT INTO conversations (id, title, created_at, updated_at) VALUES ('conv-1','t',1,1)"
    );
  });

  it("returns only rows with an audio_source, above the watermark", async () => {
    // Without the audio_source filter, TYPED chat messages get rendered into a
    // customer-visible Odoo attachment.
    message({ id: "typed", audio_source: null, content: "a typed question", timestamp: 3000 });
    message({ id: "old", content: "before the watermark", timestamp: 500 });
    message({ id: "keep", content: "said aloud", timestamp: 3000 });
    const entries = await readMeetingMessages("conv-1", 1000);
    expect(entries.map((e) => e.original)).toEqual(["said aloud"]);
  });

  it("parses the speaker JSON column back into a SpeakerInfo object", async () => {
    message({ id: "s", speaker: JSON.stringify({ speakerLabel: "Ada" }), timestamp: 3000 });
    const entries = await readMeetingMessages("conv-1", 1000);
    expect(entries[0].speaker).toEqual({ speakerLabel: "Ada" });
  });

  it("survives an unparseable speaker blob rather than failing the whole read", async () => {
    message({ id: "bad", speaker: "{not json", timestamp: 3000 });
    const entries = await readMeetingMessages("conv-1", 1000);
    expect(entries[0].speaker).toBeUndefined();
    expect(entries[0].original).toBe("hello");
  });
});

describe("retryQueueRow", () => {
  it("moves a failed row to pending, clears the error, and LEAVES attempts alone", async () => {
    // The positive assertions are the point. A refusal-only test lets the
    // mutant that drops `SET status = 'pending'` survive: the statement still
    // affects one row, the wrapper still returns true, the mocked "then pushes"
    // case still passes - and in production claimRow refuses the still-`failed`
    // row and the push does nothing, permanently.
    seed({ id: "r", status: "failed", attempts: 3, last_error: "boom", last_error_code: "ODOO_FAULT" });

    expect(await retryQueueRow("r")).toBe(true);

    expect(await getQueueRow("r")).toMatchObject({
      status: "pending",
      last_error: null,
      last_error_code: null,
      attempts: 3, // NOT reset - the escalation record survives a retry
    });
  });

  it("accepts an escalated pending row", async () => {
    seed({ id: "r", status: "pending", attempts: ESCALATE_AFTER_ATTEMPTS });
    expect(await retryQueueRow("r")).toBe(true);
  });

  it("refuses a sent row", async () => {
    seed({ id: "r", status: "sent" });
    expect(await retryQueueRow("r")).toBe(false);
    expect(await getQueueRow("r")).toMatchObject({ status: "sent" });
  });
});

describe("assignQueueRow", () => {
  it("assigns an unassigned row and inserts its target", async () => {
    // A row can never be `pending` with no target - the exact collision the
    // `unassigned` status exists to prevent.
    seed({ id: "r", status: "unassigned", contact_id: null, lead_id: null });

    expect(await assignQueueRow("r", [{ model: "res.partner", resId: 42, name: "A" }]))
      .toBe(true);

    expect(await getQueueRow("r")).toMatchObject({ status: "pending" });
    expect(await listTargets("r")).toMatchObject([
      { model: "res.partner", resId: 42, status: "pending" },
    ]);
  });

  it("accepts a failed row, clears its last_error, inserts the new target, and leaves attempts alone", async () => {
    // `failed` is accepted so a meeting whose Odoo target was archived can be
    // retargeted instead of only deleted.
    //
    // `attempts` is asserted here (not just documented) because resetting it
    // makes attemptsBefore === 0 on the next push, which disables both
    // adopt-searches - a retained child whose message_post succeeded but
    // whose setTargetMessage failed would get re-posted as a duplicate
    // customer-visible note.
    seed({
      id: "r", status: "failed", attempts: 3,
      last_error: "gone", last_error_code: "ODOO_FAULT",
    });

    expect(await assignQueueRow("r", [{ model: "res.partner", resId: 42, name: null }]))
      .toBe(true);

    expect(await getQueueRow("r")).toMatchObject({
      status: "pending",
      attempts: 3,
      last_error: null,
      last_error_code: null,
    });
    expect(await listTargets("r")).toMatchObject([
      { model: "res.partner", resId: 42, status: "pending" },
    ]);
  });

  it("refuses to retarget a row that is neither unassigned nor failed", async () => {
    seed({ id: "r1", status: "pending" });
    expect(await assignQueueRow("r1", [{ model: "res.partner", resId: 2, name: "B" }]))
      .toBe(false);
  });

  it("refuses a pending retarget without deleting its existing children first", async () => {
    // The row-status gate closes this: without it, step 1 inserts the new
    // target, step 2 deletes BOTH pre-existing unsent children as the
    // complement of the new set, step 3's CAS correctly refuses on
    // `pending` - but by then the row's entire target set has already been
    // silently replaced under a result the caller reads as "nothing
    // happened." Neither child here is sent, so the sent-target gate alone
    // would not catch this - it is the row's own status that must gate
    // steps 1 and 2, not only its children's.
    seed({ id: "r1", status: "pending" });
    seedTargets("r1", [
      { resId: 1, status: "pending" },
      { resId: 2, status: "failed", lastErrorCode: "ODOO_FAULT" },
    ]);

    expect(await assignQueueRow("r1", [{ model: "res.partner", resId: 3, name: "C" }]))
      .toBe(false);

    const t = await listTargets("r1");
    expect(t.map((x) => x.resId).sort()).toEqual([1, 2]);
  });

  it("un-sends nothing when the new set contains an already-sent target", async () => {
    seed({ id: "r1", status: "failed" });
    seedTargets("r1", [{ resId: 1, status: "sent" }]);
    await assignQueueRow("r1", [{ model: "res.partner", resId: 1, name: "A" }]);
    expect((await listTargets("r1"))[0].status).toBe("sent");
  });

  it("refuses to retarget a row with a sent target, without touching the children", async () => {
    seed({ id: "r1", status: "failed" });
    seedTargets("r1", [{ resId: 1, status: "sent" }]);
    expect(await assignQueueRow("r1", [{ model: "res.partner", resId: 2, name: "B" }]))
      .toBe(false);
    // Length 1, not 2: the gate runs BEFORE the inserts. Gating only in step 3
    // would leave the new child behind on a "refused" retarget.
    expect(await listTargets("r1")).toHaveLength(1);
  });

  it("retargets an overlapping set without colliding, and resets the retained child", async () => {
    seed({ id: "r1", status: "failed" });
    seedTargets("r1", [
      { resId: 1, status: "failed", lastErrorCode: "ODOO_FAULT", attachmentId: 111 },
      { resId: 2, status: "failed", lastErrorCode: "ODOO_FAULT" },
    ]);
    await assignQueueRow("r1", [
      { model: "res.partner", resId: 1, name: "A" },     // retained
      { model: "res.partner", resId: 3, name: "C" },     // new
    ]);
    const t = await listTargets("r1");
    expect(t.map((x) => x.resId).sort()).toEqual([1, 3]);
    const retained = t.find((x) => x.resId === 1)!;
    expect(retained.status).toBe("pending");
    expect(retained.lastErrorCode).toBeNull();
    expect(retained.attachmentId).toBe(111);   // preserved, so the next push converges
  });

  it("leaves a concurrently-sent child in place during the delete step", async () => {
    seed({ id: "r1", status: "failed" });
    seedTargets("r1", [{ resId: 2, status: "sent" }]);   // sent between steps 1 and 2
    await assignQueueRow("r1", [{ model: "res.partner", resId: 3, name: "C" }]);
    const t = await listTargets("r1");
    expect(t.some((x) => x.resId === 2 && x.status === "sent")).toBe(true);
  });

  // The two tests above seed their sent target BEFORE calling assignQueueRow,
  // so the read-then-write gate at the top of assignQueueRow ("GATE FIRST")
  // refuses the whole call before step 1 or step 2 ever run - neither one
  // reaches step 2's `status === "sent"` skip or step 3's `NOT EXISTS`
  // backstop. These two simulate the actual race the gate's own comment
  // names: the target is still unsent when the gate reads it, and only
  // reaches Odoo WHILE step 1's insert is in flight - the "residual TOCTOU"
  // the gate is not supposed to be safe from on its own.
  it("refuses a retarget whose target is sent mid-flight, and step 2 leaves it in place", async () => {
    seed({ id: "r1", status: "failed" });
    seedTargets("r1", [{ resId: 2, status: "pending" }]);

    let flipped = false;
    execute.mockImplementation(async (sql: string, args?: unknown[]) => {
      const result = await rawExecute(sql, args);
      if (!flipped && sql.includes("INSERT INTO meeting_log_targets")) {
        flipped = true;
        // Simulates the push loop's own targetToSent landing between this
        // function's gate read and its step 2 delete pass.
        await rawExecute(
          `UPDATE meeting_log_targets SET status = 'sent' WHERE row_id = ? AND res_id = ?`,
          ["r1", 2]
        );
      }
      return result;
    });

    expect(await assignQueueRow("r1", [{ model: "res.partner", resId: 3, name: "C" }]))
      .toBe(false);
    expect((await listTargets("r1")).find((x) => x.resId === 2)?.status).toBe("sent");
  });

  it("does not un-send a target that lands mid-flight when the new set retains it", async () => {
    seed({ id: "r1", status: "failed" });
    seedTargets("r1", [{ resId: 1, status: "pending" }]);

    let flipped = false;
    execute.mockImplementation(async (sql: string, args?: unknown[]) => {
      if (!flipped && sql.includes("INSERT INTO meeting_log_targets")) {
        flipped = true;
        await rawExecute(
          `UPDATE meeting_log_targets SET status = 'sent' WHERE row_id = ? AND res_id = ?`,
          ["r1", 1]
        );
      }
      return rawExecute(sql, args);
    });

    expect(await assignQueueRow("r1", [{ model: "res.partner", resId: 1, name: "A" }]))
      .toBe(false);
    expect((await listTargets("r1"))[0].status).toBe("sent");
  });
});

describe("deriveRowStatus", () => {
  it("derives unassigned when the row has no targets", async () => {
    seed({ id: "r1", status: "sending" });
    expect(await deriveRowStatus("r1", "sending", 1_000)).toMatchObject({ status: "unassigned" });
  });

  it("prefers a retryable target over a failed one", async () => {
    seed({ id: "r1", status: "sending" });
    seedTargets("r1", [
      { resId: 1, status: "pending" },
      { resId: 2, status: "failed", lastErrorCode: "ODOO_FAULT" },
    ]);
    expect(await deriveRowStatus("r1", "sending", 1_000)).toMatchObject({ status: "pending" });
  });

  it("derives failed when every unsent target is failed", async () => {
    seed({ id: "r1", status: "sending" });
    seedTargets("r1", [
      { resId: 1, status: "sent" },
      { resId: 2, status: "failed", lastErrorCode: "ODOO_FAULT" },
    ]);
    expect(await deriveRowStatus("r1", "sending", 1_000)).toMatchObject({ status: "failed" });
  });

  it("derives sent when every target is sent", async () => {
    seed({ id: "r1", status: "sending" });
    seedTargets("r1", [{ resId: 1, status: "sent" }, { resId: 2, status: "sent" }]);
    expect(await deriveRowStatus("r1", "sending", 1_000)).toMatchObject({ status: "sent" });
  });

  it("runs from a failed parent, which is what Remove needs", async () => {
    seed({ id: "r1", status: "failed" });
    seedTargets("r1", [{ resId: 1, status: "sent" }]);
    expect(await deriveRowStatus("r1", "failed", 1_000)).toMatchObject({
      changed: true,
      status: "sent",
    });
  });

  it("refuses to run on a deleted parent", async () => {
    seed({ id: "r1", status: "deleted" });
    seedTargets("r1", [{ resId: 1, status: "pending" }]);
    expect(await deriveRowStatus("r1", "deleted", 1_000)).toMatchObject({ changed: false });
    expect(await getQueueRow("r1")).toMatchObject({ status: "deleted" });
  });

  it("loses to a concurrent claim", async () => {
    seed({ id: "r1", status: "failed" });
    seedTargets("r1", [{ resId: 1, status: "sent" }]);
    // Seed the stolen claim with raw SQL. QUEUE_SQL.claim is
    // `WHERE id = ? AND status IN ('pending','held')` and CANNOT claim a failed
    // row - calling claimRow here would leave the row `failed`, the derive CAS
    // would match, and this test would fail against a CORRECT implementation.
    await rawExecute("UPDATE meeting_log_queue SET status = 'sending' WHERE id = ?", ["r1"]);
    expect(await deriveRowStatus("r1", "failed", 1_000)).toMatchObject({ changed: false });
  });

  it("mirrors the determining target's error and clears it on sent", async () => {
    seed({ id: "r1", status: "sending" });
    seedTargets("r1", [
      { resId: 1, status: "pending", createdAt: 1 }, // no error yet
      {
        resId: 2, status: "pending", createdAt: 2,
        lastError: "boom", lastErrorCode: "ODOO_UNREACHABLE",
      },
    ]);
    await deriveRowStatus("r1", "sending", 1_000);
    expect(await getQueueRow("r1")).toMatchObject({ last_error_code: "ODOO_UNREACHABLE" });
  });
});

describe("deleteQueueRow", () => {
  it("blanks transcript AND summary_json while every timestamp survives", async () => {
    seed({
      id: "r", status: "failed", transcript: "You: secrets",
      summary_json: '{"title":"Q3 renewal","participants":["Ada"]}',
      transcript_start_at: 1000, transcript_end_at: 2000,
      session_key: "conv:1000", created_at: 1234, contact_id: 42, lead_id: 7,
    });

    expect(await deleteQueueRow("r")).toBe(true);

    // summary_json is not optional to clear: it holds title, summary,
    // decisions, action items, next steps, participants and entities - the
    // meeting's content in condensed form, including named people. Blanking
    // the transcript and keeping the digest defeats the promise the confirm
    // step made.
    expect(await getQueueRow("r")).toMatchObject({
      status: "deleted",
      transcript: "",
      summary_json: null,
      transcript_start_at: 1000,
      transcript_end_at: 2000,
      session_key: "conv:1000",
      created_at: 1234,
      contact_id: 42,
      lead_id: 7,
    });
  });

  it.each(["failed", "unassigned", "held", "pending"])(
    "accepts a %s row",
    async (status) => {
      seed({ id: "r", status });
      expect(await deleteQueueRow("r")).toBe(true);
    }
  );

  // THE SPLIT IS THE POINT, so assert the refusal, not just that the terminal
  // statement works. deleteQueueRow succeeding is what deleteMeetingLog treats
  // as proof that nothing reached Odoo; widen this predicate back to include
  // 'sent' and that proof becomes a guess, and the page tells a user "Nothing
  // was sent to Odoo." about a note already on a customer's chatter.
  it.each(["sent", "cancelled"])("REFUSES a %s row", async (status) => {
    seed({ id: "r", status });
    expect(await deleteQueueRow("r")).toBe(false);
    expect(await getQueueRow("r")).toMatchObject({ status });
  });

  it.each(["sent", "cancelled"])(
    "deleteTerminalQueueRow removes a %s row, blanking it the same way",
    async (status) => {
      seed({
        id: "r", status, transcript: "You: secrets",
        summary_json: '{"title":"Q3 renewal"}', created_at: 1234,
      });
      expect(await deleteTerminalQueueRow("r")).toBe(true);
      expect(await getQueueRow("r")).toMatchObject({
        status: "deleted", transcript: "", summary_json: null, created_at: 1234,
      });
    }
  );

  it.each(["failed", "unassigned", "held", "pending", "sending"])(
    "deleteTerminalQueueRow refuses a %s row",
    async (status) => {
      seed({ id: "r", status });
      expect(await deleteTerminalQueueRow("r")).toBe(false);
      expect(await getQueueRow("r")).toMatchObject({ status });
    }
  );

  it("refuses a sending row", async () => {
    seed({ id: "r", status: "sending" });
    expect(await deleteQueueRow("r")).toBe(false);
    expect(await getQueueRow("r")).toMatchObject({ status: "sending" });
  });

  it("LEAVES THE WATERMARK UNCHANGED after deleting the newest row", async () => {
    // THE regression test for this slice's headline defect, named in the spec
    // and required to exist by name. A hard DELETE regresses
    // MAX(transcript_end_at); because meetingTranscript is never cleared when a
    // meeting ends, the next trigger re-slices the entries the deleted row had
    // consumed and reposts that meeting under whatever contact is selected by
    // then. The skip watermark does not cover it - that one advances only for a
    // span that wrote NO row.
    seed({ id: "old", session_key: "a", transcript_end_at: 1000, status: "sent" });
    seed({ id: "new", session_key: "b", transcript_end_at: 9999, status: "failed" });

    expect(await getTranscriptWatermark()).toBe(9999);

    await deleteQueueRow("new");

    expect(await getTranscriptWatermark()).toBe(9999);
  });

  it("keeps the session_key dedup backstop alive", async () => {
    seed({ id: "r", session_key: "conv:1000", status: "failed" });
    await deleteQueueRow("r");

    // A hard delete would free the key and drop the UNIQUE race backstop.
    expect(await insertQueueRow(newRow({ id: "other", sessionKey: "conv:1000" }))).toBe(false);
  });

  it("refuses to delete a partially-sent row under the nothing-was-sent copy", async () => {
    seed({ id: "r1", status: "failed" });
    seedTargets("r1", [
      { resId: 1, status: "sent" },
      { resId: 2, status: "failed", lastErrorCode: "ODOO_FAULT" },
    ]);
    // deleteQueueRow returns Promise<boolean>, not a QueryResult.
    expect(await deleteQueueRow("r1")).toBe(false);
  });

  it("still deletes a row where nothing was sent", async () => {
    seed({ id: "r1", status: "failed" });
    seedTargets("r1", [{ resId: 1, status: "failed", lastErrorCode: "ODOO_FAULT" }]);
    expect(await deleteQueueRow("r1")).toBe(true);
  });

  it("deletes a partially-sent row through the honest deleted-after-send copy", async () => {
    seed({ id: "r1", status: "failed" });
    seedTargets("r1", [
      { resId: 1, status: "sent" },
      { resId: 2, status: "failed", lastErrorCode: "ODOO_FAULT" },
    ]);
    // Without widening deleteTerminalRow, BOTH statements refuse and the row is
    // permanently undeletable.
    expect(await deleteTerminalQueueRow("r1")).toBe(true);
  });

  it("deletes only the row it was asked to delete", async () => {
    // The AND/OR precedence bug drops the id scope and deletes every row with a
    // sent child. Every other fixture here is single-row and cannot see it.
    seed({ id: "r1", session_key: "seed-r1", status: "failed" });
    seedTargets("r1", [{ resId: 1, status: "sent" }]);
    seed({ id: "r2", session_key: "seed-r2", status: "sent" });
    seedTargets("r2", [{ resId: 2, status: "sent" }]);
    await deleteTerminalQueueRow("r1");
    expect(await readRow("r2")).toMatchObject({ status: "sent" });
  });

  it("refuses to delete a row that is mid-push", async () => {
    seed({ id: "r1", status: "sending" });
    seedTargets("r1", [{ resId: 1, status: "sent" }]);
    expect(await deleteTerminalQueueRow("r1")).toBe(false);
  });
});

describe("listActionableRows", () => {
  it("omits the transcript column entirely", async () => {
    seed({ id: "r", status: "failed", transcript: "You: hello" });
    const [row] = await listActionableRows(INSTANCE);
    expect(row).not.toHaveProperty("transcript");
    expect(row).toMatchObject({ id: "r", status: "failed" });
  });

  it("attaches targets to every listed row with one extra query, not N+1", async () => {
    const spy = spyOnSelect();
    seed({ id: "r1", session_key: "r1", status: "pending" });
    seed({ id: "r2", session_key: "r2", status: "failed" });
    seedTargets("r1", [{ resId: 1, status: "pending" }]);
    seedTargets("r2", [{ resId: 2, status: "failed", lastErrorCode: "ODOO_FAULT" }]);

    const rows = await listActionableRows(INSTANCE);

    expect(rows.map((r) => (r.targets ?? []).length)).toEqual([1, 1]);
    // ONE select against meeting_log_targets for the whole list - a JOIN
    // would multiply parent rows, and N+1 would be one select per row.
    expect(spy.calls.filter((s) => s.includes("meeting_log_targets"))).toHaveLength(1);
  });

  it.each(["sent", "cancelled", "deleted"])("excludes a %s row", async (status) => {
    seed({ id: "r", status });
    expect(await listActionableRows(INSTANCE)).toHaveLength(0);
  });

  it("includes an other-instance failed row", async () => {
    // Under QUEUE_SQL.counts such a row matches no arm and is invisible,
    // unsendable, undeletable and never pruned - transcript retained forever
    // with no user-reachable surface.
    seed({ id: "r", status: "failed", instance: OTHER });
    expect(await listActionableRows(INSTANCE)).toHaveLength(1);
  });

  it("returns 201 rows when 250 exist", async () => {
    for (let i = 0; i < 250; i += 1) {
      seed({ id: `r${i}`, session_key: `k${i}`, status: "pending", created_at: NOW + i });
    }
    expect(await listActionableRows(INSTANCE)).toHaveLength(201);
  });

  it("ranks needs-attention above newer rows so the cap cannot starve it", async () => {
    // 210 newer rows, not 200. With exactly 200 the total is 201 = LIMIT 201,
    // so the needs-attention row comes back with or WITHOUT the group-rank
    // CASE and the case kills no mutant.
    seed({ id: "old-failed", session_key: "of", status: "failed", created_at: NOW });
    for (let i = 0; i < 210; i += 1) {
      seed({ id: `u${i}`, session_key: `uk${i}`, status: "unassigned", created_at: NOW + 1 + i });
    }

    const rows = await listActionableRows(INSTANCE);

    expect(rows[0]).toMatchObject({ id: "old-failed" });
  });

  it("ranks an ESCALATED PENDING row above newer rows too, not just failed", async () => {
    // The "failed" sibling above only exercises the CASE's first needs-attention
    // arm (`status = 'failed' THEN 0`). This is the second: `status = 'pending'
    // AND attempts >= ?2 THEN 0`. Nothing else in the suite seeds an escalated
    // pending row into a starvation scenario, so a mutant deleting that WHEN
    // line survives every other case. 210 newer rows, not 200, for the same
    // reason as the sibling case: at exactly 200 the total is 201 = LIMIT 201,
    // so the row comes back regardless of the CASE. This also proves `?2`
    // (ESCALATE_AFTER_ATTEMPTS) is bound correctly inside the ORDER BY, which
    // nothing else in the suite proves.
    seed({
      id: "old-escalated", session_key: "oe", status: "pending",
      attempts: ESCALATE_AFTER_ATTEMPTS, created_at: NOW,
    });
    for (let i = 0; i < 210; i += 1) {
      seed({ id: `v${i}`, session_key: `vk${i}`, status: "unassigned", created_at: NOW + 1 + i });
    }

    const rows = await listActionableRows(INSTANCE);

    expect(rows[0]).toMatchObject({ id: "old-escalated" });
  });

  it("orders same-group rows newest-first", async () => {
    // Group placement and the cap length are both covered elsewhere, but
    // nothing asserts WHICH rows come back within a single group - a mutant
    // flipping the trailing `created_at DESC` to ASC survives every other
    // case in this file.
    seed({ id: "u-old", session_key: "uo", status: "unassigned", created_at: NOW });
    seed({ id: "u-mid", session_key: "um", status: "unassigned", created_at: NOW + 10 });
    seed({ id: "u-new", session_key: "un", status: "unassigned", created_at: NOW + 20 });

    const rows = await listActionableRows(INSTANCE);

    expect(rows.map((r) => r.id)).toEqual(["u-new", "u-mid", "u-old"]);
  });
});

describe("a deleted row is excluded by every shipped predicate", () => {
  beforeEach(() => {
    // TWO rows, one per instance, BOTH with a non-null last_error and an
    // escalated attempts count. A single current-instance row with a null error
    // passes two arms vacuously: `lastError` filters `last_error IS NOT NULL`
    // BEFORE the status predicate is ever reached, so a NOT IN rewrite of that
    // status list survives; and the counts fourth arm is `instance <> ?1`,
    // which a current-instance row cannot exercise at all. The fixture must
    // make status the only clause that can exclude them.
    seed({
      id: "d-here", session_key: "dh", status: "deleted", instance: INSTANCE,
      last_error: "was a failure", last_error_code: "ODOO_FAULT",
      attempts: ESCALATE_AFTER_ATTEMPTS, transcript: "", created_at: 1,
    });
    seed({
      id: "d-there", session_key: "dt", status: "deleted", instance: OTHER,
      last_error: "was a failure", last_error_code: "ODOO_FAULT",
      attempts: ESCALATE_AFTER_ATTEMPTS, transcript: "", created_at: 1,
    });
  });

  it("is never swept", async () => {
    expect(await selectSweepable(INSTANCE, NOW)).toHaveLength(0);
  });

  it("cannot be claimed", async () => {
    // The failure this would miss: the sweep posting an empty attachment and a
    // chatter note for the one meeting the user explicitly destroyed.
    expect(await claimRow("d-here", NOW)).toBe(false);
  });

  it("is counted by no arm of getQueueCounts", async () => {
    expect(await getQueueCounts(INSTANCE)).toMatchObject({
      waiting: 0, needsAttention: 0, unassigned: 0, otherInstance: 0, lastError: null,
    });
  });

  it("is counted by neither countAllQueued nor countActionableQueued", async () => {
    expect(await countAllQueued()).toBe(0);
    expect(await countActionableQueued()).toBe(0);
  });
});

describe("countActionableQueued", () => {
  it("counts the failed and unassigned rows countAllQueued deliberately omits", async () => {
    // countAll's predicate feeds /odoo's promise "finish setting Odoo up and
    // they will be sent", which is false for `failed` (terminal until a manual
    // retry) and `unassigned` (needs a contact, not credentials). This page
    // needs its own count or a user whose backlog is entirely those two sees a
    // BLANK page - no groups because the config is incomplete, no stranded line
    // because the count is zero.
    seed({ id: "f", session_key: "f", status: "failed" });
    seed({ id: "u", session_key: "u", status: "unassigned" });

    expect(await countAllQueued()).toBe(0);
    expect(await countActionableQueued()).toBe(2);
  });

  it("ignores instance entirely", async () => {
    seed({ id: "o", session_key: "o", status: "pending", instance: OTHER });
    expect(await countActionableQueued()).toBe(1);
  });
});

describe("pruneTranscripts", () => {
  const OLD = NOW - RETENTION_MS - 1;

  it("blanks transcript and summary on sent and cancelled rows past the cutoff", async () => {
    seed({ id: "s", session_key: "s", status: "sent", transcript: "text", summary_json: "{}", created_at: OLD });
    seed({ id: "c", session_key: "c", status: "cancelled", transcript: "text", summary_json: "{}", created_at: OLD });

    expect(await pruneTranscripts(NOW)).toBe(2);

    expect(await getQueueRow("s")).toMatchObject({ transcript: "", summary_json: null });
    expect(await getQueueRow("c")).toMatchObject({ transcript: "", summary_json: null });
  });

  it.each(["failed", "unassigned", "pending", "held", "sending"])(
    "leaves a %s row untouched at ANY age",
    async (status) => {
      // Those five may all still be pushed, and a pushed row with a blanked
      // transcript uploads an EMPTY attachment to a customer record.
      seed({ id: "r", session_key: "r", status, transcript: "text", created_at: OLD });
      expect(await pruneTranscripts(NOW)).toBe(0);
      expect(await getQueueRow("r")).toMatchObject({ transcript: "text" });
    }
  );

  it("blanks a past-cutoff row whose transcript is ALREADY blank but summary_json is not", async () => {
    // The predicate is `(transcript <> '' OR summary_json IS NOT NULL)`. Every
    // other case here has both columns non-empty together, so a mutant
    // dropping the OR arm entirely (leaving only `transcript <> ''`) survives
    // them all. That mutant would strand the AI digest - title, summary,
    // decisions, action items, participants, named people - on a row the user
    // believes was pruned.
    seed({
      id: "digest-only", session_key: "digest-only", status: "sent",
      transcript: "", summary_json: '{"title":"Q3 renewal"}', created_at: OLD,
    });

    expect(await pruneTranscripts(NOW)).toBe(1);

    expect(await getQueueRow("digest-only")).toMatchObject({ summary_json: null });
  });

  it("leaves a past-cutoff DELETED row alone", async () => {
    // The deliberate negative. `deleted` is absent from the predicate because
    // the delete action blanks both columns in the same statement that sets the
    // status, so the clause would be dead. Delete, not retention, blanks those.
    seed({ id: "d", session_key: "d", status: "deleted", transcript: "leftover", created_at: OLD });
    expect(await pruneTranscripts(NOW)).toBe(0);
    expect(await getQueueRow("d")).toMatchObject({ transcript: "leftover" });
  });

  it("leaves a recent sent row alone", async () => {
    seed({ id: "s", session_key: "s", status: "sent", transcript: "text", created_at: NOW });
    expect(await pruneTranscripts(NOW)).toBe(0);
  });

  it("is idempotent and never touches a timestamp", async () => {
    seed({
      id: "s", session_key: "s", status: "sent", transcript: "text", summary_json: null,
      created_at: OLD, transcript_start_at: 11, transcript_end_at: 22, sent_at: 33,
    });

    expect(await pruneTranscripts(NOW)).toBe(1);
    expect(await pruneTranscripts(NOW)).toBe(0); // rowsAffected stays meaningful

    expect(await getQueueRow("s")).toMatchObject({
      transcript_start_at: 11, transcript_end_at: 22, sent_at: 33, created_at: OLD,
    });
  });
});

describe("getQueueTranscript", () => {
  it("returns the stored text", async () => {
    seed({ id: "r", status: "failed", transcript: "You: hello" });
    expect(await getQueueTranscript("r")).toBe("You: hello");
  });

  it("distinguishes a blanked transcript from a missing row", async () => {
    // "" means removed; null means no row. Collapsing them tells a user their
    // meeting text was deliberately destroyed when the row simply is not there.
    seed({ id: "r", status: "deleted", transcript: "" });
    expect(await getQueueTranscript("r")).toBe("");
    expect(await getQueueTranscript("nope")).toBeNull();
  });
});

describe("migration 14 backfill", () => {
  // This assertion holds identically with or without the migration's WHERE
  // guard: INSERT OR IGNORE already skips a row that would violate res_id
  // NOT NULL, so a both-NULL row produces zero targets either way. The guard
  // states that intent explicitly rather than being load-bearing for it.
  it("backfills an unassigned legacy row to zero targets", async () => {
    const db = await seedPre14([
      { id: "r1", contact_id: null, lead_id: null, status: "unassigned" },
    ]);
    await applyMigration14(db);
    expect(rows(db, "SELECT * FROM meeting_log_targets")).toHaveLength(0);
  });

  it("backfills a lead row to one crm.lead target", async () => {
    const db = await seedPre14([
      { id: "r1", contact_id: 7, lead_id: 90, status: "pending" },
    ]);
    await applyMigration14(db);
    const t = rows(db, "SELECT * FROM meeting_log_targets");
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ row_id: "r1", model: "crm.lead", res_id: 90 });
  });

  it("backfills a contact-only row to one res.partner target", async () => {
    const db = await seedPre14([
      { id: "r1", contact_id: 7, lead_id: null, status: "pending" },
    ]);
    await applyMigration14(db);
    const t = rows(db, "SELECT * FROM meeting_log_targets");
    expect(t[0]).toMatchObject({ model: "res.partner", res_id: 7 });
  });

  it("carries attachment_id and message_id across for an in-flight row", async () => {
    const db = await seedPre14([
      { id: "r1", contact_id: 7, lead_id: null, status: "sending",
        attachment_id: 111, message_id: 222 },
    ]);
    await applyMigration14(db);
    const t = rows(db, "SELECT * FROM meeting_log_targets")[0];
    expect(t).toMatchObject({ attachment_id: 111, message_id: 222, status: "pending" });
  });

  it("maps sent to sent and failed to failed, everything else to pending", async () => {
    const db = await seedPre14([
      { id: "a", contact_id: 1, lead_id: null, status: "sent" },
      { id: "b", contact_id: 2, lead_id: null, status: "failed" },
      { id: "c", contact_id: 3, lead_id: null, status: "held" },
    ]);
    await applyMigration14(db);
    const byRow = Object.fromEntries(
      rows(db, "SELECT row_id, status FROM meeting_log_targets").map((r) => [r.row_id, r.status]),
    );
    expect(byRow).toEqual({ a: "sent", b: "failed", c: "pending" });
  });
});
