import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { TeamUiState } from "@/lib/team/team-controller";

const h = vi.hoisted(() => ({
  state: null as unknown,
  send: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@/hooks/useTeamState", () => ({
  useTeamState: () => [h.state, h.send],
}));
vi.mock("sonner", () => ({ toast: { error: h.toastError } }));

import { TeamJoinPrompt } from "@/components/TeamJoinPrompt";
import { TEAM_COPY } from "@/lib/team/team-file";

const base = (over: Partial<TeamUiState> = {}): TeamUiState => ({
  joined: false,
  pending: null,
  busy: false,
  error: null,
  errorSeq: 0,
  check: null,
  googleNeedsConnect: false,
  ...over,
});
const pending = (switching = false) => ({
  gistShort: "abc123",
  owner: "octo-owner",
  switching,
});

beforeEach(() => {
  h.state = base();
  h.send.mockReset();
  h.toastError.mockReset();
});

describe("TeamJoinPrompt", () => {
  it("is closed without a pending join", () => {
    render(<TeamJoinPrompt />);
    expect(screen.queryByText("Use your team's settings?")).toBeNull();
  });

  it("opens on a pending state and sends confirm / decline", async () => {
    h.state = base({ pending: pending() });
    render(<TeamJoinPrompt />);
    expect(screen.getByText("Use your team's settings?")).toBeInTheDocument();
    expect(screen.getByText(/team file abc123…/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Use team settings" }));
    expect(h.send).toHaveBeenCalledWith({ type: "confirm" });
    await userEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(h.send).toHaveBeenCalledWith({ type: "decline" });
  });

  it("names the gist owner", () => {
    h.state = base({ pending: pending() });
    render(<TeamJoinPrompt />);
    expect(screen.getByText("Shared by GitHub user octo-owner")).toBeInTheDocument();
    expect(screen.getByText(/Only accept if you know this GitHub user/)).toBeInTheDocument();
  });

  it("mentions leaving the current team when switching", () => {
    h.state = base({ pending: pending(false) });
    const { rerender } = render(<TeamJoinPrompt />);
    expect(screen.queryByText(/leave your current team settings/)).toBeNull();
    h.state = base({ pending: pending(true) });
    rerender(<TeamJoinPrompt />);
    expect(screen.getByText(/You'll leave your current team settings\./)).toBeInTheDocument();
  });

  it("toasts the fixed copy when an error arrives", () => {
    h.state = base({ error: "TEAM_LINK_INVALID", errorSeq: 1 });
    render(<TeamJoinPrompt />);
    expect(h.toastError).toHaveBeenCalledTimes(1);
    expect(h.toastError).toHaveBeenCalledWith(TEAM_COPY.TEAM_LINK_INVALID);
  });

  it("toasts again when the same error arrives with a new errorSeq, and not on a re-render with the same errorSeq", () => {
    h.state = base({ error: "TEAM_LINK_INVALID", errorSeq: 1 });
    const { rerender } = render(<TeamJoinPrompt />);
    rerender(<TeamJoinPrompt />);
    expect(h.toastError).toHaveBeenCalledTimes(1);
    h.state = base({ error: "TEAM_LINK_INVALID", errorSeq: 2 });
    act(() => rerender(<TeamJoinPrompt />));
    expect(h.toastError).toHaveBeenCalledTimes(2);
  });
});
