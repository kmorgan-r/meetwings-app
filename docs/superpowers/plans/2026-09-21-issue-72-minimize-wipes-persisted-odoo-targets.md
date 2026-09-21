# Issue 72 — Minimize wipes persisted Odoo targets: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Instrument every read/write of the persisted Odoo target list (`odoo_selected_targets`) with an `instance`-keyed log so the minimize-path wipe mechanism can be identified from its log signature, and independently stop the Minimize button/pill from dismissing an open ContactPicker (the confirmed calendar-proposal wipe).

**Architecture:** Logging lives at the action-module choke point (`odoo-contacts.action.ts`) — every wipe already funnels through `clearTargets`, and `purgeOtherInstances` is the one deletion no user action drives — plus one effect-based count line in `useOdooTarget`. The dismissal fix marks both minimize surfaces with a shared attribute and refuses Radix's outside-dismissal when a pointerdown lands on them. The mechanism fix itself is NOT pre-written: it is selected at the manual gate by the log signature table in the spec, and implemented only after a failing test reproduces the mechanism.

**Tech Stack:** React 19 + TypeScript (strict), Vitest + @testing-library/react (jsdom), Radix popover, Tauri 2, SQLite via `@tauri-apps/plugin-sql`.

**Spec:** `docs/superpowers/specs/2026-09-21-issue-72-minimize-wipes-persisted-odoo-targets-logging-to-list-design.md`

## Global Constraints

- Log prefix is exactly `"[odoo-targets]"` on `console.info`, every line carries an `instance` key. Logs are PERMANENT (no dev-only gate) — ops fire at user frequency.
- StrictMode-safe: no side effects inside `setTargets` updaters; all logging is effect-based or pre-await.
- No new npm dependencies. No signature changes to any exported function in `odoo-contacts.action.ts` (new params would touch every hook and test that calls these).
- Path alias `@/`; files kebab-case; commits conventional (`feat:`/`test:`/`docs:`) ending with `Co-Authored-By: Claude Code <noreply@anthropic.com>`.
- Cross-window events use Tauri `listen`; same-window events use `window.dispatchEvent(new CustomEvent(...))`.
- Test scaffolds follow the repo's proven patterns: hook tests mock the ACTION MODULE layer (`vi.mock("@/lib/database/odoo-contacts.action", () => action)`); action tests run the REAL module against a sql.js in-memory DB via the `getDatabase` seam (`src/tests/odoo-contacts.action.test.ts:11-27`).
- `docs/superpowers/*` is gitignored: any file under it needs `git add -f`.

---

### Task 1: Action-layer `[odoo-targets]` instrumentation

**Files:**
- Modify: `src/lib/database/odoo-contacts.action.ts`
- Test: `src/tests/odoo-contacts.action.test.ts`

**Interfaces:**
- Consumes: existing exports `loadTargets`, `addSelectedTarget`, `removeSelectedTarget`, `clearTargets`, `purgeOtherInstances` (signatures unchanged).
- Produces: module-scope helper `logTargetOp(op: string, instance: string | null, detail?: Record<string, unknown>): void` (not exported); every op now emits `console.info("[odoo-targets]", op, { instance, ...detail, stack })` before its DB call and with an `outcome` after. Later tasks and the manual gate read these lines.

- [ ] **Step 1: Write the failing tests**

Append to `src/tests/odoo-contacts.action.test.ts` (the file already runs the real module against a sql.js DB — reuse its `INSTANCE`/`OTHER` constants and `contact()` helper; `addSelectedTarget` seeds rows). Add a `describe` at the end of the file:

