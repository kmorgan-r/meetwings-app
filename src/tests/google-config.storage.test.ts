import { beforeEach, describe, expect, it, vi } from "vitest";

const secure = vi.hoisted(() => ({ secureGet: vi.fn(), secureSet: vi.fn() }));
vi.mock("@/lib/secure-storage", () => secure);

import {
  SECURE_GOOGLE_CONFIG_KEY,
  loadGoogleConfigState,
  saveGoogleConfig,
} from "@/lib/storage/google-config.storage";

beforeEach(() => {
  secure.secureGet.mockReset();
  secure.secureSet.mockReset();
  secure.secureSet.mockResolvedValue(undefined);
});

describe("google config storage", () => {
  it("saves the client ID and secret through secure storage only", async () => {
    const setItem = vi.mocked(localStorage.setItem);
    setItem.mockClear();
    await saveGoogleConfig({ clientId: " id ", clientSecret: " s " });
    expect(secure.secureSet).toHaveBeenCalledWith(
      SECURE_GOOGLE_CONFIG_KEY,
      '{"clientId":"id","clientSecret":"s"}'
    );
    expect(setItem).not.toHaveBeenCalled();
  });

  it("a blob of the wrong shape is unreadable, not a throw", async () => {
    secure.secureGet.mockResolvedValueOnce("null");
    await expect(loadGoogleConfigState()).resolves.toEqual({ state: "unreadable", config: null });
    secure.secureGet.mockResolvedValueOnce('{"clientId":5,"clientSecret":"s"}');
    await expect(loadGoogleConfigState()).resolves.toEqual({ state: "unreadable", config: null });
    secure.secureGet.mockResolvedValueOnce('{"clientId":"id","clientSecret":{}}');
    await expect(loadGoogleConfigState()).resolves.toEqual({ state: "unreadable", config: null });
  });

  it("a blank secret or client ID is absent", async () => {
    secure.secureGet.mockResolvedValueOnce('{"clientId":"id","clientSecret":"  "}');
    await expect(loadGoogleConfigState()).resolves.toEqual({ state: "absent", config: null });
    secure.secureGet.mockResolvedValueOnce('{"clientId":" ","clientSecret":"s"}');
    await expect(loadGoogleConfigState()).resolves.toEqual({ state: "absent", config: null });
    secure.secureGet.mockResolvedValueOnce(null);
    await expect(loadGoogleConfigState()).resolves.toEqual({ state: "absent", config: null });
  });

  it("an unreadable blob is unreadable, not absent", async () => {
    secure.secureGet.mockRejectedValueOnce(new Error("locked"));
    await expect(loadGoogleConfigState()).resolves.toEqual({ state: "unreadable", config: null });
    secure.secureGet.mockResolvedValueOnce("{");
    await expect(loadGoogleConfigState()).resolves.toEqual({ state: "unreadable", config: null });
  });

  it("a complete blob is complete", async () => {
    secure.secureGet.mockResolvedValueOnce('{"clientId":" id ","clientSecret":"s"}');
    await expect(loadGoogleConfigState()).resolves.toEqual({
      state: "complete",
      config: { clientId: "id", clientSecret: "s" },
    });
  });
});
