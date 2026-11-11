import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { memo } from "react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Every module-level mock is `vi.hoisted`, for the reason meetings-page.test.tsx
// states: vitest hoists `vi.mock` above the imports.
const db = vi.hoisted(() => ({
  listActionableRows: vi.fn(),
  countActionableQueued: vi.fn(),
  getQueueTranscript: vi.fn(),
  getQueueRow: vi.fn(),
  listConversationBadgeRows: vi.fn(),
  insertQueueRow: vi.fn(),
  readConversationTranscript: vi.fn(),
  NOTION_LANE_OPEN: "1",
}));
vi.mock("@/lib/database/meeting-log.action", () => db);

const history = vi.hoisted(() => ({
  getAllConversations: vi.fn(),
  deleteConversation: vi.fn(),
  renameConversationManually: vi.fn(),
  getConversationById: vi.fn(),
}));
vi.mock("@/lib/database/chat-history.action", () => history);

vi.mock("@/lib/odoo/meeting-log-actions", () => ({
  retryMeetingLog: vi.fn(),
  assignMeetingLog: vi.fn(),
  deleteMeetingLog: vi.fn(),
  retryTarget: vi.fn(),
  removeQueueTarget: vi.fn(),
  enqueueConversation: vi.fn(),
}));

const odooStorage = vi.hoisted(() => ({
  loadOdooConfigState: vi.fn(),
  loadOdooConfig: vi.fn(async () => null),
  requireOdooConfig: vi.fn(),
  saveOdooConfig: vi.fn(),
  clearOdooConfig: vi.fn(async () => {}),
  instanceFingerprint: vi.fn((url: string, database: string) => `${url}|${database}`),
}));
vi.mock("@/lib/storage/odoo-config.storage", () => odooStorage);

vi.mock("@/lib/database/odoo-contacts.action", () => ({ listContacts: vi.fn(async () => []) }));
vi.mock("@/lib/functions/meetwings.api", () => ({ shouldUseMeetwingsAPI: vi.fn(async () => false) }));
vi.mock("@/contexts", () => ({ useApp: () => ({ allAiProviders: [], selectedAIProvider: {} }) }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({ onFocusChanged: async () => () => {} }),
}));
vi.mock("@/layouts", () => ({
  PageLayout: ({ children, title, description }: { children: React.ReactNode; title?: React.ReactNode; description?: React.ReactNode }) => (
    <div>
      <div data-testid="page-title">{title}</div>
      <div data-testid="page-description">{description}</div>
      {children}
    </div>
  ),
}));

// The Notion side. The queue's DB layer is mocked; `@/lib/notion/actions` runs
// for real on top of it, so a click is checked down to the DB call it makes.
const notionQueue = vi.hoisted(() => ({
  listNotionItems: vi.fn(),
  retrySend: vi.fn(),
  cancelSend: vi.fn(),
  offerRowsToWaiting: vi.fn(),
  cancelOfferedRows: vi.fn(),
  listConversationNotionRows: vi.fn(),
  markRowsWaiting: vi.fn(),
}));
vi.mock("@/lib/database/notion-queue.action", () => notionQueue);

const notionStorage = vi.hoisted(() => ({
  isNotionConfigured: vi.fn(),
  NOTION_CONFIG_CHANGED_EVENT: "notion-config-changed",
}));
vi.mock("@/lib/storage/notion-config.storage", () => notionStorage);

const tauriEvent = vi.hoisted(() => ({
  emit: vi.fn(async () => {}),
  listen: vi.fn(async () => () => {}),
}));
vi.mock("@tauri-apps/api/event", () => tauriEvent);

const opener = vi.hoisted(() => ({ openUrl: vi.fn(async () => {}) }));
vi.mock("@tauri-apps/plugin-opener", () => opener);

// Counts renders of the memoised row. The spy is itself `memo`'d with the same
// default shallow compare, so it renders exactly when the real boundary would.
const rowRenders = vi.hoisted(() => ({ spy: vi.fn() }));
vi.mock("@/pages/meetings/components/ConversationRow", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/pages/meetings/components/ConversationRow")>();
  const Real = actual.ConversationRow;
  const Spy = memo(function Spy(props: React.ComponentProps<typeof Real>) {
    rowRenders.spy(props.id);
    return <Real {...props} />;
  });
  return { ...actual, ConversationRow: Spy };
});

