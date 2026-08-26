import { STORAGE_KEYS } from "@/config";
import { safeLocalStorage } from "./helper";

/**
 * How far a meeting log trigger has consumed the in-memory transcript even
 * when it wrote NO row for it.
 *
 * `meetingTranscript` is never cleared when a meeting ends
 * (see `sliceTranscript`'s doc comment in `lib/odoo/meeting-log.ts`), so two
 * consecutive meetings live in one array and the ONLY thing that tells them
 * apart is the watermark - `getTranscriptWatermark()`, `MAX(transcript_end_at)`
 * over the whole queue. That watermark advances only when a row is actually
 * written.
 *
 * A trigger that takes a synchronous snapshot and then bails - Odoo not fully
 * configured, or any throw - has consumed that snapshot without writing a row
 * for it. Left alone, those entries stay above the DB watermark forever, so
 * the NEXT trigger slices from the same old mark, picks the lost entries back
 * up, and posts them under whatever contact happens to be selected for THAT
 * later meeting - one customer's transcript, uploaded as a chatter note on a
 * different customer's record. This is the second, independent watermark that
 * closes that gap: the effective read is
 * `Math.max(getTranscriptWatermark(), getSkipWatermark())`, so a row that IS
 * later written for the real span always advances past whatever this one
 * holds, and a span that was only ever skipped stays excluded either way.
 */
export function getSkipWatermark(): number {
  const raw = safeLocalStorage.getItem(STORAGE_KEYS.MEETING_LOG_SKIP_WATERMARK);
  if (!raw) return 0;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Monotonic. `Math.max` against the stored value rather than an unconditional
 * write: a caller that snapshots a SUB-RANGE would otherwise walk this
 * watermark backward, and the next trigger would re-slice entries a previous
 * trigger already consumed - posting one customer's transcript onto whatever
 * contact is selected for a LATER meeting. Safe today only because the single
 * caller derives its value from a snapshot that grows monotonically within a
 * session; this guard costs nothing and removes the assumption.
 */
export function setSkipWatermark(ts: number): void {
  const next = Math.max(getSkipWatermark(), ts);
  safeLocalStorage.setItem(STORAGE_KEYS.MEETING_LOG_SKIP_WATERMARK, String(next));
}
