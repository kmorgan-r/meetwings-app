import fs from "node:fs";
import path from "node:path";
import initSqlJs, { type Database as SqlJsDatabase } from "sql.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let db: SqlJsDatabase;

async function rawExecute(sql: string, params?: unknown[]) {
  db.run(sql, (params ?? []) as never[]);
  return { rowsAffected: db.getRowsModified(), lastInsertId: 0 };
}
async function rawSelect(sql: string, params?: unknown[]) {
  const stmt = db.prepare(sql);
  stmt.bind((params ?? []) as never[]);
  const out: Record<string, unknown>[] = [];
  while (stmt.step()) out.push(stmt.getAsObject());
  stmt.free();
  return out;
}

const m = vi.hoisted(() => ({
  execute: vi.fn(),
  select: vi.fn(),
  emit: vi.fn(),
  listen: vi.fn(),
  runNotionSend: vi.fn(),
  buildSendDeps: vi.fn(),
  isConfigured: vi.fn(),
  active: { id: null as string | null, capturing: null as string | null },
}));

vi.mock("@/lib/database/config", () => ({
  getDatabase: async () => ({ execute: m.execute, select: m.select }),
}));
vi.mock("@tauri-apps/api/event", () => ({ emit: m.emit, listen: m.listen }));
vi.mock("@/lib/notion/send", () => ({ runNotionSend: m.runNotionSend, buildSendDeps: m.buildSendDeps }));
vi.mock("@/lib/storage/notion-config.storage", () => ({ isNotionConfigured: m.isConfigured }));
vi.mock("@/lib/storage/active-conversation.storage", () => ({
  getActiveConversationId: () => m.active.id,
  getCapturingConversationId: () => m.active.capturing,
}));

import { MEETING_CONVERSATION_GAP_MS } from "@/config";
import type { NotionItem, WaitingRow } from "@/lib/database/notion-queue.action";
import { HOLD_MS } from "@/lib/odoo/meeting-log";
import {
  dontSendToNotion,
  retryNotionSend,
  sendConversationToNotion,
  sendRowsToNotion,
} from "@/lib/notion/actions";
import { isQuiet, joinSets } from "@/lib/notion/join";
import {
  NOTION_KICK_EVENT,
  NOTION_TICK_MS,
  ensureNotionScheduler,
  isNotionSchedulerStarted,
  resetNotionSchedulerForTests,
  runNotionTick,
  type SchedulerDeps,
} from "@/lib/notion/scheduler";
import { MIGRATIONS, applyMigration14 } from "./helpers/migration-14";

const GAP = MEETING_CONVERSATION_GAP_MS;
const MIN = 60_000;
const T0 = 1_700_000_000_000;

function seedRow(over: Record<string, unknown>) {
  const row = {
    id: "r1", session_key: `k-${over.id ?? "r1"}`, conversation_id: "c1", instance: "",
    contact_id: null, lead_id: null, transcript: "t", transcript_start_at: T0,
    transcript_end_at: T0 + 10 * MIN, status: "none", attempts: 0, meeting_started_at: T0,
    created_at: T0, notion_status: "waiting", notion_send_id: null,
    ...over,
  };
  db.run(
    `INSERT INTO meeting_log_queue (${Object.keys(row).join(",")}) VALUES (${Object.keys(row).map(() => "?").join(",")})`,
    Object.values(row) as never[]
  );
}

let msgN = 0;
function message(conv: string, timestamp: number, over: Record<string, unknown> = {}) {
  if (!(db.exec(`SELECT 1 FROM conversations WHERE id='${conv}'`)[0])) {
    db.run("INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, 't', 1, 1)", [conv]);
  }
  const row = {
    id: `m${++msgN}`, conversation_id: conv, role: "user", content: "hello", timestamp,
    attached_files: null, speaker: null, audio_source: "microphone", ...over,
  };
  db.run(
    `INSERT INTO messages (${Object.keys(row).join(",")}) VALUES (${Object.keys(row).map(() => "?").join(",")})`,
    Object.values(row) as never[]
  );
}

const rowOf = async (id: string) => (await rawSelect("SELECT * FROM meeting_log_queue WHERE id=?", [id]))[0];
const sends = () => rawSelect("SELECT * FROM notion_sends ORDER BY id");
const queue = () => rawSelect("SELECT * FROM meeting_log_queue ORDER BY transcript_start_at");

function deps(now: number, over: Partial<SchedulerDeps> = {}): SchedulerDeps {
  return { now: () => now, liveLastLineAt: () => null, fallbackProvider: () => undefined, ...over };
}

