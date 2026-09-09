import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

let stored: Record<string, string> = {};
vi.mock("@/lib", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    safeLocalStorage: {
      getItem: (k: string) => stored[k] ?? null,
      setItem: (k: string, v: string) => {
        stored[k] = v;
      },
      removeItem: (k: string) => {
        delete stored[k];
      },
    },
  };
});

vi.mock("@/layouts", () => ({
  PageLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/lib/platform", () => ({
  isWindows: () => true,
  isMacOS: () => false,
  isLinux: () => false,
  getPlatform: () => "windows",
}));

// Sibling settings sections are stubbed; the selector under test stays real.
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
    ContentProtectionToggle: Stub,
    MeetingAutoRecordToggle: Stub,
  };
});

// The real selector calls useApp() — without a contexts mock (or an
// AppProvider wrap) `customizable` is undefined and it crashes on
// `customizable.overlayPill.style` before the assertion can run.
vi.mock("@/contexts", () => ({
  useApp: () => ({
    customizable: { overlayPill: { style: "status-count" } },
    setOverlayPillStyle: vi.fn(),
  }),
}));

import Settings from "@/pages/settings";

describe("settings page renders the overlay pill style selector", () => {
  it("mounts OverlayPillStyleSelect", () => {
    render(
      <MemoryRouter>
        <Settings />
      </MemoryRouter>
    );
    expect(
      screen.queryByText(/minimized pill style/i)
    ).not.toBeNull();
  });
});

describe("OverlayPillStyleSelect writes storage and announces the change", () => {
  const setOverlayPillStyle = vi.fn();
  let currentStyle = "status-count";

  beforeEach(async () => {
    vi.resetModules();
    // happy-dom does not implement the pointer-capture API Radix Select's
    // item pointerdown handler requires (`target.hasPointerCapture is not a
    // function` mid-dispatch leaves the dropdown closed, so no option is ever
    // rendered to click). Stub the three capture methods the handler touches.
    Element.prototype.hasPointerCapture = () => false;
    Element.prototype.setPointerCapture = () => {};
    Element.prototype.releasePointerCapture = () => {};
    stored = {};
    setOverlayPillStyle.mockClear();
    // The storage module writes through the GLOBAL localStorage (the
    // @/lib safeLocalStorage mock above does not intercept it), and setup.ts
    // leaves that as bare vi.fn()s — wire them to the `stored` map so the
    // round-trip is real, exactly like customizable.storage.test.ts does.
    vi.mocked(localStorage.getItem).mockImplementation(
      (k: string) => stored[k] ?? null
    );
    vi.mocked(localStorage.setItem).mockImplementation(
      (k: string, v: string) => {
        stored[k] = v;
      }
    );
    // ESM: no `require`. Capture the real writer through a dynamic import so
    // the context-setter mock routes at it — a real round-trip, not a mock
    // calling a mock.
    const { updateOverlayPillStyle } = await import(
      "@/lib/storage/customizable.storage"
    );
    setOverlayPillStyle.mockImplementation((style: string) => {
      updateOverlayPillStyle(style as never);
      currentStyle = style;
    });
  });

  it("calls setOverlayPillStyle and emits overlay-pill-style-changed on change", async () => {
    const emitMock = vi.fn().mockResolvedValue(undefined);
    const listenMock = vi.fn().mockResolvedValue(() => {});
    vi.doMock("@tauri-apps/api/event", () => ({
      emit: emitMock,
      listen: listenMock,
    }));
    vi.doMock("@/contexts", () => ({
      useApp: () => ({
        customizable: { overlayPill: { style: currentStyle } },
        setOverlayPillStyle,
      }),
    }));

    const { OverlayPillStyleSelect } = await import(
      "@/pages/settings/components/OverlayPillStyleSelect"
    );
    render(
      <MemoryRouter>
        <OverlayPillStyleSelect />
      </MemoryRouter>
    );

    await userEvent.click(screen.getByRole("combobox"));
    await userEvent.click(await screen.findByRole("option", { name: /icon only/i }));

    await waitFor(() => {
      expect(setOverlayPillStyle).toHaveBeenCalledWith("icon-only");
      expect(emitMock).toHaveBeenCalledWith("overlay-pill-style-changed", {
        style: "icon-only",
      });
    });
    // The storage round-trip wrote the new style under the CUSTOMIZABLE key.
    expect(JSON.parse(stored["customizable"]).overlayPill.style).toBe("icon-only");
  });
});

