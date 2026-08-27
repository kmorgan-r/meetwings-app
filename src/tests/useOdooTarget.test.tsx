import { act, renderHook, waitFor } from "@testing-library/react";
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
  saveTarget: vi.fn(async () => {}),
  loadTarget: vi.fn(async () => null as unknown),
  clearTarget: vi.fn(async () => {}),
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
import type { OdooContact } from "@/types";

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
  action.loadTarget.mockResolvedValue(null);
  action.getSyncState.mockResolvedValue({ last_sync_at: 1000, last_error_code: null });
  action.saveTarget.mockResolvedValue(undefined);
  action.stampLastMeeting.mockResolvedValue(undefined);
  action.setColleague.mockResolvedValue(undefined);
  odoo.fetchOpportunities.mockResolvedValue([]);
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
  // odoo_selected_target.instance TEXT NOT NULL - thrown out of a click
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
    await waitFor(() => expect(action.saveTarget).toHaveBeenCalled());
    expect(action.saveTarget.mock.calls[0][0]).toMatchObject({
      instance: "http://h:8069|odoo",
    });
  });

  // A rejected saveTarget with the selection already in state leaves targetRef
  // claiming something that was never written - so the next remount loses it
  // silently, which is exactly what the persisted singleton row exists to stop.
  it("does not leave targetRef claiming an unpersisted selection", async () => {
    action.saveTarget.mockRejectedValue(new Error("database is locked"));
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
    expect(result.current.targetRef.current).toEqual({ contactId: 1, leadId: null });
  });

  // Added during self-review: pin the exact scenario the hook's own doc
  // comment on commit()'s rejection path describes, and which no other test
  // here exercises. Pick Ada (token 1, saveTarget hangs); pick Bea (token 2,
  // saveTarget resolves - the row now names Bea); THEN Ada's write rejects.
  // Without re-checking the token in the rejection path, the rollback would
  // restore `previous` (null, captured before Ada's commit) over Bea's
  // already-persisted selection - the picker would show nothing chosen while
  // SQLite still holds Bea, silently reintroducing the unassigned-meeting
  // failure through the error handling meant to prevent it.
  it("does not let a stale commit's rejection roll back a newer, already-persisted selection", async () => {
    let rejectAdaSave: (err: unknown) => void = () => {};
    action.saveTarget.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectAdaSave = reject;
        })
    );
    const { result } = mount();
    await waitFor(() => expect(action.listContacts).toHaveBeenCalled());

    await act(async () => {
      result.current.pickerProps.onSelect(ada); // token 1, saveTarget pending
    });
    await act(async () => {
      await result.current.pickerProps.onSelect(colleague); // token 2, saveTarget resolves
    });
    expect(result.current.targetRef.current).toEqual({ contactId: 2, leadId: null });

    await act(async () => {
      rejectAdaSave(new Error("database is locked"));
    });

    expect(result.current.targetRef.current).toEqual({ contactId: 2, leadId: null });
  });
});

