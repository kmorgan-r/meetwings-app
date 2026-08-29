import { getDatabase } from "@/lib/database/config";
import {
  assignQueueRow,
  deleteQueueRow,
  deleteTerminalQueueRow,
  deriveRowStatus,
  getQueueRow,
  listTargets,
  pruneTranscripts,
  QUEUE_SQL,
  retryQueueRow,
} from "@/lib/database/meeting-log.action";
import { generateMeetingLogSummary } from "@/lib/functions/meeting-summarizer";
import {
  instanceFingerprint,
  requireOdooConfig,
} from "@/lib/storage/odoo-config.storage";
import type { SelectedTargets, SummarizationResult } from "@/types";
import { createOdooClient, type OdooClient } from "./client";
import { reportOdooError, type OdooErrorReport } from "./errors";
import { SUMMARIZE_TIMEOUT_MS, type TranscriptSlice } from "./meeting-log";
import { pushQueuedRow } from "./meeting-log-push";

/**
 * Orchestration for the queue page.
 *
 * THIS MODULE NEVER CALLS `runMeetingLogSweep` OR `reclaimStaleSending`. It
 * runs in the dashboard window, whose `claimed` set is empty, so a reclaim from
 * here would re-`pending` a row the main window has in flight: two attachments
 * and two customer-visible chatter notes. `pushQueuedRow` alone is safe, and
 * that is an owner ruling - `claimRow`'s own WHERE clause refuses every
 * `sending` row, which is what actually prevents the double push.
 */

/** What the page renders. Conflating any two of these teaches users to distrust it. */
export type ActionOutcome =
  | { kind: "ok" }
  | { kind: "degraded" }
  | { kind: "no-op" }
  | { kind: "still-sending" }
  | { kind: "push-failed" }
  /**
   * At least one target reached Odoo and at least one did not, read from the
   * AFTER-STATE of every target (not the delta this pass produced) - a retry
   * that re-faults the same target must still report the targets that were
   * already sent, not fall through to `push-failed`'s "nothing was sent" copy.
   */
  | { kind: "push-partial"; sentCount: number; failedCount: number; pendingCount: number }
  | { kind: "conflict" }
  | { kind: "moved-unknown" }
  /**
   * Deleted, but the row had already reached Odoo (or been cancelled) before
   * the click landed. Distinct from `ok` because `ok`'s copy states that
   * nothing was sent, and here something was.
   */
  | { kind: "deleted-after-send" }
  | { kind: "failed"; report: OdooErrorReport };

/** The shape `useApp()` supplies. Structural, so the page owns the context. */
export interface ProviderConfigLike {
  provider?: unknown;
  selectedProvider?: unknown;
}

export interface ActionDeps {
  providerConfig: ProviderConfigLike | null;
  /**
   * No caller passes this today. `AssignDialog` builds its own client via its
   * own `getClient()` for its own contact and opportunity lookups, and does
   * not put it on the Confirm payload it hands up.
   *
   * `runAction` DELIBERATELY NEVER READS THIS and rebuilds from the config it
   * just resolved. `instanceFingerprint` is url|db only, so a login or API-key
   * rotation while the dialog sat open still matches the fingerprint - pushing
   * with the dialog's client would hit revoked credentials and record a
   * spurious ODOO_AUTH_FAILED against a row that was fine. `createOdooClient`
   * is synchronous and does no I/O, so reuse would buy nothing. Do not
   * "optimise" this into `deps.client ?? createOdooClient(config)`.
   *
   * It exists anyway so the "never reuse a caller's client" contract is
   * expressible in the type and testable - see the stale-client sentinel case
   * in `meeting-log-actions.test.ts`.
   */
  client?: OdooClient;
  /**
   * Fired the instant the CAS commits, BEFORE the push runs.
   *
   * The page must re-read the list immediately after the CAS as well as after
   * the push - otherwise the row renders its pre-click status for the whole
   * push, which can be five 30s Odoo calls plus a summarize. Without this hook
   * the page has no way to observe that moment: `runAction` owns the CAS
   * internally and its promise resolves only after both re-reads.
   */
  onCommitted?: () => void;
}

/**
 * The summarize dep, bounded.
 *
 * Two jobs. It carries the provider config through - a dep that cannot reach
 * the provider sends every assign down the fallback-body path - and it RACES
 * the call against SUMMARIZE_TIMEOUT_MS, because `fetchAIResponse` has no
 * timeout and an unbounded summarize is the one way a dashboard push crosses
 * STALE_CLAIM_MS.
 *
 * `didSummarize` is exposed so the caller can tell a real summary from the
 * fallback: generateMeetingLogSummary returns null identically for a MISSING
 * provider and for a FAILING one, and pushQueuedRow swallows that a second
 * time - so without this the row reaches `sent` with last_error cleared and the
 * page reports unqualified success while a "Summarization failed" note is live
 * on the customer's record.
 */
