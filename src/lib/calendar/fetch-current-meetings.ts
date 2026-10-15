import { invoke } from "@tauri-apps/api/core";
import { loadGraphConfigState } from "@/lib/storage/graph-config.storage";
import type { CalendarEvent, CurrentMeetings, GraphErrorCode } from "@/types";
import { toGraphError } from "./errors";

/** Deliberately WIDER than the acceptance window in current-meeting.ts, so the
 * pure function sees the events either side of the boundary rather than having
 * them filtered away by the query. */
export const QUERY_WINDOW_MS = 15 * 60 * 1000;

export type FetchCurrentMeetingsResult =
  | { kind: "ok"; events: CalendarEvent[]; ownAddress: string | null }
  | { kind: "absent" }
  | { kind: "error"; code: GraphErrorCode };

/** The calendar read both the proposal block and auto-select make. Never rejects. */
export async function fetchCurrentMeetings(): Promise<FetchCurrentMeetingsResult> {
  const config = await loadGraphConfigState();
  if (config.state === "absent") return { kind: "absent" };
  // Same code readStatus uses for the same condition: an invalid stored config
  // is a rejected authority, not a disconnected account.
  if (config.state !== "complete") return { kind: "error", code: "GRAPH_AUTH_REJECTED" };
  const now = Date.now();
  try {
    const response = await invoke<CurrentMeetings>("graph_current_meetings", {
      clientId: config.config.clientId,
      authority: config.config.authority,
      startIso: new Date(now - QUERY_WINDOW_MS).toISOString(),
      endIso: new Date(now + QUERY_WINDOW_MS).toISOString(),
    });
    return { kind: "ok", events: response.events, ownAddress: response.ownAddress };
  } catch (err) {
    return { kind: "error", code: toGraphError(err).code };
  }
}