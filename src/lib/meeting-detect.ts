import {
  MEETING_DETECT_FALLBACK_LABEL,
  MEETING_DETECT_GATED_PROCESSES,
  MEETING_DETECT_LABELS,
  MEETING_DETECT_PROCESSES,
} from "@/config/constants";
import { EARLY_JOIN_MS, isDeclined } from "@/lib/calendar/current-meeting";
import {
  loadGoogleConfigState,
  type GoogleConfigState,
} from "@/lib/storage/google-config.storage";
import type { CalendarEvent, GoogleErrorCode } from "@/types/calendar";

export interface WatchLists {
  direct: string[];
  gated: string[];
}

/** Gated processes are only watched once a Google config exists to check them against. */
export function computeWatchLists(
  configState: GoogleConfigState["state"]
): WatchLists {
  return {
    direct: MEETING_DETECT_PROCESSES,
    gated: configState === "absent" ? [] : MEETING_DETECT_GATED_PROCESSES,
  };
}

export async function currentWatchLists(): Promise<WatchLists> {
  return computeWatchLists((await loadGoogleConfigState()).state);
}

export function meetingLabel(process?: string): string {
  return (
    (process && MEETING_DETECT_LABELS[process.toLowerCase()]) ||
    MEETING_DETECT_FALLBACK_LABEL
  );
}

export function isGatedProcess(process?: string): boolean {
  return (
    !!process && MEETING_DETECT_GATED_PROCESSES.includes(process.toLowerCase())
  );
}

/**
 * A current Meet call: Meet link, not cancelled/all-day/declined, and now within
 * [start - EARLY_JOIN_MS, end). Unlike isMeetingEvent, a solo event qualifies.
 */
export function hasQualifyingMeetEvent(
  events: CalendarEvent[],
  nowMs: number
): boolean {
  return events.some(
    (e) =>
      e.hasMeetLink &&
      !e.isCancelled &&
      !e.isAllDay &&
      !isDeclined(e) &&
      e.startMs - EARLY_JOIN_MS <= nowMs &&
      nowMs < e.endMs
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
