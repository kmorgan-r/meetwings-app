import { beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({
  secureGet: vi.fn(async () => null as string | null),
  secureSet: vi.fn(async () => {}),
}));
vi.mock("@/lib/secure-storage", () => store);

// The real module would invoke Tauri keychain commands; these tests never
// touch it.
const tokenModule = vi.hoisted(() => ({
  isNotionKeychainAvailable: vi.fn(async () => true),
  loadNotionToken: vi.fn(async () => null as string | null),
}));
vi.mock("@/lib/notion/token", () => tokenModule);

// setup.ts replaces the global localStorage with bare vi.fn() stubs, so the
// auto-send tests observe a Map-backed safeLocalStorage instead - the functions
// under test still run their real read/write path.
const ls = vi.hoisted(() => {
  const map = new Map<string, string>();
  return {
    map,
    safeLocalStorage: {
      getItem: (key: string): string | null => map.get(key) ?? null,
      setItem: (key: string, value: string): void => {
        map.set(key, value);
      },
      removeItem: (key: string): void => {
        map.delete(key);
      },
    },
  };
});
vi.mock("@/lib/storage/helper", () => ({ safeLocalStorage: ls.safeLocalStorage }));

import {
  SECURE_NOTION_CONFIG_KEY,
  isNotionAutoSendEnabled,
  getNotionSetupAt,
  isNotionConfigured,
  loadNotionConfig,
  loadNotionConfigState,
  parseNotionDatabaseId,
  saveNotionConfig,
  setNotionAutoSendEnabled,
} from "@/lib/storage/notion-config.storage";
import type { NotionConfig } from "@/lib/storage/notion-config.storage";

// Fake ids only - never a real Notion database id in this public repo.
const ID = "0123456789abcdef0123456789abcdef";
const VIEW = "fedcba9876543210fedcba9876543210";
const MEETINGS_URL = `https://www.notion.so/acme/Weekly-Team-Meetings-${ID}?v=${VIEW}`;
// A DIFFERENT id from the meetings link, so the complete-state test proves the
// two ids are parsed separately (the view id in the query must be ignored).
const KNOWLEDGE_URL = `https://www.notion.so/acme/Team-Knowledge-${VIEW}?v=${ID}`;

const FULL_CONFIG: NotionConfig = {
  meetingsDbUrl: MEETINGS_URL,
  knowledgeDbUrl: KNOWLEDGE_URL,
  teamTimes: { wednesday: "10:00" },
  yourName: "Kim",
};

beforeEach(() => {
  vi.clearAllMocks();
  store.secureSet.mockResolvedValue(undefined);
  store.secureGet.mockResolvedValue(null);
  tokenModule.isNotionKeychainAvailable.mockResolvedValue(true);
  tokenModule.loadNotionToken.mockResolvedValue(null);
  ls.map.clear();
});

describe("SECURE_NOTION_CONFIG_KEY", () => {
  it('is exactly "secure_notion_config"', () => {
    expect(SECURE_NOTION_CONFIG_KEY).toBe("secure_notion_config");
  });
});

describe("parseNotionDatabaseId", () => {
  it.each([
    [`https://app.notion.com/p/acme/${ID}?v=${VIEW}`, ID],
    [`https://www.notion.so/acme/Weekly-Team-Meetings-${ID}?v=${VIEW}&pvs=4`, ID],
    [`https://www.notion.so/${ID}`, ID],
    [`  https://www.notion.so/acme/01234567-89ab-cdef-0123-456789abcdef \n`, ID],
    // The LAST run in the path wins: a first run from an earlier path segment
    // must not shadow the id.
    [`https://www.notion.so/p/${VIEW}/${ID}`, ID],
    // "Meetings-2026" runs together with the id into one 36-char run; its LAST
    // 32 characters are the id.
    [`https://www.notion.so/acme/Meetings-2026-${ID}`, ID],
    // Case-insensitive: an uppercase (dashed) URL still yields the lowercase id.
    [`https://www.notion.so/acme/01234567-89AB-CDEF-0123-456789ABCDEF`, ID],
    ["https://www.notion.so/acme/no-id-here", null],
    ["not a url", null],
  ])("parseNotionDatabaseId(%s) -> %s", (url, id) => {
    expect(parseNotionDatabaseId(url)).toBe(id);
  });

  it("ignores the query string entirely", () => {
    // The query would otherwise be read for hex runs: VIEW is 32 hex chars.
    expect(parseNotionDatabaseId(`https://www.notion.so/acme/no-id?v=${VIEW}`)).toBeNull();
  });
});

