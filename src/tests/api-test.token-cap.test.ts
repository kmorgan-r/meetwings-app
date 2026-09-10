import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: vi.fn(),
}));

import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { testAIProvider } from "@/lib/functions/api-test.function";
import { AI_PROVIDERS } from "@/config/ai-providers.constants";
import { TYPE_PROVIDER } from "@/types";

const mockTauriFetch = vi.mocked(tauriFetch);

// The real built-in template, so the test exercises the same request shape
// the Verify button sends for OpenRouter.
const openrouter = {
  ...AI_PROVIDERS.find((p) => p.id === "openrouter")!,
  name: "OpenRouter",
} as unknown as TYPE_PROVIDER;

const selectedProvider = {
  provider: "openrouter",
  variables: { api_key: "sk-or-test", model: "openrouter/free" },
};

function jsonResponse(body: unknown): Response {
  return {
    status: 200,
    ok: true,
    statusText: "OK",
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

describe("testAIProvider with the 10-token verify cap", () => {
  beforeEach(() => {
    mockTauriFetch.mockReset();
  });

  it("verifies a reasoning model that spent the whole cap thinking", async () => {
    // Shape OpenRouter returns when the routed model reasons past max_tokens.
    mockTauriFetch.mockResolvedValueOnce(
      jsonResponse({
        model: "z-ai/glm-5.3-flash",
        choices: [
          {
            index: 0,
            finish_reason: "length",
            message: { role: "assistant", content: "", reasoning: "The user wants" },
          },
        ],
      })
    );

    const result = await testAIProvider(openrouter, selectedProvider);

    expect(result).toMatchObject({ success: true, message: "Connection verified" });
  });

  it("verifies when the truncated content is null", async () => {
    mockTauriFetch.mockResolvedValueOnce(
      jsonResponse({
        choices: [{ finish_reason: "length", message: { role: "assistant", content: null } }],
      })
    );

    const result = await testAIProvider(openrouter, selectedProvider);

    expect(result.success).toBe(true);
  });

  it("accepts a top-level MAX_TOKENS finish reason (Cohere v2 shape)", async () => {
    mockTauriFetch.mockResolvedValueOnce(
      jsonResponse({ finish_reason: "MAX_TOKENS", message: { content: [] } })
    );

    const result = await testAIProvider(openrouter, selectedProvider);

    expect(result.success).toBe(true);
  });

  it("still fails an empty completion that stopped normally", async () => {
    mockTauriFetch.mockResolvedValueOnce(
      jsonResponse({
        choices: [{ finish_reason: "stop", message: { role: "assistant", content: "" } }],
      })
    );

    const result = await testAIProvider(openrouter, selectedProvider);

    expect(result).toMatchObject({ success: false, message: "Response error: Empty response" });
  });

  it("still fails a 200 error body", async () => {
    mockTauriFetch.mockResolvedValueOnce(
      jsonResponse({ error: { code: 404, message: "No endpoints found" } })
    );

    const result = await testAIProvider(openrouter, selectedProvider);

    expect(result.success).toBe(false);
  });

  it("caps OpenAI with max_completion_tokens, which GPT-5 models require", async () => {
    mockTauriFetch.mockResolvedValueOnce(
      jsonResponse({ choices: [{ finish_reason: "stop", message: { content: "OK" } }] })
    );
    const openai = {
      ...AI_PROVIDERS.find((p) => p.id === "openai")!,
      name: "OpenAI",
    } as unknown as TYPE_PROVIDER;

    await testAIProvider(openai, {
      provider: "openai",
      variables: { api_key: "sk-test", model: "gpt-5.6-terra" },
    });

    const body = JSON.parse(mockTauriFetch.mock.calls[0][1]!.body as string);
    expect(body.max_completion_tokens).toBe(10);
    expect(body).not.toHaveProperty("max_tokens");
  });

  it("keeps max_tokens for other OpenAI-compatible endpoints", async () => {
    mockTauriFetch.mockResolvedValueOnce(
      jsonResponse({ choices: [{ finish_reason: "stop", message: { content: "OK" } }] })
    );

    await testAIProvider(openrouter, selectedProvider);

    const body = JSON.parse(mockTauriFetch.mock.calls[0][1]!.body as string);
    expect(body.max_tokens).toBe(10);
    expect(body).not.toHaveProperty("max_completion_tokens");
  });

  it("reads the text block that follows a Claude thinking block", async () => {
    mockTauriFetch.mockResolvedValueOnce(
      jsonResponse({
        stop_reason: "end_turn",
        content: [
          { type: "thinking", thinking: "", signature: "sig" },
          { type: "text", text: "OK" },
        ],
      })
    );
    const claude = {
      ...AI_PROVIDERS.find((p) => p.id === "claude")!,
      name: "Anthropic",
    } as unknown as TYPE_PROVIDER;

    const result = await testAIProvider(claude, {
      provider: "claude",
      variables: { api_key: "sk-ant-test", model: "claude-opus-5" },
    });

    expect(result.success).toBe(true);
  });
});
