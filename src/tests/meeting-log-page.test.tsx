import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

// `vi.hoisted`, not a bare `const`. Vitest hoists every `vi.mock` above the
// imports, so a factory closing over a plain outer const runs while that const
// is still in its TDZ and the file dies at load reporting "no tests" rather
// than failures. See src/tests/odoo-settings-page.test.tsx:5-16.
const db = vi.hoisted(() => ({
  listActionableRows: vi.fn(),
  countActionableQueued: vi.fn(),
  getQueueTranscript: vi.fn(),
  // Delete's zero-row CAS re-reads the row to tell "being sent right now" from
  // the generic conflict. deleteMeetingLog returns ok/conflict only, so the
  // branch has to live on the page and this is the read it makes.
  getQueueRow: vi.fn(),
}));
vi.mock("@/lib/database/meeting-log.action", () => db);

// The actions module, mocked whole: the spec's Testing -> Page section runs
// this suite with "action and actions modules mocked", so every outcome the
// page must render distinctly is fed in directly rather than reconstructed
// from a push.
const actions = vi.hoisted(() => ({
  retryMeetingLog: vi.fn(),
  assignMeetingLog: vi.fn(),
  deleteMeetingLog: vi.fn(),
}));
vi.mock("@/lib/odoo/meeting-log-actions", () => actions);

const storage = vi.hoisted(() => ({
  loadOdooConfigState: vi.fn(),
  loadOdooConfig: vi.fn(async () => null),
  requireOdooConfig: vi.fn(),
  saveOdooConfig: vi.fn(),
  clearOdooConfig: vi.fn(async () => {}),
  instanceFingerprint: vi.fn((url: string, database: string) => `${url}|${database}`),
}));
vi.mock("@/lib/storage/odoo-config.storage", () => storage);

const contacts = vi.hoisted(() => ({ listContacts: vi.fn() }));
vi.mock("@/lib/database/odoo-contacts.action", () => contacts);

// `@/lib/functions/meetwings.api` exports shouldUseMeetwingsAPI and NOTHING
// else, so mocking the leaf is complete - and `@/lib`'s barrel re-exports the
// mock. Mocking `@/lib` itself would break @/components/GetLicense.tsx:5, which
// imports captureEvent from the same barrel.
const meetwings = vi.hoisted(() => ({ shouldUseMeetwingsAPI: vi.fn(async () => false) }));
vi.mock("@/lib/functions/meetwings.api", () => meetwings);

const PROVIDER = { id: "openai", name: "OpenAI" };
const SELECTED = { provider: "openai", model: "gpt-4o", variables: {} };
const appState = vi.hoisted(() => ({
  current: {} as Record<string, unknown>,
}));
vi.mock("@/contexts", () => ({ useApp: () => appState.current }));

// The focus listener. Captured so a test can fire it, and so the blur payload
// can be fired at it - onFocusChanged fires on blur too.
const focus = vi.hoisted(() => ({
  handler: null as null | ((event: { payload: boolean }) => void),
  unlisten: vi.fn(),
}));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({
    onFocusChanged: async (cb: (event: { payload: boolean }) => void) => {
      focus.handler = cb;
      return focus.unlisten;
    },
  }),
}));

