import { beforeEach, describe, expect, it, vi } from "vitest";

const sync = vi.hoisted(() => ({ syncContacts: vi.fn() }));
vi.mock("@/lib/odoo/contacts-sync", () => sync);

const storage = vi.hoisted(() => ({
  requireOdooConfig: vi.fn(async () => ({
    url: "http://h:8069",
    db: "odoo",
    login: "b",
    apiKey: "k",
  })),
  instanceFingerprint: vi.fn(() => "http://h:8069|odoo"),
}));
vi.mock("@/lib/storage/odoo-config.storage", () => storage);

const action = vi.hoisted(() => ({ getSyncState: vi.fn(async () => null as unknown) }));
vi.mock("@/lib/database/odoo-contacts.action", () => action);

vi.mock("@/lib/odoo/client", () => ({
  createOdooClient: vi.fn(() => ({ authenticate: vi.fn(), execute: vi.fn(), serverDate: null })),
  DEFAULT_TIMEOUT_MS: 30_000,
}));

import { runSync } from "@/lib/odoo";

const RESULT = { changed: 2, fetched: 2, skipped: 0, clampSkipped: false };

beforeEach(() => {
  vi.clearAllMocks();
  storage.requireOdooConfig.mockResolvedValue({
    url: "http://h:8069",
    db: "odoo",
    login: "b",
    apiKey: "k",
  });
  action.getSyncState.mockResolvedValue(null);
  sync.syncContacts.mockResolvedValue(RESULT);
});

describe("runSync", () => {
  // The StrictMode double-mount case, and the "Refresh pressed twice" case.
  // Both callers must get the SAME run, not two concurrent paged pulls - the
  // second of which claimSync would refuse with ODOO_SYNC_BUSY, turning a
  // harmless double-fire into a visible error.
  it("joins a run already in flight instead of starting a second", async () => {
    let release: (v: unknown) => void = () => {};
    sync.syncContacts.mockReturnValue(new Promise((resolve) => { release = resolve; }));

    const a = runSync("refresh");
    const b = runSync("refresh");
    release(RESULT);

    await expect(a).resolves.toEqual({ ran: true, ...RESULT });
    await expect(b).resolves.toEqual({ ran: true, ...RESULT });
    expect(sync.syncContacts).toHaveBeenCalledTimes(1);
  });

  // Guard POSITION, not guard presence. "syncContacts called once" (above)
  // cannot discriminate where the guard sits: JS's run-to-completion
  // microtask semantics make a synchronous check-and-assign atomic wherever
  // it is, so two synchronous callers can never both start a sync no matter
  // how many awaits precede the check - see the comment above `runSync`.
  //
  // What guard position DOES change is how many times the reads before it
  // run. With the guard first, a joining caller returns before ever calling
  // `requireOdooConfig`; move the guard after it and BOTH callers call it -
  // each fetching its own copy of the credentials - before either can join.
  // That duplicate credential/sync-state read is real: needless config I/O
  // on every overlapping caller, not just the winner. This assertion is what
  // actually distinguishes "guard first" from "guard moved after the first
  // await," which the syncContacts-count assertion above does not.
  it("calls requireOdooConfig only once across two concurrent callers, and joins one run", async () => {
    const a = runSync("refresh");
    const b = runSync("refresh");

    expect(storage.requireOdooConfig).toHaveBeenCalledTimes(1);

    await expect(a).resolves.toEqual({ ran: true, ...RESULT });
    await expect(b).resolves.toEqual({ ran: true, ...RESULT });
    expect(sync.syncContacts).toHaveBeenCalledTimes(1);
  });

  // The guard must be released. If `.finally` did not clear `inFlight`, one
  // completed sync would make every later Refresh a no-op returning a stale
  // result forever.
  it("clears the latch so a later call starts a new run", async () => {
    await runSync("refresh");
    await runSync("refresh");
    expect(sync.syncContacts).toHaveBeenCalledTimes(2);
  });

  // A failed run must clear the latch too - otherwise one network blip wedges
  // syncing for the rest of the session.
  it("clears the latch after a failure", async () => {
    sync.syncContacts.mockRejectedValueOnce(new Error("down"));
    await expect(runSync("refresh")).rejects.toThrow();
    await expect(runSync("refresh")).resolves.toEqual({ ran: true, ...RESULT });
    expect(sync.syncContacts).toHaveBeenCalledTimes(2);
  });

  // A skip must not reach syncContacts at all, and must be reported as a skip.
  it("returns ran:false without syncing when decideSync refuses", async () => {
    await expect(runSync("app-start", true)).resolves.toEqual({
      ran: false,
      reason: "skip-in-meeting",
    });
    expect(sync.syncContacts).not.toHaveBeenCalled();
  });

  // A joiner must inherit the skip, not re-label it `ran: true` with zeroes -
  // which is exactly the "0 contacts updated for a sync that never ran"
  // sentence SyncOutcome exists to prevent.
  it("hands a joiner the same skip outcome, not a zeroed success", async () => {
    action.getSyncState.mockResolvedValue({ last_sync_at: Date.now() });
    const [a, b] = await Promise.all([runSync("app-start"), runSync("app-start")]);
    expect(a).toEqual({ ran: false, reason: "skip-recent" });
    expect(b).toEqual(a);
  });

  // ODOO_NOT_CONFIGURED is raised by requireOdooConfig INSIDE the wrapped run,
  // so it must reach the caller as a rejection - not be swallowed into a
  // ran:false outcome that reads as a deliberate skip.
  it("propagates ODOO_NOT_CONFIGURED rather than reporting a skip", async () => {
    const { OdooError } = await vi.importActual<typeof import("@/lib/odoo/errors")>(
      "@/lib/odoo/errors"
    );
    storage.requireOdooConfig.mockRejectedValue(
      new OdooError("ODOO_NOT_CONFIGURED", "not set up", {})
    );
    await expect(runSync("app-start")).rejects.toMatchObject({
      code: "ODOO_NOT_CONFIGURED",
    });
  });
});
