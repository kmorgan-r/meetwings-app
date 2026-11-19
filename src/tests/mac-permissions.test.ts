import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const checkMicrophonePermission = vi.fn(async () => true);
const invoke = vi.fn(async (_cmd?: unknown, _args?: unknown) => undefined as unknown);

vi.mock("tauri-plugin-macos-permissions-api", () => ({
  checkMicrophonePermission: (...a: Parameters<typeof checkMicrophonePermission>) =>
    checkMicrophonePermission(...a),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...a: Parameters<typeof invoke>) => invoke(...a),
}));

import {
  hasMicGrant,
  requestMicAccess,
  requestSystemAudioAccess,
  openMicSettings,
  openSystemAudioSettings,
} from "@/lib/mac-permissions";

const setMediaDevices = (value: MediaDevices | undefined) => {
  Object.defineProperty(globalThis.navigator, "mediaDevices", {
    value,
    configurable: true,
  });
};
const originalMediaDevices = globalThis.navigator.mediaDevices;

type GetUserMedia = (constraints: MediaStreamConstraints) => Promise<MediaStream>;

const setGetUserMedia = (mock: ReturnType<typeof vi.fn>) => {
  if (!globalThis.navigator.mediaDevices) {
    setMediaDevices({
      getUserMedia: () => Promise.reject(new DOMException("no", "NotSupportedError")),
    } as unknown as MediaDevices);
  }
  (globalThis.navigator.mediaDevices as { getUserMedia: GetUserMedia }).getUserMedia =
    mock as unknown as GetUserMedia;
};

beforeEach(() => {
  checkMicrophonePermission.mockReset();
  checkMicrophonePermission.mockResolvedValue(true);
  invoke.mockReset();
  invoke.mockResolvedValue(undefined);
  setGetUserMedia(vi.fn());
});

afterEach(() => {
  setMediaDevices(originalMediaDevices);
});

describe("requestMicAccess", () => {
  it("resolves true and stops every track", async () => {
    const stop1 = vi.fn();
    const stop2 = vi.fn();
    setGetUserMedia(
      vi.fn(async () =>
        ({ getTracks: () => [{ stop: stop1 }, { stop: stop2 }] }) as unknown as MediaStream
      )
    );

    await expect(requestMicAccess()).resolves.toBe(true);
    expect(stop1).toHaveBeenCalledTimes(1);
    expect(stop2).toHaveBeenCalledTimes(1);
  });

  it("resolves false on NotAllowedError", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    setGetUserMedia(
      vi.fn(async () => {
        throw new DOMException("denied", "NotAllowedError");
      })
    );

    await expect(requestMicAccess()).resolves.toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("resolves false on NotFoundError", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    setGetUserMedia(
      vi.fn(async () => {
        throw new DOMException("no mic", "NotFoundError");
      })
    );

    await expect(requestMicAccess()).resolves.toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("resolves false when mediaDevices is missing", async () => {
    setMediaDevices(undefined);

    await expect(requestMicAccess()).resolves.toBe(false);
  });
});

describe("hasMicGrant", () => {
  it("returns the plugin's true", async () => {
    checkMicrophonePermission.mockResolvedValue(true);
    await expect(hasMicGrant()).resolves.toBe(true);
  });

  it("returns the plugin's false", async () => {
    checkMicrophonePermission.mockResolvedValue(false);
    await expect(hasMicGrant()).resolves.toBe(false);
  });

  it("fails open with a warning when the plugin throws", async () => {
    checkMicrophonePermission.mockRejectedValue(new Error("plugin blew up"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(hasMicGrant()).resolves.toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

describe("requestSystemAudioAccess", () => {
  it("invokes prime_system_audio_access and resolves null on success", async () => {
    await expect(requestSystemAudioAccess()).resolves.toBeNull();
    expect(invoke).toHaveBeenCalledWith("prime_system_audio_access");
  });

  it("resolves the rejection detail", async () => {
    invoke.mockRejectedValue("no output device");

    await expect(requestSystemAudioAccess()).resolves.toBe("no output device");
  });
});

describe("openMicSettings", () => {
  it("invokes open_microphone_settings", async () => {
    await openMicSettings();
    expect(invoke).toHaveBeenCalledWith("open_microphone_settings");
  });
});

describe("openSystemAudioSettings", () => {
  it("invokes request_system_audio_access", async () => {
    await openSystemAudioSettings();
    expect(invoke).toHaveBeenCalledWith("request_system_audio_access");
  });
});
