import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NotionPickSource } from "@/hooks/useNotionPick";
import type { CalendarSnapshot } from "@/lib/calendar/calendar-snapshot";
import type { SelectedTargets, TranscriptEntry } from "@/types";

// Check 2 inside useMeetingLog's trigger (spec 8.3): an auto Notion tick is
// held only when autoNotionAllowed says so, a hand tick is never checked, and
// a trigger dropped while the check runs is re-run once. The real hook runs;
// the queue, configs, the check itself and the snapshot read are doubles,
// following meeting-log-entry-points.test.tsx's section (c).

const hookListeners = new Map<string, (event: unknown) => void>();
const tauri = vi.hoisted(() => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => tauri);
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ label: "main" }) }));

const toastMock = vi.hoisted(() => ({ error: vi.fn(), info: vi.fn(), warning: vi.fn(), success: vi.fn() }));
vi.mock("sonner", () => ({ toast: toastMock }));

const queue = vi.hoisted(() => ({
  getTranscriptWatermark: vi.fn(async () => 0),
  insertQueueRow: vi.fn(async (_row: unknown) => true),
  readMeetingMessages: vi.fn(async () => []),
  findHeldRow: vi.fn(async () => null as unknown),
  cancelHeldRow: vi.fn(async () => "all" as "all" | "partial" | "none"),
  promoteHeldNotionRow: vi.fn(async () => true),
  getQueueRow: vi.fn(async () => null as unknown),
  pruneTranscripts: vi.fn(async () => 0),
  sweepOrphanTargets: vi.fn(async () => 0),
  readUnloggedMessages: vi.fn(async () => []),
}));
vi.mock("@/lib/database/meeting-log.action", () => queue);

vi.mock("@/lib/odoo/meeting-log-push", () => ({
  pushQueuedRow: vi.fn(async () => {}),
  runMeetingLogSweep: vi.fn(async () => ({ ran: true, pushed: 0 })),
  claimed: new Set<string>(),
}));
vi.mock("@/lib/odoo/meeting-log-recovery", () => ({ runMeetingRecovery: vi.fn(async () => 0) }));
vi.mock("@/lib/notion/scheduler", () => ({
  ensureNotionScheduler: vi.fn(),
  isNotionSchedulerStarted: vi.fn(() => false),
}));
vi.mock("@/lib/functions/meeting-summarizer", () => ({ ensureMeetingSummary: vi.fn(async () => null) }));

const odooConfig = vi.hoisted(() => ({
  loadOdooConfigState: vi.fn(),
  requireOdooConfig: vi.fn(),
  instanceFingerprint: vi.fn((url: string, db: string) => `${url}|${db}`),
}));
vi.mock("@/lib/storage/odoo-config.storage", () => odooConfig);

vi.mock("@/lib/storage/notion-config.storage", () => ({
  isNotionConfigured: vi.fn(async () => true),
  isNotionAutoSendEnabled: vi.fn(() => true),
}));

const skipMark = vi.hoisted(() => ({ value: 0 }));
vi.mock("@/lib/storage/meeting-log-watermark.storage", () => ({
  getSkipWatermark: () => skipMark.value,
  setSkipWatermark: (n: number) => void (skipMark.value = n),
}));
const active = vi.hoisted(() => ({ id: null as string | null }));
vi.mock("@/lib/storage/active-conversation.storage", () => ({
  getActiveConversationId: () => active.id,
}));

const check = vi.hoisted(() => ({
  autoNotionAllowed: vi.fn<typeof import("@/lib/calendar/auto-notion")["autoNotionAllowed"]>(),
}));
vi.mock("@/lib/calendar/auto-notion", () => check);

const snapshots = vi.hoisted(() => ({
  getCalendarSnapshot: vi.fn<(conversationId: string) => Promise<CalendarSnapshot | null>>(),
}));
vi.mock("@/lib/database/calendar-snapshot.action", () => snapshots);

