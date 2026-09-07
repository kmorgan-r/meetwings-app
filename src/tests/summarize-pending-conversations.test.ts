import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatConversation } from "@/types";

const {
  getUnsummarizedConversations,
  createMeetingSummary,
  getMeetingSummaryByConversation,
} = vi.hoisted(() => ({
  getUnsummarizedConversations: vi.fn(),
  createMeetingSummary: vi.fn(async () => ({ id: "s1" })),
  // Call-aware, not a flat resolved value: ensureMeetingSummary's OWN
  // internal cache check (Task 1) calls this once per conversation BEFORE
  // generating, and Step 1.2's re-check above calls it a second time AFTER a
  // truthy result - the first call must stay a cache MISS (null) or the AI
  // path this test exists to exercise never runs at all, and the second call
  // must return a row or `summarized` stays 0 even on a real success.
  getMeetingSummaryByConversation: vi.fn(),
}));
vi.mock("@/lib/database", () => ({
  getKnowledgeProfile: vi.fn(),
  updateKnowledgeProfile: vi.fn(),
  getOldestUncompactedSummaries: vi.fn(),
  getUncompactedSummaryCount: vi.fn(),
  getUnsummarizedConversations,
  createMeetingSummary,
  getMeetingSummaryByConversation,
  createOrUpdateKnowledgeEntity: vi.fn(async () => ({ id: "e1" })),
  createEntityMention: vi.fn(async () => true),
  applySummaryTitleToConversation: vi.fn(async () => true),
}));

const { fetchAIResponse } = vi.hoisted(() => ({ fetchAIResponse: vi.fn() }));
vi.mock("@/lib/functions/ai-response.function", () => ({ fetchAIResponse }));

vi.mock("@/lib/functions/meetwings.api", () => ({
  shouldUseMeetwingsAPI: vi.fn(async () => false),
}));

vi.mock("@/lib/storage", () => ({
  getUserIdentity: vi.fn(() => null),
  hasUserIdentity: vi.fn(() => false),
  getActiveConversationId: vi.fn(() => null),
}));

import { summarizePendingConversations } from "@/lib/functions/knowledge-compactor";

function stream(chunks: string[]) {
  return async function* () {
    for (const c of chunks) yield c;
  };
}

const MIXED_CONVERSATION: ChatConversation = {
  id: "conv-1",
  title: "Old Chat",
  messages: [
    { id: "m1", role: "user", content: "u1", timestamp: 1 },
    { id: "m2", role: "assistant", content: "a1", timestamp: 2 },
    { id: "m3", role: "user", content: "u2", timestamp: 3 },
    { id: "m4", role: "assistant", content: "a2", timestamp: 4 },
    { id: "m5", role: "user", content: "u3", timestamp: 5 },
    { id: "m6", role: "assistant", content: "a3", timestamp: 6 },
    { id: "m7", role: "user", content: "u4", timestamp: 7 },
    { id: "m8", role: "assistant", content: "a4", timestamp: 8 },
  ],
  createdAt: 1,
  updatedAt: 8,
};

const providerConfig = {
  provider: { id: "openai" },
  selectedProvider: { provider: "openai", variables: {} },
};

beforeEach(() => {
  fetchAIResponse.mockReset();
  getUnsummarizedConversations.mockReset();
  createMeetingSummary.mockClear();
  getMeetingSummaryByConversation.mockReset();
  getMeetingSummaryByConversation
    .mockResolvedValueOnce(null) // ensureMeetingSummary's own cache check
    .mockResolvedValue({ id: "s1", conversationId: "conv-1" }); // this task's re-check, and any further calls
});

describe("summarizePendingConversations", () => {
  it("gates on the FILTERED user-message count (4), not the raw message count (8)", async () => {
    // 4 user + 4 assistant = 8 raw messages. If the loop's pre-check (or
    // ensureMeetingSummary's own gate) counted raw messages against a
    // minEntries of 4, this would pass trivially either way - the point of
    // this test is that it passes on the FILTERED count too, proving the
    // adapter's role==="user" filter runs before the count is checked, not
    // just that some AI call eventually happens.
    getUnsummarizedConversations.mockResolvedValue([MIXED_CONVERSATION]);
    fetchAIResponse.mockImplementation(stream(['{"summary":"backfilled"}']));

    const result = await summarizePendingConversations(providerConfig);

    expect(result.summarized).toBe(1);
    expect(result.attempts).toBe(1);
    expect(fetchAIResponse).toHaveBeenCalledTimes(1);
    const userMessage = fetchAIResponse.mock.calls[0][0].userMessage as string;
    // Only the 4 user lines should reach the transcript sent to the AI.
    expect(userMessage).toContain("u1");
    expect(userMessage).toContain("u4");
    expect(userMessage).not.toContain("a1");
    expect(userMessage).not.toContain("a4");
  });

  it("skips a conversation whose FILTERED count is below 4, without counting it as an attempt", async () => {
    const short: ChatConversation = {
      ...MIXED_CONVERSATION,
      // 3 user + 4 assistant = 7 raw messages, but only 3 pass the filter.
      messages: [
        ...MIXED_CONVERSATION.messages.slice(0, 6),
        { id: "m9", role: "assistant", content: "a5", timestamp: 9 },
      ],
    };
    getUnsummarizedConversations.mockResolvedValue([short]);

    const result = await summarizePendingConversations(providerConfig);

    expect(result.attempts).toBe(0);
    expect(result.summarized).toBe(0);
    expect(fetchAIResponse).not.toHaveBeenCalled();
  });
});