describe("loadNotionConfigState", () => {
  it("is absent with no token and no meetings link", async () => {
    store.secureGet.mockResolvedValue(null);
    tokenModule.loadNotionToken.mockResolvedValue(null);
    await expect(loadNotionConfigState()).resolves.toEqual({ state: "absent" });
    await expect(isNotionConfigured()).resolves.toBe(false);
  });

  it("records the setup time once, on complete only, and never overwrites it", async () => {
    // Not complete: nothing recorded.
    await loadNotionConfigState();
    expect(getNotionSetupAt()).toBeNull();
    store.secureGet.mockResolvedValue(JSON.stringify(FULL_CONFIG));
    tokenModule.loadNotionToken.mockResolvedValue(null);
    await loadNotionConfigState();
    expect(ls.map.has("notion_setup_at")).toBe(false);

    tokenModule.loadNotionToken.mockResolvedValue("secret_SENTINEL");
    await loadNotionConfigState();
    const first = getNotionSetupAt();
    expect(first).toBeGreaterThan(0);

    ls.map.set("notion_setup_at", "1234");
    await loadNotionConfigState();
    expect(getNotionSetupAt()).toBe(1234);
  });

  it("reads a garbage setup time as null", () => {
    ls.map.set("notion_setup_at", "soon");
    expect(getNotionSetupAt()).toBeNull();
    ls.map.set("notion_setup_at", "-5");
    expect(getNotionSetupAt()).toBeNull();
  });

  it("is incomplete and lists the missing token when the meetings link is set", async () => {
    store.secureGet.mockResolvedValue(JSON.stringify(FULL_CONFIG));
    tokenModule.loadNotionToken.mockResolvedValue(null);
    await expect(loadNotionConfigState()).resolves.toEqual({
      state: "incomplete",
      missing: ["token"],
    });
  });

  it("is incomplete and lists the missing link when only the token is present", async () => {
    store.secureGet.mockResolvedValue(null);
    tokenModule.loadNotionToken.mockResolvedValue("secret_SENTINEL");
    await expect(loadNotionConfigState()).resolves.toEqual({
      state: "incomplete",
      missing: ["meetingsDbUrl"],
    });
  });

  it("counts the meetings link as missing when it holds no database id", async () => {
    store.secureGet.mockResolvedValue(
      JSON.stringify({ ...FULL_CONFIG, meetingsDbUrl: "https://www.notion.so/acme/no-id-here" })
    );
    tokenModule.loadNotionToken.mockResolvedValue("secret_SENTINEL");
    await expect(loadNotionConfigState()).resolves.toEqual({
      state: "incomplete",
      missing: ["meetingsDbUrl"],
    });
  });

  it("reads complete and parses both ids from a full setup", async () => {
    store.secureGet.mockResolvedValue(JSON.stringify(FULL_CONFIG));
    tokenModule.loadNotionToken.mockResolvedValue("secret_SENTINEL");
    await expect(loadNotionConfigState()).resolves.toEqual({
      state: "complete",
      config: FULL_CONFIG,
      // The two links carry DIFFERENT ids (see KNOWNLEDGE_URL): each id is
      // parsed, not one shared value.
      meetingsDbId: ID,
      knowledgeDbId: VIEW,
    });
    await expect(isNotionConfigured()).resolves.toBe(true);
  });

  it("rejects when the stored read fails, for state and configured checks", async () => {
    store.secureGet.mockRejectedValue(new Error("keychain went away"));
    await expect(loadNotionConfigState()).rejects.toThrow("NOTION_CONFIG_UNREADABLE");
    await expect(isNotionConfigured()).rejects.toThrow("NOTION_CONFIG_UNREADABLE");
  });

  it("rejects when the stored blob is corrupt JSON", async () => {
    store.secureGet.mockResolvedValue('{"meetingsDbUrl": ');
    await expect(loadNotionConfigState()).rejects.toThrow("NOTION_CONFIG_UNREADABLE");
  });

  it("rejects when the stored blob is the JSON text null", async () => {
    store.secureGet.mockResolvedValue("null");
    await expect(loadNotionConfigState()).rejects.toThrow("NOTION_CONFIG_UNREADABLE");
  });

  it("rejects when the stored blob is a JSON array", async () => {
    store.secureGet.mockResolvedValue(`["${ID}"]`);
    await expect(loadNotionConfigState()).rejects.toThrow("NOTION_CONFIG_UNREADABLE");
  });

  it("reads knowledgeDbId as null when the Team Knowledge link is empty", async () => {
    store.secureGet.mockResolvedValue(JSON.stringify({ ...FULL_CONFIG, knowledgeDbUrl: "" }));
    tokenModule.loadNotionToken.mockResolvedValue("secret_SENTINEL");
    const result = await loadNotionConfigState();
    expect(result).toMatchObject({ state: "complete", meetingsDbId: ID });
    if (result.state !== "complete") throw new Error("expected complete");
    expect(result.knowledgeDbId).toBeNull();
    expect(result.config.knowledgeDbUrl).toBe("");
  });

  it("reads complete when the keychain read throws, as long as the link is set", async () => {
    // A throwing read is NOT "no token": meetings keep being queued for Notion
    // and the read is retried at send time, where the caller surfaces the
    // failure. Only an UNAVAILABLE keychain drops the token.
    store.secureGet.mockResolvedValue(JSON.stringify(FULL_CONFIG));
    tokenModule.loadNotionToken.mockRejectedValue(new Error("boom"));
    await expect(loadNotionConfigState()).resolves.toMatchObject({ state: "complete" });
  });

  it("reads incomplete ['token'] when the keychain is unavailable", async () => {
    store.secureGet.mockResolvedValue(JSON.stringify(FULL_CONFIG));
    tokenModule.isNotionKeychainAvailable.mockResolvedValue(false);
    tokenModule.loadNotionToken.mockResolvedValue("secret_SENTINEL");
    // Availability gates the read: even a readable token does not count.
    await expect(loadNotionConfigState()).resolves.toEqual({
      state: "incomplete",
      missing: ["token"],
    });
  });

  it("counts an empty token string as missing", async () => {
    store.secureGet.mockResolvedValue(JSON.stringify(FULL_CONFIG));
    tokenModule.loadNotionToken.mockResolvedValue("");
    await expect(loadNotionConfigState()).resolves.toEqual({
      state: "incomplete",
      missing: ["token"],
    });
  });
});

