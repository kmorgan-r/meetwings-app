/**
 * useSaveConversation Hook
 *
 * Provides debounced and queued conversation saving to prevent race conditions
 * when multiple rapid saves occur (e.g., during streaming responses).
 *
 * Features:
 * - Debounces saves to reduce database writes
 * - Queues saves to ensure latest state is always persisted
 * - Handles errors gracefully without losing data
 * - Provides pending/saving status for UI feedback
 */

import { useCallback, useRef, useState, useEffect } from "react";
import { ChatConversation } from "@/types";
import { saveConversation } from "@/lib/database/chat-history.action";
import { CONVERSATION_SAVE_DEBOUNCE_MS } from "@/lib/chat-constants";

interface UseSaveConversationOptions {
  /** Debounce delay in milliseconds (default: 500ms) */
  debounceMs?: number;
  /** Callback when save completes successfully */
  onSaveSuccess?: (conversation: ChatConversation) => void;
  /** Callback when save fails */
  onSaveError?: (error: Error, conversation: ChatConversation) => void;
}

interface UseSaveConversationReturn {
  /** Queue a conversation for saving (debounced) */
  queueSave: (conversation: ChatConversation) => void;
  /** Force immediate save of any pending conversation */
  flushSave: () => Promise<void>;
  /** Whether there's a pending save waiting for debounce */
  hasPendingSave: boolean;
  /** Whether a save is currently in progress */
  isSaving: boolean;
  /** The last error that occurred during save (cleared on next successful save) */
  lastError: Error | null;
}

/**
 * Hook for managing debounced conversation saves with queue support.
 *
 * Usage:
 * ```tsx
 * const { queueSave, flushSave, isSaving } = useSaveConversation({
 *   onSaveSuccess: (conv) => console.log('Saved:', conv.id),
 *   onSaveError: (error) => console.error('Save failed:', error),
 * });
 *
 * // Queue a save (will be debounced)
 * queueSave(conversation);
 *
 * // Force immediate save (e.g., before navigating away)
 * await flushSave();
 * ```
 */
export function useSaveConversation(
  options: UseSaveConversationOptions = {}
): UseSaveConversationReturn {
  const {
    debounceMs = CONVERSATION_SAVE_DEBOUNCE_MS,
    onSaveSuccess,
    onSaveError,
  } = options;

  // Track pending conversation to save (always keeps latest)
  const pendingConversationRef = useRef<ChatConversation | null>(null);
  // Track debounce timer
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Track if a save is currently in progress
  const isSavingRef = useRef(false);
  // Track if component is mounted to avoid state updates after unmount
  const isMountedRef = useRef(true);

  // State for UI feedback
  const [hasPendingSave, setHasPendingSave] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [lastError, setLastError] = useState<Error | null>(null);

  // Cleanup on unmount
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      // Clear any pending timer
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, []);

  /**
   * Internal function to perform the actual save.
   * Handles queue processing and error handling.
   */
  const performSave = useCallback(async () => {
    // Don't start a new save if one is already in progress
    if (isSavingRef.current) {
      return;
    }

    // Get the pending conversation
    const conversationToSave = pendingConversationRef.current;
    if (!conversationToSave) {
      return;
    }

    // Clear pending (will be set again if another save is queued during this save)
    pendingConversationRef.current = null;
    isSavingRef.current = true;

    if (isMountedRef.current) {
      setHasPendingSave(false);
      setIsSaving(true);
    }

    try {
      await saveConversation(conversationToSave);

      if (isMountedRef.current) {
        setLastError(null);
      }

      onSaveSuccess?.(conversationToSave);

      // Check if another save was queued while we were saving
      if (pendingConversationRef.current) {
        // Process the next save in the queue
        isSavingRef.current = false;
        await performSave();
      }
    } catch (error) {
      const errorObj = error instanceof Error ? error : new Error(String(error));

      console.error("[useSaveConversation] Save failed:", errorObj);

      if (isMountedRef.current) {
        setLastError(errorObj);
      }

      onSaveError?.(errorObj, conversationToSave);

      // Re-queue the failed save for retry
      // Only if nothing newer has been queued
      if (!pendingConversationRef.current) {
        pendingConversationRef.current = conversationToSave;
        if (isMountedRef.current) {
          setHasPendingSave(true);
        }
      }
    } finally {
      isSavingRef.current = false;
      if (isMountedRef.current) {
        setIsSaving(false);
      }
    }
  }, [onSaveSuccess, onSaveError]);

  /**
   * Queue a conversation for saving.
   * Uses debouncing to batch rapid updates.
   */
  const queueSave = useCallback(
    (conversation: ChatConversation) => {
      // Always update to latest conversation
      pendingConversationRef.current = conversation;

      if (isMountedRef.current) {
        setHasPendingSave(true);
      }

      // Clear existing timer
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }

      // Set new debounce timer
      debounceTimerRef.current = setTimeout(() => {
        debounceTimerRef.current = null;
        performSave();
      }, debounceMs);
    },
    [debounceMs, performSave]
  );

  /**
   * Force immediate save of any pending conversation.
   * Useful before navigation or when user explicitly saves.
   */
  const flushSave = useCallback(async () => {
    // Clear debounce timer
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }

    // Perform save if there's anything pending
    if (pendingConversationRef.current) {
      await performSave();
    }

    // Wait for any in-progress save to complete
    while (isSavingRef.current) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }, [performSave]);

  return {
    queueSave,
    flushSave,
    hasPendingSave,
    isSaving,
    lastError,
  };
}

/**
 * Utility function for immediate (non-hook) save with retry.
 * Use this for one-off saves outside of React components.
 */
export async function saveConversationWithRetry(
  conversation: ChatConversation,
  maxRetries: number = 3,
  retryDelayMs: number = 1000
): Promise<void> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await saveConversation(conversation);
      return;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      console.warn(
        `[saveConversationWithRetry] Attempt ${attempt}/${maxRetries} failed:`,
        lastError.message
      );

      if (attempt < maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      }
    }
  }

  throw lastError;
}