import Meetings from "@/pages/meetings";
import { buildBadgeMap } from "@/hooks/useNotionQueue";
import { NOTION_COPY } from "@/lib/notion/errors";
import { groupOf, resolveBadge } from "@/lib/odoo/meeting-log";
import type { NotionItem } from "@/lib/database/notion-queue.action";
import type { ChatConversation, DbNotionSend } from "@/types";

const AT = 1_700_000_000_000;
const PAGE = "https://notion.example/page-1";
const WINNER = "https://notion.example/winner";

function conversation(over: Partial<ChatConversation> = {}): ChatConversation {
  return { id: "c1", title: "Quarterly review", messages: [], createdAt: AT, updatedAt: AT, ...over };
}

function send(over: Partial<DbNotionSend> = {}): NotionItem {
  return {
    kind: "send",
    rowIds: [],
    send: {
      id: "s1", conversation_id: "c1", status: "retry", span_start_at: AT, span_end_at: AT + 60_000,
      attempts: 1, summary_failures: 0, claimed_at: null, next_at: null, error_code: null,
      practices_error_code: null, summary_json: null, create_started_at: null, page_id: null,
      page_url: null, page_created_time: null, lost_to_url: null, body_done: 0,
      toggle_block_id: null, transcript_done: 0, practices_done: 0, created_at: AT, sent_at: null,
      ...over,
    },
  };
}

function rows(over: Partial<Extract<NotionItem, { kind: "rows" }>> = {}): NotionItem {
  return {
    kind: "rows", conversationId: "c1", rowIds: ["r1", "r2"], status: "offered",
    startAt: AT, endAt: AT + 60_000, ...over,
  };
}

/** What the queue returns on the next read. A function, so each read is a fresh array. */
let current: () => NotionItem[] = () => [];

async function renderPage() {
  const view = render(
    <MemoryRouter>
      <Meetings />
    </MemoryRouter>,
  );
  await waitFor(() => expect(history.getAllConversations).toHaveBeenCalled());
  await waitFor(() => expect(notionQueue.listNotionItems).toHaveBeenCalled());
  await act(async () => {
    await Promise.resolve();
  });
  return view;
}

const card = (id: string) => document.querySelector(`[data-conversation-id="${id}"]`) as HTMLElement;
const section = () => screen.getByRole("region", { name: "Notion" });

beforeEach(() => {
  vi.clearAllMocks();
  current = () => [];
  odooStorage.loadOdooConfigState.mockResolvedValue({ state: "absent", config: null });
  db.listActionableRows.mockResolvedValue([]);
  db.countActionableQueued.mockResolvedValue(0);
  db.listConversationBadgeRows.mockResolvedValue([]);
  db.getQueueRow.mockResolvedValue(null);
  db.getQueueTranscript.mockResolvedValue("");
  db.readConversationTranscript.mockResolvedValue([]);
  history.getAllConversations.mockResolvedValue([
    conversation({ id: "c1", title: "Quarterly review" }),
    conversation({ id: "c2", title: "Supplier onboarding", updatedAt: AT - 86_400_000 }),
  ]);
  notionStorage.isNotionConfigured.mockResolvedValue(true);
  notionQueue.listNotionItems.mockImplementation(async () => current());
  notionQueue.retrySend.mockResolvedValue(true);
  notionQueue.cancelSend.mockResolvedValue(true);
  notionQueue.offerRowsToWaiting.mockResolvedValue(true);
  notionQueue.cancelOfferedRows.mockResolvedValue(true);
  notionQueue.listConversationNotionRows.mockResolvedValue([]);
  notionQueue.markRowsWaiting.mockResolvedValue(true);
  tauriEvent.emit.mockResolvedValue(undefined);
  tauriEvent.listen.mockResolvedValue(() => {});
});

