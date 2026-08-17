import fs from "node:fs";
import path from "node:path";
import initSqlJs, { type Database as SqlJsDatabase } from "sql.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

let db: SqlJsDatabase;

vi.mock("@/lib/database/config", () => ({
  getDatabase: vi.fn(async () => ({
    execute: async (sql: string, params: unknown[] = []) => {
      db.run(sql, params as never[]);
      return { rowsAffected: db.getRowsModified(), lastInsertId: 0 };
    },
    select: async (sql: string, params: unknown[] = []) => {
      const stmt = db.prepare(sql);
      stmt.bind(params as never[]);
      const rows: Record<string, unknown>[] = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      stmt.free();
      return rows;
    },
  })),
}));

import {
  QUEUE_SQL,
  cancelHeldRow,
  claimRow,
  countAllQueued,
  failRow,
  findHeldRow,
  getQueueCounts,
  getQueueRow,
  getTranscriptWatermark,
  insertQueueRow,
  markSent,
  readMeetingMessages,
  reclaimStaleSending,
  recordAttemptError,
  recordErrorOnUnsent,
  releaseRowToPending,
  selectSweepable,
} from "@/lib/database/meeting-log.action";
import { purgeOtherInstances } from "@/lib/database/odoo-contacts.action";
import { HOLD_MS, STALE_CLAIM_MS } from "@/lib/odoo/meeting-log";

const MIGRATIONS = path.resolve(__dirname, "../../src-tauri/src/db/migrations");
const INSTANCE = "http://h:8069|odoo";
const OTHER = "http://h:8069|staging";
const NOW = 1_700_000_000_000;

function newRow(over: Record<string, unknown> = {}) {
  return {
    id: "row-1",
    sessionKey: "conv-1:1000",
    conversationId: "conv-1",
    instance: INSTANCE,
    contactId: 42,
    leadId: null,
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
    for (const [name, sql] of Object.entries(QUEUE_SQL)) {
      expect(sql, `${name} must not open a transaction`).not.toMatch(/\bBEGIN\b/i);
      expect(sql, `${name} must not commit`).not.toMatch(/\bCOMMIT\b/i);
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
