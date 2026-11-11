import { redactNotion } from "./redact";

/**
 * Error codes and the one fixed copy table for the Notion lane.
 *
 * NOTION_COPY is the ONLY source of user-visible Notion/summary copy. None of
 * its strings mention "Odoo": a Notion-only user must never see Odoo copy. The
 * messages NEVER carry a Notion response body, a provider reply or a token -
 * logs carry the codes, never content.
 */

export type NotionErrorCode =
  | "NOTION_NOT_CONFIGURED"
  | "NOTION_KEYCHAIN_UNAVAILABLE"
  | "NOTION_UNAUTHORIZED"
  | "NOTION_NO_ACCESS"
  | "NOTION_NOT_FOUND"
  | "NOTION_INVALID"
  | "NOTION_RATE_LIMITED"
  | "NOTION_SERVER"
  | "NOTION_NETWORK"
  | "NOTION_TIMEOUT"
  | "NOTION_PAGE_CHANGED"
  | "SAME_MEETING_UNDECIDED"
  | "PRACTICES_UNDECIDED"
  | "NOTION_INTERNAL";

// Category per code: "final" gives up outright, "retry, no strike" waits for
// the next tick, "strike" counts toward SUMMARY_STRIKES. Marked inline below.
export type SummaryErrorCode =
  | "SUMMARY_NO_PROVIDER"
  | "SUMMARY_TOO_SHORT" // final
  | "SUMMARY_NETWORK"
  | "SUMMARY_RATE_LIMITED"
  | "SUMMARY_SPENDING_LIMIT"
  | "SUMMARY_PROVIDER_DOWN"
  | "SUMMARY_AUTH" // retry, no strike
  | "SUMMARY_UNREADABLE"
  | "SUMMARY_EMPTY"
  | "SUMMARY_TIMEOUT"
  | "SUMMARY_REJECTED"; // strike

// Exact user-visible copy. The strings are verbatim from the plan's table.
export const NOTION_COPY: Record<
  NotionErrorCode | SummaryErrorCode | "SUMMARY_STRIKES_OUT",
  string
> = {
  NOTION_NOT_CONFIGURED:
    "Notion isn't set up. Finish it in Settings > Integrations > Notion.",
  NOTION_KEYCHAIN_UNAVAILABLE:
    "Meetwings can't use the system keychain for the Notion token. Press Retry; if it keeps failing, paste the token again in Settings > Integrations > Notion.",
  NOTION_UNAUTHORIZED:
    "Notion rejected your token. Paste a new one in Settings > Integrations > Notion.",
  NOTION_NO_ACCESS:
    "Notion refused access. Open the database in Notion and check you have edit access.",
  NOTION_NOT_FOUND:
    "Notion can't find the database. Check the link in Settings > Integrations > Notion.",
  NOTION_INVALID:
    "Notion refused the page. Press Check in Settings > Integrations > Notion.",
  NOTION_RATE_LIMITED: "Notion is busy. Trying again shortly.",
  NOTION_SERVER: "Notion is having problems. Trying again shortly.",
  NOTION_NETWORK: "Can't reach Notion. Trying again shortly.",
  NOTION_TIMEOUT: "Notion took too long. Trying again shortly.",
  NOTION_PAGE_CHANGED:
    "The Notion page was changed while it was being written. Check it, then press Retry, or Stop and keep page.",
  SAME_MEETING_UNDECIDED:
    "Checking whether a teammate already sent this meeting. Trying again shortly.",
  PRACTICES_UNDECIDED:
    "The AI couldn't check the practices against Team Knowledge. Trying again shortly.",
  NOTION_INTERNAL: "Something went wrong sending to Notion. Press Retry.",
  SUMMARY_NO_PROVIDER: "No AI provider is set up for meeting summaries.",
  SUMMARY_TOO_SHORT: "The meeting is too short to summarise.",
  SUMMARY_NETWORK: "Can't reach the AI provider.",
  SUMMARY_RATE_LIMITED: "The AI provider is busy.",
  SUMMARY_SPENDING_LIMIT: "The shared AI key has hit its spending limit.",
  SUMMARY_PROVIDER_DOWN: "The AI provider is having problems.",
  SUMMARY_AUTH: "The AI provider refused the key, or its limit was reached.",
  SUMMARY_UNREADABLE: "The AI reply couldn't be used.",
  SUMMARY_EMPTY: "The AI sent an empty reply.",
  SUMMARY_TIMEOUT: "The AI took too long.",
  SUMMARY_REJECTED: "The AI provider refused the request.",
  // Stored error_code only (three strikes spent); never thrown, never caught.
  SUMMARY_STRIKES_OUT: "The AI gave no usable summary three times.",
};

