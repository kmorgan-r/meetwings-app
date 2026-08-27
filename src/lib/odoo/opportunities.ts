import type { OdooContact, OdooOpportunity } from "@/types";
import type { OdooClient } from "./client";
import { odooError } from "./errors";
import { many2one } from "./many2one";
import type { XmlRpcValue } from "./xmlrpc-codec";

export const OPPORTUNITY_LIMIT = 20;

/**
 * Everything the lookup reads off the selected contact.
 *
 * Narrow on purpose. Both callers hand it a whole `OdooContact` and it is
 * structurally compatible, but the lookup has no business with the rest of
 * that record, and its tests get to build a four-field object.
 */
export type OpportunityLookupContact = Pick<
  OdooContact,
  "id" | "parentId" | "name" | "email"
>;

/**
 * The search domain, in Odoo PREFIX notation: an operator applies to the
 * sub-expressions that follow it, "&" and "|" are binary, and the top-level
 * items are implicitly AND-ed together.
 *
 * A crm.lead reaches this list two ways, and they are not the same kind of
 * claim:
 *
 *  1. `partner_id` is the contact or their parent company. AUTHORITATIVE -
 *     Odoo itself says this record belongs to that partner. Both kinds of
 *     crm.lead are found this way, and it is the only way an opportunity is.
 *
 *  2. An UNLINKED lead whose own `contact_name` or `email_from` matches the
 *     contact. A HEURISTIC, and the reason it exists is that Odoo default for
 *     an unconverted lead is exactly this: free-text contact details and NO
 *     partner at all. Rule 1 finds none of those, which is why a real Leads
 *     list looked empty here the first time leads were offered.
 *
 *     Narrowed to `partner_id = false` deliberately. A lead already pointed
 *     at a DIFFERENT partner belongs to that partner whatever name it
 *     carries, and must not surface under this contact.
 *
 * `=ilike`, never `ilike`: Odoo wraps a bare `ilike` value in `%...%`, so
 * "ada@x.com" would also match "notada@x.com". `=ilike` is exact and
 * case-insensitive, which is the comparison actually wanted here.
 *
 * The won filter is scoped to opportunities. `probability < 100` means "not
 * won", and a LEAD is never won - it is converted (which flips `type`) or
 * lost (which clears `active`). Applying it to leads buys nothing and risks
 * dropping every one of them: `probability` is nullable in Postgres, and
 * NULL < 100 is NULL, i.e. excluded.
 */
export function searchDomain(contact: OpportunityLookupContact): XmlRpcValue[] {
  const partnerIds =
    contact.parentId === null ? [contact.id] : [contact.id, contact.parentId];

  // At most two, so at most one "|" is ever needed to join them.
  const identity: XmlRpcValue[] = [];
  if (contact.email) identity.push(["email_from", "=ilike", contact.email]);
  const name = contact.name.trim();
  if (name) identity.push(["contact_name", "=ilike", name]);

  const linked: XmlRpcValue = ["partner_id", "in", partnerIds];

  const base: XmlRpcValue[] = [
    ["active", "=", true],
    // `type` has exactly these two values in stock Odoo, so this is a
    // statement of intent rather than a filter - and a guard if an install
    // ever adds a third.
    ["type", "in", ["lead", "opportunity"]],
    "|",
    ["type", "=", "lead"],
    ["probability", "<", 100],
  ];

  // Nothing to recognise an unlinked lead BY. Ask only for what Odoo can
  // answer authoritatively rather than widening the search on a blank value.
  if (identity.length === 0) return [...base, linked];

  const identityExpr: XmlRpcValue[] =
    identity.length === 2 ? ["|", identity[0], identity[1]] : [identity[0]];

  return [
    ...base,
    "|",
    linked,
    "&",
    "&",
    ["type", "=", "lead"],
    ["partner_id", "=", false],
    ...identityExpr,
  ];
}

/**
 * The one live call the picker makes when you select a client.
 *
 * BOTH KINDS of crm.lead, leads and opportunities. They are one table in Odoo
 * separated by the `type` column, `meeting-log-push` already resolves any
 * non-null lead_id to the `crm.lead` model, and a meeting held about an
 * unconverted lead belongs on that lead - not on the contact record, which is
 * where it would land if the picker pretended the lead did not exist.
 *
 * How each kind is reached, and why an unlinked lead needs a clause of its
 * own, is on `searchDomain`.
 *
 * ONE query, and its `limit` is a shared budget across both kinds. Two queries
 * would double the throw surface of the one live call the picker makes, and
 * add a round trip to the live-meeting path.
 *
 * This THROWS on the first unreadable row, where syncContacts skips and counts.
 * The asymmetry is deliberate, not an oversight. In the sync, failing the run
 * leaves the watermark unadvanced, so one malformed partner among thousands
 * wedges syncing permanently with no way past it. Here nothing is wedged: the
 * target is already committed to the contact BEFORE this call runs, the
 * failure lands in `opportunityError` beside a Retry button, and the user
 * keeps a working contact-only selection. Loud beats partial when a partial
 * list means "no open deals" - which is the sentence that sends slice 2 to
 * the wrong record.
 */
