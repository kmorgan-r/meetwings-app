import {
  getTranscriptWatermark,
  insertQueueRow,
  readUnloggedMessages,
  type UnloggedTranscriptEntry,
} from "@/lib/database/meeting-log.action";
import { IDLE_FLUSH_MS, renderTranscript, segmentByGap, sessionKeyFor } from "./meeting-log";
import { decideDestinations } from "@/lib/notion/destinations";
import { notionErrorText } from "@/lib/notion/errors";
import {
  getNotionSetupAt,
  isNotionAutoSendEnabled,
  isNotionConfigured,
} from "@/lib/storage/notion-config.storage";
import { instanceFingerprint, loadOdooConfigState } from "@/lib/storage/odoo-config.storage";

/**
 * How far back recovery is willing to reach.
 *
 * The queue watermark is 0 on a machine that has been holding meetings with
 * Odoo unconfigured - nothing was ever written to raise it - so without a floor
 * the first run after setup dumps every meeting ever held into the strip as
 * unassigned work to triage. Seven days
 * covers the cases this path is for - a crash, a kill, an app closed with the
 * pill still on - and a meeting older than that is history, not a backlog.
 */
export const RECOVERY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The upper edge of what recovery will claim: anything said from this instant
 * on belongs to the live triggers, not to the backstop.
 *
 * Captured at module import, so it still means "this run of the app" after a
 * <Completion /> remount. This is the mirror of the floor `useMeetingLog.ts`
 * puts on its own recovery read - see its comment at :51-84 for the full
 * argument; the short version is that a read with no session bound will happily
 * cross a process boundary in whichever direction it is left open. That one
 * refuses to reach BACK into a previous run's meeting. This one refuses to
 * reach FORWARD into the current run's.
 *
 * Without it: recovery runs from a startup effect that awaits a config load, a
 * sweep and a prune, and a user who launches the app and starts talking has STT
 * writing rows to `messages` throughout. Recovery reads its own process's live
 * meeting, files it `unassigned`, and lifts the global watermark past it - so
 * the pill-off or idle trigger that follows finds the span already consumed,
 * writes no `held` row, and the contact the user had selected is dropped.
 *
 * A meeting straddling a restart therefore lands as two rows: the pre-restart
 * span recovered as `unassigned`, the rest handled live. The live path splits
 * on its own floor exactly the same way, and two rows the user can see beats
 * one row that silently swallows a stranger's words.
 *
 * Its own constant rather than an import of `useMeetingLog`'s: a lib module
 * must not depend on a hook, and the millisecond of skew between the two
 * module-load instants cannot matter - no STT entry can exist that early in
 * app start.
 */
export const RECOVERY_STARTED_AT = Date.now();

let recoveryRan = false; // module scope: survives a <Completion /> remount
// A second call while the first is still inserting joins it, so nothing (the
// scheduler start above all) can proceed mid-recovery.
let inFlight: Promise<number> | null = null;

/** Test-only. Lets a suite start each case from a clean process state. */
export function resetMeetingRecoveryGuard(): void {
  recoveryRan = false;
  inFlight = null;
}

/**
 * Enqueues every meeting that was said but never queued.
 *
 * The backstop under the three live triggers in `useMeetingLog`. Each of them
 * needs the process to still be alive at the moment the meeting ends:
 * `meeting-ended` needs the Windows watcher (which only runs with Auto-record
 * on), the pill-off edge needs the user to toggle the pill, and the idle flush
 * needs five more minutes of uptime. Close the app, or lose it to a crash or a
 * kill, and the transcript sits in `messages` with nothing in the queue
 * pointing at it and no trace anywhere that a meeting happened.
 *
 * Runs ONCE PER PROCESS, beside runOrphanSweep, for the same reason that one
 * does: <Completion /> remounts mid-session, and a per-mount recovery would
 * re-read the whole span on every remount.
 *
 * Every recovered row has NO targets, so nothing here reaches Odoo on its own:
 * it is `unassigned` when Odoo is set up, and `none` (with a Notion lane) when
 * only Notion is. The contact that was selected when the meeting was said is
 * long gone by the time this runs; guessing one would post a stranger's words
 * into a customer's chatter, which is the mis-post the whole watermark design
 * exists to prevent. `unassigned` puts the row in the strip under "Needs a
 * contact" and hands the choice back to the user.
 *
 * NEVER REJECTS. The only production caller is a `void` inside a React effect.
 */
export function runMeetingRecovery(): Promise<number> {
  if (inFlight) return inFlight;
  if (recoveryRan) return Promise.resolve(0);
  const run = recover().finally(() => {
    if (inFlight === run) inFlight = null;
  });
  inFlight = run;
  return run;
}

