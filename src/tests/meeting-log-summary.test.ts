import { beforeEach, describe, expect, it, vi } from "vitest";

const { fetchAIResponse, shouldUseMeetwingsAPI } = vi.hoisted(() => ({
  fetchAIResponse: vi.fn(),
  shouldUseMeetwingsAPI: vi.fn(async () => true),
}));
vi.mock("@/lib/functions/ai-response.function", () => ({ fetchAIResponse }));
vi.mock("@/lib/functions/meetwings.api", () => ({ shouldUseMeetwingsAPI }));

// meeting-summarizer.ts imports @/lib/database (which pulls in
// @tauri-apps/plugin-sql at module load) and @/lib/storage (which
// getUserIdentityInstruction reaches at call time). The existing suite for this
// module stubs both for exactly that reason - copy its block rather than
// rediscovering it: src/tests/meeting-summarizer.title-sync.test.ts:12-31.
vi.mock("@/lib/database", () => ({
  createMeetingSummary: vi.fn(),
  createOrUpdateKnowledgeEntity: vi.fn(),
  createEntityMention: vi.fn(),
  getMeetingSummaryByConversation: vi.fn(async () => null),
  applySummaryTitleToConversation: vi.fn(),
}));
vi.mock("@/lib/storage", () => ({
  getUserIdentity: vi.fn(() => null),
  hasUserIdentity: vi.fn(() => false),
}));

import { generateMeetingLogSummary } from "@/lib/functions/meeting-summarizer";
import type { TranscriptEntry } from "@/types";

const ENTRIES: TranscriptEntry[] = [
  { original: "we should ship on Friday", timestamp: 1000, audioSource: "microphone" },
  { original: "agreed", timestamp: 2000, audioSource: "system" },
];

function stream(chunks: string[]) {
  return async function* () {
    for (const c of chunks) yield c;
  };
}

beforeEach(() => {
  fetchAIResponse.mockReset();
  shouldUseMeetwingsAPI.mockResolvedValue(true);
});

describe("generateMeetingLogSummary", () => {
  it("parses a valid JSON response", async () => {
    fetchAIResponse.mockImplementation(
      stream([JSON.stringify({ title: "Ship", summary: "We agreed.", decisions: ["Friday"] })])
    );
    const result = await generateMeetingLogSummary(ENTRIES);
    expect(result).toMatchObject({ title: "Ship", summary: "We agreed.", decisions: ["Friday"] });
  });

  it("sends a SPEAKER-labelled transcript, not User/Assistant roles", async () => {
    // formatConversationForSummary (meeting-summarizer.ts:96) labels lines from
    // msg.role, which is meaningless when both sides are human.
    fetchAIResponse.mockImplementation(stream(['{"summary":"s"}']));
    await generateMeetingLogSummary(ENTRIES);
    const userMessage = fetchAIResponse.mock.calls[0][0].userMessage as string;
    expect(userMessage).toContain("You: we should ship on Friday");
    expect(userMessage).toContain("Guest: agreed");
    expect(userMessage).not.toContain("Assistant:");
  });

  it("summarizes a SHORT meeting that generateConversationSummary would skip", async () => {
    // MIN_EXCHANGES_FOR_SUMMARY is 2 (meeting-summarizer.ts:20); a one-line
    // meeting still gets logged.
    fetchAIResponse.mockImplementation(stream(['{"summary":"short but real"}']));
    const result = await generateMeetingLogSummary([ENTRIES[0]]);
    expect(result?.summary).toBe("short but real");
  });

  it("returns null rather than throwing on unparseable JSON", async () => {
    // parseSummarizationResponse catches and returns null - the push module's
    // fallback path depends on this being a null, not a throw.
    fetchAIResponse.mockImplementation(stream(["not json at all"]));
    expect(await generateMeetingLogSummary(ENTRIES)).toBeNull();
  });

  it("returns null when there is no provider and the Meetwings API is off", async () => {
    shouldUseMeetwingsAPI.mockResolvedValue(false);
    expect(await generateMeetingLogSummary(ENTRIES)).toBeNull();
    expect(fetchAIResponse).not.toHaveBeenCalled();
  });

  it("threads a custom provider through when the Meetwings API is off", async () => {
    shouldUseMeetwingsAPI.mockResolvedValue(false);
    fetchAIResponse.mockImplementation(stream(['{"summary":"s"}']));
    const providerConfig = {
      provider: { id: "openai" },
      selectedProvider: { provider: "openai", variables: {} },
    };
    await generateMeetingLogSummary(ENTRIES, providerConfig as never);
    expect(fetchAIResponse.mock.calls[0][0].provider).toEqual({ id: "openai" });
  });

  it("returns null rather than throwing when the provider rejects", async () => {
    fetchAIResponse.mockImplementation(() => {
      throw new Error("Error in fetchAIResponse: 429");
    });
    expect(await generateMeetingLogSummary(ENTRIES)).toBeNull();
  });

  it("returns null for an empty transcript", async () => {
    expect(await generateMeetingLogSummary([])).toBeNull();
    expect(fetchAIResponse).not.toHaveBeenCalled();
  });
});