```ts
describe("[odoo-targets] instrumentation (issue #72)", () => {
  let infoSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
  });
  afterEach(() => infoSpy.mockRestore());

  const lines = (op: string) =>
    infoSpy.mock.calls.filter((c) => c[0] === "[odoo-targets]" && c[1] === op);

  it("loadTargets logs the op with the instance key and row count", async () => {
    await addSelectedTarget(
      INSTANCE,
      { model: "res.partner", resId: 1, name: "A" },
      null,
      1000
    );
    infoSpy.mockClear();
    const rows = await loadTargets(INSTANCE);
    expect(rows).toHaveLength(1);
    expect(lines("loadTargets")).toHaveLength(2); // before-call + outcome
    expect(lines("loadTargets")[0][2]).toMatchObject({ instance: INSTANCE });
    expect(lines("loadTargets")[1][2]).toMatchObject({
      instance: INSTANCE,
      rowCount: 1,
      outcome: "ok",
    });
  });

  it("addSelectedTarget logs ok:false on the cap rejection", async () => {
    for (let i = 0; i < MAX_TARGETS; i++) {
      await addSelectedTarget(
        INSTANCE,
        { model: "res.partner", resId: i + 1, name: `C${i}` },
        null,
        1000 + i
      );
    }
    infoSpy.mockClear();
    const result = await addSelectedTarget(
      INSTANCE,
      { model: "res.partner", resId: 999, name: "Overflow" },
      null,
      2000
    );
    expect(result).toEqual({ ok: false, reason: "cap" });
    expect(lines("addSelectedTarget").at(-1)?.[2]).toMatchObject({
      instance: INSTANCE,
      resId: 999,
      outcome: { ok: false, reason: "cap" },
    });
  });

  it("clearTargets logs before the DELETE and the outcome after", async () => {
    await addSelectedTarget(
      INSTANCE,
      { model: "res.partner", resId: 2, name: "B" },
      null,
      1000
    );
    infoSpy.mockClear();
    await clearTargets(INSTANCE);
    expect(lines("clearTargets")).toHaveLength(2);
    expect(lines("clearTargets")[0][2]).toMatchObject({ instance: INSTANCE });
    expect(lines("clearTargets")[1][2]).toMatchObject({ outcome: "ok" });
  });

  it("purgeOtherInstances logs instance + rowsAffected, sourced from the DELETE results", async () => {
    await addSelectedTarget(
      INSTANCE,
      { model: "res.partner", resId: 3, name: "Keep" },
      null,
      1000
    );
    await addSelectedTarget(
      OTHER,
      { model: "res.partner", resId: 9, name: "Gone" },
      null,
      1000
    );
    infoSpy.mockClear();
    await purgeOtherInstances(INSTANCE);
    expect(lines("purgeOtherInstances").at(-1)?.[2]).toMatchObject({
      instance: INSTANCE,
      rowsAffected: 1, // the OTHER row; odoo_contacts/odoo_sync_state are empty here
      outcome: "ok",
    });
    // the kept instance's rows survive
    expect(await loadTargets(INSTANCE)).toHaveLength(1);
  });

  it("a failed op still logs — the before-call line wins", async () => {
    const { getDatabase } = await import("@/lib/database/config");
    vi.mocked(getDatabase).mockRejectedValueOnce(new Error("database is locked"));
    infoSpy.mockClear();
    await expect(loadTargets(INSTANCE)).rejects.toThrow("database is locked");
    expect(lines("loadTargets")).toHaveLength(1); // before-call line only
    expect(lines("loadTargets")[0][2]).toMatchObject({ instance: INSTANCE });
  });
});
```

Add `MAX_TARGETS` to the existing import from `@/lib/odoo` at the top of the test file (the cap constant the action module itself imports). If `MAX_TARGETS` is not exported from `@/lib/odoo` (check `src/lib/odoo` — `ContactPicker.tsx:3` imports it from there), import it from wherever the action module gets it.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/tests/odoo-contacts.action.test.ts`
Expected: FAIL — the new `describe` fails on "loadTargets logs..." (no log lines emitted yet: `lines("loadTargets")` is empty).

- [ ] **Step 3: Add `logTargetOp` and instrument the five ops**

In `src/lib/database/odoo-contacts.action.ts`, add above `purgeOtherInstances` (near the other module helpers):

```ts
/**
 * [odoo-targets] — issue #72 instrumentation. Every read/write of
 * odoo_selected_targets passes through here, so this is the one place a
 * minimize-path wipe can show itself. `stack` carries frames 2-5 of the
 * captured stack: the immediate caller chain, enough to tell
 * handleNewChat from clearAllTargets from purgeOtherInstances' runSync
 * caller without threading an origin parameter through every call site.
 * Permanent on purpose: ops fire at user frequency, and a future reporter
 * can paste these lines instead of triggering a fresh investigation.
 */