export function boundedSummarize(providerConfig: ProviderConfigLike | null): {
  summarize: (slice: TranscriptSlice) => Promise<SummarizationResult | null>;
  didSummarize: () => boolean | null;
} {
  let produced: boolean | null = null;

  const summarize = async (slice: TranscriptSlice): Promise<SummarizationResult | null> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        generateMeetingLogSummary(slice.entries, providerConfig as never),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), SUMMARIZE_TIMEOUT_MS);
        }),
      ]);
      produced = result !== null;
      return result;
    } catch {
      // UNREACHABLE TODAY, kept as defence in depth. generateMeetingLogSummary
      // catches everything and returns null (meeting-summarizer.ts:475-478),
      // and the timeout leg only ever resolves - so every real failure already
      // arrives as `null` and sets produced = false above. The actual guard
      // keeping an AI error out of last_error is the summarizer's own catch
      // plus meeting-log-push.ts:205-211, NOT this line; do not read it as the
      // redaction boundary.
      produced = false;
      return null;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };

  return { summarize, didSummarize: () => produced };
}

/**
 * The shared tail: resolve, CAS, re-read, push, re-read, classify.
 *
 * `cas` runs AFTER the credentials resolve. That ordering is the whole point -
 * requireOdooConfig throws for exactly the half-filled config a user comes to
 * this page to fix, and with the CAS first that throw lands with the row
 * already flipped and its last_error already NULLed.
 */
async function runAction(
  id: string,
  cas: () => Promise<boolean>,
  deps: ActionDeps
): Promise<ActionOutcome> {
  let client: OdooClient;
  let instance: string;
  try {
    const config = await requireOdooConfig();
    instance = instanceFingerprint(config.url, config.db);
    // ALWAYS built from the config just resolved, never reused from the dialog.
    // instanceFingerprint is url|db only, so a login or API-key rotation while
    // the dialog sat open still matches the fingerprint - and pushing with the
    // dialog's stale client would hit revoked credentials and record a spurious
    // ODOO_AUTH_FAILED. createOdooClient is synchronous and does no I/O, so
    // reuse buys nothing here. No caller passes `deps.client` today - see its
    // doc comment on ActionDeps for why the member stays anyway.
    client = createOdooClient(config);
  } catch (err) {
    // Nothing has been written. The row is genuinely unchanged.
    return { kind: "failed", report: reportOdooError(err, "meeting log action") };
  }

  // BEFORE the CAS. An other-instance row must not even be attempted -
  // pushQueuedRow returns silently on a mismatch - but checking it AFTER the
  // CAS means retryRow/assignRow have already NULLed last_error and
  // last_error_code, leaving a foreign-instance row `pending` with its only
  // diagnostic destroyed on a database this install no longer points at.
  // `selectSweepable` filters by instance, so nothing ever picks it up again,
  // and the `no-op` copy would promise a retry that can never happen. Reachable
  // exactly in the scenario Task 8 names: a credentials change between render
  // and click.
  try {
    const before = await getQueueRow(id);
    if (!before) return { kind: "moved-unknown" };
    if (before.instance !== instance) return { kind: "conflict" };
  } catch (err) {
    return { kind: "failed", report: reportOdooError(err, "meeting log action") };
  }

  let committed = false;
  try {
    if (!(await cas())) return { kind: "conflict" };
    committed = true;
    // Before the push, so the page can repaint the row's real status for the
    // duration rather than leaving the pre-click status on screen.
    deps.onCommitted?.();

    const fresh = await getQueueRow(id);
    if (!fresh) return { kind: "moved-unknown" };

    const { summarize, didSummarize } = boundedSummarize(deps.providerConfig);
    // `now` sampled HERE, never carried from the credential step: claimRow
    // writes it into claimed_at, and a pre-aged claimed_at makes the row
    // eligible for the main window's reclaim while this push is still live.
    await pushQueuedRow(fresh, {
      client,
      instance,
      now: () => Date.now(),
      summarize,
    });

    const after = await getQueueRow(id);
    if (!after) return { kind: "moved-unknown" };

    // attempts unchanged => the claim never happened => the push never reached
    // Odoo. One of pushQueuedRow's four silent early exits.
    if (after.attempts === fresh.attempts) return { kind: "no-op" };
    // Claimed, but left `sending` with no error: the terminal status write
    // itself failed and the inner catch deliberately wrote nothing. An
    // attempts-only comparison would call this success.
    if (after.status === "sending") return { kind: "still-sending" };

    // THE PUSH CAN ALSO HAVE FAILED, and neither check above sees it.
    // pushQueuedRow records every per-target outcome on the children, then
    // derives the parent's status from them (deriveRowStatus, called once
    // after the per-target loop) - so a retryable failure leaves the row
    // `pending` and a deterministic one leaves it `failed`, both already
    // bumped `attempts` via the claim and both with last_error written from
    // whichever target carried a reason. Without a gate here such a row falls
    // through to `degraded` or `ok` - and one network outage produces exactly
    // that pairing, because it kills the Odoo call AND the AI call, and
    // generateMeetingLogSummary swallows its throw and returns null. The page
    // would then print "Sent - but the note shows the transcript's first
    // lines" directly beside the row's own freshly written last_error, telling
    // the user a note is live on a customer's record when nothing reached Odoo.
    //
    // But the PARENT'S status alone is not the whole story on a multi-target
    // row: a pass that lands notes on two of three targets derives `pending`
    // or `failed` on the parent (deriveRowStatus's precedence, rule 1/2), so a
    // blanket `after.status !== "sent"` here would tell the user NOTHING was
    // sent while two notes are already live on two customers' chatter - the
    // falsehood this task exists to remove. Re-read the children (the parent
    // alone cannot distinguish "0 sent" from "2 of 3 sent") and classify on
    // THEIR after-state, not the delta this pass produced: a retry that
    // re-faults the SAME target must still report the targets that were
    // already sent from an earlier pass, not fall through to push-failed's
    // "nothing was sent" copy just because this pass changed nothing.
    const targetsAfter = await listTargets(id);
    const sentCount = targetsAfter.filter((t) => t.status === "sent").length;
    const failedCount = targetsAfter.filter((t) => t.status === "failed").length;
    const pendingCount = targetsAfter.filter((t) => t.status === "pending").length;
    if (sentCount > 0 && (failedCount > 0 || pendingCount > 0)) {
      return { kind: "push-partial", sentCount, failedCount, pendingCount };
    }

    if (after.status !== "sent") return { kind: "push-failed" };

    if (didSummarize() === false) return { kind: "degraded" };
    return { kind: "ok" };
  } catch (err) {
    // The CAS committed and a later await threw. NOT "row unchanged".
    if (committed) return { kind: "moved-unknown" };
    return { kind: "failed", report: reportOdooError(err, "meeting log action") };
  }
}

