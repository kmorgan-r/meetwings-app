import { StrictMode } from "react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";

// --- Mock harness -----------------------------------------------------------
// The listen mock is a registry keyed by event name holding EVERY callback, and
// unlisten removes only its own. A mock that keeps just the last callback makes
// leak assertions undetectable; a bulk delete makes StrictMode tests fail
// against correct code.
const listeners = new Map<string, Set<(e: { payload: unknown }) => void>>();

const listen = vi.fn();
const emit = vi.fn();
const invoke = vi.fn();

vi.mock("@tauri-apps/api/event", () => ({
  listen: (...args: Parameters<typeof listen>) => listen(...args),
  emit: (...args: Parameters<typeof emit>) => emit(...args),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: Parameters<typeof invoke>) => invoke(...args),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ label: windowLabel }),
}));
vi.mock("@/lib/platform", () => ({ isWindows: () => onWindows }));

// vi.hoisted is mandatory: vi.mock is hoisted above the imports, so a factory
// that dereferences a plain `const toast` declared below runs while that binding
// is still in TDZ and the whole file fails to load with "Cannot access 'toast'
// before initialization". The other factories are safe because they only read
// their outer variables lazily, inside arrow bodies.
const toast = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
}));
vi.mock("sonner", () => ({ toast }));

let windowLabel = "main";
let onWindows = true;
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

import { useMeetingDetection } from "@/hooks/useMeetingDetection";
import { MEETING_DETECT_PROCESSES, STORAGE_KEYS } from "@/config/constants";

const DETECTION_EVENTS = [
  "meeting-detected",
  "meeting-ended",
  "meeting-watcher-error",
  "meeting-watcher-stopped",
];

/** Let every pending listen()/invoke() promise settle. */
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

const registered = (event: string) => listeners.get(event)?.size ?? 0;

/** The default listen behaviour: register immediately, unlisten removes only its own. */
const registerImmediately = async (
  event: string,
  cb: (e: { payload: unknown }) => void
) => {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event)!.add(cb);
  return () => {
    listeners.get(event)?.delete(cb);
  };
};

beforeEach(() => {
  listeners.clear();
  vi.clearAllMocks();
  // clearAllMocks wipes call history but NOT implementations, so any test that
  // overrides listen/invoke would leak into the next one. Restore both here.
  listen.mockImplementation(registerImmediately);
  invoke.mockResolvedValue(undefined);
  emit.mockResolvedValue(undefined);
  windowLabel = "main";
  onWindows = true;
  stored = { [STORAGE_KEYS.MEETING_AUTO_RECORD_ENABLED]: "true" };
});

