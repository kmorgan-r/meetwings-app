import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  type Dispatch,
  type SetStateAction,
} from "react";

import { setPillActions } from "@/lib/overlay-minimize.store";

export type UsePillRecordActionOptions = {
  meetingAssistMode: boolean;
  setMeetingAssistMode: Dispatch<SetStateAction<boolean>>;
  enableVAD: boolean;
  setEnableVAD: Dispatch<SetStateAction<boolean>>;
  /**
   * Audio.tsx's `canUseVoice` (`meetwingsApiEnabled || selectedSttProvider.provider`).
   * Without it the mic opens onto a provider that cannot transcribe, so the
   * pill would go red and collect nothing.
   */
  canRecord: boolean;
};

/**
 * Publishes "start/stop a meeting recording" to the minimized pill.
 *
 * Mounted from <Completion />, which owns `meetingAssistMode` and `enableVAD`;
 * the pill renders as a sibling of the Card and can only reach them through
 * the module store.
 *
 * The pair it writes is the SAME state useMeetingAutoRecord enters on its
 * "start-meeting" decision (useMeetingAutoRecord.ts:407-409), so a manual
 * session and an auto-detected one are indistinguishable downstream:
 * useMeetingAudio is gated on `meetingAssistMode && enableVAD` (Audio.tsx:124),
 * and useMeetingLog's pill-off effect (useMeetingLog.ts:453-458) fires the
 * Odoo log on the true->false transition. It deliberately writes NO
 * provenance - `startedModeRef` stays null, so every branch of auto-record's
 * ownership layout effect skips a manual session and cannot stop it out from
 * under the user.
 *
 * No flush call here either: setMeetingAssistMode already flushes the unsaved
 * transcript on true->false (useCompletion.ts:563-567).
 */
export const usePillRecordAction = ({
  meetingAssistMode,
  setMeetingAssistMode,
  enableVAD,
  setEnableVAD,
  canRecord,
}: UsePillRecordActionOptions) => {
  // Mirror, not deps. Registering a fresh closure per render would push a new
  // object through setPillActions on EVERY render, and <Completion /> re-renders
  // on every streamed AI token - waking the pill's useSyncExternalStore each
  // time. The registered function is created once and reads current state from
  // here, so the store is written only when `canRecord` flips.
  //
  // useLayoutEffect, NOT useEffect, matching the mirror in
  // useMeetingAutoRecord.ts:159-164: a layout effect commits the sync
  // synchronously, before the browser can dispatch anything at the pill,
  // whereas a passive effect is only scheduled at that point. The click that
  // reads this ref is a user event on another part of the tree, so nothing
  // here re-renders on the toggle - the mirror is the only thing keeping the
  // stable callback current.
  const stateRef = useRef({ recording: false, setMeetingAssistMode, setEnableVAD });
  useLayoutEffect(() => {
    stateRef.current = {
      recording: meetingAssistMode && enableVAD,
      setMeetingAssistMode,
      setEnableVAD,
    };
  });

  // [] deps: stable for the component's whole life, so the effect below is
  // driven by `canRecord` alone.
  const toggleRecording = useCallback(() => {
    const { recording, setMeetingAssistMode, setEnableVAD } = stateRef.current;
    // Both setters in one handler, so React commits one state change: the
    // guest half (meetingAssistMode) and the mic (enableVAD) must never be
    // observed half-flipped by useMeetingAudio's `enabled` gate.
    if (recording) {
      setEnableVAD(false);
      setMeetingAssistMode(false);
      return;
    }
    setMeetingAssistMode(true);
    setEnableVAD(true);
  }, []);

  useEffect(() => {
    setPillActions({ toggleRecording: canRecord ? toggleRecording : null });
    // Cleared on unmount, not left dangling: <Completion /> unmounts with the
    // Card subtree on an error boundary reset, and a pill still holding that
    // closure would write state into a dead tree.
    return () => setPillActions({ toggleRecording: null });
  }, [canRecord, toggleRecording]);
};
