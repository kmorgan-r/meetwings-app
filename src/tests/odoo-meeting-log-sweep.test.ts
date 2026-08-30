import fs from "node:fs";
import path from "node:path";
import initSqlJs, { type Database as SqlJsDatabase } from "sql.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let db: SqlJsDatabase;

// `failNextWrite.value` is a SQL prefix; the next db.execute whose statement
// starts with it rejects once, then the hook disarms. That is how a
// single-statement SQLITE_BUSY is simulated without a second database.
const { failNextWrite } = vi.hoisted(() => ({ failNextWrite: { value: null as string | null } }));

vi.mock("@/lib/database/config", () => ({
  getDatabase: vi.fn(async () => ({
    execute: async (sql: string, params: unknown[] = []) => {
      if (failNextWrite.value && sql.trim().startsWith(failNextWrite.value)) {
        failNextWrite.value = null;
        throw new Error("database is locked");
      }
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

const { tauriFetch } = vi.hoisted(() => ({ tauriFetch: vi.fn() }));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: tauriFetch }));

// The layer UNDERNEATH the config module, so the real requireOdooConfig and
// instanceFingerprint run. A partial mock of odoo-config.storage would NOT
// work - see the seam note above.
const { store } = vi.hoisted(() => ({ store: new Map<string, string>() }));
vi.mock("@/lib/secure-storage", () => ({
  secureGet: vi.fn(async (key: string) => store.get(key) ?? null),
  secureSet: vi.fn(async (key: string, value: string) => void store.set(key, value)),
  secureDelete: vi.fn(async (key: string) => void store.delete(key)),
}));

import { getQueueRow } from "@/lib/database/meeting-log.action";
import { createOdooClient } from "@/lib/odoo/client";
import { claimed, runMeetingLogSweep } from "@/lib/odoo/meeting-log-push";
import { STALE_CLAIM_MS } from "@/lib/odoo/meeting-log";
import { resetOdooRedactor, setOdooRedactor } from "@/lib/odoo/redactor";
import { SECURE_ODOO_CONFIG_KEY } from "@/lib/storage/odoo-config.storage";
import type { DbMeetingLogRow, SummarizationResult } from "@/types";

const MIGRATIONS = path.resolve(__dirname, "../../src-tauri/src/db/migrations");
const CONFIG = { url: "http://h:8069", db: "odoo", login: "me@x.io", apiKey: "sk-secret" };
const INSTANCE = "http://h:8069|odoo";
const NOW = 1_700_000_000_000;

/** plugin-http Response stub. `headers` is REQUIRED - see client.ts:64. */
function xml(body: string, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ date: "Sat, 08 Aug 2026 14:32:00 GMT" }),
    text: async () => body,
  };
}

const intResponse = (value: number) =>
  xml(`<?xml version="1.0"?><methodResponse><params><param><value><int>${value}</int></value></param></params></methodResponse>`);

const arrayResponse = (ids: number[]) =>
  xml(
    `<?xml version="1.0"?><methodResponse><params><param><value><array><data>` +
      ids.map((i) => `<value><int>${i}</int></value>`).join("") +
      `</data></array></value></param></params></methodResponse>`
  );

const faultResponse = (code: number, text: string) =>
  xml(`<?xml version="1.0"?><methodResponse><fault><value><struct><member><name>faultCode</name><value><int>${code}</int></value></member><member><name>faultString</name><value><string>${text}</string></value></member></struct></value></fault></methodResponse>`);

/** The uid response every client issues before its first execute. */
const AUTH = () => intResponse(7);

function seedRow(over: Partial<DbMeetingLogRow> = {}): DbMeetingLogRow {
  const row = {
    id: "row-1", session_key: "k1", conversation_id: "conv-1", instance: INSTANCE,
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
  return row;
}

// Task 9 bridge: pushQueuedRow now reads meeting_log_targets, not the legacy
// contact_id/lead_id columns, and declines pre-claim on a row with zero
// targets. Every seedRow fixture in this file that expects the sweep to
// actually push it now needs a matching target row too.
function seedTargets(rowId: string, resId: number) {
  db.run(
    `INSERT INTO meeting_log_targets
       (id, row_id, model, res_id, name, status, created_at)
     VALUES (?, ?, 'res.partner', ?, NULL, 'pending', ?)`,
    [`target-${rowId}`, rowId, resId, NOW]
  );
}

function summary(over: Partial<SummarizationResult> = {}): SummarizationResult {
  return {
    title: "Kickoff", summary: "We agreed to start.", topics: [], goals: [],
    actionItems: [], nextSteps: [], decisions: [], teamUpdates: [],
    participants: [], entities: [], ...over,
  };
}

function deps(over: Record<string, unknown> = {}) {
  return {
    client: createOdooClient(CONFIG),
    instance: INSTANCE,
    now: NOW,
    summarize: vi.fn(async () => summary()),
    ...over,
  } as Parameters<typeof pushQueuedRow>[1];
}

/** Which model/method each XML-RPC POST called, in order. */
function calls(): string[] {
  return tauriFetch.mock.calls.map(([, init]) => {
    const body = String((init as { body: string }).body);
    const method = /<methodName>([^<]+)<\/methodName>/.exec(body)?.[1] ?? "?";
    if (method !== "execute_kw") return method;
    const strings = [...body.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1]);
    // execute_kw params: db, uid, apiKey, model, method, ...
    return `${strings[2]}.${strings[3]}`;
  });
}

beforeEach(async () => {
  const wasmBinary = fs.readFileSync(
    path.resolve(__dirname, "../../node_modules/sql.js/dist/sql-wasm.wasm")
  );
  const SQL = await initSqlJs({ wasmBinary });
  db = new SQL.Database();
  db.run(fs.readFileSync(path.join(MIGRATIONS, "meeting-log-queue.sql"), "utf8"));
  // Task 9 bridge: odoo-contacts.sql creates odoo_selected_target, which
  // migration 13 rebuilds and migration 14 reads from - so meeting_log_targets
  // exists before any test body runs.
  db.run(fs.readFileSync(path.join(MIGRATIONS, "odoo-contacts.sql"), "utf8"));
  db.run(fs.readFileSync(path.join(MIGRATIONS, "odoo-lead-only-target.sql"), "utf8"));
  db.run(fs.readFileSync(path.join(MIGRATIONS, "odoo-multi-target.sql"), "utf8"));
  tauriFetch.mockReset();
  claimed.clear();
  failNextWrite.value = null;
  store.clear();
  store.set(SECURE_ODOO_CONFIG_KEY, JSON.stringify(CONFIG));
  setOdooRedactor([CONFIG.apiKey, CONFIG.login]);
});

afterEach(() => resetOdooRedactor());

describe("runMeetingLogSweep", () => {
  it("pushes pending rows oldest-first and sequentially", async () => {
    seedRow({ id: "a", session_key: "a", created_at: NOW - 3000 });
    seedRow({ id: "b", session_key: "b", created_at: NOW - 1000 });
    seedTargets("a", 42);
    seedTargets("b", 42);
    const order: string[] = [];
    tauriFetch.mockImplementation(async (_url, init) => {
      const body = String((init as { body: string }).body);
      if (body.includes("authenticate")) return AUTH();
      if (body.includes("ir.attachment")) {
        order.push("create");
        // Resolve on the next macrotask so an overlapping run would interleave.
        await new Promise((r) => setTimeout(r, 0));
        return intResponse(555);
      }
      order.push("post");
      return intResponse(999);
    });

    await runMeetingLogSweep(async () => null);

    // Sequential: create/post/create/post, never create/create/post/post.
    expect(order).toEqual(["create", "post", "create", "post"]);
    expect((await getQueueRow("a"))?.status).toBe("sent");
    expect((await getQueueRow("b"))?.status).toBe("sent");
  });

  it("performs exactly one authenticate across a two-row run", async () => {
    // Slice 1's opportunity lookup built a fresh client per call, costing an
    // extra authenticate each time. The sweep must build ONE client and reuse it.
    seedRow({ id: "a", session_key: "a" });
    seedRow({ id: "b", session_key: "b" });
    seedTargets("a", 42);
    seedTargets("b", 42);
    tauriFetch.mockImplementation(async (_url, init) => {
      const body = String((init as { body: string }).body);
      if (body.includes("authenticate")) return AUTH();
      return body.includes("ir.attachment") ? intResponse(555) : intResponse(999);
    });
    await runMeetingLogSweep(async () => null);
    expect(calls().filter((c) => c === "authenticate")).toHaveLength(1);
  });

  it("continues to the next row when one row throws", async () => {
    // Without per-row isolation a propagating failure abandons every later row.
    seedRow({ id: "bad", session_key: "bad", created_at: NOW - 3000 });
    seedRow({ id: "good", session_key: "good", created_at: NOW - 1000 });
    seedTargets("bad", 42);
    seedTargets("good", 42);
    let call = 0;
    tauriFetch.mockImplementation(async (_url, init) => {
      const body = String((init as { body: string }).body);
      if (body.includes("authenticate")) return AUTH();
      if (body.includes("ir.attachment") && call++ === 0) return faultResponse(2, "nope");
      return body.includes("ir.attachment") ? intResponse(555) : intResponse(999);
    });
    await runMeetingLogSweep(async () => null);
    expect((await getQueueRow("bad"))?.status).toBe("failed");
    expect((await getQueueRow("good"))?.status).toBe("sent");
  });

  it("reclaims a stale sending row first, then pushes it", async () => {
    seedRow({
      id: "stale", session_key: "stale", status: "sending",
      claimed_at: NOW - STALE_CLAIM_MS - 1,
    });
    seedTargets("stale", 42);
    tauriFetch.mockImplementation(async (_url, init) => {
      const body = String((init as { body: string }).body);
      if (body.includes("authenticate")) return AUTH();
      return body.includes("ir.attachment") ? intResponse(555) : intResponse(999);
    });
    await runMeetingLogSweep(async () => null);
    expect((await getQueueRow("stale"))?.status).toBe("sent");
  });

  it("never touches sent, cancelled or unassigned rows", async () => {
    for (const status of ["sent", "cancelled", "unassigned"] as const) {
      seedRow({ id: status, session_key: status, status });
    }
    await runMeetingLogSweep(async () => null);
    expect(tauriFetch).not.toHaveBeenCalled();
  });

  it("joins an in-flight run instead of starting a second one", async () => {
    // Module-level single flight, mirroring runSync (src/lib/odoo/index.ts:20-33,
    // 72-111) including its polarity note: the latch is owned by the RUN and
    // clears itself in .finally(), so it is never re-armed in an effect body.
    seedRow({ id: "a", session_key: "a" });
    seedTargets("a", 42);
    tauriFetch.mockImplementation(async (_url, init) => {
      const body = String((init as { body: string }).body);
      if (body.includes("authenticate")) return AUTH();
      await new Promise((r) => setTimeout(r, 5));
      return body.includes("ir.attachment") ? intResponse(555) : intResponse(999);
    });
    const [first, second] = await Promise.all([
      runMeetingLogSweep(async () => null),
      runMeetingLogSweep(async () => null),
    ]);
    expect(first).toBe(second); // the joiner gets the SAME outcome object
    expect(calls().filter((c) => c === "ir.attachment.create")).toHaveLength(1);
  });

  it("reports ran:false, issues no calls, and records WHY on every sendable row", async () => {
    // This is the ONLY place ODOO_NOT_CONFIGURED is reachable: pushQueuedRow
    // takes the fingerprint from its caller, so it never resolves credentials
    // itself. And this path never claims, so `attempts` never increments and no
    // row can escalate into "needs attention" on its own - without the recorded
    // reason a half-filled config leaves N meetings stuck and unexplained.
    store.clear();
    seedRow({ id: "a", session_key: "a" });
    seedRow({ id: "done", session_key: "done", status: "sent" });
    expect(await runMeetingLogSweep(async () => null)).toMatchObject({ ran: false });
    expect(tauriFetch).not.toHaveBeenCalled();
    expect(await getQueueRow("a")).toMatchObject({
      status: "pending", attempts: 0, last_error_code: "ODOO_NOT_CONFIGURED",
    });
    // Terminal rows keep whatever they had - this must not overwrite the
    // actionable error a user is already trying to act on.
    expect(await getQueueRow("done")).toMatchObject({ last_error_code: null });
  });

  it("resolves rather than rejecting when the queue reads themselves fail", async () => {
    // The only production caller is a `void` inside a React effect, so a
    // rejection here would escape as an unhandled rejection at app start - the
    // exact escape path errors.ts:6-18 exists to close - and the run would die
    // with no trace the user or the next launch can see.
    seedRow({ id: "a", session_key: "a" });
    failNextWrite.value = "UPDATE meeting_log_queue SET status = 'pending'";
    await expect(runMeetingLogSweep(async () => null)).resolves.toMatchObject({ ran: false });
  });
});
