import { STORAGE_KEYS } from "@/config/constants";
import { MAX_TARGETS } from "@/lib/odoo/meeting-log";
import { safeLocalStorage } from "@/lib/storage/helper";
import type {
  CalendarEvent,
  CalendarParticipant,
  OdooContact,
  SelectedTarget,
} from "@/types";
import { pickCurrentMeeting } from "./current-meeting";
import { matchAttendees, normalizeAddress, participantsOf } from "./match-attendees";
import { domainOf, FREE_MAIL, inferCompany, normalizeName, similar } from "./similar-contacts";

/**
 * Auto-select adds targets, and creates contacts, with no confirm click: a
 * deliberate exception to the confirm-gate rules of the 2026-09-01 and
 * 2026-09-05 specs, for the clear case only. See
 * docs/superpowers/specs/2026-10-15-calendar-auto-select-design.md.
 */

/** Default ON: only an explicit "false" turns it off. */
export function isCalendarAutoSelectEnabled(): boolean {
  return safeLocalStorage.getItem(STORAGE_KEYS.CALENDAR_AUTO_SELECT_ENABLED) !== "false";
}

export function setCalendarAutoSelectEnabled(enabled: boolean): void {
  safeLocalStorage.setItem(STORAGE_KEYS.CALENDAR_AUTO_SELECT_ENABLED, String(enabled));
}

export interface AutoCreate {
  participant: CalendarParticipant;
  name: string;
  parentId: number | null;
}

export type AutoSelectSkip =
  | "no-own-address"
  | "no-meeting"
  | "several-meetings"
  | "nothing-to-do"
  | "over-cap";

export type AutoSelectPlan =
  | { kind: "skip"; reason: AutoSelectSkip }
  | { kind: "apply"; add: OdooContact[]; create: AutoCreate[] };

export function planAutoSelect({
  events,
  ownAddress,
  contacts,
  targets,
  now,
}: {
  events: CalendarEvent[];
  ownAddress: string | null;
  contacts: OdooContact[];
  targets: SelectedTarget[];
  now: number;
}): AutoSelectPlan {
  // No own domain means no way to tell a coworker from a customer.
  if (ownAddress === null || domainOf(ownAddress) === null) {
    return { kind: "skip", reason: "no-own-address" };
  }

  const current = pickCurrentMeeting(events, now);
  if (current.kind === "none") return { kind: "skip", reason: "no-meeting" };
  if (current.kind === "several") return { kind: "skip", reason: "several-meetings" };

  // Free mail is left out: one colleague on gmail must not block every gmail
  // attendee. domainOf lowercases, so the comparison is case-insensitive.
  const colleagueDomains = new Set<string>();
  for (const address of [ownAddress, ...contacts.filter((c) => c.isColleague).map((c) => c.email)]) {
    const domain = address === null ? null : domainOf(address);
    if (domain !== null && !FREE_MAIL.has(domain)) colleagueDomains.add(domain);
  }
  const outside = (address: string) => {
    const domain = domainOf(address);
    return domain !== null && !colleagueDomains.has(domain);
  };

  const people = participantsOf(current.event);
  const { matched, unmatched } = matchAttendees({ participants: people, contacts, ownAddress });

  // Any namesake makes a create the user's call, not only the active,
  // non-colleague rows similarContacts offers as Use buttons: an archived
  // record, a coworker on personal mail, or another attendee under a second
  // address is still probably this person.
  const hasNamesake = (name: string, address: string) => {
    const tokens = normalizeName(name);
    if (tokens.size === 0) return false;
    const own = normalizeAddress(address);
    const namesake = (otherAddress: string | null, otherName: string | null) =>
      (otherAddress === null || normalizeAddress(otherAddress) !== own) &&
      otherName !== null &&
      similar(tokens, normalizeName(otherName));
    return contacts.some((c) => namesake(c.email, c.name)) || people.some((p) => namesake(p.address, p.name));
  };

  // An already-selected match is never re-upserted: that would rewrite its
  // selected_at and conversation_id.
  const add = matched
    .filter(
      ({ participant, contact }) =>
        outside(participant.address) &&
        !targets.some((t) => t.model === "res.partner" && t.resId === contact.id)
    )
    .map(({ contact }) => contact);

  const create: AutoCreate[] = [];
  for (const { participant, reason } of unmatched) {
    // Creating over an archived record would duplicate it.
    if (reason !== "no-contact") continue;
    const name = participant.name?.trim() ?? "";
    // A name that is just the address says nothing about who this is.
    if (name === "" || normalizeAddress(name) === normalizeAddress(participant.address)) continue;
    if (!outside(participant.address)) continue;
    if (hasNamesake(name, participant.address)) continue;
    create.push({ participant, name, parentId: inferCompany({ address: participant.address, contacts }) });
  }

  if (add.length + create.length === 0) return { kind: "skip", reason: "nothing-to-do" };
  // Never a subset: choosing which attendees fit is the guess "clear cases only" rules out.
  if (add.length + create.length > MAX_TARGETS - targets.length) {
    return { kind: "skip", reason: "over-cap" };
  }
  return { kind: "apply", add, create };
}
