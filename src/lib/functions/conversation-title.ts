import { Message, TYPE_PROVIDER } from "@/types";
import { STORAGE_KEYS } from "@/config";
import { safeLocalStorage } from "@/lib/storage";
import { updateConversationTitle } from "@/lib/database";
import { fetchAIResponse } from "./ai-response.function";
import { extractJsonObject } from "./meeting-summarizer";
import { shouldUseMeetwingsAPI } from "./meetwings.api";

/** Longest title we will store. Beyond this the chats list just clips it. */
export const MAX_AI_TITLE_LENGTH = 60;

/**
 * Upper bound on the raw model output we will even look at. A well-behaved
 * response is a few dozen characters of JSON; anything far past that is the
 * model ignoring the format, and parsing it out is not worth the risk of
 * storing a paragraph as a title.
 */
const MAX_RAW_RESPONSE_LENGTH = 500;

/** How many messages from the start of the conversation to send. */
const MESSAGES_FOR_TITLE = 4;

/** How much of each message to send. Titles don't need the whole transcript. */
const MAX_MESSAGE_CHARS = 1000;

export interface TitleProviderConfig {
  provider: TYPE_PROVIDER | undefined;
  selectedProvider: {
    provider: string;
    variables: Record<string, string>;
  };
}

/**
 * JSON is requested rather than a bare line of text because fetchAIResponse
 * reports failures by *yielding* an error string ("Meetwings API Error: ...")
 * instead of throwing. A bare-text contract would happily store that error as
 * the conversation's title; requiring a JSON envelope makes every such
 * response fail to parse and fall through to the caller's existing fallback.
 */
const TITLE_PROMPT = `You name conversations. Read the excerpt and produce a short title describing what it is about.

Respond ONLY with a valid JSON object, no markdown and no code fences:
{"title": "Short descriptive title"}

Rules:
- 3 to 6 words, under ${MAX_AI_TITLE_LENGTH} characters
- Describe the subject matter, not the format ("Q3 Budget Review", not "A conversation about a budget")
- Title Case, no trailing punctuation, no surrounding quotes
- Use the conversation's own language
- If the excerpt is too short or empty to tell, use a plain topical guess rather than refusing`;

/**
 * Whether AI title generation is turned on. Defaults to enabled; the toggle
 * exists because each new conversation costs one extra (small) API call.
 */
export function isAITitleEnabled(): boolean {
  return safeLocalStorage.getItem(STORAGE_KEYS.AI_TITLES_ENABLED) !== "false";
}

/**
 * Turns a raw model response into a storable title, or null if it isn't one.
 */
