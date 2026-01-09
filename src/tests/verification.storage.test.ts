/**
 * Tests for verification.storage.ts
 *
 * Critical test cases:
 * - Verification hash invalidation when API key/model/provider changes
 * - SHA-256 hashing consistency
 * - Storage and retrieval correctness
 * - Secure storage integration
 * - Migration from localStorage
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

// Mock the secure-storage module before importing the module under test
vi.mock("@/lib/secure-storage", () => ({
  secureSet: vi.fn(),
  secureGet: vi.fn(),
  secureDelete: vi.fn(),
}));

import {
  getAIVerificationStatus,
  getSTTVerificationStatus,
  setAIVerificationStatus,
  setSTTVerificationStatus,
  clearAIVerificationStatus,
  clearSTTVerificationStatus,
  isAIVerificationValid,
  isSTTVerificationValid,
  getAIVerificationError,
  getSTTVerificationError,
  loadVerificationCache,
  migrateVerificationToSecureStorage,
  resetVerificationCache,
} from "@/lib/storage/verification.storage";
import { secureSet, secureGet, secureDelete } from "@/lib/secure-storage";
import { STORAGE_KEYS } from "@/config/constants";

// Mock crypto.subtle for SHA-256 hashing
const mockDigest = vi.fn();
vi.stubGlobal("crypto", {
  subtle: {
    digest: mockDigest,
  },
});

// Helper to create mock hash buffer
function createMockHashBuffer(seed: string): ArrayBuffer {
  const encoder = new TextEncoder();
  const data = encoder.encode(seed);
  // Create a deterministic "hash" based on input
  const hash = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    hash[i] = data[i % data.length] ^ (i * 7);
  }
  return hash.buffer;
}

describe("verification.storage", () => {
  let localStorageData: Record<string, string>;
  let secureStorageData: Record<string, string>;

  beforeEach(async () => {
    // Reset localStorage mock
    localStorageData = {};
    vi.mocked(localStorage.getItem).mockImplementation((key: string) => {
      return localStorageData[key] || null;
    });
    vi.mocked(localStorage.setItem).mockImplementation((key: string, value: string) => {
      localStorageData[key] = value;
    });
    vi.mocked(localStorage.removeItem).mockImplementation((key: string) => {
      delete localStorageData[key];
    });

    // Reset secure storage mock
    secureStorageData = {};
    vi.mocked(secureSet).mockImplementation(async (key: string, value: string) => {
      secureStorageData[key] = value;
    });
    vi.mocked(secureGet).mockImplementation(async (key: string) => {
      return secureStorageData[key] || null;
    });
    vi.mocked(secureDelete).mockImplementation(async (key: string) => {
      delete secureStorageData[key];
    });

    // Reset crypto mock - return deterministic hash based on input
    mockDigest.mockImplementation((_algorithm: string, data: ArrayBuffer) => {
      const decoder = new TextDecoder();
      const input = decoder.decode(data);
      return Promise.resolve(createMockHashBuffer(input));
    });

    // Reset cache for each test
    resetVerificationCache();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("loadVerificationCache", () => {
    it("loads AI and STT verification from secure storage", async () => {
      const aiData = {
        provider: "openai",
        model: "gpt-4",
        apiKeyHash: "abc123",
        verifiedAt: Date.now(),
        isVerified: true,
      };
      secureStorageData["secure_ai_verification"] = JSON.stringify(aiData);

      await loadVerificationCache();

      const result = getAIVerificationStatus();
      expect(result).toEqual(aiData);
    });

    it("handles empty secure storage", async () => {
      await loadVerificationCache();

      expect(getAIVerificationStatus()).toBeNull();
      expect(getSTTVerificationStatus()).toBeNull();
    });

    it("handles JSON parse errors gracefully", async () => {
      secureStorageData["secure_ai_verification"] = "invalid json";

      await loadVerificationCache();

      expect(getAIVerificationStatus()).toBeNull();
    });
  });

  describe("migrateVerificationToSecureStorage", () => {
    it("migrates AI verification from localStorage to secure storage", async () => {
      const data = {
        provider: "openai",
        model: "gpt-4",
        apiKeyHash: "hash123",
        verifiedAt: Date.now(),
        isVerified: true,
      };
      localStorageData[STORAGE_KEYS.AI_PROVIDER_VERIFIED] = JSON.stringify(data);

      await migrateVerificationToSecureStorage();

      expect(secureSet).toHaveBeenCalledWith(
        "secure_ai_verification",
        JSON.stringify(data)
      );
      expect(localStorageData[STORAGE_KEYS.AI_PROVIDER_VERIFIED]).toBeUndefined();
    });

    it("migrates STT verification from localStorage to secure storage", async () => {
      const data = {
        provider: "whisper",
        model: "whisper-1",
        apiKeyHash: "hash456",
        verifiedAt: Date.now(),
        isVerified: true,
      };
      localStorageData[STORAGE_KEYS.STT_PROVIDER_VERIFIED] = JSON.stringify(data);

      await migrateVerificationToSecureStorage();

      expect(secureSet).toHaveBeenCalledWith(
        "secure_stt_verification",
        JSON.stringify(data)
      );
      expect(localStorageData[STORAGE_KEYS.STT_PROVIDER_VERIFIED]).toBeUndefined();
    });

    it("does not overwrite existing secure storage data", async () => {
      secureStorageData["secure_ai_verification"] = JSON.stringify({
        provider: "existing",
        isVerified: true,
      });
      localStorageData[STORAGE_KEYS.AI_PROVIDER_VERIFIED] = JSON.stringify({
        provider: "local",
        isVerified: true,
      });

      await migrateVerificationToSecureStorage();

      // Should NOT have overwritten secure storage
      expect(secureSet).not.toHaveBeenCalledWith(
        "secure_ai_verification",
        expect.any(String)
      );
      // But should still remove from localStorage
      expect(localStorageData[STORAGE_KEYS.AI_PROVIDER_VERIFIED]).toBeUndefined();
    });
  });

  describe("getAIVerificationStatus / getSTTVerificationStatus", () => {
    it("returns null when cache not loaded", () => {
      // Cache is reset in beforeEach, so should return null
      expect(getAIVerificationStatus()).toBeNull();
      expect(getSTTVerificationStatus()).toBeNull();
    });

    it("returns cached verification data after load", async () => {
      const data = {
        provider: "openai",
        model: "gpt-4",
        apiKeyHash: "abc123",
        verifiedAt: Date.now(),
        isVerified: true,
      };
      secureStorageData["secure_ai_verification"] = JSON.stringify(data);

      await loadVerificationCache();

      expect(getAIVerificationStatus()).toEqual(data);
    });
  });

  describe("setAIVerificationStatus / setSTTVerificationStatus", () => {
    it("stores verification status in secure storage with hashed API key", async () => {
      await setAIVerificationStatus("openai", "gpt-4", "sk-test-key", true);

      expect(secureSet).toHaveBeenCalledWith(
        "secure_ai_verification",
        expect.any(String)
      );

      const stored = JSON.parse(secureStorageData["secure_ai_verification"]);
      expect(stored.provider).toBe("openai");
      expect(stored.model).toBe("gpt-4");
      expect(stored.isVerified).toBe(true);
      expect(stored.apiKeyHash).toBeDefined();
      expect(stored.apiKeyHash).not.toBe("sk-test-key"); // Should be hashed
    });

    it("updates cache immediately", async () => {
      await setAIVerificationStatus("openai", "gpt-4", "sk-test-key", true);

      const cached = getAIVerificationStatus();
      expect(cached?.provider).toBe("openai");
      expect(cached?.isVerified).toBe(true);
    });

    it("stores error message when verification fails", async () => {
      await setAIVerificationStatus("openai", "gpt-4", "bad-key", false, "Invalid API key");

      const cached = getAIVerificationStatus();
      expect(cached?.isVerified).toBe(false);
      expect(cached?.errorMessage).toBe("Invalid API key");
    });

    it("stores STT verification separately from AI", async () => {
      await setAIVerificationStatus("openai", "gpt-4", "ai-key", true);
      await setSTTVerificationStatus("whisper", "whisper-1", "stt-key", true);

      expect(secureStorageData["secure_ai_verification"]).toBeDefined();
      expect(secureStorageData["secure_stt_verification"]).toBeDefined();

      const aiCached = getAIVerificationStatus();
      const sttCached = getSTTVerificationStatus();

      expect(aiCached?.provider).toBe("openai");
      expect(sttCached?.provider).toBe("whisper");
    });
  });

  describe("clearAIVerificationStatus / clearSTTVerificationStatus", () => {
    it("clears AI verification from cache and secure storage", async () => {
      await setAIVerificationStatus("openai", "gpt-4", "key", true);
      expect(getAIVerificationStatus()).not.toBeNull();

      await clearAIVerificationStatus();

      expect(getAIVerificationStatus()).toBeNull();
      expect(secureDelete).toHaveBeenCalledWith("secure_ai_verification");
    });

    it("clears STT verification from cache and secure storage", async () => {
      await setSTTVerificationStatus("whisper", "whisper-1", "key", true);
      expect(getSTTVerificationStatus()).not.toBeNull();

      await clearSTTVerificationStatus();

      expect(getSTTVerificationStatus()).toBeNull();
      expect(secureDelete).toHaveBeenCalledWith("secure_stt_verification");
    });
  });

  describe("isAIVerificationValid / isSTTVerificationValid - Hash Invalidation", () => {
    it("returns true when provider, model, and API key match", async () => {
      await setAIVerificationStatus("openai", "gpt-4", "sk-test-key", true);

      const isValid = await isAIVerificationValid("openai", "gpt-4", "sk-test-key");
      expect(isValid).toBe(true);
    });

    it("returns false when no verification exists", async () => {
      const isValid = await isAIVerificationValid("openai", "gpt-4", "sk-test-key");
      expect(isValid).toBe(false);
    });

    it("returns false when verification failed", async () => {
      await setAIVerificationStatus("openai", "gpt-4", "sk-test-key", false, "Error");

      const isValid = await isAIVerificationValid("openai", "gpt-4", "sk-test-key");
      expect(isValid).toBe(false);
    });

    it("INVALIDATES when provider changes", async () => {
      await setAIVerificationStatus("openai", "gpt-4", "sk-test-key", true);

      // Same model and key, different provider
      const isValid = await isAIVerificationValid("anthropic", "gpt-4", "sk-test-key");
      expect(isValid).toBe(false);
    });

    it("INVALIDATES when model changes", async () => {
      await setAIVerificationStatus("openai", "gpt-4", "sk-test-key", true);

      // Same provider and key, different model
      const isValid = await isAIVerificationValid("openai", "gpt-4-turbo", "sk-test-key");
      expect(isValid).toBe(false);
    });

    it("INVALIDATES when API key changes", async () => {
      await setAIVerificationStatus("openai", "gpt-4", "sk-test-key-1", true);

      // Same provider and model, different key
      const isValid = await isAIVerificationValid("openai", "gpt-4", "sk-test-key-2");
      expect(isValid).toBe(false);
    });

    it("validates STT verification independently", async () => {
      await setSTTVerificationStatus("groq", "whisper-large-v3", "stt-key", true);

      const isValid = await isSTTVerificationValid("groq", "whisper-large-v3", "stt-key");
      expect(isValid).toBe(true);

      // Different key should invalidate
      const isInvalid = await isSTTVerificationValid("groq", "whisper-large-v3", "different-key");
      expect(isInvalid).toBe(false);
    });
  });

  describe("getAIVerificationError / getSTTVerificationError", () => {
    it("returns error message when verification failed", async () => {
      await setAIVerificationStatus("openai", "gpt-4", "key", false, "Rate limit exceeded");

      expect(getAIVerificationError()).toBe("Rate limit exceeded");
    });

    it("returns undefined when no error", async () => {
      await setAIVerificationStatus("openai", "gpt-4", "key", true);

      expect(getAIVerificationError()).toBeUndefined();
    });

    it("returns undefined when no verification exists", () => {
      expect(getAIVerificationError()).toBeUndefined();
      expect(getSTTVerificationError()).toBeUndefined();
    });
  });

  describe("SHA-256 Hashing", () => {
    it("uses crypto.subtle.digest for hashing", async () => {
      await setAIVerificationStatus("openai", "gpt-4", "my-api-key", true);

      // TextEncoder.encode() returns Uint8Array, which is passed to crypto.subtle.digest
      expect(mockDigest).toHaveBeenCalledWith("SHA-256", expect.any(Uint8Array));
    });

    it("produces empty hash for empty API key", async () => {
      await setAIVerificationStatus("openai", "gpt-4", "", true);

      const cached = getAIVerificationStatus();
      expect(cached?.apiKeyHash).toBe("");
    });

    it("produces consistent hashes for same input", async () => {
      await setAIVerificationStatus("openai", "gpt-4", "consistent-key", true);
      const hash1 = getAIVerificationStatus()?.apiKeyHash;

      await setAIVerificationStatus("openai", "gpt-4", "consistent-key", true);
      const hash2 = getAIVerificationStatus()?.apiKeyHash;

      expect(hash1).toBe(hash2);
    });

    it("produces different hashes for different inputs", async () => {
      await setAIVerificationStatus("openai", "gpt-4", "key-one", true);
      const hash1 = getAIVerificationStatus()?.apiKeyHash;

      await setAIVerificationStatus("openai", "gpt-4", "key-two", true);
      const hash2 = getAIVerificationStatus()?.apiKeyHash;

      expect(hash1).not.toBe(hash2);
    });
  });

  describe("Edge Cases", () => {
    it("handles empty model name", async () => {
      await setAIVerificationStatus("openai", "", "key", true);
      const isValid = await isAIVerificationValid("openai", "", "key");
      expect(isValid).toBe(true);
    });

    it("handles special characters in API key", async () => {
      const specialKey = "sk-proj-ABC123!@#$%^&*()_+-=[]{}|;':\",./<>?";
      await setAIVerificationStatus("openai", "gpt-4", specialKey, true);

      const isValid = await isAIVerificationValid("openai", "gpt-4", specialKey);
      expect(isValid).toBe(true);
    });

    it("handles unicode in model name", async () => {
      await setAIVerificationStatus("openai", "gpt-4-日本語", "key", true);
      const isValid = await isAIVerificationValid("openai", "gpt-4-日本語", "key");
      expect(isValid).toBe(true);
    });

    it("handles very long API keys", async () => {
      const longKey = "sk-" + "a".repeat(1000);
      await setAIVerificationStatus("openai", "gpt-4", longKey, true);

      const isValid = await isAIVerificationValid("openai", "gpt-4", longKey);
      expect(isValid).toBe(true);
    });
  });
});
