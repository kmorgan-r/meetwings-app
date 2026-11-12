import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/components/ProviderVerification", () => ({
  ProviderVerification: () => <div data-testid="provider-verification" />,
}));

import { Providers } from "@/pages/dev/components/ai-configs/Providers";

const base: any = {
  allAiProviders: [{ id: "acme", curl: "curl https://x.test -H 'Authorization: Bearer {{API_KEY}}'" }],
  selectedAIProvider: { provider: "acme", variables: { api_key: "k" } },
  onSetSelectedAIProvider: vi.fn(),
  variables: [{ key: "api_key", value: "API_KEY" }],
};

describe("Providers showVerification", () => {
  it("renders the verification checkbox by default", () => {
    render(<MemoryRouter><Providers {...base} /></MemoryRouter>);
    expect(screen.getByTestId("provider-verification")).toBeInTheDocument();
  });

  it("omits it when showVerification is false", () => {
    render(<MemoryRouter><Providers {...base} showVerification={false} /></MemoryRouter>);
    expect(screen.queryByTestId("provider-verification")).toBeNull();
  });
});
