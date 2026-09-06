import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CalendarParticipant, OdooContact } from "@/types";

vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ label: "main" }) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => {}) }));

/**
 * The event listeners the hook registers, captured by name.
 *
 * `handleInstanceChanged` is reachable ONLY through
 * `listen("odoo-instance-changed")` (useOdooTarget.ts:699-710). A mock that
 * returns a bare no-op leaves the instance-change path untestable, and the
 * alternative - exporting a test-only hook member - puts a surface in
 * production code that exists for no production caller.
 *
 * `vi.hoisted`, not a plain const: a `vi.mock` factory closing over an ordinary
 * outer binding dies at load with a TDZ ReferenceError instead of reporting a
 * failing test. Same reason the precedent file gives at
 * odoo-target-new-chat-entry-points.test.tsx:87-89.
 */
const listeners = vi.hoisted(() => new Map<string, () => unknown>());
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event: string, handler: () => unknown) => {
    listeners.set(event, handler);
    return () => listeners.delete(event);
  }),
}));
vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

const action = vi.hoisted(() => ({
  listContacts: vi.fn(async () => [] as unknown[]),
  getSyncState: vi.fn(async () => null as unknown),
  setColleague: vi.fn(async () => {}),
  stampLastMeeting: vi.fn(async () => {}),
  loadTargets: vi.fn(async () => [] as unknown[]),
  addSelectedTarget: vi.fn(async () => ({ ok: true }) as { ok: boolean; reason?: "cap" }),
  removeSelectedTarget: vi.fn(async () => {}),
  clearTargets: vi.fn(async () => {}),
  upsertContacts: vi.fn(async () => 1),
}));
vi.mock("@/lib/database/odoo-contacts.action", () => action);

const odoo = vi.hoisted(() => ({
  runSync: vi.fn(async () => ({ ran: true, changed: 0, fetched: 0, skipped: 0, clampSkipped: false })),
  currentInstance: vi.fn(async () => "http://h:8069|odoo"),
  createOdooClient: vi.fn(() => ({ authenticate: vi.fn(), execute: vi.fn(), serverDate: null })),
  fetchOpportunities: vi.fn(async () => []),
  createOrAdoptContact: vi.fn(),
}));
vi.mock("@/lib/odoo", async () => {
  const errors = await vi.importActual<Record<string, unknown>>("@/lib/odoo/errors");
  return { ...errors, ...odoo, LEAD_SEARCH_MIN_CHARS: 3, searchLeads: vi.fn(async () => []) };
});
vi.mock("@/lib/storage/odoo-config.storage", () => ({
  loadOdooConfig: vi.fn(async () => ({ url: "http://h:8069", db: "odoo", login: "b", apiKey: "k" })),
  instanceFingerprint: vi.fn(() => "http://h:8069|odoo"),
}));

import { OdooError } from "@/lib/odoo/errors";
import { useOdooTarget } from "@/hooks/useOdooTarget";

function contact(over: Partial<OdooContact> = {}): OdooContact {
  return {
    id: 7,
    name: "Jane Doe",
    email: "jane@acme.example",
    phone: null,
    companyName: null,
    parentId: null,
    isCompany: false,
    active: true,
    writeDate: "2026-09-05 10:00:00",
    isColleague: false,
    lastMeetingAt: null,
    ...over,
  };
}

const participant: CalendarParticipant = {
  address: "Jane@Acme.Example",
  name: "Jane Doe",
  type: "required",
  isOrganizer: false,
};
const draft = { name: "Jane Doe", parentId: null };

function mount() {
  return renderHook(() =>
    useOdooTarget({
      meetingAssistMode: false,
      isPickerOpen: false,
      setIsPickerOpen: vi.fn(),
      setTargetCount: vi.fn(),
    })
  );
}

