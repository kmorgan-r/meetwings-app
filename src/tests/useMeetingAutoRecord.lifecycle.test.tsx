import { StrictMode } from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock is hoisted above the imports, so shared spies must come from vi.hoisted
// or the factory dereferences a const that is still in its temporal dead zone and
// the whole file fails to load, reporting "no tests" rather than failures.
const mocks = vi.hoisted(() => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    // The watcher-stopped path calls toast.warning. #31's harness omitted it, which
    // would throw inside a Tauri callback instead of failing on the assertion.
    warning: vi.fn(),
  },
  invoke: vi.fn(),
  windowLabel: { value: "main" },
  isWindows: vi.fn(() => true),
  // Event names whose listen() should reject, so the partial-subscription-failure
  // path is reachable from a test.
  failListenFor: new Set<string>(),
}));

vi.mock("sonner", () => ({ toast: mocks.toast }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ label: mocks.windowLabel.value }),
}));
vi.mock("@/lib/platform", () => ({ isWindows: mocks.isWindows }));

// A listen registry keyed by event name that holds ALL callbacks, and whose
// unlisten removes only its own - so a leak is observable.
const listeners = new Map<string, Set<(payload: any) => void>>();
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event: string, cb: (e: { payload: any }) => void) => {
    if (mocks.failListenFor.has(event)) {
      throw new Error(`listen failed for ${event}`);
    }
    const wrapped = (payload: any) => cb({ payload });
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event)!.add(wrapped);
    return () => listeners.get(event)?.delete(wrapped);
  }),
}));

let stored: Record<string, string> = {};
vi.mock("@/lib", () => ({
  safeLocalStorage: {
    getItem: (k: string) => stored[k] ?? null,
    setItem: (k: string, v: string) => {
      stored[k] = v;
    },
    removeItem: (k: string) => {
      delete stored[k];
    },
  },
}));

import {
  GENERIC_START_MESSAGE,
  SETUP_MESSAGE,
  STOP_FAILED_MESSAGE,
  STUCK_MESSAGE,
  useMeetingAutoRecord,
  VAD_MESSAGE,
  WATCHER_STOPPED_MESSAGE,
} from "@/hooks/useMeetingAutoRecord";

const registered = (event: string) => listeners.get(event)?.size ?? 0;

const fire = async (event: string, payload?: any) => {
  const cbs = [...(listeners.get(event) ?? [])];
  for (const cb of cbs) cb(payload);
  await flush();
};

/** Drains the microtask queue. NOT a substitute for waitFor - see rule 1. */
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

const makeAudio = (overrides: Record<string, any> = {}) => ({
  capturing: false,
  error: "",
  vadConfig: { enabled: true },
  startCapture: vi.fn(async () => {}),
  stopCapture: vi.fn(async () => {}),
  // Present ONLY so tests can assert it is never called. This slice is VAD-only
  // and must never drive continuous recording; the MeetingAutoRecordAudio type
  // already omits it, but a type is not a runtime assertion.
  startContinuousRecording: vi.fn(async () => {}),
  ...overrides,
});

/**
 * Seeds `get_capture_status` from a per-call QUEUE, not a constant. The queue
 * length must match the number of invocations the flow makes: a confirmed start
 * consumes one, a stop link one, an ignore-busy cross-check one, and a
 * decideOnEnded that returns "ignore" consumes none. A short queue falls through
 * to `false`, which turns a confirmed start into a failed one and injects a
 * teardown stopCapture - breaking cases against a CORRECT hook.
 */
const seedStatus = (queue: boolean[]) => {
  const remaining = [...queue];
  mocks.invoke.mockImplementation(async (cmd: string) =>
    cmd === "get_capture_status" ? remaining.shift() ?? false : undefined
  );
};

const statusCalls = () =>
  mocks.invoke.mock.calls.filter((c) => c[0] === "get_capture_status").length;

const mount = (
  audio: ReturnType<typeof makeAudio> = makeAudio(),
  setupComplete = true,
  setupLoading = false,
  opts: { strict?: boolean } = {}
) =>
  renderHook(
    ({ a, c, l }: { a: any; c: boolean; l: boolean }) =>
      useMeetingAutoRecord(a, c, l),
    {
      initialProps: { a: audio, c: setupComplete, l: setupLoading },
      ...(opts.strict ? { wrapper: StrictMode } : {}),
    }
  );

