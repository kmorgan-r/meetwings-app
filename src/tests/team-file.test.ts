import { beforeEach, describe, expect, it, vi } from "vitest";
import { installMemoryLocalStorage } from "./memory-local-storage";
import { STORAGE_KEYS } from "@/config";

const h = vi.hoisted(() => ({
  token: vi.fn(),
  notion: vi.fn(),
  google: vi.fn(),
}));
vi.mock("@/lib/notion/token", () => ({ loadNotionToken: h.token }));
vi.mock("@/lib/storage/notion-config.storage", async () => ({
  ...(await vi.importActual<object>("@/lib/storage/notion-config.storage")),
  loadNotionConfig: h.notion,
}));
vi.mock("@/lib/storage/google-config.storage", () => ({
  loadGoogleConfigState: h.google,
}));

import {
  exportTeamSettings,
  parseTeamFile,
  TEAM_COPY,
  type TeamResult,
} from "@/lib/team/team-file";

const NOTION_URL = "https://www.notion.so/ws/0123456789abcdef0123456789abcdef?v=1";
let store: Map<string, string>;

function ownerSeed() {
  store.set(
    STORAGE_KEYS.SELECTED_AI_PROVIDER,
    JSON.stringify({ provider: "openai", variables: { api_key: "sk-owner", model: "gpt-x" } })
  );
  store.set(
    STORAGE_KEYS.SELECTED_STT_PROVIDER,
    JSON.stringify({ provider: "groq", variables: { api_key: "gsk-owner" } })
  );
  h.token.mockResolvedValue("ntn_owner");
  h.notion.mockResolvedValue({
    meetingsDbUrl: NOTION_URL,
    knowledgeDbUrl: "",
    teamTimes: { monday: "09:00" },
    yourName: "Owner",
  });
  h.google.mockResolvedValue({
    state: "complete",
    config: { clientId: "cid", clientSecret: "csecret" },
  });
}

const CUSTOM = {
  id: "custom-1",
  name: "Mine",
  curl: "curl https://x.test/v1 -H 'Authorization: Bearer {{API_KEY}}' -d '{}'",
  responseContentPath: "a.b",
  streaming: false,
  isCustom: true,
};
function seedCustom(curl = CUSTOM.curl) {
  const p = { ...CUSTOM, curl };
  store.set(STORAGE_KEYS.CUSTOM_AI_PROVIDERS, JSON.stringify([p]));
  store.set(
    STORAGE_KEYS.SELECTED_AI_PROVIDER,
    JSON.stringify({ provider: "custom-1", variables: { api_key: "sk-owner" } })
  );
  return p;
}

// Tests write deliberately wrong values into these, so they are not TeamFile.
interface Fixture {
  [key: string]: unknown;
  ai: Record<string, unknown> & { variables: Record<string, unknown> };
  notion: Record<string, unknown>;
  google: Record<string, unknown>;
}

function valid(): Fixture {
  return {
    version: 2,
    ai: { provider: "openai", variables: { api_key: "k" } },
    notion: { token: "t", meetingsDbUrl: NOTION_URL },
    google: { clientId: "c", clientSecret: "s" },
  };
}
const parse = (o: unknown) => parseTeamFile(JSON.stringify(o));
const code = (r: TeamResult<unknown>) => (r.ok ? null : r.code);
function okValue<T>(r: TeamResult<T>): T {
  if (!r.ok) throw new Error(`expected ok, got ${r.code}`);
  return r.value;
}

beforeEach(() => {
  store = installMemoryLocalStorage();
  vi.clearAllMocks();
});

