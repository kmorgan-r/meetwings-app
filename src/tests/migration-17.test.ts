// @vitest-environment node
import { describe, expect, it } from "vitest";
import { applyMigration16, rows, seedPre16 } from "./helpers/migration-16";
import { readMigration } from "./helpers/migration-14";

function insertPost16Row(db: Awaited<ReturnType<typeof seedPre16>>, id: string, status: string, seq: number) {
  db.run(
    `INSERT INTO meeting_log_queue
       (id, session_key, conversation_id, instance, contact_id, lead_id,
        transcript, transcript_start_at, transcript_end_at, attachment_id,
        message_id, status, attempts, claimed_at, last_error, last_error_code,
        meeting_started_at, created_at, sent_at)
     VALUES (?, ?, 'c1', 'http://h:8069|odoo', NULL, NULL, 't', 1, 2, NULL,
             NULL, ?, 0, NULL, NULL, NULL, 1, ?, NULL)`,
    [id, `session-${id}`, status, 1_700_000_000_000 + seq]
  );
}

describe("migration 17: notion-sends.sql", () => {
  it("keeps every existing queue row and target, with an empty Notion lane", async () => {
    const db = await seedPre16([]);
    applyMigration16(db);
    insertPost16Row(db, "r-sent", "sent", 1);
    insertPost16Row(db, "r-held", "held", 2);
    db.run(
      `INSERT INTO meeting_log_targets (id, row_id, model, res_id, name, created_at)
       VALUES ('t1', 'r-held', 'res.partner', 7, 'Ann', 1)`
    );
    const sql = "SELECT id,status,transcript FROM meeting_log_queue ORDER BY id";
    const before = rows(db, sql);
    const targetsBefore = rows(db, "SELECT COUNT(*) AS n FROM meeting_log_targets");
    expect(before).toHaveLength(2);

    db.exec(readMigration("notion-sends.sql"));

    expect(rows(db, sql)).toEqual(before);
    for (const r of rows(db, "SELECT notion_status, notion_send_id FROM meeting_log_queue")) {
      expect(r.notion_status).toBeNull();
      expect(r.notion_send_id).toBeNull();
    }
    expect(rows(db, "SELECT COUNT(*) AS n FROM meeting_log_targets")).toEqual(targetsBefore);
  });

  it("creates notion_sends with the documented columns", async () => {
    const db = await seedPre16([]);
    applyMigration16(db);
    db.exec(readMigration("notion-sends.sql"));
    const names = rows(db, "PRAGMA table_info(notion_sends)").map((c) => c.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "id", "status", "summary_json", "page_id", "toggle_block_id",
        "transcript_done", "practices_done", "claimed_at", "next_at",
      ])
    );
  });
});
