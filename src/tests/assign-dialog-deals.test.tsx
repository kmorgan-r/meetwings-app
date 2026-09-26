import { act, configure, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Issue #74: AssignDialog's deals panel and lead search, rendered DIRECTLY.
// `vi.hoisted` for the reason src/tests/meeting-log-page.test.tsx:6-9 gives.
// Mocked at the LEAF, as that file does. These six are the minimum that lets
// the dialog render under happy-dom (verified 2026-09-25 with a probe file).
const storage = vi.hoisted(() => ({ requireOdooConfig: vi.fn() }));
vi.mock("@/lib/storage/odoo-config.storage", () => storage);

const contacts = vi.hoisted(() => ({ listContacts: vi.fn(), upsertContacts: vi.fn() }));
vi.mock("@/lib/database/odoo-contacts.action", () => contacts);

const client = vi.hoisted(() => ({ createOdooClient: vi.fn(), DEFAULT_TIMEOUT_MS: 30_000 }));
vi.mock("@/lib/odoo/client", () => client);

const opportunities = vi.hoisted(() => ({
  fetchOpportunities: vi.fn(),
  searchLeads: vi.fn(),
  OPPORTUNITY_LIMIT: 20,
  LEAD_SEARCH_LIMIT: 10,
  LEAD_SEARCH_MIN_CHARS: 2,
  // NOT a spy - see meeting-log-page.test.tsx's own opportunities mock.
  kindLabel: (type: string) => (type === "lead" ? "Lead" : "Opportunity"),
}));
vi.mock("@/lib/odoo/opportunities", () => opportunities);

const meetwings = vi.hoisted(() => ({ shouldUseMeetwingsAPI: vi.fn() }));
vi.mock("@/lib/functions/meetwings.api", () => meetwings);

vi.mock("@/contexts", () => ({
  useApp: () => ({
    allAiProviders: [{ id: "openai", name: "OpenAI" }],
    selectedAIProvider: { provider: "openai", model: "gpt-4o", variables: {} },
    meetwingsApiEnabled: false,
  }),
}));

import { AssignDialog, LEAD_SEARCH_DEBOUNCE_MS } from "@/pages/meetings/components/AssignDialog";
import type { MeetingLogListRow, MeetingLogTarget, OdooContact, OdooOpportunity } from "@/types";

// Most tests here wait through the REAL 350 ms search debounce inside a
// findBy/waitFor window; the default 1000 ms leaves little slack under
// full-suite load. Vitest isolates test files, so this stays in this file.
configure({ asyncUtilTimeout: 3000 });

const INSTANCE = "http://h:8069|odoo";
const CONFIG = { url: "http://h:8069", db: "odoo", login: "bob", apiKey: "sk-live-key" };
/** Held module-wide so a test can assert the SAME client reached a call. */
const CLIENT = { authenticate: vi.fn(), execute: vi.fn() };

function row(): MeetingLogListRow {
  return {
    id: "un",
    session_key: "s1",
    conversation_id: null,
    instance: INSTANCE,
    contact_id: null,
    lead_id: null,
    transcript_start_at: 1_700_000_000_000,
    transcript_end_at: 1_700_000_060_000,
    attachment_id: null,
    message_id: null,
    status: "unassigned",
    attempts: 0,
    claimed_at: null,
    last_error: null,
    last_error_code: null,
    meeting_started_at: 1_700_000_000_000,
    created_at: 1_600_000_000_000,
    sent_at: null,
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

/** A deal LINKED to the contact, as `fetchOpportunities` returns it. */
function deal(over: Partial<OdooOpportunity> = {}): OdooOpportunity {
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

/** An UNLINKED lead, as `searchLeads` returns it - no partner at all. */
function lead(over: Partial<OdooOpportunity> = {}): OdooOpportunity {
  return {
    id: 90,
    name: "Partnership with ECS",
    type: "lead",
    stageName: "New",
    partnerId: null,
    partnerName: null,
    contactName: "Christian Carron",
    email: null,
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

function props(over: { replacing?: MeetingLogTarget } = {}) {
  return { row: row(), instance: INSTANCE, onConfirm: vi.fn(), onCancel: vi.fn(), ...over };
}

/** Renders and waits for step 0 to settle, so the picker is live. */
async function renderReady(p = props()) {
  const view = render(<AssignDialog {...p} />);
  await screen.findByPlaceholderText("Search contacts");
  return { ...view, props: p };
}

function searchBox() {
  return screen.getByPlaceholderText("Search contacts");
}

/**
 * ONE change event. `userEvent.type` sends a keystroke per character, and on
 * a slow runner a gap between two of them can outlast the debounce and put an
 * intermediate query on the wire - which would make every call-count
 * assertion below flaky.
 */
function search(value: string) {
  fireEvent.change(searchBox(), { target: { value } });
}

beforeEach(() => {
  // A test that fakes timers restores them itself; this is the net for one
  // that throws first. A leaked fake clock hangs every later waitFor.
  vi.useRealTimers();
  vi.clearAllMocks();
  storage.requireOdooConfig.mockResolvedValue(CONFIG);
  client.createOdooClient.mockReturnValue(CLIENT);
  contacts.listContacts.mockResolvedValue([contact()]);
  contacts.upsertContacts.mockResolvedValue(1);
  meetwings.shouldUseMeetwingsAPI.mockResolvedValue(false);
  opportunities.fetchOpportunities.mockResolvedValue([]);
  opportunities.searchLeads.mockResolvedValue([]);
});

describe("AssignDialog lead search (issue #74)", () => {
  // THE point of the port: an unconverted lead has no res.partner, so a
  // search that waited for a contact selection could never reach it.
  it("finds a lead with no contact selected first", async () => {
    opportunities.searchLeads.mockResolvedValue([lead()]);
    await renderReady();

    search("carron");

    const name = await screen.findByText("Partnership with ECS");
    expect(name.textContent).toMatch(/^Lead ·/);
    expect(screen.getByText("Leads & opportunities")).toBeInTheDocument();
    expect(opportunities.searchLeads).toHaveBeenCalledWith(CLIENT, "carron");
    expect(opportunities.fetchOpportunities).not.toHaveBeenCalled();
  });

  // One live XML-RPC round trip per keystroke is what the debounce prevents.
  it("sends ONE search for a burst of typing, with the last query", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await renderReady();
      for (const value of ["c", "ca", "car", "carr"]) search(value);
      expect(opportunities.searchLeads).not.toHaveBeenCalled();

      act(() => {
        vi.advanceTimersByTime(LEAD_SEARCH_DEBOUNCE_MS);
      });

      await waitFor(() => expect(opportunities.searchLeads).toHaveBeenCalledTimes(1));
      expect(opportunities.searchLeads).toHaveBeenCalledWith(CLIENT, "carr");
    } finally {
      vi.useRealTimers();
    }
  });

  // The dialog is mounted only while open; the effect cleanup is what stops a
  // pending timer from outliving it.
  it("never searches after the dialog closes with a keystroke pending", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { unmount } = await renderReady();
      search("carron");
      unmount();

      act(() => {
        vi.advanceTimersByTime(LEAD_SEARCH_DEBOUNCE_MS * 2);
      });
      await act(async () => {
        await Promise.resolve();
      });

      expect(opportunities.searchLeads).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  // `null`, not []: [] would say "No matches" for a query nobody ran.
  it("does not search below two characters, and clears earlier results", async () => {
    opportunities.searchLeads.mockResolvedValue([lead()]);
    await renderReady();

    search("carron");
    expect(await screen.findByText("Partnership with ECS")).toBeInTheDocument();

    search("c");
    await waitFor(() => expect(screen.queryByText("Partnership with ECS")).toBeNull());

    expect(opportunities.searchLeads).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("No matches")).toBeNull();
    expect(screen.queryByTestId("lead-search-section")).toBeNull();
  });

  // Review Focus 1. The in-flight search for "carron" lands after the user
  // emptied the box; painting it would show results for a query that is gone.
  // Resolved INSIDE the new query's debounce window - before its own reset
  // has run - which is the window a token bumped only by the timer leaves open.
  it("drops a search that lands after the box was cleared", async () => {
    const gate = deferred<OdooOpportunity[]>();
    opportunities.searchLeads.mockReturnValue(gate.promise);
    await renderReady();

    search("carron");
    await waitFor(() => expect(opportunities.searchLeads).toHaveBeenCalledTimes(1));
    search("");
    await act(async () => {
      gate.resolve([lead()]);
    });

    expect(screen.queryByText("Partnership with ECS")).toBeNull();
    await waitFor(() => expect(screen.queryByTestId("lead-search-section")).toBeNull());
    expect(screen.queryByText("Partnership with ECS")).toBeNull();
  });

  // The REJECT path too, for the reason meeting-log-page.test.tsx's "is
  // token-ordered on the REJECT path too" gives for the contact lookup: a stale
  // failure must not paint over a box that has moved on.
  it("drops a search failure that lands after the box was cleared", async () => {
    const gate = deferred<OdooOpportunity[]>();
    opportunities.searchLeads.mockReturnValue(gate.promise);
    await renderReady();

    search("carron");
    await waitFor(() => expect(opportunities.searchLeads).toHaveBeenCalledTimes(1));
    search("");
    await act(async () => {
      gate.reject(new Error("crm.lead blew up"));
    });

    expect(screen.queryByText(/Search failed/)).toBeNull();
    await waitFor(() => expect(screen.queryByTestId("lead-search-section")).toBeNull());
  });

  it("stages a searched lead as a crm.lead target, worded neutrally", async () => {
    opportunities.searchLeads.mockResolvedValue([lead()]);
    const { props: p } = await renderReady();

    search("carron");
    await userEvent.click(await screen.findByRole("button", { name: "add Partnership with ECS" }));

    // The ROW says "Lead"; the destination sentence cannot - SelectedTarget
    // carries `model`, not `type` (see describeTargetForSentence).
    expect(
      screen.getByText(
        "This meeting will be logged on 1 record: the lead or opportunity Partnership with ECS."
      )
    ).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Log this meeting" }));
    expect(p.onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({
        targets: [{ model: "crm.lead", resId: 90, name: "Partnership with ECS" }],
      })
    );
  });

  it("counts a searched lead against the cap", async () => {
    const letters = ["A", "B", "C", "D", "E"];
    contacts.listContacts.mockResolvedValue(letters.map((n, i) => contact({ id: i + 1, name: n })));
    opportunities.searchLeads.mockResolvedValue([lead()]);
    await renderReady();

    for (const n of letters) {
      await userEvent.click(screen.getByRole("button", { name: `add ${n}` }));
    }
    search("carron");

    expect(
      await screen.findByRole("button", { name: "add Partnership with ECS" })
    ).toHaveAttribute("aria-disabled", "true");
  });

  it("takes a searched lead back off through the same toggle", async () => {
    opportunities.searchLeads.mockResolvedValue([lead()]);
    await renderReady();

    search("carron");
    await userEvent.click(await screen.findByRole("button", { name: "add Partnership with ECS" }));
    expect(screen.getByRole("button", { name: "Log this meeting" })).toBeEnabled();

    await userEvent.click(screen.getByRole("button", { name: "added Partnership with ECS" }));
    expect(screen.getByRole("button", { name: "Log this meeting" })).toBeDisabled();
  });

  // The two failures must stay distinguishable on screen: a failed SEARCH
  // says nothing about whether the picked contact has deals.
  it("shows a failed search as its own error, never as the contact's lookup failure", async () => {
    opportunities.searchLeads.mockRejectedValue(new Error("crm.lead blew up"));
    await renderReady();

    await userEvent.click(screen.getByRole("button", { name: "Ada Lovelace" }));
    expect(
      await screen.findByText("No open opportunities or leads for this contact.")
    ).toBeInTheDocument();

    search("carron");

    expect(await screen.findByText("Search failed (ODOO_INTERNAL).")).toBeInTheDocument();
    expect(screen.queryByText(/could not be read/)).toBeNull();
    expect(screen.getByText("No open opportunities or leads for this contact.")).toBeInTheDocument();
    // The code only - never the raw thrown text.
    expect(document.body.textContent).not.toContain("crm.lead blew up");
  });

  // Searches are superseded by later SEARCHES, not by selections.
  it("keeps search results that land after a contact is picked", async () => {
    const gate = deferred<OdooOpportunity[]>();
    opportunities.searchLeads.mockReturnValue(gate.promise);
    opportunities.fetchOpportunities.mockResolvedValue([deal()]);
    await renderReady();

    search("ada");
    await waitFor(() => expect(opportunities.searchLeads).toHaveBeenCalledTimes(1));
    await userEvent.click(screen.getByRole("button", { name: "Ada Lovelace" }));
    expect(await screen.findByText("Heat pumps for the north wing")).toBeInTheDocument();

    await act(async () => {
      gate.resolve([lead()]);
    });

    expect(await screen.findByText("Partnership with ECS")).toBeInTheDocument();
    expect(screen.getByText("Heat pumps for the north wing")).toBeInTheDocument();
  });

  // Review Focus 2. addTarget dedups by model+resId; both rows read the same
  // `targets`, so both must flip together.
  it("stages a lead once when it shows in both lists", async () => {
    const shared = lead({ partnerId: 7, partnerName: "Ada Lovelace", contactName: null });
    opportunities.fetchOpportunities.mockResolvedValue([shared]);
    opportunities.searchLeads.mockResolvedValue([shared]);
    const { props: p } = await renderReady();

    await userEvent.click(screen.getByRole("button", { name: "Ada Lovelace" }));
    await screen.findByText("Partnership with ECS");
    search("ecs");
    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: "add Partnership with ECS" })).toHaveLength(2)
    );

    await userEvent.click(screen.getAllByRole("button", { name: "add Partnership with ECS" })[0]);

    expect(screen.getAllByRole("button", { name: "added Partnership with ECS" })).toHaveLength(2);
    await userEvent.click(screen.getByRole("button", { name: "Log this meeting" }));
    expect(p.onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({
        targets: [{ model: "crm.lead", resId: 90, name: "Partnership with ECS" }],
      })
    );
  });

  describe("replacing a crm.lead target", () => {
    const DEAD_LEAD: MeetingLogTarget = {
      id: "t-90",
      rowId: "un",
      model: "crm.lead",
      resId: 90,
      name: "Partnership with ECS",
      status: "failed",
      attachmentId: 3265,
      messageId: null,
      lastError: "ODOO_FAULT",
      lastErrorCode: "ODOO_FAULT",
      createdAt: 1,
      sentAt: null,
    };

    // Dead or wrong by definition - the same rule `visible` applies to a
    // replaced res.partner.
    it("does not offer the lead it is replacing, in either list", async () => {
      opportunities.fetchOpportunities.mockResolvedValue([
        lead({ partnerId: 7, partnerName: "Ada Lovelace" }),
        deal(),
      ]);
      opportunities.searchLeads.mockResolvedValue([lead(), lead({ id: 91, name: "Solar retrofit" })]);
      await renderReady(props({ replacing: DEAD_LEAD }));

      await userEvent.click(screen.getByRole("button", { name: "Ada Lovelace" }));
      expect(await screen.findByText("Heat pumps for the north wing")).toBeInTheDocument();
      search("re");
      expect(await screen.findByText("Solar retrofit")).toBeInTheDocument();

      expect(screen.queryByText("Partnership with ECS")).toBeNull();
    });

    // The invariant: "No open opportunities or leads" is a claim about the
    // CRM. Odoo just returned one - it is only hidden because it is the one
    // being replaced - so the claim would be false.
    it("never claims no deals when the only one is the lead being replaced", async () => {
      opportunities.fetchOpportunities.mockResolvedValue([
        lead({ partnerId: 7, partnerName: "Ada Lovelace" }),
      ]);
      await renderReady(props({ replacing: DEAD_LEAD }));

      await userEvent.click(screen.getByRole("button", { name: "Ada Lovelace" }));
      await waitFor(() => expect(opportunities.fetchOpportunities).toHaveBeenCalledTimes(1));
      await waitFor(() =>
        expect(screen.queryByText("Looking up opportunities & leads…")).toBeNull()
      );

      expect(screen.queryByText("No open opportunities or leads for this contact.")).toBeNull();
      expect(screen.queryByText("Partnership with ECS")).toBeNull();
    });

    it("keeps one choice: a second searched lead replaces the first", async () => {
      opportunities.searchLeads.mockResolvedValue([
        lead({ id: 91, name: "Solar retrofit" }),
        lead({ id: 93, name: "Wind audit" }),
      ]);
      const { props: p } = await renderReady(props({ replacing: DEAD_LEAD }));

      search("re");
      await userEvent.click(await screen.findByRole("button", { name: "add Solar retrofit" }));
      await userEvent.click(screen.getByRole("button", { name: "add Wind audit" }));
      await userEvent.click(screen.getByRole("button", { name: "Log this meeting" }));

      expect(p.onConfirm).toHaveBeenCalledWith(
        expect.objectContaining({
          targets: [{ model: "crm.lead", resId: 93, name: "Wind audit" }],
        })
      );
    });
  });
});