const graph = vi.hoisted(() => ({ loadGraphConfigState: vi.fn() }));
vi.mock("@/lib/storage/graph-config.storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/storage/graph-config.storage")>()),
  loadGraphConfigState: graph.loadGraphConfigState,
}));

// A passthrough spy, so a test can count how many times the trigger decided.
vi.mock("@/lib/notion/destinations", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/notion/destinations")>();
  return { ...real, decideDestinations: vi.fn(real.decideDestinations) };
});

import { useMeetingLog, resetMeetingLogSweepGuard } from "@/hooks/useMeetingLog";
import { fetchMeetingsBetween } from "@/lib/calendar/fetch-current-meetings";
import { decideDestinations } from "@/lib/notion/destinations";
import { resetTranscriptPruneGuard } from "@/lib/odoo/meeting-log-actions";

const ODOO = { url: "http://h:8069", db: "odoo", login: "me@example.org", apiKey: "sk-secret" };
const GRAPH_COMPLETE = {
  state: "complete" as const,
  config: { clientId: "c", authority: "https://login.example.org/organizations" },
};
const ONE_TARGET: SelectedTargets = [{ model: "res.partner", resId: 42, name: null }];
const SNAPSHOT: CalendarSnapshot = {
  key: "g-1",
  subject: "Planning",
  startMs: 0,
  endMs: 10_000,
  ownAddress: "me@example.org",
  participants: [{ address: "guest@example.org", name: "Guest" }],
};

function said(timestamp: number): TranscriptEntry {
  return { original: "hello", timestamp, audioSource: "microphone" };
}

/** Odoo complete, Notion ticked automatically, one contact, a 1000-4000 row. */
function renderLog(
  opts: {
    targets?: SelectedTargets;
    source?: NotionPickSource;
    transcript?: TranscriptEntry[];
    conversationId?: string | null;
  } = {}
) {
  // Plain ref objects, created outside the hook so a test can flip them.
  const targetRef = { current: opts.targets ?? ONE_TARGET };
  const notionPickedRef = { current: true };
  const notionSourceRef: { current: NotionPickSource } = { current: opts.source ?? "auto" };
  const transcript = opts.transcript ?? [said(1000), said(4000)];
  const conversationId = opts.conversationId === undefined ? "conv-1" : opts.conversationId;
  const view = renderHook(() =>
    useMeetingLog({
      targetRef,
      notionPickedRef,
      notionSourceRef,
      meetingTranscript: transcript,
      currentConversationId: conversationId,
      // Off: no pill-off edge and no idle flush, so only endMeeting() triggers.
      meetingAssistMode: false,
    })
  );
  return { ...view, notionPickedRef, notionSourceRef };
}

async function listening() {
  await waitFor(() => expect(hookListeners.has("meeting-ended")).toBe(true));
}

function endMeeting() {
  hookListeners.get("meeting-ended")?.({ payload: null });
}

async function settle() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(50);
  });
}

