import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  load: vi.fn(),
  save: vi.fn(async (..._a: unknown[]) => {}),
}));
vi.mock("@/lib/storage/secure-provider-configs", () => ({
  loadSummaryProvider: h.load,
  saveSummaryProvider: h.save,
}));
vi.mock("@/contexts", () => ({
  useApp: () => ({
    allAiProviders: [
      { id: "acme", curl: "curl https://x.test -H 'Authorization: Bearer {{API_KEY}}'" },
      { id: "free", curl: "curl https://y.test" },
    ],
  }),
}));
// A stub with buttons that drive the card's change handler; it also shows the
// props the card passes down.
vi.mock("@/pages/dev/components/ai-configs/Providers", () => ({
  Providers: (p: any) => (
    <div>
      <span data-testid="show-verification">{String(p.showVerification)}</span>
      <button onClick={() => p.onSetSelectedAIProvider({ provider: "acme", variables: {} })}>
        pick-empty
      </button>
      <button
        onClick={() =>
          p.onSetSelectedAIProvider({ provider: "acme", variables: { api_key: "k-123" } })
        }
      >
        pick-filled
      </button>
    </div>
  ),
}));

import { SummaryProviderCard } from "@/pages/dev/components/ai-configs/SummaryProviderCard";

// Header calls useNavigate.
const renderCard = () =>
  render(
    <MemoryRouter>
      <SummaryProviderCard />
    </MemoryRouter>,
  );

beforeEach(() => {
  vi.clearAllMocks();
  h.load.mockResolvedValue(null);
  h.save.mockResolvedValue(undefined);
});

describe("SummaryProviderCard", () => {
  it("an unreadable setting shows the fixed line and Clear resets it", async () => {
    h.load.mockRejectedValue(new Error("SUMMARY_PROVIDER_UNREADABLE"));
    renderCard();
    expect(
      await screen.findByText("Can't read the saved meeting summaries setting. Press Clear to reset it."),
    ).toBeInTheDocument();
    const clear = screen.getByRole("button", { name: "Clear" });
    expect(clear).toBeEnabled();
    await userEvent.click(clear);
    expect(h.save).toHaveBeenCalledWith(null);
    await waitFor(() =>
      expect(screen.queryByText(/Can't read the saved meeting summaries setting/)).toBeNull(),
    );
  });

  it("a save failure shows the fixed line", async () => {
    h.save.mockRejectedValue(new Error("disk full"));
    const { container } = renderCard();
    await userEvent.click(screen.getByText("pick-filled"));
    expect(await screen.findByText("Couldn't save the meeting summaries setting.")).toBeInTheDocument();
    expect(container.textContent).not.toContain("disk full");
  });

  it("choosing a provider with an empty key saves nothing", async () => {
    renderCard();
    await userEvent.click(screen.getByText("pick-empty"));
    expect(screen.getByText("Fill in every field to use this provider for summaries.")).toBeInTheDocument();
    expect(h.save).not.toHaveBeenCalled();
    await userEvent.click(screen.getByText("pick-filled"));
    expect(h.save).toHaveBeenCalledWith({ provider: "acme", variables: { api_key: "k-123" } });
    expect(screen.queryByText("Fill in every field to use this provider for summaries.")).toBeNull();
  });

  it("asks Providers not to show the verification checkbox", async () => {
    renderCard();
    expect(screen.getByTestId("show-verification")).toHaveTextContent("false");
  });
});