describe("main window listens for overlay-pill-style-changed", () => {
  const invokeMock = vi.fn<(cmd: string, args?: Record<string, unknown>) => Promise<void>>();
  let listeners = new Map<string, Array<(e: { payload: unknown }) => void>>();

  beforeEach(() => {
    vi.resetModules();
    listeners = new Map();
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
  });

  it("re-invokes minimize_overlay with the new style's dims ONLY when minimized", async () => {
    vi.doMock("@tauri-apps/api/core", () => ({
      invoke: (cmd: string, args?: Record<string, unknown>) => invokeMock(cmd, args),
    }));
    vi.doMock("@tauri-apps/api/event", () => ({
      emit: vi.fn().mockResolvedValue(undefined),
      listen: (event: string, handler: (e: { payload: unknown }) => void) => {
        if (!listeners.has(event)) listeners.set(event, []);
        listeners.get(event)!.push(handler);
        return Promise.resolve(() => {});
      },
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
      Card: ({ children }: any) => <div>{children}</div>,
      Updater: () => null,
      DragButton: () => null,
      CustomCursor: () => null,
      Button: ({ children, onClick, title }: any) => (
        <button onClick={onClick} title={title}>
          {children}
        </button>
      ),
      WingIcon: () => null,
    }));
    vi.doMock("@/pages/app/components", () => ({
      SystemAudio: () => null,
      Completion: () => null,
      AudioVisualizer: () => null,
      StatusIndicator: () => null,
      MinimizedPill: () => null,
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
    }));
    vi.doMock("react-error-boundary", () => ({
      ErrorBoundary: ({ children }: any) => <>{children}</>,
    }));
    vi.doMock("lucide-react", () => ({
      AlertCircle: () => null,
      Minimize2: () => null,
    }));

    const { setMinimized } = await import("@/lib/overlay-minimize.store");
    const { default: App } = await import("@/pages/app");

    const { unmount } = render(
      <MemoryRouter>
        <App />
      </MemoryRouter>
    );

    // NOT minimized: the event must be a geometry no-op.
    listeners.get("overlay-pill-style-changed")!.forEach((cb) =>
      cb({ payload: { style: "icon-only" } })
    );
    await vi.waitFor(() => {
      // The listener still synced the context state (a pure no-op here), but
      // NO geometry invoke may fire.
      expect(invokeMock).not.toHaveBeenCalledWith(
        "minimize_overlay",
        expect.anything()
      );
    });

    // Minimized: the SAME event re-invokes minimize_overlay as a restyle with
    // the new style's dimensions.
    setMinimized(true);
    listeners.get("overlay-pill-style-changed")!.forEach((cb) =>
      cb({ payload: { style: "icon-only" } })
    );
    await vi.waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("minimize_overlay", {
        width: 84,
        height: 52,
        restyle: true,
      });
    });

    // The remaining two style->dimension mappings (the spec requires all
    // three; icon-only ran above):
    listeners.get("overlay-pill-style-changed")!.forEach((cb) =>
      cb({ payload: { style: "status-last-line" } })
    );
    await vi.waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("minimize_overlay", {
        width: 352,
        height: 48,
        restyle: true,
      });
    });
    listeners.get("overlay-pill-style-changed")!.forEach((cb) =>
      cb({ payload: { style: "status-count" } })
    );
    await vi.waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("minimize_overlay", {
        width: 180,
        height: 40,
        restyle: true,
      });
    });

    unmount();
  });
});