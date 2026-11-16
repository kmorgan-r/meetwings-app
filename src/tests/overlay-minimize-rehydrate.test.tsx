import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// The minimized flag lives in a module variable, so anything that resets the
// webview's JS heap — a reload from the ErrorBoundary's retry button, a
// WebView2 renderer restart — used to drop it to false while the WINDOW was
// still the bottom-right pill. The Card then rendered inside pill geometry
// and the MutationObserver stretched it back to 600px from the corner
// anchor, hanging the drag handle and the minimize button off the right edge
// of the screen with no way to reach them. Rust keeps the flag now; these
// pin the mount-time rehydration that reads it back.

const invokeMock =
  vi.fn<(cmd: string, args?: Record<string, unknown>) => Promise<unknown>>();

const mockAppPage = () => {
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
    }),
  }));
  vi.doMock("@/lib", () => ({ getPlatform: () => "windows" }));
  vi.doMock("@/layouts", () => ({ ErrorLayout: () => null }));
  vi.doMock("@/components", () => ({
    Card: ({ children }: any) => <div data-testid="overlay-card">{children}</div>,
    Updater: () => null,
    DragButton: () => null,
    CustomCursor: () => <div data-testid="custom-cursor" />,
    Button: ({ children, onClick, title }: any) => (
      <button onClick={onClick} title={title}>
        {children}
      </button>
    ),
    WingIcon: () => null,
  }));
  vi.doMock("@/pages/app/components", () => ({
    SystemAudio: () => null,
    Completion: () => <div data-testid="completion-stub" />,
    AudioVisualizer: () => null,
    StatusIndicator: () => null,
    MinimizedPill: () => <div data-testid="minimized-pill-stub" />,
  }));
  vi.doMock("react-error-boundary", () => ({
    ErrorBoundary: ({ children }: any) => <>{children}</>,
  }));
  vi.doMock("lucide-react", () => ({
    AlertCircle: () => null,
    Minimize2: () => null,
  }));
  vi.doMock("@/hooks", () => ({
    useApp: () => ({ isHidden: false, systemAudio: { capturing: false } }),
    useSetupStatus: () => ({
      isComplete: true,
      isLoading: false,
      aiConfigured: true,
      sttConfigured: true,
    }),
    useMeetingDetection: () => ({}),
    useSilentUpdater: () => {},
    useMeetingCardHost: () => null,
  }));
};

const renderApp = async () => {
  const { default: App } = await import("@/pages/app");
  render(
    <MemoryRouter>
      <App />
    </MemoryRouter>
  );
};

beforeEach(async () => {
  vi.resetModules();
  invokeMock.mockReset();
  invokeMock.mockResolvedValue(undefined);
  // The flag is module state and vi.resetModules() gives every test a fresh
  // copy, but the body attribute it writes is real DOM and outlives the reset.
  document.body.removeAttribute("data-overlay-minimized");
});

describe("minimized state rehydration on mount", () => {
  it("renders the pill when Rust reports the window is still minimized", async () => {
    mockAppPage();
    invokeMock.mockImplementation((cmd) =>
      cmd === "is_overlay_minimized"
        ? Promise.resolve(true)
        : Promise.resolve(undefined)
    );

    await renderApp();

    await waitFor(() => {
      expect(screen.queryByTestId("minimized-pill-stub")).not.toBeNull();
    });
    const { getMinimized } = await import("@/lib/overlay-minimize.store");
    expect(getMinimized()).toBe(true);
  });

  it("stays expanded when Rust reports the window is not minimized", async () => {
    mockAppPage();
    invokeMock.mockImplementation((cmd) =>
      cmd === "is_overlay_minimized"
        ? Promise.resolve(false)
        : Promise.resolve(undefined)
    );

    await renderApp();

    await waitFor(() => {
      expect(
        invokeMock.mock.calls.some(([cmd]) => cmd === "is_overlay_minimized")
      ).toBe(true);
    });
    expect(screen.queryByTestId("minimized-pill-stub")).toBeNull();
    expect(screen.queryByTestId("overlay-card")).not.toBeNull();
  });

  it("leaves the overlay expanded when the query fails, and does not throw", async () => {
    mockAppPage();
    invokeMock.mockImplementation((cmd) =>
      cmd === "is_overlay_minimized"
        ? Promise.reject(new Error("no such command"))
        : Promise.resolve(undefined)
    );
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    await renderApp();

    await waitFor(() => {
      expect(consoleError).toHaveBeenCalled();
    });
    expect(screen.queryByTestId("minimized-pill-stub")).toBeNull();
    const { getMinimized } = await import("@/lib/overlay-minimize.store");
    expect(getMinimized()).toBe(false);
    consoleError.mockRestore();
  });

  it("does not re-minimize: rehydration only ever restyles, never re-snapshots", async () => {
    mockAppPage();
    invokeMock.mockImplementation((cmd) =>
      cmd === "is_overlay_minimized"
        ? Promise.resolve(true)
        : Promise.resolve(undefined)
    );

    await renderApp();

    await waitFor(() => {
      expect(screen.queryByTestId("minimized-pill-stub")).not.toBeNull();
    });
    const calls = invokeMock.mock.calls.filter(
      ([cmd]) => cmd === "minimize_overlay"
    );
    expect(calls.length).toBeGreaterThan(0);
    for (const [, args] of calls) expect(args?.restyle).toBe(true);
  });

  it("a minimized rehydrate restyles the window to the plain pill size of the STORED style", async () => {
    // The reload emptied the card store, but the window kept its card-aware size.
    // The context mock still reports the provider's pre-load default
    // (status-count); the stored style is what the user picked.
    // setup.ts replaces localStorage with no-op vi.fn()s; answer the read.
    const { STORAGE_KEYS } = await import("@/config/constants");
    vi.mocked(localStorage.getItem).mockImplementation((k: string) =>
      k === STORAGE_KEYS.CUSTOMIZABLE
        ? JSON.stringify({ overlayPill: { style: "icon-only" } })
        : null
    );
    mockAppPage();
    invokeMock.mockImplementation((cmd) =>
      cmd === "is_overlay_minimized"
        ? Promise.resolve(true)
        : Promise.resolve(undefined)
    );

    try {
      await renderApp();

      const { PILL_DIMENSIONS } = await import("@/lib/overlay-minimize.store");
      await waitFor(() => {
        expect(invokeMock).toHaveBeenCalledWith("minimize_overlay", {
          ...PILL_DIMENSIONS["icon-only"],
          restyle: true,
        });
      });
    } finally {
      vi.mocked(localStorage.getItem).mockReset();
    }
  });

  it("an expanded rehydrate does not touch the window size", async () => {
    mockAppPage();
    invokeMock.mockImplementation((cmd) =>
      cmd === "is_overlay_minimized"
        ? Promise.resolve(false)
        : Promise.resolve(undefined)
    );

    await renderApp();
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("is_overlay_minimized", undefined);
    });
    expect(
      invokeMock.mock.calls.filter(([cmd]) => cmd === "minimize_overlay")
    ).toHaveLength(0);
  });
});
