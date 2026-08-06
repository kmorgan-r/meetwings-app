import { beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted: vi.mock factories run before module-level consts are initialized,
// and this factory dereferences these immediately rather than inside a callback.
const { createMeetingSummary, applySummaryTitleToConversation } = vi.hoisted(
  () => ({
    createMeetingSummary: vi.fn(),
    applySummaryTitleToConversation: vi.fn(),
  })
);

vi.mock("@/lib/database", () => ({
  createMeetingSummary,
  applySummaryTitleToConversation,
  createOrUpdateKnowledgeEntity: vi.fn(async () => ({ id: "entity-1" })),
  createEntityMention: vi.fn(async () => true),
  getMeetingSummaryByConversation: vi.fn(async () => null),
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
}));

import { saveSummarizationResult } from "@/lib/functions/meeting-summarizer";
import type { SummarizationResult } from "@/types";

const RESULT: SummarizationResult = {
  title: "Live Platform Demo with Kylie",
  summary: "Walked Kylie through the platform and discussed a partnership.",
  topics: [],
  goals: [],
  actionItems: [],
  nextSteps: [],
  decisions: [],
  teamUpdates: [],
  participants: [],
  entities: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  createMeetingSummary.mockResolvedValue({ id: "summary-1" });
  applySummaryTitleToConversation.mockResolvedValue(true);
});

describe("summary title propagation", () => {
  it("offers the summary's title to the conversation it summarized", async () => {
    await saveSummarizationResult("conv-1", RESULT, 4);

    // Otherwise the same meeting is "Casual Greeting and Check-In" in Chats and
    // "Live Platform Demo with Kylie" in Context Memory, and neither page can
    // be used to find the other.
    expect(applySummaryTitleToConversation).toHaveBeenCalledWith(
      "conv-1",
      "Live Platform Demo with Kylie"
    );
  });

  it("skips the rename when the AI produced no title", async () => {
    await saveSummarizationResult("conv-1", { ...RESULT, title: null }, 4);

    expect(applySummaryTitleToConversation).not.toHaveBeenCalled();
  });

  it("still reports the saved summary when the rename fails", async () => {
    applySummaryTitleToConversation.mockRejectedValue(new Error("locked"));

    await expect(saveSummarizationResult("conv-1", RESULT, 4)).resolves.toBe(
      "summary-1"
    );
  });
});
