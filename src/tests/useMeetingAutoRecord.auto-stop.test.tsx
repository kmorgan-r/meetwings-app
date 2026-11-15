import {
  StrictMode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
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
  fetchMeetings: vi.fn(),
}));

vi.mock("sonner", () => ({ toast: mocks.toast }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ label: mocks.windowLabel.value }),
}));
vi.mock("@/lib/platform", () => ({ isWindows: mocks.isWindows }));
vi.mock("@/lib/calendar/fetch-current-meetings", () => ({
  fetchCurrentMeetings: mocks.fetchMeetings,
}));

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
// at the shipped 300ms a five-attempt loop measures 1548ms, and RTL's waitFor
// budget is 1000ms - so this override is mandatory, not prudent. Only the
// INTERVAL is overridden: STOP_CONFIRM_ATTEMPTS is asserted against below, and
// a case that pinned a shortened count would stop describing the real loop.
vi.mock("@/config/constants", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  STOP_CONFIRM_INTERVAL_MS: 5,
  // Above 2 * CALL_END_GRACE_MS plus headroom: a grace case watches the mic
  // for 2 * GRACE after meeting-ended, and a silence stop landing inside that
  // window would read as the grace firing when it should have been cancelled.
  SILENCE_STOP_MS: 600,
  CALL_END_GRACE_MS: 150,
  SAME_CALL_READ_TIMEOUT_MS: 100,
}));

// The REAL cap module with a pass-through spy on the setter: the I3 cases take
// the cap the way useMeetingLog does, so the held value must be real.
const stopCap = vi.hoisted(() => ({
  set: vi.fn(),
  real: null as null | typeof import("@/lib/recording-stop-cap"),
}));
vi.mock("@/lib/recording-stop-cap", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/recording-stop-cap")>();
  stopCap.real = real;
  stopCap.set.mockImplementation(real.setRecordingStopCap);
  return { ...real, setRecordingStopCap: stopCap.set };
});

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
  MEETING_STOP_FAILED_MESSAGE,
  MEETING_WATCHER_STOPPED_MESSAGE,
  STOP_FAILED_MESSAGE,
  STUCK_MESSAGE,
  useMeetingAutoRecord,
  VAD_MESSAGE,
  WATCHER_STOPPED_MESSAGE,
} from "@/hooks/useMeetingAutoRecord";
import {
  getActiveAutoRecording,
  getMeetingCard,
  resetMeetingCardsForTests,
  stopActiveRecording,
} from "@/lib/meeting-cards.store";
// Through the mock above, so these are the values the HOOK is running on here,
// not the shipped ones: the drain has to outlast the loop as it actually
// behaves in this file, and the attempt count has to match what it really does.
import {
  STOP_CONFIRM_ATTEMPTS,
  STOP_CONFIRM_INTERVAL_MS,
  SILENCE_STOP_MS as SILENCE,
  CALL_END_GRACE_MS as GRACE,
  // Task 9's same-call read bound; imported here so it arrives mocked too.
  SAME_CALL_READ_TIMEOUT_MS as READ_TIMEOUT,
} from "@/config/constants";
import { takeRecordingStopCap } from "@/lib/recording-stop-cap";
import type { TranscriptEntry } from "@/types/completion";

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Outlasts the post-stop confirmation loop, which is a REAL-timer background
 * process that outlives the assertions of the case that started it.
 *
 * Called from `beforeEach` BEFORE clearAllMocks and seedStatus, because a poll
 * landing after the next case has seeded would consume its queue at index 0 and
 * fail a CORRECT implementation - in the next case, for a reason invisible
 * there. Cases that settle mid-loop call it directly as well, so an assertion
 * about a terminal poll count is not merely a snapshot taken early.
 *
 * The floor of 20ms is timer clamping and a saturated runner; the doubling is
 * headroom. Never fake timers: RTL gates its own on `typeof jest`, which Vitest
 * never defines, so waitFor's timeout is mocked too and the case hangs to the
 * 20000ms limit.
 */
