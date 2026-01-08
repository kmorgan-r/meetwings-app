/**
 * Verification Storage
 *
 * Stores and retrieves API verification status for AI and STT providers.
 * Verification is invalidated when the provider, model, or API key changes.
 */

import { STORAGE_KEYS } from "@/config/constants";

interface VerificationData {
  /** Provider ID */
  provider: string;
  /** Model name (for detecting changes) */
  model: string;
  /** Hash of the API key (to detect changes without storing the key) */
  apiKeyHash: string;
  /** When the verification was performed */
  verifiedAt: number;
  /** Whether verification was successful */
  isVerified: boolean;
  /** Optional error message if verification failed */
  errorMessage?: string;
}

/**
 * Creates a simple hash of the API key for change detection.
 * This is not for security - just to detect if the key changed.
 */
function hashApiKey(apiKey: string): string {
  if (!apiKey) return "";
  // Simple hash: length + first 4 chars + last 4 chars
  const first = apiKey.substring(0, 4);
  const last = apiKey.substring(apiKey.length - 4);
  return `${apiKey.length}:${first}...${last}`;
}

/**
 * Gets the AI provider verification status from localStorage.
 */
export function getAIVerificationStatus(): VerificationData | null {
  try {
    const stored = localStorage.getItem(STORAGE_KEYS.AI_PROVIDER_VERIFIED);
    if (!stored) return null;
    return JSON.parse(stored);
  } catch {
    return null;
  }
}

/**
 * Gets the STT provider verification status from localStorage.
 */
export function getSTTVerificationStatus(): VerificationData | null {
  try {
    const stored = localStorage.getItem(STORAGE_KEYS.STT_PROVIDER_VERIFIED);
    if (!stored) return null;
    return JSON.parse(stored);
  } catch {
    return null;
  }
}

/**
 * Saves AI provider verification status to localStorage.
 */
export function setAIVerificationStatus(
  provider: string,
  model: string,
  apiKey: string,
  isVerified: boolean,
  errorMessage?: string
): void {
  const data: VerificationData = {
    provider,
    model,
    apiKeyHash: hashApiKey(apiKey),
    verifiedAt: Date.now(),
    isVerified,
    errorMessage,
  };
  localStorage.setItem(STORAGE_KEYS.AI_PROVIDER_VERIFIED, JSON.stringify(data));
}

/**
 * Saves STT provider verification status to localStorage.
 */
export function setSTTVerificationStatus(
  provider: string,
  model: string,
  apiKey: string,
  isVerified: boolean,
  errorMessage?: string
): void {
  const data: VerificationData = {
    provider,
    model,
    apiKeyHash: hashApiKey(apiKey),
    verifiedAt: Date.now(),
    isVerified,
    errorMessage,
  };
  localStorage.setItem(STORAGE_KEYS.STT_PROVIDER_VERIFIED, JSON.stringify(data));
}

/**
 * Clears AI provider verification status.
 */
export function clearAIVerificationStatus(): void {
  localStorage.removeItem(STORAGE_KEYS.AI_PROVIDER_VERIFIED);
}

/**
 * Clears STT provider verification status.
 */
export function clearSTTVerificationStatus(): void {
  localStorage.removeItem(STORAGE_KEYS.STT_PROVIDER_VERIFIED);
}

/**
 * Checks if the AI provider verification is still valid.
 * Invalidates if provider, model, or API key has changed.
 */
export function isAIVerificationValid(
  provider: string,
  model: string,
  apiKey: string
): boolean {
  const status = getAIVerificationStatus();
  if (!status) return false;
  if (!status.isVerified) return false;
  if (status.provider !== provider) return false;
  if (status.model !== model) return false;
  if (status.apiKeyHash !== hashApiKey(apiKey)) return false;

  return true;
}

/**
 * Checks if the STT provider verification is still valid.
 * Invalidates if provider, model, or API key has changed.
 */
export function isSTTVerificationValid(
  provider: string,
  model: string,
  apiKey: string
): boolean {
  const status = getSTTVerificationStatus();
  if (!status) return false;
  if (!status.isVerified) return false;
  if (status.provider !== provider) return false;
  if (status.model !== model) return false;
  if (status.apiKeyHash !== hashApiKey(apiKey)) return false;

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
