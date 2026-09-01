import type { MeetingLogListRow, SummarizationResult, TranscriptEntry } from "@/types";
import { toOdooError } from "./errors";
import { getRedactor, isRedactorInitialised } from "./redactor";
import { speakerLabelFor } from "@/lib/functions/speaker-label.function";

/**
 * Pure helpers for the meeting log. No I/O, no mocks in its tests.
 *
 * Task 4 appends the rendering half (transcript text, note body, queueErrorText)
 * to this same file.
 */

/** How long the undo window holds a row before it is pushed. */
export const HOLD_MS = 30_000;

/**
 * How long the "already being sent" message stays up after a losing undo.
 *
 * It must expire: <Completion /> swaps the ContactPicker trigger out while the
 * strip is showing, so a permanent message locks the user out of choosing a
 * contact for the next meeting.
 */
export const UNDO_BLOCKED_MS = 6_000;

/**
 * How stale a `sending` claim must be before the sweep reclaims it.
 *
 * Generously larger than the client's 30s timeout (client.ts:21) plus a
 * plausible summarization round trip, because reclaiming a LIVE push is how
 * duplicate chatter notes get made.
 */
export const STALE_CLAIM_MS = 5 * 60 * 1000;

/**
 * Whether a `sending` row's claim has outlived STALE_CLAIM_MS as of `now`.
 *
 * Takes the clock rather than reading it, because the only caller that matters
 * is the queue page: QueueRow is memoised on its props, `Date.now()` is not one
 * of them, and a row reading the clock itself freezes its verdict at whatever
 * it read on its last DB-driven render. The page ticks and passes the answer
 * down. Named for the claim, not just "stale", because src/lib/index.ts star-
 * exports this module and ./database into one flat namespace.
 */
export function isClaimStale(
  row: Pick<MeetingLogListRow, "status" | "claimed_at">,
  now: number
): boolean {
  return (
    row.status === "sending" && row.claimed_at !== null && now - row.claimed_at > STALE_CLAIM_MS
  );
}

/** Above this, a `pending` row stops being "waiting" and starts being visible. */
export const ESCALATE_AFTER_ATTEMPTS = 5;

/**
 * How many Odoo records one meeting can be logged to.
 *
 * Enforced by REJECTING the write in odoo-contacts.action.ts's
 * addSelectedTarget - the user picks fewer targets instead. The enqueue and
 * retarget child inserts (meeting-log.action.ts, Tasks 6/7) cannot reject the
 * same way: an overflow there would throw out of `trigger`, whose catch calls
 * skipUnwritten() and advances the watermark, destroying the whole meeting.
 * Those paths cap to five and record the error on the row instead.
 */
export const MAX_TARGETS = 5;

/** How long a terminal row keeps its transcript text before retention blanks it. */
export const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * The bound on the AI summarization the queue page passes to `pushQueuedRow`.
 *
 * `fetchAIResponse` has no timeout and no abort, so an unbounded summarize is
 * the ONE way a dashboard push crosses STALE_CLAIM_MS - and crossing it lets
 * the main window's reclaim re-push a live row, producing two attachments and
 * two customer-visible chatter notes.
 *
 * The arithmetic this bound protects is NOT "summarize plus a fixed Odoo
 * budget" any more - it cannot be, because the Odoo half now scales with the
 * target count (up to MAX_TARGETS records per meeting) instead of being one
 * fixed cost. What actually keeps a live push from crossing STALE_CLAIM_MS is
 * pushQueuedRow re-stamping `claimed_at` after EVERY target it finishes, not
 * once for the whole row - so the budget that matters per claim window is one
 * target's worth of Odoo calls, not five targets'. On a RETRY pass
 * (attemptsBefore > 0) that is FOUR calls, not two - an attachment search
 * that finds nothing falls through to a create, and a message search that
 * finds nothing falls through to a post (client.ts:21, up to 30s each) - so
 * 120s of wire for the first target. `summary_json` can legitimately still be
 * null on a retry (a previous summarize failed), adding this 60s call ahead
 * of it: 180s total for the first claim window, comfortably under
 * STALE_CLAIM_MS (300s), with the re-stamp keeping every LATER target from
 * ever needing to borrow from that same budget. A timed-out summarize
 * resolves null, which pushQueuedRow already handles by taking the fallback
 * body: degrading a note is not comparable to duplicating one.
 */