beforeEach(() => {
  vi.clearAllMocks();
  listeners.clear();
  stored = { meeting_auto_record_enabled: "true" };
  mocks.windowLabel.value = "main";
  mocks.isWindows.mockReturnValue(true);
  mocks.failListenFor.clear();
  seedStatus([]);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useMeetingAutoRecord - enablement and consent", () => {
  it("F5: deletes the legacy detection key on mount", async () => {
    stored.meeting_detection_enabled = "true";
    expect(stored.meeting_detection_enabled).toBe("true"); // or this passes vacuously

    mount();
    await flush();

    expect(stored.meeting_detection_enabled).toBeUndefined();
  });

  it("F5b: deletes the legacy key even off Windows (the cleanup is ungated)", async () => {
    mocks.isWindows.mockReturnValue(false);
    stored.meeting_detection_enabled = "true";

    mount();
    await flush();

    expect(stored.meeting_detection_enabled).toBeUndefined();
  });

  it("F30: registers no listeners in the dashboard window", async () => {
    mocks.windowLabel.value = "dashboard";

    mount();
    await flush();

    expect(registered("meeting-detected")).toBe(0);
    expect(registered("meeting-ended")).toBe(0);
  });

  it("F30b: registers no listeners off Windows", async () => {
    mocks.isWindows.mockReturnValue(false);

    mount();
    await flush();

    expect(registered("meeting-detected")).toBe(0);
  });

  it("F31: registers each event exactly once and releases them on unmount", async () => {
    const { unmount } = mount();
    await flush();

    // Assert the COUNT, not merely non-empty: non-empty passes against a
    // double-registration leak.
    for (const event of [
      "meeting-detected",
      "meeting-ended",
      "meeting-watcher-stopped",
      "meeting-detection-setting-changed",
      "capture-stopped",
    ]) {
      expect(registered(event)).toBe(1);
    }

    unmount();
    await flush();

    for (const event of [
      "meeting-detected",
      "meeting-ended",
      "meeting-watcher-stopped",
      "meeting-detection-setting-changed",
      "capture-stopped",
    ]) {
      expect(registered(event)).toBe(0);
    }
  });

  it("F31b: refuses to start when a subscription failed", async () => {
    // A hook that registered meeting-detected but NOT meeting-ended would start
    // recordings it can never auto-stop - strictly worse than not starting.
    mocks.failListenFor.add("meeting-ended");
    seedStatus([true]);
    const audio = makeAudio();

    mount(audio);
    await flush();
    await fire("meeting-detected");
    await flush();

    // No sentinel is available here: the feature is off, so nothing it does is
    // observable. flush() suffices because the op returns before its first await.
    expect(audio.startCapture).not.toHaveBeenCalled();
    expect(statusCalls()).toBe(0);
  });
});

