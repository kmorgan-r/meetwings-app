import fs from "node:fs";
import path from "node:path";
import initSqlJs, { type Database as SqlJsDatabase } from "sql.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbMeetingLogRow } from "@/types";
import type { PushDeps } from "@/lib/odoo/meeting-log-push";

let db: SqlJsDatabase;

/** The real sql.js reads/writes, unwrapped - both for the getDatabase mock
 * below and for fixture setup/assertions in test bodies (seedRow, seedTargets,
 * mockPush, readRow). */
async function rawExecute(sql: string, params: unknown[] = []) {
  db.run(sql, params as never[]);
  return { rowsAffected: db.getRowsModified(), lastInsertId: 0 };
}

async function rawSelect(sql: string, params: unknown[] = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params as never[]);
  const rows: Record<string, unknown>[] = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

// A REAL sql.js database backs this file now, not a fully-stubbed db-action
// layer: Task 10's new functions (retryTarget, removeQueueTarget) reach
// `getDatabase()` directly, and its partial-send classification re-reads
// `meeting_log_targets` from wherever `getDatabase()` points - a canned mock
// return value cannot stand in for that re-read.
vi.mock("@/lib/database/config", () => ({
  getDatabase: async () => ({ execute: rawExecute, select: rawSelect }),
}));

// A PARTIAL mock, not a full stub. Every export of the real module passes
// through unchanged (listTargets, deriveRowStatus, QUEUE_SQL, cancelHeldRow,
// sweepOrphanTargets, insertQueueRow, ...) EXCEPT the seven functions wrapped
// in `vi.fn(actual.fn)` below, which stay overridable per test exactly as the
// old full-stub `action` object was - `vi.fn(impl)`'s `mockReset()` restores
// THIS impl (the real one), not an empty stub, so a test that does not
// override one of these seven gets genuine database-backed behaviour by
// default. That default is what the new push-partial/retryTarget/
// removeQueueTarget tests below run against; every pre-existing test that DOES
// override one of these seven (`action.getQueueRow.mockResolvedValueOnce(...)`
// etc.) is completely unaffected; its canned row is never seeded into the real
// db, so a call from new code to a NOT-wrapped real function (listTargets,
// namely) simply sees an empty table for that id, matching the old code's
// classification exactly.
vi.mock("@/lib/database/meeting-log.action", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/database/meeting-log.action")>();
  return {
    ...actual,
    retryQueueRow: vi.fn(actual.retryQueueRow),
    assignQueueRow: vi.fn(actual.assignQueueRow),
    deleteQueueRow: vi.fn(actual.deleteQueueRow),
    deleteTerminalQueueRow: vi.fn(actual.deleteTerminalQueueRow),
    getQueueRow: vi.fn(actual.getQueueRow),
    pruneTranscripts: vi.fn(actual.pruneTranscripts),
    reclaimStaleSending: vi.fn(actual.reclaimStaleSending),
  };
});

const push = vi.hoisted(() => ({
  // Typed with two REQUIRED params (row, deps), not inferred from a bare
  // `async () => {}` - `mockPush` below needs `.mockImplementation` to accept
  // a two-arg function, and a zero-arg inferred type would reject that at
  // the type level.
  pushQueuedRow: vi.fn(async (_row: DbMeetingLogRow, _deps: PushDeps) => {}),
  runMeetingLogSweep: vi.fn(async () => ({ ran: true, pushed: 0 })),
  // Declared so the ban below is ASSERTABLE. Without this key the guard's
  // property path is permanently absent and the assertion passes no matter what
  // the implementation does - the highest-stakes constraint in the slice,
  // guarded by an expression that cannot fail.
  reclaimStaleSending: vi.fn(async () => {}),
  claimed: new Set<string>(),
}));
vi.mock("@/lib/odoo/meeting-log-push", () => push);

const summarizer = vi.hoisted(() => ({
  generateMeetingLogSummary: vi.fn(async () => ({ title: "T", summary: "S" })),
}));
vi.mock("@/lib/functions/meeting-summarizer", () => summarizer);

const config = vi.hoisted(() => ({
  requireOdooConfig: vi.fn(async () => ({
    url: "http://h:8069", db: "odoo", login: "a@b.c", apiKey: "k",
  })),
  instanceFingerprint: vi.fn(() => "http://h:8069|odoo"),
}));
vi.mock("@/lib/storage/odoo-config.storage", () => config);

// A distinguishable SENTINEL, not a plausible client shape. `runAction` must
// hand the push the client it built from the config it just resolved, and the
// only way to tell that apart from the caller's is to make the two objects
// visibly different.
const odooClient = vi.hoisted(() => ({
  createOdooClient: vi.fn(() => ({ id: "fresh" })),
}));
vi.mock("@/lib/odoo/client", () => odooClient);

import { SUMMARIZE_TIMEOUT_MS } from "@/lib/odoo/meeting-log";
import {
  assignQueueRow,
  cancelHeldRow,
  deleteQueueRow,
  deleteTerminalQueueRow,
  deriveRowStatus,
  getQueueRow,
  listTargets,
  pruneTranscripts,
  reclaimStaleSending,
  retryQueueRow,
  sweepOrphanTargets,
} from "@/lib/database/meeting-log.action";
import {
  assignMeetingLog, boundedSummarize, deleteMeetingLog, removeQueueTarget,
  retryMeetingLog, retryTarget,
} from "@/lib/odoo/meeting-log-actions";
import { MIGRATIONS, applyMigration14 } from "./helpers/migration-14";