const logTargetOp = (
  op: string,
  instance: string | null,
  detail: Record<string, unknown> = {}
) => {
  const stack = (new Error().stack ?? "").split("\n").slice(2, 6).join(" <- ");
  console.info("[odoo-targets]", op, { instance, ...detail, stack });
};
```

`purgeOtherInstances` (line 241) — collect `rowsAffected` from the three DELETE results; the `meeting_log_queue` comment block above the deletes is preserved verbatim:

```ts
export async function purgeOtherInstances(instance: string): Promise<void> {
  logTargetOp("purgeOtherInstances", instance);
  const db = await getDatabase();
  // (existing comment block about meeting_log_queue deliberately NOT being
  // purged here — keep it exactly as-is)
  let rowsAffected = 0;
  rowsAffected += (await db.execute("DELETE FROM odoo_contacts WHERE instance <> ?", [instance])).rowsAffected ?? 0;
  rowsAffected += (await db.execute("DELETE FROM odoo_sync_state WHERE instance <> ?", [instance])).rowsAffected ?? 0;
  rowsAffected += (await db.execute("DELETE FROM odoo_selected_targets WHERE instance <> ?", [instance])).rowsAffected ?? 0;
  logTargetOp("purgeOtherInstances", instance, { rowsAffected, outcome: "ok" });
}
```

`loadTargets`:

```ts
export async function loadTargets(instance: string): Promise<SelectedTargets> {
  logTargetOp("loadTargets", instance);
  const db = await getDatabase();
  const rows = await db.select<{ model: SelectedTarget["model"]; res_id: number; name: string | null }[]>(
    SELECTED_TARGET_SQL.list,
    [instance]
  );
  const targets = rows.map((row) => ({ model: row.model, resId: row.res_id, name: row.name }));
  logTargetOp("loadTargets", instance, { rowCount: targets.length, outcome: "ok" });
  return targets;
}
```

`addSelectedTarget` — log at entry (model/resId), and the final result at BOTH exits:

```ts
export async function addSelectedTarget(
  instance: string,
  t: SelectedTarget,
  conversationId: string | null,
  at: number
): Promise<{ ok: boolean; reason?: "cap" }> {
  logTargetOp("addSelectedTarget", instance, { model: t.model, resId: t.resId });
  const db = await getDatabase();
  const existing = await db.select<{ n: number }[]>(SELECTED_TARGET_SQL.countOthers, [
    instance,
    t.model,
    t.resId,
  ]);
  if ((existing[0]?.n ?? 0) >= MAX_TARGETS) {
    logTargetOp("addSelectedTarget", instance, {
      model: t.model,
      resId: t.resId,
      outcome: { ok: false, reason: "cap" },
    });
    return { ok: false, reason: "cap" };
  }
  await db.execute(SELECTED_TARGET_SQL.upsert, [
    instance,
    t.model,
    t.resId,
    t.name,
    conversationId,
    at,
  ]);
  logTargetOp("addSelectedTarget", instance, {
    model: t.model,
    resId: t.resId,
    outcome: { ok: true },
  });
  return { ok: true };
}
```

`removeSelectedTarget` — same pattern (entry log with model/resId, outcome log after the DELETE).

`clearTargets` (line 352):

```ts
export async function clearTargets(instance: string): Promise<void> {
  logTargetOp("clearTargets", instance);
  const db = await getDatabase();
  await db.execute(SELECTED_TARGET_SQL.clear, [instance]);
  logTargetOp("clearTargets", instance, { outcome: "ok" });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/tests/odoo-contacts.action.test.ts`
Expected: PASS — all pre-existing cases (the adapter passes `console.info` calls nowhere; nothing else reads the log) plus the five new ones.

- [ ] **Step 5: Commit**

```bash
git add src/lib/database/odoo-contacts.action.ts src/tests/odoo-contacts.action.test.ts
git commit -m "test: log odoo target db ops with the instance key (issue 72)"
```

---

### Task 2: Hook-side `targets` count log

**Files:**
- Modify: `src/hooks/useOdooTarget.ts` (add one effect; place it directly after the existing `setTargetCount` effect at lines 251-253)
- Test: `src/tests/useOdooTarget.test.tsx`

**Interfaces:**
- Consumes: `targets` state (`useState<SelectedTargets>([])`, line 240).
- Produces: console line `"[odoo-targets]", "targets", { count: <n> }` on every committed targets change. The manual gate's signature table reads this line to distinguish a UI-only wipe (count drops with no action-layer op) from a real one.

- [ ] **Step 1: Write the failing test**

Append to `src/tests/useOdooTarget.test.tsx` (the file already mocks `@/lib/database/odoo-contacts.action` as the `action` object at line 69 and mounts the real hook — copy the nearest existing `renderHook` call's parameter shape; the four production params are `meetingAssistMode` / `isPickerOpen` / `setIsPickerOpen` / `setTargetCount`, exactly what `completion/index.tsx:51-62` passes):

```ts
describe("[odoo-targets] hook-side count log (issue #72)", () => {
  let infoSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
  });
  afterEach(() => infoSpy.mockRestore());

  const countLines = () => infoSpy.mock.calls.filter((c) => c[1] === "targets");

  it("logs count transitions, and a UI wipe shows as a count-0 line with the clearTargets op beside it", async () => {
    action.loadTargets.mockResolvedValue([
      { model: "res.partner", resId: 1, name: "A" },
    ]);
    renderHook(() =>
      useOdooTarget({
        meetingAssistMode: true,
        isPickerOpen: false,
        setIsPickerOpen: vi.fn(),
        setTargetCount: vi.fn(),
      })
    );
    await waitFor(() =>
      expect(countLines().some((c) => c[2].count === 1)).toBe(true)
    );

    // The new-chat wipe: in-memory clear first (the count-0 line), DB wipe
    // second (the clearTargets action line). Both must be on the record.
    window.dispatchEvent(new CustomEvent("newConversationStarted"));
    await waitFor(() =>
      expect(countLines().some((c) => c[2].count === 0)).toBe(true)
    );
    await waitFor(() =>
      expect(action.clearTargets).toHaveBeenCalledWith("http://h:8069|odoo")
    );
  });
});
```

Match the existing file's import style — `action` (the hoisted action-module mock at line 93), `useOdooTarget`, `renderHook`, `waitFor` are already imported there.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/tests/useOdooTarget.test.tsx`
Expected: FAIL — `countLines()` is empty (no `targets` log exists yet).

