import {
  claimRow,
  failRow,
  markSent,
  reclaimStaleSending,
  recordErrorOnUnsent,
  releaseRowToPending,
  selectSweepable,
  setAttachmentId,
  setMessageId,
  setSummaryJson,
} from "@/lib/database/meeting-log.action";
import {
  instanceFingerprint,
  requireOdooConfig,
} from "@/lib/storage/odoo-config.storage";
import type { DbMeetingLogRow, SummarizationResult } from "@/types";
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
  now: number;
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
  const { client, now } = deps;

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

  const model = row.lead_id !== null ? "crm.lead" : "res.partner";
  const resId = row.lead_id ?? row.contact_id;
  if (resId === null) return; // unassigned rows are slice 3's

  let claimedHere = false;
  // Set by `persist()` below. Routing on the THROW SITE, not on whether an Odoo
  // write happened this attempt: the adopt paths and the both-ids-stored
  // short-circuit perform local writes with no Odoo call, and a rejection there
  // must not fail a meeting whose attachment and note are already live.
  let persistenceFailed = false;
  /** Any local DB write after the claim. A rejection here is never a refusal. */
  const persist = async (write: () => Promise<void>): Promise<void> => {
    try {
      await write();
    } catch (err) {
      persistenceFailed = true;
      throw err;
    }
  };
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
    if (!(await claimRow(row.id, now))) return; // someone else owns it, or it is already in flight
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
    // Built ONCE, before the summarize branch, and reused for the
    // attachment/note body below. An earlier draft built a SEPARATE, empty
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

    // ---- Step 1: the attachment. ----------------------------------------
    let attachmentId = row.attachment_id;
    const name = attachmentNameFor(row.id, row.transcript_start_at);
    if (attachmentId === null) {
      if (attemptsBefore > 0) {
        // Prove absence before writing. The commit-then-timeout window means a
        // NULL id does not prove the attachment is absent.
        const found = await client.execute("ir.attachment", "search", [
          [["res_model", "=", model], ["res_id", "=", resId], ["name", "=", name]],
        ], { limit: 1 });
        attachmentId = firstId(found);
      }
      if (attachmentId === null) {
        attachmentId = expectInt(
          await client.execute("ir.attachment", "create", [
            {
              name,
              res_model: model,
              res_id: resId,
              datas: toBase64Utf8(renderTranscript(slice.entries) || row.transcript),
            },
          ]),
          "attachment id"
        );
      }
      await persist(() => setAttachmentId(row.id, attachmentId as number));
    }

    // ---- Step 2: the note. ----------------------------------------------
    if (row.message_id === null) {
      let messageId: number | null = null;
      if (attemptsBefore > 0) {
        const found = await client.execute("mail.message", "search", [
          [
            ["model", "=", model],
            ["res_id", "=", resId],
            ["attachment_ids", "in", [attachmentId]],
          ],
        ], { limit: 1 });
        messageId = firstId(found);
      }
      if (messageId === null) {
        messageId = expectInt(
          await client.execute(model, "message_post", [[resId]], {
            body: buildNoteBody(summary, slice, row.meeting_started_at ?? row.transcript_start_at),
            attachment_ids: [attachmentId],
          }),
          "message id"
        );
      }
      await persist(() => setMessageId(row.id, messageId as number));
    }

    await persist(() => markSent(row.id, now));
  } catch (err) {
    const odoo = toOdooError(err);
    const { code, text } = queueErrorText(err);
    try {
      // A local DB write failed after the claim. Failing the row there could
      // strand an attachment - or a whole posted note - live on a customer
      // record with the row marked terminal, and selectSweepable never picks up
      // `failed`, so nothing would recover it before slice 3. A re-push is
      // provably safe: the attachment name is deterministic, both ids are
      // stored the moment they return, and attemptsBefore is now > 0 so both
      // adopt-searches run.
      //
      // Note what this does NOT cover, deliberately: a `message_post`
      // ODOO_FAULT after a successful ir.attachment.create still fails the row,
      // leaving an orphan attachment. That is the right trade - the fault is
      // deterministic and `pending` would retry it on every launch forever -
      // and the stored attachment_id makes slice 3's manual retry
      // non-duplicating.
      if (persistenceFailed || isRetryable(odoo)) {
        await releaseRowToPending(row.id, code, text);
      } else {
        await failRow(row.id, code, text);
      }
    } catch {
      // The status write itself failed. Do not attempt a second write when the
      // database is what is broken - the stale-`sending` reclaim recovers it.
    }
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
      // Date.now() PER ROW, not one stamp for the run: against a slow Odoo (30s
      // per call, client.ts:21) a shared stamp would write claimed_at/sent_at
      // values minutes in the past for the later rows.
      try {
        await pushQueuedRow(row, { client, instance, now: Date.now(), summarize });
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
