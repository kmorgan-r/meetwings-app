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
    action.readMeetingMessages.mockResolvedValue([entry(3000, "said before the remount")]);
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
    action.readMeetingMessages.mockResolvedValue([entry(1000, "before"), entry(3000, "dup")]);
    render({ meetingTranscript: [entry(3000, "dup"), entry(5000, "after")] });
    await waitFor(() => expect(listeners.has("meeting-ended")).toBe(true));
    fireMeetingEnded();
    await waitFor(() => expect(action.insertQueueRow).toHaveBeenCalled());
    const row = action.insertQueueRow.mock.calls[0][0];
    expect(row.transcriptStartAt).toBe(1000);
    expect(row.transcriptEndAt).toBe(5000);
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
