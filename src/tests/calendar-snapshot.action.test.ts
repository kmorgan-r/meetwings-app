import fs from "node:fs";
import path from "node:path";
import initSqlJs, { type Database as SqlJsDatabase } from "sql.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CalendarSnapshot } from "@/lib/calendar/calendar-snapshot";
import { readMigration } from "./helpers/migration-14";

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

vi.mock("@/lib/database/config", () => ({
  getDatabase: async () => ({ execute: rawExecute, select: rawSelect }),
}));

import {
  deleteCalendarSnapshot,
  getCalendarSnapshot,
  saveCalendarSnapshot,
} from "@/lib/database/calendar-snapshot.action";
import { deleteAllConversations, deleteConversation } from "@/lib/database/chat-history.action";

const NOW = 1_700_000_000_000;

function snap(key: string): CalendarSnapshot {
  return {
    key,
    subject: "Weekly sync",
    startMs: NOW,
    endMs: NOW + 1_800_000,
    ownAddress: "me@example.com",
    participants: [{ address: "ann@example.com", name: "Ann" }],
  };
}

function addConversation(id: string) {
  db.run("INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, 't', 1, 1)", [id]);
}

beforeEach(async () => {
  const wasmBinary = fs.readFileSync(
    path.resolve(__dirname, "../../node_modules/sql.js/dist/sql-wasm.wasm")
  );
  const SQL = await initSqlJs({ wasmBinary });
  db = new SQL.Database();
  db.run(readMigration("chat-history.sql"));
  db.run(readMigration("chat-history-v8.sql"));
  // calendar-snapshots.sql alters notion_sends; only the table's existence matters here.
  db.run(
    "CREATE TABLE notion_sends (id TEXT PRIMARY KEY, span_start_at INTEGER, span_end_at INTEGER, created_at INTEGER)"
  );
  db.run(readMigration("calendar-snapshots.sql"));
});

afterEach(() => {
  db.close();
});

describe("calendar snapshot storage", () => {
  it("save then get returns the snapshot", async () => {
    await saveCalendarSnapshot("c1", snap("e1"), NOW);
    expect(await getCalendarSnapshot("c1")).toEqual(snap("e1"));
  });

  it("a second save for the same conversation replaces it", async () => {
    await saveCalendarSnapshot("c1", snap("e1"), NOW);
    await saveCalendarSnapshot("c1", snap("e2"), NOW + 1);
    expect((await getCalendarSnapshot("c1"))?.key).toBe("e2");
    expect(await rawSelect("SELECT * FROM calendar_snapshots")).toHaveLength(1);
  });

  it("delete removes it", async () => {
    await saveCalendarSnapshot("c1", snap("e1"), NOW);
    await deleteCalendarSnapshot("c1");
    expect(await getCalendarSnapshot("c1")).toBeNull();
  });

  it("a saved snapshot is read back by a fresh module instance", async () => {
    await saveCalendarSnapshot("c1", snap("e1"), NOW);
    vi.resetModules();
    const fresh = await import("@/lib/database/calendar-snapshot.action");
    expect(await fresh.getCalendarSnapshot("c1")).toEqual(snap("e1"));
  });

  it("deleteConversation removes the conversation's snapshot and no other", async () => {
    addConversation("c1");
    addConversation("c2");
    await saveCalendarSnapshot("c1", snap("e1"), NOW);
    await saveCalendarSnapshot("c2", snap("e2"), NOW);
    expect(await deleteConversation("c1")).toBe(true);
    expect(await getCalendarSnapshot("c1")).toBeNull();
    expect(await getCalendarSnapshot("c2")).toEqual(snap("e2"));
  });

  it("deleteAllConversations removes every snapshot", async () => {
    addConversation("c1");
    await saveCalendarSnapshot("c1", snap("e1"), NOW);
    await saveCalendarSnapshot("c2", snap("e2"), NOW);
    await deleteAllConversations();
    expect(await rawSelect("SELECT * FROM calendar_snapshots")).toHaveLength(0);
  });

  it("a corrupt row reads as null", async () => {
    db.run("INSERT INTO calendar_snapshots VALUES ('c1', '{not json', 1)");
    expect(await getCalendarSnapshot("c1")).toBeNull();
  });
});