/**
 * The whole-row retry's CAS. Flips the parent first via the real `retryRow`
 * predicate (`status IN ('failed','pending')`); only on a successful flip does
 * it reset every FAILED child to `pending` - never a `sent` one. Gating the
 * child writes on the parent CAS, rather than doing them first, means a
 * refused retry (the row moved to `sending` underneath the caller) leaves the
 * children untouched instead of resetting them out from under a push that may
 * already be mid-flight.
 *
 * The reset is the load-bearing half regardless of order: pushQueuedRow's loop
 * only picks up targets with status = 'pending' (meeting-log-push.ts:326), so
 * flipping only the parent leaves every failed target untouched and the next
 * push a no-op against exactly what the user clicked Retry to fix.
 */
async function retryRowAndFailedChildren(id: string): Promise<boolean> {
  if (!(await retryQueueRow(id))) return false;
  const db = await getDatabase();
  for (const t of await listTargets(id)) {
    if (t.status === "failed") {
      await db.execute(QUEUE_SQL.targetToPending, [null, null, t.id]);
    }
  }
  return true;
}

export function retryMeetingLog(id: string, deps: ActionDeps): Promise<ActionOutcome> {
  return runAction(id, () => retryRowAndFailedChildren(id), deps);
}

/** What a per-target action reports. Distinct from `ActionOutcome`: neither
 * function here ever pushes, so there is no `degraded`/`still-sending`/etc to
 * conflate with. */
export type TargetActionOutcome =
  | { kind: "ok" }
  | { kind: "gone" }
  | { kind: "refused" }
  | { kind: "conflict" };

/**
 * Retries ONE target on an otherwise-untouched row: resets that child to
 * `pending` and flips the parent back to `pending` so the next sweep or push
 * picks it up.
 */
