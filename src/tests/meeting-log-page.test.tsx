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
  // reload's badge read (Task 11). Left undefined here would throw inside the
  // hook's Promise.all and every test in this file would hit the single catch.
  listConversationBadgeRows: vi.fn(),
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
  // The per-target actions QueueRow's own Retry/Remove buttons call through
  // index.tsx's handlers. Not exercised by any full-page test in this file
  // today (Task 13's given tests render <QueueRow> directly instead), but
  // left undefined here would throw "not a function" the day one does.
  retryTarget: vi.fn(),
  removeQueueTarget: vi.fn(),
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

// The merged page mounts `useHistory`, which calls getAllConversations through
// the `@/lib` barrel in a mount effect. Mocked at the LEAF for the reason the
// meetwings.api mock below states; unmocked it reaches
// @tauri-apps/plugin-sql under jsdom. This suite is about the queue, so the
// list stays empty in every test here.
const history = vi.hoisted(() => ({
  getAllConversations: vi.fn(),
  deleteConversation: vi.fn(),
}));
vi.mock("@/lib/database/chat-history.action", () => history);

// AssignDialog's own two live dependencies. Mocked at the LEAF, not at
// `@/lib/odoo`: the barrel re-exports both, so the mock is what every importer
// sees, and mocking the barrel would have to restate a dozen unrelated exports.
// `DEFAULT_TIMEOUT_MS` and `OPPORTUNITY_LIMIT` are restated because
// `@/lib/odoo/index.ts` does `export * from` both modules.
const client = vi.hoisted(() => ({
  createOdooClient: vi.fn(),
  DEFAULT_TIMEOUT_MS: 30_000,
}));
vi.mock("@/lib/odoo/client", () => client);

const opportunities = vi.hoisted(() => ({
  fetchOpportunities: vi.fn(),
  OPPORTUNITY_LIMIT: 20,
  // NOT a spy. It is a pure string function the dialog calls during render, and
  // a `vi.fn()` returning undefined renders every row with a blank kind - the
  // one thing these rows now have to state.
  kindLabel: (type: string) => (type === "lead" ? "Lead" : "Opportunity"),
}));
vi.mock("@/lib/odoo/opportunities", () => opportunities);

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
import MeetingLog from "@/pages/meetings";
// LEAF paths, not `@/pages/meetings/components`. That barrel now also carries
// View.tsx, which imports `@/hooks` - whose barrel star-exports useCompletion
// and useSystemAudio, none of which this file mocks.
import { AssignDialog } from "@/pages/meetings/components/AssignDialog";
import { QueueRow } from "@/pages/meetings/components/QueueRow";
import type { MeetingLogListRow, MeetingLogTarget, OdooContact, OdooOpportunity } from "@/types";

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

function opportunity(over: Partial<OdooOpportunity> = {}): OdooOpportunity {
  return {
    id: 500,
    name: "Heat pumps for the north wing",
    type: "opportunity",
    stageName: "Proposal",
    partnerId: 7,
    partnerName: "Ada Lovelace",
    contactName: null,
    email: null,
    ...over,
  };
}

/**
 * The object `createOdooClient` returns, held module-wide so a test can assert
 * the SAME instance reached both opportunity lookups. A fresh object per call
 * would make "at most one client" pass on identity by accident.
 */
const CLIENT = { authenticate: vi.fn(), execute: vi.fn() };

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

/**
 * Radix PORTALS the dialog to `document.body`, so it is never inside the row
 * that opened it - `within(rowElement(id))` finds nothing. Everything the
 * dialog owns is queried through here.
 */
function dialog() {
  return within(screen.getByRole("dialog"));
}

async function openAssign(id: string, label: "Assign" | "Reassign" = "Assign") {
  await findRow(id);
  await userEvent.click(rowOf(id).getByRole("button", { name: label }));
  await screen.findByRole("dialog");
}

/** Opens and waits for step 0 to settle, so the picker is live. */
async function openAssignReady(id: string, label: "Assign" | "Reassign" = "Assign") {
  await openAssign(id, label);
  await screen.findByPlaceholderText("Search contacts");
}

/**
 * The other-database group is COLLAPSED on the merged page: it renders one line
 * saying how many meetings are queued elsewhere, with its rows behind a toggle.
 * Nothing in it can be sent while the credentials point at another database, so
 * it must not push the rows that do need the user off the top of the page - but
 * it must stay reachable, because hiding a backlog silently is how one is lost.
 */
async function expandOtherDatabase() {
  await userEvent.click(await screen.findByRole("button", { name: "Show these meetings" }));
}

/** A promoted notice, addressed the same way and for the same reason. */
function noticeElement(id: string): HTMLElement {
  const el = document.querySelector(`[data-notice-id="${id}"]`);
  if (!el) throw new Error(`notice ${id} is not rendered`);
  return el as HTMLElement;
}

