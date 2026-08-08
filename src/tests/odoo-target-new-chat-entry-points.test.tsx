import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Re-review finding: startNewConversation is not the ONLY path to the
// blank-slate signature ("currentConversationId: null, conversationHistory:
// []") that must clear the Odoo target. clearMeetingTranscript
// (useCompletion.ts) reaches the same state independently, via two real UI
// entry points - MeetingTranscriptPanel's Clear button and Input.tsx's X
// button in meeting-assist mode - neither of which calls
// startNewConversation. This file mounts useCompletion and useOdooTarget
// together, exactly as <Completion /> composes them
// (src/pages/app/components/completion/index.tsx), and exercises the literal
// callback each entry point invokes rather than re-testing
// clearMeetingTranscript in isolation.
//
// This is a combined-hook harness, not a rendered-component test: rendering
// MeetingTranscriptPanel.tsx or Input.tsx would pull in unrelated UI
// (ScrollArea, icons, quick actions, etc.) for no additional proof over
// calling the exact function each button's onClick invokes.

const windowLabel = vi.hoisted(() => ({ value: "main" }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ label: windowLabel.value }),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => {}) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

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
  useWindowResize: () => ({ resizeWindow: vi.fn(async () => {}) }),
}));

vi.mock("@/lib", () => ({
  fetchAIResponse: vi.fn(async function* () {} as never),
  saveConversation: vi.fn(async () => ({
    id: "conversation-1",
    title: "t",
    messages: [],
    createdAt: 1,
    updatedAt: 1,
  })),
  appendMessagesToConversation: vi.fn(async () => {}),
  getConversationById: vi.fn(async () => null),
  generateConversationTitle: vi.fn((message: string) => message),
  shouldUseMeetwingsAPI: vi.fn(async () => false),
  MESSAGE_ID_OFFSET: 1,
  generateConversationId: vi.fn(() => "conversation-1"),
  generateMessageId: vi.fn((role: string, timestamp: number) => `${role}-${timestamp}`),
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

// `vi.hoisted`, not a bare `const` - see src/tests/useMeetingAutoRecord.lifecycle.test.tsx:12-15
// for why a factory closing over a plain outer const dies at load with a TDZ
// ReferenceError instead of reporting a failing test.
const action = vi.hoisted(() => ({
  listContacts: vi.fn(async () => []),
  getSyncState: vi.fn(async () => null as unknown),
  setColleague: vi.fn(async () => {}),
  stampLastMeeting: vi.fn(async () => {}),
  saveTarget: vi.fn(async () => {}),
  loadTarget: vi.fn(async () => null as unknown),
  clearTarget: vi.fn(async () => {}),
}));
vi.mock("@/lib/database/odoo-contacts.action", () => action);

const odoo = vi.hoisted(() => ({
  runSync: vi.fn(async () => ({
    ran: true,
    changed: 0,
    fetched: 0,
    skipped: 0,
    clampSkipped: false,
  })),
  currentInstance: vi.fn(async () => "http://h:8069|odoo"),
  createOdooClient: vi.fn(() => ({ authenticate: vi.fn(), execute: vi.fn(), serverDate: null })),
  fetchOpportunities: vi.fn(async () => []),
}));
vi.mock("@/lib/odoo", async () => {
  const errors = await vi.importActual<Record<string, unknown>>("@/lib/odoo/errors");
  return { ...errors, ...odoo };
});
vi.mock("@/lib/storage/odoo-config.storage", () => ({
  loadOdooConfig: vi.fn(async () => ({ url: "http://h:8069", db: "odoo", login: "b", apiKey: "k" })),
  instanceFingerprint: vi.fn(() => "http://h:8069|odoo"),
}));

import { useCompletion } from "@/hooks/useCompletion";
import { useOdooTarget } from "@/hooks/useOdooTarget";

beforeEach(() => {
  vi.clearAllMocks();
  windowLabel.value = "main";
  vi.mocked(localStorage.getItem).mockReturnValue(null);
  action.listContacts.mockResolvedValue([]);
  action.loadTarget.mockResolvedValue(null);
  action.getSyncState.mockResolvedValue({ last_sync_at: 1000, last_error_code: null });
  action.saveTarget.mockResolvedValue(undefined);
  action.stampLastMeeting.mockResolvedValue(undefined);
  action.setColleague.mockResolvedValue(undefined);
  action.clearTarget.mockResolvedValue(undefined);
  odoo.fetchOpportunities.mockResolvedValue([]);
  odoo.currentInstance.mockResolvedValue("http://h:8069|odoo");
  odoo.runSync.mockResolvedValue({
    ran: true,
    changed: 0,
    fetched: 0,
    skipped: 0,
    clampSkipped: false,
  });
});

// Mirrors exactly how <Completion /> composes the two hooks -
// src/pages/app/components/completion/index.tsx.
function mountCombined() {
  return renderHook(() => {
    const completion = useCompletion();
    const odoo = useOdooTarget({
      meetingAssistMode: completion.meetingAssistMode,
      isPickerOpen: false,
      setIsPickerOpen: vi.fn(),
    });
    return { completion, odoo };
  });
}

describe("clearing the Odoo target from the meeting-transcript reset paths", () => {
  // MeetingTranscriptPanel.tsx:114 - onClick={clearMeetingTranscript}, no
  // other logic in between.
  it("clears via the meeting-transcript panel's Clear button", async () => {
    action.loadTarget.mockResolvedValue({ contactId: 1, leadId: null });
    const { result } = mountCombined();
    await waitFor(() =>
      expect(result.current.odoo.targetRef.current).toEqual({ contactId: 1, leadId: null })
    );

    await act(async () => {
      await result.current.completion.clearMeetingTranscript();
    });

    await waitFor(() => expect(result.current.odoo.targetRef.current).toBeNull());
    expect(action.clearTarget).toHaveBeenCalled();
  });

  // Input.tsx:194-199 - the X button's non-keepEngaged, meeting-assist-mode
  // branch: reset() then clearMeetingTranscript(), in that order.
  it("clears via the Input X button's non-keepEngaged meeting-assist branch", async () => {
    action.loadTarget.mockResolvedValue({ contactId: 1, leadId: null });
    const { result } = mountCombined();
    await waitFor(() =>
      expect(result.current.odoo.targetRef.current).toEqual({ contactId: 1, leadId: null })
    );

    act(() => {
      result.current.completion.setMeetingAssistMode(true);
    });

    await act(async () => {
      result.current.completion.reset();
      if (result.current.completion.meetingAssistMode) {
        await result.current.completion.clearMeetingTranscript();
      }
    });

    await waitFor(() => expect(result.current.odoo.targetRef.current).toBeNull());
    expect(action.clearTarget).toHaveBeenCalled();
  });
});
