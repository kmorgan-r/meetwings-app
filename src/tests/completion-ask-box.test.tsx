import { StrictMode } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ASK_COLLAPSE_DEBOUNCE_MS,
  Input,
} from "@/pages/app/components/completion/Input";

vi.mock("@/contexts", () => ({ useApp: () => ({ sttTranslationEnabled: false }) }));
vi.mock("@/pages/app/components/completion/MessageHistory", () => ({
  MessageHistory: () => <div data-testid="message-history" />,
}));
vi.mock("@/pages/app/components/completion/QuickActions", () => ({
  QuickActions: () => <div data-testid="quick-actions" />,
}));
vi.mock("@/pages/app/components/completion/MeetingTranscriptPanel", () => ({
  MeetingTranscriptPanel: () => <div data-testid="meeting-transcript-panel" />,
}));
vi.mock("@/pages/app/components/completion/ActiveModels", () => ({
  ActiveModels: () => <div data-testid="active-models" />,
}));

function makeProps(overrides: Record<string, unknown> = {}) {
  const inputRef: { current: HTMLInputElement | null } = { current: null };
  return {
    isPopoverOpen: true,
    isLoading: false,
    reset: vi.fn(),
    input: "",
    setInput: vi.fn(),
    handleKeyPress: vi.fn(),
    handlePaste: vi.fn(),
    currentConversationId: null,
    conversationHistory: [],
    startNewConversation: vi.fn(),
    messageHistoryOpen: false,
    setMessageHistoryOpen: vi.fn(),
    isContactPickerOpen: false,
    isFilesPopoverOpen: false,
    error: null,
    response: "",
    setResponse: vi.fn(),
    cancel: vi.fn(),
    scrollAreaRef: { current: null },
    inputRef,
    attachInput: vi.fn((el: HTMLInputElement | null) => {
      inputRef.current = el;
    }),
    askExpanded: true,
    onAskExpand: vi.fn(),
    onAskCollapse: vi.fn(),
    isHidden: false,
    keepEngaged: false,
    setKeepEngaged: vi.fn(),
    setMeetingPanelHidden: vi.fn(),
    meetingTranscriptHidden: false,
    setMeetingTranscriptHidden: vi.fn(),
    enableVAD: false,
    meetingAssistMode: true,
    meetingTranscript: [
      { original: "hello", timestamp: 1000, audioSource: "microphone" },
    ],
    clearMeetingTranscript: vi.fn(),
    assignSpeaker: vi.fn(),
    respondedModel: null,
    ...overrides,
  };
}

// The partial props object is deliberate: Input reads a small slice of
// UseCompletionReturn.
const asInputProps = (p: object) => p as unknown as Parameters<typeof Input>[0];

function renderInput(overrides: Record<string, unknown> = {}) {
  const props = makeProps(overrides);
  const utils = render(<Input {...asInputProps(props)} />);
  const rerenderWith = (o: Record<string, unknown>) =>
    utils.rerender(<Input {...asInputProps({ ...props, ...o })} />);
  return { props, rerenderWith, ...utils };
}

describe("the ask box transcript panel", () => {
  it("a hidden transcript stays hidden while an error holds the popover open", () => {
    renderInput({ error: "boom", meetingTranscriptHidden: true });
    expect(screen.queryByTestId("meeting-transcript-panel")).toBeNull();
  });

  it("the panel renders when the transcript is not hidden", () => {
    renderInput({ error: "boom", meetingTranscriptHidden: false });
    expect(screen.getByTestId("meeting-transcript-panel")).toBeTruthy();
  });
});

