/**
 * Verification Storage
 *
 * Stores and retrieves API verification status for AI and STT providers.
 * Verification is invalidated when the provider, model, or API key changes.
 *
 * Uses secure storage (encrypted at rest) with a cache layer for synchronous access.
 *
 * IMPORTANT: Initialization Requirements
 * --------------------------------------
 * The following functions MUST be called during app initialization (in app.context.tsx):
 * 1. migrateVerificationToSecureStorage() - Migrates data from localStorage (one-time)
 * 2. loadVerificationCache() - Loads data into cache for synchronous access
 *
 * These must complete BEFORE calling any getter functions (getAIVerificationStatus, etc.)
 * Failure to initialize will result in getters returning null with a console warning.
 */

import { STORAGE_KEYS } from "@/config/constants";
import { secureSet, secureGet, secureDelete } from "@/lib/secure-storage";

// Secure storage keys
const AI_VERIFICATION_KEY = "secure_ai_verification";
const STT_VERIFICATION_KEY = "secure_stt_verification";

interface VerificationData {
  /** Provider ID */
  provider: string;
  /** Model name (for detecting changes) */
  model: string;
  /** SHA-256 hash of the API key (to detect changes securely) */
  apiKeyHash: string;
  /** When the verification was performed */
  verifiedAt: number;
  /** Whether verification was successful */
  isVerified: boolean;
  /** Optional error message if verification failed */
  errorMessage?: string;
}

// Cache for synchronous access (populated from secure storage on app init)
let aiVerificationCache: VerificationData | null = null;
let sttVerificationCache: VerificationData | null = null;
let cacheLoaded = false;

/**
 * Check if the verification cache has been loaded.
 * Use this to guard against premature access to verification data.
 */
export function isVerificationCacheLoaded(): boolean {
  return cacheLoaded;
}

/**
 * Creates a secure SHA-256 hash of the API key for change detection.
 * Uses Web Crypto API for cryptographically secure hashing.
 */
