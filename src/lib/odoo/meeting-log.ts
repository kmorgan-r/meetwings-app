import type { TranscriptEntry } from "@/types";

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

/** Above this, a `pending` row stops being "waiting" and starts being visible. */
export const ESCALATE_AFTER_ATTEMPTS = 5;

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
