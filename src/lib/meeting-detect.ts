import {
  MEETING_DETECT_FALLBACK_LABEL,
  MEETING_DETECT_GATED_PROCESSES,
  MEETING_DETECT_LABELS,
  MEETING_DETECT_PROCESSES,
} from "@/config/constants";
import type { GoogleConfigState } from "@/lib/storage/google-config.storage";
import type { GoogleErrorCode } from "@/types/calendar";

export interface WatchLists {
  direct: string[];
  gated: string[];
}

/** Chrome is watched whether or not Google is set up: any Chrome mic use is a call. */
export async function currentWatchLists(): Promise<WatchLists> {
  return { direct: MEETING_DETECT_PROCESSES, gated: MEETING_DETECT_GATED_PROCESSES };
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
