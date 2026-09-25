import {
  deleteContact,
  listContactIds,
  loadTargets,
  removeSelectedTarget,
} from "@/lib/database/odoo-contacts.action";
import type { OdooClient } from "./client";
import { PARTNER_TYPE_LEAVES } from "./contacts-sync";
import { odooError } from "./errors";

/** `search` returns bare ids, so a page this big is a few KB. */
export const ID_PAGE_LIMIT = 2000;

/** Below this the "looks like a permissions change" guard is not applied. */
const MIN_GUARDED_CACHE = 10;

/**
 * Removes cached contacts Odoo no longer has.
 *
 * `syncContacts` cannot: it pulls `write_date > watermark`, and a deleted
 * record never appears in that result, so it lingers as a live-looking row and
 * the picker keeps offering an id that `message_post` will refuse.
 *
 * Reads the LOCAL ids first, then Odoo's. A contact created between the two
 * reads is in Odoo's answer but not in the local snapshot, so it is never a
 * candidate; the reverse order could delete it. Any failure while enumerating
 * throws before anything is deleted, so a partial answer can never look like
 * a deletion.
 */
export async function reconcileDeletedContacts(deps: {
  client: OdooClient;
  instance: string;
}): Promise<number> {
  const { client, instance } = deps;

  const local = await listContactIds(instance);
  if (local.length === 0) return 0;

  const live = new Set<number>();
  let cursor = 0;
  for (;;) {
    const page = await client.execute(
      "res.partner",
      "search",
      [[["id", ">", cursor], ...PARTNER_TYPE_LEAVES]],
      { order: "id asc", limit: ID_PAGE_LIMIT, context: { active_test: false } }
    );
    if (!Array.isArray(page)) {
      throw odooError("ODOO_UNEXPECTED_ROW", "Odoo returned a non-list from search");
    }
    let pageMax = cursor;
    for (const id of page) {
      if (typeof id !== "number" || !Number.isInteger(id)) {
        throw odooError("ODOO_UNEXPECTED_ROW", "Odoo returned a partner id that is not an integer");
      }
      live.add(id);
      if (id > pageMax) pageMax = id;
    }
    // The domain says id > cursor, so a non-empty page that does not move the
    // cursor is a broken answer, and retrying it forever would spin.
    if (page.length > 0 && pageMax === cursor) {
      throw odooError(
        "ODOO_UNEXPECTED_ROW",
        "Odoo returned a page of partner ids the cursor cannot advance past",
        { cursor }
      );
    }
    cursor = pageMax;
    if (page.length < ID_PAGE_LIMIT) break;
  }

  // An empty answer for a non-empty cache is a bad response, not a wiped Odoo.
  if (live.size === 0) return 0;

  const stale = local.filter((id) => !live.has(id));
  if (stale.length === 0) return 0;

  // Most of a real-sized cache "deleted" at once is far likelier a permissions
  // change than a purge, and unlike a true deletion it is reversible in Odoo
  // while the watermark sync would never restore these rows.
  if (local.length >= MIN_GUARDED_CACHE && stale.length * 2 > local.length) {
    console.warn(
      `[Odoo] contact reconcile skipped: ${stale.length} of ${local.length} cached contacts ` +
        "look deleted, which is more likely a permissions change"
    );
    return 0;
  }

  const pinned = await loadTargets(instance);
  for (const id of stale) {
    if (pinned.some((t) => t.model === "res.partner" && t.resId === id)) {
      await removeSelectedTarget(instance, "res.partner", id);
    }
    await deleteContact(instance, id);
  }
  return stale.length;
}
