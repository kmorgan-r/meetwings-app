// The persisted record of the last automatic record start failure, and the
// gate the Settings toggle runs before starting the watcher on macOS.
import { invoke } from "@tauri-apps/api/core";
import { safeLocalStorage } from "@/lib";
import { STORAGE_KEYS } from "@/config/constants";
import { currentWatchLists } from "@/lib/meeting-detect";
import { requestMicAccess, requestSystemAudioAccess } from "@/lib/mac-permissions";

export type StartFailureKind =
  | "start-error"
  | "mic-denied"
  | "audio-denied"
  | "permission-reset";

export interface StartFailure {
  message: string;
  kind: StartFailureKind;
}

export const MIC_DENIED_MESSAGE =
  "Meetwings can't use the microphone. Allow it in System Settings → Privacy & Security → Microphone, and check that a microphone is connected.";

export const AUDIO_DENIED_MESSAGE =
  "Meetwings couldn't record system audio. Allow it in System Settings → Privacy & Security → Screen & System Audio Recording, then turn auto-record on again.";

export const PERMISSION_RESET_MESSAGE =
  "Microphone permission was reset (this can happen after an update). Turn auto-record on again to allow it.";

const KNOWN_KINDS: StartFailureKind[] = [
  "start-error",
  "mic-denied",
  "audio-denied",
  "permission-reset",
];

export class MicGrantMissingError extends Error {}

const isStartFailure = (value: unknown): value is StartFailure => {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { message?: unknown; kind?: unknown };
  return (
    typeof candidate.message === "string" &&
    typeof candidate.kind === "string" &&
    (KNOWN_KINDS as string[]).includes(candidate.kind)
  );
};

export function readStartFailure(): StartFailure | null {
  try {
    const raw = safeLocalStorage.getItem(STORAGE_KEYS.MEETING_AUTO_RECORD_START_FAILURE);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isStartFailure(parsed)) return null;
    return parsed;
  } catch (error) {
    console.warn("Could not read the auto-record start failure:", error);
    return null;
  }
}

export function writeStartFailure(failure: StartFailure): void {
  safeLocalStorage.setItem(
    STORAGE_KEYS.MEETING_AUTO_RECORD_START_FAILURE,
    JSON.stringify(failure)
  );
}

export function clearStartFailure(): void {
  safeLocalStorage.removeItem(STORAGE_KEYS.MEETING_AUTO_RECORD_START_FAILURE);
}

export function toStartFailure(error: unknown): StartFailure {
  if (error instanceof MicGrantMissingError) {
    return { kind: "permission-reset", message: PERMISSION_RESET_MESSAGE };
  }
  return { kind: "start-error", message: String(error) };
}

/**
 * Run the checks the toggle performs before starting auto-record on macOS, in
 * strict order and stopping at the first failure. Each failure asks for only
 * what has not been granted yet: an unsupported macOS is probed first (the same
 * `list_capture_sessions` call the watcher runs) so it never prompts for a
 * permission.
 */
export async function macToggleOnCheck(): Promise<StartFailure | null> {
  try {
    await invoke("list_capture_sessions", { ...(await currentWatchLists()) });
  } catch (error) {
    return toStartFailure(error);
  }

  if (!(await requestMicAccess())) {
    return { kind: "mic-denied", message: MIC_DENIED_MESSAGE };
  }

  const detail = await requestSystemAudioAccess();
  if (detail !== null) {
    return { kind: "audio-denied", message: `${AUDIO_DENIED_MESSAGE} (${detail})` };
  }

  return null;
}
