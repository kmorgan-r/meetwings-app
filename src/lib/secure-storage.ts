/**
 * Secure Storage Utility
 *
 * Stores sensitive data (API keys, tokens, etc.) via Tauri's `plugin-store`
 * instead of localStorage.
 *
 * What this provides:
 * - Data lives in a file in the OS app-data directory, NOT in the webview.
 * - Not readable from webview JS/DOM (immune to XSS-reads-localStorage).
 * - Not accessible to browser extensions.
 *
 * What this does NOT provide:
 * - The store file is plaintext JSON on disk; it is NOT encrypted at rest.
 *   Anyone with read access to the user's app-data directory can read it.
 *   For true at-rest encryption use tauri-plugin-stronghold or an OS keychain.
 */

import { Store } from "@tauri-apps/plugin-store";

// Store file name (plaintext JSON in the OS app-data directory)
const SECURE_STORE_FILE = ".secure-settings.dat";

// Singleton store instance
let storeInstance: Store | null = null;

/**
 * Get or create the secure store instance
 */
async function getStore(): Promise<Store> {
  if (!storeInstance) {
    storeInstance = await Store.load(SECURE_STORE_FILE);
  }
  return storeInstance;
}

/**
 * Securely store a sensitive value
 *
 * @param key - Storage key
 * @param value - Value to store
 */
export async function secureSet(key: string, value: string): Promise<void> {
  const store = await getStore();
  await store.set(key, value);
  await store.save(); // Persist to disk (plaintext JSON)
}

/**
 * Retrieve a securely stored value
 *
 * @param key - Storage key
 * @returns Stored value or null if not found
 */
export async function secureGet(key: string): Promise<string | null> {
  const store = await getStore();
  const value = await store.get<string>(key);
  return value ?? null;
}

/**
 * Remove a securely stored value
 *
 * @param key - Storage key
 */
export async function secureDelete(key: string): Promise<void> {
  const store = await getStore();
  await store.delete(key);
  await store.save(); // Persist changes
}

/**
 * Check if a key exists in secure storage
 *
 * @param key - Storage key
 * @returns True if key exists
 */
export async function secureHas(key: string): Promise<boolean> {
  const store = await getStore();
  return await store.has(key);
}

/**
 * Clear all secure storage (use with caution!)
 */
export async function secureClear(): Promise<void> {
  const store = await getStore();
  await store.clear();
  await store.save();
}

/**
 * Migrate data from localStorage to secure storage
 *
 * @param key - Key to migrate
 * @param deleteFromLocalStorage - Whether to delete from localStorage after migration
 */
export async function migrateFromLocalStorage(
  key: string,
  deleteFromLocalStorage: boolean = true
): Promise<void> {
  // Check if value exists in localStorage
  const localStorageValue = localStorage.getItem(key);

  if (localStorageValue) {
    // Move to secure storage
    await secureSet(key, localStorageValue);

    // Optionally delete from localStorage
    if (deleteFromLocalStorage) {
      localStorage.removeItem(key);
      console.log(`[SecureStorage] Migrated ${key} from localStorage to secure storage`);
    }
  }
}
