import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

// Only the error branch's "Open Settings" button (Important 3) reaches this -
// it opens the dashboard webview via `invoke("open_dashboard")` rather than
// promising a deep link this command cannot provide. Mocked here so clicking
// it in a test does not reject against the real (Tauri-less) module.
const invoke = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

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
    // Locale/TZ-safe: don't pin the exact hour, just that a start-end range
    // is actually printed, not silently dropped alongside the subject.
    expect(screen.getByTestId("calendar-candidate-b").textContent).toMatch(
      /\d{1,2}:\d{2}.*–.*\d{1,2}:\d{2}/
    );
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
    // GREYED, not just present: both entries actually carry the muted style.
    expect(screen.getByTestId("calendar-unmatched-new@acme.example")).toHaveClass(
      "text-muted-foreground"
    );
    expect(screen.getByTestId("calendar-unmatched-old@acme.example")).toHaveClass(
      "text-muted-foreground"
    );
    // No add control anywhere in this block: no checkbox at all (an id-0
    // testid probe is vacuous - no code path ever emits one), and no
    // create-contact escape hatch either.
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: /create/i })).toBeNull();
    // The fixed-height region is what keeps the popover's footprint from
    // jumping around as content behind it changes; a proposal is the state
    // most likely to grow content, so pin the class here too.
    expect(screen.getByTestId("calendar-proposal-region")).toHaveClass("h-28");
  });
});

describe("other states", () => {
  it.each([
    ["loading", { kind: "loading" } as const],
    ["no-meeting", { kind: "no-meeting" } as const],
  ])("renders the reserved region for %s", (_label, state) => {
    renderState(state);
    const region = screen.getByTestId("calendar-proposal-region");
    expect(region).toBeInTheDocument();
    // FIXED height, not max-height - see the comment on REGION_CLASS. A
    // max-height (or no height at all) passes every other assertion in this
    // file while breaking the one constraint the region exists to hold.
    expect(region).toHaveClass("h-28");
  });

  // `idle` is reachable with the popover still open and rendering - an Odoo
  // instance change resets the hook to idle while the picker stays open
  // (src/types/calendar.ts's CalendarProposalState doc comment), and
  // Radix's Presence also keeps content mounted through the exit-animation
  // window after `open` has already gone false. Returning `null` in either
  // case collapses the box out from under whatever sits below it - the
  // region must stay reserved, just empty.
  it("reserves the region but renders nothing in it when idle", () => {
    renderState({ kind: "idle" });
    const region = screen.getByTestId("calendar-proposal-region");
    expect(region).toBeInTheDocument();
    // Same fixed height as every other state - idle is the one that failed
    // the Global Constraint before, and it's the only state where a mutant
    // that bypasses `region()` entirely for idle (a bare
    // `<div data-testid="calendar-proposal-region" />`) would otherwise
    // survive the whole suite.
    expect(region).toHaveClass("h-28");
    expect(region.textContent).toBe("");
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
    expect(screen.queryByTestId("calendar-proposal-confirm")).toBeNull();
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

  /**
   * IMPORTANT 3's fail-first case. By the time GRAPH_AUTH_EXPIRED reaches the
   * webview, mod.rs's refresh_and_adopt has already deleted the stored
   * refresh token - "Try again" re-runs the same fetch, finds nothing to
   * refresh, and the SECOND attempt shows GRAPH_NOT_CONNECTED instead. A
   * retry button offering a fix that cannot work is worse than none: it must
   * be replaced by a pointer at the actual remedy.
   */
  it.each([
    ["GRAPH_AUTH_EXPIRED", /reconnect/i],
    ["GRAPH_NOT_CONNECTED", /connect/i],
    ["GRAPH_CONSENT_REQUIRED", /administrator|consent/i],
    ["GRAPH_NO_KEYCHAIN", /secure storage/i],
  ] as const)("offers a settings pointer, not a retry, for %s", async (code, remedyPattern) => {
    invoke.mockClear();
    renderState({ kind: "error", code });
    expect(screen.queryByTestId("calendar-proposal-retry")).toBeNull();
    const settingsButton = screen.getByTestId("calendar-proposal-open-settings");
    expect(screen.getByTestId("calendar-proposal-region")).toHaveTextContent(remedyPattern);

    await userEvent.click(settingsButton);
    expect(invoke).toHaveBeenCalledWith("open_dashboard");
  });

  // The three codes retrying genuinely fixes stay exactly as they were -
  // Important 3 narrows the OTHER six, not these.
  it.each(["GRAPH_NETWORK", "GRAPH_THROTTLED", "GRAPH_BAD_RESPONSE"] as const)(
    "keeps the retry control, with no settings pointer, for %s",
    (code) => {
      renderState({ kind: "error", code });
      expect(screen.getByTestId("calendar-proposal-retry")).toBeInTheDocument();
      expect(screen.queryByTestId("calendar-proposal-open-settings")).toBeNull();
    }
  );
});
