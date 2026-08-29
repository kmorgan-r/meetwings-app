import { getDatabase } from "@/lib/database/config";
import {
  claimRow,
  deriveRowStatus,
  listTargets,
  QUEUE_SQL,
  reclaimStaleSending,
  recordErrorOnUnsent,
  selectSweepable,
  setSummaryJson,
} from "@/lib/database/meeting-log.action";
import { stampLastMeeting } from "@/lib/database/odoo-contacts.action";
import {
  instanceFingerprint,
  requireOdooConfig,
} from "@/lib/storage/odoo-config.storage";
import type { DbMeetingLogRow, MeetingLogTarget, SummarizationResult } from "@/types";
import { createOdooClient, type OdooClient } from "./client";
import { OdooError, odooError, toOdooError } from "./errors";
import {
  attachmentNameFor,
  buildNoteBody,
  queueErrorText,
  renderTranscript,
  toBase64Utf8,
  type TranscriptSlice,
} from "./meeting-log";
import type { XmlRpcValue } from "./xmlrpc-codec";

/**
 * Rows this PROCESS is currently pushing.
 *
 * Module scope, not a ref: it must survive a <Completion /> remount, which a
 * ref cannot. The sweep's stale-`sending` reclaim consults it so a remount
 * cannot blind-reclaim a live in-flight push into a duplicate attachment and a
 * duplicate customer-visible chatter note.
 *
 * Populated ONLY here, and only around a successful claim. A rehydrated hold
 * timer does not register: the sweep never selects an in-window `held` row, and
 * if a stale-held row is ever contested the CAS arbitrates - one writer gets
 * rowsAffected 1, the other 0.
 */
export const claimed = new Set<string>();

export interface PushDeps {
  client: OdooClient;
  /**
   * The LIVE instance fingerprint, resolved once by the caller.
   *
   * Load-bearing, not informational: it is what a row's stored `instance` is
   * compared against before the claim, so a row enqueued against database A can
   * never post to database B after a credentials edit.
   */
  instance: string;
  /**
   * Sampled fresh on EVERY call, not once by the caller. The push loop
   * re-stamps the parent's claim after every target it processes - a scalar
   * clock would write the identical value on every re-stamp, making a
   * correct once-per-target cadence indistinguishable in the database from a
   * broken once-per-row one.
   */
  now: () => number;
  /** Wrapped in its own try/catch here; may reject freely. */
  summarize: (slice: TranscriptSlice) => Promise<SummarizationResult | null>;
}

/** HTTP statuses worth retrying. Everything else 4xx is a deterministic refusal. */
function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/**
 * Post-wire failures only. A failure raised BEFORE the first wire call is
 * handled by the caller and never reaches this.
 */
function isRetryable(err: OdooError): boolean {
  switch (err.code) {
    case "ODOO_AUTH_FAILED":
    case "ODOO_NOT_CONFIGURED":
      return true;
    case "ODOO_UNREACHABLE": {
      const status = err.details.status;
      // No status means a transport failure (DNS, refused, timeout) - retry.
      // client.ts:58-62 maps EVERY non-2xx to this code, so a 413 or a 404 from
      // a wrong URL path would otherwise retry every launch forever.
      return typeof status !== "number" || isRetryableStatus(status);
    }
    default:
      return false;
  }
}

function expectInt(value: XmlRpcValue, what: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw odooError("ODOO_UNEXPECTED_ROW", `Odoo returned a non-integer ${what}`);
  }
  return value;
}

function firstId(value: XmlRpcValue): number | null {
  if (!Array.isArray(value)) {
    throw odooError("ODOO_UNEXPECTED_ROW", "Odoo returned a non-list from search");
  }
  const first = value[0];
  return typeof first === "number" && Number.isInteger(first) ? first : null;
}

/**
 * Pushes one claimed row. NEVER THROWS - every outcome is a row state, because
 * the sweep must continue to the next row and a propagating failure would
 * abandon every later one.
 */