// WITHOUT THIS EVERY TEST IN THIS FILE THROWS ON RENDER: PageLayout renders
// <Header />, which calls useNavigate(), and <Promote />, which calls useApp().
// Same stub as src/tests/odoo-settings-page.test.tsx:55-64.
vi.mock("@/layouts", () => ({
  PageLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import { ESCALATE_AFTER_ATTEMPTS, STALE_CLAIM_MS } from "@/lib/odoo/meeting-log";
import { setOdooRedactor } from "@/lib/odoo/redactor";
import MeetingLog from "@/pages/meeting-log";
import type { MeetingLogListRow, OdooContact } from "@/types";

const INSTANCE = "http://h:8069|odoo";
const OTHER = "http://elsewhere:8069|other";
const CONFIG = { url: "http://h:8069", db: "odoo", login: "bob", apiKey: "sk-live-key" };

/** Seeded into the redactor AND into an error report the page must never print. */
const SECRET = "sk-live-key-9f3a";

const MEETING_AT = 1_700_000_000_000;
const CREATED_AT = 1_600_000_000_000;

const REMAINDER = "Showing 200 of the meetings waiting — more are hidden.";

function row(over: Partial<MeetingLogListRow> = {}): MeetingLogListRow {
  return {
    id: "r1",
    session_key: "s1",
    conversation_id: null,
    instance: INSTANCE,
    contact_id: 7,
    lead_id: null,
    transcript_start_at: MEETING_AT,
    transcript_end_at: MEETING_AT + 60_000,
    summary_json: null,
    attachment_id: null,
    message_id: null,
    status: "failed",
    attempts: 1,
    claimed_at: null,
    last_error: null,
    last_error_code: null,
    meeting_started_at: MEETING_AT,
    created_at: CREATED_AT,
    sent_at: null,
    ...over,
  };
}

function contact(over: Partial<OdooContact> = {}): OdooContact {
  return {
    id: 7,
    name: "Ada Lovelace",
    email: null,
    phone: null,
    companyName: null,
    parentId: null,
    isCompany: false,
    active: true,
    writeDate: "2026-01-01 00:00:00",
    isColleague: false,
    lastMeetingAt: null,
    ...over,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function renderPage() {
  const view = render(
    <MemoryRouter>
      <MeetingLog />
    </MemoryRouter>
  );
  // Settles the mount read AND ProviderConfigReader's async
  // shouldUseMeetwingsAPI leg, so a click in the test body sees a populated ref
  // rather than the pre-resolution null.
  await waitFor(() => expect(storage.loadOdooConfigState).toHaveBeenCalled());
  await act(async () => {
    await Promise.resolve();
  });
  return view;
}

function group(name: string | RegExp) {
  return within(screen.getByRole("region", { name }));
}

/**
 * Rows are addressed by `data-row-id`, not by an accessible name.
 *
 * An aria-label carrying the row id would be a test-shaped label read aloud to
 * a real user, and the row's genuine label - a date and a contact name - is
 * shared by every fixture row here, so it cannot select one.
 */
function rowElement(id: string): HTMLElement {
  const el = document.querySelector(`[data-row-id="${id}"]`);
  if (!el) throw new Error(`row ${id} is not rendered`);
  return el as HTMLElement;
}

function rowOf(id: string) {
  return within(rowElement(id));
}

async function findRow(id: string) {
  await waitFor(() => rowElement(id));
  return rowOf(id);
}

/** A promoted notice, addressed the same way and for the same reason. */
function noticeElement(id: string): HTMLElement {
  const el = document.querySelector(`[data-notice-id="${id}"]`);
  if (!el) throw new Error(`notice ${id} is not rendered`);
  return el as HTMLElement;
}

beforeEach(() => {
  // clearAllMocks wipes the CALL LOG and leaves implementations, so a
  // mockResolvedValue from one test would still be in force for every test
  // after it. Re-establish every default explicitly.
  vi.clearAllMocks();
  focus.handler = null;
  appState.current = {
    allAiProviders: [PROVIDER],
    selectedAIProvider: SELECTED,
    meetwingsApiEnabled: false,
  };
  meetwings.shouldUseMeetwingsAPI.mockResolvedValue(false);
  storage.loadOdooConfigState.mockResolvedValue({ state: "complete", config: CONFIG });
  storage.instanceFingerprint.mockImplementation(
    (url: string, database: string) => `${url}|${database}`
  );
  db.listActionableRows.mockResolvedValue([]);
  db.countActionableQueued.mockResolvedValue(0);
  db.getQueueTranscript.mockResolvedValue("");
  db.getQueueRow.mockResolvedValue(null);
  contacts.listContacts.mockResolvedValue([contact()]);
  actions.retryMeetingLog.mockResolvedValue({ kind: "ok" });
  actions.deleteMeetingLog.mockResolvedValue({ kind: "ok" });
  actions.assignMeetingLog.mockResolvedValue({ kind: "ok" });
  // Armed, so the "benign text survives" half of every redaction assertion is
  // meaningful: an unarmed redactor blanks whole strings and an absence-only
  // assertion would pass either way.
  setOdooRedactor([SECRET, CONFIG.apiKey]);
});

describe("groups", () => {
  it("renders the four groups in the documented order", async () => {
    db.listActionableRows.mockResolvedValue([
      row({ id: "na", status: "failed", attempts: 1 }),
      row({ id: "esc", status: "pending", attempts: ESCALATE_AFTER_ATTEMPTS }),
      row({ id: "un", status: "unassigned", contact_id: null }),
      row({ id: "wa", status: "pending", attempts: 0 }),
      row({ id: "held", status: "held" }),
      row({ id: "od", instance: OTHER, status: "failed", attempts: 3 }),
    ]);
    await renderPage();

    const headings = await screen.findAllByRole("heading", { level: 2 });
    expect(headings.map((h) => h.textContent)).toEqual([
      "Needs attention",
      "Not assigned to a contact",
      "Waiting to be logged",
      "Queued for a different Odoo database",
    ]);

    // Membership, not just order. `groupOf` tests instance BEFORE status, so
    // the other-database `failed` row must NOT appear in needs attention.
    expect(group("Needs attention").getAllByRole("listitem")).toHaveLength(2);
    expect(group("Not assigned to a contact").getAllByRole("listitem")).toHaveLength(1);
    expect(group("Waiting to be logged").getAllByRole("listitem")).toHaveLength(2);
    expect(group("Queued for a different Odoo database").getAllByRole("listitem")).toHaveLength(1);
  });

  it("renders the empty state and no groups when every group is empty", async () => {
    await renderPage();
    expect(await screen.findByText("No meetings waiting to be logged.")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 2 })).toBeNull();
  });
});

describe("which actions a row offers", () => {
  it("leaves Retry disabled on held and unassigned rows", async () => {
    // retryRow's predicate is status IN ('failed','pending'), so an enabled
    // Retry on `held` returns conflict and renders "changed in another window"
    // - a false explanation for a row nothing touched, repeatable per click.
    db.listActionableRows.mockResolvedValue([
      row({ id: "held", status: "held" }),
      row({ id: "un", status: "unassigned", contact_id: null }),
    ]);
    await renderPage();

    const held = await findRow("held");
    const unassigned = rowOf("un");
    expect(held.getByRole("button", { name: "Retry" })).toBeDisabled();
    expect(unassigned.getByRole("button", { name: "Retry" })).toBeDisabled();
  });

  it("enables Retry on failed rows and on pending rows at the escalation threshold", async () => {
    db.listActionableRows.mockResolvedValue([
      row({ id: "na", status: "failed", attempts: 1 }),
      row({ id: "esc", status: "pending", attempts: ESCALATE_AFTER_ATTEMPTS }),
      row({ id: "young", status: "pending", attempts: ESCALATE_AFTER_ATTEMPTS - 1 }),
    ]);
    await renderPage();

    const failed = await findRow("na");
    const escalated = rowOf("esc");
    const young = rowOf("young");
    expect(failed.getByRole("button", { name: "Retry" })).toBeEnabled();
    expect(escalated.getByRole("button", { name: "Retry" })).toBeEnabled();
    expect(young.getByRole("button", { name: "Retry" })).toBeDisabled();
  });

  it("offers Assign on unassigned rows and Reassign on current-instance failed rows", async () => {
    db.listActionableRows.mockResolvedValue([
      row({ id: "un", status: "unassigned", contact_id: null }),
      row({ id: "na", status: "failed", attempts: 1 }),
      row({ id: "wa", status: "pending", attempts: 0 }),
    ]);
    await renderPage();

    const unassigned = await findRow("un");
    const failed = rowOf("na");
    const waiting = rowOf("wa");
    expect(unassigned.getByRole("button", { name: "Assign" })).toBeEnabled();
    expect(failed.getByRole("button", { name: "Reassign" })).toBeEnabled();
    expect(waiting.getByRole("button", { name: "Assign" })).toBeDisabled();
    // Task 9 owns the dialog. Nothing may push from here yet.
    expect(actions.assignMeetingLog).not.toHaveBeenCalled();
  });

  it("disables Retry, Assign and Delete for a sending row", async () => {
    db.listActionableRows.mockResolvedValue([
      row({ id: "s", status: "sending", claimed_at: Date.now() }),
    ]);
    await renderPage();

    const sending = await findRow("s");
    expect(sending.getByRole("button", { name: "Retry" })).toBeDisabled();
    expect(sending.getByRole("button", { name: "Assign" })).toBeDisabled();
    expect(sending.getByRole("button", { name: "Delete" })).toBeDisabled();
  });

  it("disables Retry and Assign but not Delete for an other-database row", async () => {
    db.listActionableRows.mockResolvedValue([
      row({ id: "od", instance: OTHER, status: "failed", attempts: 2 }),
    ]);
    await renderPage();

    const other = await findRow("od");
    expect(other.getByRole("button", { name: "Retry" })).toBeDisabled();
    expect(other.getByRole("button", { name: "Reassign" })).toBeDisabled();
    expect(other.getByRole("button", { name: "Delete" })).toBeEnabled();
  });

  it("lets sending win over instance: an other-database sending row cannot be deleted", async () => {
    // deleteRow's CAS refuses `sending`, so an enabled Delete there is the
    // do-nothing button the group rules exist to prevent.
    db.listActionableRows.mockResolvedValue([
      row({ id: "ods", instance: OTHER, status: "sending", claimed_at: Date.now() }),
    ]);
    await renderPage();

    const other = await findRow("ods");
    expect(other.getByRole("button", { name: "Delete" })).toBeDisabled();
  });

  it("renders the interrupted copy for a sending row whose claim went stale", async () => {
    db.listActionableRows.mockResolvedValue([
      row({ id: "fresh", status: "sending", claimed_at: Date.now() }),
      row({
        id: "stale",
        status: "sending",
        claimed_at: Date.now() - STALE_CLAIM_MS - 60_000,
      }),
    ]);
    await renderPage();

    const stale = await findRow("stale");
    const fresh = rowOf("fresh");
    expect(
      stale.getByText("Interrupted. This will be retried the next time Meetwings starts.")
    ).toBeInTheDocument();
    expect(stale.queryByText("Sending…")).toBeNull();
    expect(fresh.getByText("Sending…")).toBeInTheDocument();
    // Recovery is reclaimStaleSending in the main window; an age-gated Delete
    // here would race a live push that already holds its row in memory.
    expect(stale.getByRole("button", { name: "Delete" })).toBeDisabled();
  });
});

describe("a busy row", () => {
  it("disables its buttons and issues no second CAS on a second click", async () => {
    const gate = deferred<{ kind: string }>();
    actions.retryMeetingLog.mockReturnValue(gate.promise);
    db.listActionableRows.mockResolvedValue([row({ id: "na", status: "failed" })]);
    await renderPage();

    const retry = await screen.findByRole("button", { name: "Retry" });
    await userEvent.click(retry);

    // The busy mark is set before the first await, so it is already on screen
    // while the action is still pending.
    expect(actions.retryMeetingLog).toHaveBeenCalledTimes(1);
    const item = rowOf("na");
    expect(item.getByRole("button", { name: "Retry" })).toBeDisabled();
    expect(item.getByRole("button", { name: "Delete" })).toBeDisabled();

    await userEvent.click(item.getByRole("button", { name: "Retry" }));
    expect(actions.retryMeetingLog).toHaveBeenCalledTimes(1);

    gate.resolve({ kind: "ok" });
    await waitFor(() => expect(db.listActionableRows).toHaveBeenCalledTimes(2));
  });

  it("survives a re-read that would otherwise truncate it off the 200-row cap", async () => {
    // The action's own CAS demotes the row's group rank, so the post-CAS
    // re-read can push it past the cap on a page that is already at it.
    const busy = row({ id: "busy", status: "failed", attempts: 1 });
    const filler = Array.from({ length: 200 }, (_, i) =>
      row({ id: `f${i}`, status: "unassigned", contact_id: null })
    );
    db.listActionableRows.mockResolvedValueOnce([busy, ...filler]);
    db.listActionableRows.mockResolvedValue([...filler, busy]);
    const gate = deferred<{ kind: string }>();
    actions.retryMeetingLog.mockImplementation(
      async (_id: string, deps: { onCommitted?: () => void }) => {
        deps.onCommitted?.();
        return gate.promise;
      }
    );
    await renderPage();

    const item = await findRow("busy");
    await userEvent.click(item.getByRole("button", { name: "Retry" }));
    // The CAS re-read has landed and put the row at index 200, past the cap.
    await waitFor(() => expect(db.listActionableRows).toHaveBeenCalledTimes(2));
    expect(rowElement("busy")).toBeInTheDocument();

    gate.resolve({ kind: "ok" });
    await waitFor(() => expect(db.listActionableRows).toHaveBeenCalledTimes(3));
  });

  it("pins the row OBJECT, so its status, target and error still render", async () => {
    // An id alone has no status, no target and no last_error: "union the busy
    // ids into the rendered set" renders nothing and the row still vanishes.
    const busy = row({
      id: "busy",
      status: "failed",
      attempts: 4,
      last_error: "ODOO_FAULT: partner deleted",
    });
    db.listActionableRows.mockResolvedValueOnce([busy]);
    db.listActionableRows.mockResolvedValue([]);
    const gate = deferred<{ kind: string }>();
    actions.retryMeetingLog.mockImplementation(
      async (_id: string, deps: { onCommitted?: () => void }) => {
        deps.onCommitted?.();
        return gate.promise;
      }
    );
    await renderPage();

    await userEvent.click(await screen.findByRole("button", { name: "Retry" }));
    await waitFor(() => expect(db.listActionableRows).toHaveBeenCalledTimes(2));

    const item = rowOf("busy");
    expect(item.getByText("ODOO_FAULT: partner deleted")).toBeInTheDocument();
    expect(item.getByText(/Ada Lovelace/)).toBeInTheDocument();
    expect(item.getByText("Sending…")).toBeInTheDocument();

    gate.resolve({ kind: "ok" });
    await waitFor(() => expect(db.listActionableRows).toHaveBeenCalledTimes(3));
  });
});

describe("what retry is handed", () => {
  it("passes the provider config derived from @/contexts, never null", async () => {
    // The mutant is passing null: every retry of a `failed` row (whose
    // summary_json is null by construction) then takes the fallback-body path
    // and posts "Summarization failed" to a customer's record.
    db.listActionableRows.mockResolvedValue([row({ id: "na", status: "failed" })]);
    await renderPage();

    await userEvent.click(await screen.findByRole("button", { name: "Retry" }));
    await waitFor(() => expect(actions.retryMeetingLog).toHaveBeenCalled());

    const [id, deps] = actions.retryMeetingLog.mock.calls[0];
    expect(id).toBe("na");
    expect(deps.providerConfig).toEqual({ provider: PROVIDER, selectedProvider: SELECTED });
  });

  it("re-reads the list when onCommitted fires, before the action resolves", async () => {
    // Without this the row renders its pre-click status for the whole push -
    // up to five 30s Odoo calls plus a summarize.
    const gate = deferred<{ kind: string }>();
    let committed: (() => void) | undefined;
    actions.retryMeetingLog.mockImplementation(
      async (_id: string, deps: { onCommitted?: () => void }) => {
        committed = deps.onCommitted;
        deps.onCommitted?.();
        return gate.promise;
      }
    );
    db.listActionableRows.mockResolvedValue([row({ id: "na", status: "failed" })]);
    await renderPage();

    await userEvent.click(await screen.findByRole("button", { name: "Retry" }));
    // Asserted while the action is STILL PENDING - two call counts compared
    // after it resolved would pass in either order.
    await waitFor(() => expect(db.listActionableRows).toHaveBeenCalledTimes(2));
    expect(committed).toBeTypeOf("function");

    gate.resolve({ kind: "ok" });
    await waitFor(() => expect(db.listActionableRows).toHaveBeenCalledTimes(3));
  });
});

describe("the transcript view", () => {
  it("reads the transcript on expand and not before", async () => {
    db.getQueueTranscript.mockResolvedValue("You: hello\nGuest: hi there");
    db.listActionableRows.mockResolvedValue([row({ id: "na", status: "failed" })]);
    await renderPage();

    await findRow("na");
    expect(db.getQueueTranscript).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Show transcript" }));
    expect(db.getQueueTranscript).toHaveBeenCalledWith("na");
    expect(await screen.findByText(/Guest: hi there/)).toBeInTheDocument();
  });

  it("renders an error with a retry control when the read rejects", async () => {
    db.getQueueTranscript.mockRejectedValue(new Error("disk gone"));
    db.listActionableRows.mockResolvedValue([row({ id: "na", status: "failed" })]);
    await renderPage();

    await userEvent.click(await screen.findByRole("button", { name: "Show transcript" }));
    expect(await screen.findByText("The transcript could not be read.")).toBeInTheDocument();
    // Never "removed": the text is still in the column.
    expect(screen.queryByText("Transcript removed")).toBeNull();

    db.getQueueTranscript.mockResolvedValue("You: still here");
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText(/You: still here/)).toBeInTheDocument();
  });

  it("renders the no-longer-queued line and re-reads when no row comes back", async () => {
    db.getQueueTranscript.mockResolvedValue(null);
    db.listActionableRows.mockResolvedValue([row({ id: "na", status: "failed" })]);
    await renderPage();

    await userEvent.click(await screen.findByRole("button", { name: "Show transcript" }));
    expect(await screen.findByText("This meeting is no longer in the queue.")).toBeInTheDocument();
    await waitFor(() => expect(db.listActionableRows).toHaveBeenCalledTimes(2));
  });

  it("renders Transcript removed only for an empty string", async () => {
    db.getQueueTranscript.mockResolvedValue("");
    db.listActionableRows.mockResolvedValue([row({ id: "na", status: "failed" })]);
    await renderPage();

    await userEvent.click(await screen.findByRole("button", { name: "Show transcript" }));
    expect(await screen.findByText("Transcript removed")).toBeInTheDocument();
    expect(screen.queryByText("This meeting is no longer in the queue.")).toBeNull();
    expect(screen.queryByText("The transcript could not be read.")).toBeNull();
  });
});

describe("delete", () => {
  it("confirms first, naming the meeting date and the target", async () => {
    db.listActionableRows.mockResolvedValue([row({ id: "na", status: "failed" })]);
    await renderPage();

    await userEvent.click(await screen.findByRole("button", { name: "Delete" }));
    expect(actions.deleteMeetingLog).not.toHaveBeenCalled();

    const prompt = screen.getByText(/Delete the meeting from/);
    expect(prompt.textContent).toContain(new Date(MEETING_AT).toLocaleString());
    expect(prompt.textContent).toContain("Ada Lovelace");
    // meeting_started_at ?? transcript_start_at, NEVER created_at - the shipped
    // note body uses the same fallback, and two fallbacks for one nullable
    // column let this page and the customer's chatter disagree.
    expect(prompt.textContent).not.toContain(new Date(CREATED_AT).toLocaleString());

    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(actions.deleteMeetingLog).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    await userEvent.click(screen.getByRole("button", { name: "Delete this meeting" }));
    await waitFor(() => expect(actions.deleteMeetingLog).toHaveBeenCalledWith("na"));
    expect(actions.deleteMeetingLog).toHaveBeenCalledTimes(1);
  });

  it("falls back to transcript_start_at when meeting_started_at is null", async () => {
    db.listActionableRows.mockResolvedValue([
      row({ id: "na", status: "failed", meeting_started_at: null, transcript_start_at: MEETING_AT }),
    ]);
    await renderPage();

    await userEvent.click(await screen.findByRole("button", { name: "Delete" }));
    expect(screen.getByText(/Delete the meeting from/).textContent).toContain(
      new Date(MEETING_AT).toLocaleString()
    );
  });

  it("re-reads the row on a conflict and names sending specifically", async () => {
    actions.deleteMeetingLog.mockResolvedValue({ kind: "conflict" });
    db.getQueueRow.mockResolvedValue({ id: "na", status: "sending" });
    db.listActionableRows.mockResolvedValue([row({ id: "na", status: "failed" })]);
    await renderPage();

    await userEvent.click(await screen.findByRole("button", { name: "Delete" }));
    await userEvent.click(screen.getByRole("button", { name: "Delete this meeting" }));

    expect(
      await screen.findByText("This meeting is being sent to Odoo right now.")
    ).toBeInTheDocument();
    // The re-read must follow the CAS. Two call counts would pass in either
    // order, and the order is the whole claim.
    expect(db.getQueueRow.mock.invocationCallOrder[0]).toBeGreaterThan(
      actions.deleteMeetingLog.mock.invocationCallOrder[0]
    );
  });

  it("keeps the generic copy when the conflict re-read is not sending", async () => {
    actions.deleteMeetingLog.mockResolvedValue({ kind: "conflict" });
    db.getQueueRow.mockResolvedValue({ id: "na", status: "sent" });
    db.listActionableRows.mockResolvedValue([row({ id: "na", status: "failed" })]);
    await renderPage();

    await userEvent.click(await screen.findByRole("button", { name: "Delete" }));
    await userEvent.click(screen.getByRole("button", { name: "Delete this meeting" }));

    expect(await screen.findByText("This meeting changed in another window.")).toBeInTheDocument();
    expect(screen.queryByText("This meeting is being sent to Odoo right now.")).toBeNull();
  });
});

describe("outcome copy", () => {
  /**
   * The row STAYS actionable after the action.
   *
   * Realistic for conflict / no-op / push-failed / still-sending /
   * moved-unknown / failed: every one of them leaves the row in a status
   * `listActionable` still selects, so it keeps rendering and the outcome line
   * stays inline on it. NOT realistic for ok or degraded - see `retryTerminal`.
   */
  async function retryWith(outcome: unknown) {
    actions.retryMeetingLog.mockResolvedValue(outcome);
    db.listActionableRows.mockResolvedValue([row({ id: "na", status: "failed" })]);
    await renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "Retry" }));
  }

  /**
   * The row LEAVES the list, which is what a successful retry actually does.
   *
   * `retryRow` -> push -> `status = 'sent'`, and `sent` is not in
   * listActionable's WHERE clause, so the post-action read omits it. Using
   * `retryWith` for these two is exactly why 39 green cases missed that the
   * `degraded` sentence was unreadable in production.
   */
  async function retryTerminal(outcome: unknown) {
    actions.retryMeetingLog.mockResolvedValue(outcome);
    db.listActionableRows.mockResolvedValueOnce([row({ id: "na", status: "failed" })]);
    db.listActionableRows.mockResolvedValue([]);
    await renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "Retry" }));
  }

  it("surfaces a conflict and re-reads", async () => {
    await retryWith({ kind: "conflict" });
    expect(await screen.findByText("This meeting changed in another window.")).toBeInTheDocument();
    await waitFor(() => expect(db.listActionableRows).toHaveBeenCalledTimes(2));
  });

  it("says a no-op was requeued and reached nothing, not that it was sent", async () => {
    await retryWith({ kind: "no-op" });
    expect(
      await screen.findByText(
        "This meeting was put back in the queue, but nothing reached Odoo. It will be retried the next time Meetwings starts."
      )
    ).toBeInTheDocument();
    expect(screen.queryByText(/^Sent/)).toBeNull();
  });

  it("defers a push-failed outcome to the row's own error and never claims a send", async () => {
    // The mutant is the classifier without the `after.status !== "sent"` gate:
    // one outage kills the Odoo call AND the AI call, so the page would print
    // "Sent - but the note shows the transcript's first lines" beside the row's
    // freshly written error text.
    await retryWith({ kind: "push-failed" });
    expect(
      await screen.findByText("This meeting could not be sent. The error on the row says why.")
    ).toBeInTheDocument();
    expect(screen.queryByText(/^Sent/)).toBeNull();
  });

  it("says a moved-unknown row was moved but unread, not unchanged", async () => {
    await retryWith({ kind: "moved-unknown" });
    expect(
      await screen.findByText("This meeting was moved, but the result could not be read.")
    ).toBeInTheDocument();
    expect(screen.queryByText(/Nothing on this meeting changed/)).toBeNull();
  });

  it("qualifies a degraded send rather than reporting plain success", async () => {
    // Terminal fixture: the row is gone by the time the message exists, so
    // this also proves the one sentence the summarize plumbing exists to
    // produce is readable at all.
    await retryTerminal({ kind: "degraded" });
    expect(
      await screen.findByText(
        "Sent — but the note shows the transcript's first lines, because the summary could not be generated."
      )
    ).toBeInTheDocument();
    expect(screen.queryByText("Sent to Odoo.")).toBeNull();
  });

  it("reports still-sending as its own outcome", async () => {
    await retryWith({ kind: "still-sending" });
    expect(
      await screen.findByText(
        "This meeting is still being sent. If it stays this way, it will be retried the next time Meetwings starts."
      )
    ).toBeInTheDocument();
    expect(screen.queryByText("Sent to Odoo.")).toBeNull();
  });

  it("reports a plain success distinctly", async () => {
    await retryTerminal({ kind: "ok" });
    expect(await screen.findByText("Sent to Odoo.")).toBeInTheDocument();
  });

  it("renders its own copy for a known code and never the report's message", async () => {
    await retryWith({
      kind: "failed",
      report: { code: "ODOO_AUTH_FAILED", message: `login rejected for ${SECRET}`, details: {} },
    });
    expect(
      await screen.findByText(
        "Odoo rejected the credentials. Check the login and API key on the Odoo page. Nothing on this meeting changed."
      )
    ).toBeInTheDocument();
    // Both directions. The page's own copy is present AND the secret is not -
    // an absence-only assertion passes whether or not anything was suppressed.
    expect(document.body.textContent).not.toContain(SECRET);
  });

  it("names an unknown code once rather than doubling it", async () => {
    await retryWith({
      kind: "failed",
      report: { code: "ODOO_FAULT", message: "ODOO_FAULT", details: {} },
    });
    const line = await screen.findByText(/ODOO_FAULT/);
    expect(line.textContent).toBe("The action stopped with ODOO_FAULT. Nothing on this meeting changed.");
  });
});

