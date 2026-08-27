import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

// `vi.hoisted`, not a bare `const`. Vitest hoists every `vi.mock` call above the
// imports, so a factory that closes over a plain outer const runs while that
// const is still in its TDZ - the file then dies at load with
// `ReferenceError: Cannot access 'storage' before initialization` and reports "no
// tests" rather than failures. See src/tests/useMeetingAutoRecord.lifecycle.test.tsx:12-15.
const storage = vi.hoisted(() => ({
  loadOdooConfig: vi.fn(async () => null as unknown),
  loadOdooConfigState: vi.fn(async () => ({ state: "absent", config: null }) as unknown),
  saveOdooConfig: vi.fn(async () => ({ instanceChanged: false, becameUsable: false })),
  clearOdooConfig: vi.fn(async () => {}),
  instanceFingerprint: vi.fn(() => "http://h:8069|odoo"),
}));
vi.mock("@/lib/storage/odoo-config.storage", () => storage);

// Task 12's queue status block. Mocked here (not left to reach a real
// getDatabase()) for the same reason as the odoo-contacts.action mock below:
// without it every test in this file fails at render, not just the new ones.
const { getQueueCounts, countAllQueued } = vi.hoisted(() => ({
  getQueueCounts: vi.fn(),
  countAllQueued: vi.fn(async () => 0),
}));
vi.mock("@/lib/database/meeting-log.action", () => ({ getQueueCounts, countAllQueued }));

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

// The counts block now links to /meeting-log, and <Link> throws outside a
// Router exactly as useNavigate does. See the @/layouts stub above.
function renderPage() {
  return render(
    <MemoryRouter>
      <OdooSettings />
    </MemoryRouter>
  );
}

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
  storage.loadOdooConfigState.mockResolvedValue({
    state: "complete",
    config: { url: "http://h:8069", db: "odoo", login: "l", apiKey: "k" },
  });
  storage.saveOdooConfig.mockResolvedValue({ instanceChanged: false, becameUsable: false });
  getQueueCounts.mockResolvedValue({
    waiting: 0, needsAttention: 0, unassigned: 0, otherInstance: 0, lastError: null,
  });
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
    renderPage();
    await fillAndSave();
    await waitFor(() => expect(emit).toHaveBeenCalledWith("odoo-instance-changed"));
  });

  // The blank-login repair: same url and db, so the fingerprint is UNCHANGED.
  // Gating only on instanceChanged leaves the picker stuck on "not set up",
  // a state that deliberately offers no Refresh, until the app restarts.
  it("notifies when a half-filled config became usable, fingerprint unchanged", async () => {
    storage.saveOdooConfig.mockResolvedValue({ instanceChanged: false, becameUsable: true });
    renderPage();
    await fillAndSave();
    await waitFor(() => expect(emit).toHaveBeenCalledWith("odoo-instance-changed"));
  });

  it("does not notify when nothing meaningful changed", async () => {
    renderPage();
    await fillAndSave();
    await waitFor(() => expect(storage.saveOdooConfig).toHaveBeenCalled());
    expect(emit).not.toHaveBeenCalled();
  });

  // A failed credential write must not leave the user believing it succeeded.
  // saveOdooConfig awaits secureGet, secureSet and the store's own save(), all
  // of which throw raw, and it has no try of its own.
  it("reports a failed save instead of rejecting out of the click handler", async () => {
    storage.saveOdooConfig.mockRejectedValue(new Error("store is locked"));
    renderPage();
    await fillAndSave();
    expect(await screen.findByText(/ODOO_INTERNAL/)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("i9j0");
  });

  // Review finding 1: the credentials were already written by the time
  // `emit` runs. A rejecting `emit` must not relabel that as a failed save -
  // the user would re-enter credentials that are already stored, or worse,
  // conclude Odoo is unconfigured. This pins that the "Saved" confirmation
  // survives the rejection and the ODOO_INTERNAL failure text this handler's
  // OWN catch would render never appears, even after the rejection has had a
  // full turn to propagate.
  it("keeps the save successful when the cross-window notification itself fails", async () => {
    storage.saveOdooConfig.mockResolvedValue({ instanceChanged: true, becameUsable: false });
    let rejectEmit: (err: unknown) => void = () => {};
    emit.mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        rejectEmit = reject;
      })
    );

    renderPage();
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
    expect(screen.getByText(/saved/i)).toBeInTheDocument();
  });

  // Finding 4: the only prior observable difference between a successful save
  // and a click that did nothing was the absence of an error line. Credential
  // entry is the one screen where "did that work?" must be answerable.
  it("shows a success confirmation after a successful save", async () => {
    renderPage();
    await fillAndSave();
    expect(await screen.findByText(/saved/i)).toBeInTheDocument();
  });

  it("clears the success confirmation on the next edit", async () => {
    renderPage();
    await fillAndSave();
    expect(await screen.findByText(/saved/i)).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText(/url/i), "1");
    expect(screen.queryByText(/saved/i)).not.toBeInTheDocument();
  });
});

