import fs from "node:fs";
import path from "node:path";
import initSqlJs, { type Database as SqlJsDatabase } from "sql.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

let db: SqlJsDatabase;

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

const { execute, select } = vi.hoisted(() => ({ execute: vi.fn(), select: vi.fn() }));
vi.mock("@/lib/database/config", () => ({
  getDatabase: async () => ({ execute, select }),
}));

import {
  cancelOfferedRows,
  cancelOrphanedWaitingRows,
  cancelSend,
  claimSend,
  conversationsWithLiveSend,
  createSendAndLink,
  finishSend,
  getSend,
  lastSpokenLineAt,
  listDueSends,
  listNotionItems,
  listWaitingRows,
  offerRowsToWaiting,
  patchSend,
  readSendLines,
  requeueAuthFailures,
  restampSend,
  retrySend,
} from "@/lib/database/notion-queue.action";
import { NOTION_LANE_OPEN, pruneTranscripts } from "@/lib/database/meeting-log.action";
import { STALE_CLAIM_MS } from "@/lib/odoo/meeting-log";
import { MIGRATIONS, applyMigration14 } from "./helpers/migration-14";

const NOW = 1_700_000_000_000;
const STALE = STALE_CLAIM_MS;

function seedRow(over: Record<string, unknown>) {
  const row = {
    id: "r1", session_key: `k-${over.id ?? "r1"}`, conversation_id: "c1", instance: "i",
    contact_id: 1, lead_id: null, transcript: "t", transcript_start_at: 1,
    transcript_end_at: 2, status: "sent", attempts: 0, meeting_started_at: 1,
    created_at: NOW, notion_status: "waiting", notion_send_id: null,
    ...over,
  };
  db.run(
    `INSERT INTO meeting_log_queue (${Object.keys(row).join(",")}) VALUES (${Object.keys(row).map(() => "?").join(",")})`,
    Object.values(row) as never[]
  );
}

const sendInit = (over: Partial<Parameters<typeof createSendAndLink>[0]> = {}) => ({
  id: "r1", conversationId: "c1", spanStartAt: 1, spanEndAt: 2, createdAt: NOW, ...over,
});

const rowOf = async (id: string) => (await rawSelect("SELECT * FROM meeting_log_queue WHERE id=?", [id]))[0];
const sendOf = async (id: string) => (await rawSelect("SELECT * FROM notion_sends WHERE id=?", [id]))[0];

/** A send already claimed at `at`. */
async function claimed(id = "r1", at = NOW) {
  seedRow({ id });
  await createSendAndLink(sendInit({ id }), [id]);
  expect(await claimSend(id, at, at - STALE)).toBe(at);
}

beforeEach(async () => {
  const wasmBinary = fs.readFileSync(path.resolve(__dirname, "../../node_modules/sql.js/dist/sql-wasm.wasm"));
  const SQL = await initSqlJs({ wasmBinary });
  db = new SQL.Database();
  for (const f of ["chat-history.sql", "chat-history-v8.sql", "odoo-contacts.sql", "meeting-log-queue.sql", "odoo-lead-only-target.sql"]) {
    db.run(fs.readFileSync(path.join(MIGRATIONS, f), "utf8"));
  }
  await applyMigration14(db);
  db.run(fs.readFileSync(path.join(MIGRATIONS, "notion-sends.sql"), "utf8"));
  execute.mockImplementation(async (sql: string, args?: unknown[]) => rawExecute(sql, args));
  select.mockImplementation(async (sql: string, args?: unknown[]) => rawSelect(sql, args));
});

