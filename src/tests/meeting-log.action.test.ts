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
  assignQueueRow,
  cancelHeldRow,
  claimRow,
  countActionableQueued,
  countAllQueued,
  deleteQueueRow,
  failRow,
  findHeldRow,
  getQueueCounts,
  getQueueRow,
  getQueueTranscript,
  getTranscriptWatermark,
  insertQueueRow,
  listActionableRows,
  markSent,
  pruneTranscripts,
  readMeetingMessages,
  reclaimStaleSending,
  recordAttemptError,
  recordErrorOnUnsent,
  releaseRowToPending,
  retryQueueRow,
  selectSweepable,
} from "@/lib/database/meeting-log.action";
import { purgeOtherInstances } from "@/lib/database/odoo-contacts.action";
import { ESCALATE_AFTER_ATTEMPTS, HOLD_MS, RETENTION_MS, STALE_CLAIM_MS } from "@/lib/odoo/meeting-log";

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
  it("writes target and status in ONE statement", async () => {
    // A row can never be `pending` with no target - the exact collision the
    // `unassigned` status exists to prevent.
    seed({ id: "r", status: "unassigned", contact_id: null, lead_id: null });

    expect(await assignQueueRow("r", 42, 7)).toBe(true);

    expect(await getQueueRow("r")).toMatchObject({
      status: "pending",
      contact_id: 42,
      lead_id: 7,
    });
  });

  it("accepts a failed row and CLEARS both Odoo ids", async () => {
    // Reassign. Clearing the ids is not tidying: a failed row legitimately
    // holds an attachment_id when ir.attachment.create succeeded and
    // message_post then faulted. Retargeting without clearing makes
    // pushQueuedRow skip the create and post a note on the NEW partner that
    // links a file living on the OLD partner's record - one customer's
    // transcript reachable from another customer's chatter.
    seed({
      id: "r", status: "failed", contact_id: 1, lead_id: null,
      attachment_id: 99, message_id: null, last_error: "gone", last_error_code: "ODOO_FAULT",
    });

    expect(await assignQueueRow("r", 42, null)).toBe(true);

    expect(await getQueueRow("r")).toMatchObject({
      status: "pending",
      contact_id: 42,
      lead_id: null,
      attachment_id: null,
      message_id: null,
      last_error: null,
      last_error_code: null,
    });
  });

  it("refuses a pending row", async () => {
    seed({ id: "r", status: "pending" });
    expect(await assignQueueRow("r", 42, null)).toBe(false);
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

  it.each(["failed", "unassigned", "held", "pending", "sent", "cancelled"])(
    "accepts a %s row",
    async (status) => {
      seed({ id: "r", status });
      expect(await deleteQueueRow("r")).toBe(true);
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
});

describe("listActionableRows", () => {
  it("omits the transcript column entirely", async () => {
    seed({ id: "r", status: "failed", transcript: "You: hello" });
    const [row] = await listActionableRows(INSTANCE);
    expect(row).not.toHaveProperty("transcript");
    expect(row).toMatchObject({ id: "r", status: "failed" });
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