export function parseGeneratedTitle(raw: string): string | null {
  if (!raw || raw.length > MAX_RAW_RESPONSE_LENGTH) {
    return null;
  }

  let title: unknown;
  try {
    title = JSON.parse(extractJsonObject(raw))?.title;
  } catch {
    return null;
  }

  if (typeof title !== "string") {
    return null;
  }

  const cleaned = title
    .replace(/\s+/g, " ")
    // Models like to wrap titles in quotes despite being told not to.
    .replace(/^["'“”‘’`]+|["'“”‘’`]+$/g, "")
    // ...and to prefix them with markdown heading or list syntax.
    .replace(/^[#*\-\s]+/, "")
    .replace(/[.,;:]+$/, "")
    .trim();

  if (!cleaned) {
    return null;
  }

  if (cleaned.length <= MAX_AI_TITLE_LENGTH) {
    return cleaned;
  }

  // Cut at the last word boundary that fits, so an over-long title ends on a
  // whole word instead of mid-syllable. Falls back to a hard cut when the
  // first word alone is longer than the budget.
  const clipped = cleaned.slice(0, MAX_AI_TITLE_LENGTH);
  const lastSpace = clipped.lastIndexOf(" ");
  return (lastSpace > 0 ? clipped.slice(0, lastSpace) : clipped).trim();
}

/**
 * Flattens a message's content to plain text. Message content is either a
 * string or an array of multimodal parts; only the text parts can contribute
 * to a title, and image parts are dropped rather than stringified.
 */
function messageText(content: Message["content"]): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part) => (typeof part?.text === "string" ? part.text : ""))
    .filter(Boolean)
    .join(" ");
}

/**
 * Builds the excerpt sent to the model: the opening messages of the
 * conversation, each truncated, which is enough to name it and keeps the call
 * cheap on a long meeting transcript.
 */
function formatExcerpt(messages: Message[]): string {
  return messages
    .slice(0, MESSAGES_FOR_TITLE)
    .map((msg) => {
      const role = msg.role === "user" ? "User" : "Assistant";
      const content = messageText(msg.content).slice(0, MAX_MESSAGE_CHARS);
      return `${role}: ${content}`;
    })
    .filter((line) => line.replace(/^(User|Assistant): /, "").trim())
    .join("\n\n");
}

/**
 * Asks the AI for a title for a conversation. Returns null whenever a title
 * can't be produced — no provider, request failed, unparseable response — so
 * callers keep whatever fallback title they already computed.
 */
export async function generateAIConversationTitle(
  messages: Message[],
  providerConfig?: TitleProviderConfig
): Promise<string | null> {
  const excerpt = formatExcerpt(messages).trim();
  if (!excerpt) {
    return null;
  }

  try {
    const useMeetwingsAPI = await shouldUseMeetwingsAPI();

    if (!useMeetwingsAPI && !providerConfig?.provider) {
      return null;
    }

    let raw = "";
    const controller = new AbortController();
    for await (const chunk of fetchAIResponse({
      provider: useMeetwingsAPI ? undefined : providerConfig?.provider,
      selectedProvider: providerConfig?.selectedProvider || {
        provider: "",
        variables: {},
      },
      systemPrompt: TITLE_PROMPT,
      history: [],
      userMessage: `CONVERSATION:\n${excerpt}\n\nProvide the JSON title:`,
      imagesBase64: [],
      signal: controller.signal,
    })) {
      raw += chunk;
      // Stop reading a response that has already blown past any plausible
      // title rather than buffering a whole runaway generation.
      //
      // Abort before breaking: leaving the loop tears the generator down with
      // .return(), which runs finally blocks only, and fetchAIResponse's
      // streaming branch has none — its reader.cancel() sits behind abort
      // checks that never get to run. Aborting cancels the fetch itself, which
      // is what actually releases the HTTP stream.
      if (raw.length > MAX_RAW_RESPONSE_LENGTH) {
        controller.abort();
        break;
      }
    }

    return parseGeneratedTitle(raw);
  } catch (error) {
    console.error("[AI Title] Failed to generate conversation title:", error);
    return null;
  }
}

/**
 * Conversations this session has already tried to title. Titling is a
 * one-shot per conversation: it runs right after the row is created, and every
 * later save preserves the stored title, so a second attempt would either be a
 * no-op or would rename a conversation out from under the user.
 */
const attempted = new Set<string>();

/**
 * Generates a title for a freshly created conversation and writes it to the
 * database, replacing the caller's fallback title. Fire-and-forget: it never
 * throws and never blocks the save path.
 *
 * Resolves to the stored title, or null if nothing was stored (disabled,
 * already attempted, generation failed, or the row is gone).
 */
export async function applyAIConversationTitle(
  conversationId: string,
  messages: Message[],
  providerConfig?: TitleProviderConfig
): Promise<string | null> {
  if (!conversationId || attempted.has(conversationId) || !isAITitleEnabled()) {
    return null;
  }
  // Claimed before the first await so concurrent callers — the save path and
  // the transcript autosave can both fire for the same new conversation —
  // can't each spend an API call on it.
  attempted.add(conversationId);

  try {
    const title = await generateAIConversationTitle(messages, providerConfig);
    if (!title) {
      return null;
    }

    const renamed = await updateConversationTitle(conversationId, title);
    if (!renamed) {
      return null;
    }

    // Lets in-memory holders of the old title (the chats list, the completion
    // hook's conversation metadata cache) catch up without re-reading the row.
    if (typeof window !== "undefined") {
      window.dispatchEvent(
        new CustomEvent("conversation-title-updated", {
          detail: { id: conversationId, title },
        })
      );
    }

    return title;
  } catch (error) {
    console.error("[AI Title] Failed to apply conversation title:", error);
    return null;
  }
}
