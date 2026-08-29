import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const windowLabel = vi.hoisted(() => ({ value: "main" }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ label: windowLabel.value }),
}));

// The overlay does not navigate - it opens the dashboard webview. See the
// Global Constraints note.
const invoke = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

// Tauri events broadcast to every window; this is how the dashboard-window
// settings page tells the main-window picker the credentials changed.
//
// A SET per event name, not one handler per name. A Map<name, handler> lets a
// leaked second registration silently OVERWRITE the first, so the StrictMode
// double-listen bug this hook is written against would pass unnoticed. With a
// set, a leak shows up as two invocations - which is what the leak test below
// asserts on.
const listeners = vi.hoisted(
  () => new Map<string, Set<(e: unknown) => void>>()
);
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, handler: (e: unknown) => void) => {
    const set = listeners.get(name) ?? new Set();
    set.add(handler);
    listeners.set(name, set);
    return () => set.delete(handler);
  }),
  emit: vi.fn(async () => {}),
}));

function instanceChangedHandlers() {
  return listeners.get("odoo-instance-changed") ?? new Set();
}

async function emitInstanceChanged() {
  for (const handler of instanceChangedHandlers()) handler({ payload: null });
}

// The hook reports a sync failure that wrote no error marker through a toast -
// there is no other carrier for it. sonner is already mounted in this app.
const toastError = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({
  toast: { error: toastError, info: vi.fn(), warning: vi.fn(), success: vi.fn() },
}));

// `vi.hoisted`, not a bare `const`. Vitest hoists every `vi.mock` call above the
// imports, so a factory that closes over a plain outer const runs while that
// const is still in its TDZ - the file then dies at load with
// `ReferenceError: Cannot access 'action' before initialization` and reports "no
// tests" rather than failures. See src/tests/useMeetingAutoRecord.lifecycle.test.tsx:12-15.
const action = vi.hoisted(() => ({
  listContacts: vi.fn(async () => []),
  getSyncState: vi.fn(async () => null as unknown),
  setColleague: vi.fn(async () => {}),
  stampLastMeeting: vi.fn(async () => {}),
  // Task 11: the shared multi-target table, which `useOdooTarget`'s single
  // flow now persists through too - `saveTarget`/`loadTarget` queried
  // `odoo_selected_target`, a table migration 14 drops.
  loadTargets: vi.fn(async () => [] as unknown[]),
  addSelectedTarget: vi.fn(async () => ({ ok: true }) as { ok: boolean; reason?: "cap" }),
  removeSelectedTarget: vi.fn(async () => {}),
  clearTargets: vi.fn(async () => {}),
}));
vi.mock("@/lib/database/odoo-contacts.action", () => action);

const odoo = vi.hoisted(() => ({
  // SyncOutcome: `ran` distinguishes a suppressed sync from a completed one.
  runSync: vi.fn(async () => ({
    ran: true,
    changed: 0,
    fetched: 0,
    skipped: 0,
    clampSkipped: false,
  })),
  currentInstance: vi.fn(async () => "http://h:8069|odoo"),
  createOdooClient: vi.fn(() => ({ authenticate: vi.fn(), execute: vi.fn(), serverDate: null })),
  fetchOpportunities: vi.fn(async () => []),
  searchLeads: vi.fn(async () => []),
  LEAD_SEARCH_MIN_CHARS: 2,
}));
vi.mock("@/lib/odoo", async () => {
  const errors = await vi.importActual<Record<string, unknown>>("@/lib/odoo/errors");
  return { ...errors, ...odoo };
});
vi.mock("@/lib/storage/odoo-config.storage", () => ({
  loadOdooConfig: vi.fn(async () => ({ url: "http://h:8069", db: "odoo", login: "b", apiKey: "k" })),
  instanceFingerprint: vi.fn(() => "http://h:8069|odoo"),
}));

import { useOdooTarget } from "@/hooks/useOdooTarget";
import type { OdooContact, OdooOpportunity, SelectedTarget } from "@/types";

const ada: OdooContact = {
  id: 1,
  name: "Ada Lovelace",
  email: null,
  phone: null,
  companyName: null,
  parentId: 9,
  isCompany: false,
  active: true,
  writeDate: "2026-08-01 10:00:00",
  isColleague: false,
  lastMeetingAt: null,
};
const colleague: OdooContact = { ...ada, id: 2, name: "Bo Colleague", isColleague: true };

beforeEach(() => {
  // clearAllMocks keeps implementations, so every default a test overrides with
  // mockResolvedValue / mockRejectedValue is re-established here explicitly.
  vi.clearAllMocks();
  listeners.clear();
  windowLabel.value = "main";
  action.listContacts.mockResolvedValue([ada, colleague]);
  action.loadTargets.mockResolvedValue([]);
  action.getSyncState.mockResolvedValue({ last_sync_at: 1000, last_error_code: null });
  action.addSelectedTarget.mockResolvedValue({ ok: true });
  action.removeSelectedTarget.mockResolvedValue(undefined);
  action.clearTargets.mockResolvedValue(undefined);
  action.stampLastMeeting.mockResolvedValue(undefined);
  action.setColleague.mockResolvedValue(undefined);
  odoo.fetchOpportunities.mockResolvedValue([]);
  odoo.searchLeads.mockResolvedValue([]);
  odoo.currentInstance.mockResolvedValue("http://h:8069|odoo");
  odoo.runSync.mockResolvedValue({
    ran: true,
    changed: 0,
    fetched: 0,
    skipped: 0,
    clampSkipped: false,
  });
});

function mount(meetingAssistMode = false, isPickerOpen = false, setIsPickerOpen = vi.fn()) {
  return renderHook(() =>
    useOdooTarget({ meetingAssistMode, isPickerOpen, setIsPickerOpen })
  );
}

