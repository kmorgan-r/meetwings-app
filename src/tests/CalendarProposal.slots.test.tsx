import React from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CalendarProposal } from "@/pages/app/components/completion/CalendarProposal";
import { MAX_TARGETS } from "@/lib/odoo";
import type { OdooContact, SelectedTargets } from "@/types";

function contact(id: number, over: Partial<OdooContact> = {}): OdooContact {
  return {
    id, name: `Person ${id}`, email: `p${id}@acme.example`, phone: null,
    companyName: null, parentId: null, isCompany: false, active: true,
    writeDate: "2026-09-01 00:00:00", isColleague: false, lastMeetingAt: null,
    ...over,
  };
}

function matched(contacts: OdooContact[]) {
  return contacts.map((c) => ({
    participant: { address: c.email!, name: c.name, type: "required" as const, isOrganizer: false },
    contact: c,
  }));
}

function target(resId: number): SelectedTargets[number] {
  return { model: "res.partner", resId, name: `Person ${resId}` };
}

function renderProposal({
  contacts,
  targets = [],
  onAddTarget = vi.fn(async () => ({ ok: true })),
  unmatched = [],
}: {
  contacts: OdooContact[];
  targets?: SelectedTargets;
  onAddTarget?: (t: SelectedTargets[number]) => Promise<{ ok: boolean; reason?: "cap" }>;
  unmatched?: { participant: { address: string; name: string | null; type: "required"; isOrganizer: false }; reason: "no-contact" | "archived" }[];
}) {
  render(
    <CalendarProposal
      state={{
        kind: "proposal",
        eventId: "e1",
        subject: "Client sync",
        matched: matched(contacts),
        unmatched,
      }}
      targets={targets}
      onAddTarget={onAddTarget}
      onPickCandidate={vi.fn()}
      onRetry={vi.fn()}
    />
  );
  return { onAddTarget };
}

