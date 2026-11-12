import { pickCurrentMeeting } from "./current-meeting";
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
