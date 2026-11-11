import { afterEach, describe, expect, it, vi } from "vitest";

// The default fetchAIResponse mock throws, so an ai built without an injected
// fake fetch impl fails loudly instead of sneaking a real request through.
const { fetchAIResponse } = vi.hoisted(() => ({
  fetchAIResponse: vi.fn(() => {
    throw new Error("unexpected fetchAIResponse call: inject a fake fetch impl");
  }),
}));
vi.mock("@/lib/functions/ai-response.function", () => ({ fetchAIResponse }));
vi.mock("@/lib/functions/meetwings.api", () => ({
  shouldUseMeetwingsAPI: vi.fn(async () => false),
}));
vi.mock("@/lib/storage/secure-provider-configs", () => ({
  loadSummaryProvider: vi.fn(async () => null),
}));
vi.mock("@/lib/database", () => ({}));
vi.mock("@/lib/storage", () => ({
  getUserIdentity: vi.fn(() => null),
  hasUserIdentity: vi.fn(() => false),
}));
vi.mock("@/lib/odoo/meeting-log", () => ({ renderTranscript: vi.fn(() => "") }));

import type { AIErrorInfo } from "@/lib/functions/ai-response.function";
import type { ResolvedSummaryProvider } from "@/lib/functions/summary-provider";
import { createNotionAi, type NotionAi } from "@/lib/notion/ai";
import { SummaryError } from "@/lib/notion/errors";
import {
  MIN_NOTION_LINES,
  NOTION_SUMMARY_PROMPT,
  NOTION_SUMMARY_TIMEOUT_MS,
  parseNotionSummary,
  summarizeForNotion,
} from "@/lib/notion/summarize";

// Fake secrets only - never a real token or Notion id.
const PROVIDER = {
  id: "test-provider",
  name: "Test provider",
  curl:
    'curl --request POST --url "https://provider.invalid/v1/chat" --data @- <<EOF\n{"model":"{{MODEL}}"}\nEOF',
  responseContentPath: "choices[0].message.content",
  streaming: true,
};
const CONFIG = {
  provider: PROVIDER,
  selectedProvider: {
    provider: "test-provider",
    variables: { MODEL: "test-model", API_KEY: "sk-or-v1-TESTKEY" },
  },
};

interface AskParams {
  provider: unknown;
  selectedProvider: unknown;
  systemPrompt?: string;
  userMessage: string;
  signal?: AbortSignal;
  onError?: (e: AIErrorInfo) => void;
  skipMeetwingsAPI?: boolean;
  rawSystemPrompt?: boolean;
}

/**
 * A fake fetch impl with the same shape as fetchAIResponse: an async generator
 * that records the params it receives, optionally reports one error through
 * onError first, then yields the given chunks.
 */
function fakeFetch(opts: {
  error?: AIErrorInfo;
  yields?: string[];
  throw?: unknown;
}) {
  const calls: AskParams[] = [];
  const fetchImpl = async function* (params: AskParams): AsyncGenerator<string> {
    calls.push(params);
    if (opts.throw !== undefined) throw opts.throw;
    if (opts.error) params.onError?.(opts.error);
    for (const y of opts.yields ?? []) yield y;
  };
  return { fetchImpl, calls };
}

function aiFor(
  r:
    | { kind: "none" }
    | { kind: "meetwings" }
    | { kind: "chat" | "override"; config: typeof CONFIG },
  fetchImpl: (params: AskParams) => AsyncGenerator<string>,
): NotionAi {
  return createNotionAi(r as ResolvedSummaryProvider, fetchImpl as never);
}

const LINES = ["alpha", "bravo", "charlie", "delta", "echo"];

/** The summary the fake model sends back for a happy-path run. */
const SUMMARY_JSON = JSON.stringify({
  title: "Weekly sync",
  action_items: ["Write the doc"],
  sections: [{ heading: "Launch", bullets: ["Ship on Friday"] }],
  practices: [{ rule: "Sync notes are written as bullets", topic: "Docs" }],
});

/** Awaits the run, and hands back the thrown value as an object for asserts. */
async function thrownBy(run: () => Promise<unknown>): Promise<{
  instance: boolean;
  code?: string;
  message?: string;
  stringForm?: string;
}> {
  try {
    await run();
    return { instance: false };
  } catch (thrown) {
    return {
      instance: thrown instanceof SummaryError,
      code: thrown instanceof SummaryError ? thrown.code : undefined,
      message: thrown instanceof Error ? thrown.message : undefined,
      stringForm: String(thrown),
    };
  }
}

