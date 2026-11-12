// @vitest-environment node
import { describe, expect, it } from "vitest";
import { applyMigration16, rows, seedPre16 } from "./helpers/migration-16";
import { readMigration } from "./helpers/migration-14";

describe("migration 18: calendar-snapshots.sql", () => {
  it("keeps every notion_sends row and adds calendar_json as NULL", async () => {
    const db = await seedPre16([]);
    applyMigration16(db);
    db.exec(readMigration("notion-sends.sql"));
    db.run(
      `INSERT INTO notion_sends (id, status, span_start_at, span_end_at, created_at)
       VALUES ('s1', 'sent', 1, 2, 3), ('s2', 'retry', 4, 5, 6)`
    );
    const sql = "SELECT id, span_start_at, span_end_at, created_at FROM notion_sends ORDER BY id";
    const before = rows(db, sql);
    expect(before).toHaveLength(2);

    db.exec(readMigration("calendar-snapshots.sql"));

    expect(rows(db, sql)).toEqual(before);
    for (const r of rows(db, "SELECT calendar_json FROM notion_sends")) {
      expect(r.calendar_json).toBeNull();
    }
  });

  it("creates calendar_snapshots with conversation_id, snapshot_json and updated_at", async () => {
    const db = await seedPre16([]);
    applyMigration16(db);
    db.exec(readMigration("notion-sends.sql"));
    db.exec(readMigration("calendar-snapshots.sql"));
    const names = rows(db, "PRAGMA table_info(calendar_snapshots)").map((c) => c.name);
    expect(names).toEqual(["conversation_id", "snapshot_json", "updated_at"]);
  });
});
