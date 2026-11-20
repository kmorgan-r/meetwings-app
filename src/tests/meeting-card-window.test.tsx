import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

// Same module-mock approach as overlay-minimize-keeps-mounted.test.tsx, but
// the @/hooks barrel is stubbed WITHOUT importOriginal (it would pull
// useCompletion's heavy tree) and re-exports the REAL useMeetingCardHost from
// its own file, which is the unit under test.
vi.setConfig({ testTimeout: 30_000 });

const invokeMock = vi.fn<(cmd: string, args?: Record<string, unknown>) => Promise<unknown>>();
let pillStyleListener: ((e: { payload: { style: string } }) => void) | null = null;

const mockEverything = () => {
  vi.doMock("@tauri-apps/api/core", () => ({
    invoke: (cmd: string, args?: Record<string, unknown>) => invokeMock(cmd, args),
  }));
  vi.doMock("@tauri-apps/api/webviewWindow", () => ({
    getCurrentWebviewWindow: () => ({ label: "main" }),
  }));
  vi.doMock("@tauri-apps/api/event", () => ({
    listen: (_name: string, cb: typeof pillStyleListener) => {
      pillStyleListener = cb;
      return Promise.resolve(() => {});
    },
    emit: vi.fn().mockResolvedValue(undefined),
  }));
  vi.doMock("@/lib/calendar/google-connect", () => ({
    reconnectGoogle: vi.fn(async () => ({ ok: true })),
  }));
  vi.doMock("@/contexts", () => ({
    useApp: () => ({
      customizable: { cursor: { type: "default" }, overlayPill: { style: "status-count" } },
      setOverlayPillStyle: vi.fn(),
    }),
  }));
  vi.doMock("@/lib", () => ({ getPlatform: () => "windows" }));
  vi.doMock("@/layouts", () => ({ ErrorLayout: () => null }));
  vi.doMock("@/components", () => ({
    Card: ({ children }: any) => <div data-testid="overlay-card">{children}</div>,
    Updater: () => null,
    DragButton: () => null,
    Button: ({ children, onClick, title, ...rest }: any) => (
      <button onClick={onClick} title={title} {...rest}>
        {children}
      </button>
    ),
    WingIcon: () => null,
  }));
  vi.doMock("@/hooks", async () => {
    const real = await import("@/hooks/useMeetingCardHost");
    return {
      useApp: () => ({ isHidden: false, systemAudio: { capturing: false, error: "" } }),
      useSetupStatus: () => ({
        isComplete: true,
        isLoading: false,
        aiConfigured: true,
        sttConfigured: true,
      }),
      useMeetingDetection: () => ({}),
      useTeamSync: () => {},
      useMeetingCardHost: real.useMeetingCardHost,
    };
  });
  vi.doMock("@/pages/app/components", async () => {
    const { MeetingCard } = await import("@/pages/app/components/MeetingCard");
    return {
      SystemAudio: () => null,
      Completion: () => null,
      AudioVisualizer: () => null,
      StatusIndicator: () => null,
      MinimizedPill: () => <div data-testid="minimized-pill-stub" />,
      MeetingCard,
    };
  });
  vi.doMock("react-error-boundary", () => ({
    ErrorBoundary: ({ children }: any) => <>{children}</>,
  }));
  vi.doMock("lucide-react", () => ({
    AlertCircle: () => null,
    Minimize2: () => null,
  }));
};

const calls = (cmd: string) => invokeMock.mock.calls.filter(([c]) => c === cmd);

// Fresh store instance per test (vi.resetModules), shared with the App import.
async function load() {
  mockEverything();
  const store = await import("@/lib/meeting-cards.store");
  const min = await import("@/lib/overlay-minimize.store");
  const { default: App } = await import("@/pages/app");
  const { useMeetingCardHost } = await import("@/hooks/useMeetingCardHost");
  store.resetMeetingCardsForTests();
  return { store, min, App, useMeetingCardHost };
}

const startRecording = (store: Awaited<ReturnType<typeof load>>["store"]) =>
  act(() => {
    store.autoRecordingStarted({ app: "google-meet", gated: false, stop: () => {} });
  });

