import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type Dispatch,
  type SetStateAction,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { toast } from "sonner";
import { safeLocalStorage } from "@/lib";
import { isWindows } from "@/lib/platform";
import {
  decideOnDetected,
  decideOnEnded,
  decideOnWatcherStopped,
  isSameCall,
  type StartedMode,
} from "@/lib/functions/meeting-auto-record";
import { isGatedProcess, meetingLabel } from "@/lib/meeting-detect";
import { detectionLog } from "@/lib/detection-log";
import {
  autoRecordingStarted,
  autoRecordingStopped,
  showStopNotice,
  type StopNoticeReason,
} from "@/lib/meeting-cards.store";
import {
  peekRecordingStopCap,
  setRecordingStopCap,
  type RecordingStopCap,
} from "@/lib/recording-stop-cap";
import { fetchCurrentMeetings } from "@/lib/calendar/fetch-current-meetings";
import { fetchCurrentGoogleMeetings } from "@/lib/calendar/fetch-google-meetings";
import type { CalendarEvent } from "@/types";
import type { TranscriptEntry } from "@/types/completion";
import {
  CALL_END_GRACE_MS,
  SAME_CALL_READ_TIMEOUT_MS,
  SILENCE_STOP_MS,
  STOP_CONFIRM_ATTEMPTS,
  STOP_CONFIRM_INTERVAL_MS,
  STORAGE_KEYS,
} from "@/config/constants";

/**
 * The pre-#32 key. Used as a literal on purpose: the constant is gone, and
 * reintroducing it just to delete it invites someone to read from it again.
 */
const LEGACY_DETECTION_KEY = "meeting_detection_enabled";

export const VAD_MESSAGE =
  "Auto-record needs voice detection — enable it in audio settings to record future calls";
export const STUCK_MESSAGE =
  "Auto-record could not start — restart Meetwings if it keeps happening";
/**
 * Deliberately self-contained. An earlier draft pointed the user at the recording
 * panel for details - but the failure branch calls stopCapture immediately after
 * toasting, and that clears `error` and closes the popover, so the panel would be
 * empty by the time anyone looked. On Windows this is also the COMMON branch, not
 * a rare fallback: check_system_audio_access cannot fail there, so systemAudio.error
 * is usually empty.
 */
export const GENERIC_START_MESSAGE = "Could not start recording for this call";
export const STOP_FAILED_MESSAGE =
  "Could not stop the recording — stop it manually";
/**
 * The transcribing copy tells the user to stop it manually, which works there:
 * systemAudio.capturing is true, so the app page renders the visualizer and the
 * SystemAudio button reads "Stop system audio capture"
 * (src/pages/app/components/speech/index.tsx:85). After a MEETING auto-stop none
 * of that holds - capturing is false, the block does not render, the mic is
 * already closed, and that button reads "Start system audio capture" (:86).
 */
export const MEETING_STOP_FAILED_MESSAGE =
  "Recording may still be running — restart Meetwings if audio keeps being captured";
export const MEETING_WATCHER_STOPPED_MESSAGE =
  "Meeting detection stopped — still recording this call. Press the record button to end it.";
export const WATCHER_STOPPED_MESSAGE =
  "Meeting detection stopped — still recording. Stop manually when the call ends.";

/** The slice of `useSystemAudio` this hook drives. */
export type MeetingAutoRecordAudio = {
  capturing: boolean;
  error: string;
  vadConfig: { enabled: boolean };
  startCapture: () => Promise<void>;
  stopCapture: () => Promise<void>;
};

export type MeetingAutoRecordOptions = {
  systemAudio: MeetingAutoRecordAudio;
  enableVAD: boolean;
  setEnableVAD: Dispatch<SetStateAction<boolean>>;
  meetingAssistMode: boolean;
  flushUnsavedMeetingTranscript: () => Promise<void>;
  /**
   * Session-wide transcript. Read for its LENGTH (silence timer) and its count
   * of system-audio lines (call-end grace restart); never for content.
   */
  meetingTranscript: TranscriptEntry[];
  /**
   * Clears the conversation (and its Odoo targets). Called when a detection
   * during the grace turns out to be a NEW call. Its identity changes with every
   * transcript line, so it is mirrored into a ref, never listed in effect deps.
   */
  startNewConversation: () => Promise<void>;
};

/**
 * A running call-end grace. Mutated in place by a re-arm, never replaced, so a
 * holder can compare it by identity across a restart.
 */
type Grace = {
  endedAt: number;
  endedProcess: string | undefined;
  gen: number;
  timer: ReturnType<typeof setTimeout> | null;
};

