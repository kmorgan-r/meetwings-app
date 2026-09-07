import { PropsWithChildren, StrictMode } from "react";
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const APP_CONTEXT = {
  selectedAIProvider: { provider: null },
  allAiProviders: [],
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
vi.mock("@/hooks/useWindow", () => ({ useWindowResize: () => ({ resizeWindow }) }));

vi.mock("@/lib", () => {
  let messageIdSequence = 0;
  const mockGenerateConversationId = vi.fn(() => "conversation-B");
  return {
    fetchAIResponse: vi.fn(async function* () {} as never),
    saveConversation: vi.fn(),
    appendMessagesToConversation: vi.fn(),
    getConversationById: vi.fn().mockResolvedValue(null),
    generateConversationTitle: vi.fn((message: string) => message),
    shouldUseMeetwingsAPI: vi.fn().mockResolvedValue(false),
    MESSAGE_ID_OFFSET: 1,
    generateConversationId: mockGenerateConversationId,
    ensureConversationId: vi.fn((ref: { current: string | null }) => {
      ref.current ??= mockGenerateConversationId();
      return ref.current;
    }),
    generateMessageId: vi.fn(
      (role: string, timestamp: number) => `${role}-${timestamp}-${(messageIdSequence += 1)}`
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

// vi.hoisted, not a plain top-level const: vi.mock factories are hoisted
// above every import (including the `import { useCompletion }` below, which
// transitively imports this mocked module), so a bare `const` here would
// still be in its temporal dead zone when the factory below actually runs -
// see resizeWindow above for the identical fix on the identical problem.
const ensureMeetingSummary = vi.hoisted(() => vi.fn(async () => null));
vi.mock("@/lib/functions/meeting-summarizer", () => ({ ensureMeetingSummary }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(vi.fn()) }));

import { useCompletion } from "@/hooks/useCompletion";

const strictModeWrapper = ({ children }: PropsWithChildren) => (
  <StrictMode>{children}</StrictMode>
);

describe("summarizeCurrentConversation per-conversation slicing", () => {
  beforeEach(() => {
    ensureMeetingSummary.mockClear();
  });

  it("summarizes only entries added since the CURRENT conversation started, not the whole session", async () => {
    const { result } = renderHook(() => useCompletion(), { wrapper: strictModeWrapper });

    act(() => { result.current.setMeetingAssistMode(true); });

    // Conversation A: two entries.
    act(() => { result.current.addMeetingTranscript("A-1"); });
    act(() => { result.current.addMeetingTranscript("A-2"); });
    expect(result.current.meetingTranscript).toHaveLength(2);

    // Switch to a new conversation B. This fires summarizeCurrentConversation
    // for A fire-and-forget, then synchronously advances
    // conversationTranscriptStartRef to meetingTranscript.length (2).
    await act(async () => { await result.current.startNewConversation(); });

    // Conversation B: two more entries.
    act(() => { result.current.addMeetingTranscript("B-1"); });
    act(() => { result.current.addMeetingTranscript("B-2"); });
    expect(result.current.meetingTranscript).toHaveLength(4);

    ensureMeetingSummary.mockClear(); // discard whatever A's switch queued

    // Switch away from B.
    await act(async () => { await result.current.startNewConversation(); });

    expect(ensureMeetingSummary).toHaveBeenCalledTimes(1);
    const [, entries] = ensureMeetingSummary.mock.calls[0];
    expect(entries).toHaveLength(2);
    expect(entries.map((e: { original: string }) => e.original)).toEqual(["B-1", "B-2"]);
  });
});
