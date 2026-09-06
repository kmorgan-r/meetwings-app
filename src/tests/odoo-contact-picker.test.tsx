import { useState } from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import {
  ContactPicker,
  LEAD_SEARCH_DEBOUNCE_MS,
  MAX_RENDERED_ROWS,
  type ContactPickerProps,
} from "@/pages/app/components/completion/ContactPicker";
import type { OdooContact, OdooOpportunity, SelectedTarget } from "@/types";

// Task 12 fix round 1: AddToggle's add branch now surfaces a `{ok:false,
// reason:"cap"}` return via toast.error - the same mock shape
// useCompletion.meeting-assist.test.tsx and useOdooTarget.test.tsx already
// use for the same library.
vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

function contact(over: Partial<OdooContact> = {}): OdooContact {
  return {
    id: 1,
    name: "Ada Lovelace",
    email: "ada@x.no",
    phone: null,
    companyName: "Analytical Ltd",
    parentId: 9,
    isCompany: false,
    active: true,
    writeDate: "2026-08-01 10:00:00",
    isColleague: false,
    lastMeetingAt: null,
    ...over,
  };
}

// ContactPicker is a CONTROLLED component (Finding 1: the caller's resize
// effect must observe every open/close, so ContactPicker cannot own that
// state itself). This harness plays the caller's role for every other test
// in this file, which cares about the CONTENTS of the popover, not who owns
// `open` - it mirrors `open` back through onOpenChange so openPopover() below
// still opens it, while still forwarding calls to the spy under test so the
// dedicated "open state" tests can assert on them.
function Harness(props: ContactPickerProps) {
  const [open, setOpen] = useState(props.open);
  return (
    <ContactPicker
      {...props}
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        props.onOpenChange(next);
      }}
    />
  );
}

// Split from setup() (Task 12) so a test that only needs a props object -
// never rendering it itself, e.g. the trigger-label test below, which renders
// a bare <ContactPicker> instead of the open-state Harness - can build one
// without a second, redundant render leaving two matching trigger buttons in
// the document.
function defaultProps(over: Partial<ContactPickerProps> = {}): ContactPickerProps {
  return {
    contactId: null,
    leadId: null,
    leadName: null,
    contactName: null,
    cache: { kind: "ready", contacts: [contact()], lastError: null },
    opportunities: null,
    opportunityError: null,
    isLookingUp: false,
    leadResults: null,
    leadSearchError: null,
    isSearchingLeads: false,
    // All async handlers resolve, matching the Promise<void> contract.
    onSelectLead: vi.fn(async () => {}),
    onSearchLeads: vi.fn(async () => {}),
    onSelect: vi.fn(async () => {}),
    onSelectOpportunity: vi.fn(async () => {}),
    onToggleColleague: vi.fn(async () => {}),
    onRetryOpportunities: vi.fn(async () => {}),
    onRefresh: vi.fn(async () => {}),
    onOpenSettings: vi.fn(),
    // Task 12: the flat multi-target list and its own per-contact deal
    // lookup, mirroring useOdooTarget.ts's UseOdooTargetReturn field names
    // exactly (verified against source) so wiring pickerProps there is a
    // straight pass-through.
    targets: [],
    onAddTarget: vi.fn(async () => ({ ok: true })),
    onRemoveTarget: vi.fn(async () => {}),
    onClearTargets: vi.fn(async () => {}),
    onExpandContact: vi.fn(async () => {}),
    opportunitiesFor: vi.fn(() => null),
    errorFor: vi.fn(() => null),
    onRetryContactOpportunities: vi.fn(async () => {}),
    open: false,
    onOpenChange: vi.fn(),
    ...over,
  };
}

function setup(over: Partial<ContactPickerProps> = {}) {
  const props = defaultProps(over);
  render(<Harness {...props} />);
  return props;
}


// The trigger's own label is no longer a fixed set of strings once `targets`
// is non-empty (Task 12: it shows "<first target> + N more"), so a name-based
// query on it is no longer stable. Queried by testid instead - the rows still
// do not exist until it is clicked.
async function openPopover() {
  await userEvent.click(screen.getByTestId("contact-picker-trigger"));
}

/** The select button inside a row, addressed without touching the star. */
function rowButton(index = 0) {
  return within(screen.getAllByTestId("contact-row")[index]).getAllByRole("button")[0];
}

describe("the chip", () => {
  it("prompts when nothing is selected", () => {
    setup();
    expect(screen.getByRole("button", { name: /who are you meeting/i })).toBeInTheDocument();
  });

  it("shows the selected contact's name", () => {
    setup({ contactId: 1, contactName: "Ada Lovelace" });
    expect(screen.getByRole("button", { name: /ada lovelace/i })).toBeInTheDocument();
  });
});

describe("the empty states", () => {
  // "No contacts match" and "the cache has never synced" mean completely
  // different things and demand different actions from the user. Rendering
  // both as an empty list is the failure this feature is written against.
  it("distinguishes never-synced from no-matches", async () => {
    setup({ cache: { kind: "never-synced" } });
    await openPopover();
    expect(screen.getByText(/have not synced yet/i)).toBeInTheDocument();
    expect(screen.queryByText(/no contacts match/i)).not.toBeInTheDocument();
  });

  // The state most first-time users are in. Telling them their contacts "have
  // not synced yet" is true, useless, and points them at a Refresh button that
  // can only fail again - they have entered no credentials.
  it("distinguishes not-configured from never-synced, and offers Settings not Refresh", async () => {
    const { onOpenSettings } = setup({ cache: { kind: "not-configured" } });
    await openPopover();
    expect(screen.getByText(/not set up yet/i)).toBeInTheDocument();
    expect(screen.queryByText(/have not synced yet/i)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /open settings/i }));
    expect(onOpenSettings).toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /refresh/i })).not.toBeInTheDocument();
  });

  it("shows the code when the last sync failed and there is nothing cached", async () => {
    setup({ cache: { kind: "sync-failed", code: "ODOO_UNREACHABLE" } });
    await openPopover();
    expect(screen.getByText(/ODOO_UNREACHABLE/)).toBeInTheDocument();
  });

  // A failure over a POPULATED cache is a banner, not a replacement. A cached
  // list does not stop being correct because the latest refresh could not reach
  // the server, and last_error_code persists until a run completes - so hiding
  // the rows would lock an offline user out of a perfectly good list at every
  // app start.
  it("keeps the rows usable under a banner when a sync failed over a full cache", async () => {
    setup({ cache: { kind: "ready", contacts: [contact()], lastError: "ODOO_UNREACHABLE" } });
    await openPopover();
    expect(screen.getByText(/ODOO_UNREACHABLE/)).toBeInTheDocument();
    expect(screen.getAllByTestId("contact-row")).toHaveLength(1);
    expect(rowButton()).toBeEnabled();
  });

  it("says no contacts match when a filter excludes everything", async () => {
    setup();
    await openPopover();
    await userEvent.type(screen.getByPlaceholderText(/search/i), "zzzz");
    expect(screen.getByText(/no contacts match/i)).toBeInTheDocument();
  });
});

