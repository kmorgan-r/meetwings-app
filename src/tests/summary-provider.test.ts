import { beforeEach, describe, expect, it, vi } from "vitest";

const { fetchAIResponse, shouldUseMeetwingsAPI, loadSummaryProvider, getCustomAiProviders } =
  vi.hoisted(() => ({
    fetchAIResponse: vi.fn(),
    shouldUseMeetwingsAPI: vi.fn(async () => false),
    loadSummaryProvider: vi.fn(async (): Promise<unknown> => null),
    getCustomAiProviders: vi.fn((): unknown[] => []),
  }));
vi.mock("@/lib/functions/ai-response.function", () => ({ fetchAIResponse }));
vi.mock("@/lib/functions/meetwings.api", () => ({ shouldUseMeetwingsAPI }));
vi.mock("@/lib/storage/secure-provider-configs", () => ({ loadSummaryProvider }));
vi.mock("@/lib/storage/ai-providers", () => ({ getCustomAiProviders }));
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

import {
  resolveSummaryProvider,
  summarySecrets,
  type ProviderConfig,
} from "@/lib/functions/summary-provider";
import { ensureMeetingSummary } from "@/lib/functions/meeting-summarizer";
import type { TranscriptEntry } from "@/types";

const ENTRIES4: TranscriptEntry[] = [1, 2, 3, 4].map((n) => ({ original: `l${n}`, timestamp: n * 1000 }));

const OVERRIDE = {
  provider: "openrouter",
  variables: { api_key: "sk-or-v1-TESTKEY", model: "some/model" },
};
const FALLBACK = {
  provider: { id: "groq", curl: "curl x" },
  selectedProvider: { provider: "groq", variables: { api_key: "gsk_FAKEKEY1" } },
} as unknown as ProviderConfig;

beforeEach(() => {
  shouldUseMeetwingsAPI.mockResolvedValue(false);
  loadSummaryProvider.mockReset().mockResolvedValue(null);
  getCustomAiProviders.mockReset().mockReturnValue([]);
  fetchAIResponse.mockReset();
});

describe("resolveSummaryProvider", () => {
  it("override beats the Meetwings API and the chat provider", async () => {
    loadSummaryProvider.mockResolvedValue(OVERRIDE);
    shouldUseMeetwingsAPI.mockResolvedValue(true);
    const r = await resolveSummaryProvider(FALLBACK);
    expect(r.kind).toBe("override");
    if (r.kind !== "override") return;
    expect(r.config.provider.id).toBe("openrouter");
    expect(r.config.selectedProvider).toEqual(OVERRIDE);
  });

  it("empty override: meetwings when enabled, else chat, else none", async () => {
    shouldUseMeetwingsAPI.mockResolvedValue(true);
    expect((await resolveSummaryProvider(FALLBACK)).kind).toBe("meetwings");
    shouldUseMeetwingsAPI.mockResolvedValue(false);
    expect(await resolveSummaryProvider(FALLBACK)).toEqual({ kind: "chat", config: FALLBACK });
    expect(await resolveSummaryProvider()).toEqual({ kind: "none" });
  });

  it("an override naming a deleted custom provider is treated as unset", async () => {
    loadSummaryProvider.mockResolvedValue({ provider: "custom-gone", variables: { api_key: "abcdefgh" } });
    expect(await resolveSummaryProvider(FALLBACK)).toEqual({ kind: "chat", config: FALLBACK });
  });

  it("finds an override among custom providers", async () => {
    getCustomAiProviders.mockReturnValue([{ id: "custom-1", curl: "curl y", isCustom: true }]);
    loadSummaryProvider.mockResolvedValue({ provider: "custom-1", variables: {} });
    const r = await resolveSummaryProvider();
    expect(r.kind).toBe("override");
  });

  it("an unreadable stored override rejects instead of falling through", async () => {
    loadSummaryProvider.mockRejectedValue(new Error("SUMMARY_PROVIDER_UNREADABLE"));
    shouldUseMeetwingsAPI.mockResolvedValue(true);
    await expect(resolveSummaryProvider(FALLBACK)).rejects.toThrow("SUMMARY_PROVIDER_UNREADABLE");
  });
});

describe("summarySecrets", () => {
  it("returns the api key and not the model name", async () => {
    loadSummaryProvider.mockResolvedValue(OVERRIDE);
    const r = await resolveSummaryProvider();
    expect(summarySecrets(r)).toEqual(["sk-or-v1-TESTKEY"]);
  });

  it("skips short values and returns nothing for meetwings, none and unmatched keys", () => {
    const short: ProviderConfig = {
      provider: {},
      selectedProvider: { provider: "x", variables: { token: "abc", secret: "abcdef", base_url: "https://long.example" } },
    };
    expect(summarySecrets({ kind: "chat", config: short })).toEqual(["abcdef"]);
    expect(summarySecrets({ kind: "meetwings" })).toEqual([]);
    expect(summarySecrets({ kind: "none" })).toEqual([]);
  });
});

describe("ensureMeetingSummary with a summary override", () => {
  it("calls fetchAIResponse with the override and skipMeetwingsAPI", async () => {
    loadSummaryProvider.mockResolvedValue(OVERRIDE);
    shouldUseMeetwingsAPI.mockResolvedValue(true);
    fetchAIResponse.mockImplementation(async function* () {});
    await ensureMeetingSummary(null, ENTRIES4, FALLBACK);

    expect(fetchAIResponse).toHaveBeenCalledTimes(1);
    const arg = fetchAIResponse.mock.calls[0][0];
    expect(arg.skipMeetwingsAPI).toBe(true);
    expect(arg.provider.id).toBe("openrouter");
    expect(arg.selectedProvider).toEqual(OVERRIDE);
    expect(arg.rawSystemPrompt).toBe(true);
  });

  it("the chat path sends neither skipMeetwingsAPI nor rawSystemPrompt", async () => {
    fetchAIResponse.mockImplementation(async function* () {});
    await ensureMeetingSummary(null, ENTRIES4, FALLBACK);
    const arg = fetchAIResponse.mock.calls[0][0];
    expect(arg.skipMeetwingsAPI).toBeFalsy();
    expect(arg.rawSystemPrompt).toBeFalsy();
    expect(arg.provider).toBe(FALLBACK.provider);
  });

  it("an unreadable setting returns null and never calls the AI", async () => {
    loadSummaryProvider.mockRejectedValue(new Error("SUMMARY_PROVIDER_UNREADABLE"));
    expect(await ensureMeetingSummary(null, ENTRIES4, FALLBACK)).toBeNull();
    expect(fetchAIResponse).not.toHaveBeenCalled();
  });
});