describe("useMeetingDetection", () => {
  // F1
  it("toasts on detection and on call end", async () => {
    renderHook(() => useMeetingDetection());
    await flush();

    fire("meeting-detected", { process: "ms-teams.exe" });
    expect(toast.info).toHaveBeenCalledTimes(1);
    expect(toast.info.mock.calls[0][0]).toContain("Teams call detected");

    fire("meeting-ended", { process: "ms-teams.exe" });
    expect(toast.info).toHaveBeenCalledTimes(2);
    expect(toast.info.mock.calls[1][0]).toContain("Teams call ended");
  });

  // F2
  it("starts the watcher with the configured process list", async () => {
    renderHook(() => useMeetingDetection());
    await flush();

    expect(invoke).toHaveBeenCalledWith("start_meeting_watcher", {
      processes: MEETING_DETECT_PROCESSES,
    });
  });

  // F3 - regression: the setting listener must NOT be trapped in the [enabled] effect
  it("receives the first toggle-on delivered only by event", async () => {
    stored = { [STORAGE_KEYS.MEETING_AUTO_RECORD_ENABLED]: "false" };
    renderHook(() => useMeetingDetection());
    await flush();
    expect(invoke).not.toHaveBeenCalledWith("start_meeting_watcher", expect.anything());

    fire("meeting-detection-setting-changed", { enabled: true });
    await flush();
    expect(invoke).toHaveBeenCalledWith("start_meeting_watcher", {
      processes: MEETING_DETECT_PROCESSES,
    });
  });

  // F4 - regression for the [isOwner] keying of the subscription effect
  it("keeps the detection listeners registered across a disable", async () => {
    renderHook(() => useMeetingDetection());
    await flush();

    fire("meeting-detection-setting-changed", { enabled: false });
    await flush();

    expect(invoke).toHaveBeenCalledWith("stop_meeting_watcher");
    for (const event of DETECTION_EVENTS) {
      expect(registered(event)).toBe(1);
    }
  });

  // F5
  it("is inert in a non-main window", async () => {
    windowLabel = "dashboard";
    renderHook(() => useMeetingDetection());
    await flush();

    expect(invoke).not.toHaveBeenCalled();
    expect(listen).not.toHaveBeenCalled();
  });

  // F6
  it("is inert on a non-Windows platform even with the setting persisted on", async () => {
    onWindows = false;
    renderHook(() => useMeetingDetection());
    await flush();

    expect(invoke).not.toHaveBeenCalledWith("start_meeting_watcher", expect.anything());
  });

  // F7 - serialization, driven by an enabled sequence (NOT StrictMode)
  it("serializes watcher commands", async () => {
    let releaseStop: () => void = () => {};
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "stop_meeting_watcher") {
        await new Promise<void>((resolve) => {
          releaseStop = resolve;
        });
      }
      return undefined;
    });

    const { rerender } = renderHook(() => useMeetingDetection());
    await flush();

    fire("meeting-detection-setting-changed", { enabled: false });
    await flush();
    fire("meeting-detection-setting-changed", { enabled: true });
    await flush();
    rerender();
    await flush();

    const starts = () =>
      invoke.mock.calls.filter(([cmd]) => cmd === "start_meeting_watcher").length;

    expect(starts()).toBe(1);
    await act(async () => {
      releaseStop();
      await Promise.resolve();
    });
    await flush();
    await waitFor(() => expect(starts()).toBe(2));
  });

  // F9 - the chain must not be poisoned by a rejection
  it("still stops after a rejected start", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "start_meeting_watcher") throw new Error("boom");
      return undefined;
    });

    renderHook(() => useMeetingDetection());
    await flush();

    invoke.mockResolvedValue(undefined);
    fire("meeting-detection-setting-changed", { enabled: true });
    await flush();
    fire("meeting-detection-setting-changed", { enabled: false });
    await flush();

    expect(invoke).toHaveBeenCalledWith("stop_meeting_watcher");
  });

  // F8 - StrictMode is how the app actually runs; the cancelled-flag discipline
  // in effects 1, 2 and 3 exists solely for the mount -> cleanup -> mount cycle.
  // Effect 3's flag specifically keeps the in-flight start from the first mount
  // from double-firing after its cleanup enqueues a stop, so starts <= 1 holds.
  it("keeps one watcher and one toast under StrictMode", async () => {
    renderHook(() => useMeetingDetection(), { wrapper: StrictMode });
    await flush();

    const starts = invoke.mock.calls.filter(
      ([cmd]) => cmd === "start_meeting_watcher"
    ).length;
    expect(starts).toBeLessThanOrEqual(1);

    for (const event of DETECTION_EVENTS) {
      expect(registered(event)).toBe(1);
    }

    fire("meeting-detected", { process: "ms-teams.exe" });
    expect(toast.info).toHaveBeenCalledTimes(1);
  });

  // F10 - the echo-suppression regression the spec names by hand. An
  // implementation that ignores an event matching the value it last wrote passes
  // everything else and fails only here.
  it("does not swallow a genuine toggle-off after a forced-off revert", async () => {
    let startCalls = 0;
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "start_meeting_watcher") {
        startCalls += 1;
        // Rejects on the FIRST call only, so the re-enable can succeed.
        if (startCalls === 1) throw new Error("boom");
      }
      return undefined;
    });

    renderHook(() => useMeetingDetection());
    await flush();

    // The forced-off revert emits {enabled:false} and the emitter hears its own
    // echo. An echo-suppressing implementation records "false" as self-written.
    fire("meeting-detection-setting-changed", { enabled: false });
    await flush();

    fire("meeting-detection-setting-changed", { enabled: true });
    await flush();

    // Count stops from HERE: the forced-off already produced one.
    const before = invoke.mock.calls.filter(
      ([cmd]) => cmd === "stop_meeting_watcher"
    ).length;

    fire("meeting-detection-setting-changed", { enabled: false });
    await flush();

    const after = invoke.mock.calls.filter(
      ([cmd]) => cmd === "stop_meeting_watcher"
    ).length;
    expect(after).toBeGreaterThan(before);
  });

  // F14 - the disable-failure ladder, plus its negative pair
  it("reports a watcher that will not stop, and stays quiet when it does", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "stop_meeting_watcher") return "timedOut";
      if (cmd === "get_meeting_watcher_status") return { running: true };
      return undefined;
    });

    const { unmount } = renderHook(() => useMeetingDetection());
    await flush();
    fire("meeting-detection-setting-changed", { enabled: false });
    await flush();

    expect(
      invoke.mock.calls.filter(([cmd]) => cmd === "stop_meeting_watcher").length
    ).toBe(2);
    // The disable ladder (stopOnce x2 + status query + emit) needs several
    // microtasks to settle; a bare await flush() races the assertion ahead of
    // the emit, which would make the negative pair below pass vacuously.
    await waitFor(() =>
      expect(emit).toHaveBeenCalledWith("meeting-detection-watcher-restarted", {
        ok: false,
        error: "the watcher did not stop",
      })
    );
    unmount();

    // Negative pair: the same ladder, but the watcher actually did stop. An
    // unconditional emit would pass the assertion above and fail this one.
    vi.clearAllMocks();
    listeners.clear();
    listen.mockImplementation(registerImmediately);
    emit.mockResolvedValue(undefined);
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "stop_meeting_watcher") return "timedOut";
      if (cmd === "get_meeting_watcher_status") return { running: false };
      return undefined;
    });

    renderHook(() => useMeetingDetection());
    await flush();
    fire("meeting-detection-setting-changed", { enabled: false });
    await flush();

    // Wait for the ladder to actually settle before asserting absence, so the
    // negative pair is falsifiable rather than passing on an unfinished chain.
    await waitFor(() =>
      expect(
        invoke.mock.calls.filter(([cmd]) => cmd === "stop_meeting_watcher").length
      ).toBe(2)
    );
    expect(emit).not.toHaveBeenCalledWith(
      "meeting-detection-watcher-restarted",
      expect.objectContaining({ ok: false })
    );
  });

  // F11 - the slice's defining constraint
  it("never touches capture commands", async () => {
    renderHook(() => useMeetingDetection());
    await flush();
    fire("meeting-detected", { process: "ms-teams.exe" });
    fire("meeting-ended", { process: "ms-teams.exe" });
    fire("meeting-watcher-stopped", { reason: "x" });
    await flush();

    const forbidden = [
      "start_system_audio_capture",
      "stop_system_audio_capture",
      "manual_stop_continuous",
      "get_capture_status",
    ];
    for (const cmd of forbidden) {
      expect(invoke).not.toHaveBeenCalledWith(cmd, expect.anything());
      expect(invoke).not.toHaveBeenCalledWith(cmd);
    }
  });

  // F12 - non-vacuous leak assertion
  it("registers and then releases its listeners", async () => {
    const { unmount } = renderHook(() => useMeetingDetection());
    await flush();

    for (const event of DETECTION_EVENTS) {
      expect(registered(event)).toBe(1);
    }

    unmount();
    await flush();

    for (const event of DETECTION_EVENTS) {
      expect(registered(event)).toBe(0);
    }
  });

  // F19 - the listeners-before-start gate. Made falsifiable by holding the
  // listen() promises open: without the gate the start fires anyway.
  it("registers every detection listener before starting the watcher", async () => {
    const releases: Array<() => void> = [];
    listen.mockImplementation(
      (event: string, cb: (e: { payload: unknown }) => void) =>
        new Promise((resolve) => {
          releases.push(() => {
            if (!listeners.has(event)) listeners.set(event, new Set());
            listeners.get(event)!.add(cb);
            resolve(() => listeners.get(event)?.delete(cb));
          });
        })
    );

    renderHook(() => useMeetingDetection());
    await flush();

    expect(invoke).not.toHaveBeenCalledWith(
      "start_meeting_watcher",
      expect.anything()
    );

    await act(async () => {
      releases.forEach((release) => release());
      await Promise.resolve();
    });
    await flush();

    for (const event of DETECTION_EVENTS) {
      expect(registered(event)).toBe(1);
    }
    expect(invoke).toHaveBeenCalledWith("start_meeting_watcher", {
      processes: MEETING_DETECT_PROCESSES,
    });
  });

  // F13
  it("reverts the persisted setting when the start rejects", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "start_meeting_watcher") throw new Error("boom");
      return undefined;
    });

    renderHook(() => useMeetingDetection());
    await flush();

    expect(stored[STORAGE_KEYS.MEETING_AUTO_RECORD_ENABLED]).toBe("false");
    expect(emit).toHaveBeenCalledWith("meeting-detection-setting-changed", {
      enabled: false,
    });
  });

  // F15 / F16 - retry is gated on the setting, via a ref not a stale state value
  it("retries only when the feature is on", async () => {
    renderHook(() => useMeetingDetection());
    await flush();
    invoke.mockClear();

    fire("meeting-detection-retry-requested");
    await flush();
    expect(invoke).toHaveBeenCalledWith("stop_meeting_watcher");
    expect(invoke).toHaveBeenCalledWith("start_meeting_watcher", {
      processes: MEETING_DETECT_PROCESSES,
    });

    fire("meeting-detection-setting-changed", { enabled: false });
    await flush();
    invoke.mockClear();

    fire("meeting-detection-retry-requested");
    await flush();
    expect(invoke).not.toHaveBeenCalledWith("start_meeting_watcher", expect.anything());
    expect(emit).toHaveBeenCalledWith("meeting-detection-watcher-restarted", {
      ok: false,
    });
  });

  // F17 / F18
  it("toasts once on a terminal stop and never on a transient error", async () => {
    renderHook(() => useMeetingDetection());
    await flush();
    toast.info.mockClear();

    fire("meeting-watcher-error", { message: "com failure" });
    expect(toast.info).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();

    fire("meeting-watcher-stopped", { reason: "30 consecutive failed polls" });
    expect(toast.info).toHaveBeenCalledTimes(1);
    expect(stored[STORAGE_KEYS.MEETING_AUTO_RECORD_ENABLED]).toBe(
      "true",
      // deliberately left on so the settings note and its retry stay reachable
    );
  });

  // F32 - label lookup is case-normalized with a fallback
  it("normalizes the toast label and falls back for unknown processes", async () => {
    renderHook(() => useMeetingDetection());
    await flush();

    fire("meeting-detected", { process: "MS-TEAMS.EXE" });
    expect(toast.info.mock.calls[0][0]).toContain("Teams call detected");

    fire("meeting-ended", { process: "MS-TEAMS.EXE" });
    toast.info.mockClear();

    fire("meeting-detected", { process: "unknown.exe" });
    expect(toast.info.mock.calls[0][0]).toContain("Meeting call detected");
    expect(toast.info.mock.calls[0][0]).not.toContain("undefined");
  });

  // F33 - the end payload carries the process, so a reload cannot orphan the label
  it("labels the end toast from the payload", async () => {
    renderHook(() => useMeetingDetection());
    await flush();

    // No preceding meeting-detected in this document, as after a window reload.
    fire("meeting-ended", { process: "ms-teams.exe" });
    expect(toast.info).toHaveBeenCalledTimes(1);
    expect(toast.info.mock.calls[0][0]).toContain("Teams call ended");
  });
});