describe("slot rule", () => {
  it("pre-checks every writable match when they fit the free slots", async () => {
    // 3 matches, 1 target already selected -> 4 free slots. All fit.
    renderProposal({ contacts: [contact(1), contact(2), contact(3)], targets: [target(9)] });
    for (const id of [1, 2, 3]) {
      expect(screen.getByTestId(`calendar-proposal-row-${id}`)).toBeChecked();
    }
    expect(screen.getByTestId("calendar-proposal-confirm")).toHaveTextContent("Add 3 to log");
  });

  // Auto-selecting an arbitrary subset is precisely the wrong-record risk this
  // feature exists to avoid, and the cap makes some choice unavoidable - so
  // the choice is the user's.
  it("pre-checks nothing when writable matches exceed free slots", () => {
    const contacts = Array.from({ length: 8 }, (_, i) => contact(i + 1));
    renderProposal({ contacts, targets: [target(90), target(91), target(92)] });
    for (const c of contacts) {
      expect(screen.getByTestId(`calendar-proposal-row-${c.id}`)).not.toBeChecked();
    }
    // The copy names the REAL remaining count, not MAX_TARGETS. "Pick up to
    // five" when two slots remain is a promise the database will break.
    const notice = screen.getByTestId("calendar-proposal-notice").textContent ?? "";
    expect(notice).toContain("8 attendees matched");
    expect(notice).toContain("2 slots left");
    expect(notice).not.toContain(String(MAX_TARGETS));
  });

  /**
   * The slot rule is "fits the FREE slots", not "fits under MAX_TARGETS" -
   * and no other case in this file discriminates the two: every other
   * overflow case here also happens to exceed MAX_TARGETS, and every
   * within-bounds case also happens to be within MAX_TARGETS. Here
   * `writable` (4) sits strictly between `freeSlots` (3) and `MAX_TARGETS`
   * (5), so a mutant comparing against `MAX_TARGETS` instead of `freeSlots`
   * would pre-check everything and pass every other test in this file, but
   * fails here.
   */
  it("pre-checks nothing when matches exceed free slots but stay within MAX_TARGETS", () => {
    const contacts = Array.from({ length: 4 }, (_, i) => contact(i + 1));
    renderProposal({ contacts, targets: [target(90), target(91)] });
    for (const c of contacts) {
      expect(screen.getByTestId(`calendar-proposal-row-${c.id}`)).not.toBeChecked();
    }
    const notice = screen.getByTestId("calendar-proposal-notice").textContent ?? "";
    expect(notice).toContain("4 attendees matched");
    expect(notice).toContain("3 slots left");
  });

  it("offers nothing checkable when there are no free slots", () => {
    const full = Array.from({ length: MAX_TARGETS }, (_, i) => target(80 + i));
    renderProposal({ contacts: [contact(1)], targets: full });
    expect(screen.getByTestId("calendar-proposal-row-1")).toBeDisabled();
    expect(screen.getByTestId("calendar-proposal-notice")).toHaveTextContent(/full/i);
    expect(screen.queryByTestId("calendar-proposal-confirm")).toBeNull();
  });

  // Re-upserting an already-selected row would overwrite its conversation_id
  // (possibly to null) and its selected_at, reordering loadTargets - silently
  // rewriting a row the user chose by hand.
  it("renders an already-selected match as selected and excludes it from the write", async () => {
    const { onAddTarget } = renderProposal({
      contacts: [contact(1), contact(2)],
      targets: [target(1)],
    });
    expect(screen.getByTestId("calendar-proposal-row-1")).toBeDisabled();
    expect(screen.getByTestId("calendar-proposal-selected-1")).toBeInTheDocument();
    expect(screen.getByTestId("calendar-proposal-confirm")).toHaveTextContent("Add 1 to log");

    await userEvent.click(screen.getByTestId("calendar-proposal-confirm"));
    await waitFor(() => expect(onAddTarget).toHaveBeenCalledTimes(1));
    expect(onAddTarget).toHaveBeenCalledWith({ model: "res.partner", resId: 2, name: "Person 2" });
  });

  it("orders by lastMeetingAt descending, nulls last, ties by name", () => {
    renderProposal({
      contacts: [
        contact(1, { name: "Zoe", lastMeetingAt: null }),
        contact(2, { name: "Adam", lastMeetingAt: null }),
        contact(3, { name: "Recent", lastMeetingAt: 5_000 }),
        contact(4, { name: "Older", lastMeetingAt: 1_000 }),
      ],
    });
    const rendered = screen
      .getAllByTestId(/^calendar-proposal-label-/)
      .map((n) => n.textContent);
    expect(rendered).toEqual(["Recent", "Older", "Adam", "Zoe"]);
  });
});

