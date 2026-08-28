import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { toast } from "sonner";
import {
  cancelHeldRow,
  findHeldRow,
  getQueueRow,
  getTranscriptWatermark,
  insertQueueRow,
  readMeetingMessages,
  sweepOrphanTargets,
} from "@/lib/database/meeting-log.action";
import { generateMeetingLogSummary } from "@/lib/functions/meeting-summarizer";
import { createOdooClient } from "@/lib/odoo/client";
import {
  HOLD_MS,
  UNDO_BLOCKED_MS,
  renderTranscript,
  sessionKeyFor,
  sliceTranscript,
} from "@/lib/odoo/meeting-log";
import { runTranscriptPrune } from "@/lib/odoo/meeting-log-actions";
import { pushQueuedRow, runMeetingLogSweep } from "@/lib/odoo/meeting-log-push";
import { getActiveConversationId } from "@/lib/storage/active-conversation.storage";
import { getSkipWatermark, setSkipWatermark } from "@/lib/storage/meeting-log-watermark.storage";
import {
  instanceFingerprint,
  loadOdooConfigState,
  requireOdooConfig,
} from "@/lib/storage/odoo-config.storage";
import type { ResolvedTarget, SelectedTarget, TranscriptEntry } from "@/types";
import type { RefObject } from "react";

type ProviderConfig = {
  provider: any;
  selectedProvider: { provider: string; variables: Record<string, string> };
};

/**
 * Once per PROCESS, not once per mount. See the sweep effect below.
 *
 * NOT exported: ESM import bindings are read-only, so a test could not assign
 * to it anyway - which is exactly why `resetMeetingLogSweepGuard()` exists.
 * Nothing in production writes it but the effect.
 */
let sweptThisProcess = false;

/**
 * The floor below which the remount-recovery read (readMeetingMessages,
 * below) refuses to reach - evaluated ONCE, at module import, so it survives
 * a <Completion /> remount mid-session and still means "this run of the app".
 *
 * `getActiveConversationId()` is a bare localStorage read with no clear site
 * on mount or app start - it survives a killed process. `readMeetingMessages`'
 * SQL has no session bound and no LIMIT, only `timestamp > watermark`. And on
 * a fresh install the queue is empty, so that watermark is 0. Put those three
 * together and an app killed mid-meeting, before `meeting-ended` ever wrote a
 * row, leaves that meeting's entries sitting in `messages` with nothing
 * marking them consumed. The NEXT run's first empty-transcript trigger -
 * any pill toggled on then off with no speech - would otherwise recover that
 * entire prior meeting and stamp it with WHATEVER contact is selected now,
 * not the one it was said to. That is a cross-customer mis-post, not a bug
 * that degrades gracefully.
 *
 * Flooring the recovery read at process start closes it: a legitimate
 * mid-call remount is the same process, so its entries were written after
 * this constant was captured and stay above the floor. A prior run's
 * unwritten meeting was written before it and drops out. The excluded span
 * is not silently swallowed alongside a written one - the in-memory
 * transcript is empty in exactly this case (that is WHY recovery ran at
 * all), so there is no live meeting to attach it to. It was already outside
 * the write-ahead guarantee by construction: no row was ever queued for it,
 * so there is nothing here to roll back or retry - this is a deliberate
 * silent loss of an orphaned span, not a mis-post.
 *
 * Deliberately NOT applied to `sliceTranscript` below: that reads the
 * in-memory `entries` snapshot alone, which cannot contain anything from a
 * previous process (the array does not survive one), so flooring it would
 * only risk dropping a real meeting that happens to start near process
 * launch for no safety benefit.
 */
const PROCESS_STARTED_AT = Date.now();

/** Test-only. Lets a suite start each case from a clean process state. */
export function resetMeetingLogSweepGuard(): void {
  sweptThisProcess = false;
}