export async function pushQueuedRow(row: DbMeetingLogRow, deps: PushDeps): Promise<void> {
  // The caller resolved the credentials ONCE and passed the fingerprint in.
  //
  // An earlier draft called requireOdooConfig() here, per row. That was both
  // wasteful (a Store.load round trip per row of a sweep) and dead: BOTH
  // callers already resolve the config and bail before reaching this function,
  // so the pre-wire config catch it guarded was unreachable in production. The
  // not-configured case is now recorded where it is actually reachable - in
  // runMeetingLogSweep's own catch.
  //
  // `attemptsBefore` is read BEFORE the claim: the CAS increments `attempts`,
  // so a post-claim read is already 1 on a brand-new row and the retry-search
  // guard would fire on every first push.
  const attemptsBefore = row.attempts;

  // Before the CAS, so a mismatch moves neither status nor attempts.
  if (row.instance !== deps.instance) return;

  // Read the children BEFORE the claim, and decline before it when there are
  // none - the way this push always returned before the CAS on a null resId,
  // so a mismatch moves neither status nor attempts.
  //
  // Guarded like the claim's own handler just below: listTargets calls
  // db.select, which rejects on a transient SQLITE_BUSY same as any other
  // write, and an unguarded await here would reject pushQueuedRow itself -
  // contradicting its own NEVER THROWS contract for a reason no worse than
  // "the database hiccuped before any wire call happened."
  let targets;
  try {
    targets = await listTargets(row.id);
  } catch (err) {
    console.error("[Odoo] meeting log target read failed:", err);
    return;
  }
  if (targets.length === 0) {
    // Derive before returning. deriveRowStatus is CAS'd on the observed
    // status and safe without a claim. Returning bare would leave a `pending`
    // zero-target row uncorrected forever - reachable, because the assign
    // dialog can confirm an empty set and assignQueueRow([]) CASes the parent
    // to `pending`. The push would then decline pre-claim every sweep while
    // the row sits under "Waiting to be sent" inside countAllQueued's promise.
    try {
      await deriveRowStatus(row.id, row.status, deps.now());
    } catch (err) {
      console.warn("[meeting-log] zero-target derive failed", err);
    }
    return;
  }

  let claimedHere = false;
  try {
    // The CAS runs UNCONDITIONALLY, regardless of row.status. `claimed` tracks
    // pushes this process has in flight, for the stale-claim reclaim
    // (reclaimStaleSending) to consult - it is not evidence of ownership.
    // Checking it here instead of claiming would grant an Odoo write with no
    // CAS precisely when another push of the same row is already in flight,
    // and that concurrent call's `finally` clears the id from `claimed` while
    // this one is still running, dropping the exclusion mid-push.
    // claimRow's own `WHERE status IN ('pending','held')` already refuses
    // every `sending` row, which is what actually prevents the double push.
    if (!(await claimRow(row.id, deps.now()))) return; // someone else owns it, or it is already in flight
    claimed.add(row.id);
    claimedHere = true;
  } catch (err) {
    // The claim write itself failed - a driver problem, not a refusal, so the
    // row stays exactly as it was. Logged rather than silent: on the hold-timer
    // path this is the difference between "the strip vanished and the meeting
    // is queued" and "the strip vanished and nothing happened".
    console.error("[Odoo] meeting log claim failed:", err);
    return;
  }

  try {
    const db = await getDatabase();

    // Built ONCE, before the summarize branch, and reused for every target's
    // attachment/note below. An earlier draft built a SEPARATE, empty
    // `{ entries: [] }` slice just for `deps.summarize` - every real
    // summarizer treats an empty transcript as nothing to summarize and
    // returns null, so the AI summary never reached Odoo and every meeting
    // silently took the "Summarization failed" fallback body, regardless of
    // whether summarization actually worked.
    //
    // One entry PER LINE, not one entry for the whole transcript.
    // buildNoteBody's fallback caps at FALLBACK_LINES entries, so a single
    // synthetic entry caps nothing and the whole transcript lands in a
    // customer-visible note under body text promising only its first lines.
    // renderTranscript round-trips this exactly: it joins on "\n", and an
    // entry with no speaker and no audioSource renders as its bare text - so
    // the "You: "/"Guest: " prefixes already baked into the stored transcript
    // text are rendered exactly once, not doubled by a label renderTranscript
    // would otherwise add.
    const slice: TranscriptSlice = {
      entries: row.transcript
        ? row.transcript.split("\n").map((line, i) => ({
            original: line,
            timestamp: row.transcript_start_at + i,
          }))
        : [],
      startAt: row.transcript_start_at,
      endAt: row.transcript_end_at,
    };

    // ---- Summarize. Its own try/catch, walled off from last_error. --------
    let summary: SummarizationResult | null = null;
    if (row.summary_json) {
      try {
        summary = JSON.parse(row.summary_json) as SummarizationResult;
      } catch {
        summary = null; // a corrupt blob takes the fallback body, not a failure
      }
    } else {
      try {
        summary = await deps.summarize(slice);
      } catch {
        // An AI-provider error NEVER reaches last_error: the redactor holds
        // [apiKey, login] only and has no needle for an AI key, and
        // fetchAIResponse re-wraps failures with the provider's own message.
        summary = null;
      }
      if (summary) {
        try {
          await setSummaryJson(row.id, JSON.stringify(summary));
        } catch (err) {
          // A DB write that runs AFTER the claim but BEFORE the first wire
          // call. Left in the main try, a transient SQLITE_BUSY here would map
          // to ODOO_INTERNAL and permanently `fail` a row that never touched
          // Odoo - exactly what the pre-wire/post-wire split forbids. The
          // stored summary is only a retry optimisation: losing it costs one
          // extra AI call, not the meeting.
          console.error("[Odoo] could not cache the meeting summary:", err);
        }
      }
    }

    // One attachment name, built ONCE for the whole row and reused across
    // every target. attachmentNameFor takes the PARENT queue row's id, not a
    // target's: it is what lets the retry search on a LATER attempt find the
    // SAME attachment this attempt (or an earlier one) already created for
    // that target. Cheap (string formatting), so it stays eager - and every
    // target needs it for the search even on a pass that creates nothing.
    const name = attachmentNameFor(row.id, row.transcript_start_at);

    // `datas` (a full base64 encode of the transcript) and `body` (the
    // rendered note) are NOT cheap, and a pass where every target is already
    // `sent` - or already carries both ids - makes zero wire calls that would
    // need either. Computed lazily, on first actual use, and cached so a
    // SECOND target needing one this same pass does not redo the work.
    let datas: string | null = null;
    const getDatas = (): string =>
      (datas ??= toBase64Utf8(renderTranscript(slice.entries) || row.transcript));
    let body: string | null = null;
    const getBody = (): string =>
      (body ??= buildNoteBody(summary, slice, row.meeting_started_at ?? row.transcript_start_at));

    // ---- Per-target adopt-or-create helpers, closed over the row-wide -----
    // ---- name/getDatas/getBody built just above. --------------------------
    async function createOrAdoptAttachment(
      target: MeetingLogTarget, attemptsBefore: number, deps: PushDeps
    ): Promise<number> {
      if (attemptsBefore > 0) {
        // Prove absence before writing. The commit-then-timeout window means a
        // NULL id does not prove the attachment is absent.
        const found = await deps.client.execute("ir.attachment", "search", [
          [["res_model", "=", target.model], ["res_id", "=", target.resId], ["name", "=", name]],
        ], { limit: 1 });
        const adopted = firstId(found);
        if (adopted !== null) return adopted;
      }
      return expectInt(
        await deps.client.execute("ir.attachment", "create", [
          { name, res_model: target.model, res_id: target.resId, datas: getDatas() },
        ]),
        "attachment id"
      );
    }

    async function postOrAdoptMessage(
      target: MeetingLogTarget, attachmentId: number, attemptsBefore: number, deps: PushDeps
    ): Promise<number> {
      if (attemptsBefore > 0) {
        const found = await deps.client.execute("mail.message", "search", [
          [
            ["model", "=", target.model],
            ["res_id", "=", target.resId],
            ["attachment_ids", "in", [attachmentId]],
          ],
        ], { limit: 1 });
        const adopted = firstId(found);
        if (adopted !== null) return adopted;
      }
      return expectInt(
        await deps.client.execute(target.model, "message_post", [[target.resId]], {
          body: getBody(),
          attachment_ids: [attachmentId],
          // Pinned, not left to Odoo's default. The default IS an internal
          // note today, but nothing enforces that across Odoo versions or
          // customer-side customisations, and the failure mode if it ever
          // flips is that every customer is emailed their own meeting
          // transcript - now on up to five records.
          subtype_xmlid: "mail.mt_note",
        }),
        "message id"
      );
    }

    // ---- Sequentially, one Odoo record at a time. ------------------------
    for (const target of targets) {
      // `!== "pending"`, NOT `=== "sent"`. Skipping only `sent` means a
      // deterministically failed child is re-attempted on EVERY sweep of a
      // row that still has a pending sibling - re-firing the fault forever
      // and making retryTarget's child reset (its entire reason for
      // existing) dead code.
      if (target.status !== "pending") continue;

      // The persist helper and its flag are re-created HERE, inside the
      // loop. Hoisting them above it would let a persistence failure on an
      // EARLIER target bleed into a LATER target's classification.
      let persistenceFailed = false;
      const persist = async (sql: string, args: unknown[]): Promise<void> => {
        try {
          await db.execute(sql, args);
        } catch (err) {
          persistenceFailed = true;
          throw err;
        }
      };

      try {
        let attachmentId = target.attachmentId;
        if (attachmentId === null) {
          attachmentId = await createOrAdoptAttachment(target, attemptsBefore, deps);
          await persist(QUEUE_SQL.setTargetAttachment, [attachmentId, target.id]);
        }

        let messageId = target.messageId;
        if (messageId === null) {
          messageId = await postOrAdoptMessage(target, attachmentId, attemptsBefore, deps);
          await persist(QUEUE_SQL.setTargetMessage, [messageId, target.id]);
        }

        await persist(QUEUE_SQL.targetToSent, [deps.now(), target.id]);

        if (target.model === "res.partner") {
          // Never bare `void`: this is a db.execute, a transient SQLITE_BUSY
          // rejects, and an unhandled rejection in the webview is the exact
          // path errors.ts exists to close. Never awaited unwrapped either -
          // it sits inside this try but outside persist(), so an awaited
          // rejection would be read as an Odoo fault and mark a target
          // terminal whose note is already live.
          stampLastMeeting(deps.instance, target.resId, deps.now()).catch((err) =>
            console.warn("[meeting-log] last_meeting_at stamp failed", err)
          );
        }
      } catch (err) {
        // toOdooError FIRST. isRetryable switches on err.code, so an
        // unwrapped transport rejection (a fetch TypeError, an abort) hits
        // `default: false`, is treated as deterministic, and is marked
        // terminally failed - which selectSweepable never picks up.
        const odoo = toOdooError(err);
        const { code, text } = queueErrorText(err);

        // Every recovery write keeps its own guard. This branch is reached
        // when the database itself may be what is broken, so a second
        // unguarded write here would escape the outer NEVER-THROWS contract.
        const record = async (sql: string): Promise<void> => {
          try {
            await db.execute(sql, [code, text, target.id]);
          } catch (inner) {
            console.warn("[meeting-log] target status write failed", inner);
          }
        };

        if (persistenceFailed) {
          // A local write failed AFTER a wire call. This target goes
          // pending - never failed, whatever the code says - and the pass
          // aborts, because continuing fires wire calls whose ids the same
          // broken database cannot store.
          await record(QUEUE_SQL.targetToPending);
          break;
        }
        if (isRetryable(odoo)) {
          await record(QUEUE_SQL.targetToPending);
          break;
        }
        await record(QUEUE_SQL.targetToFailed);
        // No `break` - a deterministic fault on one target must not strand
        // the rest.
      } finally {
        // In a finally, so a DETERMINISTIC failure refreshes the claim too.
        // Three consecutive slow faults (a 30s-timeout client returning an
        // access refusal) would otherwise cross STALE_CLAIM_MS with zero
        // re-stamps, and the other window would reclaim mid-flight - the
        // duplicate note this exists to stop.
        //
        // Guarded, and a throw is treated exactly like zero rows affected.
        // This finally is reached on the persistenceFailed path too, where
        // the database is precisely what is broken - so an unguarded write
        // here is the statement most likely to fail, and it would escape a
        // function whose contract is NEVER THROWS.
        let claimHeld = false;
        try {
          const stamp = await db.execute(QUEUE_SQL.restampClaim, [deps.now(), row.id]);
          claimHeld = (stamp.rowsAffected ?? 0) > 0;
        } catch (err) {
          console.warn("[meeting-log] claim re-stamp failed", err);
        }
        if (!claimHeld) {
          // The claim is gone or unprovable. RETURN, not break: the terminal
          // derive below CASes on 'sending' and would match the NEW owner's
          // row, overwriting their state mid-push. A `return` in a `finally`
          // overrides a pending `break`, which is exactly what is wanted.
          return;
        }
      }
    }

    try {
      await deriveRowStatus(row.id, "sending", deps.now());
    } catch (err) {
      console.warn("[meeting-log] terminal derive failed", err);
    }
  } catch (err) {
    // Per-target failures are already recorded on the children above, and
    // the parent's status comes from deriveRowStatus - never written here.
    // Reaching this catch at all means something outside the per-target loop
    // broke (getDatabase(), the summarize wall, or the terminal derive's own
    // try already swallowed its failure) - there is nothing more to do than
    // log it.
    console.warn("[meeting-log] push failed", err);
  } finally {
    if (claimedHere) claimed.delete(row.id);
  }
}

