/**
 * Issue #72: "Chosen contacts disappear each time I put into small minimize
 * mode during a meeting."
 *
 * overlay-minimize-keeps-mounted.test.tsx proves a bare minimize/restore cycle
 * wipes nothing, but it stubs useCompletion and never runs a meeting. This file
 * mounts the real App with the REAL useCompletion, useOdooTarget,
 * useMeetingAutoRecord, usePillRecordAction, MinimizedPill, ContactPicker and
 * Input, over the REAL odoo-contacts.action module backed by sql.js with the
 * shipped migrations - so every `[odoo-targets]` line captured below is the
 * production logTargetOp output, and `dbTargets()` reads the real table.
 *
 * Scenarios 1-5 rule out the minimize/restore cycle itself under meeting
 * conditions. Scenario 6 is the mechanism: the response panel's X.
 */
import fs from "node:fs";
import path from "node:path";
import initSqlJs, { type Database as SqlJsDatabase } from "sql.js";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import {
  cloneElement,
  createContext,
  forwardRef,
  isValidElement,
  useContext,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
} from "react";
import type { UseCompletionReturn } from "@/types";

type Kids = { children?: ReactNode };

// Cold import of the whole app graph (useCompletion, shiki via the real
// components, sql.js) - same reason as overlay-minimize-keeps-mounted.
vi.setConfig({ testTimeout: 60_000 });

const INSTANCE = "http://h:8069|odoo";
const MIGRATIONS = path.resolve(__dirname, "../../src-tauri/src/db/migrations");
const WASM = path.resolve(__dirname, "../../node_modules/sql.js/dist/sql-wasm.wasm");
const GAP_PLUS = 31 * 60 * 1000; // > MEETING_CONVERSATION_GAP_MS (30 min)

// ---------------------------------------------------------------------------
// Real SQLite (sql.js) behind the real action module
// ---------------------------------------------------------------------------
let db: SqlJsDatabase;

async function freshDb() {
  const SQL = await initSqlJs({ wasmBinary: fs.readFileSync(WASM) });
  db = new SQL.Database();
  // The app's own order (src-tauri/src/db/main.rs), Odoo-relevant subset.
  for (const m of [
    "chat-history.sql",
    "chat-history-v8.sql",
    "odoo-contacts.sql",
    "meeting-log-queue.sql",
    "odoo-lead-only-target.sql",
    "odoo-multi-target.sql",
  ]) {
    db.exec(fs.readFileSync(path.join(MIGRATIONS, m), "utf8"));
  }
}

const sqlJsAdapter = () => ({
  execute: async (sql: string, params: unknown[] = []) => {
    db.run(sql, params as never[]);
    return { rowsAffected: db.getRowsModified(), lastInsertId: 0 };
  },
  select: async (sql: string, params: unknown[] = []) => {
    const stmt = db.prepare(sql);
    stmt.bind(params as never[]);
    const rows: Record<string, unknown>[] = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
  },
});

const dbTargets = () => {
  const out: Record<string, unknown>[] = [];
  const stmt = db.prepare(
    "SELECT instance, model, res_id FROM odoo_selected_targets ORDER BY selected_at"
  );
  while (stmt.step()) out.push(stmt.getAsObject());
  stmt.free();
  return out;
};

// ---------------------------------------------------------------------------
// [odoo-targets] capture
// ---------------------------------------------------------------------------
type TargetLine = { op: string; detail: Record<string, unknown> };
let infoSpy: MockInstance<typeof console.info>;
const targetLines = (): TargetLine[] =>
  infoSpy.mock.calls
    .filter((c) => c[0] === "[odoo-targets]")
    .map((c) => ({ op: c[1] as string, detail: (c[2] ?? {}) as Record<string, unknown> }));
const WIPE_OPS = new Set(["clearTargets", "removeSelectedTarget", "purgeOtherInstances"]);
/** Entry lines (no `outcome`) of every wipe-capable op since `mark`. */
const wipeOpsSince = (mark: number) =>
  targetLines()
    .slice(mark)
    .filter((l) => WIPE_OPS.has(l.op) && !("outcome" in l.detail));
const fmt = (lines: TargetLine[]) =>
  lines.map((l) => `[odoo-targets] ${l.op} ${JSON.stringify(l.detail)}`).join("\n");
const lastInMemoryCount = () =>
  [...targetLines()].reverse().find((l) => l.op === "targets")?.detail.count;

