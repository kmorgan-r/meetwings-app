import {
  assignQueueRow,
  deleteQueueRow,
  getQueueRow,
  pruneTranscripts,
  retryQueueRow,
} from "@/lib/database/meeting-log.action";
import { generateMeetingLogSummary } from "@/lib/functions/meeting-summarizer";
import {
  instanceFingerprint,
  requireOdooConfig,
} from "@/lib/storage/odoo-config.storage";
import type { DbMeetingLogRow, SummarizationResult } from "@/types";
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
  | { kind: "conflict" }
  | { kind: "moved-unknown" }
  | { kind: "failed"; report: OdooErrorReport };

/** The shape `useApp()` supplies. Structural, so the page owns the context. */
export interface ProviderConfigLike {
  provider?: unknown;
  selectedProvider?: unknown;
}

export interface ActionDeps {
  providerConfig: ProviderConfigLike | null;
  /**
   * The dialog's OWN client, for its OWN contact and opportunity lookups.
   *
   * `runAction` DELIBERATELY IGNORES THIS and rebuilds from the config it just
   * resolved. `instanceFingerprint` is url|db only, so a login or API-key
   * rotation while the dialog sat open still matches the fingerprint - pushing
   * with the dialog's client would hit revoked credentials and record a
   * spurious ODOO_AUTH_FAILED against a row that was fine. `createOdooClient`
   * is synchronous and does no I/O, so reuse would buy nothing. Do not
   * "optimise" this into `deps.client ?? createOdooClient(config)`.
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
    // reuse buys nothing here. `deps.client` stays for the dialog's OWN contact
    // and opportunity lookups, which is where the saved `authenticate` matters.
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
    await pushQueuedRow(fresh as DbMeetingLogRow, {
      client,
      instance,
      now: Date.now(),
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
    // pushQueuedRow's post-wire catch calls releaseRowToPending (retryable) or
    // failRow (deterministic); BOTH already bumped `attempts` via the claim and
    // BOTH leave a non-`sending` status with last_error written
    // (meeting-log-push.ts:282-305). Without this gate such a row falls through
    // to `degraded` or `ok` - and one network outage produces exactly that
    // pairing, because it kills the Odoo call AND the AI call, and
    // generateMeetingLogSummary swallows its throw and returns null. The page
    // would then print "Sent - but the note shows the transcript's first
    // lines" directly beside the row's own freshly written last_error, telling
    // the user a note is live on a customer's record when nothing reached Odoo.
    if (after.status !== "sent") return { kind: "push-failed" };

    if (didSummarize() === false) return { kind: "degraded" };
    return { kind: "ok" };
  } catch (err) {
    // The CAS committed and a later await threw. NOT "row unchanged".
    if (committed) return { kind: "moved-unknown" };
    return { kind: "failed", report: reportOdooError(err, "meeting log action") };
  }
}

export function retryMeetingLog(id: string, deps: ActionDeps): Promise<ActionOutcome> {
  return runAction(id, () => retryQueueRow(id), deps);
}

export function assignMeetingLog(
  id: string, contactId: number, leadId: number | null, deps: ActionDeps
): Promise<ActionOutcome> {
  return runAction(id, () => assignQueueRow(id, contactId, leadId), deps);
}

/** No push, ever. Delete is a status flip and nothing reaches Odoo. */
export async function deleteMeetingLog(id: string): Promise<ActionOutcome> {
  return (await deleteQueueRow(id)) ? { kind: "ok" } : { kind: "conflict" };
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