function wrow(id: string, conv: string | null, start: number, end: number): WaitingRow {
  return { id, conversation_id: conv, transcript_start_at: start, transcript_end_at: end, created_at: 0 };
}

beforeEach(async () => {
  vi.clearAllMocks();
  resetNotionSchedulerForTests();
  m.active.id = null;
  m.active.capturing = null;
  m.isConfigured.mockResolvedValue(true);
  m.emit.mockResolvedValue(undefined);
  m.listen.mockResolvedValue(() => {});
  m.runNotionSend.mockResolvedValue({});
  m.buildSendDeps.mockResolvedValue({ client: "c" });
  const wasmBinary = fs.readFileSync(path.resolve(__dirname, "../../node_modules/sql.js/dist/sql-wasm.wasm"));
  const SQL = await initSqlJs({ wasmBinary });
  db = new SQL.Database();
  for (const f of ["chat-history.sql", "chat-history-v8.sql", "odoo-contacts.sql", "meeting-log-queue.sql", "odoo-lead-only-target.sql"]) {
    db.run(fs.readFileSync(path.join(MIGRATIONS, f), "utf8"));
  }
  await applyMigration14(db);
  db.run(fs.readFileSync(path.join(MIGRATIONS, "notion-sends.sql"), "utf8"));
  m.execute.mockImplementation(async (sql: string, args?: unknown[]) => rawExecute(sql, args));
  m.select.mockImplementation(async (sql: string, args?: unknown[]) => rawSelect(sql, args));
});

afterEach(() => {
  resetNotionSchedulerForTests();
  vi.useRealTimers();
});

describe("joinSets / isQuiet", () => {
  it("joinSets: 29:59 gap joins, 30:00 does not; different conversations never join", () => {
    const e = 10 * MIN;
    expect(joinSets([wrow("a", "c", 0, e), wrow("b", "c", e + GAP - 1000, e + GAP + MIN)])).toHaveLength(1);
    expect(joinSets([wrow("a", "c", 0, e), wrow("b", "c", e + GAP, e + GAP + MIN)])).toHaveLength(2);
    expect(joinSets([wrow("a", "c1", 0, e), wrow("b", "c2", 1000, e)])).toHaveLength(2);
  });

  it("joinSets measures the gap from the set's max end, not the last row's end", () => {
    const sets = joinSets([wrow("a", "c", 0, 100 * MIN), wrow("b", "c", 10 * MIN, 20 * MIN), wrow("d", "c", 110 * MIN, 120 * MIN)]);
    expect(sets.map((s) => s.map((r) => r.id))).toEqual([["a", "b", "d"]]);
  });

  it("rows with a null conversation id each form their own set", () => {
    expect(joinSets([wrow("a", null, 0, MIN), wrow("b", null, 2 * MIN, 3 * MIN)])).toHaveLength(2);
  });

  it("isQuiet is inclusive at exactly the gap", () => {
    expect(isQuiet(0, GAP - 1)).toBe(false);
    expect(isQuiet(0, GAP)).toBe(true);
  });
});