const rows = () => queue.insertQueueRow.mock.calls.map((c) => c[0] as Record<string, unknown>);

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe("useMeetingLog: check 2 before an auto-ticked row is held", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    resetMeetingLogSweepGuard();
    resetTranscriptPruneGuard();
    hookListeners.clear();
    skipMark.value = 0;
    active.id = null;
    tauri.listen.mockImplementation(async (name: string, handler: (e: unknown) => void) => {
      hookListeners.set(name, handler);
      return () => void hookListeners.delete(name);
    });
    queue.insertQueueRow.mockReset();
    queue.insertQueueRow.mockResolvedValue(true);
    odooConfig.loadOdooConfigState.mockResolvedValue({ state: "complete", config: ODOO });
    odooConfig.requireOdooConfig.mockResolvedValue(ODOO);
    check.autoNotionAllowed.mockReset();
    check.autoNotionAllowed.mockResolvedValue(true);
    snapshots.getCalendarSnapshot.mockReset();
    snapshots.getCalendarSnapshot.mockResolvedValue(SNAPSHOT);
    graph.loadGraphConfigState.mockReset();
    graph.loadGraphConfigState.mockResolvedValue(GRAPH_COMPLETE);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("a hand tick is held with no Outlook read", async () => {
    renderLog({ source: "hand" });
    await listening();
    endMeeting();

    await waitFor(() => expect(queue.insertQueueRow).toHaveBeenCalledTimes(1));
    expect(rows()[0]).toMatchObject({ status: "held", notionStatus: "held" });
    expect(check.autoNotionAllowed).not.toHaveBeenCalled();
    expect(snapshots.getCalendarSnapshot).not.toHaveBeenCalled();
    expect(graph.loadGraphConfigState).not.toHaveBeenCalled();
  });

  it("a refused auto tick is written with notionStatus null", async () => {
    check.autoNotionAllowed.mockResolvedValue(false);
    const { result } = renderLog();
    await listening();
    endMeeting();

    await waitFor(() => expect(queue.insertQueueRow).toHaveBeenCalledTimes(1));
    expect(rows()[0]).toMatchObject({
      instance: "http://h:8069|odoo",
      status: "held",
      notionStatus: null,
      targets: ONE_TARGET,
    });
    // The Odoo lane is still held, so the undo strip still shows.
    await waitFor(() => expect(result.current.holding).toBe(true));
  });

  it("a refused auto tick with no contact is written from the final decision: unassigned, no hold", async () => {
    check.autoNotionAllowed.mockResolvedValue(false);
    const { result } = renderLog({ targets: [] });
    await listening();
    endMeeting();

    await waitFor(() => expect(queue.insertQueueRow).toHaveBeenCalledTimes(1));
    // Before the check the decision was Odoo 'none' + Notion 'held'.
    expect(rows()[0]).toMatchObject({ status: "unassigned", notionStatus: null, targets: [] });
    await settle();
    expect(result.current.holding).toBe(false);
  });

  it("an allowed auto tick is written held", async () => {
    renderLog();
    await listening();
    endMeeting();

    await waitFor(() => expect(queue.insertQueueRow).toHaveBeenCalledTimes(1));
    expect(check.autoNotionAllowed).toHaveBeenCalledTimes(1);
    expect(rows()[0]).toMatchObject({ status: "held", notionStatus: "held" });
  });

  it("a toggle mid-check does not change the enqueued row", async () => {
    const gate = deferred<boolean>();
    check.autoNotionAllowed.mockImplementationOnce(() => gate.promise);
    const { notionPickedRef, notionSourceRef } = renderLog();
    await listening();
    endMeeting();
    await waitFor(() => expect(check.autoNotionAllowed).toHaveBeenCalledTimes(1));

    notionPickedRef.current = false;
    notionSourceRef.current = "hand";
    gate.resolve(true);

    await waitFor(() => expect(queue.insertQueueRow).toHaveBeenCalledTimes(1));
    expect(rows()[0]).toMatchObject({ status: "held", notionStatus: "held" });
  });

  it("a second trigger arriving mid-check is re-run after it", async () => {
    const gate = deferred<boolean>();
    check.autoNotionAllowed.mockImplementationOnce(() => gate.promise);
    renderLog();
    await listening();
    endMeeting();
    await waitFor(() => expect(check.autoNotionAllowed).toHaveBeenCalledTimes(1));

    // Two more while the check runs: re-run ONCE, not once per drop.
    endMeeting();
    endMeeting();
    await settle();
    expect(queue.insertQueueRow).not.toHaveBeenCalled();

    gate.resolve(true);
    await waitFor(() => expect(queue.insertQueueRow).toHaveBeenCalledTimes(2));
    await settle();
    expect(queue.insertQueueRow).toHaveBeenCalledTimes(2);
    expect(check.autoNotionAllowed).toHaveBeenCalledTimes(2);
  });

  it("a trigger dropped outside check 2 is not re-run", async () => {
    // Incomplete Odoo: a re-run would also show the incomplete toast twice.
    odooConfig.loadOdooConfigState.mockResolvedValue({ state: "incomplete", missing: ["apiKey"] });
    const insert = deferred<boolean>();
    queue.insertQueueRow.mockImplementationOnce(() => insert.promise);
    renderLog({ source: "hand" });
    await listening();
    endMeeting();
    await waitFor(() => expect(queue.insertQueueRow).toHaveBeenCalledTimes(1));

    endMeeting();
    insert.resolve(true);
    await settle();

    expect(decideDestinations).toHaveBeenCalledTimes(1);
    expect(queue.insertQueueRow).toHaveBeenCalledTimes(1);
    expect(toastMock.error).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["absent", { state: "absent", config: null }, true],
    ["complete", GRAPH_COMPLETE, false],
    ["unreadable", { state: "unreadable", config: null }, false],
  ])(
    "check 2 is called with the row's span, the conversation's snapshot and the Outlook config state (%s)",
    async (_name, graphState, outlookAbsent) => {
      graph.loadGraphConfigState.mockResolvedValue(graphState);
      renderLog({ transcript: [said(4000), said(1000), said(2500)] });
      await listening();
      endMeeting();

      await waitFor(() => expect(check.autoNotionAllowed).toHaveBeenCalledTimes(1));
      expect(snapshots.getCalendarSnapshot).toHaveBeenCalledWith("conv-1");
      expect(check.autoNotionAllowed).toHaveBeenCalledWith({
        span: { start: 1000, end: 4000 },
        snapshot: SNAPSHOT,
        outlookAbsent,
        // The span read, NOT fetchCurrentMeetings' now-relative one.
        readOutlook: fetchMeetingsBetween,
      });
    }
  );

  it("reads the snapshot of the recovered conversation when the live id is gone", async () => {
    active.id = "conv-9";
    renderLog({ conversationId: null });
    await listening();
    endMeeting();

    await waitFor(() => expect(check.autoNotionAllowed).toHaveBeenCalledTimes(1));
    expect(snapshots.getCalendarSnapshot).toHaveBeenCalledWith("conv-9");
  });

  it("no conversation id passes a null snapshot and reads none", async () => {
    renderLog({ conversationId: null });
    await listening();
    endMeeting();

    await waitFor(() => expect(check.autoNotionAllowed).toHaveBeenCalledTimes(1));
    expect(check.autoNotionAllowed).toHaveBeenCalledWith(
      expect.objectContaining({ snapshot: null })
    );
    expect(snapshots.getCalendarSnapshot).not.toHaveBeenCalled();
  });

  it.each([
    ["the check rejects", () => check.autoNotionAllowed.mockRejectedValue(new Error("boom"))],
    ["the snapshot read rejects", () => snapshots.getCalendarSnapshot.mockRejectedValue(new Error("db"))],
    ["the Outlook config read rejects", () => graph.loadGraphConfigState.mockRejectedValue(new Error("kc"))],
  ])("a throwing check 2 writes the row with notionStatus null (%s)", async (_name, arrange) => {
    arrange();
    renderLog({ targets: [] });
    await listening();
    endMeeting();

    await waitFor(() => expect(queue.insertQueueRow).toHaveBeenCalledTimes(1));
    expect(rows()[0]).toMatchObject({ status: "unassigned", notionStatus: null });
    expect(toastMock.error).not.toHaveBeenCalled();
  });

  it("three rows of one call with mixed Outlook outcomes are each decided on their own", async () => {
    check.autoNotionAllowed
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    renderLog();
    await listening();

    for (let n = 1; n <= 3; n++) {
      endMeeting();
      await waitFor(() => expect(queue.insertQueueRow).toHaveBeenCalledTimes(n));
      await settle(); // let this trigger finish before the next one fires
    }

    expect(rows().map((r) => r.notionStatus)).toEqual(["held", null, "held"]);
  });
});