const PROVIDER_TEXT = 'API request failed: 429 Too Many Requests - {"key":"sk-or-v1-KEY"}';

afterEach(() => {
  vi.useRealTimers();
});

describe("summarizeForNotion", () => {
  it(`fewer than ${MIN_NOTION_LINES} lines → SUMMARY_TOO_SHORT and no model call`, async () => {
    const { fetchImpl, calls } = fakeFetch({ yields: [SUMMARY_JSON] });
    const ai = aiFor({ kind: "chat", config: CONFIG }, fetchImpl);
    const outcome = await thrownBy(() => summarizeForNotion(["one", "two", "three"], ai));
    expect(outcome.instance).toBe(true);
    expect(outcome.code).toBe("SUMMARY_TOO_SHORT");
    expect(outcome.message).toBe("The meeting is too short to summarise.");
    expect(calls).toHaveLength(0);
  });

  it.each([
    [401, "SUMMARY_AUTH"],
    [402, "SUMMARY_SPENDING_LIMIT"],
    [403, "SUMMARY_AUTH"],
    [429, "SUMMARY_RATE_LIMITED"],
    [408, "SUMMARY_PROVIDER_DOWN"],
    [500, "SUMMARY_PROVIDER_DOWN"],
    [503, "SUMMARY_PROVIDER_DOWN"],
    [400, "SUMMARY_REJECTED"],
  ])(
    "http %i → %s, and the provider text is not in the message",
    async (status, expected) => {
      const { fetchImpl } = fakeFetch({
        error: { kind: "http", status },
        yields: [PROVIDER_TEXT],
      });
      const outcome = await thrownBy(() =>
        summarizeForNotion(LINES, aiFor({ kind: "chat", config: CONFIG }, fetchImpl)),
      );
      expect(outcome.instance).toBe(true);
      expect(outcome.code).toBe(expected);
      // The yielded error text is the provider's, never ours: it is discarded,
      // and the fixed copy carries none of it.
      expect(outcome.message).not.toContain("sk-or-v1-KEY");
      expect(outcome.message).not.toContain("Too Many Requests");
      expect(outcome.stringForm).not.toContain("sk-or-v1-KEY");
      expect(outcome.stringForm).not.toContain("Too Many Requests");
    },
  );

  it("network error → SUMMARY_NETWORK", async () => {
    const { fetchImpl } = fakeFetch({
      error: { kind: "network" },
      yields: ["Network error during API request: getaddrinfo failed"],
    });
    const outcome = await thrownBy(() =>
      summarizeForNotion(LINES, aiFor({ kind: "chat", config: CONFIG }, fetchImpl)),
    );
    expect(outcome.code).toBe("SUMMARY_NETWORK");
    expect(outcome.stringForm).not.toContain("getaddrinfo failed");
  });

  it("stream error → SUMMARY_UNREADABLE; meetwings error → SUMMARY_PROVIDER_DOWN", async () => {
    const streamCase = fakeFetch({
      error: { kind: "stream" },
      yields: ["API error: upstream exploded"],
    });
    expect(
      (await thrownBy(() =>
        summarizeForNotion(LINES, aiFor({ kind: "chat", config: CONFIG }, streamCase.fetchImpl)),
      )).code,
    ).toBe("SUMMARY_UNREADABLE");

    const meetwingsCase = fakeFetch({
      error: { kind: "meetwings" },
      yields: ["Meetwings API Error: down"],
    });
    expect(
      (await thrownBy(() =>
        summarizeForNotion(LINES, aiFor({ kind: "chat", config: CONFIG }, meetwingsCase.fetchImpl)),
      )).code,
    ).toBe("SUMMARY_PROVIDER_DOWN");
  });

  it("a generator that throws → SUMMARY_REJECTED (ask called directly)", async () => {
    const { fetchImpl } = fakeFetch({ throw: new Error("generator blew up") });
    const ai = aiFor({ kind: "chat", config: CONFIG }, fetchImpl);
    const outcome = await thrownBy(() =>
      ai.ask(
        NOTION_SUMMARY_PROMPT,
        "MEETING TRANSCRIPT:\n" + LINES.join("\n"),
        NOTION_SUMMARY_TIMEOUT_MS,
      ),
    );
    expect(outcome.code).toBe("SUMMARY_REJECTED");
  });

  it("a generator that throws after the timer fired → SUMMARY_TIMEOUT (ask called directly)", async () => {
    vi.useFakeTimers();
    const fetchImpl = async function* (): AsyncGenerator<string> {
      await new Promise<void>((resolve) =>
        setTimeout(resolve, NOTION_SUMMARY_TIMEOUT_MS),
      );
      throw new Error("threw once the timer had fired");
    };
    const ai = aiFor({ kind: "chat", config: CONFIG }, fetchImpl);
    const promise = ai.ask(
      NOTION_SUMMARY_PROMPT,
      "MEETING TRANSCRIPT:\n" + LINES.join("\n"),
      NOTION_SUMMARY_TIMEOUT_MS,
    );
    // Fires ask's timer first, then the generator's settle timer: the throw
    // lands after the timeout, and the timeout still wins.
    vi.advanceTimersByTime(NOTION_SUMMARY_TIMEOUT_MS + 1);
    await expect(promise).rejects.toMatchObject({ code: "SUMMARY_TIMEOUT" });
  });

  it("own timer firing → SUMMARY_TIMEOUT (abort makes fetchImpl return silently)", async () => {
    vi.useFakeTimers();
    const calls: AskParams[] = [];
    const fetchImpl = async function* (params: AskParams): AsyncGenerator<string> {
      calls.push(params);
      // Hangs until its own signal aborts, then returns without yielding:
      // the real fetchAIResponse returns silently on abort.
      await new Promise<void>((resolve) => {
        if (params.signal?.aborted) resolve();
        else params.signal?.addEventListener("abort", () => resolve());
      });
      return;
    };
    const ai = aiFor({ kind: "chat", config: CONFIG }, fetchImpl);
    const promise = summarizeForNotion(LINES, ai);
    vi.advanceTimersByTime(NOTION_SUMMARY_TIMEOUT_MS);
    await expect(promise).rejects.toMatchObject({ code: "SUMMARY_TIMEOUT" });
    expect(NOTION_SUMMARY_TIMEOUT_MS).toBe(120_000);
    expect(calls[0].signal?.aborted).toBe(true);
  });

  it("the timer firing wins over a fired onError → SUMMARY_TIMEOUT", async () => {
    vi.useFakeTimers();
    const fetchImpl = async function* (params: AskParams): AsyncGenerator<string> {
      // Reports once, then the provider goes away mid-stream and never
      // settles - not even when its own abort signal fires.
      params.onError?.({ kind: "http", status: 503 });
      await new Promise(() => {});
    };
    const ai = aiFor({ kind: "chat", config: CONFIG }, fetchImpl);
    const promise = summarizeForNotion(LINES, ai);
    vi.advanceTimersByTime(NOTION_SUMMARY_TIMEOUT_MS);
    await expect(promise).rejects.toMatchObject({ code: "SUMMARY_TIMEOUT" });
  });

  it("two onError calls → the first one's code wins", async () => {
    const fetchImpl = async function* (params: AskParams): AsyncGenerator<string> {
      params.onError?.({ kind: "http", status: 429 });
      params.onError?.({ kind: "network" });
      yield "the provider's error text";
    };
    const outcome = await thrownBy(() =>
      summarizeForNotion(LINES, aiFor({ kind: "chat", config: CONFIG }, fetchImpl)),
    );
    expect(outcome.code).toBe("SUMMARY_RATE_LIMITED");
  });

  it("after a successful ask no timer is left running", async () => {
    vi.useFakeTimers();
    const { fetchImpl } = fakeFetch({ yields: [SUMMARY_JSON] });
    await summarizeForNotion(LINES, aiFor({ kind: "chat", config: CONFIG }, fetchImpl));
    expect(vi.getTimerCount()).toBe(0);
  });

  it(`exactly ${MIN_NOTION_LINES} lines → the model is called; fewer → SUMMARY_TOO_SHORT`, async () => {
    const four = fakeFetch({ yields: [SUMMARY_JSON] });
    const parsed = await summarizeForNotion(
      ["one", "two", "three", "four"],
      aiFor({ kind: "chat", config: CONFIG }, four.fetchImpl),
    );
    expect(four.calls).toHaveLength(1);
    expect(parsed.title).toBe("Weekly sync");

    const three = fakeFetch({ yields: [SUMMARY_JSON] });
    const outcome = await thrownBy(() =>
      summarizeForNotion(["one", "two", "three"], aiFor({ kind: "chat", config: CONFIG }, three.fetchImpl)),
    );
    expect(outcome.code).toBe("SUMMARY_TOO_SHORT");
    expect(three.calls).toHaveLength(0);
  });

  it("summarizeForNotion calls ask with the 120_000 ms Notion timeout", async () => {
    const ask = vi.fn(() => Promise.resolve(SUMMARY_JSON));
    const fakeAi: NotionAi = { ask };
    const result = await summarizeForNotion(LINES, fakeAi);
    expect(result.title).toBe("Weekly sync");
    expect(ask).toHaveBeenCalledWith(
      NOTION_SUMMARY_PROMPT,
      "MEETING TRANSCRIPT:\n" + LINES.join("\n"),
      NOTION_SUMMARY_TIMEOUT_MS,
    );
    const [, , timeoutMs] = ask.mock.calls[0];
    expect(timeoutMs).toBe(120_000);
  });

  it("a plain Error thrown by a fake NotionAi propagates out of summarizeForNotion unchanged", async () => {
    const boom = new Error("boom");
    const fakeAi: NotionAi = { ask: vi.fn(() => Promise.reject(boom)) };
    let caught: unknown;
    try {
      await summarizeForNotion(LINES, fakeAi);
    } catch (thrown) {
      caught = thrown;
    }
    expect(caught).toBe(boom);
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(SummaryError);
    expect(caught).toMatchObject({ message: "boom" });
  });

  it("empty reply → SUMMARY_EMPTY; prose reply → SUMMARY_UNREADABLE", async () => {
    const empty = fakeFetch({ yields: ["  \n\t"] });
    const emptyOutcome = await thrownBy(() =>
      summarizeForNotion(LINES, aiFor({ kind: "chat", config: CONFIG }, empty.fetchImpl)),
    );
    expect(emptyOutcome.code).toBe("SUMMARY_EMPTY");

    const prose = fakeFetch({ yields: ["Here are your notes! Nothing structured here."] });
    const proseOutcome = await thrownBy(() =>
      summarizeForNotion(LINES, aiFor({ kind: "chat", config: CONFIG }, prose.fetchImpl)),
    );
    expect(proseOutcome.code).toBe("SUMMARY_UNREADABLE");
  });

  it("kind none → SUMMARY_NO_PROVIDER", async () => {
    const outcome = await thrownBy(() => summarizeForNotion(LINES, createNotionAi({ kind: "none" })));
    expect(outcome.code).toBe("SUMMARY_NO_PROVIDER");
    expect(fetchAIResponse).not.toHaveBeenCalled();
  });
});