// `vi.mocked` casts these imported bindings to their proper Mock<> type -
// they ARE the same vi.fn() objects the mock factory above wrapped
// (actual.fn), just typed so `.mockResolvedValueOnce`/`.mockReset()` etc.
// type-check. Every `action.xxx` call site below is unchanged from before
// Task 10 - only the factory that produces these bindings changed, from a
// full hand-written stub to a partial real-module wrap.
const action = {
  retryQueueRow: vi.mocked(retryQueueRow),
  assignQueueRow: vi.mocked(assignQueueRow),
  deleteQueueRow: vi.mocked(deleteQueueRow),
  deleteTerminalQueueRow: vi.mocked(deleteTerminalQueueRow),
  getQueueRow: vi.mocked(getQueueRow),
  pruneTranscripts: vi.mocked(pruneTranscripts),
  reclaimStaleSending: vi.mocked(reclaimStaleSending),
};

const INSTANCE = "http://h:8069|odoo";
const NOW = 1_700_000_000_000;

/** The pre-Task-10 canned row shape, for tests that mock `getQueueRow`
 * directly and never touch the real database. */
function dbRow(over: Record<string, unknown> = {}) {
  return {
    id: "r", session_key: "k", conversation_id: null, instance: INSTANCE,
    contact_id: 42, lead_id: null, transcript: "You: hi",
    transcript_start_at: 1, transcript_end_at: 2, summary_json: null,
    attachment_id: null, message_id: null, status: "pending", attempts: 1,
    claimed_at: null, last_error: null, last_error_code: null,
    meeting_started_at: 1, created_at: 1, sent_at: null,
    ...over,
  };
}

/** Straight into the real meeting_log_queue table, for the tests below that
 * exercise the real db-action layer. */
function seedRow(over: Partial<DbMeetingLogRow> = {}): void {
  const row = {
    id: "r1", session_key: "k1", conversation_id: "conv-1", instance: INSTANCE,
    contact_id: 42, lead_id: null, transcript: "You: hello",
    transcript_start_at: 1000, transcript_end_at: 2000, summary_json: null,
    attachment_id: null, message_id: null, status: "pending", attempts: 0,
    claimed_at: null, last_error: null, last_error_code: null,
    meeting_started_at: 1000, created_at: NOW, sent_at: null,
    ...over,
  } as DbMeetingLogRow;
  db.run(
    `INSERT INTO meeting_log_queue (${Object.keys(row).join(",")}) ` +
      `VALUES (${Object.keys(row).map(() => "?").join(",")})`,
    Object.values(row) as never[]
  );
}

interface SeedTarget {
  resId: number;
  model?: "res.partner" | "crm.lead";
  status?: "pending" | "sent" | "failed";
  attachmentId?: number | null;
  messageId?: number | null;
  lastError?: string | null;
  lastErrorCode?: string | null;
  createdAt?: number;
}

