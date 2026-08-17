import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRef } from "react";

const listeners = new Map<string, (event: unknown) => void>();
const { listen, unlisten, windowLabel } = vi.hoisted(() => ({
  listen: vi.fn(),
  unlisten: vi.fn(),
  windowLabel: { value: "main" },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ label: windowLabel.value }),
}));

// Mocked (not left real, unlike Task 9) so the incomplete-vs-absent config
// test can assert on the missing-fields message. sonner is already mounted in
// this app; the precedent is src/tests/useOdooTarget.test.tsx:45-48.
const toastMock = vi.hoisted(() => ({
  error: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
  success: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: toastMock }));

const action = vi.hoisted(() => ({
  getTranscriptWatermark: vi.fn(async () => 0),
  insertQueueRow: vi.fn(async () => true),
  readMeetingMessages: vi.fn(async () => []),
  findHeldRow: vi.fn(async () => null),
  cancelHeldRow: vi.fn(async () => true),
  claimRow: vi.fn(async () => true),
  getQueueRow: vi.fn(async () => null),
}));
vi.mock("@/lib/database/meeting-log.action", () => action);

const push = vi.hoisted(() => ({
  pushQueuedRow: vi.fn(async () => {}),
  runMeetingLogSweep: vi.fn(async () => ({ ran: true, pushed: 0 })),
  claimed: new Set<string>(),
}));
vi.mock("@/lib/odoo/meeting-log-push", () => push);

// A FULL factory, not `{...actual, loadOdooConfigState}`. The hook imports
// loadOdooConfigState directly so a partial mock would work here - but Task 10
// adds pushHeldRow, which calls requireOdooConfig, and THAT resolves the
// module-local binding a partial mock never rewires. One full factory now
// saves a confusing failure later. Precedent: src/tests/odoo-run-sync.test.ts:6-15.
const config = vi.hoisted(() => ({
  loadOdooConfigState: vi.fn(),
  requireOdooConfig: vi.fn(),
  instanceFingerprint: vi.fn((url: string, db: string) => `${url}|${db}`),
}));
vi.mock("@/lib/storage/odoo-config.storage", () => config);

const summarizer = vi.hoisted(() => ({
  generateMeetingLogSummary: vi.fn(async () => null),
}));
vi.mock("@/lib/functions/meeting-summarizer", () => summarizer);

// STATEFUL, not a static return value - mocked (rather than left real) because
// src/tests/setup.ts replaces the GLOBAL `localStorage` with an inert
// `vi.fn()` stub that never actually stores anything: `getItem` always
// returns `undefined` and `setItem` is a no-op. The real modules would
// silently "work" (every read returns the empty default) without ever
// proving a write round-trips, which is exactly the behavior these two
// findings are about. `state` is a plain object, not a mockReturnValue,
// so a write from inside the hook is visible to a later read in the SAME
// test - required to prove the skip watermark set by one trigger is seen by
// the next, and that a remount's recovered conversation id is seen by the
// hook's getActiveConversationId() call.
const watermarkStorage = vi.hoisted(() => {
  const state = { skip: 0 };
  return {
    state,
    getSkipWatermark: vi.fn(() => state.skip),
    setSkipWatermark: vi.fn((ts: number) => {
      state.skip = ts;
    }),
  };
});
vi.mock("@/lib/storage/meeting-log-watermark.storage", () => watermarkStorage);

const conversationStorage = vi.hoisted(() => {
  const state = { id: null as string | null };
  return {
    state,
    getActiveConversationId: vi.fn(() => state.id),
    setActiveConversationId: vi.fn((id: string) => {
      state.id = id;
    }),
    clearActiveConversationId: vi.fn(() => {
      state.id = null;
    }),
  };
});
vi.mock("@/lib/storage/active-conversation.storage", () => conversationStorage);

import { resetMeetingLogSweepGuard, useMeetingLog } from "@/hooks/useMeetingLog";
import type { ResolvedTarget, TranscriptEntry } from "@/types";

const CONFIG = { url: "http://h:8069", db: "odoo", login: "me@x.io", apiKey: "sk-secret" };

function entry(timestamp: number, original = "hello"): TranscriptEntry {
  return { original, timestamp, audioSource: "microphone" };
}

