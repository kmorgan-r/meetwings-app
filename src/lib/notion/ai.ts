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
 *   ask throws SUMMARY_TIMEOUT, whatever else happened - the timer also races
 *   every chunk read, so the timeout holds even when fetchImpl ignores the
 *   signal and never settles.
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
      // On the Meetwings path fetchImpl may ignore the abort signal and block
      // forever, so the timer ALSO rejects this promise: every it.next() races
      // against it, and the timeout holds even when the generator never
      // settles.
      let rejectAborted: (e: SummaryError) => void = () => {};
      const aborted: Promise<never> = new Promise((_, reject) => {
        rejectAborted = reject;
      });
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        rejectAborted(new SummaryError("SUMMARY_TIMEOUT"));
      }, timeoutMs);

      let text = "";
      try {
        const gen = fetchImpl({
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
        });
        const it = gen[Symbol.asyncIterator]();
        try {
          for (;;) {
            const next = await Promise.race([it.next(), aborted]);
            if (next.done) break;
            text += next.value;
          }
        } catch {
          // The generator threw or the timer fired. The timeout keeps priority
          // over everything else: it wins over a fired onError, a mid-stream
          // throw and a hung generator alike.
          if (timedOut) {
            // The generator may be hung; request its cleanup without awaiting,
            // because it.return may never settle.
            void it.return?.(undefined);
            throw new SummaryError("SUMMARY_TIMEOUT");
          }
          throw new SummaryError("SUMMARY_REJECTED");
        }
        // The timer may have fired while the last chunk was still settling.
        if (timedOut) {
          void it.return?.(undefined);
          throw new SummaryError("SUMMARY_TIMEOUT");
        }
        if (failed.info !== null) {
          throw new SummaryError(codeForError(failed.info));
        }
        const trimmed = text.trim();
        if (!trimmed) throw new SummaryError("SUMMARY_EMPTY");
        return trimmed;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
