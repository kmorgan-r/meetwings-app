import { beforeEach, describe, expect, it, vi } from "vitest";
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

import { STORAGE_KEYS } from "@/config";
import { applyTeamFile, TEAM_LINK_SECURE_KEY } from "@/lib/team/team-apply";
import type { TeamFileV1 } from "@/lib/team/team-file";
import { buildTeamLink, type TeamLink } from "@/lib/team/team-link";
import { SECURE_GOOGLE_CONFIG_KEY } from "@/lib/storage/google-config.storage";
import { SECURE_NOTION_CONFIG_KEY } from "@/lib/storage/notion-config.storage";
import {
  AI_CONFIGS_KEY,
  loadSecureAIConfigs,
  resetSecureProviderConfigsCache,
  STT_CONFIGS_KEY,
} from "@/lib/storage/secure-provider-configs";
import { createTeamStorageFake } from "./team-test-utils";

const MEETINGS_URL = "https://www.notion.so/acme/Meetings-0123456789abcdef0123456789abcdef";
const OLD_MEETINGS_URL = "https://www.notion.so/acme/Old-fedcba9876543210fedcba9876543210";
const LINK: TeamLink = { gistId: "0123456789abcdef0123", key: "k".repeat(43) };

function teamFile(): TeamFileV1 {
  return {
    version: 1,
    ai: { provider: "openai", variables: { api_key: "sk-team", model: "gpt-team" } },
    stt: { provider: "groq-whisper", variables: { api_key: "stt-team" } },
    notion: { token: "ntn_team", meetingsDbUrl: MEETINGS_URL },
    google: { clientId: "team-client.apps.googleusercontent.com", clientSecret: "g-secret" },
  };
}

const json = (raw: string | null | undefined): unknown => (raw == null ? raw : JSON.parse(raw));
const secureJson = (key: string) => json(h.fake.secure.get(key));
const localJson = (key: string) => json(h.fake.local.get(key));

const notionBlob = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ meetingsDbUrl: OLD_MEETINGS_URL, knowledgeDbUrl: "", teamTimes: {}, yourName: "", ...over });

/** Every write the apply could make, counted. */
function writeCounts() {
  const invokes = h.fake.invoke.mock.calls.map((c) => c[0]);
  return {
    secureSet: h.fake.secureModule.secureSet.mock.calls.length,
    secureDelete: h.fake.secureModule.secureDelete.mock.calls.length,
    localSet: vi.mocked(localStorage.setItem).mock.calls.length,
    localRemove: vi.mocked(localStorage.removeItem).mock.calls.length,
    tokenSet: invokes.filter((c) => c === "notion_token_set").length,
    tokenClear: invokes.filter((c) => c === "notion_token_clear").length,
  };
}

const secureSetKeys = () => h.fake.secureModule.secureSet.mock.calls.map((c) => c[0]);
const disconnects = () => h.fake.invoke.mock.calls.filter((c) => c[0] === "google_disconnect").length;

// Prior raws in a non-canonical form (indented, reordered): an undo that went
// through a save function would re-normalize them and break byte identity.
const PRIOR_NOTION_RAW = JSON.stringify(
  { yourName: "Ana", teamTimes: {}, knowledgeDbUrl: "", meetingsDbUrl: OLD_MEETINGS_URL },
  null,
  1
);
const PRIOR_GOOGLE_RAW = JSON.stringify({ clientSecret: "old-s", clientId: "old-client" }, null, 1);
const PRIOR_AI_RAW = JSON.stringify({ openai: { api_key: "sk-old" }, groq: { api_key: "g" } }, null, 1);

/** Every write in call order: secure/local writes by key, keychain writes as "token". */
function writeLog(): string[] {
  type Fn = { mock: { calls: unknown[][]; invocationCallOrder: number[] } };
  const entries: [number, string][] = [];
  const add = (fn: Fn, label: (call: unknown[]) => string | null) =>
    fn.mock.calls.forEach((call, i) => {
      const l = label(call);
      if (l !== null) entries.push([fn.mock.invocationCallOrder[i], l]);
    });
  add(h.fake.secureModule.secureSet, (c) => `secure:${c[0]}`);
  add(h.fake.secureModule.secureDelete, (c) => `secure:${c[0]}`);
  add(vi.mocked(localStorage.setItem), (c) => `local:${c[0]}`);
  add(vi.mocked(localStorage.removeItem), (c) => `local:${c[0]}`);
  add(h.fake.invoke, (c) => (c[0] === "notion_token_set" || c[0] === "notion_token_clear" ? "token" : null));
  return entries.sort((a, b) => a[0] - b[0]).map(([, l]) => l);
}

