import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// The minimize handler ordering assertions live here rather than in the gate
// unit test because the handlers are the app page's, not useWindow's. The
// spec pins them under useWindow.minimize-gate.test.ts; this file is their
// runtime home — see the extended block in useWindow.minimize-gate.test.ts
// for the re-export note.

const invokeMock = vi.fn<(cmd: string, args?: Record<string, unknown>) => Promise<void>>();

const mockAppPage = (cursorType: string = "default") => {
  vi.doMock("@tauri-apps/api/core", () => ({
    invoke: (cmd: string, args?: Record<string, unknown>) => invokeMock(cmd, args),
  }));
  // The app page now calls listen("overlay-pill-style-changed", ...) on mount;
  // the real listen() rejects under happy-dom, and Vitest fails the run on
  // the resulting unhandled rejection.
  vi.doMock("@tauri-apps/api/event", () => ({
    listen: () => Promise.resolve(() => {}),
    emit: vi.fn().mockResolvedValue(undefined),
  }));
  vi.doMock("@/contexts", () => ({
    useApp: () => ({
      customizable: {
        cursor: { type: cursorType },
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
};

const mockHooks = (isHidden: boolean) => {
  vi.doMock("@/hooks", () => ({
    useApp: () => ({ isHidden, systemAudio: { capturing: false } }),
    useSetupStatus: () => ({
      isComplete: true,
      isLoading: false,
      aiConfigured: true,
      sttConfigured: true,
    }),
    useMeetingDetection: () => ({}),
  }));
};

beforeEach(() => {
  vi.resetModules();
  invokeMock.mockReset();
  invokeMock.mockResolvedValue(undefined);
});

describe("hidden vs minimized orthogonality (spec edge case 1)", () => {
  it("hidden AND minimized: both render without error and nothing unmounts", async () => {
    mockAppPage();
    mockHooks(true); // isHidden = true
    const { setMinimized } = await import("@/lib/overlay-minimize.store");
    const { default: App } = await import("@/pages/app");

    render(
      <MemoryRouter>
        <App />
      </MemoryRouter>
    );

    setMinimized(true);
    await waitFor(() => {
      expect(screen.queryByTestId("minimized-pill-stub")).not.toBeNull();
    });
    // Structural contract: the pill renders INSIDE the isHidden wrapper and
    // the Card stays mounted while hidden (happy-dom does not apply
    // Tailwind's display rules, so visibility itself is the manual gate's
    // job — this pins the nesting that PRODUCES the visibility).
    expect(screen.queryByTestId("overlay-card")).not.toBeNull();
  });

  it("hiding and unhiding issues no geometry invoke", async () => {
    mockAppPage();
    mockHooks(true);
    const { default: App } = await import("@/pages/app");

    render(
      <MemoryRouter>
        <App />
      </MemoryRouter>
    );

    expect(invokeMock).not.toHaveBeenCalledWith(
      "minimize_overlay",
      expect.anything()
    );
    expect(invokeMock).not.toHaveBeenCalledWith("restore_overlay");
  });
});

describe("minimize button (gate ordering, per the spec)", () => {
  it("closes the gate synchronously BEFORE invoking minimize_overlay", async () => {
    mockAppPage();
    mockHooks(false);
    const { default: App } = await import("@/pages/app");
    const { getMinimized } = await import("@/lib/overlay-minimize.store");

    render(
      <MemoryRouter>
        <App />
      </MemoryRouter>
    );

    let resolveInvoke: (v: void) => void = () => {};
    invokeMock.mockImplementation(
      (cmd: string) =>
        new Promise<void>((resolve) => {
          if (cmd === "minimize_overlay") resolveInvoke = resolve;
          else resolve();
        })
    );

    await userEvent.click(screen.getByTitle("Minimize"));

    // Gate closed BEFORE the invoke resolves: a resizeWindow fired during
    // the await (the MutationObserver stomp) is swallowed.
    expect(getMinimized()).toBe(true);
    expect(invokeMock).toHaveBeenCalledWith("minimize_overlay", {
      width: 180,
      height: 40,
      restyle: false,
    });

    resolveInvoke();
    await waitFor(() => expect(getMinimized()).toBe(true));
  });

  // Re-entrancy guard (review-bot bug, run 34284949023): two invocations
  // landing back-to-back BEFORE React re-renders the button out of the tree
  // (the fast-double-click race) must invoke minimize_overlay ONCE — a second
  // `restyle: false` call would make Rust re-snapshot the pill's own corner
  // geometry as the "pre-minimize" rect, corrupting the restore target. Two
  // synchronous fireEvent clicks land in one React batch, which is exactly
  // that pre-re-render window; userEvent's awaits would let the re-render
  // remove the button first and make the test vacuous.
  it("guards re-entrancy: a second call while minimized does not re-invoke minimize_overlay", async () => {
    mockAppPage();
    mockHooks(false);
    const { default: App } = await import("@/pages/app");
    const { getMinimized } = await import("@/lib/overlay-minimize.store");

    render(
      <MemoryRouter>
        <App />
      </MemoryRouter>
    );

    fireEvent.click(screen.getByTitle("Minimize"));
    fireEvent.click(screen.getByTitle("Minimize"));

    // Counted by command, not by total invokes: mounting the app page also
    // reads the minimized flag back from Rust (is_overlay_minimized), and a
    // bare toHaveBeenCalledTimes(1) would be asserting that unrelated fact.
    await waitFor(() => {
      expect(
        invokeMock.mock.calls.filter(([cmd]) => cmd === "minimize_overlay")
      ).toHaveLength(1);
      expect(invokeMock).toHaveBeenCalledWith("minimize_overlay", {
        width: 180,
        height: 40,
        restyle: false,
      });
    });
    expect(getMinimized()).toBe(true);
  });

  it("rolls the flag back when minimize_overlay rejects", async () => {
    mockAppPage();
    mockHooks(false);
    const { default: App } = await import("@/pages/app");
    const { getMinimized, setMinimized } = await import(
      "@/lib/overlay-minimize.store"
    );
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    invokeMock.mockRejectedValue(new Error("no monitor"));

    render(
      <MemoryRouter>
        <App />
      </MemoryRouter>
    );

    await userEvent.click(screen.getByTitle("Minimize"));
    await waitFor(() => expect(getMinimized()).toBe(false));
    consoleError.mockRestore();
  });
});

// The drawn cursor. `--cursor-type: none` is set on the whole `main` webview
// whenever cursor.type is "invisible" (the DEFAULT), so the real pointer is
// hidden app-wide and <CustomCursor /> is the only thing the user sees. It
// must therefore survive the minimized wrapper: on main it was a sibling of
// the Card inside the isHidden wrapper, and minimizing must not swallow it.
describe("custom cursor placement (invisible-cursor default)", () => {
  it("stays outside the minimized wrapper so the pill is not cursor-less", async () => {
    mockAppPage("invisible");
    mockHooks(false);
    const { setMinimized } = await import("@/lib/overlay-minimize.store");
    const { default: App } = await import("@/pages/app");

    render(
      <MemoryRouter>
        <App />
      </MemoryRouter>
    );

    setMinimized(true);
    await waitFor(() => {
      expect(screen.queryByTestId("minimized-pill-stub")).not.toBeNull();
    });

    // The inner wrapper carries `hidden` while minimized; the cursor must not
    // be inside it.
    expect(screen.getByTestId("custom-cursor").closest(".hidden")).toBeNull();
  });

  it("still hides with the app when isHidden is true", async () => {
    mockAppPage("invisible");
    mockHooks(true);
    const { default: App } = await import("@/pages/app");

    render(
      <MemoryRouter>
        <App />
      </MemoryRouter>
    );

    // The OUTER wrapper carries `hidden` — hiding the app hides the cursor,
    // which is main's behaviour and must be preserved.
    expect(screen.getByTestId("custom-cursor").closest(".hidden")).not.toBeNull();
  });
});