/**
 * Starts and stops recording around detected Teams calls. VAD sessions only.
 *
 * Single-owner: Tauri events broadcast to every window, so only the main window
 * may drive the single global capture. The dashboard window is held off by the
 * label check; the capture-overlay windows never reach it at all.
 *
 * Mount it inside <Completion />, NOT in the app page. It needs enableVAD and
 * meetingAssistMode, which live in useCompletion, and reading them as props is
 * what lets provenance be a local fact rather than a cross-mount protocol.
 *
 * The cost of that placement is stated rather than hidden, and it runs in BOTH
 * directions. <Completion /> is gated on `!setupLoading && setupComplete`
 * (pages/app/index.tsx:84).
 *
 * Late registration: these listeners register AFTER useMeetingDetection starts
 * its watcher, so a call already in progress at launch is not auto-recorded.
 *
 * Unmount: that gate is REACTIVE, not latched. useSetupStatus recomputes
 * isComplete on every render (useSetupStatus.ts:185) and re-runs on
 * verification-status-changed (:96-105), so a true->false flip UNMOUNTS
 * <Completion /> - unregistering every listener here and discarding
 * startedModeRef. A capture this hook auto-started then keeps running, with no
 * meeting-ended able to stop it and no toast. It is reachable MID-CALL:
 * app.context.tsx:490-509 reloads providers on a cross-window `storage` event,
 * which feeds aiConfigured/sttConfigured and therefore isComplete, so another
 * window changing the provider selection is enough. The unmount cleanup below
 * closes this: it flushes, and enqueues the stop for a transcribing session.
 * See the design doc, "What the move costs".
 *
 * `systemAudio` is passed in rather than obtained by calling useSystemAudio()
 * here: `useApp` in @/hooks is a plain hook, not a context, so a second call
 * would create a second, independent copy of the capture state.
 */