const drainStopConfirm = async () => {
  await act(async () => {
    await sleep(
      STOP_CONFIRM_ATTEMPTS * Math.max(STOP_CONFIRM_INTERVAL_MS, 20) * 2
    );
  });
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
  lines?: number;
  enableVAD?: boolean;
  meetingAssistMode?: boolean;
  /** Take the cap the way useMeetingLog does, after this hook (see Probe). */
  takeCap?: boolean;
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
  const takenCaps: ReturnType<typeof takeRecordingStopCap>[] = [];

  let applyAudio!: Dispatch<SetStateAction<AudioFixture>>;
  let applyEnableVAD!: Dispatch<SetStateAction<boolean>>;
  let applyMeetingAssistMode!: Dispatch<SetStateAction<boolean>>;

  // Every write the HOOK makes goes through this spy, and only the hook's. The
  // harness's own mic writes below bypass it, and passing the raw setter would
  // record nothing at all - so a hook that writes `true` over an already-true
  // value (a React bailout: no render, no change in observedVAD) is still
  // visible here.
  // `closeTimes` is the restart judge: Date.now() of every close the hook made.
  const closeTimes: number[] = [];
  const setEnableVAD = vi.fn((value: SetStateAction<boolean>) => {
    if (value === false) closeTimes.push(Date.now());
    applyEnableVAD(value);
  });
  // Task 9 consumes this; kept in the harness so the file is the shared base.
  const startNewConversation = vi.fn(async () => {});
  let applyTranscript!: Dispatch<SetStateAction<TranscriptEntry[]>>;
  const entry = (audioSource: "microphone" | "system", n: number) =>
    ({
      original: `line ${n}`,
      timestamp: n,
      audioSource,
    }) satisfies TranscriptEntry;

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

    const [meetingTranscript, setTranscript] = useState<TranscriptEntry[]>(() =>
      Array.from({ length: opts.lines ?? 0 }, (_, i) => entry("system", i))
    );
    applyTranscript = setTranscript;

    useMeetingAutoRecord({
      systemAudio,
      enableVAD,
      setEnableVAD: stableSetEnableVAD,
      meetingAssistMode,
      flushUnsavedMeetingTranscript: flushTranscript,
      meetingTranscript,
      startNewConversation,
    });

    // useMeetingLog stand-in, AFTER the hook as in <Completion />: its
    // recording-stop edge (a layout effect, compare before assign) and its
    // unmount trigger (a passive cleanup) both take the cap synchronously.
    const recording = meetingAssistMode && enableVAD;
    const prevRecordingRef = useRef(recording);
    const recordingRef = useRef(recording);
    useLayoutEffect(() => {
      const prev = prevRecordingRef.current;
      prevRecordingRef.current = recording;
      recordingRef.current = recording;
      if (opts.takeCap && prev && !recording) takenCaps.push(takeRecordingStopCap());
    }, [recording]);
    useEffect(
      () => () => {
        if (opts.takeCap && recordingRef.current) takenCaps.push(takeRecordingStopCap());
      },
      []
    );
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
    closeTimes,
    startNewConversation,
    flushTranscript,
    /** What the useMeetingLog stand-in took, in order (`takeCap` only). */
    takenCaps,
    unmount: () => view.unmount(),
    /** A new transcript line: the length changes. */
    appendLine: async (audioSource: "microphone" | "system" = "system") => {
      await act(async () => {
        applyTranscript((t) => [...t, entry(audioSource, t.length)]);
      });
    },
    /** Same length, new object at `index`: an edit, not an arrival. */
    replaceEntry: async (index: number) => {
      await act(async () => {
        applyTranscript((t) =>
          t.map((e, i) => (i === index ? { ...e, original: "edited" } : e))
        );
      });
    },
    clearTranscript: async () => {
      await act(async () => {
        applyTranscript([]);
      });
    },
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

beforeEach(async () => {
  // Drain FIRST, then clear, then seed - see drainStopConfirm. A case that
  // failed mid-loop never reached its own drain, and the next one must not
  // inherit its polls.
  await drainStopConfirm();
  // Unspied, and before the clear: a cap a case left behind must not reach
  // the next one, and the reset must not show up as a hook call.
  stopCap.real!.takeRecordingStopCap();
  vi.clearAllMocks();
  resetMeetingCardsForTests();
  listeners.clear();
  stored = { meeting_auto_record_enabled: "true" };
  mocks.windowLabel.value = "main";
  mocks.isWindows.mockReturnValue(true);
  mocks.failListenFor.clear();
  mocks.fetchMeetings.mockReset();
  mocks.fetchMeetings.mockResolvedValue({ kind: "absent" });
  seedStatus([]);
});

afterEach(() => {
  vi.useRealTimers();
});

// Timing rules (the lifecycle file's 20ms floor makes tighter gaps flake):
// "stopped" is waitFor, never a fixed sleep; "not yet" is asserted within a third
// of the timer; restart vs no restart compares the Date.now() the setEnableVAD
// spy recorded with the time of the restarting input. Timers never fire early,
// so a restarted timer stops at or after input + SILENCE.
/** Act environment off while waiting, as RTL's waitFor does itself. */
const settle = async (ms: number) => {
  const env = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const prev = env.IS_REACT_ACT_ENVIRONMENT;
  env.IS_REACT_ACT_ENVIRONMENT = false;
  try {
    await sleep(ms);
  } finally {
    env.IS_REACT_ACT_ENVIRONMENT = prev;
  }
};

const SECOND_THIRD = (SILENCE * 2) / 3;
const stopped = (h: ReturnType<typeof mount>) =>
  waitFor(() => expect(h.setEnableVAD).toHaveBeenCalledWith(false));

describe("useMeetingAutoRecord - silence stop", () => {
  it("silence closes a hand-opened mic", async () => {
    seedStatus([false]);
    const h = mount();
    await flush();
    await h.setMicOpen(true);

    await stopped(h);

    expect(getMeetingCard()).toEqual({ kind: "ended", reason: "silence" });
    expect(stopCap.set).toHaveBeenCalledWith(null);
  });

  it("does not stop before the timer", async () => {
    const h = mount();
    await flush();
    await h.setMicOpen(true);

    await sleep(SILENCE / 3);

    expect(h.setEnableVAD).not.toHaveBeenCalled();
  });

  it("each appended line restarts the silence timer", async () => {
    seedStatus([false]);
    const h = mount();
    await flush();
    await h.setMicOpen(true);
    await sleep(SECOND_THIRD);

    const lineAt = Date.now();
    await h.appendLine();
    await stopped(h);

    expect(h.closeTimes[0]).toBeGreaterThanOrEqual(lineAt + SILENCE);
  });

  it("lines already there at start do not count", async () => {
    seedStatus([false]);
    const h = mount(makeAudio(), { lines: 5 });
    await flush();
    const openAt = Date.now();
    await h.setMicOpen(true);

    await stopped(h);

    // Not at once: old lines must not read as "already silent for 15 min".
    expect(h.closeTimes[0]).toBeGreaterThanOrEqual(openAt + SILENCE);
  });

  it("editing an entry in place is not an arrival", async () => {
    seedStatus([false]);
    const h = mount(makeAudio(), { lines: 1 });
    await flush();
    await h.setMicOpen(true);
    await sleep(SECOND_THIRD);

    const editAt = Date.now();
    await h.replaceEntry(0);
    await stopped(h);

    expect(h.closeTimes[0]).toBeLessThan(editAt + SILENCE);
  });

  it("silence runs on the main window when not Windows", async () => {
    mocks.isWindows.mockReturnValue(false);
    seedStatus([false]);
    const h = mount();
    await flush();
    await h.setMicOpen(true);

    await stopped(h);
  });

  it("never on another window", async () => {
    mocks.windowLabel.value = "dashboard";
    const h = mount();
    await flush();
    await h.setMicOpen(true);

    await sleep(SILENCE * 1.5);

    expect(h.setEnableVAD).not.toHaveBeenCalled();
    expect(getMeetingCard()).toBeNull();
  });

  it("the stop keeps the quiet window for an auto-started call", async () => {
    seedStatus([false, false]); // probe, then the stop's confirm poll
    const h = mount(makeAudio(), { meetingAssistMode: true });
    await flush();
    await fireActed("meeting-detected");
    await waitFor(() => expect(h.setEnableVAD).toHaveBeenCalledWith(true));
    expect(getMeetingCard()?.kind).toBe("recording");

    await stopped(h);
    expect(getMeetingCard()).toEqual({ kind: "ended", reason: "silence" });
    await waitFor(() => expect(h.observedVAD).toEqual([false, true, false]));
    await drainStopConfirm();

    seedStatus([false]); // the second probe
    await fireActed("meeting-detected");
    await waitFor(() =>
      expect(h.observedVAD).toEqual([false, true, false, true])
    );

    // Quiet branch: the stale notice is cleared and no recording card appears.
    expect(getMeetingCard()).toBeNull();
  });

  it("an unconfirmed stop warns", async () => {
    mocks.invoke.mockImplementation(async (cmd: string) =>
      cmd === "get_capture_status" ? true : undefined
    );
    const h = mount();
    await flush();
    await h.setMicOpen(true);

    await waitFor(() =>
      expect(mocks.toast.error).toHaveBeenCalledWith(MEETING_STOP_FAILED_MESSAGE)
    );
    expect(h.setEnableVAD).toHaveBeenCalledWith(false);
  });
});

describe("useMeetingAutoRecord - call-end grace", () => {
  // Same timing rules as the silence block, against GRACE.

  /**
   * `stopped`, plus the reason: a silence stop would satisfy a bare `stopped`
   * (and does, against a hook with no grace at all).
   */
  const stoppedByGrace = async (h: ReturnType<typeof mount>) => {
    await stopped(h);
    expect(getMeetingCard()).toEqual({ kind: "ended", reason: "call-ended" });
  };

  /** A hand-opened mic in meeting mode (the production default). */
  const openByHand = async (opts: MountOptions = {}) => {
    const h = mount(makeAudio(), { meetingAssistMode: true, ...opts });
    await flush();
    await h.setMicOpen(true);
    return h;
  };

  /** Fires meeting-ended; returns the Date.now() taken just before it. */
  const endCall = async () => {
    const at = Date.now();
    await fireActed("meeting-ended");
    return at;
  };

  it("meeting-ended with the mic open waits the grace, then stops", async () => {
    seedStatus([false]); // the stop's confirm poll
    const h = await openByHand();

    const endedAt = await endCall();
    const afterEnd = Date.now();
    await sleep(GRACE / 3);
    expect(h.setEnableVAD).not.toHaveBeenCalled();

    await stoppedByGrace(h);
    expect(h.closeTimes[0]).toBeGreaterThanOrEqual(endedAt + GRACE);
    expect(getMeetingCard()).toEqual({ kind: "ended", reason: "call-ended" });

    // The cap is the call's end time, set before the mic write.
    const caps = stopCap.set.mock;
    const capIdx = caps.calls.findIndex(([v]) => v !== null);
    expect(capIdx).toBeGreaterThanOrEqual(0);
    expect(caps.calls[capIdx][0]).toBeGreaterThanOrEqual(endedAt);
    expect(caps.calls[capIdx][0]).toBeLessThanOrEqual(afterEnd);
    const closeIdx = h.setEnableVAD.mock.calls.findIndex(([v]) => v === false);
    expect(caps.invocationCallOrder[capIdx]).toBeLessThan(
      h.setEnableVAD.mock.invocationCallOrder[closeIdx]
    );

    // Step 7: once confirmed, the cap is cleared - after it was set.
    await drainStopConfirm();
    expect(stopCap.set).toHaveBeenLastCalledWith(null);
    expect(caps.invocationCallOrder[caps.calls.length - 1]).toBeGreaterThan(
      caps.invocationCallOrder[capIdx]
    );
  });

  it("an auto-started recording is no longer stopped at once", async () => {
    seedStatus([false, false]); // probe, then the stop's confirm poll
    const h = mount(makeAudio(), { meetingAssistMode: true });
    await flush();
    await fireActed("meeting-detected");
    await waitFor(() => expect(h.setEnableVAD).toHaveBeenCalledWith(true));

    const endedAt = await endCall();
    await sleep(GRACE / 3);
    expect(h.setEnableVAD).not.toHaveBeenCalledWith(false);

    await stoppedByGrace(h);
    expect(h.closeTimes[0]).toBeGreaterThanOrEqual(endedAt + GRACE);
  });

  it("meeting-ended queued behind the auto-start still arms the grace", async () => {
    seedStatus([false, false]); // probe, then the stop's confirm poll
    const h = mount(makeAudio(), { meetingAssistMode: true });
    await flush();

    const endedAt = Date.now();
    await act(async () => {
      emit("meeting-detected");
      emit("meeting-ended");
      await flush();
    });

    await waitFor(() =>
      expect(h.setEnableVAD.mock.calls).toEqual([[true], [false]])
    );
    // The grace's stop, not silence's: with no arm, silence closes the mic
    // inside waitFor's budget and the lower bound alone still holds.
    expect(getMeetingCard()).toEqual({ kind: "ended", reason: "call-ended" });
    expect(h.closeTimes[0]).toBeGreaterThanOrEqual(endedAt + GRACE);
    expect(h.closeTimes[0]).toBeLessThan(endedAt + SILENCE);
    await drainStopConfirm();
    expect(h.setEnableVAD.mock.calls).toEqual([[true], [false]]);
  });

  it("a grace armed before the auto-start commits survives that commit", async () => {
    // The case above, in PRODUCTION ordering. Under act() React commits the
    // start within a few microtasks, before the queued meeting-ended op runs,
    // so the op sees the mic open and the enableVAD exception is never needed
    // (measured: deleting it leaves the case above green). Outside act the
    // commit lands on a macrotask, so the op runs first, arms on "meeting"
    // provenance, and the start's false->true commit must not cancel it.
    // RTL's own waitFor drops the act environment the same way.
    seedStatus([false, false]); // probe, then the stop's confirm poll
    const h = mount(makeAudio(), { meetingAssistMode: true });
    await flush();

    const env = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
    const prevEnv = env.IS_REACT_ACT_ENVIRONMENT;
    env.IS_REACT_ACT_ENVIRONMENT = false;
    try {
      const observedAtArm: boolean[] = [];
      emit("meeting-detected");
      emit("meeting-ended");
      // Both ops have run (microtasks) and the start has not committed yet.
      for (let i = 0; i < 20; i++) await Promise.resolve();
      observedAtArm.push(...h.observedVAD);
      expect(h.setEnableVAD.mock.calls).toEqual([[true]]);
      expect(observedAtArm).toEqual([false]);

      await waitFor(() =>
        expect(h.setEnableVAD.mock.calls).toEqual([[true], [false]])
      );
      expect(getMeetingCard()).toEqual({ kind: "ended", reason: "call-ended" });
      await sleep(STOP_CONFIRM_ATTEMPTS * Math.max(STOP_CONFIRM_INTERVAL_MS, 20) * 2);
    } finally {
      env.IS_REACT_ACT_ENVIRONMENT = prevEnv;
    }
  });

  it("meeting-ended behind a queued transcribing start stops it", async () => {
    seedStatus([true, false]); // confirm the start, then the post-stop query
    const stopAt: number[] = [];
    const audio = makeAudio({
      stopCapture: vi.fn(async () => {
        stopAt.push(Date.now());
      }),
    });
    mount(audio); // meetingAssistMode false: the transcribing path

    await flush();
    const endedAt = Date.now();
    await act(async () => {
      emit("meeting-detected");
      emit("meeting-ended");
      await flush();
    });

    await waitFor(() => expect(audio.stopCapture).toHaveBeenCalledTimes(1));
    expect(stopAt[0]).toBeLessThan(endedAt + GRACE); // no grace wait
    await sleep(GRACE * 2);
    expect(audio.stopCapture).toHaveBeenCalledTimes(1);
  });

  it("meeting-ended with the mic closed arms nothing", async () => {
    const h = mount(makeAudio(), { meetingAssistMode: true });
    await flush();

    await endCall();
    await sleep(GRACE * 2);

    expect(h.setEnableVAD).not.toHaveBeenCalled();
    expect(getMeetingCard()).toBeNull();
  });

  it("a mic-closed meeting-ended leaves no grace to close the next auto-start", async () => {
    // The half the case above cannot see: a grace armed with the mic closed is
    // cancelled by the timer's own re-check. An auto-start inside it writes
    // "meeting" provenance before its false->true commit, which takes the
    // enableVAD exception - so a phantom grace would survive and close the new
    // recording at endedAt + GRACE.
    seedStatus([false]); // the detection's probe
    const h = mount(makeAudio(), { meetingAssistMode: true });
    await flush();

    const endedAt = await endCall();
    await sleep(GRACE / 3);
    await fireActed("meeting-detected");
    await sleep(Math.max(0, endedAt + 2 * GRACE - Date.now()));

    expect(h.setEnableVAD.mock.calls).toEqual([[true]]);
    expect(getMeetingCard()?.kind).toBe("recording");
  });

  it("a system line restarts the grace", async () => {
    seedStatus([false]);
    const h = await openByHand();
    await endCall();
    await sleep((GRACE * 2) / 3);

    const lineAt = Date.now();
    await h.appendLine("system");
    await stoppedByGrace(h);

    expect(h.closeTimes[0]).toBeGreaterThanOrEqual(lineAt + GRACE);
  });

  it("a mic line does not restart the grace", async () => {
    seedStatus([false]);
    const h = await openByHand();
    await endCall();
    await sleep((GRACE * 2) / 3);

    const lineAt = Date.now();
    await h.appendLine("microphone");
    await stoppedByGrace(h);

    expect(h.closeTimes[0]).toBeLessThan(lineAt + GRACE);
  });

  it("the user moving the mic cancels the grace", async () => {
    const h = await openByHand();
    await endCall();

    await sleep(GRACE / 6);
    await h.setMicOpen(false);
    await sleep(GRACE / 6);
    await h.setMicOpen(true);
    await sleep(GRACE * 2);

    expect(h.setEnableVAD).not.toHaveBeenCalled();
  });

  it("turning auto-record off cancels the grace", async () => {
    const h = await openByHand();
    await endCall();
    await sleep(GRACE / 3);

    await fireActed("meeting-detection-setting-changed", { enabled: false });
    await sleep(GRACE * 2);

    expect(h.setEnableVAD).not.toHaveBeenCalled();
    expect(h.observedVAD).toEqual([false, true]);
  });

  it("a meeting-ended queued before auto-record is turned off arms no grace", async () => {
    const h = await openByHand();

    // One synchronous block: the arm op runs on a microtask, after the
    // setting change has already lowered the switch.
    await act(async () => {
      emit("meeting-ended");
      emit("meeting-detection-setting-changed", { enabled: false });
      await flush();
    });
    await sleep(GRACE * 2);

    expect(h.setEnableVAD).not.toHaveBeenCalled();
    expect(h.observedVAD).toEqual([false, true]);
  });

  it("watcher stopped cancels the grace", async () => {
    const h = await openByHand();
    await endCall();
    await sleep(GRACE / 3);

    await fireActed("meeting-watcher-stopped");
    await sleep(GRACE * 2);

    expect(h.setEnableVAD).not.toHaveBeenCalled();
    expect(h.observedVAD).toEqual([false, true]);
  });

  it("a second meeting-ended re-arms and never stacks", async () => {
    seedStatus([false]);
    const h = await openByHand();
    await endCall();
    await sleep(GRACE / 3);

    const secondAt = await endCall();
    await stoppedByGrace(h);
    await sleep(GRACE);

    expect(h.setEnableVAD.mock.calls).toEqual([[false]]);
    expect(h.closeTimes[0]).toBeGreaterThanOrEqual(secondAt + GRACE);
  });

  it("StrictMode runs one grace", async () => {
    seedStatus([false]);
    const h = await openByHand({ strict: true });
    await endCall();

    await stoppedByGrace(h);
    await sleep(GRACE);

    expect(h.setEnableVAD.mock.calls).toEqual([[false]]);
  });

  it("unmount clears the grace", async () => {
    // stopRecording's mountedRef guard hides a live timer from the mic, the
    // card and the cap, so the timer itself is the evidence. Pass-through
    // spies on the real timers; clearAllMocks does not restore them.
    const setSpy = vi.spyOn(globalThis, "setTimeout");
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");
    try {
      const h = await openByHand();
      await endCall();
      const idx = setSpy.mock.calls.findIndex(([, ms]) => ms === GRACE);
      expect(idx).toBeGreaterThanOrEqual(0);
      const handle = setSpy.mock.results[idx].value;
      await sleep(GRACE / 3);

      h.unmount();
      expect(clearSpy).toHaveBeenCalledWith(handle);

      await sleep(GRACE * 2);
      expect(h.setEnableVAD).not.toHaveBeenCalled();
      expect(getMeetingCard()).toBeNull();
    } finally {
      setSpy.mockRestore();
      clearSpy.mockRestore();
    }
  });

  it("a line arriving after the fire, before the queued stop, cannot revive it", async () => {
    // Park the chain on a re-detection's calendar read (a detection no longer
    // reaches its probe inside a grace: it decides same-call/new-call first), so
    // the grace stop the timer enqueues sits behind it. The read gives up at
    // READ_TIMEOUT, counts as the same call and cancels the grace; the queued
    // stop then finds its generation gone.
    mocks.fetchMeetings.mockImplementation(() => new Promise(() => {}));
    const h = await openByHand();
    await endCall();
    await sleep(GRACE - READ_TIMEOUT / 2); // read ends after the timer fires
    await fireActed("meeting-detected");

    await sleep(READ_TIMEOUT / 2 + 10); // the timer has fired; its stop is queued
    await h.appendLine("system"); // re-arms the (still live) grace
    await settle(READ_TIMEOUT + GRACE * 2);

    expect(h.setEnableVAD).not.toHaveBeenCalled();
    expect(h.observedVAD).toEqual([false, true]);
  });

  it("clearing the transcript during the grace neither stops nor re-arms", async () => {
    seedStatus([false]);
    const h = await openByHand({ lines: 3 });
    await endCall();
    await sleep((GRACE * 2) / 3); // same slack as the mic-line case

    const clearAt = Date.now();
    await h.clearTranscript();
    expect(h.setEnableVAD).not.toHaveBeenCalled();

    await stoppedByGrace(h);
    expect(h.closeTimes[0]).toBeLessThan(clearAt + GRACE);
  });

  it("after a clear, a later system line re-arms", async () => {
    seedStatus([false]);
    const h = await openByHand({ lines: 3 });
    await endCall();
    await sleep(GRACE / 6);
    await h.clearTranscript();
    await sleep(GRACE / 3);

    // One system line after the drop: a count compared against the pre-clear
    // value (3) would not see it as new.
    const lineAt = Date.now();
    await h.appendLine("system");
    await stoppedByGrace(h);

    expect(h.closeTimes[0]).toBeGreaterThanOrEqual(lineAt + GRACE);
  });
});

describe("useMeetingAutoRecord - same call or new call during the grace", () => {
  const person = (address: string) => ({
    address,
    name: null,
    type: "required" as const,
    isOrganizer: false,
  });
  const slot = (id: string, startMs: number, endMs: number) => ({
    id,
    subject: id,
    startMs,
    endMs,
    isCancelled: false,
    isAllDay: false,
    ownResponse: "accepted",
    participants: [person("a@x.com"), person("b@x.com")],
    hasMeetLink: false,
  });

  /** An auto-started meeting recording for `process`, then its meeting-ended. */
  const startAndEnd = async (process = "ms-teams.exe") => {
    const h = mount(makeAudio(), { meetingAssistMode: true });
    await flush();
    await fireActed("meeting-detected", { process });
    await waitFor(() => expect(h.setEnableVAD).toHaveBeenCalledWith(true));
    const endedAt = Date.now();
    await fireActed("meeting-ended");
    return { h, endedAt };
  };

  const recordingId = () => {
    const card = getMeetingCard();
    return card?.kind === "recording" ? card.recordingId : null;
  };

  it("same app and same slot: the grace is cancelled", async () => {
    seedStatus([false]); // the start's probe only: nothing stops
    const now = Date.now();
    mocks.fetchMeetings.mockResolvedValue({
      kind: "ok",
      events: [slot("e1", now - 60_000, now + 60_000)],
      ownAddress: null,
    });
    const { h } = await startAndEnd();
    const id = recordingId();
    expect(id).not.toBeNull();
    await sleep(GRACE / 6);

    await fireActed("meeting-detected", { process: "ms-teams.exe" });
    await settle(GRACE * 2);

    expect(h.setEnableVAD.mock.calls).toEqual([[true]]);
    expect(recordingId()).toBe(id);
    expect(h.startNewConversation).not.toHaveBeenCalled();
  });

  it("a hand-opened mic with no prior detection and an unreadable calendar counts as the same call", async () => {
    mocks.fetchMeetings.mockResolvedValue({ kind: "error", code: "GRAPH_AUTH_REJECTED" });
    const h = mount(makeAudio(), { meetingAssistMode: true });
    await flush();
    await h.setMicOpen(true);
    await fireActed("meeting-ended");
    await sleep(GRACE / 6);

    await fireActed("meeting-detected", { process: "Zoom.exe" });
    await settle(GRACE * 2);

    expect(h.setEnableVAD).not.toHaveBeenCalled();
    expect(h.startNewConversation).not.toHaveBeenCalled();
  });

  it("another app is a new call", async () => {
    seedStatus([false, false, false]); // A's probe, the stop's poll, B's probe
    const { h, endedAt } = await startAndEnd("ms-teams.exe");
    const idA = recordingId();
    await sleep(GRACE / 6);

    const detectAt = Date.now();
    await fireActed("meeting-detected", { process: "Zoom.exe" });
    await waitFor(() =>
      expect(h.setEnableVAD.mock.calls).toEqual([[true], [false], [true]])
    );

    const order = (spy: { mock: { invocationCallOrder: number[] } }, i: number) =>
      spy.mock.invocationCallOrder[i];
    expect(h.startNewConversation).toHaveBeenCalledTimes(1);
    expect(order(h.setEnableVAD, 1)).toBeLessThan(order(h.startNewConversation, 0));
    expect(order(h.startNewConversation, 0)).toBeLessThan(order(h.setEnableVAD, 2));

    // A's end exactly, never widened: by now the newest system lines are B's.
    const caps = stopCap.set.mock.calls.filter(([v]) => v !== null);
    expect(caps).toHaveLength(1);
    expect(caps[0][1]).toBe(false);
    expect(caps[0][0]).toBeGreaterThanOrEqual(endedAt);
    expect(caps[0][0]).toBeLessThan(detectAt);

    const idB = recordingId();
    expect(idB).not.toBeNull();
    expect(idB).not.toBe(idA);
    await settle(GRACE * 2); // the cancelled grace never closes B
    expect(h.setEnableVAD.mock.calls).toEqual([[true], [false], [true]]);
  });

  it("the same app in a different slot is a new call", async () => {
    seedStatus([false, false, false]);
    mocks.fetchMeetings.mockImplementation(async () => {
      const boundary = Date.now();
      return {
        kind: "ok",
        events: [
          slot("e1", boundary - 60_000, boundary),
          slot("e2", boundary, boundary + 60_000),
        ],
        ownAddress: null,
      };
    });
    const { h } = await startAndEnd();
    const idA = recordingId();
    await sleep(GRACE / 6); // endedAt is strictly before the read's boundary

    await fireActed("meeting-detected", { process: "ms-teams.exe" });
    await waitFor(() =>
      expect(h.setEnableVAD.mock.calls).toEqual([[true], [false], [true]])
    );

    expect(h.startNewConversation).toHaveBeenCalledTimes(1);
    // Same app, so a quiet (auto) stop would restart quietly with NO card.
    expect(recordingId()).not.toBeNull();
    expect(recordingId()).not.toBe(idA);
  });

  it("a failed conversation reset still records the new call", async () => {
    seedStatus([false, false, false]);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { h } = await startAndEnd();
      h.startNewConversation.mockRejectedValueOnce(new Error("reset boom"));
      await sleep(GRACE / 6);

      await fireActed("meeting-detected", { process: "Zoom.exe" });
      await waitFor(() =>
        expect(h.setEnableVAD.mock.calls).toEqual([[true], [false], [true]])
      );

      expect(errSpy).toHaveBeenCalledWith(
        "New-call conversation reset failed:",
        expect.any(Error)
      );
    } finally {
      errSpy.mockRestore();
    }
  });

  it("a grace cancelled during the calendar read is not acted on", async () => {
    let resolveRead: (v: unknown) => void = () => {};
    mocks.fetchMeetings.mockImplementation(() => new Promise((r) => (resolveRead = r)));
    const h = mount(makeAudio(), { meetingAssistMode: true });
    await flush();
    await h.setMicOpen(true); // by hand: no ended process, so the read runs
    const endedAt = Date.now();
    await fireActed("meeting-ended");
    await sleep(GRACE / 6); // endedAt is strictly before the slot boundary

    const detectAt = Date.now();
    await fireActed("meeting-detected", { process: "ms-teams.exe" });
    expect(mocks.fetchMeetings).toHaveBeenCalledTimes(1);
    // Auto-record off cancels the grace while the read is out...
    await fireActed("meeting-detection-setting-changed", { enabled: false });
    // ...and the read then says "new call".
    const boundary = Date.now();
    await act(async () => {
      resolveRead({
        kind: "ok",
        events: [
          slot("e1", endedAt - 60_000, boundary),
          slot("e2", boundary, boundary + 60_000),
        ],
        ownAddress: null,
      });
      await flush();
    });
    // Inside the read's bound, or its timeout ("same call") decided instead.
    expect(Date.now() - detectAt).toBeLessThan(READ_TIMEOUT);
    await settle(GRACE * 2);

    expect(h.setEnableVAD).not.toHaveBeenCalled();
    expect(h.startNewConversation).not.toHaveBeenCalled();
  });

  it("a hung calendar read counts as the same call and frees the chain", async () => {
    mocks.fetchMeetings.mockImplementation(() => new Promise(() => {}));
    seedStatus([false]); // the later grace stop's poll
    const h = mount(makeAudio(), { meetingAssistMode: true });
    await flush();
    await h.setMicOpen(true);
    await fireActed("meeting-ended");

    await fireActed("meeting-detected", { process: "Zoom.exe" });
    await waitFor(() => expect(mocks.fetchMeetings).toHaveBeenCalledTimes(1));
    await settle(READ_TIMEOUT + GRACE * 2);
    expect(h.setEnableVAD).not.toHaveBeenCalled();
    expect(h.startNewConversation).not.toHaveBeenCalled();

    // The chain is free: a later meeting-ended arms a grace that stops the mic.
    await fireActed("meeting-ended");
    await stopped(h);
    expect(getMeetingCard()).toEqual({ kind: "ended", reason: "call-ended" });
  });

  it("a detection after the grace stop already ran starts fresh", async () => {
    seedStatus([false, false, false]); // A's probe, the stop's poll, B's probe
    const { h } = await startAndEnd();
    await stopped(h);
    await drainStopConfirm();

    await fireActed("meeting-detected", { process: "Zoom.exe" });
    await waitFor(() =>
      expect(h.setEnableVAD.mock.calls).toEqual([[true], [false], [true]])
    );

    expect(h.startNewConversation).not.toHaveBeenCalled();
    expect(mocks.fetchMeetings).not.toHaveBeenCalled();
  });
});

