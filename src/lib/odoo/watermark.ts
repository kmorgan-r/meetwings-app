/**
 * Sync cursor arithmetic. Pure, and deliberately string-based.
 *
 * Odoo's write_date is zone-less UTC ('2026-08-04 12:00:00'). V8 parses that
 * as LOCAL time, so a naive parse -> subtract -> reformat on a UTC+2 machine
 * moves the watermark two hours FORWARD and permanently skips every partner
 * written inside that window.
 */

const ODOO_DATETIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

function toDate(odooUtc: string): Date {
  if (!ODOO_DATETIME.test(odooUtc)) {
    throw new Error(`Not an Odoo UTC datetime: ${odooUtc}`);
  }
  // The explicit Z is the whole point.
  return new Date(`${odooUtc.replace(" ", "T")}Z`);
}

function format(date: Date): string {
  return date.toISOString().slice(0, 19).replace("T", " ");
}

export function minusOneSecond(odooUtc: string): string {
  return format(new Date(toDate(odooUtc).getTime() - 1000));
}

/**
 * `write_date` has one-second granularity, so `>=` re-pulls the whole last
 * batch every run while `>` can drop a record written in the same second as
 * the watermark. We store max-minus-one-second and let the boundary second be
 * re-pulled; the guarded upsert makes that free.
 *
 * The clamp to `runStartedAt` (Odoo's own clock, from the first page's HTTP
 * Date header) is NOT optional. Keyset paging is stable, but a partner whose
 * edit brings it into the domain BEHIND the cursor is only caught next run if
 * its write_date exceeds the stored watermark. Without the clamp: a record
 * edited at T behind the cursor, plus any record ahead of the cursor edited at
 * T+2, gives max = T+2 and a watermark of T+1 - and the record at T is gone
 * for good.
 *
 * Returns null when the run returned no rows, which means "do not move".
 */
export function computeWatermark(
  maxWriteDate: string | null,
  runStartedAt: string | null
): string | null {
  if (maxWriteDate === null) return null;
  if (runStartedAt === null) return minusOneSecond(maxWriteDate);
  return minusOneSecond(maxWriteDate < runStartedAt ? maxWriteDate : runStartedAt);
}
