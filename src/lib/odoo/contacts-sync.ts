import {
  claimSync,
  failSync,
  finishSync,
  getSyncState,
  purgeOtherInstances,
  releaseSync,
  upsertContacts,
} from "@/lib/database/odoo-contacts.action";
import type { OdooContact, SyncResult } from "@/types";
import type { OdooClient } from "./client";
import { odooError, OdooError, toOdooError } from "./errors";
import { computeWatermark } from "./watermark";
import type { XmlRpcValue } from "./xmlrpc-codec";

export const PAGE_LIMIT = 200;

export const PARTNER_FIELDS = [
  "id",
  "name",
  "email",
  "phone",
  "parent_id",
  "is_company",
  "active",
  "write_date",
  "type",
];

/** Odoo returns `false` for an unset field of any type. */
function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * A many2one is `[id, display_name]` or `false`. Nothing else is readable, and
 * guessing would put the wrong company name beside a contact.
 */
function many2one(value: unknown): { id: number; name: string } | null {
  if (Array.isArray(value) && typeof value[0] === "number" && typeof value[1] === "string") {
    return { id: value[0], name: value[1] };
  }
  return null;
}

export function parsePartnerRow(raw: unknown): OdooContact {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw odooError("ODOO_UNEXPECTED_ROW", "Odoo returned a partner that is not a record");
  }
  const row = raw as Record<string, unknown>;
  if (typeof row.id !== "number" || !Number.isInteger(row.id)) {
    throw odooError("ODOO_UNEXPECTED_ROW", "Odoo returned a partner with no usable id");
  }
  if (typeof row.write_date !== "string") {
    throw odooError("ODOO_UNEXPECTED_ROW", "Odoo returned a partner with no write_date", {
      id: row.id,
    });
  }
  const parent = many2one(row.parent_id);
  return {
    id: row.id,
    name: optionalString(row.name) ?? `Partner ${row.id}`,
    email: optionalString(row.email),
    phone: optionalString(row.phone),
    companyName: parent?.name ?? null,
    parentId: parent?.id ?? null,
    isCompany: row.is_company === true,
    active: row.active !== false,
    writeDate: row.write_date,
    // Never written by the sync - the cache owns them. Present only because
    // OdooContact is one type.
    isColleague: false,
    lastMeetingAt: null,
  };
}

/**
 * The incremental pull.
 *
 * Paging is keyset on `id`, not `offset`. With offset + order by write_date,
 * any partner edited mid-sync re-sorts to the end and shifts every later row
 * down one index; the next fetch starts one row late and exactly one partner
 * is never returned - and because its write_date is below the final watermark,
 * it is skipped PERMANENTLY. `id` is unique and immutable, so the cursor is
 * stable under concurrent edits.
 */
