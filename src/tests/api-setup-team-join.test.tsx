import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const h = vi.hoisted(() => ({ state: null as unknown, sttConfigured: false }));

vi.mock("@/hooks/useTeamState", () => ({
  useTeamState: () => [h.state, vi.fn()],
}));
vi.mock("@/hooks", () => ({
  useSettings: () => ({}),
  useSetupStatus: () => ({ isComplete: false, isLoading: false, sttConfigured: h.sttConfigured }),
  useTeamState: () => [h.state, vi.fn()],
}));
vi.mock("@/pages/dev/components", () => ({
  AIProviders: () => null,
  STTProviders: () => null,
  MeetwingsApiSetup: () => null,
  SetupProgressHeader: () => null,
  AICustomProviders: () => null,
  STTCustomProviders: () => null,
}));
vi.mock("@/pages/dev/components/ai-configs/SummaryProviderCard", () => ({
  SummaryProviderCard: () => null,
}));
vi.mock("@/components/Contribute", () => ({ default: () => null }));
vi.mock("@/layouts", () => ({
  PageLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/components/TeamJoinBox", () => ({
  TeamJoinBox: () => <div>team-join-box</div>,
}));

import DevSpace from "@/pages/dev";

beforeEach(() => {
  h.state = null;
  h.sttConfigured = false;
});

describe("API Setup team join", () => {
  it.each([[null], [{ joined: false }]])(
    "API Setup shows the team join box when state is %j",
    (state) => {
      h.state = state;
      render(<DevSpace />);
      expect(screen.getByText("team-join-box")).toBeInTheDocument();
    }
  );

  it("points a joined colleague with no speech key at their own AssemblyAI key", () => {
    h.state = { joined: true };
    render(<DevSpace />);
    expect(screen.getByText(/Speech uses your own key/)).toBeInTheDocument();
    expect(screen.getByText(/Get API Key from AssemblyAI/)).toBeInTheDocument();
  });

  it.each([
    ["joined with a speech key", { joined: true }, true],
    ["not joined", { joined: false }, false],
  ])("shows no speech note when %s", (_n, state, sttConfigured) => {
    h.state = state;
    h.sttConfigured = sttConfigured;
    render(<DevSpace />);
    expect(screen.queryByText(/Speech uses your own key/)).toBeNull();
  });

  it("API Setup hides the team join box when joined", () => {
    h.state = { joined: true };
    render(<DevSpace />);
    expect(screen.queryByText("team-join-box")).toBeNull();
  });
});
