import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TeamStorageFake } from "./team-test-utils";

const h = vi.hoisted(() => ({
  fake: undefined as unknown as TeamStorageFake,
  apply: vi.fn(),
  resetCache: vi.fn(),
}));

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
vi.mock("@/lib/team/team-apply", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/team/team-apply")>()),
  applyTeamFile: (...a: unknown[]) => h.apply(...a),
}));
vi.mock("@/lib/storage/secure-provider-configs", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/storage/secure-provider-configs")>();
  return {
    ...actual,
    resetSecureProviderConfigsCache: () => {
      h.resetCache();
      actual.resetSecureProviderConfigsCache();
    },
  };
});

import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { emit } from "@tauri-apps/api/event";
import { STORAGE_KEYS, TEAM_SETTINGS_APPLIED_EVENT } from "@/config";
import { NOTION_CONFIG_CHANGED_EVENT } from "@/lib/storage/notion-config.storage";
import { GOOGLE_CONNECTION_CHANGED_EVENT } from "@/lib/storage/google-config.storage";
import { applyTeamFile, TEAM_LINK_SECURE_KEY } from "@/lib/team/team-apply";
import { encryptTeamPayload, generateTeamKey } from "@/lib/team/team-crypto";
import { exportTeamSettings, type TeamFileV1 } from "@/lib/team/team-file";
import { buildTeamLink, type TeamLink } from "@/lib/team/team-link";
import {
  __resetTeamSyncForTests,
  fetchTeamFile,
  leaveTeam,
  loadOwnerTeamLink,
  loadStoredTeamLink,
  syncTeam,
  TEAM_OWNER_GIST_SECURE_KEY,
  TEAM_OWNER_KEY_SECURE_KEY,
} from "@/lib/team/team-sync";
import { AI_CONFIGS_KEY, resetSecureProviderConfigsCache } from "@/lib/storage/secure-provider-configs";
import { createTeamStorageFake } from "./team-test-utils";

const MEETINGS_URL = "https://www.notion.so/acme/Meetings-0123456789abcdef0123456789abcdef";
const KEY = generateTeamKey();
const LINK: TeamLink = { gistId: "0123456789abcdef0123", key: KEY };

function teamFile(): TeamFileV1 {
  return {
    version: 1,
    ai: { provider: "openai", variables: { api_key: "sk-team", model: "gpt-team" } },
    stt: { provider: "groq", variables: { api_key: "stt-team" } },
    notion: { token: "ntn_team", meetingsDbUrl: MEETINGS_URL },
    google: { clientId: "team-client.apps.googleusercontent.com", clientSecret: "g-secret" },
  };
}

const OWNER_LOGIN = "team-owner";
const gistResponse = (blob: string, status = 200) =>
  ({
    status,
    text: async () => JSON.stringify({ owner: { login: OWNER_LOGIN }, files: { "team.txt": { content: blob } } }),
  }) as unknown as Response;

const serve = async (payload: unknown, key = KEY) =>
  vi.mocked(tauriFetch).mockResolvedValue(
    gistResponse(await encryptTeamPayload(typeof payload === "string" ? payload : JSON.stringify(payload), key))
  );

const emitted = () => vi.mocked(emit).mock.calls.map((c) => c[0]);

/** A non-empty prior state, so "byte-identical" means something. */
function seedPrior() {
  h.fake.keychain.token = "old-token";
  h.fake.local.set(
    STORAGE_KEYS.SELECTED_AI_PROVIDER,
    JSON.stringify({ provider: "openai", variables: { api_key: "sk-old" } })
  );
}

beforeEach(() => {
  h.fake = createTeamStorageFake();
  resetSecureProviderConfigsCache();
  __resetTeamSyncForTests();
  vi.mocked(tauriFetch).mockReset();
  vi.mocked(emit).mockClear();
  h.resetCache.mockClear();
  h.apply.mockReset();
  return vi.importActual<typeof import("@/lib/team/team-apply")>("@/lib/team/team-apply").then((a) => {
    h.apply.mockImplementation(a.applyTeamFile);
  });
});

