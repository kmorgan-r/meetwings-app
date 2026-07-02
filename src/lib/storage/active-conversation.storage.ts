import { STORAGE_KEYS } from "@/config";
import { safeLocalStorage } from "./helper";

/**
 * Tracks the conversation currently open in the chat view.
 *
 * Summaries are normally only created when the user leaves a conversation, so a
 * conversation that is still being added to must be excluded from the "Update
 * Knowledge" backfill — otherwise it gets summarized early and later messages
 * are lost (there is no update path for an existing summary).
 */
export function setActiveConversationId(id: string): void {
  safeLocalStorage.setItem(STORAGE_KEYS.ACTIVE_CONVERSATION_ID, id);
}

export function getActiveConversationId(): string | null {
  return safeLocalStorage.getItem(STORAGE_KEYS.ACTIVE_CONVERSATION_ID);
}

export function clearActiveConversationId(): void {
  safeLocalStorage.removeItem(STORAGE_KEYS.ACTIVE_CONVERSATION_ID);
}
