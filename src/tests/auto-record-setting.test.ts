import { describe, it, expect, beforeEach, vi } from "vitest";

const emit = vi.fn(async (..._a: unknown[]) => {});
const invoke = vi.fn(async (_cmd?: unknown, _args?: unknown) => undefined as unknown);

vi.mock("@tauri-apps/api/event", () => ({
  emit: (...a: Parameters<typeof emit>) => emit(...a),
  listen: vi.fn(async () => () => {}),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...a: Parameters<typeof invoke>) => invoke(...a),
}));

let platform: "windows" | "macos" | "linux" = "macos";
vi.mock("@/lib/platform", () => ({
  getPlatform: () => platform,
  isWindows: () => platform === "windows",
  isMacOS: () => platform === "macos",
  isLinux: () => platform === "linux",
}));

const requestMicAccess = vi.fn();
const requestSystemAudioAccess = vi.fn();
vi.mock("@/lib/mac-permissions", () => ({
  hasMicGrant: vi.fn(),
  requestMicAccess: (...a: unknown[]) => requestMicAccess(...a),
  requestSystemAudioAccess: (...a: unknown[]) => requestSystemAudioAccess(...a),
  openMicSettings: vi.fn(),
  openSystemAudioSettings: vi.fn(),
}));

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

import { announceAutoRecordSetting, turnOnAutoRecord } from "@/lib/auto-record-setting";
import { STORAGE_KEYS } from "@/config/constants";
import { MIC_DENIED_MESSAGE } from "@/lib/meeting-start-failure";

beforeEach(() => {
  stored = {};
  platform = "macos";
  emit.mockReset().mockResolvedValue(undefined);
  invoke.mockReset().mockResolvedValue(undefined);
  requestMicAccess.mockReset();
  requestSystemAudioAccess.mockReset();
});

describe("turnOnAutoRecord", () => {
  it("windows: saves true, emits, never asks for permissions", async () => {
    platform = "windows";
    expect(await turnOnAutoRecord()).toBeNull();
    expect(stored[STORAGE_KEYS.MEETING_AUTO_RECORD_ENABLED]).toBe("true");
    expect(emit).toHaveBeenCalledWith("meeting-detection-setting-changed", { enabled: true });
    expect(requestMicAccess).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("mac: probe, mic, system audio pass -> saves true and emits", async () => {
    invoke.mockResolvedValue([]);
    requestMicAccess.mockResolvedValue(true);
    requestSystemAudioAccess.mockResolvedValue(null);
    expect(await turnOnAutoRecord()).toBeNull();
    expect(invoke).toHaveBeenCalledWith("list_capture_sessions", expect.anything());
    expect(requestSystemAudioAccess).toHaveBeenCalledTimes(1);
    expect(stored[STORAGE_KEYS.MEETING_AUTO_RECORD_ENABLED]).toBe("true");
    expect(emit).toHaveBeenCalledWith("meeting-detection-setting-changed", { enabled: true });
  });

  it("mac: mic denied -> returns mic-denied, writes failure, saves and emits nothing", async () => {
    invoke.mockResolvedValue([]);
    requestMicAccess.mockResolvedValue(false);
    const f = await turnOnAutoRecord();
    expect(f).toEqual({ kind: "mic-denied", message: MIC_DENIED_MESSAGE });
    expect(JSON.parse(stored[STORAGE_KEYS.MEETING_AUTO_RECORD_START_FAILURE]).kind).toBe(
      "mic-denied"
    );
    expect(stored[STORAGE_KEYS.MEETING_AUTO_RECORD_ENABLED]).toBeUndefined();
    expect(emit).not.toHaveBeenCalled();
  });

  it("mac: a passing check clears an older start failure", async () => {
    stored[STORAGE_KEYS.MEETING_AUTO_RECORD_START_FAILURE] = JSON.stringify({
      kind: "mic-denied",
      message: MIC_DENIED_MESSAGE,
    });
    invoke.mockResolvedValue([]);
    requestMicAccess.mockResolvedValue(true);
    requestSystemAudioAccess.mockResolvedValue(null);
    await turnOnAutoRecord();
    expect(stored[STORAGE_KEYS.MEETING_AUTO_RECORD_START_FAILURE]).toBeUndefined();
  });
});

describe("announceAutoRecordSetting", () => {
  it("saves false and emits enabled:false", async () => {
    await announceAutoRecordSetting(false);
    expect(stored[STORAGE_KEYS.MEETING_AUTO_RECORD_ENABLED]).toBe("false");
    expect(emit).toHaveBeenCalledWith("meeting-detection-setting-changed", { enabled: false });
  });

  it("a rejected emit is logged, not thrown, and the setting is still saved", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    emit.mockRejectedValueOnce(new Error("no ipc"));
    await expect(announceAutoRecordSetting(true)).resolves.toBeUndefined();
    expect(stored[STORAGE_KEYS.MEETING_AUTO_RECORD_ENABLED]).toBe("true");
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});
