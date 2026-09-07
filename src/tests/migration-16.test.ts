import { describe, expect, it } from "vitest";
import { applyMigration16, INSTANCE, rows, seedPre16, seedPre16WithExistingSummary } from "./helpers/migration-16";

describe("migration 16 backfill", () => {
  it("backfills a queue row with a cached summary into meeting_summaries", async () => {
    const summaryJson = JSON.stringify({
      title: "Q3 renewal", summary: "Discussed renewal terms.",
      topics: ["renewal"], goals: [], actionItems: ["send contract"],
      nextSteps: [], decisions: [], teamUpdates: [], participants: ["Ada"],
    });
    const db = await seedPre16([
      { id: "r1", conversationId: "conv-1", summaryJson },
    ]);
    applyMigration16(db);

    const backfilled = rows(db, "SELECT * FROM meeting_summaries WHERE conversation_id = 'conv-1'");
    expect(backfilled).toHaveLength(1);
    expect(backfilled[0]).toMatchObject({
      title: "Q3 renewal",
      summary: "Discussed renewal terms.",
      exchange_count: 0,
    });

    const cols = rows(db, "PRAGMA table_info(meeting_log_queue)").map((c) => c.name);
    expect(cols).not.toContain("summary_json");
  });

  it("skips a row whose conversation_id is NULL", async () => {
    const db = await seedPre16([
      { id: "r1", conversationId: null, summaryJson: JSON.stringify({ summary: "orphan" }) },
    ]);
    applyMigration16(db);
    expect(rows(db, "SELECT * FROM meeting_summaries")).toHaveLength(0);
  });

  it("does not double-insert when a meeting_summaries row already exists for the conversation", async () => {
    const db = await seedPre16WithExistingSummary("conv-1", "Already Named");
    db.run(
      `INSERT INTO meeting_log_queue
         (id, session_key, conversation_id, instance, transcript, transcript_start_at,
          transcript_end_at, summary_json, status, attempts, meeting_started_at, created_at)
       VALUES ('r1', 's1', 'conv-1', 'http://h:8069|odoo', 't', 1, 2,
               ?, 'sent', 1, 1, 1700000000001)`,
      [JSON.stringify({ title: "New Title", summary: "new" })]
    );
    applyMigration16(db);
    const summaries = rows(db, "SELECT * FROM meeting_summaries WHERE conversation_id = 'conv-1'");
    expect(summaries).toHaveLength(1);
    expect(summaries[0].title).toBe("Already Named"); // untouched, not overwritten
  });

  it("keeps only the newest row when two queue rows share one conversation_id, DIFFERENT created_at", async () => {
    const db = await seedPre16([
      { id: "older", conversationId: "conv-1", summaryJson: JSON.stringify({ title: "Older", summary: "a" }), createdAt: 100 },
      { id: "newer", conversationId: "conv-1", summaryJson: JSON.stringify({ title: "Newer", summary: "b" }), createdAt: 200 },
    ]);
    applyMigration16(db);
    const summaries = rows(db, "SELECT * FROM meeting_summaries WHERE conversation_id = 'conv-1'");
    expect(summaries).toHaveLength(1);
    expect(summaries[0].title).toBe("Newer");
  });

  it("keeps exactly one row when two queue rows share one conversation_id AND an IDENTICAL created_at", async () => {
    const db = await seedPre16([
      { id: "a", conversationId: "conv-1", summaryJson: JSON.stringify({ title: "A", summary: "a" }), createdAt: 100 },
      { id: "b", conversationId: "conv-1", summaryJson: JSON.stringify({ title: "B", summary: "b" }), createdAt: 100 },
    ]);
    applyMigration16(db);
    // The point of this test is NOT which of the two wins (the rowid
    // tiebreak makes that deterministic but arbitrary) - it's that the
    // UNIQUE constraint on meeting_summaries.conversation_id does not abort
    // the migration.
    expect(rows(db, "SELECT * FROM meeting_summaries WHERE conversation_id = 'conv-1'")).toHaveLength(1);
  });

  it("backfills the meeting window from the queue row, not NULL", async () => {
    const db = await seedPre16([
      { id: "r1", conversationId: "conv-1", summaryJson: JSON.stringify({ summary: "s" }) },
    ]);
    applyMigration16(db);
    const [row] = rows(db, "SELECT meeting_started_at, meeting_ended_at FROM meeting_summaries WHERE conversation_id = 'conv-1'");
    expect(row.meeting_started_at).toBe(1);
    expect(row.meeting_ended_at).toBe(2);
  });

  it("a queue row with malformed JSON does not abort the migration, and is not backfilled", async () => {
    const db = await seedPre16([
      { id: "bad", conversationId: "conv-bad", summaryJson: "not json at all" },
      { id: "good", conversationId: "conv-good", summaryJson: JSON.stringify({ summary: "s" }) },
    ]);
    expect(() => applyMigration16(db)).not.toThrow();
    expect(rows(db, "SELECT * FROM meeting_summaries WHERE conversation_id = 'conv-bad'")).toHaveLength(0);
    expect(rows(db, "SELECT * FROM meeting_summaries WHERE conversation_id = 'conv-good'")).toHaveLength(1);
  });

  it("a queue row with valid JSON but no summary key does not abort the migration, and is not backfilled", async () => {
    const db = await seedPre16([
      { id: "nosum", conversationId: "conv-nosum", summaryJson: JSON.stringify({ title: "Has title, no summary" }) },
    ]);
    expect(() => applyMigration16(db)).not.toThrow();
    expect(rows(db, "SELECT * FROM meeting_summaries WHERE conversation_id = 'conv-nosum'")).toHaveLength(0);

    const cols = rows(db, "PRAGMA table_info(meeting_log_queue)").map((c) => c.name);
    expect(cols).not.toContain("summary_json");
  });

  it("listActionable's own SQL still runs after the column is dropped", async () => {
    // Imports the REAL QUEUE_SQL.listActionable string rather than a
    // hand-copied one, so a future SELECT/ORDER BY change can never drift out
    // of sync with what this test exercises. meeting-log.action.ts's only
    // load-time import chain (./config -> @tauri-apps/plugin-sql) has no
    // side effects at module scope - Database.load() only runs inside
    // getDatabase(), which this test never calls - so a plain static import
    // of QUEUE_SQL is safe under vitest's node environment, unmocked.
    const { QUEUE_SQL } = await import("@/lib/database/meeting-log.action");
    const db = await seedPre16([
      { id: "r1", conversationId: "conv-1", summaryJson: JSON.stringify({ summary: "s" }) },
    ]);
    applyMigration16(db);
    expect(() => {
      const stmt = db.prepare(QUEUE_SQL.listActionable);
      stmt.bind([INSTANCE, 3]); // ?1 = instance (matches every seeded row), ?2 = attempts threshold
      while (stmt.step()) stmt.getAsObject();
      stmt.free();
    }).not.toThrow();
  });
});