describe("runNotionTick", () => {
  it("cancelled rows and rows not bound for Notion are never in a set", async () => {
    seedRow({ id: "a", notion_status: "cancelled" });
    seedRow({ id: "b", notion_status: null });
    seedRow({ id: "c", notion_status: "offered" });
    seedRow({ id: "d", notion_status: "held", created_at: T0 + 10 * MIN + 2 * GAP });
    await runNotionTick(deps(T0 + 10 * MIN + 2 * GAP));
    expect(await sends()).toEqual([]);
  });

  it("flap flush at minute 10 + 40 min of unbroken talk → nothing until 30 min after the last spoken line", async () => {
    seedRow({ id: "r1" });
    for (let t = 0; t <= 50; t += 5) message("c1", T0 + t * MIN);
    await runNotionTick(deps(T0 + 45 * MIN));
    await runNotionTick(deps(T0 + 79 * MIN));
    expect(await sends()).toEqual([]);
    await runNotionTick(deps(T0 + 80 * MIN));
    expect(await sends()).toHaveLength(1);
    expect((await rowOf("r1")).notion_status).toBe("joined");
  });

  it("live transcript keeps a conversation open even with no new saved messages", async () => {
    seedRow({ id: "r1" });
    const now = T0 + 10 * MIN + GAP;
    await runNotionTick(deps(now, { liveLastLineAt: () => now - MIN }));
    expect(await sends()).toEqual([]);
    await runNotionTick(deps(now));
    expect(await sends()).toHaveLength(1);
  });

  it("a conversation with a live sending send is skipped", async () => {
    seedRow({ id: "r1", notion_status: "joined", notion_send_id: "r1" });
    db.run(
      "INSERT INTO notion_sends (id, conversation_id, status, claimed_at, next_at, span_start_at, span_end_at, created_at) VALUES ('r1','c1','sending',?,0,1,2,1)",
      [T0 + 100 * MIN]
    );
    seedRow({ id: "r2", transcript_start_at: T0 + 20 * MIN, transcript_end_at: T0 + 30 * MIN });
    await runNotionTick(deps(T0 + 100 * MIN + 1000));
    expect((await rowOf("r2")).notion_status).toBe("waiting");
    expect(m.runNotionSend).not.toHaveBeenCalled();
  });

  it("stale held Notion rows are promoted to waiting only after HOLD_MS + NOTION_TICK_MS", async () => {
    const now = T0 + 5 * MIN;
    seedRow({ id: "old", notion_status: "held", created_at: now - HOLD_MS - NOTION_TICK_MS, transcript_end_at: now });
    seedRow({ id: "fresh", notion_status: "held", created_at: now - HOLD_MS - 1000, transcript_end_at: now });
    await runNotionTick(deps(now));
    expect((await rowOf("old")).notion_status).toBe("waiting");
    expect((await rowOf("fresh")).notion_status).toBe("held");
  });

  it("not configured → the tick reads and writes nothing", async () => {
    m.isConfigured.mockResolvedValue(false);
    seedRow({ id: "r1" });
    await runNotionTick(deps(T0 + 10 * MIN + 2 * GAP));
    expect(m.select).not.toHaveBeenCalled();
    expect(m.execute).not.toHaveBeenCalled();
  });

  it("the tick swallows an isNotionConfigured throw: nothing written, no rejection", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    m.isConfigured.mockRejectedValue(new Error("secret meeting text"));
    await expect(runNotionTick(deps(T0))).resolves.toBeUndefined();
    expect(m.execute).not.toHaveBeenCalled();
    expect(err).toHaveBeenCalledWith("[notion] NOTION_INTERNAL", "Error");
    expect(JSON.stringify(err.mock.calls)).not.toContain("secret");
    err.mockRestore();
  });

  it("a sysaudio_conv_ waiting row never becomes a send", async () => {
    seedRow({ id: "r1", conversation_id: "sysaudio_conv_1" });
    await runNotionTick(deps(T0 + 10 * MIN + 2 * GAP));
    expect(await sends()).toEqual([]);
  });

  it("two overlapping ticks run runNotionSend once", async () => {
    seedRow({ id: "r1", notion_status: "joined", notion_send_id: "r1" });
    db.run("INSERT INTO notion_sends (id, conversation_id, status, next_at, span_start_at, span_end_at, created_at) VALUES ('r1','c1','retry',0,1,2,1)");
    let release!: () => void;
    m.runNotionSend.mockImplementation(() => new Promise<void>((r) => (release = r)));
    const d = deps(T0);
    const both = Promise.all([runNotionTick(d), runNotionTick(d)]);
    await vi.waitFor(() => expect(m.runNotionSend).toHaveBeenCalledTimes(1));
    release();
    await both;
    expect(m.runNotionSend).toHaveBeenCalledTimes(1);
  });

  it("buildSendDeps is called once for a tick with two due sends, which run sequentially", async () => {
    for (const id of ["s1", "s2"]) {
      db.run("INSERT INTO notion_sends (id, conversation_id, status, next_at, span_start_at, span_end_at, created_at) VALUES (?, ?, 'retry',0,1,2,1)", [id, id]);
    }
    await runNotionTick(deps(T0));
    expect(m.buildSendDeps).toHaveBeenCalledTimes(1);
    expect(m.runNotionSend.mock.calls.map((c) => c[0])).toEqual(["s1", "s2"]);
  });

  it("buildSendDeps error → each due send is finished with that code (failed for KEYCHAIN_UNAVAILABLE) and runNotionSend is not called", async () => {
    m.buildSendDeps.mockResolvedValue({ error: "NOTION_KEYCHAIN_UNAVAILABLE" });
    for (const id of ["s1", "s2"]) {
      db.run("INSERT INTO notion_sends (id, conversation_id, status, next_at, span_start_at, span_end_at, created_at) VALUES (?, ?, 'retry',0,1,2,1)", [id, id]);
    }
    await runNotionTick(deps(T0));
    expect(m.runNotionSend).not.toHaveBeenCalled();
    for (const s of await sends()) {
      expect(s).toMatchObject({ status: "failed", error_code: "NOTION_KEYCHAIN_UNAVAILABLE", attempts: 1, claimed_at: null });
    }
  });

  it.each(["saved message", "live line", "row end"])(
    "quiet is measured from the latest of the three sources (%s latest)",
    async (latest) => {
      const now = T0 + 200 * MIN;
      const recent = now - GAP + MIN; // 29 min ago: not quiet
      const old = now - GAP - 60 * MIN;
      seedRow({
        id: "r1", transcript_start_at: old - MIN,
        transcript_end_at: latest === "row end" ? recent : old,
      });
      message("c1", latest === "saved message" ? recent : old);
      const live = latest === "live line" ? recent : old;
      await runNotionTick(deps(now, { liveLastLineAt: () => live }));
      expect(await sends()).toEqual([]);
      // and with all three old it does send
      await runNotionTick(deps(now + 2 * GAP, { liveLastLineAt: () => live }));
      expect(await sends()).toHaveLength(1);
    }
  );

  it("a restart mid-meeting: recovered rows join the pre-crash rows into one send", async () => {
    seedRow({ id: "pre", transcript_start_at: T0, transcript_end_at: T0 + 10 * MIN });
    seedRow({ id: "rec", transcript_start_at: T0 + 12 * MIN, transcript_end_at: T0 + 20 * MIN });
    await runNotionTick(deps(T0 + 20 * MIN + GAP));
    const [s] = await sends();
    expect(await sends()).toHaveLength(1);
    expect(s).toMatchObject({ id: "pre", span_start_at: T0, span_end_at: T0 + 20 * MIN });
    expect((await rowOf("rec")).notion_send_id).toBe("pre");
  });
});