// ---------------------------------------------------------------------------
// Tauri IPC / events
// ---------------------------------------------------------------------------
const invokeMock = vi.fn<(cmd: string, args?: Record<string, unknown>) => Promise<unknown>>();
const tauriListeners = new Map<string, Set<(e: { event: string; payload: unknown }) => void>>();
const emitTauri = (event: string, payload: unknown = null) => {
  for (const h of [...(tauriListeners.get(event) ?? [])]) h({ event, payload });
};

// ---------------------------------------------------------------------------
// Fake Odoo server for the REAL runSync/syncContacts/reconcile
// ---------------------------------------------------------------------------
const odoo = {
  liveIds: [1, 2],
  /** When set, the next search_read waits on it (a sync held in flight). */
  hold: null as Promise<void> | null,
  execute: vi.fn(async (_model: string, method: string, args: unknown[]) => {
    if (method === "search_read") {
      if (odoo.hold) await odoo.hold;
      return [];
    }
    if (method === "search") {
      const domain = args[0] as unknown[][];
      const cursor = (domain.find((l) => l[0] === "id" && l[1] === ">")?.[2] as number) ?? 0;
      return odoo.liveIds.filter((id) => id > cursor);
    }
    return [];
  }),
};

// ---------------------------------------------------------------------------
// Per-test knobs read by the mock factories
// ---------------------------------------------------------------------------
const knobs = {
  config: { url: "http://h:8069", db: "odoo", login: "b", apiKey: "k" },
  systemAudio: {
    capturing: false,
    error: "",
    vadConfig: { enabled: true },
    startCapture: vi.fn(async () => {}),
    stopCapture: vi.fn(async () => {}),
  } as Record<string, unknown>,
  autoRecord: false,
  calendar: null as null | Record<string, unknown>,
};

const real: { useCompletion: null | (() => UseCompletionReturn) } = { useCompletion: null };
let liveCompletion: UseCompletionReturn | null = null;
/** The live useCompletion return of the latest render, plus a render log. */
const probe = {
  get completion(): UseCompletionReturn {
    if (!liveCompletion) throw new Error("useCompletion has not rendered yet");
    return liveCompletion;
  },
  renders: [] as Array<{ meetingAssistMode: boolean; enableVAD: boolean }>,
};
/** What the tests poke through setState, typed against the hook's public shape. */
type PanelState = Pick<UseCompletionReturn, "response" | "isLoading" | "attachedFiles">;
const patchState = (patch: Partial<PanelState>) =>
  act(() => probe.completion.setState((p: PanelState) => ({ ...p, ...patch })));

let convSeq = 0;
let msgSeq = 0;

const APP_CONTEXT = {
  customizable: { cursor: { type: "default" }, overlayPill: { style: "status-count" } },
  setOverlayPillStyle: vi.fn(),
  allAiProviders: [{ id: "openai" }],
  selectedAIProvider: { provider: "openai", variables: {} },
  // A speech provider, so usePillRecordAction registers the pill's record button.
  selectedSttProvider: { provider: "openai-whisper", variables: {} },
  meetwingsApiEnabled: false,
  systemPrompt: "",
  screenshotConfiguration: { enabled: false, mode: "manual" },
  setScreenshotConfiguration: vi.fn(),
  sttTranslationEnabled: false,
};
const GLOBAL_SHORTCUTS = {
  registerAudioCallback: vi.fn(),
  registerInputRef: vi.fn(),
  registerScreenshotCallback: vi.fn(),
};

// A controlled-Popover stand-in: content renders only while `open` is not
// false, and the trigger toggles through onOpenChange - enough to observe the
// response panel being forced open, which a pass-through mock cannot.
const PopoverCtx = createContext<{ open?: boolean; onOpenChange?: (o: boolean) => void }>({});