describe("the app-start sync", () => {
  it("runs in the main window", async () => {
    mount();
    await waitFor(() => expect(odoo.runSync).toHaveBeenCalledWith("app-start", false));
  });

  // Two webviews share one SQLite file; capabilities/cross-platform.json grants
  // sql access to both. Without the gate they race the same watermark row.
  //
  // The gate covers runSync ONLY. reload() runs in every window - the dashboard
  // does not sync but still renders from the cache, which is what the
  // listContacts assertion pins. An implementation that put reload() inside the
  // owner gate makes this test time out.
  it("does not sync in the dashboard window, but still loads the cache", async () => {
    windowLabel.value = "dashboard";
    mount();
    await waitFor(() => expect(action.listContacts).toHaveBeenCalled());
    expect(odoo.runSync).not.toHaveBeenCalled();
  });

  it("passes meetingMode through so decideSync can refuse mid-call", async () => {
    mount(true);
    await waitFor(() => expect(odoo.runSync).toHaveBeenCalledWith("app-start", true));
  });

  // An automatic sync fails while the user is on the OVERLAY, not the settings
  // page, so "report it on the settings page" would report it nowhere.
  //
  // `sync-failed` is the EMPTY-cache variant, so the fixture must be empty. The
  // populated-cache case is the "keeps a populated cache usable" test below,
  // and the two are deliberately different states.
  it("surfaces an automatic sync failure through the picker's cache state", async () => {
    action.listContacts.mockResolvedValue([]);
    action.getSyncState.mockResolvedValue({
      last_sync_at: null,
      last_error_code: "ODOO_UNREACHABLE",
    });
    const { result } = mount();
    await waitFor(() =>
      expect(result.current.pickerProps.cache).toEqual({
        kind: "sync-failed",
        code: "ODOO_UNREACHABLE",
      })
    );
  });

  it("reports a never-synced cache distinctly from an empty one", async () => {
    action.listContacts.mockResolvedValue([]);
    action.getSyncState.mockResolvedValue({ last_sync_at: null, last_error_code: null });
    const { result } = mount();
    await waitFor(() =>
      expect(result.current.pickerProps.cache).toEqual({ kind: "never-synced" })
    );
  });

  // ODOO_NOT_CONFIGURED is the first thing runSync can throw and the state most
  // users are in on day one. Reported as "never synced" it reads as a broken
  // sync and sends them to a Refresh button that can only fail again.
  it("reports an unconfigured Odoo as not-configured, not as never-synced", async () => {
    const { OdooError } = await vi.importActual<typeof import("@/lib/odoo/errors")>(
      "@/lib/odoo/errors"
    );
    odoo.runSync.mockRejectedValue(
      new OdooError("ODOO_NOT_CONFIGURED", "Odoo is not set up yet", {})
    );
    action.listContacts.mockResolvedValue([]);
    const { result } = mount();
    await waitFor(() =>
      expect(result.current.pickerProps.cache).toEqual({ kind: "not-configured" })
    );
  });

  // Another window syncing is a normal outcome. Painting the cache red for it
  // tells the user Odoo is broken when nothing is wrong - and the contacts
  // already in the cache are still perfectly usable.
  it("leaves the cache alone when another window holds the sync claim", async () => {
    const { OdooError } = await vi.importActual<typeof import("@/lib/odoo/errors")>(
      "@/lib/odoo/errors"
    );
    odoo.runSync.mockRejectedValue(new OdooError("ODOO_SYNC_BUSY", "already running", {}));
    action.getSyncState.mockResolvedValue({ last_sync_at: 1000, last_error_code: null });
    const { result } = mount();
    await waitFor(() =>
      expect(result.current.pickerProps.cache).toEqual({
        kind: "ready",
        contacts: [ada, colleague],
        lastError: null,
      })
    );
  });

  // ODOO_NOT_CONFIGURED is thrown by currentInstance() -> requireOdooConfig(),
  // which the mount effect calls BEFORE runSync. A triage that only wraps
  // runSync never sees it: the real rejection escapes the effect uncaught and
  // the picker sits on its initial never-synced. BOTH mocks reject here because
  // in production both read the same stored config - a fixture where only
  // runSync rejects is a state production cannot produce.
  it("reports an unconfigured Odoo even though the instance resolves first", async () => {
    const { OdooError } = await vi.importActual<typeof import("@/lib/odoo/errors")>(
      "@/lib/odoo/errors"
    );
    const notConfigured = () => new OdooError("ODOO_NOT_CONFIGURED", "not set up", {});
    odoo.currentInstance.mockRejectedValue(notConfigured());
    odoo.runSync.mockRejectedValue(notConfigured());
    const { result } = mount();
    await waitFor(() =>
      expect(result.current.pickerProps.cache).toEqual({ kind: "not-configured" })
    );
  });

  // A failed sync must not HIDE a cache that already has contacts in it.
  // last_error_code persists until a run completes, so a laptop that is offline
  // at every app start would otherwise be locked out of a perfectly good local
  // list - the same reasoning that makes ODOO_SYNC_BUSY leave the cache alone.
  it("keeps a populated cache usable when the last sync failed", async () => {
    action.getSyncState.mockResolvedValue({
      last_sync_at: 1000,
      last_error_code: "ODOO_UNREACHABLE",
    });
    const { result } = mount();
    await waitFor(() =>
      expect(result.current.pickerProps.cache).toEqual({
        kind: "ready",
        contacts: [ada, colleague],
        lastError: "ODOO_UNREACHABLE",
      })
    );
  });

  // A failure raised BEFORE syncContacts writes no last_error_code at all, so
  // reload() shows the stale cache and the user never learns syncing is dead.
  // The toast is the only carrier for that case.
  it("surfaces a sync failure that wrote no error marker", async () => {
    const { OdooError } = await vi.importActual<typeof import("@/lib/odoo/errors")>(
      "@/lib/odoo/errors"
    );
    const { setOdooRedactor } = await vi.importActual<typeof import("@/lib/odoo/redactor")>(
      "@/lib/odoo/redactor"
    );
    // ARMED on purpose. Unarmed, reportOdooError falls back to
    // `message === code` and this assertion passes for an implementation that
    // toasts only `report.message` - which in production, where the redactor IS
    // armed, would show "bad blob" and no code at all.
    setOdooRedactor(["a-secret"]);
    odoo.runSync.mockRejectedValue(new OdooError("ODOO_INTERNAL", "bad blob", {}));
    action.getSyncState.mockResolvedValue({ last_sync_at: 1000, last_error_code: null });
    mount();
    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(JSON.stringify(toastError.mock.calls[0])).toContain("ODOO_INTERNAL");
  });

  // Zero contacts after a COMPLETED run is an empty Odoo, not an absent sync.
  // Reporting it as never-synced would be wrong forever - it is the state
  // Task 6's "stores NULL, never ''" test creates.
  it("treats a completed sync that returned nothing as ready, not never-synced", async () => {
    action.listContacts.mockResolvedValue([]);
    action.getSyncState.mockResolvedValue({ last_sync_at: 1000, last_error_code: null });
    const { result } = mount();
    await waitFor(() =>
      expect(result.current.pickerProps.cache).toEqual({
        kind: "ready",
        contacts: [],
        lastError: null,
      })
    );
  });

  // reload() is called from the mount effect's CATCH branches, which are
  // outside any try. A DB failure there would escape as an unhandled rejection.
  it("reports a cache read failure instead of rejecting out of the effect", async () => {
    action.listContacts.mockRejectedValue(new Error("database is locked"));
    mount();
    await waitFor(() => expect(toastError).toHaveBeenCalled());
  });

  // A sync that decideSync refused is not a sync that completed. The hook must
  // read `ran`, not treat a zeroed result as a successful pull.
  it("does not treat a refused sync as a completed one", async () => {
    odoo.runSync.mockResolvedValue({ ran: false, reason: "skip-in-meeting" });
    action.listContacts.mockResolvedValue([]);
    action.getSyncState.mockResolvedValue({ last_sync_at: null, last_error_code: null });
    const { result } = mount();
    await waitFor(() =>
      expect(result.current.pickerProps.cache).toEqual({ kind: "never-synced" })
    );
  });

  // The overlay is a 600x54 undecorated card; /odoo renders a full sidebar page
  // in the SEPARATE dashboard webview. Navigating THIS window would replace the
  // meeting bar with a settings page inside 54 pixels, with no route back -
  // useMenuItems has no "/" entry.
  it("opens the dashboard webview rather than navigating the overlay", async () => {
    const { result } = mount();
    await waitFor(() => expect(action.listContacts).toHaveBeenCalled());
    await act(async () => {
      result.current.pickerProps.onOpenSettings();
    });
    expect(invoke).toHaveBeenCalledWith("open_dashboard");
  });
});

