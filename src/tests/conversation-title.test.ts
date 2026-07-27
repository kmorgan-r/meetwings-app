import { beforeEach, describe, expect, it, vi } from "vitest";

const mockFetchAIResponse = vi.fn();
const mockShouldUseMeetwingsAPI = vi.fn();
const mockUpdateConversationTitle = vi.fn();
const mockGetItem = vi.fn();

vi.mock("@/lib/functions/ai-response.function", () => ({
  fetchAIResponse: (...args: unknown[]) => mockFetchAIResponse(...args),
}));

vi.mock("@/lib/functions/meetwings.api", () => ({
  shouldUseMeetwingsAPI: () => mockShouldUseMeetwingsAPI(),
}));

vi.mock("@/lib/database", () => ({
  updateConversationTitle: (...args: unknown[]) =>
    mockUpdateConversationTitle(...args),
}));

vi.mock("@/lib/storage", () => ({
  safeLocalStorage: {
    getItem: (...args: unknown[]) => mockGetItem(...args),
    setItem: vi.fn(),
    removeItem: vi.fn(),
  },
}));

import {
  applyAIConversationTitle,
  generateAIConversationTitle,
  isAITitleEnabled,
  MAX_AI_TITLE_LENGTH,
  parseGeneratedTitle,
} from "@/lib/functions/conversation-title";
import { Message } from "@/types";

const MESSAGES: Message[] = [
  { role: "user", content: "how do I rotate the signing key without downtime" },
  { role: "assistant", content: "Publish the new key first, then cut over." },
];

/** Makes fetchAIResponse yield `chunks` like a streaming provider would. */
function respondWith(...chunks: string[]) {
  mockFetchAIResponse.mockImplementation(async function* () {
    for (const chunk of chunks) {
      yield chunk;
    }
  });
}

let nextId = 0;
/**
 * applyAIConversationTitle only ever attempts a given conversation once per
 * process, so each test needs its own id rather than a shared constant.
 */
function freshConversationId(): string {
  nextId += 1;
  return `conversation-${nextId}`;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockShouldUseMeetwingsAPI.mockResolvedValue(true);
  mockUpdateConversationTitle.mockResolvedValue(true);
  mockGetItem.mockReturnValue(null);
  respondWith('{"title": "Signing Key Rotation"}');
});

describe("parseGeneratedTitle", () => {
  it("reads the title out of a plain JSON response", () => {
    expect(parseGeneratedTitle('{"title": "Signing Key Rotation"}')).toBe(
      "Signing Key Rotation"
    );
  });

  it("reads the title out of a fenced JSON response", () => {
    expect(
      parseGeneratedTitle('```json\n{"title": "Q3 Budget Review"}\n```')
    ).toBe("Q3 Budget Review");
  });

  it.each([
    ['{"title": "\\"Quoted Title\\""}', "Quoted Title"],
    ['{"title": "## Heading Title"}', "Heading Title"],
    ['{"title": "Trailing Period."}', "Trailing Period"],
    ['{"title": "  Padded   Title  "}', "Padded Title"],
  ])("strips model formatting tics from %s", (raw, expected) => {
    expect(parseGeneratedTitle(raw)).toBe(expected);
  });

  it("truncates an over-long title on a word boundary", () => {
    const long = "Rotating The Production Signing Key Without Any Downtime At All";
    const title = parseGeneratedTitle(JSON.stringify({ title: long }));

    expect(title).not.toBeNull();
    expect(title!.length).toBeLessThanOrEqual(MAX_AI_TITLE_LENGTH);
    // A word-boundary cut, not a cut through the middle of a word.
    expect(long.split(" ")).toContain(title!.split(" ").pop());
  });

  it.each([
    // fetchAIResponse reports failures by yielding a string rather than
    // throwing, so these are what a failed call actually looks like.
    "Meetwings API Error: 401 Unauthorized",
    "Streaming not supported or response body missing",
    "Failed to parse non-streaming response: Unexpected token",
    // Malformed or empty model output.
    '{"title": ""}',
    '{"title": 42}',
    "{}",
    "",
  ])("rejects %s", (raw) => {
    expect(parseGeneratedTitle(raw)).toBeNull();
  });

  it("rejects a response that is far too long to be a title", () => {
    const rambling = JSON.stringify({ title: "x".repeat(600) });
    expect(parseGeneratedTitle(rambling)).toBeNull();
  });
});

describe("isAITitleEnabled", () => {
  it("defaults to enabled when nothing is stored", () => {
    mockGetItem.mockReturnValue(null);
    expect(isAITitleEnabled()).toBe(true);
  });

  it('is disabled only by an explicit "false"', () => {
    mockGetItem.mockReturnValue("false");
    expect(isAITitleEnabled()).toBe(false);
  });
});

