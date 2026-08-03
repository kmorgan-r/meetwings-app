import {
  StrictMode,
  useCallback,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { flushSync } from "react-dom";
import { act, render, waitFor } from "@testing-library/react";
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

// Spread the real module, or STORAGE_KEYS arrives undefined and the hook throws
// on its first getItem. The override shortens the post-stop confirmation poll:
// RTL's waitFor budget is 1000ms and the shipped interval blows through it.
vi.mock("@/config/constants", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  STOP_CONFIRM_INTERVAL_MS: 5,
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
  STOP_FAILED_MESSAGE,
  STUCK_MESSAGE,
  useMeetingAutoRecord,
  VAD_MESSAGE,
  WATCHER_STOPPED_MESSAGE,
} from "@/hooks/useMeetingAutoRecord";

const registered = (event: string) => listeners.get(event)?.size ?? 0;

/**
 * Delivers an event to every listener registered for it, draining nothing.
 * Split out so a case that must land two events inside ONE act() (see F39) can
 * do so without nesting `fireActed` calls, which would overlap acts.
 */
const emit = (event: string, payload?: any) => {
  for (const cb of [...(listeners.get(event) ?? [])]) cb(payload);
};

const fire = async (event: string, payload?: any) => {
  emit(event, payload);
  await flush();
};

/**
 * `fire` for any path that can make the hook WRITE state.
 *
 * `fire` only drains microtasks: the enqueued op resumes on a microtask but
 * React commits on a macrotask, so a setEnableVAD issued by the op never
 * commits, the ownership layout effect never runs, and React logs an act
 * warning instead of failing. One act() containing both the callbacks and the
 * drain closes that gap. Never nest this inside another act - overlapping acts
 * leave later cases inert rather than failing.
 */
const fireActed = async (event: string, payload?: any) => {
  await act(async () => {
    emit(event, payload);
    await flush();
  });
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

type AudioFixture = ReturnType<typeof makeAudio>;

type MountOptions = {
  strict?: boolean;
  enableVAD?: boolean;
  meetingAssistMode?: boolean;
};

/**
 * Mounts the hook inside a component that OWNS the props it reads, the way
 * <Completion /> does - so `enableVAD` and `meetingAssistMode` are real state
 * here rather than inert literals, and the hook's writes land in a real commit.
 *
 * `meetingAssistMode` defaults to false: every transcribing case predates the
 * meeting fork and must keep its current path.
 */
const mount = (audio: AudioFixture = makeAudio(), opts: MountOptions = {}) => {
  // The signature used to end in two positional booleans. A leftover one would
  // autobox here, read every option as undefined and NOT throw - which would
  // silently drop StrictMode from the only case that asks for it.
  if (typeof opts !== "object" || opts === null) {
    throw new TypeError(
      "mount(audio, opts) takes an options OBJECT; the positional " +
        "setupComplete/setupLoading booleans are gone."
    );
  }

  // Hoisted ABOVE the component deliberately. `makeAudio()` evaluated in the
  // render body would mint a fresh spy set on every render, so the ref mirror
  // this file exists to exercise would have nothing stable to mirror.
  let currentAudio = audio;
  const renderedVAD: boolean[] = [];
  const flushTranscript = vi.fn(async () => {});

  let applyAudio!: Dispatch<SetStateAction<AudioFixture>>;
  let applyEnableVAD!: Dispatch<SetStateAction<boolean>>;
  let applyMeetingAssistMode!: Dispatch<SetStateAction<boolean>>;

  // Every write the HOOK makes goes through this spy, and only the hook's. The
  // harness's own mic writes below bypass it, and passing the raw setter would
  // record nothing at all - so a hook that writes `true` over an already-true
  // value (a React bailout: no render, no change in observedVAD) is still
  // visible here.
  const setEnableVAD = vi.fn((value: SetStateAction<boolean>) => {
    applyEnableVAD(value);
  });

  const Probe = () => {
    const [systemAudio, setSystemAudio] = useState(audio);
    const [enableVAD, setVADState] = useState(opts.enableVAD ?? false);
    const [meetingAssistMode, setAssistState] = useState(
      opts.meetingAssistMode ?? false
    );

    // useState setters are stable, so these assignments are idempotent.
    applyAudio = setSystemAudio;
    applyEnableVAD = setVADState;
    applyMeetingAssistMode = setAssistState;
    renderedVAD.push(enableVAD);

    // Stable identity: the hook mirrors it into a ref every commit, and a new
    // function each render would hide a hook that captured one at mount.
    const stableSetEnableVAD = useCallback<Dispatch<SetStateAction<boolean>>>(
      (value) => setEnableVAD(value),
      []
    );

    useMeetingAutoRecord({
      systemAudio,
      enableVAD,
      setEnableVAD: stableSetEnableVAD,
      meetingAssistMode,
      flushUnsavedMeetingTranscript: flushTranscript,
    });
    return null;
  };

  const view = render(<Probe />, opts.strict ? { wrapper: StrictMode } : {});

  return {
    /** The audio object the hook is currently holding. */
    get audio() {
      return currentAudio;
    },
    /**
     * The enableVAD TRANSITIONS, consecutive duplicates collapsed on read.
     *
     * The raw push happens in the render body, which StrictMode double-invokes
     * - so a `{ strict: true }` case would otherwise read doubled entries and
     * fail confusingly. Moving the push to a no-deps useEffect would not fix
     * that: StrictMode double-invokes mount effects too (run, clean up, run).
     * Collapsing on read is the shape that survives both, and it loses nothing
     * real - a write of `true` over an already-true value is a React bailout
     * that never renders at all, which is precisely why setEnableVAD below is
     * a spy rather than the raw setter.
     */
    get observedVAD() {
      return renderedVAD.filter((v, i) => i === 0 || v !== renderedVAD[i - 1]);
    },
    setEnableVAD,
    flushTranscript,
    unmount: () => view.unmount(),
    /** Swaps the audio object, the way a useSystemAudio re-render would. */
    setAudio: async (next: AudioFixture) => {
      currentAudio = next;
      await act(async () => {
        applyAudio(next);
      });
    },
    /**
     * The same swap, committed SYNCHRONOUSLY. For callers already running
     * inside an act() - a mock startCapture, say - where a nested act would
     * overlap, and where a deferred commit would land after the hook has
     * already read the ref.
     */
    setAudioSync: (next: AudioFixture) => {
      currentAudio = next;
      flushSync(() => {
        applyAudio(next);
      });
    },
    /** The USER opening or closing the mic. Bypasses the spy on purpose. */
    setMicOpen: async (open: boolean) => {
      await act(async () => {
        applyEnableVAD(open);
      });
    },
    setMeetingAssistMode: async (on: boolean) => {
      await act(async () => {
        applyMeetingAssistMode(on);
      });
    },
  };
};

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

// The harness's own smoke test. Everything below drives the hook; these two
// drive the HARNESS, because `src/tests/**` is outside tsconfig - a typo or a
// mis-wired setter in the mount helper is invisible to `npm run type-check`
// AND to every case that never touches it. Nothing in this file reads
// enableVAD or meetingAssistMode yet; the meeting-mode cases will, and they
// should find these carries already proven.
describe("useMeetingAutoRecord - harness carries", () => {
  it("F35: the mic props are real state, and the harness's own writes bypass the spy", async () => {
    const h = mount(makeAudio(), {
      enableVAD: true,
      meetingAssistMode: true,
    });
    await flush();

    // The mount options reach state rather than being dropped on the floor.
    expect(h.observedVAD).toEqual([true]);

    // A USER closing the mic. It must commit, and it must NOT be recorded as a
    // write by the hook - that bypass is the whole reason setEnableVAD is a
    // spy delegating to the setter rather than the setter itself.
    await h.setMicOpen(false);
    expect(h.observedVAD).toEqual([true, false]);
    expect(h.setEnableVAD).not.toHaveBeenCalled();

    // The pill toggling mid-session. Nothing reads it yet, so the property
    // under test is that the setter is wired at all: an unassigned
    // applyMeetingAssistMode throws here rather than in the meeting cases.
    await h.setMeetingAssistMode(false);
    expect(h.setEnableVAD).not.toHaveBeenCalled();

    // The other half of H4: the spy the HOOK holds records its argument and
    // delegates to the setter. Called directly here because no shipped code
    // path writes enableVAD yet.
    await act(async () => {
      h.setEnableVAD(true);
    });
    expect(h.setEnableVAD).toHaveBeenCalledTimes(1);
    expect(h.setEnableVAD).toHaveBeenCalledWith(true);
    expect(h.observedVAD).toEqual([true, false, true]);

    expect(h.flushTranscript).not.toHaveBeenCalled();
  });

  it("F35b: observedVAD reports transitions, not renders, under StrictMode", async () => {
    // StrictMode double-invokes the render body, so the raw push happens twice
    // per commit. Without the collapse-on-read a strict case would see
    // [false, false] here and fail for a reason that has nothing to do with
    // the hook.
    const h = mount(makeAudio(), { strict: true });
    await flush();

    expect(h.observedVAD).toEqual([false]);

    await h.setMicOpen(true);
    expect(h.observedVAD).toEqual([false, true]);
    expect(h.setEnableVAD).not.toHaveBeenCalled();
  });
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
    const h = mount(continuous);
    await flush();

    await fire("meeting-detected"); // continuous ignore-busy: invokes nothing

    // Rule-1 sentinel: swap to a VAD-on busy session, whose ignore-busy DOES
    // query, and wait on that. The chain is FIFO, so once the sentinel is
    // observable the continuous op has already run.
    await h.setAudio(makeAudio({ capturing: true }));
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

  it("F9: defers to Meeting Assist Mode when it is actually holding the capture", async () => {
    seedStatus([true]); // the assist probe: a capture IS live
    const audio = makeAudio();
    const h = mount(audio, { meetingAssistMode: true });
    await flush();

    await fire("meeting-detected");

    // One query - the assist probe - and nothing else. Asserting the exact count
    // is what makes this discriminate: a hook that skipped the probe and deferred
    // on the bare pill would report 0 here and still "pass" a
    // startCapture-not-called assertion. `ignore-active` is tested BEFORE the
    // meeting fork, so this outranks F36's start.
    await waitFor(() => expect(statusCalls()).toBe(1));
    expect(audio.startCapture).not.toHaveBeenCalled();
    // Deferring means deferring: a live guest half is already recording this
    // call, and opening the mic on top of it would double it.
    expect(h.setEnableVAD).not.toHaveBeenCalled();
    expect(mocks.toast.info).not.toHaveBeenCalled();
    expect(mocks.toast.error).not.toHaveBeenCalled();
  });

  it("F9c: defers when the assist probe cannot be read", async () => {
    // Conservative default, matching the ignore-busy cross-check: an unreadable
    // status must never be licence to stomp a live Meeting Assist session.
    mocks.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "get_capture_status") throw new Error("ipc down");
      return undefined;
    });
    const audio = makeAudio();
    const h = mount(audio, { meetingAssistMode: true });
    await flush();

    await fire("meeting-detected");

    await waitFor(() => expect(statusCalls()).toBe(1));
    expect(audio.startCapture).not.toHaveBeenCalled();
    // The probe defaults to held, so this lands on ignore-active - before the
    // meeting fork - and claims no mic either.
    expect(h.setEnableVAD).not.toHaveBeenCalled();
    expect(mocks.toast.info).not.toHaveBeenCalled();
    expect(mocks.toast.error).not.toHaveBeenCalled();
  });

  it("F9d: does not probe when the switch is off or a session is already open", async () => {
    // The probe must stay behind the cheap branches. Without this, every detection
    // with the pill on costs an IPC round trip even when the feature is off.
    stored.meeting_auto_record_enabled = "false";
    const audio = makeAudio();
    const h = mount(audio, { meetingAssistMode: true });
    await flush();

    await fire("meeting-detected"); // ignore-off: no probe

    // Rule 1 FIFO sentinel: the off branch is silent, so drive a second detect
    // down ignore-busy - which queries exactly once - and wait on that. The chain
    // is FIFO, so observing the sentinel proves the off op already ran.
    stored.meeting_auto_record_enabled = "true";
    await fire("meeting-detection-setting-changed", { enabled: true });
    await h.setAudio(makeAudio({ capturing: true }));
    await fire("meeting-detected"); // ignore-busy: one query, and no assist probe

    await waitFor(() => expect(statusCalls()).toBe(1));
    expect(audio.startCapture).not.toHaveBeenCalled();
    // Neither ignore-off nor ignore-busy may open the mic: both are decided
    // ahead of the meeting fork, pill or no pill.
    expect(h.setEnableVAD).not.toHaveBeenCalled();
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

describe("useMeetingAutoRecord - start", () => {
  it("F1: starts on detection when the key is seeded on", async () => {
    seedStatus([true]);
    const audio = makeAudio();

    mount(audio);
    await flush();
    await fire("meeting-detected");

    await waitFor(() => expect(audio.startCapture).toHaveBeenCalledTimes(1));
    // VAD-only: this slice must never drive continuous recording.
    expect(audio.startContinuousRecording).not.toHaveBeenCalled();
  });

  it("F2: does NOT start when only the legacy key is set", async () => {
    stored = { meeting_detection_enabled: "true" };
    const audio = makeAudio();

    mount(audio);
    await flush();
    await fire("meeting-detected");
    // FIFO sentinel: ignore-off invokes nothing, so enable and fire again.
    stored.meeting_auto_record_enabled = "true";
    await fire("meeting-detection-setting-changed", { enabled: true });
    seedStatus([true]);
    await fire("meeting-detected");

    await waitFor(() => expect(audio.startCapture).toHaveBeenCalledTimes(1));
  });

  it("F3: starts after the switch is turned on by event", async () => {
    stored = {};
    seedStatus([true]);
    const audio = makeAudio();

    mount(audio);
    await flush();
    await fire("meeting-detection-setting-changed", { enabled: true });
    await fire("meeting-detected");

    await waitFor(() => expect(audio.startCapture).toHaveBeenCalledTimes(1));
  });

  it("F4: does not start after the switch is turned off by event", async () => {
    const audio = makeAudio();

    mount(audio);
    await flush();
    await fire("meeting-detection-setting-changed", { enabled: false });
    await fire("meeting-detected");
    // Sentinel: re-enable and fire again to prove the chain has drained.
    seedStatus([true]);
    await fire("meeting-detection-setting-changed", { enabled: true });
    await fire("meeting-detected");

    await waitFor(() => expect(audio.startCapture).toHaveBeenCalledTimes(1));
  });

  it("F14: awaits startCapture before querying status", async () => {
    // Every mock startCapture elsewhere in this file resolves immediately, so
    // deleting the `await` before startCapture() in the start sequence leaves the
    // rest of the suite green. A held promise makes the ordering itself the
    // assertion: with the await removed, get_capture_status fires right away and
    // statusCalls() is already 1 below, before releaseStart() ever runs.
    seedStatus([true]);
    let releaseStart: () => void = () => {};
    const audio = makeAudio({
      startCapture: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            releaseStart = resolve;
          })
      ),
    });

    mount(audio);
    await flush();
    await fire("meeting-detected");

    expect(statusCalls()).toBe(0);

    releaseStart();
    await waitFor(() => expect(statusCalls()).toBe(1));
  });
});

