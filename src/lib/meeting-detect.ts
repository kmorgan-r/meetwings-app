import {
  MEETING_DETECT_FALLBACK_LABEL,
  MEETING_DETECT_GATED_PROCESSES,
  MEETING_DETECT_GATED_PROCESSES_MAC,
  MEETING_DETECT_LABELS,
  MEETING_DETECT_PROCESSES,
  MEETING_DETECT_PROCESSES_MAC,
} from "@/config/constants";
import { isMacOS, isWindows } from "@/lib/platform";
import type { GoogleConfigState } from "@/lib/storage/google-config.storage";
import type { GoogleErrorCode } from "@/types/calendar";

export interface WatchLists {
  direct: string[];
  gated: string[];
}

/**
 * Does a watch-list `entry` match a session id? The TS twin of Rust's
 * `entry_matches` (meeting_detect/mod.rs), so the two platforms keep one rule:
 *
 * - case-insensitive equality, else
 * - an `.exe` entry never prefix-matches (`chrome.exe.foo` is not Chrome), else
 * - `id` starts with `entry` and the next character is `.`, so
 *   `com.google.Chrome` matches `com.google.Chrome.helper` but not
 *   `com.google.ChromeX`.
 */
export function entryMatches(entry: string, id: string): boolean {
  if (entry.toLowerCase() === id.toLowerCase()) return true;
  if (entry.toLowerCase().endsWith(".exe")) return false;
  return (
    id.toLowerCase().startsWith(entry.toLowerCase()) &&
    id.charAt(entry.length) === "."
  );
}

/**
 * Whether two detected process ids describe the same call. True on equal ids
 * case-insensitively, or when some watch-list entry of either platform matches
 * both - a Chrome app and its Chrome helper (or two helpers) are one call, not
 * a flap from Meet to a new app. The union is static and `.exe` entries never
 * prefix-match, so it cannot change any Windows pairing.
 */
export function sameCallId(a: string, b: string): boolean {
  if (a.toLowerCase() === b.toLowerCase()) return true;
  const entries = [
    ...MEETING_DETECT_PROCESSES,
    ...MEETING_DETECT_GATED_PROCESSES,
    ...MEETING_DETECT_PROCESSES_MAC,
    ...MEETING_DETECT_GATED_PROCESSES_MAC,
  ];
  return entries.some((e) => entryMatches(e, a) && entryMatches(e, b));
}

/** The feature runs on Windows today, and on the Mac once its watcher lands. */
export const isMeetingDetectionPlatform = (): boolean =>
  isWindows() || isMacOS();

/** Chrome is watched whether or not Google is set up: any Chrome mic use is a call. */
export async function currentWatchLists(): Promise<WatchLists> {
  return isMacOS()
    ? {
        direct: MEETING_DETECT_PROCESSES_MAC,
        gated: MEETING_DETECT_GATED_PROCESSES_MAC,
      }
    : { direct: MEETING_DETECT_PROCESSES, gated: MEETING_DETECT_GATED_PROCESSES };
}

export function meetingLabel(process?: string): string {
  if (!process) return MEETING_DETECT_FALLBACK_LABEL;
  const entry = Object.keys(MEETING_DETECT_LABELS).find((key) =>
    entryMatches(key, process)
  );
  return (entry && MEETING_DETECT_LABELS[entry]) || MEETING_DETECT_FALLBACK_LABEL;
}

export function isGatedProcess(process?: string): boolean {
  return (
    !!process &&
    [...MEETING_DETECT_GATED_PROCESSES, ...MEETING_DETECT_GATED_PROCESSES_MAC].some(
      (e) => entryMatches(e, process)
    )
  );
}

export type AmberKind = "reconnect" | "settings" | "offline";

export function amberKindFor(
  code: GoogleErrorCode,
  configState: GoogleConfigState["state"]
): AmberKind {
  if (configState !== "complete") return "settings";
  switch (code) {
    case "GOOGLE_AUTH_EXPIRED":
    case "GOOGLE_AUTH_REJECTED":
    case "GOOGLE_CONSENT_REQUIRED":
    case "GOOGLE_AUTH_CANCELLED":
    case "GOOGLE_NOT_CONNECTED":
      return "reconnect";
    default:
      return "offline";
  }
}