export interface SweepOutcome {
  ran: boolean;
  pushed: number;
}

/**
 * Module-level single flight, mirroring runSync (src/lib/odoo/index.ts:20-33).
 *
 * The latch is owned by the RUN, not the component: the promise clears ITSELF
 * in .finally(), so it is never re-armed in an effect create body. Re-arming it
 * there would discard the promise the first StrictMode create armed and start
 * exactly the second concurrent run it exists to prevent.
 */
let sweepInFlight: Promise<SweepOutcome> | null = null;

/**
 * Retries queued meetings. Called once at app start from useMeetingLog, in the
 * `main` window only.
 *
 * SEQUENTIAL by design - a parallel sweep against a rate-limited Odoo turns one
 * bad morning into a thundering herd. ONE client for the whole run, because a
 * per-row client re-authenticates on every row.
 */
export async function runMeetingLogSweep(
  summarize: PushDeps["summarize"]
): Promise<SweepOutcome> {
  if (sweepInFlight) return sweepInFlight;

  const run = (async (): Promise<SweepOutcome> => {
    let config;
    try {
      config = await requireOdooConfig();
    } catch (err) {
      // Not set up, or half-filled. The rows keep their status - this is not a
      // rejection by Odoo - but the REASON is recorded on each of them, because
      // nothing else can: this path never claims, so `attempts` never
      // increments and no row can escalate into "needs attention" on its own.
      // Without it a user whose credentials went half-filled has N meetings
      // stuck with no explanation anywhere.
      const { code, text } = queueErrorText(err);
      try {
        await recordErrorOnUnsent(code, text);
      } catch {
        // The database is what failed. Nothing more to try.
      }
      return { ran: false, pushed: 0 };
    }
    const instance = instanceFingerprint(config.url, config.db);

    let rows;
    try {
      // FIRST. Age-gated, and excluding anything this process is pushing right
      // now - see reclaimStaleSending's doc comment for why both halves matter.
      await reclaimStaleSending(Date.now(), [...claimed]);
      rows = await selectSweepable(instance, Date.now());
    } catch (err) {
      // Aborting is right - if the database is down there is nothing to
      // iterate - but it must not REJECT: the only production caller is a
      // `void` inside a React effect.
      console.error("[Odoo] meeting log sweep could not read the queue:", err);
      return { ran: false, pushed: 0 };
    }
    if (rows.length === 0) return { ran: true, pushed: 0 };

    const client = createOdooClient(config);
    let pushed = 0;
    for (const row of rows) {
      // pushQueuedRow never throws, but the loop is defensive anyway: a row
      // failure must never abandon the rows behind it.
      //
      // `now` is a FRESH read on every call, not one stamp for the run:
      // against a slow Odoo (up to 30s per call, client.ts:21, times up to
      // five targets) a shared stamp would write claimed_at/sent_at values
      // minutes in the past for the later rows and later targets alike.
      try {
        await pushQueuedRow(row, { client, instance, now: () => Date.now(), summarize });
        pushed += 1;
      } catch {
        // already recorded on the row
      }
    }
    return { ran: true, pushed };
  })();

  sweepInFlight = run.finally(() => {
    sweepInFlight = null;
  });
  return sweepInFlight;
}