describe("persisting a selection", () => {
  // instanceRef is filled by the async mount effect, and the picker is usable
  // before it resolves. Writing a null instance violates
  // odoo_selected_targets.instance TEXT NOT NULL - thrown out of a click
  // handler, i.e. an unhandled rejection.
  it("never writes a null instance, even mid-rehydrate", async () => {
    let releaseInstance: (v: string) => void = () => {};
    odoo.currentInstance.mockReturnValue(
      new Promise<string>((resolve) => {
        releaseInstance = resolve;
      })
    );
    const { result } = mount();
    await act(async () => {
      result.current.pickerProps.onSelect(ada);
    });
    await act(async () => {
      releaseInstance("http://h:8069|odoo");
    });
    await waitFor(() => expect(action.addSelectedTarget).toHaveBeenCalled());
    // instance is the FIRST positional arg of addSelectedTarget(instance, t,
    // conversationId, at) - not an object property, unlike the old saveTarget.
    expect(action.addSelectedTarget.mock.calls[0][0]).toBe("http://h:8069|odoo");
  });

  // A rejected addSelectedTarget with the selection already in state leaves
  // targetRef claiming something that was never written - so the next
  // remount loses it silently, which is exactly what the persisted row
  // exists to stop.
  it("does not leave targetRef claiming an unpersisted selection", async () => {
    action.addSelectedTarget.mockRejectedValue(new Error("database is locked"));
    const { result } = mount();
    await waitFor(() => expect(action.listContacts).toHaveBeenCalled());
    await act(async () => {
      result.current.pickerProps.onSelect(ada);
    });
    await waitFor(() => expect(result.current.targetRef.current).toBeNull());
    expect(toastError).toHaveBeenCalled();
  });

  // The recency stamp is cosmetic. Awaiting it BEFORE the commit means a locked
  // DB takes down the load-bearing write for the sake of an ordering hint.
  it("still commits when the recency stamp fails", async () => {
    action.stampLastMeeting.mockRejectedValue(new Error("database is locked"));
    const { result } = mount();
    await waitFor(() => expect(action.listContacts).toHaveBeenCalled());
    await act(async () => {
      result.current.pickerProps.onSelect(ada);
    });
    expect(result.current.targetRef.current).toEqual({ contactId: 1, leadId: null, leadName: null });
  });

  // Added during self-review: pin the exact scenario the hook's own doc
  // comment on commit()'s rejection path describes, and which no other test
  // here exercises. Pick Ada (token 1, addSelectedTarget hangs); pick Bea
  // (token 2, addSelectedTarget resolves - the row now names Bea); THEN
  // Ada's write rejects. Without re-checking the token in the rejection
  // path, the rollback would restore `previous` (null, captured before
  // Ada's commit) over Bea's already-persisted selection - the picker would
  // show nothing chosen while SQLite still holds Bea, silently
  // reintroducing the unassigned-meeting failure through the error handling
  // meant to prevent it.
  it("does not let a stale commit's rejection roll back a newer, already-persisted selection", async () => {
    let rejectAdaSave: (err: unknown) => void = () => {};
    action.addSelectedTarget.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectAdaSave = reject;
        })
    );
    const { result } = mount();
    await waitFor(() => expect(action.listContacts).toHaveBeenCalled());

    await act(async () => {
      result.current.pickerProps.onSelect(ada); // token 1, addSelectedTarget pending
    });
    await act(async () => {
      await result.current.pickerProps.onSelect(colleague); // token 2, addSelectedTarget resolves
    });
    expect(result.current.targetRef.current).toEqual({ contactId: 2, leadId: null, leadName: null });

    await act(async () => {
      rejectAdaSave(new Error("database is locked"));
    });

    expect(result.current.targetRef.current).toEqual({ contactId: 2, leadId: null, leadName: null });
  });
});