const mockEverything = () => {
  vi.doMock("@/lib/database/config", () => ({ getDatabase: vi.fn(async () => sqlJsAdapter()) }));
  vi.doMock("@tauri-apps/api/core", () => ({
    invoke: (cmd: string, args?: Record<string, unknown>) => invokeMock(cmd, args),
  }));
  vi.doMock("@tauri-apps/api/event", () => ({
    listen: (event: string, handler: (e: { event: string; payload: unknown }) => void) => {
      if (!tauriListeners.has(event)) tauriListeners.set(event, new Set());
      tauriListeners.get(event)!.add(handler);
      return Promise.resolve(() => tauriListeners.get(event)?.delete(handler));
    },
    emit: vi.fn().mockResolvedValue(undefined),
  }));
  vi.doMock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ label: "main" }) }));
  vi.doMock("sonner", () => ({
    toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
  }));
  vi.doMock("@/lib/platform", async (orig) => ({
    ...(await orig<Record<string, unknown>>()),
    isWindows: () => true,
    getPlatform: () => "windows",
  }));
  vi.doMock("@/lib/storage/odoo-config.storage", async (orig) => ({
    ...(await orig<Record<string, unknown>>()),
    loadOdooConfigState: vi.fn(async () => ({ state: "complete", config: knobs.config })),
    loadOdooConfig: vi.fn(async () => knobs.config),
    requireOdooConfig: vi.fn(async () => knobs.config),
  }));
  vi.doMock("@/lib/odoo/client", async (orig) => ({
    ...(await orig<Record<string, unknown>>()),
    createOdooClient: () => ({ authenticate: async () => 1, execute: odoo.execute, serverDate: null }),
  }));
  vi.doMock("@/contexts", () => ({ useApp: () => APP_CONTEXT }));
  vi.doMock("@/lib", () => ({
    getPlatform: () => "windows",
    shouldUseMeetwingsAPI: vi.fn(async () => false),
    safeLocalStorage: {
      getItem: (k: string) =>
        k === "meeting_auto_record_enabled" && knobs.autoRecord ? "true" : null,
      setItem: vi.fn(),
      removeItem: vi.fn(),
    },
    fetchAIResponse: vi.fn(async function* () {}),
    saveConversation: vi.fn(async (c: { id: string }) => ({ ...c })),
    appendMessagesToConversation: vi.fn(async () => {}),
    getConversationById: vi.fn(async () => null),
    generateConversationTitle: vi.fn((m: string) => m),
    MESSAGE_ID_OFFSET: 1,
    generateConversationId: vi.fn(() => `conv-${++convSeq}`),
    ensureConversationId: vi.fn((ref: { current: string | null }) => {
      ref.current ??= `conv-${++convSeq}`;
      return ref.current;
    }),
    generateMessageId: vi.fn((role: string, ts: number) => `${role}-${ts}-${++msgSeq}`),
    generateRequestId: vi.fn(() => "request-1"),
    getResponseSettings: vi.fn(() => ({ autoScroll: false })),
    createUsageRecord: vi.fn(),
    calculateCost: vi.fn(() => 0),
    calculateSTTCost: vi.fn(() => 0),
    setActiveConversationId: vi.fn(),
    clearActiveConversationId: vi.fn(),
  }));
  vi.doMock("@/lib/functions/meeting-summarizer", () => ({
    ensureMeetingSummary: vi.fn(async () => null),
    extractJsonObject: vi.fn(() => null),
  }));
  vi.doMock("@/lib/functions/conversation-title", () => ({
    applyAIConversationTitle: vi.fn(async () => {}),
  }));
  vi.doMock("@/hooks/useWindow", () => ({
    useWindowResize: () => ({ resizeWindow: vi.fn(async () => {}) }),
    resizeWindow: vi.fn(async () => {}),
    isAnyPopoverOpen: () => false,
  }));
  vi.doMock("@/layouts", () => ({ ErrorLayout: () => null }));
  vi.doMock("@/components", async () => {
    const { AddToggle } = await import("@/components/AddToggle");
    return {
      AddToggle,
      Card: ({ children }: Kids) => <div data-testid="overlay-card">{children}</div>,
      Updater: () => null,
      DragButton: () => null,
      CustomCursor: () => null,
      WingIcon: () => null,
      CopyButton: () => null,
      SpeakerTaggingPopover: () => null,
      Markdown: ({ children }: Kids) => <div>{children}</div>,
      Button: ({
        children,
        onClick,
        title,
        size: _s,
        variant: _v,
        ...rest
      }: ComponentProps<"button"> & { size?: string; variant?: string }) => (
        <button type="button" onClick={onClick} title={title} {...rest}>
          {children}
        </button>
      ),
      Input: forwardRef<HTMLInputElement, ComponentProps<"input">>((props, ref) => (
        <input ref={ref} {...props} />
      )),
      ScrollArea: forwardRef<HTMLDivElement, Kids & { className?: string }>(
        ({ children, className }, ref) => (
          <div ref={ref} className={className}>
            {children}
          </div>
        )
      ),
      Switch: ({
        checked,
        onCheckedChange,
      }: {
        checked: boolean;
        onCheckedChange: (checked: boolean) => void;
      }) => (
        <button
          type="button"
          role="switch"
          aria-checked={checked}
          onClick={() => onCheckedChange(!checked)}
        />
      ),
      Popover: ({
        open,
        onOpenChange,
        children,
      }: Kids & { open?: boolean; onOpenChange?: (open: boolean) => void }) => (
        <PopoverCtx.Provider value={{ open, onOpenChange }}>{children}</PopoverCtx.Provider>
      ),
      PopoverTrigger: ({ children }: { children: ReactNode }) => {
        const ctx = useContext(PopoverCtx);
        if (!isValidElement(children)) return <>{children}</>;
        const child = children as ReactElement<{ onClick?: (e: unknown) => void }>;
        return cloneElement(child, {
          onClick: (e: unknown) => {
            child.props.onClick?.(e);
            ctx.onOpenChange?.(!ctx.open);
          },
        });
      },
      PopoverContent: ({ children }: { children: ReactNode }) => {
        const ctx = useContext(PopoverCtx);
        return ctx.open === false ? null : <div data-testid="popover-content">{children}</div>;
      },
    };
  });
  // The barrel WITHOUT importOriginal: every hook App/Completion mounts is named
  // here. useCompletion is late-bound (it imports this barrel itself).
  vi.doMock("@/hooks", async () => {
    const { useOdooTarget } = await import("@/hooks/useOdooTarget");
    const { useMeetingAutoRecord } = await import("@/hooks/useMeetingAutoRecord");
    const { usePillRecordAction } = await import("@/hooks/usePillRecordAction");
    return {
      useApp: () => ({ isHidden: false, systemAudio: knobs.systemAudio }),
      useSetupStatus: () => ({
        isComplete: true,
        isLoading: false,
        aiConfigured: true,
        sttConfigured: true,
      }),
      useMeetingDetection: () => ({}),
      useGlobalShortcuts: () => GLOBAL_SHORTCUTS,
      useCompletion: () => {
        const c = real.useCompletion!();
        liveCompletion = c;
        probe.renders.push({ meetingAssistMode: c.meetingAssistMode, enableVAD: c.enableVAD });
        return c;
      },
      useQuickActions: () => undefined,
      usePillRecordAction,
      useMeetingAutoRecord,
      useOdooTarget,
      useCalendarProposal: () =>
        knobs.calendar ?? {
          present: false,
          state: { kind: "idle" },
          onPickCandidate: vi.fn(),
          onRetry: vi.fn(),
        },
      useMeetingLog: () => ({ holding: false, onUndo: vi.fn(), undoBlockedMessage: null }),
    };
  });
  vi.doMock("@/pages/app/components", async (orig) => ({
    ...(await orig<Record<string, unknown>>()),
    SystemAudio: () => null,
    AudioVisualizer: () => null,
    StatusIndicator: () => null,
  }));
  vi.doMock("@/pages/app/components/completion/Audio", () => ({ Audio: () => null }));
  vi.doMock("@/pages/app/components/completion/Screenshot", () => ({ Screenshot: () => null }));
  vi.doMock("@/pages/app/components/completion/Files", () => ({ Files: () => null }));
  vi.doMock("@/pages/app/components/completion/MeetingAssistToggle", () => ({
    MeetingAssistToggle: () => null,
  }));
  vi.doMock("@/pages/app/components/completion/MessageHistory", () => ({
    MessageHistory: () => null,
  }));
  vi.doMock("@/pages/app/components/completion/QuickActions", () => ({
    QuickActions: () => null,
  }));
  vi.doMock("@/pages/app/components/completion/ActiveModels", () => ({
    ActiveModels: () => null,
  }));
  vi.doMock("react-error-boundary", () => ({
    ErrorBoundary: ({ children }: Kids) => <>{children}</>,
  }));
};