describe("loadNotionConfig", () => {
  it("returns null when nothing is stored", async () => {
    await expect(loadNotionConfig()).resolves.toBeNull();
  });

  it("returns the stored config when the meetings link is valid", async () => {
    store.secureGet.mockResolvedValue(JSON.stringify(FULL_CONFIG));
    await expect(loadNotionConfig()).resolves.toEqual(FULL_CONFIG);
  });

  it("returns the stored config even when the meetings link holds no id", async () => {
    // The settings card prefills what the user saved - the "missing
    // meetingsDbUrl" decision belongs to loadNotionConfigState, not here.
    const blob = { ...FULL_CONFIG, meetingsDbUrl: "https://www.notion.so/acme/no-id-here" };
    store.secureGet.mockResolvedValue(JSON.stringify(blob));
    await expect(loadNotionConfig()).resolves.toEqual(blob);
  });

  it("drops non-weekday and non-string teamTimes entries", async () => {
    const blob = {
      ...FULL_CONFIG,
      teamTimes: { monday: 9, tuesday: "10:00", foo: "x" },
    };
    store.secureGet.mockResolvedValue(JSON.stringify(blob));
    await expect(loadNotionConfig()).resolves.toEqual({
      ...FULL_CONFIG,
      teamTimes: { tuesday: "10:00" },
    });
    // state still reads complete: a junk teamTimes is a filter, not damage.
    tokenModule.loadNotionToken.mockResolvedValue("secret_SENTINEL");
    await expect(loadNotionConfigState()).resolves.toMatchObject({
      state: "complete",
      meetingsDbId: ID,
    });
  });
});

describe("saveNotionConfig", () => {
  it("stores the blob without ever holding the token", async () => {
    tokenModule.loadNotionToken.mockResolvedValue("secret_SENTINEL");
    await saveNotionConfig(FULL_CONFIG);
    expect(store.secureSet).toHaveBeenCalledTimes(1);
    const [key, payload] = store.secureSet.mock.calls[0] as [string, string];
    expect(key).toBe(SECURE_NOTION_CONFIG_KEY);
    expect(payload).not.toContain("secret_SENTINEL");
    expect(JSON.parse(payload)).toEqual(FULL_CONFIG);

    // Even a config HAND-CONTAMINATED with a token field loses it: the blob
    // shape is built by saveNotionConfig, not passed through.
    await saveNotionConfig({ ...FULL_CONFIG, token: "secret_SENTINEL" } as unknown as NotionConfig);
    const [, secondPayload] = store.secureSet.mock.calls[1] as [string, string];
    expect(secondPayload).not.toContain("secret_SENTINEL");
  });

  it("trims the string fields before storing", async () => {
    await saveNotionConfig({
      meetingsDbUrl: `  ${MEETINGS_URL}  `,
      knowledgeDbUrl: ` ${KNOWLEDGE_URL} `,
      teamTimes: { monday: "09:00" },
      yourName: "  Kim ",
    });
    expect(JSON.parse(store.secureSet.mock.calls[0][1] as string)).toEqual({
      meetingsDbUrl: MEETINGS_URL,
      knowledgeDbUrl: KNOWLEDGE_URL,
      teamTimes: { monday: "09:00" },
      yourName: "Kim",
    });
  });
});

describe("auto-send toggle", () => {
  it("defaults to on and persists off", () => {
    expect(isNotionAutoSendEnabled()).toBe(true);
    setNotionAutoSendEnabled(false);
    expect(ls.map.get("notion_auto_send")).toBe("false");
    expect(isNotionAutoSendEnabled()).toBe(false);
  });

  it("persists on when re-enabled", () => {
    setNotionAutoSendEnabled(true);
    expect(ls.map.get("notion_auto_send")).toBe("true");
    expect(isNotionAutoSendEnabled()).toBe(true);
  });
});
