import { PropsWithChildren, StrictMode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { useCompletion } from "@/hooks/useCompletion";
import {
  appendMessagesToConversation,
  fetchAIResponse,
  generateConversationTitle,
  getConversationById,
  saveConversation,
  setActiveConversationId,
  shouldUseMeetwingsAPI,
} from "@/lib";

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

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

const EXISTING_CONVERSATION = {
  id: "conversation-1",
  title: "Standup with Dana",
  messages: [],
  createdAt: 1000,
  updatedAt: 1000,
};

// The save block at useCompletion.ts:1022 only runs when the stream produced
// text, so fetchAIResponse must be an async iterable that yields at least once.
function mockStreamedResponse(text: string) {
  vi.mocked(fetchAIResponse).mockImplementation(async function* () {
    yield text;
  } as never);
}

// useApp is mocked with `provider: null`, so the gate at useCompletion.ts:948
// returns early unless the Meetwings API path is enabled.
function enableProviderGate() {
  vi.mocked(shouldUseMeetwingsAPI).mockResolvedValue(true);
}

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
    // vi.clearAllMocks() clears call records but PRESERVES implementations,
    // including any set inside a previous test body. Re-establish both of
    // these every test so one test's override cannot leak into the next.
    vi.mocked(shouldUseMeetwingsAPI).mockResolvedValue(false);
    vi.mocked(fetchAIResponse).mockImplementation(
      async function* () {} as never
    );
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

  it("exposes flushUnsavedMeetingTranscript and it persists the unsaved tail", async () => {
    const { result } = renderHook(() => useCompletion(), {
      wrapper: strictModeWrapper,
    });

    act(() => {
      result.current.setMeetingAssistMode(true);
    });

    // Fewer than MEETING_TRANSCRIPT_AUTOSAVE_INTERVAL (4, config/constants.ts:128),
    // so the periodic autosave effect never fires and any save observed below
    // came from the explicit flush.
    act(() => {
      result.current.addMeetingTranscript("First segment");
      result.current.addMeetingTranscript("Second segment");
    });
    expect(result.current.meetingTranscript).toHaveLength(2);

    // Splitting the add and the flush into separate `act` calls is load-bearing:
    // a combined async act leaves the commit un-flushed, so
    // meetingTranscriptLengthRef lags and the flush becomes a no-op.
    await act(async () => {
      await result.current.flushUnsavedMeetingTranscript();
    });

    expect(vi.mocked(saveConversation)).toHaveBeenCalledTimes(1);
  });

  it("keeps the existing conversation title when a quick action runs", async () => {
    enableProviderGate();
    vi.mocked(getConversationById).mockResolvedValue(EXISTING_CONVERSATION);
    mockStreamedResponse("Here is your summary.");

    const { result } = renderHook(() => useCompletion(), {
      wrapper: strictModeWrapper,
    });

    act(() => {
      result.current.addMeetingTranscript("Dana: let's review the roadmap");
    });

    await act(async () => {
      await result.current.submitWithMeetingContext("Summarize");
    });

    expect(saveConversation).toHaveBeenCalledTimes(1);
    expect(saveConversation).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "conversation-1",
        title: "Standup with Dana",
        createdAt: 1000,
      })
    );
    // An existing title must short-circuit the `||`, not merely tie with it.
    expect(generateConversationTitle).not.toHaveBeenCalled();
    // Pin WHICH row is read. mockResolvedValue ignores arguments, so without
    // this an implementation that reads an incorrect or undefined identifier
    // would still receive EXISTING_CONVERSATION and incorrectly pass the test.
    expect(getConversationById).toHaveBeenCalledWith("conversation-1");
    // updatedAt must still advance. Symmetrically "preserving" it would freeze
    // the row's updated_at, which is what the chats list sorts on
    // (chat-history.action.ts:215,241 ORDER BY updated_at DESC), so the
    // conversation would stop rising to the top after a quick action.
    expect(
      vi.mocked(saveConversation).mock.calls[0][0].updatedAt
    ).toBeGreaterThan(1000);
  });

  it("names a brand-new conversation after the quick action", async () => {
    enableProviderGate();
    vi.mocked(getConversationById).mockResolvedValue(null);
    mockStreamedResponse("Here is your summary.");

    const { result } = renderHook(() => useCompletion(), {
      wrapper: strictModeWrapper,
    });

    act(() => {
      result.current.addMeetingTranscript("Dana: let's review the roadmap");
    });

    await act(async () => {
      await result.current.submitWithMeetingContext("Summarize");
    });

    expect(saveConversation).toHaveBeenCalledTimes(1);
    expect(saveConversation).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Summarize" })
    );
  });

  it("names a conversation whose stored title is empty", async () => {
    enableProviderGate();
    vi.mocked(getConversationById).mockResolvedValue({
      ...EXISTING_CONVERSATION,
      title: "",
    });
    mockStreamedResponse("Here is your summary.");

    const { result } = renderHook(() => useCompletion(), {
      wrapper: strictModeWrapper,
    });

    act(() => {
      result.current.addMeetingTranscript("Dana: let's review the roadmap");
    });

    await act(async () => {
      await result.current.submitWithMeetingContext("Summarize");
    });

    // `||` not `??` — a blank stored title must fall through to the action
    // label, while createdAt is still preserved.
    expect(saveConversation).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Summarize", createdAt: 1000 })
    );
  });

  it("still saves the conversation when the existing-row read fails", async () => {
    enableProviderGate();
    vi.mocked(getConversationById).mockRejectedValue(
      new Error("db unavailable")
    );
    mockStreamedResponse("Here is your summary.");

    const { result } = renderHook(() => useCompletion(), {
      wrapper: strictModeWrapper,
    });

    act(() => {
      result.current.addMeetingTranscript("Dana: let's review the roadmap");
    });

    await act(async () => {
      await result.current.submitWithMeetingContext("Summarize");
    });

    // Without the try/catch the rejection reaches the outer catch at
    // useCompletion.ts:1083-1091, which skips the save entirely and shows a
    // completion error even though the AI response succeeded.
    expect(saveConversation).toHaveBeenCalledTimes(1);
    expect(saveConversation).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Summarize" })
    );
    expect(result.current.error).toBeNull();
  });

  it("reports transcript loss once the unsaved tail stops shrinking", async () => {
    const writeFailure = new Error("SQLITE_BUSY");
    vi.mocked(saveConversation).mockRejectedValue(writeFailure);
    vi.mocked(appendMessagesToConversation).mockRejectedValue(writeFailure);

    const { result } = renderHook(() => useCompletion(), {
      wrapper: strictModeWrapper,
    });

    // useCompletion.ts's AUTOSAVE_FAILURE_REPORT_THRESHOLD is 3 consecutive
    // autosave failures. One extra attempt beyond that confirms the report
    // fires exactly once, not on every failure past the threshold.
    for (let i = 0; i < 4; i++) {
      act(() => {
        result.current.addMeetingTranscript(`Segment ${i + 1}`);
      });
      // Splitting the add and the flush into separate `act` calls is
      // load-bearing (Task 1): a combined async act leaves the commit
      // un-flushed, so meetingTranscriptLengthRef lags and the flush is a
      // no-op — the failure counter would never reach the threshold.
      await act(async () => {
        await result.current.flushUnsavedMeetingTranscript();
      });
    }

    expect(toast.error).toHaveBeenCalledTimes(1);
  });

  it("does not spend the report on a failure that repairs itself", async () => {
    const writeFailure = new Error("SQLITE_BUSY");
    const savedConversation = {
      id: "conversation-1",
      title: "Segment 3",
      messages: [],
      createdAt: 1,
      updatedAt: 1,
    };

    // Reject, reject, resolve, reject, reject — queued on BOTH mocks. The
    // write arm switches from saveConversation to appendMessagesToConversation
    // the moment persistedMessageCountRef advances past 0 (useCompletion.ts:340),
    // which happens on the first success here (the 3rd call overall). Queueing
    // this sequence on saveConversation alone would let calls 4-5 land on a
    // freely-resolving appendMessagesToConversation, making this case pass
    // even with the re-arm deleted.
    for (const mockFn of [saveConversation, appendMessagesToConversation]) {
      const mocked = vi.mocked(mockFn);
      mocked.mockRejectedValueOnce(writeFailure);
      mocked.mockRejectedValueOnce(writeFailure);
      mocked.mockResolvedValueOnce(savedConversation as never);
      mocked.mockRejectedValueOnce(writeFailure);
      mocked.mockRejectedValueOnce(writeFailure);
    }

    const { result } = renderHook(() => useCompletion(), {
      wrapper: strictModeWrapper,
    });

    // 5 add+flush cycles walk the mocked sequence exactly as measured:
    // save#1 (reject), save#2 (reject), save#3 (resolve — arm switches),
    // append#1 (reject), append#2 (reject). Only 2 consecutive failures
    // accrue after the mid-sequence success resets the counter — short of
    // the threshold of 3.
    for (let i = 0; i < 5; i++) {
      act(() => {
        result.current.addMeetingTranscript(`Segment ${i + 1}`);
      });
      await act(async () => {
        await result.current.flushUnsavedMeetingTranscript();
      });
    }

    expect(saveConversation).toHaveBeenCalledTimes(3);
    expect(appendMessagesToConversation).toHaveBeenCalledTimes(2);
    expect(toast.error).not.toHaveBeenCalled();
  });
});
