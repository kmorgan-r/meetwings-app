import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@/lib/functions/meetwings.api", () => ({
  shouldUseMeetwingsAPI: vi.fn(async () => false),
}));
vi.mock("@/lib/functions/context-builder", () => ({
  getContextForInjection: vi.fn(async () => ""),
}));
vi.mock("@/lib", () => ({
  getResponseSettings: () => ({ responseLength: "auto", language: "auto" }),
  RESPONSE_LENGTHS: [],
  LANGUAGES: [],
}));

import { fetchAIResponse } from "@/lib/functions/ai-response.function";
import { AI_PROVIDERS } from "@/config/ai-providers.constants";
import { TYPE_PROVIDER } from "@/types";

const openrouter = {
  ...AI_PROVIDERS.find((p) => p.id === "openrouter")!,
  name: "OpenRouter",
} as unknown as TYPE_PROVIDER;

const selectedProvider = {
  provider: "openrouter",
  variables: { api_key: "sk-or-test", model: "openrouter/free" },
};

/** A 200 SSE response that delivers each event as its own network chunk. */
function sseResponse(events: string[]): Response {
  const chunks = events.map((e) => new TextEncoder().encode(`data: ${e}\n\n`));
  let i = 0;
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    body: {
      getReader: () => ({
        read: async () =>
          i < chunks.length
            ? { done: false, value: chunks[i++] }
            : { done: true, value: undefined },
        cancel: async () => {},
      }),
    },
  } as unknown as Response;
}

async function collect(stream: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const chunk of stream) out.push(chunk);
  return out;
}

function run() {
  return collect(
    fetchAIResponse({
      provider: openrouter,
      selectedProvider,
      userMessage: "hi",
    })
  );
}

describe("fetchAIResponse streaming from OpenRouter", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("streams content and leaves reasoning deltas out of the answer", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sseResponse([
          '{"choices":[{"index":0,"delta":{"role":"assistant","content":"","reasoning":"thinking"}}]}',
          '{"choices":[{"index":0,"delta":{"content":"Hel"}}]}',
          '{"choices":[{"index":0,"delta":{"content":"lo"},"finish_reason":"stop"}]}',
          "[DONE]",
        ])
      )
    );

    expect((await run()).join("")).toBe("Hello");
  });

  it("surfaces an error event sent after the stream started", async () => {
    // OpenRouter keeps HTTP 200 and reports upstream failures as an SSE event.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sseResponse([
          '{"choices":[{"index":0,"delta":{"content":"Hel"}}]}',
          '{"error":{"code":502,"message":"Provider returned error"},"choices":[{"index":0,"delta":{"content":""},"finish_reason":"error"}]}',
          "[DONE]",
        ])
      )
    );

    const out = await run();

    expect(out[0]).toBe("Hel");
    expect(out.join("")).toContain("Provider returned error");
  });

  it("keeps streaming when a healthy chunk carries an empty error field", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sseResponse([
          '{"error":{},"choices":[{"index":0,"delta":{"content":"Hel"}}]}',
          '{"error":null,"choices":[{"index":0,"delta":{"content":"lo"},"finish_reason":"stop"}]}',
          "[DONE]",
        ])
      )
    );

    expect((await run()).join("")).toBe("Hello");
  });
});