describe("outcomes whose row leaves the list", () => {
  it("promotes the message out of the unmounting row, still naming the meeting", async () => {
    // A successful retry writes status = 'sent', which listActionable's WHERE
    // clause does not select - so the row is gone on the very next read and an
    // inline-only message lives about one DB round trip. This sentence is the
    // deliverable of the whole summarize plumbing.
    actions.retryMeetingLog.mockResolvedValue({ kind: "degraded" });
    db.listActionableRows.mockResolvedValueOnce([row({ id: "na", status: "failed" })]);
    db.listActionableRows.mockResolvedValue([]);
    await renderPage();

    await userEvent.click(await screen.findByRole("button", { name: "Retry" }));

    const notice = await waitFor(() => noticeElement("na"));
    expect(notice.textContent).toContain(
      "Sent — but the note shows the transcript's first lines, because the summary could not be generated."
    );
    // The label was captured before the `finally` cleared the pin; the pinned
    // snapshot is the only place the date and the target name survive.
    expect(notice.textContent).toContain(new Date(MEETING_AT).toLocaleString());
    expect(notice.textContent).toContain("Ada Lovelace");

    // The row really is gone: this is a promotion, not the inline line
    // surviving because the fixture kept the row alive.
    expect(document.querySelector('[data-row-id="na"]')).toBeNull();
    expect(screen.getByText("No meetings waiting to be logged.")).toBeInTheDocument();

    // Persistent until dismissed - not a toast on a timer.
    await userEvent.click(within(notice).getByRole("button", { name: /^Dismiss/ }));
    expect(document.querySelector('[data-notice-id="na"]')).toBeNull();
  });

  it("keeps one notice per row when two rows finish", async () => {
    // The busy Set is plural by design, so the region must be a LIST. A
    // newest-replaces slot silently drops one message - and the one it drops
    // could be the `degraded` line this whole region exists to make readable.
    const gateA = deferred<{ kind: string }>();
    const gateB = deferred<{ kind: string }>();
    actions.retryMeetingLog.mockImplementation((id: string) =>
      id === "a" ? gateA.promise : gateB.promise
    );
    db.listActionableRows.mockResolvedValueOnce([
      row({ id: "a", status: "failed" }),
      row({ id: "b", status: "failed" }),
    ]);
    db.listActionableRows.mockResolvedValue([]);
    await renderPage();

    await findRow("a");
    await userEvent.click(rowOf("a").getByRole("button", { name: "Retry" }));
    await userEvent.click(rowOf("b").getByRole("button", { name: "Retry" }));

    gateA.resolve({ kind: "degraded" });
    await waitFor(() => noticeElement("a"));
    gateB.resolve({ kind: "ok" });
    await waitFor(() => noticeElement("b"));

    expect(noticeElement("a").textContent).toContain(
      "because the summary could not be generated"
    );
    expect(noticeElement("b").textContent).toContain("Sent to Odoo.");
    expect(document.querySelectorAll("[data-notice-id]")).toHaveLength(2);
  });

  it("promotes both rows when their two reloads OVERLAP", async () => {
    // The serialized case above cannot see this: it awaits notice A before
    // resolving B, so the two reload round trips never overlap.
    //
    // Here both actions settle before either outcome is read, so A's
    // token-ordered reload is still in flight when B's starts and bumps the
    // token past it. A's read then commits NOTHING, while B's commits a list
    // that already excludes A - because A pushed successfully and `sent` is
    // outside listActionable's WHERE clause. A's pin and busy flag clear
    // regardless, so any implementation that decides promotion from its own
    // reload's result drops A's message entirely.
    const gateA = deferred<{ kind: string }>();
    const gateB = deferred<{ kind: string }>();
    actions.retryMeetingLog.mockImplementation((id: string) =>
      id === "a" ? gateA.promise : gateB.promise
    );
    db.listActionableRows.mockResolvedValueOnce([
      row({ id: "a", status: "failed" }),
      row({ id: "b", status: "failed" }),
    ]);
    db.listActionableRows.mockResolvedValue([]);
    await renderPage();

    await findRow("a");
    await userEvent.click(rowOf("a").getByRole("button", { name: "Retry" }));
    await userEvent.click(rowOf("b").getByRole("button", { name: "Retry" }));

    await act(async () => {
      gateA.resolve({ kind: "degraded" });
      gateB.resolve({ kind: "ok" });
    });

    await waitFor(() => noticeElement("a"));
    await waitFor(() => noticeElement("b"));
    expect(noticeElement("a").textContent).toContain(
      "because the summary could not be generated"
    );
    expect(noticeElement("b").textContent).toContain("Sent to Odoo.");
    expect(document.querySelector('[data-row-id="a"]')).toBeNull();
  });

  it("says a deleted meeting was removed, never that it was sent", async () => {
    // deleteMeetingLog returns {kind:"ok"} like every other action, but the
    // module's own comment is "No push, ever" - so one shared `ok` string tells
    // a user their DELETED meeting reached a customer's record.
    actions.deleteMeetingLog.mockResolvedValue({ kind: "ok" });
    db.listActionableRows.mockResolvedValueOnce([row({ id: "na", status: "failed" })]);
    db.listActionableRows.mockResolvedValue([]);
    await renderPage();

    await userEvent.click(await screen.findByRole("button", { name: "Delete" }));
    await userEvent.click(screen.getByRole("button", { name: "Delete this meeting" }));

    const notice = await waitFor(() => noticeElement("na"));
    expect(notice.textContent).toContain("Removed from the queue. Nothing was sent to Odoo.");
    // The negative clause is lower-case "sent"; the shared success string is
    // "Sent to Odoo." So this fails the moment delete reuses it.
    expect(document.body.textContent).not.toContain("Sent to Odoo.");
  });
});

