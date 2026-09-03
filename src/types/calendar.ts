import type { OdooContact } from "./odoo";

/** Every failure this feature can surface. Mirrors OdooErrorCode's shape. */
export type GraphErrorCode =
  | "GRAPH_NOT_CONNECTED"
  | "GRAPH_CONSENT_REQUIRED"
  | "GRAPH_AUTH_CANCELLED"
  | "GRAPH_AUTH_EXPIRED"
  | "GRAPH_AUTH_REJECTED"
  | "GRAPH_BAD_RESPONSE"
  | "GRAPH_THROTTLED"
  | "GRAPH_NETWORK"
  | "GRAPH_NO_KEYCHAIN";

/**
 * Graph puts rooms and equipment in the same `attendees[]` array as people,
 * distinguished only by `type: "resource"`. They are dropped before any rule
 * sees them - see participantsOf.
 */
export type AttendeeType = "required" | "optional" | "resource";

export interface CalendarParticipant {
  address: string;
  name: string | null;
  type: AttendeeType;
  /**
   * Graph carries the organizer in a separate `organizer` property and
   * generally does NOT repeat them in `attendees`. Rust unions both; this flag
   * says which side a participant came from.
   */
  isOrganizer: boolean;
}

/**
 * One event, already normalized by Rust.
 *
 * `startMs`/`endMs` are epoch milliseconds, NOT strings. Graph sends
 * `dateTime` with no offset suffix alongside a separate `timeZone`, so
 * `new Date(ev.start.dateTime)` in the webview reads it as LOCAL time and
 * shifts the entire acceptance window by the UTC offset.
 */
export interface CalendarEvent {
  id: string;
  subject: string | null;
  startMs: number;
  endMs: number;
  isCancelled: boolean;
  isAllDay: boolean;
  /** The signed-in user's own responseStatus.response, verbatim from Graph. */
  ownResponse: string;
  /** organizer + attendees, unfiltered and undeduped. participantsOf does both. */
  participants: CalendarParticipant[];
}

/**
 * NO TOKEN FIELD, EVER. src-tauri/src/graph/mod.rs carries a cargo test that
 * fails if any exposed command's return struct gains a credential field.
 */
export interface GraphStatus {
  connected: boolean;
  /** true when no keychain service was available and the connection is session-only. */
  sessionOnly: boolean;
}

export interface CurrentMeetings {
  /**
   * The preferred_username (falling back to upn) claim of the ID token, or
   * null when neither is present. BEST-EFFORT by design: both claims are
   * UPN-shaped and in many tenants differ from the primary SMTP address in
   * `attendees[]`. When it resolves to nothing the user's own row is proposed
   * like any other - a visible row they can uncheck, never a silent drop.
   */
  ownAddress: string | null;
  events: CalendarEvent[];
}

/* ----------------------------------------------------------------------------
 * Everything below is shared between `src/lib/calendar/`, `src/hooks/` and
 * `src/pages/`, so it lives HERE rather than in whichever module happens to
 * produce it.
 *
 * That placement is load-bearing, not tidiness. The obvious alternative -
 * declaring `MatchResult` in match-attendees.ts and `CalendarProposalState` in
 * useCalendarProposal.ts - has `src/pages/` and `src/hooks/` importing types out
 * of each other: CalendarProposal.tsx and ContactPicker.tsx would both pull the
 * state union out of the hook, while the hook depends on nothing but @/types and
 * @/lib. Those edges are all `import type`, so they erase at build and the
 * runtime graph stays acyclic - but widening any one of them to a value import
 * later makes it real, and nothing in this repo has a page importing a type back
 * out of a hook.
 * ------------------------------------------------------------------------- */

export interface AttendeeMatch {
  participant: CalendarParticipant;
  contact: OdooContact;
}

export interface UnmatchedAttendee {
  participant: CalendarParticipant;
  /**
   * `archived` is NOT a softer `no-contact`: the record exists, it is just not
   * somewhere new notes should land. The two render differently.
   */
  reason: "no-contact" | "archived";
}

export interface ExcludedAttendee {
  participant: CalendarParticipant;
  /** Excluded from the PROPOSAL, not from what the user may select by hand. */
  reason: "self" | "colleague";
}

export interface MatchResult {
  matched: AttendeeMatch[];
  unmatched: UnmatchedAttendee[];
  excluded: ExcludedAttendee[];
}

export type CurrentMeeting =
  | { kind: "one"; event: CalendarEvent }
  | { kind: "several"; candidates: CalendarEvent[] }
  | { kind: "none" };

export interface CandidateSummary {
  id: string;
  subject: string | null;
  startMs: number;
  endMs: number;
}

export type CalendarProposalState =
  /** Popover closed, or reset. The region is not reserved. */
  | { kind: "idle" }
  | { kind: "loading" }
  /**
   * DYNAMICALLY absent: connected, the call ran, no current meeting. Occupies
   * the reserved region, because it resolves after open.
   */
  | { kind: "no-meeting" }
  | { kind: "several"; candidates: CandidateSummary[] }
  | {
      kind: "proposal";
      eventId: string;
      subject: string | null;
      matched: AttendeeMatch[];
      unmatched: UnmatchedAttendee[];
    }
  | { kind: "error"; code: GraphErrorCode };
