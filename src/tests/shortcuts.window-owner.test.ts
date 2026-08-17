import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke, windowLabel } = vi.hoisted(() => ({
  invoke: vi.fn(async () => undefined),
  windowLabel: { value: "main" },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ label: windowLabel.value }),
}));

const storedConfig = {
  bindings: { toggle_window: { key: "ctrl+backslash", enabled: true } },
  customActions: [],
};
vi.mock("@/lib/storage/shortcuts.storage", () => ({
  getShortcutsConfig: () => storedConfig,
}));

import { pushShortcutsConfig } from "@/lib/functions/shortcuts.function";

describe("pushShortcutsConfig", () => {
  beforeEach(() => {
    invoke.mockClear();
    windowLabel.value = "main";
  });

  it("pushes the stored config from the main window", async () => {
    await expect(pushShortcutsConfig()).resolves.toBe(true);

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("update_shortcuts", {
      config: storedConfig,
    });
  });

  // Shortcuts are registered process-wide, so a second window pushing the same
  // localStorage config just makes the Rust side unregister and re-register
  // every binding - a window where no shortcut is live.
  it("does not push from the dashboard window", async () => {
    windowLabel.value = "dashboard";

    await expect(pushShortcutsConfig()).resolves.toBe(false);

    expect(invoke).not.toHaveBeenCalled();
  });

  it("does not push from a capture overlay window", async () => {
    windowLabel.value = "capture-overlay-0";

    await expect(pushShortcutsConfig()).resolves.toBe(false);

    expect(invoke).not.toHaveBeenCalled();
  });

  it("reports failure instead of throwing when the command rejects", async () => {
    invoke.mockRejectedValueOnce(new Error("registration failed"));

    await expect(pushShortcutsConfig()).resolves.toBe(false);
  });
});
