import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { useEffect } from "react";

// Scaffold fix (brief gap): the first test's `await import("@/pages/app")`
// cold-evaluates the whole app module graph — the @/hooks importOriginal pass
// alone pulls useCompletion's shiki/vad-react tree — and that import exceeds
// the 5s default testTimeout, failing the test before its first assertion and
// leaving its render mounted to poison the next case. 30s covers the cold
// import; subsequent tests hit vite's transform cache and run in ~1s.
vi.setConfig({ testTimeout: 30_000 });

const invokeMock = vi.fn<(cmd: string, args?: Record<string, unknown>) => Promise<void>>();
// Mounted via useEffect inside the useCompletion stub, NOT the hook body: the
// hook body runs on every RENDER (minimize/restore re-renders App through
// useSyncExternalStore), so a body-placed spy counts re-renders and the
// "mount effects did not re-run" assertion can never pass. An effect with []
// deps fires once per MOUNT — which is exactly the probe the spec asks for.
const completionMountSpy = vi.fn();
// The stub's transcript persists in module state: a remount would fire the
// mount spy again (the probe), and re-running the hook would re-seed state —
// the pill-data write is what proves the data never reset.
let transcriptSeed = [
  { original: "first segment", timestamp: 1 },
  { original: "second segment", timestamp: 2 },
];

const mockEverything = () => {
  vi.doMock("@tauri-apps/api/core", () => ({
    invoke: (cmd: string, args?: Record<string, unknown>) => invokeMock(cmd, args),
  }));
  vi.doMock("@tauri-apps/api/event", () => ({
    listen: () => Promise.resolve(() => {}),
    emit: vi.fn().mockResolvedValue(undefined),
  }));
  vi.doMock("@/contexts", () => ({
    useApp: () => ({
      customizable: {
        cursor: { type: "default" },
        overlayPill: { style: "status-count" },
      },
      setOverlayPillStyle: vi.fn(),
      allAiProviders: [{ id: "openai" }],
      selectedAIProvider: { provider: "openai", variables: {} },
      selectedSttProvider: { provider: "", variables: {} },
      meetwingsApiEnabled: false,
    }),
  }));
  vi.doMock("@/lib", () => ({
    getPlatform: () => "windows",
    // Must be an async fn: Completion's mount effect does
    // `void shouldUseMeetwingsAPI().then(...)`.
    shouldUseMeetwingsAPI: vi.fn(async () => false),
  }));
  vi.doMock("@/layouts", () => ({ ErrorLayout: () => null }));
  vi.doMock("@/components", () => ({
    Card: ({ children }: any) => <div data-testid="overlay-card">{children}</div>,
    Updater: () => null,
    DragButton: () => null,
    CustomCursor: () => null,
    Button: ({ children, onClick, title }: any) => (
      <button onClick={onClick} title={title}>
        {children}
      </button>
    ),
    WingIcon: () => null,
    Popover: ({ children }: any) => <>{children}</>,
    PopoverTrigger: ({ children }: any) => <>{children}</>,
    PopoverContent: ({ children }: any) => <>{children}</>,
    // Scaffold fix (brief gap, F34 parity): the real ContactPicker renders
    // <Input> unconditionally (ContactPicker.tsx:451) even in the never-synced
    // cache branch this stub produces, and a missing export throws
    // "No 'Input' export is defined on the '@/components' mock" before any
    // assertion runs.
    Input: (props: any) => <input {...props} />,
  }));
  // The @/hooks barrel: useCompletion is the spied stub; every other hook
  // Completion mounts gets a passthrough with the return shape its
  // destructure requires (shapes copied from the proven F34 stub in
  // settings-page.meeting-auto-record.test.tsx).
  vi.doMock("@/hooks", async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return {
      ...actual,
      useApp: () => ({
        isHidden: false,
        systemAudio: { capturing: true, error: "" },
      }),
      useSetupStatus: () => ({
        isComplete: true,
        isLoading: false,
        aiConfigured: true,
        sttConfigured: true,
      }),
      useMeetingDetection: () => ({}),
      useCompletion: () => {
        useEffect(() => {
          completionMountSpy();
        }, []);
        return {
          meetingTranscript: transcriptSeed,
          meetingAssistMode: true,
          isContactPickerOpen: false,
          setIsContactPickerOpen: vi.fn(),
          setTargetCount: vi.fn(),
          setCalendarBlockPresent: vi.fn(),
          currentConversationId: null,
          enableVAD: false,
          setEnableVAD: vi.fn(),
          flushUnsavedMeetingTranscript: vi.fn(),
        };
      },
      useQuickActions: () => ({}),
      usePillRecordAction: vi.fn(),
      useMeetingAutoRecord: vi.fn(),
      useOdooTarget: () => ({
        targetsRef: { current: [] },
        pickerProps: {
          contactId: null,
          leadId: null,
          contactName: null,
          cache: { kind: "never-synced" },
          opportunities: null,
          opportunityError: null,
          isLookingUp: false,
          onSelect: vi.fn(),
          onSelectOpportunity: vi.fn(),
          onToggleColleague: vi.fn(),
          onRetryOpportunities: vi.fn(),
          onRefresh: vi.fn(),
          onOpenSettings: vi.fn(),
          // Scaffold fix (brief gap): ContactPicker's search debounce effect
          // (ContactPicker.tsx:280-285) runs on mount with a 350ms timer that
          // fires onSearchLeads even with the popover closed; a missing stub
          // is "onSearchLeads is not a function" — an uncaught timer exception
          // that kills the test mid-run. The other undeclared props
          // (leadName/leadResults/isSearchingLeads/onSelectLead/onCreateContact/
          // onClearTargets) are only read inside branches this stub never
          // renders (targets empty, cache never-synced, calendar undefined).
          onSearchLeads: vi.fn(async () => {}),
          targets: [],
          onAddTarget: vi.fn(),
          onRemoveTarget: vi.fn(),
          onExpandContact: vi.fn(),
          opportunitiesFor: vi.fn(() => null),
          errorFor: vi.fn(() => null),
          onRetryContactOpportunities: vi.fn(),
          open: false,
          onOpenChange: vi.fn(),
        },
      }),
      useCalendarProposal: () => ({
        present: false,
        state: { kind: "idle" },
        onPickCandidate: vi.fn(),
        onRetry: vi.fn(),
      }),
      useMeetingLog: vi.fn(() => ({
        holding: false,
        onUndo: vi.fn(),
        undoBlockedMessage: null,
      })),
    };
  });
  // The app page barrel: keep the REAL Completion (it carries this task's
  // new pill-data effect); stub only the page's other children.
  vi.doMock("@/pages/app/components", async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return {
      ...actual,
      SystemAudio: () => null,
      AudioVisualizer: () => null,
      StatusIndicator: () => null,
      MinimizedPill: () => <div data-testid="minimized-pill-stub" />,
    };
  });
  // ABSOLUTE specifiers (vi.doMock resolves relative to THIS file, so
  // "./Audio" would be a silent no-op): Completion's direct children are
  // heavy render paths irrelevant to the mount/pill-data assertions.
  vi.doMock("@/pages/app/components/completion/Audio", () => ({
    Audio: () => null,
  }));
  vi.doMock("@/pages/app/components/completion/Input", () => ({
    Input: () => null,
  }));
  vi.doMock("@/pages/app/components/completion/Screenshot", () => ({
    Screenshot: () => null,
  }));
  vi.doMock("@/pages/app/components/completion/Files", () => ({
    Files: () => null,
  }));
  vi.doMock("@/pages/app/components/completion/MeetingAssistToggle", () => ({
    MeetingAssistToggle: () => null,
  }));
  vi.doMock("react-error-boundary", () => ({
    ErrorBoundary: ({ children }: any) => <>{children}</>,
  }));
  vi.doMock("lucide-react", () => ({
    AlertCircle: () => null,
    Minimize2: () => null,
  }));
};