const ORPHAN_SWEEP_AGE_MS = 5 * 60 * 1000;
let orphanSweepRan = false; // module scope: survives a <Completion /> remount

/**
 * Reclaims meeting_log_targets rows whose parent never got written - the
 * crash window between insertQueueRow's ordered writes. Chained beside
 * runTranscriptPrune, outside runMeetingLogSweep's `ran` guard: it needs no
 * Odoo config, and gating it on one would leave orphans piling up for
 * exactly the users least likely to ever have completed credentials.
 */
export async function runOrphanSweep(): Promise<void> {
  if (orphanSweepRan) return;
  orphanSweepRan = true;
  try {
    const n = await sweepOrphanTargets(Date.now() - ORPHAN_SWEEP_AGE_MS);
    if (n > 0) console.info(`[meeting-log] swept ${n} orphaned target rows`);
  } catch (e) {
    console.warn("[meeting-log] orphan sweep failed", e);
  }
}

/** Test-only. Lets a suite start each case from a clean process state. */
export function resetOrphanSweepGuard(): void {
  orphanSweepRan = false;
}

/**
 * The single-target caller's adapter, until Task 14 replaces targetRef with
 * a real multi-select. Lead wins, matching the migration 14 backfill's own
 * coalesce. Returns null rather than asserting: ResolvedTarget.contactId is
 * `number | null` and SelectedTarget.resId is `number`, so an assertion
 * would fail TS strict.
 */
function resolvedToSelected(t: ResolvedTarget): SelectedTarget | null {
  if (t.leadId !== null) {
    return { model: "crm.lead", resId: t.leadId, name: t.leadName };
  }
  if (t.contactId !== null) {
    return { model: "res.partner", resId: t.contactId, name: null };
  }
  return null; // neither id set: not a target, same as today
}

export interface UseMeetingLogOptions {
  /** Slice 1's ref. Already mirrored in a useLayoutEffect (useOdooTarget.ts:143-146). */
  targetRef: RefObject<ResolvedTarget | null>;
  meetingTranscript: TranscriptEntry[];
  currentConversationId: string | null;
  meetingAssistMode: boolean;
  providerConfig?: ProviderConfig;
}

export interface UseMeetingLogReturn {
  holding: boolean;
  onUndo: () => void;
  undoBlockedMessage: string | null;
}

/**
 * Logs a finished meeting to Odoo.
 *
 * Mounted in <Completion /> beside useMeetingAutoRecord, NOT hooked to its
 * handleStop: decideOnEnded returns "ignore" for any session auto-record did
 * not itself start (useMeetingAutoRecord.ts:482-490), so a manually started
 * meeting would push nothing.
 *
 * The owner gate is the `main` window label ALONE, with no isWindows(): the
 * pill-off trigger works where the Rust watcher never runs. Contrast
 * useMeetingAutoRecord.ts:122, which gates on both because it drives the
 * Windows-only watcher.
 */
