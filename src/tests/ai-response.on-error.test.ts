import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { shouldUseMeetwingsAPI, getContextForInjection, listen } = vi.hoisted(() => ({
  shouldUseMeetwingsAPI: vi.fn(async () => false),
  getContextForInjection: vi.fn(async () => "MEMORY"),
  listen: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));
vi.mock("@/lib/functions/meetwings.api", () => ({ shouldUseMeetwingsAPI }));
vi.mock("@/lib/functions/context-builder", () => ({ getContextForInjection }));
vi.mock("@/lib", () => ({
  getResponseSettings: () => ({ responseLength: "auto", language: "auto" }),
  RESPONSE_LENGTHS: [],
  LANGUAGES: [],
}));

import { fetchAIResponse } from "@/lib/functions/ai-response.function";
import { AI_PROVIDERS } from "@/config/ai-providers.constants";
import type { TYPE_PROVIDER } from "@/types";

const openrouter = AI_PROVIDERS.find((p) => p.id === "openrouter") as unknown as TYPE_PROVIDER;
const selectedProvider = {
  provider: "openrouter",
  variables: { api_key: "sk-or-v1-TESTKEY", model: "openrouter/free" },
};

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

async function run(extra: Record<string, unknown> = {}) {
  const out: string[] = [];
  for await (const c of fetchAIResponse({
    provider: openrouter,
    selectedProvider,
    systemPrompt: "BASE PROMPT",
    userMessage: "hi",
    ...extra,
  })) {
    out.push(c);
  }
  return out;
}

beforeEach(() => {
  shouldUseMeetwingsAPI.mockResolvedValue(false);
  getContextForInjection.mockClear();
  listen.mockReset();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchAIResponse onError", () => {
  it.each([
    ["429", { status: 429, ok: false }, { kind: "http", status: 429 }],
    ["402", { status: 402, ok: false }, { kind: "http", status: 402 }],
  ])("reports HTTP %s before yielding the same error text as today", async (_n, res, info) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ...res, statusText: "Nope", text: async () => "body" }))
    );
    const order: string[] = [];
    const onError = vi.fn(() => order.push("onError"));
    const out: string[] = [];
    for await (const c of fetchAIResponse({
      provider: openrouter,
      selectedProvider,
      userMessage: "hi",
      onError,
    })) {
      order.push("yield");
      out.push(c);
    }
    expect(onError).toHaveBeenCalledWith(info);
    expect(order).toEqual(["onError", "yield"]);
    expect(out).toEqual([`API request failed: ${res.status} Nope - body`]);
  });

  it("reports a network failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("boom"); }));
    const onError = vi.fn();
    const out = await run({ onError });
    expect(onError).toHaveBeenCalledWith({ kind: "network" });
    expect(out).toEqual(["Network error during API request: boom"]);
  });

  it("reports an SSE error event as a stream error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => sseResponse(['{"error":{"message":"Provider returned error"}}']))
    );
    const onError = vi.fn();
    const out = await run({ onError });
    expect(onError).toHaveBeenCalledWith({ kind: "stream" });
    expect(out).toEqual(["API error: Provider returned error"]);
  });

  it("a throwing onError does not change what the caller sees", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("boom"); }));
    const out = await run({ onError: () => { throw new Error("cb"); } });
    expect(out).toEqual(["Network error during API request: boom"]);
  });

  it("reports a Meetwings API failure", async () => {
    shouldUseMeetwingsAPI.mockResolvedValue(true);
    listen.mockRejectedValue(new Error("down"));
    const onError = vi.fn();
    const out = await run({ onError });
    expect(onError).toHaveBeenCalledWith({ kind: "meetwings" });
    expect(out).toEqual(["Meetwings API Error: down"]);
  });
});

describe("fetchAIResponse options", () => {
  it("rawSystemPrompt sends the system prompt verbatim (no context memory)", async () => {
    const fetchMock = vi.fn(async () => sseResponse(["[DONE]"]));
    vi.stubGlobal("fetch", fetchMock);

    await run({ rawSystemPrompt: true });
    const rawBody = (fetchMock.mock.calls[0] as any)[1].body as string;
    expect(rawBody).toContain("BASE PROMPT");
    expect(rawBody).not.toContain("MEMORY");
    expect(getContextForInjection).not.toHaveBeenCalled();

    await run();
    expect((fetchMock.mock.calls[1] as any)[1].body).toContain("MEMORY");
  });

  it("skipMeetwingsAPI uses the given provider even when the Meetwings API is on", async () => {
    shouldUseMeetwingsAPI.mockResolvedValue(true);
    const fetchMock = vi.fn(async () => sseResponse(['{"choices":[{"delta":{"content":"ok"}}]}']));
    vi.stubGlobal("fetch", fetchMock);
    listen.mockClear();

    const out = await run({ skipMeetwingsAPI: true });
    expect(out.join("")).toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(listen).not.toHaveBeenCalled();
  });
});