function contact(id: number, name: string) {
  return {
    id,
    name,
    email: `${name.toLowerCase()}@example.com`,
    phone: null,
    companyName: "Customer Ltd",
    parentId: null,
    isCompany: false,
    active: true,
    writeDate: "2026-08-01 10:00:00",
    isColleague: false,
    lastMeetingAt: null,
  };
}

const user = userEvent.setup();

/** Mounts App, waits for the app-start rehydrate + sync + reload to settle. */
async function mountApp() {
  mockEverything();
  const action = await import("@/lib/database/odoo-contacts.action");
  await action.upsertContacts(INSTANCE, [contact(1, "Ada"), contact(2, "Bea")] as never, 1000);
  real.useCompletion = (await import("@/hooks/useCompletion")).useCompletion;
  const { default: App } = await import("@/pages/app");
  const store = await import("@/lib/overlay-minimize.store");
  render(
    <MemoryRouter>
      <App />
    </MemoryRouter>
  );
  // The mount effect's last leg is reload() -> listContacts; the picker shows
  // the cache once it is "ready".
  await waitFor(() =>
    expect(targetLines().some((l) => l.op === "loadTargets" && "outcome" in l.detail)).toBe(true)
  );
  await waitFor(() => expect(odoo.execute).toHaveBeenCalled());
  return { store, action };
}