const DEFAULT_TARGET: ResolvedTarget = { contactId: 42, leadId: null };

/**
 * Renders the hook with a live targetRef, like <Completion /> does.
 *
 * PRESENCE CHECKS, not `??`. With `??` an explicit `target: null` falls through
 * to the default and `currentConversationId: null` falls through to "conv-1" -
 * so the two cases that need those exact nulls (an unassigned meeting, and no
 * conversation id anywhere) could not be expressed at all.
 */
function render(initial: Record<string, unknown> = {}) {
  const props0 = { meetingTranscript: [entry(1000)], ...initial };
  return renderHook(
    (props: Record<string, unknown>) => {
      const target = ("target" in props ? props.target : DEFAULT_TARGET) as ResolvedTarget | null;
      const targetRef = useRef<ResolvedTarget | null>(target);
      targetRef.current = target;
      return useMeetingLog({
        targetRef,
        meetingTranscript: (props.meetingTranscript as TranscriptEntry[]) ?? [],
        currentConversationId: ("currentConversationId" in props
          ? props.currentConversationId
          : "conv-1") as string | null,
        meetingAssistMode: ("meetingAssistMode" in props
          ? props.meetingAssistMode
          : true) as boolean,
        providerConfig: PROVIDER_CONFIG,
      });
    },
    { initialProps: props0 }
  );
}

const PROVIDER_CONFIG = {
  provider: { id: "openai" },
  selectedProvider: { provider: "openai", variables: {} },
} as never;

function fireMeetingEnded() {
  listeners.get("meeting-ended")?.({ payload: null });
}

