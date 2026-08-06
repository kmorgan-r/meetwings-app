import { describe, expect, it, vi } from "vitest";
import type { MeetingSummary } from "@/types";

vi.mock("@/lib/database", () => ({
  getKnowledgeProfile: vi.fn(),
  updateKnowledgeProfile: vi.fn(),
  getOldestUncompactedSummaries: vi.fn(),
  getUncompactedSummaryCount: vi.fn(),
  getUnsummarizedConversations: vi.fn(),
}));

vi.mock("@/lib/functions/ai-response.function", () => ({
  fetchAIResponse: vi.fn(),
}));

vi.mock("@/lib/functions/meetwings.api", () => ({
  shouldUseMeetwingsAPI: vi.fn(async () => false),
}));

vi.mock("@/lib/storage", () => ({
  getUserIdentity: vi.fn(() => null),
  hasUserIdentity: vi.fn(() => false),
  getActiveConversationId: vi.fn(() => null),
}));

import { formatSummariesForCompaction } from "@/lib/functions/knowledge-compactor";

const MEETING_START = new Date(2026, 0, 29, 7, 18).getTime();
const WRITTEN_AT = new Date(2026, 6, 2, 8, 14).getTime();

const BACKFILLED_SUMMARY: MeetingSummary = {
  id: "sum-1",
  conversationId: "conv-1",
  summary: "Explored a partnership around LCA tooling.",
  title: "Partnership Exploration Call",
  topics: [],
  goals: [],
  actionItems: [],
  nextSteps: [],
  decisions: [],
  teamUpdates: [],
  participants: [],
  exchangeCount: 12,
  durationSeconds: null,
  meetingStartedAt: MEETING_START,
  meetingEndedAt: MEETING_START + 21 * 60 * 1000,
  createdAt: WRITTEN_AT,
  updatedAt: WRITTEN_AT,
};

describe("summaries handed to the compactor", () => {
  it("are dated by their meeting, not by when they were written", () => {
    const formatted = formatSummariesForCompaction([BACKFILLED_SUMMARY]);

    // The profile prompt asks the model to weigh recency and merge outdated
    // entries. Backfilled summaries all carry today's createdAt, which would
    // present months-old meetings to it as this week's.
    expect(formatted).toContain(new Date(MEETING_START).toLocaleDateString());
    expect(formatted).not.toContain(new Date(WRITTEN_AT).toLocaleDateString());
  });

  it("falls back to the write time for summaries with no meeting window", () => {
    const formatted = formatSummariesForCompaction([
      { ...BACKFILLED_SUMMARY, meetingStartedAt: null, meetingEndedAt: null },
    ]);

    expect(formatted).toContain(new Date(WRITTEN_AT).toLocaleDateString());
  });
});