describe("the write", () => {
  it("calls onAddTarget once per checked row", async () => {
    const { onAddTarget } = renderProposal({ contacts: [contact(1), contact(2), contact(3)] });
    await userEvent.click(screen.getByTestId("calendar-proposal-row-2")); // uncheck
    await userEvent.click(screen.getByTestId("calendar-proposal-confirm"));
    await waitFor(() => expect(onAddTarget).toHaveBeenCalledTimes(2));
    expect(onAddTarget.mock.calls.map(([t]) => t.resId)).toEqual([1, 3]);
  });

  /**
   * addSelectedTarget is a non-atomic select-then-upsert with no transaction
   * (odoo-contacts.action.ts:319-331), and this is its first BULK caller.
   * Issued concurrently, every call's count runs before any insert commits and
   * more than MAX_TARGETS rows land.
   *
   * This asserts OVERLAP, not call order: a Promise.all would still produce
   * calls in array order, so asserting the order alone would pass against the
   * exact defect. The gate is that no second call starts before the first
   * resolves.
   */
  it("issues the writes sequentially, never concurrently", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const onAddTarget = vi.fn(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return { ok: true };
    });
    renderProposal({ contacts: [contact(1), contact(2), contact(3)], onAddTarget });
    await userEvent.click(screen.getByTestId("calendar-proposal-confirm"));
    await waitFor(() => expect(onAddTarget).toHaveBeenCalledTimes(3));
    expect(maxInFlight).toBe(1);
  });

  /**
   * The regression the static-`targets` tests above cannot see.
   *
   * In production every successful `onAddTarget` updates the parent's `targets`,
   * so this test re-renders with the grown list exactly as `<Completion />`
   * would. Without the `writingRef` guard on the pre-check effect, the row the
   * user UNCHECKED gets re-checked mid-write - and once the write settles and
   * the button re-enables, clicking it again would write the row the user
   * never authorised. That is asserted directly below, not just inferred: the
   * checkbox, the button's own label, its disabled state, AND a second click
   * that must add nothing.
   */
  it("never writes a row the user unchecked, even as targets grow mid-write", async () => {
    const contacts = [contact(1), contact(2), contact(3)];
    const added: number[] = [];
    let live: SelectedTargets = [];

    function Harness() {
      const [targets, setTargets] = React.useState<SelectedTargets>([]);
      live = targets;
      return (
        <CalendarProposal
          state={{
            kind: "proposal",
            eventId: "e1",
            subject: "Client sync",
            matched: matched(contacts),
            unmatched: [],
          }}
          targets={targets}
          onAddTarget={async (t) => {
            added.push(t.resId);
            // Exactly what useOdooTarget.addTarget does on success.
            setTargets((prev) => [...prev, t]);
            return { ok: true };
          }}
          onPickCandidate={vi.fn()}
          onRetry={vi.fn()}
        />
      );
    }

    render(<Harness />);
    // The user deliberately excludes Person 2.
    await userEvent.click(screen.getByTestId("calendar-proposal-row-2"));
    expect(screen.getByTestId("calendar-proposal-confirm")).toHaveTextContent("Add 2 to log");

    await userEvent.click(screen.getByTestId("calendar-proposal-confirm"));
    await waitFor(() => expect(added).toHaveLength(2));
    expect(added).toEqual([1, 3]);
    expect(live.map((t) => t.resId)).toEqual([1, 3]);

    // The write finished. Did the pre-check effect silently re-tick the row
    // the user excluded while `targets` grew mid-loop? If it did, the
    // checkbox is back on screen checked, the confirm button names a nonzero
    // count, and it is enabled again - exactly what the `writingRef` guard
    // exists to prevent.
    expect(screen.getByTestId("calendar-proposal-row-2")).not.toBeChecked();
    expect(screen.getByTestId("calendar-proposal-confirm")).toHaveTextContent("Add 0 to log");
    expect(screen.getByTestId("calendar-proposal-confirm")).toBeDisabled();

    // A disabled button does not dispatch a click; this is the end-to-end
    // proof that the excluded row can never reach `onAddTarget` again.
    await userEvent.click(screen.getByTestId("calendar-proposal-confirm"));
    expect(added).toEqual([1, 3]);
  });

  // The action-layer cap remains the backstop; a rejection is SURFACED, never
  // swallowed.
  it("stops at the first cap rejection and names what was and was not written", async () => {
    const onAddTarget = vi.fn(async (t: { resId: number }) =>
      t.resId === 2 ? { ok: false, reason: "cap" as const } : { ok: true }
    );
    renderProposal({ contacts: [contact(1), contact(2), contact(3)], onAddTarget });
    await userEvent.click(screen.getByTestId("calendar-proposal-confirm"));
    await waitFor(() => expect(onAddTarget).toHaveBeenCalledTimes(2));
    const message = await screen.findByTestId("calendar-proposal-write-result");
    // Assert the SPLIT, not just that each name appears somewhere: checking
    // only for presence would pass even if Person 1 were reported as not
    // written.
    expect(message).toHaveTextContent("Added Person 1");
    expect(message).toHaveTextContent(/The log is full, so Person 2, Person 3 were not added/);
  });

  /**
   * `useOdooTarget.addTarget` returns a bare `{ ok: false }` from its catch for
   * ANY thrown error - a busy database, ODOO_NOT_CONFIGURED - and has already
   * toasted the real cause. Reporting that as "the log is full" contradicts the
   * toast and sends the user to remove destinations that were never the problem.
   */
  it("does not blame the cap for a failure that carries no cap reason", async () => {
    const onAddTarget = vi.fn(async (t: { resId: number }) =>
      t.resId === 2 ? { ok: false } : { ok: true }
    );
    renderProposal({ contacts: [contact(1), contact(2), contact(3)], onAddTarget });
    await userEvent.click(screen.getByTestId("calendar-proposal-confirm"));
    const message = await screen.findByTestId("calendar-proposal-write-result");
    expect(message).toHaveTextContent(/Something went wrong/);
    expect(message).not.toHaveTextContent(/log is full/i);
  });

  /**
   * `<Completion />` force-closes the picker when a meeting-log hold begins
   * (or an Odoo instance change resets the hook to idle while it stays open),
   * and this component keeps rendering across that. With no reset path,
   * `writing` stayed true forever and the confirm button was dead on every
   * later open, for an unrelated later meeting, with nothing saying why.
   *
   * The write itself must not survive the reset either: `useOdooTarget`
   * resolves a target's partner id against whichever Odoo instance is CURRENT
   * per call, so a write still in flight when the instance changes must not
   * keep going - it would write the remaining rows into the NEW instance
   * under the ids the user confirmed against the OLD one. Two matched
   * contacts, not one: a single-row batch has nothing left to abort, so this
   * is only a meaningful check with a second row still pending when the
   * reset happens.
   */
  it("clears in-flight state when the popover closes, and aborts a write still in flight", async () => {
    let resolveFirst: ((value: { ok: boolean }) => void) | null = null;
    let calls = 0;
    const onAddTarget = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        return new Promise<{ ok: boolean }>((resolve) => {
          resolveFirst = resolve;
        });
      }
      return { ok: true };
    });

    const proposal = (
      <CalendarProposal
        state={{
          kind: "proposal",
          eventId: "e1",
          subject: "Client sync",
          matched: matched([contact(1), contact(2)]),
          unmatched: [],
        }}
        targets={[]}
        onAddTarget={onAddTarget}
        onPickCandidate={vi.fn()}
        onRetry={vi.fn()}
      />
    );

    const { rerender } = render(proposal);
    await userEvent.click(screen.getByTestId("calendar-proposal-confirm"));
    await waitFor(() => expect(onAddTarget).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId("calendar-proposal-confirm")).toBeDisabled();

    // The instance changes while the first row's write is still pending.
    rerender(
      <CalendarProposal
        state={{ kind: "idle" }}
        targets={[]}
        onAddTarget={vi.fn(async () => ({ ok: true }))}
        onPickCandidate={vi.fn()}
        onRetry={vi.fn()}
      />
    );
    // Reserved, not gone: an idle reset while the picker stays open must not
    // collapse the box out from under whatever sits below it.
    expect(screen.getByTestId("calendar-proposal-region")).toBeInTheDocument();
    expect(screen.getByTestId("calendar-proposal-region").textContent).toBe("");

    // Reopened on the SAME matched contacts, so `writableKey` returns to
    // exactly what it was before - the ordinary pre-check effect (keyed on
    // `writableKey`/`freeSlots`) cannot be what re-enables the button here,
    // since from its point of view nothing changed. Only the idle-reset
    // effect's own `writing`/`writingRef` reset can.
    rerender(proposal);
    expect(screen.getByTestId("calendar-proposal-confirm")).toBeEnabled();
    expect(screen.queryByTestId("calendar-proposal-write-result")).toBeNull();

    // The first row's write - abandoned when the popover went idle - finally
    // resolves. If `confirm`'s epoch guard did not abort the loop, it would
    // now call `onAddTarget` a SECOND time for the row that was never
    // re-confirmed, writing it under an instance that has changed since the
    // user saw it.
    await act(async () => {
      resolveFirst!({ ok: true });
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(onAddTarget).toHaveBeenCalledTimes(1);
  });
});