describe("the Ask box fold", () => {
  const box = () => screen.queryByPlaceholderText("Ask me anything...");
  const sleep = (ms: number) => act(() => new Promise<void>((r) => setTimeout(r, ms)));
  const blur = () => {
    act(() => (box() as HTMLInputElement).blur());
  };

  it("collapsed shows the Ask icon and no text box", () => {
    renderInput({ askExpanded: false });
    expect(screen.getByRole("button", { name: "Ask" })).toBeTruthy();
    expect(box()).toBeNull();
    expect(screen.queryByTestId("message-history")).toBeNull();
  });

  it("clicking the icon expands and clears both hides", () => {
    const { props } = renderInput({ askExpanded: false });
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));
    expect(props.setMeetingPanelHidden).toHaveBeenCalledWith(false);
    expect(props.setMeetingTranscriptHidden).toHaveBeenCalledWith(false);
    expect(props.onAskExpand).toHaveBeenCalledTimes(1);
  });

  it("expanded focuses the text box", () => {
    renderInput();
    expect(document.activeElement).toBe(box());
  });

  it("empty and blurred collapses after the debounce, not before", async () => {
    const { props } = renderInput();
    // Focused and empty: stays open well past a mount-started timer.
    await sleep(ASK_COLLAPSE_DEBOUNCE_MS * 1.5);
    expect(props.onAskCollapse).not.toHaveBeenCalled();
    blur();
    await sleep(ASK_COLLAPSE_DEBOUNCE_MS / 3);
    expect(props.onAskCollapse).not.toHaveBeenCalled();
    await waitFor(() => expect(props.onAskCollapse).toHaveBeenCalledTimes(1));
  });

  it("the fire-time re-check: a React blur while the input still has DOM focus does not collapse", async () => {
    const { props } = renderInput();
    // onBlur clears `focused`, but document.activeElement stays the input.
    fireEvent.blur(box()!);
    expect(document.activeElement).toBe(box());
    await sleep(ASK_COLLAPSE_DEBOUNCE_MS * 1.5);
    expect(props.onAskCollapse).not.toHaveBeenCalled();
  });

  it("typed text keeps it open", async () => {
    const { props } = renderInput({ input: "hi" });
    blur();
    await sleep(ASK_COLLAPSE_DEBOUNCE_MS * 1.5);
    expect(props.onAskCollapse).not.toHaveBeenCalled();
  });

  it("loading keeps it open", async () => {
    const { props } = renderInput({ isLoading: true });
    blur();
    await sleep(ASK_COLLAPSE_DEBOUNCE_MS * 1.5);
    expect(props.onAskCollapse).not.toHaveBeenCalled();
  });

  it("open message history keeps it open", async () => {
    const { props } = renderInput({ messageHistoryOpen: true });
    blur();
    await sleep(ASK_COLLAPSE_DEBOUNCE_MS * 1.5);
    expect(props.onAskCollapse).not.toHaveBeenCalled();
  });

  it("refocus inside the debounce cancels the collapse", async () => {
    const { props } = renderInput();
    blur();
    await sleep(ASK_COLLAPSE_DEBOUNCE_MS / 3);
    act(() => (box() as HTMLInputElement).focus());
    await sleep(ASK_COLLAPSE_DEBOUNCE_MS * 1.5);
    expect(props.onAskCollapse).not.toHaveBeenCalled();
  });

  it("attachInput gets the element on mount and null on unmount, and is not re-run by a re-render", () => {
    const { props, rerenderWith, unmount } = renderInput();
    expect(props.attachInput).toHaveBeenCalledTimes(1);
    expect(props.attachInput.mock.lastCall?.[0]).toBe(box());
    rerenderWith({ input: "x" });
    expect(props.attachInput).toHaveBeenCalledTimes(1);
    unmount();
    expect(props.attachInput).toHaveBeenCalledTimes(2);
    expect(props.attachInput.mock.lastCall?.[0]).toBeNull();
  });
});