describe("syncTeam failures", () => {
  const withFile = (over: (f: any) => void) => async () => {
    const f = teamFile();
    over(f);
    await serve(f);
  };
  it.each<[string, () => Promise<void> | void, string]>([
    ["HTTP 404", () => void vi.mocked(tauriFetch).mockResolvedValue(gistResponse("", 404)), "TEAM_FETCH_FAILED"],
    ["network error", () => void vi.mocked(tauriFetch).mockRejectedValue(new Error("offline")), "TEAM_FETCH_FAILED"],
    ["wrong key", () => serve(teamFile(), generateTeamKey()), "TEAM_DECRYPT_FAILED"],
    ["not JSON inside", () => serve("not json at all"), "TEAM_FILE_INVALID"],
    ["version 2", () => serve({ ...teamFile(), version: 2 }), "TEAM_FILE_TOO_NEW"],
    ["missing required field", withFile((f) => (f.notion.token = "")), "TEAM_FIELD_MISSING"],
  ])("%s leaves storage byte-identical and stores no link", async (_n, setup, code) => {
    seedPrior();
    const before = h.fake.snapshot();
    await setup();
    const r = await syncTeam(LINK, { firstJoin: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r).toMatchObject({ code, landed: false, googleClientChanged: false });
    expect(h.fake.snapshot()).toBe(before);
    expect(h.fake.secure.has(TEAM_LINK_SECURE_KEY)).toBe(false);
    expect(h.fake.local.has(STORAGE_KEYS.TEAM_LAST_SYNCED_AT)).toBe(false);
    expect(emitted()).toEqual([]);
  });
});

describe("fetchTeamFile", () => {
  it("returns the parsed file and the gist owner's login, and applies nothing", async () => {
    await serve(teamFile());
    const before = h.fake.snapshot();

    const r = await fetchTeamFile(LINK);

    expect(r).toEqual({ ok: true, value: { file: teamFile(), ownerLogin: OWNER_LOGIN } });
    expect(h.apply).not.toHaveBeenCalled();
    expect(h.fake.snapshot()).toBe(before);
  });
});

describe("syncTeam success", () => {
  it("first join success stores the link, stamps last synced and emits the three events once", async () => {
    await serve(teamFile());
    const r = await syncTeam(LINK, { firstJoin: true });
    expect(r).toEqual({ ok: true, value: { changed: true, googleClientChanged: false } });
    expect(h.fake.secure.get(TEAM_LINK_SECURE_KEY)).toBe(buildTeamLink(LINK));
    expect(Number(h.fake.local.get(STORAGE_KEYS.TEAM_LAST_SYNCED_AT))).toBeGreaterThan(0);
    const ev = emitted();
    expect(ev.filter((e) => e === TEAM_SETTINGS_APPLIED_EVENT)).toHaveLength(1);
    expect(ev.filter((e) => e === NOTION_CONFIG_CHANGED_EVENT)).toHaveLength(1);
    expect(ev.filter((e) => e === GOOGLE_CONNECTION_CHANGED_EVENT)).toHaveLength(1);
  });

  it("a no-op re-sync stamps last synced and emits nothing", async () => {
    await serve(teamFile());
    await syncTeam(LINK, { firstJoin: true });
    h.fake.local.delete(STORAGE_KEYS.TEAM_LAST_SYNCED_AT);
    vi.mocked(emit).mockClear();
    const r = await syncTeam(LINK, { firstJoin: false });
    expect(r).toEqual({ ok: true, value: { changed: false, googleClientChanged: false } });
    expect(h.fake.local.has(STORAGE_KEYS.TEAM_LAST_SYNCED_AT)).toBe(true);
    expect(emitted()).toEqual([]);
  });

  it("later sync: an apply failure stamps no last synced and still emits the events when something landed", async () => {
    await serve(teamFile());
    h.fake.failWhen((op, key) => op === "secureSet" && key === "secure_notion_config");
    const r = await syncTeam(LINK, { firstJoin: false });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.landed).toBe(true);
    expect(h.fake.local.has(STORAGE_KEYS.TEAM_LAST_SYNCED_AT)).toBe(false);
    expect(emitted()).toContain(TEAM_SETTINGS_APPLIED_EVENT);
  });

  it("first join: an apply failure that rolls back cleanly stamps nothing and emits nothing", async () => {
    await serve(teamFile());
    h.fake.failWhen((op, key) => op === "secureSet" && key === "secure_notion_config");
    const r = await syncTeam(LINK, { firstJoin: true });
    expect(r).toMatchObject({ ok: false, code: "TEAM_WRITE_FAILED", landed: false });
    expect(h.fake.local.has(STORAGE_KEYS.TEAM_LAST_SYNCED_AT)).toBe(false);
    expect(emitted()).toEqual([]);
  });
});