/** The user opens the picker and clicks "+ add" on two contact rows. */
async function addTwoTargetsViaPicker() {
  await user.click(screen.getByTestId("contact-picker-trigger"));
  await user.click(await screen.findByRole("button", { name: "add Ada" }));
  await screen.findByRole("button", { name: "added Ada" });
  await user.click(screen.getByRole("button", { name: "add Bea" }));
  await screen.findByRole("button", { name: "added Bea" });
  expect(screen.getByText("Logging to (2)")).toBeInTheDocument();
  expect(dbTargets()).toHaveLength(2);
}

async function closePicker() {
  await user.click(screen.getByTestId("contact-picker-trigger"));
  await waitFor(() => expect(screen.queryByText("Logging to (2)")).toBeNull());
}

/** Meeting assist on, mic (VAD) open, transcript lines present. */
async function startMeetingByHand(lines = ["Hello everyone", "Let's begin"]) {
  act(() => {
    probe.completion.setMeetingAssistMode(true);
    probe.completion.setEnableVAD(true);
  });
  for (const line of lines) {
    // Distinct timestamps under a frozen fake Date (the panel keys on them).
    if (vi.isFakeTimers()) vi.setSystemTime(Date.now() + 1000);
    act(() => {
      probe.completion.addMeetingTranscript(line, undefined, "microphone");
    });
  }
  await waitFor(() => expect(probe.completion.meetingTranscript).toHaveLength(lines.length));
}

/** Minimize via the REAL button, restore via the REAL pill's Expand button. */
async function minimizeThenRestore(whileMinimized?: () => Promise<void>) {
  await user.click(screen.getByTitle("Minimize"));
  await screen.findByRole("button", { name: "Expand Meetwings overlay" });
  await whileMinimized?.();
  await user.click(screen.getByRole("button", { name: "Expand Meetwings overlay" }));
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "Expand Meetwings overlay" })).toBeNull()
  );
  expect(invokeMock).toHaveBeenCalledWith("minimize_overlay", expect.anything());
  expect(invokeMock).toHaveBeenCalledWith("restore_overlay", undefined);
}

/** The bug-free outcome every test asserts. */
async function expectTargetsSurvived(mark: number) {
  // Let any fire-and-forget clearTargets (handleNewChat) land.
  await new Promise((r) => setTimeout(r, 50));
  // purgeOtherInstances deleting nothing of ours is benign; the others are not
  // (scenario 5 asserts the purge's rowsAffected separately).
  const harmful = wipeOpsSince(mark).filter((l) => l.op !== "purgeOtherInstances");
  // One object, so a reproduction's failure diff shows ALL the evidence at once.
  expect({
    wipeOps: fmt(harmful),
    dbRows: dbTargets().length,
    inMemoryCount: lastInMemoryCount(),
    trigger: screen.getByTestId("contact-picker-trigger").getAttribute("title"),
    newConversationStartedDispatchedFrom: newChatStacks,
  }).toEqual({
    wipeOps: "",
    dbRows: 2,
    inMemoryCount: 2,
    trigger: "Ada + 1 more",
    newConversationStartedDispatchedFrom: [],
  });
}

/**
 * The synchronous call chain behind every `newConversationStarted` dispatch.
 * A window listener runs INSIDE dispatchEvent, so its stack still holds the
 * dispatcher's frames - which logTargetOp's own stack (taken after the await
 * in handleNewChat) has lost.
 */
