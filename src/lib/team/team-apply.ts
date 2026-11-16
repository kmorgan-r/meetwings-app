import { invoke } from "@tauri-apps/api/core";
import { STORAGE_KEYS } from "@/config";
import { clearNotionToken, loadNotionToken, saveNotionToken } from "@/lib/notion/token";
import { secureDelete, secureGet, secureSet } from "@/lib/secure-storage";
import {
  loadGoogleConfigState,
  saveGoogleConfig,
  SECURE_GOOGLE_CONFIG_KEY,
} from "@/lib/storage/google-config.storage";
import { safeLocalStorage } from "@/lib/storage/helper";
import {
  loadNotionConfig,
  saveNotionConfig,
  SECURE_NOTION_CONFIG_KEY,
  type NotionConfig,
} from "@/lib/storage/notion-config.storage";
import { AI_CONFIGS_KEY, resetSecureProviderConfigsCache } from "@/lib/storage/secure-provider-configs";
import type { TYPE_PROVIDER } from "@/types";
import type { TeamErrorCode, TeamFile, TeamProviderSettings } from "./team-file";
import { buildTeamLink, type TeamLink } from "./team-link";

/** Written last on a first join, so a stored link means every setting landed. */
export const TEAM_LINK_SECURE_KEY = "team_link";

/**
 * Speech keys are never shared (free tiers rate-limit per key), so a first join
 * only suggests AssemblyAI to a colleague with no speech provider, key left blank.
 */
const SUGGESTED_STT = { provider: "assemblyai-diarization", variables: {} };

export interface ApplyOutcome {
  changed: boolean;
  googleClientChanged: boolean;
}

export type ApplyResult =
  | { ok: true; value: ApplyOutcome }
  | { ok: false; code: TeamErrorCode; landed: boolean; googleClientChanged: boolean };

interface Step {
  run: () => Promise<void>;
  undo: () => Promise<void>;
  /**
   * A rejected run left nothing behind (one keychain call). Secure-store and
   * localStorage writes are not: secureSet's store.set can land in memory before
   * store.save rejects, and the next write would persist it.
   */
  atomic?: true;
}

