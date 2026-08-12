import { act, renderHook, waitFor } from "@testing-library/react";
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
import { HOLD_MS, UNDO_BLOCKED_MS } from "@/lib/odoo/meeting-log";
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

describe("the hold", () => {
  it("pushes exactly once after the hold elapses", async () => {
    // The positive control. Without it, "undo -> not pushed" passes when the
    // timer was never scheduled at all.
    action.getQueueRow.mockResolvedValue({ id: "row-1", status: "held" });
    render();
    await waitFor(() => expect(listeners.has("meeting-ended")).toBe(true));
    fireMeetingEnded();
    await waitFor(() => expect(action.insertQueueRow).toHaveBeenCalled());  // 1. enqueue
    await vi.advanceTimersByTimeAsync(HOLD_MS);                              // 2. advance
    await waitFor(() => expect(push.pushQueuedRow).toHaveBeenCalledTimes(1)); // 3. assert
  });

  it("does not push before the hold elapses", async () => {
    // The `held` stub is load-bearing: pushHeldRow bails on `!row`, so with
    // getQueueRow at its beforeEach default of null this assertion would pass
    // even against an implementation whose timer fires immediately.
    action.getQueueRow.mockResolvedValue({ id: "row-1", status: "held" });
    render();
    await waitFor(() => expect(listeners.has("meeting-ended")).toBe(true));
    fireMeetingEnded();
    await waitFor(() => expect(action.insertQueueRow).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(HOLD_MS - 1000);
    expect(push.pushQueuedRow).not.toHaveBeenCalled();
  });

  it("reports holding while the window is open and false after it closes", async () => {
    action.getQueueRow.mockResolvedValue({ id: "row-1", status: "held" });
    const { result } = render();
    await waitFor(() => expect(listeners.has("meeting-ended")).toBe(true));
    fireMeetingEnded();
    await waitFor(() => expect(result.current.holding).toBe(true));
    await vi.advanceTimersByTimeAsync(HOLD_MS);
    await waitFor(() => expect(result.current.holding).toBe(false));
  });
});

describe("undo", () => {
  it("cancels the row, pushes nothing and makes no AI call", async () => {
    // Same reason as above - without this the "pushes nothing" assertion holds
    // even if onUndo never cleared the timer.
    action.getQueueRow.mockResolvedValue({ id: "row-1", status: "held" });
    const { result } = render();
    await waitFor(() => expect(listeners.has("meeting-ended")).toBe(true));
    fireMeetingEnded();
    await waitFor(() => expect(result.current.holding).toBe(true));

    result.current.onUndo();
    await waitFor(() => expect(action.cancelHeldRow).toHaveBeenCalledWith("row-1"));
    await vi.advanceTimersByTimeAsync(HOLD_MS * 2);
    expect(push.pushQueuedRow).not.toHaveBeenCalled();
    // Documentation, not a discriminator: pushQueuedRow is mocked and is the
    // only caller of `summarize`, so nothing in this suite could call it. The
    // real no-AI-call-on-undo guarantee is structural - summarization happens
    // inside pushQueuedRow, after the hold.
    expect(summarizer.generateMeetingLogSummary).not.toHaveBeenCalled();
  });

  it("surfaces a message when the timer already won the race", async () => {
    // The t=29.9s case. The user clicked Undo, the strip reacted, and the
    // meeting posts anyway - swallowing that is the highest-consequence silent
    // failure in the slice, because the whole window exists to prevent a
    // mis-post.
    action.cancelHeldRow.mockResolvedValue(false);
    const { result } = render();
    await waitFor(() => expect(listeners.has("meeting-ended")).toBe(true));
    fireMeetingEnded();
    await waitFor(() => expect(result.current.holding).toBe(true));

    result.current.onUndo();
    await waitFor(() => expect(result.current.undoBlockedMessage).toMatch(/already being sent/i));
  });

  it("clears the blocked message so the contact picker comes back", async () => {
    // <Completion /> swaps the ContactPicker trigger out whenever the strip is
    // showing, so a message that never cleared would lock the user out of
    // choosing a contact for the NEXT meeting - and the only thing that clears
    // it would be a new hold, which requires a target already selected.
    action.cancelHeldRow.mockResolvedValue(false);
    const { result } = render();
    await waitFor(() => expect(listeners.has("meeting-ended")).toBe(true));
    fireMeetingEnded();
    await waitFor(() => expect(result.current.holding).toBe(true));
    result.current.onUndo();
    await waitFor(() => expect(result.current.undoBlockedMessage).not.toBeNull());
    await vi.advanceTimersByTimeAsync(UNDO_BLOCKED_MS);
    await waitFor(() => expect(result.current.undoBlockedMessage).toBeNull());
  });
});

describe("two meetings inside one hold window", () => {
  it("pushes the displaced row immediately instead of stranding it", async () => {
    // Only one row can be undoable at a time, but the displaced one must not be
    // left `held` with no timer - stranded it waits for a sweep, and the sweep
    // runs once per process, i.e. the next app start.
    const { rerender, result } = render();
    await waitFor(() => expect(listeners.has("meeting-ended")).toBe(true));
    // Keyed on the requested id, not a blanket object: a blanket
    // { id: "row-1" } would make the assertion below pass no matter WHICH row
    // was pushed.
    action.getQueueRow.mockImplementation(async (id: string) => ({ id, status: "held" }));
    fireMeetingEnded();
    await waitFor(() => expect(result.current.holding).toBe(true));

    vi.spyOn(crypto, "randomUUID").mockReturnValue(
      "row-2" as `${string}-${string}-${string}-${string}-${string}`
    );
    action.getTranscriptWatermark.mockResolvedValue(1000);
    rerender({ meetingTranscript: [entry(1000), entry(9000, "second meeting")] });
    fireMeetingEnded();
    await waitFor(() => expect(push.pushQueuedRow).toHaveBeenCalledTimes(1));
    expect(push.pushQueuedRow.mock.calls[0][0]).toMatchObject({ id: "row-1" });
  });
});

describe("unmount during the hold", () => {
  it("clears the timer, pushes nothing itself, and does NOT cancel the row", async () => {
    // The row stays `held` and durable; the sweep's stale-held rescue owns it.
    // An unmount push would double-post against that sweep.
    action.getQueueRow.mockResolvedValue({ id: "row-1", status: "held" });
    const { result, unmount } = render();
    await waitFor(() => expect(listeners.has("meeting-ended")).toBe(true));
    fireMeetingEnded();
    // Wait for `holding`, NOT for insertQueueRow: the latter resolves at
    // INVOCATION, so startHold frequently arms its timer after unmount() and
    // the assertion below would pass for the wrong reason.
    await waitFor(() => expect(result.current.holding).toBe(true));
    unmount();
    await vi.advanceTimersByTimeAsync(HOLD_MS * 2);
    expect(push.pushQueuedRow).not.toHaveBeenCalled();
    expect(action.cancelHeldRow).not.toHaveBeenCalled();
  });
});

describe("the mount rehydrate", () => {
  it("re-arms the hold for an in-window held row and pushes once", async () => {
    // Without this a remount at t=5s makes the strip vanish while the row is
    // still nominally undoable, and the row is not pushed until a sweep runs
    // >=30s later - in practice the next app start.
    const held = { id: "rehydrated", status: "held", created_at: Date.now() - 20_000 };
    action.findHeldRow.mockResolvedValue(held);
    // pushHeldRow re-reads the row and bails unless it is still `held`, so this
    // stub is load-bearing - without it pushQueuedRow is never reached.
    action.getQueueRow.mockResolvedValue(held);
    const { result } = render();
    await waitFor(() => expect(result.current.holding).toBe(true));
    await vi.advanceTimersByTimeAsync(10_000);
    await waitFor(() => expect(push.pushQueuedRow).toHaveBeenCalledTimes(1));
    expect(push.pushQueuedRow.mock.calls[0][0]).toMatchObject({ id: "rehydrated" });
  });

  it("does not rehydrate when there is no held row", async () => {
    action.findHeldRow.mockResolvedValue(null);
    const { result } = render();
    // NOT waitFor: waitFor resolves on the FIRST success, so against a
    // broken implementation that armed a hold, a synchronous read here could
    // pass vacuously - setHolding(true) fires from an async continuation
    // outside act(), and whether the render has committed by the time this
    // line runs is scheduler-dependent, not guaranteed false. The explicit
    // act() flush forces every pending state update to commit before the
    // read, so this stays a real negative assertion.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(result.current.holding).toBe(false);
  });

  it("does not push the row it is already holding when the rehydrate races meeting-ended", async () => {
    // This is the CRITICAL scenario: findHeldRow orders newest-first, so a
    // meeting-ended that completes inside this effect's own await gap makes
    // findHeldRow resolve with the SAME row this effect is racing to
    // rehydrate. Without the identity check, "if a hold is already running,
    // push the rehydrated row" pushes the row it is ALREADY holding - posting
    // a just-finished meeting with a zero-second undo window, the one thing
    // the hold exists to guarantee. The armed 30s timer masks it in
    // production: by the time it would fire, the row already reads `sent`.
    let resolveFindHeldRow: (value: unknown) => void = () => {};
    action.findHeldRow.mockReturnValue(
      new Promise((resolve) => {
        resolveFindHeldRow = resolve;
      })
    );
    action.getQueueRow.mockResolvedValue({ id: "row-1", status: "held" });
    const { result } = render();
    await waitFor(() => expect(listeners.has("meeting-ended")).toBe(true));
    fireMeetingEnded();
    await waitFor(() => expect(result.current.holding).toBe(true));

    resolveFindHeldRow({ id: "row-1", status: "held", created_at: Date.now() });
    // Short advance only - long enough to flush the rehydrate's resumed
    // continuation, well short of the legitimate 30s timer, so a push here
    // can only be the bug's premature one.
    await vi.advanceTimersByTimeAsync(10);
    expect(push.pushQueuedRow).not.toHaveBeenCalled();
  });
});