describe("the opportunity panel", () => {
  // Contact A's deals must not sit under contact B. For a COLLEAGUE - which
  // skips the lookup entirely - stale deals would otherwise stay forever.
  it("clears the previous contact's opportunities before the next selection", async () => {
    odoo.fetchOpportunities.mockResolvedValue([
      {
        id: 5,
        name: "Heat pump",
        type: "opportunity",
        stageName: null,
        partnerId: 1,
        partnerName: "Ada",
        contactName: null,
        email: null,
      },
    ]);
    const { result } = mount();
    await waitFor(() => expect(action.listContacts).toHaveBeenCalled());
    await act(async () => {
      await result.current.pickerProps.onSelect(ada);
    });
    expect(result.current.pickerProps.opportunities).toHaveLength(1);

    await act(async () => {
      await result.current.pickerProps.onSelect(colleague);
    });
    expect(result.current.pickerProps.opportunities).toBeNull();
    expect(result.current.pickerProps.isLookingUp).toBe(false);
  });

  // Only the CURRENT-token branch may lower isLookingUp. A stale client lookup
  // followed by a colleague otherwise leaves a spinner running forever.
  it("leaves no spinner behind when a lookup is superseded by a colleague", async () => {
    odoo.fetchOpportunities.mockReturnValue(new Promise(() => {}));
    const { result } = mount();
    await waitFor(() => expect(action.listContacts).toHaveBeenCalled());
    await act(async () => {
      result.current.pickerProps.onSelect(ada);
    });
    expect(result.current.pickerProps.isLookingUp).toBe(true);
    await act(async () => {
      result.current.pickerProps.onSelect(colleague);
    });
    expect(result.current.pickerProps.isLookingUp).toBe(false);
  });

  // Retry re-runs the lookup for the contact the HOOK remembers, and does not
  // touch the target. The component holds only primitives and could not hand
  // back an OdooContact even if asked.
  it("retries the lookup without re-committing the target", async () => {
    odoo.fetchOpportunities.mockRejectedValueOnce(new Error("down"));
    const { result } = mount();
    await waitFor(() => expect(action.listContacts).toHaveBeenCalled());
    await act(async () => {
      await result.current.pickerProps.onSelect(ada);
    });
    const savesAfterSelect = action.addSelectedTarget.mock.calls.length;

    odoo.fetchOpportunities.mockResolvedValue([]);
    await act(async () => {
      await result.current.pickerProps.onRetryOpportunities();
    });
    expect(odoo.fetchOpportunities).toHaveBeenCalledTimes(2);
    expect(action.addSelectedTarget.mock.calls).toHaveLength(savesAfterSelect);
  });

  // Task 11's `opportunities === null` branch — the one that renders the Look
  // up button — is reachable with NO prior onSelect: it is the normal state of
  // a target rehydrated after a <Completion /> remount. That is exactly when
  // the hook's contactRef is empty, so retry must fall back to the cache or the
  // button is dead on the one path it was added for.
  it("retries for a rehydrated target that was never selected in this session", async () => {
    action.loadTargets.mockResolvedValue([{ model: "res.partner", resId: 1, name: "Ada Lovelace" }]);
    const { result } = mount();
    await waitFor(() => expect(action.listContacts).toHaveBeenCalled());
    expect(result.current.pickerProps.opportunities).toBeNull();

    await act(async () => {
      await result.current.pickerProps.onRetryOpportunities();
    });
    expect(odoo.fetchOpportunities).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: 1, parentId: ada.parentId })
    );
  });
});

describe("colleague marks", () => {
  // ContactPicker renders exclusively from props.cache. A patch applied to any
  // other array leaves the star where it was - the exact failure the optimistic
  // patch exists to prevent.
  it("shows a new colleague mark in the cache the picker renders from", async () => {
    const { result } = mount();
    await waitFor(() => expect(action.listContacts).toHaveBeenCalled());
    await act(async () => {
      await result.current.pickerProps.onToggleColleague(ada);
    });
    const { cache } = result.current.pickerProps;
    expect(cache.kind).toBe("ready");
    expect(
      cache.kind === "ready" && cache.contacts.find((c) => c.id === 1)?.isColleague
    ).toBe(true);
  });
});

describe("cross-window credential changes", () => {
  // The settings page lives in the dashboard window; this hook lives in main.
  // Without the listener, first-time setup leaves the picker on
  // "not configured" - a state that deliberately offers NO Refresh - until the
  // app is restarted.
  it("re-resolves and reloads when another window changes the instance", async () => {
    const { OdooError } = await vi.importActual<typeof import("@/lib/odoo/errors")>(
      "@/lib/odoo/errors"
    );
    // ONLY currentInstance rejects. The mount effect resolves the instance
    // BEFORE runSync, so a queued runSync rejection is never consumed at mount
    // and would still be armed when the event handler calls runSync("refresh") -
    // re-triaging straight back to not-configured, and the waitFor below could
    // never settle. Rejecting currentInstance alone reproduces the day-one
    // state exactly.
    odoo.currentInstance.mockRejectedValueOnce(
      new OdooError("ODOO_NOT_CONFIGURED", "not set up", {})
    );
    const { result } = mount();
    await waitFor(() =>
      expect(result.current.pickerProps.cache).toEqual({ kind: "not-configured" })
    );

    await act(async () => {
      await emitInstanceChanged();
    });
    await waitFor(() =>
      expect(result.current.pickerProps.cache).toMatchObject({ kind: "ready" })
    );
  });

  // The listener must not leak. listen() returns a PROMISE of the unlisten fn,
  // so under StrictMode both mounts resolve after the first cleanup ran - and
  // without a `cancelled` flag the second handler stays registered forever,
  // firing runSync and setCache against a dead hook on every later event.
  it("registers exactly one handler and unsubscribes on unmount", async () => {
    const { unmount } = mount();
    await waitFor(() => expect(action.listContacts).toHaveBeenCalled());
    expect(instanceChangedHandlers().size).toBe(1);
    unmount();
    await waitFor(() => expect(instanceChangedHandlers().size).toBe(0));
  });

  // A save that leaves the config still unusable is the routine case. The
  // handler must triage it the same way the mount effect does, not let the
  // rejection escape as an unhandled rejection.
  // Finding 2: purgeOtherInstances deletes the DB row for the OLD instance's
  // target as part of the sync this handler triggers, but nothing previously
  // cleared the in-memory target to match - so `target`/`targetRef` kept
  // naming a contact from the database that is no longer the active one. A
  // subsequent onSelectOpportunity would then commit that stale contactId
  // under the NEW instance's fingerprint, writing a poisoned row.
  it("clears the in-memory target when the instance changes, matching the DB purge", async () => {
    action.loadTargets.mockResolvedValue([{ model: "res.partner", resId: 1, name: null }]);
    const { result } = mount();
    await waitFor(() =>
      expect(result.current.targetRef.current).toEqual({ contactId: 1, leadId: null, leadName: null })
    );

    action.loadTargets.mockClear();
    action.loadTargets.mockResolvedValue([]);
    await act(async () => {
      await emitInstanceChanged();
    });

    expect(result.current.targetRef.current).toBeNull();
    // Re-resolved for the NEW instance, not just cleared and left stale.
    expect(action.loadTargets).toHaveBeenCalled();
  });

  it("triages a still-unconfigured instance rather than rejecting", async () => {
    const { OdooError } = await vi.importActual<typeof import("@/lib/odoo/errors")>(
      "@/lib/odoo/errors"
    );
    const { result } = mount();
    await waitFor(() => expect(action.listContacts).toHaveBeenCalled());

    odoo.currentInstance.mockRejectedValue(
      new OdooError("ODOO_NOT_CONFIGURED", "still blank", {})
    );
    await act(async () => {
      await emitInstanceChanged();
    });
    await waitFor(() =>
      expect(result.current.pickerProps.cache).toEqual({ kind: "not-configured" })
    );
  });
});

