import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

// `vi.hoisted`, not a bare `const`: vitest hoists every `vi.mock` above the
// imports, so a factory closing over a plain outer const runs while that const
// is still in its TDZ and the file dies at load reporting "no tests" rather
// than failures. Same reason as meeting-log-page.test.tsx:10-16.
const db = vi.hoisted(() => ({
  listActionableRows: vi.fn(),
  countActionableQueued: vi.fn(),
  getQueueTranscript: vi.fn(),
  getQueueRow: vi.fn(),
  listConversationBadgeRows: vi.fn(),
}));
vi.mock("@/lib/database/meeting-log.action", () => db);

// `useHistory` reads this in a mount effect through the `@/lib` barrel, which
// star-exports it. Mocked at the LEAF rather than at `@/lib`, so the rest of
// that barrel stays real - the queue page suite's rule, for its reason.
const history = vi.hoisted(() => ({
  getAllConversations: vi.fn(),
  deleteConversation: vi.fn(),
  renameConversationManually: vi.fn(),
  getConversationById: vi.fn(),
}));
vi.mock("@/lib/database/chat-history.action", () => history);

// `View.tsx` (the header-rename suite below) calls this hook for its own
// message-loading and completion plumbing, none of which that suite exercises
// - only the rename control in `rightSlot` and the `[]`-deped title listener
// are under test. Mocked at the leaf, same reasoning as `chat-history.action`
// above: the real hook needs `useApp()` fields (selectedAIProvider,
// selectedSttProvider, screenshotConfiguration, ...), a Tauri `invoke`/`listen`
// pair, and AI/STT fetch plumbing this file has no reason to stand up.
// `setMessages` (View's own state setter) is passed straight through and never
// touched by the mock, so View's real title-update path is unaffected.
const chatCompletion = vi.hoisted(() => ({
  input: "",
  setInput: vi.fn(),
  isLoading: false,
  error: null as string | null,
  attachedFiles: [] as unknown[],
  handleFileSelect: vi.fn(),
  removeFile: vi.fn(),
  onRemoveAllFiles: vi.fn(),
  isFilesPopoverOpen: false,
  setIsFilesPopoverOpen: vi.fn(),
  micOpen: false,
  setMicOpen: vi.fn(),
  isRecording: false,
  setIsRecording: vi.fn(),
  screenshotConfiguration: {},
  captureScreenshot: vi.fn(),
  isScreenshotLoading: false,
  handleKeyPress: vi.fn(),
  handlePaste: vi.fn(),
  submit: vi.fn(),
  inputRef: { current: null },
  messagesEndRef: { current: null },
}));
vi.mock("@/hooks/useChatCompletion", () => ({
  useChatCompletion: () => chatCompletion,
}));

const actions = vi.hoisted(() => ({
  retryMeetingLog: vi.fn(),
  assignMeetingLog: vi.fn(),
  deleteMeetingLog: vi.fn(),
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

const meetwings = vi.hoisted(() => ({ shouldUseMeetwingsAPI: vi.fn(async () => false) }));
vi.mock("@/lib/functions/meetwings.api", () => meetwings);

const appState = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
vi.mock("@/contexts", () => ({ useApp: () => appState.current }));

// The focus listener the queue hook registers once on mount.
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

// PageLayout renders <Header />, which calls useNavigate(), and <Promote />,
// which calls useApp(). Same stub as meeting-log-page.test.tsx:105-108.
// `title` is surfaced as a plain div (never a heading - several tests below
// assert `queryByRole("heading", { level: 2 })` is null) so the header-rename
// suite can observe the `[]`-deped title listener actually repainting it;
// `rightSlot` is rendered for the same reason - View.tsx's rename control
// lives there, not in `children`. The list page never passes `rightSlot` and
// its `title` ("Meetings") is never asserted on, so this is a no-op for it.
vi.mock("@/layouts", () => ({
  PageLayout: ({
    children,
    title,
    rightSlot,
  }: {
    children: React.ReactNode;
    title?: React.ReactNode;
    rightSlot?: React.ReactNode;
  }) => (
    <div>
      <div data-testid="page-title">{title}</div>
      <div data-testid="page-right-slot">{rightSlot}</div>
      {children}
    </div>
  ),
}));

import Meetings from "@/pages/meetings";
import View from "@/pages/meetings/components/View";
import type { ChatConversation, MeetingLogListRow } from "@/types";
import { CONVERSATION_RENAMED_KEY } from "@/lib/chat-constants";

const INSTANCE = "http://h:8069|odoo";
const CONFIG = { url: "http://h:8069", db: "odoo", login: "bob", apiKey: "sk-live-key" };
const MEETING_AT = 1_700_000_000_000;

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
    created_at: MEETING_AT,
    sent_at: null,
    targets: [],
    ...over,
  };
}

function conversation(over: Partial<ChatConversation> = {}): ChatConversation {
  return {
    id: "c1",
    title: "Quarterly review",
    messages: [],
    createdAt: MEETING_AT,
    updatedAt: MEETING_AT,
    ...over,
  };
}

const CONVERSATIONS = [
  conversation({ id: "c1", title: "Quarterly review" }),
  conversation({ id: "c2", title: "Supplier onboarding", updatedAt: MEETING_AT - 86_400_000 }),
];

async function renderPage() {
  const view = render(
    <MemoryRouter>
      <Meetings />
    </MemoryRouter>
  );
  await waitFor(() => expect(storage.loadOdooConfigState).toHaveBeenCalled());
  await waitFor(() => expect(history.getAllConversations).toHaveBeenCalled());
  // Settles ProviderConfigReader's async shouldUseMeetwingsAPI leg too.
  await act(async () => {
    await Promise.resolve();
  });
  return view;
}

function conversationCard(id: string): HTMLElement | null {
  return document.querySelector(`[data-conversation-id="${id}"]`);
}

function stripRow(id: string): HTMLElement | null {
  return document.querySelector(`[data-row-id="${id}"]`);
}

beforeEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  focus.handler = null;
  appState.current = {
    allAiProviders: [{ id: "openai", name: "OpenAI" }],
    selectedAIProvider: { provider: "openai", model: "gpt-4o", variables: {} },
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
  db.listConversationBadgeRows.mockResolvedValue([]);
  contacts.listContacts.mockResolvedValue([]);
  history.getAllConversations.mockResolvedValue(CONVERSATIONS);
  history.renameConversationManually.mockResolvedValue(true);
});

