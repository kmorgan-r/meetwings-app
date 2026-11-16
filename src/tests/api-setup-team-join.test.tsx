import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const h = vi.hoisted(() => ({ state: null as unknown }));

vi.mock("@/hooks/useTeamState", () => ({
  useTeamState: () => [h.state, vi.fn()],
}));
vi.mock("@/hooks", () => ({
  useSettings: () => ({}),
  useSetupStatus: () => ({ isComplete: false, isLoading: false }),
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

  it("API Setup hides the team join box when joined", () => {
    h.state = { joined: true };
    render(<DevSpace />);
    expect(screen.queryByText("team-join-box")).toBeNull();
  });
});