describe("ensureNotionScheduler", () => {
  it("starts once however many times it is called", async () => {
    vi.useFakeTimers();
    ensureNotionScheduler(deps(T0));
    ensureNotionScheduler(deps(T0));
    ensureNotionScheduler(deps(T0));
    expect(isNotionSchedulerStarted()).toBe(true);
    expect(m.listen).toHaveBeenCalledTimes(1);
    expect(m.listen.mock.calls[0][0]).toBe(NOTION_KICK_EVENT);
    await vi.advanceTimersByTimeAsync(0);
    expect(m.isConfigured).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(NOTION_TICK_MS);
    expect(m.isConfigured).toHaveBeenCalledTimes(2);
  });

  it("a NOTION_KICK_EVENT runs a tick with the overlay's latest deps", async () => {
    vi.useFakeTimers();
    const first = deps(T0, { now: vi.fn(() => T0) });
    const latest = deps(T0, { now: vi.fn(() => T0) });
    ensureNotionScheduler(first);
    await vi.advanceTimersByTimeAsync(0);
    ensureNotionScheduler(latest);
    (first.now as ReturnType<typeof vi.fn>).mockClear();
    const handler = m.listen.mock.calls[0][1] as () => void;
    handler();
    await vi.advanceTimersByTimeAsync(0);
    expect(latest.now).toHaveBeenCalled();
    expect(first.now).not.toHaveBeenCalled();
  });
});

