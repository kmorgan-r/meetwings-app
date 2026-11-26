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
import { detectionLog } from "@/lib/detection-log";
import {
  deleteCalendarSnapshot,
  saveCalendarSnapshot,
} from "@/lib/database/calendar-snapshot.action";
import { amberKindFor } from "@/lib/meeting-detect";
import {
  dismissAmber,
  getActiveAutoRecording,
  setCardEvent,
  showAmber,
  type ActiveAutoRecording,
} from "@/lib/meeting-cards.store";
import { GOOGLE_CONNECTION_CHANGED_EVENT } from "@/lib/storage/google-config.storage";
import type { UseNotionPickReturn } from "@/hooks/useNotionPick";

export interface GoogleMeetingCaptureInputs {
  currentConversationId: string | null;
  /** True when Notion is available to tick; false makes no Outlook read. */
  tickEnabled: boolean;
  notionPick: Pick<UseNotionPickReturn, "autoTick" | "autoUntick" | "handTouchesRef">;
}

// Names one failed-read warning; survives remounts so a new one never reuses an id.
let amberEpisode = 0;

type Pending ={ kind: "save"; snapshot: CalendarSnapshot } | { kind: "delete" };

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
  // Bumped by newConversationStarted and conversationLoaded (not
  // odooTargetsCleared, spec 8.3).
  const convGen = useRef(0);
  // Bumped by those two AND odooTargetsCleared: guards the tick.
  const tickGen = useRef(0);
  const pending = useRef<Pending | null>(null);
  const chain = useRef<Promise<void>>(Promise.resolve());

  const flush = useCallback(() => {
    const job = pending.current;
    // The rollover dispatches meetingCaptureStarted before React commits the
    // null id, so a result resolving before that commit would flush to the
    // previous conversation. Safe only because the read awaits IPC plus HTTP.
    // Opening another conversation mid-read drops the result instead
    // (conversationLoaded below): no snapshot beats the wrong one.
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
      if (arm.current) dismissAmber(arm.current.episode);
      arm.current = null;
    };
    // Drops a late tick but never the snapshot (spec 8.3).
    const onTargetsCleared = () => {
      tickGen.current += 1;
    };
    window.addEventListener("newConversationStarted", onNewConversation);
    window.addEventListener("conversationLoaded", onNewConversation);
    window.addEventListener("odooTargetsCleared", onTargetsCleared);
    return () => {
      window.removeEventListener("newConversationStarted", onNewConversation);
      window.removeEventListener("conversationLoaded", onNewConversation);
      window.removeEventListener("odooTargetsCleared", onTargetsCleared);
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen(GOOGLE_CONNECTION_CHANGED_EVENT, () => {
      readSeq.current += 1;
      pending.current = null;
      if (arm.current) read.current("reconnect", arm.current.at).catch(() => {});
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

  // Held across renders so the capture and connection-changed listeners share
  // one read. Re-assigned each run of the effect below.
  const read = useRef<(src: "capture" | "reconnect", at: number) => Promise<void>>(
    async () => {}
  );
  // Set by a capture read that errored: lets a Google reconnect re-read the
  // same meeting (at the capture-start time, for the same recording).
  const arm = useRef<{
    at: number;
    rec: ActiveAutoRecording | null;
    gen: number;
    episode: number;
  } | null>(null);

  useEffect(() => {
    read.current = async (src, at) => {
      // Read synchronously: a result landing after a newer recording started
      // must not label it (setCardEvent ignores the stale id). A reconnect
      // read labels the recording the capture read saw.
      const rec = src === "capture" ? getActiveAutoRecording() : arm.current!.rec;
      const seq = ++readSeq.current;
      const gen = src === "capture" ? convGen.current : arm.current!.gen;
      // Captured before any await: the touch count at the event, and the
      // tick generation.
      const tick = tickGen.current;
      const touches = latest.current.notionPick.handTouchesRef.current;
      const tickEnabled = src === "capture" && latest.current.tickEnabled;
      const now = at;
      const g = fetchCurrentGoogleMeetings(now);
      // Always read, whatever the auto-select setting. Never rejects, so it
      // is safe to leave unawaited if the Google result is dropped.
      const o = tickEnabled
        ? withTimeout(fetchCurrentMeetings(), OUTLOOK_CHECK_TIMEOUT_MS)
        : null;
      const result = await g;
      if (seq !== readSeq.current || gen !== convGen.current) {
        detectionLog(`google read stale src=${src}`);
        return;
      }
      const pick = result.kind === "ok" ? pickCurrentMeeting(result.events, now) : null;
      if (result.kind === "ok") {
        detectionLog(`google read ok events=${result.events.length} pick=${pick?.kind} src=${src}`);
      } else if (result.kind === "error") {
        detectionLog(`google read error ${result.code} src=${src}`);
      } else {
        detectionLog(`google read absent src=${src}`);
      }
      if (result.kind === "error") {
        if (src === "capture") {
          const episode = arm.current?.episode ?? ++amberEpisode;
          showAmber({ variant: amberKindFor(result.code, result.config), episode });
          arm.current = { at, rec, gen, episode };
        }
      } else {
        if (arm.current) dismissAmber(arm.current.episode);
        arm.current = null;
      }
      if (rec?.gated && result.kind === "ok" && pick?.kind === "one") {
        setCardEvent(rec.id, pick.event, result.ownAddress);
      }
      pending.current =
        result.kind === "ok" && pick?.kind === "one"
          ? { kind: "save", snapshot: buildSnapshot(pick.event, result.ownAddress) }
          : { kind: "delete" };
      flush();
      if (!o) return;
      // The snapshot is already stored; only the tick waits on Outlook.
      const outlook = await o;
      if (seq !== readSeq.current || tick !== tickGen.current) return;
      // Notion may have become unavailable while Outlook was pending.
      if (!latest.current.tickEnabled) return;
      const { notionPick } = latest.current;
      if (decideCheckOne(result, outlook, now) === "tick") notionPick.autoTick(touches);
      else notionPick.autoUntick();
    };
  }, [flush]);

  useEffect(() => {
    const onCaptureStarted = () => {
      read.current("capture", Date.now()).catch(() => {});
    };
    window.addEventListener("meetingCaptureStarted", onCaptureStarted);
    return () => window.removeEventListener("meetingCaptureStarted", onCaptureStarted);
  }, []);
}