export const SUMMARIZE_TIMEOUT_MS = 60_000;

/** `String.fromCharCode(...)` blows the argument limit on a big transcript. */
const BASE64_CHUNK = 0x8000;

export interface TranscriptSlice {
  entries: TranscriptEntry[];
  startAt: number;
  endAt: number;
}

/**
 * The entries belonging to THIS meeting.
 *
 * `meetingTranscript` is never cleared when a meeting ends -
 * `setMeetingTranscript([])` appears in exactly one place, `clearMeetingTranscript`
 * (useCompletion.ts:724). So two consecutive meetings live in one array and the
 * naive "first entry" key would make UNIQUE(session_key) dedup two DIFFERENT
 * meetings into one row - meeting 2 silently unlogged, meeting 1's transcript
 * spliced into its payload.
 *
 * The watermark is `MAX(transcript_end_at)` across the whole queue table -
 * global, with no conversation and no status predicate. See the action layer.
 *
 * Strictly `>`: an entry sharing a millisecond with the watermark is dropped.
 * That is deliberate. `>=` would re-consume the boundary entry on EVERY
 * meeting, and a meeting boundary is seconds wide, so the collision is
 * theoretical while the double-consume would be universal.
 */
export function sliceTranscript(
  entries: TranscriptEntry[],
  watermark: number
): TranscriptSlice | null {
  const kept = entries.filter((e) => e.timestamp > watermark);
  if (kept.length === 0) return null;
  // MIN/MAX, not [0] and [-1]: addMeetingTranscriptEntries appends
  // caller-supplied timestamps verbatim, so array order is not timestamp order.
  let startAt = kept[0].timestamp;
  let endAt = kept[0].timestamp;
  for (const e of kept) {
    if (e.timestamp < startAt) startAt = e.timestamp;
    if (e.timestamp > endAt) endAt = e.timestamp;
  }
  return { entries: kept, startAt, endAt };
}

/**
 * The conversation id is there for legibility, not uniqueness - the watermark
 * is what makes two meetings distinct. With no id the key is the bare
 * timestamp, NOT "null:1700", which would read as a real namespace.
 */
