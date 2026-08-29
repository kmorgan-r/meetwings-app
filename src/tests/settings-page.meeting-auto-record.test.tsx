import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

let onWindows = true;
vi.mock("@/lib/platform", () => ({
  isWindows: () => onWindows,
  isMacOS: () => false,
  isLinux: () => !onWindows,
  getPlatform: () => (onWindows ? "windows" : "linux"),
}));

// The toggle's own behaviour is covered by its unit test; here we only care
// whether the settings page renders it.
vi.mock("@/pages/settings/components/MeetingAutoRecordToggle", () => ({
  MeetingAutoRecordToggle: () => (
    <div aria-label="Automatically record Teams calls" />
  ),
}));

vi.mock("@/layouts", () => ({
  PageLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/pages/settings/components", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const Stub = () => <div />;
  return {
    ...actual,
    Theme: Stub,
    AITitlesToggle: Stub,
    AlwaysOnTopToggle: Stub,
    AppIconToggle: Stub,
    AutostartToggle: Stub,
  };
});

import Settings from "@/pages/settings";

beforeEach(() => {
  onWindows = true;
});

describe("settings page auto-record gate", () => {
  // F28
  it("renders the toggle on Windows only", () => {
    const { unmount } = render(<Settings />);
    expect(
      screen.queryByLabelText(/automatically record teams calls/i)
    ).not.toBeNull();
    unmount();

    onWindows = false;
    render(<Settings />);
    expect(
      screen.queryByLabelText(/automatically record teams calls/i)
    ).toBeNull();
  });
});

// Shared render-path stubs for the app page's mount tests below. `App` throws
// without every one of these - only the @/hooks factory varies between cases.
// These are vi.doMock, not vi.mock, so they must run inside each `it` body
// (after that case's own vi.resetModules()), not hoisted to file scope.
const mockAppRenderDeps = () => {
  vi.doMock("@/contexts", () => ({
    // App reads customizable.cursor.type at render, so the stub must hold shape.
    useApp: () => ({ customizable: { cursor: { type: "default" } } }),
  }));
  vi.doMock("@/lib", () => ({ getPlatform: () => "windows" }));
  vi.doMock("@/layouts", () => ({ ErrorLayout: () => null }));
  vi.doMock("@/components", () => ({
    Card: ({ children }: any) => <>{children}</>,
    Updater: () => null,
    DragButton: () => null,
    CustomCursor: () => null,
    Button: ({ children }: any) => <>{children}</>,
    WingIcon: () => null,
  }));
  vi.doMock("@/pages/app/components", () => ({
    SystemAudio: () => null,
    Completion: () => null,
    AudioVisualizer: () => null,
    StatusIndicator: () => null,
  }));
  vi.doMock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
  vi.doMock("react-error-boundary", () => ({
    ErrorBoundary: ({ children }: any) => <>{children}</>,
  }));
  vi.doMock("lucide-react", () => ({ AlertCircle: () => null }));
};

// F29 - the hook mount site. Without this, deleting the useMeetingDetection()
// call from the app page leaves every other test green and the feature inert.
describe("app page mounts the detection hook", () => {
  it("calls useMeetingDetection", async () => {
    vi.resetModules();
    const useMeetingDetection = vi.fn();

    // Mock @/hooks ENTIRELY (not `...actual`). The real useApp -> useSystemAudio
    // pulls in @ricky0123/vad-react, navigator.mediaDevices and AudioContext,
    // none of which setup.ts stubs, so a real useApp would throw before the
    // assertion could run. Replacing the barrel wholesale keeps the test
    // falsifiable: App still does `import { useMeetingDetection } from "@/hooks"`
    // and calls it in its body, so a missing mount fails this assertion. Every
    // other module App's render path touches is stubbed to a no-op for the same
    // reason - the only behavior under test is the hook call site.
    vi.doMock("@/hooks", () => ({
      useApp: () => ({ isHidden: false, systemAudio: {} }),
      useSetupStatus: () => ({
        isComplete: true,
        isLoading: false,
        aiConfigured: true,
        sttConfigured: true,
      }),
      useMeetingDetection,
    }));
    mockAppRenderDeps();

    const { default: App } = await import("@/pages/app");
    render(
      <MemoryRouter>
        <App />
      </MemoryRouter>
    );

    expect(useMeetingDetection).toHaveBeenCalled();
  });
});

// F34/F34b - the auto-record hook mount site, which is now <Completion /> and
// no longer the app page. Without these, deleting the useMeetingAutoRecord(...)
// call leaves every other test green (including the detection-hook test above,
// which stubs it as a no-op) and the feature inert.
describe("<Completion /> mounts the auto-record hook", () => {
  it("F34: mounts auto-record inside <Completion />, once, with every option", async () => {
    vi.resetModules(); // or the cached module ignores the factories below
    const systemAudio = { capturing: false };
    const useMeetingAutoRecord = vi.fn();
    const setEnableVAD = vi.fn();
    const flushUnsavedMeetingTranscript = vi.fn();

    // Mock @/hooks wholesale: the real useCompletion reaches for the app
    // context and the whole audio stack. mockAppRenderDeps() is deliberately
    // NOT used here - it stubs Completion itself to `() => null`, so the
    // component under test would never render and the spy never be called.
    vi.doMock("@/hooks", () => ({
      useCompletion: () => ({
        enableVAD: false,
        setEnableVAD,
        meetingAssistMode: false,
        meetingTranscript: [],
        currentConversationId: null,
        setMeetingAssistMode: vi.fn(),
        submit: vi.fn(),
        submitWithMeetingContext: vi.fn(),
        flushUnsavedMeetingTranscript,
      }),
      useQuickActions: () => ({}),
      useMeetingAutoRecord,
      // <Completion /> also mounts useOdooTarget (index.tsx:43) and spreads
      // odoo.pickerProps into the real (unmocked) ContactPicker, so this
      // needs the full ContactPickerProps shape or that render throws before
      // the useMeetingAutoRecord assertions below ever run.
      useOdooTarget: () => ({
        targetRef: { current: null },
        // Task 14: <Completion /> now feeds useMeetingLog's `targetRef` from
        // THIS field, not the single-select `targetRef` above - see
        // useOdooTarget.ts's UseOdooTargetReturn.targetsRef doc comment.
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
          // Task 12 bridge: ContactPicker (real, unmocked here) reads
          // targets.length unconditionally on every render, so a stub
          // missing it throws before any assertion in this file runs.
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
      // Returns the RENDER PROPS shape, not a bare vi.fn(). <Completion />
      // destructures holding/onUndo/undoBlockedMessage, so an undefined return
      // throws before any assertion - byte-for-byte the failure slice 1 hit with
      // useOdooTarget, which is why its stub at :163-182 spells the shape out.
      useMeetingLog: vi.fn(() => ({
        holding: false,
        onUndo: vi.fn(),
        undoBlockedMessage: null,
      })),
    }));
    vi.doMock("@/contexts", () => ({
      useApp: () => ({
        customizable: { cursor: { type: "default" } },
        allAiProviders: [{ id: "openai" }],
        selectedAIProvider: { provider: "openai", variables: {} },
      }),
    }));
    vi.doMock("@/lib", () => ({
      getPlatform: () => "windows",
      // Must be an async fn: the mount effect does
      // `void shouldUseMeetwingsAPI().then(...)`, and a bare vi.fn() returns
      // undefined, which throws on .then.
      shouldUseMeetwingsAPI: vi.fn(async () => false),
    }));
    // ABSOLUTE specifiers: vi.doMock resolves relative to THIS file, so
    // "./Audio" would be a silent no-op and the real
    // Audio -> AutoSpeechVad -> useApp() chain would run and throw.
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
    // ContactPicker (index.tsx:67) is NOT stubbed here - F34b's app-page path
    // stubs Completion itself, but F34 mounts the real Completion, and
    // Completion renders the real ContactPicker straight from @/components.
    // The F29 case above already left a "@/components" factory registered via
    // vi.doMock (it is not undone by vi.resetModules()), and that one lacks
    // Popover/Button/Input - so without redeclaring it here, ContactPicker
    // throws the same "no export defined on the mock" error the useMeetingAutoRecord
    // fix above was written to eliminate. Passthrough stubs only: this test's
    // assertions are about useMeetingAutoRecord's call, not ContactPicker's own
    // behaviour (that is covered by odoo-contact-picker.test.tsx).
    vi.doMock("@/components", () => ({
      Popover: ({ children }: any) => <>{children}</>,
      PopoverTrigger: ({ children }: any) => <>{children}</>,
      PopoverContent: ({ children }: any) => <>{children}</>,
      Button: ({ children, ...props }: any) => <button {...props}>{children}</button>,
      Input: (props: any) => <input {...props} />,
    }));

    const { Completion } = await import("@/pages/app/components/completion");
    render(<Completion isHidden systemAudio={systemAudio as any} />);

    // Exactly once: two hooks driving one global capture would start and stop
    // the same recording twice.
    expect(useMeetingAutoRecord).toHaveBeenCalledTimes(1);
    const options = useMeetingAutoRecord.mock.calls[0][0];
    expect(Object.keys(options).sort()).toEqual([
      "enableVAD",
      "flushUnsavedMeetingTranscript",
      "meetingAssistMode",
      "setEnableVAD",
      "systemAudio",
    ]);
    expect(options.enableVAD).toBe(false);
    expect(options.meetingAssistMode).toBe(false);
    expect(options.setEnableVAD).toBe(setEnableVAD);
    expect(options.flushUnsavedMeetingTranscript).toBe(
      flushUnsavedMeetingTranscript
    );
    // Reference identity, not deep equality: useMeetingAutoRecord.ts:80-82
    // requires the SAME object the UI renders, because a second copy would
    // drive independent capture state.
    expect(options.systemAudio).toBe(systemAudio);
  });

  it("F34c: <Completion /> mounts useMeetingLog exactly once, with the target ref and a provider config", async () => {
    // Without this, deleting the useMeetingLog(...) call leaves every meeting
    // log test in the suite green while the feature is completely inert - the
    // same reason F34/F34b exist for useMeetingAutoRecord.
    vi.resetModules();
    const systemAudio = { capturing: false };
    const useMeetingLog = vi.fn(() => ({
      holding: false,
      onUndo: vi.fn(),
      undoBlockedMessage: null,
    }));

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
      }),
      useQuickActions: () => ({}),
      useMeetingAutoRecord: vi.fn(),
      useOdooTarget: () => ({
        targetRef: { current: null },
        // Task 14: <Completion /> now feeds useMeetingLog's `targetRef` from
        // THIS field, not the single-select `targetRef` above - see
        // useOdooTarget.ts's UseOdooTargetReturn.targetsRef doc comment.
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
          // Task 12 bridge: ContactPicker (real, unmocked here) reads
          // targets.length unconditionally on every render, so a stub
          // missing it throws before any assertion in this file runs.
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
      useMeetingLog,
    }));
    vi.doMock("@/contexts", () => ({
      useApp: () => ({
        customizable: { cursor: { type: "default" } },
        allAiProviders: [{ id: "openai" }],
        selectedAIProvider: { provider: "openai", variables: {} },
      }),
    }));
    vi.doMock("@/lib", () => ({
      getPlatform: () => "windows",
      shouldUseMeetwingsAPI: vi.fn(async () => false),
    }));
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
    vi.doMock("@/components", () => ({
      Popover: ({ children }: any) => <>{children}</>,
      PopoverTrigger: ({ children }: any) => <>{children}</>,
      PopoverContent: ({ children }: any) => <>{children}</>,
      Button: ({ children, ...props }: any) => <button {...props}>{children}</button>,
      Input: (props: any) => <input {...props} />,
    }));

    const { Completion } = await import("@/pages/app/components/completion");
    render(<Completion isHidden={false} systemAudio={systemAudio as any} />);

    expect(useMeetingLog).toHaveBeenCalledTimes(1);
    expect(useMeetingLog.mock.calls[0][0]).toMatchObject({
      targetRef: expect.any(Object),
      meetingTranscript: [],
      meetingAssistMode: expect.any(Boolean),
    });
    // The provider config must RESOLVE, not merely be spelled.
    // `toHaveProperty("providerConfig")` would pass on a key holding
    // `undefined` - which IS the failure case: every BYO-provider user then
    // gets the "Summarization failed" body on every meeting, and nothing else
    // in this plan would catch it.
    expect(useMeetingLog.mock.calls[0][0].providerConfig).toMatchObject({
      provider: { id: "openai" },
    });
  });

  it("F34d: closes the contact picker in the layout phase - before ANY passive effect in the same commit can observe it open", async () => {
    // Round-1 fix for Task 11's review Important: the picker-close effect was
    // a passive useEffect and lost the ordering race against useCompletion's
    // OWN resize effect, which is registered first because `completion =
    // useCompletion()` runs before it. jsdom cannot observe the resulting
    // window resize (there are no real window bounds), but the ORDERING
    // property is observable: a useLayoutEffect flushes before every passive
    // effect in the same commit, regardless of hook declaration order within
    // the component. This test proves it using effects that already exist in
    // index.tsx rather than inventing a stand-in for the real resize effect -
    // the pre-existing shouldUseMeetwingsAPI effect (declared BEFORE the
    // picker-close effect in source, and still a plain passive useEffect) is
    // the probe: it calls the mocked shouldUseMeetwingsAPI() synchronously on
    // every mount, so recording setIsContactPickerOpen's call count at that
    // instant pins which phase ran first.
    //
    // Mounting with holding: true from the first render (rather than
    // toggling it on a later rerender) puts both effects in the SAME commit
    // without needing a second act() pass - render() already flushes layout
    // effects before passive effects within one commit.
    vi.resetModules();
    const systemAudio = { capturing: false };
    const setIsContactPickerOpen = vi.fn();
    const order: string[] = [];
    const shouldUseMeetwingsAPI = vi.fn(async () => {
      order.push(
        setIsContactPickerOpen.mock.calls.length > 0
          ? "passive-effect-after-close"
          : "passive-effect-before-close"
      );
      return false;
    });

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
        isContactPickerOpen: true,
        setIsContactPickerOpen,
      }),
      useQuickActions: () => ({}),
      useMeetingAutoRecord: vi.fn(),
      useOdooTarget: () => ({
        targetRef: { current: null },
        // Task 14: <Completion /> now feeds useMeetingLog's `targetRef` from
        // THIS field, not the single-select `targetRef` above - see
        // useOdooTarget.ts's UseOdooTargetReturn.targetsRef doc comment.
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
          // Task 12 bridge: ContactPicker (real, unmocked here) reads
          // targets.length unconditionally on every render, so a stub
          // missing it throws before any assertion in this file runs.
          targets: [],
          onAddTarget: vi.fn(),
          onRemoveTarget: vi.fn(),
          onExpandContact: vi.fn(),
          opportunitiesFor: vi.fn(() => null),
          errorFor: vi.fn(() => null),
          onRetryContactOpportunities: vi.fn(),
          open: true,
          onOpenChange: vi.fn(),
        },
      }),
      // holding true from mount, so the picker-close effect has work to do
      // (and something to race the shouldUseMeetwingsAPI probe against) on
      // the very first commit.
      useMeetingLog: () => ({
        holding: true,
        onUndo: vi.fn(),
        undoBlockedMessage: null,
      }),
    }));
    vi.doMock("@/contexts", () => ({
      useApp: () => ({
        customizable: { cursor: { type: "default" } },
        allAiProviders: [{ id: "openai" }],
        selectedAIProvider: { provider: "openai", variables: {} },
      }),
    }));
    vi.doMock("@/lib", () => ({
      getPlatform: () => "windows",
      shouldUseMeetwingsAPI,
    }));
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
    vi.doMock("@/components", () => ({
      Popover: ({ children }: any) => <>{children}</>,
      PopoverTrigger: ({ children }: any) => <>{children}</>,
      PopoverContent: ({ children }: any) => <>{children}</>,
      Button: ({ children, ...props }: any) => <button {...props}>{children}</button>,
      Input: (props: any) => <input {...props} />,
    }));

    const { Completion } = await import("@/pages/app/components/completion");
    render(<Completion isHidden={false} systemAudio={systemAudio as any} />);

    expect(shouldUseMeetwingsAPI).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["passive-effect-after-close"]);
    expect(setIsContactPickerOpen).toHaveBeenCalledWith(false);
  });

  it("F34b: no longer mounts auto-record from the app page", async () => {
    // The double-mount guard. noUnusedLocals only catches a leftover call site
    // if the import goes too, and F34's identity assertion compares a prop the
    // TEST supplied - so nothing else would notice a second live mount.
    vi.resetModules();
    const useMeetingAutoRecord = vi.fn();

    vi.doMock("@/hooks", () => ({
      useApp: () => ({ isHidden: false, systemAudio: { capturing: false } }),
      useSetupStatus: () => ({
        isComplete: true,
        isLoading: false,
        aiConfigured: true,
        sttConfigured: true,
      }),
      useMeetingDetection: vi.fn(),
      useMeetingAutoRecord,
    }));
    mockAppRenderDeps();

    const { default: App } = await import("@/pages/app");
    render(
      <MemoryRouter>
        <App />
      </MemoryRouter>
    );

    expect(useMeetingAutoRecord).not.toHaveBeenCalled();
  });
});
