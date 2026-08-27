import type { OdooOpportunity } from "@/types";
import type { OdooClient } from "./client";
import { odooError } from "./errors";
import { many2one } from "./many2one";
import type { XmlRpcValue } from "./xmlrpc-codec";

export const OPPORTUNITY_LIMIT = 20;

/**
 * The one live call the picker makes when you select a client.
 *
 * BOTH KINDS of crm.lead, leads and opportunities. They are one table in Odoo
 * separated by the `type` column, `meeting-log-push` already resolves any
 * non-null lead_id to the `crm.lead` model, and a meeting held about an
 * unconverted lead belongs on that lead - not on the contact record, which is
 * where it would land if the picker pretended the lead did not exist.
 *
 * Matched by `partner_id` for both kinds, which is the one caveat worth
 * knowing: a lead that was never linked to a partner (Odoo's own default for
 * an unconverted lead is to hold `contact_name`/`email_from` and no
 * `partner_id`) cannot be found this way and will not be listed.
 *
 * `probability < 100` rather than `active = true` alone: in Odoo active = false
 * means LOST, while WON opportunities stay active forever - so filtering only
 * on active would list every deal ever closed with that partner. It holds for
 * leads too: a lead is converted before it can be won, so a live one is never
 * at 100.
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
  contactId: number,
  parentId: number | null
): Promise<OdooOpportunity[]> {
  const partnerIds = parentId === null ? [contactId] : [contactId, parentId];
  const domain: XmlRpcValue[] = [
    ["partner_id", "in", partnerIds],
    ["type", "in", ["lead", "opportunity"]],
    ["active", "=", true],
    ["probability", "<", 100],
  ];

  const rows = await client.execute("crm.lead", "search_read", [domain], {
    fields: ["id", "name", "type", "stage_id", "partner_id", "probability"],
    order: "write_date desc",
    limit: OPPORTUNITY_LIMIT,
  });

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
    };
  });
}
