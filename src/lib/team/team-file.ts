import curl2Json from "@bany/curl-to-json";
import { STORAGE_KEYS } from "@/config";
import { AI_PROVIDERS } from "@/config/ai-providers.constants";
import { SPEECH_TO_TEXT_PROVIDERS } from "@/config/stt.constants";
import { loadNotionToken } from "@/lib/notion/token";
import { parseSavedAiSelection } from "@/lib/storage/ai-providers";
import { loadGoogleConfigState } from "@/lib/storage/google-config.storage";
import { safeLocalStorage } from "@/lib/storage/helper";
import {
  loadNotionConfig,
  parseNotionDatabaseId,
  type Weekday,
} from "@/lib/storage/notion-config.storage";
import type { TYPE_PROVIDER } from "@/types";

export const TEAM_FILE_VERSION = 1;

export interface TeamProviderSettings {
  provider: string;
  variables: Record<string, string>;
  custom?: TYPE_PROVIDER;
}

export interface TeamFileV1 {
  version: 1;
  ai: TeamProviderSettings;
  stt: TeamProviderSettings;
  notion: {
    token: string;
    meetingsDbUrl: string;
    knowledgeDbUrl?: string;
    teamTimes?: Partial<Record<Weekday, string>>;
  };
  google: { clientId: string; clientSecret: string };
}

export type TeamErrorCode =
  | "TEAM_LINK_INVALID"
  | "TEAM_FETCH_FAILED"
  | "TEAM_DECRYPT_FAILED"
  | "TEAM_FILE_INVALID"
  | "TEAM_FILE_TOO_NEW"
  | "TEAM_FIELD_MISSING"
  | "TEAM_WRITE_FAILED"
  | "TEAM_KEY_INLINE";

export const TEAM_COPY: Record<TeamErrorCode, string> = {
  TEAM_LINK_INVALID:
    "That isn't a Meetwings team link. Ask the person who shared it for a new one.",
  TEAM_FETCH_FAILED:
    "Couldn't reach the team settings. Check your connection and try the link again.",
  TEAM_DECRYPT_FAILED:
    "This link's key doesn't match the team settings. Ask for the current link.",
  TEAM_FILE_INVALID:
    "The team settings are damaged or incomplete. The owner needs to copy them again.",
  TEAM_FILE_TOO_NEW:
    "These team settings need a newer Meetwings. Update the app and try again.",
  TEAM_FIELD_MISSING:
    "The team settings are missing a required key or link (AI, speech, Notion or Google).",
  TEAM_WRITE_FAILED:
    "Couldn't save the team settings on this computer. Please try again.",
  TEAM_KEY_INLINE:
    "A custom provider has its API key typed into the curl command. Replace it with {{API_KEY}} first.",
};

export type TeamResult<T> = { ok: true; value: T } | { ok: false; code: TeamErrorCode };

const WEEKDAYS: readonly string[] = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
];

const fail = (code: TeamErrorCode): { ok: false; code: TeamErrorCode } => ({ ok: false, code });

// Thrown inside the parse helpers for a wrong type; caught once in parseTeamFile.
class WrongType extends Error {}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** A string, or "" when absent (so validate reports it as missing). Any other type is wrong. */
function str(v: unknown): string {
  if (v === undefined) return "";
  if (typeof v !== "string") throw new WrongType();
  return v;
}

function reqStr(v: unknown): string {
  if (typeof v !== "string") throw new WrongType();
  return v;
}

function obj(v: unknown): Record<string, unknown> {
  if (v === undefined) return {};
  if (!isObj(v)) throw new WrongType();
  return v;
}

function variables(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(obj(v))) {
    if (typeof val !== "string") throw new WrongType();
    out[k] = val;
  }
  return out;
}

/** Copies only the known provider fields; anything else is dropped. */
function pickCustom(v: unknown): TYPE_PROVIDER {
  const c = obj(v);
  const out: TYPE_PROVIDER = {
    id: str(c.id),
    curl: str(c.curl),
    // Required: absent is wrong, not "" (blank is rejected in providerKnown).
    responseContentPath: reqStr(c.responseContentPath),
  };
  if (c.name !== undefined) out.name = reqStr(c.name);
  if (c.streaming !== undefined) {
    if (typeof c.streaming !== "boolean") throw new WrongType();
    out.streaming = c.streaming;
  }
  if (c.isCustom !== undefined) {
    if (typeof c.isCustom !== "boolean") throw new WrongType();
    out.isCustom = c.isCustom;
  }
  return out;
}

function providerSettings(v: unknown): TeamProviderSettings {
  const o = obj(v);
  const out: TeamProviderSettings = { provider: str(o.provider), variables: variables(o.variables) };
  if (o.custom !== undefined) out.custom = pickCustom(o.custom);
  return out;
}