describe("the Odoo settings page", () => {
  it("warns that the store is plaintext on disk, where the key is entered", async () => {
    renderPage();
    expect(await screen.findByText(/not encrypted at rest/i)).toBeInTheDocument();
  });

  it("reports the resolved uid on a successful Test connection", async () => {
    storage.loadOdooConfig.mockResolvedValue({
      url: "http://h:8069",
      db: "odoo",
      login: "bob",
      apiKey: KEY,
    });
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: /test connection/i }));
    // Scoped to the status line rather than the whole document: the checklist
    // card now repeats the uid as a detail beside its verified step, so a bare
    // findByText(/uid 7/i) matches two nodes and throws on the ambiguity.
    // Asserting on the line the button actually writes is the narrower claim.
    expect(await screen.findByTestId("odoo-test-status")).toHaveTextContent(/uid 7/i);
  });

  // Every ODOO_* code surfaces. A failure that shows nothing is the bug this
  // whole feature is written against.
  it("shows the error code when Test connection fails", async () => {
    odoo.testOdooConnection.mockRejectedValue(
      odooError("ODOO_AUTH_FAILED", "Odoo rejected the credentials")
    );
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: /test connection/i }));
    expect(await screen.findByText(/ODOO_AUTH_FAILED/)).toBeInTheDocument();
  });

  it("never renders the api key inside an error message", async () => {
    odoo.testOdooConnection.mockRejectedValue(
      odooError("ODOO_FAULT", `traceback with ${KEY} inside`)
    );
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: /test connection/i }));
    await screen.findByText(/ODOO_FAULT/);
    expect(document.body.textContent).not.toContain("i9j0");
  });

  it("marks the connection verified on the checklist after a successful test", async () => {
    storage.loadOdooConfig.mockResolvedValue({
      url: "http://h:8069",
      db: "odoo",
      login: "bob",
      apiKey: KEY,
    });
    renderPage();
    expect(await screen.findByText(/not tested yet/i)).toBeInTheDocument();
    await userEvent.click(await screen.findByRole("button", { name: /test connection/i }));
    expect(await screen.findByText(/connection verified/i)).toBeInTheDocument();
    expect(screen.queryByText(/not tested yet/i)).not.toBeInTheDocument();
  });

  // A failed test must not leave the checklist claiming a verified connection,
  // including the case where an EARLIER test succeeded - the green check
  // describes the credentials as they stand now.
  it("drops the verified check when a later test fails", async () => {
    storage.loadOdooConfig.mockResolvedValue({
      url: "http://h:8069",
      db: "odoo",
      login: "bob",
      apiKey: KEY,
    });
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: /test connection/i }));
    expect(await screen.findByText(/connection verified/i)).toBeInTheDocument();

    odoo.testOdooConnection.mockRejectedValue(
      odooError("ODOO_AUTH_FAILED", "Odoo rejected the credentials")
    );
    await userEvent.click(screen.getByRole("button", { name: /test connection/i }));
    expect(await screen.findByText(/not tested yet/i)).toBeInTheDocument();
    expect(screen.queryByText(/connection verified/i)).not.toBeInTheDocument();
  });

  // Editing the API key invalidates a verification performed against the old
  // one. Without this the checklist shows a passing check for a value that has
  // never been sent to Odoo.
  it("drops the verified check when a credential is edited", async () => {
    storage.loadOdooConfig.mockResolvedValue({
      url: "http://h:8069",
      db: "odoo",
      login: "bob",
      apiKey: KEY,
    });
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: /test connection/i }));
    expect(await screen.findByText(/connection verified/i)).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText(/url/i), "1");
    expect(screen.queryByText(/connection verified/i)).not.toBeInTheDocument();
    expect(screen.getByText(/not tested yet/i)).toBeInTheDocument();
  });

  // Same reasoning as the verified check above, and the card needs it more:
  // runSync reads the persisted config, so a green "Contacts synced" is a
  // claim about credentials the edit has just changed. It is also the row
  // drawn pending={!verified}, so a stale synced=true beside a freshly
  // cleared verified=false renders step 3 done above an untested step 2.
  it("drops the synced check when a credential is edited", async () => {
    storage.loadOdooConfig.mockResolvedValue({
      url: "http://h:8069",
      db: "odoo",
      login: "bob",
      apiKey: KEY,
    });
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: /sync contacts/i }));
    expect(await screen.findByText(/^contacts synced$/i)).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText(/url/i), "1");
    expect(screen.queryByText(/^contacts synced$/i)).not.toBeInTheDocument();
    expect(screen.getByText(/contacts not synced yet/i)).toBeInTheDocument();
  });

  // The storage layer's completeness check is bare truthiness, so "   " passes
  // it. The client concatenates config.url straight into the XML-RPC URL, so a
  // padded value cannot connect - a green "Credentials stored" check for one
  // would be the checklist lying about the exact failure this page is most
  // likely to hit, since every field here is pasted.
  it("does not count a whitespace-only field as filled", async () => {
    storage.loadOdooConfig.mockResolvedValue({
      url: "http://h:8069",
      db: "odoo",
      login: "bob",
      apiKey: "   ",
    });
    renderPage();
    expect(await screen.findByText(/3 of 4/)).toBeInTheDocument();
    expect(screen.queryByText(/credentials stored/i)).not.toBeInTheDocument();
  });

  it("reports what a manual sync did", async () => {
    renderPage();
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
    renderPage();
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
    renderPage();
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
    renderPage();
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
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: /sync contacts/i }));
    expect(await screen.findByText(/already running/i)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/failed/i);
  });

  // The copy above already said "benign"; this pins that the ICON agrees with
  // it. Statuses carry a kind precisely so the renderer does not have to sniff
  // the wording, and the failure this kills is a future refactor collapsing
  // every catch branch onto errorStatus - which would leave the sentence
  // reassuring and paint a red cross next to it.
  it("renders a busy sync in the muted tone, not the failure tone", async () => {
    odoo.runSync.mockRejectedValue(
      new OdooError("ODOO_SYNC_BUSY", "A sync is already running in another window", {})
    );
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: /sync contacts/i }));
    const line = await screen.findByTestId("odoo-sync-status");
    expect(line).toHaveClass("text-muted-foreground");
    expect(line).not.toHaveClass("text-destructive");
  });

  it("renders a genuinely failed sync in the failure tone", async () => {
    odoo.runSync.mockRejectedValue(new OdooError("ODOO_FAULT", "server exploded", {}));
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: /sync contacts/i }));
    const line = await screen.findByTestId("odoo-sync-status");
    expect(line).toHaveClass("text-destructive");
  });

  // A sync that declined to run has not failed either - same reasoning as the
  // busy case, different branch of handleSync.
  it("renders a sync that never ran in the muted tone", async () => {
    odoo.runSync.mockResolvedValue({
      ran: false,
      reason: "not configured",
      changed: 0,
      fetched: 0,
      skipped: 0,
      clampSkipped: false,
    } as never);
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: /sync contacts/i }));
    expect(await screen.findByTestId("odoo-sync-status")).toHaveClass("text-muted-foreground");
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

    renderPage();
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

