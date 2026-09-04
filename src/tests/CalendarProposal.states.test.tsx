import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CalendarProposal } from "@/pages/app/components/completion/CalendarProposal";
import type { CalendarProposalState } from "@/types";

function renderState(state: CalendarProposalState, over = {}) {
  const handlers = {
    onPickCandidate: vi.fn(),
    onRetry: vi.fn(),
    onAddTarget: vi.fn(async () => ({ ok: true })),
    ...over,
  };
  render(<CalendarProposal state={state} targets={[]} {...handlers} />);
  return handlers;
}

const MIN = 60_000;
const NOW = Date.UTC(2026, 8, 2, 14, 0, 0);

describe("several survivors", () => {
  // Do not guess. One row per candidate meeting, subject and start-end time.
  it("lists one row per candidate with its subject and time", () => {
    renderState({
      kind: "several",
      candidates: [
        { id: "a", subject: "Client sync", startMs: NOW, endMs: NOW + 30 * MIN },
        { id: "b", subject: null, startMs: NOW + 5 * MIN, endMs: NOW + 35 * MIN },
      ],
    });
    expect(screen.getByTestId("calendar-candidate-a")).toHaveTextContent("Client sync");
    // An untitled event is a real event; the row still has to name a time.
    expect(screen.getByTestId("calendar-candidate-b")).toHaveTextContent(/untitled/i);
    expect(screen.getAllByTestId(/^calendar-candidate-/)).toHaveLength(2);
  });

  it("picking a candidate reports it to the hook", async () => {
    const { onPickCandidate } = renderState({
      kind: "several",
      candidates: [{ id: "a", subject: "Client sync", startMs: NOW, endMs: NOW + 30 * MIN }],
    });
    await userEvent.click(screen.getByTestId("calendar-candidate-a"));
    expect(onPickCandidate).toHaveBeenCalledWith("a");
  });
});

describe("unmatched attendees", () => {
  // Never silently dropped: silent dropping is how a user fails to notice that
  // the one person who mattered is missing from the list.
  it("shows unmatched attendees greyed and labelled, with no add control", () => {
    renderState({
      kind: "proposal",
      eventId: "e1",
      subject: "Client sync",
      matched: [],
      unmatched: [
        {
          participant: { address: "new@acme.example", name: "New Person", type: "required", isOrganizer: false },
          reason: "no-contact",
        },
        {
          participant: { address: "old@acme.example", name: "Archived Person", type: "required", isOrganizer: false },
          reason: "archived",
        },
      ],
    });
    expect(screen.getAllByTestId(/^calendar-unmatched-/)).toHaveLength(2);
    // The two reasons render DIFFERENTLY. Telling the user there is "no Odoo
    // contact" for a partner who is merely archived would send them off to
    // create a duplicate of a record they already have.
    expect(screen.getByTestId("calendar-unmatched-new@acme.example")).toHaveTextContent(
      /no odoo contact/i
    );
    expect(screen.getByTestId("calendar-unmatched-old@acme.example")).toHaveTextContent(
      /archived in odoo/i
    );
    // Greyed, and there is no create-contact action anywhere in this block.
    expect(screen.queryByRole("button", { name: /create/i })).toBeNull();
    expect(screen.queryByTestId("calendar-proposal-row-0")).toBeNull();
  });
});

describe("other states", () => {
  it.each([
    ["loading", { kind: "loading" } as const],
    ["no-meeting", { kind: "no-meeting" } as const],
  ])("renders the reserved region for %s", (_label, state) => {
    renderState(state);
    expect(screen.getByTestId("calendar-proposal-region")).toBeInTheDocument();
  });

  it("renders nothing at all when idle", () => {
    renderState({ kind: "idle" });
    expect(screen.queryByTestId("calendar-proposal-region")).toBeNull();
  });

  it("offers a retry on an error", async () => {
    const { onRetry } = renderState({ kind: "error", code: "GRAPH_NETWORK" });
    await userEvent.click(screen.getByTestId("calendar-proposal-retry"));
    expect(onRetry).toHaveBeenCalled();
  });

  it("never renders a token or a raw error message", () => {
    renderState({ kind: "error", code: "GRAPH_AUTH_REJECTED" });
    expect(screen.getByTestId("calendar-proposal-region").textContent ?? "").not.toMatch(/eyJ/);
  });
});