/** Finds the pencil on a rendered conversation card and clicks it. */
async function openRowEditor(id: string): Promise<HTMLElement> {
  const card = conversationCard(id)!;
  await userEvent.hover(card);
  await userEvent.click(within(card).getByRole("button", { name: "Rename conversation" }));
  return card;
}

/**
 * The editor opens pre-filled with the current title (so Enter with no edits
 * is a no-op rename), so every caller must clear it first - `userEvent.type`
 * appends to existing content rather than replacing it.
 */
async function renameRowTo(card: HTMLElement, text: string): Promise<void> {
  const input = within(card).getByRole("textbox");
  await userEvent.clear(input);
  await userEvent.type(input, `${text}{Enter}`);
}

describe("the meetings page", () => {
  it("renders the conversation list with no strip and no badges when Odoo is unconfigured", async () => {
    // For a user who never set up Odoo this page must be complete as a plain
    // conversation history: no strip, and nothing resolved into a badge.
    storage.loadOdooConfigState.mockResolvedValue({ state: "absent", config: null });
    // Seeded, and still must not paint: the hook never reads them without a
    // complete config, and a badge resolved against an empty instance would
    // report another database's rows as this one's.
    db.listConversationBadgeRows.mockResolvedValue([
      { conversationId: "c1", status: "sent", instance: INSTANCE },
    ]);
    await renderPage();

    expect(await screen.findByText("Quarterly review")).toBeInTheDocument();
    expect(screen.getByText("Supplier onboarding")).toBeInTheDocument();
    expect(document.querySelector("[data-row-id]")).toBeNull();
    expect(document.querySelector("[data-badge-status]")).toBeNull();
    expect(screen.queryByRole("heading", { level: 2 })).toBeNull();
  });

  it("still reports the stranded count on a half-filled config", async () => {
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
    // The list is not the queue's, so it renders beside the warning.
    expect(screen.getByText("Quarterly review")).toBeInTheDocument();
  });

  it("keeps the conversation list rendered when the queue read fails", async () => {
    // The isolation the spec requires: `reload`'s single catch owns the strip
    // only. The list is useHistory state, which reload never touches.
    db.listActionableRows.mockRejectedValue(new Error("database is locked"));
    await renderPage();

    expect(
      await screen.findByText("The meetings waiting to be logged could not be read.")
    ).toBeInTheDocument();
    expect(screen.getByText("Quarterly review")).toBeInTheDocument();
    expect(screen.getByText("Supplier onboarding")).toBeInTheDocument();
  });

  it("filters the date-grouped list but never the strip", async () => {
    // The strip is a worklist, not a view of the list: filtering it would hide
    // the one thing on this page that needs the user.
    db.listActionableRows.mockResolvedValue([
      row({ id: "na", status: "failed" }),
      row({ id: "un", status: "unassigned", contact_id: null }),
    ]);
    await renderPage();

    await waitFor(() => expect(stripRow("na")).not.toBeNull());
    await userEvent.type(screen.getByPlaceholderText("Search conversations..."), "Quarterly");

    expect(screen.getByText("Quarterly review")).toBeInTheDocument();
    expect(screen.queryByText("Supplier onboarding")).toBeNull();
    expect(stripRow("na")).not.toBeNull();
    expect(stripRow("un")).not.toBeNull();
  });

  it("renders a conversation_id IS NULL row in the strip with no link", async () => {
    // Reachable through useMeetingLog.ts's `conversationId ??
    // getActiveConversationId()`. It has no conversation row to badge onto, so
    // the strip is the only place it can be seen at all - and it must not
    // pretend to link to a conversation that does not exist.
    db.listActionableRows.mockResolvedValue([row({ id: "orphan", conversation_id: null })]);
    await renderPage();

    await waitFor(() => expect(stripRow("orphan")).not.toBeNull());
    expect(within(stripRow("orphan")!).queryByRole("link")).toBeNull();
    expect(stripRow("orphan")!.querySelector("a")).toBeNull();
  });

  it("badges a waiting row's conversation instead of keeping it in the strip", async () => {
    // THE MUTANT THIS KILLS: drop the `waiting` narrowing in QueueStrip's
    // stripRowsFor and this row renders a full QueueRow beside the badge that
    // already says the same thing. Every fixture in meeting-log-page.test.tsx
    // has a null conversation_id, so nothing over there can catch it.
    db.listActionableRows.mockResolvedValue([
      row({ id: "wa", status: "pending", attempts: 0, conversation_id: "c1" }),
    ]);
    db.listConversationBadgeRows.mockResolvedValue([
      { conversationId: "c1", status: "pending", instance: INSTANCE },
    ]);
    await renderPage();

    const badge = await waitFor(() => {
      const el = conversationCard("c1")!.querySelector("[data-badge-status]");
      expect(el).not.toBeNull();
      return el!;
    });
    expect(badge.getAttribute("data-badge-status")).toBe("pending");
    expect(badge.textContent).toContain("Waiting for Odoo");
    // In flight, and nothing here needs the user - so it is not on the worklist.
    expect(stripRow("wa")).toBeNull();
    expect(screen.queryByRole("heading", { level: 2 })).toBeNull();
  });

  it("keeps a waiting row on screen while it still has an outcome to show", async () => {
    // A no-op retry leaves a `failed` row `pending` with a conversation, i.e.
    // narrowed out of the strip - but the hook's `inlineIds` is derived from the
    // GROUPED buckets, so it counts that row as rendered and never promotes its
    // record into the notice region. Drop the `results` clause from
    // stripRowsFor and this sentence is written and then shown nowhere.
    actions.retryMeetingLog.mockResolvedValue({ kind: "no-op" });
    db.listActionableRows.mockResolvedValueOnce([
      row({ id: "wa", status: "failed", attempts: 1, conversation_id: "c1" }),
    ]);
    db.listActionableRows.mockResolvedValue([
      row({ id: "wa", status: "pending", attempts: 0, conversation_id: "c1" }),
    ]);
    await renderPage();

    await userEvent.click(await screen.findByRole("button", { name: "Retry" }));

    expect(
      await screen.findByText(
        "This meeting was put back in the queue, but nothing reached Odoo. It will be retried the next time Meetwings starts."
      )
    ).toBeInTheDocument();
    expect(stripRow("wa")).not.toBeNull();
  });

  it("badges a conversation from its queue rows and counts them", async () => {
    db.listConversationBadgeRows.mockResolvedValue([
      { conversationId: "c1", status: "sent", instance: INSTANCE },
      { conversationId: "c1", status: "sent", instance: INSTANCE },
      // cancelled contributes nothing, so c2 stays unbadged.
      { conversationId: "c2", status: "cancelled", instance: INSTANCE },
    ]);
    await renderPage();

    const card = await waitFor(() => {
      const el = conversationCard("c1");
      expect(el).not.toBeNull();
      return el!;
    });
    const badge = await waitFor(() => {
      const el = card.querySelector("[data-badge-status]");
      expect(el).not.toBeNull();
      return el!;
    });
    expect(badge.getAttribute("data-badge-status")).toBe("sent");
    expect(badge.textContent).toContain("Sent to Odoo");
    expect(badge.textContent).toContain("2");
    expect(conversationCard("c2")!.querySelector("[data-badge-status]")).toBeNull();
  });
});