/** Straight into meeting_log_targets, parallel to seedRow. */
function seedTargets(rowId: string, targets: SeedTarget[]): void {
  targets.forEach((t, i) => {
    const row = {
      id: `target-${rowId}-${i}`,
      row_id: rowId,
      model: t.model ?? "res.partner",
      res_id: t.resId,
      name: null,
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

/** getQueueRow, minus the null case - every caller here already seeded the row. */
async function readRow(id: string): Promise<DbMeetingLogRow> {
  const row = await getQueueRow(id);
  if (!row) throw new Error(`readRow: no such row ${id}`);
  return row;
}

/**
 * `mockPush`'s two-part contract: `runAction`'s partial-send classification
 * re-reads target counts from the database after the push runs, so this must
 * both REPLACE `pushQueuedRow` and PERFORM the underlying `meeting_log_targets`
 * writes in raw SQL (seedTargets-style) - resolving a return value alone
 * leaves that re-read seeing nothing, and every push-partial test below would
 * pass vacuously.
 *
 * Mirrors the real pushQueuedRow's shape closely enough to drive the
 * classification under test: claims (status -> 'sending', attempts + 1, same
 * as claimRow), writes the given resIds' outcomes onto their target rows, then
 * calls the REAL `deriveRowStatus(rowId, "sending", now)` - not a
 * reimplementation of its precedence rules - so the parent status this
 * produces always agrees with production's.
 */
function mockPush(outcome: { sent: number[]; failed: number[] }): void {
  push.pushQueuedRow.mockImplementation(async (row, deps) => {
    const now = deps.now();
    await rawExecute(
      `UPDATE meeting_log_queue SET status = 'sending', attempts = attempts + 1, claimed_at = ? WHERE id = ?`,
      [now, row.id]
    );
    for (const resId of outcome.sent) {
      await rawExecute(
        `UPDATE meeting_log_targets SET status = 'sent', sent_at = ?, last_error = NULL, last_error_code = NULL WHERE row_id = ? AND res_id = ?`,
        [now, row.id, resId]
      );
    }
    for (const resId of outcome.failed) {
      await rawExecute(
        `UPDATE meeting_log_targets SET status = 'failed', last_error_code = 'ODOO_FAULT', last_error = 'Odoo rejected the request' WHERE row_id = ? AND res_id = ?`,
        [row.id, resId]
      );
    }
    await deriveRowStatus(row.id, "sending", now);
  });
}

beforeEach(async () => {
  const wasmBinary = fs.readFileSync(
    path.resolve(__dirname, "../../node_modules/sql.js/dist/sql-wasm.wasm")
  );
  const SQL = await initSqlJs({ wasmBinary });
  db = new SQL.Database();
  db.run(fs.readFileSync(path.join(MIGRATIONS, "chat-history.sql"), "utf8"));
  db.run(fs.readFileSync(path.join(MIGRATIONS, "chat-history-v8.sql"), "utf8"));
  db.run(fs.readFileSync(path.join(MIGRATIONS, "odoo-contacts.sql"), "utf8"));
  db.run(fs.readFileSync(path.join(MIGRATIONS, "meeting-log-queue.sql"), "utf8"));
  db.run(fs.readFileSync(path.join(MIGRATIONS, "odoo-lead-only-target.sql"), "utf8"));
  await applyMigration14(db);

  vi.clearAllMocks();
  // `clearAllMocks` clears CALLS, not IMPLEMENTATIONS. Several cases below use
  // `getQueueRow.mockResolvedValue(...)`, which permanently replaces the
  // factory's real implementation for every LATER case in the file - so a case
  // that queues two `...Once` values and expects the third read to return null
  // would silently get the previous case's row instead. Order-coupled flake.
  // `mockReset` restores the implementation the factory passed to `vi.fn` -
  // the REAL `getQueueRow`, backed by the sql.js db above.
  action.getQueueRow.mockReset();
  action.retryQueueRow.mockResolvedValue(true);
  action.assignQueueRow.mockResolvedValue(true);
  action.deleteQueueRow.mockResolvedValue(true);
  // Default false: the terminal statement is the fallback, reached only when
  // the narrow one declines.
  action.deleteTerminalQueueRow.mockResolvedValue(false);
  push.pushQueuedRow.mockResolvedValue(undefined);
  config.requireOdooConfig.mockResolvedValue({
    url: "http://h:8069", db: "odoo", login: "a@b.c", apiKey: "k",
  });
  summarizer.generateMeetingLogSummary.mockResolvedValue({ title: "T", summary: "S" });
});

// `runAction` reads the row THREE times, and every `...Once` chain below must
// supply all three or the un-stubbed call falls through to the factory default
// (`null`) and the case returns `moved-unknown` instead of what it asserts:
//
//   1. BEFORE the CAS  - the instance check
//   2. `fresh`, after the CAS - the object handed to pushQueuedRow
//   3. `after`, after the push - the object the outcome is classified from
//
// Read that order off `runAction` in Step 3 before editing any sequence here.
describe("retryMeetingLog", () => {
  it("pushes the RE-READ row, not the caller's stale object", async () => {
    // The Retry-side discriminator. contact_id/lead_id do NOT change on a
    // retry, so a mutant that re-reads for assign and hands the list-time
    // object to retry survives every assign-side case. Assert on what the CAS
    // actually changed: status and last_error.
    action.getQueueRow
      .mockResolvedValueOnce(dbRow({ status: "failed", last_error: "boom" }))  // 1: pre-CAS
      .mockResolvedValueOnce(dbRow({ status: "pending", last_error: null, attempts: 4 })) // 2: fresh
      .mockResolvedValueOnce(dbRow({ status: "sent", attempts: 5 }));          // 3: after

    await retryMeetingLog("r", { providerConfig: null });

    expect(push.pushQueuedRow.mock.calls[0][0]).toMatchObject({
      status: "pending", last_error: null, attempts: 4,
    });
  });

  it("passes the fresher attempts count when the sweep ran in between", async () => {
    // attemptsBefore drives the idempotency-search guard. A list-time snapshot
    // can be stale by one attempt.
    action.getQueueRow
      .mockResolvedValueOnce(dbRow({ attempts: 7 }))                 // 1: pre-CAS
      .mockResolvedValueOnce(dbRow({ attempts: 7 }))                 // 2: fresh
      .mockResolvedValueOnce(dbRow({ attempts: 8, status: "sent" })); // 3: after

    await retryMeetingLog("r", { providerConfig: null });

    expect(push.pushQueuedRow.mock.calls[0][0]).toMatchObject({ attempts: 7 });
  });

  it("does not push when the CAS returns false", async () => {
    // The pre-CAS read must still succeed, or this returns `moved-unknown`
    // and stops testing the CAS at all.
    action.getQueueRow.mockResolvedValue(dbRow());
    action.retryQueueRow.mockResolvedValue(false);
    const out = await retryMeetingLog("r", { providerConfig: null });
    expect(push.pushQueuedRow).not.toHaveBeenCalled();
    expect(out).toEqual({ kind: "conflict" });
  });

  it("resolves credentials BEFORE the CAS, so a config throw leaves the row alone", async () => {
    // requireOdooConfig throws for exactly the half-filled config a user comes
    // to this page to fix. With the CAS first, that throw lands with the row
    // already flipped and its last_error already NULLed - making the error
    // table's "row unchanged" false and leaving nothing on screen.
    config.requireOdooConfig.mockRejectedValueOnce(new Error("nope"));

    const out = await retryMeetingLog("r", { providerConfig: null });

    expect(action.retryQueueRow).not.toHaveBeenCalled();
    expect(out.kind).toBe("failed");
  });

  it("pushes with a client REBUILT from the fresh config, never the caller's", async () => {
    // `runAction` deliberately ignores deps.client. The mutant
    // `deps.client ?? createOdooClient(config)` is invisible until Task 9's
    // AssignDialog starts passing one - and then it pushes on the client the
    // dialog built when it opened. instanceFingerprint is url|db only, so a
    // login or API-key rotation while the dialog sat open still matches the
    // fingerprint: the push goes out on revoked credentials and records a
    // spurious ODOO_AUTH_FAILED against a row that was fine.
    action.getQueueRow.mockResolvedValue(dbRow());
    const stale = { id: "stale" };

    await retryMeetingLog("r", { providerConfig: null, client: stale });

    const pushed = push.pushQueuedRow.mock.calls[0][1].client;
    expect(pushed).toEqual({ id: "fresh" });
    // The half the mutant breaks. `toEqual` alone would still pass if the two
    // sentinels ever converged in shape.
    expect(pushed).not.toBe(stale);
    expect(odooClient.createOdooClient).toHaveBeenCalledWith({
      url: "http://h:8069", db: "odoo", login: "a@b.c", apiKey: "k",
    });
  });

  it("fires onCommitted after the CAS and BEFORE the push", async () => {
    // Deleting `deps.onCommitted?.()` is invisible to every other case, and
    // Task 8 cannot cover it either: its page suite mocks this module, so it
    // can only assert the page PASSES a callback, never that runAction FIRES
    // one. Split across two mocked boundaries the hook is untested on both
    // sides. Without it the row renders its pre-click status for the whole
    // push - up to five 30s Odoo calls plus a summarize.
    action.getQueueRow.mockResolvedValue(dbRow());
    const onCommitted = vi.fn();

    await retryMeetingLog("r", { providerConfig: null, onCommitted });

    expect(onCommitted).toHaveBeenCalledTimes(1);
    // ORDER, not two call counts. "Both were called" passes with the hook
    // moved after the push, which is the one arrangement that makes it useless.
    expect(onCommitted.mock.invocationCallOrder[0])
      .toBeLessThan(push.pushQueuedRow.mock.invocationCallOrder[0]);
  });

  it("does NOT fire onCommitted when the CAS is refused", async () => {
    // A hook that fires on a refused CAS makes the page re-read the list for
    // nothing on every conflict - and conflicts are the common case when two
    // windows are open, which is the whole reason the CAS exists.
    action.getQueueRow.mockResolvedValue(dbRow());
    action.retryQueueRow.mockResolvedValue(false);
    const onCommitted = vi.fn();

    await retryMeetingLog("r", { providerConfig: null, onCommitted });

    expect(onCommitted).not.toHaveBeenCalled();
  });

  it("samples `now` after the credentials resolve, never before", async () => {
    // claimRow writes `now` straight into claimed_at. A pre-aged claimed_at
    // makes the row eligible for the main window's reclaim WHILE this push is
    // live - two attachments and two customer-visible chatter notes.
    //
    // The credential step is given MEASURABLE DURATION on purpose. Against an
    // immediately-resolving mock the discriminating window is 0 ms, so
    // `now >= (a timestamp taken before the call)` is satisfied by a `now`
    // sampled anywhere inside it - INCLUDING the mutant this case is named for.
    let afterCreds = 0;
    config.requireOdooConfig.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 25));
      afterCreds = Date.now();
      return { url: "http://h:8069", db: "odoo", login: "a@b.c", apiKey: "k" };
    });
    action.getQueueRow.mockResolvedValue(dbRow());

    await retryMeetingLog("r", { providerConfig: null });

    // Task 9 bridge: PushDeps.now is `() => number` now, sampled fresh on
    // every read - not a scalar the caller sampled once. Call it to get the
    // value this assertion actually cares about.
    expect(push.pushQueuedRow.mock.calls[0][1].now()).toBeGreaterThanOrEqual(afterCreds);
  });

  it("reports a no-op when the push wrote nothing", async () => {
    // pushQueuedRow has FOUR silent early exits that write nothing at all.
    // attempts unchanged proves the claim never happened. All three reads
    // return the same row, so `mockResolvedValue` is clearer than three onces.
    action.getQueueRow.mockResolvedValue(dbRow({ attempts: 3 }));

    expect(await retryMeetingLog("r", { providerConfig: null })).toEqual({ kind: "no-op" });
  });

  it("reports push-failed when the push ran and the row did NOT reach sent", async () => {
    // pushQueuedRow's post-wire catch (releaseRowToPending / failRow) bumps
    // attempts and leaves a non-sending status with last_error written, so
    // neither the attempts check nor the sending check sees it. Without the
    // `after.status !== "sent"` gate this is classified `degraded` and the page
    // tells the user a note is live on a customer's record. This row's id ("r")
    // is never seeded into the real database in this describe, so the new
    // push-partial re-read sees zero targets and correctly does not fire.
    summarizer.generateMeetingLogSummary.mockResolvedValue(null);
    action.getQueueRow
      .mockResolvedValueOnce(dbRow({ attempts: 1, status: "failed" }))    // 1: pre-CAS
      .mockResolvedValueOnce(dbRow({ attempts: 1, status: "pending" }))   // 2: fresh
      .mockResolvedValueOnce(dbRow({                                      // 3: after
        attempts: 2, status: "failed", last_error: "ODOO_UNREACHABLE: ...",
      }));

    expect(await retryMeetingLog("r", { providerConfig: null }))
      .toEqual({ kind: "push-failed" });
  });

  it("refuses an other-instance row BEFORE the CAS, leaving last_error intact", async () => {
    // Checking after the CAS would have already NULLed last_error on a row
    // belonging to a database this install no longer points at - and
    // selectSweepable filters by instance, so nothing would ever pick it up.
    action.getQueueRow.mockResolvedValue(dbRow({ instance: "http://h:8069|staging" }));

    const out = await retryMeetingLog("r", { providerConfig: null });

    expect(action.retryQueueRow).not.toHaveBeenCalled();
    expect(push.pushQueuedRow).not.toHaveBeenCalled();
    expect(out).toEqual({ kind: "conflict" });
  });

  it("reports still-sending when the row is left sending with attempts bumped", async () => {
    // The FIFTH path: the terminal status write itself failed, so the inner
    // catch wrote nothing, but attempts DID increment. An attempts-only
    // comparison calls this success while the row shows "Sending..." for a full
    // STALE_CLAIM_MS.
    action.getQueueRow
      .mockResolvedValueOnce(dbRow({ attempts: 3, status: "failed" }))    // 1: pre-CAS
      .mockResolvedValueOnce(dbRow({ attempts: 3, status: "pending" }))   // 2: fresh
      .mockResolvedValueOnce(dbRow({ attempts: 4, status: "sending" }));  // 3: after

    expect(await retryMeetingLog("r", { providerConfig: null }))
      .toEqual({ kind: "still-sending" });
  });

  it("reports moved-unknown when the post-CAS re-read throws", async () => {
    // Two mandated awaits sit AFTER the CAS and reject into the same catch. A
    // SQLITE_BUSY there must not render "row genuinely unchanged" about a row
    // that was requeued and error-cleared.
    //
    // The PRE-CAS read must RESOLVE and only the `fresh` read reject. A bare
    // `mockRejectedValueOnce` lands on read 1 instead, where nothing has been
    // written yet - that path correctly returns `failed`, so the case would
    // assert the wrong branch and pass for the wrong reason.
    action.getQueueRow
      .mockResolvedValueOnce(dbRow())                               // 1: pre-CAS, resolves
      .mockRejectedValueOnce(new Error("SQLITE_BUSY"));             // 2: fresh, throws

    expect(await retryMeetingLog("r", { providerConfig: null }))
      .toEqual({ kind: "moved-unknown" });
  });
});