describe("selecting", () => {
  it("commits { contactId, leadId: null } immediately, before the lookup resolves", async () => {
    let resolveLookup: (v: unknown) => void = () => {};
    odoo.fetchOpportunities.mockReturnValue(
      new Promise((resolve) => {
        resolveLookup = resolve;
      })
    );
    const { result } = mount();
    await waitFor(() => expect(action.listContacts).toHaveBeenCalled());

    await act(async () => {
      result.current.pickerProps.onSelect(ada);
    });

    // The user picked a person. If an unmount or a meeting-ended landed here,
    // waiting for the second click would file the meeting as unassigned.
    expect(result.current.targetRef.current).toEqual({ contactId: 1, leadId: null, leadName: null });
    expect(action.addSelectedTarget).toHaveBeenCalledWith(
      "http://h:8069|odoo",
      { model: "res.partner", resId: 1, name: null },
      null,
      expect.any(Number)
    );
    await act(async () => resolveLookup([]));
  });

  it("stamps recency at selection time, so ordering works before anything logs", async () => {
    const { result } = mount();
    await waitFor(() => expect(action.listContacts).toHaveBeenCalled());
    await act(async () => {
      result.current.pickerProps.onSelect(ada);
    });
    expect(action.stampLastMeeting).toHaveBeenCalledWith(
      "http://h:8069|odoo",
      1,
      expect.any(Number)
    );
  });

  it("skips the crm.lead lookup entirely for a colleague", async () => {
    const { result } = mount();
    await waitFor(() => expect(action.listContacts).toHaveBeenCalled());
    await act(async () => {
      result.current.pickerProps.onSelect(colleague);
    });
    expect(odoo.fetchOpportunities).not.toHaveBeenCalled();
    expect(result.current.targetRef.current).toEqual({ contactId: 2, leadId: null, leadName: null });
  });

  // A colleague selection leaves opportunities === null (onSelect never looks
  // up their deals), which is the exact state ContactPicker's "Look up"
  // button renders for - it carries no isColleague signal of its own. Without
  // a guard in onRetryOpportunities itself, that button silently reaches the
  // crm.lead lookup the design states colleagues skip entirely.
  it("does not run the crm.lead lookup for a colleague reached through retry", async () => {
    const { result } = mount();
    await waitFor(() => expect(action.listContacts).toHaveBeenCalled());
    await act(async () => {
      result.current.pickerProps.onSelect(colleague);
    });
    expect(result.current.pickerProps.opportunities).toBeNull();

    await act(async () => {
      await result.current.pickerProps.onRetryOpportunities();
    });
    expect(odoo.fetchOpportunities).not.toHaveBeenCalled();
  });

  it("searches the parent company as well as the contact", async () => {
    const { result } = mount();
    await waitFor(() => expect(action.listContacts).toHaveBeenCalled());
    await act(async () => {
      result.current.pickerProps.onSelect(ada);
    });
    await waitFor(() =>
      expect(odoo.fetchOpportunities).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ id: 1, parentId: 9 })
      )
    );
  });

  // Select A, then B; A's slower response lands LAST. Without a token the
  // target names two different customers - invisible in slice 1, a wrong-record
  // post in slice 2.
  it("discards a lookup whose selection has been superseded", async () => {
    const deferred: ((v: unknown) => void)[] = [];
    odoo.fetchOpportunities.mockImplementation(
      () => new Promise((resolve) => deferred.push(resolve))
    );
    const { result } = mount();
    await waitFor(() => expect(action.listContacts).toHaveBeenCalled());

    await act(async () => {
      result.current.pickerProps.onSelect(ada);
    });
    await act(async () => {
      result.current.pickerProps.onSelect({ ...ada, id: 3, name: "Bea" });
    });

    // A resolves last, with A's opportunity.
    await act(async () => {
      deferred[1]?.([]);
      deferred[0]?.([
        {
          id: 99,
          name: "A's deal",
          type: "opportunity",
          stageName: null,
          partnerId: 1,
          partnerName: "Ada",
          contactName: null,
          email: null,
        },
      ]);
    });

    expect(result.current.targetRef.current?.contactId).toBe(3);
    expect(result.current.pickerProps.opportunities).toEqual([]);
  });

  it("surfaces a failed lookup as a code, never as 'no opportunities'", async () => {
    const { odooError } = await import("@/lib/odoo/errors");
    odoo.fetchOpportunities.mockRejectedValue(odooError("ODOO_UNREACHABLE", "down"));
    const { result } = mount();
    await waitFor(() => expect(action.listContacts).toHaveBeenCalled());
    await act(async () => {
      result.current.pickerProps.onSelect(ada);
    });
    await waitFor(() =>
      expect(result.current.pickerProps.opportunityError).toBe("ODOO_UNREACHABLE")
    );
    // Still usable: the partner record is a valid target.
    expect(result.current.targetRef.current).toEqual({ contactId: 1, leadId: null, leadName: null });
  });

  it("writes contactId and leadId together when an opportunity is picked", async () => {
    const { result } = mount();
    await waitFor(() => expect(action.listContacts).toHaveBeenCalled());
    await act(async () => {
      result.current.pickerProps.onSelect(ada);
    });
    await act(async () => {
      result.current.pickerProps.onSelectOpportunity(7);
    });
    expect(result.current.targetRef.current).toEqual({
      contactId: 1,
      leadId: 7,
      // Captured from the list on screen. `opportunities` is in-memory state
      // that a <Completion /> remount destroys, so this is the last moment
      // anything can name the record - and the fixture's lookup returned [],
      // which is exactly the case where there is nothing to name it from.
      leadName: null,
    });
    expect(action.addSelectedTarget).toHaveBeenLastCalledWith(
      "http://h:8069|odoo",
      { model: "crm.lead", resId: 7, name: null },
      null,
      expect.any(Number)
    );
  });
});

