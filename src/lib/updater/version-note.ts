import { STORAGE_KEYS } from "@/config/constants";
import { safeLocalStorage } from "@/lib/storage/helper";

export interface TYPE_APP_UPDATED_NOTE {
  version: string;
  at: number;
}

/**
 * Records the currently running version and detects upgrades. First install
 * writes APP_LAST_VERSION silently; a changed version (an update just
 * installed) also writes a one-time APP_UPDATED_TO note for Settings to show.
 */
export function recordAppVersion(current: string, now: number): void {
  const last = safeLocalStorage.getItem(STORAGE_KEYS.APP_LAST_VERSION);
  if (last !== null && last !== current) {
    safeLocalStorage.setItem(
      STORAGE_KEYS.APP_UPDATED_TO,
      JSON.stringify({ version: current, at: now })
    );
  }
  safeLocalStorage.setItem(STORAGE_KEYS.APP_LAST_VERSION, current);
}

/**
 * The one-time "Updated to X" note, but only when X is the version actually
 * running now — a note left over from an older update is never shown.
 */
export function readUpdatedNote(current: string): TYPE_APP_UPDATED_NOTE | null {
  const raw = safeLocalStorage.getItem(STORAGE_KEYS.APP_UPDATED_TO);
  if (raw === null) return null;
  try {
    const note = JSON.parse(raw) as Partial<TYPE_APP_UPDATED_NOTE>;
    if (typeof note.version !== "string" || typeof note.at !== "number") {
      return null;
    }
    if (note.version !== current) return null;
    return { version: note.version, at: note.at };
  } catch {
    return null;
  }
}
