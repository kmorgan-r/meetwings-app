import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(async () => {}) }));
vi.mock("@/lib/functions", () => ({
  testAIProvider: vi.fn(),
  testSTTProvider: vi.fn(),
}));
vi.mock("@/lib/storage", () => ({
  setAIVerificationStatus: vi.fn(async () => {}),
  setSTTVerificationStatus: vi.fn(async () => {}),
  isAIVerificationValid: vi.fn(async () => false),
  isSTTVerificationValid: vi.fn(async () => false),
  clearAIVerificationStatus: vi.fn(async () => {}),
  clearSTTVerificationStatus: vi.fn(async () => {}),
}));

import { ProviderVerification } from "@/components/ProviderVerification";
import { testAIProvider, TestResult } from "@/lib/functions";
import { TYPE_PROVIDER } from "@/types";

const provider = {
  id: "openrouter",
  curl: "",
  responseContentPath: "choices[0].message.content",
  streaming: true,
} as unknown as TYPE_PROVIDER;

const selectedProvider = {
  provider: "openrouter",
  variables: { api_key: "sk-or-test", model: "thinkingmachines/inkling:free" },
};

async function verifyWith(result: TestResult) {
  vi.mocked(testAIProvider).mockResolvedValue(result);
  // Let the mount-time "already verified?" check settle before clicking, so
  // it can't reset the state after the click.
  await act(async () => {
    render(
      <ProviderVerification
        type="ai"
        provider={provider}
        selectedProvider={selectedProvider}
        isConfigured
      />
    );
  });
  fireEvent.click(screen.getByRole("checkbox"));
}

describe("ProviderVerification failure card", () => {
  afterEach(() => {
    cleanup();
    vi.mocked(testAIProvider).mockReset();
  });

  it("reports a 403 as access denied with the provider's reason, not a bad key", async () => {
    await verifyWith({
      success: false,
      message: "Access denied by provider",
      error: "HTTP 403: Blocked by guardrail",
    });

    expect(await screen.findByText("Access denied")).toBeInTheDocument();
    expect(screen.getByText(/Blocked by guardrail/)).toBeInTheDocument();
    expect(screen.queryByText("Invalid API key")).toBeNull();
  });

  it("shows the provider's reason when a 401 rejects the key", async () => {
    await verifyWith({
      success: false,
      message: "Authentication failed: Invalid API key",
      error: "HTTP 401: User not found.",
    });

    expect(await screen.findByText("Invalid API key")).toBeInTheDocument();
    expect(screen.getByText(/User not found\./)).toBeInTheDocument();
  });
});