describe("the opportunity panel", () => {
  // Contact A's deals must not sit under contact B. For a COLLEAGUE - which
  // skips the lookup entirely - stale deals would otherwise stay forever.
  it("clears the previous contact's opportunities before the next selection", async () => {
    odoo.fetchOpportunities.mockResolvedValue([
      { id: 5, name: "Heat pump", type: "opportunity", stageName: null, partnerId: 1, partnerName: "Ada" },
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
    const savesAfterSelect = action.saveTarget.mock.calls.length;

    odoo.fetchOpportunities.mockResolvedValue([]);
    await act(async () => {
      await result.current.pickerProps.onRetryOpportunities();
    });
    expect(odoo.fetchOpportunities).toHaveBeenCalledTimes(2);
    expect(action.saveTarget.mock.calls).toHaveLength(savesAfterSelect);
  });

  // Task 11's `opportunities === null` branch — the one that renders the Look
  // up button — is reachable with NO prior onSelect: it is the normal state of
  // a target rehydrated after a <Completion /> remount. That is exactly when
  // the hook's contactRef is empty, so retry must fall back to the cache or the
  // button is dead on the one path it was added for.
  it("retries for a rehydrated target that was never selected in this session", async () => {
    action.loadTarget.mockResolvedValue({ contactId: 1, leadId: null });
    const { result } = mount();
    await waitFor(() => expect(action.listContacts).toHaveBeenCalled());
    expect(result.current.pickerProps.opportunities).toBeNull();

    await act(async () => {
      await result.current.pickerProps.onRetryOpportunities();
    });
    expect(odoo.fetchOpportunities).toHaveBeenCalledWith(
      expect.anything(),
      1,
      ada.parentId
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
    action.loadTarget.mockResolvedValue({ contactId: 1, leadId: null });
    const { result } = mount();
    await waitFor(() =>
      expect(result.current.targetRef.current).toEqual({ contactId: 1, leadId: null })
    );

    action.loadTarget.mockClear();
    action.loadTarget.mockResolvedValue(null);
    await act(async () => {
      await emitInstanceChanged();
    });

    expect(result.current.targetRef.current).toBeNull();
    // Re-resolved for the NEW instance, not just cleared and left stale.
    expect(action.loadTarget).toHaveBeenCalled();
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
    expect(result.current.targetRef.current).toEqual({ contactId: 1, leadId: null });
    expect(action.saveTarget).toHaveBeenCalledWith(
      expect.objectContaining({ contactId: 1, leadId: null }),
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
    expect(result.current.targetRef.current).toEqual({ contactId: 2, leadId: null });
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
      expect(odoo.fetchOpportunities).toHaveBeenCalledWith(expect.anything(), 1, 9)
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
        { id: 99, name: "A's deal", type: "opportunity", stageName: null, partnerId: 1, partnerName: "Ada" },
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
    expect(result.current.targetRef.current).toEqual({ contactId: 1, leadId: null });
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
    expect(result.current.targetRef.current).toEqual({ contactId: 1, leadId: 7 });
    expect(action.saveTarget).toHaveBeenLastCalledWith(
      expect.objectContaining({ contactId: 1, leadId: 7 }),
      expect.any(Number)
    );
  });
});

describe("rehydrate", () => {
  // <Completion /> can unmount mid-call: the setup gate at
  // src/pages/app/index.tsx:84 is reactive, not latched.
  it("restores the target from the singleton row on mount", async () => {
    action.loadTarget.mockResolvedValue({ contactId: 4, leadId: 8 });
    const { result } = mount();
    await waitFor(() =>
      expect(result.current.targetRef.current).toEqual({ contactId: 4, leadId: 8 })
    );
  });

  // A mid-call remount is exactly when the user is likeliest to re-pick.
  it("does not clobber a selection committed during the rehydrate round trip", async () => {
    let resolveLoad: (v: unknown) => void = () => {};
    action.loadTarget.mockReturnValue(
      new Promise((resolve) => {
        resolveLoad = resolve;
      })
    );
    const { result } = mount();
    await act(async () => {
      result.current.pickerProps.onSelect(colleague);
    });
    await act(async () => resolveLoad({ contactId: 4, leadId: 8 }));
    expect(result.current.targetRef.current).toEqual({ contactId: 2, leadId: null });
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
    expect(result.current.targetRef.current).toEqual({ contactId: 2, leadId: null });
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
    expect(action.clearTarget).toHaveBeenCalled();
  });
});

// Finding 3: the third DB-deletion trigger the spec names. Emitted by
// useCompletion's startNewConversation, which every "start a new chat" path
// (the newConversation request event, a deleted-conversation fallback, and
// Input.tsx's keepEngaged close button) funnels through.
describe("starting a new chat", () => {
  it("clears both the in-memory target and the persisted row", async () => {
    action.loadTarget.mockResolvedValue({ contactId: 1, leadId: null });
    const { result } = mount();
    await waitFor(() =>
      expect(result.current.targetRef.current).toEqual({ contactId: 1, leadId: null })
    );

    await act(async () => {
      window.dispatchEvent(new CustomEvent("newConversationStarted"));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.targetRef.current).toBeNull();
    expect(action.clearTarget).toHaveBeenCalled();
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
