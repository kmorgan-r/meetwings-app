import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => {}) }));

import {
  CalendarProposal,
  type CalendarProposalProps,
} from "@/pages/app/components/completion/CalendarProposal";
import type {
  CalendarProposalState,
  CalendarParticipant,
  CreateContactResult,
  OdooContact,
  SelectedTargets,
} from "@/types";

function participant(address: string, name: string | null = null): CalendarParticipant {
  return { address, name, type: "required", isOrganizer: false };
}

function proposal(
  unmatched: { participant: CalendarParticipant; reason: "no-contact" | "archived" }[]
): CalendarProposalState {
  return { kind: "proposal", eventId: "e1", subject: "Client sync", matched: [], unmatched };
}

/**
 * `data` and `handlers` are destructured SEPARATELY on purpose. Folding
 * `contacts`/`targets` into the handler object and spreading it last would let
 * them override the explicit props below - a helper that silently ignores half
 * its own arguments.
 */
function setup(
  state: CalendarProposalState,
  // NOT `unknown` for the handlers. TypeScript unions a spread's left-hand
  // property with an optional right-hand one, so `{ onAddTarget: vi.fn(...),
  // ...handlerOverrides }` gives both keys `Mock | unknown` = `unknown`, and
  // every call site loses the prop's real shape.
  //
  // This is NOT caught by a gate: tsconfig.json excludes src/tests/**/*, so
  // `npm run type-check` never sees this file. That is exactly why it is worth
  // getting right by hand - the editor is the only thing that will tell you.
  over: {
    contacts?: OdooContact[];
    targets?: SelectedTargets;
  } & Partial<Pick<CalendarProposalProps, "onAddTarget" | "onCreateContact">> = {}
) {
  const { contacts = [], targets = [], ...handlerOverrides } = over;
  const handlers = {
    onPickCandidate: vi.fn(),
    onRetry: vi.fn(),
    onAddTarget: vi.fn(async () => ({ ok: true })),
    onCreateContact: vi.fn(async () => ({ kind: "abandoned" }) as const),
    ...handlerOverrides,
  };
  const view = render(
    <CalendarProposal state={state} targets={targets} contacts={contacts} {...handlers} />
  );
  /** Re-render with the same handlers and new data - every lifecycle test needs
   * this, and hand-rolling the full prop list at each call site is how one of
   * them ends up quietly passing a different handler. */
  const rerender = (next: { state?: CalendarProposalState; targets?: SelectedTargets; contacts?: OdooContact[] }) =>
    view.rerender(
      <CalendarProposal
        state={next.state ?? state}
        targets={next.targets ?? targets}
        contacts={next.contacts ?? contacts}
        {...handlers}
      />
    );
  return { ...handlers, view, rerender };
}

beforeEach(() => vi.clearAllMocks());

describe("the create affordance", () => {
  it("is offered on a no-contact row and not on an archived one", () => {
    setup(
      proposal([
        { participant: participant("new@acme.example", "New Person"), reason: "no-contact" },
        { participant: participant("old@acme.example", "Old Person"), reason: "archived" },
      ])
    );
    expect(screen.getByTestId("calendar-create-new@acme.example")).toBeInTheDocument();
    expect(screen.queryByTestId("calendar-create-old@acme.example")).toBeNull();
  });

  // The fixed footprint is a Global Constraint: the main window is 600x54 and
  // non-resizable, and resizeWindow(true) reads a flag list at popover-open.
  it("keeps the region's fixed height with the form open", async () => {
    setup(proposal([{ participant: participant("new@acme.example"), reason: "no-contact" }]));
    await userEvent.click(screen.getByTestId("calendar-create-new@acme.example"));
    const region = screen.getByTestId("calendar-proposal-region");
    expect(region).toHaveClass("h-28");
    // The form renders INSIDE the scroll region, not in a portal.
    expect(region).toContainElement(screen.getByTestId("calendar-create-form"));
  });
});

