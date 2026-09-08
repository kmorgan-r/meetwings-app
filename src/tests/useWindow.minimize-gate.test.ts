import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The gate reads the flag directly from the store module; mocking the module
// keeps these tests pure unit tests of the gate, independent of the store's
// own (separately tested) behavior.
const getMinimizedMock = vi.fn<() => boolean>();
vi.mock("@/lib/overlay-minimize.store", () => ({
  getMinimized: () => getMinimizedMock(),
}));

const invokeMock = vi.fn<(args: Record<string, unknown>) => Promise<void>>();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: Record<string, unknown>) =>
    invokeMock({ cmd, ...args }),
}));

// resizeWindow calls getCurrentWebviewWindow() BEFORE the invoke; under
// happy-dom there is no __TAURI_INTERNALS__, so the real module throws inside
// the try block and the invoke is never reached. Without this mock the three
// positive-path tests fail even against a correct implementation.
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({ label: "main" }),
}));

import { isAnyPopoverOpen, resizeWindow } from "@/hooks/useWindow";

const flush = async () => {
  await vi.waitFor(() => expect(invokeMock).toHaveBeenCalled());
};

describe("resizeWindow minimize gate", () => {
  beforeEach(() => {
    getMinimizedMock.mockReturnValue(false);
    invokeMock.mockClear();
    invokeMock.mockResolvedValue(undefined);
  });

  it("invokes set_window_height(600) when expanded and not minimized", async () => {
    await resizeWindow(true);
    expect(invokeMock).toHaveBeenCalledWith(
      expect.objectContaining({ cmd: "set_window_height", height: 600 })
    );
  });

  it("invokes set_window_height(54) when collapsed and no popover is open", async () => {
    await resizeWindow(false);
    expect(invokeMock).toHaveBeenCalledWith(
      expect.objectContaining({ cmd: "set_window_height", height: 54 })
    );
  });

  it("no-ops on resizeWindow(false) while minimized (the MutationObserver stomp)", async () => {
    getMinimizedMock.mockReturnValue(true);
    await resizeWindow(false);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("no-ops on resizeWindow(true) while minimized (a popover opening must not un-minimize)", async () => {
    getMinimizedMock.mockReturnValue(true);
    await resizeWindow(true);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("resumes both directions once the gate clears", async () => {
    getMinimizedMock.mockReturnValue(true);
    await resizeWindow(true);
    expect(invokeMock).not.toHaveBeenCalled();

    getMinimizedMock.mockReturnValue(false);
    await resizeWindow(true);
    await resizeWindow(false);
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });

  it("exports isAnyPopoverOpen (the restore step needs it)", () => {
    expect(typeof isAnyPopoverOpen).toBe("function");
    // No popovers in the test DOM: false.
    expect(isAnyPopoverOpen()).toBe(false);
  });
});