import { byRecency } from "@/lib/odoo/contact-ordering";
import type { OdooContact } from "@/types";
import { normalizeAddress } from "./match-attendees";

/** At most three candidates - the warning lives in a 112px scroll region. */
export const MAX_SIMILAR = 3;

/**
 * Elision marks are REMOVED; every other non-alphanumeric becomes a space.
 *
 * The two classes are the rule, not a detail. Collapse them either way and one
 * of the two cases this must handle breaks: spacing apostrophes turns O'Brien
 * into {brien}, which shares nothing with OBrien's {obrien}; stripping hyphens
 * turns Doe-Smith into the single token "doesmith", which shares only "jane"
 * with Jane Doe and so falls under the two-token threshold.
 *
 * The curly apostrophe is in the class deliberately - Graph returns display
 * names as the directory holds them, and a smart-quoted O’Brien is common
 * enough that treating it as a separator would silently disable the rule for
 * that name.
 */
const ELISION = /['’.]/g;
/** Unicode-aware, NOT [^a-z0-9]: an ASCII-only class wipes a Cyrillic or Greek
 * name to the empty set and switches this rule off for it entirely. */
const NON_ALPHANUMERIC = /[^\p{L}\p{N}]+/gu;

export function normalizeName(name: string): Set<string> {
  const folded = name
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLocaleLowerCase()
    .replace(ELISION, "")
    .replace(NON_ALPHANUMERIC, " ");
  // Length > 1: an initial must not match every name that starts with it.
  return new Set(folded.split(/\s+/).filter((token) => token.length > 1));
}

/**
 * Two shared tokens, or two equal mononyms.
 *
 * One shared token is worthless - every Jane in the CRM would surface for
 * every Jane. The single-token clause requires BOTH sets to be single-token:
 * relaxing it to "either" readmits exactly the one-shared-token case the
 * threshold exists to reject, since a bare "Jane" would then match every
 * multi-token name containing it.
 */
export function similar(a: Set<string>, b: Set<string>): boolean {
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  if (shared >= 2) return true;
  return a.size === 1 && b.size === 1 && shared === 1;
}

/**
 * Cached candidates that might be this attendee under a different address.
 *
 * Colleagues are excluded because matchAttendees routes them to `excluded` - a
 * Use button for one would add a target the matcher considers noise, and the
 * row would not resolve. The email exclusion is belt and braces: such a contact
 * would have matched already and the row would not be unmatched.
 */
export function similarContacts({
  name,
  address,
  contacts,
}: {
  name: string;
  address: string;
  contacts: OdooContact[];
}): OdooContact[] {
  const target = normalizeName(name);
  // Nothing usable to compare. Returning [] rather than every contact whose
  // name also normalises to nothing.
  if (target.size === 0) return [];
  const own = normalizeAddress(address);
  return contacts
    .filter(
      (c) =>
        c.active &&
        !c.isColleague &&
        (c.email === null || normalizeAddress(c.email) !== own) &&
        similar(target, normalizeName(c.name))
    )
    // `filter` already returned a fresh array, so this sort cannot reach the
    // caller's - see filterContacts (contact-ordering.ts:44) for the bug that
    // rule exists to prevent.
    .sort(byRecency)
    .slice(0, MAX_SIMILAR);
}

/**
 * Two unrelated people share gmail.com. Inferring from a free-mail domain
 * attaches a stranger's company to a new contact, and the user is being invited
 * to accept a prefilled value - a confident-looking wrong guess is worse than a
 * blank field.
 *
 * Being incomplete is SAFE: an unlisted free-mail domain degrades to the
 * ordinary path, which needs at least one cached contact on that domain with a
 * parent before it proposes anything.
 */
const FREE_MAIL: ReadonlySet<string> = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com",
  "yahoo.com", "yahoo.co.uk", "icloud.com", "me.com", "aol.com",
  "proton.me", "protonmail.com", "gmx.com", "gmx.de", "mail.com",
  "qq.com", "163.com",
]);

/** The part after the LAST "@", lowercased, or null when there is none. */
function domainOf(address: string): string | null {
  const at = address.lastIndexOf("@");
  if (at === -1) return null;
  const domain = address.slice(at + 1).trim().toLocaleLowerCase();
  return domain === "" ? null : domain;
}

/**
 * A prefill, NEVER a silent write. The user sees the result in the form and can
 * clear or change it before confirming.
 */
export function inferCompany({
  address,
  contacts,
}: {
  address: string;
  contacts: OdooContact[];
}): number | null {
  const domain = domainOf(address);
  if (domain === null || FREE_MAIL.has(domain)) return null;

  const tally = new Map<number, number>();
  for (const c of contacts) {
    if (!c.active || c.parentId === null || c.email === null) continue;
    if (domainOf(c.email) !== domain) continue;
    tally.set(c.parentId, (tally.get(c.parentId) ?? 0) + 1);
  }

  let winner: number | null = null;
  let best = 0;
  for (const [parentId, count] of tally) {
    // Ties break on the LOWEST id, for the same reason preferForDuplicateEmail
    // does (match-attendees.ts:52-55): stable across syncs in a way `name` is
    // not, and deterministic beats arbitrary when both are imperfect.
    if (count > best || (count === best && winner !== null && parentId < winner)) {
      winner = parentId;
      best = count;
    }
  }
  if (winner === null) return null;

  // The Company control lists cached contacts with isCompany === true. A winner
  // absent from that set cannot be displayed or re-selected, so prefilling it
  // would seed the field with a value the user can neither see nor clear.
  return contacts.some((c) => c.id === winner && c.isCompany) ? winner : null;
}