async function hashApiKey(apiKey: string): Promise<string> {
  if (!apiKey) return "";

  const encoder = new TextEncoder();
  const data = encoder.encode(apiKey);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Load verification data from secure storage into cache.
 * Must be called during app initialization before using getters.
 * Dispatches "verification-status-changed" event only if data was loaded.
 */
export async function loadVerificationCache(): Promise<void> {
  // Track previous state to detect changes
  const previousAiCache = aiVerificationCache;
  const previousSttCache = sttVerificationCache;
  const wasLoaded = cacheLoaded;

  try {
    const [aiData, sttData] = await Promise.all([
      secureGet(AI_VERIFICATION_KEY),
      secureGet(STT_VERIFICATION_KEY),
    ]);

    aiVerificationCache = aiData ? JSON.parse(aiData) : null;
    sttVerificationCache = sttData ? JSON.parse(sttData) : null;
    cacheLoaded = true;

    // Only dispatch event if data actually changed or this is first load
    const aiChanged = JSON.stringify(previousAiCache) !== JSON.stringify(aiVerificationCache);
    const sttChanged = JSON.stringify(previousSttCache) !== JSON.stringify(sttVerificationCache);
    const hasData = aiVerificationCache !== null || sttVerificationCache !== null;

    if (!wasLoaded || aiChanged || sttChanged || hasData) {
      window.dispatchEvent(new CustomEvent("verification-status-changed"));
    }
  } catch (error) {
    console.error("[VerificationStorage] Failed to load cache:", error);
    const hadData = aiVerificationCache !== null || sttVerificationCache !== null;

    aiVerificationCache = null;
    sttVerificationCache = null;
    cacheLoaded = true;

    // Only notify if we previously had data (state changed to null)
    if (!wasLoaded || hadData) {
      window.dispatchEvent(new CustomEvent("verification-status-changed"));
    }
  }
}

/**
 * Migrate verification data from localStorage to secure storage.
 * Call once on app startup to migrate existing users.
 */
export async function migrateVerificationToSecureStorage(): Promise<void> {
  try {
    // Migrate AI verification
    const aiLocal = localStorage.getItem(STORAGE_KEYS.AI_PROVIDER_VERIFIED);
    if (aiLocal) {
      const existingSecure = await secureGet(AI_VERIFICATION_KEY);
      if (!existingSecure) {
        await secureSet(AI_VERIFICATION_KEY, aiLocal);
        console.log("[VerificationStorage] Migrated AI verification to secure storage");
      }
      localStorage.removeItem(STORAGE_KEYS.AI_PROVIDER_VERIFIED);
    }

    // Migrate STT verification
    const sttLocal = localStorage.getItem(STORAGE_KEYS.STT_PROVIDER_VERIFIED);
    if (sttLocal) {
      const existingSecure = await secureGet(STT_VERIFICATION_KEY);
      if (!existingSecure) {
        await secureSet(STT_VERIFICATION_KEY, sttLocal);
        console.log("[VerificationStorage] Migrated STT verification to secure storage");
      }
      localStorage.removeItem(STORAGE_KEYS.STT_PROVIDER_VERIFIED);
    }
  } catch (error) {
    console.error("[VerificationStorage] Migration failed:", error);
  }
}

/**
 * Gets the AI provider verification status from cache.
 * Returns null if cache not loaded or no verification exists.
 *
 * NOTE: Ensure loadVerificationCache() has been called before using this function.
 * If cache is not loaded, this returns null which may cause the UI to show
 * "verification required" incorrectly.
 */
export function getAIVerificationStatus(): VerificationData | null {
  if (!cacheLoaded) {
    console.warn(
      "[VerificationStorage] Cache not loaded - call loadVerificationCache() during app init. " +
      "Returning null which may cause incorrect 'verification required' state."
    );
  }
  return aiVerificationCache;
}

/**
 * Gets the STT provider verification status from cache.
 * Returns null if cache not loaded or no verification exists.
 *
 * NOTE: Ensure loadVerificationCache() has been called before using this function.
 * If cache is not loaded, this returns null which may cause the UI to show
 * "verification required" incorrectly.
 */
export function getSTTVerificationStatus(): VerificationData | null {
  if (!cacheLoaded) {
    console.warn(
      "[VerificationStorage] Cache not loaded - call loadVerificationCache() during app init. " +
      "Returning null which may cause incorrect 'verification required' state."
    );
  }
  return sttVerificationCache;
}

/**
 * Saves AI provider verification status to secure storage and updates cache.
 */
export async function setAIVerificationStatus(
  provider: string,
  model: string,
  apiKey: string,
  isVerified: boolean,
  errorMessage?: string
): Promise<void> {
  const data: VerificationData = {
    provider,
    model,
    apiKeyHash: await hashApiKey(apiKey),
    verifiedAt: Date.now(),
    isVerified,
    errorMessage,
  };

  // Update cache immediately
  aiVerificationCache = data;

  // Persist to secure storage
  try {
    await secureSet(AI_VERIFICATION_KEY, JSON.stringify(data));
  } catch (error) {
    console.error("[VerificationStorage] Failed to save AI verification:", error);
    throw error;
  }
}

/**
 * Saves STT provider verification status to secure storage and updates cache.
 */
export async function setSTTVerificationStatus(
  provider: string,
  model: string,
  apiKey: string,
  isVerified: boolean,
  errorMessage?: string
): Promise<void> {
  const data: VerificationData = {
    provider,
    model,
    apiKeyHash: await hashApiKey(apiKey),
    verifiedAt: Date.now(),
    isVerified,
    errorMessage,
  };

  // Update cache immediately
  sttVerificationCache = data;

  // Persist to secure storage
  try {
    await secureSet(STT_VERIFICATION_KEY, JSON.stringify(data));
  } catch (error) {
    console.error("[VerificationStorage] Failed to save STT verification:", error);
    throw error;
  }
}

/**
 * Clears AI provider verification status from cache and secure storage.
 */
export async function clearAIVerificationStatus(): Promise<void> {
  aiVerificationCache = null;
  try {
    await secureDelete(AI_VERIFICATION_KEY);
  } catch (error) {
    console.error("[VerificationStorage] Failed to clear AI verification:", error);
  }
}

/**
 * Clears STT provider verification status from cache and secure storage.
 */
export async function clearSTTVerificationStatus(): Promise<void> {
  sttVerificationCache = null;
  try {
    await secureDelete(STT_VERIFICATION_KEY);
  } catch (error) {
    console.error("[VerificationStorage] Failed to clear STT verification:", error);
  }
}

/**
 * Checks if the AI provider verification is still valid.
 * Invalidates if provider, model, or API key has changed.
 */
export async function isAIVerificationValid(
  provider: string,
  model: string,
  apiKey: string
): Promise<boolean> {
  // Require non-empty API key for valid verification
  if (!apiKey || apiKey.trim() === "") return false;

  const status = getAIVerificationStatus();
  if (!status) return false;
  if (!status.isVerified) return false;
  if (status.provider !== provider) return false;
  if (status.model !== model) return false;

  // Don't allow empty hash comparisons (would incorrectly match)
  if (!status.apiKeyHash) return false;

  const currentHash = await hashApiKey(apiKey);
  if (status.apiKeyHash !== currentHash) return false;

  return true;
}

/**
 * Checks if the STT provider verification is still valid.
 * Invalidates if provider, model, or API key has changed.
 */
export async function isSTTVerificationValid(
  provider: string,
  model: string,
  apiKey: string
): Promise<boolean> {
  // Require non-empty API key for valid verification
  if (!apiKey || apiKey.trim() === "") return false;

  const status = getSTTVerificationStatus();
  if (!status) return false;
  if (!status.isVerified) return false;
  if (status.provider !== provider) return false;
  if (status.model !== model) return false;

  // Don't allow empty hash comparisons (would incorrectly match)
  if (!status.apiKeyHash) return false;

  const currentHash = await hashApiKey(apiKey);
  if (status.apiKeyHash !== currentHash) return false;

  return true;
}

/**
 * Gets the verification error message for AI provider if verification failed.
 */
export function getAIVerificationError(): string | undefined {
  const status = getAIVerificationStatus();
  return status?.errorMessage;
}

/**
 * Gets the verification error message for STT provider if verification failed.
 */
export function getSTTVerificationError(): string | undefined {
  const status = getSTTVerificationStatus();
  return status?.errorMessage;
}

/**
 * Reset cache (for testing purposes)
 */
export function resetVerificationCache(): void {
  aiVerificationCache = null;
  sttVerificationCache = null;
  cacheLoaded = false;
}