describe("syncTeam serialization and throws", () => {
  it("two concurrent syncs run one after the other", async () => {
    await serve(teamFile());
    const ok = vi.mocked(tauriFetch).getMockImplementation()!;
    let release!: (r: Response) => void;
    vi.mocked(tauriFetch).mockImplementationOnce(() => new Promise<Response>((res) => (release = res)));
    vi.mocked(tauriFetch).mockImplementation(ok);

    const first = syncTeam(LINK, { firstJoin: true });
    const second = syncTeam(LINK, { firstJoin: false });
    await vi.waitFor(() => expect(tauriFetch).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(tauriFetch).toHaveBeenCalledTimes(1);

    release((await (ok as () => Promise<Response>)()) as Response);
    await Promise.all([first, second]);
    expect(tauriFetch).toHaveBeenCalledTimes(2);
  });

  it("a sync whose body throws resolves TEAM_WRITE_FAILED and the next sync still runs", async () => {
    await serve(teamFile());
    h.apply.mockImplementationOnce(() => {
      throw new Error("boom " + KEY);
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const r1 = await syncTeam(LINK, { firstJoin: true });
    expect(r1).toEqual({ ok: false, code: "TEAM_WRITE_FAILED", landed: true, googleClientChanged: false });
    expect(emitted()).toContain(TEAM_SETTINGS_APPLIED_EVENT);
    expect(h.resetCache).toHaveBeenCalled();
    expect(warn.mock.calls).toEqual([["[team] sync failed:", "TEAM_WRITE_FAILED"]]);
    warn.mockRestore();

    const r2 = await syncTeam(LINK, { firstJoin: true });
    expect(r2.ok).toBe(true);
  });
});

describe("team links and leaving", () => {
  it("loadStoredTeamLink and loadOwnerTeamLink read and validate their stores", async () => {
    expect(await loadStoredTeamLink()).toBeNull();
    expect(await loadOwnerTeamLink()).toBeNull();
    h.fake.secure.set(TEAM_LINK_SECURE_KEY, buildTeamLink(LINK));
    expect(await loadStoredTeamLink()).toEqual(LINK);
    h.fake.secure.set(TEAM_OWNER_KEY_SECURE_KEY, LINK.key);
    expect(await loadOwnerTeamLink()).toBeNull();
    h.fake.secure.set(TEAM_OWNER_GIST_SECURE_KEY, LINK.gistId);
    expect(await loadOwnerTeamLink()).toEqual(LINK);
    h.fake.secure.set(TEAM_OWNER_GIST_SECURE_KEY, "not a gist id");
    expect(await loadOwnerTeamLink()).toBeNull();
    h.fake.failWhen((op) => op === "secureGet");
    expect(await loadStoredTeamLink()).toBeNull();
    expect(await loadOwnerTeamLink()).toBeNull();
  });

  it("leaveTeam deletes the link and last-synced and keeps settings", async () => {
    await serve(teamFile());
    await syncTeam(LINK, { firstJoin: true });
    const token = h.fake.keychain.token;
    const ai = h.fake.secure.get(AI_CONFIGS_KEY);
    await leaveTeam();
    expect(h.fake.secure.has(TEAM_LINK_SECURE_KEY)).toBe(false);
    expect(h.fake.local.has(STORAGE_KEYS.TEAM_LAST_SYNCED_AT)).toBe(false);
    expect(h.fake.keychain.token).toBe(token);
    expect(h.fake.secure.get(AI_CONFIGS_KEY)).toBe(ai);
  });

  it("leaveTeam still clears last-synced and never throws when the delete fails", async () => {
    h.fake.local.set(STORAGE_KEYS.TEAM_LAST_SYNCED_AT, "1");
    h.fake.failWhen((op) => op === "secureDelete");
    await expect(leaveTeam()).resolves.toBeUndefined();
    expect(h.fake.local.has(STORAGE_KEYS.TEAM_LAST_SYNCED_AT)).toBe(false);
  });

  it("Copy -> apply round trip reproduces the owner's settings", async () => {
    await applyTeamFile(teamFile(), { firstJoin: false });
    const owner = await exportTeamSettings();
    expect(owner.ok).toBe(true);
    if (!owner.ok) return;
    await serve(owner.value);

    // wipe storage
    h.fake = createTeamStorageFake();
    resetSecureProviderConfigsCache();
    const r = await syncTeam(LINK, { firstJoin: true });
    expect(r.ok).toBe(true);
    expect(await exportTeamSettings()).toEqual(owner);
  });
});