describe("createSendAndLink", () => {
  it("links rows even when the send already exists (crash between insert and link)", async () => {
    seedRow({ id: "r1" });
    seedRow({ id: "r2" });
    const order: string[] = [];
    execute.mockImplementation(async (sql: string, args?: unknown[]) => {
      order.push(sql);
      return rawExecute(sql, args);
    });
    await createSendAndLink(sendInit(), ["r1"]);
    expect(order[0]).toMatch(/INSERT INTO notion_sends/);
    expect(order[1]).toMatch(/UPDATE meeting_log_queue/);
    await createSendAndLink(sendInit(), ["r1", "r2"]);
    expect((await rowOf("r2")).notion_send_id).toBe("r1");
    expect((await rowOf("r2")).notion_status).toBe("joined");
    expect(await sendOf("r1")).toMatchObject({ status: "retry", next_at: 0 });
  });

  it("never relinks a row already joined to another send", async () => {
    seedRow({ id: "r1" });
    seedRow({ id: "r2" });
    await createSendAndLink(sendInit(), ["r1"]);
    await createSendAndLink(sendInit({ id: "r2" }), ["r1", "r2"]);
    expect((await rowOf("r1")).notion_send_id).toBe("r1");
    expect((await rowOf("r2")).notion_send_id).toBe("r2");
  });
});

describe("claimSend", () => {
  beforeEach(() => {
    seedRow({ id: "r1" });
  });

  it("two concurrent claims → exactly one non-null", async () => {
    await createSendAndLink(sendInit(), ["r1"]);
    const r = await Promise.all([claimSend("r1", NOW, NOW - STALE), claimSend("r1", NOW, NOW - STALE)]);
    expect(r.filter((x) => x !== null)).toEqual([NOW]);
    expect((await sendOf("r1")).attempts).toBe(1);
  });

  it("refuses a retry send whose next_at is in the future", async () => {
    await createSendAndLink(sendInit(), ["r1"]);
    db.run("UPDATE notion_sends SET next_at=? WHERE id='r1'", [NOW + 1000]);
    expect(await claimSend("r1", NOW, NOW - STALE)).toBeNull();
    expect(await claimSend("r1", NOW + 1000, NOW)).toBe(NOW + 1000);
  });

  it("reclaims a sending send only once its claim is stale", async () => {
    await createSendAndLink(sendInit(), ["r1"]);
    await claimSend("r1", NOW, NOW - STALE);
    expect(await claimSend("r1", NOW + 1, NOW - 1)).toBeNull();
    expect(await claimSend("r1", NOW + STALE, NOW)).toBe(NOW + STALE);
  });
});

describe("zombie writers", () => {
  it("restampSend / patchSend / finishSend refuse a stale claimedAt", async () => {
    await claimed();
    expect(await restampSend("r1", NOW - 1, NOW + 5)).toBeNull();
    expect(await patchSend("r1", NOW - 1, { page_id: "p" })).toBe(false);
    expect(await finishSend("r1", NOW - 1, { status: "sent" })).toBe(false);
    expect(await sendOf("r1")).toMatchObject({ status: "sending", page_id: null, claimed_at: NOW });
  });

  it("after restampSend, patchSend and finishSend succeed with the returned stamp and refuse the original one", async () => {
    await claimed();
    const s2 = await restampSend("r1", NOW, NOW + 10);
    expect(s2).toBe(NOW + 10);
    expect(await patchSend("r1", NOW, { page_id: "p" })).toBe(false);
    expect(await finishSend("r1", NOW, { status: "sent" })).toBe(false);
    expect(await patchSend("r1", s2!, { page_id: "p", body_done: 1 })).toBe(true);
    const s3 = await restampSend("r1", s2!, NOW + 20);
    expect(s3).toBe(NOW + 20);
    expect(await finishSend("r1", s2!, { status: "sent" })).toBe(false);
    expect(await finishSend("r1", s3!, { status: "sent", sentAt: NOW + 30 })).toBe(true);
    expect(await sendOf("r1")).toMatchObject({ status: "sent", page_id: "p", body_done: 1, claimed_at: null, sent_at: NOW + 30 });
  });

  it("patchSend skips undefined values", async () => {
    await claimed();
    await patchSend("r1", NOW, { page_id: "keep" });
    expect(await patchSend("r1", NOW, { page_id: undefined, body_done: 1 })).toBe(true);
    expect(await sendOf("r1")).toMatchObject({ page_id: "keep", body_done: 1 });
    expect(await patchSend("r1", NOW, { page_id: undefined })).toBe(true);
    expect(await patchSend("r1", NOW, {})).toBe(true);
    expect(await patchSend("r1", NOW - 1, { page_id: undefined })).toBe(false);
  });

  it("patchSend rejects a column outside the whitelist", async () => {
    await claimed();
    await expect(patchSend("r1", NOW, { status: "sent" } as never)).rejects.toThrow();
    expect((await sendOf("r1")).status).toBe("sending");
  });
});