export function parseTeamFile(json: string): TeamResult<TeamFileV1> {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return fail("TEAM_FILE_INVALID");
  }
  if (!isObj(raw)) return fail("TEAM_FILE_INVALID");
  if (typeof raw.version !== "number") return fail("TEAM_FILE_INVALID");
  if (raw.version > TEAM_FILE_VERSION) return fail("TEAM_FILE_TOO_NEW");
  if (raw.version !== TEAM_FILE_VERSION) return fail("TEAM_FILE_INVALID");

  let file: TeamFileV1;
  try {
    const n = obj(raw.notion);
    const g = obj(raw.google);
    const notion: TeamFileV1["notion"] = { token: str(n.token), meetingsDbUrl: str(n.meetingsDbUrl) };
    if (n.knowledgeDbUrl !== undefined) notion.knowledgeDbUrl = str(n.knowledgeDbUrl);
    if (n.teamTimes !== undefined) {
      const times: Partial<Record<Weekday, string>> = {};
      for (const [day, t] of Object.entries(obj(n.teamTimes))) {
        if (!WEEKDAYS.includes(day) || typeof t !== "string") throw new WrongType();
        times[day as Weekday] = t;
      }
      notion.teamTimes = times;
    }
    file = {
      version: 1,
      ai: providerSettings(raw.ai),
      stt: providerSettings(raw.stt),
      notion,
      google: { clientId: str(g.clientId), clientSecret: str(g.clientSecret) },
    };
  } catch (e) {
    if (e instanceof WrongType) return fail("TEAM_FILE_INVALID");
    throw e;
  }

  const code = validateTeamFile(file);
  return code ? fail(code) : { ok: true, value: file };
}

function providerKnown(s: TeamProviderSettings, builtIn: TYPE_PROVIDER[]): boolean {
  // A built-in id carries no custom definition: nothing unchecked may ride along.
  if (builtIn.some((p) => p.id === s.provider)) return s.custom === undefined;
  const c = s.custom;
  if (!c || c.id !== s.provider) return false;
  if (
    (c.name !== undefined && typeof c.name !== "string") ||
    typeof c.curl !== "string" ||
    typeof c.responseContentPath !== "string" ||
    c.responseContentPath.trim() === "" ||
    (c.streaming !== undefined && typeof c.streaming !== "boolean")
  ) {
    return false;
  }
  try {
    curl2Json(c.curl);
    return true;
  } catch {
    return false;
  }
}

export function validateTeamFile(file: TeamFileV1): TeamErrorCode | null {
  const required = [
    file.ai.provider,
    file.ai.variables.api_key,
    file.stt.provider,
    file.stt.variables.api_key,
    file.notion.token,
    file.notion.meetingsDbUrl,
    file.google.clientId,
    file.google.clientSecret,
  ];
  if (required.some((v) => typeof v !== "string" || v.trim() === "")) return "TEAM_FIELD_MISSING";
  if (parseNotionDatabaseId(file.notion.meetingsDbUrl) === null) return "TEAM_FILE_INVALID";
  if (!providerKnown(file.ai, AI_PROVIDERS) || !providerKnown(file.stt, SPEECH_TO_TEXT_PROVIDERS)) {
    return "TEAM_FILE_INVALID";
  }
  return null;
}

function readCustomList(key: string): TYPE_PROVIDER[] {
  try {
    const parsed = JSON.parse(safeLocalStorage.getItem(key) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((p) => isObj(p) && typeof p.id === "string") : [];
  } catch {
    return [];
  }
}

function exportProvider(
  selectedKey: string,
  customKey: string,
  builtIn: TYPE_PROVIDER[]
): TeamProviderSettings {
  const customs = readCustomList(customKey);
  const sel = parseSavedAiSelection(safeLocalStorage.getItem(selectedKey) ?? "", [
    ...builtIn,
    ...customs,
  ]);
  if (!sel) return { provider: "", variables: {} };
  const out: TeamProviderSettings = { provider: sel.provider, variables: variables(sel.variables) };
  const custom = customs.find((p) => p.id === sel.provider);
  if (custom) out.custom = pickCustom(custom);
  return out;
}

async function orEmpty<T, E>(read: () => Promise<T>, empty: E): Promise<NonNullable<T> | E> {
  try {
    return (await read()) ?? empty;
  } catch {
    return empty;
  }
}

export async function exportTeamSettings(): Promise<TeamResult<TeamFileV1>> {
  try {
    const ai = exportProvider(STORAGE_KEYS.SELECTED_AI_PROVIDER, STORAGE_KEYS.CUSTOM_AI_PROVIDERS, AI_PROVIDERS);
    const stt = exportProvider(
      STORAGE_KEYS.SELECTED_STT_PROVIDER,
      STORAGE_KEYS.CUSTOM_SPEECH_PROVIDERS,
      SPEECH_TO_TEXT_PROVIDERS
    );
    const token = await orEmpty(loadNotionToken, "");
    const cfg = await orEmpty(loadNotionConfig, null);
    const google = await orEmpty(loadGoogleConfigState, null);

    const notion: TeamFileV1["notion"] = { token, meetingsDbUrl: cfg?.meetingsDbUrl ?? "" };
    if (cfg?.knowledgeDbUrl?.trim()) notion.knowledgeDbUrl = cfg.knowledgeDbUrl;
    if (cfg?.teamTimes) notion.teamTimes = cfg.teamTimes;

    const file: TeamFileV1 = {
      version: 1,
      ai,
      stt,
      notion,
      google:
        google?.state === "complete"
          ? { clientId: google.config.clientId, clientSecret: google.config.clientSecret }
          : { clientId: "", clientSecret: "" },
    };

    for (const s of [ai, stt]) {
      if (!s.custom) continue;
      const key = s.variables.api_key;
      if (!s.custom.curl.includes("{{API_KEY}}") || (key && s.custom.curl.includes(key))) {
        return fail("TEAM_KEY_INLINE");
      }
    }

    // Exactly what a member's parser accepts (it validates last).
    return parseTeamFile(JSON.stringify(file));
  } catch {
    return fail("TEAM_FILE_INVALID");
  }
}