// Every call site below passes the real SelectedTargets shape
// (`[{model, resId, name}]`) directly - `action.assignQueueRow` is a mock in
// this describe, so the array's content is never inspected. Task 10 owns this
// file: these are the real calls, not a bridge.
describe("assignMeetingLog", () => {
  it("pushes the re-read row carrying the NEW target", async () => {
    action.getQueueRow
      // 1: pre-CAS - the UNASSIGNED shape, no target yet. Using the post-CAS
      // row here would let a mutant that pushes read 1 pass.
      .mockResolvedValueOnce(dbRow({ status: "unassigned", contact_id: null, lead_id: null }))
      .mockResolvedValueOnce(dbRow({ status: "pending", contact_id: 42, lead_id: 7 })) // 2: fresh
      .mockResolvedValueOnce(dbRow({ status: "sent", attempts: 2 }));                  // 3: after

    await assignMeetingLog("r", [{ model: "crm.lead", resId: 7, name: null }], { providerConfig: null });

    expect(push.pushQueuedRow.mock.calls[0][0]).toMatchObject({ contact_id: 42, lead_id: 7 });
  });

  it("does not push when the CAS returns false", async () => {
    action.getQueueRow.mockResolvedValue(dbRow());
    action.assignQueueRow.mockResolvedValue(false);
    const out = await assignMeetingLog("r", [{ model: "res.partner", resId: 42, name: null }], { providerConfig: null });
    expect(push.pushQueuedRow).not.toHaveBeenCalled();
    expect(out).toEqual({ kind: "conflict" });
  });

  it("INVOKES the summarize dep it hands to the push", async () => {
    // Not just passes it. The mutant is a summarize that resolves null
    // unconditionally - which is how slice 2 shipped three green AI-summary
    // tests over a path where the summary never reached Odoo.
    action.getQueueRow.mockResolvedValue(dbRow());

    await assignMeetingLog("r", [{ model: "res.partner", resId: 42, name: null }], { providerConfig: null });

    const deps = push.pushQueuedRow.mock.calls[0][1];
    const result = await deps.summarize({
      entries: [{ original: "hi", timestamp: 1 }], startAt: 1, endAt: 2,
    });

    expect(summarizer.generateMeetingLogSummary).toHaveBeenCalled();
    expect(result).not.toBeNull();
  });

  it("reports degraded when the summarize resolved null", async () => {
    // A configured-but-FAILING provider returns null identically to a missing
    // one, and pushQueuedRow swallows it a second time - so without this the
    // row reaches `sent`, toSent clears last_error, and the page reports
    // unqualified success while a "Summarization failed" note is live on the
    // customer's record.
    summarizer.generateMeetingLogSummary.mockResolvedValue(null);
    push.pushQueuedRow.mockImplementation(async (_row, deps) => {
      await deps.summarize({ entries: [{ original: "hi", timestamp: 1 }], startAt: 1, endAt: 2 });
    });
    action.getQueueRow
      .mockResolvedValueOnce(dbRow())                                  // 1: pre-CAS
      .mockResolvedValueOnce(dbRow())                                  // 2: fresh, attempts 1
      .mockResolvedValueOnce(dbRow({ status: "sent", attempts: 2 }));  // 3: after

    expect(await assignMeetingLog("r", [{ model: "res.partner", resId: 42, name: null }], { providerConfig: null }))
      .toEqual({ kind: "degraded" });
  });
});

