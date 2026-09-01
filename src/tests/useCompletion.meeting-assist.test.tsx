import { PropsWithChildren, StrictMode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { useCompletion } from "@/hooks/useCompletion";
import {
  appendMessagesToConversation,
  fetchAIResponse,
  generateConversationId,
  generateConversationTitle,
  getConversationById,
  saveConversation,
  setActiveConversationId,
  shouldUseMeetwingsAPI,
} from "@/lib";

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

// Hoisted to a stable module-scope object: a factory that returns a fresh
// object per render makes selectedAIProvider change identity on every render,
// which rebuilds `submit` every time and makes it impossible for a stale
// closure to ever form - exactly the defect this suite needs to reproduce.
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

// `vi.hoisted`, not a plain module-scope const returned fresh from the
// factory: useCompletion calls useWindowResize() on every render, and a
// factory that returns `{ resizeWindow: vi.fn() }` mints a NEW mock function
// each call, so any assertion on calls made before the render that produced
// the currently-held `resizeWindow` reference would silently see nothing.
// One stable instance is required to assert on it at all.
const resizeWindow = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@/hooks/useWindow", () => ({
  useWindowResize: () => ({ resizeWindow }),
}));

vi.mock("@/lib", () => {
  // The real generateMessageId appends a monotonic counter precisely so "no two
  // messages can share an ID regardless of creation timing" — segments minted
  // inside the same millisecond still differ. A mock keyed on role+timestamp
  // alone breaks that guarantee, and since the autosave selects unwritten
  // messages by id, colliding ids make it skip a real append. That surfaces as
  // a machine-speed-dependent flake, not a clear failure, so keep the counter.
  let messageIdSequence = 0;

  // Hoisted so `ensureConversationId` below delegates to the SAME vi.fn as
  // `generateConversationId`, meaning a test's `mockReturnValueOnce` on
  // `generateConversationId` still drives what ensureConversationId mints.
  const mockGenerateConversationId = vi.fn(() => "conversation-1");

  return {
    fetchAIResponse: vi.fn(),
    saveConversation: vi.fn(),
    appendMessagesToConversation: vi.fn(),
    getConversationById: vi.fn(),
    generateConversationTitle: vi.fn((message: string) => message),
    shouldUseMeetwingsAPI: vi.fn().mockResolvedValue(false),
    MESSAGE_ID_OFFSET: 1,
    generateConversationId: mockGenerateConversationId,
    ensureConversationId: vi.fn((ref: { current: string | null }) => {
      ref.current ??= mockGenerateConversationId();
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
    // vi.clearAllMocks() clears call records but not queued one-shot
    // behaviours (mockReturnValueOnce). A test that deliberately leaves a
    // second queued id unconsumed would otherwise leak it into the next
    // test, where it gets picked up by the first mint and breaks every
    // "conversation-1" pin. mockReset() restores the factory's default
    // `vi.fn(() => "conversation-1")` implementation.
    vi.mocked(generateConversationId).mockReset();
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

  // Every case above drives addMeetingTranscript (the microphone half) and
  // flushes by hand. Production does neither: guest audio arrives through
  // addSystemAudioTranscript and is persisted by the PERIODIC autosave effect,
  // which no case exercises. That is the exact asymmetry a real call showed -
  // four microphone messages persisted, fifty-seven guest segments did not.
  it("persists guest segments through the periodic autosave", async () => {
    // vi.clearAllMocks() clears call records but NOT queued one-shot
    // behaviours, and the case above leaves unconsumed mockRejectedValueOnce
    // entries on both write mocks. Without this the first autosave here
    // rejects with that leaked SQLITE_BUSY and the case passes on a later
    // write instead of the one it means to observe.
    vi.mocked(saveConversation).mockReset().mockResolvedValue({
      id: "conversation-1",
      title: "Guest line 1",
      messages: [],
      createdAt: 1,
      updatedAt: 1,
    });
    vi.mocked(appendMessagesToConversation).mockReset().mockResolvedValue();

    const { result } = renderHook(() => useCompletion(), {
      wrapper: strictModeWrapper,
    });

    act(() => {
      result.current.setMeetingAssistMode(true);
    });

    // Two full autosave intervals' worth, with monotonic timestamps the way
    // useMeetingAudio mints them (Date.now() once fetchSTT resolves). No
    // manual flush anywhere - the periodic effect is the subject.
    for (let i = 0; i < 2 * 4; i++) {
      act(() => {
        result.current.addSystemAudioTranscript(`Guest line ${i + 1}`, 5_000 + i);
      });
    }

    await waitFor(() => {
      const writes =
        vi.mocked(saveConversation).mock.calls.length +
        vi.mocked(appendMessagesToConversation).mock.calls.length;
      expect(writes).toBeGreaterThan(0);
    });

    const persisted = [
      ...vi.mocked(saveConversation).mock.calls.flatMap(
        ([conversation]) => conversation.messages
      ),
      ...vi.mocked(appendMessagesToConversation).mock.calls.flatMap(
        ([, , , messages]) => messages
      ),
    ].map((m) => m.content);

    expect(persisted).toContain("Guest line 1");
    expect(persisted).toContain("Guest line 8");
  });

  it("persists new segments when the message list has been reordered newest-first", async () => {
    vi.mocked(saveConversation).mockReset().mockResolvedValue({
      id: "conversation-1",
      title: "Guest line 1",
      messages: [],
      createdAt: 1,
      updatedAt: 1,
    });
    vi.mocked(appendMessagesToConversation).mockReset().mockResolvedValue();

    const { result } = renderHook(() => useCompletion(), {
      wrapper: strictModeWrapper,
    });

    act(() => {
      result.current.setMeetingAssistMode(true);
    });

    // MessageHistory and Input both render `conversationHistory.sort(...)`,
    // and Array.prototype.sort reorders in place - so displaying the message
    // list rewrites the very array the autosave reads, newest segment first.
    // Reproduce that here after every segment, which is when a re-render would
    // do it in the app.
    const reorderTheWayTheRenderDoes = () =>
      result.current.conversationHistory.sort(
        (a, b) => b.timestamp - a.timestamp
      );

    const addSegments = async (from: number) => {
      for (let i = from; i < from + 4; i++) {
        act(() => {
          result.current.addSystemAudioTranscript(
            `Guest line ${i + 1}`,
            5_000 + i
          );
        });
        reorderTheWayTheRenderDoes();
      }
    };

    // The first save creates the row and writes whatever exists, so it is
    // immune to ordering. Let it settle before the second batch - the append
    // that follows is the one that slices, and the one that loses segments.
    await addSegments(0);
    await waitFor(() => {
      expect(vi.mocked(saveConversation)).toHaveBeenCalled();
    });

    await addSegments(4);
    await waitFor(() => {
      expect(vi.mocked(appendMessagesToConversation)).toHaveBeenCalled();
    });

    const appended = vi
      .mocked(appendMessagesToConversation)
      .mock.calls.flatMap(([, , , messages]) => messages.map((m) => m.content));

    // Slicing by position hands back the already-persisted head instead of the
    // new tail, and INSERT OR IGNORE then discards it without a word.
    expect(appended).toEqual(
      expect.arrayContaining([
        "Guest line 5",
        "Guest line 6",
        "Guest line 7",
        "Guest line 8",
      ])
    );
  });

  // Finding 1 (odoo-contact-picker review): the main window is 600x54 and
  // non-resizable (src-tauri/tauri.conf.json), and grows ONLY through this
  // effect - resizeWindow is never called with `true` from anywhere else in
  // the overlay. ContactPicker's popover used to own its own `open` state,
  // invisible to this effect, so opening it never grew the window around it.
  // isContactPickerOpen is threaded to useOdooTarget/ContactPicker in
  // src/pages/app/components/completion/index.tsx; this test only proves
  // useCompletion's OWN half of that wiring - that flipping the flag this
  // hook exposes actually calls resizeWindow(true), the same way
  // isFilesPopoverOpen already does for Files.tsx. It cannot prove
  // ContactPicker calls setIsContactPickerOpen correctly (pinned separately
  // in odoo-contact-picker.test.tsx) or that the resized window is actually
  // visible on screen - jsdom has no window bounds.
  it("grows the window when the Odoo contact picker opens", () => {
    const { result } = renderHook(() => useCompletion());

    act(() => {
      result.current.setIsContactPickerOpen(true);
    });
    expect(resizeWindow).toHaveBeenCalledWith(true);

    act(() => {
      result.current.setIsContactPickerOpen(false);
    });
    expect(resizeWindow).toHaveBeenLastCalledWith(false);
  });

  // Task 12: the "Logging to" section's height is CONTENT-driven, not
  // flag-driven like every other entry in the resize effect's OR list -
  // adding or removing a target inside an already-open picker never toggles
  // isContactPickerOpen, so without targetCount in the dependency array the
  // window would never be asked to re-apply around the new row. useOdooTarget
  // pushes the count in via setTargetCount (see its own test coverage in
  // useOdooTarget.test.tsx, "Task 12: setTargetCount") - this test only pins
  // useCompletion's own half: that the effect actually re-fires when the
  // count it owns changes, mirroring "grows the window..." above exactly.
  it("re-runs the resize effect when a target is added while the picker is open", () => {
    const { result } = renderHook(() => useCompletion());

    act(() => {
      result.current.setIsContactPickerOpen(true);
    });
    resizeWindow.mockClear();

    act(() => {
      result.current.setTargetCount(2);
    });
    expect(resizeWindow).toHaveBeenCalled();
  });
});