const EMPTY_NOTION: NotionConfig = { meetingsDbUrl: "", knowledgeDbUrl: "", teamTimes: {}, yourName: "" };

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function parse(raw: string | null): unknown {
  try {
    return raw === null ? null : JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Key order never counts as a change. */
const stable = (v: unknown): string =>
  JSON.stringify(v, (_k, x: unknown) =>
    isObj(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x
  );

const sameJson = (raw: string | null, target: unknown): boolean =>
  raw !== null && stable(parse(raw)) === stable(target);

const restoreSecure = (key: string, raw: string | null) => () =>
  raw === null ? secureDelete(key) : secureSet(key, raw);

// The next reader must reload the raw blob, not this window's startup cache.
const thenResetCache = (op: () => Promise<void>) => async () => {
  try {
    await op();
  } finally {
    resetSecureProviderConfigsCache();
  }
};

// safeLocalStorage swallows a failed write (quota): read back so it rejects.
async function writeLocal(key: string, value: string | null): Promise<void> {
  if (value === null) safeLocalStorage.removeItem(key);
  else safeLocalStorage.setItem(key, value);
  if (safeLocalStorage.getItem(key) !== value) throw new Error("TEAM_WRITE_FAILED");
}

/** Never through saveSecure*Config: that rewrites the blob from a possibly stale cache. */
function providerTargets(s: TeamProviderSettings, blobRaw: string | null, selectedRaw: string | null) {
  const parsedBlob = parse(blobRaw);
  const stored = isObj(parsedBlob) ? parsedBlob : {};
  const sel = parse(selectedRaw);
  // The active provider's live values sit in the selection, not the blob.
  const base =
    isObj(sel) && sel.provider === s.provider && isObj(sel.variables)
      ? sel.variables
      : isObj(stored[s.provider])
        ? (stored[s.provider] as Record<string, unknown>)
        : {};
  const variables = { ...base, ...s.variables };
  return { blob: { ...stored, [s.provider]: variables }, selected: { provider: s.provider, variables } };
}

function upsertCustom(raw: string | null, custom: TYPE_PROVIDER): unknown[] {
  const parsed = parse(raw);
  const list: unknown[] = Array.isArray(parsed) ? parsed : [];
  const entry = { ...custom, isCustom: true };
  const i = list.findIndex((p) => isObj(p) && p.id === custom.id);
  return i === -1 ? [...list, entry] : list.map((p, j) => (j === i ? entry : p));
}

const failed = (landed: boolean, googleClientChanged: boolean): ApplyResult => ({
  ok: false,
  code: "TEAM_WRITE_FAILED",
  landed,
  googleClientChanged,
});

/**
 * Writes only what differs, secrets before the configs that use them. A first
 * join that fails is rolled back to the exact prior bytes; a later sync keeps
 * whatever landed.
 */
export async function applyTeamFile(
  file: TeamFile,
  opts: { firstJoin: false } | { firstJoin: true; link: TeamLink }
): Promise<ApplyResult> {
  // 1. Snapshot before any write.
  let token: string | null;
  let aiRaw: string | null;
  let googleRaw: string | null;
  let notionRaw: string | null;
  let linkRaw: string | null;
  let oldGoogle: Awaited<ReturnType<typeof loadGoogleConfigState>>;
  let local: Record<"customAi" | "selectedAi" | "selectedStt", string | null>;
  try {
    token = await loadNotionToken();
    aiRaw = await secureGet(AI_CONFIGS_KEY);
    googleRaw = await secureGet(SECURE_GOOGLE_CONFIG_KEY);
    notionRaw = await secureGet(SECURE_NOTION_CONFIG_KEY);
    linkRaw = await secureGet(TEAM_LINK_SECURE_KEY);
    oldGoogle = await loadGoogleConfigState();
    // Raw localStorage, not safeLocalStorage: a swallowed read would look like
    // "absent" and a rollback would then delete the key.
    local = {
      customAi: localStorage.getItem(STORAGE_KEYS.CUSTOM_AI_PROVIDERS),
      selectedAi: localStorage.getItem(STORAGE_KEYS.SELECTED_AI_PROVIDER),
      selectedStt: localStorage.getItem(STORAGE_KEYS.SELECTED_STT_PROVIDER),
    };
  } catch {
    return failed(false, false);
  }
  // Unreadable counts as nothing stored. Never loadNotionConfigState: it stamps NOTION_SETUP_AT.
  const notion = (await loadNotionConfig().catch(() => null)) ?? EMPTY_NOTION;

  // 2. Targets.
  const ai = providerTargets(file.ai, aiRaw, local.selectedAi);
  const sttSel = parse(local.selectedStt);
  const suggestStt = opts.firstJoin && !(isObj(sttSel) && sttSel.provider);
  const notionTarget: NotionConfig = {
    meetingsDbUrl: file.notion.meetingsDbUrl,
    knowledgeDbUrl: file.notion.knowledgeDbUrl ?? notion.knowledgeDbUrl,
    teamTimes: file.notion.teamTimes ?? notion.teamTimes,
    yourName: notion.yourName,
  };
  // Exactly what saveGoogleConfig / saveNotionConfig would store.
  const googleJson = JSON.stringify({
    clientId: file.google.clientId.trim(),
    clientSecret: file.google.clientSecret.trim(),
  });
  const notionJson = JSON.stringify({
    meetingsDbUrl: notionTarget.meetingsDbUrl.trim(),
    knowledgeDbUrl: notionTarget.knowledgeDbUrl.trim(),
    teamTimes: notionTarget.teamTimes,
    yourName: notionTarget.yourName.trim(),
  });

  // 3. Steps, only where the target differs from the snapshot.
  const steps: Step[] = [];
  if (token !== file.notion.token.trim()) {
    const old = token;
    steps.push({
      run: () => saveNotionToken(file.notion.token),
      undo: () => (old === null ? clearNotionToken() : saveNotionToken(old)),
      atomic: true,
    });
  }
  if (!sameJson(aiRaw, ai.blob)) {
    steps.push({
      run: thenResetCache(() => secureSet(AI_CONFIGS_KEY, JSON.stringify(ai.blob))),
      undo: thenResetCache(restoreSecure(AI_CONFIGS_KEY, aiRaw)),
    });
  }
  let googleStep: Step | undefined;
  if (googleRaw !== googleJson) {
    googleStep = { run: () => saveGoogleConfig(file.google), undo: restoreSecure(SECURE_GOOGLE_CONFIG_KEY, googleRaw) };
    steps.push(googleStep);
  }
  const localTargets: [string, string | null, unknown][] = [];
  if (file.ai.custom) {
    localTargets.push([STORAGE_KEYS.CUSTOM_AI_PROVIDERS, local.customAi, upsertCustom(local.customAi, file.ai.custom)]);
  }
  localTargets.push([STORAGE_KEYS.SELECTED_AI_PROVIDER, local.selectedAi, ai.selected]);
  if (suggestStt) localTargets.push([STORAGE_KEYS.SELECTED_STT_PROVIDER, local.selectedStt, SUGGESTED_STT]);
  for (const [key, raw, target] of localTargets) {
    if (sameJson(raw, target)) continue;
    steps.push({ run: () => writeLocal(key, JSON.stringify(target)), undo: () => writeLocal(key, raw) });
  }
  if (notionRaw !== notionJson) {
    steps.push({ run: () => saveNotionConfig(notionTarget), undo: restoreSecure(SECURE_NOTION_CONFIG_KEY, notionRaw) });
  }
  if (opts.firstJoin) {
    const link = buildTeamLink(opts.link);
    if (linkRaw !== link) {
      steps.push({ run: () => secureSet(TEAM_LINK_SECURE_KEY, link), undo: restoreSecure(TEAM_LINK_SECURE_KEY, linkRaw) });
    }
  }

  // 4. Run in order; stop at the first rejection.
  const done: Step[] = [];
  let failedStep: Step | undefined;
  for (const step of steps) {
    try {
      await step.run();
      done.push(step);
    } catch {
      failedStep = step;
      break;
    }
  }
  let landed = false;
  let googleInPlace = googleStep !== undefined && done.includes(googleStep);
  if (failedStep) {
    // In both modes the failed write's own half-write goes first, so memory never
    // holds an unpersisted value; a first join then undoes the rest in reverse.
    const undos = failedStep.atomic ? [] : [failedStep];
    if (opts.firstJoin) undos.push(...[...done].reverse());
    let undoThrew = false;
    for (const step of undos) {
      try {
        await step.undo();
        if (step === googleStep) googleInPlace = false;
      } catch {
        undoThrew = true;
      }
    }
    landed = opts.firstJoin ? undoThrew : done.length > 0 || undoThrew;
  }

  // 5. A new Google client cannot use the old client's sign-in.
  const googleClientChanged =
    googleInPlace && oldGoogle.state === "complete" && oldGoogle.config.clientId !== file.google.clientId.trim();
  if (googleClientChanged) {
    try {
      await invoke("google_disconnect");
    } catch {
      // Best effort: a failed disconnect never fails the apply.
    }
  }

  // 6. Result.
  return failedStep
    ? failed(landed, googleClientChanged)
    : { ok: true, value: { changed: steps.length > 0, googleClientChanged } };
}
