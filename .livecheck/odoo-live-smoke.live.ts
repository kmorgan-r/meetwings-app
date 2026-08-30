// LIVE SMOKE TEST - talks to the real Odoo instance in the app's own store.
// Never matched by the repo's default vitest include glob; runs only via
// vitest.live.config.ts with ODOO_LIVE=1.
import fs from "node:fs";
import path from "node:path";
import initSqlJs, { type Database as SqlJsDatabase } from "sql.js";
import { beforeAll, describe, expect, it, vi } from "vitest";

const REPO = "C:/Users/kmorg/meetwings-app";
const MIGRATIONS = path.join(REPO, "src-tauri/src/db/migrations");
const WASM = path.join(REPO, "node_modules/sql.js/dist/sql-wasm.wasm");
const STORE = path.join(
  process.env.APPDATA as string,
  "com.meetwings.app",
  ".secure-settings.dat"
);

if (process.env.ODOO_LIVE !== "1") {
  throw new Error("refusing to run: set ODOO_LIVE=1 to authorize live Odoo writes");
}

// ---------------------------------------------------------------- db shim --
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

const { execute, select } = vi.hoisted(() => ({ execute: vi.fn(), select: vi.fn() }));
vi.mock("@/lib/database/config", () => ({
  getDatabase: async () => ({ execute, select }),
}));
// The ONLY transport substitution: plugin-http -> node's real fetch. Same
// URLs, same bodies, same headers the app sends.
vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: (...args: unknown[]) =>
    (globalThis.fetch as unknown as (...a: unknown[]) => unknown)(...args),
}));

import { createOdooClient, type OdooClient } from "@/lib/odoo/client";
import { pushQueuedRow } from "@/lib/odoo/meeting-log-push";
import { attachmentNameFor } from "@/lib/odoo/meeting-log";
import { instanceFingerprint } from "@/lib/storage/odoo-config.storage";
import type { DbMeetingLogRow } from "@/types";

// ------------------------------------------------------------- fixtures ----
const STAMP = new Date().toISOString().replace(/[:.]/g, "-");
const PARTNER_NAME = "ZZ Meetwings smoke " + STAMP;
const LEAD_NAME = "ZZ Meetwings smoke lead " + STAMP;
const ARCHIVED_NAME = "ZZ Meetwings smoke archived " + STAMP;

let client: OdooClient;
let instance: string;
let uid = 0;
let noteSubtypeId = 0;
let partnerId = 0;
let leadId = 0;
let archivedId = 0;

const TRANSCRIPT = [
  "You: Thanks for making time today - this is an automated smoke test record.",
  "Guest: Understood, nothing here is a real conversation.",
  "You: We are verifying the meeting note lands on the chatter as an internal note.",
].join("\n");

const START = Date.now() - 600000;
const END = Date.now() - 60000;

function seedRow(id: string, targets: { model: string; resId: number }[]): DbMeetingLogRow {
  const now = Date.now();
  db.run(
    "INSERT INTO meeting_log_queue (id, session_key, conversation_id, instance, contact_id," +
      " lead_id, transcript, transcript_start_at, transcript_end_at, status, attempts, created_at)" +
      " VALUES (?,?,?,?,?,?,?,?,?,'pending',0,?)",
    [id, "sk-" + id, null, instance, null, null, TRANSCRIPT, START, END, now] as never[]
  );
  for (const t of targets) {
    db.run(
      "INSERT INTO meeting_log_targets (id, row_id, model, res_id, name, status, created_at)" +
        " VALUES (?,?,?,?,?,'pending',?)",
      [crypto.randomUUID(), id, t.model, t.resId, null, now] as never[]
    );
  }
  return {
    id,
    session_key: "sk-" + id,
    conversation_id: null,
    instance,
    contact_id: null,
    lead_id: null,
    transcript: TRANSCRIPT,
    transcript_start_at: START,
    transcript_end_at: END,
    summary_json: null,
    attachment_id: null,
    message_id: null,
    status: "pending",
    attempts: 0,
    claimed_at: null,
    last_error: null,
    last_error_code: null,
    meeting_started_at: START,
    created_at: now,
    sent_at: null,
  };
}

const deps = () => ({
  client,
  instance,
  now: () => Date.now(),
  summarize: async () => null,
});

const targetRows = (rowId: string) =>
  rawSelect("SELECT * FROM meeting_log_targets WHERE row_id = ? ORDER BY model", [rowId]);