describe("useMeetingAutoRecord - decision branches", () => {
  it("F6: ignores a genuine manual session in silence", async () => {
    seedStatus([true]); // the cross-check agrees a session is running
    const audio = makeAudio({ capturing: true });

    mount(audio);
    await flush();
    await fire("meeting-detected");

    // The cross-check invoke is itself the rule-1 positive marker.
    await waitFor(() => expect(statusCalls()).toBe(1));
    expect(audio.startCapture).not.toHaveBeenCalled();
    expect(mocks.toast.error).not.toHaveBeenCalled();
    expect(mocks.toast.info).not.toHaveBeenCalled();
  });

  it("F6b: an unreadable status is NOT treated as a stuck mirror", async () => {
    // The .catch(() => true) default. Without it an IPC hiccup tells a user with a
    // genuine manual recording that auto-record is broken, and burns the budget.
    mocks.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "get_capture_status") throw new Error("ipc down");
      return undefined;
    });
    const audio = makeAudio({ capturing: true });

    mount(audio);
    await flush();
    await fire("meeting-detected");

    await waitFor(() => expect(statusCalls()).toBe(1));
    expect(mocks.toast.error).not.toHaveBeenCalled();
    expect(audio.stopCapture).not.toHaveBeenCalled();
  });

  it("F7: toasts ONCE when Rust contradicts a stuck mirror in VAD mode", async () => {
    seedStatus([false, false]); // nothing is actually running - the mirror lies
    const audio = makeAudio({ capturing: true });

    mount(audio);
    await flush();
    await fire("meeting-detected");
    await fire("meeting-detected"); // fire TWICE or the "once" claim is vacuous

    await waitFor(() => expect(statusCalls()).toBe(2));
    expect(mocks.toast.error).toHaveBeenCalledTimes(1);
    expect(mocks.toast.error).toHaveBeenCalledWith(STUCK_MESSAGE);
    // Report only. This branch must never touch capture - see F8b.
    expect(audio.stopCapture).not.toHaveBeenCalled();
    expect(audio.startCapture).not.toHaveBeenCalled();
  });

  it("F8b: an idle manual CONTINUOUS session is left completely alone", async () => {
    // The regression test for the whole ignore-busy branch. `capturing: true` with
    // Rust reporting false is the NORMAL idle state of a manual continuous session
    // (startCapture returns at useSystemAudio.ts:606-609 without ever invoking
    // start_system_audio_capture), NOT a stuck mirror. An implementation that
    // cross-checks here tears down a live user recording and blames auto-record.
    seedStatus([true]); // consumed by the sentinel below, not by this case
    const continuous = makeAudio({
      capturing: true,
      vadConfig: { enabled: false },
    });
    const view = mount(continuous);
    await flush();

    await fire("meeting-detected"); // continuous ignore-busy: invokes nothing

    // Rule-1 sentinel: swap to a VAD-on busy session, whose ignore-busy DOES
    // query, and wait on that. The chain is FIFO, so once the sentinel is
    // observable the continuous op has already run.
    view.rerender({ a: makeAudio({ capturing: true }), c: true, l: false });
    await fire("meeting-detected");

    // Exactly one query - the sentinel's. The continuous detect made none.
    await waitFor(() => expect(statusCalls()).toBe(1));
    expect(continuous.stopCapture).not.toHaveBeenCalled();
    expect(continuous.startCapture).not.toHaveBeenCalled();
    expect(mocks.toast.error).not.toHaveBeenCalled();
  });

  it("F8: a busy manual CONTINUOUS session draws no VAD toast", async () => {
    // The ordering regression test: a hook that checks vadEnabled before
    // capturing toasts here, at a user who is already recording.
    //
    // No status marker is available: `ignore-busy` is gated on vadConfig.enabled
    // and returns BEFORE its first await for a continuous session, so it issues
    // no invoke at all. flush() is sufficient for exactly that reason - the op
    // completes synchronously once the chain reaches it. (F8b covers the same
    // input from the other side, proving stopCapture is never called.)
    const audio = makeAudio({ capturing: true, vadConfig: { enabled: false } });

    mount(audio);
    await flush();
    await fire("meeting-detected");
    await flush();

    expect(mocks.toast.info).not.toHaveBeenCalled();
    expect(mocks.toast.error).not.toHaveBeenCalled();
    expect(statusCalls()).toBe(0);
  });

  it("F9: defers to Meeting Assist Mode without even querying status", async () => {
    stored.meeting_assist_mode_enabled = "true";
    seedStatus([true]);
    const audio = makeAudio();
    const view = mount(audio);
    await flush();

    await fire("meeting-detected"); // ignore-assist: invokes nothing at all

    // Rule 1 FIFO sentinel: this branch is silent, so drive a SECOND detect down a
    // branch that does invoke something, and wait on that. The chain is FIFO, so
    // once the sentinel is observable the assist op has already run.
    stored.meeting_assist_mode_enabled = "false";
    view.rerender({ a: makeAudio({ capturing: true }), c: true, l: false });
    await fire("meeting-detected"); // ignore-busy: exactly one status query

    await waitFor(() => expect(statusCalls()).toBe(1));
    // One query total means the assist detect made none, and neither detect
    // started anything.
    expect(audio.startCapture).not.toHaveBeenCalled();
    expect(mocks.toast.info).not.toHaveBeenCalled();
    expect(mocks.toast.error).not.toHaveBeenCalled();
  });

  it("F10: stays silent while setup is loading, and keeps the toast budget", async () => {
    const audio = makeAudio();
    const view = mount(audio, false, true); // setupComplete false, loading true

    await flush();
    await fire("meeting-detected");
    expect(mocks.toast.info).not.toHaveBeenCalled();

    // Loading finishes and setup really is incomplete - NOW it may speak.
    view.rerender({ a: audio, c: false, l: false });
    await fire("meeting-detected");

    await waitFor(() => expect(mocks.toast.info).toHaveBeenCalledTimes(1));
    expect(mocks.toast.info).toHaveBeenCalledWith(SETUP_MESSAGE);
  });

  it("F11: explains incomplete setup exactly once per run", async () => {
    const audio = makeAudio();

    mount(audio, false, false);
    await flush();
    await fire("meeting-detected");
    await fire("meeting-detected");

    await waitFor(() => expect(mocks.toast.info).toHaveBeenCalledTimes(1));
    expect(mocks.toast.info).toHaveBeenCalledWith(SETUP_MESSAGE);
    expect(audio.startCapture).not.toHaveBeenCalled();
  });

  it("F12: explains disabled VAD exactly once per run", async () => {
    const audio = makeAudio({ vadConfig: { enabled: false } });

    mount(audio);
    await flush();
    await fire("meeting-detected");
    await fire("meeting-detected");

    await waitFor(() => expect(mocks.toast.info).toHaveBeenCalledTimes(1));
    expect(mocks.toast.info).toHaveBeenCalledWith(VAD_MESSAGE);
    expect(audio.startCapture).not.toHaveBeenCalled();
    // The whole point of refusing: never half-drive a continuous session.
    expect(audio.startContinuousRecording).not.toHaveBeenCalled();
  });
});
