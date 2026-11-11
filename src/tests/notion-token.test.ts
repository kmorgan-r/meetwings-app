import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@/lib/secure-storage", () => ({
  secureSet: vi.fn(),
  secureGet: vi.fn(),
  secureDelete: vi.fn(),
}));

import { secureSet } from "@/lib/secure-storage";
import {
  saveNotionToken,
  loadNotionToken,
  clearNotionToken,
  isNotionKeychainAvailable,
} from "@/lib/notion/token";
import { NotionError } from "@/lib/notion/errors";

describe("notion token", () => {
  let setItem: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    invoke.mockReset();
    vi.mocked(secureSet).mockClear();
    setItem = vi.spyOn(Storage.prototype, "setItem");
  });
  afterEach(() => setItem.mockRestore());

  it("saveNotionToken trims and stores through the keychain command only", async () => {
    invoke.mockResolvedValue(undefined);
    await saveNotionToken("  secret_abc\n");
    expect(invoke).toHaveBeenCalledWith("notion_token_set", { token: "secret_abc" });
    expect(secureSet).not.toHaveBeenCalled();
    for (const c of setItem.mock.calls) expect(String(c[1])).not.toContain("secret_abc");
  });

  it("saveNotionToken surfaces a keychain failure as NOTION_KEYCHAIN_UNAVAILABLE without the token in message", async () => {
    invoke.mockRejectedValue(new Error("boom secret_abc"));
    const err = await saveNotionToken("secret_abc").catch((e) => e);
    expect(err).toBeInstanceOf(NotionError);
    expect(err.code).toBe("NOTION_KEYCHAIN_UNAVAILABLE");
    expect(err.message).not.toContain("secret_abc");
    expect(err.message).not.toContain("boom");
  });

  it("loadNotionToken returns null when the command returns null", async () => {
    invoke.mockResolvedValue(null);
    expect(await loadNotionToken()).toBeNull();
  });

  it("loadNotionToken returns the stored token", async () => {
    invoke.mockResolvedValue("secret_abc");
    expect(await loadNotionToken()).toBe("secret_abc");
  });

  it("loadNotionToken throws NOTION_KEYCHAIN_UNAVAILABLE when the invoke rejects", async () => {
    invoke.mockRejectedValue("denied");
    await expect(loadNotionToken()).rejects.toMatchObject({ code: "NOTION_KEYCHAIN_UNAVAILABLE" });
  });

  it("clear and availability use their commands", async () => {
    invoke.mockResolvedValue(true);
    expect(await isNotionKeychainAvailable()).toBe(true);
    await clearNotionToken();
    expect(invoke).toHaveBeenCalledWith("notion_token_clear");
    invoke.mockRejectedValue("x");
    expect(await isNotionKeychainAvailable()).toBe(false);
  });
});
