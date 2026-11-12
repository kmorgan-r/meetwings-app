import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { buildSnapshot, type CalendarSnapshot } from "@/lib/calendar/calendar-snapshot";
import { pickCurrentMeeting } from "@/lib/calendar/current-meeting";
import { fetchCurrentGoogleMeetings } from "@/lib/calendar/fetch-google-meetings";
import {
  deleteCalendarSnapshot,
  saveCalendarSnapshot,
} from "@/lib/database/calendar-snapshot.action";
import { GOOGLE_CONNECTION_CHANGED_EVENT } from "@/lib/storage/google-config.storage";

export interface GoogleMeetingCaptureInputs {
  currentConversationId: string | null;
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
      pending.current = null;
    };
    window.addEventListener("newConversationStarted", onNewConversation);
    return () => window.removeEventListener("newConversationStarted", onNewConversation);
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
      const now = Date.now();
      const result = await fetchCurrentGoogleMeetings(now);
      if (seq !== readSeq.current || gen !== convGen.current) return;
      const pick = result.kind === "ok" ? pickCurrentMeeting(result.events, now) : null;
      pending.current =
        result.kind === "ok" && pick?.kind === "one"
          ? { kind: "save", snapshot: buildSnapshot(pick.event, result.ownAddress) }
          : { kind: "delete" };
      flush();
    };
    const onCaptureStarted = () => {
      run().catch(() => {});
    };
    window.addEventListener("meetingCaptureStarted", onCaptureStarted);
    return () => window.removeEventListener("meetingCaptureStarted", onCaptureStarted);
  }, [flush]);
}
