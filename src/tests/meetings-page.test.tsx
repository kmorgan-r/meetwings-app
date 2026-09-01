import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
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
}));
vi.mock("@/lib/database/chat-history.action", () => history);

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
vi.mock("@/layouts", () => ({
  PageLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import Meetings from "@/pages/meetings";
import type { ChatConversation, MeetingLogListRow } from "@/types";

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
});

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
