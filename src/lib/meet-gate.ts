import { invoke } from "@tauri-apps/api/core";
import { detectionLog } from "@/lib/detection-log";

export interface MeetGateDeps {
  confirm: (episode: number) => Promise<unknown>;
}

export interface MeetGate {
  candidateStarted(episode: number): void;
  candidateEnded(episode: number): void;
  connectionChanged(): void;
  stop(): void;
}

/**
 * Confirms every Chrome call candidate Rust reports: any Chrome mic use counts
 * as a call, calendar event or not (owner decision, 2026-11-16). Rust stays the
 * only emitter and decider. A candidate re-announced after a webview reload is
 * confirmed again, which Rust treats as a no-op.
 */
// ponytail: candidateEnded/connectionChanged/stop are no-ops kept so
// useMeetingDetection's wiring is untouched; delete the gate outright if the
// calendar requirement never comes back.
export function createMeetGate(deps: MeetGateDeps): MeetGate {
  return {
    candidateStarted(e) {
      deps.confirm(e).catch((error) => {
        console.warn("confirm_meeting_candidate failed:", error);
        detectionLog(`gate confirm failed: ${String(error)}`);
      });
    },
    candidateEnded() {},
    connectionChanged() {},
    stop() {},
  };
}

export function defaultMeetGateDeps(): MeetGateDeps {
  return {
    confirm: (episode) => invoke("confirm_meeting_candidate", { episode }),
  };
}
