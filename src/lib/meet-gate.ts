import { invoke } from "@tauri-apps/api/core";
import { MEET_RECHECK_MS } from "@/config/constants";
import { detectionLog } from "@/lib/detection-log";
import {
  fetchCurrentGoogleMeetings,
  type FetchGoogleMeetingsResult,
} from "@/lib/calendar/fetch-google-meetings";
import {
  amberKindFor,
  hasQualifyingMeetEvent,
  type AmberKind,
} from "@/lib/meeting-detect";
import {
  dismissAmber,
  getActiveAutoRecording,
  showAmber,
} from "@/lib/meeting-cards.store";
import {
  loadGoogleConfigState,
  type GoogleConfigState,
} from "@/lib/storage/google-config.storage";

export interface MeetGateDeps {
  loadConfigState: () => Promise<GoogleConfigState["state"]>;
  fetchMeetings: (now: number) => Promise<FetchGoogleMeetingsResult>;
  confirm: (episode: number) => Promise<unknown>;
  captureRunning: () => Promise<boolean>;
  gatedRecordingRunning: () => boolean;
  showAmber: (a: { variant: AmberKind; episode: number }) => void;
  dismissAmber: () => void;
  now: () => number;
}

export interface MeetGate {
  candidateStarted(episode: number): void;
  candidateEnded(episode: number): void;
  connectionChanged(): void;
  stop(): void;
}

/**
 * Checks Google Calendar for a Meet event while Rust reports a Chrome call
 * candidate, and asks Rust to confirm it. Never starts or stops the watcher and
 * never emits meeting-* events: Rust is the only emitter and decider.
 */
export function createMeetGate(deps: MeetGateDeps): MeetGate {
  let live: number | null = null;
  let inFlight: number | null = null;
  let rerun = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let amberShownFor: number | null = null;

  const clearTimer = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };

  // Clears first so at most one re-check chain exists.
  const schedule = (e: number) => {
    clearTimer();
    timer = setTimeout(() => {
      timer = null;
      go(e);
    }, MEET_RECHECK_MS);
  };

  const logConfirmFailure = (error: unknown) => {
    console.warn("confirm_meeting_candidate failed:", error);
    detectionLog(`gate confirm failed: ${String(error)}`);
  };

  const runCheck = async (e: number): Promise<void> => {
    if (inFlight === e) {
      rerun = true;
      return;
    }
    inFlight = e;
    let configState: GoogleConfigState["state"];
    let result: FetchGoogleMeetingsResult;
    try {
      configState = await deps.loadConfigState();
      result = await deps.fetchMeetings(deps.now());
    } catch (error) {
      // fetchMeetings never rejects; this keeps the slot from sticking if a dep does.
      console.error("Meet calendar check failed:", error);
      detectionLog(`gate e=${e} check threw`);
      if (inFlight === e) inFlight = null;
      if (live === e) schedule(e);
      return;
    }
    // A newer episode's check may own the slot by now; clearing it would let
    // connectionChanged() start a second concurrent check.
    if (inFlight === e) inFlight = null;
    const qualifying =
      result.kind === "ok" && hasQualifyingMeetEvent(result.events, deps.now());
    detectionLog(
      `gate e=${e} live=${live === e} ${result.kind}` +
        (result.kind === "ok"
          ? ` events=${result.events.length} qualifying=${qualifying}`
          : result.kind === "error"
            ? ` ${result.code}`
            : "")
    );
    if (live !== e) return;

    if (result.kind === "ok") {
      if (qualifying) {
        try {
          await deps.confirm(e);
          if (live !== e) return;
          live = null;
          deps.dismissAmber();
          return;
        } catch (error) {
          logConfirmFailure(error);
          if (live !== e) return;
        }
      } else {
        // The calendar is reachable, so an amber card's claim no longer holds.
        deps.dismissAmber();
      }
    } else if (result.kind === "error") {
      if (amberShownFor !== e) {
        const capturing = await deps.captureRunning();
        if (live !== e) return;
        if (!capturing && amberShownFor !== e) {
          amberShownFor = e;
          deps.showAmber({
            variant: amberKindFor(result.code, configState),
            episode: e,
          });
        }
      }
    }

    if (rerun) {
      rerun = false;
      go(e);
    } else {
      schedule(e);
    }
  };

  // Fire-and-forget entry: a throw is logged, never an unhandled rejection.
  function go(e: number): void {
    runCheck(e).catch((error) => console.error("Meet check crashed:", error));
  }

  return {
    candidateStarted(e) {
      // Rust re-announces a live candidate after a webview reload.
      if (live === e) return;
      live = e;
      clearTimer();
      rerun = false;
      amberShownFor = null;
      if (deps.gatedRecordingRunning()) {
        // The watcher restarted under a gate-confirmed recording.
        live = null;
        deps.confirm(e).catch(logConfirmFailure);
        return;
      }
      go(e);
    },
    candidateEnded(e) {
      if (live !== e) return;
      live = null;
      clearTimer();
      deps.dismissAmber();
    },
    connectionChanged() {
      if (live === null) return;
      clearTimer();
      go(live);
    },
    stop() {
      live = null;
      clearTimer();
      deps.dismissAmber();
    },
  };
}

export function defaultMeetGateDeps(): MeetGateDeps {
  return {
    loadConfigState: async () => (await loadGoogleConfigState()).state,
    fetchMeetings: (now) => fetchCurrentGoogleMeetings(now),
    confirm: (episode) => invoke("confirm_meeting_candidate", { episode }),
    // Defaults to false so an unreadable status shows the warning rather than
    // hiding it. Not getPillData(): only <Completion /> writes it, and it goes
    // stale when that unmounts.
    captureRunning: async () =>
      (await invoke<boolean>("get_capture_status").catch(() => false)) ||
      getActiveAutoRecording() !== null,
    gatedRecordingRunning: () => getActiveAutoRecording()?.gated === true,
    showAmber,
    dismissAmber,
    now: () => Date.now(),
  };
}