export function sessionKeyFor(conversationId: string | null, startAt: number): string {
  return conversationId ? `${conversationId}:${startAt}` : String(startAt);
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

/**
 * Deterministic and row-unique, and BOTH halves are load-bearing.
 *
 * Derived from `transcript_start_at` rather than Date.now() so a retry produces
 * the same name and `ir.attachment.search` can actually match it - otherwise
 * every retry creates a duplicate attachment. The row id is in the name because
 * minute granularity alone collides with a DIFFERENT meeting logged to the same
 * record in the same minute, and the search would adopt the wrong file.
 */
export function attachmentNameFor(rowId: string, startAt: number): string {
  const d = new Date(startAt);
  const stamp =
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` +
    `-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}`;
  return `transcript-${stamp}-${rowId}.md`;
}

/**
 * `btoa(text)` throws InvalidCharacterError on any non-Latin1 character -
 * routine for Norwegian, accented or emoji transcript text - and that throw
 * surfaces as a non-OdooError, i.e. ODOO_INTERNAL, i.e. permanently `failed`.
 * The repo has no existing helper; verification.storage.ts:68 is the only other
 * TextEncoder use.
 */
export function toBase64Utf8(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let i = 0; i < bytes.length; i += BASE64_CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + BASE64_CHUNK));
  }
  return btoa(binary);
}

/** How many transcript lines the fallback body shows when there is no summary. */
const FALLBACK_LINES = 8;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * The attachment's contents. NOT formatConversationForSummary
 * (meeting-summarizer.ts:96), which labels lines User/Assistant from msg.role -
 * meaningless when both sides are human.
 */
export function renderTranscript(entries: TranscriptEntry[]): string {
  return entries
    .map((e) => {
      const label = speakerLabelFor(e);
      return label ? `${label}: ${e.original}` : e.original;
    })
    .join("\n");
}

function section(heading: string, items: string[] | undefined): string {
  // Omitted ENTIRELY when empty - never <b>Decisions</b><ul></ul>.
  if (!items || items.length === 0) return "";
  const lis = items.map((i) => `<li>${escapeHtml(i)}</li>`).join("");
  return `<b>${heading}</b><ul>${lis}</ul>`;
}

/**
 * The chatter note.
 *
 * EVERY interpolated value is escaped, not just the transcript: title, summary
 * and every list item are AI-derived from the same untrusted transcript, and
 * message_post renders `body` as HTML.
 *
 * Every field is treated as optional. A partial SummarizationResult must not
 * raise a TypeError here - that would map to ODOO_INTERNAL and permanently fail
 * a row, which is precisely the trade "a summary failure is not a push failure"
 * refuses.
 */
export function buildNoteBody(
  summary: SummarizationResult | null,
  slice: TranscriptSlice,
  meetingStartedAt: number
): string {
  const when = escapeHtml(new Date(meetingStartedAt).toLocaleString());

  if (!summary || !summary.summary) {
    const head = slice.entries.slice(0, FALLBACK_LINES);
    const lines = escapeHtml(renderTranscript(head)).replace(/\n/g, "<br>");
    return (
      `<b>Meeting transcript</b> &mdash; ${when}` +
      `<p>Summarization failed, so the transcript's first lines are shown instead. ` +
      `The full transcript is attached.</p><p>${lines}</p>`
    );
  }

  const title = escapeHtml(summary.title || "Meeting");
  return (
    `<b>${title}</b> &mdash; ${when}` +
    `<p>${escapeHtml(summary.summary)}</p>` +
    section("Decisions", summary.decisions) +
    section("Action items", summary.actionItems) +
    section("Next steps", summary.nextSteps)
  );
}

/**
 * The ONE producer of the persisted `last_error`. Nothing else writes that
 * column.
 *
 * `details.detail` is included deliberately: for a plain Error, toOdooError
 * (errors.ts:49-53) sets .message to the fixed string "Something failed outside
 * Odoo" and puts the original text in details.detail - so a message-only helper
 * stores a constant and drops both the useful text and the secret that needed
 * redacting.
 *
 * When the redactor is unarmed we store the CODE ALONE. setOdooRedactor sits at
 * odoo-config.storage.ts:87 and is reached only on the `incomplete` and
 * `complete` returns - the `absent` return (:65) and both throw paths (:63,
 * :71) exit before it, and requireOdooConfig constructs ODOO_NOT_CONFIGURED
 * (:114-116) with nothing armed. Storing a bare "[REDACTED]" there would be
 * information-free and indistinguishable from successful redaction.
 *
 * AI-provider errors never reach this function: summarization has its own
 * try/catch in the push module. The redactor holds [apiKey, login] only, so it
 * has no needle for an AI key.
 */
export function queueErrorText(thrown: unknown): { code: string; text: string } {
  const err = toOdooError(thrown);
  if (!isRedactorInitialised()) return { code: err.code, text: err.code };
  const redact = getRedactor();
  const detail = typeof err.details.detail === "string" ? err.details.detail : "";
  const message = detail ? `${err.message} - ${detail}` : err.message;
  return { code: err.code, text: `${err.code}: ${redact(message)}` };
}