describe("renaming a conversation from the list", () => {
  // vi.spyOn(window, "dispatchEvent" | Date, "now" | localStorage, "setItem")
  // below stack across tests otherwise - the outer file's beforeEach only
  // clears call history, it does not restore a spy to the real implementation.
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reveals the editor on the pencil and commits on Enter", async () => {
    await renderPage();
    const card = await openRowEditor("c1");

    await renameRowTo(card, "New name");

    await waitFor(() =>
      expect(history.renameConversationManually).toHaveBeenCalledWith("c1", "New name")
    );
  });

  it("cancels on Escape without writing", async () => {
    await renderPage();
    const card = await openRowEditor("c1");

    const input = within(card).getByRole("textbox");
    await userEvent.clear(input);
    await userEvent.type(input, "Whatever{Escape}");

    expect(history.renameConversationManually).not.toHaveBeenCalled();
    // Back to the read-only title - no editor left open on the row.
    await waitFor(() => expect(within(card).queryByRole("textbox")).toBeNull());
    expect(within(card).getByText("Quarterly review")).toBeInTheDocument();
  });

  it("fires both channels on a successful commit", async () => {
    const dispatchSpy = vi.spyOn(window, "dispatchEvent");
    const setItemSpy = vi.spyOn(window.localStorage, "setItem");
    await renderPage();
    const card = await openRowEditor("c1");

    await renameRowTo(card, "New name");
    await waitFor(() => expect(history.renameConversationManually).toHaveBeenCalled());

    const titleEvent = await waitFor(() => {
      const found = dispatchSpy.mock.calls
        .map(([event]) => event as CustomEvent)
        .find((event) => event.type === "conversation-title-updated");
      expect(found).toBeDefined();
      return found!;
    });
    expect(titleEvent.detail).toEqual({ id: "c1", title: "New name" });

    const renamedCall = await waitFor(() => {
      const found = setItemSpy.mock.calls.find(([key]) => key === CONVERSATION_RENAMED_KEY);
      expect(found).toBeDefined();
      return found!;
    });
    const payload = JSON.parse(renamedCall[1] as string);
    expect(payload.id).toBe("c1");
    expect(payload.title).toBe("New name");
    expect(typeof payload.timestamp).toBe("number");
  });

  it("fires neither channel when the row no longer exists", async () => {
    // The conversation was deleted between render and commit.
    history.renameConversationManually.mockResolvedValue(false);
    const dispatchSpy = vi.spyOn(window, "dispatchEvent");
    const setItemSpy = vi.spyOn(window.localStorage, "setItem");
    await renderPage();
    const card = await openRowEditor("c1");

    await renameRowTo(card, "New name");
    await waitFor(() => expect(history.renameConversationManually).toHaveBeenCalled());
    // Let the resolved (but falsy) write settle before asserting silence.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const titleEvent = dispatchSpy.mock.calls
      .map(([event]) => event as CustomEvent)
      .find((event) => event.type === "conversation-title-updated");
    expect(titleEvent).toBeUndefined();
    expect(setItemSpy.mock.calls.some(([key]) => key === CONVERSATION_RENAMED_KEY)).toBe(false);
  });

  it("uses a fresh timestamp for a repeated identical rename", async () => {
    // storage does not fire on a byte-identical write - without a nonce the
    // second identical rename would never reach the overlay.
    let now = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now++);
    const setItemSpy = vi.spyOn(window.localStorage, "setItem");
    await renderPage();

    for (let i = 0; i < 2; i++) {
      const card = await openRowEditor("c1");
      await renameRowTo(card, "Same name");
      await waitFor(() => expect(within(card).queryByRole("textbox")).toBeNull());
    }

    await waitFor(() => {
      const payloads = setItemSpy.mock.calls.filter(([key]) => key === CONVERSATION_RENAMED_KEY);
      expect(payloads).toHaveLength(2);
    });

    const payloads = setItemSpy.mock.calls
      .filter(([key]) => key === CONVERSATION_RENAMED_KEY)
      .map(([, value]) => JSON.parse(value as string));
    expect(payloads[0].timestamp).not.toBe(payloads[1].timestamp);
  });

  it("saves from the tick button, not Enter alone", async () => {
    await renderPage();
    const card = await openRowEditor("c1");

    const input = within(card).getByRole("textbox");
    await userEvent.clear(input);
    await userEvent.type(input, "Clicked name");
    await userEvent.click(within(card).getByRole("button", { name: "Save the name" }));

    await waitFor(() =>
      expect(history.renameConversationManually).toHaveBeenCalledWith("c1", "Clicked name")
    );
  });

  it("keeps the typed name on screen and says so when the write is refused", async () => {
    // The same silent-failure case the strip row covers: the card used to
    // close over the user's text and show the old title back, which is
    // indistinguishable from a save that never ran.
    history.renameConversationManually.mockResolvedValue(false);
    await renderPage();
    const card = await openRowEditor("c1");

    await renameRowTo(card, "Refused name");

    await waitFor(() =>
      expect(
        within(conversationCard("c1")!).getByText("That name could not be saved.")
      ).toBeInTheDocument()
    );
    expect(within(conversationCard("c1")!).getByRole("textbox")).toHaveValue("Refused name");
  });

  it("reports a database error instead of leaving an unhandled rejection", async () => {
    // renameConversationManually RETHROWS a database error rather than
    // returning false, so a bare call here would reject into nothing.
    history.renameConversationManually.mockRejectedValue(new Error("database is locked"));
    await renderPage();
    const card = await openRowEditor("c1");

    await renameRowTo(card, "Doomed name");

    await waitFor(() =>
      expect(
        within(conversationCard("c1")!).getByText("That name could not be saved.")
      ).toBeInTheDocument()
    );
  });
});