describe("exportTeamSettings", () => {
  it("exports owner settings that parse back identically and carry no yourName", async () => {
    ownerSeed();
    const r = await exportTeamSettings();
    const v = okValue(r);
    const back = parseTeamFile(JSON.stringify(v));
    expect(back).toEqual(r);
    expect(JSON.stringify(r)).not.toContain("Owner");
    expect(v.notion.knowledgeDbUrl).toBeUndefined();
    expect(v.ai.variables).toEqual({ api_key: "sk-owner", model: "gpt-x" });
    expect(v.notion.teamTimes).toEqual({ monday: "09:00" });
  });

  it("export is version 2 and carries no speech settings", async () => {
    ownerSeed();
    const v = okValue(await exportTeamSettings());
    expect(v.version).toBe(2);
    expect(v).not.toHaveProperty("stt");
    expect(JSON.stringify(v)).not.toContain("gsk-owner");
  });

  it("export ignores the owner's speech settings: none, or a custom one with an inline key", async () => {
    ownerSeed();
    store.delete(STORAGE_KEYS.SELECTED_STT_PROVIDER);
    expect((await exportTeamSettings()).ok).toBe(true);
    const p = { ...CUSTOM, id: "custom-stt", curl: "curl https://x.test -H 'k: gsk-owner'" };
    store.set(STORAGE_KEYS.CUSTOM_SPEECH_PROVIDERS, JSON.stringify([p]));
    store.set(
      STORAGE_KEYS.SELECTED_STT_PROVIDER,
      JSON.stringify({ provider: "custom-stt", variables: { api_key: "gsk-owner" } })
    );
    expect((await exportTeamSettings()).ok).toBe(true);
  });

  it.each(["ai key", "notion token", "google config"])(
    "export refuses when %s is empty -> TEAM_FIELD_MISSING",
    async (what) => {
      ownerSeed();
      if (what === "ai key")
        store.set(
          STORAGE_KEYS.SELECTED_AI_PROVIDER,
          JSON.stringify({ provider: "openai", variables: { api_key: "" } })
        );
      if (what === "notion token") h.token.mockRejectedValue(new Error("keychain"));
      if (what === "google config")
        h.google.mockResolvedValue({ state: "absent", config: null });
      expect(code(await exportTeamSettings())).toBe("TEAM_FIELD_MISSING");
    }
  );

  it("export refuses a custom provider whose curl has the key inline", async () => {
    ownerSeed();
    seedCustom("curl https://x.test -H 'Authorization: Bearer sk-abc'");
    expect(code(await exportTeamSettings())).toBe("TEAM_KEY_INLINE");
  });

  it("export refuses a custom provider whose curl contains the key value", async () => {
    ownerSeed();
    seedCustom("curl https://x.test/{{API_KEY}}?k=sk-owner");
    expect(code(await exportTeamSettings())).toBe("TEAM_KEY_INLINE");
  });

  it("export includes the custom definition for a selected custom provider", async () => {
    ownerSeed();
    const p = seedCustom();
    const r = await exportTeamSettings();
    const v = okValue(r);
    expect(v.ai.custom).toEqual(p);
    expect(parseTeamFile(JSON.stringify(v))).toEqual(r);
  });
});

