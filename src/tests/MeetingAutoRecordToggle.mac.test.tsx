import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

const listeners = new Map<string, Set<(e: { payload: unknown }) => void>>();

const listen = vi.fn(async (event: string, cb: (e: { payload: unknown }) => void) => {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event)!.add(cb);
  return () => {
    listeners.get(event)?.delete(cb);
  };
});
const emit = vi.fn(async (..._a: unknown[]) => {});
const invoke = vi.fn(async (_cmd?: unknown, _args?: unknown) => undefined as unknown);

vi.mock("@tauri-apps/api/event", () => ({
  listen: (...a: Parameters<typeof listen>) => listen(...a),
  emit: (...a: Parameters<typeof emit>) => emit(...a),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...a: Parameters<typeof invoke>) => invoke(...a),
}));

vi.mock("@/lib/storage/google-config.storage", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadGoogleConfigState: vi.fn(async () => ({ state: "complete" })),
}));

// A three-state platform mock, flipped in one place by the `platform` let.
let platform: "windows" | "macos" | "linux" = "macos";
vi.mock("@/lib/platform", () => ({
  getPlatform: () => platform,
  isWindows: () => platform === "windows",
  isMacOS: () => platform === "macos",
  isLinux: () => platform === "linux",
}));

const hasMicGrant = vi.fn();
const requestMicAccess = vi.fn();
const requestSystemAudioAccess = vi.fn();
const openMicSettings = vi.fn();
const openSystemAudioSettings = vi.fn();
vi.mock("@/lib/mac-permissions", () => ({
  hasMicGrant: (...a: unknown[]) => hasMicGrant(...a),
  requestMicAccess: (...a: unknown[]) => requestMicAccess(...a),
  requestSystemAudioAccess: (...a: unknown[]) => requestSystemAudioAccess(...a),
  openMicSettings: (...a: unknown[]) => openMicSettings(...a),
  openSystemAudioSettings: (...a: unknown[]) => openSystemAudioSettings(...a),
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

import { MeetingAutoRecordToggle } from "@/pages/settings/components/MeetingAutoRecordToggle";
import { STORAGE_KEYS } from "@/config/constants";
import {
  MIC_DENIED_MESSAGE,
  AUDIO_DENIED_MESSAGE,
  PERMISSION_RESET_MESSAGE,
} from "@/lib/meeting-start-failure";

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

const fire = (event: string, payload?: unknown) =>
  act(() => {
    listeners.get(event)?.forEach((cb) => cb({ payload }));
  });

// The component renders <Header>, which calls useNavigate() unconditionally.
const renderToggle = () =>
  render(
    <MemoryRouter>
      <MeetingAutoRecordToggle />
    </MemoryRouter>
  );

// vi.clearAllMocks() keeps implementations between tests, so every default is
// re-set here.
beforeEach(() => {
  listeners.clear();
  vi.clearAllMocks();
  stored = {};
  platform = "macos";
  invoke.mockReset();
  invoke.mockResolvedValue({ running: true, lastError: null });
  hasMicGrant.mockReset().mockResolvedValue(true);
  requestMicAccess.mockReset().mockResolvedValue(true);
  requestSystemAudioAccess.mockReset().mockResolvedValue(null);
  openMicSettings.mockReset().mockResolvedValue(undefined);
  openSystemAudioSettings.mockReset().mockResolvedValue(undefined);
});

const ENABLED = STORAGE_KEYS.MEETING_AUTO_RECORD_ENABLED;
const START_FAILURE = STORAGE_KEYS.MEETING_AUTO_RECORD_START_FAILURE;
const UNSUPPORTED = "Auto-record needs macOS 14.2 or later";

const sw = () =>
  screen.getByLabelText("Automatically record Google Meet calls in Chrome");

const rejectProbe = () =>
  invoke.mockImplementation(async (cmd: unknown) => {
    if (cmd === "list_capture_sessions") throw UNSUPPORTED;
    return { running: true, lastError: null };
  });

const deferMic = () => {
  let resolve: (v: boolean) => void = () => {};
  requestMicAccess.mockImplementation(
    () =>
      new Promise<boolean>((r) => {
        resolve = r;
      })
  );
  return (v: boolean) => resolve(v);
};

const enabledEmits = () =>
  emit.mock.calls.filter(
    (c) =>
      c[0] === "meeting-detection-setting-changed" &&
      (c[1] as { enabled?: boolean } | undefined)?.enabled === true
  );

describe("MeetingAutoRecordToggle on a Mac", () => {
  it("an unsupported macOS shows that error and asks for nothing", async () => {
    rejectProbe();
    renderToggle();
    await flush();
    fireEvent.click(sw());
    await flush();
    await flush();

    expect(screen.getByText(UNSUPPORTED)).toBeInTheDocument();
    expect(requestMicAccess).not.toHaveBeenCalled();
    expect(requestSystemAudioAccess).not.toHaveBeenCalled();
    expect(stored[ENABLED]).not.toBe("true");
    expect(enabledEmits()).toHaveLength(0);
    expect(sw()).not.toBeChecked();
  });

  it("asks for both permissions before saving or emitting", async () => {
    const resolveMic = deferMic();
    renderToggle();
    await flush();
    fireEvent.click(sw());
    await flush();

    expect(emit).not.toHaveBeenCalledWith(
      "meeting-detection-setting-changed",
      expect.anything()
    );
    expect(stored[ENABLED]).toBeUndefined();
    expect(sw()).toBeDisabled();

    resolveMic(true);
    await flush();
    await flush();

    expect(requestSystemAudioAccess).toHaveBeenCalled();
    expect(stored[ENABLED]).toBe("true");
    expect(emit).toHaveBeenCalledWith("meeting-detection-setting-changed", {
      enabled: true,
    });
    expect(sw()).toBeEnabled();
  });

  it("a mic denial keeps it off and names the microphone", async () => {
    requestMicAccess.mockResolvedValue(false);
    renderToggle();
    await flush();
    fireEvent.click(sw());
    await flush();
    await flush();

    expect(screen.getByText(MIC_DENIED_MESSAGE)).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Open Microphone settings" })
    );
    expect(openMicSettings).toHaveBeenCalled();
    expect(requestSystemAudioAccess).not.toHaveBeenCalled();
    expect(enabledEmits()).toHaveLength(0);
  });

  it("a system-audio denial names system audio", async () => {
    requestSystemAudioAccess.mockResolvedValue("tap failed");
    renderToggle();
    await flush();
    fireEvent.click(sw());
    await flush();
    await flush();

    expect(
      screen.getByText(`${AUDIO_DENIED_MESSAGE} (tap failed)`)
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Open System Audio settings" })
    );
    expect(openSystemAudioSettings).toHaveBeenCalled();
  });

  it("a click while the requests are pending changes nothing", async () => {
    const resolveMic = deferMic();
    renderToggle();
    await flush();
    fireEvent.click(sw());
    await flush();
    fireEvent.click(sw());
    await flush();

    expect(requestMicAccess).toHaveBeenCalledTimes(1);
    resolveMic(false);
    await flush();
    await flush();
    expect(stored[ENABLED]).not.toBe("true");
  });

  it("a failure stored before mount shows while the toggle is off", async () => {
    stored[START_FAILURE] = JSON.stringify({
      kind: "start-error",
      message: UNSUPPORTED,
    });
    renderToggle();
    await flush();

    expect(screen.getByText(UNSUPPORTED)).toBeInTheDocument();
    expect(sw()).not.toBeChecked();
  });

  it("a failure carried by setting-changed shows at once", async () => {
    renderToggle();
    await flush();
    fire("meeting-detection-setting-changed", {
      enabled: false,
      failure: { kind: "permission-reset", message: PERMISSION_RESET_MESSAGE },
    });

    expect(screen.getByText(PERMISSION_RESET_MESSAGE)).toBeInTheDocument();
  });

  it("the next toggle-on clears the failure", async () => {
    stored[START_FAILURE] = JSON.stringify({
      kind: "start-error",
      message: UNSUPPORTED,
    });
    renderToggle();
    await flush();
    expect(screen.getByText(UNSUPPORTED)).toBeInTheDocument();

    fireEvent.click(sw());
    await flush();
    await flush();

    expect(screen.queryByText(UNSUPPORTED)).toBeNull();
    expect(stored[START_FAILURE]).toBeUndefined();
  });

  it("the readout shows the probe's error", async () => {
    rejectProbe();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    renderToggle();
    await flush();
    fireEvent.click(
      screen.getByRole("button", { name: "Check microphone apps" })
    );
    await flush();

    expect(
      screen.getByText("Couldn't list microphone apps.")
    ).toBeInTheDocument();
    expect(screen.getByText(new RegExp(UNSUPPORTED))).toBeInTheDocument();
    error.mockRestore();
  });

  it("Mac copy names Google Meet in Chrome only", async () => {
    renderToggle();
    await flush();
    expect(screen.queryByText(/teams/i)).toBeNull();
  });
});

describe("MeetingAutoRecordToggle on Windows", () => {
  it("Windows: immediate save, no permission calls, no lasting note", async () => {
    platform = "windows";
    stored[START_FAILURE] = JSON.stringify({
      kind: "start-error",
      message: UNSUPPORTED,
    });
    renderToggle();
    await flush();

    fireEvent.click(
      screen.getByLabelText("Automatically record Teams and Google Meet calls")
    );
    await flush();

    expect(stored[ENABLED]).toBe("true");
    expect(emit).toHaveBeenCalledWith("meeting-detection-setting-changed", {
      enabled: true,
    });
    for (const fn of [
      hasMicGrant,
      requestMicAccess,
      requestSystemAudioAccess,
      openMicSettings,
      openSystemAudioSettings,
    ]) {
      expect(fn).not.toHaveBeenCalled();
    }
    expect(screen.queryByText(UNSUPPORTED)).toBeNull();
    expect(screen.queryByText(/windows only/i)).toBeNull();
  });
});
