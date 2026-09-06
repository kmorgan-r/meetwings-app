import { act, fireEvent, render, screen } from "@testing-library/react";
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

function contact(id: number, name: string, over: Partial<OdooContact> = {}): OdooContact {
  return {
    id, name, email: null, phone: null, companyName: null, parentId: null,
    isCompany: false, active: true, writeDate: "2026-09-05 10:00:00",
    isColleague: false, lastMeetingAt: null, ...over,
  };
}

describe("the company field", () => {
  const acme = contact(90, "Acme Ltd", { isCompany: true });
  const onDomain = [
    contact(1, "A", { email: "a@acme.example", parentId: 90 }),
    contact(2, "B", { email: "b@acme.example", parentId: 90 }),
  ];
  const row = { participant: participant("new@acme.example", "New Person"), reason: "no-contact" as const };

  it("prefills the inferred company", async () => {
    setup(proposal([row]), { contacts: [acme, ...onDomain] });
    await userEvent.click(screen.getByTestId("calendar-create-new@acme.example"));
    expect(screen.getByTestId("calendar-create-company")).toHaveValue("Acme Ltd");
  });

  it("leaves the field blank when nothing is inferred", async () => {
    setup(proposal([row]), { contacts: [acme] });
    await userEvent.click(screen.getByTestId("calendar-create-new@acme.example"));
    expect(screen.getByTestId("calendar-create-company")).toHaveValue("");
  });

  it("lists only companies, filtered by the typed query and capped at five", async () => {
    const many = Array.from({ length: 8 }, (_, i) =>
      contact(100 + i, `Acme Division ${i}`, { isCompany: true })
    );
    setup(proposal([row]), {
      contacts: [
        contact(5, "Acme Person"),
        contact(108, "Zeta Corp", { isCompany: true }),
        ...many,
      ],
    });
    await userEvent.click(screen.getByTestId("calendar-create-new@acme.example"));
    await userEvent.type(screen.getByTestId("calendar-create-company"), "Acme");
    const options = screen.getAllByTestId(/^calendar-create-company-option-/);
    expect(options).toHaveLength(5);
    // A person matching the query is not a company and must not be offered.
    expect(screen.queryByText("Acme Person")).toBeNull();
    // A company that does not match the query must not be offered either.
    expect(screen.queryByText("Zeta Corp")).toBeNull();
  });

  it("selecting a row collapses the list back to the chosen name", async () => {
    setup(proposal([row]), { contacts: [acme, contact(91, "Beta Ltd", { isCompany: true })] });
    await userEvent.click(screen.getByTestId("calendar-create-new@acme.example"));
    await userEvent.clear(screen.getByTestId("calendar-create-company"));
    await userEvent.type(screen.getByTestId("calendar-create-company"), "Beta");
    await userEvent.click(screen.getByTestId("calendar-create-company-option-91"));
    expect(screen.getByTestId("calendar-create-company")).toHaveValue("Beta Ltd");
    expect(screen.queryAllByTestId(/^calendar-create-company-option-/)).toHaveLength(0);
  });

  it("clearing the field clears the selection", async () => {
    setup(proposal([row]), { contacts: [acme, ...onDomain] });
    await userEvent.click(screen.getByTestId("calendar-create-new@acme.example"));
    await userEvent.clear(screen.getByTestId("calendar-create-company"));
    expect(screen.getByTestId("calendar-create-company")).toHaveValue("");
    expect(screen.getByTestId("calendar-create-company-none")).toBeInTheDocument();
  });
});

