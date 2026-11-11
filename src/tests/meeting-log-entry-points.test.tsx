import { render, screen } from "@testing-library/react";
import { renderHook } from "@testing-library/react";
import { Outlet } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Review finding: a repo-wide grep across src/tests/** found no reference to
// the /meeting-log route, the "Meeting log" menu item, or the "Open the
// meeting log" link on /integrations - deleting any one of the three left the full
// suite green while making 4,875 lines of feature unreachable from the UI.
// The link is covered separately, alongside its sibling count fixtures, in
// src/tests/odoo-settings-page.test.tsx ("the queue status block"). This file
// covers the other two: the route itself, and the menu entry's shared gate.
//
// No suite in this repo already exercised routes/index.tsx or useMenuItems -
// this file is new.
//
// Section (c) at the bottom is different in kind: it drives the real
// useMeetingLog hook (who sends where - Odoo, Notion, both, neither) against
// hoisted doubles for the queue actions, push, recovery, the Notion scheduler
// and the Odoo/Notion config storage. Those vi.mock calls apply file-wide but
// only the hook describe imports anything they replace.

// ---------------------------------------------------------------------------
// (a) the /meeting-log route resolves to the page.
//
// Every page @/pages exports is stubbed - routes/index.tsx builds every
// <Route element={...}> eagerly (React.createElement runs for all of them,
// not just the one that matches), so an undefined stub for an UNVISITED page
// would still crash the render. DashboardLayout is stubbed to a bare
// <Outlet /> so this stays a routing-table test, not a Sidebar/useApp test -
// the same "harness, not full render" call the repo already makes in
// src/tests/odoo-target-new-chat-entry-points.test.tsx.
// ---------------------------------------------------------------------------

vi.mock("@/pages", () => {
  const stub = (name: string) => () => <div data-testid={`stub-${name}`}>{name}</div>;
  return {
    Dashboard: stub("dashboard"),
    App: stub("app"),
    SystemPrompts: stub("system-prompts"),
    ViewChat: stub("view-chat"),
    Settings: stub("settings"),
    DevSpace: stub("dev-space"),
    Shortcuts: stub("shortcuts"),
    Audio: stub("audio"),
    Screenshot: stub("screenshot"),
    Responses: stub("responses"),
    CostTracking: stub("cost-tracking"),
    ContextMemory: stub("context-memory"),
    Speakers: stub("speakers"),
    Language: stub("language"),
    Odoo: stub("odoo"),
    Meetings: stub("meetings"),
  };
});

vi.mock("@/layouts", () => ({
  DashboardLayout: () => <Outlet />,
}));

import AppRoutes from "@/routes";

afterEach(() => {
  window.history.pushState({}, "", "/");
});

describe("the meetings route", () => {
  it("resolves /meetings to the Meetings page", () => {
    window.history.pushState({}, "", "/meetings");
    render(<AppRoutes />);
    expect(screen.getByTestId("stub-meetings")).toBeInTheDocument();
  });

  it("still lands the old /meeting-log entry point on it", () => {
    // The queue page merged into /meetings; the old path redirects rather than
    // 404-ing, because the menu entry and the /integrations link both still
    // point here until they are moved.
    window.history.pushState({}, "", "/meeting-log");
    render(<AppRoutes />);
    expect(screen.getByTestId("stub-meetings")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// (b) the "Meeting log" menu item exists and shares the Integrations entry's gate.
//
// Pinning the item's mere presence would pass a mutant that disables it under
// a DIFFERENT condition, or never disables it at all. What actually matters
// is that it uses the SAME gateOnSetup as the Integrations entry beside it - so
// asserts both states (gate on, gate off) AND that the two items agree in
// each state, not just their own hard-coded value.
// ---------------------------------------------------------------------------

const setupStatus = vi.hoisted(() => ({ isComplete: true, isLoading: false }));
vi.mock("@/hooks/useSetupStatus", () => ({
  useSetupStatus: () => setupStatus,
}));
vi.mock("@/contexts", () => ({
  useApp: () => ({ hasActiveLicense: false }),
}));

import { useMenuItems } from "@/hooks/useMenuItems";

interface MenuItem {
  label: string;
  href: string;
  disabled?: boolean;
}

function findItem(menu: MenuItem[], label: string): MenuItem {
  const item = menu.find((m) => m.label === label);
  if (!item) throw new Error(`menu item not found: ${label}`);
  return item;
}

beforeEach(() => {
  setupStatus.isComplete = true;
  setupStatus.isLoading = false;
});

describe("the Meetings menu entry", () => {
  it("is present, points at /meetings, and shares the Integrations entry's setup gate", () => {
    const { result, rerender } = renderHook(() => useMenuItems());

    const meetingsOpen = findItem(result.current.menu, "Meetings");
    const integrationsOpen = findItem(result.current.menu, "Integrations");
    expect(meetingsOpen.href).toBe("/meetings");
    expect(integrationsOpen.href).toBe("/integrations");
    // Gate OFF: setup is complete. Both entries enabled, and agreeing.
    expect(meetingsOpen.disabled).toBe(false);
    expect(meetingsOpen.disabled).toBe(integrationsOpen.disabled);

    setupStatus.isComplete = false;
    rerender();

    const meetingsGated = findItem(result.current.menu, "Meetings");
    const integrationsGated = findItem(result.current.menu, "Integrations");
    // Gate ON: setup incomplete. Both entries disabled, and STILL agreeing -
    // this is what proves it is the SHARED gate, not two independent ones
    // that happen to start out matching.
    expect(meetingsGated.disabled).toBe(true);
    expect(meetingsGated.disabled).toBe(integrationsGated.disabled);
  });

  // The merge's whole point: two entry points collapse into one. A regression
  // that brings back "Chats" or "Meeting log" as a second item would pass
  // every assertion above (both still find "Meetings"), so this checks the
  // menu has exactly one meetings-shaped entry, not zero-or-two.
  it("collapses the old Meeting log and Chats entries into the one Meetings entry", () => {
    const { result } = renderHook(() => useMenuItems());

    expect(result.current.menu.filter((item) => item.href === "/meetings")).toHaveLength(1);
    expect(result.current.menu.find((item) => item.label === "Meeting log")).toBeUndefined();
    expect(result.current.menu.find((item) => item.label === "Chats")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// (c) who sends where: the overlay hook's Notion lane (Task 15).
//
// The queue, config and scheduler modules are replaced with stateful doubles;
// everything else in useMeetingLog (timers, holds, snapshots) runs for real.
// ---------------------------------------------------------------------------

import { act, waitFor } from "@testing-library/react";
import { useRef } from "react";
import { useMeetingLog, resetMeetingLogSweepGuard } from "@/hooks/useMeetingLog";
import { HOLD_MS } from "@/lib/odoo/meeting-log";
import { resetTranscriptPruneGuard } from "@/lib/odoo/meeting-log-actions";
import type { SelectedTargets, TranscriptEntry } from "@/types";

const hookListeners = new Map<string, (event: unknown) => void>();
const tauri = vi.hoisted(() => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => tauri);
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ label: "main" }) }));

const toastMock = vi.hoisted(() => ({ error: vi.fn(), info: vi.fn(), warning: vi.fn(), success: vi.fn() }));
vi.mock("sonner", () => ({ toast: toastMock }));

const queue = vi.hoisted(() => ({
  getTranscriptWatermark: vi.fn(async () => 0),
  insertQueueRow: vi.fn(async () => true),
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

const push = vi.hoisted(() => ({
  pushQueuedRow: vi.fn(async () => {}),
  runMeetingLogSweep: vi.fn(async () => ({ ran: true, pushed: 0 })),
  claimed: new Set<string>(),
}));
vi.mock("@/lib/odoo/meeting-log-push", () => push);

const recovery = vi.hoisted(() => ({ runMeetingRecovery: vi.fn(async () => 0) }));
vi.mock("@/lib/odoo/meeting-log-recovery", () => recovery);

const scheduler = vi.hoisted(() => ({
  ensureNotionScheduler: vi.fn(),
  isNotionSchedulerStarted: vi.fn(() => false),
}));
vi.mock("@/lib/notion/scheduler", () => scheduler);

const odooConfig = vi.hoisted(() => ({
  loadOdooConfigState: vi.fn(),
  requireOdooConfig: vi.fn(),
  instanceFingerprint: vi.fn((url: string, db: string) => `${url}|${db}`),
}));
vi.mock("@/lib/storage/odoo-config.storage", () => odooConfig);

const notionConfig = vi.hoisted(() => ({
  isNotionConfigured: vi.fn(async () => true),
  isNotionAutoSendEnabled: vi.fn(() => true),
}));
vi.mock("@/lib/storage/notion-config.storage", () => notionConfig);

vi.mock("@/lib/functions/meeting-summarizer", () => ({ ensureMeetingSummary: vi.fn(async () => null) }));
const skipMark = vi.hoisted(() => ({ value: 0 }));
vi.mock("@/lib/storage/meeting-log-watermark.storage", () => ({
  getSkipWatermark: () => skipMark.value,
  setSkipWatermark: (n: number) => void (skipMark.value = n),
}));
vi.mock("@/lib/storage/active-conversation.storage", () => ({
  getActiveConversationId: () => null,
}));

const ODOO = { url: "http://h:8069", db: "odoo", login: "me@x.io", apiKey: "sk-secret" };
const ONE_TARGET: SelectedTargets = [{ model: "res.partner", resId: 42, name: null }];

function said(timestamp: number): TranscriptEntry {
  return { original: "hello", timestamp, audioSource: "microphone" };
}

function renderLog(opts: { targets?: SelectedTargets; picked?: boolean; pill?: boolean } = {}) {
  return renderHook(
    (props: { pill: boolean }) => {
      const targetRef = useRef<SelectedTargets>(opts.targets ?? []);
      const notionPickedRef = useRef(opts.picked ?? false);
      return useMeetingLog({
        targetRef,
        notionPickedRef,
        meetingTranscript: [said(1000)],
        currentConversationId: "conv-1",
        meetingAssistMode: props.pill,
      });
    },
    { initialProps: { pill: opts.pill ?? true } }
  );
}

function endMeeting() {
  hookListeners.get("meeting-ended")?.({ payload: null });
}

const bodyOf = (call: unknown[]) => call[0] as Record<string, unknown>;

describe("the hook: who sends where", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.spyOn(crypto, "randomUUID").mockReturnValue(
      "row-1" as `${string}-${string}-${string}-${string}-${string}`
    );
    resetMeetingLogSweepGuard();
    resetTranscriptPruneGuard();
    hookListeners.clear();
    skipMark.value = 0;
    tauri.listen.mockImplementation(async (name: string, handler: (e: unknown) => void) => {
      hookListeners.set(name, handler);
      return () => void hookListeners.delete(name);
    });
    queue.insertQueueRow.mockResolvedValue(true);
    queue.findHeldRow.mockResolvedValue(null);
    queue.cancelHeldRow.mockResolvedValue("all");
    queue.promoteHeldNotionRow.mockResolvedValue(true);
    queue.getQueueRow.mockResolvedValue(null);
    push.pushQueuedRow.mockResolvedValue(undefined);
    push.runMeetingLogSweep.mockResolvedValue({ ran: true, pushed: 0 });
    recovery.runMeetingRecovery.mockResolvedValue(0);
    scheduler.isNotionSchedulerStarted.mockReturnValue(false);
    odooConfig.loadOdooConfigState.mockResolvedValue({ state: "absent", config: null });
    odooConfig.requireOdooConfig.mockResolvedValue(ODOO);
    notionConfig.isNotionConfigured.mockResolvedValue(true);
    notionConfig.isNotionAutoSendEnabled.mockReturnValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("Notion-only, no Odoo config: pill-off queues a held Notion row and shows the undo strip", async () => {
    const { result, rerender } = renderLog({ pill: true });
    await waitFor(() => expect(hookListeners.has("meeting-ended")).toBe(true));
    rerender({ pill: false });

    await waitFor(() => expect(result.current.holding).toBe(true));
    expect(bodyOf(queue.insertQueueRow.mock.calls[0])).toMatchObject({
      instance: "",
      status: "none",
      notionStatus: "held",
      targets: [],
    });
  });

  it("undo during the hold cancels the Notion row", async () => {
    const { result } = renderLog();
    await waitFor(() => expect(hookListeners.has("meeting-ended")).toBe(true));
    endMeeting();
    await waitFor(() => expect(result.current.holding).toBe(true));

    act(() => result.current.onUndo());

    await waitFor(() => expect(queue.cancelHeldRow).toHaveBeenCalledWith("row-1"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HOLD_MS * 2);
    });
    expect(queue.promoteHeldNotionRow).not.toHaveBeenCalled();
    expect(result.current.undoBlockedMessage).toBeNull();
  });

  it("undo on a both-held row cancels both lanes through the hook", async () => {
    odooConfig.loadOdooConfigState.mockResolvedValue({ state: "complete", config: ODOO });
    const { result } = renderLog({ targets: ONE_TARGET, picked: true });
    await waitFor(() => expect(hookListeners.has("meeting-ended")).toBe(true));
    endMeeting();
    await waitFor(() => expect(result.current.holding).toBe(true));
    expect(bodyOf(queue.insertQueueRow.mock.calls[0])).toMatchObject({
      instance: "http://h:8069|odoo",
      status: "held",
      notionStatus: "held",
    });

    act(() => result.current.onUndo());

    await waitFor(() => expect(queue.cancelHeldRow).toHaveBeenCalledTimes(1));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HOLD_MS * 2);
    });
    expect(push.pushQueuedRow).not.toHaveBeenCalled();
    expect(queue.promoteHeldNotionRow).not.toHaveBeenCalled();
  });

  it("undo after the Notion lane was promoted shows 'This meeting is already being sent.'", async () => {
    queue.cancelHeldRow.mockResolvedValue("partial");
    const { result } = renderLog();
    await waitFor(() => expect(hookListeners.has("meeting-ended")).toBe(true));
    endMeeting();
    await waitFor(() => expect(result.current.holding).toBe(true));

    act(() => result.current.onUndo());

    await waitFor(() =>
      expect(result.current.undoBlockedMessage).toBe("This meeting is already being sent.")
    );
  });

  it("hold expiry promotes the Notion row to waiting and makes no Odoo call", async () => {
    queue.getQueueRow.mockResolvedValue({ id: "row-1", status: "none", notion_status: "held" });
    renderLog();
    await waitFor(() => expect(hookListeners.has("meeting-ended")).toBe(true));
    endMeeting();
    await waitFor(() => expect(queue.insertQueueRow).toHaveBeenCalled());

    await act(async () => {
      await vi.advanceTimersByTimeAsync(HOLD_MS);
    });

    await waitFor(() => expect(queue.promoteHeldNotionRow).toHaveBeenCalledWith("row-1"));
    expect(push.pushQueuedRow).not.toHaveBeenCalled();
    // Odoo is absent: reading its config here would throw and blame Odoo.
    expect(odooConfig.requireOdooConfig).not.toHaveBeenCalled();
  });

  it("hold expiry on a both-held row promotes Notion and pushes Odoo exactly once", async () => {
    odooConfig.loadOdooConfigState.mockResolvedValue({ state: "complete", config: ODOO });
    queue.getQueueRow.mockResolvedValue({ id: "row-1", status: "held", notion_status: "held" });
    renderLog({ targets: ONE_TARGET, picked: true });
    await waitFor(() => expect(hookListeners.has("meeting-ended")).toBe(true));
    endMeeting();
    await waitFor(() => expect(queue.insertQueueRow).toHaveBeenCalled());

    await act(async () => {
      await vi.advanceTimersByTimeAsync(HOLD_MS);
    });

    await waitFor(() => expect(push.pushQueuedRow).toHaveBeenCalledTimes(1));
    expect(queue.promoteHeldNotionRow).toHaveBeenCalledTimes(1);
  });

  it("an Odoo push that rejects at hold expiry still leaves the Notion lane promoted", async () => {
    odooConfig.loadOdooConfigState.mockResolvedValue({ state: "complete", config: ODOO });
    queue.getQueueRow.mockResolvedValue({ id: "row-1", status: "held", notion_status: "held" });
    push.pushQueuedRow.mockRejectedValue(new Error("odoo down"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    renderLog({ targets: ONE_TARGET, picked: true });
    await waitFor(() => expect(hookListeners.has("meeting-ended")).toBe(true));
    endMeeting();
    await waitFor(() => expect(queue.insertQueueRow).toHaveBeenCalled());

    await act(async () => {
      await vi.advanceTimersByTimeAsync(HOLD_MS);
    });

    await waitFor(() => expect(push.pushQueuedRow).toHaveBeenCalledTimes(1));
    expect(queue.promoteHeldNotionRow).toHaveBeenCalledWith("row-1");
    err.mockRestore();
  });

  it("a promotion failure still lets a both-held row's Odoo push run", async () => {
    odooConfig.loadOdooConfigState.mockResolvedValue({ state: "complete", config: ODOO });
    queue.getQueueRow.mockResolvedValue({ id: "row-1", status: "held", notion_status: "held" });
    queue.promoteHeldNotionRow.mockRejectedValue(new Error("db busy"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    renderLog({ targets: ONE_TARGET, picked: true });
    await waitFor(() => expect(hookListeners.has("meeting-ended")).toBe(true));
    endMeeting();
    await waitFor(() => expect(queue.insertQueueRow).toHaveBeenCalled());

    await act(async () => {
      await vi.advanceTimersByTimeAsync(HOLD_MS);
    });

    await waitFor(() => expect(push.pushQueuedRow).toHaveBeenCalledTimes(1));
    err.mockRestore();
  });

  it("rehydrate with Odoo absent finds the in-window Notion held row and shows the undo strip", async () => {
    queue.findHeldRow.mockResolvedValue({ id: "row-9", created_at: Date.now() - 5_000 });
    const { result } = renderLog();

    await waitFor(() => expect(result.current.holding).toBe(true));
    expect(queue.findHeldRow).toHaveBeenCalledWith(null, expect.any(Number));
  });

  it("Notion-only user never sees Odoo in the trigger toast", async () => {
    // A failing config read hits the trigger's catch toast.
    odooConfig.loadOdooConfigState.mockRejectedValue(new Error("unreadable"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    renderLog();
    await waitFor(() => expect(hookListeners.has("meeting-ended")).toBe(true));
    endMeeting();
    await waitFor(() => expect(toastMock.error).toHaveBeenCalled());
    for (const call of toastMock.error.mock.calls) expect(String(call[0])).not.toMatch(/odoo/i);
    err.mockRestore();
  });

  it("Notion-only user never sees Odoo in the undo-blocked message", async () => {
    queue.cancelHeldRow.mockResolvedValue("none");
    const { result } = renderLog();
    await waitFor(() => expect(hookListeners.has("meeting-ended")).toBe(true));
    endMeeting();
    await waitFor(() => expect(result.current.holding).toBe(true));
    act(() => result.current.onUndo());
    await waitFor(() => expect(result.current.undoBlockedMessage).not.toBeNull());
    expect(result.current.undoBlockedMessage).not.toMatch(/odoo/i);
  });

  it("an isNotionConfigured throw means Notion off: an Odoo user keeps logging to Odoo", async () => {
    odooConfig.loadOdooConfigState.mockResolvedValue({ state: "complete", config: ODOO });
    notionConfig.isNotionConfigured.mockRejectedValue(new Error("unreadable"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { result } = renderLog({ targets: ONE_TARGET, picked: true });
    await waitFor(() => expect(hookListeners.has("meeting-ended")).toBe(true));
    endMeeting();

    await waitFor(() => expect(result.current.holding).toBe(true));
    expect(bodyOf(queue.insertQueueRow.mock.calls[0])).toMatchObject({
      status: "held",
      notionStatus: null,
      targets: ONE_TARGET,
    });
    expect(toastMock.error).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("an isNotionConfigured throw with Odoo absent queues nothing and shows no Odoo toast", async () => {
    notionConfig.isNotionConfigured.mockRejectedValue(new Error("unreadable"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    renderLog();
    await waitFor(() => expect(hookListeners.has("meeting-ended")).toBe(true));
    endMeeting();

    await waitFor(() => expect(notionConfig.isNotionConfigured).toHaveBeenCalled());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(queue.insertQueueRow).not.toHaveBeenCalled();
    for (const call of toastMock.error.mock.calls) expect(String(call[0])).not.toMatch(/odoo/i);
    warn.mockRestore();
  });

  it("a failing Odoo config read still shows 'This meeting could not be queued.'", async () => {
    odooConfig.loadOdooConfigState.mockRejectedValue(new Error("unreadable"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    renderLog();
    await waitFor(() => expect(hookListeners.has("meeting-ended")).toBe(true));
    endMeeting();

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("This meeting could not be queued.")
    );
    expect(queue.insertQueueRow).not.toHaveBeenCalled();
    err.mockRestore();
  });

  it("incomplete Odoo + picked Notion queues none/held and shows the incomplete toast", async () => {
    odooConfig.loadOdooConfigState.mockResolvedValue({ state: "incomplete", missing: ["apiKey"] });
    const { result } = renderLog({ targets: ONE_TARGET, picked: true });
    await waitFor(() => expect(hookListeners.has("meeting-ended")).toBe(true));
    endMeeting();

    await waitFor(() => expect(result.current.holding).toBe(true));
    expect(bodyOf(queue.insertQueueRow.mock.calls[0])).toMatchObject({
      instance: "",
      status: "none",
      notionStatus: "held",
      targets: [],
    });
    expect(toastMock.error).toHaveBeenCalledWith(expect.stringContaining("apiKey"));
  });

  it("a started scheduler gets fresh deps on every re-render", async () => {
    scheduler.isNotionSchedulerStarted.mockReturnValue(true);
    const { rerender } = renderLog();
    await waitFor(() => expect(scheduler.ensureNotionScheduler).toHaveBeenCalled());
    scheduler.ensureNotionScheduler.mockClear();

    // Same props: a plain re-render, no pill-off trigger.
    rerender({ pill: true });

    expect(scheduler.ensureNotionScheduler).toHaveBeenCalledTimes(1);
    const deps = scheduler.ensureNotionScheduler.mock.calls[0][0] as {
      liveLastLineAt: (c: string) => number | null;
    };
    expect(deps.liveLastLineAt("conv-1")).toBe(1000);
    expect(deps.liveLastLineAt("other")).toBeNull();
  });

  it("the scheduler starts only after recovery finished", async () => {
    const order: string[] = [];
    let finishRecovery: (n: number) => void = () => {};
    recovery.runMeetingRecovery.mockImplementation(
      () =>
        new Promise<number>((resolve) => {
          order.push("recovery-started");
          finishRecovery = (n) => {
            order.push("recovery-finished");
            resolve(n);
          };
        })
    );
    scheduler.ensureNotionScheduler.mockImplementation(() => void order.push("scheduler"));
    renderLog();

    await waitFor(() => expect(order).toContain("recovery-started"));
    expect(scheduler.ensureNotionScheduler).not.toHaveBeenCalled();
    finishRecovery(0);

    await waitFor(() => expect(scheduler.ensureNotionScheduler).toHaveBeenCalledTimes(1));
    expect(order).toEqual(["recovery-started", "recovery-finished", "scheduler"]);
  });
});
