import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

// `vi.hoisted`, not a bare `const`. Vitest hoists every `vi.mock` call above the
// imports, so a factory that closes over a plain outer const runs while that
// const is still in its TDZ - the file then dies at load with
// `ReferenceError: Cannot access 'storage' before initialization` and reports "no
// tests" rather than failures. See src/tests/useMeetingAutoRecord.lifecycle.test.tsx:12-15.
const storage = vi.hoisted(() => ({
  loadOdooConfig: vi.fn(async () => null as unknown),
  saveOdooConfig: vi.fn(async () => ({ instanceChanged: false, becameUsable: false })),
  clearOdooConfig: vi.fn(async () => {}),
  instanceFingerprint: vi.fn(() => "http://h:8069|odoo"),
}));
vi.mock("@/lib/storage/odoo-config.storage", () => storage);

// The EMITTING half of the cross-window notification. Task 12 covers the
// listening half; without this suite covering the emit, a save handler that
// forgets it - or fires it on the wrong condition - ships green.
const emit = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@tauri-apps/api/event", () => ({ emit, listen: vi.fn(async () => () => {}) }));

const odoo = vi.hoisted(() => ({
  // SyncOutcome, not SyncResult - `ran` is what tells a skip apart from a
  // completed sync that changed nothing.
  runSync: vi.fn(async () => ({
    ran: true,
    changed: 3,
    fetched: 3,
    skipped: 0,
    clampSkipped: false,
  })),
  testOdooConnection: vi.fn(async () => 7),
}));
vi.mock("@/lib/odoo", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@/lib/odoo/errors");
  return { ...actual, ...odoo };
});

vi.mock("@/lib/database/odoo-contacts.action", () => ({
  getSyncState: vi.fn(async () => null),
}));

