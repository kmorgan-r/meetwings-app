/**
 * Secure Provider Configuration Storage
 *
 * Stores API keys and other sensitive provider configuration using Tauri's
 * encrypted store plugin instead of plain localStorage.
 *
 * Security Benefits:
 * - Data is encrypted at rest
 * - Protected from malicious browser extensions
 * - Protected from XSS attacks that read localStorage
 * - Uses OS-level security features
 */

import { secureSet, secureGet, secureDelete } from "@/lib/secure-storage";

// Storage keys for provider configs
const AI_CONFIGS_KEY = "secure_ai_provider_configs";
const STT_CONFIGS_KEY = "secure_stt_provider_configs";

// Cache for loaded configs to avoid async reads on every access
let aiConfigsCache: Record<string, Record<string, string>> | null = null;
let sttConfigsCache: Record<string, Record<string, string>> | null = null;

// Loading promises to avoid race conditions
let aiLoadingPromise: Promise<void> | null = null;
let sttLoadingPromise: Promise<void> | null = null;

/**
 * Load AI provider configs from secure storage into cache
 */
export async function loadSecureAIConfigs(): Promise<Record<string, Record<string, string>>> {
  if (aiConfigsCache !== null) {
    return aiConfigsCache;
  }

  // Avoid duplicate loading
  if (aiLoadingPromise) {
    await aiLoadingPromise;
    return aiConfigsCache || {};
  }

  aiLoadingPromise = (async () => {
    try {
      const stored = await secureGet(AI_CONFIGS_KEY);
      if (stored) {
        aiConfigsCache = JSON.parse(stored);
      } else {
        aiConfigsCache = {};
      }
    } catch (error) {
      console.error("[SecureStorage] Failed to load AI configs:", error);
      aiConfigsCache = {};
    }
  })();

  await aiLoadingPromise;
  aiLoadingPromise = null;
  return aiConfigsCache || {};
}

/**
 * Load STT provider configs from secure storage into cache
 */
export async function loadSecureSTTConfigs(): Promise<Record<string, Record<string, string>>> {
  if (sttConfigsCache !== null) {
    return sttConfigsCache;
  }

  // Avoid duplicate loading
  if (sttLoadingPromise) {
    await sttLoadingPromise;
    return sttConfigsCache || {};
  }

  sttLoadingPromise = (async () => {
    try {
      const stored = await secureGet(STT_CONFIGS_KEY);
      if (stored) {
        sttConfigsCache = JSON.parse(stored);
      } else {
        sttConfigsCache = {};
      }
    } catch (error) {
      console.error("[SecureStorage] Failed to load STT configs:", error);
      sttConfigsCache = {};
    }
  })();

  await sttLoadingPromise;
  sttLoadingPromise = null;
  return sttConfigsCache || {};
}

/**
 * Save AI provider config to secure storage
 * Updates both cache and persistent storage
 */
export async function saveSecureAIConfig(
  providerId: string,
  variables: Record<string, string>
): Promise<void> {
  // Ensure cache is loaded
  const configs = await loadSecureAIConfigs();

  // Update cache
  configs[providerId] = variables;
  aiConfigsCache = configs;

  // Persist to secure storage
  try {
    await secureSet(AI_CONFIGS_KEY, JSON.stringify(configs));
  } catch (error) {
    console.error("[SecureStorage] Failed to save AI config:", error);
  }
}

/**
 * Save STT provider config to secure storage
 * Updates both cache and persistent storage
 */
export async function saveSecureSTTConfig(
  providerId: string,
  variables: Record<string, string>
): Promise<void> {
  // Ensure cache is loaded
  const configs = await loadSecureSTTConfigs();

  // Update cache
  configs[providerId] = variables;
  sttConfigsCache = configs;

  // Persist to secure storage
  try {
    await secureSet(STT_CONFIGS_KEY, JSON.stringify(configs));
  } catch (error) {
    console.error("[SecureStorage] Failed to save STT config:", error);
  }
}

/**
 * Get cached AI config for a provider (sync, must call loadSecureAIConfigs first)
 */
export function getCachedAIConfig(providerId: string): Record<string, string> | undefined {
  return aiConfigsCache?.[providerId];
}

/**
 * Get cached STT config for a provider (sync, must call loadSecureSTTConfigs first)
 */
export function getCachedSTTConfig(providerId: string): Record<string, string> | undefined {
  return sttConfigsCache?.[providerId];
}

/**
 * Update cache synchronously (for use in state setters)
 * The actual save to secure storage happens asynchronously
 */
export function updateAIConfigCache(providerId: string, variables: Record<string, string>): void {
  if (aiConfigsCache === null) {
    aiConfigsCache = {};
  }
  aiConfigsCache[providerId] = variables;

  // Fire-and-forget async save
  secureSet(AI_CONFIGS_KEY, JSON.stringify(aiConfigsCache)).catch((error) => {
    console.error("[SecureStorage] Failed to persist AI config:", error);
  });
}

/**
 * Update cache synchronously (for use in state setters)
 * The actual save to secure storage happens asynchronously
 */
export function updateSTTConfigCache(providerId: string, variables: Record<string, string>): void {
  if (sttConfigsCache === null) {
    sttConfigsCache = {};
  }
  sttConfigsCache[providerId] = variables;

  // Fire-and-forget async save
  secureSet(STT_CONFIGS_KEY, JSON.stringify(sttConfigsCache)).catch((error) => {
    console.error("[SecureStorage] Failed to persist STT config:", error);
  });
}

/**
 * Clear all secure provider configs (for testing/reset)
 */
export async function clearSecureProviderConfigs(): Promise<void> {
  aiConfigsCache = null;
  sttConfigsCache = null;
  await Promise.all([
    secureDelete(AI_CONFIGS_KEY),
    secureDelete(STT_CONFIGS_KEY),
  ]);
}

/**
 * Migrate existing localStorage configs to secure storage
 * Call this once on app startup to move existing data
 */
export async function migrateProviderConfigsToSecureStorage(): Promise<void> {
  const AI_PROVIDER_CONFIGS_KEY = "ai_provider_configs";
  const STT_PROVIDER_CONFIGS_KEY = "stt_provider_configs";

  try {
    // Migrate AI configs
    const aiConfigsLocal = localStorage.getItem(AI_PROVIDER_CONFIGS_KEY);
    if (aiConfigsLocal) {
      const existingSecure = await secureGet(AI_CONFIGS_KEY);
      if (!existingSecure) {
        // Only migrate if secure storage is empty
        await secureSet(AI_CONFIGS_KEY, aiConfigsLocal);
        console.log("[SecureStorage] Migrated AI provider configs to secure storage");
      }
      // Remove from localStorage after successful migration
      localStorage.removeItem(AI_PROVIDER_CONFIGS_KEY);
    }

    // Migrate STT configs
    const sttConfigsLocal = localStorage.getItem(STT_PROVIDER_CONFIGS_KEY);
    if (sttConfigsLocal) {
      const existingSecure = await secureGet(STT_CONFIGS_KEY);
      if (!existingSecure) {
        // Only migrate if secure storage is empty
        await secureSet(STT_CONFIGS_KEY, sttConfigsLocal);
        console.log("[SecureStorage] Migrated STT provider configs to secure storage");
      }
      // Remove from localStorage after successful migration
      localStorage.removeItem(STT_PROVIDER_CONFIGS_KEY);
    }
  } catch (error) {
    console.error("[SecureStorage] Migration failed:", error);
  }
}