export function useMeetingLog(options: UseMeetingLogOptions): UseMeetingLogReturn {
  const { targetRef, meetingTranscript, currentConversationId, meetingAssistMode } = options;

  // Synchronous and stable. getCurrentWindow().label is read synchronously in
  // this repo (useOdooTarget.ts:296, useMeetingAutoRecord.ts:121-124), so this
  // never flips after mount - which the [isOwner] keying below depends on.
  const isOwner = useMemo(() => getCurrentWindow().label === "main", []);

  const [holding, setHolding] = useState(false);
  const [undoBlockedMessage, setUndoBlockedMessage] = useState<string | null>(null);

  /**
   * Every mutable value the meeting-ended handler reads goes through a
   * useLayoutEffect-mirrored ref, because that handler is registered ONCE per
   * window lifetime and would otherwise close over the mount render - where the
   * transcript is [] and the conversation id is null. Combined with "an empty
   * slice produces no row", that makes every real meeting a silent no-op.
   *
   * useLayoutEffect, not useEffect: a passive mirror is one commit stale and no
   * RTL test distinguishes them, because act() flushes passive effects before
   * any assertion. See useCompletion.ts:440-446.
   */
  const transcriptRef = useRef(meetingTranscript);
  const conversationIdRef = useRef(currentConversationId);
  const providerConfigRef = useRef(options.providerConfig);
  useLayoutEffect(() => {
    transcriptRef.current = meetingTranscript;
    conversationIdRef.current = currentConversationId;
    providerConfigRef.current = options.providerConfig;
  });

  /**
   * ONE latch for BOTH triggers, raised synchronously before the first await
   * and lowered in a finally on EVERY exit - including each early return.
   *
   * It exists so a Windows meeting-ended and a pill-off cannot run the
   * snapshot -> slice -> insert sequence concurrently through their async gap.
   * It is NOT the guard against per-commit re-fire: the pill trigger is
   * edge-triggered and fires once by construction. A latch that never lowers
   * would mean only the first meeting of a window's lifetime is ever logged.
   */
  const inFlightRef = useRef(false);
  const heldRowIdRef = useRef<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const blockedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const summarize = useCallback(
    (entries: TranscriptEntry[]) =>
      generateMeetingLogSummary(entries, providerConfigRef.current),
    []
  );

  /**
   * Fires the push for a held row.
   *
   * Detached from the component on purpose: an unmount clears the TIMER but a
   * push already under way keeps running, owned by the module. Its entry in
   * meeting-log-push's `claimed` set is what keeps a concurrent sweep off it.
   */
  const pushHeldRow = useCallback(async (rowId: string) => {
    try {
      const row = await getQueueRow(rowId);
      if (!row || row.status !== "held") return; // undone, or someone else claimed it
      const config = await requireOdooConfig();
      await pushQueuedRow(row, {
        client: createOdooClient(config),
        instance: instanceFingerprint(config.url, config.db),
        now: Date.now(),
        summarize: (slice) => summarize(slice.entries),
      });
    } catch (err) {
      // pushQueuedRow never throws; this catches the reads around it. The row
      // stays `held` and the sweep's stale-held rescue owns it.
      console.error("[Odoo] held-row push failed:", err);
    }
  }, [summarize]);

  /**
   * Only ONE row is undoable at a time - but a displaced row must never be
   * stranded.
   *
   * Two meetings can end inside one 30s window (a detection false-positive
   * followed by a real end, or `meeting-ended` then a manual pill-off). The
   * strip can only show one, so the DISPLACED row is pushed immediately rather
   * than left `held` with no timer: stranded, it would wait for a sweep, and
   * the sweep runs once per process - in practice the next app start.
   */
  const startHold = useCallback(
    (rowId: string, remainingMs = HOLD_MS) => {
      const displaced = heldRowIdRef.current;
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      if (displaced && displaced !== rowId) void pushHeldRow(displaced);

      heldRowIdRef.current = rowId;
      setHolding(true);
      if (blockedTimerRef.current) {
        clearTimeout(blockedTimerRef.current);
        blockedTimerRef.current = null;
      }
      setUndoBlockedMessage(null);
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        setHolding(false);
        // Only if nothing newer has taken the ref since this timer was
        // armed - startHold and onUndo both clear timerRef before writing
        // it, so reaching here with a stale rowId is not possible, but the
        // guard is the same one onUndo needs anyway, so it is kept explicit
        // rather than assumed.
        if (heldRowIdRef.current === rowId) heldRowIdRef.current = null;
        void pushHeldRow(rowId);
      }, remainingMs);
    },
    [pushHeldRow]
  );

  const trigger = useCallback(async () => {
    if (!isOwner || inFlightRef.current) return;
    inFlightRef.current = true;
    // Snapshot SYNCHRONOUSLY, before any await. Without it a user clearing
    // the transcript or re-picking a contact mid-push splices two meetings.
    const entries = transcriptRef.current;
    const target = targetRef.current;
    const conversationId = conversationIdRef.current;

    // The consumed span, from the SAME synchronous snapshot.
    //
    // `meetingTranscript` is never cleared when a meeting ends, so two
    // consecutive meetings live in one array and the DB watermark - which
    // only advances when a row is actually WRITTEN - is the only thing that
    // separates them. A trigger that reads this far and then bails (Odoo not
    // fully configured, or any throw) has consumed this span without writing
    // a row for it: left alone, the NEXT trigger slices from the same old
    // watermark, picks these entries back up, and posts THIS meeting's
    // transcript as a chatter note on whatever contact is selected for the
    // NEXT one. `skipUnwritten` closes that gap on every exit that reaches
    // it - see meeting-log-watermark.storage.ts.
    const consumedTo = entries.length ? Math.max(...entries.map((e) => e.timestamp)) : 0;
    const skipUnwritten = () => {
      if (consumedTo > 0) setSkipWatermark(consumedTo);
    };

    try {
      const state = await loadOdooConfigState();
      if (state.state === "incomplete") {
        // Set up, then a field got cleared. The sweep already goes out of its
        // way to recordErrorOnUnsent for exactly this state "because nothing
        // else can" - here there is no row to record it on at all, so the
        // user is told directly instead of the meeting vanishing with no
        // trace anywhere.
        toast.error(
          `Odoo is set up but incomplete - fill in ${state.missing.join(", ")} in Settings > Odoo`
        );
        skipUnwritten();
        return;
      }
      if (state.state === "absent") {
        // Odoo was never set up. Nothing to tell the user that isn't already
        // obvious from the picker never having offered Odoo at all.
        skipUnwritten();
        return;
      }

      const instance = instanceFingerprint(state.config.url, state.config.db);
      // The skip watermark can only ever push this FORWARD of the real one: a
      // row that IS written always advances getTranscriptWatermark() past
      // whatever an earlier skip recorded, so max() never resurrects a span a
      // written row already covers.
      const watermark = Math.max(await getTranscriptWatermark(), getSkipWatermark());

      // The remount recovery. Keyed on the PERSISTED id, because a remount
      // re-initialises state.currentConversationId to null
      // (useCompletion.ts:118) - the mirrored id is gone exactly when the
      // transcript is. The autosave persists it at useCompletion.ts:381.
      //
      // Unioned, not gated on an empty slice: if the meeting continued after
      // the remount the slice is non-empty and the pre-remount entries would
      // otherwise be dropped.
      const recoveryId = conversationId ?? getActiveConversationId();
      let all = entries;
      if (recoveryId) {
        // Floored at PROCESS_STARTED_AT (see its own comment above) for this
        // call ONLY - sliceTranscript below keeps the plain `watermark`. The
        // in-memory snapshot can never hold a previous run's entries, so
        // there is nothing there to protect against; only this DB read can
        // reach back across a process boundary into a different meeting.
        const recoveryFloor = Math.max(watermark, PROCESS_STARTED_AT);
        // A THROW here is not an empty result. Letting it collapse into
        // "no meeting" loses the meeting silently, which is the exact failure
        // this path was added to close - so it propagates to the catch below
        // and writes no row rather than a wrong one.
        const recovered = await readMeetingMessages(recoveryId, recoveryFloor);
        if (recovered.length > 0) {
          const seen = new Set(entries.map((e) => e.timestamp));
          all = [...recovered.filter((e) => !seen.has(e.timestamp)), ...entries];
        }
      }

      const slice = sliceTranscript(all, watermark);
      if (!slice) return; // a genuinely silent meeting is not a meeting

      // Deleted in Task 14, when targetRef becomes a real multi-select.
      const targets = [target ? resolvedToSelected(target) : null].filter(
        (t): t is SelectedTarget => t !== null
      );

      const rowId = crypto.randomUUID();
      const created = await insertQueueRow({
        id: rowId,
        // Keyed on recoveryId, NOT the raw conversationId. A mid-meeting
        // remount is documented reachable (useOdooTarget.ts:73-80): trigger A
        // (pre-remount) sees conversationId "c1", trigger B (post-remount,
        // recovering through getActiveConversationId()) sees a mirrored null
        // that resolves to the SAME "c1" as its recoveryId. Keying on the raw
        // id would give "c1:1000" and "1000" for one meeting - two different
        // session keys, so ON CONFLICT(session_key) DO NOTHING never catches
        // the duplicate and two `held` rows get written for it. Keying both
        // on recoveryId makes them collide as intended. This cannot falsely
        // collide two DIFFERENT meetings: slice.startAt is always strictly
        // above the watermark, and every already-stored row's
        // transcript_start_at <= transcript_end_at <= that same watermark.
        sessionKey: sessionKeyFor(recoveryId, slice.startAt),
        // Stored as recoveryId too - the fallback path used to persist NULL
        // here even when it had just recovered the conversation via
        // getActiveConversationId(), losing the link slice 3 needs.
        conversationId: recoveryId,
        instance,
        targets,
        transcript: renderTranscript(slice.entries),
        transcriptStartAt: slice.startAt,
        transcriptEndAt: slice.endAt,
        meetingStartedAt: slice.startAt,
        status: targets.length ? "held" : "unassigned",
        createdAt: Date.now(),
      });

      // The other trigger won. Normal outcome: no hold, no push, no error.
      // No skip-mark either: the row THAT trigger wrote already advanced the
      // real watermark past this span.
      if (!created) return;
      // An unassigned row has no hold and no push - slice 3 owns it. Telling
      // the user a meeting is being logged when nothing will be sent is worse
      // than saying nothing.
      //
      // `startHold` is the SOLE writer of heldRowIdRef. Do not assign it here:
      // Task 10's startHold reads the previous value to decide whether a
      // displaced row needs pushing, and a pre-assignment here would make
      // `displaced === rowId` on every call, silently disabling that branch.
      if (targets.length) startHold(rowId);
    } catch (err) {
      // SURFACED, not just logged. Reaching here means no row was written, so
      // to the user this is indistinguishable from "the meeting was silent" -
      // which is the exact failure the write-ahead design exists to prevent.
      // The repo already toasts transcript loss from useCompletion.ts:415.
      console.error("[Odoo] meeting log trigger failed:", err);
      toast.error("This meeting could not be queued for Odoo.");
      skipUnwritten();
    } finally {
      inFlightRef.current = false;
    }
  }, [isOwner, startHold, targetRef]);

  const triggerRef = useRef(trigger);
  useLayoutEffect(() => {
    triggerRef.current = trigger;
  });

  /**
   * Keyed on OWNERSHIP ONLY, never on the selection.
   *
   * Not because "the target changes on every streamed AI chunk" - that is
   * false; `target` is useState and changes only when setTarget runs. The real
   * reasons: re-keying tears down and re-registers meeting-ended on every
   * re-pick with a lossy async listen() gap each time, and values that DO
   * change per commit (the transcript above all) must be read from refs.
   */
  useEffect(() => {
    if (!isOwner) return;
    let cancelled = false;
    let un: (() => void) | undefined;
    // listen() returns a PROMISE of the unlisten fn. Under StrictMode the first
    // mount's listen() resolves AFTER the first cleanup ran, so without the
    // flag the second handler leaks permanently. See useOdooTarget.ts:346-364.
    void listen("meeting-ended", () => void triggerRef.current()).then((fn) => {
      if (cancelled) fn();
      else un = fn;
    });
    return () => {
      cancelled = true;
      un?.();
    };
  }, [isOwner]);

  /**
   * The pill-off edge. COMPARE BEFORE ASSIGN, in ONE layout effect.
   *
   * Every other ref mirror in this repo is a write-only useLayoutEffect, so
   * this is spelled out deliberately: mirroring here and comparing in a passive
   * useEffect gives a PERMANENTLY DEAD trigger - layout effects flush first, so
   * the comparison would always see the already-updated value. That would
   * silently remove the only trigger that works where the Rust watcher does not
   * run, i.e. all logging on macOS and Linux.
   */
  const prevPillRef = useRef(meetingAssistMode);
  useLayoutEffect(() => {
    const prev = prevPillRef.current;
    prevPillRef.current = meetingAssistMode;
    if (prev && !meetingAssistMode) void triggerRef.current();
  }, [meetingAssistMode]);

  // App start - and ONCE PER PROCESS, not once per mount.
  //
  // `sweptThisProcess` is module-level for the same reason meeting-log-push's
  // `claimed` is: <Completion /> remount mid-session is documented reachable
  // (useOdooTarget.ts:76-81), and the sweep's own single flight only joins
  // CONCURRENT runs. Without this flag a remount storm while Odoo is
  // unreachable re-pushes every pending row and walks `attempts` to
  // ESCALATE_AFTER_ATTEMPTS - moving rows into "needs attention" for a reason
  // that has nothing to do with the user.
  //
  // The `void` carries a .catch(): runMeetingLogSweep awaits its reclaim and
  // select outside any try, so a DB failure there would escape a React effect
  // as an unhandled rejection - the exact escape path errors.ts:6-18 exists to
  // close.
  // The latch is set on the OUTCOME, not before the run. runMeetingLogSweep
  // returns { ran: false } - it never throws - when the config is absent or
  // half-filled, or when the queue read fails. Latching first would mean a
  // launch with incomplete credentials permanently disables the sweep: the user
  // opens /odoo, sees the stranded total, completes their credentials, comes
  // back, and nothing flushes until an app restart. `sweepInFlight` inside the
  // sweep already joins concurrent runs, and a ran:false retry costs one config
  // read with no `attempts` increment, so this cannot reopen the remount-storm
  // hole the guard exists to close.
  useEffect(() => {
    if (!isOwner || sweptThisProcess) return;
    void runMeetingLogSweep((slice) => summarize(slice.entries))
      .then((outcome) => {
        if (outcome.ran) sweptThisProcess = true;
      })
      .catch((err) => {
        console.error("[Odoo] meeting log sweep failed:", err);
      })
      // Retention. UNCONDITIONAL and outside the `if (outcome.ran)` guard:
      // `ran` is false whenever the config is absent or half-filled, so a
      // prune inside that guard means a user who removes their credentials
      // keeps every stored transcript and digest forever. It takes no config
      // and does not care whether Odoo is reachable.
      //
      // Its OWN catch, not the sweep's: one shared chain would log a prune
      // failure under "[Odoo] meeting log sweep failed" and make the two
      // indistinguishable.
      .then(() => runTranscriptPrune(Date.now()))
      // Same reasoning as the prune above: UNCONDITIONAL, because an orphaned
      // target row needs no Odoo config to exist. runOrphanSweep carries its
      // own try/catch, so no trailing .catch is needed here either.
      .then(() => runOrphanSweep());
    // NO trailing .catch here. `runTranscriptPrune` and `runOrphanSweep` both
    // swallow and log their own failure, so a second catch carrying one of
    // their messages would be dead code in production and a copy that can
    // drift. The `void` plus the sweep's catch above already cover the sweep leg.
  }, [isOwner, summarize]);

  /**
   * A <Completion /> remount mid-hold must not strand the row.
   *
   * It does NOT register in meeting-log-push's `claimed` set: the sweep never
   * selects an in-window `held` row, and if a stale-held row is ever contested
   * the CAS arbitrates - one writer gets rowsAffected 1, the other 0.
   */
  useEffect(() => {
    if (!isOwner) return;
    let cancelled = false;
    void (async () => {
      try {
        const config = await loadOdooConfigState();
        if (config.state !== "complete" || cancelled) return;
        const instance = instanceFingerprint(config.config.url, config.config.db);
        const now = Date.now();
        const row = await findHeldRow(instance, now);
        if (!row || cancelled) return;
        // NEVER displace through the rehydrate. This effect has two awaits, and
        // a meeting-ended firing in that gap can complete first and arm a hold
        // on a brand-new row. Calling startHold here would then treat that
        // fresh row as `displaced` and push it immediately - posting a
        // just-finished meeting with a ZERO-second undo window, the one thing
        // the hold exists to guarantee. If a hold is already running, the
        // rehydrated row simply goes straight to the push it was owed.
        if (heldRowIdRef.current) {
          // Only push a row we are NOT already holding. findHeldRow orders
          // newest-first, so in the very scenario this guard exists for - a
          // meeting-ended completing inside this effect's await gap - the row
          // it returns IS the fresh one, and pushing it would post a
          // just-finished meeting with a zero-second undo window. The armed
          // timer hides it: at t=30s the row reads `sent` and pushHeldRow bails.
          if (row.id !== heldRowIdRef.current) void pushHeldRow(row.id);
          return;
        }
        const remaining = Math.max(0, row.created_at + HOLD_MS - now);
        startHold(row.id, remaining);
      } catch (err) {
        console.error("[Odoo] hold rehydrate failed:", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isOwner, startHold, pushHeldRow]);

  // Closes over the stable ref OBJECTS, not their values, so teardown reads
  // whatever the latest startHold wrote.
  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (blockedTimerRef.current) clearTimeout(blockedTimerRef.current);
  }, []);

  /**
   * The blocked message is TRANSIENT.
   *
   * <Completion /> renders the strip whenever `holding || undoBlockedMessage`
   * and swaps out the ContactPicker trigger to do it. A message that never
   * cleared would therefore replace the picker PERMANENTLY - the user could not
   * choose a contact for the next meeting, and the only thing that clears it
   * would be a new hold, which requires a target already selected. The 54px bar
   * has no other route back.
   */
  const showUndoBlocked = useCallback((message: string) => {
    setUndoBlockedMessage(message);
    if (blockedTimerRef.current) clearTimeout(blockedTimerRef.current);
    blockedTimerRef.current = setTimeout(() => {
      blockedTimerRef.current = null;
      setUndoBlockedMessage(null);
    }, UNDO_BLOCKED_MS);
  }, []);

  const onUndo = useCallback(() => {
    const rowId = heldRowIdRef.current;
    if (!rowId) return;
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setHolding(false);
    void (async () => {
      try {
        // CAS. Whichever writer wins, the loser's rowsAffected is 0 - and the
        // loser here is the USER, who clicked Undo and whose meeting posts
        // anyway. Saying so is the whole point of the window.
        if (await cancelHeldRow(rowId)) {
          // Only if nothing newer has taken the ref since this undo started -
          // a hold that started while this cancel was in flight owns it now,
          // and clearing unconditionally would lie about THAT row's state.
          // Without this at all, a second onUndo() after a successful cancel
          // re-runs cancelHeldRow on an already-cancelled row, gets 0 rows
          // back, and tells the user "already being sent to Odoo" - the
          // opposite of the truth.
          if (heldRowIdRef.current === rowId) heldRowIdRef.current = null;
        } else {
          showUndoBlocked("This meeting is already being sent to Odoo.");
        }
      } catch (err) {
        // The CAS write itself failed - this is not a lost race. The timer
        // is already cleared, so nothing is sending this row; it stays
        // `held`, durable, for the sweep's stale-held rescue to pick up
        // later. "Already being sent" would be false here.
        console.error("[Odoo] undo failed:", err);
        showUndoBlocked("Undo could not be saved - this meeting will be sent later.");
      }
    })();
  }, [showUndoBlocked]);

  return { holding, onUndo, undoBlockedMessage };
}
