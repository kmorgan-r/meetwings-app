import fs from "node:fs";
import path from "node:path";
import initSqlJs, { type Database as SqlJsDatabase } from "sql.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readMigration } from "./helpers/migration-14";

let db: SqlJsDatabase;
/** Every row the "database" handed back - what crosses the Tauri bridge. */
let returned: Record<string, unknown>[];

async function rawSelect(sql: string, params?: unknown[]) {
  const stmt = db.prepare(sql);
  stmt.bind((params ?? []) as never[]);
  const out: Record<string, unknown>[] = [];
  while (stmt.step()) out.push(stmt.getAsObject());
  stmt.free();
  returned.push(...out);
  return out;
}

vi.mock("@/lib/database/config", () => ({
  getDatabase: async () => ({ execute: vi.fn(), select: rawSelect }),
}));

import { listConversations } from "@/lib/database/chat-history.action";

function addConversation(id: string, updatedAt: number) {
  db.run(
    "INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
    [id, `Title ${id}`, updatedAt - 1, updatedAt]
  );
}

/** Stamped at the conversation's own updated_at: chat-history.sql's insert
 * trigger copies each message timestamp onto its conversation. */
function addMessage(conversationId: string, n: number) {
  db.run(
    `INSERT INTO messages (id, conversation_id, role, content, timestamp, attached_files)
     SELECT ?, id, 'user', ?, updated_at, ? FROM conversations WHERE id = ?`,
    [`${conversationId}-m${n}`, "x".repeat(1000), JSON.stringify([{ base64: "y".repeat(1000) }]), conversationId]
  );
}

beforeEach(async () => {
  const wasmBinary = fs.readFileSync(
    path.resolve(__dirname, "../../node_modules/sql.js/dist/sql-wasm.wasm")
  );
  const SQL = await initSqlJs({ wasmBinary });
  db = new SQL.Database();
  db.run(readMigration("chat-history.sql"));
  db.run(readMigration("chat-history-v8.sql"));
  db.run(readMigration("conversation-title-source.sql"));
  returned = [];
});

afterEach(() => {
  db.close();
});

describe("listConversations", () => {
  it("returns each conversation with its message count, newest first", async () => {
    addConversation("old", 1_000);
    addConversation("new", 2_000);
    for (let n = 0; n < 3; n++) addMessage("new", n);

    expect(await listConversations()).toEqual([
      { id: "new", title: "Title new", createdAt: 1_999, updatedAt: 2_000, messageCount: 3 },
      { id: "old", title: "Title old", createdAt: 999, updatedAt: 1_000, messageCount: 0 },
    ]);
  });

  // The leak: the dashboard list used to pull every message ever saved,
  // attachments included, and hold it while the window sat hidden.
  it("never reads a message row across the bridge", async () => {
    addConversation("c1", 1_000);
    addConversation("c2", 2_000);
    for (let n = 0; n < 50; n++) addMessage("c1", n);

    await listConversations();

    expect(returned).toHaveLength(2);
    for (const row of returned) {
      expect(row).not.toHaveProperty("content");
      expect(row).not.toHaveProperty("attached_files");
    }
  });
});