describe("Layer 2 - the similarity warning", () => {
  const jane = contact(7, "Jane Doe", { email: "jane@acme.example" });
  const row = { participant: participant("j.doe@acme.example", "Jane Doe"), reason: "no-contact" as const };

  it("offers a Use button for a similar cached contact", async () => {
    setup(proposal([row]), { contacts: [jane] });
    await userEvent.click(screen.getByTestId("calendar-create-j.doe@acme.example"));
    expect(screen.getByTestId("calendar-create-use-7")).toHaveTextContent("Jane Doe");
  });

  it("offers nothing when no cached contact is similar", async () => {
    setup(proposal([row]), { contacts: [contact(8, "Bob Stone", { email: "bob@acme.example" })] });
    await userEvent.click(screen.getByTestId("calendar-create-j.doe@acme.example"));
    expect(screen.queryAllByTestId(/^calendar-create-use-/)).toHaveLength(0);
  });

  it("leaves Create contact enabled below the warning", async () => {
    setup(proposal([row]), { contacts: [jane] });
    await userEvent.click(screen.getByTestId("calendar-create-j.doe@acme.example"));
    // Two people genuinely do share a name; a hard block would make that
    // unresolvable from this UI.
    expect(screen.getByTestId("calendar-create-submit")).toBeEnabled();
  });

  it("adds that contact as a target, creates nothing, and resolves the row", async () => {
    const { onAddTarget, onCreateContact, rerender } = setup(proposal([row]), { contacts: [jane] });
    await userEvent.click(screen.getByTestId("calendar-create-j.doe@acme.example"));
    await userEvent.click(screen.getByTestId("calendar-create-use-7"));

    expect(onAddTarget).toHaveBeenCalledWith({ model: "res.partner", resId: 7, name: "Jane Doe" });
    expect(onCreateContact).not.toHaveBeenCalled();
    expect(screen.queryByTestId("calendar-create-form")).toBeNull();

    // The row must stop inviting a create: matchAttendees keys on email and
    // never reads targets, so it still says no-contact.
    rerender({ targets: [{ model: "res.partner", resId: 7, name: "Jane Doe" }] });
    expect(screen.queryByTestId("calendar-create-j.doe@acme.example")).toBeNull();
    expect(screen.getByTestId("calendar-unmatched-j.doe@acme.example")).toHaveTextContent(
      /added Jane Doe/i
    );
  });

  it("reports a cap rejection and leaves the row unresolved", async () => {
    const onAddTarget = vi.fn(async () => ({ ok: false, reason: "cap" as const }));
    setup(proposal([row]), { contacts: [jane], onAddTarget });
    await userEvent.click(screen.getByTestId("calendar-create-j.doe@acme.example"));
    await userEvent.click(screen.getByTestId("calendar-create-use-7"));

    expect(screen.getByTestId("calendar-create-result")).toHaveTextContent(/full/i);
    // Nothing was added, so nothing is resolved and create stays on offer.
    expect(screen.getByTestId("calendar-create-j.doe@acme.example")).toBeInTheDocument();
  });

  it("restores the row when the target is removed again", async () => {
    const { rerender } = setup(proposal([row]), { contacts: [jane] });
    await userEvent.click(screen.getByTestId("calendar-create-j.doe@acme.example"));
    await userEvent.click(screen.getByTestId("calendar-create-use-7"));

    rerender({ targets: [{ model: "res.partner", resId: 7, name: "Jane Doe" }] });
    expect(screen.queryByTestId("calendar-create-j.doe@acme.example")).toBeNull();

    // Removed from the "Logging to" list. The latch must not outlive the fact.
    rerender({ targets: [] });
    expect(screen.getByTestId("calendar-create-j.doe@acme.example")).toBeInTheDocument();
  });

  // The spec requires the search to run on the SEEDED name (prefillName,
  // including the local-part fallback), not participant.name raw - an attendee
  // with no display name is the population most likely to need Layer 2. An
  // implementation passing `entry.participant.name ?? ""` passes every other
  // test in this block and fails only this one.
  it("matches on the local-part fallback when the attendee has no display name", async () => {
    setup(proposal([{ participant: participant("jane.doe@corp.example", null), reason: "no-contact" }]), {
      contacts: [contact(7, "Jane Doe", { email: "jd@acme.example" })],
    });
    await userEvent.click(screen.getByTestId("calendar-create-jane.doe@corp.example"));
    expect(screen.getByTestId("calendar-create-use-7")).toBeInTheDocument();
  });

  // Computed ONCE at open. A useMemo keyed on draftName would flicker the list
  // under a user typing in a 112px scroll region, and would pass every other
  // test here.
  it("does not recompute the candidate list as the name is edited", async () => {
    setup(proposal([row]), { contacts: [jane] });
    await userEvent.click(screen.getByTestId("calendar-create-j.doe@acme.example"));
    expect(screen.getByTestId("calendar-create-use-7")).toBeInTheDocument();

    await userEvent.clear(screen.getByTestId("calendar-create-name"));
    await userEvent.type(screen.getByTestId("calendar-create-name"), "Zzz Qqq");
    expect(screen.getByTestId("calendar-create-use-7")).toBeInTheDocument();
  });

  // addSelectedTarget is a non-atomic check-then-act (CalendarProposal.tsx:436-438).
  // Two Use buttons clicked before the first resolves would both read the same
  // pre-write count and both pass the cap check.
  it("disables the sibling Use buttons while a write is in flight", async () => {
    let release!: () => void;
    const onAddTarget = vi.fn(
      () => new Promise<{ ok: boolean }>((r) => (release = () => r({ ok: true })))
    );
    setup(proposal([row]), {
      contacts: [jane, contact(8, "Jane Doe", { email: "jane2@acme.example" })],
      onAddTarget,
    });
    await userEvent.click(screen.getByTestId("calendar-create-j.doe@acme.example"));
    await userEvent.click(screen.getByTestId("calendar-create-use-7"));

    expect(screen.getByTestId("calendar-create-use-8")).toBeDisabled();
    await userEvent.click(screen.getByTestId("calendar-create-use-8"));
    expect(onAddTarget).toHaveBeenCalledTimes(1);

    await act(async () => {
      release();
    });
  });

  // Regression test for guard PLACEMENT, not just presence. The test above
  // clicks a DIFFERENT (disabled) button via two separately-awaited
  // `userEvent.click` calls, and React commits the `disabled` attribute
  // synchronously after the FIRST dispatch finishes - so by the time the
  // second dispatch runs, React's own click-suppression for disabled elements
  // already blocks it, no matter where the guard sits in the handler. That
  // test cannot tell a guard checked before the `try` from one checked inside
  // it: both placements leave the count at 1.
  //
  // Firing BOTH clicks inside the SAME `act()` callback defers React's commit
  // until after both handlers have already run against the STALE (pre-write)
  // `disabled` value, which is what a genuine two-clicks-before-any-repaint
  // race looks like. Verified empirically: with the guard deleted entirely,
  // this exact setup produces 2 calls; with it restored, 1. A guard moved
  // inside the `try` still passes this test's raw count (its own early return
  // still stops that second call's `onAddTarget`), but the mutation check
  // below is on `finally` running for a REFUSED call, not on this count.
  it("guards re-entry even when two clicks land before any render flush", async () => {
    let release!: () => void;
    const onAddTarget = vi.fn(
      () => new Promise<{ ok: boolean }>((r) => (release = () => r({ ok: true })))
    );
    setup(proposal([row]), {
      contacts: [jane, contact(8, "Jane Doe", { email: "jane2@acme.example" })],
      onAddTarget,
    });
    await userEvent.click(screen.getByTestId("calendar-create-j.doe@acme.example"));

    const use7 = screen.getByTestId("calendar-create-use-7");
    const use8 = screen.getByTestId("calendar-create-use-8");
    await act(async () => {
      fireEvent.click(use7);
      fireEvent.click(use8);
    });

    expect(onAddTarget).toHaveBeenCalledTimes(1);

    // The first call is STILL in flight. A guard placed INSIDE the `try`
    // still stops this refused second call's own `onAddTarget`, but its
    // early `return` reaches the `finally` and clears the ref anyway - so
    // the button would have committed back to enabled here, and a third,
    // ordinary click would slip a second `onAddTarget` call past the cap.
    expect(use7).toBeDisabled();
    await userEvent.click(use7);
    expect(onAddTarget).toHaveBeenCalledTimes(1);

    await act(async () => {
      release();
    });
  });

  // Step 6a's OTHER half of the cap race: `confirm` and `resolveWithExisting`
  // write against the SAME five slots, and a flag each (without reading the
  // other's ref) is not a guard. Four targets already logged (freeSlots = 1)
  // pre-checks the sole writable match, so "Add 1 to log" and a "Use" click
  // contend for the same last slot. Same batched-`act()` technique as the
  // Use-vs-Use test above, and for the same reason: two separately-awaited
  // clicks would let React commit `writing`/`acting` into the DOM between
  // them, and the second control's own `disabled` attribute would then block
  // it regardless of whether the guard reads the other ref at all.
  function crossGuardSetup(onAddTarget: CalendarProposalProps["onAddTarget"]) {
    const matchedContact = contact(50, "Match Person");
    const state: CalendarProposalState = {
      kind: "proposal",
      eventId: "e1",
      subject: "Client sync",
      matched: [
        { participant: participant("m@acme.example", "Match Person"), contact: matchedContact },
      ],
      unmatched: [row],
    };
    const fourTargets: SelectedTargets = [1, 2, 3, 4].map((n) => ({
      model: "res.partner",
      resId: n,
      name: `T${n}`,
    }));
    return setup(state, { contacts: [matchedContact, jane], targets: fourTargets, onAddTarget });
  }

  it("refuses a Use click while Add N to log is in flight", async () => {
    let release!: () => void;
    const onAddTarget = vi.fn(
      () => new Promise<{ ok: boolean }>((r) => (release = () => r({ ok: true })))
    );
    crossGuardSetup(onAddTarget);
    await userEvent.click(screen.getByTestId("calendar-create-j.doe@acme.example"));

    const confirmButton = screen.getByTestId("calendar-proposal-confirm");
    const useButton = screen.getByTestId("calendar-create-use-7");
    await act(async () => {
      fireEvent.click(confirmButton);
      fireEvent.click(useButton);
    });

    expect(onAddTarget).toHaveBeenCalledTimes(1);

    await act(async () => {
      release();
    });
  });

  it("refuses Add N to log while a Use click is in flight", async () => {
    let release!: () => void;
    const onAddTarget = vi.fn(
      () => new Promise<{ ok: boolean }>((r) => (release = () => r({ ok: true })))
    );
    crossGuardSetup(onAddTarget);
    await userEvent.click(screen.getByTestId("calendar-create-j.doe@acme.example"));

    const confirmButton = screen.getByTestId("calendar-proposal-confirm");
    const useButton = screen.getByTestId("calendar-create-use-7");
    await act(async () => {
      fireEvent.click(useButton);
      fireEvent.click(confirmButton);
    });

    expect(onAddTarget).toHaveBeenCalledTimes(1);

    await act(async () => {
      release();
    });
  });

  // The idle-reset effect resets `writingRef`/`writing` on an Odoo instance
  // change (state -> idle) precisely so a write in flight does not leave the
  // confirm button dead forever - its own doc comment names that exact
  // failure for `writingRef`. `acting`/`actingRef` need the identical reset:
  // without it, an instance change while a `Use` click is pending strands
  // both flags `true` forever, because the pending write's own `finally`
  // checks `epochRef` and skips its release once the idle transition has
  // bumped it - permanently disabling every `Use` button and `Add N to log`
  // for the rest of the mount, silently.
  it("releases the acting latch when the Odoo instance changes mid-write", async () => {
    // Never resolves - this write is abandoned by the instance change below,
    // exactly like a real in-flight `addTarget` call would be.
    const onAddTarget = vi.fn(() => new Promise<{ ok: boolean }>(() => {}));
    const { rerender } = setup(proposal([row]), { contacts: [jane], onAddTarget });
    await userEvent.click(screen.getByTestId("calendar-create-j.doe@acme.example"));
    await userEvent.click(screen.getByTestId("calendar-create-use-7"));
    expect(onAddTarget).toHaveBeenCalledTimes(1);

    // Odoo instance changes mid-write. Task 9 routes the idle reset through
    // `closeForm`, same as Cancel and a landed write, so the open form (and
    // its stale candidate list from the OLD instance) does not survive it.
    rerender({ state: { kind: "idle" } });
    // The picker opens again, later, for a different meeting.
    rerender({ state: proposal([row]) });

    await userEvent.click(screen.getByTestId("calendar-create-j.doe@acme.example"));
    await userEvent.click(screen.getByTestId("calendar-create-use-7"));
    expect(onAddTarget).toHaveBeenCalledTimes(2);
  });

  // freeSlots is a dep of the pre-check effect and a successful Use click
  // changes it by definition. Clearing resolvedByHand there would un-resolve
  // the row on the very next commit.
  it("stays resolved when another target is added by hand", async () => {
    const { rerender } = setup(proposal([row]), { contacts: [jane] });
    await userEvent.click(screen.getByTestId("calendar-create-j.doe@acme.example"));
    await userEvent.click(screen.getByTestId("calendar-create-use-7"));

    rerender({
      targets: [
        { model: "res.partner", resId: 7, name: "Jane Doe" },
        { model: "res.partner", resId: 99, name: "Someone Else" },
      ],
    });
    expect(screen.queryByTestId("calendar-create-j.doe@acme.example")).toBeNull();
  });
});