describe("last_error", () => {
  it("renders from the column in every group, and keeps the secret out", async () => {
    db.listActionableRows.mockResolvedValue([
      row({ id: "na", status: "failed", attempts: 2, last_error: "ODOO_FAULT: partner deleted" }),
      row({
        id: "un",
        status: "unassigned",
        contact_id: null,
        attempts: 1,
        last_error: "ODOO_FAULT: no contact chosen",
      }),
      // A retryable failure leaves the row `pending` below the escalation
      // threshold, i.e. in WAITING - gating the error on needs-attention would
      // make that failed retry render as an unexplained success.
      row({
        id: "wa",
        status: "pending",
        attempts: 1,
        last_error: "ODOO_UNREACHABLE: connection refused",
      }),
      row({
        id: "od",
        instance: OTHER,
        status: "failed",
        attempts: 3,
        last_error: "ODOO_AUTH_FAILED: key [REDACTED]",
      }),
    ]);
    await renderPage();

    expect(await screen.findByText("ODOO_FAULT: partner deleted")).toBeInTheDocument();
    expect(screen.getByText("ODOO_FAULT: no contact chosen")).toBeInTheDocument();
    expect(screen.getByText("ODOO_UNREACHABLE: connection refused")).toBeInTheDocument();
    expect(screen.getByText("ODOO_AUTH_FAILED: key [REDACTED]")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(SECRET);
    // The attempt count travels with the error.
    expect(
      rowOf("na").getByText(/attempt 2/)
    ).toBeInTheDocument();
  });
});

describe("the cap", () => {
  it("renders 200 of 201 rows plus the bounded remainder line", async () => {
    db.listActionableRows.mockResolvedValue(
      Array.from({ length: 201 }, (_, i) =>
        row({ id: `r${i}`, status: "unassigned", contact_id: null })
      )
    );
    await renderPage();

    await screen.findByRole("region", { name: "Not assigned to a contact" });
    expect(screen.getAllByRole("listitem")).toHaveLength(200);
    expect(screen.getByText(REMAINDER)).toBeInTheDocument();
  });

  it("shows no remainder line at exactly 200", async () => {
    db.listActionableRows.mockResolvedValue(
      Array.from({ length: 200 }, (_, i) =>
        row({ id: `r${i}`, status: "unassigned", contact_id: null })
      )
    );
    await renderPage();

    await screen.findByRole("region", { name: "Not assigned to a contact" });
    expect(screen.queryByText(REMAINDER)).toBeNull();
  });
});

describe("when Odoo is not configured", () => {
  it("counts the actionable backlog and offers no groups or actions", async () => {
    // Seeded with only `failed` and `unassigned` rows, which countAllQueued's
    // ('held','pending','sending') predicate would count as zero - a blank page
    // while rows are queued.
    storage.loadOdooConfigState.mockResolvedValue({
      state: "incomplete",
      config: null,
      missing: ["apiKey"],
    });
    db.countActionableQueued.mockResolvedValue(2);
    await renderPage();

    const line = await screen.findByText(/^2 meetings are waiting\./);
    expect(line.textContent).toContain("Finish setting Odoo up on the");
    expect(screen.getByRole("link", { name: "Odoo page" })).toHaveAttribute("href", "/odoo");

    expect(db.listActionableRows).not.toHaveBeenCalled();
    expect(screen.queryByRole("heading", { level: 2 })).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Assign" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
  });
});

describe("the contact map", () => {
  it("falls back to Contact #<id> and re-resolves on the same cycle as the list", async () => {
    // purgeOtherInstances deletes other-instance contacts on every sync, so a
    // miss is normal, not exceptional.
    contacts.listContacts.mockResolvedValueOnce([]);
    contacts.listContacts.mockResolvedValue([contact({ id: 7, name: "Ada Lovelace" })]);
    db.listActionableRows.mockResolvedValue([row({ id: "na", status: "failed", contact_id: 7 })]);
    await renderPage();

    expect(await screen.findByText(/Contact #7/)).toBeInTheDocument();

    act(() => focus.handler?.({ payload: true }));
    expect(await screen.findByText(/Ada Lovelace/)).toBeInTheDocument();
    // Same cycle: one contact read per list read, never a single mount read.
    expect(contacts.listContacts).toHaveBeenCalledTimes(db.listActionableRows.mock.calls.length);
  });

  it("marks a row targeting an opportunity", async () => {
    db.listActionableRows.mockResolvedValue([
      row({ id: "na", status: "failed", contact_id: 7, lead_id: 42 }),
    ]);
    await renderPage();
    expect(await screen.findByText("Ada Lovelace (opportunity)")).toBeInTheDocument();
  });
});

describe("a queue that cannot be read", () => {
  it("says so, and does not claim a meeting was left unchanged", async () => {
    db.listActionableRows.mockRejectedValue(new Error("database is locked"));
    await renderPage();

    expect(
      await screen.findByText("The meetings waiting to be logged could not be read.")
    ).toBeInTheDocument();
    // describeFailure's trailing clause is about an ACTION that stopped before
    // its CAS. This path never named a meeting, so the clause is off-key here.
    expect(document.body.textContent).not.toContain("Nothing on this meeting changed.");
    // And a read that failed must not look like a queue that is empty.
    expect(screen.queryByText("No meetings waiting to be logged.")).toBeNull();
    // Never the raw thrown text: the page renders the CODE's copy only.
    expect(document.body.textContent).not.toContain("database is locked");
  });
});

describe("refreshing", () => {
  it("re-resolves the config on focus, so a cleared API key is caught", async () => {
    // A complete -> incomplete transition emits NO event: becameUsable is
    // !previousUsable and instanceChanged is false when url and db are
    // unchanged. Focus is the only trigger that catches it.
    db.listActionableRows.mockResolvedValue([row({ id: "na", status: "failed" })]);
    await renderPage();
    await findRow("na");

    storage.loadOdooConfigState.mockResolvedValue({
      state: "incomplete",
      config: null,
      missing: ["apiKey"],
    });
    db.countActionableQueued.mockResolvedValue(1);
    act(() => focus.handler?.({ payload: true }));

    expect(await screen.findByText(/^1 meeting is waiting\./)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("ignores the blur half of onFocusChanged", async () => {
    await renderPage();
    await waitFor(() => expect(db.listActionableRows).toHaveBeenCalledTimes(1));

    act(() => focus.handler?.({ payload: false }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(db.listActionableRows).toHaveBeenCalledTimes(1);
  });
});
