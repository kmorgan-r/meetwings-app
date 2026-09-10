import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCompletion } from "@/hooks/useCompletion";
import {
  calculateCost,
  createUsageRecord,
  fetchAIResponse,
  getConversationById,
  saveConversation,
} from "@/lib";

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

// Module scope for a stable identity, as in useCompletion.meeting-assist.test.tsx.
const APP_CONTEXT = {
  selectedAIProvider: {
    provider: "openrouter",
    variables: { api_key: "sk-or-test", model: "openrouter/free" },
  },
  allAiProviders: [{ id: "openrouter", curl: "", streaming: true }],
  systemPrompt: "",
  screenshotConfiguration: { enabled: false, mode: "manual" },
  setScreenshotConfiguration: vi.fn(),
};
vi.mock("@/contexts", () => ({ useApp: () => APP_CONTEXT }));

vi.mock("@/hooks", () => ({
  useGlobalShortcuts: () => ({
    registerAudioCallback: vi.fn(),
    registerInputRef: vi.fn(),
    registerScreenshotCallback: vi.fn(),
  }),
}));

const resizeWindow = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@/hooks/useWindow", () => ({
  useWindowResize: () => ({ resizeWindow }),
}));

vi.mock("@/lib", () => {
  let messageIdSequence = 0;
  return {
    fetchAIResponse: vi.fn(),
    saveConversation: vi.fn(),
    appendMessagesToConversation: vi.fn(),
    getConversationById: vi.fn(),
    generateConversationTitle: vi.fn((message: string) => message),
    shouldUseMeetwingsAPI: vi.fn().mockResolvedValue(false),
    MESSAGE_ID_OFFSET: 1,
    generateConversationId: vi.fn(() => "conversation-1"),
    ensureConversationId: vi.fn((ref: { current: string | null }) => {
      ref.current ??= "conversation-1";
      return ref.current;
    }),
    generateMessageId: vi.fn(
      (role: string, timestamp: number) =>
        `${role}-${timestamp}-${(messageIdSequence += 1)}`
    ),
    generateRequestId: vi.fn(() => "request-1"),
    getResponseSettings: vi.fn(() => ({ autoScroll: false })),
    createUsageRecord: vi.fn(),
    calculateCost: vi.fn(() => 0),
    calculateSTTCost: vi.fn(() => 0),
    setActiveConversationId: vi.fn(),
    clearActiveConversationId: vi.fn(),
  };
});

vi.mock("@/lib/functions/meeting-summarizer", () => ({
  ensureMeetingSummary: vi.fn(async () => null),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(vi.fn()),
}));

/** Streams one answer, reporting `model` first the way fetchAIResponse does. */
function answerWith(model: string | null) {
  vi.mocked(fetchAIResponse).mockImplementation(async function* (params: {
    onModel?: (model: string) => void;
  }) {
    if (model) params.onModel?.(model);
    yield "Hello";
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(localStorage.getItem).mockReturnValue(null);
  vi.mocked(getConversationById).mockResolvedValue(null);
  vi.mocked(saveConversation).mockResolvedValue({
    id: "conversation-1",
    title: "hi",
    messages: [],
    createdAt: 1,
    updatedAt: 1,
  });
});

afterEach(cleanup);

describe("useCompletion respondedModel", () => {
  it("holds the model the router picked for the current answer", async () => {
    answerWith("upstage/solar-pro-3:free");
    const { result } = renderHook(() => useCompletion());

    await act(async () => {
      await result.current.submit("hi");
    });

    expect(result.current.respondedModel).toEqual({
      requested: "openrouter/free",
      model: "upstage/solar-pro-3:free",
    });
  });

  it("forgets the previous pick when a new request starts", async () => {
    answerWith("upstage/solar-pro-3:free");
    const { result } = renderHook(() => useCompletion());
    await act(async () => {
      await result.current.submit("hi");
    });

    answerWith(null);
    await act(async () => {
      await result.current.submit("again");
    });

    expect(result.current.respondedModel).toBeNull();
  });
});

describe("useCompletion usage records", () => {
  function captureUsage(detail: Record<string, string>) {
    window.dispatchEvent(
      new CustomEvent("api-usage-captured", {
        detail: {
          usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
          ...detail,
        },
      })
    );
  }

  it("records the model that answered and prices the one requested", async () => {
    renderHook(() => useCompletion());

    captureUsage({
      provider: "openrouter",
      model: "openrouter/free",
      respondedModel: "upstage/solar-pro-3:free",
    });

    await waitFor(() => expect(createUsageRecord).toHaveBeenCalledTimes(1));
    expect(calculateCost).toHaveBeenCalledWith(
      expect.anything(),
      "openrouter",
      "openrouter/free"
    );
    expect(createUsageRecord).toHaveBeenCalledWith(
      expect.objectContaining({ model: "upstage/solar-pro-3:free" })
    );
  });

  it("keeps the requested id when the answer is a dated snapshot of it", async () => {
    renderHook(() => useCompletion());

    captureUsage({
      provider: "openai",
      model: "gpt-5.6-terra",
      respondedModel: "gpt-5.6-terra-2026-08-01",
    });

    await waitFor(() => expect(createUsageRecord).toHaveBeenCalledTimes(1));
    expect(createUsageRecord).toHaveBeenCalledWith(
      expect.objectContaining({ model: "gpt-5.6-terra" })
    );
  });
});