export async function retryTarget(rowId: string, targetId: string): Promise<TargetActionOutcome> {
  const target = (await listTargets(rowId)).find((t) => t.id === targetId);
  if (!target) return { kind: "gone" };
  // Mirror removeQueueTarget: a sent target is immutable. targetToPending's
  // own `AND status <> 'sent'` is the backstop; this is the honest answer to
  // the caller - a silent no-op there would tell the UI a retry happened when
  // nothing was written.
  if (target.status === "sent") return { kind: "refused" };

  const db = await getDatabase();
  // The child reset is the load-bearing half: pushQueuedRow's loop only picks
  // up targets with status = 'pending' (meeting-log-push.ts:326), so flipping
  // only the parent leaves this a no-op against the very target the button
  // names.
  await db.execute(QUEUE_SQL.targetToPending, [null, null, targetId]);
  // retryRow's own predicate is `WHERE id = ? AND status IN ('failed','pending')`.
  // A row that moved to `sending` between the read above and this write
  // matches nothing - surface that as a refusal rather than a false `ok`.
  const res = await db.execute(QUEUE_SQL.retryRow, [rowId]);
  if ((res.rowsAffected ?? 0) === 0) return { kind: "conflict" };
  return { kind: "ok" };
}

/**
 * Removes one target from a row and re-derives the parent's status from what
 * remains - including the zero-target case, which lands on `unassigned`
 * (`deriveRowStatus` rule 0): a row with nothing left to send should not sit
 * in a `pending`/`failed` group implying otherwise.
 */
export async function removeQueueTarget(
  rowId: string, targetId: string
): Promise<TargetActionOutcome> {
  const target = (await listTargets(rowId)).find((t) => t.id === targetId);
  if (!target) return { kind: "gone" };
  // Global Constraint: a sent target row is immutable - it is the only record
  // that the note exists at all.
  if (target.status === "sent") return { kind: "refused" };

  const before = (await getQueueRow(rowId))?.status;
  if (!before) return { kind: "gone" };
  // `held` is deliberately absent from DERIVE_FORBIDDEN in the DB layer -
  // nothing before this function ever calls deriveRowStatus with an observed
  // `held`, and doing so here would CAS the row out of `held` early, ending
  // the 30s undo window because a target happened to be removed mid-hold.
  // Refuse rather than become the first caller to reach that combination.
  if (before === "held") return { kind: "refused" };

  const db = await getDatabase();
  await db.execute(QUEUE_SQL.deleteTargetById, [targetId]);
  // The read-then-derive window is a real TOCTOU, but a fail-safe one: the CAS
  // inside deriveRowStatus turns a row that moved between the read above and
  // this call into zero rows affected - reported as a conflict, not silently
  // discarded.
  const { changed } = await deriveRowStatus(rowId, before, Date.now());
  if (!changed) return { kind: "conflict" };
  return { kind: "ok" };
}

export function assignMeetingLog(
  id: string, targets: SelectedTargets, deps: ActionDeps
): Promise<ActionOutcome> {
  return runAction(id, () => assignQueueRow(id, targets), deps);
}

/** No push, ever. Delete is a status flip and nothing reaches Odoo. */
export async function deleteMeetingLog(id: string): Promise<ActionOutcome> {
  // ORDER IS THE WHOLE POINT. deleteQueueRow refuses a terminal row, so its
  // success is proof - at the instant of the write, not at some earlier read -
  // that this meeting had not reached Odoo. Only that makes `ok`'s "Nothing was
  // sent to Odoo." a statement this function can actually stand behind.
  if (await deleteQueueRow(id)) return { kind: "ok" };
  // Still removed, exactly as the spec intends terminal rows to be. What
  // changes is only what the user is told about it.
  if (await deleteTerminalQueueRow(id)) return { kind: "deleted-after-send" };
  return { kind: "conflict" };
}

/**
 * Retention, behind a module-level single flight.
 *
 * Module scope, not a ref: it must survive a remount, the same reason
 * meeting-log-push's `claimed` is module scope.
 */
let prunedThisProcess = false;

/**
 * TEST-ONLY. Without it the latch is already true by the time a suite's prune
 * cases run - six describes render the hook first - and those cases would fail
 * against CORRECT code.
 */
export function resetTranscriptPruneGuard(): void {
  prunedThisProcess = false;
}

export async function runTranscriptPrune(now: number): Promise<void> {
  if (prunedThisProcess) return;
  prunedThisProcess = true;
  try {
    await pruneTranscripts(now);
  } catch (err) {
    // Logged and nothing else. It must never affect a launch and has no
    // user-visible surface to report to. Its OWN message, not the sweep's -
    // one shared chain makes a prune failure indistinguishable from a sweep
    // failure in the log.
    console.error("[Odoo] meeting log retention prune failed:", err);
  }
}
