import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import type { TeamErrorCode, TeamResult } from "@/lib/team/team-file";

/**
 * Fetches the encrypted team-settings blob ("mwt1."-prefixed text) out of the
 * owner's secret GitHub Gist, with the gist owner's login (the join prompt
 * names it). Trust boundary: everything read here comes from the internet.
 *
 * Load-bearing details:
 * - tauriFetch, per CLAUDE.md - the webview fetch would not have the plugin's
 *   CORS bypass, and the plugin is what the rest of the repo already uses.
 * - Gist ids are pinned to /^[0-9a-f]{20,32}$/ BEFORE anything else, so a
 *   malformed id is never sent (the validated id is in the URL by design) -
 *   and nothing here is ever logged.
 * - maxRedirections: 0 kills a redirect-based exfiltration of the id/url.
 * - connectTimeout does NOT cover a response that stalls after connecting,
 *   and syncTeam calls are serialized downstream, so one hang would block
 *   every later sync (a confirm-join included). ONE timer therefore races
 *   the WHOLE attempt - fetch AND the body read - and is cleared in a
 *   finally. When the timer wins, the AbortController behind `signal` is
 *   aborted and the caller gets TEAM_FETCH_FAILED (same shape as the Notion
 *   client's per-attempt timer).
 */

export const GIST_API_BASE = "https://api.github.com/gists/";
export const TEAM_FETCH_TIMEOUT_MS = 15_000;

const GIST_ID_RE = /^[0-9a-f]{20,32}$/;

const BLOB_PREFIX = "mwt1.";

// GitHub's login shape. The join prompt shows it, so it is validated here.
const OWNER_LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

const fail = (code: TeamErrorCode): { ok: false; code: TeamErrorCode } => ({ ok: false, code });

/** `owner.login`, or null when it is missing or not a GitHub login. */
function pickOwnerLogin(parsed: unknown): string | null {
  const owner = (parsed as { owner?: unknown } | null)?.owner;
  const login = typeof owner === "object" && owner !== null ? (owner as { login?: unknown }).login : undefined;
  return typeof login === "string" && OWNER_LOGIN_RE.test(login) ? login : null;
}

/**
 * `files` must be a plain object (not null, not an array). Entries whose
 * `content` is not a string are skipped; the file whose trimmed content
 * starts with "mwt1." must be exactly one and not truncated.
 */
function pickBlob(parsed: unknown): TeamResult<string> {
  const files = (parsed as { files?: unknown } | null)?.files;
  if (typeof files !== "object" || files === null || Array.isArray(files)) return fail("TEAM_FETCH_FAILED");

  const matches: string[] = [];
  for (const entry of Object.values(files as Record<string, unknown>)) {
    if (typeof entry !== "object" || entry === null) continue;
    const content = (entry as { content?: unknown }).content;
    if (typeof content !== "string") continue;
    const trimmed = content.trim();
    if (!trimmed.startsWith(BLOB_PREFIX)) continue;
    if ((entry as { truncated?: unknown }).truncated === true) return fail("TEAM_FILE_INVALID");
    matches.push(trimmed);
  }
  if (matches.length !== 1) return fail("TEAM_FILE_INVALID");
  return { ok: true, value: matches[0] };
}

export async function fetchTeamBlob(
  gistId: string,
): Promise<TeamResult<{ blob: string; ownerLogin: string }>> {
  if (!GIST_ID_RE.test(gistId)) return fail("TEAM_LINK_INVALID");

  const controller = new AbortController();
  let rejectTimer: (reason: unknown) => void = () => undefined;
  const timerPromise = new Promise<never>((_resolve, reject) => {
    rejectTimer = reject;
  });
  const timer = setTimeout(() => {
    controller.abort();
    rejectTimer(new Error("team gist fetch timed out"));
  }, TEAM_FETCH_TIMEOUT_MS);

  try {
    const response = (await Promise.race([
      tauriFetch(GIST_API_BASE + gistId, {
        method: "GET",
        headers: {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        maxRedirections: 0,
        connectTimeout: TEAM_FETCH_TIMEOUT_MS,
        signal: controller.signal,
      }),
      timerPromise,
    ])) as Response;

    if (response.status !== 200) {
      // Error bodies are NEVER read.
      return fail("TEAM_FETCH_FAILED");
    }
    // The body read is inside the same race: a stalled body must hit the
    // timer too.
    const text = (await Promise.race([response.text(), timerPromise])) as string;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      // A 200 that is not JSON: the internet, not the file, is broken.
      return fail("TEAM_FETCH_FAILED");
    }
    const ownerLogin = pickOwnerLogin(parsed);
    if (ownerLogin === null) return fail("TEAM_FETCH_FAILED");
    const blob = pickBlob(parsed);
    return blob.ok ? { ok: true, value: { blob: blob.value, ownerLogin } } : blob;
  } catch {
    // A throw, or the timer winning the race - same user-facing answer.
    return fail("TEAM_FETCH_FAILED");
  } finally {
    clearTimeout(timer);
  }
}
