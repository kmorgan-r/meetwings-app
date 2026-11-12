import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { buildSnapshot, type CalendarSnapshot } from "@/lib/calendar/calendar-snapshot";
import {
  OUTLOOK_CHECK_TIMEOUT_MS,
  decideCheckOne,
  withTimeout,
} from "@/lib/calendar/auto-notion";
import { pickCurrentMeeting } from "@/lib/calendar/current-meeting";
import { fetchCurrentMeetings } from "@/lib/calendar/fetch-current-meetings";
import { fetchCurrentGoogleMeetings } from "@/lib/calendar/fetch-google-meetings";
import {
  deleteCalendarSnapshot,
  saveCalendarSnapshot,
} from "@/lib/database/calendar-snapshot.action";
import { GOOGLE_CONNECTION_CHANGED_EVENT } from "@/lib/storage/google-config.storage";
import type { UseNotionPickReturn } from "@/hooks/useNotionPick";

export interface GoogleMeetingCaptureInputs {
  currentConversationId: string | null;
  /** True when Notion is available to tick; false makes no Outlook read. */
  tickEnabled: boolean;
  notionPick: Pick<UseNotionPickReturn, "autoTick" | "autoUntick" | "handTouchesRef">;
}

type Pending = { kind: "save"; snapshot: CalendarSnapshot } | { kind: "delete" };

/**
 * When meeting capture starts, reads Google Calendar once and stores the
 * current meeting's guests as the conversation's snapshot. Exactly one current
 * meeting is stored; none, several, absent or an error removes the older
 * snapshot (spec 6.1: never guess). Fire-and-forget: it never throws into the
 * capture dispatch and never delays the recording.
 */
export function useGoogleMeetingCapture(inputs: GoogleMeetingCaptureInputs): void {
  // Declared BEFORE the flush layout effect so flush sees the new id on the
  // same commit.
  const latest = useRef(inputs);
  useLayoutEffect(() => {
    latest.current = inputs;
  });

  // Bumped by every capture start and by a Google connection change.
  const readSeq = useRef(0);
  // Bumped by newConversationStarted only (not odooTargetsCleared, spec 8.3).
  const convGen = useRef(0);
  // Bumped by newConversationStarted AND odooTargetsCleared: guards the tick.
  const tickGen = useRef(0);
  const pending = useRef<Pending | null>(null);
  const chain = useRef<Promise<void>>(Promise.resolve());

  const flush = useCallback(() => {
    const job = pending.current;
    // The rollover dispatches meetingCaptureStarted before React commits the
    // null id, so a result resolving before that commit would flush to the
    // previous conversation. Safe only because the read awaits IPC plus HTTP.
    const id = latest.current.currentConversationId;
    if (!job || !id) return;
    pending.current = null;
    const now = Date.now();
    const write = () =>
      job.kind === "save"
        ? saveCalendarSnapshot(id, job.snapshot, now)
        : deleteCalendarSnapshot(id);
    chain.current = chain.current.then(write).catch(() => {});
  }, []);

  useLayoutEffect(() => {
    flush();
  }, [inputs.currentConversationId, flush]);

  useEffect(() => {
    const onNewConversation = () => {
      convGen.current += 1;
      tickGen.current += 1;
      pending.current = null;
    };
    // Drops a late tick but never the snapshot (spec 8.3).
    const onTargetsCleared = () => {
      tickGen.current += 1;
    };
    window.addEventListener("newConversationStarted", onNewConversation);
    window.addEventListener("odooTargetsCleared", onTargetsCleared);
    return () => {
      window.removeEventListener("newConversationStarted", onNewConversation);
      window.removeEventListener("odooTargetsCleared", onTargetsCleared);
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen(GOOGLE_CONNECTION_CHANGED_EVENT, () => {
      readSeq.current += 1;
      pending.current = null;
    }).then((fn) => {
      if (disposed) {
        fn();
        return;
      }
      unlisten = fn;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    const run = async () => {
      const seq = ++readSeq.current;
      const gen = convGen.current;
      // Captured before any await: the touch count at the event, and the
      // tick generation.
      const tick = tickGen.current;
      const touches = latest.current.notionPick.handTouchesRef.current;
      const tickEnabled = latest.current.tickEnabled;
      const now = Date.now();
      const g = fetchCurrentGoogleMeetings(now);
      // Always read, whatever the auto-select setting. Never rejects, so it
      // is safe to leave unawaited if the Google result is dropped.
      const o = tickEnabled
        ? withTimeout(fetchCurrentMeetings(), OUTLOOK_CHECK_TIMEOUT_MS)
        : null;
      const result = await g;
      if (seq !== readSeq.current || gen !== convGen.current) return;
      const pick = result.kind === "ok" ? pickCurrentMeeting(result.events, now) : null;
      pending.current =
        result.kind === "ok" && pick?.kind === "one"
          ? { kind: "save", snapshot: buildSnapshot(pick.event, result.ownAddress) }
          : { kind: "delete" };
      flush();
      if (!o) return;
      // The snapshot is already stored; only the tick waits on Outlook.
      const outlook = await o;
      if (seq !== readSeq.current || tick !== tickGen.current) return;
      const { notionPick } = latest.current;
      if (decideCheckOne(result, outlook, now) === "tick") notionPick.autoTick(touches);
      else notionPick.autoUntick();
    };
    const onCaptureStarted = () => {
      run().catch(() => {});
    };
    window.addEventListener("meetingCaptureStarted", onCaptureStarted);
    return () => window.removeEventListener("meetingCaptureStarted", onCaptureStarted);
  }, [flush]);
}
