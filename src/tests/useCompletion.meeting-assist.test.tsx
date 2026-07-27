import { PropsWithChildren, StrictMode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useCompletion } from "@/hooks/useCompletion";
import {
  getConversationById,
  saveConversation,
  setActiveConversationId,
} from "@/lib";

vi.mock("@/contexts", () => ({
  useApp: () => ({
    selectedAIProvider: { provider: null },
    allAiProviders: [],
    systemPrompt: "",
    screenshotConfiguration: { enabled: false, mode: "manual" },
    setScreenshotConfiguration: vi.fn(),
  }),
}));

vi.mock("@/hooks", () => ({
  useGlobalShortcuts: () => ({
    registerAudioCallback: vi.fn(),
    registerInputRef: vi.fn(),
    registerScreenshotCallback: vi.fn(),
  }),
}));

vi.mock("@/hooks/useWindow", () => ({
  useWindowResize: () => ({ resizeWindow: vi.fn() }),
}));

vi.mock("@/lib", () => ({
  fetchAIResponse: vi.fn(),
  saveConversation: vi.fn(),
  appendMessagesToConversation: vi.fn(),
  getConversationById: vi.fn(),
  generateConversationTitle: vi.fn((message: string) => message),
  shouldUseMeetwingsAPI: vi.fn().mockResolvedValue(false),
  MESSAGE_ID_OFFSET: 1,
  generateConversationId: vi.fn(() => "conversation-1"),
  generateMessageId: vi.fn((role: string, timestamp: number) =>
    `${role}-${timestamp}`
  ),
  generateRequestId: vi.fn(() => "request-1"),
  getResponseSettings: vi.fn(() => ({ autoScroll: false })),
  createUsageRecord: vi.fn(),
  calculateCost: vi.fn(() => 0),
  calculateSTTCost: vi.fn(() => 0),
  setActiveConversationId: vi.fn(),
  clearActiveConversationId: vi.fn(),
}));

vi.mock("@/lib/functions/meeting-summarizer", () => ({
  summarizeConversation: vi.fn(),
  shouldSummarize: vi.fn(() => false),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(vi.fn()),
}));

const strictModeWrapper = ({ children }: PropsWithChildren) => (
  <StrictMode>{children}</StrictMode>
);

describe("useCompletion meeting assist mode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(localStorage.getItem).mockReturnValue(null);
    vi.mocked(getConversationById).mockResolvedValue(null);
    vi.mocked(saveConversation).mockResolvedValue({
      id: "conversation-1",
      title: "First segment",
      messages: [],
      createdAt: 1,
      updatedAt: 1,
    });
  });

  it("queues one transcript flush when StrictMode disables meeting assist", async () => {
    const { result } = renderHook(() => useCompletion(), {
      wrapper: strictModeWrapper,
    });

    act(() => {
      result.current.setMeetingAssistMode(true);
    });
    expect(result.current.meetingAssistMode).toBe(true);

    act(() => {
      result.current.addMeetingTranscript("First segment");
    });
    expect(result.current.meetingTranscript).toHaveLength(1);

    act(() => {
      result.current.setMeetingAssistMode(false);
    });

    await waitFor(() => {
      expect(saveConversation).toHaveBeenCalledTimes(1);
      expect(setActiveConversationId).toHaveBeenCalledTimes(1);
    });
  });
});