/** Giving up is the outcome; nothing to retry. */
export const SUMMARY_FINAL: ReadonlySet<SummaryErrorCode> = new Set([
  "SUMMARY_NO_PROVIDER",
  "SUMMARY_TOO_SHORT",
]);

/** Counts toward SUMMARY_STRIKES consecutive failures. */
export const SUMMARY_STRIKE: ReadonlySet<SummaryErrorCode> = new Set([
  "SUMMARY_UNREADABLE",
  "SUMMARY_EMPTY",
  "SUMMARY_TIMEOUT",
  "SUMMARY_REJECTED",
]);

/**
 * Shown the moment it happens and the send ends as 'failed' - no retry.
 * A bug (NOTION_INTERNAL, from an unknown thrown error) must never loop
 * silently in the background, so it fails loudly instead.
 */
export const NOTION_SHOW_AT_ONCE: ReadonlySet<NotionErrorCode> = new Set([
  "NOTION_UNAUTHORIZED",
  "NOTION_NO_ACCESS",
  "NOTION_NOT_FOUND",
  "NOTION_INVALID",
  "NOTION_NOT_CONFIGURED",
  "NOTION_KEYCHAIN_UNAVAILABLE",
  "NOTION_PAGE_CHANGED",
  "NOTION_INTERNAL",
]);

export class NotionError extends Error {
  readonly code: NotionErrorCode;
  readonly retryAfterMs?: number;
  constructor(code: NotionErrorCode, opts?: { retryAfterMs?: number }) {
    super(NOTION_COPY[code]);
    this.name = "NotionError";
    this.code = code;
    this.retryAfterMs = opts?.retryAfterMs;
  }
}

export class SummaryError extends Error {
  readonly code: SummaryErrorCode;
  constructor(code: SummaryErrorCode) {
    super(NOTION_COPY[code]);
    this.name = "SummaryError";
    this.code = code;
  }
}

/**
 * The single classifier for a caught throw on the Notion side: every catch in
 * the send steps and the buildSendDeps error path reads its status from this -
 * outcomeFor is the ONLY place a Notion-side code becomes a send status.
 */
export function outcomeFor(
  code: string,
  attempts: number,
  now: number,
  retryAfterMs?: number,
): { status: "retry" | "failed"; nextAt: number | null } {
  if (NOTION_SHOW_AT_ONCE.has(code as NotionErrorCode)) {
    return { status: "failed", nextAt: null };
  }
  // attempts is the send's attempt count AFTER the claim, so it is >= 1 in
  // normal use; clamping below 1 keeps 2^(attempts-1) at the 60_000 ms floor.
  const clamped = Math.max(1, attempts);
  const backoff = Math.min(60_000 * 2 ** (clamped - 1), 3_600_000);
  return {
    status: "retry",
    nextAt: now + Math.max(retryAfterMs ?? 0, backoff),
  };
}

/**
 * Maps a thrown value to the status's displayed code and text.
 *
 * NotionError / SummaryError carry the fixed copy by construction. Anything
 * else - unknown Error, a rejected string, a response body - becomes
 * NOTION_INTERNAL: unknown error text is never shown, and the ONE console.error
 * line logs it through redactNotion, which fails closed when unarmed.
 */
export function notionErrorText(thrown: unknown): {
  code: string;
  text: string;
} {
  if (thrown instanceof NotionError) {
    return { code: thrown.code, text: NOTION_COPY[thrown.code] };
  }
  if (thrown instanceof SummaryError) {
    return { code: thrown.code, text: NOTION_COPY[thrown.code] };
  }
  const message = thrown instanceof Error ? thrown.message : String(thrown);
  console.error(redactNotion(String(message)));
  return { code: "NOTION_INTERNAL", text: NOTION_COPY.NOTION_INTERNAL };
}
