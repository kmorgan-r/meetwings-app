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
import { SECURE_ODOO_CONFIG_KEY } from "@/lib/storage/odoo-config.storage";
import { createOdooClient } from "@/lib/odoo/client";
import { pushQueuedRow, claimed } from "@/lib/odoo/meeting-log-push";
import { resetOdooRedactor, setOdooRedactor } from "@/lib/odoo/redactor";
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
  tauriFetch.mockReset();
  claimed.clear();
  failNextWrite.value = null;
  store.clear();
  store.set(SECURE_ODOO_CONFIG_KEY, JSON.stringify(CONFIG));
  setOdooRedactor([CONFIG.apiKey, CONFIG.login]);
});

afterEach(() => resetOdooRedactor());

describe("the happy path", () => {
  it("creates one attachment, posts one note carrying it, and marks the row sent", async () => {
    const row = seedRow();
    tauriFetch
      .mockResolvedValueOnce(AUTH())
      .mockResolvedValueOnce(intResponse(555))   // ir.attachment.create
      .mockResolvedValueOnce(intResponse(999));  // message_post
    await pushQueuedRow(row, deps());

    expect(calls()).toEqual(["authenticate", "ir.attachment.create", "res.partner.message_post"]);
    const body = String(tauriFetch.mock.calls[2][1].body);
    expect(body).toContain("<int>555</int>"); // attachment_ids: [thatId]
    expect(await getQueueRow("row-1")).toMatchObject({
      status: "sent", sent_at: NOW, attachment_id: 555, message_id: 999,
    });
  });

  it("pins the note subtype to an internal log note", async () => {
    // Odoo's DEFAULT subtype happens to be an internal note today, on this
    // version, with no customer-side customisation. If that ever flips, every
    // customer is emailed their own meeting transcript. Pinning it makes the
    // guarantee something the code states rather than something a person must
    // remember to check.
    const row = seedRow();
    tauriFetch
      .mockResolvedValueOnce(AUTH())
      .mockResolvedValueOnce(intResponse(555))   // ir.attachment.create
      .mockResolvedValueOnce(intResponse(999));  // message_post

    await pushQueuedRow(row, deps());

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
    tauriFetch
      .mockResolvedValueOnce(AUTH())
      .mockResolvedValueOnce(intResponse(555))
      .mockResolvedValueOnce(intResponse(999));
    await pushQueuedRow(row, deps());
    expect(calls()).toEqual(["authenticate", "ir.attachment.create", "res.partner.message_post"]);
  });

  it("names the attachment from transcript_start_at and the row id", async () => {
    seedRow();
    const row = (await getQueueRow("row-1"))!;
    tauriFetch
      .mockResolvedValueOnce(AUTH())
      .mockResolvedValueOnce(intResponse(555))
      .mockResolvedValueOnce(intResponse(999));
    await pushQueuedRow(row, deps());
    expect(String(tauriFetch.mock.calls[1][1].body)).toContain("-row-1.md");
  });

  it("persists summary_json before the first write so a retry re-posts the same body", async () => {
    seedRow();
    const row = (await getQueueRow("row-1"))!;
    tauriFetch
      .mockResolvedValueOnce(AUTH())
      .mockResolvedValueOnce(intResponse(555))
      .mockResolvedValueOnce(intResponse(999));
    const d = deps();
    await pushQueuedRow(row, d);
    expect(await getQueueRow("row-1")).toMatchObject({ summary_json: expect.stringContaining("Kickoff") });

    // A second push over the stored summary makes no second AI call.
    //
    // The DB row must be reset, not just the in-memory copy: after the first
    // push it is `sent`, so spreading `status: "pending"` onto a local object
    // only makes the CAS fail and the function return before the summary
    // branch - which would make this assertion pass against an implementation
    // that re-summarizes every time.
    db.run("UPDATE meeting_log_queue SET status='pending', message_id=NULL WHERE id='row-1'");
    const stored = (await getQueueRow("row-1"))!;
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
    tauriFetch
      .mockResolvedValueOnce(AUTH())
      .mockResolvedValueOnce(intResponse(555))
      .mockResolvedValueOnce(intResponse(999));
    const d = deps({
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
    tauriFetch
      .mockResolvedValueOnce(AUTH())
      .mockResolvedValueOnce(intResponse(555))
      .mockResolvedValueOnce(intResponse(999));
    await pushQueuedRow(row, deps());
    expect(calls()).toContain("crm.lead.message_post");
    expect(calls()).not.toContain("res.partner.message_post");
    expect(String(tauriFetch.mock.calls[1][1].body)).toContain("crm.lead"); // res_model
  });

  it("posts to res.partner with contact_id when lead_id is null", async () => {
    const row = seedRow({ lead_id: null, contact_id: 42 });
    tauriFetch
      .mockResolvedValueOnce(AUTH())
      .mockResolvedValueOnce(intResponse(555))
      .mockResolvedValueOnce(intResponse(999));
    await pushQueuedRow(row, deps());
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
    tauriFetch
      .mockResolvedValueOnce(AUTH())
      .mockResolvedValueOnce(arrayResponse([]))
      .mockResolvedValueOnce(intResponse(999));
    await pushQueuedRow(row, deps());
    expect(calls()).not.toContain("ir.attachment.create");
    expect(calls()).toContain("res.partner.message_post");
    expect(await getQueueRow("row-1")).toMatchObject({ status: "sent" });
  });

  it("searches before creating on a retry with no stored attachment id, and adopts a match", async () => {
    // The commit-then-timeout window: Odoo created the attachment and the
    // response never came back, so attachment_id is NULL but the file exists.
    const row = seedRow({ attempts: 1 });
    tauriFetch
      .mockResolvedValueOnce(AUTH())
      .mockResolvedValueOnce(arrayResponse([777]))  // ir.attachment.search
      .mockResolvedValueOnce(arrayResponse([]))     // mail.message.search
      .mockResolvedValueOnce(intResponse(999));
    await pushQueuedRow(row, deps());
    expect(calls()).toContain("ir.attachment.search");
    expect(calls()).not.toContain("ir.attachment.create");
    expect(await getQueueRow("row-1")).toMatchObject({ attachment_id: 777, status: "sent" });
  });

  it("creates when the retry search finds nothing", async () => {
    const row = seedRow({ attempts: 1 });
    tauriFetch
      .mockResolvedValueOnce(AUTH())
      .mockResolvedValueOnce(arrayResponse([]))
      .mockResolvedValueOnce(intResponse(555))
      .mockResolvedValueOnce(arrayResponse([]))   // mail.message.search
      .mockResolvedValueOnce(intResponse(999));
    await pushQueuedRow(row, deps());
    expect(calls()).toContain("ir.attachment.create");
    expect(await getQueueRow("row-1")).toMatchObject({ status: "sent" });
  });

  it("searches mail.message before re-posting and adopts a match, creating no second note", async () => {
    // message_post succeeded on the wire and the status write never landed.
    // Without this the sweep posts a SECOND customer-visible chatter note.
    const row = seedRow({ attachment_id: 555, attempts: 1 });
    tauriFetch.mockResolvedValueOnce(AUTH()).mockResolvedValueOnce(arrayResponse([321]));
    await pushQueuedRow(row, deps());
    expect(calls()).toContain("mail.message.search");
    expect(calls()).not.toContain("res.partner.message_post");
    expect(await getQueueRow("row-1")).toMatchObject({ status: "sent", message_id: 321 });
  });

  it("short-circuits entirely when both ids are already stored", async () => {
    const row = seedRow({ attachment_id: 555, message_id: 999, attempts: 2 });
    await pushQueuedRow(row, deps());
    expect(tauriFetch).not.toHaveBeenCalled();
    expect(await getQueueRow("row-1")).toMatchObject({ status: "sent" });
  });
});

describe("a search that fails never falls through to a write", () => {
  it("keeps the row pending on a transport failure, issuing no create and no post", async () => {
    const row = seedRow({ attempts: 1 });
    tauriFetch.mockResolvedValueOnce(AUTH()).mockRejectedValueOnce(new Error("ECONNREFUSED"));
    await pushQueuedRow(row, deps());
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
    tauriFetch.mockResolvedValueOnce(AUTH()).mockResolvedValueOnce(faultResponse(2, "AccessError"));
    await pushQueuedRow(row, deps());
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
    await pushQueuedRow(row, deps());
    expect(tauriFetch).not.toHaveBeenCalled();
    expect(await getQueueRow("row-1")).toMatchObject({ status: "pending", attempts: 0 });
  });
});

describe("the claim CAS", () => {
  it("does nothing when the row is already terminal and the claim is refused", async () => {
    // claimRow's WHERE clause only matches ('pending','held'), so a row some
    // OTHER attempt already finished - here, 'sent' - must refuse the CAS and
    // pushQueuedRow must return before any wire call. Every other test in this
    // file leaves seedRow's default status: "pending", so the claim always
    // succeeds and this guard was previously unfalsifiable: a mutant that
    // discarded claimRow's return value and pushed unconditionally passed
    // every other case in this file.
    const row = seedRow({ status: "sent", attachment_id: 555, message_id: 999 });
    await pushQueuedRow(row, deps());
    expect(tauriFetch).not.toHaveBeenCalled();
    expect(await getQueueRow("row-1")).toMatchObject({ status: "sent", attempts: 0 });
  });
});

describe("the code table", () => {
  it("keeps the row pending on a 5xx", async () => {
    const row = seedRow();
    tauriFetch.mockResolvedValueOnce(AUTH()).mockResolvedValueOnce(xml("", 503));
    await pushQueuedRow(row, deps());
    expect(await getQueueRow("row-1")).toMatchObject({ status: "pending" });
  });

  it("FAILS the row on a 4xx that is not 408 or 429", async () => {
    // client.ts:58-62 maps EVERY non-2xx to ODOO_UNREACHABLE, so without the
    // status split a proxy 413 on a large attachment retries every launch
    // forever.
    const row = seedRow();
    tauriFetch.mockResolvedValueOnce(AUTH()).mockResolvedValueOnce(xml("", 413));
    await pushQueuedRow(row, deps());
    expect(await getQueueRow("row-1")).toMatchObject({ status: "failed" });
  });

  it("keeps the row pending on a 429", async () => {
    const row = seedRow();
    tauriFetch.mockResolvedValueOnce(AUTH()).mockResolvedValueOnce(xml("", 429));
    await pushQueuedRow(row, deps());
    expect(await getQueueRow("row-1")).toMatchObject({ status: "pending" });
  });

  it("keeps the row pending on ODOO_AUTH_FAILED", async () => {
    const row = seedRow();
    tauriFetch.mockResolvedValueOnce(intResponse(0)); // uid 0 = rejected credentials
    await pushQueuedRow(row, deps());
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
    tauriFetch.mockResolvedValueOnce(AUTH()).mockResolvedValueOnce(faultResponse(2, "no such partner"));
    await pushQueuedRow(row, deps());
    expect(await getQueueRow("row-1")).toMatchObject({ status: "failed", last_error_code: "ODOO_FAULT" });
  });

  it("FAILS the row on an unexpected Odoo return value", async () => {
    // expectInt turns this into ODOO_UNEXPECTED_ROW - an OdooError - which
    // isRetryable's `default` correctly refuses to retry.
    const row = seedRow();
    tauriFetch
      .mockResolvedValueOnce(AUTH())
      .mockResolvedValueOnce(xml("<methodResponse><params><param><value><boolean>0</boolean></value></param></params></methodResponse>"));
    await pushQueuedRow(row, deps());
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
    tauriFetch.mockResolvedValueOnce(AUTH()).mockResolvedValueOnce(arrayResponse([321]));
    failNextWrite.value = "UPDATE meeting_log_queue SET message_id";
    await pushQueuedRow(row, deps());
    expect(await getQueueRow("row-1")).toMatchObject({ status: "pending" });
  });

  it("returns the row to pending when markSent fails on a fully-logged meeting", async () => {
    const row = seedRow({ attachment_id: 555, message_id: 999, attempts: 2 });
    failNextWrite.value = "UPDATE meeting_log_queue\n   SET status = 'sent'";
    await pushQueuedRow(row, deps());
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
    failNextWrite.value = "UPDATE meeting_log_queue\n   SET status = 'sending'";
    await pushQueuedRow(row, deps());
    expect(tauriFetch).not.toHaveBeenCalled();
    expect(await getQueueRow("row-1")).toMatchObject({ status: "pending", attempts: 0 });
  });

  it("does NOT fail a row whose Odoo write already landed but whose DB write did not", async () => {
    // ir.attachment.create SUCCEEDED; setAttachmentId then fails. Failing the
    // row here would leave an orphan attachment on the customer's record with
    // no chatter note, and selectSweepable never picks up `failed` - so nothing
    // recovers it before slice 3. A re-push is provably safe (the name is
    // deterministic and attemptsBefore > 0 forces the adopt-search), so the row
    // must go back to `pending`.
    //
    // `failNextWrite` is the harness hook declared in this file's
    // @/lib/database/config mock (see the beforeEach); it makes the NEXT
    // db.execute reject once, which is how a single-statement SQLITE_BUSY is
    // simulated without a second database.
    const row = seedRow();
    tauriFetch.mockResolvedValueOnce(AUTH()).mockResolvedValueOnce(intResponse(555));
    failNextWrite.value = "UPDATE meeting_log_queue SET attachment_id";
    await pushQueuedRow(row, deps());
    expect(calls()).toContain("ir.attachment.create");
    expect(await getQueueRow("row-1")).toMatchObject({ status: "pending" });
    expect((await getQueueRow("row-1"))?.status).not.toBe("failed");
  });
});

describe("summarization is walled off from the push", () => {
  it("still pushes, with a fallback body, when the summarizer rejects", async () => {
    const row = seedRow();
    tauriFetch
      .mockResolvedValueOnce(AUTH())
      .mockResolvedValueOnce(intResponse(555))
      .mockResolvedValueOnce(intResponse(999));
    await pushQueuedRow(row, deps({ summarize: vi.fn(async () => { throw new Error("429"); }) }));
    expect(String(tauriFetch.mock.calls[2][1].body)).toContain("Summarization failed");
    expect(await getQueueRow("row-1")).toMatchObject({ status: "sent" });
  });

  it("takes the same path when the summarizer returns null", async () => {
    // parseSummarizationResponse NEVER throws - it catches and returns null
    // (meeting-summarizer.ts:239-243). That is the common real failure.
    const row = seedRow();
    tauriFetch
      .mockResolvedValueOnce(AUTH())
      .mockResolvedValueOnce(intResponse(555))
      .mockResolvedValueOnce(intResponse(999));
    await pushQueuedRow(row, deps({ summarize: vi.fn(async () => null) }));
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
    tauriFetch
      .mockResolvedValueOnce(AUTH())
      .mockResolvedValueOnce(intResponse(555))
      .mockResolvedValueOnce(intResponse(999));
    await pushQueuedRow(row, deps({ summarize: vi.fn(async () => null) }));
    const body = String(tauriFetch.mock.calls[2][1].body);
    expect(body).toContain("line-0");
    expect(body).not.toContain("line-11");
  });

  it("takes the same path for a result with an empty summary", async () => {
    const row = seedRow();
    tauriFetch
      .mockResolvedValueOnce(AUTH())
      .mockResolvedValueOnce(intResponse(555))
      .mockResolvedValueOnce(intResponse(999));
    await pushQueuedRow(row, deps({ summarize: vi.fn(async () => summary({ summary: "" })) }));
    expect(String(tauriFetch.mock.calls[2][1].body)).toContain("Summarization failed");
  });

  it("leaves last_error NULL when the summarizer rejects", async () => {
    // The AI try/catch must be SEPARATE from the push's. fetchAIResponse
    // re-wraps every downstream failure as `Error in fetchAIResponse: ...`
    // (ai-response.function.ts:486), and for providers that key the URL that
    // message can carry the AI key - for which the Odoo redactor holds no
    // needle at all.
    const row = seedRow();
    tauriFetch
      .mockResolvedValueOnce(AUTH())
      .mockResolvedValueOnce(intResponse(555))
      .mockResolvedValueOnce(intResponse(999));
    await pushQueuedRow(row, deps({
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
    tauriFetch
      .mockResolvedValueOnce(AUTH())
      .mockRejectedValueOnce(new Error(`socket hang up while sending sk-secret to odoo`));
    await pushQueuedRow(row, deps());
    const stored = await getQueueRow("row-1");
    expect(stored?.last_error).not.toContain("sk-secret");
    expect(stored?.last_error).toContain("socket hang up");
  });
});

describe("the claimed set", () => {
  it("registers the row while pushing and removes it afterwards, even on failure", async () => {
    const row = seedRow();
    let observed = false;
    tauriFetch.mockResolvedValueOnce(AUTH()).mockImplementationOnce(async () => {
      observed = claimed.has("row-1");
      throw new Error("boom");
    });
    await pushQueuedRow(row, deps());
    expect(observed).toBe(true);
    expect(claimed.has("row-1")).toBe(false);
  });
});
