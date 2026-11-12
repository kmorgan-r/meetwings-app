import { invoke } from "@tauri-apps/api/core";
import { loadGoogleConfigState } from "@/lib/storage/google-config.storage";
import type { CalendarEvent, CurrentMeetings, GoogleErrorCode } from "@/types";
import { QUERY_WINDOW_MS } from "./fetch-current-meetings";
import { toGoogleCode } from "./google-errors";

export type FetchGoogleMeetingsResult =
  | { kind: "ok"; events: CalendarEvent[]; ownAddress: string | null }
  | { kind: "absent" }
  | { kind: "error"; code: GoogleErrorCode };

/** The Google calendar read. Never rejects. */
export async function fetchCurrentGoogleMeetings(
  now: number = Date.now()
): Promise<FetchGoogleMeetingsResult> {
  const config = await loadGoogleConfigState();
  if (config.state === "absent") return { kind: "absent" };
  if (config.state !== "complete") return { kind: "error", code: "GOOGLE_AUTH_REJECTED" };
  try {
    const response = await invoke<CurrentMeetings>("google_current_meetings", {
      clientId: config.config.clientId,
      clientSecret: config.config.clientSecret,
      startIso: new Date(now - QUERY_WINDOW_MS).toISOString(),
      endIso: new Date(now + QUERY_WINDOW_MS).toISOString(),
    });
    return { kind: "ok", events: response.events, ownAddress: response.ownAddress };
  } catch (err) {
    return { kind: "error", code: toGoogleCode(err) };
  }
}