describe("rehydrate", () => {
  // <Completion /> can unmount mid-call: the setup gate at
  // src/pages/app/index.tsx:84 is reactive, not latched.
  //
  // The row rehydrates from `odoo_selected_targets` now, coalesced to at
  // most one row per selection (Task 11) - a lead-only row never recorded
  // the partner it was picked under, so a rehydrated `crm.lead` target
  // always comes back with `contactId: null`. That loss is the same one
  // migration 14's own backfill already accepts.
  it("restores the target from the most recent row on mount", async () => {
    action.loadTargets.mockResolvedValue([{ model: "crm.lead", resId: 8, name: null }]);
    const { result } = mount();
    await waitFor(() =>
      expect(result.current.targetRef.current).toEqual({ contactId: null, leadId: 8, leadName: null })
    );
  });

  // A mid-call remount is exactly when the user is likeliest to re-pick.
  it("does not clobber a selection committed during the rehydrate round trip", async () => {
    let resolveLoad: (v: unknown) => void = () => {};
    action.loadTargets.mockReturnValue(
      new Promise((resolve) => {
        resolveLoad = resolve;
      })
    );
    const { result } = mount();
    await act(async () => {
      result.current.pickerProps.onSelect(colleague);
    });
    await act(async () => resolveLoad([{ model: "crm.lead", resId: 8, name: null }]));
    expect(result.current.targetRef.current).toEqual({ contactId: 2, leadId: null, leadName: null });
  });
});