export const useMeetingAutoRecord = ({
  systemAudio,
  enableVAD,
  setEnableVAD,
  meetingAssistMode,
  flushUnsavedMeetingTranscript,
  meetingTranscript,
  startNewConversation,
}: MeetingAutoRecordOptions) => {
  // Two gates. The silence timer and the shared stop op need only the main
  // window (they act on this window's own mic, whatever the platform); the
  // detection listeners and grace logic also need Windows.
  const isMain = useMemo(() => getCurrentWindow().label === "main", []);
  const isOwner = isMain && isWindows();

  // Every mutable value a listener reads comes from a ref. The listeners are
  // registered once per window lifetime, and startCapture/stopCapture are
  // useCallbacks whose IDENTITY changes after mount (their deps include vadConfig,
  // which is replaced from localStorage in a mount effect, and conversation, which
  // changes on every transcribed utterance). Mirroring the whole object also keeps
  // it - a fresh literal every render - out of every dependency array.
  //
  // No dependency array on purpose: it must resync on every commit. Assigning in
  // an effect rather than during render satisfies react-hooks/refs.
  //
  // useLayoutEffect, NOT useEffect. A passive effect flushes after paint, so
  // between a commit and the sync the ref holds the PREVIOUS render's object -
  // and a one-commit-stale `stopCapture` closes over a conversation missing the
  // last exchange (its deps include conversation.messages), silently skipping
  // summarization. A layout effect runs synchronously during commit, before any
  // macrotask can deliver a Tauri event. This does not weaken the decideOnEnded
  // rationale: an op resuming on a microtask still beats a render that has not
  // started.
  //
  // NO TEST GUARDS THIS. RTL act()-wraps render/rerender, so passive effects
  // flush before any assertion and reverting to useEffect leaves the whole suite
  // green - F33 catches a captured-at-registration `stopCapture`, not a
  // one-commit-stale one. Keep it deliberately; do not "simplify" it back.
  //
  // `enableVADRef` needs the same timing for its own reason: handleDetected reads
  // it AFTER an IPC round trip to decide whether the mic is already the user's
  // (F38), so a mirror lagging one commit would claim a mic the user had just
  // opened - and the release below would never fire to correct it.
  const systemAudioRef = useRef(systemAudio);
  const enableVADRef = useRef(enableVAD);
  const meetingAssistModeRef = useRef(meetingAssistMode);
  const setEnableVADRef = useRef(setEnableVAD);
  const flushRef = useRef(flushUnsavedMeetingTranscript);
  const startNewConversationRef = useRef(startNewConversation);
  useLayoutEffect(() => {
    systemAudioRef.current = systemAudio;
    enableVADRef.current = enableVAD;
    meetingAssistModeRef.current = meetingAssistMode;
    setEnableVADRef.current = setEnableVAD;
    flushRef.current = flushUnsavedMeetingTranscript;
    startNewConversationRef.current = startNewConversation;

    if (startedModeRef.current !== "meeting") return;
    if (!enableVAD) {
      // Someone closed the mic - the user, or us. Either way we no longer own
      // it. No flush here: the recording-stop edge in useCompletion owns the
      // flush of the unsaved tail for every close of the mic.
      //
      // handleStop releases provenance BEFORE it writes the mic, so this branch
      // never double-fires against it; it is reached only for a close this hook
      // did not perform.
      startedModeRef.current = null;
      autoRecordingStopped();
    } else if (!meetingAssistMode && !stopRequestedRef.current) {
      // Pill off mid-call: the guest half unmounts but the mic stays open and
      // starts auto-submitting to the AI. Do NOT close it inline - enqueue the
      // ordinary stop, so this path gets the same confirmation as
      // meeting-ended.
      //
      // stopRequestedRef is a chain-length optimisation, not a correctness
      // guard: this effect has no dependency array and <Completion /> re-renders
      // on every streamed AI chunk, so without it every commit until the queued
      // op runs enqueues another handleStop. Correctness comes from handleStop
      // nulling provenance, after which repeats decide "ignore".
      //
      // The flush is not here: handleStop closes the mic, and the
      // recording-stop edge in useCompletion flushes on that close.
      stopRequestedRef.current = true;
      enqueue(handleStop);
    }
  });

  // Never read on its own on a start path - every start goes through
  // `enabledRef.current && listenersOkRef.current`. A partial subscription failure
  // leaves the listeners that DID register live, so this ref keeps being updated by
  // meeting-detection-setting-changed while the feature is meant to be off; only
  // the combined flag knows that. A future branch reading this alone would start
  // recordings it cannot stop - exactly what listenersOkRef exists to prevent.
  const enabledRef = useRef(false);
  const startedModeRef = useRef<StartedMode>(null);

  // Cleared if any subscription fails. A hook that registered meeting-detected but
  // NOT meeting-ended would start recordings it can never auto-stop, which is
  // strictly worse than not starting at all - so a partial failure disables the
  // feature rather than half-enabling it. RE-ARMED at the top of each run of the
  // listener effect (see below): StrictMode discards the first mount, and a
  // transient rejection there must not latch the feature off for the window's
  // whole life when the second mount registered everything fine.
  const listenersOkRef = useRef(true);

  // Serializes every capture command, so two capture commands can never overlap.
  // Held in a ref so it outlives individual renders.
  const chainRef = useRef<Promise<unknown>>(Promise.resolve());

  // Read by the confirm loop below, which is a real-timer background process
  // that can outlive this component: after unmount there is nothing left to
  // warn anybody about, and the loop stands down rather than reporting a stop
  // it can no longer observe. Read by handleDetected too, which owns cancelling
  // a start still in flight when the tree goes away - the unmount cleanup
  // cannot, because provenance is not written yet.
  //
  // Lowered by the unmount cleanup below and RE-ARMED by that effect's create
  // body. The `true` initialiser is NOT sufficient on its own: it runs once per
  // ref, and StrictMode's discarded first mount shares the ref. See there.
  const mountedRef = useRef(true);

  // Latched while a stop is queued or in flight, so the pill-off branch can
  // tell "already stopping" from "nothing to stop" and not enqueue a second
  // one. handleStop clears it on EVERY exit - including the "ignore" early
  // return, which sits before the try and so is not covered by the finally.
  // Raised in exactly ONE place - the ownership layout effect's pill-off branch
  // - and always immediately followed by the enqueue of the handleStop that
  // clears it again, which is why it cannot latch. F57 is the case that catches
  // a clear that only ran in the finally.
  const stopRequestedRef = useRef(false);

  // One ref per message: sharing a single budget would let a user who fixes their
  // VAD setting never see a subsequent genuine capture failure.
  const vadToastedRef = useRef(false);
  const stuckToastedRef = useRef(false);
  const startFailToastedRef = useRef(false);

  const toastOnce = (
    ref: { current: boolean },
    message: string,
    kind: "info" | "error"
  ) => {
    if (ref.current) return;
    ref.current = true;
    if (kind === "info") toast.info(message);
    else toast.error(message);
  };

  // The USER-FACING transcript-loss report lives in useCompletion (at the
  // autosave catch, where the failure actually is). This is only a net for an
  // unexpected throw - but it is never an empty catch.
  const reportFlushFailure = (error: unknown) => {
    console.error("Auto-record transcript flush failed:", error);
  };

  // Declared BEFORE the listener effect so it runs first: React runs mount effects
  // in declaration order, and enabledRef must be seeded before any callback reads
  // it. Ungated on purpose - the isOwner gate exists to stop two windows driving
  // one global capture, and a localStorage delete has no such hazard. Gating it
  // would leave the artifact on exactly the machines that can never clear it.
  useEffect(() => {
    enabledRef.current =
      safeLocalStorage.getItem(STORAGE_KEYS.MEETING_AUTO_RECORD_ENABLED) ===
      "true";
    safeLocalStorage.removeItem(LEGACY_DETECTION_KEY);
  }, []);

  const enqueue = (op: () => Promise<unknown>) => {
    // Each link ends in its own catch, or the first rejection leaves the ref
    // holding a rejected promise and every later command is silently skipped for
    // the life of the window.
    chainRef.current = chainRef.current.then(op).catch((error) => {
      console.error("Auto-record command failed:", error);
    });
    return chainRef.current;
  };

  const handleDetected = async (process?: string) => {
    // The op that starts a capture owns cancelling it, because the unmount
    // cleanup cannot: provenance is written two IPC round trips after
    // startCapture(), while Rust sets is_capturing before the first of them
    // (src-tauri/src/speaker/commands.rs:102-105), so a start still in flight
    // is invisible to the cleanup. This first guard covers an op still QUEUED
    // at unmount - the chain is FIFO, so it can resume long after the tree has
    // gone.
    if (!mountedRef.current) return;

    // Read once, synchronously, before any await: the decideOnDetected call
    // below and the ignore-busy re-check further down must see the SAME
    // object, structurally rather than by coincidence of there being no await
    // between them.
    const audio = systemAudioRef.current;

    const enabled = enabledRef.current && listenersOkRef.current;

    // The LIVE pill, mirrored from useCompletion's state, not the persisted
    // setting: this same value both gates the probe below and forks the
    // decision, and the two must not be able to disagree about it.
    const meetingMode = meetingAssistModeRef.current;

    // Meeting Assist Mode only OWNS the capture device while it is ACTUALLY
    // capturing. useMeetingAudio is gated on `meetingAssistMode && enableVAD`
    // (Audio.tsx:124), and enableVAD is transient, unpersisted mic state. The
    // pill alone is therefore far broader than the real conflict: with it on
    // and the mic closed nothing is capturing, and standing down helps
    // nobody. That combination is the DEFAULT (enableVAD starts false,
    // useCompletion.ts:120), so the broad guard silently disabled the whole
    // feature for anyone who left Meeting Assist on.
    //
    // Ask Rust instead of inferring. useMeetingAudio drives the SAME global
    // capture (useMeetingAudio.ts:190 and useSystemAudio.ts:621 both invoke
    // start_system_audio_capture) but does so without touching useSystemAudio's
    // state - which is precisely why `capturing` above cannot see it, and why
    // this query is the only honest signal available.
    //
    // Only pay for the round trip when it can change the outcome: the
    // `enabled` and `capturing` branches are decided before meetingAssist is
    // consulted at all (see the branch order in decideOnDetected) and cost
    // nothing. Default true on a rejected query - an unreadable status must
    // never be taken as licence to stomp a live Meeting Assist session.
    const globalCaptureHeld =
      enabled && !audio.capturing && meetingMode
        ? await invoke<boolean>("get_capture_status").catch(() => true)
        : meetingMode;

    // READ AFTER THE AWAIT. Deliberately the OPPOSITE discipline to the `audio`
    // snapshot above, and the asymmetry is load-bearing: an IPC round trip is a
    // macrotask, so the user can open the mic inside it. A stale `false` here
    // yields "start-meeting", we record provenance, and setEnableVAD(true) is a
    // no-op on an already-true value - leaving a state byte-identical to a
    // legitimate auto-start, with enableVAD never observed false, so ownership
    // is never released and the hook treats the USER's mic as its own
    // recording (card, quiet restart, pill-off stop). A stale
    // meetingMode read self-heals via the layout effect; a stale vadOpen read
    // cannot.
    const vadOpen = enableVADRef.current;

    const decision = decideOnDetected({
      enabled,
      capturing: audio.capturing,
      globalCaptureHeld,
      meetingMode,
      vadOpen,
      vadEnabled: audio.vadConfig.enabled,
    });
    detectionLog(`detected ${process} decision=${decision}`);

    if (decision === "tell-vad") {
      toastOnce(vadToastedRef, VAD_MESSAGE, "info");
      return;
    }

    if (decision === "ignore-busy") {
      // ONLY meaningful in VAD mode, and this guard is load-bearing. In continuous
      // mode `capturing: true` with Rust reporting false is the NORMAL idle state
      // of a manual session: startCapture sets capturing at useSystemAudio.ts:600
      // and returns at :606-609 WITHOUT invoking start_system_audio_capture, which
      // is the only place `is_capturing` is ever set (commands.rs:102-105). So a
      // continuous user waiting to press Enter looks exactly like a stuck mirror.
      if (!audio.vadConfig.enabled) return;

      // In VAD mode the two should agree, so a disagreement is real: the mirror
      // can be stuck true forever because setCapturing(false) exists in exactly
      // one place (useSystemAudio.ts:686), after an await and a summarization
      // block inside the same try, so any throw there strands it.
      //
      // Report it; do NOT try to repair it by calling stopCapture. An earlier
      // draft did, and it would have torn down a manual session on the sub-second
      // window during a manual VAD start, when :600 has set capturing but the
      // invokes at :613/:621 have not landed. Stomping a real recording is far
      // worse than a stale feature, so this branch never touches capture.
      //
      // Default true on a rejected query: never take an unreadable status as
      // licence to call the user's session stuck.
      const active = await invoke<boolean>("get_capture_status").catch(
        () => true
      );
      if (!active) toastOnce(stuckToastedRef, STUCK_MESSAGE, "error");
      return;
    }

    if (decision === "start-meeting") {
      // Re-checked, because the probe above is an await and the tree can go
      // away inside it. This branch returns BEFORE the transcribing guard
      // further down, so without its own check it would still write provenance
      // and call the setter on a dead tree.
      if (!mountedRef.current) return;

      // Provenance FIRST, then the write, in one synchronous block: no commit
      // can interleave, so the next commit always observes what we just wrote.
      // Nothing is confirmed against Rust - see Decision 4. A failing guest half
      // reports itself via useMeetingAudio's onError.
      startedModeRef.current = "meeting";
      // Published BEFORE the mic opens, so meetingCaptureStarted finds it.
      autoRecordingStarted({
        app: meetingLabel(process),
        gated: isGatedProcess(process),
        stop: () => setEnableVADRef.current(false),
      });
      setEnableVADRef.current(true);
      return;
    }

    // ignore-off, ignore-active, ignore-mic-open are all silent.
    if (decision !== "start") return;

    await systemAudioRef.current.startCapture();

    // startCapture NEVER throws - it swallows everything into setError /
    // setSetupRequired - so the only signal is asking Rust. Default false on a
    // rejected query: an unreadable status must never be reported as a healthy
    // start. Note this read is `systemAudioRef.current`, not a snapshot taken at
    // the top of the op: startCapture reports its failure via setError, which only
    // appears on the NEXT render's object.
    const started = await invoke<boolean>("get_capture_status").catch(
      () => false
    );

    if (!mountedRef.current) {
      // The tree went away while this start was in flight. Record nothing and
      // undo it - there is no listener left to stop it later.
      if (started) await systemAudioRef.current.stopCapture();
      return;
    }

    if (started) {
      startedModeRef.current = "transcribing";
      // Not a bare stopCapture(): see the unmount cleanup for why.
      autoRecordingStarted({
        app: meetingLabel(process),
        gated: isGatedProcess(process),
        stop: () => void enqueue(handleStop),
      });
      return;
    }

    toastOnce(
      startFailToastedRef,
      systemAudioRef.current.error || GENERIC_START_MESSAGE,
      "error"
    );
    await systemAudioRef.current.stopCapture();
  };

  /**
   * Polls until Rust agrees the capture is down, or the budget runs out.
   *
   * A single query would report a false failure on EVERY healthy meeting stop:
   * closing the mic is fire-and-forget through React, and the Rust stop holds
   * is_capturing for at least 500ms of its own (commands.rs:478-490).
   */
  const confirmMeetingStopped = async (): Promise<boolean> => {
    for (let attempt = 0; attempt < STOP_CONFIRM_ATTEMPTS; attempt++) {
      await new Promise((r) => setTimeout(r, STOP_CONFIRM_INTERVAL_MS));

      // BOTH guards run AFTER the sleep, before the query. Placed before it,
      // the re-acquisition guard fires on every healthy stop - the layout
      // mirror still reads `true` synchronously and for two microtasks after
      // our write, flipping only on the first macrotask - and the loop becomes
      // dead code (measured: checkBeforeSleep -> 0 polls; checkAfterSleep -> 1).
      // Do not "tidy" them up to the top of the body.
      //
      // Unmount returns TRUE, not false: there is nothing left to warn about,
      // and returning false would fire MEETING_STOP_FAILED_MESSAGE on an
      // unmount that merely landed inside the window.
      if (!mountedRef.current) return true;
      if (enableVADRef.current) return true; // re-opened: something new started

      // Default true on a rejected query: an unreadable status is never
      // reported as success.
      const active = await invoke<boolean>("get_capture_status").catch(
        () => true
      );
      if (!active) return true;
    }
    return false;
  };

  // `opts` is optional AND read defensively: a bare enqueue(handleStop) goes
  // through chain.then(op), which hands op the previous link's result.
  const handleStop = async (opts?: { auto?: boolean }) => {
    const auto = opts?.auto === true;
    const action = decideOnEnded({ startedMode: startedModeRef.current });
    if (action === "ignore") {
      // MUST clear here, not only in `finally`: this early return is before the
      // try, and an inert stop is a common case (a setting-off with nothing
      // auto-started, or a queued pill-off stop whose provenance the mic-close
      // release already nulled). Leaving it latched permanently disarms the
      // pill-off branch.
      stopRequestedRef.current = false;
      return;
    }

    // Release ownership BEFORE writing the mic. The write commits during the
    // confirm loop's first sleep, and the ownership layout effect has no dep
    // array - so with provenance still "meeting" it would take its release
    // branch and call autoRecordingStopped() a SECOND time. The action is already captured, so nulling here is safe.
    startedModeRef.current = null;
    autoRecordingStopped({ auto });

    try {
      if (action === "stop-meeting") {
        // Closing the mic IS the stop: AutoSpeechVad, useMeetingAudio and the
        // diarization buffer are all gated on enableVAD. Nothing here touches
        // the transcribing pipeline's startCapture/stopCapture. The unsaved
        // tail is flushed by the recording-stop edge in useCompletion.
        setEnableVADRef.current(false);

        const ok = await confirmMeetingStopped();
        // Gate on our OWN view too: get_capture_status is a global signal we do
        // not exclusively own, so a session the user started inside the window
        // must not be reported as our failed stop.
        if (!ok && !enableVADRef.current && !systemAudioRef.current.capturing) {
          toast.error(MEETING_STOP_FAILED_MESSAGE);
        }
        return;
      }

      await systemAudioRef.current.stopCapture();

      // stopCapture never rejects either - its whole body is wrapped - so a failed
      // stop resolves normally and the hook would otherwise believe it worked.
      //
      // Note the default: an unreadable status is reported as STILL ACTIVE, not as
      // success. Defaulting to false would let a broken IPC silently claim the stop
      // worked and leave a live recording nothing will ever stop again. This is the
      // same discipline as the sibling hook's disable ladder in
      // `useMeetingDetection.ts`, which initialises `running = true` and lowers
      // it only on a SUCCESSFUL query.
      let stillActive = true;
      try {
        stillActive = Boolean(await invoke<boolean>("get_capture_status"));
      } catch (error) {
        console.error("get_capture_status rejected after stop:", error);
      }
      if (stillActive) toast.error(STOP_FAILED_MESSAGE);
    } finally {
      // In a finally so no rejection can strand provenance set forever, and here
      // rather than relying on capture-stopped, which a failed stop never emits.
      startedModeRef.current = null; // idempotent
      stopRequestedRef.current = false;
    }
  };

  /**
   * The one stop every AUTOMATIC stop goes through (silence, call-end grace,
   * new call). Unlike handleStop it does not depend on provenance: it also
   * closes a hand-opened mic. Always call it through `enqueue`.
   *
   * `widen: false` caps the row at `capEndedAt` exactly, with no system-line
   * widening: the new-call stop, whose newest system lines are call B's.
   */
  const stopRecording = async (o: {
    reason: StopNoticeReason;
    auto: boolean;
    capEndedAt: number | null;
    widen?: boolean;
  }): Promise<void> => {
    if (!mountedRef.current || !enableVADRef.current) return;
    detectionLog(`stop reason=${o.reason} auto=${o.auto}`);

    // Before the write, so the ownership layout effect's release branch never
    // runs and never calls autoRecordingStopped() without `auto`.
    startedModeRef.current = null;
    autoRecordingStopped({ auto: o.auto });
    showStopNotice(o.reason);
    if (o.widen === false) setRecordingStopCap(o.capEndedAt, false);
    else setRecordingStopCap(o.capEndedAt);
    setEnableVADRef.current(false);

    const ok = await confirmMeetingStopped();
    // The edge trigger read the cap synchronously at the stop commit; this
    // clears one no edge consumed (a stop and start batched into one commit).
    setRecordingStopCap(null);
    if (!ok && !enableVADRef.current && !systemAudioRef.current.capturing) {
      toast.error(MEETING_STOP_FAILED_MESSAGE);
    }
  };

  // Silence: counted by transcript-line ARRIVAL (length), so an in-place edit of
  // an entry does not reset it, and lines already present when the mic opens do
  // not count. enqueue/stopRecording close over refs only (see the listener
  // effect's argument below).
  useEffect(() => {
    if (!isMain || !enableVAD) return;
    const t = setTimeout(
      () =>
        void enqueue(() =>
          stopRecording({ reason: "silence", auto: true, capEndedAt: null })
        ),
      SILENCE_STOP_MS
    );
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMain, enableVAD, meetingTranscript.length]);

  // Call-end grace. meeting-ended no longer stops at once: detection flaps
  // mid-call, so the stop waits CALL_END_GRACE_MS, and it closes the mic
  // whoever opened it. Armed only from the meeting-ended listener, so it sits
  // behind that listener's isOwner gate; every helper below is inert while
  // graceRef is null.
  //
  // The generation counter is what lets a cancel or restart catch a stop the
  // timer has ALREADY enqueued: the queued op re-checks it when it runs.
  const graceRef = useRef<Grace | null>(null);
  const graceGenRef = useRef(0);
  // The process of the last meeting-detected. meeting-ended carries no payload,
  // so this is "the call that ended".
  const lastProcessRef = useRef<string | undefined>(undefined);

  const cancelGrace = () => {
    const g = graceRef.current;
    if (g?.timer) clearTimeout(g.timer);
    graceRef.current = null;
    graceGenRef.current += 1;
  };

  // A mic closed during the grace (by hand, or by unmount) caps the row at
  // the call's end, as the grace stop would, so the room talk since the
  // hang-up stays out of the note. Only when no cap is held: stopRecording
  // sets its own before it closes the mic (the new-call one must not widen).
  // Returns the cap it set, for the identity check of the clear below.
  const capAtGraceEnd = (): RecordingStopCap | null => {
    const g = graceRef.current;
    if (!g || peekRecordingStopCap() !== null) return null;
    setRecordingStopCap(g.endedAt);
    return peekRecordingStopCap();
  };

  const graceStop = async (gen: number) => {
    const g = graceRef.current;
    if (!g || g.gen !== gen) return; // cancelled or restarted since the fire
    graceRef.current = null;
    await stopRecording({
      reason: "call-ended",
      auto: true,
      capEndedAt: g.endedAt,
    });
  };

  // Re-arm MUTATES the running grace rather than replacing it (see Grace), and
  // clears its timer first, so a second meeting-ended never stacks timers.
  const armGrace = (endedAt: number, endedProcess: string | undefined) => {
    graceGenRef.current += 1;
    const g: Grace = graceRef.current ?? {
      endedAt,
      endedProcess,
      gen: 0,
      timer: null,
    };
    if (g.timer) clearTimeout(g.timer);
    g.endedAt = endedAt;
    g.endedProcess = endedProcess;
    g.gen = graceGenRef.current;
    graceRef.current = g;
    g.timer = setTimeout(() => {
      if (!enableVADRef.current) {
        cancelGrace(); // the mic is already closed
        return;
      }
      const gen = graceGenRef.current;
      g.timer = null;
      void enqueue(() => graceStop(gen));
    }, CALL_END_GRACE_MS);
  };

  // Far-end audio restarts the grace: the other side only arrives as system
  // audio, room talk only on the mic. Counted by ARRIVAL (the count rising), so
  // a Clear only re-bases the count and never re-arms. Compare BEFORE assign,
  // in a layout effect, seeded from the first render: no edge on mount.
  const systemLineCount = useMemo(
    () => meetingTranscript.filter((e) => e.audioSource === "system").length,
    [meetingTranscript]
  );
  const prevSystemLineCountRef = useRef(systemLineCount);
  useLayoutEffect(() => {
    const prev = prevSystemLineCountRef.current;
    prevSystemLineCountRef.current = systemLineCount;
    const g = graceRef.current;
    if (systemLineCount > prev && g) armGrace(g.endedAt, g.endedProcess);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [systemLineCount]);

  // The user opening or closing the mic cancels the grace - with one
  // exception: a false->true change under "meeting" provenance is this hook's
  // own start committing, and a meeting-ended queued behind that start has
  // already armed a grace that must survive it.
  //
  // A close sets the cap first. useMeetingLog's recording-stop edge, a layout
  // effect of a LATER hook in <Completion />, takes it in this same commit:
  // `recording` is derived from enableVAD during render, so it falls here too.
  const prevEnableVADRef = useRef(enableVAD);
  const closeCapRef = useRef<RecordingStopCap | null>(null);
  useLayoutEffect(() => {
    const prev = prevEnableVADRef.current;
    prevEnableVADRef.current = enableVAD;
    if (prev === enableVAD) return;
    // mode "meeting" on open = auto-started; null = opened by hand. A close
    // right after a "stop reason=" line is ours; with none, it was by hand.
    if (isMain) {
      detectionLog(
        `mic ${enableVAD ? "open" : "close"} mode=${startedModeRef.current}`
      );
    }
    if (enableVAD && startedModeRef.current === "meeting") return;
    if (prev) closeCapRef.current = capAtGraceEnd();
    cancelGrace();
  }, [enableVAD, isMain]);

  // A close cap nothing took in its commit would cap a later, unrelated row.
  // Passive effects run after every layout effect of the commit, so a trigger
  // that ran has already taken it. Identity, so a cap stopRecording set since
  // is never cleared. No cleanup: on unmount the cap is the unmount trigger's.
  useEffect(() => {
    const mine = closeCapRef.current;
    closeCapRef.current = null;
    if (mine && peekRecordingStopCap() === mine) setRecordingStopCap(null);
  }, [enableVAD]);

  // The calendar read behind the same-call decision. Bounded: the op that calls
  // it holds the chain, so a hung read must not freeze every later command.
  // Unreadable (not "ok", a throw, or a timeout) is null, which isSameCall
  // counts as the same call. A Meet call's (a gated process) slots come from
  // Google, every other app's from Outlook. Reading Outlook for Meet would merge
  // every back-to-back Meet.
  const readCalendarEvents = async (
    process: string | undefined
  ): Promise<CalendarEvent[] | null> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), SAME_CALL_READ_TIMEOUT_MS);
    });
    // The catch also covers a rejection arriving AFTER the timeout won, which
    // would otherwise surface as an unhandled rejection.
    const read = (async () => {
      const r = isGatedProcess(process)
        ? await fetchCurrentGoogleMeetings()
        : await fetchCurrentMeetings();
      return r.kind === "ok" ? r.events : null;
    })().catch(() => null);
    try {
      return await Promise.race([read, timeout]);
    } finally {
      clearTimeout(timer);
    }
  };

  // meeting-detected as ONE op: no queued meeting-ended can slip in between A's
  // stop and B's start. Inside a grace, a detection is usually the SAME call
  // coming back (detection flaps) - the grace is cancelled and recording
  // continues. A NEW call (back-to-back meetings) stops A capped at its end and
  // resets the conversation first, so B's transcript is never filed under A's
  // Odoo contacts.
  const onDetected = async (process?: string) => {
    const g = graceRef.current;
    if (g) {
      const events =
        g.endedProcess &&
        process &&
        g.endedProcess.toLowerCase() !== process.toLowerCase()
          ? null // already a new call; skip the read
          : await readCalendarEvents(process ?? g.endedProcess);
      // Identity, not truthiness: a grace cancelled or re-armed during the read
      // must not be acted on with stale data.
      if (graceRef.current === g) {
        const same = isSameCall({
          endedProcess: g.endedProcess,
          process,
          events,
          endedAt: g.endedAt,
          now: Date.now(),
        });
        detectionLog(
          `in-grace detect ${process} same=${same} events=${events?.length ?? "null"}`
        );
        cancelGrace();
        if (same) return; // recording continues; no card
        // auto:false: no quiet window for B. widen:false: B's audio is
        // already arriving as system lines, and must not stretch A's cap.
        await stopRecording({
          reason: "call-ended",
          auto: false,
          capEndedAt: g.endedAt,
          widen: false,
        });
        try {
          await startNewConversationRef.current(); // clears A's targets before B
        } catch (e) {
          // A's mic is already closed: still record B
          console.error("New-call conversation reset failed:", e);
        }
      }
    }
    return handleDetected(process);
  };

  useEffect(() => {
    // The CREATE body is MANDATORY, not decoration. StrictMode runs
    // create -> destroy -> create on mount WITHOUT recreating refs, so a
    // cleanup-only effect latches mountedRef false for the component's whole
    // life. The listenersOkRef declaration comment already records this lesson.
    // Deleting this line as "redundant with useRef(true)" kills the
    // stop-confirm loop on poll 1 in every dev build - F53 is what catches it.
    mountedRef.current = true;
    if (isMain) detectionLog("autorecord mount");
    return () => {
      mountedRef.current = false;
      if (isMain) detectionLog("autorecord unmount");
      // Unmount closes an open mic: capped like a hand close. Passive
      // destroys run in hook order, so useMeetingLog's unmount trigger,
      // mounted after this hook, takes it.
      if (enableVADRef.current) capAtGraceEnd();
      cancelGrace();
      if (startedModeRef.current || enableVADRef.current) {
        // useCompletion dies with the tree, taking meetingTranscript and
        // conversationHistoryRef with it, and there is no unmount flush in
        // useCompletion today - up to MEETING_TRANSCRIPT_AUTOSAVE_INTERVAL - 1
        // segments would vanish silently. A hand-opened mic (no provenance)
        // records into the same transcript, so it flushes too.
        void flushRef.current?.().catch(reportFlushFailure);
      }
      if (startedModeRef.current) {
        // Idempotent: a transcribing handleStop enqueued below publishes again.
        autoRecordingStopped();
      }
      if (startedModeRef.current === "transcribing") {
        // enqueue, NOT a bare stopCapture(): a direct call bypasses chainRef
        // and can overlap an in-flight capture command. It would also skip
        // decideOnEnded, the provenance clear and the post-stop confirmation
        // query - so a stop that did not take would go unreported. F49 pins
        // that query's count for exactly that reason.
        enqueue(handleStop);
      }
      // "meeting" needs no stop here - the tree teardown unmounts
      // useMeetingAudio, whose own cleanup issues it. Verified: cleanups run
      // PARENT BEFORE CHILDREN, so that stop is issued after this one.
    };
    // enqueue and handleStop are recreated every render but close over refs
    // only, so the mount copies are behaviourally identical to the last ones -
    // the same argument the listener effect below makes at length.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!isOwner) return;
    let cancelled = false;
    listenersOkRef.current = true; // re-arm per run; see the declaration
    const unlisteners: Array<() => void> = [];

    // The cancelled flag is mandatory under StrictMode: listen() is async, so the
    // first mount's promises resolve AFTER cleanup and would leak a second handler
    // - making every meeting-detected start capture twice.
    const register = async (event: string, handler: (payload: any) => void) => {
      const un = await listen(event, (e) => handler(e.payload));
      if (cancelled) un();
      else unlisteners.push(un);
    };

    Promise.all([
      register("meeting-detected", (payload) => {
        enqueue(() => onDetected(payload?.process));
        lastProcessRef.current = payload?.process;
      }),

      register("meeting-ended", () => {
        // Captured now, at the event: the grace caps the row at the call's end.
        const endedAt = Date.now();
        const endedProcess = lastProcessRef.current;
        // The checks run INSIDE the op. A queued start writes its provenance
        // after awaits and resumes before the enableVAD mirror updates, so
        // "meeting" provenance counts as an open mic here. A transcribing
        // session stops at once, as before; an open mic waits the grace,
        // unless auto-record was turned off since the event (no automatic
        // call-end stop then, spec G2).
        enqueue(async () => {
          detectionLog(
            `ended ${endedProcess} mode=${startedModeRef.current} mic=${enableVADRef.current} enabled=${enabledRef.current}`
          );
          if (startedModeRef.current === "transcribing") {
            return handleStop({ auto: true });
          }
          if (
            enabledRef.current &&
            (enableVADRef.current || startedModeRef.current === "meeting")
          ) {
            armGrace(endedAt, endedProcess);
          }
        });
      }),

      register("capture-stopped", () => {
        // Transcribing provenance ONLY. This fires on any stop - including the
        // one startCapture issues before every VAD start, and including a
        // mid-call useMeetingAudio deps re-run (device or STT-language change).
        // Clearing meeting provenance here would end the recording card and the
        // quiet-restart window mid-call, and disarm the pill-off stop. (The
        // call-end grace still closes the mic: it needs no provenance.)
        if (startedModeRef.current === "transcribing") {
          startedModeRef.current = null;
          autoRecordingStopped();
        }
      }),

      register("meeting-watcher-stopped", () => {
        // No meeting-ended will follow, so no call-end is coming to wait for.
        cancelGrace();
        // decideOnWatcherStopped returns "warn" | "ignore" and carries no mode,
        // so the copy choice has to happen here.
        if (
          decideOnWatcherStopped({ startedMode: startedModeRef.current }) !==
          "warn"
        ) {
          return;
        }
        toast.warning(
          startedModeRef.current === "meeting"
            ? MEETING_WATCHER_STOPPED_MESSAGE
            : WATCHER_STOPPED_MESSAGE
        );
      }),

      register("meeting-detection-setting-changed", (payload) => {
        // Assigned SYNCHRONOUSLY here, not mirrored from state through a passive
        // effect: an op queued behind an in-flight one resumes on a microtask,
        // while a state mirror lands on a macrotask, so it would read stale.
        enabledRef.current = Boolean(payload?.enabled);
        if (!enabledRef.current) {
          cancelGrace(); // Auto-record off: no automatic call-end stop
          enqueue(handleStop);
        }
      }),
    ]).catch((error) => {
      // Refuse to start rather than start something we cannot stop.
      listenersOkRef.current = false;
      console.error("Failed to subscribe to auto-record events:", error);
    });

    return () => {
      cancelled = true;
      unlisteners.forEach((un) => un());
    };
    // handleDetected/handleStop are recreated every render but close over nothing
    // render-VARYING - only refs, module imports, and render-invariant local
    // helpers (toastOnce closes over nothing but the module-level toast, so every
    // render's copy is behaviourally identical to the last) - so capturing them
    // once is safe. Listing them would re-run this effect on every commit of App
    // (which re-renders per streamed AI chunk), tearing down and re-registering
    // all five listeners with an async listen() gap each time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOwner]);
};