describe("finishSend", () => {
  it("'sent' is one statement and the lane reads closed for every joined row", async () => {
    seedRow({ id: "r1" });
    seedRow({ id: "r2" });
    await createSendAndLink(sendInit(), ["r1", "r2"]);
    await claimSend("r1", NOW, NOW - STALE);
    const open = async () =>
      rawSelect(`SELECT id FROM meeting_log_queue WHERE ${NOTION_LANE_OPEN}`);
    expect(await open()).toHaveLength(2);
    execute.mockClear();
    expect(await finishSend("r1", NOW, { status: "sent", sentAt: NOW })).toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(await open()).toHaveLength(0);
  });
});

describe("readSendLines", () => {
  it("joins rows in time order and drops blank lines", async () => {
    seedRow({ id: "r1", transcript: "b1\n  \nb2", transcript_start_at: 20, transcript_end_at: 30 });
    seedRow({ id: "r2", transcript: "a1\n\na2", transcript_start_at: 5, transcript_end_at: 10 });
    await createSendAndLink(sendInit(), ["r1", "r2"]);
    expect(await readSendLines("r1")).toEqual({ lines: ["a1", "a2", "b1", "b2"], startAt: 5, endAt: 30 });
  });

  it("one conversation with two sends: returns only the target send's rows", async () => {
    seedRow({ id: "r1", transcript: "early", transcript_start_at: 1 });
    seedRow({ id: "r2", transcript: "late", transcript_start_at: 99_999_999 });
    await createSendAndLink(sendInit(), ["r1"]);
    await createSendAndLink(sendInit({ id: "r2" }), ["r2"]);
    expect((await readSendLines("r2")).lines).toEqual(["late"]);
    expect((await readSendLines("r1")).lines).toEqual(["early"]);
  });
});

