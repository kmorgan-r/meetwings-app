import fs from "node:fs";
import path from "node:path";
import initSqlJs, { type Database as SqlJsDatabase } from "sql.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let db: SqlJsDatabase;

// `failNextWrite.value` is a SQL prefix; the next db.execute whose statement
// starts with it rejects once, then the hook disarms. That is how a
// single-statement SQLITE_BUSY is simulated without a second database.
const { failNextWrite } = vi.hoisted(() => ({ failNextWrite: { value: null as string | null } }));

// Arms a ONE-SHOT competing write: after the next statement matching
// `SET status = 'sent'` on meeting_log_targets runs, a raw UPDATE flips the
// PARENT row back to 'pending' - modeling another process stealing the claim
// mid-loop, between two of pushQueuedRow's own writes. Distinct from
// failNextWrite, which fails the pusher's OWN write; this one lets the
// pusher's write SUCCEED and then contests the claim underneath it.
const { stealClaim } = vi.hoisted(() => ({ stealClaim: { rowId: null as string | null } }));

// One-shot SELECT failure, mirroring failNextWrite but for db.select - proves
// the pre-claim listTargets read (a select, not a write) is guarded too.
// Named distinctly from the local failNextSelect() helper below, which sets it.
const { nextSelectFailure } = vi.hoisted(() => ({ nextSelectFailure: { value: null as string | null } }));

const SENT_TARGET_RE = /UPDATE meeting_log_targets\s+SET status = 'sent'/;

