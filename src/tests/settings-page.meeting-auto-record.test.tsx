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

describe("settings page meeting detection gate", () => {
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

    const { default: App } = await import("@/pages/app");
    render(
      <MemoryRouter>
        <App />
      </MemoryRouter>
    );

    expect(useMeetingDetection).toHaveBeenCalled();
  });
});
