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
  it("refuses a second Use click while the first is in flight", async () => {
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
