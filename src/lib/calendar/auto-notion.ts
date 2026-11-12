import type { CalendarSnapshot } from "./calendar-snapshot";
import { insideEvent, isMeetingEvent, pickCurrentMeeting } from "./current-meeting";
import type { FetchCurrentMeetingsResult } from "./fetch-current-meetings";
import type { FetchGoogleMeetingsResult } from "./fetch-google-meetings";

export const OUTLOOK_CHECK_TIMEOUT_MS = 5_000;

/**
 * Races `p` against a timer and clears the timer when `p` settles. Never
 * rejects: a rejection of `p` resolves to "timeout", which every caller treats
 * as a failed read.
 */
export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | "timeout"> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve("timeout"), ms);
    p.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve("timeout");
      }
    );
  });
}

/**
 * Check 1: tick only for a meeting that is on Google and NOT on Outlook.
 * Any Outlook meeting, error or timeout refuses (the owner's rule: no Outlook
 * calls go to Notion).
 */
export function decideCheckOne(
  google: FetchGoogleMeetingsResult,
  outlook: FetchCurrentMeetingsResult | "timeout",
  now: number
): "tick" | "refuse" {
  if (outlook === "timeout") return "refuse";
  if (google.kind !== "ok" || pickCurrentMeeting(google.events, now).kind !== "one") {
    return "refuse";
  }
  if (outlook.kind === "absent") return "tick";
  if (outlook.kind === "ok" && pickCurrentMeeting(outlook.events, now).kind === "none") {
    return "tick";
  }
  return "refuse";
}

/**
 * The window rule, then check 2, for one meeting-end row with an AUTO tick.
 * The row must sit mostly inside the saved Google event, and no Outlook
 * meeting may overlap it at all. Never rejects: any doubt (no snapshot, an
 * Outlook error, timeout or throw) withholds. `outlookAbsent` only skips the
 * read; it never excuses the window rule.
 */
export async function autoNotionAllowed(i: {
  span: { start: number; end: number };
  snapshot: CalendarSnapshot | null;
  outlookAbsent: boolean;
  readOutlook: (startMs: number, endMs: number) => Promise<FetchCurrentMeetingsResult>;
  timeoutMs?: number;
}): Promise<boolean> {
  try {
    if (i.snapshot === null || !insideEvent(i.span, i.snapshot)) return false;
    if (i.outlookAbsent) return true;
    const outlook = await withTimeout(
      i.readOutlook(i.span.start, i.span.end),
      i.timeoutMs ?? OUTLOOK_CHECK_TIMEOUT_MS
    );
    // A config that vanished mid-check (`absent`) is doubt too, not "no Outlook".
    if (outlook === "timeout" || outlook.kind !== "ok") return false;
    return !outlook.events.some(
      (e) =>
        isMeetingEvent(e) &&
        Math.min(e.endMs, i.span.end) - Math.max(e.startMs, i.span.start) > 0
    );
  } catch {
    return false;
  }
}
