import {
  fetchAIResponse,
  type AIErrorInfo,
} from "@/lib/functions/ai-response.function";
import type { ResolvedSummaryProvider } from "@/lib/functions/summary-provider";
import { SummaryError, type SummaryErrorCode } from "./errors";

/**
 * The one model call the Notion summary lane makes. It maps every way the call
 * can fail to a typed SummaryError whose message is always the fixed copy from
 * NOTION_COPY - the provider's error text and the transcript never reach it,
 * or any log.
 */
export interface NotionAi {
  ask(systemPrompt: string, userMessage: string, timeoutMs: number): Promise<string>;
}

/** Maps an onError report to its summary error code. */
function codeForError(info: AIErrorInfo): SummaryErrorCode {
  switch (info.kind) {
    case "http":
      if (info.status === 401 || info.status === 403) return "SUMMARY_AUTH";
      if (info.status === 402) return "SUMMARY_SPENDING_LIMIT";
      if (info.status === 429) return "SUMMARY_RATE_LIMITED";
      // 408 and 5xx are the provider struggling; every other 4xx is ours.
      if (info.status === 408 || info.status >= 500) return "SUMMARY_PROVIDER_DOWN";
      return "SUMMARY_REJECTED";
    case "network":
      return "SUMMARY_NETWORK";
    case "stream":
      return "SUMMARY_UNREADABLE";
    case "meetwings":
      return "SUMMARY_PROVIDER_DOWN";
  }
}

/**
 * Builds the summariser's model call.
 *
 * - `kind: "none"` → every ask throws SUMMARY_NO_PROVIDER.
 * - `rawSystemPrompt: true` always: no Context Memory, response-length or
 *   language prompt may wrap the summary instruction.
 * - `skipMeetwingsAPI` only for the "override" kind: the Meeting summaries
 *   provider must be used as chosen. The "meetwings" kind passes
 *   `provider: undefined` and lets the Meetwings API answer as usual.
 * - `ask` owns an AbortController timer: when it fires, the signal aborts and
 *   ask throws SUMMARY_TIMEOUT, whatever else happened.
 */
export function createNotionAi(
  r: ResolvedSummaryProvider,
  fetchImpl = fetchAIResponse,
): NotionAi {
  return {
    async ask(
      systemPrompt: string,
      userMessage: string,
      timeoutMs: number,
    ): Promise<string> {
      if (r.kind === "none") {
        throw new SummaryError("SUMMARY_NO_PROVIDER");
      }

      // The first onError report decides the failure; later ones are of the
      // same failed attempt. The chunks it yields after it are the provider's
      // error text and are discarded, never returned.
      const failed: { info: AIErrorInfo | null } = { info: null };

      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);

      let text = "";
      try {
        for await (const chunk of fetchImpl({
          provider: r.kind === "meetwings" ? undefined : r.config.provider,
          selectedProvider:
            r.kind === "meetwings"
              ? { provider: "meetwings", variables: {} }
              : r.config.selectedProvider,
          systemPrompt,
          userMessage,
          rawSystemPrompt: true,
          skipMeetwingsAPI: r.kind === "override",
          signal: controller.signal,
          onError: (e) => {
            if (failed.info === null) failed.info = e;
          },
        })) {
          text += chunk;
        }
      } catch {
        // The generator threw. The timeout keeps priority over everything else.
        if (timedOut) throw new SummaryError("SUMMARY_TIMEOUT");
        throw new SummaryError("SUMMARY_REJECTED");
      } finally {
        clearTimeout(timer);
      }

      if (timedOut) throw new SummaryError("SUMMARY_TIMEOUT");
      if (failed.info !== null) {
        throw new SummaryError(codeForError(failed.info));
      }
      const trimmed = text.trim();
      if (!trimmed) throw new SummaryError("SUMMARY_EMPTY");
      return trimmed;
    },
  };
}
