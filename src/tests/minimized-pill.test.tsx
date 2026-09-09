import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

const invokeMock = vi.fn<(cmd: string, args?: Record<string, unknown>) => Promise<void>>();
vi.mock("@tauri-apps/api/core", () => ({
  // Spread, not (cmd, args) => invokeMock(cmd, args): a named args parameter
  // records [cmd, undefined] even when the caller passed no second argument,
  // which breaks toHaveBeenCalledWith("restore_overlay") arity matching.
  invoke: (...args: [string, Record<string, unknown>?]) => invokeMock(...args),
}));
// The restore sequence ends with resizeWindow(isAnyPopoverOpen()), which calls
// getCurrentWebviewWindow() before its invoke; without this mock that throws
// (no __TAURI_INTERNALS__ under happy-dom) and set_window_height never fires —
// the stale-rect regression below asserts on exactly that invoke.
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({ label: "main" }),
}));

import { MinimizedPill } from "@/pages/app/components/MinimizedPill";
import {
  getPillData,
  setMinimized,
  setPillActions,
  setPillData,
} from "@/lib/overlay-minimize.store";

describe("MinimizedPill", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
    setMinimized(true); // the pill only ever renders while minimized
    setPillData({ segmentCount: 0, lastLine: "", status: "idle", recording: false });
    setPillActions({ toggleRecording: null });
  });

  it.each([
    ["status-count", "Status and count"],
    ["icon-only", "Icon only"],
    ["status-last-line", "Status and last line"],
  ] as const)("renders the %s variant", (style) => {
    render(
      <MemoryRouter>
        <MinimizedPill style={style} />
      </MemoryRouter>
    );
    expect(screen.getByRole("button", { name: /expand/i })).not.toBeNull();
  });

  it("shows the segment count in the status-count variant", () => {
    setPillData({
      segmentCount: 42,
      lastLine: "hello",
      status: "capturing",
      recording: true,
    });
    render(
      <MemoryRouter>
        <MinimizedPill style="status-count" />
      </MemoryRouter>
    );
    expect(screen.getByText(/42/)).not.toBeNull();
  });

  it("shows the last transcript line (truncated) in the status-last-line variant", () => {
    setPillData({
      segmentCount: 1,
      lastLine: "the quick brown fox",
      status: "capturing",
      recording: true,
    });
    render(
      <MemoryRouter>
        <MinimizedPill style="status-last-line" />
      </MemoryRouter>
    );
    expect(screen.getByText(/the quick brown fox/)).not.toBeNull();
  });

  it("clicking invokes restore_overlay, and clears the flag only AFTER the invoke resolves", async () => {
    let resolveInvoke: (value: void) => void = () => {};
    invokeMock.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveInvoke = resolve;
      })
    );

    render(
      <MemoryRouter>
        <MinimizedPill style="status-count" />
      </MemoryRouter>
    );

    await userEvent.click(screen.getByRole("button", { name: /expand/i }));

    // Invoke fired, but the gate is still closed while the window is
    // pill-sized — the flag must not clear early.
    expect(invokeMock).toHaveBeenCalledWith("restore_overlay");
    expect(getPillData()).not.toBeNull(); // sanity: store alive
    expect(document.body.hasAttribute("data-overlay-minimized")).toBe(true);

    resolveInvoke();
    await waitFor(() => {
      expect(document.body.hasAttribute("data-overlay-minimized")).toBe(false);
    });
  });

  it("keeps the flag set (pill stays) when restore_overlay rejects", async () => {
    invokeMock.mockRejectedValue(new Error("no monitor"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    render(
      <MemoryRouter>
        <MinimizedPill style="status-count" />
      </MemoryRouter>
    );

    await userEvent.click(screen.getByRole("button", { name: /expand/i }));
    await waitFor(() => {
      expect(document.body.hasAttribute("data-overlay-minimized")).toBe(true);
    });
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  // The spec's stale-rect regression, pinned under useWindow.minimize-gate
  // but exercised here because it needs the pill's real click handler: a
  // popover that opens WHILE minimized must leave the restored window at
  // 600, not the minimize-time 54 — resizeWindow(isAnyPopoverOpen()) must
  // re-derive the height from the CURRENT popover state.
  it("restore re-derives the height: popover open while minimized ends at 600, not 54", async () => {
    render(
      <MemoryRouter>
        <MinimizedPill style="status-count" />
      </MemoryRouter>
    );

    // A transcript segment arrives while minimized: the Radix portal appears
    // in the DOM (CSS-hidden in production, present to isAnyPopoverOpen()).
    const portal = document.createElement("div");
    portal.setAttribute("data-radix-popper-content-wrapper", "");
    document.body.appendChild(portal);

    await userEvent.click(screen.getByRole("button", { name: /expand/i }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("set_window_height", {
        window: expect.objectContaining({ label: "main" }),
        height: 600,
      });
    });
    const collapsed = invokeMock.mock.calls.filter(
      ([cmd, args]) => cmd === "set_window_height" && (args as { height: number }).height === 54
    );
    expect(collapsed).toEqual([]);
    portal.remove();
  });

  describe("record button", () => {
    it("is absent while no toggle is registered - <Completion /> is the only writer", () => {
      render(
        <MemoryRouter>
          <MinimizedPill style="status-count" />
        </MemoryRouter>
      );
      expect(screen.queryByRole("button", { name: /recording/i })).toBeNull();
      expect(screen.getByRole("button", { name: /expand/i })).not.toBeNull();
    });

    it.each([
      ["status-count"],
      ["icon-only"],
      ["status-last-line"],
    ] as const)("renders beside the expand button in the %s variant", (style) => {
      setPillActions({ toggleRecording: vi.fn() });
      render(
        <MemoryRouter>
          <MinimizedPill style={style} />
        </MemoryRouter>
      );

      const record = screen.getByRole("button", { name: /start meeting recording/i });
      const expand = screen.getByRole("button", { name: /expand/i });
      // SIBLINGS, not nested: a <button> inside a <button> is invalid HTML and
      // the inner click target stops being reliable.
      expect(record.contains(expand)).toBe(false);
      expect(expand.contains(record)).toBe(false);
    });

    it("clicking calls the registered toggle, and does NOT expand the overlay", async () => {
      const toggleRecording = vi.fn();
      setPillActions({ toggleRecording });
      render(
        <MemoryRouter>
          <MinimizedPill style="status-count" />
        </MemoryRouter>
      );

      await userEvent.click(
        screen.getByRole("button", { name: /start meeting recording/i })
      );

      expect(toggleRecording).toHaveBeenCalledTimes(1);
      expect(invokeMock).not.toHaveBeenCalledWith("restore_overlay");
      expect(document.body.hasAttribute("data-overlay-minimized")).toBe(true);
    });

    it("reads as Stop while recording", () => {
      setPillActions({ toggleRecording: vi.fn() });
      setPillData({
        segmentCount: 3,
        lastLine: "hello",
        status: "capturing",
        recording: true,
      });
      render(
        <MemoryRouter>
          <MinimizedPill style="status-count" />
        </MemoryRouter>
      );

      expect(
        screen.getByRole("button", { name: /stop meeting recording/i })
      ).not.toBeNull();
      expect(
        screen.queryByRole("button", { name: /start meeting recording/i })
      ).toBeNull();
    });

    it("hides the divider until a record button exists", () => {
      render(
        <MemoryRouter>
          <MinimizedPill style="status-count" />
        </MemoryRouter>
      );
      expect(screen.queryByTestId("pill-divider")).toBeNull();
    });

    it("renders the divider that tells the user the pill is two targets", () => {
      setPillActions({ toggleRecording: vi.fn() });
      render(
        <MemoryRouter>
          <MinimizedPill style="status-count" />
        </MemoryRouter>
      );

      const divider = screen.getByTestId("pill-divider");
      expect(divider.getAttribute("aria-hidden")).toBe("true");
      // Invisible at rest, revealed on pill hover - a permanently visible
      // separator would make the resting pill read as two chips.
      expect(divider.className).toContain("opacity-0");
      expect(divider.className).toContain("group-hover/pill:opacity-100");
    });

    it("keeps the hook classes the cross-zone dimming selectors depend on", () => {
      setPillActions({ toggleRecording: vi.fn() });
      render(
        <MemoryRouter>
          <MinimizedPill style="status-count" />
        </MemoryRouter>
      );

      const expand = screen.getByRole("button", { name: /expand/i });
      const record = screen.getByRole("button", { name: /start meeting recording/i });

      // Renaming either class silently kills the "dim the other zone" half of
      // the hover treatment - nothing else in the tree would fail.
      expect(expand.className).toContain("pill-expand");
      expect(record.className).toContain("pill-record");
      expect(expand.className).toContain("group-has-[.pill-record:hover]/pill:opacity-55");
      expect(record.className).toContain("group-has-[.pill-expand:hover]/pill:opacity-55");
    });

    it("separates the two zones by hue, and never by --accent", () => {
      setPillActions({ toggleRecording: vi.fn() });
      render(
        <MemoryRouter>
          <MinimizedPill style="status-count" />
        </MemoryRouter>
      );

      const expand = screen.getByRole("button", { name: /expand/i });
      const record = screen.getByRole("button", { name: /start meeting recording/i });

      expect(expand.className).toContain("hover:bg-foreground/10");
      expect(record.className).toContain("hover:bg-red-500/15");
      // The regression this guards: bg-accent over bg-card is a 3% lightness
      // delta in light mode (global.css:49,59) - a hover state you cannot see.
      expect(expand.className).not.toContain("accent");
      expect(record.className).not.toContain("accent");
    });

    it("is reachable by keyboard - both zones take a visible focus ring", () => {
      setPillActions({ toggleRecording: vi.fn() });
      render(
        <MemoryRouter>
          <MinimizedPill style="status-count" />
        </MemoryRouter>
      );

      for (const name of [/expand/i, /start meeting recording/i]) {
        const button = screen.getByRole("button", { name });
        expect(button.className).toContain("focus-visible:ring-2");
        expect(button.className).toContain("focus-visible:ring-inset");
      }
    });

    it("re-registering a new toggle re-points the button", async () => {
      const first = vi.fn();
      const second = vi.fn();
      setPillActions({ toggleRecording: first });
      const { rerender } = render(
        <MemoryRouter>
          <MinimizedPill style="status-count" />
        </MemoryRouter>
      );

      // act(): setPillActions notifies the pill's useSyncExternalStore, which
      // is a React state update from outside React's own event handling.
      act(() => setPillActions({ toggleRecording: second }));
      rerender(
        <MemoryRouter>
          <MinimizedPill style="status-count" />
        </MemoryRouter>
      );

      await userEvent.click(
        screen.getByRole("button", { name: /start meeting recording/i })
      );
      expect(first).not.toHaveBeenCalled();
      expect(second).toHaveBeenCalledTimes(1);
    });
  });
});
