import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TeamStorageFake } from "./team-test-utils";

const h = vi.hoisted(() => ({ fake: undefined as unknown as TeamStorageFake }));

vi.mock("@/lib/secure-storage", () => ({
  secureGet: (k: string) => h.fake.secureModule.secureGet(k),
  secureSet: (k: string, v: string) => h.fake.secureModule.secureSet(k, v),
  secureDelete: (k: string) => h.fake.secureModule.secureDelete(k),
  secureHas: (k: string) => h.fake.secureModule.secureHas(k),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: unknown) => h.fake.invoke(cmd, args),
}));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ emit: vi.fn(async () => undefined) }));

import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { encryptTeamPayload, generateTeamKey } from "@/lib/team/team-crypto";
import type { TeamFileV1 } from "@/lib/team/team-file";
import { __resetTeamSyncForTests, syncTeam } from "@/lib/team/team-sync";
import { resetSecureProviderConfigsCache } from "@/lib/storage/secure-provider-configs";
import { createTeamStorageFake } from "./team-test-utils";

const AI = "SENTINEL_AI_KEY_7f3";
const STT = "SENTINEL_STT_KEY_9a1";
const NOTION = "SENTINEL_NOTION_TOKEN_2c8";
const GOOGLE = "SENTINEL_GOOGLE_SECRET_5d4";
const GIST_ID = "abcdef0123456789abcdef";
const LINK_KEY = "SENTINEL_LINK_KEY_abcdefghijklmnopqrstuvwxy"; // 43 chars
const SENTINELS = [AI, STT, NOTION, GOOGLE, GIST_ID, LINK_KEY];
const LINK = { gistId: GIST_ID, key: LINK_KEY };

const file = (): TeamFileV1 => ({
  version: 1,
  ai: { provider: "openai", variables: { api_key: AI } },
  stt: { provider: "groq", variables: { api_key: STT } },
  notion: {
    token: NOTION,
    meetingsDbUrl: "https://www.notion.so/acme/Meetings-0123456789abcdef0123456789abcdef",
  },
  google: { clientId: "client.apps.googleusercontent.com", clientSecret: GOOGLE },
});

const blobResponse = async (plaintext: string, key = LINK_KEY) =>
  ({
    status: 200,
    text: async () =>
      JSON.stringify({
        owner: { login: "team-owner" },
        files: { "t.txt": { content: await encryptTeamPayload(plaintext, key) } },
      }),
  }) as unknown as Response;

const spies = () =>
  (["error", "warn", "log", "info", "debug"] as const).map((m) =>
    vi.spyOn(console, m).mockImplementation(() => undefined)
  );

const flat = (arg: unknown): string =>
  arg instanceof Error ? `${String(arg)} ${arg.message} ${arg.stack ?? ""}` : `${String(arg)} ${safeJson(arg)}`;
const safeJson = (v: unknown) => {
  try {
    return JSON.stringify(v) ?? "";
  } catch {
    return "";
  }
};

describe("team sync redaction", () => {
  let consoleSpies: ReturnType<typeof spies>;
  beforeEach(() => {
    h.fake = createTeamStorageFake();
    resetSecureProviderConfigsCache();
    __resetTeamSyncForTests();
    vi.mocked(tauriFetch).mockReset();
    consoleSpies = spies();
  });
  afterEach(() => consoleSpies.forEach((s) => s.mockRestore()));

  const allConsoleArgs = () => consoleSpies.flatMap((s) => s.mock.calls.flat()).map(flat).join("\n");

  const paths: [string, () => Promise<void>][] = [
    [
      "fetch rejection naming the gist",
      async () => {
        vi.mocked(tauriFetch).mockRejectedValue(new Error(`GET https://api.github.com/gists/${GIST_ID} failed`));
      },
    ],
    [
      "decrypt failure",
      async () => {
        vi.mocked(tauriFetch).mockResolvedValue(await blobResponse(JSON.stringify(file()), generateTeamKey()));
      },
    ],
    [
      "parse failure",
      async () => {
        vi.mocked(tauriFetch).mockResolvedValue(
          await blobResponse(JSON.stringify({ ...file(), notion: { token: NOTION } }))
        );
      },
    ],
    [
      "keychain write rejecting with the token",
      async () => {
        vi.mocked(tauriFetch).mockResolvedValue(await blobResponse(JSON.stringify(file())));
        const orig = h.fake.invoke.getMockImplementation()!;
        h.fake.invoke.mockImplementation(async (cmd: string, args?: any) => {
          if (cmd === "notion_token_set") throw new Error(`keychain rejected ${args.token}`);
          return orig(cmd, args);
        });
      },
    ],
  ];

  it.each(paths)("%s leaks no sentinel to console or the result", async (_n, force) => {
    await force();
    const r = await syncTeam(LINK, { firstJoin: true });
    expect(r.ok).toBe(false);
    // Proves the spies capture: an empty capture would make the check below vacuous.
    expect(allConsoleArgs()).toContain("[team] sync failed:");
    const out = JSON.stringify(r) + allConsoleArgs();
    for (const s of SENTINELS) expect(out).not.toContain(s);
  });

  it("the harness would notice a leak: sentinels do reach the code", async () => {
    // The gist id is in the fetch URL and the file holds every secret, so the
    // inputs are real; a console.error(err) of the fetch rejection would show it.
    vi.mocked(tauriFetch).mockResolvedValue(await blobResponse(JSON.stringify(file())));
    const r = await syncTeam(LINK, { firstJoin: true });
    expect(r.ok).toBe(true);
    expect(h.fake.keychain.token).toBe(NOTION);
    expect(JSON.stringify([...h.fake.secure])).toContain(AI);
    expect(JSON.stringify([...h.fake.secure])).toContain(GOOGLE);
    expect(String(vi.mocked(tauriFetch).mock.calls[0][0])).toContain(GIST_ID);
    expect(flat(new Error(`x ${AI}`))).toContain(AI);
  });
});