describe("AssignDialog: adding a contact previews its deals (issue #74, C0)", () => {
  // `+ add` is the dialog's prominent action. It used to stage the contact
  // and show no deals at all - "they don't show up after selecting one".
  it("shows a contact's deals when it is added, without a name click", async () => {
    opportunities.fetchOpportunities.mockResolvedValue([deal()]);
    await renderReady();

    await userEvent.click(screen.getByRole("button", { name: "add Ada Lovelace" }));

    expect(await screen.findByText("Heat pumps for the north wing")).toBeInTheDocument();
    expect(opportunities.fetchOpportunities).toHaveBeenCalledTimes(1);
    expect(opportunities.fetchOpportunities.mock.calls[0][1]).toMatchObject({ id: 7 });
    expect(screen.getByRole("button", { name: "Ada Lovelace" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    expect(screen.getByRole("button", { name: "added Ada Lovelace" })).toBeInTheDocument();
  });

  it("does not re-fetch a contact that is already previewed", async () => {
    await renderReady();

    await userEvent.click(screen.getByRole("button", { name: "Ada Lovelace" }));
    await waitFor(() => expect(opportunities.fetchOpportunities).toHaveBeenCalledTimes(1));
    await userEvent.click(screen.getByRole("button", { name: "add Ada Lovelace" }));
    expect(screen.getByRole("button", { name: "added Ada Lovelace" })).toBeInTheDocument();
    // Let a wrongly-fired lookup reach the mock before counting.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(opportunities.fetchOpportunities).toHaveBeenCalledTimes(1);
  });

  it("leaves the preview alone when a contact is taken back off", async () => {
    opportunities.fetchOpportunities.mockResolvedValue([deal()]);
    await renderReady();

    await userEvent.click(screen.getByRole("button", { name: "add Ada Lovelace" }));
    expect(await screen.findByText("Heat pumps for the north wing")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "added Ada Lovelace" }));

    expect(screen.getByRole("button", { name: "add Ada Lovelace" })).toBeInTheDocument();
    expect(screen.getByText("Heat pumps for the north wing")).toBeInTheDocument();
    expect(opportunities.fetchOpportunities).toHaveBeenCalledTimes(1);
  });
});

describe("AssignDialog: zero-rows hint (issue #74)", () => {
  it("points at the search box as its own line under an empty lookup", async () => {
    await renderReady();

    await userEvent.click(screen.getByRole("button", { name: "Ada Lovelace" }));

    // The original line, matched WHOLE: the hint must not be appended to it,
    // or meeting-log-page.test.tsx's "a failed fetch never reads as no open
    // deals" pin would pass whichever branch rendered.
    expect(
      await screen.findByText("No open opportunities or leads for this contact.")
    ).toBeInTheDocument();
    expect(
      screen.getByText("Expecting a deal? Search for it by name in the box above.")
    ).toBeInTheDocument();
  });

  it("never shows the hint when the lookup failed", async () => {
    opportunities.fetchOpportunities.mockRejectedValue(new Error("crm.lead blew up"));
    await renderReady();

    await userEvent.click(screen.getByRole("button", { name: "Ada Lovelace" }));

    expect(await screen.findByText(/could not be read/)).toBeInTheDocument();
    expect(
      screen.queryByText("Expecting a deal? Search for it by name in the box above.")
    ).toBeNull();
    expect(screen.queryByText("No open opportunities or leads for this contact.")).toBeNull();
  });
});

describe("[assign-dialog] lookup log (issue #74)", () => {
  let info: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    info = vi.spyOn(console, "info").mockImplementation(() => {});
  });
  afterEach(() => {
    info.mockRestore();
  });

  const lines = () => info.mock.calls.filter((c) => c[0] === "[assign-dialog]");

  // Tells C1 (a company: isCompany, parentId null, rows 0) from C2 (hasEmail,
  // rows 0) in one run - and names nobody.
  it("logs ids, flags and the row count on success, never a name or email", async () => {
    contacts.listContacts.mockResolvedValue([
      contact({ id: 3, name: "Bentley AS", email: "post@bentley.example", isCompany: true }),
    ]);
    opportunities.fetchOpportunities.mockResolvedValue([deal(), deal({ id: 501 })]);
    await renderReady();

    await userEvent.click(screen.getByRole("button", { name: "Bentley AS" }));

    await waitFor(() => expect(lines()).toHaveLength(1));
    expect(lines()[0]).toEqual([
      "[assign-dialog]",
      "opportunities",
      { contactId: 3, parentId: null, isCompany: true, hasEmail: true, rows: 2, code: null },
    ]);
    const flat = JSON.stringify(lines());
    expect(flat).not.toContain("Bentley");
    expect(flat).not.toContain("bentley.example");
    expect(flat).not.toContain("Heat pumps");
  });

  it("logs the error code, and no row count, on failure", async () => {
    opportunities.fetchOpportunities.mockRejectedValue(new Error("crm.lead blew up"));
    await renderReady();

    await userEvent.click(screen.getByRole("button", { name: "Ada Lovelace" }));

    await waitFor(() => expect(lines()).toHaveLength(1));
    expect(lines()[0][2]).toEqual({
      contactId: 7,
      parentId: null,
      isCompany: false,
      hasEmail: false,
      rows: null,
      code: "ODOO_INTERNAL",
    });
  });

  it("counts a whitespace-only email as no email", async () => {
    contacts.listContacts.mockResolvedValue([contact({ email: "   " })]);
    await renderReady();

    await userEvent.click(screen.getByRole("button", { name: "Ada Lovelace" }));

    await waitFor(() => expect(lines()).toHaveLength(1));
    expect(lines()[0][2]).toMatchObject({ hasEmail: false, rows: 0 });
  });

  it("logs nothing for a lookup superseded by a later pick", async () => {
    const a = contact({ id: 7, name: "Ada Lovelace" });
    const b = contact({ id: 8, name: "Grace Hopper" });
    contacts.listContacts.mockResolvedValue([a, b]);
    const pending = deferred<OdooOpportunity[]>();
    opportunities.fetchOpportunities.mockImplementation((_client: unknown, c: OdooContact) =>
      c.id === 7 ? pending.promise : Promise.resolve([])
    );
    await renderReady();

    await userEvent.click(screen.getByRole("button", { name: "Ada Lovelace" }));
    await userEvent.click(screen.getByRole("button", { name: "Grace Hopper" }));

    await waitFor(() => expect(lines()).toHaveLength(1));

    pending.resolve([]);
    await act(async () => {
      await Promise.resolve();
    });

    expect(lines()).toHaveLength(1);
    for (const line of lines()) {
      expect(line[2]).toMatchObject({ contactId: 8 });
    }
  });
});
