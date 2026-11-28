// Turning auto-record on or off. Shared by the Settings toggle and the
// first-launch offer card, so the two can never drift apart.
import { emit } from "@tauri-apps/api/event";
import { safeLocalStorage } from "@/lib";
import { STORAGE_KEYS } from "@/config/constants";
import { isMacOS } from "@/lib/platform";
import {
  clearStartFailure,
  macToggleOnCheck,
  writeStartFailure,
  type StartFailure,
} from "@/lib/meeting-start-failure";

/** Persist the setting and tell every window. A failed emit is logged, never thrown. */
export async function announceAutoRecordSetting(enabled: boolean): Promise<void> {
  safeLocalStorage.setItem(STORAGE_KEYS.MEETING_AUTO_RECORD_ENABLED, String(enabled));
  try {
    await emit("meeting-detection-setting-changed", { enabled });
  } catch (error) {
    console.error("Failed to announce the meeting detection setting:", error);
  }
}

/**
 * Turn auto-record on. On a Mac nothing is saved or announced until the probe
 * and both permission requests pass; a failure is persisted (Settings shows it)
 * and returned. Resolves null once the setting is on.
 */
export async function turnOnAutoRecord(): Promise<StartFailure | null> {
  if (isMacOS()) {
    clearStartFailure();
    const failure = await macToggleOnCheck();
    if (failure) {
      writeStartFailure(failure);
      return failure;
    }
  }
  await announceAutoRecordSetting(true);
  return null;
}
