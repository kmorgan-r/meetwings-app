import { useState } from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  ContactPicker,
  MAX_RENDERED_ROWS,
  type ContactPickerProps,
} from "@/pages/app/components/completion/ContactPicker";
import type { OdooContact } from "@/types";

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

function setup(over: Partial<ContactPickerProps> = {}) {
  const props: ContactPickerProps = {
    contactId: null,
    leadId: null,
    contactName: null,
    cache: { kind: "ready", contacts: [contact()], lastError: null },
    opportunities: null,
    opportunityError: null,
    isLookingUp: false,
    // All async handlers resolve, matching the Promise<void> contract.
    onSelect: vi.fn(async () => {}),
    onSelectOpportunity: vi.fn(async () => {}),
    onToggleColleague: vi.fn(async () => {}),
    onRetryOpportunities: vi.fn(async () => {}),
    onRefresh: vi.fn(async () => {}),
    onOpenSettings: vi.fn(),
    open: false,
    onOpenChange: vi.fn(),
    ...over,
  };
  render(<Harness {...props} />);
  return props;
}

// The chip is the popover TRIGGER and lives outside the popover content, so a
// name query is safe here - the rows do not exist until it is clicked. Inside
// the popover, always query rows by testid; see the note in Step 3.
async function openPopover() {
  await userEvent.click(screen.getByRole("button", { name: /who are you meeting|ada/i }));
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
  // they are not the same thing to say out loud. The marker is a PREFIX and
  // only leads carry it - an unmarked row is a deal, which is what every row
  // in this list used to be.
  it("marks lead rows and leaves opportunities unmarked", async () => {
    setup({
      contactId: 1,
      contactName: "Ada Lovelace",
      opportunities: [
        { id: 5, name: "Heat pump", type: "opportunity", stageName: null, partnerId: 1, partnerName: "Ada" },
        { id: 7, name: "Website form", type: "lead", stageName: "New", partnerId: 1, partnerName: "Ada" },
      ],
    });
    await openPopover();
    expect(screen.getByRole("button", { name: /lead . website form/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /heat pump/i }).textContent).not.toMatch(/lead/i);
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
        {...{
          contactId: null,
          leadId: null,
          contactName: null,
          cache: { kind: "ready", contacts: [contact()], lastError: null },
          opportunities: null,
          opportunityError: null,
          isLookingUp: false,
          onSelect: vi.fn(async () => {}),
          onSelectOpportunity: vi.fn(async () => {}),
          onToggleColleague: vi.fn(async () => {}),
          onRetryOpportunities: vi.fn(async () => {}),
          onRefresh: vi.fn(async () => {}),
          onOpenSettings: vi.fn(),
        }}
        open={false}
        onOpenChange={onOpenChange}
      />
    );
    await openPopover();
    expect(onOpenChange).toHaveBeenCalledWith(true);
    expect(screen.queryByPlaceholderText(/search/i)).not.toBeInTheDocument();
  });
});