describe("useMeetingAutoRecord - meeting mode start", () => {
  it("F36: opens the mic and claims provenance when the Meeting pill is on", async () => {
    seedStatus([false]); // the probe: nothing holds the global capture
    const audio = makeAudio();
    const h = mount(audio, { meetingAssistMode: true });
    await flush();

    await fireActed("meeting-detected");

    await waitFor(() => expect(h.setEnableVAD).toHaveBeenCalledTimes(1));
    expect(h.setEnableVAD).toHaveBeenCalledWith(true);
    expect(h.observedVAD).toEqual([false, true]);

    // Opening the mic IS the start: AutoSpeechVad, useMeetingAudio and the
    // diarization buffer are all gated on enableVAD. Driving the transcribing
    // pipeline as well would record the same call twice.
    expect(audio.startCapture).not.toHaveBeenCalled();
    expect(audio.startContinuousRecording).not.toHaveBeenCalled();

    // The probe, and nothing else. Pinning the count is what separates the
    // meeting fork from the transcribing one, which queries a second time to
    // confirm the start.
    expect(statusCalls()).toBe(1);
    expect(mocks.toast.info).not.toHaveBeenCalled();
    expect(mocks.toast.error).not.toHaveBeenCalled();
  });

  it("F37: declines a mic the user already had open", async () => {
    seedStatus([false]); // the probe: idle, so ignore-active cannot mask this
    const audio = makeAudio();
    const h = mount(audio, { meetingAssistMode: true });
    await flush();
    await h.setMicOpen(true); // the USER, bypassing the spy - see F35

    await fireActed("meeting-detected");

    await waitFor(() => expect(statusCalls()).toBe(1));
    expect(h.setEnableVAD).not.toHaveBeenCalled();
    expect(audio.startCapture).not.toHaveBeenCalled();
    expect(mocks.toast.info).not.toHaveBeenCalled();
    expect(mocks.toast.error).not.toHaveBeenCalled();

    // The other half of "declined": no provenance was recorded either, so the
    // call ending cannot close a mic this hook never opened. Today that is a
    // forward guard rather than the killing clause - the meeting-mode stop has
    // not landed, so meeting-ended is inert whatever provenance says, and it is
    // the setEnableVAD assertion above that catches a hook claiming anyway.
    // TODO(meeting-mode stop): live once handleStop grows its stop-meeting
    // branch - tighten rather than assume it already discriminates.
    await fireActed("meeting-ended");
    expect(h.setEnableVAD).not.toHaveBeenCalled();
    expect(audio.stopCapture).not.toHaveBeenCalled();
    expect(h.observedVAD).toEqual([false, true]); // the user's write, only
  });

  it("F38: declines a mic opened DURING the capture-status round trip", async () => {
    // The ordering case. An IPC round trip is a macrotask, so the user can open
    // the mic inside it; a vadOpen read taken before the await would still say
    // false, claim the session, and later close their mic.
    //
    // Two sequential acts, never one. enableVADRef is mirrored from a LAYOUT
    // effect, so it only moves on COMMIT; releasing the probe in the same act
    // that writes the mic races the op's continuation against that commit, and
    // a correct hook can read false there too - the case would then pass while
    // killing nothing. The first act must close before the second opens for the
    // same reason nothing here ever nests one act inside another.
    let releaseProbe!: (held: boolean) => void;
    mocks.invoke.mockImplementation(async (cmd: string) =>
      cmd === "get_capture_status"
        ? new Promise<boolean>((resolve) => {
            releaseProbe = resolve;
          })
        : undefined
    );
    const audio = makeAudio();
    const h = mount(audio, { meetingAssistMode: true });
    await flush();

    await fireActed("meeting-detected"); // parks on the probe
    await waitFor(() => expect(statusCalls()).toBe(1));

    await h.setMicOpen(true); // act 1: the mirror commits
    await act(async () => {
      // act 2: the op resumes and reads it. An async act drains to a macrotask
      // boundary, so the op has finished by the time this returns.
      releaseProbe(false);
      await flush();
    });

    expect(h.setEnableVAD).not.toHaveBeenCalled();
    expect(audio.startCapture).not.toHaveBeenCalled();
    expect(h.observedVAD).toEqual([false, true]); // the user's write, only
    expect(statusCalls()).toBe(1);

    // TODO(meeting-mode stop): inert today for the reason spelled out in F37.
    await fireActed("meeting-ended");
    expect(h.setEnableVAD).not.toHaveBeenCalled();
    expect(audio.stopCapture).not.toHaveBeenCalled();
  });

  it("F39: two detections in one tick claim once and commit once", async () => {
    seedStatus([false, false]); // one probe per op
    const audio = makeAudio();
    const h = mount(audio, { meetingAssistMode: true });
    await flush();

    await act(async () => {
      emit("meeting-detected");
      emit("meeting-detected");
      await flush();
    });

    // Both ops genuinely run - they share the chain, so op B probes too, and
    // this count is what stops the case passing on op A alone.
    await waitFor(() => expect(statusCalls()).toBe(2));

    // ...and op B declines, because its post-probe read lands AFTER React has
    // committed op A's write. MEASURED, not assumed: React 19 processes the
    // root schedule from a microtask, and under act() that beats the remaining
    // hops of op B's own probe. Pinning ONE call is therefore the anti-re-entrancy
    // assertion - a hook that ignored vadOpen entirely claims twice here and
    // fails. (Production has no act queue, so the commit may instead land after
    // op B; that is equally safe, because the claim is idempotent and the second
    // write is a React bailout. Only the act-driven ordering is observable here.)
    expect(h.setEnableVAD.mock.calls).toEqual([[true]]);
    expect(h.observedVAD).toEqual([false, true]); // exactly one commit
    expect(audio.startCapture).not.toHaveBeenCalled();

    // Two ended events, because handleStop clears provenance first: a single one
    // cannot tell a correct stop from one that would fire twice. The meeting-mode
    // stop lands with that path; today both are inert, and what this pins is that
    // NEITHER writes the mic closed behind the user's back in the meantime.
    await fireActed("meeting-ended");
    await fireActed("meeting-ended");
    expect(h.setEnableVAD.mock.calls).toEqual([[true]]);
    expect(audio.stopCapture).not.toHaveBeenCalled();
  });

  it("F40: releases ownership and flushes when the mic goes closed", async () => {
    seedStatus([false]);
    const audio = makeAudio();
    const h = mount(audio, { meetingAssistMode: true });
    await flush();

    await fireActed("meeting-detected");
    await waitFor(() => expect(h.setEnableVAD).toHaveBeenCalledTimes(1));

    // The commit that OPENS the mic must not release anything - it is the one
    // that claimed it.
    expect(h.flushTranscript).not.toHaveBeenCalled();

    await h.setMicOpen(false); // the user closes it mid-call

    // Nothing else saves the tail: the periodic autosave is length-driven, and
    // setMeetingAssistMode's flush only fires when the PILL moves.
    expect(h.flushTranscript).toHaveBeenCalledTimes(1);
    // Releasing is not a mic write - the mic is already closed.
    expect(h.setEnableVAD).toHaveBeenCalledTimes(1);
    expect(h.observedVAD).toEqual([false, true, false]);

    // The RELEASE half, and it needs a second commit to be visible at all: the
    // mirror effect has no dependency array, so it re-enters this branch on
    // every render of <Completion /> - which re-renders per streamed AI chunk.
    // A build that flushed but left provenance set would fire a transcript save
    // on each one for the rest of the session, and the assertions above cannot
    // tell it apart from a correct one. Any commit that changes nothing relevant
    // will do; a fresh audio object is the cheapest.
    await h.setAudio(makeAudio());

    expect(h.flushTranscript).toHaveBeenCalledTimes(1);
  });
});