/** Lets a test hold the create open while it does something else. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
  listeners.clear();
  action.listContacts.mockResolvedValue([]);
  action.loadTargets.mockResolvedValue([]);
  action.getSyncState.mockResolvedValue({ last_sync_at: 1000, last_error_code: null });
  action.upsertContacts.mockResolvedValue(1);
  odoo.currentInstance.mockResolvedValue("http://h:8069|odoo");
  odoo.createOrAdoptContact.mockResolvedValue({ kind: "created", contact: contact() });
});

describe("onCreateContact", () => {
  it("upserts exactly one row and reloads, never runSync", async () => {
    const { result } = mount();
    await waitFor(() => expect(action.loadTargets).toHaveBeenCalled());
    odoo.runSync.mockClear();

    let out;
    await act(async () => {
      out = await result.current.onCreateContact(participant, draft);
    });

    expect(out).toMatchObject({ kind: "created" });
    expect(action.upsertContacts).toHaveBeenCalledTimes(1);
    const [instance, rows] = action.upsertContacts.mock.calls[0];
    expect(instance).toBe("http://h:8069|odoo");
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(7);
    // runSync would claim the sync lock and can fail ODOO_SYNC_BUSY for a
    // reason unrelated to this write.
    expect(odoo.runSync).not.toHaveBeenCalled();
    // reload() re-reads the cache.
    expect(action.listContacts).toHaveBeenCalled();
  });

  it.each([
    ["adopted-active", true],
    ["adopted-archived", false],
  ])("caches the found row on a %s hit and makes no create call", async (kind, active) => {
    odoo.createOrAdoptContact.mockResolvedValue({ kind, contact: contact({ id: 9, active }) });
    const { result } = mount();
    await waitFor(() => expect(action.loadTargets).toHaveBeenCalled());

    let out;
    await act(async () => {
      out = await result.current.onCreateContact(participant, draft);
    });

    expect(out).toMatchObject({ kind });
    // The archived branch caches TOO. matchAttendees only produces
    // reason "archived" when a cache row exists with active false; without the
    // upsert the row keeps claiming there is no contact for somebody the
    // search just proved exists.
    expect(action.upsertContacts).toHaveBeenCalledTimes(1);
    expect(action.upsertContacts.mock.calls[0][1][0].id).toBe(9);
  });

  it("caches nothing when the created partner is invisible to this connection", async () => {
    odoo.createOrAdoptContact.mockResolvedValue({ kind: "created-invisible" });
    const { result } = mount();
    await waitFor(() => expect(action.loadTargets).toHaveBeenCalled());

    let out;
    await act(async () => {
      out = await result.current.onCreateContact(participant, draft);
    });

    expect(out).toEqual({ kind: "created-invisible" });
    expect(action.upsertContacts).not.toHaveBeenCalled();
  });

  it("still reports the Odoo write as landed when the cache write fails", async () => {
    action.upsertContacts.mockRejectedValue(new Error("database is locked"));
    const { result } = mount();
    await waitFor(() => expect(action.loadTargets).toHaveBeenCalled());

    let out;
    await act(async () => {
      out = await result.current.onCreateContact(participant, draft);
    });

    expect(out).toEqual({ kind: "cached-failed" });
  });

  it("maps a thrown OdooError to failed with its code", async () => {
    odoo.createOrAdoptContact.mockRejectedValue(new OdooError("ODOO_FAULT", "boom", {}));
    const { result } = mount();
    await waitFor(() => expect(action.loadTargets).toHaveBeenCalled());

    let out;
    await act(async () => {
      out = await result.current.onCreateContact(participant, draft);
    });

    expect(out).toEqual({ kind: "failed", code: "ODOO_FAULT" });
  });

  it("releases the guard after a failure so a second attempt runs", async () => {
    odoo.createOrAdoptContact.mockRejectedValueOnce(new OdooError("ODOO_UNREACHABLE", "boom", {}));
    const { result } = mount();
    await waitFor(() => expect(action.loadTargets).toHaveBeenCalled());

    await act(async () => {
      await result.current.onCreateContact(participant, draft);
    });
    let second;
    await act(async () => {
      second = await result.current.onCreateContact(participant, draft);
    });
    expect(second).toMatchObject({ kind: "created" });
  });

  it("refuses a second create while one is in flight, without releasing the first", async () => {
    const gate = deferred<{ kind: string; contact: OdooContact }>();
    odoo.createOrAdoptContact.mockReturnValueOnce(gate.promise);
    const { result } = mount();
    await waitFor(() => expect(action.loadTargets).toHaveBeenCalled());

    let first!: Promise<unknown>;
    await act(async () => {
      first = result.current.onCreateContact(participant, draft);
    });

    let second;
    await act(async () => {
      second = await result.current.onCreateContact(participant, draft);
    });
    expect(second).toEqual({ kind: "busy" });
    // The refusal must not have released the in-flight create's guard.
    expect(action.upsertContacts).not.toHaveBeenCalled();

    await act(async () => {
      gate.resolve({ kind: "created", contact: contact() });
      await first;
    });
    expect(action.upsertContacts).toHaveBeenCalledTimes(1);
  });
});

describe("onCreateContact - the two tokens", () => {
  // The regression the instanceToken split exists to prevent. selectionToken is
  // bumped by onSelect/onSelectLead/handleNewChat/clearAllTargets, none of
  // which invalidate a single cached contact - guarding the cache write on it
  // would silently discard a partner successfully created in Odoo.
  it("still writes the cache when only the SELECTION changed mid-create", async () => {
    const gate = deferred<{ kind: string; contact: OdooContact }>();
    odoo.createOrAdoptContact.mockReturnValueOnce(gate.promise);
    const { result } = mount();
    await waitFor(() => expect(action.loadTargets).toHaveBeenCalled());

    let create!: Promise<unknown>;
    await act(async () => {
      create = result.current.onCreateContact(participant, draft);
    });
    // A selection made in the single-select part of the same popover.
    await act(async () => {
      await result.current.pickerProps.onSelect(contact({ id: 55 }));
    });
    let out;
    await act(async () => {
      gate.resolve({ kind: "created", contact: contact() });
      out = await create;
    });

    expect(out).toMatchObject({ kind: "created" });
    expect(action.upsertContacts).toHaveBeenCalledTimes(1);
  });

  it("abandons and writes nothing when the INSTANCE changed mid-create", async () => {
    const gate = deferred<{ kind: string; contact: OdooContact }>();
    odoo.createOrAdoptContact.mockReturnValueOnce(gate.promise);
    const { result } = mount();
    await waitFor(() => expect(action.loadTargets).toHaveBeenCalled());

    let create!: Promise<unknown>;
    await act(async () => {
      create = result.current.onCreateContact(participant, draft);
    });
    // The real cross-window path: /odoo broadcasts, this listener runs, and
    // handleInstanceChanged bumps instanceToken.
    await act(async () => {
      await listeners.get("odoo-instance-changed")?.();
    });
    let out;
    await act(async () => {
      gate.resolve({ kind: "created", contact: contact() });
      out = await create;
    });

    expect(out).toEqual({ kind: "abandoned" });
    expect(action.upsertContacts).not.toHaveBeenCalled();
  });
});