/** The strip's own pencil, scoped to one queue row rather than a list card. */
async function openStripRowEditor(rowId: string): Promise<HTMLElement> {
  const li = stripRow(rowId)!;
  await userEvent.hover(li);
  await userEvent.click(within(li).getByRole("button", { name: "Rename conversation" }));
  return li;
}

describe("renaming a conversation from the queue strip", () => {
  // Same spy-stacking guard as the list block above.
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("names the conversation on a strip row", async () => {
    // The whole point: a row whose status line reads "No contact chosen" still
    // has to say WHICH meeting it is.
    db.listActionableRows.mockResolvedValue([
      row({ id: "na", status: "unassigned", contact_id: null, conversation_id: "c1" }),
    ]);
    await renderPage();

    await waitFor(() => expect(stripRow("na")).not.toBeNull());
    const li = stripRow("na")!;
    expect(within(li).getByText("Quarterly review")).toBeInTheDocument();
    // toHaveTextContent, not getByText: an unassigned row with no targets says
    // "No contact chosen" twice - once as the heading `targetNameOf` resolves
    // to, once as the status line.
    expect(li).toHaveTextContent("No contact chosen");
    expect(within(li).getByRole("button", { name: "Rename conversation" })).toBeInTheDocument();
  });

  it("renders no name and no pencil on a conversation_id IS NULL row", async () => {
    // Nothing to name, and a rename control here could only ever be refused.
    db.listActionableRows.mockResolvedValue([row({ id: "orphan", conversation_id: null })]);
    await renderPage();

    await waitFor(() => expect(stripRow("orphan")).not.toBeNull());
    const li = stripRow("orphan")!;
    expect(within(li).queryByRole("button", { name: "Rename conversation" })).toBeNull();
    expect(within(li).queryByText("Quarterly review")).toBeNull();
  });

  it("renders no name for a conversation that no longer exists", async () => {
    // The row outlives the conversation: `deleteConversation` leaves the queue
    // row's `conversation_id` pointing at nothing.
    db.listActionableRows.mockResolvedValue([row({ id: "gone", conversation_id: "deleted" })]);
    await renderPage();

    await waitFor(() => expect(stripRow("gone")).not.toBeNull());
    expect(
      within(stripRow("gone")!).queryByRole("button", { name: "Rename conversation" })
    ).toBeNull();
  });

  it("commits with the CONVERSATION id and fires both channels", async () => {
    const dispatchSpy = vi.spyOn(window, "dispatchEvent");
    const setItemSpy = vi.spyOn(window.localStorage, "setItem");
    db.listActionableRows.mockResolvedValue([row({ id: "na", conversation_id: "c1" })]);
    await renderPage();
    await waitFor(() => expect(stripRow("na")).not.toBeNull());

    const li = await openStripRowEditor("na");
    await renameRowTo(li, "Renamed from the strip");

    // "c1", never "na" - the row id only identifies which editor was open.
    await waitFor(() =>
      expect(history.renameConversationManually).toHaveBeenCalledWith(
        "c1",
        "Renamed from the strip"
      )
    );

    const titleEvent = await waitFor(() => {
      const found = dispatchSpy.mock.calls
        .map(([event]) => event as CustomEvent)
        .find((event) => event.type === "conversation-title-updated");
      expect(found).toBeDefined();
      return found!;
    });
    expect(titleEvent.detail).toEqual({ id: "c1", title: "Renamed from the strip" });

    const renamedCall = await waitFor(() => {
      const found = setItemSpy.mock.calls.find(([key]) => key === CONVERSATION_RENAMED_KEY);
      expect(found).toBeDefined();
      return found!;
    });
    expect(JSON.parse(renamedCall[1] as string).id).toBe("c1");
  });

  it("repaints the strip row AND the card below from one commit", async () => {
    // The loop no other test covers end to end: commit -> CustomEvent ->
    // useHistory patch -> the page's title map -> both surfaces. Either memo
    // boundary swallowing the new title shows up here.
    db.listActionableRows.mockResolvedValue([row({ id: "na", conversation_id: "c1" })]);
    await renderPage();
    await waitFor(() => expect(stripRow("na")).not.toBeNull());

    const li = await openStripRowEditor("na");
    await renameRowTo(li, "Renamed everywhere");

    await waitFor(() =>
      expect(within(stripRow("na")!).getByText("Renamed everywhere")).toBeInTheDocument()
    );
    expect(within(conversationCard("c1")!).getByText("Renamed everywhere")).toBeInTheDocument();
  });

  it("saves from the tick button, not Enter alone", async () => {
    // Enter is not an affordance: nothing on screen said the name was saved
    // that way, which is how this read as editable-but-unsaveable.
    db.listActionableRows.mockResolvedValue([row({ id: "na", conversation_id: "c1" })]);
    await renderPage();
    await waitFor(() => expect(stripRow("na")).not.toBeNull());

    const li = await openStripRowEditor("na");
    const input = within(li).getByRole("textbox");
    await userEvent.clear(input);
    await userEvent.type(input, "Saved by button");
    await userEvent.click(within(li).getByRole("button", { name: "Save the name" }));

    await waitFor(() =>
      expect(history.renameConversationManually).toHaveBeenCalledWith("c1", "Saved by button")
    );
    await waitFor(() => expect(within(stripRow("na")!).queryByRole("textbox")).toBeNull());
  });

  it("closes the editor from the cross button without writing", async () => {
    db.listActionableRows.mockResolvedValue([row({ id: "na", conversation_id: "c1" })]);
    await renderPage();
    await waitFor(() => expect(stripRow("na")).not.toBeNull());

    const li = await openStripRowEditor("na");
    await userEvent.clear(within(li).getByRole("textbox"));
    await userEvent.type(within(li).getByRole("textbox"), "Discarded");
    await userEvent.click(within(li).getByRole("button", { name: "Cancel renaming" }));

    expect(history.renameConversationManually).not.toHaveBeenCalled();
    await waitFor(() => expect(within(stripRow("na")!).queryByRole("textbox")).toBeNull());
  });

  it("keeps the typed name on screen and says so when the write is refused", async () => {
    // The silent-failure case: the row used to close over the user's text and
    // show the old name back, which is indistinguishable from a save that
    // never ran.
    history.renameConversationManually.mockResolvedValue(false);
    db.listActionableRows.mockResolvedValue([row({ id: "na", conversation_id: "c1" })]);
    await renderPage();
    await waitFor(() => expect(stripRow("na")).not.toBeNull());

    const li = await openStripRowEditor("na");
    await renameRowTo(li, "Refused name");

    await waitFor(() =>
      expect(within(stripRow("na")!).getByText("That name could not be saved.")).toBeInTheDocument()
    );
    expect(within(stripRow("na")!).getByRole("textbox")).toHaveValue("Refused name");
  });

  it("reports a database error instead of leaving an unhandled rejection", async () => {
    // renameConversationManually RETHROWS a database error rather than
    // returning false.
    history.renameConversationManually.mockRejectedValue(new Error("database is locked"));
    db.listActionableRows.mockResolvedValue([row({ id: "na", conversation_id: "c1" })]);
    await renderPage();
    await waitFor(() => expect(stripRow("na")).not.toBeNull());

    const li = await openStripRowEditor("na");
    await renameRowTo(li, "Doomed name");

    await waitFor(() =>
      expect(within(stripRow("na")!).getByText("That name could not be saved.")).toBeInTheDocument()
    );
  });

  it("refuses an empty name without touching the database", async () => {
    db.listActionableRows.mockResolvedValue([row({ id: "na", conversation_id: "c1" })]);
    await renderPage();
    await waitFor(() => expect(stripRow("na")).not.toBeNull());

    const li = await openStripRowEditor("na");
    await userEvent.clear(within(li).getByRole("textbox"));
    await userEvent.click(within(li).getByRole("button", { name: "Save the name" }));

    expect(history.renameConversationManually).not.toHaveBeenCalled();
    expect(within(stripRow("na")!).getByText("A conversation needs a name.")).toBeInTheDocument();
  });

  it("cancels on Escape without writing", async () => {
    db.listActionableRows.mockResolvedValue([row({ id: "na", conversation_id: "c1" })]);
    await renderPage();
    await waitFor(() => expect(stripRow("na")).not.toBeNull());

    const li = await openStripRowEditor("na");
    const input = within(li).getByRole("textbox");
    await userEvent.clear(input);
    await userEvent.type(input, "Whatever{Escape}");

    expect(history.renameConversationManually).not.toHaveBeenCalled();
    await waitFor(() => expect(within(stripRow("na")!).queryByRole("textbox")).toBeNull());
    expect(within(stripRow("na")!).getByText("Quarterly review")).toBeInTheDocument();
  });

  it("opens one editor when two rows share a conversation", async () => {
    // The duplicate-mint pairs already in the database. Keyed by conversation
    // id, one click would open an autoFocus editor on both and the second
    // would steal the focus from the row the user clicked.
    db.listActionableRows.mockResolvedValue([
      row({ id: "dup1", conversation_id: "c1" }),
      row({ id: "dup2", conversation_id: "c1" }),
    ]);
    await renderPage();
    await waitFor(() => expect(stripRow("dup2")).not.toBeNull());

    await openStripRowEditor("dup1");

    expect(within(stripRow("dup1")!).getByRole("textbox")).toBeInTheDocument();
    expect(within(stripRow("dup2")!).queryByRole("textbox")).toBeNull();
  });

  it("leaves the list's own editor alone", async () => {
    // Two surfaces, two editors: opening one must not open (or close) the
    // other, or a rename in progress on the card below dies on a strip click.
    db.listActionableRows.mockResolvedValue([row({ id: "na", conversation_id: "c1" })]);
    await renderPage();
    await waitFor(() => expect(stripRow("na")).not.toBeNull());

    await openStripRowEditor("na");

    expect(within(stripRow("na")!).getByRole("textbox")).toBeInTheDocument();
    expect(within(conversationCard("c1")!).queryByRole("textbox")).toBeNull();
  });
});