describe("useMeetingAutoRecord - a mic closed during the grace is capped", () => {
  // `takeCap` adds the useMeetingLog stand-in (see mount): what it took is
  // what the written row is capped at, so a cap set too late reads as null.
  const openByHand = async (opts: MountOptions = {}) => {
    const h = mount(makeAudio(), { meetingAssistMode: true, takeCap: true, ...opts });
    await flush();
    await h.setMicOpen(true);
    return h;
  };

  /** meeting-ended; the hook's endedAt falls inside the returned window. */
  const endCall = async () => {
    const from = Date.now();
    await fireActed("meeting-ended");
    return { from, to: Date.now() };
  };

  const expectCapAtEnd = (
    cap: ReturnType<typeof takeRecordingStopCap> | undefined,
    ended: { from: number; to: number },
    widen: boolean
  ) => {
    expect(cap).toEqual({ endedAt: expect.any(Number), widen });
    expect(cap!.endedAt).toBeGreaterThanOrEqual(ended.from);
    expect(cap!.endedAt).toBeLessThanOrEqual(ended.to);
  };

  it("a hand close caps the row at the call's end", async () => {
    const h = await openByHand();
    const ended = await endCall();
    await sleep(GRACE / 3); // the close is well after `ended.to`

    await h.setMicOpen(false);

    expect(h.takenCaps).toHaveLength(1);
    expectCapAtEnd(h.takenCaps[0], ended, true);
  });

  it("the new-call stop's own close keeps its non-widening cap", async () => {
    seedStatus([false, false, false]); // A's probe, the stop's poll, B's probe
    const h = mount(makeAudio(), { meetingAssistMode: true, takeCap: true });
    await flush();
    await fireActed("meeting-detected", { process: "ms-teams.exe" });
    await waitFor(() => expect(h.setEnableVAD).toHaveBeenCalledWith(true));
    const ended = await endCall();
    await sleep(GRACE / 6);

    await fireActed("meeting-detected", { process: "Zoom.exe" });
    await waitFor(() =>
      expect(h.setEnableVAD.mock.calls).toEqual([[true], [false], [true]])
    );

    expect(h.takenCaps).toHaveLength(1);
    expectCapAtEnd(h.takenCaps[0], ended, false);
  });

  it("a hand close nothing consumes leaves no cap behind", async () => {
    const h = await openByHand({ takeCap: false });
    const ended = await endCall();
    await sleep(GRACE / 3);

    await h.setMicOpen(false);

    // Set in the close commit (so the null below is not vacuous)...
    const set = stopCap.set.mock.calls.filter(([v]) => v !== null);
    expect(set).toHaveLength(1);
    expect(set[0][0]).toBeGreaterThanOrEqual(ended.from);
    expect(set[0][0]).toBeLessThanOrEqual(ended.to);
    // ...and cleared after it, so it cannot cap a later, unrelated row.
    expect(stopCap.real!.takeRecordingStopCap()).toBeNull();
  });

  it("unmount during the grace leaves the cap for the unmount trigger", async () => {
    const h = await openByHand();
    const ended = await endCall();
    await sleep(GRACE / 3);

    h.unmount();

    expect(h.takenCaps).toHaveLength(1);
    expectCapAtEnd(h.takenCaps[0], ended, true);
  });
});

describe("useMeetingAutoRecord - unmount flush", () => {
  it("unmount with a hand-opened mic flushes once", async () => {
    const h = mount();
    await flush();
    await h.setMicOpen(true);

    h.unmount();

    expect(h.flushTranscript).toHaveBeenCalledTimes(1);
  });

  it("unmount with the mic closed does not flush", async () => {
    const h = mount();
    await flush();

    h.unmount();

    expect(h.flushTranscript).not.toHaveBeenCalled();
  });
});
