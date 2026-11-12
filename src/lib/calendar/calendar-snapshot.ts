import type { CalendarEvent } from "@/types";
import { normalizeAddress, participantsOf } from "./match-attendees";
import { FREE_MAIL, domainOf } from "./similar-contacts";

/**
 * Caps for what lands in a meeting note. The participants are capped at
 * grouping time (groupAttendees), not storage time - the snapshot keeps every
 * person it was given, and only the rendered list is clipped.
 */
export const MAX_ATTENDEE_TEXT = 100;
export const MAX_ATTENDEES = 50;
export const MAX_SUBJECT = 200;

export interface SnapshotParticipant {
  address: string;
  name: string | null;
}

export interface CalendarSnapshot {
  key: string;
  subject: string | null;
  startMs: number;
  endMs: number;
  ownAddress: string | null;
  participants: SnapshotParticipant[];
}

export interface AttendeeGroups {
  teamLabel: string;
  team: string[];
  external: { domain: string; people: string[] }[];
  otherGuests: string[];
  omitted: number;
}

/**
 * Long display text is elided, not bluntly cut: the reader sees at a glance
 * that a name was shortened. `…` is a single BMP code unit, so the result of
 * cutting text longer than the cap is EXACTLY the cap long.
 */
function displayText(raw: string): string {
  if (raw.length <= MAX_ATTENDEE_TEXT) return raw;
  return raw.slice(0, MAX_ATTENDEE_TEXT - 1) + "…";
}

function displayOf(participant: SnapshotParticipant): string {
  const name = participant.name === null ? "" : participant.name.trim();
  return name === "" ? participant.address : name;
}

/**
 * Freeze one meeting for the note later attached to it.
 *
 * `participantsOf` already does the structuring that must not happen twice:
 * rooms and equipment are dropped, and duplicate addresses collapse with the
 * organizer winning. Adding a second filter here would fork that rule - the
 * snapshot relies on it. Declines are the one filter on top: Google sets
 * `responseStatus` per guest, and a person who cancelled is not attending the
 * meeting the note describes. `tentative` still is.
 */
export function buildSnapshot(
  event: CalendarEvent,
  ownAddress: string | null
): CalendarSnapshot {
  const participants = participantsOf(event)
    .filter((p) => p.response?.toLowerCase() !== "declined")
    .map((p) => ({ address: p.address, name: p.name }));
  return {
    key: event.id,
    subject: event.subject === null ? null : event.subject.slice(0, MAX_SUBJECT),
    startMs: event.startMs,
    endMs: event.endMs,
    ownAddress,
    participants,
  };
}

/**
 * JSON.parse plus a shape check, never a throw.
 *
 * The snapshot lives in storage as JSON and comes back hand-edited, truncated
 * or from a previous schema just as easily as intact. Only the fields
 * grouping reads are validated; `subject`/`ownAddress` are coerced to null
 * when absent rather than rejected, so an older snapshot still loads.
 */
export function parseSnapshot(json: string | null): CalendarSnapshot | null {
  if (json === null) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.key !== "string") return null;
  if (typeof obj.startMs !== "number" || !Number.isFinite(obj.startMs)) return null;
  if (typeof obj.endMs !== "number" || !Number.isFinite(obj.endMs)) return null;
  if (!Array.isArray(obj.participants)) return null;

  const participants: SnapshotParticipant[] = [];
  for (const item of obj.participants) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return null;
    const entry = item as Record<string, unknown>;
    if (typeof entry.address !== "string") return null;
    if (entry.name !== null && typeof entry.name !== "string") return null;
    participants.push({
      address: entry.address,
      name: entry.name as string | null,
    });
  }
  return {
    key: obj.key,
    subject: typeof obj.subject === "string" ? obj.subject : null,
    startMs: obj.startMs,
    endMs: obj.endMs,
    ownAddress: typeof obj.ownAddress === "string" ? obj.ownAddress : null,
    participants,
  };
}

/**
 * The note's attendee section: the user's team first, then outside companies
 * grouped by domain, then unaffiliated guests.
 *
 * The team is the user plus everyone on the user's non-free-mail domain - see
 * FREE_MAIL for why gmail.com and friends never imply a company, here or in
 * the create form. A person whose address IS the user's is team no matter
 * what domain inference made of the rest.
 *
 * Capping fills team first, then external domains A to Z, then other guests -
 * company people read for the note, stray gmail addresses last. Within every
 * list the snapshot's participant order, i.e. invite order, is kept.
 */
export function groupAttendees(snapshot: CalendarSnapshot): AttendeeGroups {
  const own = snapshot.ownAddress === null ? null : normalizeAddress(snapshot.ownAddress);
  const ownDomain = own === null ? null : domainOf(own);
  const teamDomain =
    ownDomain !== null && !FREE_MAIL.has(ownDomain) ? ownDomain : null;
  const teamLabel = teamDomain === null ? "Team" : `Team (${teamDomain})`;

  const team: string[] = [];
  const byDomain = new Map<string, string[]>();
  const otherGuests: string[] = [];

  for (const participant of snapshot.participants) {
    const key = normalizeAddress(participant.address);
    const text = displayText(displayOf(participant));
    if (own !== null && key === own) {
      team.push(text);
      continue;
    }
    const domain = domainOf(key);
    if (teamDomain !== null && domain === teamDomain) {
      team.push(text);
      continue;
    }
    if (domain === null || FREE_MAIL.has(domain)) {
      otherGuests.push(text);
      continue;
    }
    const bucket = byDomain.get(domain);
    if (bucket === undefined) byDomain.set(domain, [text]);
    else bucket.push(text);
  }

  // Budget spent strictly in priority order: team, external domains A-Z,
  // then other guests. Whoever the budget cannot cover is counted, never a
  // surprise to the reader - just absent.
  let budget = MAX_ATTENDEES;
  const cap = (list: string[]): { kept: string[]; dropped: number } => {
    if (list.length <= budget) {
      budget -= list.length;
      return { kept: list, dropped: 0 };
    }
    const kept = list.slice(0, Math.max(0, budget));
    const dropped = list.length - kept.length;
    budget = 0;
    return { kept, dropped };
  };

  const teamCapped = cap(team);
  // [...keys()] sorts the SNAPSHOT-encounter order A-Z; this cannot reach the
  // caller's arrays, the map is local.
  const domains = [...byDomain.keys()].sort();
  let omitted = teamCapped.dropped;
  const external: { domain: string; people: string[] }[] = [];
  for (const domain of domains) {
    const capped = cap(byDomain.get(domain) ?? []);
    omitted += capped.dropped;
    if (capped.kept.length > 0) external.push({ domain, people: capped.kept });
  }
  const guestsCapped = cap(otherGuests);
  omitted += guestsCapped.dropped;

  return {
    teamLabel,
    team: teamCapped.kept,
    external,
    otherGuests: guestsCapped.kept,
    omitted,
  };
}
