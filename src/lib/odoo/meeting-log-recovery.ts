import {
  getTranscriptWatermark,
  insertQueueRow,
  readUnloggedMessages,
  type UnloggedTranscriptEntry,
} from "@/lib/database/meeting-log.action";
import { IDLE_FLUSH_MS, renderTranscript, segmentByGap, sessionKeyFor } from "./meeting-log";
import { getSkipWatermark } from "@/lib/storage/meeting-log-watermark.storage";
import { instanceFingerprint, loadOdooConfigState } from "@/lib/storage/odoo-config.storage";

/**
 * How far back recovery is willing to reach.
 *
 * Both watermarks are 0 on a machine that has been holding meetings with Odoo
 * unconfigured, so without a floor the first run after setup dumps every
 * meeting ever held into the strip as unassigned work to triage. Seven days
 * covers the cases this path is for - a crash, a kill, an app closed with the
 * pill still on - and a meeting older than that is history, not a backlog.
 */
export const RECOVERY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

let recoveryRan = false; // module scope: survives a <Completion /> remount

/** Test-only. Lets a suite start each case from a clean process state. */
export function resetMeetingRecoveryGuard(): void {
  recoveryRan = false;
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
 * Every recovered row is `unassigned` with NO targets, so nothing here reaches
 * Odoo on its own. The contact that was selected when the meeting was said is
 * long gone by the time this runs; guessing one would post a stranger's words
 * into a customer's chatter, which is the mis-post the whole watermark design
 * exists to prevent. `unassigned` puts the row in the strip under "Needs a
 * contact" and hands the choice back to the user.
 *
 * NEVER REJECTS. The only production caller is a `void` inside a React effect.
 */
export async function runMeetingRecovery(): Promise<number> {
  if (recoveryRan) return 0;
  recoveryRan = true;

  try {
    // BEFORE the read, so an unconfigured install consumes nothing: the
    // entries stay above every watermark and the run after the user finishes
    // setting Odoo up still finds them.
    const state = await loadOdooConfigState();
    if (state.state !== "complete") return 0;
    const instance = instanceFingerprint(state.config.url, state.config.db);

    // The same effective watermark the live trigger computes, floored at the
    // age limit. The skip mark is not optional: it records spans a trigger
    // consumed WITHOUT writing a row, and ignoring it here would recover
    // exactly the entries that mark exists to exclude.
    const floor = Math.max(
      await getTranscriptWatermark(),
      getSkipWatermark(),
      Date.now() - RECOVERY_MAX_AGE_MS
    );

    const entries = await readUnloggedMessages(floor);
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
            status: "unassigned",
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
