import type { CalendarEvent, CurrentMeeting } from "@/types";
import { participantsOf } from "./match-attendees";

/**
 * An event starting further out than this is not the meeting you are in, even
 * when the wider 15-minute query window returns it. Five minutes covers the
 * normal early join.
 */
export const EARLY_JOIN_MS = 5 * 60 * 1000;

/**
 * An event that ended within this still counts when nothing else is live.
 * Meetings run over, and users start logging after the fact.
 */
export const ENDED_GRACE_MS = 10 * 60 * 1000;

// `CurrentMeeting` is imported from @/types (see Task 3's placement note). The
// "several" case is deliberate: do NOT guess. The block renders one row per
// candidate, and picking one replaces it with that meeting's proposal.

/**
 * `declined` is the ONLY response that rejects. `notResponded`, `none` and
 * `tentativelyAccepted` all survive: a tentative meeting the user is sitting
 * in is still the meeting they are in.
 */
function isDeclined(event: CalendarEvent): boolean {
  return event.ownResponse.toLowerCase() === "declined";
}

function isCandidate(event: CalendarEvent, nowMs: number): boolean {
  if (event.isCancelled) return false;
  if (event.isAllDay) return false;
  if (isDeclined(event)) return false;
  // Organizer INCLUDED, resources EXCLUDED - both handled by participantsOf.
  // A solo entry is a focus block or a reminder, not a meeting.
  if (participantsOf(event).length < 2) return false;
  if (event.startMs > nowMs + EARLY_JOIN_MS) return false;
  if (event.endMs < nowMs - ENDED_GRACE_MS) return false;
  return true;
}

export function pickCurrentMeeting(
  events: CalendarEvent[],
  nowMs: number
): CurrentMeeting {
  const candidates = events.filter((event) => isCandidate(event, nowMs));
  if (candidates.length === 0) return { kind: "none" };
  if (candidates.length === 1) return { kind: "one", event: candidates[0] };
  // Soonest-starting first, so the candidate list reads in the order the user
  // would scan it. Ties broken by id for a stable render.
  const ordered = [...candidates].sort(
    (a, b) => a.startMs - b.startMs || a.id.localeCompare(b.id)
  );
  return { kind: "several", candidates: ordered };
}