describe("useMeetingAutoRecord - start failure", () => {
  it("F15: toasts, tears down, and claims no provenance", async () => {
    seedStatus([false]);
    const audio = makeAudio();

    mount(audio);
    await flush();
    await fire("meeting-detected");

    await waitFor(() => expect(mocks.toast.error).toHaveBeenCalledTimes(1));
    expect(mocks.toast.error).toHaveBeenCalledWith(GENERIC_START_MESSAGE);
    // startCapture already set capturing and opened the popover before failing,
    // so toasting alone would leave the UI claiming to record nothing.
    expect(audio.stopCapture).toHaveBeenCalledTimes(1);

    await fire("meeting-ended");
    await flush();
    expect(audio.stopCapture).toHaveBeenCalledTimes(1); // not called again
  });

  it("F15b: a confirmed start toasts nothing and tears nothing down", async () => {
    seedStatus([true]);
    const audio = makeAudio();

    mount(audio);
    await flush();
    await fire("meeting-detected");

    await waitFor(() => expect(audio.startCapture).toHaveBeenCalledTimes(1));
    expect(mocks.toast.error).not.toHaveBeenCalled();
    expect(audio.stopCapture).not.toHaveBeenCalled();
  });

  it("F16: a REJECTED confirmation is treated as a failed start", async () => {
    // The only case that fails if `.catch(() => false)` is dropped: without it the
    // rejection escapes to the chain's catch, so no toast, no teardown, and the UI
    // is left claiming to record.
    mocks.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "get_capture_status") throw new Error("ipc down");
      return undefined;
    });
    const audio = makeAudio();

    mount(audio);
    await flush();
    await fire("meeting-detected");

    await waitFor(() => expect(mocks.toast.error).toHaveBeenCalledTimes(1));
    expect(audio.stopCapture).toHaveBeenCalledTimes(1);

    await fire("meeting-ended");
    await flush();
    expect(audio.stopCapture).toHaveBeenCalledTimes(1);
  });

  it("F17: the toast carries the real error set DURING startCapture", async () => {
    seedStatus([false]);
    const audio = makeAudio();
    let h: ReturnType<typeof mount>;
    // Setting `error` from inside the mock is what makes this discriminate: a
    // static mount prop passes even against a hook that snapshots systemAudio once
    // at the top of the op, which is the bug this guards.
    //
    // setAudioSync, not setAudio: this runs inside fireActed's act, where a
    // nested act would overlap, and a commit deferred to a macrotask would land
    // AFTER the hook has read the error - which toasts the generic message and
    // passes against a correct hook.
    audio.startCapture = vi.fn(async () => {
      h.setAudioSync({ ...audio, error: "Failed to access system audio" });
    });

    h = mount(audio);
    await flush();
    await fireActed("meeting-detected");

    await waitFor(() => expect(mocks.toast.error).toHaveBeenCalledTimes(1));
    expect(mocks.toast.error).toHaveBeenCalledWith(
      "Failed to access system audio"
    );
  });

  it("F18: only one start-failure toast per run", async () => {
    seedStatus([false, false]); // one confirmation per failed start
    const audio = makeAudio();

    mount(audio);
    await flush();
    await fire("meeting-detected");
    await fire("meeting-detected");

    await waitFor(() => expect(audio.startCapture).toHaveBeenCalledTimes(2));
    expect(mocks.toast.error).toHaveBeenCalledTimes(1);
  });
});