describe("submitting the create form", () => {
  const row = { participant: participant("new@acme.example", "New Person"), reason: "no-contact" as const };
  const created = contact(7, "New Person", { email: "new@acme.example" });

  async function submit(result: CreateContactResult, over = {}) {
    const onCreateContact = vi.fn(async () => result);
    const harness = setup(proposal([row]), { onCreateContact, ...over });
    await userEvent.click(screen.getByTestId("calendar-create-new@acme.example"));
    await userEvent.click(screen.getByTestId("calendar-create-submit"));
    return { ...harness, onCreateContact };
  }

  it("calls onCreateContact with the participant and the draft, and never onAddTarget", async () => {
    const { onCreateContact, onAddTarget } = await submit({ kind: "created", contact: created });
    expect(onCreateContact).toHaveBeenCalledWith(
      expect.objectContaining({ address: "new@acme.example" }),
      { name: "New Person", parentId: null }
    );
    // Two buttons, two writes, no path where one implies the other.
    expect(onAddTarget).not.toHaveBeenCalled();
  });

  it.each([
    ["created", { kind: "created", contact: created }, /tick them below/i],
    ["adopted-active", { kind: "adopted-active", contact: created }, /already in odoo/i],
    ["adopted-archived", { kind: "adopted-archived", contact: created }, /archived/i],
    ["created-invisible", { kind: "created-invisible" }, /isn't visible/i],
    ["cached-failed", { kind: "cached-failed" }, /refresh to see them/i],
  ])("closes the form and reports %s", async (_label, result, pattern) => {
    await submit(result);
    expect(screen.queryByTestId("calendar-create-form")).toBeNull();
    expect(screen.getByTestId("calendar-create-result")).toHaveTextContent(pattern);
  });

  it("renders nothing at all for an abandoned create", async () => {
    await submit({ kind: "abandoned" });
    expect(screen.queryByTestId("calendar-create-form")).toBeNull();
    expect(screen.queryByTestId("calendar-create-result")).toBeNull();
  });

  // `as const` on the tuples: without it `code` widens to `string`, which is
  // not assignable to OdooErrorCode and breaks the typed fixture below.
  it.each([
    ["ODOO_FAULT", /permissions/i],
    ["ODOO_UNREACHABLE", /could not reach odoo/i],
    ["ODOO_INTERNAL", /ODOO_INTERNAL/],
  ] as const)("keeps the form open with the draft intact after %s", async (code, pattern) => {
    setup(proposal([row]), {
      onCreateContact: vi.fn(async (): Promise<CreateContactResult> => ({ kind: "failed", code })),
    });
    await userEvent.click(screen.getByTestId("calendar-create-new@acme.example"));
    await userEvent.clear(screen.getByTestId("calendar-create-name"));
    await userEvent.type(screen.getByTestId("calendar-create-name"), "Edited Name");
    await userEvent.click(screen.getByTestId("calendar-create-submit"));

    expect(screen.getByTestId("calendar-create-form")).toBeInTheDocument();
    expect(screen.getByTestId("calendar-create-name")).toHaveValue("Edited Name");
    expect(screen.getByTestId("calendar-create-result")).toHaveTextContent(pattern);
    // The retry the message promises must actually be clickable.
    expect(screen.getByTestId("calendar-create-submit")).toBeEnabled();
  });

  // The reciprocal half of the two-gate invariant, and the only test that pins
  // it: two buttons, two writes, no path where one implies the other.
  it("Add N to log does not call onCreateContact", async () => {
    const created = contact(7, "Matched", { email: "m@acme.example" });
    const { onCreateContact } = setup(
      {
        kind: "proposal",
        eventId: "e1",
        subject: "Client sync",
        matched: [{ participant: participant("m@acme.example", "Matched"), contact: created }],
        unmatched: [row],
      },
      { contacts: [created] }
    );
    await userEvent.click(screen.getByTestId("calendar-proposal-confirm"));
    expect(onCreateContact).not.toHaveBeenCalled();
  });

  // `busy` is the one member whose form behaviour is "unchanged". A mutant that
  // deletes the early return folds it into the closeIfStillOpen path and
  // silently discards the user's draft.
  it("leaves the form and the draft alone on a busy refusal", async () => {
    setup(proposal([row]), {
      onCreateContact: vi.fn(async (): Promise<CreateContactResult> => ({ kind: "busy" })),
    });
    await userEvent.click(screen.getByTestId("calendar-create-new@acme.example"));
    await userEvent.clear(screen.getByTestId("calendar-create-name"));
    await userEvent.type(screen.getByTestId("calendar-create-name"), "Half Typed");
    await userEvent.click(screen.getByTestId("calendar-create-submit"));

    expect(screen.getByTestId("calendar-create-form")).toBeInTheDocument();
    expect(screen.getByTestId("calendar-create-name")).toHaveValue("Half Typed");
    expect(screen.queryByTestId("calendar-create-result")).toBeNull();
  });

  // The whole point of the createdInvisible latch. Without it the row keeps
  // deriving no-contact, the affordance returns, and one more click makes a
  // second partner the search will never see.
  it("withdraws the create affordance after created-invisible", async () => {
    await submit({ kind: "created-invisible" });
    expect(screen.queryByTestId("calendar-create-new@acme.example")).toBeNull();
    expect(screen.getByTestId("calendar-unmatched-new@acme.example")).toHaveTextContent(
      /not visible to this connection/i
    );
  });

  // epochRef tracks idle resets, not row switches. A create resolving after the
  // user moved to another row must not wipe THAT row's draft.
  it("does not close another row's form when a slow create resolves", async () => {
    let release!: () => void;
    const onCreateContact = vi.fn(
      () =>
        new Promise<CreateContactResult>(
          (r) => (release = () => r({ kind: "created", contact: created }))
        )
    );
    setup(
      proposal([
        row,
        { participant: participant("other@acme.example", "Other Person"), reason: "no-contact" },
      ]),
      { onCreateContact }
    );
    await userEvent.click(screen.getByTestId("calendar-create-new@acme.example"));
    await userEvent.click(screen.getByTestId("calendar-create-submit"));
    await userEvent.click(screen.getByTestId("calendar-create-other@acme.example"));
    await userEvent.clear(screen.getByTestId("calendar-create-name"));
    await userEvent.type(screen.getByTestId("calendar-create-name"), "Other Draft");

    await act(async () => {
      release();
    });

    expect(screen.getByTestId("calendar-create-form")).toBeInTheDocument();
    expect(screen.getByTestId("calendar-create-name")).toHaveValue("Other Draft");
  });

  it("never renders server prose", async () => {
    await submit({ kind: "failed", code: "ODOO_FAULT" });
    const text = screen.getByTestId("calendar-create-result").textContent ?? "";
    expect(text).not.toMatch(/traceback|psycopg|odoo\.exceptions/i);
  });

  it("survives the re-projection that removes the row it refers to", async () => {
    const { rerender } = await submit({ kind: "created", contact: created });
    // The create moved the attendee into `matched`: `unmatched` shrinks and
    // `writable` grows, which re-fires the pre-check effect. The message must
    // NOT be cleared there.
    rerender({
      state: {
        kind: "proposal",
        eventId: "e1",
        subject: "Client sync",
        matched: [{ participant: participant("new@acme.example", "New Person"), contact: created }],
        unmatched: [],
      },
      contacts: [created],
    });
    expect(screen.getByTestId("calendar-create-result")).toHaveTextContent(/tick them below/i);
    // And the new row is present, enabled and UNCHECKED - the intersect-only
    // reconciliation never adds an id back to `checked`.
    const box = screen.getByTestId("calendar-proposal-row-7");
    expect(box).toBeEnabled();
    expect(box).not.toBeChecked();
  });

  // The other half of the intersect-only rule: a create widens `writable`,
  // which re-fires the pre-check effect. A row the user deliberately unchecked
  // before the create must not be re-ticked by it.
  it("leaves a row the user unchecked still unchecked after a create", async () => {
    const other = contact(9, "Already Matched", { email: "am@acme.example" });
    const withMatch = (unmatched: typeof row[]) => ({
      kind: "proposal" as const,
      eventId: "e1",
      subject: "Client sync",
      matched: [{ participant: participant("am@acme.example", "Already Matched"), contact: other }],
      unmatched,
    });
    const { rerender } = setup(withMatch([row]), {
      contacts: [other],
      onCreateContact: vi.fn(async (): Promise<CreateContactResult> => ({ kind: "created", contact: created })),
    });
    // Pre-checked because it fits; the user unticks it.
    await userEvent.click(screen.getByTestId("calendar-proposal-row-9"));
    expect(screen.getByTestId("calendar-proposal-row-9")).not.toBeChecked();

    await userEvent.click(screen.getByTestId("calendar-create-new@acme.example"));
    await userEvent.click(screen.getByTestId("calendar-create-submit"));

    rerender({
      state: {
        kind: "proposal",
        eventId: "e1",
        subject: "Client sync",
        matched: [
          { participant: participant("am@acme.example", "Already Matched"), contact: other },
          { participant: participant("new@acme.example", "New Person"), contact: created },
        ],
        unmatched: [],
      },
      contacts: [other, created],
    });
    expect(screen.getByTestId("calendar-proposal-row-9")).not.toBeChecked();
  });

  it("clears the message when a different meeting is proposed", async () => {
    const { rerender } = await submit({ kind: "created", contact: created });
    rerender({
      state: { kind: "proposal", eventId: "e2", subject: "Other", matched: [], unmatched: [] },
    });
    expect(screen.queryByTestId("calendar-create-result")).toBeNull();
  });

  it("closes the form when its row flips to archived underneath it", async () => {
    const { rerender } = setup(proposal([row]), {});
    await userEvent.click(screen.getByTestId("calendar-create-new@acme.example"));
    expect(screen.getByTestId("calendar-create-form")).toBeInTheDocument();

    rerender({ state: proposal([{ participant: row.participant, reason: "archived" }]) });
    expect(screen.queryByTestId("calendar-create-form")).toBeNull();
  });

  // The render guard (`canCreate && openForm === address`) alone already
  // hides the form the moment a row's reason flips away from "no-contact" -
  // the test above passes on that guard alone, even if `openForm` itself were
  // never cleared. This test is the one that actually pins the STATE reset:
  // without it, `openForm` keeps naming this address, and a LATER reprojection
  // back to "no-contact" (un-archived, then re-matched as no-contact again)
  // would silently reopen the form with whatever stale draft the user typed
  // before it was hidden - a create the user never asked to reopen, carrying
  // text they may have abandoned.
  it("does not silently reopen with a stale draft when a row's reason flips back to no-contact", async () => {
    const { rerender } = setup(proposal([row]), {});
    await userEvent.click(screen.getByTestId("calendar-create-new@acme.example"));
    await userEvent.clear(screen.getByTestId("calendar-create-name"));
    await userEvent.type(screen.getByTestId("calendar-create-name"), "Stale Draft");

    rerender({ state: proposal([{ participant: row.participant, reason: "archived" }]) });
    expect(screen.queryByTestId("calendar-create-form")).toBeNull();

    rerender({ state: proposal([row]) });
    expect(screen.queryByTestId("calendar-create-form")).toBeNull();
  });

  it("disables the button while a create is in flight", async () => {
    let release!: () => void;
    const onCreateContact = vi.fn(
      () =>
        new Promise<CreateContactResult>(
          (r) => (release = () => r({ kind: "created", contact: created }))
        )
    );
    setup(proposal([row]), { onCreateContact });
    await userEvent.click(screen.getByTestId("calendar-create-new@acme.example"));
    await userEvent.click(screen.getByTestId("calendar-create-submit"));
    expect(screen.getByTestId("calendar-create-submit")).toBeDisabled();
    await act(async () => {
      release();
    });
  });

  // Same batched-`act()` technique as the Use-vs-Use race test above (Layer 2
  // describe block): two separately-awaited `userEvent.click` calls on the
  // SAME button would let React commit `disabled` between them, and the
  // button's own attribute would then block the second dispatch regardless of
  // whether `actingRef` is checked at all - a guard-less handler would still
  // pass that shape of test. Firing both clicks inside one `act()` defers
  // React's commit until after both handlers have already run against the
  // STALE (pre-write) `disabled` value, which is what a genuine
  // two-clicks-before-any-repaint race looks like. Verified empirically: with
  // the `actingRef` guard deleted entirely, this exact setup produces 2 calls
  // to `onCreateContact`; with it restored, 1.
  it("guards re-entry when Create contact is clicked twice before any render flush", async () => {
    let release!: () => void;
    const onCreateContact = vi.fn(
      () =>
        new Promise<CreateContactResult>(
          (r) => (release = () => r({ kind: "created", contact: created }))
        )
    );
    setup(proposal([row]), { onCreateContact });
    await userEvent.click(screen.getByTestId("calendar-create-new@acme.example"));

    const submit = screen.getByTestId("calendar-create-submit");
    await act(async () => {
      fireEvent.click(submit);
      fireEvent.click(submit);
    });

    expect(onCreateContact).toHaveBeenCalledTimes(1);
    // The first call is STILL in flight. A guard placed INSIDE the `try`
    // still stops this refused second call's own `onCreateContact`, but its
    // early `return` reaches the `finally` and clears `actingRef` anyway - so
    // the button would have committed back to enabled here, and a third,
    // ordinary click would slip a second `onCreateContact` call past the
    // guard.
    expect(submit).toBeDisabled();
    await userEvent.click(submit);
    expect(onCreateContact).toHaveBeenCalledTimes(1);

    await act(async () => {
      release();
    });
  });

  it("an idle reset mid-create sets no result and leaves no disabled button", async () => {
    let release!: () => void;
    const onCreateContact = vi.fn(
      () =>
        new Promise<CreateContactResult>(
          (r) => (release = () => r({ kind: "created", contact: created }))
        )
    );
    const { rerender } = setup(proposal([row]), { onCreateContact });
    await userEvent.click(screen.getByTestId("calendar-create-new@acme.example"));
    await userEvent.click(screen.getByTestId("calendar-create-submit"));

    rerender({ state: { kind: "idle" } });
    await act(async () => {
      release();
    });
    expect(screen.queryByTestId("calendar-create-result")).toBeNull();
    expect(screen.getByTestId("calendar-proposal-region").textContent).toBe("");
  });

  it("a re-projection while the form is open does not overwrite an edited name", async () => {
    const { rerender } = setup(proposal([row]), {});
    await userEvent.click(screen.getByTestId("calendar-create-new@acme.example"));
    await userEvent.clear(screen.getByTestId("calendar-create-name"));
    await userEvent.type(screen.getByTestId("calendar-create-name"), "Corrected Name");

    // A fresh participant object, as project() produces on every reprojection.
    rerender({
      state: proposal([
        { participant: participant("new@acme.example", "New Person"), reason: "no-contact" },
      ]),
      contacts: [contact(50, "Unrelated", { email: "u@x.test" })],
    });
    expect(screen.getByTestId("calendar-create-name")).toHaveValue("Corrected Name");
  });

  it("still offers create at cap, and the resulting row renders disabled", async () => {
    const full = Array.from({ length: 5 }, (_, i) => ({
      model: "res.partner" as const,
      resId: 200 + i,
      name: `T${i}`,
    }));
    // BOTH halves in one fixture: a matched row to show the disabled state, and
    // an unmatched no-contact row to show the affordance is still offered.
    // `canCreate` never consults `atCap`, which is the point.
    setup(
      {
        kind: "proposal",
        eventId: "e1",
        subject: "Client sync",
        matched: [{ participant: participant("m@acme.example", "Matched"), contact: contact(9, "Matched", { email: "m@acme.example" }) }],
        unmatched: [row],
      },
      { targets: full, contacts: [created] }
    );
    // The Odoo record has value independent of whether a slot is free, so the
    // affordance does not appear and disappear for a reason unrelated to the
    // attendee...
    expect(screen.getByTestId("calendar-create-new@acme.example")).toBeInTheDocument();
    // ...but the rows themselves are disabled while the log is full.
    expect(screen.getByTestId("calendar-proposal-row-9")).toBeDisabled();
    expect(screen.getByTestId("calendar-proposal-notice")).toHaveTextContent(/log is full/i);
  });

  // Regression: the pre-check effect records `isNewProposal` from
  // `lastProposalEventIdRef` UNCONDITIONALLY, before the `writingRef.current`
  // guard - so a proposal change landing mid-`confirm`-write must still clear
  // `createResult` on that SAME pass. If the clearing were gated behind the
  // guard instead, the guard would swallow it this one time, the ref would
  // already have advanced to the new eventId, and no later pass would ever
  // see `isNewProposal` true again for this transition - the stale message
  // would survive into the next meeting permanently. A promise that never
  // settles is deliberate: if the write resolved before the rerender,
  // `writingRef` would already be false, the guard would never fire, and this
  // test would pass regardless of where the clearing block sits.
  it("clears a stale create result when the proposal changes while a confirm write is in flight", async () => {
    const matchedContact = contact(50, "Match Person", { email: "m@acme.example" });
    const onAddTarget = vi.fn(() => new Promise<{ ok: boolean }>(() => {}));
    const { rerender } = setup(
      {
        kind: "proposal",
        eventId: "e1",
        subject: "Client sync",
        matched: [
          { participant: participant("m@acme.example", "Match Person"), contact: matchedContact },
        ],
        unmatched: [row],
      },
      {
        contacts: [matchedContact],
        onAddTarget,
        onCreateContact: vi.fn(async (): Promise<CreateContactResult> => ({ kind: "created", contact: created })),
      }
    );

    // Establish a non-null createResult BEFORE the write starts: the Create
    // button disables on `writing`, so this must happen first.
    await userEvent.click(screen.getByTestId("calendar-create-new@acme.example"));
    await userEvent.click(screen.getByTestId("calendar-create-submit"));
    expect(screen.getByTestId("calendar-create-result")).toHaveTextContent(/tick them below/i);

    // Start a confirm write that never settles - `writingRef.current` stays
    // true for the rest of this test.
    await userEvent.click(screen.getByTestId("calendar-proposal-confirm"));
    expect(onAddTarget).toHaveBeenCalledTimes(1);

    // A genuinely different meeting (a different eventId - same eventId would
    // make `isNewProposal` false either way and prove nothing), landing
    // mid-write.
    rerender({
      state: { kind: "proposal", eventId: "e2", subject: "Other", matched: [], unmatched: [] },
    });

    expect(screen.queryByTestId("calendar-create-result")).toBeNull();
  });
});
