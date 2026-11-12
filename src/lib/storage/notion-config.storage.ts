import { STORAGE_KEYS } from "@/config/constants";
import { isNotionKeychainAvailable, loadNotionToken } from "@/lib/notion/token";
import { secureGet, secureSet } from "@/lib/secure-storage";
import { safeLocalStorage } from "./helper";

export const SECURE_NOTION_CONFIG_KEY = "secure_notion_config";

/**
 * A Tauri event, NOT a window event: the settings card lives in the dashboard
 * window and the overlay is a separate JS context.
 */
export const NOTION_CONFIG_CHANGED_EVENT = "notion-config-changed";

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

const WEEKDAY_NAMES: readonly Weekday[] = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
];

/** Keeps only weekday keys with string values; everything else is dropped. */
function parseTeamTimes(value: unknown): Partial<Record<Weekday, string>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  const teamTimes: Partial<Record<Weekday, string>> = {};
  for (const day of WEEKDAY_NAMES) {
    if (typeof record[day] === "string") teamTimes[day] = record[day] as string;
  }
  return teamTimes;
}

/**
 * The database id is the LAST run of 32 hex characters (dashes removed) in
 * the URL path, ignoring the query string; a dashed 8-4-4-4-12 UUID counts.
 * The dashes are removed first, so the run can span dash separators in either
 * form. Matching is case-insensitive: an uppercase page URL yields the same
 * id as Notion's canonical lowercase form.
 */
export function parseNotionDatabaseId(url: string): string | null {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return null;
  }
  const runs = path.replace(/-/g, "").match(/[0-9a-f]{32,}/gi);
  if (!runs) return null;
  // `slice(-32)`: the id ends the run's tail, which keeps a hex-rich page
  // title that ran together with the id harmless. The query string was never
  // in here, so a view id cannot be picked up. Lowercase is the canonical
  // stored form, so an uppercase URL does not read as a different database.
  return runs[runs.length - 1].slice(-32).toLowerCase();
}

/**
 * Throws NOTION_CONFIG_UNREADABLE on a failed secure read or a blob that is
 * not a JSON object: a stored setup that cannot be read is a broken setup,
 * NOT "not set up" - only `!raw` means nothing is stored. The meetings link
 * is NOT validated here: a stored config always comes back, so the settings
 * card can prefill what the user saved; whether the link parses is decided in
 * loadNotionConfigState.
 */
async function parseStoredBlob(): Promise<NotionConfig | null> {
  let raw: string | null;
  try {
    raw = await secureGet(SECURE_NOTION_CONFIG_KEY);
  } catch {
    throw new Error("NOTION_CONFIG_UNREADABLE");
  }
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("NOTION_CONFIG_UNREADABLE");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("NOTION_CONFIG_UNREADABLE");
  }

  const blob = parsed as Partial<NotionConfig>;
  const meetingsDbUrl =
    typeof blob.meetingsDbUrl === "string" ? blob.meetingsDbUrl.trim() : "";
  const knowledgeDbUrl =
    typeof blob.knowledgeDbUrl === "string" ? blob.knowledgeDbUrl.trim() : "";
  const yourName = typeof blob.yourName === "string" ? blob.yourName.trim() : "";
  const teamTimes = parseTeamTimes(blob.teamTimes);

  return { meetingsDbUrl, knowledgeDbUrl, teamTimes, yourName };
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

/** Throws on an unreadable blob; never throws for "not set up". */
export async function loadNotionConfigState(): Promise<NotionConfigState> {
  const tokenPresent = await isTokenPresent();
  const stored = await parseStoredBlob();
  const meetingsDbId =
    stored === null ? null : parseNotionDatabaseId(stored.meetingsDbUrl);

  // "absent" is neither piece present at all; either one alone is "incomplete".
  // A stored blob whose meetings link holds no id is still "no meetings link".
  if (!tokenPresent && meetingsDbId === null) return { state: "absent" };
  // Only the token is on file (absent above ruled out the other case).
  if (!tokenPresent) return { state: "incomplete", missing: ["token"] };
  if (meetingsDbId === null || stored === null) {
    return { state: "incomplete", missing: ["meetingsDbUrl"] };
  }

  // First time Notion reads as set up: remember when, so crash recovery never
  // backfills meetings that predate the setup. Never overwritten.
  if (safeLocalStorage.getItem(STORAGE_KEYS.NOTION_SETUP_AT) === null) {
    safeLocalStorage.setItem(STORAGE_KEYS.NOTION_SETUP_AT, String(Date.now()));
  }

  return {
    state: "complete",
    config: stored,
    meetingsDbId,
    knowledgeDbId: parseNotionDatabaseId(stored.knowledgeDbUrl),
  };
}

/**
 * Returns null ONLY when nothing is stored: a stored config always comes
 * back, even when the meetings link holds no database id - the settings card
 * prefills what the user saved. Throws NOTION_CONFIG_UNREADABLE when the
 * blob is unreadable.
 */
export async function loadNotionConfig(): Promise<NotionConfig | null> {
  return parseStoredBlob();
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

/** When Notion first read as set up, or null if it never has. */
export function getNotionSetupAt(): number | null {
  const n = Number(safeLocalStorage.getItem(STORAGE_KEYS.NOTION_SETUP_AT));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Default TRUE when the key is unset: sending to Notion is opt-out. */
export function isNotionAutoSendEnabled(): boolean {
  return safeLocalStorage.getItem(STORAGE_KEYS.NOTION_AUTO_SEND) !== "false";
}

export function setNotionAutoSendEnabled(on: boolean): void {
  safeLocalStorage.setItem(STORAGE_KEYS.NOTION_AUTO_SEND, String(on));
}