describe("useMeetingAutoRecord - stop", () => {
  it("F19: stops a session it started", async () => {
    seedStatus([true, false]); // confirm start, then post-stop re-query
    const audio = makeAudio();

    mount(audio);
    await flush();
    await fire("meeting-detected");
    await waitFor(() => expect(audio.startCapture).toHaveBeenCalledTimes(1));
    await fire("meeting-ended");

    await waitFor(() => expect(audio.stopCapture).toHaveBeenCalledTimes(1));
  });

  it("F20: never stops a session the user started by hand", async () => {
    // The provenance regression test. capturing:true means the detect is ignored,
    // so no provenance is ever claimed and meeting-ended must do nothing.
    seedStatus([true]); // the ignore-busy cross-check only
    const audio = makeAudio({ capturing: true });

    mount(audio);
    await flush();
    await fire("meeting-detected");
    await waitFor(() => expect(statusCalls()).toBe(1));
    await fire("meeting-ended");
    await flush();

    expect(audio.stopCapture).not.toHaveBeenCalled();
  });

  it("F21: a capture-stopped event disowns the session", async () => {
    seedStatus([true]);
    const audio = makeAudio();

    mount(audio);
    await flush();
    await fire("meeting-detected");
    await waitFor(() => expect(audio.startCapture).toHaveBeenCalledTimes(1));

    await fire("capture-stopped"); // the user stopped it by hand
    await fire("meeting-ended");
    await flush();

    expect(audio.stopCapture).not.toHaveBeenCalled();
  });

  it("F22: a stop that did not take toasts, and provenance is still cleared", async () => {
    seedStatus([true, true]); // confirm start, then STILL capturing after the stop
    const audio = makeAudio();

    mount(audio);
    await flush();
    await fire("meeting-detected");
    await waitFor(() => expect(audio.startCapture).toHaveBeenCalledTimes(1));
    await fire("meeting-ended");

    await waitFor(() => expect(mocks.toast.error).toHaveBeenCalledTimes(1));
    expect(mocks.toast.error).toHaveBeenCalledWith(STOP_FAILED_MESSAGE);

    // Provenance must be cleared by the stop link ITSELF - a failed stop emits no
    // capture-stopped, so nothing else would ever clear it.
    await fire("meeting-ended");
    await flush();
    expect(audio.stopCapture).toHaveBeenCalledTimes(1);
  });

  it("F22b: a clean stop toasts nothing", async () => {
    seedStatus([true, false]);
    const audio = makeAudio();

    mount(audio);
    await flush();
    await fire("meeting-detected");
    await waitFor(() => expect(audio.startCapture).toHaveBeenCalledTimes(1));
    await fire("meeting-ended");

    await waitFor(() => expect(audio.stopCapture).toHaveBeenCalledTimes(1));
    expect(mocks.toast.error).not.toHaveBeenCalled();
  });

  it("F22c: an UNREADABLE post-stop status is reported, not assumed clean", async () => {
    // The `let stillActive = true` default. Flipping it to false is silent and
    // leaves a live recording nothing will ever stop again - so it needs a test
    // that rejects the query, which no other case does.
    seedStatus([true]); // confirm the start, then swap to rejecting
    const audio = makeAudio();

    mount(audio);
    await flush();
    await fire("meeting-detected");
    await waitFor(() => expect(audio.startCapture).toHaveBeenCalledTimes(1));

    mocks.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "get_capture_status") throw new Error("ipc down");
      return undefined;
    });
    await fire("meeting-ended");

    await waitFor(() => expect(mocks.toast.error).toHaveBeenCalledTimes(1));
    expect(mocks.toast.error).toHaveBeenCalledWith(STOP_FAILED_MESSAGE);
    // Provenance is still cleared by the finally, so a second ended is a no-op.
    await fire("meeting-ended");
    await flush();
    expect(audio.stopCapture).toHaveBeenCalledTimes(1);
  });
});

