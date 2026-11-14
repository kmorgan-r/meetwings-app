import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { toGoogleCode } from "@/lib/calendar/google-errors";
import {
  GOOGLE_CONNECTION_CHANGED_EVENT,
  loadGoogleConfigState,
} from "@/lib/storage/google-config.storage";
import type { GoogleErrorCode } from "@/types";

/** Best-effort: a failed broadcast never turns a successful connect into an error. */
export async function broadcastGoogleConnectionChanged(): Promise<void> {
  try {
    await emit(GOOGLE_CONNECTION_CHANGED_EVENT);
  } catch {
    // best-effort
  }
}

/** Same flow as the Connect button, from the saved config. */
export async function reconnectGoogle(): Promise<{ ok: true } | { ok: false; code: GoogleErrorCode }> {
  const state = await loadGoogleConfigState();
  if (state.state !== "complete") return { ok: false, code: "GOOGLE_AUTH_REJECTED" };
  try {
    await invoke("google_connect", {
      clientId: state.config.clientId,
      clientSecret: state.config.clientSecret,
    });
  } catch (err) {
    return { ok: false, code: toGoogleCode(err) };
  }
  await broadcastGoogleConnectionChanged();
  return { ok: true };
}