async function recover(): Promise<number> {
  try {
    // BEFORE the read, so an unconfigured install consumes nothing: the
    // entries stay above every watermark and a later run still finds them.
    const state = await loadOdooConfigState();
    // An unreadable Notion config counts as "Notion off": Odoo-only recovery
    // must not die with it. The code is logged, never the thrown text.
    let notion = false;
    try {
      notion = await isNotionConfigured();
    } catch (e) {
      console.warn("[meeting-log] notion config unreadable:", notionErrorText(e).code);
    }
    if (state.state !== "complete" && !notion) return 0;

    // Latched HERE, on the outcome, not on entry - the same rule the sweep
    // effect spells out at useMeetingLog.ts:515-523. Latching before the
    // config check would permanently disable recovery for any process that
    // started without credentials: the user opens /odoo, finishes setting it
    // up, comes back, and the days of unlogged meetings this function exists
    // to find stay invisible until an app restart. That is precisely the
    // moment there is the most to recover.
    //
    // It does NOT wait for the read below to succeed, though - deliberately,
    // and unlike the sweep's `outcome.ran`. Missing credentials are a NORMAL
    // state a user fixes mid-session; a failing `readUnloggedMessages` means
    // getDatabase() is down, which takes chat history, prompts and cost
    // tracking with it. Retrying that on the next remount would buy nothing,
    // and latching later would open a window where two remounts run the whole
    // read-and-insert pass concurrently, with no single flight to join them.
    recoveryRan = true;
    // No Odoo instance to key a row to unless Odoo is fully set up.
    const instance =
      state.state === "complete" ? instanceFingerprint(state.config.url, state.config.db) : "";
    const decision = decideDestinations({
      source: "recovery",
      odoo: state.state,
      notion,
      autoSend: isNotionAutoSendEnabled(),
      odooTargets: 0,
      notionPicked: false,
    });
    if (!decision.queue) return 0;

    // The QUEUE watermark only, floored at the age limit.
    //
    // Deliberately NOT `Math.max(..., getSkipWatermark())`, which is what the
    // live trigger computes at useMeetingLog.ts:323. The two readers want
    // different things from that mark and only one of them is in danger.
    //
    // The skip mark records a span some trigger consumed without writing a row,
    // and it exists for ONE hazard: a LATER live trigger re-slicing that span
    // and posting it under whatever contact is selected for the NEXT meeting -
    // one customer's words in another customer's chatter
    // (meeting-log-watermark.storage.ts:15-25). The live trigger picks a
    // contact, so it must keep honouring it.
    //
    // Recovery picks none. Every row below has NO Odoo targets, so none reaches
    // an Odoo contact until a human chooses one (a Notion lane, when present,
    // goes to the team database and names no contact), so there is no mis-post
    // here to prevent - and honouring the mark would cost the entire feature.
    // `skipUnwritten` fires on the absent, incomplete AND catch branches
    // (useMeetingLog.ts:308/314/406), i.e. on precisely the meetings that were
    // said and never queued. Reading it here excluded the meetings this
    // function exists to find: a user who held a meeting before setting Odoo up
    // and left the app idle five minutes had it skip-marked by the idle flush,
    // and no later run could ever see it again.
    //
    // What this does NOT rescue: the global watermark is a single
    // MAX(transcript_end_at) over the whole queue, so if a LATER meeting gets a
    // row written before recovery next runs, that row's watermark buries the
    // earlier unlogged span for good. That is the pre-existing cost of a global
    // watermark, not something this floor introduces.
    let floor = Math.max(await getTranscriptWatermark(), Date.now() - RECOVERY_MAX_AGE_MS);
    // A row with a Notion lane is only rescued from when Notion was first set
    // up: older meetings were never Notion-bound, and sending them would be a
    // backfill into the team database. No stored time means nothing is
    // rescued. ponytail: a user who disconnects and later reconnects keeps the
    // FIRST setup time, so meetings recorded while disconnected can be rescued
    // on reconnect.
    if (decision.notionStatus !== null) {
      floor = Math.max(floor, getNotionSetupAt() ?? Date.now());
    }

    const entries = await readUnloggedMessages(floor, RECOVERY_STARTED_AT);
    if (entries.length === 0) return 0;

    let created = 0;
    for (const [conversationId, group] of groupByConversation(entries)) {
      for (const slice of segmentByGap(group, IDLE_FLUSH_MS)) {
        try {
          const inserted = await insertQueueRow({
            id: crypto.randomUUID(),
            sessionKey: sessionKeyFor(conversationId, slice.startAt),
            conversationId,
            instance,
            targets: [],
            transcript: renderTranscript(slice.entries),
            transcriptStartAt: slice.startAt,
            transcriptEndAt: slice.endAt,
            meetingStartedAt: slice.startAt,
            status: decision.odooStatus,
            notionStatus: decision.notionStatus,
            createdAt: Date.now(),
          });
          // `false` is ON CONFLICT(session_key) DO NOTHING - the row was
          // already there. A normal outcome, but not a recovery, so it must
          // not be counted as one.
          if (inserted) created += 1;
        } catch (e) {
          // Per segment, so a transient SQLITE_BUSY on the first meeting does
          // not abandon the ones behind it.
          console.warn("[meeting-log] could not recover a meeting", e);
        }
      }
    }

    if (created > 0) {
      console.info(`[meeting-log] recovered ${created} unlogged meeting(s)`);
    }
    return created;
  } catch (e) {
    console.error("[meeting-log] recovery failed", e);
    return 0;
  }
}

/**
 * Insertion-ordered, so the rows come out in the order the read returned them.
 *
 * Grouping is what keeps two conversations that overlap in time from being cut
 * into one another's meetings by `segmentByGap` - it segments on silence, and
 * two interleaved conversations have no silence between them at all.
 */
function groupByConversation(
  entries: UnloggedTranscriptEntry[]
): Map<string, UnloggedTranscriptEntry[]> {
  const groups = new Map<string, UnloggedTranscriptEntry[]>();
  for (const entry of entries) {
    const bucket = groups.get(entry.conversationId);
    if (bucket) bucket.push(entry);
    else groups.set(entry.conversationId, [entry]);
  }
  return groups;
}