describe("parseTeamFile", () => {
  it("parse: invalid JSON -> TEAM_FILE_INVALID", () => {
    expect(code(parseTeamFile("{nope"))).toBe("TEAM_FILE_INVALID");
    expect(code(parseTeamFile("[]"))).toBe("TEAM_FILE_INVALID");
    expect(code(parseTeamFile("null"))).toBe("TEAM_FILE_INVALID");
  });

  it("parse: version 3 -> TEAM_FILE_TOO_NEW; version 1 or '2' -> TEAM_FILE_INVALID", () => {
    expect(code(parse({ ...valid(), version: 3 }))).toBe("TEAM_FILE_TOO_NEW");
    expect(code(parse({ ...valid(), version: 1 }))).toBe("TEAM_FILE_INVALID");
    expect(code(parse({ ...valid(), version: "2" }))).toBe("TEAM_FILE_INVALID");
    expect(code(parse({ ...valid(), version: 0 }))).toBe("TEAM_FILE_INVALID");
  });

  it("parse: a speech section in the file is dropped, key and all", () => {
    const f = valid();
    f.stt = { provider: "groq", variables: { api_key: "gsk-leak" } };
    const r = parse(f);
    expect(r.ok).toBe(true);
    expect(JSON.stringify(r)).not.toContain("gsk-leak");
  });

  it("parse: whitespace-only notion token -> TEAM_FIELD_MISSING", () => {
    const f = valid();
    f.notion.token = "   ";
    expect(code(parse(f))).toBe("TEAM_FIELD_MISSING");
  });

  it("parse: wrong types -> TEAM_FILE_INVALID", () => {
    const f = valid();
    f.ai.variables.api_key = 5;
    expect(code(parse(f))).toBe("TEAM_FILE_INVALID");
    const g = valid();
    g.notion.teamTimes = { funday: "09:00" };
    expect(code(parse(g))).toBe("TEAM_FILE_INVALID");
  });

  it("parse: unknown provider without custom -> TEAM_FILE_INVALID", () => {
    const f = valid();
    f.ai.provider = "nope";
    expect(code(parse(f))).toBe("TEAM_FILE_INVALID");
  });

  it("parse: custom id that does not match provider -> TEAM_FILE_INVALID", () => {
    const f = valid();
    f.ai = { provider: "custom-2", variables: { api_key: "k" }, custom: CUSTOM };
    expect(code(parse(f))).toBe("TEAM_FILE_INVALID");
  });

  it("parse: meetings link that is not a Notion database -> TEAM_FILE_INVALID", () => {
    const f = valid();
    f.notion.meetingsDbUrl = "https://example.com/hello";
    expect(code(parse(f))).toBe("TEAM_FILE_INVALID");
  });

  it("parse: unknown extra fields are ignored", () => {
    const f = valid();
    f.extra = 1;
    f.notion.yourName = "Owner";
    f.ai = { provider: "custom-1", variables: { api_key: "k" }, custom: { ...CUSTOM, extra: 3 }, extra: 2 };
    const r = parse(f);
    expect(r.ok).toBe(true);
    expect(JSON.stringify(r)).not.toContain("extra");
    expect(JSON.stringify(r)).not.toContain("Owner");
  });

  it("parse: built-in id carrying custom -> TEAM_FILE_INVALID", () => {
    const evil = { id: "x", curl: "curl https://evil.test" };
    // Also a well-formed custom: only the built-in-id rule can reject that one.
    for (const c of [evil, { ...CUSTOM, id: "openai" }]) {
      const a = valid();
      a.ai = { provider: "openai", variables: { api_key: "k" }, custom: c };
      expect(code(parse(a))).toBe("TEAM_FILE_INVALID");
    }
  });

  it("parse: custom responseContentPath absent or blank -> TEAM_FILE_INVALID", () => {
    const { responseContentPath, ...noPath } = CUSTOM;
    for (const c of [noPath, { ...CUSTOM, responseContentPath: "  " }]) {
      const f = valid();
      f.ai = { provider: "custom-1", variables: { api_key: "k" }, custom: c };
      expect(code(parse(f))).toBe("TEAM_FILE_INVALID");
    }
  });

  it("parse: custom name optional, but must be a string when present", () => {
    const { name, ...noName } = CUSTOM;
    const f = valid();
    f.ai = { provider: "custom-1", variables: { api_key: "k" }, custom: noName };
    expect(parse(f).ok).toBe(true);
    f.ai.custom = { ...CUSTOM, name: 5 };
    expect(code(parse(f))).toBe("TEAM_FILE_INVALID");
  });

  it("parse: null variable value -> TEAM_FILE_INVALID", () => {
    const f = valid();
    f.ai.variables = { api_key: "k", model: null };
    expect(code(parse(f))).toBe("TEAM_FILE_INVALID");
  });

  it("the missing-field copy no longer names speech", () => {
    expect(TEAM_COPY.TEAM_FIELD_MISSING).toBe(
      "The team settings are missing a required key or link (AI, Notion or Google)."
    );
  });

  it("has fixed copy for the fetch failure", () => {
    expect(TEAM_COPY.TEAM_FETCH_FAILED).toBe(
      "Couldn't reach the team settings. Check your connection and try the link again."
    );
  });
});