describe("useMeetingAutoRecord - watcher lifecycle", () => {
  it("F23: warns but keeps recording when the watcher dies mid-session", async () => {
    seedStatus([true]);
    const audio = makeAudio();

    mount(audio);
    await flush();
    await fire("meeting-detected");
    await waitFor(() => expect(audio.startCapture).toHaveBeenCalledTimes(1));

    await fire("meeting-watcher-stopped");

    expect(mocks.toast.warning).toHaveBeenCalledTimes(1);
    expect(mocks.toast.warning).toHaveBeenCalledWith(WATCHER_STOPPED_MESSAGE);
    // Deliberate: a transient watcher death must not truncate a real recording.
    expect(audio.stopCapture).not.toHaveBeenCalled();
  });

  it("F23b: says nothing when the watcher dies with nothing recording", async () => {
    const audio = makeAudio();

    mount(audio);
    await flush();
    await fire("meeting-watcher-stopped");

    expect(mocks.toast.warning).not.toHaveBeenCalled();
  });

  it("F24: turning the switch off mid-recording stops it", async () => {
    // This path has no other exit: stop_meeting_watcher sets explicit_stop, which
    // SUPPRESSES meeting-watcher-stopped, and no meeting-ended will ever arrive.
    seedStatus([true, false]);
    const audio = makeAudio();

    mount(audio);
    await flush();
    await fire("meeting-detected");
    await waitFor(() => expect(audio.startCapture).toHaveBeenCalledTimes(1));

    await fire("meeting-detection-setting-changed", { enabled: false });

    await waitFor(() => expect(audio.stopCapture).toHaveBeenCalledTimes(1));
  });

  it("F24b: turning the switch off with nothing recording stops nothing", async () => {
    const audio = makeAudio();

    mount(audio);
    await flush();
    await fire("meeting-detection-setting-changed", { enabled: false });
    await flush();

    expect(audio.stopCapture).not.toHaveBeenCalled();
  });

  it("F25: the chain serializes, so a queued op sees the toggle-off", async () => {
    // [confirm start A, post-stop re-query]. The toggle-off legitimately enqueues a
    // stop behind ops A and B, and by the time it runs A has confirmed - so this
    // case also demonstrates switch-off-while-recording end to end.
    seedStatus([true, false]);
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const audio = makeAudio();
    audio.startCapture = vi.fn(async () => {
      await held;
    });

    mount(audio);
    await flush();
    await fire("meeting-detected"); // op A, now in flight and parked
    await waitFor(() => expect(audio.startCapture).toHaveBeenCalledTimes(1));

    await fire("meeting-detected"); // op B queues behind A
    await fire("meeting-detection-setting-changed", { enabled: false });
    release();

    // Settle FIRST on a positive marker (rule 1), then assert the absence. Op A
    // confirms and claims provenance, so the toggle-off's stop runs against it.
    await waitFor(() => expect(audio.stopCapture).toHaveBeenCalledTimes(1));
    // Op B re-read enabledRef and found it false, so it never started a second
    // capture. This is the case's unique value: it is the ONLY one that fails
    // against a fire-and-forget `enqueue`, because without serialization B would
    // have run concurrently with A and started one.
    expect(audio.startCapture).toHaveBeenCalledTimes(1);
  });
});

