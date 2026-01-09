/**
 * Tests for secure-provider-configs.ts
 *
 * Critical test cases:
 * - Secure storage migration from localStorage
 * - Cache consistency with persistent storage
 * - Race conditions on concurrent saves
 * - Loading and saving provider configurations
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

// Mock the secure-storage module before importing the module under test
vi.mock("@/lib/secure-storage", () => ({
  secureSet: vi.fn(),
  secureGet: vi.fn(),
  secureDelete: vi.fn(),
}));

import {
  loadSecureAIConfigs,
  loadSecureSTTConfigs,
  saveSecureAIConfig,
  saveSecureSTTConfig,
  getCachedAIConfig,
  getCachedSTTConfig,
  updateAIConfigCache,
  updateSTTConfigCache,
  clearSecureProviderConfigs,
  migrateProviderConfigsToSecureStorage,
} from "@/lib/storage/secure-provider-configs";
import { secureSet, secureGet, secureDelete } from "@/lib/secure-storage";

describe("secure-provider-configs", () => {
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

    // Reset caches by clearing (after mocks are set up)
    await clearSecureProviderConfigs();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("loadSecureAIConfigs / loadSecureSTTConfigs", () => {
    it("returns empty object when no configs exist", async () => {
      const configs = await loadSecureAIConfigs();
      expect(configs).toEqual({});
    });

    it("loads configs from secure storage", async () => {
      // Set data in mock secure storage (after beforeEach clears cache)
      secureStorageData["secure_ai_provider_configs"] = JSON.stringify({
        openai: { api_key: "sk-test", model: "gpt-4" },
      });

      const configs = await loadSecureAIConfigs();
      expect(configs.openai).toEqual({ api_key: "sk-test", model: "gpt-4" });
    });

    it("caches loaded configs", async () => {
      secureStorageData["secure_ai_provider_configs"] = JSON.stringify({
        openai: { api_key: "sk-test" },
      });

      // Clear call count after beforeEach
      vi.mocked(secureGet).mockClear();

      // First load
      await loadSecureAIConfigs();
      expect(secureGet).toHaveBeenCalledTimes(1);

      // Second load should use cache
      await loadSecureAIConfigs();
      expect(secureGet).toHaveBeenCalledTimes(1); // Still 1, used cache
    });

    it("handles JSON parse errors gracefully", async () => {
      // Set invalid JSON data (after beforeEach clears cache)
      secureStorageData["secure_ai_provider_configs"] = "invalid json";

      const configs = await loadSecureAIConfigs();
      expect(configs).toEqual({});
    });
  });

  describe("saveSecureAIConfig / saveSecureSTTConfig", () => {
    it("saves config to secure storage", async () => {
      await saveSecureAIConfig("openai", { api_key: "sk-new", model: "gpt-4" });

      expect(secureSet).toHaveBeenCalledWith(
        "secure_ai_provider_configs",
        expect.stringContaining("openai")
      );

      const stored = JSON.parse(secureStorageData["secure_ai_provider_configs"]);
      expect(stored.openai).toEqual({ api_key: "sk-new", model: "gpt-4" });
    });

    it("preserves existing configs when saving new one", async () => {
      // First save
      await saveSecureAIConfig("openai", { api_key: "sk-openai" });

      // Second save different provider
      await saveSecureAIConfig("anthropic", { api_key: "sk-anthropic" });

      const stored = JSON.parse(secureStorageData["secure_ai_provider_configs"]);
      expect(stored.openai).toEqual({ api_key: "sk-openai" });
      expect(stored.anthropic).toEqual({ api_key: "sk-anthropic" });
    });

    it("updates cache immediately", async () => {
      await saveSecureAIConfig("openai", { api_key: "sk-test" });

      const cached = getCachedAIConfig("openai");
      expect(cached).toEqual({ api_key: "sk-test" });
    });

    it("overwrites existing config for same provider", async () => {
      await saveSecureAIConfig("openai", { api_key: "old-key" });
      await saveSecureAIConfig("openai", { api_key: "new-key" });

      const stored = JSON.parse(secureStorageData["secure_ai_provider_configs"]);
      expect(stored.openai).toEqual({ api_key: "new-key" });
    });
  });

  describe("getCachedAIConfig / getCachedSTTConfig", () => {
    it("returns undefined when cache is empty", async () => {
      await clearSecureProviderConfigs();
      // Force empty cache
      const cached = getCachedAIConfig("openai");
      expect(cached).toBeUndefined();
    });

    it("returns cached config after load", async () => {
      // Set data in mock secure storage (after beforeEach clears cache)
      secureStorageData["secure_ai_provider_configs"] = JSON.stringify({
        openai: { api_key: "cached-key" },
      });

      await loadSecureAIConfigs();

      const cached = getCachedAIConfig("openai");
      expect(cached).toEqual({ api_key: "cached-key" });
    });

    it("returns cached config after save", async () => {
      await saveSecureAIConfig("groq", { api_key: "groq-key" });

      const cached = getCachedAIConfig("groq");
      expect(cached).toEqual({ api_key: "groq-key" });
    });
  });

  describe("updateAIConfigCache / updateSTTConfigCache - Async Saves", () => {
    it("updates cache and persists to secure storage", async () => {
      await updateAIConfigCache("openai", { api_key: "test-key" });

      const cached = getCachedAIConfig("openai");
      expect(cached).toEqual({ api_key: "test-key" });
      expect(secureSet).toHaveBeenCalled();
    });

    it("awaits the save to secure storage", async () => {
      await updateAIConfigCache("openai", { api_key: "async-save" });

      // secureSet should have been awaited
      expect(secureSet).toHaveBeenCalledWith(
        "secure_ai_provider_configs",
        expect.stringContaining("openai")
      );
    });

    it("throws on save errors", async () => {
      vi.mocked(secureSet).mockRejectedValueOnce(new Error("Save failed"));

      // Should throw the error
      await expect(
        updateAIConfigCache("openai", { api_key: "error-key" })
      ).rejects.toThrow("Save failed");

      // Cache should still be updated even if save fails
      expect(getCachedAIConfig("openai")).toEqual({ api_key: "error-key" });
    });
  });

  describe("clearSecureProviderConfigs", () => {
    it("clears both AI and STT configs", async () => {
      await saveSecureAIConfig("openai", { api_key: "ai-key" });
      await saveSecureSTTConfig("whisper", { api_key: "stt-key" });

      await clearSecureProviderConfigs();

      expect(secureDelete).toHaveBeenCalledWith("secure_ai_provider_configs");
      expect(secureDelete).toHaveBeenCalledWith("secure_stt_provider_configs");
    });

    it("clears caches", async () => {
      await saveSecureAIConfig("openai", { api_key: "cached" });
      await clearSecureProviderConfigs();

      // Cache should be null, getCachedAIConfig returns undefined for null cache
      expect(getCachedAIConfig("openai")).toBeUndefined();
    });
  });

  describe("migrateProviderConfigsToSecureStorage", () => {
    it("migrates AI configs from localStorage to secure storage", async () => {
      localStorageData["ai_provider_configs"] = JSON.stringify({
        openai: { api_key: "local-ai-key" },
      });

      await migrateProviderConfigsToSecureStorage();

      // Should have been migrated to secure storage
      expect(secureSet).toHaveBeenCalledWith(
        "secure_ai_provider_configs",
        JSON.stringify({ openai: { api_key: "local-ai-key" } })
      );

      // Should be removed from localStorage
      expect(localStorageData["ai_provider_configs"]).toBeUndefined();
    });

    it("migrates STT configs from localStorage to secure storage", async () => {
      localStorageData["stt_provider_configs"] = JSON.stringify({
        whisper: { api_key: "local-stt-key" },
      });

      await migrateProviderConfigsToSecureStorage();

      expect(secureSet).toHaveBeenCalledWith(
        "secure_stt_provider_configs",
        JSON.stringify({ whisper: { api_key: "local-stt-key" } })
      );

      expect(localStorageData["stt_provider_configs"]).toBeUndefined();
    });

    it("does not overwrite existing secure storage data", async () => {
      // Existing secure data
      secureStorageData["secure_ai_provider_configs"] = JSON.stringify({
        existing: { api_key: "secure-key" },
      });

      // Old localStorage data
      localStorageData["ai_provider_configs"] = JSON.stringify({
        openai: { api_key: "local-key" },
      });

      await migrateProviderConfigsToSecureStorage();

      // Should NOT have called secureSet (existing data protected)
      expect(secureSet).not.toHaveBeenCalledWith(
        "secure_ai_provider_configs",
        expect.any(String)
      );

      // But should still remove from localStorage
      expect(localStorageData["ai_provider_configs"]).toBeUndefined();
    });

    it("handles missing localStorage data gracefully", async () => {
      // No localStorage data

      await migrateProviderConfigsToSecureStorage();

      // Should not throw, should not call secureSet
      expect(secureSet).not.toHaveBeenCalled();
    });

    it("handles migration errors gracefully", async () => {
      localStorageData["ai_provider_configs"] = JSON.stringify({
        openai: { api_key: "test" },
      });

      vi.mocked(secureSet).mockRejectedValueOnce(new Error("Secure storage error"));

      // Should not throw
      await migrateProviderConfigsToSecureStorage();
    });
  });

  describe("Cache Consistency", () => {
    it("cache matches persistent storage after save", async () => {
      const config = { api_key: "consistency-test", model: "gpt-4" };
      await saveSecureAIConfig("openai", config);

      const cached = getCachedAIConfig("openai");
      const persisted = JSON.parse(secureStorageData["secure_ai_provider_configs"]).openai;

      expect(cached).toEqual(persisted);
    });

    it("cache matches persistent storage after load", async () => {
      // Set data in mock secure storage (after beforeEach clears cache)
      secureStorageData["secure_stt_provider_configs"] = JSON.stringify({
        groq: { api_key: "persisted-key" },
      });

      await loadSecureSTTConfigs();

      const cached = getCachedSTTConfig("groq");
      const persisted = JSON.parse(secureStorageData["secure_stt_provider_configs"]).groq;

      expect(cached).toEqual(persisted);
    });
  });

  describe("Race Conditions - Concurrent Saves", () => {
    it("handles concurrent saves without data loss", async () => {
      // Simulate concurrent saves
      const saves = [
        saveSecureAIConfig("provider1", { api_key: "key1" }),
        saveSecureAIConfig("provider2", { api_key: "key2" }),
        saveSecureAIConfig("provider3", { api_key: "key3" }),
      ];

      await Promise.all(saves);

      const stored = JSON.parse(secureStorageData["secure_ai_provider_configs"]);
      expect(stored.provider1).toEqual({ api_key: "key1" });
      expect(stored.provider2).toEqual({ api_key: "key2" });
      expect(stored.provider3).toEqual({ api_key: "key3" });
    });

    it("handles concurrent loads with single storage read", async () => {
      // Set data in mock secure storage (after beforeEach clears cache)
      secureStorageData["secure_ai_provider_configs"] = JSON.stringify({
        openai: { api_key: "test" },
      });

      // Clear call count after beforeEach
      vi.mocked(secureGet).mockClear();

      // Concurrent loads
      const loads = [
        loadSecureAIConfigs(),
        loadSecureAIConfigs(),
        loadSecureAIConfigs(),
      ];

      const results = await Promise.all(loads);

      // All should return same data
      expect(results[0]).toEqual(results[1]);
      expect(results[1]).toEqual(results[2]);

      // Should only read from storage once (due to loading promise)
      expect(secureGet).toHaveBeenCalledTimes(1);
    });

    it("handles interleaved save and load operations", async () => {
      // Interleaved save operations
      const ops = [
        saveSecureAIConfig("provider1", { api_key: "key1" }),
        saveSecureAIConfig("provider2", { api_key: "key2" }),
        loadSecureAIConfigs(),
        saveSecureAIConfig("provider3", { api_key: "key3" }),
      ];

      await Promise.all(ops);

      // Final state should have all providers
      const cached = await loadSecureAIConfigs();
      expect(cached.provider1).toEqual({ api_key: "key1" });
      expect(cached.provider2).toEqual({ api_key: "key2" });
      expect(cached.provider3).toEqual({ api_key: "key3" });
    });
  });

  describe("Edge Cases", () => {
    it("handles empty provider ID", async () => {
      await saveSecureAIConfig("", { api_key: "empty-id" });

      const cached = getCachedAIConfig("");
      expect(cached).toEqual({ api_key: "empty-id" });
    });

    it("handles empty config object", async () => {
      await saveSecureAIConfig("openai", {});

      const cached = getCachedAIConfig("openai");
      expect(cached).toEqual({});
    });

    it("handles special characters in config values", async () => {
      const config = {
        api_key: "sk-!@#$%^&*()_+-={}[]|:;'<>?,./",
        model: "test-模型",
      };
      await saveSecureAIConfig("openai", config);

      const cached = getCachedAIConfig("openai");
      expect(cached).toEqual(config);
    });

    it("handles very large configs", async () => {
      const largeConfig: Record<string, string> = {};
      for (let i = 0; i < 100; i++) {
        largeConfig[`key_${i}`] = "a".repeat(100);
      }

      await saveSecureAIConfig("openai", largeConfig);

      const cached = getCachedAIConfig("openai");
      expect(Object.keys(cached!).length).toBe(100);
    });
  });
});