/**
 * `View.tsx` reads `conversationId` from `useParams()`, so it needs an actual
 * matching `<Route>` rather than a bare `<MemoryRouter>` - `Meetings` above
 * never reads route params and gets away with rendering unrouted.
 */
async function renderView(conversationId = "c1") {
  const view = render(
    <MemoryRouter initialEntries={[`/meetings/view/${conversationId}`]}>
      <Routes>
        <Route path="/meetings/view/:conversationId" element={<View />} />
      </Routes>
    </MemoryRouter>
  );
  await waitFor(() => expect(history.getConversationById).toHaveBeenCalledWith(conversationId));
  // Wait for the fetched conversation to land in state before a test acts on
  // the header - the title starts empty until this resolves.
  await screen.findByText("Quarterly review");
  return view;
}

/** The header's `rightSlot`, scoped past the footer's own `role="textbox"` -
 *  the message composer below it is a `<textarea>`, which shares that role. */
function headerRightSlot(): HTMLElement {
  return screen.getByTestId("page-right-slot");
}

/** Finds the pencil in the page header (View's `rightSlot`) and clicks it. */
async function openHeaderEditor(): Promise<void> {
  await userEvent.click(within(headerRightSlot()).getByRole("button", { name: "Rename conversation" }));
}

/** Same pre-filled-input caveat as `renameRowTo` above. */
async function renameHeaderTo(text: string): Promise<void> {
  const input = within(headerRightSlot()).getByRole("textbox");
  await userEvent.clear(input);
  await userEvent.type(input, `${text}{Enter}`);
}