describe("the queue status block", () => {
  it("renders nothing when the queue is empty", async () => {
    renderPage();
    await waitFor(() => expect(getQueueCounts).toHaveBeenCalled());
    expect(screen.queryByTestId("meeting-log-queue-status")).toBeNull();
  });

  it("words each group separately", async () => {
    getQueueCounts.mockResolvedValue({
      waiting: 2, needsAttention: 1, unassigned: 3, otherInstance: 4,
      lastError: "ODOO_FAULT: partner deleted",
    });
    renderPage();
    const block = await screen.findByTestId("meeting-log-queue-status");
    expect(block).toHaveTextContent("2 meetings waiting to be logged");
    expect(block).toHaveTextContent("1 meeting needs attention");
    expect(block).toHaveTextContent("3 meetings not assigned to a contact");
    expect(block).toHaveTextContent("4 meetings queued for a different Odoo database");
    expect(
      within(block).getByRole("link", { name: "Open the meeting log" })
    ).toHaveAttribute("href", "/meeting-log");
  });

  it("surfaces the most recent redacted error beside the attention group", async () => {
    getQueueCounts.mockResolvedValue({
      waiting: 0, needsAttention: 1, unassigned: 0, otherInstance: 0,
      lastError: "ODOO_FAULT: partner deleted",
    });
    renderPage();
    expect(await screen.findByText(/ODOO_FAULT: partner deleted/)).toBeInTheDocument();
  });

  it("omits a group whose count is zero", async () => {
    getQueueCounts.mockResolvedValue({
      waiting: 1, needsAttention: 0, unassigned: 0, otherInstance: 0, lastError: null,
    });
    const block = await (renderPage(), screen.findByTestId("meeting-log-queue-status"));
    expect(block).toHaveTextContent("waiting to be logged");
    expect(block).not.toHaveTextContent("needs attention");
    expect(block).not.toHaveTextContent("not assigned");
  });

  it("shows the stranded total when the credentials are half-filled", async () => {
    // A not-configured push never claims, so `attempts` never moves and no row
    // can ever escalate into "needs attention". Without this line the backlog
    // is invisible exactly when it is largest - on the page the user opened to
    // fix it.
    storage.loadOdooConfigState.mockResolvedValue({
      state: "incomplete", config: null, missing: ["apiKey"],
    });
    countAllQueued.mockResolvedValue(3);
    renderPage();
    expect(await screen.findByTestId("meeting-log-stranded")).toHaveTextContent(
      "3 meetings waiting to be logged"
    );
  });

  it("does not blow up the page when the count read fails", async () => {
    // A queue count is diagnostic. Failing it must not take the credentials
    // form - the thing the user came here to fix - down with it.
    getQueueCounts.mockRejectedValue(new Error("db locked"));
    renderPage();
    expect(await screen.findByLabelText("URL")).toBeInTheDocument();
  });

  // Review finding (Critical, round 1): the effect reset strandedTotal at the
  // top of every run but never reset queue. A save that makes a previously
  // complete config incomplete (e.g. clearing the api key) takes the effect's
  // else branch and populates strandedTotal, but the PREVIOUS instance's
  // queue object survives - so the four-group block kept rendering stale
  // counts for an instance the page no longer has credentials for, at the
  // same time as the stranded line telling the user to finish setting Odoo
  // up. Neither six existing case exercises a state transition on an
  // already-mounted component; each renders once against a fixed mock.
  it("clears the previous instance's queue counts when a save makes the config incomplete", async () => {
    getQueueCounts.mockResolvedValue({
      waiting: 2, needsAttention: 0, unassigned: 0, otherInstance: 0, lastError: null,
    });
    renderPage();
    await screen.findByTestId("meeting-log-queue-status");

    storage.loadOdooConfigState.mockResolvedValue({
      state: "incomplete", config: null, missing: ["apiKey"],
    });
    countAllQueued.mockResolvedValue(2);

    await userEvent.click(screen.getByRole("button", { name: /save/i }));

    expect(await screen.findByTestId("meeting-log-stranded")).toBeInTheDocument();
    expect(screen.queryByTestId("meeting-log-queue-status")).toBeNull();
  });
});
