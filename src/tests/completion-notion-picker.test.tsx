import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";

// Pins what <Completion /> derives from the two setup hooks: when the picker is
// hidden (Notion alone) and what it passes down. Same harness as
// completion-calendar-wiring.test.tsx, which explains the absolute specifiers
// and the "@/components" stub.

async function renderCompletion(setup: { notion: boolean | null; odoo: string | null }) {
  vi.resetModules();
  const pickerSpy = vi.fn();
  const toggle = vi.fn();

  vi.doMock("@/hooks", () => ({
    useCompletion: () => ({
      enableVAD: false,
      setEnableVAD: vi.fn(),
      meetingAssistMode: false,
      meetingTranscript: [],
      currentConversationId: null,
      setMeetingAssistMode: vi.fn(),
      submit: vi.fn(),
      submitWithMeetingContext: vi.fn(),
      flushUnsavedMeetingTranscript: vi.fn(),
      isContactPickerOpen: false,
      setIsContactPickerOpen: vi.fn(),
      setTargetCount: vi.fn(),
      setCalendarBlockPresent: vi.fn(),
    }),
    useQuickActions: () => ({}),
    usePillRecordAction: vi.fn(),
    useMeetingAutoRecord: vi.fn(),
    useNotionPick: () => ({ picked: true, pickedRef: { current: true }, toggle, clear: vi.fn() }),
    useOdooTarget: () => ({
      targetsRef: { current: [] },
      addTarget: vi.fn(),
      onCreateContact: vi.fn(),
      pickerProps: { contactName: null, cache: { kind: "never-synced" }, targets: [] },
    }),
    useCalendarProposal: () => ({ present: false, state: { kind: "no-meeting" }, onPickCandidate: vi.fn(), onRetry: vi.fn() }),
    useCalendarAutoSelect: vi.fn(),
    useMeetingLog: () => ({ holding: false, onUndo: vi.fn(), undoBlockedMessage: null }),
  }));
  vi.doMock("@/hooks/useNotionConfigured", () => ({
    useNotionConfigured: () => setup.notion,
    useOdooSetupState: () => setup.odoo,
  }));
  vi.doMock("@/contexts", () => ({
    useApp: () => ({
      customizable: { cursor: { type: "default" } },
      allAiProviders: [{ id: "openai" }],
      selectedAIProvider: { provider: "openai", variables: {} },
      selectedSttProvider: { provider: "", variables: {} },
    }),
  }));
  vi.doMock("@/lib", () => ({
    getPlatform: () => "windows",
    shouldUseMeetwingsAPI: vi.fn(async () => false),
  }));
  for (const name of ["Audio", "Input", "Screenshot", "Files", "MeetingAssistToggle"]) {
    vi.doMock(`@/pages/app/components/completion/${name}`, () => ({ [name]: () => null }));
  }
  vi.doMock("@/pages/app/components/completion/ContactPicker", () => ({
    ContactPicker: (p: unknown) => {
      pickerSpy(p);
      return null;
    },
  }));
  vi.doMock("@/components", () => ({
    Button: ({ children, ...props }: any) => <button {...props}>{children}</button>,
    Input: (props: any) => <input {...props} />,
  }));

  const { Completion } = await import("@/pages/app/components/completion");
  render(<Completion isHidden={false} systemAudio={{ capturing: false } as any} />);
  return { pickerSpy, toggle };
}

describe("<Completion /> and the Notion picker row", () => {
  beforeEach(() => vi.clearAllMocks());

  it("Notion-only: the overlay renders no contact picker", async () => {
    const { pickerSpy } = await renderCompletion({ notion: true, odoo: "absent" });
    expect(pickerSpy).not.toHaveBeenCalled();
  });

  it("offers the Notion row only when Notion is configured and Odoo is complete", async () => {
    const both = await renderCompletion({ notion: true, odoo: "complete" });
    expect(both.pickerSpy.mock.calls[0][0]).toMatchObject({
      notionAvailable: true,
      notionSelected: true,
    });
    both.pickerSpy.mock.calls[0][0].onToggleNotion();
    expect(both.toggle).toHaveBeenCalledTimes(1);

    const odooOnly = await renderCompletion({ notion: false, odoo: "complete" });
    expect(odooOnly.pickerSpy.mock.calls[0][0].notionAvailable).toBe(false);

    const incomplete = await renderCompletion({ notion: true, odoo: "incomplete" });
    expect(incomplete.pickerSpy.mock.calls[0][0].notionAvailable).toBe(false);
  });

  it("keeps today's picker while either setup read is still loading", async () => {
    const loading = await renderCompletion({ notion: null, odoo: null });
    expect(loading.pickerSpy).toHaveBeenCalled();
    expect(loading.pickerSpy.mock.calls[0][0].notionAvailable).toBe(false);
  });
});
