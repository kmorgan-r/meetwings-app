import { beforeEach, describe, expect, it, vi } from "vitest";

const { secureGet, secureSet, secureDelete } = vi.hoisted(() => ({
  secureGet: vi.fn(),
  secureSet: vi.fn(async (_k: string, _v: string) => {}),
  secureDelete: vi.fn(async (_k: string) => {}),
}));
vi.mock("@/lib/secure-storage", () => ({ secureGet, secureSet, secureDelete }));

import { loadSummaryProvider, saveSummaryProvider } from "@/lib/storage/secure-provider-configs";

const V = { provider: "openrouter", variables: { api_key: "sk-or-v1-TESTKEY", model: "m" } };

beforeEach(() => {
  secureGet.mockReset();
  secureSet.mockClear();
  secureDelete.mockClear();
});

describe("summary provider storage", () => {
  it("round-trips through secure storage under secure_summary_provider", async () => {
    await saveSummaryProvider(V);
    expect(secureSet).toHaveBeenCalledWith("secure_summary_provider", JSON.stringify(V));
    secureGet.mockResolvedValue(secureSet.mock.calls[0][1]);
    expect(await loadSummaryProvider()).toEqual(V);
    expect(secureGet).toHaveBeenCalledWith("secure_summary_provider");
  });

  it("save(null) deletes the key", async () => {
    await saveSummaryProvider(null);
    expect(secureDelete).toHaveBeenCalledWith("secure_summary_provider");
    expect(secureSet).not.toHaveBeenCalled();
  });

  it("a missing blob is null", async () => {
    secureGet.mockResolvedValue(null);
    expect(await loadSummaryProvider()).toBeNull();
  });

  it.each(["{not json", '{"provider":"x"}', "[]"])(
    "an unreadable blob %s throws a fixed code",
    async (blob) => {
      secureGet.mockResolvedValue(blob);
      await expect(loadSummaryProvider()).rejects.toThrow(/^SUMMARY_PROVIDER_UNREADABLE$/);
    }
  );

  it("a store failure propagates", async () => {
    secureGet.mockRejectedValue(new Error("store down"));
    await expect(loadSummaryProvider()).rejects.toThrow("store down");
  });
});
