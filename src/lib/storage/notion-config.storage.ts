import { STORAGE_KEYS } from "@/config/constants";
import { isNotionKeychainAvailable, loadNotionToken } from "@/lib/notion/token";
import { secureGet, secureSet } from "@/lib/secure-storage";
import { safeLocalStorage } from "./helper";

export const SECURE_NOTION_CONFIG_KEY = "secure_notion_config";

export type Weekday =
  | "monday"
  | "tuesday"
  | "wednesday"
  | "thursday"
  | "friday"
  | "saturday"
  | "sunday";

/**
 * Everything Notion needs besides the token. The blob deliberately holds NO
 * token: the token only ever lives in the OS keychain (see `saveNotionConfig`).
 */
export interface NotionConfig {
  meetingsDbUrl: string;
  /** "" means the practices step is skipped; the box is still written. */
  knowledgeDbUrl: string;
  /** "HH:MM" local time; a missing or "" entry means any time that day. */
  teamTimes: Partial<Record<Weekday, string>>;
  /** "" means use the Notion name, falling back to "You". */
  yourName: string;
}

type NotionConfigMissing = "token" | "meetingsDbUrl";

export type NotionConfigState =
  | { state: "absent" }
  | { state: "incomplete"; missing: NotionConfigMissing[] }
  | {
      state: "complete";
      config: NotionConfig;
      meetingsDbId: string;
      knowledgeDbId: string | null;
    };

/**
 * The database id is the LAST run of 32 lowercase hex characters (dashes
 * removed) in the URL path, ignoring the query string; a dashed
 * 8-4-4-4-12 UUID counts. The dashes are removed first, so the run can span
 * dash separators in either form. Lowercase hex only: an all-uppercase
 * fragment is not accepted.
 */
export function parseNotionDatabaseId(url: string): string | null {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return null;
  }
  const runs = path.replace(/-/g, "").match(/[0-9a-f]{32,}/g);
  if (!runs) return null;
  // `slice(-32)`: the id ends the run's tail, which keeps a hex-rich page
  // title that ran together with the id harmless. The query string was never
  // in here, so a view id cannot be picked up.
  return runs[runs.length - 1].slice(-32);
}

async function parseStoredBlob(): Promise<
  { config: NotionConfig; meetingsDbId: string } | null
> {
  let raw: string | null;
  try {
    raw = await secureGet(SECURE_NOTION_CONFIG_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;

  let parsed: Partial<NotionConfig>;
  try {
    parsed = JSON.parse(raw) as Partial<NotionConfig>;
  } catch {
    return null;
  }

  const meetingsDbUrl =
    typeof parsed.meetingsDbUrl === "string" ? parsed.meetingsDbUrl.trim() : "";
  const meetingsDbId = parseNotionDatabaseId(meetingsDbUrl);
  // A link with no database id counts as missing, not as a broken config.
  if (meetingsDbId === null) return null;

  const knowledgeDbUrl =
    typeof parsed.knowledgeDbUrl === "string" ? parsed.knowledgeDbUrl.trim() : "";
  const yourName = typeof parsed.yourName === "string" ? parsed.yourName.trim() : "";
  const teamTimes =
    parsed.teamTimes && typeof parsed.teamTimes === "object" ? parsed.teamTimes : {};

  return {
    config: { meetingsDbUrl, knowledgeDbUrl, teamTimes, yourName },
    meetingsDbId,
  };
}

/**
 * Token presence, in the order the feature relies on:
 * - an unavailable keychain (Linux) means the token counts as missing;
 * - a keychain read that THROWS means the token counts as PRESENT - a failing
 *   read is not proof of "no token", meetings keep being queued for Notion and
 *   the read is retried at send time, where the caller surfaces the failure;
 * - null or an empty string means missing; anything non-empty is present.
 */
async function isTokenPresent(): Promise<boolean> {
  if (!(await isNotionKeychainAvailable())) return false;
  try {
    const token = await loadNotionToken();
    return token !== null && token !== "";
  } catch {
    return true;
  }
}

export async function loadNotionConfigState(): Promise<NotionConfigState> {
  const tokenPresent = await isTokenPresent();
  const stored = await parseStoredBlob();

  // "absent" is neither piece present at all; either one alone is "incomplete".
  if (!tokenPresent && !stored) return { state: "absent" };
  // Only the token is on file (absent above ruled out the other case).
  if (!stored) return { state: "incomplete", missing: ["meetingsDbUrl"] };
  if (!tokenPresent) return { state: "incomplete", missing: ["token"] };

  return {
    state: "complete",
    config: stored.config,
    meetingsDbId: stored.meetingsDbId,
    knowledgeDbId: parseNotionDatabaseId(stored.config.knowledgeDbUrl),
  };
}

export async function loadNotionConfig(): Promise<NotionConfig | null> {
  const stored = await parseStoredBlob();
  return stored?.config ?? null;
}

export async function isNotionConfigured(): Promise<boolean> {
  return (await loadNotionConfigState()).state === "complete";
}

export async function saveNotionConfig(config: NotionConfig): Promise<void> {
  // The token NEVER enters this blob - it lives only in the OS keychain. Only
  // the fields a page build needs do, trimmed so the stored form is the
  // canonical one.
  await secureSet(
    SECURE_NOTION_CONFIG_KEY,
    JSON.stringify({
      meetingsDbUrl: config.meetingsDbUrl.trim(),
      knowledgeDbUrl: config.knowledgeDbUrl.trim(),
      teamTimes: config.teamTimes,
      yourName: config.yourName.trim(),
    })
  );
}

/** Default TRUE when the key is unset: sending to Notion is opt-out. */
export function isNotionAutoSendEnabled(): boolean {
  return safeLocalStorage.getItem(STORAGE_KEYS.NOTION_AUTO_SEND) !== "false";
}

export function setNotionAutoSendEnabled(on: boolean): void {
  safeLocalStorage.setItem(STORAGE_KEYS.NOTION_AUTO_SEND, String(on));
}