describe("useMeetingAutoRecord - structure", () => {
  it("F26: handles two calls back to back", async () => {
    // confirm start 1, post-stop re-query, confirm start 2. Pin ALL THREE: an
    // unpinned third call defaults to false and fires a spurious teardown
    // stopCapture, breaking this case against a CORRECT hook.
    seedStatus([true, false, true]);
    const audio = makeAudio();

    mount(audio);
    await flush();
    await fire("meeting-detected");
    await waitFor(() => expect(audio.startCapture).toHaveBeenCalledTimes(1));
    await fire("meeting-ended");
    await waitFor(() => expect(audio.stopCapture).toHaveBeenCalledTimes(1));
    await fire("meeting-detected");

    await waitFor(() => expect(audio.startCapture).toHaveBeenCalledTimes(2));
    expect(audio.stopCapture).toHaveBeenCalledTimes(1);
  });

  it("F27: a rejected command does not poison the chain", async () => {
    const audio = makeAudio();
    audio.startCapture = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue(undefined);
    seedStatus([true]);

    mount(audio);
    await flush();
    await fire("meeting-detected"); // rejects
    await fire("meeting-detected"); // must still run

    await waitFor(() => expect(audio.startCapture).toHaveBeenCalledTimes(2));
  });

  it("F28: a capture-stopped mid-flight does not block later provenance", async () => {
    // Regression guard, not a live bug: stop_system_audio_capture (which emits
    // capture-stopped, commands.rs:490) is issued by startCapture at
    // useSystemAudio.ts:613, BEFORE the real start at :621 - so in production
    // this event always lands before startedModeRef is assigned, which happens
    // two further IPC round trips later (the real start, then the confirmation
    // query). If that ordering ever inverted - the event delivered AFTER
    // provenance is claimed - the capture-stopped listener would clear a live
    // auto-started session's provenance, and the following meeting-ended would
    // return silently at the decideOnEnded gate: a leaked recording with no
    // toast at all. This pins the current, correct ordering so a refactor that
    // assigns provenance before startCapture resolves gets caught here.
    seedStatus([true, false]); // confirm start, then post-stop re-query
    let releaseStart: () => void = () => {};
    const audio = makeAudio({
      startCapture: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            releaseStart = resolve;
          })
      ),
    });

    mount(audio);
    await flush();
    await fire("meeting-detected");
    await waitFor(() => expect(audio.startCapture).toHaveBeenCalledTimes(1));

    await fire("capture-stopped"); // fires while startCapture is still pending
    releaseStart();
    await waitFor(() => expect(statusCalls()).toBe(1));

    await fire("meeting-ended");

    await waitFor(() => expect(audio.stopCapture).toHaveBeenCalledTimes(1));
  });

  it("F29: StrictMode does not double-register or double-start", async () => {
    seedStatus([true]);
    const audio = makeAudio();

    mount(audio, { strict: true });
    await flush();

    expect(registered("meeting-detected")).toBe(1);

    await fire("meeting-detected");
    await waitFor(() => expect(audio.startCapture).toHaveBeenCalledTimes(1));
  });

  it("F13: all three toast budgets are independent", async () => {
    const audio = makeAudio({ vadConfig: { enabled: false } });
    const h = mount(audio);
    await flush();

    await fire("meeting-detected"); // 1: VAD

    const busy = makeAudio({ capturing: true });
    seedStatus([false]);
    await h.setAudio(busy);
    await fire("meeting-detected"); // 2: stuck
    await waitFor(() => expect(mocks.toast.error).toHaveBeenCalledTimes(1));

    const failing = makeAudio();
    seedStatus([false]);
    await h.setAudio(failing);
    await fire("meeting-detected"); // 3: start failure

    await waitFor(() => expect(mocks.toast.error).toHaveBeenCalledTimes(2));
    expect(mocks.toast.info).toHaveBeenCalledTimes(1);
    expect(mocks.toast.info).toHaveBeenCalledWith(VAD_MESSAGE);
    expect(mocks.toast.error).toHaveBeenCalledWith(STUCK_MESSAGE);
    expect(mocks.toast.error).toHaveBeenCalledWith(GENERIC_START_MESSAGE);
  });

  it("F32: uses the FRESH startCapture after a re-render", async () => {
    seedStatus([true]);
    const first = makeAudio();
    const h = mount(first);
    await flush();

    const second = makeAudio();
    await h.setAudio(second);
    await flush();
    await fire("meeting-detected");

    await waitFor(() => expect(second.startCapture).toHaveBeenCalledTimes(1));
    expect(first.startCapture).not.toHaveBeenCalled();
  });

  it("F33: uses the FRESH stopCapture after a re-render", async () => {
    // Without this, a hook that reads startCapture through the ref but closes over
    // stopCapture passes every other case - and its real consequence is that
    // summarization silently never runs for any auto-recorded meeting, because the
    // captured stopCapture holds an empty conversation.
    seedStatus([true, false]);
    const first = makeAudio();
    const h = mount(first);
    await flush();
    await fire("meeting-detected");
    await waitFor(() => expect(first.startCapture).toHaveBeenCalledTimes(1));

    const second = makeAudio();
    await h.setAudio(second);
    await flush();
    await fire("meeting-ended");

    await waitFor(() => expect(second.stopCapture).toHaveBeenCalledTimes(1));
    expect(first.stopCapture).not.toHaveBeenCalled();
  });
});
