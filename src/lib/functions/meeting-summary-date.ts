import type { MeetingSummary } from "@/types";

/**
 * When a summary's meeting actually happened.
 *
 * `createdAt` is when the summary row was written, which is only the same thing
 * for a conversation summarized as it ends. The "Update Knowledge" backfill
 * summarizes conversations of any age at today's timestamp, so dating by
 * `createdAt` files a January meeting under July and stamps a whole backfilled
 * batch with one identical time.
 *
 * Falls back to `createdAt` for summaries written before the meeting window was
 * recorded, and for conversations whose messages are gone.
 */
export function meetingTimestamp(
  summary: Pick<MeetingSummary, "meetingStartedAt" | "createdAt">
): number {
  return summary.meetingStartedAt ?? summary.createdAt;
}
