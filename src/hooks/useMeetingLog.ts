import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { toast } from "sonner";
import {
  getTranscriptWatermark,
  insertQueueRow,
  readMeetingMessages,
} from "@/lib/database/meeting-log.action";
import { generateMeetingLogSummary } from "@/lib/functions/meeting-summarizer";
import { renderTranscript, sessionKeyFor, sliceTranscript } from "@/lib/odoo/meeting-log";
import { runMeetingLogSweep } from "@/lib/odoo/meeting-log-push";
import { getActiveConversationId } from "@/lib/storage/active-conversation.storage";
import { instanceFingerprint, loadOdooConfigState } from "@/lib/storage/odoo-config.storage";
import type { ResolvedTarget, TranscriptEntry } from "@/types";
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

/** Test-only. Lets a suite start each case from a clean process state. */
export function resetMeetingLogSweepGuard(): void {
  sweptThisProcess = false;
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
   * Task 10 replaces this stub with the real timer.
   *
   * It already flips `holding` so `tsconfig`'s `noUnusedLocals` is satisfied at
   * Task 9's commit - a task must never commit a tree where `npm run type-check`
   * fails.
   */
  const startHold = useCallback((rowId: string) => {
    heldRowIdRef.current = rowId;
    setHolding(true);
    setUndoBlockedMessage(null);
  }, []);

  const trigger = useCallback(async () => {
    if (!isOwner || inFlightRef.current) return;
    inFlightRef.current = true;
    try {
      // Snapshot SYNCHRONOUSLY, before any await. Without it a user clearing
      // the transcript or re-picking a contact mid-push splices two meetings.
      const entries = transcriptRef.current;
      const target = targetRef.current;
      const conversationId = conversationIdRef.current;

      const state = await loadOdooConfigState();
      if (state.state !== "complete") return; // instance is NOT NULL

      const instance = instanceFingerprint(state.config.url, state.config.db);
      const watermark = await getTranscriptWatermark();

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
        // A THROW here is not an empty result. Letting it collapse into
        // "no meeting" loses the meeting silently, which is the exact failure
        // this path was added to close - so it propagates to the catch below
        // and writes no row rather than a wrong one.
        const recovered = await readMeetingMessages(recoveryId, watermark);
        if (recovered.length > 0) {
          const seen = new Set(entries.map((e) => e.timestamp));
          all = [...recovered.filter((e) => !seen.has(e.timestamp)), ...entries];
        }
      }

      const slice = sliceTranscript(all, watermark);
      if (!slice) return; // a genuinely silent meeting is not a meeting

      const rowId = crypto.randomUUID();
      const created = await insertQueueRow({
        id: rowId,
        sessionKey: sessionKeyFor(conversationId, slice.startAt),
        conversationId,
        instance,
        contactId: target?.contactId ?? null,
        leadId: target?.leadId ?? null,
        transcript: renderTranscript(slice.entries),
        transcriptStartAt: slice.startAt,
        transcriptEndAt: slice.endAt,
        meetingStartedAt: slice.startAt,
        status: target ? "held" : "unassigned",
        createdAt: Date.now(),
      });

      // The other trigger won. Normal outcome: no hold, no push, no error.
      if (!created) return;
      // An unassigned row has no hold and no push - slice 3 owns it. Telling
      // the user a meeting is being logged when nothing will be sent is worse
      // than saying nothing.
      //
      // `startHold` is the SOLE writer of heldRowIdRef. Do not assign it here:
      // Task 10's startHold reads the previous value to decide whether a
      // displaced row needs pushing, and a pre-assignment here would make
      // `displaced === rowId` on every call, silently disabling that branch.
      if (target) startHold(rowId);
    } catch (err) {
      // SURFACED, not just logged. Reaching here means no row was written, so
      // to the user this is indistinguishable from "the meeting was silent" -
      // which is the exact failure the write-ahead design exists to prevent.
      // The repo already toasts transcript loss from useCompletion.ts:415.
      console.error("[Odoo] meeting log trigger failed:", err);
      toast.error("This meeting could not be queued for Odoo.");
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
      });
  }, [isOwner, summarize]);

  // Closes over the stable ref OBJECTS, not their values, so teardown reads
  // whatever the latest startHold wrote.
  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (blockedTimerRef.current) clearTimeout(blockedTimerRef.current);
  }, []);

  const onUndo = useCallback(() => {}, []); // Task 10

  return { holding, onUndo, undoBlockedMessage };
}
