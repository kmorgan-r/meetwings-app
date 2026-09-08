import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("@/layouts", () => ({
  PageLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

// Sibling toggles are stubbed, and the toggle under test is replaced by a
// marker stub (the real one calls useApp, which needs an AppProvider). The
// page's own behaviour is only "does it mount ContentProtectionToggle"; the
// component itself is covered by content-protection-toggle.test.tsx.
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
    MeetingAutoRecordToggle: Stub,
    // The real selector calls useApp, which throws outside an AppProvider -
    // same reason Theme and the other siblings above are stubbed.
    OverlayPillStyleSelect: Stub,
    ContentProtectionToggle: () => (
      <div aria-label="Toggle screen capture protection" />
    ),
  };
});

// PageLayout is stubbed but the page itself imports isWindows via @/lib/platform.
vi.mock("@/lib/platform", () => ({
  isWindows: () => true,
  isMacOS: () => false,
  isLinux: () => false,
  getPlatform: () => "windows",
}));

import Settings from "@/pages/settings";

describe("settings page content protection", () => {
  it("renders the Screen Capture Protection toggle", () => {
    render(<Settings />);
    expect(
      screen.queryByLabelText(/screen capture protection/i)
    ).not.toBeNull();
  });
});