describe("parseNotionSummary", () => {
  it("parses title, action items, sections and practices; caps lengths", () => {
    const big = {
      title: "  Big meeting  ",
      action_items: Array.from({ length: 25 }, (_, i) => `task ${i + 1}`),
      sections: Array.from(
        { length: 14 },
        () => ({ heading: "H", bullets: Array.from({ length: 10 }, (_, i) => `b${i}`) }),
      ),
      practices: Array.from({ length: 12 }, () => ({ rule: "r", topic: 42 })),
    };
    const parsed = parseNotionSummary(`Preamble${JSON.stringify(big)}trailing prose`);
    expect(parsed).toEqual({
      title: "Big meeting",
      actionItems: Array.from({ length: 20 }, (_, i) => `task ${i + 1}`),
      sections: Array.from({ length: 12 }, () => ({
        heading: "H",
        bullets: Array.from({ length: 8 }, (_, i) => `b${i}`),
      })),
      practices: Array.from({ length: 10 }, () => ({ rule: "r", topic: null })),
    });
  });

  it("trims strings, drops empty ones, and drops sections with no bullets or an empty heading", () => {
    const parsed = parseNotionSummary(
      JSON.stringify({
        title: "T",
        action_items: ["", "  do this  ", 7, null, "also do that"],
        sections: [
          { heading: "  ", bullets: ["x"] },
          { heading: "No bullets", bullets: [] },
          { heading: "All empty", bullets: ["", "   ", 5] },
          { heading: " Good heading ", bullets: [null, " kept bullet "] },
        ],
        practices: [{ rule: "  " }, { rule: "A rule", topic: "" }, { rule: "Another rule" }],
        unknown_key: "ignored",
      }),
    );
    expect(parsed).toEqual({
      title: "T",
      actionItems: ["do this", "also do that"],
      sections: [{ heading: "Good heading", bullets: ["kept bullet"] }],
      practices: [
        { rule: "A rule", topic: null },
        { rule: "Another rule", topic: null },
      ],
    });
  });

  it("missing arrays become [], a fenced or prose-wrapped reply still parses, and non-JSON returns null", () => {
    expect(parseNotionSummary(JSON.stringify({ title: "T" }))).toEqual({
      title: "T",
      actionItems: [],
      sections: [],
      practices: [],
    });
    const fenced = "```json\n" + SUMMARY_JSON + "\n```";
    expect(parseNotionSummary(fenced)).toEqual(parseNotionSummary(SUMMARY_JSON));
    expect(parseNotionSummary("no json at all")).toBeNull();
    expect(parseNotionSummary(JSON.stringify(["a", "list"]))).toBeNull();
    expect(parseNotionSummary(JSON.stringify({ title: "  " }))).toBeNull();
    expect(parseNotionSummary(JSON.stringify({ title: 5 }))).toBeNull();
  });
});

