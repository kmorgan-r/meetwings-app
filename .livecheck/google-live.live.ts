// LIVE GOOGLE CHECKS - Run by Kevin with two real access tokens against two
// accounts in your own Google Workspace (same organisation); paste the printed
// results into the PR body. G1 confirms the exact-key match (iCalUID + instant)
// the Notion send pre-check and recheck ride on; G2 prints the guest-list shape
// Google actually returns (self rows, organizer self, calendar organizers).
//
// Gating: all four GOOGLE_LIVE_* env vars must be set or the whole suite skips
// (a run without them does nothing but skip - exit 0). GOOGLE_LIVE_TOKEN_A and
// GOOGLE_LIVE_TOKEN_B are OAuth access tokens with the `calendar.events.readonly`
// scope, one per account; GOOGLE_LIVE_FROM and GOOGLE_LIVE_TO are the RFC 3339
// timeMin/timeMax of a window that covers the test events. Access tokens are
// short-lived (about an hour), so refresh them right before a run.
//
// Privacy: the tokens are never printed; no request header is ever named or
// printed; no email address, display name or event subject is ever printed -
// not even into a thrown message. A failed request prints its HTTP status
// number only. A's own domain (read from a `self: true` attendee or organizer)
// stays in memory and is only ever compared, so organizers print as
// `internal` / `external`. Events are numbered, never identified: every line
// carries a running number, and the event id is never printed.
//
// The events come straight from Node's fetch against the Calendar API - the
// production call goes through Rust (src-tauri/src/google/calendar.rs), which
// cannot run outside the app, so this harness re-issues the same request: the
// same endpoint, singleEvents=true, maxResults and the same field mask
// (EVENT_FIELDS below must match calendar.rs's EVENT_FIELDS).

const EVENT_FIELDS =
  "items(iCalUID,status,summary,start,end,originalStartTime,organizer(email,displayName,self),attendees(email,displayName,self,organizer,resource,optional,responseStatus))";

const TOKEN_A = process.env.GOOGLE_LIVE_TOKEN_A ?? "";
const TOKEN_B = process.env.GOOGLE_LIVE_TOKEN_B ?? "";
const FROM = process.env.GOOGLE_LIVE_FROM ?? "";
const TO = process.env.GOOGLE_LIVE_TO ?? "";
const ENABLED =
  TOKEN_A !== "" && TOKEN_B !== "" && FROM !== "" && TO !== "";

const EVENTS_URL =
  "https://www.googleapis.com/calendar/v3/calendars/primary/events";

// ---------------------------------------------------------------- API types --

interface TYPE_EVENT_TIME {
  dateTime?: string;
  date?: string;
}

interface TYPE_EVENT_ATTENDEE {
  email?: string;
  displayName?: string;
  self?: boolean;
  organizer?: boolean;
  resource?: boolean;
  optional?: boolean;
  responseStatus?: string;
}

interface TYPE_EVENT {
  iCalUID?: string;
  status?: string;
  summary?: string;
  start?: TYPE_EVENT_TIME;
  end?: TYPE_EVENT_TIME;
  originalStartTime?: TYPE_EVENT_TIME;
  organizer?: { email?: string; displayName?: string; self?: boolean };
  attendees?: TYPE_EVENT_ATTENDEE[];
}

// ------------------------------------------------------------------ helpers --

/**
 * One account's event list. A non-200 becomes a thrown Error carrying the
 * status number ONLY - no response body, no headers, ever.
 */