describe("renaming a conversation from the header", () => {
  // Same leak this file's row-rename block guards against: vi.spyOn on
  // window.dispatchEvent/localStorage.setItem stacks across tests otherwise.
  afterEach(() => {
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    // ChatAudio (rendered unconditionally in View's footer) reads
    // selectedSttProvider.provider straight off useApp() with no guard, and
    // View itself gates the whole footer behind hasActiveLicense - neither is
    // read by the list-page tests above, so they are added here rather than
    // in the shared fixture.
    appState.current = {
      ...appState.current,
      hasActiveLicense: true,
      selectedSttProvider: { provider: "" },
    };
    history.getConversationById.mockResolvedValue(
      conversation({ id: "c1", title: "Quarterly review" })
    );
  });

  it("reveals the editor on the header pencil and commits on Enter", async () => {
    const dispatchSpy = vi.spyOn(window, "dispatchEvent");
    const setItemSpy = vi.spyOn(window.localStorage, "setItem");
    await renderView();

    await openHeaderEditor();
    await renameHeaderTo("New header title");

    await waitFor(() =>
      expect(history.renameConversationManually).toHaveBeenCalledWith("c1", "New header title")
    );
    // Mirrors the row's "fires both channels" test: the header's commit path
    // is the same pair, not just the same writer call.
    const titleEvent = await waitFor(() => {
      const found = dispatchSpy.mock.calls
        .map(([event]) => event as CustomEvent)
        .find((event) => event.type === "conversation-title-updated");
      expect(found).toBeDefined();
      return found!;
    });
    expect(titleEvent.detail).toEqual({ id: "c1", title: "New header title" });

    const renamedCall = await waitFor(() => {
      const found = setItemSpy.mock.calls.find(([key]) => key === CONVERSATION_RENAMED_KEY);
      expect(found).toBeDefined();
      return found!;
    });
    const payload = JSON.parse(renamedCall[1] as string);
    expect(payload.id).toBe("c1");
    expect(payload.title).toBe("New header title");
    expect(typeof payload.timestamp).toBe("number");
  });

  it("cancels on Escape without writing", async () => {
    await renderView();
    await openHeaderEditor();

    const input = within(headerRightSlot()).getByRole("textbox");
    await userEvent.clear(input);
    await userEvent.type(input, "Whatever{Escape}");

    expect(history.renameConversationManually).not.toHaveBeenCalled();
    // Back to the read-only header - no editor left open.
    await waitFor(() => expect(within(headerRightSlot()).queryByRole("textbox")).toBeNull());
    expect(screen.getByTestId("page-title")).toHaveTextContent("Quarterly review");
  });

  it("fires neither channel when the row no longer exists", async () => {
    // The conversation was deleted between render and commit.
    history.renameConversationManually.mockResolvedValue(false);
    const dispatchSpy = vi.spyOn(window, "dispatchEvent");
    const setItemSpy = vi.spyOn(window.localStorage, "setItem");
    await renderView();
    await openHeaderEditor();

    await renameHeaderTo("New header title");
    await waitFor(() => expect(history.renameConversationManually).toHaveBeenCalled());
    // Let the resolved (but falsy) write settle before asserting silence.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const titleEvent = dispatchSpy.mock.calls
      .map(([event]) => event as CustomEvent)
      .find((event) => event.type === "conversation-title-updated");
    expect(titleEvent).toBeUndefined();
    expect(setItemSpy.mock.calls.some(([key]) => key === CONVERSATION_RENAMED_KEY)).toBe(false);
  });

  it("keeps the typed name on screen and says so when the write is refused", async () => {
    // Firing neither channel is not enough: the header used to close its
    // editor first and discard the typed name, which reads as a save that
    // silently did nothing.
    history.renameConversationManually.mockResolvedValue(false);
    await renderView();
    await openHeaderEditor();

    await renameHeaderTo("Refused title");

    await waitFor(() =>
      expect(
        within(headerRightSlot()).getByText("That name could not be saved.")
      ).toBeInTheDocument()
    );
    expect(within(headerRightSlot()).getByRole("textbox")).toHaveValue("Refused title");
  });

  it("reports a database error instead of leaving an unhandled rejection", async () => {
    // renameConversationManually RETHROWS a database error rather than
    // returning false, and this commit runs from a keydown handler - without
    // the catch the rejection reaches nobody.
    history.renameConversationManually.mockRejectedValue(new Error("database is locked"));
    await renderView();
    await openHeaderEditor();

    await renameHeaderTo("Doomed title");

    await waitFor(() =>
      expect(
        within(headerRightSlot()).getByText("That name could not be saved.")
      ).toBeInTheDocument()
    );
    expect(within(headerRightSlot()).getByRole("textbox")).toHaveValue("Doomed title");
  });

  it("updates the header when the conversation-title-updated listener fires for this conversation", async () => {
    // The one path the row tests cannot cover: View's `[]`-deped listener
    // (View.tsx:90-100) patching `messages` through a functional updater.
    // `setMessages` is the same setter useChatCompletion appends to during a
    // live completion, which is exactly why that listener is `[]`-deped with
    // an id-checked `prev` read instead of a `[messages]` effect - see the
    // doc comment above it.
    await renderView();
    expect(screen.getByTestId("page-title")).toHaveTextContent("Quarterly review");

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("conversation-title-updated", {
          detail: { id: "c1", title: "Retitled elsewhere" },
        })
      );
    });

    expect(screen.getByTestId("page-title")).toHaveTextContent("Retitled elsewhere");
  });
});