export async function fetchOpportunities(
  client: OdooClient,
  contact: OpportunityLookupContact
): Promise<OdooOpportunity[]> {
  const rows = await client.execute("crm.lead", "search_read", [searchDomain(contact)], {
    fields: LEAD_FIELDS,
    order: "write_date desc",
    limit: OPPORTUNITY_LIMIT,
  });

  return mapLeadRows(rows);
}

export const LEAD_SEARCH_LIMIT = 10;
/** Below this the search is not run at all - see `searchLeads`. */
export const LEAD_SEARCH_MIN_CHARS = 2;

/**
 * Free-text search across crm.lead, for records the contact-first flow cannot
 * reach at all.
 *
 * `fetchOpportunities` starts from a res.partner, which is the right shape for
 * every record Odoo has linked to one. A lead that was never converted has no
 * partner - not one that is hard to find, one that does not exist - so there
 * is nothing to select first and no lookup to hang off it. This is the only
 * way such a record is reachable.
 *
 * `ilike` here, deliberately the opposite of the identity match in
 * `searchDomain`. That one asks "is this the same person" and must be exact;
 * this one is a user typing a fragment into a search box, where the wrapping
 * `%...%` is the whole point.
 *
 * Four fields, because a lead is found by whatever it happens to carry: the
 * subject line (`name`), the person (`contact_name`), the company
 * (`partner_name`) and the address it arrived from (`email_from`).
 */
export function leadSearchDomain(query: string): XmlRpcValue[] {
  return [
    ["active", "=", true],
    // Same reasoning as searchDomain: a lead is never won, and `probability`
    // is nullable, so NULL < 100 would exclude every one of them.
    "|",
    ["type", "=", "lead"],
    ["probability", "<", 100],
    "|",
    "|",
    "|",
    ["name", "ilike", query],
    ["contact_name", "ilike", query],
    ["partner_name", "ilike", query],
    ["email_from", "ilike", query],
  ];
}

export async function searchLeads(
  client: OdooClient,
  query: string
): Promise<OdooOpportunity[]> {
  const trimmed = query.trim();
  // A one-character `ilike` matches a large fraction of any real CRM, and an
  // empty one matches ALL of it. Returning nothing is the honest answer to a
  // query that has not been typed yet - and it keeps the call off the wire on
  // the way to a real one.
  if (trimmed.length < LEAD_SEARCH_MIN_CHARS) return [];

  const rows = await client.execute("crm.lead", "search_read", [leadSearchDomain(trimmed)], {
    fields: LEAD_FIELDS,
    order: "write_date desc",
    limit: LEAD_SEARCH_LIMIT,
  });

  return mapLeadRows(rows);
}

const LEAD_FIELDS = [
  "id",
  "name",
  "type",
  "stage_id",
  "partner_id",
  "probability",
  // The free text an UNLINKED lead carries instead of a partner. Read so the
  // row can show WHO it is about - without it such a lead renders as a bare
  // subject line with nothing on it tying it to the contact on screen.
  "contact_name",
  "email_from",
];

/**
 * Shared by both reads, and it THROWS on the first unreadable row rather than
 * skipping it - see `fetchOpportunities` for why loud beats partial here.
 */
function mapLeadRows(rows: unknown): OdooOpportunity[] {
  if (!Array.isArray(rows)) {
    throw odooError("ODOO_UNEXPECTED_ROW", "Odoo returned a non-list from search_read");
  }

  return rows.map((raw) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw odooError("ODOO_UNEXPECTED_ROW", "Odoo returned an opportunity that is not a record");
    }
    const row = raw as Record<string, unknown>;
    if (typeof row.id !== "number" || !Number.isInteger(row.id)) {
      throw odooError("ODOO_UNEXPECTED_ROW", "Odoo returned an opportunity with no usable id");
    }
    const stage = many2one(row.stage_id);
    const partner = many2one(row.partner_id);
    return {
      id: row.id,
      name: typeof row.name === "string" ? row.name : `Opportunity ${row.id}`,
      // Anything that is not literally "lead" reads as an opportunity, which
      // is the pre-existing behaviour of this function for every row it has
      // ever returned. An unreadable `type` must not promote a deal to a
      // "Lead" label - the label is what the user picks by.
      type: row.type === "lead" ? "lead" : "opportunity",
      stageName: stage?.name ?? null,
      // Surfaced in the popover so it is visible WHICH record a deal hangs off
      // - the contact, or their company.
      partnerId: partner?.id ?? null,
      partnerName: partner?.name ?? null,
      // Odoo returns `false`, not "", for an empty char field.
      contactName: typeof row.contact_name === "string" ? row.contact_name : null,
      email: typeof row.email_from === "string" ? row.email_from : null,
    };
  });
}
