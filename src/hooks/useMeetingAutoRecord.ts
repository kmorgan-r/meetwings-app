import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { toast } from "sonner";
import { safeLocalStorage } from "@/lib";
import { isWindows } from "@/lib/platform";
import {
  decideOnDetected,
  decideOnEnded,
  decideOnWatcherStopped,
} from "@/lib/functions/meeting-auto-record";
import { STORAGE_KEYS } from "@/config/constants";

/**
 * The pre-#32 key. Used as a literal on purpose: the constant is gone, and
 * reintroducing it just to delete it invites someone to read from it again.
 */
const LEGACY_DETECTION_KEY = "meeting_detection_enabled";

export const SETUP_MESSAGE =
  "Could not auto-record — finish setting up your AI and speech providers";
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

/**
 * Starts and stops recording around detected Teams calls. VAD sessions only.
 *
 * Single-owner: Tauri events broadcast to every window, so only the main window
 * may drive the single global capture. Mount it once, in the app page, ABOVE
 * useMeetingDetection.
 *
 * `systemAudio` is passed in rather than obtained by calling useSystemAudio()
 * here: a second call would create a second, independent copy of the capture
 * state, and this hook would drive one while the UI renders the other.
 * `setupComplete` / `setupLoading` are passed in because useSetupStatus reaches
 * for the app context, which throws outside its provider.
 */
export const useMeetingAutoRecord = (
  systemAudio: MeetingAutoRecordAudio,
  setupComplete: boolean,
  setupLoading: boolean
) => {
  const isOwner = useMemo(
    () => getCurrentWindow().label === "main" && isWindows(),
    []
  );

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
  const systemAudioRef = useRef(systemAudio);
  const setupCompleteRef = useRef(setupComplete);
  const setupLoadingRef = useRef(setupLoading);
  useLayoutEffect(() => {
    systemAudioRef.current = systemAudio;
    setupCompleteRef.current = setupComplete;
    setupLoadingRef.current = setupLoading;
  });

  const enabledRef = useRef(false);
  const autoStartedRef = useRef(false);

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

  const handleDetected = async () => {
    decideOnDetected({
      enabled: enabledRef.current && listenersOkRef.current,
      capturing: systemAudioRef.current.capturing,
      meetingAssist:
        safeLocalStorage.getItem(STORAGE_KEYS.MEETING_ASSIST_MODE_ENABLED) ===
        "true",
      setupLoading: setupLoadingRef.current,
      setupComplete: setupCompleteRef.current,
      vadEnabled: systemAudioRef.current.vadConfig.enabled,
    });
    // Dispatch lands in Task 4.
  };

  const handleStop = async () => {
    decideOnEnded({ autoStarted: autoStartedRef.current });
    // Stop sequence lands in Task 6.
  };

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
      register("meeting-detected", () => {
        enqueue(handleDetected);
      }),

      register("meeting-ended", () => {
        enqueue(handleStop);
      }),

      register("capture-stopped", () => {
        // "A stop was issued" - not "the session ended". It is emitted
        // unconditionally by stop_system_audio_capture, including the one
        // startCapture issues before every VAD start. That is safe because
        // provenance is only set AFTER the confirmation query, two further IPC
        // round trips later, so this clear is a no-op at that point.
        autoStartedRef.current = false;
      }),

      register("meeting-watcher-stopped", () => {
        if (
          decideOnWatcherStopped({ autoStarted: autoStartedRef.current }) ===
          "warn"
        ) {
          toast.warning(WATCHER_STOPPED_MESSAGE);
        }
      }),

      register("meeting-detection-setting-changed", (payload) => {
        // Assigned SYNCHRONOUSLY here, not mirrored from state through a passive
        // effect: an op queued behind an in-flight one resumes on a microtask,
        // while a state mirror lands on a macrotask, so it would read stale.
        enabledRef.current = Boolean(payload?.enabled);
        if (!enabledRef.current) enqueue(handleStop);
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
  }, [isOwner]);
};
