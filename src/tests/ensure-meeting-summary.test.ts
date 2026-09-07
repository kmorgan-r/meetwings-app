import { beforeEach, describe, expect, it, vi } from "vitest";

const { fetchAIResponse, shouldUseMeetwingsAPI } = vi.hoisted(() => ({
  fetchAIResponse: vi.fn(),
  shouldUseMeetwingsAPI: vi.fn(async () => true),
}));
vi.mock("@/lib/functions/ai-response.function", () => ({ fetchAIResponse }));
vi.mock("@/lib/functions/meetwings.api", () => ({ shouldUseMeetwingsAPI }));

const {
  createMeetingSummary,
  createOrUpdateKnowledgeEntity,
  createEntityMention,
  getMeetingSummaryByConversation,
  applySummaryTitleToConversation,
} = vi.hoisted(() => ({
  createMeetingSummary: vi.fn(),
  createOrUpdateKnowledgeEntity: vi.fn(async () => ({ id: "entity-1" })),
  createEntityMention: vi.fn(async () => true),
  getMeetingSummaryByConversation: vi.fn(async () => null),
  applySummaryTitleToConversation: vi.fn(async () => true),
}));
vi.mock("@/lib/database", () => ({
  createMeetingSummary,
  createOrUpdateKnowledgeEntity,
  createEntityMention,
  getMeetingSummaryByConversation,
  applySummaryTitleToConversation,
}));
vi.mock("@/lib/storage", () => ({
  getUserIdentity: vi.fn(() => null),
  hasUserIdentity: vi.fn(() => false),
}));

import {
  ensureMeetingSummary,
  chatMessagesToTranscriptEntries,
} from "@/lib/functions/meeting-summarizer";
import type { MeetingSummary, TranscriptEntry } from "@/types";

const ENTRIES: TranscriptEntry[] = [
  { original: "line one", timestamp: 1000 },
  { original: "line two", timestamp: 2000 },
  { original: "line three", timestamp: 3000 },
  { original: "line four", timestamp: 4000 },
];

const ENTRIES_LABELLED: TranscriptEntry[] = [
  { original: "we should ship on Friday", timestamp: 1000, audioSource: "microphone" },
  { original: "agreed", timestamp: 2000, audioSource: "system" },
  { original: "third line to clear minEntries", timestamp: 3000, audioSource: "microphone" },
  { original: "fourth line to clear minEntries", timestamp: 4000, audioSource: "system" },
];

function stream(chunks: string[]) {
  return async function* () {
    for (const c of chunks) yield c;
  };
}

const EXISTING: MeetingSummary = {
  id: "summary-1",
  conversationId: "conv-1",
  summary: "Cached summary text",
  title: "Cached Title",
  topics: ["topic"],
  goals: [],
  actionItems: [],
  nextSteps: [],
  decisions: [],
  teamUpdates: [],
  participants: [],
  exchangeCount: 4,
  durationSeconds: null,
  meetingStartedAt: null,
  meetingEndedAt: null,
  createdAt: 1,
  updatedAt: 1,
};

beforeEach(() => {
  fetchAIResponse.mockReset();
  shouldUseMeetwingsAPI.mockResolvedValue(true);
  createMeetingSummary
    .mockReset()
    .mockResolvedValue({ id: "new-summary", conversationId: "conv-1" });
  getMeetingSummaryByConversation.mockReset().mockResolvedValue(null);
  createOrUpdateKnowledgeEntity.mockClear();
  createEntityMention.mockClear();
});

