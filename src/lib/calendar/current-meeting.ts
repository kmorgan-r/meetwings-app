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

/**
 * Whether one event, on its own qualities, is a meeting at all: not cancelled,
 * not all-day, not declined by the user, and a real gathering (two or more
 * people after resources are dropped). Carries NO knowledge of the time
 * window, so callers scanning a history can filter events without an anchor
 * time.
 */
export function isMeetingEvent(event: CalendarEvent): boolean {
  if (event.isCancelled) return false;
  if (event.isAllDay) return false;
  if (isDeclined(event)) return false;
  // Organizer INCLUDED, resources EXCLUDED - both handled by participantsOf.
  // A solo entry is a focus block or a reminder, not a meeting.
  if (participantsOf(event).length < 2) return false;
  return true;
}

/**
 * Whether a recording span sits mostly inside an event: the overlap is at
 * least half the span's own length. A span that is empty or ends before it
 * starts never counts, whatever its overlap. This tolerates some spill past
 * either edge of the entry, but not a recording that is mostly outside it.
 */
export function insideEvent(
  span: { start: number; end: number },
  event: { startMs: number; endMs: number }
): boolean {
  const overlap =
    Math.min(span.end, event.endMs) - Math.max(span.start, event.startMs);
  if (overlap < 0) return false;
  const spanLength = span.end - span.start;
  if (spanLength <= 0) return false;
  return overlap >= 0.5 * spanLength;
}

function isCandidate(event: CalendarEvent, nowMs: number): boolean {
  if (!isMeetingEvent(event)) return false;
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
