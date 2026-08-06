import { beforeEach, describe, expect, it, vi } from "vitest";

const mockExecute = vi.fn();
const mockSelect = vi.fn();

vi.mock("@/lib/database/config", () => ({
  getDatabase: vi.fn(async () => ({ execute: mockExecute, select: mockSelect })),
}));

vi.mock("@/lib/functions/context-builder", () => ({
  invalidateContextCache: vi.fn(),
}));

import {
  createMeetingSummary,
  getAllMeetingSummaries,
} from "@/lib/database/meeting-context.action";

/** 2026-01-29 07:18 — a meeting from months before it was ever summarized. */
const MEETING_START = 1769671080000;
const MEETING_END = MEETING_START + 21 * 60 * 1000;

/** Answers the "when did this meeting happen" probe with a real window. */
function respondWithMeetingWindow() {
  mockSelect.mockImplementation(async (sql: string) =>
    String(sql).includes("MIN(timestamp)")
      ? [{ started_at: MEETING_START, ended_at: MEETING_END }]
      : []
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockExecute.mockResolvedValue({ rowsAffected: 1, lastInsertId: 0 });
  mockSelect.mockResolvedValue([]);
});

describe("meeting summary timing", () => {
  it("records when the meeting happened, not when the summary was written", async () => {
    respondWithMeetingWindow();

    const summary = await createMeetingSummary({
      conversationId: "conv-old",
      summary: "Partnership exploration call",
    });

    // createdAt is the row's write time and stays that way — compaction's
    // watermark is keyed on it. The meeting window is what the UI dates by.
    expect(summary.meetingStartedAt).toBe(MEETING_START);
    expect(summary.meetingEndedAt).toBe(MEETING_END);
    expect(summary.createdAt).not.toBe(MEETING_START);
  });

  it("persists the meeting window so a reload still dates it correctly", async () => {
    respondWithMeetingWindow();

    await createMeetingSummary({
      conversationId: "conv-old",
      summary: "Partnership exploration call",
    });

    const insert = mockExecute.mock.calls.find(([sql]) =>
      String(sql).includes("INSERT INTO meeting_summaries")
    );
    expect(insert).toBeDefined();
    const [sql, params] = insert!;

    expect(sql).toMatch(/meeting_started_at/);
    expect(sql).toMatch(/meeting_ended_at/);
    expect(params).toContain(MEETING_START);
    expect(params).toContain(MEETING_END);
  });

  it("derives the duration from the meeting window", async () => {
    respondWithMeetingWindow();

    const summary = await createMeetingSummary({
      conversationId: "conv-old",
      summary: "Partnership exploration call",
    });

    expect(summary.durationSeconds).toBe(21 * 60);
  });

  it("leaves the window empty when the conversation has no messages", async () => {
    mockSelect.mockResolvedValue([{ started_at: null, ended_at: null }]);

    const summary = await createMeetingSummary({
      conversationId: "conv-empty",
      summary: "Nothing to see",
    });

    expect(summary.meetingStartedAt).toBeNull();
    expect(summary.meetingEndedAt).toBeNull();
    expect(summary.durationSeconds).toBeNull();
  });

  it("orders the list by when meetings happened, not by write order", async () => {
    await getAllMeetingSummaries();

    const [sql] = mockSelect.mock.calls[0];
    // Backfilled summaries all share one write timestamp, so ordering by
    // created_at scrambles the list chronologically.
    expect(String(sql)).toMatch(
      /ORDER BY\s+COALESCE\(meeting_started_at,\s*created_at\)\s+DESC/i
    );
  });

  it("reads rows written before the meeting window columns existed", async () => {
    mockSelect.mockResolvedValue([
      {
        id: "sum-old",
        conversation_id: "conv-old",
        summary: "from before the migration",
        title: null,
        topics: null,
        goals: null,
        action_items: null,
        next_steps: null,
        decisions: null,
        team_updates: null,
        participants: null,
        exchange_count: 3,
        duration_seconds: null,
        meeting_started_at: null,
        meeting_ended_at: null,
        created_at: 111,
        updated_at: 111,
      },
    ]);

    const [summary] = await getAllMeetingSummaries();

    expect(summary.summary).toBe("from before the migration");
    expect(summary.meetingStartedAt).toBeNull();
    expect(summary.meetingEndedAt).toBeNull();
  });
});