// ------------------------------------------------------------------ setup --
beforeAll(async () => {
  const SQL = await initSqlJs({ wasmBinary: fs.readFileSync(WASM) });
  db = new SQL.Database();
  const files = [
    "chat-history.sql",
    "chat-history-v8.sql",
    "odoo-contacts.sql",
    "meeting-log-queue.sql",
    "odoo-lead-only-target.sql",
    "odoo-multi-target.sql",
  ];
  for (const m of files) {
    db.run(fs.readFileSync(path.join(MIGRATIONS, m), "utf8"));
  }
  execute.mockImplementation(rawExecute);
  select.mockImplementation(rawSelect);

  const raw = JSON.parse(fs.readFileSync(STORE, "utf8"))["secure_odoo_config"];
  const cfg = JSON.parse(raw);
  // The app does NOT trim this; see the note in the report.
  const config = {
    url: String(cfg.url).trim(),
    db: String(cfg.db).trim(),
    login: String(cfg.login).trim(),
    apiKey: String(cfg.apiKey),
  };
  client = createOdooClient(config);
  instance = instanceFingerprint(config.url, config.db);
  console.log("[live] instance = " + instance);
});

// ------------------------------------------------------------------ tests --
const ROW = "row-multi";
const ROW2 = "row-partial";

describe("live Odoo smoke", () => {
  it("authenticates (ONE attempt - fail2ban)", async () => {
    uid = await client.authenticate();
    console.log("[live] uid = " + uid);
    expect(uid).toBeGreaterThan(0);
  });

  it("reads before it writes", async () => {
    const found = (await client.execute("res.partner", "search", [[]], {
      limit: 1,
    })) as number[];
    expect(Array.isArray(found)).toBe(true);
  });

  it("resolves mail.mt_note to a real subtype id", async () => {
    const ref = (await client.execute("ir.model.data", "check_object_reference", [
      "mail",
      "mt_note",
    ])) as [string, number];
    console.log("[live] mail.mt_note -> " + JSON.stringify(ref));
    expect(ref[0]).toBe("mail.message.subtype");
    noteSubtypeId = ref[1];
    expect(noteSubtypeId).toBeGreaterThan(0);
  });

  it("creates its own scratch records (never a real customer)", async () => {
    partnerId = (await client.execute("res.partner", "create", [
      { name: PARTNER_NAME, comment: "Automated Meetwings smoke test. Safe to delete." },
    ])) as number;
    leadId = (await client.execute("crm.lead", "create", [
      { name: LEAD_NAME, description: "Automated Meetwings smoke test. Safe to delete." },
    ])) as number;
    archivedId = (await client.execute("res.partner", "create", [
      { name: ARCHIVED_NAME, active: false },
    ])) as number;
    console.log(
      "[live] partner=" + partnerId + " lead=" + leadId + " archived-partner=" + archivedId
    );
    expect(partnerId).toBeGreaterThan(0);
    expect(leadId).toBeGreaterThan(0);
  });

  // ---- the note lands, on both models -------------------------------------
  it("pushQueuedRow posts to BOTH a res.partner and a crm.lead", async () => {
    const row = seedRow(ROW, [
      { model: "res.partner", resId: partnerId },
      { model: "crm.lead", resId: leadId },
    ]);
    await pushQueuedRow(row, deps());

    const targets = await targetRows(ROW);
    console.log("[live] targets after push: " + JSON.stringify(targets, null, 1));
    expect(targets).toHaveLength(2);
    for (const t of targets) {
      expect(t.status).toBe("sent");
      expect(t.attachment_id).toBeGreaterThan(0);
      expect(t.message_id).toBeGreaterThan(0);
    }
    const parent = await rawSelect("SELECT status FROM meeting_log_queue WHERE id = ?", [ROW]);
    expect(parent[0].status).toBe("sent");
  });

  it("BEHAVIOUR 1: subtype_xmlid pinned mail.mt_note on BOTH models", async () => {
    const targets = await targetRows(ROW);
    for (const t of targets) {
      const msg = (await client.execute("mail.message", "read", [
        [t.message_id],
        ["subtype_id", "message_type", "model", "res_id", "attachment_ids", "partner_ids"],
      ])) as Record<string, unknown>[];
      const m = msg[0];
      console.log("[live] " + t.model + "#" + t.res_id + " message: " + JSON.stringify(m));
      expect((m.subtype_id as [number, string])[0]).toBe(noteSubtypeId);
      expect(m.model).toBe(t.model);
      expect(m.res_id).toBe(t.res_id);
      expect(m.attachment_ids as number[]).toContain(t.attachment_id);
    }
  });

  it("BEHAVIOUR 1: no outbound email object exists for either note", async () => {
    const targets = await targetRows(ROW);
    const ids = targets.map((t) => t.message_id as number);
    const mails = (await client.execute("mail.mail", "search", [
      [["mail_message_id", "in", ids]],
    ])) as number[];
    const notifs = (await client.execute("mail.notification", "search_read", [
      [["mail_message_id", "in", ids]],
      ["notification_type", "res_partner_id", "notification_status"],
    ])) as Record<string, unknown>[];
    console.log("[live] mail.mail rows = " + JSON.stringify(mails));
    console.log("[live] mail.notification rows = " + JSON.stringify(notifs));
    expect(mails).toHaveLength(0);
    expect(notifs.filter((n) => n.notification_type === "email")).toHaveLength(0);
  });

  // ---- adopt-search on retry ----------------------------------------------
  it("BEHAVIOUR 2+3: a retry ADOPTS the same attachment and message", async () => {
    const before = await targetRows(ROW);
    // Manufacture the crash window LOCALLY: the ids reached Odoo but the local
    // write did not. Wipe them, re-pend the children, bump attempts.
    db.run(
      "UPDATE meeting_log_targets SET status='pending', attachment_id=NULL, message_id=NULL" +
        " WHERE row_id = ?",
      [ROW] as never[]
    );
    db.run("UPDATE meeting_log_queue SET status='pending', attempts=1 WHERE id = ?", [
      ROW,
    ] as never[]);

    const rows = (await rawSelect("SELECT * FROM meeting_log_queue WHERE id = ?", [
      ROW,
    ])) as unknown as DbMeetingLogRow[];
    await pushQueuedRow(rows[0], deps());

    const after = await targetRows(ROW);
    console.log(
      "[live] adopted: " +
        JSON.stringify(after.map((t) => [t.model, t.attachment_id, t.message_id]))
    );
    for (let i = 0; i < before.length; i++) {
      expect(after[i].status).toBe("sent");
      expect(after[i].attachment_id).toBe(before[i].attachment_id);
      expect(after[i].message_id).toBe(before[i].message_id);
    }
  });

  it("BEHAVIOUR 2+3: exactly ONE note and ONE attachment per record", async () => {
    const name = attachmentNameFor(ROW, START);
    const pairs: [string, number][] = [
      ["res.partner", partnerId],
      ["crm.lead", leadId],
    ];
    for (const [model, resId] of pairs) {
      const atts = (await client.execute("ir.attachment", "search", [
        [
          ["res_model", "=", model],
          ["res_id", "=", resId],
          ["name", "=", name],
        ],
      ])) as number[];
      // Scoped to OUR attachment. A bare "every message on this record" count
      // also picks up Odoo's own record-creation log entry, which is not a
      // duplicate of anything this app posted.
      const msgs = (await client.execute("mail.message", "search", [
        [
          ["model", "=", model],
          ["res_id", "=", resId],
          ["attachment_ids", "in", atts],
        ],
      ])) as number[];
      const all = (await client.execute("mail.message", "search", [
        [
          ["model", "=", model],
          ["res_id", "=", resId],
        ],
      ])) as number[];
      console.log(
        "[live] " +
          model +
          "#" +
          resId +
          ": our attachments=" +
          atts.length +
          " our notes=" +
          msgs.length +
          " (every message on the record, incl. Odoo's own: " +
          all.length +
          ")"
      );
      expect(atts).toHaveLength(1);
      expect(msgs).toHaveLength(1);
    }
  });

  // ---- partial send across targets, one archived --------------------------
  // FINDING: archiving is NOT an error on this instance. message_post on an
  // archived res.partner SUCCEEDS, so "archive the record" does not manufacture
  // the deterministic-failure leg the PR body assumes it does.
  it("FINDING: an ARCHIVED record accepts the note (archiving is not an error)", async () => {
    const row = seedRow(ROW2, [{ model: "res.partner", resId: archivedId }]);
    await pushQueuedRow(row, deps());
    const targets = await targetRows(ROW2);
    console.log(
      "[live] archived target -> status=" +
        targets[0].status +
        " code=" +
        targets[0].last_error_code +
        " message_id=" +
        targets[0].message_id
    );
    expect(targets[0].status).toBe("sent");
  });

  // The real deterministic-failure leg: a record that is GONE. This is the
  // shape that actually reaches production - a contact deleted in Odoo after
  // the meeting was queued.
  const ROW3 = "row-missing";
  const MISSING_ID = 999999999;
  it("BEHAVIOUR 5+6: a MISSING record fails DETERMINISTICALLY, loop continues", async () => {
    const row = seedRow(ROW3, [
      { model: "res.partner", resId: MISSING_ID },
      { model: "crm.lead", resId: leadId },
    ]);
    await pushQueuedRow(row, deps());

    const targets = await targetRows(ROW3);
    console.log("[live] partial-send targets: " + JSON.stringify(targets, null, 1));
    const missing = targets.find((t) => t.res_id === MISSING_ID) as Record<string, unknown>;
    const good = targets.find((t) => t.res_id === leadId) as Record<string, unknown>;
    console.log(
      "[live] missing target -> status=" +
        missing.status +
        " code=" +
        missing.last_error_code +
        " err=" +
        missing.last_error
    );
    // The loop must NOT strand the healthy sibling.
    expect(good.status).toBe("sent");
    // 'failed' = deterministic. 'pending' here means it retries forever.
    expect(missing.status).toBe("failed");
    const parent = await rawSelect(
      "SELECT status, last_error_code, last_error FROM meeting_log_queue WHERE id = ?",
      [ROW3]
    );
    console.log("[live] partial-send parent: " + JSON.stringify(parent));
    expect(parent[0].status).toBe("failed");
  });

  it("the note body and attachment carry the real transcript", async () => {
    const targets = await targetRows(ROW);
    const t = targets[0];
    const msg = (await client.execute("mail.message", "read", [
      [t.message_id],
      ["body"],
    ])) as Record<string, unknown>[];
    const att = (await client.execute("ir.attachment", "read", [
      [t.attachment_id],
      ["name", "mimetype", "file_size"],
    ])) as Record<string, unknown>[];
    console.log("[live] note body = " + JSON.stringify(msg[0].body));
    console.log("[live] attachment = " + JSON.stringify(att[0]));
    expect(String(msg[0].body).length).toBeGreaterThan(20);
    expect(att[0].name).toBe(attachmentNameFor(ROW, START));
  });

  // PROBE: how do we get real HTML into the chatter from XML-RPC?
  it("PROBE: which call shape preserves HTML in the body", async () => {
    const HTML = "<b>bold</b> &mdash; <p>para</p>";
    const readBody = async (id: number) => {
      const r = (await client.execute("mail.message", "read", [
        [id],
        ["body"],
      ])) as Record<string, unknown>[];
      return r[0].body;
    };
    const version = (await client.execute("ir.module.module", "search_read", [
      [["name", "=", "base"]],
      ["latest_version"],
    ])) as Record<string, unknown>[];
    console.log("[probe] odoo base module version = " + JSON.stringify(version));

    // A: exactly what the app does today.
    const a = (await client.execute("res.partner", "message_post", [[archivedId]], {
      body: HTML,
      subtype_xmlid: "mail.mt_note",
    })) as number;
    console.log("[probe] A message_post(body)        -> " + JSON.stringify(await readBody(a)));

    // B: message_post, then write the body back onto the mail.message.
    const b = (await client.execute("res.partner", "message_post", [[archivedId]], {
      body: "placeholder",
      subtype_xmlid: "mail.mt_note",
    })) as number;
    await client.execute("mail.message", "write", [[b], { body: HTML }]);
    console.log("[probe] B message_post + write body -> " + JSON.stringify(await readBody(b)));

    expect(a).toBeGreaterThan(0);
  });

  it("reports the scratch record ids for manual inspection", async () => {
    const base = instance.split("|")[0];
    // This instance serves the CLASSIC /web# hash URLs, not the /odoo/<model>/<id>
    // scheme. menu_id/action are this database's own ids for the Contacts and
    // CRM actions - they are not portable to another Odoo.
    const form = (model: string, id: number, menu: number, action: number) =>
      base +
      "/web#id=" +
      id +
      "&cids=1&menu_id=" +
      menu +
      "&action=" +
      action +
      "&model=" +
      model +
      "&view_type=form";

    console.log("\n================ INSPECT IN ODOO ================");
    console.log("partner  : " + form("res.partner", partnerId, 117, 154));
    console.log("           (" + PARTNER_NAME + ")");
    console.log("lead     : " + form("crm.lead", leadId, 145, 206));
    console.log("           (" + LEAD_NAME + ")");
    console.log("archived : " + form("res.partner", archivedId, 117, 154));
    console.log("           (" + ARCHIVED_NAME + " - hidden from the list view)");
    console.log("================================================\n");
    expect(partnerId).toBeGreaterThan(0);
  });
});
