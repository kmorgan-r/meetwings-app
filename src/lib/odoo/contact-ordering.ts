import type { OdooContact } from "@/types";

/**
 * Search and ordering for the picker. Pure, and run in JS rather than SQL.
 *
 * That is deliberate: one async IPC round trip per keystroke has the same
 * out-of-order hazard as a network call (results for "ab" landing after
 * "abc"), SQLite's LIKE is case-insensitive for ASCII only - "øyvind" would
 * not match "Øyvind" - and raw input in a LIKE pattern makes a typed % match
 * the entire cache. It also makes the ordering genuinely unit-testable rather
 * than an assertion about a SQL string.
 */

function fold(value: string): string {
  return value.normalize("NFD").toLocaleLowerCase();
}

/** Colleagues, then most recently met, then alphabetical. */
export function compareContacts(a: OdooContact, b: OdooContact): number {
  if (a.isColleague !== b.isColleague) return a.isColleague ? -1 : 1;

  // Nulls last. SQLite does this under DESC; a JS comparator does not unless
  // told to, and "never met" is the common case.
  if (a.lastMeetingAt !== b.lastMeetingAt) {
    if (a.lastMeetingAt === null) return 1;
    if (b.lastMeetingAt === null) return -1;
    return b.lastMeetingAt - a.lastMeetingAt;
  }

  return a.name.localeCompare(b.name);
}

export function filterContacts(
  contacts: OdooContact[],
  query: string
): OdooContact[] {
  const needle = fold(query.trim());
  // `[...contacts]`, NOT `contacts`. The caller - ContactPicker's `visible`
  // memo - sorts this result in place, and an empty query is the DEFAULT state
  // every time the popover opens. Returning the caller's own array therefore
  // reorders the cache during render, on the most common path there is. That
  // exact bug already shipped in this repo once; see
  // src/tests/message-list.no-mutation.test.tsx.
  if (needle.length === 0) return [...contacts];
  return contacts.filter((contact) =>
    [contact.name, contact.email, contact.companyName].some(
      (field) => field !== null && fold(field).includes(needle)
    )
  );
}