async function fetchEvents(token: string, label: string): Promise<TYPE_EVENT[]> {
  const params = new URLSearchParams({
    singleEvents: "true",
    timeMin: FROM,
    timeMax: TO,
    maxResults: "250",
    fields: EVENT_FIELDS,
  });
  const response = await fetch(`${EVENTS_URL}?${params.toString()}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    throw new Error(`the events request for account ${label} failed with status ${response.status}`);
  }
  const body = (await response.json()) as { items?: TYPE_EVENT[] };
  return body.items ?? [];
}

/** The lowercase domain of an email address; null when there is none. */
function domainOf(email: string): string | null {
  const at = email.indexOf("@");
  if (at === -1 || at === email.length - 1) return null;
  return email.slice(at + 1).toLowerCase();
}

/**
 * A's own domain, from the first `self: true` attendee or organizer in A's
 * events, lowercased. Kept in memory only and never printed; null when no
 * event carries A's own address.
 */
function ownDomainOf(events: TYPE_EVENT[]): string | null {
  for (const e of events) {
    for (const a of e.attendees ?? []) {
      if (a.self === true && typeof a.email === "string") {
        const domain = domainOf(a.email);
        if (domain !== null) return domain;
      }
    }
    if (e.organizer?.self === true && typeof e.organizer.email === "string") {
      const domain = domainOf(e.organizer.email);
      if (domain !== null) return domain;
    }
  }
  return null;
}

/**
 * `internal` when the organizer's email domain equals A's own domain,
 * `external` otherwise; `unknown` when A's own address was never found.
 */
function organizerLabel(e: TYPE_EVENT, ownDomain: string | null): string {
  if (ownDomain === null) return "unknown";
  const email = e.organizer?.email;
  const domain = typeof email === "string" ? domainOf(email) : null;
  return domain !== null && domain === ownDomain ? "internal" : "external";
}

/** `one-off|recurring` - recurring means Google reports an originalStartTime. */
function recurranceLabel(e: TYPE_EVENT): string {
  return e.originalStartTime !== undefined ? "recurring" : "one-off";
}

/**
 * The instant the key rides on: the occurrence's original start for a
 * recurring event, the plain start otherwise. NaN for an all-day event (the
 * caller skips those), exactly as the normalization does.
 */
function startInstant(e: TYPE_EVENT): number {
  return Date.parse(e.originalStartTime?.dateTime ?? e.start?.dateTime ?? "");
}

const calendarOrganizer = (name: string): boolean =>
  name.toLowerCase().endsWith("calendar.google.com");

// ------------------------------------------------------------------- checks --

describe.skipIf(!ENABLED)("Google live checks (two read-only tokens)", () => {
  let eventsA: TYPE_EVENT[] = [];
  let eventsB: TYPE_EVENT[] = [];

  beforeAll(async () => {
    eventsA = await fetchEvents(TOKEN_A, "A");
    eventsB = await fetchEvents(TOKEN_B, "B");
    console.log(
      `[G1] setup: A returned ${eventsA.length} event(s), B returned ${eventsB.length} event(s)`,
    );
  });

  // -------------------------------------------------------------------- G1
  it("G1: A-vs-B exact-key match (iCalUID + instant) for A events with attendees", () => {
    const ownDomain = ownDomainOf(eventsA);
    console.log(`[G1] setup: own domain ${ownDomain === null ? "not found" : "found"}`);

    // B's keys: iCalUID + the same instant A keys on.
    const bKeys = new Set<string>();
    for (const e of eventsB) {
      const instant = startInstant(e);
      if (e.iCalUID === undefined || Number.isNaN(instant)) continue;
      bKeys.add(`${e.iCalUID}@${instant}`);
    }
    // "B shares any event": only the iCalUID half decides whether an assertion
    // is even due - instants seen from two calendars can differ by offset.
    const bUIDs = new Set(eventsB.map((e) => e.iCalUID).filter((uid) => uid !== undefined));

    let number = 0;
    let matches = 0;
    for (const e of eventsA) {
      if ((e.attendees?.length ?? 0) === 0) continue;
      const instant = startInstant(e);
      if (Number.isNaN(instant)) continue; // all-day events never key-match
      number += 1;
      const key = e.iCalUID === undefined ? null : `${e.iCalUID}@${instant}`;
      const match = key !== null && bKeys.has(key);
      if (match) matches += 1;
      console.log(
        `[G1] event ${number}: ${recurranceLabel(e)}, ` +
          `organizer ${organizerLabel(e, ownDomain)}, key match ${match ? "yes" : "no"}`,
      );
    }

    const sharesUIDs = eventsA.some((e) => e.iCalUID !== undefined && bUIDs.has(e.iCalUID));
    if (sharesUIDs) {
      expect(matches, "A and B share events by iCalUID, so at least one must key-match").toBeGreaterThan(0);
    } else {
      console.log(`[G1] no shared events in window [print only]`);
    }
  });

  // -------------------------------------------------------------------- G2
  it("G2: guest-list shape of A's events (print only)", () => {
    let number = 0;
    for (const e of eventsA) {
      number += 1;
      const attendees = e.attendees ?? [];
      const selfRow = attendees.some((a) => a.self === true);
      const organizerSelf = e.organizer?.self === true;
      const organizerEmail = e.organizer?.email;
      const isACalendar =
        typeof organizerEmail === "string" && calendarOrganizer(organizerEmail);
      console.log(
        `[G2] event ${number}: attendees ${attendees.length}, ` +
          `self row ${selfRow ? "yes" : "no"}, ` +
          `organizer self ${organizerSelf ? "yes" : "no"}, ` +
          `organizer is a calendar ${isACalendar ? "yes" : "no"}`,
      );
    }
  });
});