/** Which section of the queue page a row belongs to, or null for none. */
export type QueueGroup =
  | "needs-attention"
  | "unassigned"
  | "waiting"
  | "other-database"
  | null;

/**
 * The page's grouping. Mirrors QUEUE_SQL.counts with two DELIBERATE
 * divergences, both recorded in the spec: current-instance `sending` rows are
 * shown (in waiting) rather than omitted, and other-instance `failed` rows are
 * shown (in other-database) rather than matching no arm at all - under the
 * counts SQL such a row is invisible, unsendable, undeletable and never pruned.
 *
 * INSTANCE IS TESTED FIRST. A status-first implementation puts an
 * other-instance `failed` row in needs-attention, where the page offers a Retry
 * that `pushQueuedRow` refuses at its instance check - a button that does
 * nothing at all and looks broken.
 *
 * `failedTargets` is OPTIONAL, defaulting to 0, and carried on the row object
 * rather than a third positional parameter - every existing caller already
 * passes a row, so widening it here needs no call-site change. Nothing
 * computes a real value for it yet; the callers that derive it from
 * `row.targets` are Tasks 13 and 14.
 */
export function groupOf(
  row: Pick<MeetingLogListRow, "instance" | "status" | "attempts"> & {
    failedTargets?: number;
  },
  instance: string
): QueueGroup {
  if (row.instance !== instance) {
    return row.status === "held" ||
      row.status === "pending" ||
      row.status === "sending" ||
      row.status === "unassigned" ||
      row.status === "failed"
      ? "other-database"
      : null;
  }
  // A row derives `pending` under deriveRowStatus's rule 1 whenever ANY
  // target is still retryable, even with a terminally failed sibling on the
  // same row - so this check runs BEFORE the status switch below and wins
  // over whatever the parent status says. Without it such a row is filed
  // under "waiting", where a "1 of 3 failed" summary would sit beside a
  // "Waiting to be sent" line for the same meeting.
  if ((row.failedTargets ?? 0) > 0) return "needs-attention";
  if (row.status === "failed") return "needs-attention";
  if (row.status === "pending" && row.attempts >= ESCALATE_AFTER_ATTEMPTS) {
    return "needs-attention";
  }
  if (row.status === "unassigned") return "unassigned";
  if (row.status === "held" || row.status === "pending" || row.status === "sending") {
    return "waiting";
  }
  return null;
}

/**
 * Worst-status-wins ranking for the meetings page's per-conversation badge.
 *
 * `cancelled` and `deleted` are absent DELIBERATELY: both are meetings the
 * user deliberately removed, and resurfacing either as state would resurrect
 * a decision they already made. They fall out of `resolveBadge` by
 * construction - never matching `BADGE_RANK` - rather than by a special case.
 */
const BADGE_RANK = ["failed", "unassigned", "sending", "pending", "held", "sent"] as const;

/**
 * Resolves the rows for ONE conversation into a single badge, or null.
 *
 * Mirrors groupOf's instance-first split: a `currentInstance` row is eligible
 * whenever its status is a badge-worthy one, but an OTHER-instance row is
 * eligible only when `sent` - that history is worth showing, but every other
 * other-instance status belongs to the other-database group, where
 * pushQueuedRow's instance check would refuse the very action a badge implies
 * is available.
 */
export function resolveBadge(
  rows: ReadonlyArray<{ status: string; instance: string }>,
  currentInstance: string
): { status: (typeof BADGE_RANK)[number]; count: number } | null {
  const eligible = rows.filter((r) =>
    r.instance === currentInstance
      ? (BADGE_RANK as readonly string[]).includes(r.status)
      : r.status === "sent"
  );
  if (eligible.length === 0) return null;

  const worst = BADGE_RANK.find((s) => eligible.some((r) => r.status === s));
  return worst ? { status: worst, count: eligible.length } : null;
}

/** Pure so retention is testable without a clock. */
export function pruneCutoff(now: number): number {
  return now - RETENTION_MS;
}