describe("generateAIConversationTitle", () => {
  it("returns the title from a streamed response", async () => {
    respondWith('{"title": ', '"Signing Key ', 'Rotation"}');

    await expect(generateAIConversationTitle(MESSAGES)).resolves.toBe(
      "Signing Key Rotation"
    );
  });

  it("does not call the AI when there is no provider and no Meetwings API", async () => {
    mockShouldUseMeetwingsAPI.mockResolvedValue(false);

    await expect(generateAIConversationTitle(MESSAGES)).resolves.toBeNull();
    expect(mockFetchAIResponse).not.toHaveBeenCalled();
  });

  it("does not call the AI for a conversation with no text", async () => {
    await expect(
      generateAIConversationTitle([{ role: "user", content: "   " }])
    ).resolves.toBeNull();
    expect(mockFetchAIResponse).not.toHaveBeenCalled();
  });

  it("flattens multimodal content instead of stringifying it", async () => {
    await generateAIConversationTitle([
      {
        role: "user",
        content: [
          { type: "text", text: "what is in this screenshot" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } },
        ],
      },
    ]);

    const { userMessage } = mockFetchAIResponse.mock.calls[0][0];
    expect(userMessage).toContain("what is in this screenshot");
    expect(userMessage).not.toContain("[object Object]");
    expect(userMessage).not.toContain("base64");
  });

  it("returns null when the request throws", async () => {
    mockFetchAIResponse.mockImplementation(async function* () {
      throw new Error("network down");
      // eslint-disable-next-line no-unreachable
      yield "";
    });

    await expect(generateAIConversationTitle(MESSAGES)).resolves.toBeNull();
  });
});

describe("applyAIConversationTitle", () => {
  it("stores the generated title and announces it", async () => {
    const id = freshConversationId();
    const events: CustomEvent[] = [];
    const listener = (event: Event) => events.push(event as CustomEvent);
    window.addEventListener("conversation-title-updated", listener);

    try {
      await expect(applyAIConversationTitle(id, MESSAGES)).resolves.toBe(
        "Signing Key Rotation"
      );
    } finally {
      window.removeEventListener("conversation-title-updated", listener);
    }

    expect(mockUpdateConversationTitle).toHaveBeenCalledWith(
      id,
      "Signing Key Rotation"
    );
    expect(events).toHaveLength(1);
    expect(events[0].detail).toEqual({ id, title: "Signing Key Rotation" });
  });

  it("attempts a given conversation only once", async () => {
    const id = freshConversationId();

    await applyAIConversationTitle(id, MESSAGES);
    await expect(applyAIConversationTitle(id, MESSAGES)).resolves.toBeNull();

    expect(mockFetchAIResponse).toHaveBeenCalledTimes(1);
    expect(mockUpdateConversationTitle).toHaveBeenCalledTimes(1);
  });

  it("spends only one request when two callers race the same conversation", async () => {
    const id = freshConversationId();

    await Promise.all([
      applyAIConversationTitle(id, MESSAGES),
      applyAIConversationTitle(id, MESSAGES),
    ]);

    expect(mockFetchAIResponse).toHaveBeenCalledTimes(1);
  });

  it("does nothing when the feature is disabled", async () => {
    mockGetItem.mockReturnValue("false");

    await expect(
      applyAIConversationTitle(freshConversationId(), MESSAGES)
    ).resolves.toBeNull();
    expect(mockFetchAIResponse).not.toHaveBeenCalled();
    expect(mockUpdateConversationTitle).not.toHaveBeenCalled();
  });

  it("leaves the fallback title in place when generation fails", async () => {
    respondWith("Meetwings API Error: 401 Unauthorized");

    await expect(
      applyAIConversationTitle(freshConversationId(), MESSAGES)
    ).resolves.toBeNull();
    expect(mockUpdateConversationTitle).not.toHaveBeenCalled();
  });

  it("does not announce a title when the row is gone", async () => {
    mockUpdateConversationTitle.mockResolvedValue(false);
    const events: Event[] = [];
    const listener = (event: Event) => events.push(event);
    window.addEventListener("conversation-title-updated", listener);

    try {
      await expect(
        applyAIConversationTitle(freshConversationId(), MESSAGES)
      ).resolves.toBeNull();
    } finally {
      window.removeEventListener("conversation-title-updated", listener);
    }

    expect(events).toHaveLength(0);
  });

  it("does not reject when the database write throws", async () => {
    mockUpdateConversationTitle.mockRejectedValue(new Error("database is locked"));

    await expect(
      applyAIConversationTitle(freshConversationId(), MESSAGES)
    ).resolves.toBeNull();
  });
});