describe("deleteMeetingLog", () => {
  it("never pushes", async () => {
    expect(await deleteMeetingLog("r")).toEqual({ kind: "ok" });
    expect(push.pushQueuedRow).not.toHaveBeenCalled();
  });

  it("reports a conflict when BOTH CAS statements refuse", async () => {
    action.deleteQueueRow.mockResolvedValue(false);
    action.deleteTerminalQueueRow.mockResolvedValue(false);
    expect(await deleteMeetingLog("r")).toEqual({ kind: "conflict" });
  });

  // The race this split exists for: the dashboard window re-reads only on
  // focus, mount and action, so a `held` row it is still rendering can already
  // be `sent` on disk by the time the click lands. The old single predicate
  // accepted it, returned `ok`, and the page said "Nothing was sent to Odoo."
  // about a note already on the customer's chatter.
  it("reports deleted-after-send when the row had already reached Odoo", async () => {
    action.deleteQueueRow.mockResolvedValue(false);
    action.deleteTerminalQueueRow.mockResolvedValue(true);
    expect(await deleteMeetingLog("r")).toEqual({ kind: "deleted-after-send" });
  });

  // ORDER, not just outcome. Reverse the two calls and a still-unsent row is
  // deleted by the terminal statement's sibling first - or, more precisely,
  // `ok` stops being proof of anything, because the branch that produced it
  // would no longer be the one with the narrow predicate.
  it("never reaches the terminal statement when the row was still unsent", async () => {
    action.deleteQueueRow.mockResolvedValue(true);
    expect(await deleteMeetingLog("r")).toEqual({ kind: "ok" });
    expect(action.deleteTerminalQueueRow).not.toHaveBeenCalled();
  });
});