let newChatStacks: string[] = [];
const recordNewChat = () => {
  newChatStacks.push(
    (new Error().stack ?? "")
      .split("\n")
      .slice(2)
      .filter((f) => f.includes("/src/") && !f.includes("/node_modules/") && !f.includes("/src/tests/"))
      .slice(0, 4)
      .map((f) => f.trim().replace(/^at /, "").replace(/C:\/Users\/kmorg\/meetwings-i72\//g, ""))
      .join(" <- ")
  );
};

beforeEach(async () => {
  vi.resetModules();
  await freshDb();
  tauriListeners.clear();
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (cmd: string) => {
    if (cmd === "is_overlay_minimized") return false;
    if (cmd === "get_capture_status") return false;
    return undefined;
  });
  odoo.execute.mockClear();
  odoo.hold = null;
  knobs.config = { url: "http://h:8069", db: "odoo", login: "b", apiKey: "k" };
  knobs.systemAudio = { ...knobs.systemAudio, capturing: false, error: "" };
  knobs.autoRecord = false;
  knobs.calendar = null;
  real.useCompletion = null;
  liveCompletion = null;
  probe.renders = [];
  convSeq = 0;
  msgSeq = 0;
  infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
  newChatStacks = [];
  window.addEventListener("newConversationStarted", recordNewChat);
});

afterEach(() => {
  window.removeEventListener("newConversationStarted", recordNewChat);
  infoSpy.mockRestore();
  vi.useRealTimers();
});

describe("issue #72: targets across a minimize/restore cycle during a meeting", () => {
  it("1. system-audio capture ON (toolbar swapped to `hidden`) during the cycle", async () => {
    knobs.systemAudio = { ...knobs.systemAudio, capturing: true };
    await mountApp();
    await addTwoTargetsViaPicker();
    await closePicker();
    await startMeetingByHand();

    const mark = targetLines().length;
    await minimizeThenRestore();
    await expectTargetsSurvived(mark);
  });

  describe("2. meeting assist + VAD on, PR #82 gap rule", () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(2026, 9, 6, 10, 0));
    });

    it("2a. last meeting line OLDER than 30 min: minimize/restore never toggles the capture edge", async () => {
      await mountApp();
      await addTwoTargetsViaPicker();
      await closePicker();
      await startMeetingByHand();
      const convBefore = probe.completion.currentConversationId;
      vi.setSystemTime(Date.now() + GAP_PLUS);

      const mark = targetLines().length;
      const renderMark = probe.renders.length;
      await minimizeThenRestore();

      // The rising-edge input `meetingAssistMode && enableVAD` held true on
      // every render of the cycle - minimize/restore re-renders App but never
      // drops it, so the gap effect cannot re-fire.
      const cycle = probe.renders.slice(renderMark);
      expect(cycle.length).toBeGreaterThan(0);
      expect(cycle.every((r) => r.meetingAssistMode && r.enableVAD)).toBe(true);
      expect(probe.completion.currentConversationId).toBe(convBefore);
      await expectTargetsSurvived(mark);
    });

    it("2b. last meeting line RECENT: same cycle, same result", async () => {
      await mountApp();
      await addTwoTargetsViaPicker();
      await closePicker();
      await startMeetingByHand();
      const convBefore = probe.completion.currentConversationId;
      vi.setSystemTime(Date.now() + 60_000);

      const mark = targetLines().length;
      await minimizeThenRestore();
      expect(probe.completion.currentConversationId).toBe(convBefore);
      await expectTargetsSurvived(mark);
    });

    // KNOWN BUG, not fixed with issue #72: the gap rule's new conversation
    // wipes targets the user picked AFTER the old meeting's last line, i.e.
    // for the meeting now starting. it.fails pins today's behavior; when the
    // gap rule learns to keep those (selected_at > last line), flip to it().
    it.fails("2c. while minimized, the pill's record button stop -> start after a >30 min silence", async () => {
      // NOT the bare cycle: the pill's second button toggles the very pair the
      // gap effect watches.
      await mountApp();
      await addTwoTargetsViaPicker();
      await closePicker();
      await startMeetingByHand();
      vi.setSystemTime(Date.now() + GAP_PLUS);

      const mark = targetLines().length;
      await minimizeThenRestore(async () => {
        await user.click(screen.getByRole("button", { name: "Stop meeting recording" }));
        await user.click(
          await screen.findByRole("button", { name: "Start meeting recording" })
        );
        await screen.findByRole("button", { name: "Stop meeting recording" });
      });
      await expectTargetsSurvived(mark);
    });
  });

  it("3. meeting-detected / meeting-ended flapping around the cycle (auto-record owns the mic)", async () => {
    knobs.autoRecord = true;
    await mountApp();
    await addTwoTargetsViaPicker();
    await closePicker();
    act(() => probe.completion.setMeetingAssistMode(true));

    // The call starts: auto-record's start-meeting opens the mic.
    await act(async () => emitTauri("meeting-detected"));
    await waitFor(() => expect(probe.completion.enableVAD).toBe(true));
    for (const line of ["Hi", "Agenda first"]) {
      act(() => probe.completion.addMeetingTranscript(line, undefined, "microphone"));
    }
    const convBefore = probe.completion.currentConversationId;

    const mark = targetLines().length;
    const flap = async () => {
      await act(async () => emitTauri("meeting-ended"));
      await waitFor(() => expect(probe.completion.enableVAD).toBe(false), { timeout: 3000 });
      await act(async () => emitTauri("meeting-detected"));
      await waitFor(() => expect(probe.completion.enableVAD).toBe(true), { timeout: 3000 });
    };
    await flap(); // before minimizing
    await minimizeThenRestore(flap); // while minimized
    await flap(); // after restoring
    act(() => probe.completion.addMeetingTranscript("Next point", undefined, "microphone"));

    expect(probe.completion.currentConversationId).toBe(convBefore);
    await expectTargetsSurvived(mark);
  });

  it("4. calendar proposal present, ContactPicker OPEN across the cycle, 2 targets added by hand", async () => {
    knobs.calendar = {
      present: true,
      state: {
        kind: "proposal",
        eventId: "evt-1",
        subject: "Weekly sync",
        matched: [
          {
            participant: { address: "ada@example.com", name: "Ada", type: "required" },
            contact: contact(1, "Ada"),
          },
        ],
        unmatched: [],
      },
      onPickCandidate: vi.fn(),
      onRetry: vi.fn(),
    };
    await mountApp();
    await addTwoTargetsViaPicker(); // picker stays open
    await startMeetingByHand();
    expect(screen.getByText("Logging to (2)")).toBeInTheDocument();

    const mark = targetLines().length;
    await minimizeThenRestore();
    expect(screen.getByText("Logging to (2)")).toBeInTheDocument();
    await expectTargetsSurvived(mark);
  });

  it("5. an Odoo contacts sync (Refresh) held in flight across the cycle", async () => {
    // A messy-but-equivalent config: both instance derivations (runSync's and
    // useOdooTarget.resolveInstance's currentInstance) go through
    // instanceFingerprint(config.url, config.db), so they normalise alike.
    knobs.config = { url: "HTTP://H:8069/", db: " odoo ", login: "b", apiKey: "k" };
    await mountApp();
    await addTwoTargetsViaPicker();
    await startMeetingByHand();

    let release!: () => void;
    odoo.hold = new Promise<void>((r) => (release = r));
    const mark = targetLines().length;
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() =>
      expect(wipeOpsSince(mark).some((l) => l.op === "purgeOtherInstances")).toBe(true)
    );

    await minimizeThenRestore(async () => {
      odoo.hold = null;
      release();
      // The refresh's rereadPins + reload legs land while minimized.
      await waitFor(() =>
        expect(
          targetLines()
            .slice(mark)
            .filter((l) => l.op === "loadTargets" && "outcome" in l.detail).length
        ).toBeGreaterThan(0)
      );
    });

    const purges = targetLines()
      .slice(mark)
      .filter((l) => l.op === "purgeOtherInstances");
    const loads = targetLines()
      .slice(mark)
      .filter((l) => l.op === "loadTargets");
    // One instance string across the sync's purge and the hook's reads.
    expect(new Set([...purges, ...loads].map((l) => l.detail.instance))).toEqual(
      new Set([INSTANCE])
    );
    expect(purges.find((l) => "outcome" in l.detail)?.detail.rowsAffected).toBe(0);
    await expectTargetsSurvived(mark);
  });

  // The issue #72 mechanism. During a meeting the transcript forces the
  // response panel open, outside-click/Escape can't close it, and in v1.3.0
  // Minimize was clipped off-screen - so X was the only way to make the
  // overlay small. X used to clear the transcript, which starts a new
  // conversation, which wipes the targets; the next spoken line re-forced
  // the panel open and the user clicked X again.
  describe("6. response-panel X / transcript Clear during a meeting", () => {
    it("6a. X hides the panel, keeps the meeting and its targets; only the input reopens it", async () => {
      await mountApp();
      await addTwoTargetsViaPicker();
      await closePicker();
      await startMeetingByHand();
      const convBefore = probe.completion.currentConversationId;
      expect(probe.completion.isPopoverOpen).toBe(true);
      const mark = targetLines().length;

      await user.click(screen.getByTitle("Hide panel"));
      await waitFor(() => expect(probe.completion.isPopoverOpen).toBe(false));
      expect(probe.completion.meetingTranscript).toHaveLength(2);

      // The reported flow: minimize to the pill and back.
      await minimizeThenRestore();

      // A new spoken line does not force the panel back open.
      act(() => probe.completion.addMeetingTranscript("Still talking", undefined, "microphone"));
      await waitFor(() => expect(probe.completion.meetingTranscript).toHaveLength(3));
      expect(probe.completion.isPopoverOpen).toBe(false);
      expect(screen.queryByTitle("Hide panel")).toBeNull();

      // Clicking the input does.
      await user.click(screen.getByPlaceholderText("Ask me anything..."));
      await screen.findByTitle("Hide panel");

      expect(probe.completion.currentConversationId).toBe(convBefore);
      await expectTargetsSurvived(mark);
    });

    it("6b. Clear in the transcript panel is still an explicit fresh start: it wipes the targets", async () => {
      await mountApp();
      await addTwoTargetsViaPicker();
      await closePicker();
      await startMeetingByHand();
      const mark = targetLines().length;

      await user.click(screen.getByRole("button", { name: "Clear" }));
      await waitFor(() => expect(probe.completion.meetingTranscript).toHaveLength(0));
      await waitFor(() => expect(dbTargets()).toHaveLength(0));
      expect(wipeOpsSince(mark).map((l) => l.op)).toContain("clearTargets");
    });

    it("6c. X with conversation mode (keepEngaged) on also only hides", async () => {
      await mountApp();
      await addTwoTargetsViaPicker();
      await closePicker();
      await startMeetingByHand();
      await user.click(screen.getByRole("switch"));
      await waitFor(() => expect(probe.completion.keepEngaged).toBe(true));
      const convBefore = probe.completion.currentConversationId;
      const mark = targetLines().length;

      await user.click(screen.getByTitle("Hide panel"));
      await waitFor(() => expect(probe.completion.isPopoverOpen).toBe(false));
      expect(probe.completion.meetingTranscript).toHaveLength(2);
      expect(probe.completion.currentConversationId).toBe(convBefore);
      await expectTargetsSurvived(mark);
    });

    it("6d. X dismisses an AI answer too; a new request reopens the hidden panel", async () => {
      await mountApp();
      await startMeetingByHand();
      patchState({ response: "Answer" });
      await screen.findByTitle("Hide panel");

      await user.click(screen.getByTitle("Hide panel"));
      await waitFor(() => expect(probe.completion.isPopoverOpen).toBe(false));
      expect(probe.completion.response).toBe("");
      expect(probe.completion.meetingTranscript).toHaveLength(2);

      // What submit/screenshot/quick-action do first: a request starts.
      patchState({ isLoading: true });
      await waitFor(() => expect(probe.completion.isPopoverOpen).toBe(true));
      patchState({ isLoading: false, response: "Next" });
      expect(probe.completion.isPopoverOpen).toBe(true);
    });

    it("6e. a new conversation un-hides, so the next meeting's panel shows", async () => {
      await mountApp();
      await startMeetingByHand();
      await user.click(screen.getByTitle("Hide panel"));
      await waitFor(() => expect(probe.completion.isPopoverOpen).toBe(false));

      await act(async () => {
        await probe.completion.startNewConversation();
      });
      // The meeting transcript survives a new conversation; it opens the panel again.
      await waitFor(() => expect(probe.completion.isPopoverOpen).toBe(true));
    });

    it("6f. hiding keeps a half-typed question and its attachment", async () => {
      await mountApp();
      await startMeetingByHand();
      const box = screen.getByPlaceholderText("Ask me anything...");
      await user.type(box, "half a question");
      const file = { id: "f1", name: "shot.png", type: "image/png", base64: "", size: 1 };
      patchState({ attachedFiles: [file] });

      await user.click(screen.getByTitle("Hide panel"));
      await waitFor(() => expect(probe.completion.isPopoverOpen).toBe(false));
      await user.click(box);
      await screen.findByTitle("Hide panel");

      expect(box).toHaveValue("half a question");
      expect(probe.completion.attachedFiles).toEqual([file]);
    });
  });
});
