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

// Hoisted so the new case can assert the real hook's targets-size push
// (useOdooTarget.ts:251-253) — the in-memory survival probe.
const setTargetCountSpy = vi.fn();
// Hoisted so the doMock factories (hoisted by vitest) can close over them,
// exactly like odoo-target-new-chat-entry-points.test.tsx's `action`.
const actionSpies = vi.hoisted(() => ({
  listContacts: vi.fn(async () => []),
  // `as unknown` mirrors the entry-points scaffold: the rehydrate leg reads
  // `state?.last_sync_at`, and typing the default as `null` would make the
  // new case's mockResolvedValue({ last_sync_at, ... }) a TS error.
  getSyncState: vi.fn(async () => null as unknown),
  setColleague: vi.fn(async () => {}),
  stampLastMeeting: vi.fn(async () => {}),
  loadTargets: vi.fn(async () => [] as unknown[]),
  addSelectedTarget: vi.fn(async () => ({ ok: true }) as { ok: boolean; reason?: "cap" }),
  removeSelectedTarget: vi.fn(async () => {}),
  clearTargets: vi.fn(async () => {}),
  purgeOtherInstances: vi.fn(async () => {}),
  upsertContacts: vi.fn(async () => {}),
}));

// The @/hooks barrel stub, extracted from mockEverything() verbatim so the
// new case can reuse it with ONLY useOdooTarget swapped for the real hook.
// Still async with the importOriginal spread: the real barrel import is what
// pulls useCompletion's heavy tree, covered by the 30s testTimeout above.
const hooksBarrelStub = async (
  importOriginal: () => Promise<Record<string, unknown>>
) => {
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
        setTargetCount: setTargetCountSpy,
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
};

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
    // Scaffold fix (brief gap): the keeps-mounted Odoo case asserts
    // data-overlay-minimize-control (Task 3) on the real app/index.tsx
    // Minimize button, which renders through THIS mocked Button — so the
    // mock must forward rest props, not just onClick/title.
    Button: ({ children, onClick, title, ...rest }: any) => (
      <button onClick={onClick} title={title} {...rest}>
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
  // settings-page.meeting-auto-record.test.tsx). Extracted verbatim into
  // hooksBarrelStub above so the keeps-mounted Odoo case can reuse it with
  // only useOdooTarget swapped for the real hook.
  vi.doMock("@/hooks", hooksBarrelStub);
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
  // The two new probe objects: this file clears per-mock explicitly (no
  // vi.clearAllMocks — it would also reset the doMock factories' default
  // implementations). mockClear keeps implementations; loadTargets then
  // gets its empty default re-armed so tests 1-2 are unaffected.
  setTargetCountSpy.mockClear();
  for (const spy of Object.values(actionSpies)) {
    spy.mockClear();
  }
  actionSpies.loadTargets.mockResolvedValue([]);
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

  it("the SQLite-backed target list survives a minimize/restore cycle (issue #72)", async () => {
    mockEverything();
    // Extra doMocks — registered AFTER mockEverything(), so they win for the
    // App import below. The real hook's import list is exactly:
    //   @tauri-apps/api/{core,event,window}, sonner,
    //   @/lib/database/odoo-contacts.action, @/lib/odoo,
    //   @/lib/storage/odoo-config.storage (useOdooTarget.ts:1-37).
    vi.doMock("@tauri-apps/api/window", () => ({
      getCurrentWindow: () => ({ label: "main" }),
    }));
    vi.doMock("sonner", () => ({
      toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
    }));
    vi.doMock("@/lib/database/odoo-contacts.action", () => actionSpies);
    vi.doMock("@/lib/odoo", async (importOriginal) => {
      const errors = await importOriginal<Record<string, unknown>>();
      return {
        ...errors,
        runSync: vi.fn(async () => ({
          ran: true,
          changed: 0,
          fetched: 0,
          skipped: 0,
          clampSkipped: false,
        })),
        currentInstance: vi.fn(async () => "http://h:8069|odoo"),
        createOdooClient: vi.fn(() => ({
          authenticate: vi.fn(),
          execute: vi.fn(),
          serverDate: null,
        })),
        fetchOpportunities: vi.fn(async () => []),
        searchLeads: vi.fn(async () => []),
        createOrAdoptContact: vi.fn(async () => null),
        LEAD_SEARCH_MIN_CHARS: 3,
      };
    });
    vi.doMock("@/lib/storage/odoo-config.storage", () => ({
      loadOdooConfig: vi.fn(async () => ({
        url: "http://h:8069",
        db: "odoo",
        login: "b",
        apiKey: "k",
      })),
      instanceFingerprint: vi.fn(() => "http://h:8069|odoo"),
    }));
    // The barrel: the shared stub with ONLY useOdooTarget swapped for the
    // real hook (NOT an importOriginal spread — that would un-stub every
    // other hook this file deliberately stubs).
    vi.doMock("@/hooks", async (importOriginal) => {
      const realHook = await import("@/hooks/useOdooTarget");
      return {
        ...(await hooksBarrelStub(importOriginal)),
        useOdooTarget: realHook.useOdooTarget,
      };
    });

    // The "seed": configuring the action mocks the mount effect and its
    // reload leg consume (useOdooTarget.ts:655-682). There is no stateful sql
    // mock to receive an addSelectedTarget call. getSyncState/listContacts
    // follow the entry-points scaffold's values — a plain vi.fn() returning
    // undefined would run `reload` against undefined and can crash or leave
    // setTargetCountSpy's last call at 0.
    actionSpies.loadTargets.mockResolvedValue([
      { model: "res.partner", resId: 1, name: "A" },
    ]);
    actionSpies.getSyncState.mockResolvedValue({
      last_sync_at: 1000,
      last_error_code: null,
    });
    actionSpies.listContacts.mockResolvedValue([]);

    const { default: App } = await import("@/pages/app");
    const { setMinimized } = await import("@/lib/overlay-minimize.store");

    render(
      <MemoryRouter>
        <App />
      </MemoryRouter>
    );

    // Mount: the REAL hook's mount effect rehydrates through the mocked
    // loadTargets (useOdooTarget.ts:655-682) and pushes the size to
    // useCompletion (Task 12's setTargetCount effect).
    await waitFor(() => expect(setTargetCountSpy).toHaveBeenCalledWith(1));
    // The real overlay bar is mounted here — enforce the real button's
    // attribute wiring (the picker-dismiss test's button is a stand-in).
    expect(screen.getByTitle("Minimize")).toHaveAttribute(
      "data-overlay-minimize-control",
      "true"
    );

    // The MINIMIZE leg goes through the real button: `handleMinimize`'s body
    // (src/pages/app/index.tsx) is where a wipe would be wired in a
    // regression, and a bare setMinimized(true) would bypass it. The store
    // import stays for the RESTORE leg — the pill is a stub div in this
    // scaffold, there is no real restore button to click.
    await userEvent.click(screen.getByTitle("Minimize"));
    await waitFor(() => {
      expect(screen.getByTestId("minimized-pill-stub")).not.toBeNull();
    });
    setMinimized(false);
    await waitFor(() => {
      expect(screen.queryByTestId("minimized-pill-stub")).toBeNull();
    });

    // 1. In-memory survival (covers the UI-only-wipe candidate): the size
    //    push ends at 1 — the in-memory list is intact after the cycle.
    //    What this case asserts is the zero wipe ops below
    //    (clearTargets/removeSelectedTarget/purgeOtherInstances never
    //    called) plus this count; there is NO console.info spy in this
    //    file, so no count-0 log line is asserted here (that
    //    discrimination pattern lives in useOdooTarget.test.tsx).
    expect(setTargetCountSpy).toHaveBeenLastCalledWith(1);
    // 2. No wipe ops — including purgeOtherInstances, the only wipe vector
    //    needing no user click.
    expect(actionSpies.clearTargets).not.toHaveBeenCalled();
    expect(actionSpies.removeSelectedTarget).not.toHaveBeenCalled();
    expect(actionSpies.purgeOtherInstances).not.toHaveBeenCalled();
    // 3. Instance stability: the rehydrate's instance is the one the mocked
    //    config fingerprint produced, and nothing rewrote it mid-cycle.
    expect(actionSpies.loadTargets).toHaveBeenCalledWith("http://h:8069|odoo");
    // 4. The mount probe: zero remounts across the cycle.
    expect(completionMountSpy).toHaveBeenCalledTimes(1);
  });
});