beforeEach(() => {
  // Any test that installs fake timers restores them itself; this is the net
  // for one that throws before its restore runs. A leaked fake clock makes
  // every later `waitFor` in the file hang until the suite times out.
  vi.useRealTimers();
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
  // AssignDialog's step 0. Re-established every test for the reason above: a
  // `mockRejectedValue` left in force by the poisoned-ref case would make every
  // later dialog open on a credentials failure.
  storage.requireOdooConfig.mockResolvedValue(CONFIG);
  storage.instanceFingerprint.mockImplementation(
    (url: string, database: string) => `${url}|${database}`
  );
  client.createOdooClient.mockReturnValue(CLIENT);
  opportunities.fetchOpportunities.mockResolvedValue([]);
  db.listActionableRows.mockResolvedValue([]);
  db.countActionableQueued.mockResolvedValue(0);
  db.getQueueTranscript.mockResolvedValue("");
  db.getQueueRow.mockResolvedValue(null);
  db.listConversationBadgeRows.mockResolvedValue([]);
  contacts.listContacts.mockResolvedValue([contact()]);
  history.getAllConversations.mockResolvedValue([]);
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
    // COLLAPSED, so it is a count rather than a row. The membership claim is
    // unchanged - one row landed here and not in needs attention - only where
    // that row is drawn.
    expect(
      group("Queued for a different Odoo database").getByText(
        /^1 meeting is queued for a different Odoo database\./
      )
    ).toBeInTheDocument();
    expect(
      group("Queued for a different Odoo database").queryAllByRole("listitem")
    ).toHaveLength(0);
  });

  it("renders no strip at all when every group is empty", async () => {
    // The strip is rendered only when it has something in it. The queue page's
    // "No meetings waiting to be logged." sentence retired with that page: this
    // page always has the conversation list to show instead, so an empty queue
    // needs no sentence of its own.
    await renderPage();
    await waitFor(() => expect(db.listActionableRows).toHaveBeenCalled());
    expect(screen.queryByRole("heading", { level: 2 })).toBeNull();
    expect(document.querySelector("[data-row-id]")).toBeNull();
    expect(screen.queryByText("No meetings waiting to be logged.")).toBeNull();
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

    await expandOtherDatabase();
    const other = rowOf("od");
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

    await expandOtherDatabase();
    const other = rowOf("ods");
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

  it("does not promise a retry for a stale row on another database", async () => {
    // reclaimStaleSending's predicate has no instance filter, so it DOES flip
    // this row back to `pending`. The push that would follow comes from
    // selectSweepable, which is scoped to `instance = ?` - so nothing ever
    // pushes it while credentials point elsewhere, and the shared copy's "will
    // be retried the next time Meetwings starts" is a promise nothing keeps.
    db.listActionableRows.mockResolvedValue([
      row({ id: "mine", status: "sending", claimed_at: Date.now() - STALE_CLAIM_MS - 60_000 }),
      row({
        id: "theirs",
        instance: OTHER,
        status: "sending",
        claimed_at: Date.now() - STALE_CLAIM_MS - 60_000,
      }),
    ]);
    await renderPage();

    await findRow("mine");
    await expandOtherDatabase();
    const theirs = rowOf("theirs");
    expect(theirs.getByText(/will not be retried until Meetwings points back/)).toBeInTheDocument();
    expect(
      theirs.queryByText("Interrupted. This will be retried the next time Meetwings starts.")
    ).toBeNull();
    // The same-database row keeps the promise that IS kept for it - so this
    // fails if the copy is simply swapped rather than branched.
    expect(
      rowOf("mine").getByText(
        "Interrupted. This will be retried the next time Meetwings starts."
      )
    ).toBeInTheDocument();
  });

  it("flips a fresh claim to interrupted with no re-read and no user action", async () => {
    // `shouldAdvanceTime` so renderPage's waitFor still polls under a fake
    // clock. The clock has to be faked at all because advanceTimersByTime must
    // move `Date.now()` as well as fire the interval - a build whose `toFake`
    // excluded Date would run the tick and read the same instant straight back,
    // and the assertion below would pass while proving nothing. Hence the
    // explicit check that the clock moved.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      db.listActionableRows.mockResolvedValue([
        row({ id: "live", status: "sending", claimed_at: Date.now() }),
      ]);
      await renderPage();

      const startedAt = Date.now();
      const live = await findRow("live");
      expect(live.getByText("Sending…")).toBeInTheDocument();
      const readsBefore = db.listActionableRows.mock.calls.length;

      await act(async () => {
        vi.advanceTimersByTime(STALE_CLAIM_MS + 60_000);
      });

      expect(Date.now() - startedAt).toBeGreaterThan(STALE_CLAIM_MS);
      expect(
        rowOf("live").getByText(
          "Interrupted. This will be retried the next time Meetwings starts."
        )
      ).toBeInTheDocument();
      expect(rowOf("live").queryByText("Sending…")).toBeNull();
      // THE MUTANT THIS KILLS: delete the page's STALE_TICK_MS interval, or
      // hand QueueRow a `now` it computes itself behind the memo, and this row
      // keeps saying "Sending…" indefinitely. Nothing else could have repainted
      // it - the row object never changed and the list was never re-read.
      expect(db.listActionableRows).toHaveBeenCalledTimes(readsBefore);
    } finally {
      vi.useRealTimers();
    }
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

/**
 * Task 14, decision 6: Task 13's review left this gap explicitly for this
 * task to close - nothing in index.tsx had direct test coverage, so the
 * `push-partial` copy (the single line this whole feature exists to
 * produce) was verified only by a reviewer reading it. These two exercise
 * `targetOutcomeCopy` and `outcomeCopy`'s `push-partial` branch through the
 * REAL page, not a directly-rendered `<QueueRow>`.
 */
describe("push-partial and per-target outcome copy, through the real page", () => {
  function targetFixture(over: Partial<MeetingLogTarget> = {}): MeetingLogTarget {
    return {
      id: "t1",
      rowId: "na",
      model: "res.partner",
      resId: 1,
      name: "Ada Lovelace",
      status: "pending",
      attachmentId: null,
      messageId: null,
      lastError: null,
      lastErrorCode: null,
      createdAt: 0,
      sentAt: null,
      ...over,
    };
  }

  it("names the sent count on a push-partial retry, and never calls a pending target failed", async () => {
    actions.retryMeetingLog.mockResolvedValue({
      kind: "push-partial",
      sentCount: 2,
      failedCount: 1,
      pendingCount: 1,
    });
    db.listActionableRows.mockResolvedValue([row({ id: "na", status: "failed" })]);
    await renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "Retry" }));

    const line = await screen.findByText(/^Sent to 2 of 4\./);
    expect(line.textContent).toContain("1 will be retried automatically.");
    expect(line.textContent).toContain("1 needs attention — see below.");
    // sentCount is stated first and never folded into failedCount/pendingCount
    // - the constraint Task 10 exists to enforce, and the one no line in this
    // feature may violate: this must never say nothing reached Odoo when
    // something did, and the one PENDING target (queued for automatic retry)
    // must never be counted among the one that actually failed.
    expect(line.textContent).not.toMatch(/nothing reached Odoo/);
    expect(line.textContent).not.toMatch(/2 need attention/);
  });

  it("does not render removed-parent-stale with conflict's 'this did not happen' copy", async () => {
    // TargetActionOutcome's own doc comment (meeting-log-actions.ts) states
    // the prohibition explicitly: the DELETE already committed here - only
    // the parent's derived status lost its own race on the way out - so
    // conflict's copy would be false about a removal that already happened.
    actions.removeQueueTarget.mockResolvedValue({ kind: "removed-parent-stale" });
    db.listActionableRows.mockResolvedValue([
      row({ id: "na", status: "failed", targets: [targetFixture({ status: "failed" })] }),
    ]);
    await renderPage();
    await userEvent.click(await screen.findByRole("button", { name: /expand/i }));
    await userEvent.click(await screen.findByRole("button", { name: "Remove" }));

    expect(
      await screen.findByText(
        "Removed from this meeting. The overall status will catch up shortly."
      )
    ).toBeInTheDocument();
    expect(screen.queryByText("Nothing changed. Try again.")).toBeNull();
    expect(screen.queryByText("This meeting changed in another window.")).toBeNull();
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
    // And the strip went with it: the last row leaving is what empties it.
    expect(screen.queryByRole("heading", { level: 2 })).toBeNull();

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

  it("says the opposite when the row had already reached Odoo", async () => {
    // The row on screen is `held`; on disk the main window's sweep has already
    // pushed it. This window re-reads on focus, mount and action only, so the
    // click lands against a `sent` row. Telling the user "Nothing was sent to
    // Odoo." here is false about a customer's chatter, and the transcript that
    // was the only local record of it is blanked in the same statement.
    actions.deleteMeetingLog.mockResolvedValue({ kind: "deleted-after-send" });
    db.listActionableRows.mockResolvedValueOnce([row({ id: "h", status: "held" })]);
    db.listActionableRows.mockResolvedValue([]);
    await renderPage();

    await userEvent.click(await screen.findByRole("button", { name: "Delete" }));
    await userEvent.click(screen.getByRole("button", { name: "Delete this meeting" }));

    const notice = await waitFor(() => noticeElement("h"));
    expect(notice.textContent).toContain("it had already been sent to Odoo");
    expect(notice.textContent).toContain("was not removed");
    // The mutant: map `deleted-after-send` to DELETED_COPY and this passes
    // everything except these two lines.
    expect(document.body.textContent).not.toContain("Nothing was sent to Odoo.");
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
    // Still rendered from the column in the other-database group too - it is
    // collapsed, not dropped, so the error is one click away rather than gone.
    await expandOtherDatabase();
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

  // A lead picked out of the search has NO res.partner behind it, so the row
  // carries a lead_id and no contact_id. Reading that as "No contact chosen"
  // offers to assign a meeting that is already correctly targeted - and the
  // queue stores no lead name, so the id is all there is to name it by.
  it("does not call a lead-only row unassigned", async () => {
    db.listActionableRows.mockResolvedValue([
      row({ id: "lo", status: "pending", contact_id: null, lead_id: 42 }),
    ]);
    await renderPage();
    expect(await screen.findByText("Lead or opportunity #42")).toBeInTheDocument();
    expect(screen.queryByText("No contact chosen")).toBeNull();
  });

  // NEUTRAL between the two kinds, and that is the assertion. The queue stores
  // `lead_id` and never its type, so naming one would be a guess printed beside
  // a customer's name - the marker's job is only to say "not the contact
  // record".
  it("marks a row targeting a crm.lead without guessing which kind", async () => {
    db.listActionableRows.mockResolvedValue([
      row({ id: "na", status: "failed", contact_id: 7, lead_id: 42 }),
    ]);
    await renderPage();
    expect(await screen.findByText("Ada Lovelace (lead or opportunity)")).toBeInTheDocument();
    expect(screen.queryByText("Ada Lovelace (opportunity)")).toBeNull();
  });

  // Final whole-branch review, Critical 1: `insertQueueRow`
  // (meeting-log.action.ts) writes `contact_id`/`lead_id` as `null, null` for
  // EVERY row it creates post-migration-14 - the target rows are the source
  // of truth now. The page's own `targetNameOf` used to read only those two
  // dead columns, so it printed "No contact chosen" for a row like this one
  // no matter how many real targets it carried. No fixture in this suite
  // crossed that seam before: `row()` defaults `contact_id: 7`.
  it("resolves the heading from a post-migration row's targets, not its null legacy columns", async () => {
    const target: MeetingLogTarget = {
      id: "t1", rowId: "post14", model: "res.partner", resId: 7,
      name: "Ada Lovelace", status: "failed", attachmentId: null, messageId: null,
      lastError: "ODOO_FAULT", lastErrorCode: "ODOO_FAULT",
      createdAt: CREATED_AT, sentAt: null,
    };
    db.listActionableRows.mockResolvedValue([
      row({ id: "post14", status: "failed", contact_id: null, lead_id: null, targets: [target] }),
    ]);
    await renderPage();

    const post14 = await findRow("post14");
    // TWO matches, not one: the row's own heading AND the per-target line
    // underneath it both say the target's real name. Buggy code (reading
    // contact_id/lead_id, both null on a post-migration row) leaves only the
    // per-target line saying it - the heading itself would still read "No
    // contact chosen".
    expect(post14.getAllByText("Ada Lovelace")).toHaveLength(2);
    expect(post14.queryByText("No contact chosen")).toBeNull();
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
    // And a read that failed must not look like a queue that is empty. The
    // sentence that used to carry that claim is gone with the queue page, so
    // what stands in for it here is that the strip renders nothing at all -
    // there is no group heading and no row claiming a state was read.
    expect(screen.queryByRole("heading", { level: 2 })).toBeNull();
    expect(document.querySelector("[data-row-id]")).toBeNull();
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

/**
 * Task 14, brief Step 1: `<AssignDialog>` rendered DIRECTLY, not through the
 * full page - these four assert the dialog's own contract in isolation.
 * Tests 4 and 5 from the brief live elsewhere in this file instead of being
 * duplicated here: 4 as "QueueRow > is unreachable on a row with a sent
 * target" (it is QueueRow's own render gate, not the dialog's), and 5 as
 * "what the assign dialog hands up > surfaces a zero-row assign CAS instead
 * of swallowing it" (it needs the page's own outcome-copy rendering, which a
 * bare `<AssignDialog>` has nowhere to show).
 */
describe("AssignDialog", () => {
  const CHRISTIAN = contact({ id: 1, name: "Christian Carron" });
  const BENTLEY_AS = contact({ id: 3, name: "Bentley AS" });

  function assignDialogProps() {
    return {
      row: row({ id: "un", status: "unassigned", contact_id: null }),
      instance: INSTANCE,
      onConfirm: vi.fn(),
      onCancel: vi.fn(),
    };
  }

  it("hands up a list of targets", async () => {
    contacts.listContacts.mockResolvedValue([CHRISTIAN, BENTLEY_AS]);
    const props = assignDialogProps();
    render(<AssignDialog {...props} />);
    await screen.findByPlaceholderText("Search contacts");

    await userEvent.click(screen.getByRole("button", { name: /add Christian Carron/i }));
    await userEvent.click(screen.getByRole("button", { name: /add Bentley AS/i }));
    await userEvent.click(screen.getByRole("button", { name: "Log this meeting" }));

    expect(props.onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({
        targets: [
          { model: "res.partner", resId: 1, name: "Christian Carron" },
          { model: "res.partner", resId: 3, name: "Bentley AS" },
        ],
      })
    );
  });

  it("lets a target be taken back off before confirming", async () => {
    // Decision 5 (carried into this task): Confirm is gated on a non-empty
    // selection, so the brief's own snippet - confirming an EMPTY set - is
    // unreachable against this implementation on purpose; see the dedicated
    // "gates Confirm" test below for that guard itself. The same underlying
    // guarantee (a target can be removed before Confirm is clicked) is
    // proven here over TWO targets, leaving one behind instead of zero.
    contacts.listContacts.mockResolvedValue([CHRISTIAN, BENTLEY_AS]);
    const props = assignDialogProps();
    render(<AssignDialog {...props} />);
    await screen.findByPlaceholderText("Search contacts");

    await userEvent.click(screen.getByRole("button", { name: /add Christian Carron/i }));
    await userEvent.click(screen.getByRole("button", { name: /add Bentley AS/i }));
    await userEvent.click(screen.getByRole("button", { name: /added Christian Carron/i }));
    await userEvent.click(screen.getByRole("button", { name: "Log this meeting" }));

    expect(props.onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({
        targets: [{ model: "res.partner", resId: 3, name: "Bentley AS" }],
      })
    );
  });

  it("gates Confirm on a non-empty selection", async () => {
    contacts.listContacts.mockResolvedValue([CHRISTIAN]);
    const props = assignDialogProps();
    render(<AssignDialog {...props} />);
    await screen.findByPlaceholderText("Search contacts");

    expect(screen.getByRole("button", { name: "Log this meeting" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: /add Christian Carron/i }));
    expect(screen.getByRole("button", { name: "Log this meeting" })).toBeEnabled();
    await userEvent.click(screen.getByRole("button", { name: /added Christian Carron/i }));
    expect(screen.getByRole("button", { name: "Log this meeting" })).toBeDisabled();
    expect(props.onConfirm).not.toHaveBeenCalled();
  });

  it("enforces the cap in the dialog", async () => {
    const letters = ["A", "B", "C", "D", "E", "F"];
    contacts.listContacts.mockResolvedValue(
      letters.map((n, i) => contact({ id: i + 1, name: n }))
    );
    const props = assignDialogProps();
    render(<AssignDialog {...props} />);
    await screen.findByPlaceholderText("Search contacts");

    for (const n of ["A", "B", "C", "D", "E"]) {
      await userEvent.click(screen.getByRole("button", { name: new RegExp(`add ${n}`, "i") }));
    }
    expect(screen.getByRole("button", { name: /add F/i })).toHaveAttribute("aria-disabled", "true");
  });
});

describe("the assign dialog's client", () => {
  it("builds ONE client across two opportunity lookups in one session", async () => {
    // Slice 1's open follow-up: useOdooTarget.ts:162-167 builds a fresh client
    // per selection, costing an extra `authenticate` each time. The naive
    // `if (!ref.current) ref.current = createOdooClient(await requireOdooConfig())`
    // repeats it - the check-and-assign spans a yield, so two quick selections
    // both observe null and both build.
    contacts.listContacts.mockResolvedValue([
      contact(),
      contact({ id: 8, name: "Bea Nordvik", parentId: 9 }),
    ]);
    db.listActionableRows.mockResolvedValue([
      row({ id: "un", status: "unassigned", contact_id: null }),
    ]);
    await renderPage();
    await openAssignReady("un");

    await userEvent.click(dialog().getByRole("button", { name: "Ada Lovelace" }));
    await waitFor(() => expect(opportunities.fetchOpportunities).toHaveBeenCalledTimes(1));
    await userEvent.click(dialog().getByRole("button", { name: "Bea Nordvik" }));
    await waitFor(() => expect(opportunities.fetchOpportunities).toHaveBeenCalledTimes(2));

    expect(client.createOdooClient).toHaveBeenCalledTimes(1);
    expect(storage.requireOdooConfig).toHaveBeenCalledTimes(1);
    // The SAME instance, not merely the same call count: a per-lookup build
    // that happened to be memoised on the config would pass a count assertion.
    expect(opportunities.fetchOpportunities.mock.calls[0][0]).toBe(CLIENT);
    expect(opportunities.fetchOpportunities.mock.calls[1][0]).toBe(CLIENT);
    // The parent is carried through, or a company's deals never surface - and
    // so are the name and email, which are the only way an UNLINKED lead is
    // ever found.
    expect(opportunities.fetchOpportunities.mock.calls[1][1]).toMatchObject({
      id: 8,
      parentId: 9,
      name: "Bea Nordvik",
    });
  });

  it("builds a fresh client for a SECOND dialog session", async () => {
    // "One client per dialog session" only means anything if the dialog is
    // mounted only while open. Rendered once at page level behind an `open`
    // prop, the ref outlives every session and this count stays at 1 - the
    // exact silent widening the spec's lifecycle clause exists to prevent.
    db.listActionableRows.mockResolvedValue([
      row({ id: "un", status: "unassigned", contact_id: null }),
    ]);
    await renderPage();

    await openAssignReady("un");
    await userEvent.click(dialog().getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    await openAssignReady("un");
    expect(client.createOdooClient).toHaveBeenCalledTimes(2);
  });

  it("does not poison the ref when requireOdooConfig rejects: the retry succeeds", async () => {
    // THE MUTANT IS `??=`. It caches a permanently REJECTED promise for the
    // whole dialog session the moment requireOdooConfig rejects - which is
    // exactly the half-filled config this page exists to fix - so the failure
    // state's retry control could never succeed.
    storage.requireOdooConfig.mockRejectedValueOnce(new Error("no credentials yet"));
    db.listActionableRows.mockResolvedValue([
      row({ id: "un", status: "unassigned", contact_id: null }),
    ]);
    await renderPage();
    await openAssign("un");

    expect(
      await screen.findByText(/Your Odoo contacts could not be loaded \(ODOO_INTERNAL\)/)
    ).toBeInTheDocument();
    // No picker while the pre-flight is down.
    expect(screen.queryByPlaceholderText("Search contacts")).toBeNull();

    await userEvent.click(dialog().getByRole("button", { name: "Try again" }));

    expect(await screen.findByPlaceholderText("Search contacts")).toBeInTheDocument();
    expect(await dialog().findByRole("button", { name: "Ada Lovelace" })).toBeInTheDocument();
    // The second attempt really re-resolved rather than reusing a cached
    // promise: under `??=` this stays at 1 and the contacts never appear.
    expect(storage.requireOdooConfig).toHaveBeenCalledTimes(2);
  });

  it("attaches a handler to the rejection: open-then-Cancel raises nothing unhandled", async () => {
    const unhandled: unknown[] = [];
    const record = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", record);
    try {
      storage.requireOdooConfig.mockRejectedValue(new Error("no credentials yet"));
      db.listActionableRows.mockResolvedValue([
        row({ id: "un", status: "unassigned", contact_id: null }),
      ]);
      await renderPage();
      await openAssign("un");

      // Half one: the rejection DRIVES the pre-flight UI, which is only true
      // if the open effect awaits getClient() rather than firing and forgetting.
      expect(
        await screen.findByText(/Your Odoo contacts could not be loaded/)
      ).toBeInTheDocument();

      await userEvent.click(dialog().getByRole("button", { name: "Cancel" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

      // Half two. Node classifies a rejection as unhandled only once the
      // microtask queue has drained, so the macrotask hop is load-bearing.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", record);
    }
  });

  it("keeps a credential secret out of the DOM when step 0 fails", async () => {
    // A PLAIN Error on purpose. `odooError` redacts at construction, so an
    // odooError fixture arrives already clean and would pass even against a
    // component that re-derived its text with `String(err)` - the mutant the
    // fail-closed rule exists to stop.
    storage.requireOdooConfig.mockRejectedValue(new Error(`login rejected for ${SECRET}`));
    db.listActionableRows.mockResolvedValue([
      row({ id: "un", status: "unassigned", contact_id: null }),
    ]);
    await renderPage();
    await openAssign("un");

    // Both directions: the page's own copy is present AND the secret is gone.
    // An absence-only assertion passes whether or not anything was suppressed.
    expect(
      await screen.findByText(/Your Odoo contacts could not be loaded/)
    ).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(SECRET);
    expect(document.body.textContent).not.toContain("login rejected");
  });
});

describe("the assign dialog's contact list", () => {
  it("reads the contacts when it OPENS, not the page's mount-time map", async () => {
    // The dashboard webview is hidden rather than destroyed, so a long-mounted
    // page outlives every main-window runSync. A dialog fed the page's map
    // cannot offer a contact synced after this page mounted - and the fixture
    // has to CHANGE between the two reads or the case proves nothing.
    contacts.listContacts.mockResolvedValueOnce([contact()]);
    contacts.listContacts.mockResolvedValue([
      contact(),
      contact({ id: 8, name: "Bea Nordvik" }),
    ]);
    db.listActionableRows.mockResolvedValue([
      row({ id: "un", status: "unassigned", contact_id: null }),
    ]);
    await renderPage();
    await openAssignReady("un");

    expect(dialog().getByRole("button", { name: "Ada Lovelace" })).toBeInTheDocument();
    expect(dialog().getByRole("button", { name: "Bea Nordvik" })).toBeInTheDocument();
    // Scoped to the live instance, or another database's contacts are offered.
    expect(contacts.listContacts).toHaveBeenLastCalledWith(INSTANCE);
  });

  it("filters the list from the search box", async () => {
    contacts.listContacts.mockResolvedValue([
      contact(),
      contact({ id: 8, name: "Bea Nordvik" }),
    ]);
    db.listActionableRows.mockResolvedValue([
      row({ id: "un", status: "unassigned", contact_id: null }),
    ]);
    await renderPage();
    await openAssignReady("un");

    await userEvent.type(screen.getByPlaceholderText("Search contacts"), "bea");
    expect(dialog().getByRole("button", { name: "Bea Nordvik" })).toBeInTheDocument();
    expect(dialog().queryByRole("button", { name: "Ada Lovelace" })).toBeNull();
  });

  it("refuses an archived contact, which is the target Reassign exists to escape", async () => {
    contacts.listContacts.mockResolvedValue([
      contact({ id: 8, name: "Gone Partner", active: false }),
    ]);
    db.listActionableRows.mockResolvedValue([
      row({ id: "na", status: "failed", attempts: 3 }),
    ]);
    await renderPage();
    await openAssignReady("na", "Reassign");

    // Two buttons now share the archived contact's row - the preview button
    // and its AddToggle - so both must refuse the pick, not just one.
    expect(dialog().getByRole("button", { name: "Gone Partner Archived" })).toBeDisabled();
    expect(dialog().getByRole("button", { name: /add Gone Partner/i })).toBeDisabled();
  });
});

describe("the assign dialog's opportunity step", () => {
  it("renders a DISTINCT failure state with a retry, never an empty list", async () => {
    // fetchOpportunities throws on the first unreadable row and on any
    // transport failure. Rendering that as an empty list is indistinguishable
    // from "this contact has no open deals", so the user confirms contact-only
    // and the meeting lands on the res.partner instead of the crm.lead -
    // silently, and irreversibly once it is `sent`.
    opportunities.fetchOpportunities.mockRejectedValueOnce(new Error("crm.lead blew up"));
    opportunities.fetchOpportunities.mockResolvedValue([opportunity()]);
    db.listActionableRows.mockResolvedValue([
      row({ id: "un", status: "unassigned", contact_id: null }),
    ]);
    await renderPage();
    await openAssignReady("un");

    await userEvent.click(dialog().getByRole("button", { name: "Ada Lovelace" }));

    expect(
      await screen.findByText(/The opportunities and leads for this contact could not be read/)
    ).toBeInTheDocument();
    // THE KILLER ASSERTION. A failed fetch must never read as "no open deals".
    expect(screen.queryByText("No open opportunities or leads for this contact.")).toBeNull();
    // The code only - never the raw thrown text.
    expect(document.body.textContent).not.toContain("crm.lead blew up");

    await userEvent.click(dialog().getByRole("button", { name: "Try again" }));

    expect(await screen.findByText(/Heat pumps for the north wing/)).toBeInTheDocument();
    expect(screen.queryByText(/could not be read/)).toBeNull();
  });

  it("says so plainly when a contact genuinely has no open deals", async () => {
    // The other half of the pair. If both states rendered the same nothing,
    // the case above would pass against a component that shows neither.
    opportunities.fetchOpportunities.mockResolvedValue([]);
    db.listActionableRows.mockResolvedValue([
      row({ id: "un", status: "unassigned", contact_id: null }),
    ]);
    await renderPage();
    await openAssignReady("un");

    await userEvent.click(dialog().getByRole("button", { name: "Ada Lovelace" }));
    expect(
      await screen.findByText("No open opportunities or leads for this contact.")
    ).toBeInTheDocument();
    expect(screen.queryByText(/could not be read/)).toBeNull();
  });

  // Leads and opportunities are one Odoo table and one write, but they are not
  // the same thing to say out loud - the ROW states the kind (`kindLabel`
  // reads the real `type`), but the destination sentence cannot: see the
  // test right below for why, and Final whole-branch review, Important 5 for
  // why it must not guess "the lead X" instead of saying so neutrally.
  it("marks lead rows in the row, though the destination sentence cannot", async () => {
    opportunities.fetchOpportunities.mockResolvedValue([
      opportunity({ id: 700, name: "Website enquiry", type: "lead", stageName: "New" }),
    ]);
    db.listActionableRows.mockResolvedValue([
      row({ id: "un", status: "unassigned", contact_id: null }),
    ]);
    await renderPage();
    await openAssignReady("un");

    await userEvent.click(dialog().getByRole("button", { name: "Ada Lovelace" }));
    // getByText matches on a node's OWN direct text, not its descendants'
    // (unlike the accessible-name computation `getByRole` uses) - "Lead · "
    // sits in its own nested span, so the row is found via its bare name and
    // its full recursive `.textContent` is what the prefix check needs.
    const leadText = await screen.findByText("Website enquiry");
    expect(leadText.textContent).toMatch(/^Lead ·/);
    await userEvent.click(screen.getByRole("button", { name: /add Website enquiry/i }));

    expect(
      screen.getByText(
        "This meeting will be logged on 1 record: the lead or opportunity Website enquiry."
      )
    ).toBeInTheDocument();
  });

  it("labels an opportunity as an opportunity in the row, though the destination sentence cannot", async () => {
    opportunities.fetchOpportunities.mockResolvedValue([opportunity()]);
    db.listActionableRows.mockResolvedValue([
      row({ id: "un", status: "unassigned", contact_id: null }),
    ]);
    await renderPage();
    await openAssignReady("un");

    await userEvent.click(dialog().getByRole("button", { name: "Ada Lovelace" }));
    // The ROW distinguishes lead vs opportunity - `kindLabel` reads `type`.
    const oppText = await screen.findByText(/Heat pumps for the north wing/);
    expect(oppText.textContent).toMatch(/^Opportunity ·/);
    expect(oppText.textContent).not.toMatch(/Lead/);
    await userEvent.click(screen.getByRole("button", { name: /add Heat pumps/i }));

    // The destination SENTENCE cannot: `SelectedTarget` carries only `model`
    // ("res.partner" | "crm.lead"), never `type` ("lead" | "opportunity") -
    // a crm.lead target loses that distinction the moment it is added, the
    // same limitation `describeTargetForSentence` documents. Every crm.lead
    // target is worded neutrally ("the lead or opportunity X"), never a
    // guess at which one it actually is in Odoo.
    expect(
      screen.getByText(
        "This meeting will be logged on 1 record: the lead or opportunity Heat pumps for the north wing."
      )
    ).toBeInTheDocument();
  });

  it("is token-ordered on the RESOLVE path: a slow lookup cannot paint under a newer contact", async () => {
    const gateA = deferred<OdooOpportunity[]>();
    const gateB = deferred<OdooOpportunity[]>();
    opportunities.fetchOpportunities.mockImplementation(
      (_client: unknown, picked: { id: number }) =>
        picked.id === 7 ? gateA.promise : gateB.promise
    );
    contacts.listContacts.mockResolvedValue([
      contact(),
      contact({ id: 8, name: "Bea Nordvik" }),
    ]);
    db.listActionableRows.mockResolvedValue([
      row({ id: "un", status: "unassigned", contact_id: null }),
    ]);
    await renderPage();
    await openAssignReady("un");

    await userEvent.click(dialog().getByRole("button", { name: "Ada Lovelace" }));
    await waitFor(() => expect(opportunities.fetchOpportunities).toHaveBeenCalledTimes(1));
    await userEvent.click(dialog().getByRole("button", { name: "Bea Nordvik" }));
    await waitFor(() => expect(opportunities.fetchOpportunities).toHaveBeenCalledTimes(2));

    await act(async () => {
      gateB.resolve([opportunity({ id: 501, name: "Bea's deal" })]);
    });
    expect(await screen.findByText(/Bea's deal/)).toBeInTheDocument();

    // Contact A's slower lookup lands LAST. Without the token it repaints
    // A's deals under B's selection, and Confirm then writes lead_id for the
    // wrong customer - with no undo, because the push is immediate.
    await act(async () => {
      gateA.resolve([opportunity({ id: 502, name: "Ada's deal" })]);
    });
    expect(screen.queryByText(/Ada's deal/)).toBeNull();
    expect(screen.getByText(/Bea's deal/)).toBeInTheDocument();
  });

  it("is token-ordered on the REJECT path too: a stale failure cannot paint under a newer contact", async () => {
    // The rejection path matters as much as the resolve path - a stale
    // setOpportunityError paints the WRONG contact's failure, and the user
    // retreats to contact-only for a customer whose deals loaded fine.
    const gateA = deferred<OdooOpportunity[]>();
    const gateB = deferred<OdooOpportunity[]>();
    opportunities.fetchOpportunities.mockImplementation(
      (_client: unknown, picked: { id: number }) =>
        picked.id === 7 ? gateA.promise : gateB.promise
    );
    contacts.listContacts.mockResolvedValue([
      contact(),
      contact({ id: 8, name: "Bea Nordvik" }),
    ]);
    db.listActionableRows.mockResolvedValue([
      row({ id: "un", status: "unassigned", contact_id: null }),
    ]);
    await renderPage();
    await openAssignReady("un");

    await userEvent.click(dialog().getByRole("button", { name: "Ada Lovelace" }));
    await waitFor(() => expect(opportunities.fetchOpportunities).toHaveBeenCalledTimes(1));
    await userEvent.click(dialog().getByRole("button", { name: "Bea Nordvik" }));
    await waitFor(() => expect(opportunities.fetchOpportunities).toHaveBeenCalledTimes(2));

    await act(async () => {
      gateB.resolve([opportunity({ id: 501, name: "Bea's deal" })]);
    });
    expect(await screen.findByText(/Bea's deal/)).toBeInTheDocument();

    await act(async () => {
      gateA.reject(new Error("crm.lead blew up"));
    });
    expect(screen.queryByText(/could not be read/)).toBeNull();
    expect(screen.getByText(/Bea's deal/)).toBeInTheDocument();
  });
});

// Task 14: `assignMeetingLog(id, targets, deps)` reads real `SelectedTargets`
// straight from `AssignPayload.targets` now - `assignPayloadToTargets`, the
// bridge Task 7 left in place until this task, is gone. Every add/remove
// below goes through the dialog's own `+ add` / `✓ added` rows, the same
// control ContactPicker uses (`@/components/AddToggle`), never a "select"
// click - clicking a contact or opportunity row PREVIEWS it; it does not by
// itself add anything.
describe("what the assign dialog hands up", () => {
  it("passes the provider config derived from @/contexts, never null", async () => {
    // This is the case that kills "wired to the wrong useApp", "missing
    // providerConfig" and "wired to nothing" - none of which the actions-module
    // suite can see, because there the config arrives as an argument.
    db.listActionableRows.mockResolvedValue([
      row({ id: "un", status: "unassigned", contact_id: null }),
    ]);
    await renderPage();
    await openAssignReady("un");

    await userEvent.click(dialog().getByRole("button", { name: "add Ada Lovelace" }));
    await userEvent.click(dialog().getByRole("button", { name: "Log this meeting" }));

    // Confirm closes the dialog immediately, same as Cancel - it does not wait
    // for the push to settle. A row left open here answers a THIRD click (once
    // busy clears) against a row that is now `sent`, producing a spurious
    // "This meeting changed in another window."
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    await waitFor(() => expect(actions.assignMeetingLog).toHaveBeenCalled());
    const [id, targets, deps] = actions.assignMeetingLog.mock.calls[0];
    expect(id).toBe("un");
    // The real name travels now, unlike the old single-select bridge which
    // always wrote `name: null` - AddToggle is handed `c.name` directly.
    expect(targets).toEqual([{ model: "res.partner", resId: 7, name: "Ada Lovelace" }]);
    expect(deps.providerConfig).toEqual({ provider: PROVIDER, selectedProvider: SELECTED });
    // The page owns the push, so it - not the dialog - supplies the CAS hook.
    expect(deps.onCommitted).toBeTypeOf("function");
    // The dialog owns NO push: the payload went up and nothing was built here.
    expect(deps.client).toBeUndefined();
  });

  it("lets an added opportunity be taken back off, keeping the contact", async () => {
    // The single-exclusive-pick flow this replaces used to auto-drop the
    // contact the moment an opportunity was chosen, and "Contact record
    // only" was the sole way back. Multi-select has no such exclusivity -
    // any combination can be added or removed independently - so the same
    // "take a target back off before confirming" guarantee is proven here
    // over TWO independent targets sharing one contact instead.
    opportunities.fetchOpportunities.mockResolvedValue([opportunity({ id: 500 })]);
    db.listActionableRows.mockResolvedValue([
      row({ id: "un", status: "unassigned", contact_id: null }),
    ]);
    await renderPage();
    await openAssignReady("un");

    await userEvent.click(dialog().getByRole("button", { name: "add Ada Lovelace" }));
    await userEvent.click(dialog().getByRole("button", { name: "Ada Lovelace" }));
    await userEvent.click(await dialog().findByRole("button", { name: /add Heat pumps/i }));
    // "the lead or opportunity X", never "the opportunity X" - see the
    // destination-sentence limitation documented on the opportunity-step
    // test above.
    expect(
      screen.getByText(/logged on 2 records: Ada Lovelace and the lead or opportunity Heat pumps/)
    ).toBeInTheDocument();

    await userEvent.click(dialog().getByRole("button", { name: /added Heat pumps/i }));
    await userEvent.click(dialog().getByRole("button", { name: "Log this meeting" }));

    await waitFor(() => expect(actions.assignMeetingLog).toHaveBeenCalled());
    expect(actions.assignMeetingLog.mock.calls[0][1]).toEqual([
      { model: "res.partner", resId: 7, name: "Ada Lovelace" },
    ]);
  });

  it("confirms a contact AND its opportunity together - multi-select has no exclusivity", async () => {
    opportunities.fetchOpportunities.mockResolvedValue([opportunity({ id: 500 })]);
    db.listActionableRows.mockResolvedValue([
      row({ id: "un", status: "unassigned", contact_id: null }),
    ]);
    await renderPage();
    await openAssignReady("un");

    await userEvent.click(dialog().getByRole("button", { name: "Ada Lovelace" }));
    await userEvent.click(dialog().getByRole("button", { name: "add Ada Lovelace" }));
    await userEvent.click(await dialog().findByRole("button", { name: /add Heat pumps/i }));
    await userEvent.click(dialog().getByRole("button", { name: "Log this meeting" }));

    await waitFor(() => expect(actions.assignMeetingLog).toHaveBeenCalled());
    expect(actions.assignMeetingLog.mock.calls[0][1]).toEqual([
      { model: "res.partner", resId: 7, name: "Ada Lovelace" },
      { model: "crm.lead", resId: 500, name: "Heat pumps for the north wing" },
    ]);
  });

  it("does not touch the staged targets when switching which contact's deals are previewed", async () => {
    // Previewing a contact's deals (clicking its row) is side-effect-free on
    // `targets` - only its OWN AddToggle, or an opportunity's, ever writes
    // to the staged list. The single-select flow this replaces used to reset
    // its one exclusive pick on every new selection; nothing here resets
    // anything, because nothing is implicitly selected by a preview.
    opportunities.fetchOpportunities.mockResolvedValue([opportunity({ id: 500 })]);
    contacts.listContacts.mockResolvedValue([
      contact(),
      contact({ id: 8, name: "Bea Nordvik" }),
    ]);
    db.listActionableRows.mockResolvedValue([
      row({ id: "un", status: "unassigned", contact_id: null }),
    ]);
    await renderPage();
    await openAssignReady("un");

    await userEvent.click(dialog().getByRole("button", { name: "Ada Lovelace" }));
    await userEvent.click(dialog().getByRole("button", { name: "add Ada Lovelace" }));
    await userEvent.click(dialog().getByRole("button", { name: "Bea Nordvik" }));
    await userEvent.click(dialog().getByRole("button", { name: "Log this meeting" }));

    await waitFor(() => expect(actions.assignMeetingLog).toHaveBeenCalled());
    expect(actions.assignMeetingLog.mock.calls[0][1]).toEqual([
      { model: "res.partner", resId: 7, name: "Ada Lovelace" },
    ]);
  });

  it("is offered on a current-instance FAILED row as Reassign, and assigns it", async () => {
    // Reassign, owner-approved 2026-08-25. A meeting whose Odoo target was
    // archived is otherwise unrecoverable except by deleting the transcript:
    // isRetryable calls the fault final, so Retry reproduces it forever.
    contacts.listContacts.mockResolvedValue([
      contact(),
      contact({ id: 8, name: "Bea Nordvik" }),
    ]);
    db.listActionableRows.mockResolvedValueOnce([
      row({ id: "na", status: "failed", attempts: 3, last_error: "ODOO_FAULT: partner deleted" }),
    ]);
    db.listActionableRows.mockResolvedValue([]);
    await renderPage();
    await openAssignReady("na", "Reassign");

    await userEvent.click(dialog().getByRole("button", { name: "add Bea Nordvik" }));
    await userEvent.click(dialog().getByRole("button", { name: "Log this meeting" }));

    await waitFor(() => expect(actions.assignMeetingLog).toHaveBeenCalled());
    expect(actions.assignMeetingLog.mock.calls[0].slice(0, 2)).toEqual([
      "na",
      [{ model: "res.partner", resId: 8, name: "Bea Nordvik" }],
    ]);
    // The row left the list on `sent`, so its outcome is promoted rather than
    // lost with the unmounting row.
    const notice = await waitFor(() => noticeElement("na"));
    expect(notice.textContent).toContain("Sent to Odoo.");
  });

  // Task 14, brief test 5: assignQueueRow returns Promise<boolean>. Mocking
  // an object here is always truthy, so `if (!(await assignQueueRow(...)))`
  // would read the refusal as success and this test could never pass against
  // that mutant - runAction's own CAS check turns a `false` resolve into
  // {kind:"conflict"}, which reaches this page as ASSIGN_CONFLICT_COPY, not
  // outcomeCopy's generic conflict text (see that constant's own comment).
  it("surfaces a zero-row assign CAS instead of swallowing it", async () => {
    actions.assignMeetingLog.mockResolvedValue({ kind: "conflict" });
    db.listActionableRows.mockResolvedValue([
      row({ id: "un", status: "unassigned", contact_id: null }),
    ]);
    await renderPage();
    await openAssignReady("un");

    await userEvent.click(dialog().getByRole("button", { name: "add Ada Lovelace" }));
    await userEvent.click(dialog().getByRole("button", { name: "Log this meeting" }));

    expect(await screen.findByText(/could not be reassigned/i)).toBeVisible();
    // And NEVER the generic copy other conflicting actions use - conflating
    // the two teaches a user to distrust which of the seven lines they got.
    expect(screen.queryByText("This meeting changed in another window.")).toBeNull();
  });

  it("refuses to confirm before a contact is chosen", async () => {
    db.listActionableRows.mockResolvedValue([
      row({ id: "un", status: "unassigned", contact_id: null }),
    ]);
    await renderPage();
    await openAssignReady("un");

    expect(dialog().getByRole("button", { name: "Log this meeting" })).toBeDisabled();
    expect(actions.assignMeetingLog).not.toHaveBeenCalled();
  });
});

describe("cancelling the assign dialog", () => {
  it("writes nothing and leaves the row NON-BUSY", async () => {
    // Busy is set at Confirm, in the click handler, before the first await -
    // never at open. Marking at open leaves a cancelled dialog's row rendering
    // "Sending…" with all three actions disabled until a remount, because
    // Cancel writes nothing by design.
    db.listActionableRows.mockResolvedValue([
      row({ id: "un", status: "unassigned", contact_id: null }),
    ]);
    await renderPage();
    await openAssignReady("un");

    await userEvent.click(dialog().getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    const item = rowOf("un");
    // The row is still rendered and still says what it said before the dialog
    // opened. ("No contact chosen" is both the target name and the status line
    // for an `unassigned` row, hence the All variant.)
    expect(item.getAllByText("No contact chosen")).toHaveLength(2);
    expect(item.queryByText("Sending…")).toBeNull();
    expect(item.getByRole("button", { name: "Assign" })).toBeEnabled();
    expect(item.getByRole("button", { name: "Delete" })).toBeEnabled();
    expect(actions.assignMeetingLog).not.toHaveBeenCalled();
  });
});

describe("the assign dialog's provider pre-flight", () => {
  it("warns when no provider is usable, and still lets the user go ahead deliberately", async () => {
    // generateMeetingLogSummary returns null for a MISSING provider and
    // pushQueuedRow swallows it, so without this the row reaches `sent` with
    // last_error cleared while a "Summarization failed" note is live on the
    // customer's record. Say so first; let them choose it.
    appState.current = {
      allAiProviders: [],
      selectedAIProvider: SELECTED,
      meetwingsApiEnabled: false,
    };
    db.listActionableRows.mockResolvedValue([
      row({ id: "un", status: "unassigned", contact_id: null }),
    ]);
    await renderPage();
    await openAssignReady("un");

    expect(
      await screen.findByText(/No AI provider is set up/)
    ).toBeInTheDocument();
    // Opening warns. It does not push.
    expect(actions.assignMeetingLog).not.toHaveBeenCalled();

    await userEvent.click(dialog().getByRole("button", { name: "add Ada Lovelace" }));
    await userEvent.click(dialog().getByRole("button", { name: "Log this meeting" }));

    await waitFor(() => expect(actions.assignMeetingLog).toHaveBeenCalled());
    // deps at index 2: assignMeetingLog(id, targets, deps).
    expect(actions.assignMeetingLog.mock.calls[0][2].providerConfig).toBeNull();
  });

  it("does NOT warn when the Meetwings API is the provider", async () => {
    // useProviderConfig returns null in exactly this case too, and that is
    // CORRECT - generateMeetingLogSummary routes through the Meetwings API
    // instead. The mutant is warning whenever the config is null, which would
    // tell every licensed user their summaries are broken.
    meetwings.shouldUseMeetwingsAPI.mockResolvedValue(true);
    appState.current = {
      allAiProviders: [],
      selectedAIProvider: SELECTED,
      meetwingsApiEnabled: true,
    };
    db.listActionableRows.mockResolvedValue([
      row({ id: "un", status: "unassigned", contact_id: null }),
    ]);
    await renderPage();
    await openAssignReady("un");

    expect(screen.queryByText(/No AI provider is set up/)).toBeNull();
    expect(dialog().getByRole("button", { name: "Ada Lovelace" })).toBeInTheDocument();
  });
});

describe("QueueRow", () => {
  const ROW_INSTANCE = "http://h:8069|odoo";

  const pendingRow: MeetingLogListRow = {
    id: "qr-1",
    session_key: "s1",
    conversation_id: null,
    instance: ROW_INSTANCE,
    contact_id: null,
    lead_id: null,
    transcript_start_at: MEETING_AT,
    transcript_end_at: MEETING_AT + 60_000,
    summary_json: null,
    attachment_id: null,
    message_id: null,
    status: "pending",
    attempts: 0,
    claimed_at: null,
    last_error: null,
    last_error_code: null,
    meeting_started_at: MEETING_AT,
    created_at: CREATED_AT,
    sent_at: null,
    targets: [],
  };

  function rowWith(targets: MeetingLogTarget[]): MeetingLogListRow {
    return { ...pendingRow, targets };
  }

  // `resIdFor` is keyed by NAME, not bumped unconditionally, so
  // `pending("A")` and `failed("A")` land on the SAME id/resId - the same
  // logical target across two renders, differing only in status/lastError.
  // A comparator mutant that keys off id alone (rather than status) must not
  // survive by accident because the fixtures handed it two different targets.
  let targetSeq = 0;
  const resIdByName = new Map<string, number>();
  function resIdFor(name: string | null): number {
    if (name === null) {
      targetSeq += 1;
      return targetSeq;
    }
    if (!resIdByName.has(name)) {
      targetSeq += 1;
      resIdByName.set(name, targetSeq);
    }
    return resIdByName.get(name)!;
  }

  function targetFixture(
    name: string | null,
    over: Partial<MeetingLogTarget> = {}
  ): MeetingLogTarget {
    const resId = resIdFor(name);
    return {
      id: `target-${resId}`,
      rowId: pendingRow.id,
      model: "res.partner",
      resId,
      name,
      status: "pending",
      attachmentId: null,
      messageId: null,
      lastError: null,
      lastErrorCode: null,
      createdAt: 0,
      sentAt: null,
      ...over,
    };
  }

  const target: MeetingLogTarget = targetFixture(null);

  function pending(name: string | null = null): MeetingLogTarget {
    return targetFixture(name);
  }
  function sent(name: string | null = null): MeetingLogTarget {
    return targetFixture(name, { status: "sent", sentAt: 1 });
  }
  function failed(name: string | null = null): MeetingLogTarget {
    return targetFixture(name, {
      status: "failed",
      lastError: "ODOO_FAULT",
      lastErrorCode: "ODOO_FAULT",
    });
  }

  const props = {
    row: pendingRow,
    targetName: "Someone",
    instance: ROW_INSTANCE,
    busy: false,
    stale: false,
    outcome: null,
    transcript: null,
    contacts: new Map<number, OdooContact>(),
    onRetry: vi.fn(),
    onAssign: vi.fn(),
    onDelete: vi.fn(),
    onToggleTranscript: vi.fn(),
    onReloadTranscript: vi.fn(),
    onRetryTarget: vi.fn(),
    onRemoveTarget: vi.fn(),
  };

  it("summarises how many targets failed", () => {
    render(<QueueRow {...props} row={rowWith([sent(), sent(), failed()])} />);
    expect(screen.getByText("1 of 3 failed")).toBeVisible();
  });

  it("expands to per-target state", async () => {
    render(
      <QueueRow {...props} row={rowWith([sent("Christian Carron"), failed("Bentley AS")])} />
    );
    await userEvent.click(screen.getByRole("button", { name: /expand/i }));
    expect(screen.getByText("Christian Carron")).toBeVisible();
    expect(screen.getByText("ODOO_FAULT")).toBeVisible();
  });

  it("offers Retry and Remove on a failed target only", async () => {
    render(<QueueRow {...props} row={rowWith([sent("A"), failed("B")])} />);
    await userEvent.click(screen.getByRole("button", { name: /expand/i }));
    const rowB = screen.getByRole("group", { name: /B/ });
    expect(within(rowB).getByRole("button", { name: /retry this one/i })).toBeVisible();
    const rowA = screen.getByRole("group", { name: /A/ });
    expect(within(rowA).queryByRole("button", { name: /remove/i })).toBeNull();
  });

  it("says a partly-failed row needs attention, not that it is waiting", () => {
    render(<QueueRow {...props} row={{ ...pendingRow, targets: [pending(), failed()] }} />);
    expect(screen.queryByText(/waiting to be sent/i)).toBeNull();
  });

  // Task 14: assignQueueRow's own upfront gate refuses a reassign on a row
  // with any sent target outright, even though `row.status` (here `failed`,
  // otherwise reassignable) would pass `canAssign`'s status check alone -
  // the exact push-partial shape (one sent, one failed). Not merely
  // `disabled`: `queryByRole` finds a disabled button too, and offering a
  // control that always errors is worse than not offering it.
  it("is unreachable on a row with a sent target", () => {
    render(
      <QueueRow
        {...props}
        row={{ ...pendingRow, status: "failed", targets: [sent(), failed()] }}
      />
    );
    expect(screen.queryByRole("button", { name: /assign/i })).toBeNull();
  });

  it("re-renders when a target's status changes", () => {
    const { rerender } = render(<QueueRow {...props} row={rowWith([pending("A")])} />);
    rerender(<QueueRow {...props} row={rowWith([failed("A")])} />);
    expect(screen.getByText("ODOO_FAULT")).toBeVisible();
  });

  it("falls back through name, cache, then a generic placeholder", () => {
    render(<QueueRow {...props} row={rowWith([{ ...target, name: null, resId: 12 }])} />);
    expect(screen.getByText("Contact #12")).toBeVisible();
  });

  // Not in the brief - the cache branch of `targetNameOf`'s fallback chain
  // (name -> cache -> placeholder) is otherwise never exercised: every
  // brief-given test either supplies a name or misses the cache entirely.
  it("resolves a null-name target through the contact cache before falling back", () => {
    render(
      <QueueRow
        {...props}
        contacts={new Map([[12, contact({ id: 12, name: "Real Name" })]])}
        row={rowWith([{ ...target, name: null, resId: 12 }])}
      />
    );
    expect(screen.getByText("Real Name")).toBeVisible();
    expect(screen.queryByText("Contact #12")).toBeNull();
  });

  it("calls onRetryTarget/onRemoveTarget with the row and the clicked target", async () => {
    const onRetryTarget = vi.fn();
    const onRemoveTarget = vi.fn();
    const b = failed("B");
    const withRow = rowWith([b]);
    render(
      <QueueRow
        {...props}
        row={withRow}
        onRetryTarget={onRetryTarget}
        onRemoveTarget={onRemoveTarget}
      />
    );
    await userEvent.click(screen.getByRole("button", { name: /expand/i }));
    await userEvent.click(screen.getByRole("button", { name: /retry this one/i }));
    expect(onRetryTarget).toHaveBeenCalledWith(withRow, b);
    await userEvent.click(screen.getByRole("button", { name: /^remove$/i }));
    expect(onRemoveTarget).toHaveBeenCalledWith(withRow, b);
  });
});