describe("<Completion /> and the Ask box fold", () => {
  beforeEach(() => vi.clearAllMocks());

  async function renderCompletion(
    opts: {
      holding?: boolean;
      strict?: boolean;
      heldContactName?: string | null;
      pickerContactName?: string | null;
    } = {}
  ) {
    vi.resetModules();
    const inputProps: { current: any } = { current: null };
    const completion = {
      enableVAD: false,
      setEnableVAD: vi.fn(),
      meetingAssistMode: true,
      meetingTranscript: [],
      currentConversationId: null,
      submit: vi.fn(),
      submitWithMeetingContext: vi.fn(),
      flushUnsavedMeetingTranscript: vi.fn(),
      startNewConversation: vi.fn(),
      isContactPickerOpen: false,
      setIsContactPickerOpen: vi.fn(),
      setIsFilesPopoverOpen: vi.fn(),
      setTargetCount: vi.fn(),
      setCalendarBlockPresent: vi.fn(),
    };
    const unlisten = vi.fn();
    let focusHandler: (() => void) | null = null;
    const listen = vi.fn(async (_event: string, cb: () => void) => {
      focusHandler = cb;
      return unlisten;
    });
    vi.doMock("@tauri-apps/api/event", () => ({ listen }));
    vi.doMock("@/hooks", () => ({
      useCompletion: () => completion,
      useQuickActions: () => ({}),
      usePillRecordAction: vi.fn(),
      useMeetingAutoRecord: vi.fn(),
      useNotionPick: () => ({
        picked: false,
        pickedRef: { current: false },
        sourceRef: { current: "hand" },
        toggle: vi.fn(),
        clear: vi.fn(),
      }),
      useOdooTarget: () => ({
        targetsRef: { current: [] },
        addTarget: vi.fn(),
        onCreateContact: vi.fn(),
        pickerProps: {
          contactName: opts.pickerContactName ?? null,
          cache: { kind: "never-synced" },
          targets: [],
        },
      }),
      useCalendarProposal: () => ({ present: false }),
      useCalendarAutoSelect: vi.fn(),
      useGoogleMeetingCapture: vi.fn(),
      useMeetingLog: () => ({
        holding: !!opts.holding,
        heldContactName: opts.heldContactName ?? null,
        onUndo: vi.fn(),
        undoBlockedMessage: null,
      }),
    }));
    vi.doMock("@/hooks/useNotionConfigured", () => ({
      useNotionConfigured: () => false,
      useOdooSetupState: () => "complete",
    }));
    vi.doMock("@/contexts", () => ({
      useApp: () => ({
        allAiProviders: [{ id: "openai" }],
        selectedAIProvider: { provider: "openai", variables: {} },
        selectedSttProvider: { provider: "", variables: {} },
      }),
    }));
    vi.doMock("@/lib", () => ({
      getPlatform: () => "windows",
      shouldUseMeetwingsAPI: vi.fn(async () => false),
    }));
    for (const name of ["Audio", "Screenshot", "Files", "ContactPicker", "MeetingLogStrip"]) {
      vi.doMock(`@/pages/app/components/completion/${name}`, () => ({
        [name]: (p: { contactName?: string | null }) => (
          <div data-testid={name} data-contact={p.contactName ?? undefined} />
        ),
      }));
    }
    vi.doMock("@/pages/app/components/completion/Input", () => ({
      Input: (p: unknown) => {
        inputProps.current = p;
        return <div data-testid="Input" />;
      },
    }));

    const { Completion } = await import("@/pages/app/components/completion");
    const tree = <Completion isHidden={false} systemAudio={{ capturing: false } as any} />;
    const utils = render(opts.strict ? <StrictMode>{tree}</StrictMode> : tree);
    await act(async () => {});
    const expand = () => act(() => inputProps.current.onAskExpand());
    return { ...utils, completion, listen, unlisten, inputProps, expand, fire: () => focusHandler };
  }

  const has = (id: string) => screen.queryByTestId(id) !== null;

  it("collapsed renders picker, screenshot and files", async () => {
    await renderCompletion();
    expect(has("ContactPicker") && has("Screenshot") && has("Files")).toBe(true);
  });

  it("expanded renders none of them, keeps Audio", async () => {
    const { expand } = await renderCompletion();
    await expand();
    expect(has("ContactPicker") || has("Screenshot") || has("Files")).toBe(false);
    expect(has("Audio")).toBe(true);
  });

  it("expanded keeps the meeting-log Undo strip during a hold", async () => {
    const { expand } = await renderCompletion({ holding: true });
    await expand();
    expect(has("MeetingLogStrip")).toBe(true);
  });

  it("the Undo strip names the held row's contact, not the live picker's", async () => {
    // A new-call reset can clear or re-pick the targets mid-hold.
    await renderCompletion({
      holding: true,
      heldContactName: "Ada Lovelace",
      pickerContactName: "Bob Builder",
    });
    expect(screen.getByTestId("MeetingLogStrip").dataset.contact).toBe("Ada Lovelace");
  });

  it("expanding closes the picker and files popovers first", async () => {
    const { expand, completion, inputProps } = await renderCompletion();
    await expand();
    expect(completion.setIsContactPickerOpen).toHaveBeenCalledWith(false);
    expect(completion.setIsFilesPopoverOpen).toHaveBeenCalledWith(false);
    expect(inputProps.current.askExpanded).toBe(true);
  });

  it("collapsing brings the buttons back", async () => {
    const { expand, inputProps } = await renderCompletion();
    await expand();
    await act(async () => inputProps.current.onAskCollapse());
    expect(has("Screenshot")).toBe(true);
    expect(inputProps.current.askExpanded).toBe(false);
  });

  it("focus-text-input expands", async () => {
    const { listen, fire, inputProps } = await renderCompletion();
    expect(listen).toHaveBeenCalledWith("focus-text-input", expect.any(Function));
    await act(async () => fire()!());
    expect(inputProps.current.askExpanded).toBe(true);
    expect(has("Screenshot")).toBe(false);
  });

  it("the listener is removed on unmount", async () => {
    const { unmount, unlisten } = await renderCompletion();
    unmount();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it("StrictMode registers one listener", async () => {
    const { unmount, listen, unlisten } = await renderCompletion({ strict: true });
    // Two registrations, but the first (cancelled) one is released at once.
    expect(listen).toHaveBeenCalledTimes(2);
    expect(unlisten).toHaveBeenCalledTimes(1);
    unmount();
    expect(unlisten).toHaveBeenCalledTimes(2);
  });
});