describe("page actions", () => {
  it("retrySend resets summary_failures only for no_summary", async () => {
    await claimed("r1");
    await claimed("r2");
    db.run("UPDATE notion_sends SET status='no_summary', summary_failures=3, error_code='X', claimed_at=NULL WHERE id='r1'");
    db.run("UPDATE notion_sends SET status='failed', summary_failures=2, error_code='Y', claimed_at=NULL WHERE id='r2'");
    expect(await retrySend("r1")).toBe(true);
    expect(await retrySend("r2")).toBe(true);
    expect(await sendOf("r1")).toMatchObject({ status: "retry", summary_failures: 0, error_code: null, next_at: 0 });
    expect(await sendOf("r2")).toMatchObject({ status: "retry", summary_failures: 2, error_code: null, next_at: 0 });
    expect(await retrySend("nope")).toBe(false);
  });

  it("cancelSend stops a retry send that has a page and keeps its page fields", async () => {
    await claimed("r1");
    db.run("UPDATE notion_sends SET status='retry', page_id='p', page_url='u', claimed_at=NULL WHERE id='r1'");
    expect(await cancelSend("r1")).toBe(true);
    expect(await sendOf("r1")).toMatchObject({ status: "cancelled", page_id: "p", page_url: "u" });
  });

  it("cancelSend refuses a no_summary or sending send that already has a page", async () => {
    await claimed("r1");
    await claimed("r2");
    db.run("UPDATE notion_sends SET status='sending', page_id='p' WHERE id='r1'");
    db.run("UPDATE notion_sends SET status='no_summary', page_id='p', claimed_at=NULL WHERE id='r2'");
    const before = await sendOf("r1");
    expect(await cancelSend("r1")).toBe(false);
    expect(await cancelSend("r2")).toBe(false);
    expect(await sendOf("r1")).toEqual(before);
  });

  it("cancelSend stops a failed send that has a page; its lane reads closed and prune then blanks its rows", async () => {
    seedRow({ id: "r1", transcript: "secret", created_at: 1 });
    await createSendAndLink(sendInit({ createdAt: 1 }), ["r1"]);
    await claimSend("r1", NOW, NOW - STALE);
    await finishSend("r1", NOW, { status: "failed", errorCode: "NOTION_PAGE_CHANGED" });
    db.run("UPDATE notion_sends SET page_id='p' WHERE id='r1'");
    expect(await cancelSend("r1")).toBe(true);
    expect(await sendOf("r1")).toMatchObject({ status: "cancelled", error_code: null, page_id: "p" });
    expect(await rawSelect(`SELECT id FROM meeting_log_queue WHERE ${NOTION_LANE_OPEN}`)).toHaveLength(0);
    await pruneTranscripts(NOW);
    expect((await rowOf("r1")).transcript).not.toBe("secret");
  });

  it("cancelSend stops a retry send without a page", async () => {
    seedRow({ id: "r1" });
    await createSendAndLink(sendInit(), ["r1"]);
    expect(await cancelSend("r1")).toBe(true);
  });

  it("cancelOrphanedWaitingRows cancels unjoined rows of a deleted conversation only", async () => {
    db.run("INSERT INTO conversations (id,title,created_at,updated_at) VALUES ('c1','t',1,1)");
    seedRow({ id: "gone", conversation_id: "deleted" });
    seedRow({ id: "offered", conversation_id: "deleted", notion_status: "offered" });
    seedRow({ id: "kept", conversation_id: "c1" });
    seedRow({ id: "nul", conversation_id: null });
    await cancelOrphanedWaitingRows();
    expect((await rowOf("gone")).notion_status).toBe("cancelled");
    expect((await rowOf("offered")).notion_status).toBe("cancelled");
    expect((await rowOf("kept")).notion_status).toBe("waiting");
    expect((await rowOf("nul")).notion_status).toBe("waiting");
  });

  it("offerRowsToWaiting / cancelOfferedRows move only unjoined rows in the right state", async () => {
    seedRow({ id: "a", notion_status: "offered" });
    seedRow({ id: "b", notion_status: "offered" });
    seedRow({ id: "c", notion_status: "held" });
    expect(await offerRowsToWaiting(["a", "c"])).toBe(true);
    expect((await rowOf("a")).notion_status).toBe("waiting");
    expect((await rowOf("c")).notion_status).toBe("held");
    expect(await cancelOfferedRows(["a", "b", "c"])).toBe(true);
    expect((await rowOf("a")).notion_status).toBe("cancelled");
    expect((await rowOf("b")).notion_status).toBe("cancelled");
    expect((await rowOf("c")).notion_status).toBe("held");
    expect(await offerRowsToWaiting([])).toBe(false);
  });

  it("requeueAuthFailures requeues only auth-coded failures", async () => {
    await claimed("r1");
    await claimed("r2");
    db.run("UPDATE notion_sends SET status='failed', error_code='NOTION_UNAUTHORIZED', next_at=99, claimed_at=NULL WHERE id='r1'");
    db.run("UPDATE notion_sends SET status='failed', error_code='NOTION_PAGE_CHANGED', claimed_at=NULL WHERE id='r2'");
    await requeueAuthFailures();
    expect(await sendOf("r1")).toMatchObject({ status: "retry", next_at: 0 });
    expect((await sendOf("r2")).status).toBe("failed");
  });
});

