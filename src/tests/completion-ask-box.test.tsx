import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Input } from "@/pages/app/components/completion/Input";

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

function renderInput(overrides: Record<string, unknown> = {}) {
  const props = {
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
    error: null,
    response: "",
    setResponse: vi.fn(),
    cancel: vi.fn(),
    scrollAreaRef: { current: null },
    inputRef: { current: null },
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
  // The partial props object is deliberate: Input reads a small slice of
  // UseCompletionReturn.
  return render(<Input {...(props as unknown as Parameters<typeof Input>[0])} />);
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