describe("ensureMeetingSummary", () => {
  it("returns the cached summary's real fields on a cache hit, without calling the AI", async () => {
    getMeetingSummaryByConversation.mockResolvedValue(EXISTING);
    const result = await ensureMeetingSummary("conv-1", ENTRIES);
    expect(result).toMatchObject({
      title: "Cached Title",
      summary: "Cached summary text",
      topics: ["topic"],
    });
    expect(fetchAIResponse).not.toHaveBeenCalled();
  });

  it("skips the AI call when entries.length is below the default minEntries (4)", async () => {
    const result = await ensureMeetingSummary("conv-1", ENTRIES.slice(0, 3));
    expect(result).toBeNull();
    expect(fetchAIResponse).not.toHaveBeenCalled();
  });

  it("generates when entries.length meets a lower minEntries passed by the Odoo caller", async () => {
    fetchAIResponse.mockImplementation(stream(['{"summary":"short but real"}']));
    const result = await ensureMeetingSummary("conv-1", ENTRIES.slice(0, 1), undefined, 1);
    expect(result?.summary).toBe("short but real");
    expect(fetchAIResponse).toHaveBeenCalled();
  });

  it("generates but does NOT persist when entries.length is below the fixed 4-entry persist floor", async () => {
    fetchAIResponse.mockImplementation(stream(['{"summary":"short but real"}']));
    const result = await ensureMeetingSummary("conv-1", ENTRIES.slice(0, 2), undefined, 1);
    expect(result?.summary).toBe("short but real");
    expect(createMeetingSummary).not.toHaveBeenCalled();
  });

  it("generates and persists when entries.length meets the 4-entry persist floor", async () => {
    fetchAIResponse.mockImplementation(stream(['{"summary":"full meeting"}']));
    const result = await ensureMeetingSummary("conv-1", ENTRIES);
    expect(result?.summary).toBe("full meeting");
    expect(createMeetingSummary).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: "conv-1", exchangeCount: 4 })
    );
  });

  it("returns the generated result even when conversationId is null (no persist, no cache lookup)", async () => {
    fetchAIResponse.mockImplementation(stream(['{"summary":"anon meeting"}']));
    const result = await ensureMeetingSummary(null, ENTRIES);
    expect(result?.summary).toBe("anon meeting");
    expect(createMeetingSummary).not.toHaveBeenCalled();
    expect(getMeetingSummaryByConversation).not.toHaveBeenCalled();
  });

  it("returns the generated result even when the persist write fails", async () => {
    fetchAIResponse.mockImplementation(stream(['{"summary":"persist will fail"}']));
    createMeetingSummary.mockRejectedValue(new Error("db write failed"));
    const result = await ensureMeetingSummary("conv-1", ENTRIES);
    expect(result?.summary).toBe("persist will fail");
  });

  it("returns null rather than throwing on an AI failure", async () => {
    fetchAIResponse.mockImplementation(() => {
      throw new Error("Error in fetchAIResponse: 429");
    });
    expect(await ensureMeetingSummary("conv-1", ENTRIES)).toBeNull();
  });

  it("returns null rather than throwing when no provider is configured", async () => {
    shouldUseMeetwingsAPI.mockResolvedValue(false);
    expect(await ensureMeetingSummary("conv-1", ENTRIES)).toBeNull();
    expect(fetchAIResponse).not.toHaveBeenCalled();
  });

  it("sends a SPEAKER-labelled transcript (You/Guest from audioSource), not User/Assistant roles", async () => {
    // renderTranscript labels lines via speakerLabelFor's audioSource mapping
    // (microphone -> You, system -> Guest) - formatConversationForSummary's
    // msg.role labelling is gone, and this asserts the real replacement path.
    fetchAIResponse.mockImplementation(stream(['{"summary":"s"}']));
    await ensureMeetingSummary("conv-1", ENTRIES_LABELLED);
    const userMessage = fetchAIResponse.mock.calls[0][0].userMessage as string;
    expect(userMessage).toContain("You: we should ship on Friday");
    expect(userMessage).toContain("Guest: agreed");
    expect(userMessage).not.toContain("Assistant:");
  });

  it("returns null rather than throwing on unparseable JSON", async () => {
    fetchAIResponse.mockImplementation(stream(["not json at all"]));
    expect(await ensureMeetingSummary("conv-1", ENTRIES)).toBeNull();
  });

  it("threads a custom provider through when the Meetwings API is off", async () => {
    shouldUseMeetwingsAPI.mockResolvedValue(false);
    fetchAIResponse.mockImplementation(stream(['{"summary":"s"}']));
    const providerConfig = {
      provider: { id: "openai" },
      selectedProvider: { provider: "openai", variables: {} },
    };
    await ensureMeetingSummary("conv-1", ENTRIES, providerConfig as never);
    expect(fetchAIResponse.mock.calls[0][0].provider).toEqual({ id: "openai" });
  });
});

describe("chatMessagesToTranscriptEntries", () => {
  it("keeps only role: user messages", () => {
    const entries = chatMessagesToTranscriptEntries([
      { role: "user", content: "hello", timestamp: 1 },
      { role: "assistant", content: "hi there", timestamp: 2 },
      { role: "user", content: "bye", timestamp: 3 },
    ]);
    expect(entries).toEqual([
      { original: "hello", timestamp: 1, speaker: undefined, audioSource: undefined },
      { original: "bye", timestamp: 3, speaker: undefined, audioSource: undefined },
    ]);
  });

  it("carries speaker and audioSource across when present", () => {
    const entries = chatMessagesToTranscriptEntries([
      {
        role: "user",
        content: "hi",
        timestamp: 1,
        speaker: { speakerId: "source_you" as never },
        audioSource: "microphone",
      },
    ]);
    expect(entries[0]).toMatchObject({
      speaker: { speakerId: "source_you" },
      audioSource: "microphone",
    });
  });

  it("accepts messages with no speaker/audioSource fields at all (useSystemAudio's narrower ChatMessage)", () => {
    const entries = chatMessagesToTranscriptEntries([
      { role: "user", content: "narrow", timestamp: 1 },
    ]);
    expect(entries).toEqual([
      { original: "narrow", timestamp: 1, speaker: undefined, audioSource: undefined },
    ]);
  });
});
