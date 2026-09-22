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
import { many2one } from "./many2one";
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

/** The sync domain's type leaves, shared by the page fetch and its fault-isolated re-fetches. */
const TYPE_FILTERS: XmlRpcValue[] = [
  ["type", "!=", "delivery"],
  ["type", "!=", "invoice"],
  ["type", "!=", "other"],
];

function expectRows(value: XmlRpcValue, what: string): unknown[] {
  if (!Array.isArray(value)) {
    throw odooError("ODOO_UNEXPECTED_ROW", `Odoo returned a non-list from ${what}`);
  }
  return value;
}

function expectIds(value: XmlRpcValue, what: string): number[] {
  const rows = expectRows(value, what);
  return rows.map((v, i) => {
    if (typeof v !== "number" || !Number.isInteger(v)) {
      throw odooError("ODOO_UNEXPECTED_ROW", `Odoo returned a non-integer id at index ${i} from ${what}`);
    }
    return v;
  });
}

const asFault = (err: unknown): OdooError | null =>
  err instanceof OdooError && err.code === "ODOO_FAULT" ? err : null;

/**
 * The fault-isolated row fetch. ONLY an ODOO_FAULT enters: any other
 * rejection re-throws and fails the run exactly as today. A batch that
 * faults is halved and both halves retried; a singleton that still faults
 * is recorded as skipped and the cursor moves past it. Successful rows
 * accumulate in `out.rows`.
 */
async function fetchRowsBisectingFaults(
  client: OdooClient,
  ids: number[],
  out: { rows: unknown[]; skippedIds: number[] }
): Promise<void> {
  if (ids.length === 0) return;
  const domain: XmlRpcValue[] = [["id", "in", ids], ...TYPE_FILTERS];
  let rows: XmlRpcValue;
  try {
    rows = await client.execute("res.partner", "search_read", [domain], {
      fields: PARTNER_FIELDS,
      context: { active_test: false },
    });
  } catch (err) {
    if (asFault(err) === null) throw err;
    const mid = Math.floor(ids.length / 2);
    if (mid === 0) {
      // Singleton: this record's read is what faults. Skip it, count it,
      // move the cursor past it - the run continues.
      out.skippedIds.push(ids[0]);
      return;
    }
    await fetchRowsBisectingFaults(client, ids.slice(0, mid), out);
    await fetchRowsBisectingFaults(client, ids.slice(mid), out);
    return;
  }
  out.rows.push(...expectRows(rows, "search_read"));
  // BISECTION HAPPENS ONLY IN THE FAULT CATCH. A successful read answered
  // EVERY id it was given - recursing into the second half here would re-fetch
  // it (duplicate rows, inflated fetched, O(log n) wasted RPCs per healthy
  // sub-batch).
}

/** Odoo returns `false` for an unset field of any type. */
function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
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
      domain.push(...TYPE_FILTERS);

      let page: XmlRpcValue;
      const isolatedSkips: number[] = [];
      try {
        page = await client.execute("res.partner", "search_read", [domain], {
          fields: PARTNER_FIELDS,
          order: "id asc",
          limit: PAGE_LIMIT,
          context: { active_test: false },
        });
      } catch (err) {
        // ONLY ODOO_FAULT enters the machinery. A transport failure (UNREACHABLE)
        // or a shape failure (UNEXPECTED_ROW) re-throws to the run-level catch:
        // bisection against a dead server burns calls to learn nothing, and a
        // shape drift is systemic, not per-record.
        if (asFault(err) === null) throw err;
        // 1. Re-fetch the same domain as an id-only PLAIN search. No `fields`
        // kwarg - plain search takes none, and a fields kwarg here is a
        // server-side fault that would make this whole machinery a no-op. A
        // read-side crash (a computed field raising for one record) happens on
        // READ, not on search, so this call names the page's ids without
        // tripping the fault.
        // 2. If THIS faults, the fault is domain/permission/server-shaped -
        // re-throw. The run fails honestly, as today.
        const ids = expectIds(
          await client.execute("res.partner", "search", [domain], {
            order: "id asc",
            limit: PAGE_LIMIT,
            context: { active_test: false },
          }),
          "search"
        );
        // 3-4. Bisect the reads; a singleton that still faults is skipped and
        // counted; the cursor moves past it.
        const isolated = { rows: [] as unknown[], skippedIds: [] as number[] };
        await fetchRowsBisectingFaults(client, ids, isolated);
        page = isolated.rows as XmlRpcValue;
        skipped += isolated.skippedIds.length;
        isolatedSkips.push(...isolated.skippedIds);
      }

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
      // after the page - so a row that fails parsePartnerRow cannot strand the
      // cursor on itself; the loop always moves past it. Should a multi-record
      // page still yield nothing ingestable, the zero-upsert breaker below
      // fails the run loudly instead.
      // `isolatedSkips` is a per-page `const number[]` declared beside `page`
      // above and RESET each iteration by re-declaration - its ids are folded
      // into pageMaxId below so the cursor moves past records the machinery
      // skipped (their write_date is unknown and stays above the watermark).
      let pageMaxId = cursor;
      for (const rawId of isolatedSkips) pageMaxId = Math.max(pageMaxId, rawId);
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

      // THE ZERO-UPSERT BREAKER. A page that listed MULTIPLE records and handed
      // the upsert ZERO rows is a systemic fault wearing a per-record fault's
      // clothes - the cursor would walk the whole table and the run would end
      // "successfully" with nothing ingested. Keyed on the rows HANDED to the
      // upsert, not on its return (that return counts genuinely-CHANGED rows and
      // is legitimately zero for unchanged data on a healthy re-sync). Whichever
      // route the zero came by - every singleton faulted, or every row failed
      // parse - the outcome is identical and loud, through the existing
      // failSync path.
      //
      // THE SINGLE-RECORD EXEMPTION (pageIdCount === 1): a page whose ONLY id
      // singleton-faulted is item 4's accepted fate - "a singleton id that still
      // faults is skipped and the cursor moves past it; the run continues" - not
      // a systemic fault: there is no table-walk to hide, the skip is counted and
      // surfaced, the watermark stays put so the record is re-fetched next run,
      // and the run recovers naturally the moment a healthy page-mate joins the
      // domain. Failing the run there would re-create the exact permanent wedge
      // this task removes, for a page the breaker's own harm rationale (the
      // silent total walk) does not describe. The breaker's named scenario - a
      // PARTNER_FIELDS drift faulting every read yet sparing the id-only search -
      // fires on every multi-record page and is unaffected.
      const pageIdCount = page.length + isolatedSkips.length;
      if (pageIdCount > 1 && contacts.length === 0) {
        throw odooError(
          "ODOO_UNEXPECTED_ROW",
          `a page listed ${pageIdCount} partner records and none could be ingested - the field list or domain no longer matches this server`,
          { cursor, pageIds: pageIdCount }
        );
      }

      // The break keys on the page's ID count, not its row count: a
      // fault-isolated page is short because records were skipped, not because
      // the table ended. On a non-faulting page the two are the same number.
      if (pageIdCount < PAGE_LIMIT) break;
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
