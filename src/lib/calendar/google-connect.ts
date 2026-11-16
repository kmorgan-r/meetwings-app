import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { toGoogleCode } from "@/lib/calendar/google-errors";
import {
  GOOGLE_CONNECTION_CHANGED_EVENT,
  loadGoogleConfigState,
  saveGoogleConfig,
  type GoogleConfig,
} from "@/lib/storage/google-config.storage";
import {
  NOTION_CONFIG_CHANGED_EVENT,
  loadNotionConfig,
  saveNotionConfig,
} from "@/lib/storage/notion-config.storage";
import type { GoogleConnectResult, GoogleErrorCode, GraphStatus } from "@/types";

/** Best-effort: a failed broadcast never turns a successful connect into an error. */
export async function broadcastGoogleConnectionChanged(): Promise<void> {
  try {
    await emit(GOOGLE_CONNECTION_CHANGED_EVENT);
  } catch {
    // best-effort
  }
}

/**
 * Fills a blank Notion "your name" from the Google profile. Never rejects and
 * never logs the name: a connect that worked must not turn into an error.
 * Deliberately not TEAM_SETTINGS_APPLIED_EVENT: that makes the Notion card
 * reload and wipe unsaved link edits.
 */
export async function fillYourNameIfBlank(name: string | null): Promise<void> {
  try {
    const trimmed = name?.trim();
    if (!trimmed) return;
    const cfg = await loadNotionConfig().catch(() => null);
    if (!cfg || cfg.yourName.trim() !== "") return;
    await saveNotionConfig({ ...cfg, yourName: trimmed });
    try {
      await emit(NOTION_CONFIG_CHANGED_EVENT);
    } catch {
      // best-effort
    }
  } catch {
    console.warn("[google] name fill failed");
  }
}

export type GoogleConnectOutcome =
  | { ok: true; status: GraphStatus }
  | { ok: false; code: GoogleErrorCode };

/** Save, sign in, fill the name, broadcast. Shared by the settings card and reconnect. */
export async function connectGoogle(config: GoogleConfig): Promise<GoogleConnectOutcome> {
  try {
    await saveGoogleConfig(config);
    const result = await invoke<GoogleConnectResult>("google_connect", {
      clientId: config.clientId,
      clientSecret: config.clientSecret,
    });
    await fillYourNameIfBlank(result.name);
    return { ok: true, status: { connected: result.connected, sessionOnly: result.sessionOnly } };
  } catch (err) {
    return { ok: false, code: toGoogleCode(err) };
  } finally {
    // saveGoogleConfig may already have run, so even a cancelled first sign-in
    // leaves a complete config the running watcher has not seen.
    await broadcastGoogleConnectionChanged();
  }
}

/** Same flow as the Connect button, from the saved config. */
export async function reconnectGoogle(): Promise<{ ok: true } | { ok: false; code: GoogleErrorCode }> {
  const state = await loadGoogleConfigState();
  if (state.state !== "complete") return { ok: false, code: "GOOGLE_AUTH_REJECTED" };
  return connectGoogle(state.config);
}
