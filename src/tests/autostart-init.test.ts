import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  label: "main",
  windows: true,
  enabled: true,
  enable: vi.fn(),
  disable: vi.fn(),
  isEnabled: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-autostart", () => ({
  enable: h.enable,
  disable: h.disable,
  isEnabled: h.isEnabled,
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ label: h.label }),
}));
vi.mock("@/lib/platform", () => ({ isWindows: () => h.windows }));

import { initializeAutostart } from "@/lib/autostart";
import { STORAGE_KEYS } from "@/config/constants";
import { installMemoryLocalStorage } from "./memory-local-storage";

let storage: Map<string, string>;

// Every negative test flips exactly one condition from this "would call" state.
beforeEach(() => {
  storage = installMemoryLocalStorage();
  storage.set(STORAGE_KEYS.AUTOSTART_INITIALIZED, "true");
  vi.stubEnv("PROD", true);
  h.label = "main";
  h.windows = true;
  h.enabled = true;
  h.enable.mockReset().mockResolvedValue(undefined);
  h.disable.mockReset().mockResolvedValue(undefined);
  h.isEnabled.mockReset().mockImplementation(async () => h.enabled);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("initializeAutostart: first launch", () => {
  it("applies the setting once and marks it initialized", async () => {
    storage.delete(STORAGE_KEYS.AUTOSTART_INITIALIZED);
    await initializeAutostart(true);
    expect(h.enable).toHaveBeenCalledTimes(1);
    expect(storage.get(STORAGE_KEYS.AUTOSTART_INITIALIZED)).toBe("true");

    storage.delete(STORAGE_KEYS.AUTOSTART_INITIALIZED);
    await initializeAutostart(false);
    expect(h.disable).toHaveBeenCalledTimes(1);
    expect(h.enable).toHaveBeenCalledTimes(1);
  });
});

describe("initializeAutostart: repoint the entry at the running exe (MSI -> NSIS)", () => {
  it("release build, Windows, main window, enabled: enable() once", async () => {
    await initializeAutostart(true);
    expect(h.enable).toHaveBeenCalledTimes(1);
    expect(h.disable).not.toHaveBeenCalled();
  });

  it("never enables an entry the user disabled", async () => {
    h.enabled = false;
    await initializeAutostart(true);
    expect(h.enable).not.toHaveBeenCalled();
  });

  it("not on macOS or Linux", async () => {
    h.windows = false;
    await initializeAutostart(true);
    expect(h.enable).not.toHaveBeenCalled();
  });

  it("not in a dev build (it would point startup at a debug binary)", async () => {
    vi.stubEnv("PROD", false);
    await initializeAutostart(true);
    expect(h.enable).not.toHaveBeenCalled();
  });

  it("only from the main window, so a dashboard opening does not repeat it", async () => {
    h.label = "dashboard";
    await initializeAutostart(true);
    expect(h.enable).not.toHaveBeenCalled();
  });

  it("swallows an autostart error", async () => {
    vi.spyOn(console, "debug").mockImplementation(() => {});
    h.isEnabled.mockRejectedValue(new Error("registry"));
    await expect(initializeAutostart(true)).resolves.toBeUndefined();
    expect(h.enable).not.toHaveBeenCalled();
  });
});