describe("the cross-window rule", () => {
  it("NEITHER action calls runMeetingLogSweep or reclaimStaleSending", async () => {
    // The single most likely way this slice regresses slice 2, and it is
    // invisible in every other test. reclaimStaleSending excludes only the
    // CALLING realm's `claimed` set - empty in the dashboard window - so a
    // reclaim from here re-`pending`s a row the main window is mid-push on.
    action.getQueueRow.mockResolvedValue(dbRow());

    await retryMeetingLog("r", { providerConfig: null });
    await assignMeetingLog("r", [{ model: "res.partner", resId: 42, name: null }], { providerConfig: null });
    await deleteMeetingLog("r");

    expect(push.runMeetingLogSweep).not.toHaveBeenCalled();

    // TWO reclaim assertions, and NEITHER is redundant - do not delete one.
    //
    // reclaimStaleSending is DEFINED in the DB layer (meeting-log.action.ts:385)
    // and merely IMPORTED by meeting-log-push.ts:5. An import is not a
    // re-export, so the push module does not export the name at all: the `push.`
    // assertion below reads a mock key wired to nothing and cannot fail today.
    // An earlier pass added that key believing it made the ban assertable; it
    // did not, because it went on the wrong mock. The `action.` assertion is the
    // one a real violation routes through, and it is proven to fail - a call
    // added to deleteMeetingLog trips it.
    //
    // The `push.` assertion stays as a tripwire: if reclaimStaleSending is ever
    // relocated to or re-exported from meeting-log-push, it starts failing and
    // the `action.` one stops. Together they cover both homes.
    expect(action.reclaimStaleSending).not.toHaveBeenCalled();
    expect(push.reclaimStaleSending).not.toHaveBeenCalled();
  });
});

describe("an other-instance row", () => {
  it("never reaches pushQueuedRow from ASSIGN either", async () => {
    // Retry's half is covered by the pre-CAS case above. Both actions share
    // runAction's guard, but assert assign too: it is the path a user reaches
    // from the other-database group.
    action.getQueueRow.mockResolvedValue(dbRow({ instance: "http://h:8069|staging" }));

    await assignMeetingLog("r", [{ model: "res.partner", resId: 42, name: null }], { providerConfig: null });

    expect(action.assignQueueRow).not.toHaveBeenCalled();
    expect(push.pushQueuedRow).not.toHaveBeenCalled();
  });
});