describe("reads", () => {
  it("listWaitingRows returns unjoined waiting rows ordered", async () => {
    seedRow({ id: "b", conversation_id: "c2", transcript_start_at: 1 });
    seedRow({ id: "a2", conversation_id: "c1", transcript_start_at: 9 });
    seedRow({ id: "a1", conversation_id: "c1", transcript_start_at: 3 });
    seedRow({ id: "x", notion_status: "held" });
    expect((await listWaitingRows()).map((r) => r.id)).toEqual(["a1", "a2", "b"]);
  });

  it("lastSpokenLineAt ignores lines without an audio source", async () => {
    db.run("INSERT INTO conversations (id,title,created_at,updated_at) VALUES ('c1','t',1,1)");
    const m = (id: string, ts: number, src: string | null) =>
      db.run("INSERT INTO messages (id,conversation_id,role,content,timestamp,audio_source) VALUES (?,?,?,?,?,?)", [id, "c1", "user", "x", ts, src]);
    m("1", 10, "mic");
    m("2", 20, "system");
    m("3", 30, null);
    expect(await lastSpokenLineAt("c1")).toBe(20);
    expect(await lastSpokenLineAt("zzz")).toBeNull();
  });

  it("conversationsWithLiveSend and listDueSends honour staleness", async () => {
    await claimed("r1", NOW);
    seedRow({ id: "r2", conversation_id: "c2" });
    await createSendAndLink(sendInit({ id: "r2", conversationId: "c2", createdAt: NOW + 1 }), ["r2"]);
    expect([...(await conversationsWithLiveSend(NOW - 1))]).toEqual(["c1"]);
    expect((await conversationsWithLiveSend(NOW)).size).toBe(0);
    expect((await listDueSends(NOW + 10, NOW - 1)).map((s) => s.id)).toEqual(["r2"]);
    expect((await listDueSends(NOW + 10, NOW)).map((s) => s.id)).toEqual(["r1", "r2"]);
    expect((await getSend("r2"))?.status).toBe("retry");
    expect(await getSend("none")).toBeNull();
  });

  it("listNotionItems groups unjoined waiting rows by conversation", async () => {
    seedRow({ id: "a", conversation_id: "c1", transcript_start_at: 1, transcript_end_at: 5 });
    seedRow({ id: "b", conversation_id: "c1", transcript_start_at: 6, transcript_end_at: 9 });
    seedRow({ id: "n1", conversation_id: null, notion_status: "offered" });
    seedRow({ id: "n2", conversation_id: null, notion_status: "offered" });
    seedRow({ id: "h", conversation_id: "c1", notion_status: "held", transcript_start_at: 20, transcript_end_at: 21 });
    seedRow({ id: "w2", conversation_id: "c2", transcript_start_at: 30, transcript_end_at: 31 });
    const items = await listNotionItems();
    const rows = items.filter((i) => i.kind === "rows");
    expect(rows).toHaveLength(5);
    expect(rows).toContainEqual({ kind: "rows", conversationId: "c2", rowIds: ["w2"], status: "waiting", startAt: 30, endAt: 31 });
    expect(rows).toContainEqual({ kind: "rows", conversationId: "c1", rowIds: ["a", "b"], status: "waiting", startAt: 1, endAt: 9 });
    expect(rows).toContainEqual(expect.objectContaining({ conversationId: "c1", rowIds: ["h"], status: "held" }));
  });

  it("listNotionItems lists sends but hides a cancelled send without a page", async () => {
    seedRow({ id: "s1", notion_status: "waiting" });
    seedRow({ id: "s2", notion_status: "waiting", conversation_id: "c2" });
    seedRow({ id: "s3", notion_status: "waiting", conversation_id: "c3" });
    await createSendAndLink(sendInit({ id: "s1" }), ["s1"]);
    await createSendAndLink(sendInit({ id: "s2", conversationId: "c2" }), ["s2"]);
    await createSendAndLink(sendInit({ id: "s3", conversationId: "c3" }), ["s3"]);
    db.run("UPDATE notion_sends SET status='cancelled' WHERE id='s2'");
    db.run("UPDATE notion_sends SET status='cancelled', page_id='p' WHERE id='s3'");
    const sends = (await listNotionItems()).filter((i) => i.kind === "send");
    expect(sends.map((s) => (s as { send: { id: string } }).send.id).sort()).toEqual(["s1", "s3"]);
    expect(sends[0]).toMatchObject({ rowIds: ["s1"] });
  });
});