- [ ] **Step 3: Add the effect**

In `src/hooks/useOdooTarget.ts`, directly after the existing `setTargetCount` effect (lines 251-253):

```ts
/**
 * Issue #72 instrumentation: the UI-side mirror of the action-layer
 * `[odoo-targets]` logs. A UI-only wipe empties this list with zero DB
 * writes and is invisible at the action layer; this line is what makes it
 * diagnosable in one round instead of two. Effect-based, deliberately NOT
 * inside `applyTargets`' `setTargets` updater — updaters run during render
 * and twice under StrictMode, and a side effect there is exactly the
 * impurity StrictMode punishes.
 */
useEffect(() => {
  console.info("[odoo-targets]", "targets", { count: targets.length });
}, [targets]);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/tests/useOdooTarget.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useOdooTarget.ts src/tests/useOdooTarget.test.tsx
git commit -m "test: log the odoo targets count transitions in useOdooTarget (issue 72)"
```

---

### Task 3: Minimize-control marker + ContactPicker dismissal guard

**Files:**
- Modify: `src/pages/app/index.tsx:242-250` (Minimize button), `src/pages/app/components/MinimizedPill.tsx:78-84` (root div), `src/pages/app/components/completion/ContactPicker.tsx:366` (PopoverContent)
- Test: `src/tests/overlay-minimize-picker-dismiss.test.tsx` (new file)

**Interfaces:**
- Consumes: Radix `PopoverContent`'s `onPointerDownOutside` / `onFocusOutside` (dismissal-cancel via `preventDefault`); the shadcn `Button` (spreads extra props onto the underlying `<button>`).
- Produces: attribute `data-overlay-minimize-control="true"` on the overlay-bar Minimize button and the `MinimizedPill` root — `ContactPicker`'s dismissal guard and the keeps-mounted attribute assertion (Task 4) both select on `[data-overlay-minimize-control]`.

- [ ] **Step 1: Write the failing test**

Create `src/tests/overlay-minimize-picker-dismiss.test.tsx`:

```tsx
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { ContactPicker } from "@/pages/app/components/completion/ContactPicker";
import { MinimizedPill } from "@/pages/app/components/MinimizedPill";

// jsdom lacks the PointerEvent / pointer-capture machinery Radix's
// DismissableLayer needs to process outside-pointerdown dismissals at all.
// Without these, every dismissal test below passes vacuously.
beforeAll(() => {
  if (!window.PointerEvent) {
    window.PointerEvent = class PointerEvent extends MouseEvent {
      public pointerId: number;
      constructor(type: string, params: PointerEventInit = {}) {
        super(type, params);
        this.pointerId = params.pointerId ?? 0;
      }
    } as unknown as typeof PointerEvent;
  }
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = () => false;
  }
  if (!Element.prototype.setPointerCapture) {
    Element.prototype.setPointerCapture = () => {};
  }
  if (!Element.prototype.releasePointerCapture) {
    Element.prototype.releasePointerCapture = () => {};
  }
});

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => {}) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ label: "main" }),
}));
vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));
vi.mock("@/hooks/useWindow", () => ({
  resizeWindow: vi.fn(async () => {}),
  isAnyPopoverOpen: () => false,
}));
vi.mock("@/lib/database/odoo-contacts.action", () => ({
  listContacts: vi.fn(async () => []),
  getSyncState: vi.fn(async () => null),
  setColleague: vi.fn(async () => {}),
  stampLastMeeting: vi.fn(async () => {}),
  loadTargets: vi.fn(async () => []),
  addSelectedTarget: vi.fn(async () => ({ ok: true })),
  removeSelectedTarget: vi.fn(async () => {}),
  clearTargets: vi.fn(async () => {}),
  purgeOtherInstances: vi.fn(async () => {}),
}));
// The pure helpers stay REAL (compareContacts/filterContacts are plain
// functions); only the network/instance surface is stubbed, following the
// odoo-target-new-chat-entry-points pattern of keeping the error classes.
vi.mock("@/lib/odoo", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    runSync: vi.fn(async () => ({
      ran: true,
      changed: 0,
      fetched: 0,
      skipped: 0,
      clampSkipped: false,
    })),
    currentInstance: vi.fn(async () => "http://h:8069|odoo"),
    createOdooClient: vi.fn(() => ({
      authenticate: vi.fn(),
      execute: vi.fn(),
      serverDate: null,
    })),
    fetchOpportunities: vi.fn(async () => []),
  };
});
vi.mock("@/lib/storage/odoo-config.storage", () => ({
  loadOdooConfig: vi.fn(async () => ({
    url: "http://h:8069",
    db: "odoo",
    login: "b",
    apiKey: "k",
  })),
  instanceFingerprint: vi.fn(() => "http://h:8069|odoo"),
}));
vi.mock("@/pages/app/components/completion/CalendarProposal", () => ({
  CalendarProposal: () => null,
}));

const onOpenChange = vi.fn();

// The picker with one target, plus BOTH minimize-control surfaces. The
// Minimize BUTTON is a test-local stand-in — the real one lives inline in
// the overlay bar and this scaffold cannot mount app/index.tsx; the real
// button's attribute wiring is enforced by Task 4's attribute assertion.
// The PILL is the real component: its root carrying the marker is the
// restore-click regression, and rendering the real pill is what makes it
// an enforced assertion rather than a mirror of the stand-in.
const Harness = () => {
  const [open, setOpen] = useState(true);
  return (
    <>
      <div data-testid="plain-outside">outside</div>
      <button data-overlay-minimize-control="true" data-testid="minimize-standin">
        min
      </button>
      <ContactPicker
        contactId={null}
        leadId={null}
        leadName={null}
        contactName={null}
        cache={{ kind: "never-synced" } as never}
        opportunities={null}
        opportunityError={null}
        isLookingUp={false}
        onSelect={vi.fn(async () => {})}
        onSelectOpportunity={vi.fn(async () => {})}
        onToggleColleague={vi.fn(async () => {})}
        onRetryOpportunities={vi.fn(async () => {})}
        onRefresh={vi.fn(async () => {})}
        onOpenSettings={vi.fn()}
        onSearchLeads={vi.fn(async () => {})}
        targets={[{ model: "res.partner" as const, resId: 1, name: "A" }]}
        onAddTarget={vi.fn(async () => {})}
        onCreateContact={vi.fn(async () => ({ ok: true } as never))}
        onRemoveTarget={vi.fn(async () => {})}
        onClearTargets={vi.fn(async () => {})}
        onExpandContact={vi.fn(async () => {})}
        opportunitiesFor={vi.fn(() => null)}
        errorFor={vi.fn(() => null)}
        onRetryContactOpportunities={vi.fn(async () => {})}
        open={open}
        onOpenChange={onOpenChange}
      />
      <MinimizedPill style="status-count" />
    </>
  );
};

beforeEach(() => {
  onOpenChange.mockClear();
});

describe("the minimize controls do not dismiss an open ContactPicker (issue #72)", () => {
  it("SANITY: the dismissal machinery fires at all — a plain outside pointerdown closes the picker", async () => {
    render(<Harness />);
    expect(screen.getByTestId("logging-to-section")).toBeTruthy();
    fireEvent.pointerDown(screen.getByTestId("plain-outside"));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it("a pointerdown on the Minimize control keeps the picker open", async () => {
    render(<Harness />);
    fireEvent.pointerDown(screen.getByTestId("minimize-standin"));
    // Radix fires onOpenChange(true) when the popover first opens — assert
    // it was never called with FALSE.
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("a pointerdown on the restored pill keeps the picker open", async () => {
    const { container } = render(<Harness />);
    // The pill is a SIBLING of the picker; its root carries the marker.
    const pillRoot = container.querySelector(
      'div[data-overlay-minimize-control="true"]'
    );
    expect(pillRoot).toBeTruthy(); // the REAL MinimizedPill root is marked
    fireEvent.pointerDown(pillRoot as HTMLElement);
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("the real MinimizedPill root carries the marker attribute", () => {
    const { container } = render(<MinimizedPill style="status-count" />);
    expect(
      container.querySelector('div[data-overlay-minimize-control="true"]')
    ).toBeTruthy();
  });
});
```

Notes for the implementer:
- `waitFor` needs importing from `@testing-library/react`; the picker's search-debounce effect (`ContactPicker.tsx:280-285`) fires `onSearchLeads` on mount after 350ms — the stub handles it, no timer concerns.
- The pill's `handleExpand` calls `invoke("restore_overlay")` (core mock resolves) and `resizeWindow`/`isAnyPopoverOpen` (useWindow mock). The pill data store (`overlay-minimize.store`) is a real module and jsdom-safe.
- If the REAL `@/components` barrel pull-in fails on an unrelated heavy export, spread `importOriginal` and stub ONLY the offending entries — `Popover`, `PopoverTrigger`, `PopoverContent`, `Input`, `Button`, `AddToggle` must stay REAL or the test is void.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/tests/overlay-minimize-picker-dismiss.test.tsx`
Expected: FAIL — "a pointerdown on the Minimize control keeps the picker open" fails (`onOpenChange` called with `false` — today the dismissal wins); "the real MinimizedPill root carries the marker attribute" fails (no attribute). The sanity check PASSES (dismissal machinery works). If the sanity check FAILS instead, the jsdom polyfills are incomplete — fix those before touching the component; the remaining tests are void without it.

- [ ] **Step 3: Add the marker to both minimize surfaces**

`src/pages/app/index.tsx` — the Minimize button (lines 242-250):

```tsx
<Button
  size={"icon"}
  className="cursor-pointer"
  title="Minimize"
  aria-label="Minimize overlay"
  data-overlay-minimize-control="true"
  onClick={handleMinimize}