describe("the Meetings page, Notion side", () => {
  it("Notion-only user: no rendered text contains 'Odoo' (page, rows, badges, buttons)", async () => {
    current = () => [
      rows({ conversationId: "c1" }),
      send({ id: "s2", conversation_id: "c2", status: "failed", error_code: "NOTION_NO_ACCESS", page_id: "p", page_url: PAGE }),
      send({ id: "s3", conversation_id: "c3", status: "no_summary", error_code: "SUMMARY_NO_PROVIDER" }),
      send({ id: "s4", conversation_id: "c4", status: "retry", page_id: "p", page_url: PAGE, practices_error_code: "PRACTICES_UNDECIDED" }),
    ];
    const { container } = await renderPage();
    await screen.findByRole("region", { name: "Notion" });

    expect(container.textContent).not.toMatch(/odoo/i);
    expect(screen.getByTestId("page-description").textContent).toBe(
      "Your conversations, and the meetings waiting to reach Notion.",
    );
  });

  it("describes the page by what is set up", async () => {
    odooStorage.loadOdooConfigState.mockResolvedValue({
      state: "complete",
      config: { url: "http://h:8069", db: "odoo", login: "bob", apiKey: "k" },
    });
    await renderPage();
    await waitFor(() =>
      expect(screen.getByTestId("page-description").textContent).toBe(
        "Your conversations, and the meetings waiting to reach Odoo and Notion.",
      ),
    );
  });

  it("keeps the Odoo-only and neither descriptions", async () => {
    notionStorage.isNotionConfigured.mockResolvedValue(false);
    const { unmount } = await renderPage();
    await waitFor(() =>
      expect(screen.getByTestId("page-description").textContent).toBe("Your conversations."),
    );
    unmount();

    odooStorage.loadOdooConfigState.mockResolvedValue({
      state: "complete",
      config: { url: "http://h:8069", db: "odoo", login: "bob", apiKey: "k" },
    });
    await renderPage();
    await waitFor(() =>
      expect(screen.getByTestId("page-description").textContent).toBe(
        "Your conversations, and the meetings waiting to reach Odoo.",
      ),
    );
  });

  it("a no_summary send shows 'Couldn't summarise', the fixed reason and a Retry that calls retrySend", async () => {
    current = () => [send({ id: "s9", status: "no_summary", error_code: "SUMMARY_NO_PROVIDER" })];
    await renderPage();

    const region = await screen.findByRole("region", { name: "Notion" });
    expect(within(card("c1")).getByText("Couldn't summarise")).toBeInTheDocument();
    expect(within(region).getByText(NOTION_COPY.SUMMARY_NO_PROVIDER)).toBeInTheDocument();
    await userEvent.click(within(region).getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(notionQueue.retrySend).toHaveBeenCalledWith("s9"));
  });

  it("an already send shows 'Already in Notion' linking to the winner page", async () => {
    current = () => [send({ status: "already", lost_to_url: WINNER })];
    await renderPage();

    const badge = await within(card("c1")).findByText("Already in Notion");
    await userEvent.click(badge);
    expect(opener.openUrl).toHaveBeenCalledWith(WINNER);
    // Done states stay out of the section.
    expect(screen.queryByRole("region", { name: "Notion" })).toBeNull();
  });

  it("practices pending shows 'Practices not added yet' with the page link and the reason", async () => {
    current = () => [
      send({ status: "retry", page_id: "p", page_url: PAGE, practices_done: 0, practices_error_code: "PRACTICES_UNDECIDED" }),
    ];
    await renderPage();

    const badge = await within(card("c1")).findByText("Practices not added yet");
    await userEvent.click(badge);
    expect(opener.openUrl).toHaveBeenCalledWith(PAGE);
    expect(within(section()).getByText(NOTION_COPY.PRACTICES_UNDECIDED)).toBeInTheDocument();
  });

  it("a 429-coded send is shown as waiting, not as a failure", async () => {
    current = () => [send({ status: "retry", error_code: "NOTION_RATE_LIMITED" })];
    await renderPage();

    const badge = await within(card("c1")).findByText("Sending to Notion");
    expect(badge.closest("[data-notion-tone]")).toHaveAttribute("data-notion-tone", "waiting");
    expect(screen.queryByText("Notion failed")).toBeNull();
  });

  it("a retrying send left holding a stale auth code shows no reason", async () => {
    // requeueAuthFailures puts the send back to 'retry' without clearing error_code.
    current = () => [send({ status: "retry", error_code: "NOTION_UNAUTHORIZED" })];
    const { container } = await renderPage();

    await within(card("c1")).findByText("Sending to Notion");
    expect(container.textContent).not.toContain(NOTION_COPY.NOTION_UNAUTHORIZED);
    expect(within(section()).getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("offered rows show Send to Notion; pressing it calls offerRowsToWaiting with the group's row ids", async () => {
    current = () => [rows({ rowIds: ["r1", "r2"] })];
    await renderPage();

    await within(card("c1")).findByText("Send to Notion");
    await userEvent.click(within(section()).getByRole("button", { name: "Send to Notion" }));

    await waitFor(() => expect(notionQueue.offerRowsToWaiting).toHaveBeenCalledWith(["r1", "r2"]));
    expect(tauriEvent.emit).toHaveBeenCalledWith("notion-kick");
  });

  it("offered rows can be dropped with Don't send", async () => {
    current = () => [rows({ rowIds: ["r1", "r2"] })];
    await renderPage();

    await userEvent.click(await within(await screen.findByRole("region", { name: "Notion" })).findByRole("button", { name: "Don't send" }));
    await waitFor(() => expect(notionQueue.cancelOfferedRows).toHaveBeenCalledWith(["r1", "r2"]));
  });

  it("a failed send with a page offers Stop and keep page, which calls cancelSend; the row badge then reads 'In Notion' and the Notion section no longer lists it", async () => {
    const failed = send({ id: "s5", status: "failed", error_code: "NOTION_PAGE_CHANGED", page_id: "p", page_url: PAGE });
    current = () => [failed];
    notionQueue.cancelSend.mockImplementation(async () => {
      current = () => [send({ id: "s5", status: "cancelled", page_id: "p", page_url: PAGE })];
      return true;
    });
    await renderPage();

    await within(card("c1")).findByText("Notion failed");
    const region = section();
    expect(within(region).queryByRole("button", { name: "Don't send" })).toBeNull();
    await userEvent.click(within(region).getByRole("button", { name: "Stop and keep page" }));

    await waitFor(() => expect(notionQueue.cancelSend).toHaveBeenCalledWith("s5"));
    await within(card("c1")).findByText("In Notion");
    expect(screen.queryByRole("region", { name: "Notion" })).toBeNull();
  });

  it("the Notion section renders with no Odoo config at all", async () => {
    odooStorage.loadOdooConfigState.mockResolvedValue({ state: "absent", config: null });
    current = () => [rows()];
    await renderPage();

    expect(await screen.findByRole("region", { name: "Notion" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Notion" })).toBeInTheDocument();
  });

  it("a reload with unchanged Notion state does not re-render ConversationRow", async () => {
    current = () => [send({ status: "failed", error_code: "NOTION_NO_ACCESS" })];
    await renderPage();
    await within(card("c1")).findByText("Notion failed");

    const before = rowRenders.spy.mock.calls.length;
    const reads = notionQueue.listNotionItems.mock.calls.length;
    fireEvent(window, new Event("focus"));
    await waitFor(() => expect(notionQueue.listNotionItems.mock.calls.length).toBeGreaterThan(reads));
    await act(async () => {
      await Promise.resolve();
    });

    expect(rowRenders.spy.mock.calls.length).toBe(before);
  });

  describe("the row's Send to Notion button", () => {
    it("is offered on a conversation with no Notion state, and not on a system audio one", async () => {
      history.getAllConversations.mockResolvedValue([
        conversation({ id: "c1" }),
        conversation({ id: "sysaudio_conv_1", title: "System audio" }),
      ]);
      await renderPage();

      await within(card("c1")).findByRole("button", { name: "Send to Notion" });
      expect(within(card("sysaudio_conv_1")).queryByRole("button", { name: "Send to Notion" })).toBeNull();
    });

    it("is disabled while pending, and a second click does not send again", async () => {
      let release: (v: boolean) => void = () => {};
      notionQueue.listConversationNotionRows.mockResolvedValue([
        { id: "r1", status: "none", notion_status: "offered", notion_send_id: null, transcript: "hi", lane_open: 0, send_status: null, send_page_id: null },
      ]);
      notionQueue.markRowsWaiting.mockImplementation(() => new Promise<boolean>((r) => (release = r)));
      await renderPage();

      const button = await within(card("c1")).findByRole("button", { name: "Send to Notion" });
      await userEvent.click(button);
      await waitFor(() => expect(notionQueue.markRowsWaiting).toHaveBeenCalledTimes(1));
      expect(button).toBeDisabled();
      await userEvent.click(button);
      expect(notionQueue.listConversationNotionRows).toHaveBeenCalledTimes(1);

      await act(async () => release(true));
    });

    it("shows the fixed 'already' message", async () => {
      notionQueue.listConversationNotionRows.mockResolvedValue([
        { id: "r1", status: "none", notion_status: "waiting", notion_send_id: null, transcript: "hi", lane_open: 1, send_status: null, send_page_id: null },
      ]);
      await renderPage();

      await userEvent.click(await within(card("c1")).findByRole("button", { name: "Send to Notion" }));
      expect(await within(card("c1")).findByText("This meeting is already in Notion or on its way.")).toBeInTheDocument();
    });

    it("shows notionErrorText's copy on a rejection, never the error message", async () => {
      notionQueue.listConversationNotionRows.mockRejectedValue(new Error("secret db detail"));
      vi.spyOn(console, "error").mockImplementation(() => {});
      const { container } = await renderPage();

      await userEvent.click(await within(card("c1")).findByRole("button", { name: "Send to Notion" }));
      expect(await within(card("c1")).findByText(NOTION_COPY.NOTION_INTERNAL)).toBeInTheDocument();
      expect(container.textContent).not.toContain("secret db detail");
    });
  });
});

describe("buildBadgeMap", () => {
  it("a stopped send's 'In Notion' never hides a later send's problem in the same conversation", () => {
    const stopped = send({ id: "a", status: "cancelled", page_id: "p", page_url: PAGE });
    const failed = send({ id: "b", status: "failed", error_code: "NOTION_NO_ACCESS" });
    expect(buildBadgeMap([stopped, failed]).get("c1")?.label).toBe("Notion failed");
    expect(buildBadgeMap([failed, stopped]).get("c1")?.label).toBe("Notion failed");
  });

  it("ranks worst first across the whole table", () => {
    const ladder: [NotionItem, string][] = [
      [send({ status: "failed" }), "Notion failed"],
      [send({ status: "no_summary" }), "Couldn't summarise"],
      [send({ status: "retry", error_code: "SUMMARY_NETWORK" }), "Waiting for summary"],
      [send({ status: "retry", page_id: "p", practices_error_code: "PRACTICES_UNDECIDED" }), "Practices not added yet"],
      [send({ status: "sending" }), "Sending to Notion"],
      [rows({ status: "offered" }), "Send to Notion"],
      [rows({ status: "held" }), "Waiting for the meeting to end"],
      [send({ status: "already" }), "Already in Notion"],
      [send({ status: "sent" }), "In Notion"],
    ];
    for (let worse = 0; worse < ladder.length; worse++) {
      for (let better = worse + 1; better < ladder.length; better++) {
        expect(buildBadgeMap([ladder[better][0], ladder[worse][0]]).get("c1")?.label).toBe(ladder[worse][1]);
        expect(buildBadgeMap([ladder[worse][0], ladder[better][0]]).get("c1")?.label).toBe(ladder[worse][1]);
      }
    }
  });

  it("gives an item with no conversation no badge, and an unmatched item none either", () => {
    expect(buildBadgeMap([send({ conversation_id: null, status: "failed" })]).size).toBe(0);
    expect(buildBadgeMap([send({ status: "cancelled" })]).size).toBe(0);
  });

  it("links only where the table says", () => {
    const m = (item: NotionItem) => buildBadgeMap([item]).get("c1");
    expect(m(send({ status: "failed", page_url: PAGE }))).toEqual({ label: "Notion failed", url: PAGE, tone: "attention" });
    expect(m(send({ status: "no_summary", page_url: PAGE }))?.url).toBeNull();
    expect(m(send({ status: "already", lost_to_url: WINNER }))?.url).toBe(WINNER);
    expect(m(rows())?.url).toBeNull();
  });
});

describe("the Odoo badge resolver", () => {
  it("a 'none' row gets no Odoo badge from groupOf/resolveBadge", () => {
    const none = { status: "none", instance: "i", attempts: 0 };
    expect(groupOf(none as never, "i")).toBeNull();
    expect(resolveBadge([none], "i")).toBeNull();
  });
});