describe("page actions", () => {
  it("sendConversationToNotion refuses system audio and converts offered rows", async () => {
    expect(await sendConversationToNotion("sysaudio_conv_1", T0)).toBe("system-audio");
    seedRow({ id: "r1", notion_status: "offered" });
    seedRow({ id: "r2", notion_status: null, transcript_start_at: T0 + 2 * GAP, transcript_end_at: T0 + 2 * GAP + MIN });
    expect(await sendConversationToNotion("c1", T0)).toBe("queued");
    expect((await rowOf("r1")).notion_status).toBe("waiting");
    expect((await rowOf("r2")).notion_status).toBe("waiting");
    expect(m.emit).toHaveBeenCalledWith(NOTION_KICK_EVENT);
  });

  it("refuses the active and the capturing conversation, and an unconfigured Notion", async () => {
    m.active.id = "c1";
    expect(await sendConversationToNotion("c1", T0)).toBe("active");
    m.active.id = null;
    m.active.capturing = "c1";
    expect(await sendConversationToNotion("c1", T0)).toBe("active");
    m.active.capturing = null;
    m.isConfigured.mockResolvedValue(false);
    expect(await sendConversationToNotion("c1", T0)).toBe("not-configured");
    expect(m.emit).not.toHaveBeenCalled();
  });

  it("returns already for an open lane, a sent send, and a cancelled send with a page", async () => {
    seedRow({ id: "r1", notion_status: "waiting" });
    expect(await sendConversationToNotion("c1", T0)).toBe("already");
    db.run("DELETE FROM meeting_log_queue");
    seedRow({ id: "r1", notion_status: "joined", notion_send_id: "r1" });
    db.run("INSERT INTO notion_sends (id, conversation_id, status, span_start_at, span_end_at, created_at) VALUES ('r1','c1','sent',1,2,1)");
    expect(await sendConversationToNotion("c1", T0)).toBe("already");
    db.run("UPDATE notion_sends SET status='cancelled', page_id='p'");
    expect(await sendConversationToNotion("c1", T0)).toBe("already");
    db.run("UPDATE notion_sends SET page_id=NULL");
    seedRow({ id: "r2", notion_status: null, transcript_start_at: T0 + 2 * GAP, transcript_end_at: T0 + 2 * GAP + MIN });
    expect(await sendConversationToNotion("c1", T0)).toBe("queued");
  });

  it("sendConversationToNotion with no Odoo config writes status 'none' rows", async () => {
    message("c1", T0);
    message("c1", T0 + MIN);
    message("c1", T0 + 3 * GAP);
    expect(await sendConversationToNotion("c1", T0 + 4 * GAP)).toBe("queued");
    const q = await queue();
    expect(q).toHaveLength(2);
    for (const r of q) {
      expect(r).toMatchObject({ status: "none", notion_status: "waiting", instance: "", conversation_id: "c1" });
      expect(String(r.session_key)).toMatch(/^notion:c1:\d+:\d+$/);
    }
    expect(m.emit).toHaveBeenCalledWith(NOTION_KICK_EVENT);
  });

  it("sendConversationToNotion on a conversation whose Odoo rows were pruned blank writes fresh 'none' rows from the saved transcript", async () => {
    seedRow({ id: "pruned", notion_status: null, status: "sent", transcript: "" });
    message("c1", T0 + 5 * MIN, { content: "real words" });
    expect(await sendConversationToNotion("c1", T0 + 4 * GAP)).toBe("queued");
    expect((await rowOf("pruned")).notion_status).toBeNull();
    const fresh = (await queue()).filter((r) => r.id !== "pruned");
    expect(fresh).toHaveLength(1);
    expect(fresh[0]).toMatchObject({ status: "none", notion_status: "waiting" });
    expect(String(fresh[0].transcript)).toContain("real words");
  });

  it("returns empty when there is nothing to send, without a kick", async () => {
    expect(await sendConversationToNotion("c1", T0)).toBe("empty");
    expect(m.emit).not.toHaveBeenCalled();
  });

  it("an emit failure does not reject the action", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    m.emit.mockRejectedValue(new Error("boom"));
    seedRow({ id: "r1", notion_status: "offered" });
    await expect(sendRowsToNotion(["r1"])).resolves.toBeUndefined();
    expect((await rowOf("r1")).notion_status).toBe("waiting");
    err.mockRestore();
  });

  it("page actions never call runNotionSend; they emit NOTION_KICK_EVENT", async () => {
    seedRow({ id: "r1", notion_status: "offered" });
    await sendRowsToNotion(["r1"]);
    db.run("INSERT INTO notion_sends (id, conversation_id, status, span_start_at, span_end_at, created_at, error_code) VALUES ('s1','c9','failed',1,2,1,'X')");
    await retryNotionSend("s1");
    expect((await sends())[0]).toMatchObject({ status: "retry", error_code: null });
    seedRow({ id: "r2", conversation_id: "c2", notion_status: "offered" });
    const rowsItem: NotionItem = { kind: "rows", conversationId: "c2", rowIds: ["r2"], status: "offered", startAt: 1, endAt: 2 };
    expect(await dontSendToNotion(rowsItem)).toBe(true);
    expect((await rowOf("r2")).notion_status).toBe("cancelled");
    expect(await dontSendToNotion(rowsItem)).toBe(false);
    expect(m.emit).toHaveBeenCalledTimes(3);
    expect(m.emit.mock.calls.every((c) => c[0] === NOTION_KICK_EVENT)).toBe(true);
    expect(m.runNotionSend).not.toHaveBeenCalled();
  });

  it("dontSendToNotion on a send item cancels the send", async () => {
    db.run("INSERT INTO notion_sends (id, conversation_id, status, span_start_at, span_end_at, created_at) VALUES ('s1','c9','retry',1,2,1)");
    const item = { kind: "send", send: (await sends())[0], rowIds: [] } as unknown as NotionItem;
    expect(await dontSendToNotion(item)).toBe(true);
    expect((await sends())[0].status).toBe("cancelled");
  });
});
