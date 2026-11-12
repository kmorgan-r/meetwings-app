import { invoke } from "@tauri-apps/api/core";
import { NotionError } from "./errors";

// The Notion token lives only in the OS keychain (Rust notion_token_* commands).
// Never secureSet, localStorage, logs or error messages. Failures carry no detail.

export async function isNotionKeychainAvailable(): Promise<boolean> {
  try {
    return await invoke<boolean>("notion_keychain_available");
  } catch {
    // Unknown means assume available: a false here reads as "no token" and
    // would drop Notion-only meetings; real failures surface on load/save.
    return true;
  }
}

export async function saveNotionToken(raw: string): Promise<void> {
  try {
    await invoke("notion_token_set", { token: raw.trim() });
  } catch {
    throw new NotionError("NOTION_KEYCHAIN_UNAVAILABLE");
  }
}

// null only for "no token stored"; a failed invoke throws so a Notion-only
// meeting is never silently dropped as "not connected".
export async function loadNotionToken(): Promise<string | null> {
  try {
    return (await invoke<string | null>("notion_token_get")) ?? null;
  } catch {
    throw new NotionError("NOTION_KEYCHAIN_UNAVAILABLE");
  }
}

export async function clearNotionToken(): Promise<void> {
  try {
    await invoke("notion_token_clear");
  } catch {
    throw new NotionError("NOTION_KEYCHAIN_UNAVAILABLE");
  }
}