beforeEach(() => {
  // `{ shouldAdvanceTime: true }` is REQUIRED, not stylistic.
  //
  // RTL's jestFakeTimersAreEnabled() is gated on a global `jest`, which Vitest
  // does not define, so `waitFor` takes its real-timer branch and polls with
  // the FAKED setInterval - which never fires. Every `await waitFor(...)` whose
  // condition is not already true at the first synchronous check would hang to
  // the 5s runner timeout. The repo's real precedents are
  // summary-detail.conversation-link.test.tsx:43 and
  // summary-list.meeting-date.test.tsx:42, both of which carry the same flag
  // with the same note. (useMeetingAutoRecord.lifecycle.test.tsx:340-342 is NOT
  // a precedent - it only calls useRealTimers in afterEach and never installs
  // fake timers at all.) Real drift is microseconds against a 30s hold, so the
  // negative-timing cases stay valid.
  vi.useFakeTimers({ shouldAdvanceTime: true });
  windowLabel.value = "main";
  resetMeetingLogSweepGuard();
  listeners.clear();
  // Reset the STATE behind the stateful storage mocks, not just their call
  // history - vi.clearAllMocks() in afterEach clears .mock.calls but the
  // plain `state` objects these mocks close over are not mocks themselves,
  // so a skip-mark or a seeded conversation id from one test would otherwise
  // leak into the next in file order.
  watermarkStorage.state.skip = 0;
  conversationStorage.state.id = null;
  listen.mockImplementation(async (name: string, handler: (e: unknown) => void) => {
    listeners.set(name, handler);
    // Models real deregistration. A bare `unlisten` spy that left the handler
    // in the map would make the cleanup test fail against a CORRECT
    // implementation - and the "fix" an implementer would reach for is a
    // mounted-flag inside the hook that this plan does not want.
    return () => {
      unlisten();
      listeners.delete(name);
    };
  });
  // EVERY action fn is re-stubbed, not just the four the happy path needs.
  // vi.clearAllMocks() clears calls but KEEPS implementations, so a
  // mockResolvedValue set in one test leaks into the next in file order.
  action.getTranscriptWatermark.mockResolvedValue(0);
  action.insertQueueRow.mockResolvedValue(true);
  action.readMeetingMessages.mockResolvedValue([]);
  action.findHeldRow.mockResolvedValue(null);
  action.cancelHeldRow.mockResolvedValue(true);
  action.claimRow.mockResolvedValue(true);
  action.getQueueRow.mockResolvedValue(null);
  push.runMeetingLogSweep.mockResolvedValue({ ran: true, pushed: 0 });
  push.pushQueuedRow.mockResolvedValue(undefined);
  summarizer.generateMeetingLogSummary.mockResolvedValue(null);
  config.loadOdooConfigState.mockResolvedValue({ state: "complete", config: CONFIG });
  config.requireOdooConfig.mockResolvedValue(CONFIG);
  vi.spyOn(crypto, "randomUUID").mockReturnValue(
    "row-1" as `${string}-${string}-${string}-${string}-${string}`
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("the meeting-ended trigger", () => {
  it("enqueues one row with the sliced transcript", async () => {
    render();
    await waitFor(() => expect(listeners.has("meeting-ended")).toBe(true));
    fireMeetingEnded();
    await waitFor(() => expect(action.insertQueueRow).toHaveBeenCalledTimes(1));
    expect(action.insertQueueRow.mock.calls[0][0]).toMatchObject({
      status: "held",
      transcriptStartAt: 1000,
      transcriptEndAt: 1000,
      contactId: 42,
    });
  });

  it("reads a LATE transcript through the ref, not the mount closure", async () => {
    // THE case that catches a stale-closure read. The listener is registered
    // once per window lifetime; seeding a populated transcript BEFORE mount
    // bakes it into the closure and passes against the broken implementation.
    const { rerender } = render({ meetingTranscript: [] });
    await waitFor(() => expect(listeners.has("meeting-ended")).toBe(true));
    rerender({ meetingTranscript: [entry(1000, "said after mount")] });
    fireMeetingEnded();
    await waitFor(() => expect(action.insertQueueRow).toHaveBeenCalled());
    expect(action.insertQueueRow.mock.calls[0][0].transcript).toContain("said after mount");
  });

  it("slices above the watermark, so a second meeting is its own row", async () => {
    action.getTranscriptWatermark.mockResolvedValue(1000);
    render({ meetingTranscript: [entry(1000, "meeting one"), entry(9000, "meeting two")] });
    await waitFor(() => expect(listeners.has("meeting-ended")).toBe(true));
    fireMeetingEnded();
    await waitFor(() => expect(action.insertQueueRow).toHaveBeenCalled());
    const row = action.insertQueueRow.mock.calls[0][0];
    expect(row.transcript).toContain("meeting two");
    expect(row.transcript).not.toContain("meeting one");
    expect(row.transcriptStartAt).toBe(9000);
  });

  it("writes NO row for an empty slice", async () => {
    action.getTranscriptWatermark.mockResolvedValue(5000);
    render({ meetingTranscript: [entry(1000)] });
    await waitFor(() => expect(listeners.has("meeting-ended")).toBe(true));
    fireMeetingEnded();
    await vi.advanceTimersByTimeAsync(10);
    expect(action.insertQueueRow).not.toHaveBeenCalled();
  });

  it("writes an unassigned row with NO hold when nothing is selected", async () => {
    render({ target: null });
    await waitFor(() => expect(listeners.has("meeting-ended")).toBe(true));
    fireMeetingEnded();
    await waitFor(() => expect(action.insertQueueRow).toHaveBeenCalled());
    expect(action.insertQueueRow.mock.calls[0][0]).toMatchObject({
      status: "unassigned", contactId: null,
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(push.pushQueuedRow).not.toHaveBeenCalled();
  });

  it("returns early with no row when Odoo is not configured", async () => {
    config.loadOdooConfigState.mockResolvedValue({ state: "absent", config: null });
    render();
    await waitFor(() => expect(listeners.has("meeting-ended")).toBe(true));
    fireMeetingEnded();
    await vi.advanceTimersByTimeAsync(10);
    expect(action.insertQueueRow).not.toHaveBeenCalled();
  });

  it("stops silently when the other trigger already enqueued this meeting", async () => {
    action.insertQueueRow.mockResolvedValue(false);
    render();
    await waitFor(() => expect(listeners.has("meeting-ended")).toBe(true));
    fireMeetingEnded();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(push.pushQueuedRow).not.toHaveBeenCalled();
  });
});

describe("both triggers for one meeting", () => {
  it("produces exactly one enqueue call", async () => {
    const { rerender } = render({ meetingAssistMode: true });
    await waitFor(() => expect(listeners.has("meeting-ended")).toBe(true));
    fireMeetingEnded();
    rerender({ meetingTranscript: [entry(1000)], meetingAssistMode: false });
    await waitFor(() => expect(action.insertQueueRow).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(10);
    expect(action.insertQueueRow).toHaveBeenCalledTimes(1);
  });
});

describe("the pill-off trigger", () => {
  it("fires when the pill goes true then false", async () => {
    // The positive control. Without it, an implementation with NO pill-off
    // trigger at all passes the not-on-mount case trivially and "both triggers
    // -> one row" via the meeting-ended listener alone.
    const { rerender } = render({ meetingAssistMode: true });
    rerender({ meetingTranscript: [entry(1000)], meetingAssistMode: false });
    await waitFor(() => expect(action.insertQueueRow).toHaveBeenCalledTimes(1));
  });

  it("does NOT fire on mount when the pill is already off", async () => {
    // The pill being off is its DEFAULT state, so a naive
    // useEffect([meetingAssistMode]) attempts a push on every mount -
    // including StrictMode's second and every mid-call remount.
    render({ meetingAssistMode: false });
    await vi.advanceTimersByTimeAsync(50);
    expect(action.insertQueueRow).not.toHaveBeenCalled();
  });

  it("enqueues once across many re-renders after the pill went off", async () => {
    // <Completion /> re-renders on every streamed AI chunk. Assert the CALL
    // count, not a row count: the watermark and UNIQUE(session_key) dedup rows
    // and would hide a leak entirely.
    const { rerender } = render({ meetingAssistMode: true });
    rerender({ meetingTranscript: [entry(1000)], meetingAssistMode: false });
    await waitFor(() => expect(action.insertQueueRow).toHaveBeenCalled());
    for (let i = 0; i < 5; i++) {
      rerender({ meetingTranscript: [entry(1000)], meetingAssistMode: false });
    }
    await vi.advanceTimersByTimeAsync(10);
    expect(action.insertQueueRow).toHaveBeenCalledTimes(1);
  });
});

describe("the in-flight latch", () => {
  it("lowers so a SECOND meeting in one mount is still logged", async () => {
    // A latch that never lowers means only the FIRST meeting of a window's
    // lifetime is ever logged - a total silent feature failure that no
    // single-meeting test catches.
    const { rerender } = render();
    await waitFor(() => expect(listeners.has("meeting-ended")).toBe(true));
    fireMeetingEnded();
    await waitFor(() => expect(action.insertQueueRow).toHaveBeenCalledTimes(1));

    action.getTranscriptWatermark.mockResolvedValue(1000);
    rerender({ meetingTranscript: [entry(1000), entry(9000, "second meeting")] });
    fireMeetingEnded();
    await waitFor(() => expect(action.insertQueueRow).toHaveBeenCalledTimes(2));
  });

  it("lowers after an early return too", async () => {
    action.getTranscriptWatermark.mockResolvedValue(5000);
    const { rerender } = render({ meetingTranscript: [entry(1000)] });
    await waitFor(() => expect(listeners.has("meeting-ended")).toBe(true));
    fireMeetingEnded(); // empty slice -> early return
    await vi.advanceTimersByTimeAsync(10);

    action.getTranscriptWatermark.mockResolvedValue(0);
    rerender({ meetingTranscript: [entry(9000)] });
    fireMeetingEnded();
    await waitFor(() => expect(action.insertQueueRow).toHaveBeenCalledTimes(1));
  });
});

describe("the listen() cleanup", () => {
  it("runs the handler zero times after unmount", async () => {
    // listen() returns a PROMISE of the unlisten fn; a plain `return () => un()`
    // has nothing to call yet, and under StrictMode the first mount's listen()
    // resolves AFTER the first cleanup ran. See useOdooTarget.ts:346-364.
    const { unmount } = render();
    await waitFor(() => expect(listeners.has("meeting-ended")).toBe(true));
    unmount();
    await vi.advanceTimersByTimeAsync(10);
    expect(unlisten).toHaveBeenCalled();
    fireMeetingEnded();
    await vi.advanceTimersByTimeAsync(10);
    expect(action.insertQueueRow).not.toHaveBeenCalled();
  });
});

describe("the messages fallback", () => {
  it("recovers a remount-emptied transcript from the messages table", async () => {
    // Timestamp anchored to Date.now(), not a bare small literal: the
    // recovery read is now floored at PROCESS_STARTED_AT (see useMeetingLog.ts),
    // which under this suite's fake timers is a real epoch millis value. A
    // fixture below that floor would be recovering a span the fix is
    // supposed to exclude, which is not what THIS test is checking.
    const recoveredAt = Date.now() + 10_000;
    action.readMeetingMessages.mockResolvedValue([entry(recoveredAt, "said before the remount")]);
    render({ meetingTranscript: [] });
    await waitFor(() => expect(listeners.has("meeting-ended")).toBe(true));
    fireMeetingEnded();
    await waitFor(() => expect(action.insertQueueRow).toHaveBeenCalled());
    expect(action.insertQueueRow.mock.calls[0][0].transcript).toContain("said before the remount");
  });

  it("unions the recovered entries with the in-memory slice, de-duplicated by timestamp", async () => {
    // NOT gated on "the slice is empty": if the meeting continued after the
    // remount, the new entries make the slice non-empty and the pre-remount
    // entries would be silently dropped from the push.
    //
    // Timestamps anchored to Date.now() for the same reason as the test
    // above - they must clear the PROCESS_STARTED_AT floor to still exercise
    // "recovery found something", not the containment this fix adds.
    const base = Date.now() + 10_000;
    action.readMeetingMessages.mockResolvedValue([entry(base, "before"), entry(base + 2000, "dup")]);
    render({ meetingTranscript: [entry(base + 2000, "dup"), entry(base + 4000, "after")] });
    await waitFor(() => expect(listeners.has("meeting-ended")).toBe(true));
    fireMeetingEnded();
    await waitFor(() => expect(action.insertQueueRow).toHaveBeenCalled());
    const row = action.insertQueueRow.mock.calls[0][0];
    expect(row.transcriptStartAt).toBe(base);
    expect(row.transcriptEndAt).toBe(base + 4000);
    expect(row.transcript.match(/dup/g)).toHaveLength(1);
  });

  it("issues NO fallback read when there is no conversation id anywhere", async () => {
    render({ currentConversationId: null, meetingTranscript: [entry(1000)] });
    await waitFor(() => expect(listeners.has("meeting-ended")).toBe(true));
    fireMeetingEnded();
    await waitFor(() => expect(action.insertQueueRow).toHaveBeenCalled());
    expect(action.readMeetingMessages).not.toHaveBeenCalled();
  });

  it("aborts the trigger WITHOUT writing a row when the fallback read throws", async () => {
    // A slice that could not be read is NOT an empty slice. Collapsing the two
    // loses the meeting silently, which is the failure this path exists to close.
    action.readMeetingMessages.mockRejectedValue(new Error("disk error"));
    render({ meetingTranscript: [] });
    await waitFor(() => expect(listeners.has("meeting-ended")).toBe(true));
    fireMeetingEnded();
    await vi.advanceTimersByTimeAsync(10);
    expect(action.insertQueueRow).not.toHaveBeenCalled();
  });
});

describe("the sweep kickoff", () => {
  it("runs once on mount in the main window", async () => {
    render();
    await waitFor(() => expect(push.runMeetingLogSweep).toHaveBeenCalledTimes(1));
  });

  it("does not run twice when <Completion /> remounts", async () => {
    // The effect fires once per MOUNT, and <Completion /> remount mid-session is
    // documented reachable (useOdooTarget.ts:76-81). The module single-flight
    // only joins CONCURRENT runs, so without a once-per-process flag a remount
    // storm while Odoo is unreachable re-pushes every pending row and walks
    // `attempts` to ESCALATE_AFTER_ATTEMPTS for a reason that is not the user's.
    const first = render();
    await waitFor(() => expect(push.runMeetingLogSweep).toHaveBeenCalledTimes(1));
    first.unmount();
    render();
    await vi.advanceTimersByTimeAsync(50);
    expect(push.runMeetingLogSweep).toHaveBeenCalledTimes(1);
  });
});

describe("the window-ownership gate", () => {
  it("does nothing at all outside the main window", async () => {
    // Without this, a useMeetingLog that dropped isOwner entirely - registering
    // the listener, firing the pill trigger and sweeping in EVERY window,
    // including the dashboard's full React app - stays green on every other
    // case in this file.
    windowLabel.value = "dashboard";
    const { rerender } = render({ meetingAssistMode: true });
    await vi.advanceTimersByTimeAsync(50);
    expect(listen).not.toHaveBeenCalled();
    expect(push.runMeetingLogSweep).not.toHaveBeenCalled();
    rerender({ meetingTranscript: [entry(1000)], meetingAssistMode: false });
    await vi.advanceTimersByTimeAsync(50);
    expect(action.insertQueueRow).not.toHaveBeenCalled();
  });
});

// --- Round 1 review fixes ---------------------------------------------

describe("the skip watermark", () => {
  it("CRITICAL: advances on a write failure, so the NEXT meeting does not inherit the lost one's entries", async () => {
    // meetingTranscript is never cleared at meeting end, and the DB watermark
    // only advances when a row is actually WRITTEN. Without a second,
    // independent watermark that also advances on a trigger that consumed a
    // snapshot and then failed to write, meeting two's row would splice in
    // meeting one's entries too - one customer's transcript, posted as a
    // chatter note on whichever contact is selected for the NEXT meeting.
    action.insertQueueRow.mockRejectedValueOnce(new Error("db down"));
    const { rerender } = render({ meetingTranscript: [entry(1000, "meeting one")] });
    await waitFor(() => expect(listeners.has("meeting-ended")).toBe(true));
    fireMeetingEnded();
    await waitFor(() => expect(action.insertQueueRow).toHaveBeenCalledTimes(1));

    rerender({
      meetingTranscript: [entry(1000, "meeting one"), entry(9000, "meeting two")],
    });
    fireMeetingEnded();
    await waitFor(() => expect(action.insertQueueRow).toHaveBeenCalledTimes(2));

    const secondRow = action.insertQueueRow.mock.calls[1][0];
    expect(secondRow.transcript).toContain("meeting two");
    expect(secondRow.transcript).not.toContain("meeting one");
    expect(secondRow.transcriptStartAt).toBe(9000);
  });
});

describe("the odoo-not-configured branches", () => {
  it("IMPORTANT: toasts the missing fields when Odoo is set up but incomplete, and writes no row", async () => {
    // The sweep already recordErrorOnUnsent's for exactly this state,
    // "because nothing else can" - the trigger has no row to record it on at
    // all, so silence here means the meeting vanishes with no trace
    // anywhere, unlike `absent` where silence is the right call.
    config.loadOdooConfigState.mockResolvedValue({
      state: "incomplete",
      config: null,
      missing: ["db", "apiKey"],
    });
    render();
    await waitFor(() => expect(listeners.has("meeting-ended")).toBe(true));
    fireMeetingEnded();
    await waitFor(() => expect(toastMock.error).toHaveBeenCalled());
    expect(toastMock.error.mock.calls[0][0]).toContain("db, apiKey");
    expect(action.insertQueueRow).not.toHaveBeenCalled();
  });

  it("stays silent when Odoo was never set up", async () => {
    config.loadOdooConfigState.mockResolvedValue({ state: "absent", config: null });
    render();
    await waitFor(() => expect(listeners.has("meeting-ended")).toBe(true));
    fireMeetingEnded();
    await vi.advanceTimersByTimeAsync(10);
    expect(toastMock.error).not.toHaveBeenCalled();
    expect(action.insertQueueRow).not.toHaveBeenCalled();
  });
});

describe("session-key remount stability", () => {
  it("IMPORTANT: keys a null-conversationId trigger by the recovered id, matching the pre-remount trigger's key", async () => {
    // A mid-meeting remount is documented reachable (useOdooTarget.ts:73-80).
    // Pre-remount, the hook has the live conversationId; post-remount,
    // useCompletion re-initialises it to null, and this hook can only
    // recover it through getActiveConversationId(). Keying the row on the
    // raw conversationId instead of the recovered id gives the two triggers
    // DIFFERENT session keys for the SAME meeting - "c1:1000" vs "1000" -
    // so ON CONFLICT(session_key) DO NOTHING never catches the duplicate and
    // two `held` rows get written for one meeting.
    const first = render({ currentConversationId: "c1", meetingTranscript: [entry(1000)] });
    await waitFor(() => expect(listeners.has("meeting-ended")).toBe(true));
    fireMeetingEnded();
    await waitFor(() => expect(action.insertQueueRow).toHaveBeenCalledTimes(1));
    first.unmount();

    conversationStorage.state.id = "c1";
    render({ currentConversationId: null, meetingTranscript: [entry(1000)] });
    await waitFor(() => expect(listeners.has("meeting-ended")).toBe(true));
    fireMeetingEnded();
    await waitFor(() => expect(action.insertQueueRow).toHaveBeenCalledTimes(2));

    const [preRemountRow, postRemountRow] = action.insertQueueRow.mock.calls.map((c) => c[0]);
    expect(postRemountRow.sessionKey).toBe(preRemountRow.sessionKey);
    expect(postRemountRow.conversationId).toBe("c1");
  });
});

// --- Final review fix: cross-process recovery containment ---------------

describe("the recovery floor", () => {
  it("CRITICAL: does not recover a span from a previous process, and writes no row when the in-memory transcript is empty", async () => {
    // Mirrors the real messages table: a real `readMeetingMessages` filters
    // by `timestamp > watermark` in SQL, so unlike the static mock used
    // elsewhere in this file, this one must actually apply whatever
    // watermark argument the hook passes - that argument is exactly what
    // this test is checking. A span at timestamp 1000 stands in for a
    // meeting that finished (and was autosaved) in an EARLIER run of the
    // app, before this process's PROCESS_STARTED_AT.
    const priorRunSpan = [entry(1000, "said in a previous run of the app")];
    action.readMeetingMessages.mockImplementation(async (_id: string, wm: number) =>
      priorRunSpan.filter((e) => e.timestamp > wm)
    );

    // The actual post-restart shape: the in-memory mirror is null (a fresh
    // mount never had a live conversationId to begin with) and the id is
    // recovered only through the persisted getActiveConversationId(), which
    // - per the review - is never cleared on mount or app start and so
    // survives a killed process.
    conversationStorage.state.id = "c1";
    render({ currentConversationId: null, meetingTranscript: [] });
    await waitFor(() => expect(listeners.has("meeting-ended")).toBe(true));
    fireMeetingEnded();
    await vi.advanceTimersByTimeAsync(10);

    // readMeetingMessages was still called (recoveryId is present) but with
    // a floor well above the prior run's span, so it returned nothing and no
    // row was ever queued - the excluded meeting is a deliberate silent
    // loss, not a mis-post onto whatever contact is selected in this run.
    expect(action.readMeetingMessages).toHaveBeenCalled();
    const [, floorArg] = action.readMeetingMessages.mock.calls[0];
    expect(floorArg).toBeGreaterThan(priorRunSpan[0].timestamp);
    expect(action.insertQueueRow).not.toHaveBeenCalled();
  });

  it("still recovers a span recorded after this process started", async () => {
    // The companion positive case: a span timestamped comfortably after
    // Date.now() at test time (which, under this suite's fake timers, is
    // always >= PROCESS_STARTED_AT - see useMeetingLog.ts) must still come
    // back through the same recovery path. This is the legitimate mid-call
    // remount the floor is not supposed to touch.
    const afterStart = Date.now() + 10_000;
    action.readMeetingMessages.mockImplementation(async (_id: string, wm: number) =>
      [entry(afterStart, "said after this process started")].filter((e) => e.timestamp > wm)
    );
    conversationStorage.state.id = "c1";
    render({ currentConversationId: null, meetingTranscript: [] });
    await waitFor(() => expect(listeners.has("meeting-ended")).toBe(true));
    fireMeetingEnded();
    await waitFor(() => expect(action.insertQueueRow).toHaveBeenCalled());
    expect(action.insertQueueRow.mock.calls[0][0].transcript).toContain(
      "said after this process started"
    );
  });
});