// Task 10: the whole-row retry, per-target retry/remove, and runAction's new
// push-partial outcome. These run against the REAL sql.js database seeded by
// seedRow/seedTargets - not canned `getQueueRow` returns - so the classifier's
// re-read of `meeting_log_targets` (and retryTarget/removeQueueTarget's direct
// `getDatabase()` calls) see genuine state.
describe("queue-page per-target actions", () => {
  const deps = { providerConfig: null };

  beforeEach(() => {
    // The outer beforeEach stubs retryQueueRow/assignQueueRow/deleteQueueRow/
    // deleteTerminalQueueRow to fixed true/true/true/false defaults for the
    // canned-row describes above. These tests need the REAL CAS predicates
    // running against the row seedRow just wrote - `mockReset()` restores each
    // to the real implementation `vi.fn` was created with (see the mock
    // factory comment above).
    action.retryQueueRow.mockReset();
    action.assignQueueRow.mockReset();
    action.deleteQueueRow.mockReset();
    action.deleteTerminalQueueRow.mockReset();
  });

  describe("runAction's push-partial outcome", () => {
    it("reports a partial send rather than claiming nothing was sent", async () => {
      seedRow({ id: "r1", status: "pending" });
      seedTargets("r1", [
        { resId: 1, status: "pending" },
        { resId: 2, status: "pending" },
      ]);
      mockPush({ sent: [1], failed: [2] });

      const res = await retryMeetingLog("r1", deps);

      expect(res.kind).toBe("push-partial");
      expect((res as { sentCount: number }).sentCount).toBe(1);
      expect((res as { failedCount: number }).failedCount).toBe(1);
    });

    it("still reports push-failed when nothing landed", async () => {
      seedRow({ id: "r1", status: "pending" });
      seedTargets("r1", [{ resId: 1, status: "pending" }]);
      mockPush({ sent: [], failed: [1] });

      expect((await retryMeetingLog("r1", deps)).kind).toBe("push-failed");
    });

    it("reports a partial send even when this pass changed nothing", async () => {
      // The delta is zero: target 3 faults again. Classifying on the delta
      // would fall through to push-failed and print "This meeting could not be
      // sent" while two notes are live on two customers' chatter - the exact
      // lie this task exists to remove, reintroduced on the retry path the
      // feature adds.
      seedRow({ id: "r1", status: "failed" });
      seedTargets("r1", [
        { resId: 1, status: "sent" },
        { resId: 2, status: "sent" },
        { resId: 3, status: "failed", lastErrorCode: "ODOO_FAULT" },
      ]);
      mockPush({ sent: [], failed: [3] });

      expect((await retryMeetingLog("r1", deps)).kind).toBe("push-partial");
    });

    // Final review, Important 2: distinct from the case above - THIS pass
    // never even claims the row. `mockPush` is deliberately NOT called, so
    // `push.pushQueuedRow` keeps the outer `beforeEach`'s default
    // `mockResolvedValue(undefined)` - a genuine no-op that writes nothing at
    // all, standing in for pushQueuedRow's own pre-claim early exits
    // (`listTargets` throwing, or `claimRow` losing). `attempts` is therefore
    // unchanged after the "push", which used to be classified `no-op`
    // ("nothing reached Odoo") - false here, because target 1's note is
    // already live on the customer's chatter from an earlier pass.
    it("reports a partial send, not a no-op, when the push never even claims the row", async () => {
      seedRow({ id: "r1", status: "failed", attempts: 1 });
      seedTargets("r1", [
        { resId: 1, status: "sent" },
        { resId: 2, status: "failed", lastErrorCode: "ODOO_FAULT" },
      ]);

      const res = await retryMeetingLog("r1", deps);

      expect(res).toEqual({
        kind: "push-partial", sentCount: 1, failedCount: 0, pendingCount: 1,
      });
    });
  });

  describe("retryTarget", () => {
    it("surfaces a refusal when the row moved underneath the caller", async () => {
      seedRow({ id: "r1", status: "failed" });
      seedTargets("r1", [{ resId: 1, status: "failed", lastErrorCode: "ODOO_FAULT" }]);
      const t = (await listTargets("r1"))[0];
      await rawExecute("UPDATE meeting_log_queue SET status = 'sending' WHERE id = ?", ["r1"]);

      expect(await retryTarget("r1", t.id)).toMatchObject({ kind: "conflict" });
    });

    it("resets the child, not just the parent, on a per-target retry", async () => {
      seedRow({ id: "r1", status: "failed" });
      seedTargets("r1", [
        { resId: 1, status: "sent" },
        { resId: 2, status: "failed", lastError: "boom", lastErrorCode: "ODOO_FAULT" },
      ]);
      const t = (await listTargets("r1")).find((x) => x.resId === 2)!;

      expect(await retryTarget("r1", t.id)).toMatchObject({ kind: "ok" });

      const after = (await listTargets("r1")).find((x) => x.resId === 2)!;
      expect(after.status).toBe("pending");
      expect(after.lastErrorCode).toBeNull();
      expect(await readRow("r1")).toMatchObject({ status: "pending" });
    });

    it("refuses to retry a sent target", async () => {
      seedRow({ id: "r1", status: "failed" });
      seedTargets("r1", [{ resId: 1, status: "sent" }]);
      const t = (await listTargets("r1"))[0];

      expect(await retryTarget("r1", t.id)).toMatchObject({ kind: "refused" });
      expect((await listTargets("r1"))[0].status).toBe("sent");
    });
  });

  describe("retryMeetingLog resets failed children on a whole-row retry", () => {
    it("resets every failed child and no sent child on a whole-row retry", async () => {
      seedRow({ id: "r1", status: "failed" });
      seedTargets("r1", [
        { resId: 1, status: "sent" },
        { resId: 2, status: "failed", lastErrorCode: "ODOO_FAULT" },
        { resId: 3, status: "failed", lastErrorCode: "ODOO_FAULT" },
      ]);

      await retryMeetingLog("r1", deps);

      const t = await listTargets("r1");
      expect(t.find((x) => x.resId === 1)!.status).toBe("sent");
      expect(t.filter((x) => x.status === "pending").map((x) => x.resId)).toEqual([2, 3]);
    });

    // `targetToPending`'s own `AND status <> 'sent'` guard already protects a
    // SENT child from a code-level mistake that resets every child regardless
    // of status - so a mutant that drops the `status === "failed"` filter is
    // invisible to the sent-target assertion above (the SQL statement no-ops
    // on its own). A PENDING child is not protected by that SQL guard at all:
    // only the code-level filter keeps a whole-row retry from touching one
    // that was never failed, and its carried-over error code - a real,
    // documented case (deriveRowStatus's "pending target's own carried-over
    // error", meeting-log.action.ts) - is what proves whether it was touched.
    it("leaves an already-pending child's carried error alone on a whole-row retry", async () => {
      seedRow({ id: "r1", status: "failed" });
      seedTargets("r1", [
        { resId: 1, status: "failed", lastErrorCode: "ODOO_FAULT" },
        { resId: 2, status: "pending", lastErrorCode: "STALE_CODE", lastError: "stale" },
      ]);

      await retryMeetingLog("r1", deps);

      const pending = (await listTargets("r1")).find((x) => x.resId === 2)!;
      expect(pending.lastErrorCode).toBe("STALE_CODE");
      expect(pending.lastError).toBe("stale");
    });
  });

  describe("removeQueueTarget", () => {
    it("refuses to remove a sent target", async () => {
      seedRow({ id: "r1", status: "failed" });
      seedTargets("r1", [{ resId: 1, status: "sent" }]);
      const t = (await listTargets("r1"))[0];

      await expect(removeQueueTarget("r1", t.id)).resolves.toMatchObject({ kind: "refused" });
      expect(await listTargets("r1")).toHaveLength(1);
    });

    // Final review, Important 3: `attachmentId`/`messageId` are persisted
    // BEFORE the terminal `targetToSent` write (meeting-log-push.ts), so a
    // target whose `message_post` succeeded and whose local status write did
    // not ends `pending` - not `sent` - with a real note already live on the
    // chatter. `status === "sent"` alone missed this target entirely; this
    // proves the guard now also keys on the ids it left behind.
    it("refuses to remove a pending target whose note already reached the chatter", async () => {
      seedRow({ id: "r1", status: "failed" });
      seedTargets("r1", [{ resId: 1, status: "pending", messageId: 501 }]);
      const t = (await listTargets("r1"))[0];

      await expect(removeQueueTarget("r1", t.id)).resolves.toMatchObject({ kind: "refused" });
      expect(await listTargets("r1")).toHaveLength(1);
    });

    it("flips the parent to unassigned when the last target is removed", async () => {
      seedRow({ id: "r1", status: "failed" });
      seedTargets("r1", [{ resId: 1, status: "failed", lastErrorCode: "ODOO_FAULT" }]);
      const t = (await listTargets("r1"))[0];

      await removeQueueTarget("r1", t.id);

      expect(await readRow("r1")).toMatchObject({ status: "unassigned" });
    });

    it("re-derives to sent when the only failed target is removed", async () => {
      seedRow({ id: "r1", status: "failed" });
      seedTargets("r1", [
        { resId: 1, status: "sent" },
        { resId: 2, status: "failed", lastErrorCode: "ODOO_FAULT" },
      ]);
      const t = (await listTargets("r1")).find((x) => x.resId === 2)!;

      await removeQueueTarget("r1", t.id);

      expect(await readRow("r1")).toMatchObject({ status: "sent" });
    });

    // Carried fact 2: `held` is deliberately absent from DERIVE_FORBIDDEN in
    // the DB layer, because nothing before Task 10 ever called deriveRowStatus
    // with an observed `held` - a caller that did would end the 30s undo
    // window early. removeQueueTarget is the one new function that reaches
    // deriveRowStatus, and nothing about its target-level checks (target not
    // found, target already sent) would stop it from being called on a `held`
    // row that already has a target (the hold-timer flow can seed one). This
    // proves the guard added for that case actually holds, rather than just
    // asserting it by inspection.
    it("refuses to remove a target from a held row, never ending the undo window early", async () => {
      seedRow({ id: "r1", status: "held" });
      seedTargets("r1", [{ resId: 1, status: "pending" }]);
      const t = (await listTargets("r1"))[0];

      expect(await removeQueueTarget("r1", t.id)).toMatchObject({ kind: "refused" });

      expect(await readRow("r1")).toMatchObject({ status: "held" });
      expect(await listTargets("r1")).toHaveLength(1);
    });

    // Review round 1, Important finding #1: `sending` is deliberately absent
    // from DERIVE_FORBIDDEN (the push itself must CAS out of it), so an
    // unguarded removeQueueTarget's deriveRowStatus call would MATCH an
    // observed `sending` instead of landing in the zero-rows fail-safe branch
    // - clearing claimed_at and writing a new status out from under a push
    // that can hold `sending` for up to ~30s per target across five targets.
    // The live push's restampClaim then aborts (self-correcting), but the row
    // becomes claimable by a second sweep before the first notices - the
    // duplicate-note race the claim mechanism exists to prevent.
    it("refuses to remove a target while the row is sending, closing the duplicate-note race", async () => {
      seedRow({ id: "r1", status: "sending" });
      seedTargets("r1", [{ resId: 1, status: "failed", lastErrorCode: "ODOO_FAULT" }]);
      const t = (await listTargets("r1"))[0];

      expect(await removeQueueTarget("r1", t.id)).toMatchObject({ kind: "refused" });

      expect(await readRow("r1")).toMatchObject({ status: "sending" });
      expect(await listTargets("r1")).toHaveLength(1);
    });

    // Review round 1, Important finding #2: the delete is irreversible and
    // already committed by the time the parent's re-derive could lose its own
    // CAS - that must never be reported as `conflict` (which means nothing
    // was written everywhere else in this codebase). Models a genuine TOCTOU:
    // something else (a real concurrent claim) moves the row between
    // removeQueueTarget's `before` read and its deriveRowStatus call, by
    // intercepting exactly that one read and mutating the row via raw SQL
    // before returning the value the function actually observed.
    it("reports the removal as done, not a conflict, when the parent's re-derive loses its race", async () => {
      seedRow({ id: "r1", status: "failed" });
      seedTargets("r1", [{ resId: 1, status: "failed", lastErrorCode: "ODOO_FAULT" }]);
      const t = (await listTargets("r1"))[0];

      action.getQueueRow.mockImplementationOnce(async () => {
        const [raw] = await rawSelect("SELECT * FROM meeting_log_queue WHERE id = ?", ["r1"]);
        await rawExecute("UPDATE meeting_log_queue SET status = 'sending' WHERE id = ?", ["r1"]);
        return raw as unknown as DbMeetingLogRow;
      });

      const res = await removeQueueTarget("r1", t.id);

      expect(res).toMatchObject({ kind: "removed-parent-stale" });
      // The removal itself DID happen - that is the whole point of the outcome.
      expect(await listTargets("r1")).toHaveLength(0);
    });
  });

  describe("cancel and the orphan sweep", () => {
    it("leaves a cancelled meeting's children in place, and the sweep does not take them", async () => {
      // The spec asserts undo is untouched: cancelHeldRow flips the parent and
      // never claims a child. Those children are NOT orphans - the parent row
      // still exists (as `cancelled`, never hard-deleted anywhere in this
      // codebase - see purgeOtherInstances' own documented exemption) - so the
      // startup sweep's NOT IN clause correctly ignores them.
      seedRow({ id: "r1", status: "held" });
      seedTargets("r1", [{ resId: 1, status: "pending", createdAt: 0 }]);

      await cancelHeldRow("r1");

      expect(await readRow("r1")).toMatchObject({ status: "cancelled" });
      expect(await listTargets("r1")).toHaveLength(1);
      expect(await sweepOrphanTargets(1_000)).toBe(0);
      expect(await listTargets("r1")).toHaveLength(1);
    });
  });
});

