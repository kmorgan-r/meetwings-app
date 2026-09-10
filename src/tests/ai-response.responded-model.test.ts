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

function run(onModel: (model: string) => void, provider = openrouter) {
  return collect(
    fetchAIResponse({ provider, selectedProvider, userMessage: "hi", onModel })
  );
}

describe("fetchAIResponse reports the model that answered", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads it once from the stream", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sseResponse([
          '{"model":"upstage/solar-pro-3:free","choices":[{"index":0,"delta":{"role":"assistant","content":"Hel"}}]}',
          '{"model":"upstage/solar-pro-3:free","choices":[{"index":0,"delta":{"content":"lo"},"finish_reason":"stop"}]}',
          "[DONE]",
        ])
      )
    );
    const onModel = vi.fn();

    expect((await run(onModel)).join("")).toBe("Hello");
    expect(onModel).toHaveBeenCalledTimes(1);
    expect(onModel).toHaveBeenCalledWith("upstage/solar-pro-3:free");
  });

  it("reads it from a non-streaming response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          ({
            ok: true,
            status: 200,
            statusText: "OK",
            json: async () => ({
              model: "upstage/solar-pro-3:free",
              choices: [{ message: { content: "Hello" } }],
            }),
          }) as unknown as Response
      )
    );
    const onModel = vi.fn();

    const out = await run(onModel, { ...openrouter, streaming: false });

    expect(out.join("")).toBe("Hello");
    expect(onModel).toHaveBeenCalledWith("upstage/solar-pro-3:free");
  });

  it("reads it from an error event, so a failing pick is still named", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sseResponse([
          '{"model":"upstage/solar-pro-3:free","error":{"code":502,"message":"Provider returned error"},"choices":[{"index":0,"delta":{"content":""},"finish_reason":"error"}]}',
          "[DONE]",
        ])
      )
    );
    const onModel = vi.fn();

    expect((await run(onModel)).join("")).toContain("Provider returned error");
    expect(onModel).toHaveBeenCalledWith("upstage/solar-pro-3:free");
  });

  it("reports nothing when the provider sends no model field", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sseResponse([
          '{"choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":"stop"}]}',
          "[DONE]",
        ])
      )
    );
    const onModel = vi.fn();

    await run(onModel);

    expect(onModel).not.toHaveBeenCalled();
  });

  it("puts it on the usage event beside the requested model", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sseResponse([
          '{"model":"upstage/solar-pro-3:free","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}',
          "[DONE]",
        ])
      )
    );
    const details: unknown[] = [];
    const listener = (e: Event) => details.push((e as CustomEvent).detail);
    window.addEventListener("api-usage-captured", listener);

    try {
      await run(vi.fn());
    } finally {
      window.removeEventListener("api-usage-captured", listener);
    }

    expect(details).toEqual([
      expect.objectContaining({
        model: "openrouter/free",
        respondedModel: "upstage/solar-pro-3:free",
      }),
    ]);
  });
});
