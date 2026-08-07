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
        { id: 5, name: "Heat pump", stageName: "Proposition", partnerId: 1, partnerName: "Ada" },
        { id: 6, name: "Solar", stageName: "Qualified", partnerId: 9, partnerName: "Analytical Ltd" },
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
        { id: 5, name: "Heat pump", stageName: null, partnerId: 1, partnerName: "Ada" },
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
    expect(screen.getByText(/opportunities unavailable/i)).toBeInTheDocument();
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