describe("createNotionAi wiring and the prompt", () => {
  it("passes rawSystemPrompt: true and skipMeetwingsAPI only for override, and returns the parsed summary", async () => {
    const chat = fakeFetch({ yields: [SUMMARY_JSON] });
    const result = await summarizeForNotion(
      LINES,
      aiFor({ kind: "chat", config: CONFIG }, chat.fetchImpl),
    );
    let p = chat.calls[0];
    expect(p.rawSystemPrompt).toBe(true);
    expect(p.skipMeetwingsAPI).toBe(false);
    expect(p.provider).toBe(PROVIDER);
    expect(p.selectedProvider).toBe(CONFIG.selectedProvider);
    expect(p.systemPrompt).toBe(NOTION_SUMMARY_PROMPT);
    expect(p.userMessage).toBe("MEETING TRANSCRIPT:\n" + LINES.join("\n"));
    expect(p.signal).toBeInstanceOf(AbortSignal);
    expect(result).toEqual({
      title: "Weekly sync",
      actionItems: ["Write the doc"],
      sections: [{ heading: "Launch", bullets: ["Ship on Friday"] }],
      practices: [{ rule: "Sync notes are written as bullets", topic: "Docs" }],
    });

    const override = fakeFetch({ yields: [SUMMARY_JSON] });
    await summarizeForNotion(LINES, aiFor({ kind: "override", config: CONFIG }, override.fetchImpl));
    p = override.calls[0];
    expect(p.rawSystemPrompt).toBe(true);
    expect(p.skipMeetwingsAPI).toBe(true);

    const meetwings = fakeFetch({ yields: [SUMMARY_JSON] });
    expect(
      (await summarizeForNotion(LINES, aiFor({ kind: "meetwings" }, meetwings.fetchImpl))).title,
    ).toBe("Weekly sync");
    p = meetwings.calls[0];
    expect(p.provider).toBeUndefined();
    expect(p.skipMeetwingsAPI).toBe(false);
    expect(p.rawSystemPrompt).toBe(true);
  });

  it("NOTION_SUMMARY_PROMPT carries the JSON-only contract, the practice definition and the rule wording", () => {
    expect(NOTION_SUMMARY_PROMPT).toContain(
      '{"title","action_items","sections":[{"heading","bullets"}],"practices":[{"rule","topic"}]}',
    );
    expect(NOTION_SUMMARY_PROMPT).toContain(
      "A team practice is a standing rule about how the team works that should apply to future work: how documents and reports are written, reviewed or published; which terms, methods or tools to use; standard checklists or steps. These are not practices: action items, status updates, plans, opinions, and one-off decisions about a specific deal, partner or person.",
    );
    expect(NOTION_SUMMARY_PROMPT).toContain("own words");
    expect(NOTION_SUMMARY_PROMPT).toContain("no people's names");
    expect(NOTION_SUMMARY_PROMPT).toContain("no fees");
    expect(NOTION_SUMMARY_PROMPT).toContain("no percentages");
    expect(NOTION_SUMMARY_PROMPT).toContain("no deal terms");
    expect(NOTION_SUMMARY_PROMPT).toContain(
      "a partner organisation only if the practice is about that organisation",
    );
    expect(NOTION_SUMMARY_PROMPT).toContain("order the topics came up");
    // The value types: plain strings everywhere, and topic a string or null.
    expect(NOTION_SUMMARY_PROMPT).toContain("is a plain string");
    expect(NOTION_SUMMARY_PROMPT).toContain('"topic" is a string, or null');
    // The transcript is data, and instructions spoken in it are ignored.
    const lower = NOTION_SUMMARY_PROMPT.toLowerCase();
    expect(lower).toContain("data");
    expect(lower).toContain("instructions");
    expect(lower).toContain("ignored");
  });
});
