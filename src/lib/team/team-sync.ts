import { emit } from "@tauri-apps/api/event";
import { STORAGE_KEYS, TEAM_SETTINGS_APPLIED_EVENT } from "@/config";
import { broadcastGoogleConnectionChanged } from "@/lib/calendar/google-connect";
import { secureDelete, secureGet } from "@/lib/secure-storage";
import { safeLocalStorage } from "@/lib/storage/helper";
import { NOTION_CONFIG_CHANGED_EVENT } from "@/lib/storage/notion-config.storage";
import { resetSecureProviderConfigsCache } from "@/lib/storage/secure-provider-configs";
import { applyTeamFile, TEAM_LINK_SECURE_KEY, type ApplyResult } from "./team-apply";
import { decryptTeamPayload } from "./team-crypto";
import { parseTeamFile, type TeamErrorCode, type TeamFile, type TeamResult } from "./team-file";
import { fetchTeamBlob } from "./team-fetch";
import { buildTeamLink, parseTeamLink, type TeamLink } from "./team-link";

export { TEAM_LINK_SECURE_KEY };
export const TEAM_OWNER_KEY_SECURE_KEY = "team_owner_key";
export const TEAM_OWNER_GIST_SECURE_KEY = "team_owner_gist_id";

/** Null when nothing is stored or the store cannot be read. */
export async function loadStoredTeamLink(): Promise<TeamLink | null> {
  try {
    const raw = await secureGet(TEAM_LINK_SECURE_KEY);
    return raw === null ? null : parseTeamLink(raw);
  } catch {
    return null;
  }
}

/** Null unless both owner values exist and form a valid link. */
export async function loadOwnerTeamLink(): Promise<TeamLink | null> {
  try {
    const key = await secureGet(TEAM_OWNER_KEY_SECURE_KEY);
    const gistId = await secureGet(TEAM_OWNER_GIST_SECURE_KEY);
    if (key === null || gistId === null) return null;
    return parseTeamLink(buildTeamLink({ gistId, key }));
  } catch {
    return null;
  }
}

/** Fetches, decrypts and validates; applies nothing. */
export async function fetchTeamFile(
  link: TeamLink
): Promise<TeamResult<{ file: TeamFile; ownerLogin: string }>> {
  const fetched = await fetchTeamBlob(link.gistId);
  if (!fetched.ok) return fetched;
  const plain = await decryptTeamPayload(fetched.value.blob, link.key);
  if (plain === null) return { ok: false, code: "TEAM_DECRYPT_FAILED" };
  const file = parseTeamFile(plain);
  return file.ok ? { ok: true, value: { file: file.value, ownerLogin: fetched.value.ownerLogin } } : file;
}

// Each emit is independent: one failing never skips the others.
function emitChanged(): void {
  const swallow = () => undefined;
  for (const send of [
    () => emit(TEAM_SETTINGS_APPLIED_EVENT),
    () => emit(NOTION_CONFIG_CHANGED_EVENT),
    () => broadcastGoogleConnectionChanged(),
  ]) {
    try {
      Promise.resolve(send()).catch(swallow);
    } catch {
      // best effort
    }
  }
}

const warn = (code: TeamErrorCode) => console.warn("[team] sync failed:", code);

async function run(link: TeamLink, opts: { firstJoin: boolean }): Promise<ApplyResult> {
  try {
    const file = await fetchTeamFile(link);
    if (!file.ok) {
      warn(file.code);
      return { ok: false, code: file.code, landed: false, googleClientChanged: false };
    }
    const result = await applyTeamFile(
      file.value.file,
      opts.firstJoin ? { firstJoin: true, link } : { firstJoin: false }
    );
    if (!result.ok) {
      warn(result.code);
      if (result.landed) emitChanged();
      return result;
    }
    safeLocalStorage.setItem(STORAGE_KEYS.TEAM_LAST_SYNCED_AT, String(Date.now()));
    if (result.value.changed) emitChanged();
    return result;
  } catch {
    // The caller cannot know what landed.
    warn("TEAM_WRITE_FAILED");
    resetSecureProviderConfigsCache();
    emitChanged();
    return { ok: false, code: "TEAM_WRITE_FAILED", landed: true, googleClientChanged: false };
  }
}

let chain: Promise<unknown> = Promise.resolve();

/** Serialized; never rejects. */
export function syncTeam(link: TeamLink, opts: { firstJoin: boolean }): Promise<ApplyResult> {
  const next = chain.then(() => run(link, opts), () => run(link, opts));
  chain = next;
  return next;
}

export async function leaveTeam(): Promise<void> {
  try {
    await secureDelete(TEAM_LINK_SECURE_KEY);
  } catch {
    // Still forget the sync time below.
  }
  safeLocalStorage.removeItem(STORAGE_KEYS.TEAM_LAST_SYNCED_AT);
}

export function __resetTeamSyncForTests(): void {
  chain = Promise.resolve();
}