export async function syncContacts(deps: {
  client: OdooClient;
  instance: string;
  now: number;
}): Promise<SyncResult> {
  const { client, instance, now } = deps;

  // claimSync's own DB write can reject (disk I/O, plugin-sql failure) rather
  // than merely resolve false. That is a distinct outcome from a REFUSED claim
  // and must not surface as a raw driver error - everything in this module
  // throws OdooError. No claim was taken either way, so this is deliberately
  // its own try: it must not trip the finally below, which releases a claim
  // that was never held.
  let claimed: boolean;
  try {
    claimed = await claimSync(instance, now);
  } catch (err) {
    throw toOdooError(err);
  }
  // ODOO_SYNC_BUSY, not ODOO_INTERNAL. Another window syncing is a normal
  // outcome, not a fault: the caller must be able to ignore it rather than
  // paint the picker's cache red and tell the user Odoo is broken. Note this
  // throws BEFORE the try, so failSync is not called and no error marker is
  // written for it.
  if (!claimed) {
    throw odooError("ODOO_SYNC_BUSY", "A sync is already running in another window");
  }

  try {
    await purgeOtherInstances(instance);
    const state = await getSyncState(instance);
    const watermark = state?.last_write_date ?? null;

    let cursor = 0;
    let fetched = 0;
    let changed = 0;
    let skipped = 0;
    let maxWriteDate: string | null = null;
    let runStartedAt: string | null = null;

    for (;;) {
      const domain: XmlRpcValue[] = [];
      // OMITTED, not defaulted, on the first run. See the test.
      if (watermark !== null) domain.push(["write_date", ">", watermark]);
      domain.push(["id", ">", cursor]);
      domain.push(["type", "!=", "delivery"]);
      domain.push(["type", "!=", "invoice"]);
      domain.push(["type", "!=", "other"]);

      const page = await client.execute("res.partner", "search_read", [domain], {
        fields: PARTNER_FIELDS,
        order: "id asc",
        limit: PAGE_LIMIT,
        context: { active_test: false },
      });

      if (runStartedAt === null && client.serverDate) {
        const parsed = new Date(client.serverDate);
        if (!Number.isNaN(parsed.getTime())) {
          runStartedAt = parsed.toISOString().slice(0, 19).replace("T", " ");
        }
      }

      if (!Array.isArray(page)) {
        throw odooError("ODOO_UNEXPECTED_ROW", "Odoo returned a non-list from search_read");
      }

      const contacts: OdooContact[] = [];
      // The cursor advances from the RAW id, before parsing, and is applied
      // after the page. Advancing it only from successfully parsed rows means a
      // page whose rows ALL fail parsePartnerRow leaves the cursor exactly where
      // it was - and because a full page also means `page.length === PAGE_LIMIT`,
      // the loop re-requests the identical page forever, holding the claim,
      // burning requests, reporting nothing and never finishing.
      let pageMaxId = cursor;
      for (const raw of page) {
        const rawId = (raw as { id?: unknown } | null)?.id;
        if (typeof rawId === "number" && Number.isInteger(rawId)) {
          pageMaxId = Math.max(pageMaxId, rawId);
        }
        try {
          const contact = parsePartnerRow(raw);
          contacts.push(contact);
          if (maxWriteDate === null || contact.writeDate > maxWriteDate) {
            maxWriteDate = contact.writeDate;
          }
        } catch (err) {
          // Skipped, COUNTED and surfaced - not swallowed. Failing the run
          // would wedge syncing on one malformed partner.
          //
          // `instanceof`, not a code comparison on toOdooError's output: a
          // foreign throwable maps to ODOO_INTERNAL and must escape, and a
          // genuine ODOO_INTERNAL must escape too. Only a row we recognise as
          // unreadable is skippable.
          if (!(err instanceof OdooError) || err.code !== "ODOO_UNEXPECTED_ROW") throw err;
          skipped += 1;
        }
      }

      // The backstop for the loop above: if a non-empty page yielded no usable
      // id at all, the cursor cannot move and retrying is pointless. Fail the
      // run rather than spin - a failed run leaves the watermark alone and is
      // visible in the picker, which an infinite loop is not.
      if (page.length > 0 && pageMaxId === cursor) {
        throw odooError(
          "ODOO_UNEXPECTED_ROW",
          "Odoo returned a page of partners with no usable id - the sync cursor cannot advance",
          { cursor }
        );
      }
      cursor = pageMaxId;

      changed += await upsertContacts(instance, contacts, now);
      fetched += contacts.length;

      if (page.length < PAGE_LIMIT) break;
    }

    const next = computeWatermark(maxWriteDate, runStartedAt);
    // `next ?? watermark` - and NOT `?? ""`. A first run that returns zero rows
    // has neither, and must store NULL. See finishSync's doc comment: '' is sent
    // back as ["write_date", ">", ""] and faults permanently.
    await finishSync(instance, next ?? watermark, now, skipped);
    return { changed, fetched, skipped, clampSkipped: runStartedAt === null };
  } catch (err) {
    const asOdoo = toOdooError(err);
    // A DB write failing HERE must not replace the failure being reported. If
    // failSync throws, its rejection becomes the caught value and the real
    // ODOO_UNREACHABLE / ODOO_FAULT vanishes - the user is told the database
    // broke while the actual cause goes unrecorded. The error marker is a
    // convenience; the original error is the truth.
    await failSync(instance, asOdoo.code, now).catch(() => {});
    throw asOdoo;
  } finally {
    // On success AND on failure. Without this, one completed sync blocks every
    // Refresh for the next ten minutes.
    //
    // Swallowed for the same reason, and more sharply: a throw from a `finally`
    // replaces even a SUCCESSFUL return. The cost of swallowing is bounded - the
    // claim then expires on its own via the 10-minute takeover in claimSync.
    await releaseSync(instance).catch(() => {});
  }
}
