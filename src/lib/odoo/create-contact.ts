import { normalizeAddress } from "@/lib/calendar/match-attendees";
import type { OdooContact } from "@/types";
import type { OdooClient } from "./client";
import { PARTNER_FIELDS, parsePartnerRow } from "./contacts-sync";
import { odooError } from "./errors";
import { expectInt } from "./expect";
import type { XmlRpcValue } from "./xmlrpc-codec";

/**
 * The four non-throwing results. Every failure throws an OdooError instead -
 * the hook maps that to its own `failed` member with the code.
 */
export type CreateOrAdoptOutcome =
  | { kind: "created"; contact: OdooContact }
  | { kind: "adopted-active"; contact: OdooContact }
  | { kind: "adopted-archived"; contact: OdooContact }
  | { kind: "created-invisible" };

/**
 * Which of several partners sharing one email wins.
 *
 * ACTIVE beats archived first: telling the user to go un-archive somebody while
 * a live partner with that email exists is the wrong instruction, and with
 * `limit: 1` and no `order` it is what Odoo would hand back at random.
 *
 * Then person over company, then lowest id - preferForDuplicateEmail's own
 * rules (match-attendees.ts:52-55), for the reasons stated there.
 */
function preferForAdoption(a: OdooContact, b: OdooContact): OdooContact {
  if (a.active !== b.active) return a.active ? a : b;
  if (a.isCompany !== b.isCompany) return a.isCompany ? b : a;
  return a.id <= b.id ? a : b;
}

function expectRows(value: XmlRpcValue, what: string): unknown[] {
  if (!Array.isArray(value)) {
    throw odooError("ODOO_UNEXPECTED_ROW", `Odoo returned a non-list from ${what}`);
  }
  return value;
}

/**
 * Find-by-email, create on miss, read back.
 *
 * The search is not merely a cache-staleness guard. `create` is not idempotent
 * and the commit-then-timeout window means a create that appears to fail may
 * have landed, so a retry adopts rather than duplicating - the same shape as
 * createOrAdoptAttachment (meeting-log-push.ts:270-287).
 *
 * `search_read` rather than `search`: the adopt path needs the full row anyway,
 * and a second round trip to fetch what the first could have returned buys
 * nothing.
 */
export async function createOrAdoptContact({
  client,
  address,
  name,
  parentId,
}: {
  client: OdooClient;
  address: string;
  name: string;
  parentId: number | null;
}): Promise<CreateOrAdoptOutcome> {
  // Lowercased on BOTH sides, like every other match in this feature. `=ilike`
  // because Odoo's `=` on a char field is case-sensitive.
  const email = normalizeAddress(address);

  const found = expectRows(
    await client.execute("res.partner", "search_read", [[["email", "=ilike", email]]], {
      fields: PARTNER_FIELDS,
      // An archived partner with that email is emphatically not an invitation
      // to create a second one.
      context: { active_test: false },
    }),
    "search_read"
  );

  if (found.length > 0) {
    const best = found.map(parsePartnerRow).reduce(preferForAdoption);
    return best.active
      ? { kind: "adopted-active", contact: best }
      : { kind: "adopted-archived", contact: best };
  }

  const id = expectInt(
    await client.execute("res.partner", "create", [
      {
        name,
        email,
        is_company: false,
        // EXPLICIT, not left to Odoo's default. The sync domain excludes
        // delivery/invoice/other (contacts-sync.ts:118-124), so a partner
        // created with any of those types is invisible to this app forever -
        // the user would create a contact, watch the row stay greyed, and
        // create another.
        type: "contact",
        // `false`, not null: Odoo reads false as unset for a many2one, and null
        // is not a valid XML-RPC value here.
        parent_id: parentId ?? false,
      },
    ]),
    "partner id"
  );

  const back = expectRows(
    await client.execute("res.partner", "search_read", [[["id", "=", id]]], {
      fields: PARTNER_FIELDS,
      context: { active_test: false },
    }),
    "search_read"
  );

  // Record rules can hide a record from the API user that created it. Do NOT
  // fabricate a cache row: a synthesised row produces a proposal row whose
  // target write then fails, or worse silently succeeds against a record the
  // user cannot see.
  if (back.length === 0) return { kind: "created-invisible" };

  return { kind: "created", contact: parsePartnerRow(back[0]) };
}