vi.mock("@/lib/database/config", () => ({
  getDatabase: vi.fn(async () => ({
    execute: async (sql: string, params: unknown[] = []) => {
      if (failNextWrite.value && sql.trim().startsWith(failNextWrite.value)) {
        failNextWrite.value = null;
        throw new Error("database is locked");
      }
      db.run(sql, params as never[]);
      const result = { rowsAffected: db.getRowsModified(), lastInsertId: 0 };
      if (stealClaim.rowId && SENT_TARGET_RE.test(sql)) {
        const stolenRowId = stealClaim.rowId;
        stealClaim.rowId = null; // one shot
        db.run("UPDATE meeting_log_queue SET status='pending' WHERE id=?", [stolenRowId]);
      }
      return result;
    },
    select: async (sql: string, params: unknown[] = []) => {
      if (nextSelectFailure.value && sql.trim().startsWith(nextSelectFailure.value)) {
        nextSelectFailure.value = null;
        throw new Error("database is locked");
      }
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

// Only export used by meeting-log-push.ts. Real stampLastMeeting would need
// the odoo_contacts table, which this file's schema never creates - and the
// new-target-loop tests need to COUNT calls, which a real write cannot do.
const { stampLastMeeting } = vi.hoisted(() => ({ stampLastMeeting: vi.fn(async () => {}) }));
vi.mock("@/lib/database/odoo-contacts.action", () => ({ stampLastMeeting }));

import { getQueueRow, listTargets } from "@/lib/database/meeting-log.action";
import { SECURE_ODOO_CONFIG_KEY } from "@/lib/storage/odoo-config.storage";
import { createOdooClient, type OdooClient } from "@/lib/odoo/client";
import { odooError } from "@/lib/odoo/errors";
import { claimed, pushQueuedRow, type PushDeps } from "@/lib/odoo/meeting-log-push";
import { resetOdooRedactor, setOdooRedactor } from "@/lib/odoo/redactor";
import type { XmlRpcValue } from "@/lib/odoo/xmlrpc-codec";
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

/**
 * Straight into meeting_log_targets. Every fixture in this file that used to
 * rely on seedRow's legacy contact_id/lead_id columns now needs one of these
 * too - under the Task 9 schema those columns are read by NOTHING in
 * pushQueuedRow any more (only migration 14's one-time backfill ever read
 * them), so a row with no target row here has ZERO targets, and the new
 * pre-claim zero-target check returns before any wire call at all. Without
 * this helper the whole suite would pass vacuously.
 */
function seedTargets(rowId: string, targets: SeedTarget[]) {
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

function summary(over: Partial<SummarizationResult> = {}): SummarizationResult {
  return {
    title: "Kickoff", summary: "We agreed to start.", topics: [], goals: [],
    actionItems: [], nextSteps: [], decisions: [], teamUpdates: [],
    participants: [], entities: [], ...over,
  };
}

function makeDeps(over: Record<string, unknown> = {}) {
  return {
    client: createOdooClient(CONFIG),
    instance: INSTANCE,
    now: () => NOW,
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
  // odoo-contacts.sql creates odoo_selected_target, which migration 13
  // rebuilds and migration 14 reads FROM (its singleton-migration insert).
  // Migrations 13 and 14 in order (14's backfill reads lead_name, which 13
  // adds) - so meeting_log_targets exists before any test body runs.
  db.run(fs.readFileSync(path.join(MIGRATIONS, "odoo-contacts.sql"), "utf8"));
  db.run(fs.readFileSync(path.join(MIGRATIONS, "odoo-lead-only-target.sql"), "utf8"));
  db.run(fs.readFileSync(path.join(MIGRATIONS, "odoo-multi-target.sql"), "utf8"));
  tauriFetch.mockReset();
  claimed.clear();
  failNextWrite.value = null;
  nextSelectFailure.value = null;
  stealClaim.rowId = null;
  stampLastMeeting.mockClear();
  store.clear();
  store.set(SECURE_ODOO_CONFIG_KEY, JSON.stringify(CONFIG));
  setOdooRedactor([CONFIG.apiKey, CONFIG.login]);
});

afterEach(() => resetOdooRedactor());

describe("the happy path", () => {
  it("creates one attachment, posts one note carrying it, and marks the row sent", async () => {
    const row = seedRow();
    seedTargets("row-1", [{ resId: 42 }]);
    tauriFetch
      .mockResolvedValueOnce(AUTH())
      .mockResolvedValueOnce(intResponse(555))   // ir.attachment.create
      .mockResolvedValueOnce(intResponse(999));  // message_post
    await pushQueuedRow(row, makeDeps());

    expect(calls()).toEqual(["authenticate", "ir.attachment.create", "res.partner.message_post"]);
    const body = String(tauriFetch.mock.calls[2][1].body);
    expect(body).toContain("<int>555</int>"); // attachment_ids: [thatId]
    expect(await getQueueRow("row-1")).toMatchObject({ status: "sent", sent_at: NOW });
    expect(await listTargets("row-1")).toMatchObject([
      { status: "sent", attachmentId: 555, messageId: 999 },
    ]);
  });

  it("pins the note subtype to an internal log note", async () => {
    // Odoo's DEFAULT subtype happens to be an internal note today, on this
    // version, with no customer-side customisation. If that ever flips, every
    // customer is emailed their own meeting transcript. Pinning it makes the
    // guarantee something the code states rather than something a person must
    // remember to check.
    const row = seedRow();
    seedTargets("row-1", [{ resId: 42 }]);
    tauriFetch
      .mockResolvedValueOnce(AUTH())
      .mockResolvedValueOnce(intResponse(555))   // ir.attachment.create
      .mockResolvedValueOnce(intResponse(999));  // message_post

    await pushQueuedRow(row, makeDeps());

    // Index 2 is the message_post POST; index 0 is authenticate.
    const body = String(tauriFetch.mock.calls[2][1].body);
    expect(body).toContain("subtype_xmlid");
    expect(body).toContain("mail.mt_note");
  });

  it("issues NO search on the first attempt", async () => {
    // This is what pins the attemptsBefore boundary. `attempts` is incremented
    // by the claim CAS, so a post-CAS read is already 1 on a brand-new row and
    // an `attempts > 0` gate would fire on every first push - two wasted round
    // trips per meeting for every user, and every first attempt exposed to the
    // search-failure path.
    //
    // Do NOT pre-claim the row here. An earlier draft did, which left the DB
    // row `sending` while the in-memory copy still said `pending`, so
    // pushQueuedRow's own CAS returned 0 and the function returned before ANY
    // wire call - both not.toContain assertions then passed against an
    // implementation that searches on every attempt. The positive assertion
    // below is what stops it going vacuous again the same way.
    const row = seedRow();
    seedTargets("row-1", [{ resId: 42 }]);
    tauriFetch
      .mockResolvedValueOnce(AUTH())
      .mockResolvedValueOnce(intResponse(555))
      .mockResolvedValueOnce(intResponse(999));
    await pushQueuedRow(row, makeDeps());
    expect(calls()).toEqual(["authenticate", "ir.attachment.create", "res.partner.message_post"]);
  });

  it("names the attachment from transcript_start_at and the row id", async () => {
    seedRow();
    seedTargets("row-1", [{ resId: 42 }]);
    const row = await readRow("row-1");
    tauriFetch
      .mockResolvedValueOnce(AUTH())
      .mockResolvedValueOnce(intResponse(555))
      .mockResolvedValueOnce(intResponse(999));
    await pushQueuedRow(row, makeDeps());
    expect(String(tauriFetch.mock.calls[1][1].body)).toContain("-row-1.md");
  });

  it("persists summary_json before the first write so a retry re-posts the same body", async () => {
    seedRow();
    seedTargets("row-1", [{ resId: 42 }]);
    const row = await readRow("row-1");
    tauriFetch
      .mockResolvedValueOnce(AUTH())
      .mockResolvedValueOnce(intResponse(555))
      .mockResolvedValueOnce(intResponse(999));
    const d = makeDeps();
    await pushQueuedRow(row, d);
    expect(await getQueueRow("row-1")).toMatchObject({ summary_json: expect.stringContaining("Kickoff") });

    // A second push over the stored summary makes no second AI call.
    //
    // The DB row must be reset, not just the in-memory copy: after the first
    // push it is `sent`, so spreading `status: "pending"` onto a local object
    // only makes the CAS fail and the function return before the summary
    // branch - which would make this assertion pass against an implementation
    // that re-summarizes every time. The target's own message_id/status reset
    // the same way, so the second push has a pending target to re-attempt.
    db.run("UPDATE meeting_log_queue SET status='pending' WHERE id='row-1'");
    db.run("UPDATE meeting_log_targets SET status='pending', message_id=NULL WHERE row_id='row-1'");
    const stored = await readRow("row-1");
    (d.summarize as ReturnType<typeof vi.fn>).mockClear();
    tauriFetch.mockResolvedValueOnce(arrayResponse([])).mockResolvedValueOnce(intResponse(999));
    await pushQueuedRow(stored, d);
    expect(d.summarize).not.toHaveBeenCalled();
  });

  it("puts the AI summary in the note body instead of the fallback", async () => {
    // Regression: `deps.summarize` used to be handed a slice with
    // `entries: []` regardless of the row's actual transcript, so any real
    // summarizer's own empty-transcript guard returned null and the note
    // ALWAYS took the "Summarization failed" fallback body - even on a
    // completely healthy summarization run. Every fallback-path test before
    // this one only asserted the fallback text was present, which it always
    // was; nothing asserted a summary should have replaced it instead. This
    // is both real callers' common path (a freshly enqueued row has no
    // summary_json yet), not an edge case.
    const row = seedRow({ transcript: "You: hello\nGuest: hi there" });
    seedTargets("row-1", [{ resId: 42 }]);
    tauriFetch
      .mockResolvedValueOnce(AUTH())
      .mockResolvedValueOnce(intResponse(555))
      .mockResolvedValueOnce(intResponse(999));
    const d = makeDeps({
      summarize: vi.fn(async () => summary({ summary: "They agreed to start the pilot." })),
    });
    await pushQueuedRow(row, d);

    const body = String(tauriFetch.mock.calls[2][1].body);
    expect(body).toContain("They agreed to start the pilot.");
    expect(body).not.toContain("Summarization failed");

    // The slice handed to the summarizer must carry the actual transcript,
    // not an empty placeholder.
    const passedSlice = (d.summarize as ReturnType<typeof vi.fn>).mock.calls[0][0] as { entries: unknown[] };
    expect(passedSlice.entries.length).toBeGreaterThan(0);
  });
});

describe("model discrimination", () => {
  it("posts to crm.lead when lead_id is set", async () => {
    // An implementation that ALWAYS posts to res.partner passes every other
    // case here, and posting a customer transcript to the wrong record is this
    // slice's worst outcome.
    const row = seedRow({ lead_id: 88 });
    seedTargets("row-1", [{ resId: 88, model: "crm.lead" }]);
    tauriFetch
      .mockResolvedValueOnce(AUTH())
      .mockResolvedValueOnce(intResponse(555))
      .mockResolvedValueOnce(intResponse(999));
    await pushQueuedRow(row, makeDeps());
    expect(calls()).toContain("crm.lead.message_post");
    expect(calls()).not.toContain("res.partner.message_post");
    expect(String(tauriFetch.mock.calls[1][1].body)).toContain("crm.lead"); // res_model
  });

  it("posts to res.partner with contact_id when lead_id is null", async () => {
    const row = seedRow({ lead_id: null, contact_id: 42 });
    seedTargets("row-1", [{ resId: 42, model: "res.partner" }]);
    tauriFetch
      .mockResolvedValueOnce(AUTH())
      .mockResolvedValueOnce(intResponse(555))
      .mockResolvedValueOnce(intResponse(999));
    await pushQueuedRow(row, makeDeps());
    expect(calls()).toContain("res.partner.message_post");
  });
});

describe("idempotency", () => {
  it("reuses a stored attachment_id and creates no second attachment", async () => {
    // BUDGET THE SEARCH. attempts:1 means attemptsBefore > 0, so step 2 issues
    // mail.message.search BEFORE message_post. An earlier draft queued only
    // AUTH + 999: the search ate the int, firstId threw ODOO_UNEXPECTED_ROW,
    // the row was failed and message_post never fired.
    const row = seedRow({ attachment_id: 555, attempts: 1 });
    seedTargets("row-1", [{ resId: 42, attachmentId: 555 }]);
    tauriFetch
      .mockResolvedValueOnce(AUTH())
      .mockResolvedValueOnce(arrayResponse([]))
      .mockResolvedValueOnce(intResponse(999));
    await pushQueuedRow(row, makeDeps());
    expect(calls()).not.toContain("ir.attachment.create");
    expect(calls()).toContain("res.partner.message_post");
    expect(await getQueueRow("row-1")).toMatchObject({ status: "sent" });
  });

  it("searches before creating on a retry with no stored attachment id, and adopts a match", async () => {
    // The commit-then-timeout window: Odoo created the attachment and the
    // response never came back, so attachment_id is NULL but the file exists.
    const row = seedRow({ attempts: 1 });
    seedTargets("row-1", [{ resId: 42 }]);
    tauriFetch
      .mockResolvedValueOnce(AUTH())
      .mockResolvedValueOnce(arrayResponse([777]))  // ir.attachment.search
      .mockResolvedValueOnce(arrayResponse([]))     // mail.message.search
      .mockResolvedValueOnce(intResponse(999));
    await pushQueuedRow(row, makeDeps());
    expect(calls()).toContain("ir.attachment.search");
    expect(calls()).not.toContain("ir.attachment.create");
    expect(await getQueueRow("row-1")).toMatchObject({ status: "sent" });
    expect((await listTargets("row-1"))[0]).toMatchObject({ attachmentId: 777, status: "sent" });
  });

  it("creates when the retry search finds nothing", async () => {
    const row = seedRow({ attempts: 1 });
    seedTargets("row-1", [{ resId: 42 }]);
    tauriFetch
      .mockResolvedValueOnce(AUTH())
      .mockResolvedValueOnce(arrayResponse([]))
      .mockResolvedValueOnce(intResponse(555))
      .mockResolvedValueOnce(arrayResponse([]))   // mail.message.search
      .mockResolvedValueOnce(intResponse(999));
    await pushQueuedRow(row, makeDeps());
    expect(calls()).toContain("ir.attachment.create");
    expect(await getQueueRow("row-1")).toMatchObject({ status: "sent" });
  });

  it("searches mail.message before re-posting and adopts a match, creating no second note", async () => {
    // message_post succeeded on the wire and the status write never landed.
    // Without this the sweep posts a SECOND customer-visible chatter note.
    const row = seedRow({ attachment_id: 555, attempts: 1 });
    seedTargets("row-1", [{ resId: 42, attachmentId: 555 }]);
    tauriFetch.mockResolvedValueOnce(AUTH()).mockResolvedValueOnce(arrayResponse([321]));
    await pushQueuedRow(row, makeDeps());
    expect(calls()).toContain("mail.message.search");
    expect(calls()).not.toContain("res.partner.message_post");
    expect(await getQueueRow("row-1")).toMatchObject({ status: "sent" });
    expect((await listTargets("row-1"))[0]).toMatchObject({ status: "sent", messageId: 321 });
  });

  it("short-circuits entirely when both ids are already stored", async () => {
    const row = seedRow({ attachment_id: 555, message_id: 999, attempts: 2 });
    seedTargets("row-1", [{ resId: 42, attachmentId: 555, messageId: 999 }]);
    await pushQueuedRow(row, makeDeps());
    expect(tauriFetch).not.toHaveBeenCalled();
    expect(await getQueueRow("row-1")).toMatchObject({ status: "sent" });
  });
});

describe("a search that fails never falls through to a write", () => {
  it("keeps the row pending on a transport failure, issuing no create and no post", async () => {
    const row = seedRow({ attempts: 1 });
    seedTargets("row-1", [{ resId: 42 }]);
    tauriFetch.mockResolvedValueOnce(AUTH()).mockRejectedValueOnce(new Error("ECONNREFUSED"));
    await pushQueuedRow(row, makeDeps());
    expect(calls()).not.toContain("ir.attachment.create");
    expect(await getQueueRow("row-1")).toMatchObject({
      status: "pending", last_error_code: "ODOO_UNREACHABLE",
    });
  });

  it("FAILS the row on a deterministic refusal rather than wedging it forever", async () => {
    // An Odoo user that can message_post but cannot search mail.message is a
    // realistic configuration. Keeping it pending would retry a call that can
    // never succeed, on every launch, forever.
    const row = seedRow({ attachment_id: 555, attempts: 1 });
    seedTargets("row-1", [{ resId: 42, attachmentId: 555 }]);
    tauriFetch.mockResolvedValueOnce(AUTH()).mockResolvedValueOnce(faultResponse(2, "AccessError"));
    await pushQueuedRow(row, makeDeps());
    expect(calls()).not.toContain("res.partner.message_post");
    expect(await getQueueRow("row-1")).toMatchObject({
      status: "failed", last_error_code: "ODOO_FAULT",
    });
  });
});

describe("the instance re-check", () => {
  it("does not post a row belonging to another database, and does not move attempts", async () => {
    // The check runs BEFORE the claim CAS precisely so a mismatch moves neither
    // status nor attempts.
    const row = seedRow({ instance: "http://h:8069|staging" });
    seedTargets("row-1", [{ resId: 42 }]);
    await pushQueuedRow(row, makeDeps());
    expect(tauriFetch).not.toHaveBeenCalled();
    expect(await getQueueRow("row-1")).toMatchObject({ status: "pending", attempts: 0 });
  });
});

describe("the claim CAS", () => {
  it("does nothing when the row is already terminal and the claim is refused", async () => {
    // claimRow's WHERE clause only matches ('pending','held'), so a row some
    // OTHER attempt already finished - here, 'sent' - must refuse the CAS and
    // pushQueuedRow must return before any wire call. A non-empty target set
    // is required so this actually reaches the claim CAS, rather than being
    // declined earlier by the zero-target check (which would ALSO produce a
    // no-op here, for the wrong reason: 'sent' is itself derive-forbidden).
    const row = seedRow({ status: "sent", attachment_id: 555, message_id: 999 });
    seedTargets("row-1", [{ resId: 42, status: "sent" }]);
    await pushQueuedRow(row, makeDeps());
    expect(tauriFetch).not.toHaveBeenCalled();
    expect(await getQueueRow("row-1")).toMatchObject({ status: "sent", attempts: 0 });
  });
});

describe("the code table", () => {
  it("keeps the row pending on a 5xx", async () => {
    const row = seedRow();
    seedTargets("row-1", [{ resId: 42 }]);
    tauriFetch.mockResolvedValueOnce(AUTH()).mockResolvedValueOnce(xml("", 503));
    await pushQueuedRow(row, makeDeps());
    expect(await getQueueRow("row-1")).toMatchObject({ status: "pending" });
  });

  it("FAILS the row on a 4xx that is not 408 or 429", async () => {
    // client.ts:58-62 maps EVERY non-2xx to ODOO_UNREACHABLE, so without the
    // status split a proxy 413 on a large attachment retries every launch
    // forever.
    const row = seedRow();
    seedTargets("row-1", [{ resId: 42 }]);
    tauriFetch.mockResolvedValueOnce(AUTH()).mockResolvedValueOnce(xml("", 413));
    await pushQueuedRow(row, makeDeps());
    expect(await getQueueRow("row-1")).toMatchObject({ status: "failed" });
  });

  it("keeps the row pending on a 429", async () => {
    const row = seedRow();
    seedTargets("row-1", [{ resId: 42 }]);
    tauriFetch.mockResolvedValueOnce(AUTH()).mockResolvedValueOnce(xml("", 429));
    await pushQueuedRow(row, makeDeps());
    expect(await getQueueRow("row-1")).toMatchObject({ status: "pending" });
  });

  it("keeps the row pending on ODOO_AUTH_FAILED", async () => {
    const row = seedRow();
    seedTargets("row-1", [{ resId: 42 }]);
    tauriFetch.mockResolvedValueOnce(intResponse(0)); // uid 0 = rejected credentials
    await pushQueuedRow(row, makeDeps());
    expect(await getQueueRow("row-1")).toMatchObject({
      status: "pending", last_error_code: "ODOO_AUTH_FAILED",
    });
  });

  // ODOO_NOT_CONFIGURED is not reachable inside pushQueuedRow: the caller
  // resolves the config and passes the fingerprint in, so a not-configured
  // sweep never gets this far. Its behaviour is pinned in Task 7 instead, at
  // the level where it actually happens.

  it("FAILS the row on ODOO_FAULT", async () => {
    const row = seedRow();
    seedTargets("row-1", [{ resId: 42 }]);
    tauriFetch.mockResolvedValueOnce(AUTH()).mockResolvedValueOnce(faultResponse(2, "no such partner"));
    await pushQueuedRow(row, makeDeps());
    expect(await getQueueRow("row-1")).toMatchObject({ status: "failed", last_error_code: "ODOO_FAULT" });
  });

  it("FAILS the row on an unexpected Odoo return value", async () => {
    // expectInt turns this into ODOO_UNEXPECTED_ROW - an OdooError - which
    // isRetryable's `default` correctly refuses to retry.
    const row = seedRow();
    seedTargets("row-1", [{ resId: 42 }]);
    tauriFetch
      .mockResolvedValueOnce(AUTH())
      .mockResolvedValueOnce(xml("<methodResponse><params><param><value><boolean>0</boolean></value></param></params></methodResponse>"));
    await pushQueuedRow(row, makeDeps());
    expect(await getQueueRow("row-1")).toMatchObject({ status: "failed" });
  });
});

describe("a local write failing after the Odoo write already landed", () => {
  it("returns the row to pending on the ADOPT path, not just the create path", async () => {
    // The adopt paths and the both-ids-stored short-circuit perform local
    // writes with NO Odoo call in that attempt, so routing on "did we write to
    // Odoo this time" would fail a meeting whose note is already live on the
    // customer's record - and selectSweepable never picks up `failed`.
    const row = seedRow({ attachment_id: 555, attempts: 1 });
    seedTargets("row-1", [{ resId: 42, attachmentId: 555 }]);
    tauriFetch.mockResolvedValueOnce(AUTH()).mockResolvedValueOnce(arrayResponse([321]));
    failNextWrite.value = "UPDATE meeting_log_targets SET message_id";
    await pushQueuedRow(row, makeDeps());
    expect(await getQueueRow("row-1")).toMatchObject({ status: "pending" });
  });

  it("returns the row to pending when markSent fails on a fully-logged meeting", async () => {
    const row = seedRow({ attachment_id: 555, message_id: 999, attempts: 2 });
    seedTargets("row-1", [{ resId: 42, attachmentId: 555, messageId: 999 }]);
    failNextWrite.value = "UPDATE meeting_log_targets\n    SET status = 'sent'";
    await pushQueuedRow(row, makeDeps());
    expect(tauriFetch).not.toHaveBeenCalled();
    expect(await getQueueRow("row-1")).toMatchObject({ status: "pending" });
  });
});

describe("a pre-wire failure is never terminal", () => {
  it("leaves the row alone when the claim itself cannot be written", async () => {
    // A transient store/disk error must not permanently fail a row that never
    // reached Odoo - and a broken database must not convert the ENTIRE queue to
    // `failed` in one sweep, with no exit before slice 3.
    const row = seedRow();
    seedTargets("row-1", [{ resId: 42 }]);
    failNextWrite.value = "UPDATE meeting_log_queue\n   SET status = 'sending'";
    await pushQueuedRow(row, makeDeps());
    expect(tauriFetch).not.toHaveBeenCalled();
    expect(await getQueueRow("row-1")).toMatchObject({ status: "pending", attempts: 0 });
  });

  it("does NOT fail a row whose Odoo write already landed but whose DB write did not", async () => {
    // ir.attachment.create SUCCEEDED; the target's attachment_id write then
    // fails. Failing the row here would leave an orphan attachment on the
    // customer's record with no chatter note, and selectSweepable never picks
    // up `failed` - so nothing recovers it before slice 3. A re-push is
    // provably safe (the name is deterministic and attemptsBefore > 0 forces
    // the adopt-search), so the row must go back to `pending`.
    //
    // `failNextWrite` is the harness hook declared in this file's
    // @/lib/database/config mock (see the beforeEach); it makes the NEXT
    // db.execute reject once, which is how a single-statement SQLITE_BUSY is
    // simulated without a second database.
    const row = seedRow();
    seedTargets("row-1", [{ resId: 42 }]);
    tauriFetch.mockResolvedValueOnce(AUTH()).mockResolvedValueOnce(intResponse(555));
    failNextWrite.value = "UPDATE meeting_log_targets SET attachment_id";
    await pushQueuedRow(row, makeDeps());
    expect(calls()).toContain("ir.attachment.create");
    expect(await getQueueRow("row-1")).toMatchObject({ status: "pending" });
    expect((await getQueueRow("row-1"))?.status).not.toBe("failed");
  });
});

describe("summarization is walled off from the push", () => {
  it("still pushes, with a fallback body, when the summarizer rejects", async () => {
    const row = seedRow();
    seedTargets("row-1", [{ resId: 42 }]);
    tauriFetch
      .mockResolvedValueOnce(AUTH())
      .mockResolvedValueOnce(intResponse(555))
      .mockResolvedValueOnce(intResponse(999));
    await pushQueuedRow(row, makeDeps({ summarize: vi.fn(async () => { throw new Error("429"); }) }));
    expect(String(tauriFetch.mock.calls[2][1].body)).toContain("Summarization failed");
    expect(await getQueueRow("row-1")).toMatchObject({ status: "sent" });
  });

  it("takes the same path when the summarizer returns null", async () => {
    // parseSummarizationResponse NEVER throws - it catches and returns null
    // (meeting-summarizer.ts:239-243). That is the common real failure.
    const row = seedRow();
    seedTargets("row-1", [{ resId: 42 }]);
    tauriFetch
      .mockResolvedValueOnce(AUTH())
      .mockResolvedValueOnce(intResponse(555))
      .mockResolvedValueOnce(intResponse(999));
    await pushQueuedRow(row, makeDeps({ summarize: vi.fn(async () => null) }));
    expect(String(tauriFetch.mock.calls[2][1].body)).toContain("Summarization failed");
    expect(await getQueueRow("row-1")).toMatchObject({ status: "sent" });
  });

  it("caps the fallback body at FALLBACK_LINES instead of inlining the whole transcript", async () => {
    // Regression: the slice built for buildNoteBody used to be a SINGLE
    // synthetic entry wrapping the entire stored transcript, so
    // `slice.entries.slice(0, FALLBACK_LINES)` capped nothing - one entry is
    // one entry - and the full verbatim transcript landed in a
    // customer-visible chatter note under body text that promises only the
    // first lines. This is the COMMON path, not an exotic one:
    // parseSummarizationResponse returns null rather than throwing, so any
    // unparseable model output takes it. One entry per transcript LINE is
    // what makes the FALLBACK_LINES cap actually cap.
    const lines = Array.from({ length: 12 }, (_, i) => `line-${i}`);
    const row = seedRow({ transcript: lines.join("\n") });
    seedTargets("row-1", [{ resId: 42 }]);
    tauriFetch
      .mockResolvedValueOnce(AUTH())
      .mockResolvedValueOnce(intResponse(555))
      .mockResolvedValueOnce(intResponse(999));
    await pushQueuedRow(row, makeDeps({ summarize: vi.fn(async () => null) }));
    const body = String(tauriFetch.mock.calls[2][1].body);
    expect(body).toContain("line-0");
    expect(body).not.toContain("line-11");
  });

  it("takes the same path for a result with an empty summary", async () => {
    const row = seedRow();
    seedTargets("row-1", [{ resId: 42 }]);
    tauriFetch
      .mockResolvedValueOnce(AUTH())
      .mockResolvedValueOnce(intResponse(555))
      .mockResolvedValueOnce(intResponse(999));
    await pushQueuedRow(row, makeDeps({ summarize: vi.fn(async () => summary({ summary: "" })) }));
    expect(String(tauriFetch.mock.calls[2][1].body)).toContain("Summarization failed");
  });

  it("leaves last_error NULL when the summarizer rejects", async () => {
    // The AI try/catch must be SEPARATE from the push's. fetchAIResponse
    // re-wraps every downstream failure as `Error in fetchAIResponse: ...`
    // (ai-response.function.ts:486), and for providers that key the URL that
    // message can carry the AI key - for which the Odoo redactor holds no
    // needle at all.
    const row = seedRow();
    seedTargets("row-1", [{ resId: 42 }]);
    tauriFetch
      .mockResolvedValueOnce(AUTH())
      .mockResolvedValueOnce(intResponse(555))
      .mockResolvedValueOnce(intResponse(999));
    await pushQueuedRow(row, makeDeps({
      summarize: vi.fn(async () => { throw new Error("openai key sk-ai-123 rejected"); }),
    }));
    const stored = await getQueueRow("row-1");
    expect(stored?.last_error).toBeNull();
    expect(stored?.last_error_code).toBeNull();
  });
});

describe("last_error redaction", () => {
  it("strips the api key from a PLAIN Error while keeping benign text, read back OUT of SQLite", async () => {
    // Fail-closed redaction means `not.toContain(secret)` passes whether or not
    // redaction ran, so the benign-marker assertion is what makes this fail in
    // BOTH directions. Slice 1 hit that trap four times.
    const row = seedRow();
    seedTargets("row-1", [{ resId: 42 }]);
    tauriFetch
      .mockResolvedValueOnce(AUTH())
      .mockRejectedValueOnce(new Error(`socket hang up while sending sk-secret to odoo`));
    await pushQueuedRow(row, makeDeps());
    const stored = await getQueueRow("row-1");
    expect(stored?.last_error).not.toContain("sk-secret");
    expect(stored?.last_error).toContain("socket hang up");
  });
});

describe("the claimed set", () => {
  it("registers the row while pushing and removes it afterwards, even on failure", async () => {
    const row = seedRow();
    seedTargets("row-1", [{ resId: 42 }]);
    let observed = false;
    tauriFetch.mockResolvedValueOnce(AUTH()).mockImplementationOnce(async () => {
      observed = claimed.has("row-1");
      throw new Error("boom");
    });
    await pushQueuedRow(row, makeDeps());
    expect(observed).toBe(true);
    expect(claimed.has("row-1")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Task 9: the push loop, per target. A lightweight fake OdooClient - not the
// real XML-RPC wire - so these tests can assert on `client.execute` calls
// directly and drive multi-target scenarios (five targets, a failure on the
// third, a stolen claim mid-loop) without hand-building XML-RPC bodies for
// every call.
// ---------------------------------------------------------------------------
describe("the push loop, per target", () => {
  let client: OdooClient;
  let deps: PushDeps;
  const postFailures = new WeakMap<OdooClient, { n: number; error: unknown }>();
  let postCount: number;

  function makeClient(): OdooClient {
    let nextId = 100;
    const fake: OdooClient = {
      authenticate: vi.fn(async () => 7),
      execute: vi.fn(
        async (
          _model: string,
          method: string,
          _args: XmlRpcValue[],
          _kwargs?: Record<string, XmlRpcValue>
        ): Promise<XmlRpcValue> => {
          if (method === "search") return [];
          if (method === "message_post") {
            postCount += 1;
            const failure = postFailures.get(fake);
            if (failure && postCount === failure.n) throw failure.error;
          }
          return nextId++;
        }
      ),
      serverDate: null,
    };
    return fake;
  }

  function postCalls(target: OdooClient) {
    return (target.execute as ReturnType<typeof vi.fn>).mock.calls.filter(
      (args) => args[1] === "message_post"
    );
  }

  function failPostFor(target: OdooClient, n: number, error: unknown) {
    postFailures.set(target, { n, error });
  }

  function odooFault() {
    return odooError("ODOO_FAULT", "Odoo fault 2", { faultCode: 2, faultString: "AccessError" });
  }

  function unreachable() {
    return odooError("ODOO_UNREACHABLE", "Odoo is unreachable", { reason: "network" });
  }

  function failNextExecute(prefix: string) {
    failNextWrite.value = prefix;
  }

  function failNextSelect(prefix: string) {
    nextSelectFailure.value = prefix;
  }

  function stealClaimAfterFirstTarget(rowId: string) {
    stealClaim.rowId = rowId;
  }

  beforeEach(() => {
    postCount = 0;
    client = makeClient();
    deps = {
      client,
      instance: INSTANCE,
      now: () => NOW,
      summarize: vi.fn(async () => summary()),
    };
  });

  it("posts to every pending target and skips the sent ones", async () => {
    seedRow({ id: "r1", status: "pending" });
    seedTargets("r1", [
      { resId: 1, status: "sent", attachmentId: 11, messageId: 22 },
      { resId: 2, status: "pending" },
    ]);
    await pushQueuedRow(await readRow("r1"), deps);
    expect(postCalls(client)).toHaveLength(1);
    expect(client.execute).toHaveBeenCalledWith(
      "res.partner", "message_post", [[2]],
      expect.objectContaining({ subtype_xmlid: "mail.mt_note" }),
    );
  });

  // SUPPLEMENTAL - added because the mutation check above passed vacuously.
  // In the "skips the sent ones" test above, the sent target ALSO carries
  // both ids already, so dropping the `!== "pending"` skip entirely still
  // produces the same observable result: attachmentId/messageId are non-null,
  // so createOrAdoptAttachment/postOrAdoptMessage are skipped by their own
  // null checks, and targetToSent's `status <> 'sent'` guard makes the
  // redundant write a no-op. The realistic "sent" shape incidentally masks a
  // missing status skip, the same way a pre-seeded terminal state can mask a
  // guard mutant. This fixture breaks that mask: a `sent` target with no
  // stored ids can ONLY be protected by the explicit status check, not by the
  // short-circuit - proving the Global Constraint ("a sent target row is
  // immutable") is enforced by the skip itself, not as a side effect of
  // typical data shape.
  it("never re-attempts a sent target, even one with no attachment or message id stored", async () => {
    seedRow({ id: "r1", status: "pending" });
    seedTargets("r1", [
      { resId: 1, status: "sent" },
      { resId: 2, status: "pending" },
    ]);
    await pushQueuedRow(await readRow("r1"), deps);
    expect(postCalls(client)).toHaveLength(1);
    expect((await listTargets("r1")).find((x) => x.resId === 1)).toMatchObject({
      status: "sent", attachmentId: null, messageId: null,
    });
  });

  it("continues past a deterministic failure on target 3 of 5", async () => {
    seedRow({ id: "r1", status: "pending" });
    seedTargets("r1", [1, 2, 3, 4, 5].map((resId) => ({ resId, status: "pending" as const })));
    failPostFor(client, 3, odooFault());
    await pushQueuedRow(await readRow("r1"), deps);
    const t = await listTargets("r1");
    expect(t.filter((x) => x.status === "sent").map((x) => x.resId)).toEqual([1, 2, 4, 5]);
    expect(t.find((x) => x.resId === 3)!.status).toBe("failed");
  });

  it("aborts the remaining targets on a retryable transport failure, and records its error", async () => {
    seedRow({ id: "r1", status: "pending" });
    seedTargets("r1", [1, 2, 3].map((resId) => ({ resId, status: "pending" as const })));
    failPostFor(client, 2, unreachable());
    await pushQueuedRow(await readRow("r1"), deps);
    const t = await listTargets("r1");
    expect(t.find((x) => x.resId === 3)!.status).toBe("pending");   // never attempted
    expect(t.find((x) => x.resId === 2)!.lastErrorCode).toBe("ODOO_UNREACHABLE");
  });

  // SUPPLEMENTAL - the given retryable/deterministic-fault tests all throw
  // real OdooError instances (odooFault()/unreachable(), and the real client
  // wraps every one of its own rejections in odooError() too), so passing
  // the raw error straight to isRetryable instead of toOdooError(err) is
  // unobservable in every given test: `raw.code` is already the SAME code
  // toOdooError(raw) would have produced, because `raw` already IS an
  // OdooError. This fixture throws a plain object that merely LOOKS like an
  // OdooError (has a `.code`) but isn't an instance - toOdooError must wrap
  // it to ODOO_INTERNAL (deterministic), whereas reading `.code` off the raw
  // value directly hits isRetryable's "ODOO_AUTH_FAILED" case and misreports
  // it as retryable.
  it("wraps a non-OdooError rejection before checking retryability, even one that looks like one", async () => {
    seedRow({ id: "r1", status: "pending" });
    seedTargets("r1", [{ resId: 1, status: "pending" }]);
    failPostFor(client, 1, { code: "ODOO_AUTH_FAILED", message: "not really an OdooError" });
    await pushQueuedRow(await readRow("r1"), deps);
    expect((await listTargets("r1"))[0].status).toBe("failed");
  });

  it("routes a local write failure after a wire call to pending, never failed", async () => {
    seedRow({ id: "r1", status: "pending" });
    seedTargets("r1", [{ resId: 1, status: "pending" }]);
    failNextExecute("UPDATE meeting_log_targets SET attachment_id");
    await pushQueuedRow(await readRow("r1"), deps);
    expect((await listTargets("r1"))[0].status).toBe("pending");
  });

  // SUPPLEMENTAL - none of the given fixtures make the RE-STAMP's own write
  // fail (failNextExecute above targets a DIFFERENT statement, the target's
  // attachment_id write, whose failure the outer per-target catch already
  // handles). A restampClaim failure specifically exercises the guard this
  // mutant removes. Whether that guard exists cannot be told apart from
  // outside by the returned promise alone: pushQueuedRow's OWN outer
  // try/catch would still swallow an unguarded throw here and resolve
  // normally either way (an escaped throw from inside the loop's `finally`
  // propagates to the OUTER catch, which already logs and never rethrows) -
  // so the only observable difference between "guarded" and "unguarded" is
  // WHICH log line fires. That is still a "genuine mid-flight transition":
  // a real write, at a real point, genuinely failing.
  it("logs the claim re-stamp's own failure locally, not via the outer catch", async () => {
    seedRow({ id: "r1", status: "pending" });
    seedTargets("r1", [{ resId: 1, status: "pending" }]);
    failNextExecute("UPDATE meeting_log_queue SET claimed_at");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await pushQueuedRow(await readRow("r1"), deps); // must not reject
    expect(warn).toHaveBeenCalledWith("[meeting-log] claim re-stamp failed", expect.anything());
    warn.mockRestore();
  });

  it("does not let a persistence failure on target 1 misclassify target 3's Odoo fault", async () => {
    seedRow({ id: "r1", status: "pending" });
    seedTargets("r1", [1, 2, 3].map((resId) => ({ resId, status: "pending" as const })));
    failNextExecute("UPDATE meeting_log_targets SET attachment_id");   // target 1
    failPostFor(client, 3, odooFault());
    await pushQueuedRow(await readRow("r1"), deps);
    // The pass aborted at target 1, so target 3 was never reached this pass.
    expect((await listTargets("r1")).find((x) => x.resId === 3)!.status).toBe("pending");
  });

  it("re-stamps claimed_at after each target, tracking the last one", async () => {
    seedRow({ id: "r1", status: "pending" });
    seedTargets("r1", [{ resId: 1, status: "pending" }, { resId: 2, status: "pending" }]);
    const clock = vi.fn().mockReturnValueOnce(1_000).mockReturnValueOnce(2_000)
                         .mockReturnValue(3_000);
    await pushQueuedRow(await readRow("r1"), { ...deps, now: clock });
    // DEVIATION FROM THE BRIEF'S LITERAL ASSERTION, verified empirically: both
    // targets succeed here, so the terminal `deriveRowStatus(row.id,
    // "sending", deps.now())` call after the loop (Step 4's own pseudocode)
    // reaches QUEUE_SQL.deriveStatus, whose `claimed_at = NULL` is
    // UNCONDITIONAL - see meeting-log.action.ts's comment on that statement:
    // "Clearing claimed_at is part of the reduction to today's
    // toSent/toFailed/toPending, all three of which set it NULL." That is
    // pre-existing Task 8 behavior, not something this task changes, and it
    // means claimed_at can NEVER be observed as a live timestamp on a row
    // that finishes a pass without its claim being stolen - "3_000" is
    // unreachable here, on ANY correct implementation. The neighbouring
    // "zero-rows" test is what actually observes claimed_at mid-flight,
    // before a stolen claim skips that final derive - see its own comment.
    //
    // What this test can still prove: the clock is read fresh EVERY target
    // (targetToSent, the res.partner last_meeting_at stamp, and the claim
    // re-stamp - 3 reads x 2 targets), plus once for the initial claim and
    // once more for the terminal derive - 8 total. A hoisted, once-only
    // `now` value used for the restamp would read the clock fewer times.
    expect(clock).toHaveBeenCalledTimes(8);
    expect((await readRow("r1")).claimed_at).toBeNull();
  });
  // NOTE: this test alone cannot distinguish "re-stamp after every target" from
  // "re-stamp once after the loop" via the FINAL claimed_at value (both are
  // erased by the terminal derive either way). The neighbouring zero-rows test
  // is what proves the per-target cadence by observing mid-flight state. They
  // only work as a pair.

  it("aborts the pass when the claim re-stamp affects zero rows", async () => {
    seedRow({ id: "r1", status: "pending" });
    seedTargets("r1", [{ resId: 1, status: "pending" }, { resId: 2, status: "pending" }]);
    // Injects a competing write BETWEEN two of the push's own calls - unlike
    // failNextWrite, which is a one-shot self-failure hook. The mocked
    // getDatabase().execute (this file's top-of-file mock) fires a raw
    // competing UPDATE right after the first `SET status = 'sent'` write on
    // meeting_log_targets lands.
    stealClaimAfterFirstTarget("r1");
    await pushQueuedRow(await readRow("r1"), deps);
    expect((await listTargets("r1")).find((x) => x.resId === 2)!.status).toBe("pending");
    expect(postCalls(client)).toHaveLength(1);
  });

  // SUPPLEMENTAL - none of the given fixtures seed a `failed` target, so a
  // skip written as `status === "sent"` (instead of `!== "pending"`) never
  // diverges from the correct skip in any of them: every non-pending target
  // used elsewhere in this file is already `sent`. A `failed` sibling is
  // exactly the case the brief's own prose calls out - "skipping only sent
  // means a deterministically failed child is re-attempted on EVERY sweep of
  // a row that still has a pending sibling."
  it("never re-attempts a failed target either, only a pending one", async () => {
    seedRow({ id: "r1", status: "pending" });
    seedTargets("r1", [
      { resId: 1, status: "failed", lastErrorCode: "ODOO_FAULT", lastError: "no such partner" },
      { resId: 2, status: "pending" },
    ]);
    await pushQueuedRow(await readRow("r1"), deps);
    expect(postCalls(client)).toHaveLength(1);
    expect((await listTargets("r1")).find((x) => x.resId === 1)).toMatchObject({
      status: "failed", lastErrorCode: "ODOO_FAULT",
    });
  });

  it("stamps last_meeting_at for every contact target and skips leads", async () => {
    seedRow({ id: "r1", status: "pending" });
    seedTargets("r1", [
      { resId: 1, model: "res.partner", status: "pending" },
      { resId: 2, model: "res.partner", status: "pending" },
      { resId: 9, model: "crm.lead", status: "pending" },
    ]);
    await pushQueuedRow(await readRow("r1"), deps);
    expect(stampLastMeeting).toHaveBeenCalledTimes(2);
  });

  it("declines a zero-target row before the claim, and derives it out of Waiting", async () => {
    seedRow({ id: "r1", status: "pending", attempts: 0 });
    await pushQueuedRow(await readRow("r1"), deps);
    // attempts untouched (never claimed), but the status IS corrected, or the row
    // sits in countAllQueued's "these will be sent" promise permanently.
    expect(await readRow("r1")).toMatchObject({ status: "unassigned", attempts: 0 });
  });

  // REVIEW FIX (Important #1) - the pre-claim `listTargets` read sat outside
  // every try/catch, so a transient SQLITE_BUSY on that SELECT rejected
  // pushQueuedRow itself, breaking its own documented NEVER THROWS contract.
  // Mirrors the neighbouring "leaves the row alone when the claim itself
  // cannot be written" test, but for the read one step earlier.
  it("never throws when the pre-claim target read itself fails", async () => {
    seedRow({ id: "r1", status: "pending" });
    failNextSelect("SELECT * FROM meeting_log_targets");
    await expect(pushQueuedRow(await readRow("r1"), deps)).resolves.toBeUndefined();
    // Not claimed (the read failed before the CAS), and left exactly as it was.
    expect(await readRow("r1")).toMatchObject({ status: "pending", attempts: 0 });
  });

  // DELETED "re-stamps the claim after a deterministic failure too" (the
  // brief's own given test), on review: it asserted
  // `expect((await readRow("r1")).claimed_at).not.toBe(1_000)` with TWO
  // targets, both of which terminate (target 1 fails deterministically,
  // target 2 succeeds) - so the terminal derive's CAS matches and
  // QUEUE_SQL.deriveStatus sets `claimed_at = NULL` unconditionally
  // regardless of whether the re-stamp ran at all. `expect(null).not.toBe(
  // 1_000)` is a tautology: it passes under every implementation, including
  // one with the re-stamp deleted outright. Same unreachability as the
  // "tracking the last one" test's original `toBe(3_000)`, just not carried
  // across to this sibling the first time. The test below already covers the
  // same scenario correctly (a single target, so nothing else in the pass
  // can refresh the clock, and it counts clock reads instead of the final
  // value, which the terminal derive erases either way) and is the mutant-8
  // killer of record - see Step 7 in the report.
  it("reads the clock in finally even when the row's only target fails deterministically", async () => {
    seedRow({ id: "r1", status: "pending" });
    seedTargets("r1", [{ resId: 1, status: "pending" }]);
    failPostFor(client, 1, odooFault());
    const clock = vi.fn(() => 9_000);
    await pushQueuedRow(await readRow("r1"), { ...deps, now: clock });
    expect(clock).toHaveBeenCalledTimes(3);
  });
});