describe("the rows", () => {
  // Queried by TESTID, not by accessible name. The star's aria-label is
  // "Mark Ada Lovelace as a colleague", which also matches /ada lovelace/i - a
  // name query finds two buttons and throws "found multiple elements".
  it("renders an archived contact greyed and unselectable", async () => {
    const props = setup({ cache: { kind: "ready", contacts: [contact({ active: false })], lastError: null } });
    await openPopover();
    const select = rowButton();
    expect(select).toBeDisabled();
    await userEvent.click(select);
    expect(props.onSelect).not.toHaveBeenCalled();
  });

  it("selects a contact", async () => {
    const props = setup();
    await openPopover();
    await userEvent.click(rowButton());
    expect(props.onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }));
  });

  // The star is a SIBLING of the select button, not nested inside it. Nested,
  // the row's accessible name would absorb this label and make the query below
  // ambiguous too - and a click inside a disabled button never fires.
  it("toggles the colleague star without selecting", async () => {
    const props = setup();
    await openPopover();
    const star = within(screen.getAllByTestId("contact-row")[0]).getAllByRole("button")[1];
    expect(star).toHaveAttribute("aria-label", "Mark Ada Lovelace as a colleague");
    await userEvent.click(star);
    expect(props.onToggleColleague).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }));
    expect(props.onSelect).not.toHaveBeenCalled();
  });

  // The label text is static ("Mark X as a colleague") regardless of current
  // state, so aria-pressed is the ONLY way a screen reader can tell whether a
  // contact is already a colleague - without it the control is a toggle whose
  // state is conveyed by a CSS class alone.
  it("exposes the colleague star's state via aria-pressed", async () => {
    setup({
      cache: {
        kind: "ready",
        contacts: [contact({ id: 1, name: "Ann", isColleague: false }), contact({ id: 2, name: "Bob", isColleague: true })],
        lastError: null,
      },
    });
    await openPopover();
    const rows = screen.getAllByTestId("contact-row");
    // compareContacts sorts colleagues first, so Bob (isColleague: true) is row 0.
    const bobStar = within(rows[0]).getAllByRole("button")[1];
    const annStar = within(rows[1]).getAllByRole("button")[1];
    expect(bobStar).toHaveAttribute("aria-pressed", "true");
    expect(annStar).toHaveAttribute("aria-pressed", "false");
  });

  it("orders colleagues above everyone else", async () => {
    setup({
      cache: {
        kind: "ready",
        contacts: [contact({ id: 1, name: "Ann" }), contact({ id: 2, name: "Bob", isColleague: true })],
        lastError: null,
      },
    });
    await openPopover();
    const names = screen.getAllByTestId("contact-row").map((n) => n.textContent);
    expect(names[0]).toContain("Bob");
  });

  // The cache is explicitly several thousand rows, and this component
  // re-renders on every streamed AI chunk.
  it(`renders at most ${MAX_RENDERED_ROWS} rows and says so`, async () => {
    setup({
      cache: {
        kind: "ready",
        contacts: Array.from({ length: 250 }, (_v, i) =>
          contact({ id: i + 1, name: `Person ${String(i).padStart(3, "0")}` })
        ),
        lastError: null,
      },
    });
    await openPopover();
    expect(screen.getAllByTestId("contact-row")).toHaveLength(MAX_RENDERED_ROWS);
    expect(screen.getByText(/refine your search/i)).toBeInTheDocument();
  });
});

