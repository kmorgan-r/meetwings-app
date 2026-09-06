import type { CalendarEvent, CalendarParticipant, MatchResult, OdooContact } from "@/types";

/** Exact match on normalized email: trim and lowercase BOTH sides. */
export function normalizeAddress(address: string): string {
  return address.trim().toLowerCase();
}

/**
 * The organizer-plus-attendees union every rule in this feature operates on.
 *
 * Two jobs, in this order:
 *
 * 1. Rooms and equipment are dropped. Graph puts them in the same
 *    `attendees[]` array, distinguished only by `type: "resource"`. Keeping
 *    them breaks two things at once: a booked room defeats the solo/focus
 *    block filter in current-meeting.ts (user + room = two participants), and
 *    every room-booked meeting renders a permanent greyed "Conf Room 3 - no
 *    Odoo contact" row no user can ever resolve.
 * 2. Dedupe by normalized address, organizer winning. Graph generally does
 *    not repeat the organizer inside `attendees`, but the union is correct
 *    either way and a duplicate would otherwise be proposed twice.
 */
export function participantsOf(event: CalendarEvent): CalendarParticipant[] {
  const byAddress = new Map<string, CalendarParticipant>();
  for (const participant of event.participants) {
    if (participant.type === "resource") continue;
    const key = normalizeAddress(participant.address);
    if (key === "") continue;
    const existing = byAddress.get(key);
    if (existing === undefined) {
      byAddress.set(key, participant);
    } else if (participant.isOrganizer && !existing.isOrganizer) {
      // The organizer entry carries the flag the matcher and the UI read.
      byAddress.set(key, participant);
    }
  }
  return [...byAddress.values()];
}

/**
 * Which of two contacts sharing one email wins.
 *
 * `listContacts` has no ORDER BY (odoo-contacts.action.ts:122), so without an
 * explicit rule the winner is whatever SQLite returned first - and the proposal
 * row shows only a name, so picking the wrong partner record is invisible at
 * the confirm gate. Deterministic beats arbitrary even when both are imperfect.
 *
 * A PERSON beats a company: an email shared between the two is almost always
 * the individual's, and a meeting note belongs on the person. Then lowest id,
 * which is stable across syncs in a way `name` is not.
 */
function preferForDuplicateEmail(a: OdooContact, b: OdooContact): OdooContact {
  if (a.isCompany !== b.isCompany) return a.isCompany ? b : a;
  return a.id <= b.id ? a : b;
}

export function matchAttendees({
  participants,
  contacts,
  ownAddress,
}: {
  participants: CalendarParticipant[];
  contacts: OdooContact[];
  ownAddress: string | null;
}): MatchResult {
  const byEmail = new Map<string, OdooContact>();
  for (const contact of contacts) {
    if (contact.email === null) continue;
    const key = normalizeAddress(contact.email);
    if (key === "") continue;
    const existing = byEmail.get(key);
    byEmail.set(key, existing === undefined ? contact : preferForDuplicateEmail(existing, contact));
  }

  // null when neither claim was present. Normalizing null to "" would make the
  // blank-address guard below silently exclude somebody.
  const own = ownAddress === null ? null : normalizeAddress(ownAddress);

  const result: MatchResult = { matched: [], unmatched: [], excluded: [] };
  for (const participant of participants) {
    const key = normalizeAddress(participant.address);
    if (own !== null && key === own) {
      result.excluded.push({ participant, reason: "self" });
      continue;
    }
    const contact = key === "" ? undefined : byEmail.get(key);
    if (contact === undefined) {
      result.unmatched.push({ participant, reason: "no-contact" });
      continue;
    }
    if (contact.isColleague) {
      // Logging a meeting onto a coworker's partner record is noise. No greyed
      // row either - the user can still add a colleague by hand.
      result.excluded.push({ participant, reason: "colleague" });
      continue;
    }
    if (!contact.active) {
      result.unmatched.push({ participant, reason: "archived" });
      continue;
    }
    result.matched.push({ participant, contact });
  }
  return result;
}