beforeEach(() => {
  vi.resetModules();
  invokeMock.mockReset();
  invokeMock.mockResolvedValue(undefined);
  completionMountSpy.mockClear();
  transcriptSeed = [
    { original: "first segment", timestamp: 1 },
    { original: "second segment", timestamp: 2 },
  ];
});

describe("minimize keeps the overlay mounted (hide, do not swap)", () => {
  it("a minimize/restore cycle does not unmount Completion or lose the transcript", async () => {
    mockEverything();
    const { default: App } = await import("@/pages/app");
    const { setMinimized, getPillData } = await import(
      "@/lib/overlay-minimize.store"
    );

    render(
      <MemoryRouter>
        <App />
      </MemoryRouter>
    );

    // Mount effects ran exactly once (the spec's probe), and the REAL
    // pill-data effect already fed the store from the stub's transcript.
    expect(completionMountSpy).toHaveBeenCalledTimes(1);
    expect(getPillData().segmentCount).toBe(2);
    expect(getPillData().lastLine).toBe("second segment");
    expect(getPillData().status).toBe("capturing");

    // Minimize: the Card hides, the pill renders, Completion STAYS mounted.
    setMinimized(true);
    await waitFor(() => {
      expect(screen.getByTestId("minimized-pill-stub")).not.toBeNull();
    });
    expect(completionMountSpy).toHaveBeenCalledTimes(1);

    // Restore: nothing remounted.
    setMinimized(false);
    await waitFor(() => {
      expect(screen.queryByTestId("minimized-pill-stub")).toBeNull();
    });
    expect(completionMountSpy).toHaveBeenCalledTimes(1);

    // The transcript can GROW while minimized without anything unmounting:
    // re-seed, trigger a re-render via the store, and the real effect must
    // write the new scalars.
    transcriptSeed = [
      ...transcriptSeed,
      { original: "third segment", timestamp: 3 },
    ];
    setMinimized(true);
    await waitFor(() => {
      expect(getPillData().segmentCount).toBe(3);
      expect(getPillData().lastLine).toBe("third segment");
    });
    expect(completionMountSpy).toHaveBeenCalledTimes(1);
  });

  it("a minimize via the button behaves the same as the store toggle", async () => {
    mockEverything();
    const { default: App } = await import("@/pages/app");

    render(
      <MemoryRouter>
        <App />
      </MemoryRouter>
    );

    await userEvent.click(screen.getByTitle("Minimize"));
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("minimize_overlay", {
        width: 180,
        height: 40,
        restyle: false,
      });
    });
    await waitFor(() => {
      expect(screen.getByTestId("minimized-pill-stub")).not.toBeNull();
    });
    // Card hidden but MOUNTED — no remount:
    expect(completionMountSpy).toHaveBeenCalledTimes(1);
  });
});