describe("opportunities", () => {
  it("lists several and picks one", async () => {
    const props = setup({
      contactId: 1,
      contactName: "Ada Lovelace",
      opportunities: [
        { id: 5, name: "Heat pump", type: "opportunity", stageName: "Proposition", partnerId: 1, partnerName: "Ada" },
        { id: 6, name: "Solar", type: "opportunity", stageName: "Qualified", partnerId: 9, partnerName: "Analytical Ltd" },
      ],
    });
    await openPopover();
    await userEvent.click(screen.getByRole("button", { name: /solar/i }));
    expect(props.onSelectOpportunity).toHaveBeenCalledWith(6);
  });

  // It must be visible WHICH record a deal hangs off - the contact, or the
  // company - because that is where slice 2 will post.
  //
  // The partnerName is deliberately NOT "Analytical Ltd": that is contact()'s
  // companyName, which the row renders too, so the query would match two
  // elements and getByText would throw.
  it("labels each opportunity with its own partner", async () => {
    setup({
      contactId: 1,
      contactName: "Ada Lovelace",
      opportunities: [
        {
          id: 6,
          name: "Solar",
          type: "opportunity",
          stageName: "Qualified",
          partnerId: 9,
          partnerName: "Parent Holdings AS",
        },
      ],
    });
    await openPopover();
    expect(screen.getByText(/Parent Holdings AS/)).toBeInTheDocument();
  });

  it("offers 'Contact record only'", async () => {
    const props = setup({
      contactId: 1,
      contactName: "Ada Lovelace",
      opportunities: [
        { id: 5, name: "Heat pump", type: "opportunity", stageName: null, partnerId: 1, partnerName: "Ada" },
      ],
    });
    await openPopover();
    await userEvent.click(screen.getByRole("button", { name: /contact record only/i }));
    expect(props.onSelectOpportunity).toHaveBeenCalledWith(null);
  });

  // Rendering a failed lookup as "None" is the "a value that means fine when
  // it means unknown" pattern - and here it would route a meeting to the wrong
  // record.
  it("shows an unavailable marker on a failed lookup, never an empty list", async () => {
    const props = setup({
      contactId: 1,
      contactName: "Ada Lovelace",
      opportunities: [],
      opportunityError: "ODOO_UNREACHABLE",
    });
    await openPopover();
    expect(screen.getByText(/opportunities & leads unavailable/i)).toBeInTheDocument();
    expect(screen.getByText(/ODOO_UNREACHABLE/)).toBeInTheDocument();
    // Retry calls the hook's own callback. The component holds only primitives
    // and cannot reconstruct the OdooContact that onSelect demands - and with a
    // non-ready cache it could not find one either.
    await userEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(props.onRetryOpportunities).toHaveBeenCalled();
  });

  // `null` means NOT LOOKED UP, and it is the normal state of a selection
  // rehydrated after a <Completion /> remount - the hook restores the target
  // but does not re-run the lookup. Falling through to the list branch renders
  // an empty list plus "Contact record only", which says "no open deals" while
  // a restored leadId sits selected and unlisted.
  it("distinguishes 'not looked up' from 'none found'", async () => {
    const props = setup({
      contactId: 1,
      contactName: "Ada Lovelace",
      opportunities: null,
    });
    await openPopover();
    expect(screen.getByText(/not looked up/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /contact record only/i })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /look up/i }));
    expect(props.onRetryOpportunities).toHaveBeenCalled();
  });

  it("shows an empty result as an actual empty result", async () => {
    setup({ contactId: 1, contactName: "Ada Lovelace", opportunities: [] });
    await openPopover();
    expect(screen.queryByText(/not looked up/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /contact record only/i })).toBeInTheDocument();
  });

  // The picker took `leadId` and threw it away (`leadId: _leadId`), so nothing
  // on screen moved when either row was clicked - and the muted opt-out under a
  // deal read as a caption describing the deal rather than an alternative to it.
  it("marks the chosen opportunity pressed and the others not", async () => {
    setup({
      contactId: 1,
      contactName: "Ada Lovelace",
      leadId: 6,
      opportunities: [
        { id: 5, name: "Heat pump", type: "opportunity", stageName: null, partnerId: 1, partnerName: "Ada" },
        { id: 6, name: "Solar", type: "opportunity", stageName: null, partnerId: 1, partnerName: "Ada" },
      ],
    });
    await openPopover();
    expect(screen.getByRole("button", { name: /solar/i })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /heat pump/i })).toHaveAttribute(
      "aria-pressed",
      "false"
    );
    expect(screen.getByRole("button", { name: /contact record only/i })).toHaveAttribute(
      "aria-pressed",
      "false"
    );
  });

  it("marks 'Contact record only' pressed when no deal is chosen", async () => {
    setup({
      contactId: 1,
      contactName: "Ada Lovelace",
      leadId: null,
      opportunities: [
        { id: 5, name: "Heat pump", type: "opportunity", stageName: null, partnerId: 1, partnerName: "Ada" },
      ],
    });
    await openPopover();
    expect(screen.getByRole("button", { name: /contact record only/i })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    expect(screen.getByRole("button", { name: /heat pump/i })).toHaveAttribute(
      "aria-pressed",
      "false"
    );
  });

  // aria-pressed is the semantic half; this is the half a sighted user reads.
  // The tick is HELD on every row (`invisible`, not unmounted) so picking one
  // does not shunt the list sideways - hence the length assertion.
  it("ticks the chosen row and holds the column on the rest", async () => {
    setup({
      contactId: 1,
      contactName: "Ada Lovelace",
      leadId: 6,
      opportunities: [
        { id: 5, name: "Heat pump", type: "opportunity", stageName: null, partnerId: 1, partnerName: "Ada" },
        { id: 6, name: "Solar", type: "opportunity", stageName: null, partnerId: 1, partnerName: "Ada" },
      ],
    });
    await openPopover();
    expect(screen.getAllByTestId("lead-check")).toHaveLength(3);
    expect(
      within(screen.getByRole("button", { name: /solar/i })).getByTestId("lead-check")
    ).not.toHaveClass("invisible");
    expect(
      within(screen.getByRole("button", { name: /heat pump/i })).getByTestId("lead-check")
    ).toHaveClass("invisible");
    expect(
      within(screen.getByRole("button", { name: /contact record only/i })).getByTestId(
        "lead-check"
      )
    ).toHaveClass("invisible");
  });

  // Which MODEL the meeting lands on is the one thing the labels cannot show
  // and the push cannot take back, so the picker says it in words.
  it("names the contact record as the destination when no deal is chosen", async () => {
    setup({
      contactId: 1,
      contactName: "Ada Lovelace",
      leadId: null,
      opportunities: [
        { id: 5, name: "Heat pump", type: "opportunity", stageName: null, partnerId: 1, partnerName: "Ada" },
      ],
    });
    await openPopover();
    expect(
      screen.getByText(/logged on Ada Lovelace's contact record/i)
    ).toBeInTheDocument();
  });

  it("names the opportunity as the destination once one is chosen", async () => {
    setup({
      contactId: 1,
      contactName: "Ada Lovelace",
      leadId: 5,
      opportunities: [
        { id: 5, name: "Heat pump", type: "opportunity", stageName: null, partnerId: 1, partnerName: "Ada" },
      ],
    });
    await openPopover();
    expect(screen.getByText(/logged on the opportunity Heat pump/i)).toBeInTheDocument();
    expect(screen.queryByText(/contact record\./i)).not.toBeInTheDocument();
  });

  // A target rehydrated after a <Completion /> remount holds a lead id with no
  // list to name it from - `leadId` is in the DB, `opportunities` is in memory.
  // Reading that as "no deal chosen" would state the opposite of what is
  // written. Same branch covers a deal that has since been won or lost.
  it("still names the lead when the list cannot identify it", async () => {
    setup({
      contactId: 1,
      contactName: "Ada Lovelace",
      leadId: 6,
      opportunities: null,
    });
    await openPopover();
    expect(screen.getByText(/picked earlier \(#6\)/i)).toBeInTheDocument();
    // NEUTRAL wording, and that is the assertion. Only `lead_id` is persisted,
    // never its kind, so this branch has nothing to tell a lead from an
    // opportunity and must not name either.
    expect(screen.queryByText(/the opportunity you picked/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/the lead you picked/i)).not.toBeInTheDocument();
  });

  // Leads and opportunities are the same Odoo table and the same write, but
  // they are not the same thing to say out loud. EVERY row carries its kind as
  // a prefix - marking only leads reads as "unmarked means deal", which is
  // true only for someone who remembers the list before leads were in it.
  it("labels every row with its kind", async () => {
    setup({
      contactId: 1,
      contactName: "Ada Lovelace",
      opportunities: [
        { id: 5, name: "Heat pump", type: "opportunity", stageName: null, partnerId: 1, partnerName: "Ada" },
        { id: 7, name: "Website form", type: "lead", stageName: "New", partnerId: 1, partnerName: "Ada" },
      ],
    });
    await openPopover();
    expect(
      screen.getByRole("button", { name: /website form/i }).textContent
    ).toMatch(/^Lead ·/);
    expect(
      screen.getByRole("button", { name: /heat pump/i }).textContent
    ).toMatch(/^Opportunity ·/);
  });

  it("names the lead as the destination once one is chosen", async () => {
    setup({
      contactId: 1,
      contactName: "Ada Lovelace",
      leadId: 7,
      opportunities: [
        { id: 7, name: "Website form", type: "lead", stageName: null, partnerId: 1, partnerName: "Ada" },
      ],
    });
    await openPopover();
    expect(screen.getByText(/logged on the lead Website form/i)).toBeInTheDocument();
    expect(screen.queryByText(/logged on the opportunity/i)).not.toBeInTheDocument();
  });

  // An unlinked lead has no partner to name, so `partnerName` is null and the
  // row would otherwise be a bare subject line. Its own contact_name is the
  // only thing on screen tying it to the contact that was just selected -
  // which, for a match made on a name rather than on Odoo's own link, is
  // exactly what has to be visible before it is picked.
  it("names an unlinked lead by its own contact details", async () => {
    setup({
      contactId: 1,
      contactName: "Ada Lovelace",
      opportunities: [
        {
          id: 9,
          name: "Partnership with ECS",
          type: "lead",
          stageName: "New",
          partnerId: null,
          partnerName: null,
          contactName: "Ada Lovelace",
          email: "ada@ecs.example",
        },
      ],
    });
    await openPopover();
    const row = screen.getByRole("button", { name: /partnership with ECS/i });
    expect(row.textContent).toContain("Ada Lovelace");
  });

  // The partner is AUTHORITATIVE where it exists - Odoo itself says the record
  // belongs to it - so it wins over the lead's own free text.
  it("prefers the partner over the free text when both are present", async () => {
    setup({
      contactId: 1,
      contactName: "Ada Lovelace",
      opportunities: [
        {
          id: 9,
          name: "Solar",
          type: "opportunity",
          stageName: null,
          partnerId: 9,
          partnerName: "Parent Holdings AS",
          contactName: "Somebody Else",
          email: "else@x.example",
        },
      ],
    });
    await openPopover();
    const row = screen.getByRole("button", { name: /solar/i });
    expect(row.textContent).toContain("Parent Holdings AS");
    expect(row.textContent).not.toContain("Somebody Else");
  });

  // The overlay window is FIXED at 600px tall. Leads made this list longer, and
  // an unbounded list pushes the destination sentence below it off the bottom -
  // the one line that says which record this meeting is about to be written to.
  // The contacts list above already scrolls for the same reason.
  it("scrolls the deals list rather than growing past the window", async () => {
    setup({
      contactId: 1,
      contactName: "Ada Lovelace",
      opportunities: [
        { id: 5, name: "Heat pump", type: "opportunity", stageName: null, partnerId: 1, partnerName: "Ada" },
      ],
    });
    await openPopover();
    const list = screen.getByTestId("opportunity-list");
    expect(list).toHaveClass("overflow-y-auto");
    expect(list.className).toMatch(/max-h-/);
  });

  // Outside the four-way branch, not inside the list: the destination is
  // decided in every one of those states, including before the lookup lands.
  it("names the destination while the lookup is still running", async () => {
    setup({
      contactId: 1,
      contactName: "Ada Lovelace",
      leadId: null,
      opportunities: null,
      isLookingUp: true,
    });
    await openPopover();
    expect(
      screen.getByText(/logged on Ada Lovelace's contact record/i)
    ).toBeInTheDocument();
  });
});

/**
 * The contact list is an offline filter over a synced res.partner cache. An
 * unconverted lead is not in it and never will be - Odoo default for one is
 * free-text contact details and no partner at all - so this live search is the
 * ONLY way such a record is reachable from the overlay.
 */
describe("the lead search", () => {
  const lead = (over: Partial<OdooOpportunity> = {}): OdooOpportunity => ({
    id: 90,
    name: "Partnership with ECS",
    type: "lead",
    stageName: "New",
    partnerId: null,
    partnerName: null,
    contactName: "Christian Carron",
    email: "cc@ecs.example",
    ...over,
  });

  it("lists a result and hands the whole record up when it is picked", async () => {
    const props = setup({ leadResults: [lead()] });
    await openPopover();
    // Task 12: each row also carries an add/remove toggle whose own
    // accessible name ("add Partnership with ECS") contains the lead's name
    // too, so a bare name query now matches two buttons. Scoped to the row
    // and the SELECT button's fixed position (index 0, same convention as
    // rowButton() above) instead.
    const row = screen.getByTestId("lead-search-row");
    await userEvent.click(within(row).getAllByRole("button")[0]);
    // The whole record, not an id: the caller has to persist the NAME beside
    // the id, and take the lead's own partner as the contact when it has one.
    expect(props.onSelectLead).toHaveBeenCalledWith(lead());
  });

  it("names an unlinked result by its own contact details, under its kind", async () => {
    setup({ leadResults: [lead(), lead({ id: 91, name: "Solar tender", type: "opportunity" })] });
    await openPopover();
    const rows = screen.getAllByTestId("lead-search-row");
    const ecsRow = within(rows[0]).getAllByRole("button")[0];
    expect(ecsRow.textContent).toContain("Christian Carron");
    expect(ecsRow.textContent).toMatch(/^Lead ·/);
    // A search hits both kinds, so the results have to tell them apart too.
    expect(within(rows[1]).getAllByRole("button")[0].textContent).toMatch(
      /^Opportunity ·/
    );
  });

  // Three states that must never look alike: nothing typed, a search that
  // failed, and a search that genuinely found nothing. Collapsing the middle
  // one into the last tells the user the record does not exist when the truth
  // is that nobody could ask - and the lead search is the only way that record
  // is reachable at all.
  it("says nothing at all until something has been searched for", async () => {
    setup({ leadResults: null });
    await openPopover();
    expect(screen.queryByText(/no matches/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/search failed/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/leads & opportunities/i)).not.toBeInTheDocument();
  });

  it("shows a failed search as a failure, never as 'none found'", async () => {
    setup({ leadResults: [], leadSearchError: "ODOO_UNREACHABLE" });
    await openPopover();
    expect(screen.getByText(/search failed/i)).toBeInTheDocument();
    expect(screen.getByText(/ODOO_UNREACHABLE/)).toBeInTheDocument();
    expect(screen.queryByText(/no matches/i)).not.toBeInTheDocument();
  });

  it("shows an empty result as an empty result", async () => {
    setup({ leadResults: [], leadSearchError: null });
    await openPopover();
    expect(screen.getByText(/no matches/i)).toBeInTheDocument();
    expect(screen.queryByText(/search failed/i)).not.toBeInTheDocument();
  });

  it("marks the chosen result and leaves the others unmarked", async () => {
    setup({
      leadId: 91,
      leadResults: [lead(), lead({ id: 91, name: "Solar tender" })],
    });
    await openPopover();
    const rows = screen.getAllByTestId("lead-search-row");
    expect(within(rows[1]).getAllByRole("button")[0]).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    expect(within(rows[0]).getAllByRole("button")[0]).toHaveAttribute(
      "aria-pressed",
      "false"
    );
  });

  // Live results arrive later than the offline contact filter, and this list
  // grows inside a window fixed at 600px.
  it("scrolls its own results rather than growing past the window", async () => {
    setup({ leadResults: [lead()] });
    await openPopover();
    const list = screen.getByTestId("lead-search-results");
    expect(list).toHaveClass("overflow-y-auto");
    expect(list.className).toMatch(/max-h-/);
  });

  // One live XML-RPC round trip per keystroke is what the debounce exists to
  // prevent - and the cleanup is what makes it a debounce rather than a delay.
  it("sends ONE search for a burst of typing, not one per keystroke", async () => {
    vi.useFakeTimers();
    try {
      // Rendered already open: userEvent drives its own timers and does not
      // co-operate with vi.useFakeTimers(), and this test is about the timer.
      const props = setup({ open: true });
      const box = screen.getByPlaceholderText(/search contacts/i);
      for (const value of ["c", "ch", "chr", "chri"]) {
        fireEvent.change(box, { target: { value } });
      }
      // Nothing on the wire yet, four keystrokes in.
      expect(props.onSearchLeads).not.toHaveBeenCalled();

      act(() => {
        vi.advanceTimersByTime(LEAD_SEARCH_DEBOUNCE_MS);
      });
      // ONE call, for the last value only. The mount effect's own timer for
      // the empty query is cancelled by the first keystroke, exactly as each
      // keystroke cancels the one before it - which is what makes this a
      // debounce rather than a delay.
      expect(props.onSearchLeads.mock.calls.map((c) => c[0])).toEqual(["chri"]);
    } finally {
      vi.useRealTimers();
    }
  });

  // A lead has no res.partner behind it, so the trigger has no contact name to
  // show. Falling back to "Who are you meeting?" would report NOTHING CHOSEN
  // for a target a meeting is already queued against.
  it("names a lead-only target on the trigger", () => {
    setup({ contactId: null, leadId: 90, leadName: "Partnership with ECS" });
    expect(
      screen.getByRole("button", { name: "Partnership with ECS" })
    ).toBeInTheDocument();
  });

  it("names a lead-only target as the destination", async () => {
    setup({
      contactId: null,
      leadId: 90,
      leadName: "Partnership with ECS",
      leadResults: [lead()],
    });
    await userEvent.click(screen.getByRole("button", { name: "Partnership with ECS" }));
    expect(
      screen.getByText(/logged on the lead or opportunity Partnership with ECS/i)
    ).toBeInTheDocument();
  });
});

describe("refresh", () => {
  it("asks its owner to sync", async () => {
    const props = setup();
    await openPopover();
    await userEvent.click(screen.getByRole("button", { name: /refresh/i }));
    expect(props.onRefresh).toHaveBeenCalled();
  });
});

// Finding 1: the overlay window is 600x54 and non-resizable, and grows ONLY
// through useCompletion's resize effect - the sole caller of
// resizeWindow(true) - driven by a fixed flag list ContactPicker must
// participate in, exactly as Files.tsx's isFilesPopoverOpen already does.
// A popover that owns its own `open` state (the ORIGINAL implementation
// here) is invisible to that effect: Radix would portal several hundred
// pixels of popover content into a 54px-tall webview with nothing having
// ever asked the window to grow first.
//
// jsdom has no window bounds and cannot prove the popover is actually
// visible on screen - it can only prove ContactPicker no longer owns `open`
// itself and instead reports every change to its caller. The other half of
// the fix - that the caller's resize effect actually reacts to that report -
// is pinned in useCompletion.meeting-assist.test.tsx ("grows the window when
// the Odoo contact picker opens"), since ContactPicker and useCompletion are
// separate hooks with no shared test surface.
describe("the popover open state", () => {
  it("is CONTROLLED: opening reports through onOpenChange rather than owning its own state", async () => {
    const props = setup();
    await openPopover();
    expect(props.onOpenChange).toHaveBeenCalledWith(true);
  });

  it("renders nothing open when the caller holds `open` at false, even after a click", async () => {
    // No Harness here: this asserts what a caller that ignores onOpenChange
    // (a bug) would see, which is the actual guarantee "controlled" makes -
    // an UNcontrolled popover would open regardless of what `open` says.
    const onOpenChange = vi.fn();
    render(
      <ContactPicker
        {...defaultProps()}
        open={false}
        onOpenChange={onOpenChange}
      />
    );
    await openPopover();
    expect(onOpenChange).toHaveBeenCalledWith(true);
    expect(screen.queryByPlaceholderText(/search/i)).not.toBeInTheDocument();
  });
});

/**
 * Task 12: the flat multi-target list. `contactId`/`leadId`/`opportunities`
 * above are the single-select flow's own primitives, untouched by anything
 * below - this describe block drives exclusively off `targets`, mirroring
 * `useOdooTarget.ts`'s own separation between `target` and `targets`.
 */
describe("logging to several records", () => {
  // Named to match the fixtures useOdooTarget.test.tsx's own "Task 11: the
  // multi-target list" block already uses (christian id 1, bentley id 2), so
  // a reader who has seen one recognises the other.
  const christian = contact({ id: 1, name: "Christian Carron" });
  const bentleyAS = contact({ id: 2, name: "Bentley AS" });
  const colleague = contact({ id: 3, name: "Colleague Cole", isColleague: true });

  let nextTargetId = 1000;
  function t(name: string, model: SelectedTarget["model"] = "res.partner"): SelectedTarget {
    nextTargetId += 1;
    return { model, resId: nextTargetId, name };
  }

  // Five ALREADY-selected targets, deliberately not overlapping bentleyAS.id
  // (2) or christian.id (1) - the cap tests need "Bentley AS" to still be
  // addable-but-blocked, not already-added.
  const fiveTargets: SelectedTarget[] = [1, 2, 3, 4, 5].map((n) => ({
    model: "res.partner",
    resId: 100 + n,
    name: `Existing ${n}`,
  }));

  // Reactive on top of the plain open-state Harness above: `onExpandContact`
  // is a spy in defaultProps() (it does no actual lookup), so this is the
  // thing that makes `opportunitiesFor` actually start returning data after
  // an expand click resolves - mirroring what useOdooTarget.ts's own
  // rowCache/setRowCache does for real, just held in local component state
  // instead of the hook.
  function ExpandHarness({
    lookups,
    ...props
  }: ContactPickerProps & { lookups: Record<number, OdooOpportunity[]> }) {
    const [open, setOpen] = useState(props.open);
    const [resolved, setResolved] = useState<Record<number, OdooOpportunity[]>>({});
    return (
      <ContactPicker
        {...props}
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          props.onOpenChange(next);
        }}
        onExpandContact={async (contactId) => {
          await props.onExpandContact(contactId);
          if (contactId in lookups) {
            setResolved((prev) => ({ ...prev, [contactId]: lookups[contactId] }));
          }
        }}
        opportunitiesFor={(contactId) => resolved[contactId] ?? props.opportunitiesFor(contactId)}
      />
    );
  }

  it("shows the count in the trigger line", () => {
    const props = defaultProps({ targets: [t("Christian Carron"), t("B"), t("C")] });
    render(<ContactPicker {...props} />);
    expect(
      screen.getByRole("button", { name: /Christian Carron \+ 2 more/ })
    ).toBeVisible();
  });

  it("adds a deal as its own line, not attached to the contact", async () => {
    const deal: OdooOpportunity = {
      id: 90,
      name: "Partnership with ECS",
      type: "lead",
      stageName: "New",
      partnerId: null,
      partnerName: null,
      contactName: "Christian Carron",
      email: "cc@ecs.example",
    };
    const props = defaultProps({
      cache: { kind: "ready", contacts: [christian], lastError: null },
    });
    render(<ExpandHarness {...props} lookups={{ [christian.id]: [deal] }} />);
    await openPopover();
    await userEvent.click(screen.getByRole("button", { name: /expand Christian Carron/i }));
    await userEvent.click(
      await screen.findByRole("button", { name: /add Partnership with ECS/i })
    );
    expect(props.onAddTarget).toHaveBeenCalledWith({
      model: "crm.lead",
      resId: 90,
      name: "Partnership with ECS",
    });
  });

  it("uses aria-disabled at the cap, keeping the control focusable", async () => {
    setup({
      cache: { kind: "ready", contacts: [bentleyAS], lastError: null },
      targets: fiveTargets,
    });
    await openPopover();
    // Step 3's exact header copy, pinned - otherwise it has no coverage.
    expect(
      screen.getByText(/Logging to \(5\) · limit reached/)
    ).toBeVisible();
    const add = screen.getByRole("button", { name: /add Bentley AS/i });
    expect(add).toHaveAttribute("aria-disabled", "true");
    expect(add).not.toHaveAttribute("disabled");
    add.focus();
    expect(add).toHaveFocus();
  });

  it("removes a target when its added row is clicked again", async () => {
    const props = setup({
      cache: { kind: "ready", contacts: [bentleyAS], lastError: null },
      targets: [{ model: "res.partner", resId: bentleyAS.id, name: "Bentley AS" }],
    });
    await openPopover();
    // Proves the toggle actually flips both ways and that onRemoveTarget is
    // called with the hook's real two-positional-argument shape
    // (removeTarget(model, resId), confirmed against useOdooTarget.ts) rather
    // than the single-object shape onAddTarget takes.
    await userEvent.click(screen.getByRole("button", { name: /added Bentley AS/i }));
    expect(props.onRemoveTarget).toHaveBeenCalledWith("res.partner", bentleyAS.id);
  });

  it("keeps native disabled on an archived contact", async () => {
    const archived = contact({ id: 5, name: "Archived Person", active: false });
    setup({ cache: { kind: "ready", contacts: [archived], lastError: null } });
    await openPopover();
    expect(rowButton()).toBeDisabled();
    // The add-toggle is a NEW control on the same row and must be statically
    // disabled the same way, for the same reason (Step 4): an archived
    // contact cannot become a target either.
    expect(screen.getByRole("button", { name: /add Archived Person/i })).toBeDisabled();
  });

  // Final review, Important 5: `SelectedTarget` carries `model`, not `type`
  // ("lead" vs "opportunity") - a crm.lead target loses that distinction the
  // moment it is flattened into `targets`, so naming one over the other here
  // would be a guess about the record this meeting is about to be written to.
  // Neutral wording, matching `targetRecord`'s own single-select sentence
  // (this file's "still names the lead when the list cannot identify it").
  it("pluralises the destination sentence without guessing a crm.lead's kind", async () => {
    setup({
      targets: [
        t("Christian Carron", "res.partner"),
        t("Partnership with ECS", "crm.lead"),
        t("Bentley AS"),
      ],
    });
    await openPopover();
    expect(
      screen.getByText(
        /logged on 3 records: Christian Carron, the lead or opportunity Partnership with ECS, and Bentley AS\./
      )
    ).toBeVisible();
  });

  // Final review, Important 5, the broken string it hid: `nameForTarget`'s
  // own crm.lead fallback ("Lead or opportunity #123") used to be prefixed
  // with "the lead ", producing "the lead Lead or opportunity #123" for an
  // unnamed target. Not reachable through this component's own UI (every
  // `+ add` click supplies a real name), so built directly the way a
  // rehydrated target with no name would arrive.
  it("does not double-name an unnamed crm.lead target in the destination sentence", async () => {
    setup({ targets: [{ model: "crm.lead", resId: 123, name: null }] });
    await openPopover();
    expect(
      screen.getByText(
        "This meeting will be logged on 1 record: the lead or opportunity you picked earlier (#123)."
      )
    ).toBeVisible();
    // The specific broken string this finding names, gone: `nameForTarget`'s
    // own placeholder ("Lead or opportunity #123") still names the TRIGGER
    // button for a single unnamed target - only the doubled "the lead
    // Lead or opportunity #123" inside the sentence is the defect.
    expect(screen.queryByText(/the lead Lead or opportunity #123/)).not.toBeInTheDocument();
  });

  // Final review, Important 4: `commit` mirrors every single-select into
  // `targets`, and `addTarget` never clears the single-select state - so both
  // this legacy block's own gate (contactId/leadId set) and the flat list's
  // gate (targets.length > 0) are true at once after a single-select, and the
  // two sentences can contradict each other (one contact vs a record count,
  // "the lead X" vs "the opportunity X"). Reproduced directly with both sets
  // of props supplied together, rather than by driving the picker through the
  // click sequence useOdooTarget owns - this component alone must not render
  // two contradicting sentences no matter how the props got that way.
  it("renders only one destination sentence once the flat list holds anything", async () => {
    setup({
      contactId: 1,
      contactName: "Christian Carron",
      leadId: null,
      targets: [t("Christian Carron", "res.partner")],
    });
    await openPopover();

    expect(screen.getAllByText(/This meeting will be logged on/)).toHaveLength(1);
    expect(screen.queryByText(/'s contact record\./)).not.toBeInTheDocument();
  });

  it("renders static text for a colleague's expanded row, with no dead control", async () => {
    setup({ cache: { kind: "ready", contacts: [colleague], lastError: null } });
    await openPopover();
    await userEvent.click(screen.getByRole("button", { name: /expand/i }));
    expect(screen.queryByRole("button", { name: /look up/i })).toBeNull();
    // The row is still a valid target (only the crm.lead LOOKUP is skipped
    // for a colleague, not the contact itself - onSelect commits a colleague
    // exactly like anyone else), so its own add-toggle must survive.
    expect(
      screen.getByRole("button", { name: /add Colleague Cole/i })
    ).toBeInTheDocument();
  });

  // Fix round 1, Important: AddToggle used to discard onAdd's result
  // entirely. `atCap` is computed once per render from `targets.length`, so
  // two `+ add` clicks fired before either resolves both read
  // `blocked === false` and both call onAdd - the loser legitimately loses
  // the race against addSelectedTarget's own database-side count check, and
  // used to leave the user with no add and no explanation. Reproduced here
  // WITHOUT the client-side cap (4 targets, `atCap` false) so the click goes
  // through un-blocked and the rejection can only be caught by awaiting
  // onAddTarget's own return value.
  it("tells the user when an add is rejected at the cap, not just silently doing nothing", async () => {
    vi.mocked(toast.error).mockClear();
    const props = setup({
      cache: { kind: "ready", contacts: [bentleyAS], lastError: null },
      targets: fiveTargets.slice(0, 4),
      onAddTarget: vi.fn(async () => ({ ok: false, reason: "cap" as const })),
    });
    await openPopover();
    const add = screen.getByRole("button", { name: /add Bentley AS/i });
    // Not blocked client-side - `atCap` reads false with only 4 targets.
    expect(add).not.toHaveAttribute("aria-disabled");
    await userEvent.click(add);
    expect(props.onAddTarget).toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalled();
  });

  // Fix round 1, Minor: the lead-search row's own AddToggle had no test at
  // all - added on Step 4's prose alone. model is "crm.lead" regardless of
  // whether the result is a "lead" or an "opportunity" (both live in the
  // same crm.lead table; SelectedTarget carries no `type`).
  it("adds a lead-search result as its own target", async () => {
    const searchLead: OdooOpportunity = {
      id: 90,
      name: "Partnership with ECS",
      type: "lead",
      stageName: "New",
      partnerId: null,
      partnerName: null,
      contactName: "Christian Carron",
      email: "cc@ecs.example",
    };
    const props = setup({ leadResults: [searchLead] });
    await openPopover();
    const row = screen.getByTestId("lead-search-row");
    await userEvent.click(
      within(row).getByRole("button", { name: /add Partnership with ECS/i })
    );
    expect(props.onAddTarget).toHaveBeenCalledWith({
      model: "crm.lead",
      resId: 90,
      name: "Partnership with ECS",
    });
  });
});


describe("clearing every destination", () => {
  const three: SelectedTarget[] = [
    { model: "res.partner", resId: 201, name: "Christian Carron" },
    { model: "res.partner", resId: 202, name: "Bentley AS" },
    { model: "crm.lead", resId: 203, name: "Partnership with ECS" },
  ];

  it("offers no clear control when nothing is selected", async () => {
    setup({ targets: [] });
    await openPopover();
    expect(screen.queryByTestId("logging-to-section")).not.toBeInTheDocument();
    expect(screen.queryByTestId("clear-targets")).not.toBeInTheDocument();
  });

  // The whole point of the feature: one click must NOT be enough. This is the
  // assertion that would fail if the confirmation were ever refactored away.
  it("does not clear on the first click - it arms a warning", async () => {
    const props = setup({ targets: three });
    await openPopover();
    await userEvent.click(screen.getByTestId("clear-targets"));
    expect(props.onClearTargets).not.toHaveBeenCalled();
    expect(screen.getByText(/Clear all destinations\?/i)).toBeVisible();
  });

  it("names the count and disclaims already-queued meetings", async () => {
    setup({ targets: three });
    await openPopover();
    await userEvent.click(screen.getByTestId("clear-targets"));
    const warning = screen.getByTestId("logging-to-section");
    expect(warning).toHaveTextContent("Removes all 3 destinations.");
    expect(warning).toHaveTextContent(/Meetings already queued are unaffected/i);
  });

  it("swaps the destination list out rather than pushing it down", async () => {
    setup({ targets: three });
    await openPopover();
    expect(screen.getByTestId("logging-to-section")).toHaveTextContent(/Logging to \(3\)/);
    await userEvent.click(screen.getByTestId("clear-targets"));
    // The popover lives in a 600x54 window grown only by a flag-driven resize
    // effect, so the warning REPLACES the summary; both on screen at once
    // would push content past the bottom edge.
    expect(screen.getByTestId("logging-to-section")).not.toHaveTextContent(/Logging to \(3\)/);
  });

  it("clears once the warning is confirmed", async () => {
    const props = setup({ targets: three });
    await openPopover();
    await userEvent.click(screen.getByTestId("clear-targets"));
    await userEvent.click(screen.getByTestId("confirm-clear-targets"));
    expect(props.onClearTargets).toHaveBeenCalledTimes(1);
  });

  it("cancelling leaves both the targets and the handler alone", async () => {
    const props = setup({ targets: three });
    await openPopover();
    await userEvent.click(screen.getByTestId("clear-targets"));
    await userEvent.click(screen.getByRole("button", { name: /^cancel$/i }));
    expect(props.onClearTargets).not.toHaveBeenCalled();
    expect(screen.getByTestId("logging-to-section")).toHaveTextContent(/Logging to \(3\)/);
  });

  // ContactPicker stays MOUNTED when the popover closes, so an armed warning
  // would otherwise be the first thing on screen the next time it opens -
  // with no memory of having asked for it.
  it("disarms when the popover is closed and reopened", async () => {
    setup({ targets: three });
    await openPopover();
    await userEvent.click(screen.getByTestId("clear-targets"));
    expect(screen.getByText(/Clear all destinations\?/i)).toBeVisible();

    await userEvent.keyboard("{Escape}");
    await openPopover();
    expect(screen.queryByText(/Clear all destinations\?/i)).not.toBeInTheDocument();
    expect(screen.getByTestId("logging-to-section")).toHaveTextContent(/Logging to \(3\)/);
  });
});

describe("calendar proposal slot", () => {
  // Statically absent must cost NOTHING: the default v1 user ships no client
  // ID, and reserving blank space in a 54px window for them is the exact
  // regression the static/dynamic split exists to prevent.
  it("renders no region at all when no calendar prop is passed", async () => {
    setup(); // the file's existing helper, which passes no `calendar`
    await openPopover();
    expect(screen.queryByTestId("calendar-proposal-region")).toBeNull();
  });

  it("renders the region above the search box when a proposal is present", async () => {
    setup({
      calendar: {
        state: { kind: "no-meeting" as const },
        onPickCandidate: vi.fn(),
        onRetry: vi.fn(),
      },
    });
    await openPopover();
    const region = screen.getByTestId("calendar-proposal-region");
    const search = screen.getByPlaceholderText("Search contacts");
    // Node.DOCUMENT_POSITION_FOLLOWING: the search box comes after the region.
    expect(region.compareDocumentPosition(search) & 4).toBeTruthy();
  });
});
