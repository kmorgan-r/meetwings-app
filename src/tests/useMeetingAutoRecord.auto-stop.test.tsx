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
// at the shipped 300ms a five-attempt loop measures 1548ms, and RTL's waitFor
// budget is 1000ms - so this override is mandatory, not prudent. Only the
// INTERVAL is overridden: STOP_CONFIRM_ATTEMPTS is asserted against below, and
// a case that pinned a shortened count would stop describing the real loop.
vi.mock("@/config/constants", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  STOP_CONFIRM_INTERVAL_MS: 5,
  SILENCE_STOP_MS: 300,
  CALL_END_GRACE_MS: 150,
  SAME_CALL_READ_TIMEOUT_MS: 100,
}));

const stopCap = vi.hoisted(() => ({
  set: vi.fn(),
  take: vi.fn(() => null),
}));
vi.mock("@/lib/recording-stop-cap", () => ({
  setRecordingStopCap: stopCap.set,
  takeRecordingStopCap: stopCap.take,
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
} from "@/config/constants";
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
  // `closeTimes` is the restart judge: Date.now() of every close the hook made.
  const closeTimes: number[] = [];
  const setEnableVAD = vi.fn((value: SetStateAction<boolean>) => {
    if (value === false) closeTimes.push(Date.now());
    applyEnableVAD(value);
  });
  // Task 9 consumes this; kept in the harness so the file is the shared base.
  const startNewConversation = vi.fn();
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
    closeTimes,
    startNewConversation,
    flushTranscript,
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
  vi.clearAllMocks();
  resetMeetingCardsForTests();
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

// Timing rules (the lifecycle file's 20ms floor makes tighter gaps flake):
// "stopped" is waitFor, never a fixed sleep; "not yet" is asserted within a third
// of the timer; restart vs no restart compares the Date.now() the setEnableVAD
// spy recorded with the time of the restarting input. Timers never fire early,
// so a restarted timer stops at or after input + SILENCE.
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