const expandedHeight = (store: Awaited<ReturnType<typeof load>>["store"]) =>
  store.BAR_HEIGHT + store.CARD_GAP + store.cardHeight(store.getMeetingCard(), false);

beforeEach(() => {
  vi.resetModules();
  pillStyleListener = null;
  invokeMock.mockReset();
  invokeMock.mockResolvedValue(undefined);
});

afterEach(() => cleanup());

describe("host: the card resizes the window", () => {
  it("expanded: a card resizes the bar window to include it", async () => {
    const { store, useMeetingCardHost } = await load();
    renderHook(() => useMeetingCardHost("status-count"));
    startRecording(store);
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith(
        "set_window_height",
        expect.objectContaining({ height: expandedHeight(store) })
      )
    );
  });

  it("an amber error that grows the card re-sizes the window", async () => {
    const { store, useMeetingCardHost } = await load();
    renderHook(() => useMeetingCardHost("status-count"));
    act(() => store.showAmber({ variant: "reconnect", episode: 1 } as never));
    const before = expandedHeight(store);
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith(
        "set_window_height",
        expect.objectContaining({ height: before })
      )
    );
    invokeMock.mockClear();
    act(() => store.setAmberError("boom"));
    const after = expandedHeight(store);
    expect(after).toBeGreaterThan(before);
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith(
        "set_window_height",
        expect.objectContaining({ height: after })
      )
    );
  });

  it("a card while minimized restyles the pill and never resizes the bar", async () => {
    const { store, min, useMeetingCardHost } = await load();
    min.setMinimized(true);
    renderHook(() => useMeetingCardHost("status-count"));
    startRecording(store);
    const size = store.pillWindowSize("status-count", store.getMeetingCard());
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("minimize_overlay", { ...size, restyle: true })
    );
    expect(calls("set_window_height")).toHaveLength(0);
    expect(min.getMinimized()).toBe(true);
  });
});

describe("App: pill-size call sites are card-aware", () => {
  it("minimizing with a card up uses the card-aware size", async () => {
    const { store, App } = await load();
    render(
      <MemoryRouter>
        <App />
      </MemoryRouter>
    );
    startRecording(store);
    const size = store.pillWindowSize("status-count", store.getMeetingCard());
    invokeMock.mockClear();
    await userEvent.click(screen.getByTitle("Minimize"));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("minimize_overlay", { ...size, restyle: false })
    );
  });

  it("a pill style change with a card up uses the card-aware size", async () => {
    const { store, min, App } = await load();
    min.setMinimized(true);
    render(
      <MemoryRouter>
        <App />
      </MemoryRouter>
    );
    startRecording(store);
    await waitFor(() => expect(pillStyleListener).not.toBeNull());
    invokeMock.mockClear();
    act(() => pillStyleListener!({ payload: { style: "icon-only" } }));
    const size = store.pillWindowSize("icon-only", store.getMeetingCard());
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("minimize_overlay", { ...size, restyle: true })
    );
  });

  it("card change during restore does not restyle", async () => {
    const { store, min, App } = await load();
    const { resizeWindow, isAnyPopoverOpen } = await import("@/hooks/useWindow");
    min.setMinimized(true);
    render(
      <MemoryRouter>
        <App />
      </MemoryRouter>
    );
    let release!: () => void;
    invokeMock.mockImplementation((cmd) =>
      cmd === "restore_overlay"
        ? new Promise((resolve) => {
            release = () => resolve(undefined);
          })
        : Promise.resolve(undefined)
    );
    // MinimizedPill.handleExpand in its real order (the pill is a stub here).
    const expand = (async () => {
      await invokeMock("restore_overlay");
      act(() => min.setMinimized(false));
      await resizeWindow(isAnyPopoverOpen());
    })();
    startRecording(store);
    await waitFor(() => expect(calls("minimize_overlay").length).toBeGreaterThan(0));
    release();
    await expand;
    const restyles = calls("minimize_overlay").filter(([, a]) => a?.restyle === true);
    expect(restyles.length).toBeLessThanOrEqual(1);
    expect(invokeMock).toHaveBeenLastCalledWith(
      "set_window_height",
      expect.objectContaining({ height: expandedHeight(store) })
    );
  });
});
