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
  /** SHA-256 hash of the API key (to detect changes securely) */
  apiKeyHash: string;
  /** When the verification was performed */
  verifiedAt: number;
  /** Whether verification was successful */
  isVerified: boolean;
  /** Optional error message if verification failed */
  errorMessage?: string;
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
  localStorage.setItem(STORAGE_KEYS.AI_PROVIDER_VERIFIED, JSON.stringify(data));
}

/**
 * Saves STT provider verification status to localStorage.
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
export async function isAIVerificationValid(
  provider: string,
  model: string,
  apiKey: string
): Promise<boolean> {
  const status = getAIVerificationStatus();
  if (!status) return false;
  if (!status.isVerified) return false;
  if (status.provider !== provider) return false;
  if (status.model !== model) return false;

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
  const status = getSTTVerificationStatus();
  if (!status) return false;
  if (!status.isVerified) return false;
  if (status.provider !== provider) return false;
  if (status.model !== model) return false;

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