// Tested DIRECTLY, not through runAction: the bound is a 60s race and driving
// it end to end would mean faking timers around the whole orchestration.
//
// FAKE TIMERS ARE SCOPED TO THIS DESCRIBE. The `now`-sampling case above needs
// a REAL 25 ms delay in requireOdooConfig - the whole point of that case is a
// measurable window - so fake timers leaking up to the file level would hang
// it against correct code.
describe("boundedSummarize", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves null once SUMMARIZE_TIMEOUT_MS elapses on a call that never settles", async () => {
    // fetchAIResponse has NO timeout of its own. An unbounded summarize is the
    // one way a dashboard push crosses STALE_CLAIM_MS, which lets the main
    // window's reclaim re-`pending` a row this window still has in flight:
    // two attachments and two customer-visible chatter notes. Replacing the
    // Promise.race with a plain await leaves every other case in this file
    // green, and nothing else in the slice covers it.
    summarizer.generateMeetingLogSummary.mockImplementation(() => new Promise(() => {}));
    const { summarize, didSummarize } = boundedSummarize(null);

    const pending = summarize({ entries: [], startAt: 1, endAt: 2 });
    await vi.advanceTimersByTimeAsync(SUMMARIZE_TIMEOUT_MS);

    expect(await pending).toBeNull();
    // Imported, not hardcoded: a change to the constant must not silently
    // decouple the bound from the value the module actually races against.
    expect(didSummarize()).toBe(false);
  });

  it("clears the timeout on the fast path", async () => {
    // Deleting the `clearTimeout` in the `finally` is otherwise invisible -
    // the summarize still returns the right value. Every call would leave a
    // live 60s timer behind, and under fake timers that is exactly what a
    // non-zero count means.
    const { summarize } = boundedSummarize(null);

    await summarize({ entries: [], startAt: 1, endAt: 2 });

    expect(vi.getTimerCount()).toBe(0);
  });
});