describe("the ref mirror", () => {
  // Slice 1 registers NO meeting-ended listener - there is nothing to capture,
  // so this asserts the ref directly. The listener-capture assertion belongs to
  // slice 2, whose listener is registered once per window lifetime and would
  // otherwise close over the mount-time value.
  it("holds the current target on a later macrotask, not the mount-time value", async () => {
    const { result } = mount();
    await waitFor(() => expect(action.listContacts).toHaveBeenCalled());
    expect(result.current.targetRef.current).toBeNull();
    await act(async () => {
      result.current.pickerProps.onSelect(colleague);
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(result.current.targetRef.current).toEqual({ contactId: 2, leadId: null, leadName: null });
  });
});

describe("a sync that archives the selected partner", () => {
  it("clears the selection rather than leaving an unselectable target", async () => {
    const { result } = mount();
    await waitFor(() => expect(action.listContacts).toHaveBeenCalled());
    await act(async () => {
      result.current.pickerProps.onSelect(ada);
    });

    action.listContacts.mockResolvedValue([{ ...ada, active: false }, colleague]);
    await act(async () => {
      await result.current.pickerProps.onRefresh();
    });

    await waitFor(() => expect(result.current.targetRef.current).toBeNull());
    // The single flow's coalesced row is removed individually, not a full
    // clearTargets - Task 11's per-target archival rule.
    expect(action.removeSelectedTarget).toHaveBeenCalledWith(
      "http://h:8069|odoo",
      "res.partner",
      1
    );
  });
});

// Finding 3: the third DB-deletion trigger the spec names. Emitted by
// useCompletion's startNewConversation, which every "start a new chat" path
// (the newConversation request event, a deleted-conversation fallback, and
// Input.tsx's keepEngaged close button) funnels through.
describe("starting a new chat", () => {
  it("clears both the in-memory target and the persisted rows", async () => {
    action.loadTargets.mockResolvedValue([{ model: "res.partner", resId: 1, name: null }]);
    const { result } = mount();
    await waitFor(() =>
      expect(result.current.targetRef.current).toEqual({ contactId: 1, leadId: null, leadName: null })
    );

    await act(async () => {
      window.dispatchEvent(new CustomEvent("newConversationStarted"));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.targetRef.current).toBeNull();
    expect(result.current.targets).toEqual([]);
    expect(action.clearTargets).toHaveBeenCalledWith("http://h:8069|odoo");
  });
});

// Finding 1: ContactPicker's open state must be observable by useCompletion's
// resize effect (the overlay window is 600x54 and grows only through that
// effect). This hook does not own the state - it is threaded through from
// the caller, exactly like `meetingAssistMode` already is, and handed
// straight to ContactPicker via pickerProps.
describe("the picker's open state", () => {
  it("passes the caller's isPickerOpen/setIsPickerOpen straight through to pickerProps", async () => {
    const setIsPickerOpen = vi.fn();
    const { result, rerender } = renderHook(
      ({ open }) => useOdooTarget({ meetingAssistMode: false, isPickerOpen: open, setIsPickerOpen }),
      { initialProps: { open: false } }
    );
    await waitFor(() => expect(action.listContacts).toHaveBeenCalled());
    expect(result.current.pickerProps.open).toBe(false);

    rerender({ open: true });
    expect(result.current.pickerProps.open).toBe(true);

    result.current.pickerProps.onOpenChange(true);
    expect(setIsPickerOpen).toHaveBeenCalledWith(true);
  });
});

/**
 * A crm.lead reached WITHOUT a contact.
 *
 * The contact list is an offline filter over synced res.partner rows. Odoo
 * default for an unconverted lead is free-text contact details and no partner
 * at all, so such a record is not in that list and never will be - this search
 * is the only way to it.
 */
describe("the lead search", () => {
  const found = {
    id: 90,
    name: "Partnership with ECS",
    type: "lead" as const,
    stageName: "New",
    partnerId: null,
    partnerName: null,
    contactName: "Christian Carron",
    email: "cc@ecs.example",
  };

  it("searches, and holds the results for the picker", async () => {
    odoo.searchLeads.mockResolvedValue([found]);
    const { result } = mount();
    await waitFor(() => expect(action.listContacts).toHaveBeenCalled());

    await act(async () => {
      await result.current.pickerProps.onSearchLeads("carron");
    });
    expect(odoo.searchLeads).toHaveBeenCalledWith(expect.anything(), "carron");
    expect(result.current.pickerProps.leadResults).toEqual([found]);
    expect(result.current.pickerProps.leadSearchError).toBeNull();
  });

  // `null` is "nothing asked for yet"; `[]` says "none found" for a query
  // nobody ran. The picker renders them differently and must be able to.
  it("clears back to 'not searched' below the minimum, without a call", async () => {
    const { result } = mount();
    await waitFor(() => expect(action.listContacts).toHaveBeenCalled());
    await act(async () => {
      await result.current.pickerProps.onSearchLeads("c");
    });
    expect(odoo.searchLeads).not.toHaveBeenCalled();
    expect(result.current.pickerProps.leadResults).toBeNull();
  });

  // Same reasoning as the opportunity lookup's own token: type "carr", then
  // "carron"; the slower FIRST response landing last would paint results for a
  // query no longer on screen.
  it("discards a search that a later search has superseded", async () => {
    const gates: ((v: unknown) => void)[] = [];
    odoo.searchLeads.mockImplementation(
      () => new Promise((resolve) => gates.push(resolve))
    );
    const { result } = mount();
    await waitFor(() => expect(action.listContacts).toHaveBeenCalled());

    await act(async () => {
      void result.current.pickerProps.onSearchLeads("carr");
      void result.current.pickerProps.onSearchLeads("carron");
    });
    await act(async () => {
      gates[1]?.([found]);
      gates[0]?.([{ ...found, id: 91, name: "Stale" }]);
    });

    expect(result.current.pickerProps.leadResults).toEqual([found]);
  });

  it("reports a failed search as a code, and not as an empty result", async () => {
    const { odooError } = await import("@/lib/odoo/errors");
    odoo.searchLeads.mockRejectedValue(odooError("ODOO_UNREACHABLE", "down"));
    const { result } = mount();
    await waitFor(() => expect(action.listContacts).toHaveBeenCalled());
    await act(async () => {
      await result.current.pickerProps.onSearchLeads("carron");
    });
    expect(result.current.pickerProps.leadSearchError).toBe("ODOO_UNREACHABLE");
    expect(result.current.pickerProps.leadResults).toBeNull();
  });

  // THE POINT OF THE WHOLE PATH. contactId null is a legitimate target: the
  // push resolves a non-null lead_id to crm.lead and never reads contact_id.
  it("commits a lead with no contact behind it, name and all", async () => {
    const { result } = mount();
    await waitFor(() => expect(action.listContacts).toHaveBeenCalled());
    await act(async () => {
      await result.current.pickerProps.onSelectLead(found);
    });

    expect(result.current.targetRef.current).toEqual({
      contactId: null,
      leadId: 90,
      // Persisted, because nothing else can name it: a lead is not in the
      // contact cache by definition, and the in-memory list does not survive a
      // <Completion /> remount.
      leadName: "Partnership with ECS",
    });
    expect(action.addSelectedTarget).toHaveBeenLastCalledWith(
      "http://h:8069|odoo",
      { model: "crm.lead", resId: 90, name: "Partnership with ECS" },
      null,
      expect.any(Number)
    );
  });

  // Free, and the queue page can name the row from it.
  it("keeps the lead's own partner as the contact when it has one", async () => {
    const { result } = mount();
    await waitFor(() => expect(action.listContacts).toHaveBeenCalled());
    await act(async () => {
      await result.current.pickerProps.onSelectLead({ ...found, partnerId: 4 });
    });
    expect(result.current.targetRef.current).toMatchObject({ contactId: 4, leadId: 90 });
  });

  // Left set, `onRetryOpportunities` would fetch the PREVIOUS contact's deals
  // and paint them under a lead the user reached by a different route.
  it("leaves no contact behind for a retry to look deals up against", async () => {
    const { result } = mount();
    await waitFor(() => expect(action.listContacts).toHaveBeenCalled());
    await act(async () => {
      result.current.pickerProps.onSelect(ada);
    });
    odoo.fetchOpportunities.mockClear();

    await act(async () => {
      await result.current.pickerProps.onSelectLead(found);
    });
    await act(async () => {
      await result.current.pickerProps.onRetryOpportunities();
    });
    expect(odoo.fetchOpportunities).not.toHaveBeenCalled();
    expect(result.current.pickerProps.opportunities).toBeNull();
  });
});

/**
 * Task 11: the list of targets and the per-contact "Logging to" disclosure
 * cache, both new hook-return fields - `targets`, `targetCount`, `addTarget`,
 * `removeTarget`, `expandContact`, `opportunitiesFor`, `errorFor`,
 * `retryOpportunitiesFor`. Nothing here touches `pickerProps`/`targetRef`;
 * that suite above is untouched except for the persistence-mock retargeting.
 */
describe("Task 11: the multi-target list", () => {
  const christian: OdooContact = { ...ada, id: 1, name: "Christian Carron" };
  const bentley: OdooContact = { ...ada, id: 2, name: "Bentley AS" };
  const colleagueContact: OdooContact = {
    ...ada,
    id: 99,
    name: "Colleague",
    isColleague: true,
  };
  const COLLEAGUE_ID = colleagueContact.id;

  const opts = { meetingAssistMode: false, isPickerOpen: false, setIsPickerOpen: vi.fn() };

  function opp(id: number, name: string): OdooOpportunity {
    return {
      id,
      name,
      type: "opportunity",
      stageName: null,
      partnerId: null,
      partnerName: null,
      contactName: null,
      email: null,
    };
  }

  // Keyed by the CONTACT id fetchOpportunities was called for, so two
  // concurrent lookups can be settled independently and out of order.
  let pending: Map<number, { resolve: (v: OdooOpportunity[]) => void; reject: (e: unknown) => void }>;

  beforeEach(() => {
    action.listContacts.mockResolvedValue([christian, bentley, colleagueContact]);
    pending = new Map();
    odoo.fetchOpportunities.mockImplementation(
      (_client: unknown, contact: OdooContact) =>
        new Promise<OdooOpportunity[]>((resolve, reject) => {
          pending.set(contact.id, { resolve, reject });
        })
    );
  });

  async function resolveOpportunities(contactId: number, rows: OdooOpportunity[]) {
    const deferred = pending.get(contactId);
    if (!deferred) throw new Error(`no pending fetchOpportunities call for contact ${contactId}`);
    pending.delete(contactId);
    await act(async () => {
      deferred.resolve(rows);
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  async function rejectOpportunities(contactId: number, err: unknown) {
    const deferred = pending.get(contactId);
    if (!deferred) throw new Error(`no pending fetchOpportunities call for contact ${contactId}`);
    pending.delete(contactId);
    await act(async () => {
      deferred.reject(err);
      await Promise.resolve().catch(() => {});
      await Promise.resolve();
    });
  }

  async function addTargets(
    result: { current: ReturnType<typeof useOdooTarget> },
    items: SelectedTarget[]
  ) {
    for (const t of items) {
      await act(async () => {
        await result.current.addTarget(t);
      });
    }
  }

  // Deviates from a literal transcription of the brief's snippet, which calls
  // `archiveContactAndReload(1)` with no `result` argument: this helper needs
  // a specific hook instance to drive `onRefresh` on, exactly like
  // `addTargets` above already takes one.
  async function archiveContactAndReload(
    result: { current: ReturnType<typeof useOdooTarget> },
    contactId: number
  ) {
    action.listContacts.mockResolvedValue(
      [christian, bentley, colleagueContact].map((c) =>
        c.id === contactId ? { ...c, active: false } : c
      )
    );
    await act(async () => {
      await result.current.pickerProps.onRefresh();
    });
  }

  /**
   * Test-only stand-in for the "Logging to" row Task 12 builds. Renders
   * Christian's expand control UNCONDITIONALLY, decoupled from the async
   * cache load - `expandContact` itself still needs that cache populated to
   * find the contact, which `cache-ready` below lets the test wait for
   * deterministically instead of racing userEvent's own internal timing.
   *
   * This is the render-level harness the brief's own comment calls for: a
   * ref-only version of the disclosure cache passes every hook-level
   * assertion above and still leaves this button stuck on nothing - only a
   * real render catches a `useRef` write that schedules no re-render.
   */
  function Harness() {
    const odoo = useOdooTarget(opts);
    const ready = odoo.pickerProps.cache.kind === "ready";
    const rows = odoo.opportunitiesFor(christian.id) ?? [];
    return (
      <div>
        <span data-testid="cache-ready">{String(ready)}</span>
        <button type="button" onClick={() => void odoo.expandContact(christian.id)}>
          {`expand ${christian.name}`}
        </button>
        {rows.map((o) => (
          <button key={o.id} type="button">
            {`add ${o.name}`}
          </button>
        ))}
      </div>
    );
  }

  it("hands ContactPicker a referentially stable list at zero targets", async () => {
    const { result, rerender } = renderHook(() => useOdooTarget(opts));
    const first = result.current.targets;
    // Pinned to a real, empty array up front: against a hook build that
    // dropped the `targets` field entirely, `first` would be `undefined` and
    // the `.toBe` below would pass vacuously (undefined === undefined) even
    // though nothing was actually being tested. `toEqual([])` fails that
    // build outright instead of rubber-stamping it.
    expect(first).toEqual([]);
    // Settled BEFORE asserting, not just captured before the mount effect's
    // async loadTargets([]) has a chance to run - a version that allocated a
    // fresh [] on that no-op write would only fail this once the effect has
    // actually landed.
    await waitFor(() => expect(result.current.pickerProps.cache.kind).toBe("ready"));
    rerender();
    // Object identity, not just deep equality: a version of applyTargets that
    // unconditionally called setTargets(next) on the mount effect's resolved
    // (but still-empty) array would swap in a NEW [] here, still passing
    // toEqual([]) while breaking the no-op-write guarantee this test exists
    // for. Verified this catches that exact regression by temporarily
    // simplifying applyTargets to `setTargets(next)` and re-running - the
    // test failed with "expected [] to be []" (Object.is), as intended.
    expect(result.current.targets).toBe(first);
  });

  it("re-renders the picker when a row's lookup resolves", async () => {
    render(<Harness />);
    await waitFor(() => expect(screen.getByTestId("cache-ready")).toHaveTextContent("true"));
    await userEvent.click(screen.getByRole("button", { name: /expand Christian Carron/i }));
    await resolveOpportunities(1, [opp(9, "Partnership with ECS")]);
    expect(
      await screen.findByRole("button", { name: /add Partnership with ECS/i })
    ).toBeVisible();
  });

  it("keys the deal lookup per contact, so adding a target does not strand an open row", async () => {
    const { result } = renderHook(() => useOdooTarget(opts));
    await waitFor(() => expect(result.current.pickerProps.cache.kind).toBe("ready"));
    // The async form: it flushes enough microtasks (resolveInstance,
    // getClient's loadOdooConfig) for fetchOpportunities to actually be
    // CALLED and its promise captured in `pending` - the sync form leaves
    // the call sitting before its first await, and resolveOpportunities
    // below would find nothing pending yet.
    await act(async () => {
      void result.current.expandContact(1);
    });
    await act(async () => {
      await result.current.addTarget({ model: "res.partner", resId: 2, name: "B" });
    });
    await resolveOpportunities(1, [opp(9, "Deal")]);
    expect(result.current.opportunitiesFor(1)).toHaveLength(1); // not stuck loading
  });

  it("empties the disclosure cache when the instance changes", async () => {
    const { result } = renderHook(() => useOdooTarget(opts));
    await waitFor(() => expect(result.current.pickerProps.cache.kind).toBe("ready"));
    await act(async () => {
      void result.current.expandContact(1);
    });
    await resolveOpportunities(1, [opp(9, "Deal")]);
    expect(result.current.opportunitiesFor(1)).toHaveLength(1);

    // Driven through the existing Tauri-event helper rather than widening
    // UseOdooTargetReturn with a `handleInstanceChanged` field the Interfaces
    // section does not list - the brief's literal
    // `result.current.handleInstanceChanged()` would work too, but this is
    // the minimal surface.
    await act(async () => {
      await emitInstanceChanged();
    });
    expect(result.current.opportunitiesFor(1)).toBeNull();
  });

  it("keys the lookup error per contact", async () => {
    const { result } = renderHook(() => useOdooTarget(opts));
    await waitFor(() => expect(result.current.pickerProps.cache.kind).toBe("ready"));
    await act(async () => {
      void result.current.expandContact(1);
      void result.current.expandContact(2);
    });
    await rejectOpportunities(1, new Error("boom"));
    await resolveOpportunities(2, [opp(9, "Deal")]);
    expect(result.current.errorFor(1)).not.toBeNull();
    expect(result.current.errorFor(2)).toBeNull();
  });

  it("skips the lookup for a colleague", async () => {
    const { result } = renderHook(() => useOdooTarget(opts));
    await waitFor(() => expect(result.current.pickerProps.cache.kind).toBe("ready"));
    act(() => {
      void result.current.expandContact(COLLEAGUE_ID);
    });
    expect(odoo.fetchOpportunities).not.toHaveBeenCalled();
  });

  it("drops only the archived contact's target, not the selection", async () => {
    const { result } = renderHook(() => useOdooTarget(opts));
    await addTargets(result, [
      { model: "res.partner", resId: 1, name: "A" },
      { model: "res.partner", resId: 2, name: "B" },
    ]);
    await archiveContactAndReload(result, 1);
    expect(result.current.targets.map((t) => t.resId)).toEqual([2]);
  });

  it("refuses a sixth target and surfaces the cap", async () => {
    const { result } = renderHook(() => useOdooTarget(opts));
    await addTargets(
      result,
      [1, 2, 3, 4, 5].map((resId) => ({
        model: "res.partner" as const,
        resId,
        name: `C${resId}`,
      }))
    );
    action.addSelectedTarget.mockResolvedValueOnce({ ok: false, reason: "cap" });
    await act(async () => {
      const r = await result.current.addTarget({ model: "res.partner", resId: 6, name: "C6" });
      expect(r).toMatchObject({ ok: false, reason: "cap" });
    });
    expect(result.current.targets).toHaveLength(5);
  });
});