describe("the create form", () => {
  const one = proposal([
    { participant: participant("new@acme.example", "New Person"), reason: "no-contact" },
  ]);

  it("writes nothing when it opens, and nothing when it is cancelled", async () => {
    const { onCreateContact, onAddTarget } = setup(one);
    await userEvent.click(screen.getByTestId("calendar-create-new@acme.example"));
    expect(screen.getByTestId("calendar-create-form")).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("calendar-create-cancel"));
    expect(screen.queryByTestId("calendar-create-form")).toBeNull();
    expect(onCreateContact).not.toHaveBeenCalled();
    expect(onAddTarget).not.toHaveBeenCalled();
  });

  it("shows the email read-only", async () => {
    setup(one);
    await userEvent.click(screen.getByTestId("calendar-create-new@acme.example"));
    const email = screen.getByTestId("calendar-create-email");
    expect(email).toHaveTextContent("new@acme.example");
    // Not an input at all: an editable email lets the user create a partner
    // that still does not match the attendee.
    expect(email.tagName).not.toBe("INPUT");
  });

  it("opening a second row's form closes the first and discards its draft", async () => {
    setup(
      proposal([
        { participant: participant("a@acme.example", "A Person"), reason: "no-contact" },
        { participant: participant("b@acme.example", "B Person"), reason: "no-contact" },
      ])
    );
    await userEvent.click(screen.getByTestId("calendar-create-a@acme.example"));
    const name = screen.getByTestId("calendar-create-name");
    await userEvent.clear(name);
    await userEvent.type(name, "Edited Draft");

    await userEvent.click(screen.getByTestId("calendar-create-b@acme.example"));
    expect(screen.getAllByTestId("calendar-create-form")).toHaveLength(1);
    expect(screen.getByTestId("calendar-create-email")).toHaveTextContent("b@acme.example");

    await userEvent.click(screen.getByTestId("calendar-create-a@acme.example"));
    expect(screen.getByTestId("calendar-create-name")).toHaveValue("A Person");
  });

  // A reprojection (useCalendarProposal re-running matchAttendees against the
  // same meeting when the contact cache changes underneath it - a colleague
  // toggle, an archive picked up by Refresh) can reclassify the SAME address
  // from no-contact to archived while its form sits open. Archived rows get
  // nothing - Global Constraint - and that must hold for an ALREADY-OPEN form,
  // not just for the button that offers to open one.
  it("closes the form if a reprojection reclassifies the open row as archived", async () => {
    const p = participant("new@acme.example", "New Person");
    const { rerender } = setup(proposal([{ participant: p, reason: "no-contact" }]));
    await userEvent.click(screen.getByTestId("calendar-create-new@acme.example"));
    expect(screen.getByTestId("calendar-create-form")).toBeInTheDocument();

    rerender({ state: proposal([{ participant: p, reason: "archived" }]) });

    expect(screen.queryByTestId("calendar-create-new@acme.example")).toBeNull();
    expect(screen.queryByTestId("calendar-create-form")).toBeNull();
  });
});

describe("the name prefill", () => {
  it.each([
    ["a plain name", participant("x@acme.example", "Jane Doe"), "Jane Doe"],
    ["a Last, First name", participant("x@acme.example", "Doe, Jane"), "Jane Doe"],
    ["collapsed whitespace", participant("x@acme.example", "  Jane   Doe  "), "Jane Doe"],
    ["a null name", participant("jane.doe@acme.example", null), "jane doe"],
    ["a blank name", participant("jane_doe-smith@acme.example", "   "), "jane doe smith"],
  ])("prefills %s", async (_label, p, expected) => {
    setup(proposal([{ participant: p, reason: "no-contact" }]));
    await userEvent.click(screen.getByTestId(`calendar-create-${p.address}`));
    expect(screen.getByTestId("calendar-create-name")).toHaveValue(expected);
  });

  // Only a SINGLE leading comma flips. "Doe, Jane, Jr" is not a Last, First
  // name and guessing at it would mangle a name the user then has to unmangle.
  it("does not flip a name with two commas", async () => {
    const p = participant("x@acme.example", "Doe, Jane, Jr");
    setup(proposal([{ participant: p, reason: "no-contact" }]));
    await userEvent.click(screen.getByTestId(`calendar-create-${p.address}`));
    expect(screen.getByTestId("calendar-create-name")).toHaveValue("Doe, Jane, Jr");
  });

  it("disables Create contact when the name trims to empty", async () => {
    setup(proposal([{ participant: participant("x@acme.example", "Jane"), reason: "no-contact" }]));
    await userEvent.click(screen.getByTestId("calendar-create-x@acme.example"));
    await userEvent.clear(screen.getByTestId("calendar-create-name"));
    await userEvent.type(screen.getByTestId("calendar-create-name"), "   ");
    expect(screen.getByTestId("calendar-create-submit")).toBeDisabled();
  });
});