// WITHOUT THIS EVERY TEST IN THIS FILE THROWS ON RENDER.
//
// Step 6 writes the page wrapped in PageLayout, which renders <Header /> (calls
// useNavigate(), which throws outside a <Router>) and <Promote /> (calls
// useApp(), which throws its own "must be used within a AppProvider"). The
// repo's own settings-page test does exactly this stub; see
// src/tests/settings-page.meeting-auto-record.test.tsx:21-23.
vi.mock("@/layouts", () => ({
  PageLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import { odooError, OdooError } from "@/lib/odoo/errors";
import { setOdooRedactor } from "@/lib/odoo/redactor";
import OdooSettings from "@/pages/odoo";

const KEY = 'a1b2&c3d4<e5f6>g7h8"i9j0';

const SYNCED_3 = { ran: true, changed: 3, fetched: 3, skipped: 0, clampSkipped: false };

beforeEach(() => {
  // clearAllMocks wipes the CALL LOG and leaves implementations, so a
  // mockResolvedValue / mockRejectedValue set by one test is still in force for
  // every test after it. Re-establish the defaults explicitly rather than reach
  // for resetAllMocks, which would also erase the vi.fn() bodies above.
  vi.clearAllMocks();
  odoo.runSync.mockResolvedValue(SYNCED_3);
  odoo.testOdooConnection.mockResolvedValue(7);
  storage.loadOdooConfig.mockResolvedValue(null);
  storage.saveOdooConfig.mockResolvedValue({ instanceChanged: false, becameUsable: false });
  setOdooRedactor([KEY]);
});

async function fillAndSave() {
  await userEvent.type(await screen.findByLabelText(/url/i), "http://h:8069");
  await userEvent.type(screen.getByLabelText(/database/i), "odoo");
  await userEvent.type(screen.getByLabelText(/login/i), "bob@example.com");
  await userEvent.type(screen.getByLabelText(/api key/i), KEY);
  await userEvent.click(screen.getByRole("button", { name: /save/i }));
}

describe("saving credentials", () => {
  // The picker lives in the other window and cannot see this write. The event
  // is the only thing that tells it to re-resolve.
  it("notifies the other window when the instance changed", async () => {
    storage.saveOdooConfig.mockResolvedValue({ instanceChanged: true, becameUsable: false });
    render(<OdooSettings />);
    await fillAndSave();
    await waitFor(() => expect(emit).toHaveBeenCalledWith("odoo-instance-changed"));
  });

  // The blank-login repair: same url and db, so the fingerprint is UNCHANGED.
  // Gating only on instanceChanged leaves the picker stuck on "not set up",
  // a state that deliberately offers no Refresh, until the app restarts.
  it("notifies when a half-filled config became usable, fingerprint unchanged", async () => {
    storage.saveOdooConfig.mockResolvedValue({ instanceChanged: false, becameUsable: true });
    render(<OdooSettings />);
    await fillAndSave();
    await waitFor(() => expect(emit).toHaveBeenCalledWith("odoo-instance-changed"));
  });

  it("does not notify when nothing meaningful changed", async () => {
    render(<OdooSettings />);
    await fillAndSave();
    await waitFor(() => expect(storage.saveOdooConfig).toHaveBeenCalled());
    expect(emit).not.toHaveBeenCalled();
  });

  // A failed credential write must not leave the user believing it succeeded.
  // saveOdooConfig awaits secureGet, secureSet and the store's own save(), all
  // of which throw raw, and it has no try of its own.
  it("reports a failed save instead of rejecting out of the click handler", async () => {
    storage.saveOdooConfig.mockRejectedValue(new Error("store is locked"));
    render(<OdooSettings />);
    await fillAndSave();
    expect(await screen.findByText(/ODOO_INTERNAL/)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("i9j0");
  });

  // Review finding 1: the credentials were already written by the time
  // `emit` runs. A rejecting `emit` must not relabel that as a failed save -
  // the user would re-enter credentials that are already stored, or worse,
  // conclude Odoo is unconfigured. `saveStatus` has no positive text of its
  // own (it is cleared to null on success - see the deferred "no positive
  // Saved confirmation" finding), so the strongest available proof that the
  // save is still treated as successful is that the ODOO_INTERNAL failure
  // text this handler's OWN catch would render never appears, even after the
  // rejection has had a full turn to propagate.
  it("keeps the save successful when the cross-window notification itself fails", async () => {
    storage.saveOdooConfig.mockResolvedValue({ instanceChanged: true, becameUsable: false });
    let rejectEmit: (err: unknown) => void = () => {};
    emit.mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        rejectEmit = reject;
      })
    );

    render(<OdooSettings />);
    await fillAndSave();
    await waitFor(() => expect(emit).toHaveBeenCalledWith("odoo-instance-changed"));

    // `act` so React has flushed any state update the rejection triggers
    // before the assertion below runs - without it, a still-pending
    // microtask from a buggy outer catch could land after we've already
    // checked.
    await act(async () => {
      rejectEmit(new Error("no listeners"));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.queryByText(/ODOO_INTERNAL/)).not.toBeInTheDocument();
  });
});

describe("the Odoo settings page", () => {
  it("warns that the store is plaintext on disk, where the key is entered", async () => {
    render(<OdooSettings />);
    expect(await screen.findByText(/not encrypted at rest/i)).toBeInTheDocument();
  });

  it("reports the resolved uid on a successful Test connection", async () => {
    storage.loadOdooConfig.mockResolvedValue({
      url: "http://h:8069",
      db: "odoo",
      login: "bob",
      apiKey: KEY,
    });
    render(<OdooSettings />);
    await userEvent.click(await screen.findByRole("button", { name: /test connection/i }));
    expect(await screen.findByText(/uid 7/i)).toBeInTheDocument();
  });

  // Every ODOO_* code surfaces. A failure that shows nothing is the bug this
  // whole feature is written against.
  it("shows the error code when Test connection fails", async () => {
    odoo.testOdooConnection.mockRejectedValue(
      odooError("ODOO_AUTH_FAILED", "Odoo rejected the credentials")
    );
    render(<OdooSettings />);
    await userEvent.click(await screen.findByRole("button", { name: /test connection/i }));
    expect(await screen.findByText(/ODOO_AUTH_FAILED/)).toBeInTheDocument();
  });

  it("never renders the api key inside an error message", async () => {
    odoo.testOdooConnection.mockRejectedValue(
      odooError("ODOO_FAULT", `traceback with ${KEY} inside`)
    );
    render(<OdooSettings />);
    await userEvent.click(await screen.findByRole("button", { name: /test connection/i }));
    await screen.findByText(/ODOO_FAULT/);
    expect(document.body.textContent).not.toContain("i9j0");
  });

  it("reports what a manual sync did", async () => {
    render(<OdooSettings />);
    await userEvent.click(await screen.findByRole("button", { name: /sync contacts/i }));
    await waitFor(() => expect(odoo.runSync).toHaveBeenCalledWith("settings"));
    expect(await screen.findByText(/3 contacts updated/i)).toBeInTheDocument();
  });

  it("says so plainly when a sync changed nothing", async () => {
    odoo.runSync.mockResolvedValue({
      ran: true,
      changed: 0,
      fetched: 12,
      skipped: 0,
      clampSkipped: false,
    });
    render(<OdooSettings />);
    await userEvent.click(await screen.findByRole("button", { name: /sync contacts/i }));
    expect(await screen.findByText(/no contacts changed/i)).toBeInTheDocument();
  });

  it("surfaces skipped rows rather than hiding them", async () => {
    odoo.runSync.mockResolvedValue({
      ran: true,
      changed: 1,
      fetched: 5,
      skipped: 2,
      clampSkipped: false,
    });
    render(<OdooSettings />);
    await userEvent.click(await screen.findByRole("button", { name: /sync contacts/i }));
    expect(await screen.findByText(/2 could not be read/i)).toBeInTheDocument();
  });

  // A sync that never ran must not report "0 contacts updated" - that sentence
  // describes a working, empty Odoo, and it is why runSync returns `ran`.
  //
  // `runSync("settings")` cannot itself produce ran:false today (decideSync
  // returns "run" for every non-app-start trigger), so this branch is
  // DEFENSIVE: it pins the rendering rule for a decideSync that grows another
  // manual-trigger rule later. The reachable version of the same branch is
  // covered on the app-start path in useOdooTarget.test.tsx.
  it("does not describe a sync that never ran as a completed one", async () => {
    odoo.runSync.mockResolvedValue({ ran: false, reason: "skip-in-meeting" });
    render(<OdooSettings />);
    await userEvent.click(await screen.findByRole("button", { name: /sync contacts/i }));
    expect(await screen.findByText(/did not run/i)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/contacts updated/i);
  });

  // A busy sync is another window working, not a fault. It must not read as an
  // error - it is the one ODOO_* code the settings page treats as benign.
  it("treats ODOO_SYNC_BUSY as benign, not as a failure", async () => {
    odoo.runSync.mockRejectedValue(
      new OdooError("ODOO_SYNC_BUSY", "A sync is already running in another window", {})
    );
    render(<OdooSettings />);
    await userEvent.click(await screen.findByRole("button", { name: /sync contacts/i }));
    expect(await screen.findByText(/already running/i)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/failed/i);
  });

  // Review finding 2: worse than finding 1, because by the time `emit` runs
  // the sync's DB writes are already committed and the watermark already
  // advanced. A rejecting `emit` must not erase the true "N contacts
  // updated" text and replace it with "Sync failed" - the user would then
  // hit Refresh again for work that already succeeded.
  it("keeps the sync result visible when the cross-window notification itself fails", async () => {
    let rejectEmit: (err: unknown) => void = () => {};
    emit.mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        rejectEmit = reject;
      })
    );

    render(<OdooSettings />);
    await userEvent.click(await screen.findByRole("button", { name: /sync contacts/i }));
    expect(await screen.findByText(/3 contacts updated/i)).toBeInTheDocument();

    await waitFor(() => expect(emit).toHaveBeenCalledWith("odoo-instance-changed"));
    await act(async () => {
      rejectEmit(new Error("no listeners"));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByText(/3 contacts updated/i)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/sync failed/i);
  });
});