/**
 * A real secureSet can reject after store.set (store.save failed), leaving the
 * new value in the store's memory: write it, then reject once for `key`.
 */
function writeThenRejectOnce(key: string) {
  let thrown = false;
  h.fake.secureModule.secureSet.mockImplementation(async (k: string, v: string) => {
    h.fake.secure.set(k, v);
    if (k === key && !thrown) {
      thrown = true;
      throw new Error("fake save failure");
    }
  });
}

/** A non-empty prior install, so a rollback test proves restoration. */
function seedPriorState() {
  h.fake.keychain.token = "ntn_old";
  h.fake.secure.set(AI_CONFIGS_KEY, PRIOR_AI_RAW);
  h.fake.secure.set(SECURE_NOTION_CONFIG_KEY, PRIOR_NOTION_RAW);
  h.fake.secure.set(SECURE_GOOGLE_CONFIG_KEY, PRIOR_GOOGLE_RAW);
  h.fake.local.set(
    STORAGE_KEYS.SELECTED_AI_PROVIDER,
    JSON.stringify({ variables: { api_key: "g" }, provider: "groq" }, null, 1)
  );
}

beforeEach(() => {
  h.fake = createTeamStorageFake();
  resetSecureProviderConfigsCache();
});

describe("applyTeamFile", () => {
  it("applies every covered field on an empty install", async () => {
    const result = await applyTeamFile(teamFile(), { firstJoin: true, link: LINK });

    expect(result).toEqual({ ok: true, value: { changed: true, googleClientChanged: false } });
    expect(h.fake.keychain.token).toBe("ntn_team");
    expect(secureJson(AI_CONFIGS_KEY)).toEqual({ openai: { api_key: "sk-team", model: "gpt-team" } });
    expect(localJson(STORAGE_KEYS.SELECTED_AI_PROVIDER)).toEqual({
      provider: "openai",
      variables: { api_key: "sk-team", model: "gpt-team" },
    });
    expect(secureJson(STT_CONFIGS_KEY)).toEqual({ "groq-whisper": { api_key: "stt-team" } });
    expect(localJson(STORAGE_KEYS.SELECTED_STT_PROVIDER)).toEqual({
      provider: "groq-whisper",
      variables: { api_key: "stt-team" },
    });
    expect(secureJson(SECURE_GOOGLE_CONFIG_KEY)).toEqual({
      clientId: "team-client.apps.googleusercontent.com",
      clientSecret: "g-secret",
    });
    expect(secureJson(SECURE_NOTION_CONFIG_KEY)).toEqual({
      meetingsDbUrl: MEETINGS_URL,
      knowledgeDbUrl: "",
      teamTimes: {},
      yourName: "",
    });
    expect(h.fake.secure.get(TEAM_LINK_SECURE_KEY)).toBe(buildTeamLink(LINK));
    // No custom provider in the file: the custom lists are not touched.
    expect(h.fake.local.has(STORAGE_KEYS.CUSTOM_AI_PROVIDERS)).toBe(false);
    expect(h.fake.local.has(STORAGE_KEYS.CUSTOM_SPEECH_PROVIDERS)).toBe(false);
  });

  it("keeps a typed yourName and leaves uncovered settings untouched", async () => {
    h.fake.secure.set(SECURE_NOTION_CONFIG_KEY, notionBlob({ yourName: "Ana" }));
    h.fake.local.set(STORAGE_KEYS.SYSTEM_PROMPT, "x");
    h.fake.secure.set("odoo_config", "y");

    const result = await applyTeamFile(teamFile(), { firstJoin: false });

    expect(result.ok).toBe(true);
    expect(secureJson(SECURE_NOTION_CONFIG_KEY)).toEqual({
      meetingsDbUrl: MEETINGS_URL,
      knowledgeDbUrl: "",
      teamTimes: {},
      yourName: "Ana",
    });
    expect(h.fake.local.get(STORAGE_KEYS.SYSTEM_PROMPT)).toBe("x");
    expect(h.fake.secure.get("odoo_config")).toBe("y");
    // A later sync never stores a link.
    expect(h.fake.secure.has(TEAM_LINK_SECURE_KEY)).toBe(false);
  });

  it("a no-op re-apply writes nothing", async () => {
    // Same values as the file, but stored in a different key order than the
    // merge produces: key order alone must never count as a change.
    const aiBlob = JSON.stringify({ openai: { api_key: "sk-team", model: "gpt-team" } });
    h.fake.secure.set(AI_CONFIGS_KEY, aiBlob);
    h.fake.local.set(
      STORAGE_KEYS.SELECTED_AI_PROVIDER,
      JSON.stringify({ variables: { model: "gpt-team", api_key: "sk-team" }, provider: "openai" })
    );

    const first = await applyTeamFile(teamFile(), { firstJoin: false });
    expect(first).toEqual({ ok: true, value: { changed: true, googleClientChanged: false } });
    expect(h.fake.secure.get(AI_CONFIGS_KEY)).toBe(aiBlob);
    expect(secureSetKeys()).not.toContain(AI_CONFIGS_KEY);
    expect(vi.mocked(localStorage.setItem).mock.calls.map((c) => c[0])).not.toContain(
      STORAGE_KEYS.SELECTED_AI_PROVIDER
    );
    const afterFirst = writeCounts();

    const second = await applyTeamFile(teamFile(), { firstJoin: false });

    expect(second).toEqual({ ok: true, value: { changed: false, googleClientChanged: false } });
    expect(writeCounts()).toEqual(afterFirst);
  });

  it("padded team values are stored trimmed and a re-apply writes nothing", async () => {
    const file = teamFile();
    file.notion.token = "  ntn_team \n";
    file.notion.meetingsDbUrl = ` ${MEETINGS_URL} `;
    file.google = { clientId: " team-client.apps.googleusercontent.com ", clientSecret: " g-secret " };

    await applyTeamFile(file, { firstJoin: false });
    expect(h.fake.keychain.token).toBe("ntn_team");
    expect(secureJson(SECURE_NOTION_CONFIG_KEY)).toMatchObject({ meetingsDbUrl: MEETINGS_URL });
    const afterFirst = writeCounts();

    const second = await applyTeamFile(file, { firstJoin: false });

    expect(second).toEqual({ ok: true, value: { changed: false, googleClientChanged: false } });
    expect(writeCounts()).toEqual(afterFirst);
  });

  it("re-applies only the field a colleague edited (file wins)", async () => {
    await applyTeamFile(teamFile(), { firstJoin: false });
    // The user typed their own key into the dashboard: live selection and blob.
    h.fake.secure.set(AI_CONFIGS_KEY, JSON.stringify({ openai: { api_key: "mine", model: "gpt-team" } }));
    h.fake.local.set(
      STORAGE_KEYS.SELECTED_AI_PROVIDER,
      JSON.stringify({ provider: "openai", variables: { api_key: "mine", model: "gpt-team" } })
    );
    const before = writeCounts();
    const setsBefore = secureSetKeys().length;
    const localSetsBefore = vi.mocked(localStorage.setItem).mock.calls.length;

    const result = await applyTeamFile(teamFile(), { firstJoin: false });

    expect(result).toEqual({ ok: true, value: { changed: true, googleClientChanged: false } });
    expect(secureSetKeys().slice(setsBefore)).toEqual([AI_CONFIGS_KEY]);
    expect(vi.mocked(localStorage.setItem).mock.calls.slice(localSetsBefore).map((c) => c[0])).toEqual([
      STORAGE_KEYS.SELECTED_AI_PROVIDER,
    ]);
    expect(writeCounts()).toEqual({ ...before, secureSet: before.secureSet + 1, localSet: before.localSet + 1 });
    expect(secureJson(AI_CONFIGS_KEY)).toEqual({ openai: { api_key: "sk-team", model: "gpt-team" } });
    expect(localJson(STORAGE_KEYS.SELECTED_AI_PROVIDER)).toEqual({
      provider: "openai",
      variables: { api_key: "sk-team", model: "gpt-team" },
    });
  });

  it("absent optional fields keep local values", async () => {
    h.fake.secure.set(
      SECURE_NOTION_CONFIG_KEY,
      notionBlob({ knowledgeDbUrl: "https://www.notion.so/acme/K-11112222333344445555666677778888", teamTimes: { monday: "09:00" } })
    );
    h.fake.local.set(
      STORAGE_KEYS.SELECTED_AI_PROVIDER,
      JSON.stringify({ provider: "openai", variables: { api_key: "sk-old", model: "local-model" } })
    );
    const file = teamFile();
    file.ai.variables = { api_key: "sk-team" };

    const result = await applyTeamFile(file, { firstJoin: false });

    expect(result.ok).toBe(true);
    expect(secureJson(SECURE_NOTION_CONFIG_KEY)).toEqual({
      meetingsDbUrl: MEETINGS_URL,
      knowledgeDbUrl: "https://www.notion.so/acme/K-11112222333344445555666677778888",
      teamTimes: { monday: "09:00" },
      yourName: "",
    });
    const vars = { api_key: "sk-team", model: "local-model" };
    expect(localJson(STORAGE_KEYS.SELECTED_AI_PROVIDER)).toEqual({ provider: "openai", variables: vars });
    expect(secureJson(AI_CONFIGS_KEY)).toEqual({ openai: vars });
  });

  it("present optional fields replace local values", async () => {
    h.fake.secure.set(SECURE_NOTION_CONFIG_KEY, notionBlob({ knowledgeDbUrl: "old-k", teamTimes: { monday: "09:00" } }));
    const file = teamFile();
    file.notion.knowledgeDbUrl = "https://www.notion.so/acme/K-11112222333344445555666677778888";
    file.notion.teamTimes = { friday: "15:30" };

    await applyTeamFile(file, { firstJoin: false });

    expect(secureJson(SECURE_NOTION_CONFIG_KEY)).toMatchObject({
      knowledgeDbUrl: "https://www.notion.so/acme/K-11112222333344445555666677778888",
      teamTimes: { friday: "15:30" },
    });
  });

  it("upserts a custom provider by id, marked isCustom, keeping the others", async () => {
    const other = { id: "other", curl: "curl https://other", responseContentPath: "x", isCustom: true };
    h.fake.local.set(
      STORAGE_KEYS.CUSTOM_AI_PROVIDERS,
      JSON.stringify([other, { id: "acme", curl: "curl https://old", responseContentPath: "old", isCustom: true }])
    );
    const custom = { id: "acme", curl: "curl https://acme {{API_KEY}}", responseContentPath: "choices[0].text" };
    const file = teamFile();
    file.ai = { provider: "acme", variables: { api_key: "k" }, custom };
    file.stt = { ...file.stt, custom: { id: "groq-whisper", curl: "curl https://s", responseContentPath: "text" } };

    await applyTeamFile(file, { firstJoin: false });

    expect(localJson(STORAGE_KEYS.CUSTOM_AI_PROVIDERS)).toEqual([other, { ...custom, isCustom: true }]);
    expect(localJson(STORAGE_KEYS.CUSTOM_SPEECH_PROVIDERS)).toEqual([
      { id: "groq-whisper", curl: "curl https://s", responseContentPath: "text", isCustom: true },
    ]);
  });

  it("first join: a write failing mid-apply restores storage byte-identically", async () => {
    seedPriorState();
    const before = h.fake.snapshot();
    let aiFailures = 0;
    h.fake.failWhen((op, key) => op === "secureSet" && key === AI_CONFIGS_KEY && aiFailures++ === 0);

    const result = await applyTeamFile(teamFile(), { firstJoin: true, link: LINK });

    expect(result).toEqual({ ok: false, code: "TEAM_WRITE_FAILED", landed: false, googleClientChanged: false });
    // The token step ran (team token), then was undone (old token back).
    const tokenSets = h.fake.invoke.mock.calls.filter((c) => c[0] === "notion_token_set").map((c) => c[1]);
    expect(tokenSets).toEqual([{ token: "ntn_team" }, { token: "ntn_old" }]);
    expect(h.fake.snapshot()).toBe(before);
    // The failed AI write is undone with the prior raw bytes; later steps never ran.
    expect(secureSetKeys()).toEqual([AI_CONFIGS_KEY, AI_CONFIGS_KEY]);
    expect(h.fake.secureModule.secureSet.mock.calls[1][1]).toBe(PRIOR_AI_RAW);
  });

  it("first join: a failing link write rolls back every setting and stores no link", async () => {
    seedPriorState();
    const before = h.fake.snapshot();
    h.fake.failWhen((op, key) => op === "secureSet" && key === TEAM_LINK_SECURE_KEY);

    const result = await applyTeamFile(teamFile(), { firstJoin: true, link: LINK });

    expect(result).toEqual({ ok: false, code: "TEAM_WRITE_FAILED", landed: false, googleClientChanged: false });
    // Every setting was written first, so this proves restoration, not inaction.
    expect(secureSetKeys().slice(0, 5)).toEqual([
      AI_CONFIGS_KEY,
      STT_CONFIGS_KEY,
      SECURE_GOOGLE_CONFIG_KEY,
      SECURE_NOTION_CONFIG_KEY,
      TEAM_LINK_SECURE_KEY,
    ]);
    expect(h.fake.snapshot()).toBe(before);
    expect(h.fake.secure.has(TEAM_LINK_SECURE_KEY)).toBe(false);
    // The old Google client is back, so its sign-in stays.
    expect(disconnects()).toBe(0);
    // Undo order: the failed link write first, then every completed step in reverse.
    const runs = [
      "token",
      `secure:${AI_CONFIGS_KEY}`,
      `secure:${STT_CONFIGS_KEY}`,
      `secure:${SECURE_GOOGLE_CONFIG_KEY}`,
      `local:${STORAGE_KEYS.SELECTED_AI_PROVIDER}`,
      `local:${STORAGE_KEYS.SELECTED_STT_PROVIDER}`,
      `secure:${SECURE_NOTION_CONFIG_KEY}`,
      `secure:${TEAM_LINK_SECURE_KEY}`,
    ];
    expect(writeLog()).toEqual([...runs, ...[...runs].reverse()]);
  });

  it("first join: a link write that lands then rejects is undone too", async () => {
    seedPriorState();
    const before = h.fake.snapshot();
    writeThenRejectOnce(TEAM_LINK_SECURE_KEY);

    const result = await applyTeamFile(teamFile(), { firstJoin: true, link: LINK });

    expect(result).toEqual({ ok: false, code: "TEAM_WRITE_FAILED", landed: false, googleClientChanged: false });
    expect(h.fake.snapshot()).toBe(before);
    expect(h.fake.secure.has(TEAM_LINK_SECURE_KEY)).toBe(false);
  });

  it("first join: an AI blob write that lands then rejects is undone too", async () => {
    seedPriorState();
    const before = h.fake.snapshot();
    writeThenRejectOnce(AI_CONFIGS_KEY);

    const result = await applyTeamFile(teamFile(), { firstJoin: true, link: LINK });

    expect(result).toEqual({ ok: false, code: "TEAM_WRITE_FAILED", landed: false, googleClientChanged: false });
    expect(h.fake.snapshot()).toBe(before);
    expect(h.fake.secure.get(AI_CONFIGS_KEY)).toBe(PRIOR_AI_RAW);
  });

  it("first join with no prior token: a rollback clears the team token", async () => {
    h.fake.failWhen((op, key) => op === "secureSet" && key === TEAM_LINK_SECURE_KEY);

    const result = await applyTeamFile(teamFile(), { firstJoin: true, link: LINK });

    expect(result).toMatchObject({ ok: false, landed: false });
    expect(h.fake.invoke.mock.calls.map((c) => c[0])).toContain("notion_token_clear");
    expect(h.fake.keychain.token).toBeNull();
  });

  it("first join: a failing localStorage write rolls back too", async () => {
    seedPriorState();
    const before = h.fake.snapshot();
    h.fake.failWhen((op, key) => op === "localSet" && key === STORAGE_KEYS.SELECTED_STT_PROVIDER);

    const result = await applyTeamFile(teamFile(), { firstJoin: true, link: LINK });

    expect(result).toEqual({ ok: false, code: "TEAM_WRITE_FAILED", landed: false, googleClientChanged: false });
    expect(h.fake.snapshot()).toBe(before);
    expect(secureSetKeys()).not.toContain(SECURE_NOTION_CONFIG_KEY);
  });

  it("first join: an undo that fails reports landed", async () => {
    seedPriorState();
    // The STT blob did not exist before, so its undo is a delete; make that fail.
    h.fake.failWhen(
      (op, key) =>
        (op === "secureSet" && key === TEAM_LINK_SECURE_KEY) || (op === "secureDelete" && key === STT_CONFIGS_KEY)
    );

    const result = await applyTeamFile(teamFile(), { firstJoin: true, link: LINK });

    expect(result).toMatchObject({ ok: false, code: "TEAM_WRITE_FAILED", landed: true });
    expect(h.fake.secureModule.secureDelete.mock.calls.map((c) => c[0])).toContain(STT_CONFIGS_KEY);
    // The other undos still ran.
    expect(h.fake.keychain.token).toBe("ntn_old");
  });

  it("a failing snapshot read writes nothing", async () => {
    seedPriorState();
    const before = h.fake.snapshot();
    h.fake.failWhen((op) => op === "notion_token_get");

    const result = await applyTeamFile(teamFile(), { firstJoin: true, link: LINK });

    expect(result).toEqual({ ok: false, code: "TEAM_WRITE_FAILED", landed: false, googleClientChanged: false });
    expect(writeCounts()).toMatchObject({ secureSet: 0, secureDelete: 0, tokenSet: 0, tokenClear: 0 });
    expect(h.fake.snapshot()).toBe(before);
  });

  it("a failing localStorage snapshot read writes nothing", async () => {
    seedPriorState();
    const before = h.fake.snapshot();
    const read = vi.mocked(localStorage.getItem).getMockImplementation()!;
    vi.mocked(localStorage.getItem).mockImplementation((key: string) => {
      if (key === STORAGE_KEYS.SELECTED_AI_PROVIDER) throw new Error("fake read failure");
      return read(key);
    });

    const result = await applyTeamFile(teamFile(), { firstJoin: true, link: LINK });

    expect(result).toEqual({ ok: false, code: "TEAM_WRITE_FAILED", landed: false, googleClientChanged: false });
    expect(writeCounts()).toEqual({
      secureSet: 0,
      secureDelete: 0,
      localSet: 0,
      localRemove: 0,
      tokenSet: 0,
      tokenClear: 0,
    });
    expect(h.fake.snapshot()).toBe(before);
  });

  it("later sync: a failing write keeps earlier writes, attempts no later ones and reports landed", async () => {
    seedPriorState();
    h.fake.failWhen((op, key) => op === "secureSet" && key === SECURE_GOOGLE_CONFIG_KEY);

    const result = await applyTeamFile(teamFile(), { firstJoin: false });

    expect(result).toEqual({ ok: false, code: "TEAM_WRITE_FAILED", landed: true, googleClientChanged: false });
    expect(h.fake.keychain.token).toBe("ntn_team");
    expect(secureJson(AI_CONFIGS_KEY)).toMatchObject({ openai: { api_key: "sk-team" } });
    expect(secureJson(STT_CONFIGS_KEY)).toEqual({ "groq-whisper": { api_key: "stt-team" } });
    expect(h.fake.secure.get(SECURE_GOOGLE_CONFIG_KEY)).toBe(PRIOR_GOOGLE_RAW);
    expect(localJson(STORAGE_KEYS.SELECTED_AI_PROVIDER)).toEqual({ provider: "groq", variables: { api_key: "g" } });
    expect(h.fake.local.has(STORAGE_KEYS.SELECTED_STT_PROVIDER)).toBe(false);
    expect(h.fake.secure.get(SECURE_NOTION_CONFIG_KEY)).toBe(PRIOR_NOTION_RAW);
    expect(vi.mocked(localStorage.setItem)).not.toHaveBeenCalled();
    expect(disconnects()).toBe(0);
  });

  it("later sync: a failure after the Google step still clears the old sign-in", async () => {
    seedPriorState();
    h.fake.failWhen((op, key) => op === "secureSet" && key === SECURE_NOTION_CONFIG_KEY);

    const result = await applyTeamFile(teamFile(), { firstJoin: false });

    expect(result).toEqual({ ok: false, code: "TEAM_WRITE_FAILED", landed: true, googleClientChanged: true });
    expect(secureJson(SECURE_GOOGLE_CONFIG_KEY)).toEqual({
      clientId: "team-client.apps.googleusercontent.com",
      clientSecret: "g-secret",
    });
    expect(disconnects()).toBe(1);
  });

  it("later sync: a Notion blob write that lands then rejects is put back; earlier steps stay", async () => {
    seedPriorState();
    writeThenRejectOnce(SECURE_NOTION_CONFIG_KEY);

    const result = await applyTeamFile(teamFile(), { firstJoin: false });

    expect(result).toEqual({ ok: false, code: "TEAM_WRITE_FAILED", landed: true, googleClientChanged: true });
    expect(h.fake.secure.get(SECURE_NOTION_CONFIG_KEY)).toBe(PRIOR_NOTION_RAW);
    expect(h.fake.keychain.token).toBe("ntn_team");
    expect(secureJson(AI_CONFIGS_KEY)).toMatchObject({ openai: { api_key: "sk-team" } });
    expect(secureJson(STT_CONFIGS_KEY)).toEqual({ "groq-whisper": { api_key: "stt-team" } });
    expect(secureJson(SECURE_GOOGLE_CONFIG_KEY)).toMatchObject({ clientId: "team-client.apps.googleusercontent.com" });
    expect(localJson(STORAGE_KEYS.SELECTED_AI_PROVIDER)).toMatchObject({ provider: "openai" });
    expect(localJson(STORAGE_KEYS.SELECTED_STT_PROVIDER)).toMatchObject({ provider: "groq-whisper" });
  });

  it("later sync: a failed AI write still resets the provider cache", async () => {
    expect(await loadSecureAIConfigs()).toEqual({}); // this window caches {}
    h.fake.secure.set(AI_CONFIGS_KEY, JSON.stringify({ groq: { api_key: "g" } }));
    h.fake.failWhen((op, key) => op === "secureSet" && key === AI_CONFIGS_KEY);

    const result = await applyTeamFile(teamFile(), { firstJoin: false });

    expect(result.ok).toBe(false);
    expect(await loadSecureAIConfigs()).toEqual({ groq: { api_key: "g" } });
  });

  it("later sync: a first-step write whose undo also fails reports landed", async () => {
    seedPriorState();
    h.fake.keychain.token = "ntn_team"; // unchanged: the AI blob is the first step
    h.fake.failWhen((op, key) => op === "secureSet" && key === AI_CONFIGS_KEY);

    const result = await applyTeamFile(teamFile(), { firstJoin: false });

    // Nothing completed, but the half-write could not be put back.
    expect(result).toEqual({ ok: false, code: "TEAM_WRITE_FAILED", landed: true, googleClientChanged: false });
    expect(secureSetKeys()).toEqual([AI_CONFIGS_KEY, AI_CONFIGS_KEY]);
  });

  it("first join: the provider cache is reset after the AI undo too", async () => {
    seedPriorState();
    // A reader in this window loads the cache mid-apply, while the team blob is stored.
    const write = h.fake.secureModule.secureSet.getMockImplementation()!;
    h.fake.secureModule.secureSet.mockImplementation(async (k: string, v: string) => {
      if (k !== TEAM_LINK_SECURE_KEY) return write(k, v);
      await loadSecureAIConfigs();
      throw new Error("fake link failure");
    });

    await applyTeamFile(teamFile(), { firstJoin: true, link: LINK });

    expect(await loadSecureAIConfigs()).toEqual(JSON.parse(PRIOR_AI_RAW));
  });

  it("later sync: a failure on the first step reports nothing landed", async () => {
    seedPriorState();
    const before = h.fake.snapshot();
    h.fake.failWhen((op) => op === "notion_token_set");

    const result = await applyTeamFile(teamFile(), { firstJoin: false });

    expect(result).toEqual({ ok: false, code: "TEAM_WRITE_FAILED", landed: false, googleClientChanged: false });
    expect(h.fake.snapshot()).toBe(before);
  });

  it("writes the raw provider blob, not the stale in-memory cache", async () => {
    expect(await loadSecureAIConfigs()).toEqual({}); // this window caches {}
    // The dashboard saved a groq key behind this window's cache.
    h.fake.secure.set(AI_CONFIGS_KEY, JSON.stringify({ groq: { api_key: "g" } }));

    await applyTeamFile(teamFile(), { firstJoin: false });

    const stored = { groq: { api_key: "g" }, openai: { api_key: "sk-team", model: "gpt-team" } };
    expect(secureJson(AI_CONFIGS_KEY)).toEqual(stored);
    // The cache was reset: the next reader sees the raw blob, not {}.
    expect(await loadSecureAIConfigs()).toEqual(stored);
  });

  it("merges on top of the active selection's variables", async () => {
    h.fake.local.set(
      STORAGE_KEYS.SELECTED_AI_PROVIDER,
      JSON.stringify({ provider: "openai", variables: { model: "local-m" } })
    );
    // STT: the selection is another provider, so the blob is the base.
    h.fake.local.set(
      STORAGE_KEYS.SELECTED_STT_PROVIDER,
      JSON.stringify({ provider: "deepgram", variables: { api_key: "dg" } })
    );
    h.fake.secure.set(AI_CONFIGS_KEY, JSON.stringify({ openai: { model: "old" } }));
    h.fake.secure.set(STT_CONFIGS_KEY, JSON.stringify({ "groq-whisper": { language: "en" }, deepgram: { api_key: "dg" } }));
    const file = teamFile();
    file.ai.variables = { api_key: "sk-team" };

    await applyTeamFile(file, { firstJoin: false });

    const ai = { model: "local-m", api_key: "sk-team" };
    expect(localJson(STORAGE_KEYS.SELECTED_AI_PROVIDER)).toEqual({ provider: "openai", variables: ai });
    expect(secureJson(AI_CONFIGS_KEY)).toEqual({ openai: ai });
    const stt = { language: "en", api_key: "stt-team" };
    expect(localJson(STORAGE_KEYS.SELECTED_STT_PROVIDER)).toEqual({ provider: "groq-whisper", variables: stt });
    expect(secureJson(STT_CONFIGS_KEY)).toEqual({ "groq-whisper": stt, deepgram: { api_key: "dg" } });
  });

  it("replaces an unreadable notion blob with team fields and a blank yourName", async () => {
    h.fake.secure.set(SECURE_NOTION_CONFIG_KEY, "{not json");

    const result = await applyTeamFile(teamFile(), { firstJoin: false });

    expect(result.ok).toBe(true);
    expect(secureJson(SECURE_NOTION_CONFIG_KEY)).toEqual({
      meetingsDbUrl: MEETINGS_URL,
      knowledgeDbUrl: "",
      teamTimes: {},
      yourName: "",
    });
  });

  it("a changed Google client id clears the sign-in; the same id does not", async () => {
    h.fake.secure.set(SECURE_GOOGLE_CONFIG_KEY, JSON.stringify({ clientId: "old-client", clientSecret: "old-s" }));

    const changed = await applyTeamFile(teamFile(), { firstJoin: false });

    expect(changed).toEqual({ ok: true, value: { changed: true, googleClientChanged: true } });
    expect(disconnects()).toBe(1);

    // Same client id (padded in the file), rotated secret: the Google step
    // runs, the sign-in stays.
    const file = teamFile();
    file.google = { clientId: " team-client.apps.googleusercontent.com ", clientSecret: "rotated" };
    const same = await applyTeamFile(file, { firstJoin: false });

    expect(same).toEqual({ ok: true, value: { changed: true, googleClientChanged: false } });
    expect(secureJson(SECURE_GOOGLE_CONFIG_KEY)).toMatchObject({ clientSecret: "rotated" });
    expect(disconnects()).toBe(1);
  });

  it("never stamps NOTION_SETUP_AT", async () => {
    // A complete Notion setup: loadNotionConfigState would stamp it here.
    h.fake.keychain.token = "ntn_team";
    h.fake.secure.set(SECURE_NOTION_CONFIG_KEY, notionBlob({ meetingsDbUrl: MEETINGS_URL }));

    const result = await applyTeamFile(teamFile(), { firstJoin: true, link: LINK });

    expect(result).toEqual({ ok: true, value: { changed: true, googleClientChanged: false } });
    expect(h.fake.local.has(STORAGE_KEYS.NOTION_SETUP_AT)).toBe(false);
  });
});
