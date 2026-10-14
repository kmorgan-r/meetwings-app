import fs from "node:fs";
import path from "node:path";
import initSqlJs, { type Database as SqlJsDatabase } from "sql.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyMigration14, MIGRATIONS, rows } from "./helpers/migration-14";

let db: SqlJsDatabase;

vi.mock("@/lib/database/config", () => ({
  getDatabase: async () => ({
    execute: async (sql: string, params: unknown[] = []) => {
      db.run(sql, params as never[]);
      return { rowsAffected: db.getRowsModified(), lastInsertId: 0 };
    },
    select: async (sql: string, params: unknown[] = []) => {
      const stmt = db.prepare(sql);
      stmt.bind(params as never[]);
      const out: Record<string, unknown>[] = [];
      while (stmt.step()) out.push(stmt.getAsObject());
      stmt.free();
      return out;
    },
  }),
}));

vi.mock("@/lib/storage/odoo-config.storage", () => ({
  requireOdooConfig: async () => ({ url: "http://h:8069", db: "odoo", login: "a", apiKey: "k" }),
  instanceFingerprint: () => "http://h:8069|odoo",
}));

const active = vi.hoisted(() => ({ id: null as string | null, capturing: null as string | null }));
vi.mock("@/lib/storage/active-conversation.storage", () => ({
  getActiveConversationId: () => active.id,
  getCapturingConversationId: () => active.capturing,
}));

import { enqueueConversation } from "@/lib/odoo/meeting-log-actions";

const NOW = 1_700_000_000_000;

function message(over: Record<string, unknown>) {
  const row = {
    id: crypto.randomUUID(), conversation_id: "conv_1", role: "user", content: "hello",
    timestamp: 1000, attached_files: null, speaker: null, audio_source: "microphone",
    ...over,
  };
  db.run(
    `INSERT INTO messages (${Object.keys(row).join(",")}) ` +
      `VALUES (${Object.keys(row).map(() => "?").join(",")})`,
    Object.values(row) as never[]
  );
}

const queue = () => rows(db, "SELECT * FROM meeting_log_queue");

beforeEach(async () => {
  const wasmBinary = fs.readFileSync(
    path.resolve(__dirname, "../../node_modules/sql.js/dist/sql-wasm.wasm")
  );
  db = new (await initSqlJs({ wasmBinary })).Database();
  for (const file of [
    "chat-history.sql", "chat-history-v8.sql", "odoo-contacts.sql",
    "meeting-log-queue.sql", "odoo-lead-only-target.sql",
  ]) {
    db.run(fs.readFileSync(path.join(MIGRATIONS, file), "utf8"));
  }
  await applyMigration14(db);
  for (const id of ["conv_1", "sysaudio_conv_1"]) {
    db.run("INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, 't', 1, 1)", [id]);
  }
  active.id = null;
  active.capturing = null;
});

describe("enqueueConversation", () => {
  it("queues a meeting conversation's spoken lines as an unassigned row", async () => {
    message({ content: "said aloud", timestamp: 2000 });
    message({ content: "answered", timestamp: 3000, audio_source: "system" });
    message({ content: "a typed question", timestamp: 2500, audio_source: null });
    message({ role: "assistant", content: "AI reply", timestamp: 2600, audio_source: null });

    const outcome = await enqueueConversation("conv_1", NOW);

    expect(outcome.kind).toBe("queued");
    const [row] = queue();
    expect(row).toMatchObject({
      id: outcome.kind === "queued" ? outcome.rowIds[0] : "",
      conversation_id: "conv_1",
      instance: "http://h:8069|odoo",
      status: "unassigned",
      transcript: "You: said aloud\nGuest: answered",
      transcript_start_at: 2000,
      transcript_end_at: 3000,
      meeting_started_at: 2000,
      session_key: `manual:conv_1:2000:${NOW}`,
    });
    expect(rows(db, "SELECT * FROM meeting_log_targets")).toEqual([]);
  });

  it("queues each meeting in the conversation as its own row", async () => {
    const MIN = 60_000;
    // A 13-minute silence is still one meeting; 31 minutes starts another.
    message({ content: "first call opens", timestamp: 2000 });
    message({ content: "first call resumes", timestamp: 2000 + 13 * MIN });
    message({ content: "second call", timestamp: 2000 + 44 * MIN });

    const outcome = await enqueueConversation("conv_1", NOW);

    expect(outcome.kind === "queued" && outcome.rowIds).toEqual(
      rows(db, "SELECT id FROM meeting_log_queue ORDER BY transcript_start_at").map((r) => r.id)
    );
    expect(
      rows(db, "SELECT transcript, transcript_start_at, transcript_end_at FROM meeting_log_queue ORDER BY transcript_start_at")
    ).toEqual([
      { transcript: "You: first call opens\nYou: first call resumes", transcript_start_at: 2000, transcript_end_at: 2000 + 13 * MIN },
      { transcript: "You: second call", transcript_start_at: 2000 + 44 * MIN, transcript_end_at: 2000 + 44 * MIN },
    ]);
  });

  it("takes a system-audio capture's user turns, not its AI replies", async () => {
    const base = { conversation_id: "sysaudio_conv_1", audio_source: null };
    message({ ...base, content: "Happy Tuesday", timestamp: 2000 });
    message({ ...base, role: "assistant", content: "Hey Kevin!", timestamp: 2001 });

    expect((await enqueueConversation("sysaudio_conv_1", NOW)).kind).toBe("queued");
    expect(queue()[0].transcript).toBe("Happy Tuesday");
  });

  it("writes nothing for a typed-only chat", async () => {
    message({ content: "a typed question", audio_source: null });

    expect(await enqueueConversation("conv_1", NOW)).toEqual({ kind: "empty" });
    expect(queue()).toEqual([]);
  });

  it("refuses the conversation the overlay still holds", async () => {
    message({ content: "said aloud" });
    active.id = "conv_1";

    expect(await enqueueConversation("conv_1", NOW)).toEqual({ kind: "active" });
    expect(queue()).toEqual([]);
  });

  it("refuses a system-audio capture that is still recording", async () => {
    message({ conversation_id: "sysaudio_conv_1", audio_source: null });
    active.id = "conv_1";
    active.capturing = "sysaudio_conv_1";

    expect(await enqueueConversation("sysaudio_conv_1", NOW)).toEqual({ kind: "active" });
    expect(queue()).toEqual([]);
  });

  it("refuses a conversation a live trigger has queued since the page last loaded", async () => {
    message({ content: "said aloud", timestamp: 2000 });
    await enqueueConversation("conv_1", NOW);
    // Reshape it into the trigger's own row: its key namespace never collides
    // with a manual one, so only a status check can catch it.
    db.run("UPDATE meeting_log_queue SET session_key = 'conv_1:2000', status = 'pending'");

    expect(await enqueueConversation("conv_1", NOW + 1)).toEqual({ kind: "already-queued" });
    expect(queue()).toHaveLength(1);
    // Another conversation's row blocks nothing.
    message({ conversation_id: "sysaudio_conv_1", audio_source: null });
    expect((await enqueueConversation("sysaudio_conv_1", NOW + 2)).kind).toBe("queued");
  });

  it("can send a conversation again after its earlier row was deleted", async () => {
    message({ content: "said aloud" });
    await enqueueConversation("conv_1", NOW);
    db.run("UPDATE meeting_log_queue SET status = 'deleted'");

    expect((await enqueueConversation("conv_1", NOW + 1)).kind).toBe("queued");
    expect(queue()).toHaveLength(2);
  });
});