>
```

`src/pages/app/components/MinimizedPill.tsx` — the root div (lines 78-84):

```tsx
<div
  data-overlay-minimize-control="true"
  className={cn(
    "group/pill w-full h-full flex items-center p-0.5 rounded-xl",
    "bg-card/95 border border-border shadow-md"
  )}
>
```

- [ ] **Step 4: Add the dismissal guard to ContactPicker's PopoverContent**

`src/pages/app/components/completion/ContactPicker.tsx:366`:

```tsx
<PopoverContent
  className="w-80 p-3 popover-opaque"
  onPointerDownOutside={(e) => {
    const target = e.detail.originalEvent.target as HTMLElement | null;
    if (target?.closest("[data-overlay-minimize-control]")) e.preventDefault();
  }}
  onFocusOutside={(e) => {
    // The click also moves focus, and Radix fires this as a separate
    // dismissal — preventing only the pointerdown one leaves the focus
    // dismissal to close the picker anyway.
    const target = e.detail.originalEvent.target as HTMLElement | null;
    if (target?.closest("[data-overlay-minimize-control]")) e.preventDefault();
  }}
>
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/tests/overlay-minimize-picker-dismiss.test.tsx`
Expected: PASS — all four, including the sanity check.

- [ ] **Step 6: Commit**

```bash
git add src/pages/app/index.tsx src/pages/app/components/MinimizedPill.tsx src/pages/app/components/completion/ContactPicker.tsx src/tests/overlay-minimize-picker-dismiss.test.tsx
git commit -m "fix(overlay): minimize controls no longer dismiss the contact picker (issue 72)"
```

---

### Task 4: Keeps-mounted extension — the SQLite target list survives a minimize/restore cycle

**Files:**
- Test: `src/tests/overlay-minimize-keeps-mounted.test.tsx` (refactor + new case)

**Interfaces:**
- Consumes: Task 1's action-module exports (mocked here as spies — there is NO stateful plugin-sql mock in this repo's hook tests; `useOdooTarget.test.tsx:69` mocks the action layer), Task 3's `data-overlay-minimize-control` attribute, the file's existing `mockEverything()` scaffold.
- Produces: the issue's named regression assertion — a minimize/restore cycle performs zero target wipe ops and leaves the in-memory list intact.

- [ ] **Step 1: Hoist the shared scaffold pieces**

The current file's `mockEverything()` inlines the `@/hooks` barrel stub and the `useCompletion` stub's fields. Two extractions make the new case possible WITHOUT touching the existing two tests:

1. Module level (below the `transcriptSeed` declaration):

```ts
// Hoisted so the new case can assert the real hook's targets-size push
// (useOdooTarget.ts:251-253) — the in-memory survival probe.
const setTargetCountSpy = vi.fn();
// Hoisted so the doMock factories (hoisted by vitest) can close over them,
// exactly like odoo-target-new-chat-entry-points.test.tsx's `action`.
const actionSpies = vi.hoisted(() => ({
  listContacts: vi.fn(async () => []),
  getSyncState: vi.fn(async () => null),
  setColleague: vi.fn(async () => {}),
  stampLastMeeting: vi.fn(async () => {}),
  loadTargets: vi.fn(async () => [] as unknown[]),
  addSelectedTarget: vi.fn(async () => ({ ok: true }) as { ok: boolean; reason?: "cap" }),
  removeSelectedTarget: vi.fn(async () => {}),
  clearTargets: vi.fn(async () => {}),
  purgeOtherInstances: vi.fn(async () => {}),
  upsertContacts: vi.fn(async () => {}),
}));
```

2. Extract the barrel stub into a module-level function and use it in `mockEverything()` (the object literal moves verbatim; only `setTargetCount: vi.fn()` inside the `useCompletion` stub becomes `setTargetCount: setTargetCountSpy`):

```ts
const hooksBarrelStub = () => ({
  ...actual, // existing importOriginal spread inside mockEverything's factory — keep the factory shape, just reuse this object
  useApp: () => ({ isHidden: false, systemAudio: { capturing: true, error: "" } }),
  // ...every entry from the current factory, UNCHANGED...
  useCompletion: () => {
    useEffect(() => { completionMountSpy(); }, []);
    return {
      meetingTranscript: transcriptSeed,
      meetingAssistMode: true,
      isContactPickerOpen: false,
      setIsContactPickerOpen: vi.fn(),
      setTargetCount: setTargetCountSpy,   // <- was an inline vi.fn()
      setCalendarBlockPresent: vi.fn(),
      currentConversationId: null,
      enableVAD: false,
      setEnableVAD: vi.fn(),
      flushUnsavedMeetingTranscript: vi.fn(),
    };
  },
  // useQuickActions, usePillRecordAction, useMeetingAutoRecord,
  // useOdooTarget (the STUB — kept for tests 1-2), useCalendarProposal,
  // useMeetingLog: unchanged
});
```

and `mockEverything()`'s `vi.doMock("@/hooks", ...)` becomes `vi.doMock("@/hooks", () => hooksBarrelStub())` (keep the existing `importOriginal` spread semantics inside the extracted factory — the literal object currently returned moves verbatim into `hooksBarrelStub`, with the real hook's entry REPLACED per-test only in the new case).

Also reset the new spy in `beforeEach`: `setTargetCountSpy.mockClear(); actionSpies.clearMocks?.();` — or, simplest, `vi.clearAllMocks()` is NOT used by this file (it resets per-mock explicitly), so add explicit clears for the two new objects.

- [ ] **Step 2: Write the new test case**

Append to the existing `describe`:

```ts
it("the SQLite-backed target list survives a minimize/restore cycle (issue #72)", async () => {
  mockEverything();
  // Extra doMocks — registered AFTER mockEverything(), so they win for the
  // App import below. The real hook's import list is exactly:
  //   @tauri-apps/api/{core,event,window}, sonner,
  //   @/lib/database/odoo-contacts.action, @/lib/odoo,
  //   @/lib/storage/odoo-config.storage (useOdooTarget.ts:1-37).
  vi.doMock("@tauri-apps/api/window", () => ({
    getCurrentWindow: () => ({ label: "main" }),
  }));
  vi.doMock("sonner", () => ({
    toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
  }));
  vi.doMock("@/lib/database/odoo-contacts.action", () => actionSpies);
  vi.doMock("@/lib/odoo", async (importOriginal) => {
    const errors = await importOriginal<Record<string, unknown>>();
    return {
      ...errors,
      runSync: vi.fn(async () => ({ ran: true, changed: 0, fetched: 0, skipped: 0, clampSkipped: false })),
      currentInstance: vi.fn(async () => "http://h:8069|odoo"),
      createOdooClient: vi.fn(() => ({ authenticate: vi.fn(), execute: vi.fn(), serverDate: null })),
      fetchOpportunities: vi.fn(async () => []),
    };
  });
  vi.doMock("@/lib/storage/odoo-config.storage", () => ({
    loadOdooConfig: vi.fn(async () => ({ url: "http://h:8069", db: "odoo", login: "b", apiKey: "k" })),
    instanceFingerprint: vi.fn(() => "http://h:8069|odoo"),
  }));
  // The barrel: the shared stub with ONLY useOdooTarget swapped for the
  // real hook (NOT an importOriginal spread — that would un-stub every
  // other hook this file deliberately stubs).
  vi.doMock("@/hooks", async () => {
    const realHook = await import("@/hooks/useOdooTarget");
    return { ...hooksBarrelStub(), useOdooTarget: realHook.useOdooTarget };
  });

  // The "seed": configuring the action mock to rehydrate one row. There is
  // no stateful sql mock to receive an addSelectedTarget call.
  actionSpies.loadTargets.mockResolvedValue([
    { model: "res.partner", resId: 1, name: "A" },
  ]);

  const { default: App } = await import("@/pages/app");
  const { setMinimized } = await import("@/lib/overlay-minimize.store");

  render(
    <MemoryRouter>
      <App />
    </MemoryRouter>
  );

  // Mount: the REAL hook's mount effect rehydrates through the mocked
  // loadTargets (useOdooTarget.ts:655-682) and pushes the size to
  // useCompletion (Task 12's setTargetCount effect).
  await waitFor(() => expect(setTargetCountSpy).toHaveBeenCalledWith(1));
  // The real overlay bar is mounted here — enforce the real button's
  // attribute wiring (the picker-dismiss test's button is a stand-in).
  expect(screen.getByTitle("Minimize")).toHaveAttribute(
    "data-overlay-minimize-control",
    "true"
  );

  setMinimized(true);
  await waitFor(() => {
    expect(screen.getByTestId("minimized-pill-stub")).not.toBeNull();
  });
  setMinimized(false);
  await waitFor(() => {
    expect(screen.queryByTestId("minimized-pill-stub")).toBeNull();
  });

  // 1. In-memory survival (covers the UI-only-wipe candidate): the size
  //    push ends at 1, and no count-0 line fired inside the cycle.
  expect(setTargetCountSpy).toHaveBeenLastCalledWith(1);
  // 2. No wipe ops — including purgeOtherInstances, the only wipe vector
  //    needing no user click.
  expect(actionSpies.clearTargets).not.toHaveBeenCalled();
  expect(actionSpies.removeSelectedTarget).not.toHaveBeenCalled();
  expect(actionSpies.purgeOtherInstances).not.toHaveBeenCalled();
  // 3. Instance stability: the rehydrate's instance is the one the mocked
  //    config fingerprint produced, and nothing rewrote it mid-cycle.
  expect(actionSpies.loadTargets).toHaveBeenCalledWith("http://h:8069|odoo");
  // 4. The mount probe: zero remounts across the cycle.
  expect(completionMountSpy).toHaveBeenCalledTimes(1);
});
```

`beforeEach` additions: `setTargetCountSpy.mockClear()` and `actionSpies.loadTargets.mockResolvedValue([])` (so tests 1-2 are unaffected), plus `screen.getByTitle("Minimize")` requires the lucide-react mock to keep rendering `Minimize2` as a stub INSIDE a real button — it already does (the existing Button mock renders children; the real `app/index.tsx` button uses the mocked `Button` and mocked `Minimize2` icon — `getByTitle` works today in test 2, unchanged).

- [ ] **Step 3: Run the file to verify the new case fails, then passes**

Run: `npx vitest run src/tests/overlay-minimize-keeps-mounted.test.tsx`
First expected FAIL mode (pre-implementation is already true — Task 3 landed the attribute): if the attribute assertion fails, Task 3 was not applied to `app/index.tsx`; re-check. With Task 3 done, the new case should PASS on first run — its value is REGRESSION protection: before the fix it would have caught a cycle-window wipe via `setTargetCountSpy`/action spies. Verify the whole FILE still passes (tests 1-2 must not regress from the scaffold extraction).

- [ ] **Step 4: Commit**

```bash
git add src/tests/overlay-minimize-keeps-mounted.test.tsx
git commit -m "test: assert the odoo target list survives a minimize/restore cycle (issue 72)"
```

---

### Task 5: Manual gate + mechanism decision (NOT a code task — conductor/human step)

**Files:** none (decision procedure)

**Interfaces:**
- Consumes: Tasks 1-2's `[odoo-targets]` log lines; the spec's signature table.
- Produces: either a named mechanism (→ a follow-up fix task written test-first) or the "not reproducible" outcome (the permanent logs are the deliverable, recorded in the handoff).

- [ ] **Step 1: Reproduce with the console open**

`npm run tauri dev` → configure Odoo → open the picker → add two targets → note "Logging to (2)" → minimize → restore → click the restored pill (with the picker open through both). DevTools console, `[odoo-targets]` filter.

Expected on a HEALTHY run: `loadTargets` lines only at mount (count is StrictMode/reload-leg dependent — read the WINDOW, not the count); `targets` count lines 1→1, no 0 inside the minimize→restore window; no `clearTargets`/`purgeOtherInstances` lines; the count is intact; the proposal survives both clicks.

- [ ] **Step 2: If a signature fires — write the mechanism test FIRST**

Consult the spec's signature table (Architecture section 2). The wipe's stack frame names the caller. Write the failing test reproducing THAT trigger around a minimize/restore cycle (the Task 4 harness is the shape; the trigger — e.g. `window.dispatchEvent(new CustomEvent("newConversationStarted"))` for a `handleNewChat`-stack signature — fires around the cycle), then fix the caller, then make the test pass. Never implement the fix from the table alone: the table names MECHANISMS, the log names THE mechanism.

- [ ] **Step 3: If nothing fires — record and stop**

Rows survive, count restores, no wipe lines: the mechanism does not reproduce in this build. The permanent logs ARE the deliverable (spec's last signature row). Record the manual-gate outcome in the PR description so the reporter can be asked for their console around a recurrence.

- [ ] **Step 4: Report**

Summarize which outcome occurred (healthy / mechanism named / not reproducible) in the task report for the conductor's phase log.

---

## Self-Review (run by the plan author before commit)

1. **Spec coverage:** Task 1 = spec §1 action-layer logs (all five ops + before/outcome + rowsAffected). Task 2 = §1 hook-side count line. Task 3 = §3 secondary fix (both surfaces + both dismissal handlers + the open-state automated assertions). Task 4 = §4 regression test (all five assertion classes, App-mount primary, fallback demoted to control — the fallback is NOT planned as a separate file because the App-mount variant is executable as specified; if the executor hits the entanglement the design named, the entry-points-shape fallback in the design applies verbatim). Task 5 = §2 signature table + Testing manual gate. Edge cases 1-7 are covered by the log design itself (no dedupe, log-before) and Task 5's procedure. ✓
2. **Placeholder scan:** no TBDs; every code step has full code. The one "copy the nearest existing renderHook call" in Task 2 is bounded: the four production params are given verbatim from `completion/index.tsx:51-62`. ✓
3. **Type consistency:** `logTargetOp(op, instance, detail)` used identically in Tasks 1-2; `data-overlay-minimize-control` named identically in Tasks 3-4; `actionSpies`/`hooksBarrelStub`/`setTargetCountSpy` defined in Task 4 Step 1 and used in Step 2. ✓