import { describe, it, expect, vi, beforeEach } from "vitest";

const invoke = vi.fn(async (_cmd?: unknown, _args?: unknown) => undefined as unknown);
const requestMicAccess = vi.fn(async () => true);
const requestSystemAudioAccess = vi.fn(async () => null as string | null);

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...a: Parameters<typeof invoke>) => invoke(...a),
}));
vi.mock("@/lib/mac-permissions", () => ({
  requestMicAccess: (...a: Parameters<typeof requestMicAccess>) => requestMicAccess(...a),
  requestSystemAudioAccess: (...a: Parameters<typeof requestSystemAudioAccess>) =>
    requestSystemAudioAccess(...a),
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

import type { StartFailure } from "@/lib/meeting-start-failure";
import {
  readStartFailure,
  writeStartFailure,
  clearStartFailure,
  MicGrantMissingError,
  toStartFailure,
  macToggleOnCheck,
  MIC_DENIED_MESSAGE,
  AUDIO_DENIED_MESSAGE,
  PERMISSION_RESET_MESSAGE,
} from "@/lib/meeting-start-failure";

const KEY = "meeting_auto_record_start_failure";

beforeEach(() => {
  stored = {};
  invoke.mockReset();
  invoke.mockResolvedValue(undefined);
  requestMicAccess.mockReset();
  requestMicAccess.mockResolvedValue(true);
  requestSystemAudioAccess.mockReset();
  requestSystemAudioAccess.mockResolvedValue(null);
});

describe("readStartFailure / writeStartFailure / clearStartFailure", () => {
  it("round-trips a failure", () => {
    const failure: StartFailure = { message: "boom", kind: "start-error" };
    writeStartFailure(failure);
    expect(readStartFailure()).toEqual(failure);
  });

  it("reads null on invalid JSON", () => {
    stored[KEY] = "{not json";
    expect(readStartFailure()).toBeNull();
  });

  it("reads null on an unknown kind", () => {
    stored[KEY] = JSON.stringify({ kind: "nope", message: "x" });
    expect(readStartFailure()).toBeNull();
  });

  it("reads null on a missing message", () => {
    stored[KEY] = JSON.stringify({ kind: "start-error" });
    expect(readStartFailure()).toBeNull();
  });

  it("reads null on a missing value", () => {
    expect(readStartFailure()).toBeNull();
  });

  it("clear removes it", () => {
    writeStartFailure({ message: "boom", kind: "start-error" });
    clearStartFailure();
    expect(Object.keys(stored)).not.toContain(KEY);
    expect(readStartFailure()).toBeNull();
  });
});

describe("toStartFailure", () => {
  it("maps MicGrantMissingError to permission-reset", () => {
    expect(toStartFailure(new MicGrantMissingError())).toEqual({
      kind: "permission-reset",
      message: PERMISSION_RESET_MESSAGE,
    });
  });

  it("maps anything else to start-error with its text", () => {
    expect(toStartFailure("Auto-record needs macOS 14.2 or later")).toEqual({
      kind: "start-error",
      message: "Auto-record needs macOS 14.2 or later",
    });
  });
});

describe("macToggleOnCheck", () => {
  it("gives start-error on a probe rejection and requests nothing", async () => {
    invoke.mockRejectedValue("Auto-record needs macOS 14.2 or later");

    await expect(macToggleOnCheck()).resolves.toEqual({
      kind: "start-error",
      message: "Auto-record needs macOS 14.2 or later",
    });
    expect(requestMicAccess).not.toHaveBeenCalled();
    expect(requestSystemAudioAccess).not.toHaveBeenCalled();
  });

  it("gives mic-denied on mic false and does not request system audio", async () => {
    requestMicAccess.mockResolvedValue(false);

    await expect(macToggleOnCheck()).resolves.toEqual({
      kind: "mic-denied",
      message: MIC_DENIED_MESSAGE,
    });
    expect(requestSystemAudioAccess).not.toHaveBeenCalled();
  });

  it("gives audio-denied with the detail appended", async () => {
    requestSystemAudioAccess.mockResolvedValue("tap failed");

    const failure = await macToggleOnCheck();
    expect(failure?.kind).toBe("audio-denied");
    expect(failure?.message.startsWith(AUDIO_DENIED_MESSAGE)).toBe(true);
    expect(failure?.message.endsWith("(tap failed)")).toBe(true);
  });

  it("gives null when all steps pass, with mic before system audio", async () => {
    await expect(macToggleOnCheck()).resolves.toBeNull();
    const micOrder = requestMicAccess.mock.invocationCallOrder[0];
    const audioOrder = requestSystemAudioAccess.mock.invocationCallOrder[0];
    expect(micOrder).toBeLessThan(audioOrder);
  });
});
