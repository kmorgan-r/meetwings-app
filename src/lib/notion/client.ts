import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { NotionError, type NotionErrorCode } from "./errors";

/**
 * Notion HTTP transport (API version 2025-09-03).
 *
 * Load-bearing details:
 * - tauriFetch, per CLAUDE.md - a webview fetch to api.notion.com would hit
 *   CORS in dev and the plugin is what the rest of the repo already uses.
 * - Pacing is per client instance, as closure state here, NEVER a module
 *   global: two tokens on screen at once pace independently. Every fetch
 *   attempt, retries included, waits until at least NOTION_MIN_GAP_MS after
 *   the previous attempt's send time, and concurrent calls serialise through
 *   one promise chain. A failed request never breaks the chain for later
 *   calls.
 * - Error bodies are NEVER read: no text() on a non-ok response. The thrown
 *   message is NOTION_COPY[code] by construction, so a Notion response body
 *   echoing the token has no path to a log or a toast.
 * - The timeout discriminator is our own timer flag, not error.name or
 *   error.error: naming. plugin-http surfaces an abort through its own Rust
 *   channel, so an aborted request and a network failure both arrive as a
 *   thrown value.
 * - ONE timer per attempt, covering the WHOLE attempt: fetch AND the success
 *   body read. plugin-http streams the body, so a stalled body can hang
 *   forever - the timer races the body read too, and is cleared in a finally
 *   only once the body has been fully read.
 */

export const NOTION_MIN_GAP_MS = 350;
export const NOTION_HTTP_TIMEOUT_MS = 30_000;
export const RETRY_AFTER_CAP_MS = 60_000;
export const NOTION_API_BASE = "https://api.notion.com";
export const NOTION_VERSION = "2025-09-03";

/**
 * Minimal structural types holding only what later tasks read. Every one keeps
 * a `[key: string]: unknown` index signature, so a later task that needs one
 * more field reads it with a cast instead of widening this file.
 */
export interface NotionProperty {
  id?: string;
  type?: string;
  [key: string]: unknown;
}

export interface NotionPage {
  id?: string;
  url?: string;
  created_time?: string;
  created_by?: { id?: string } & { [key: string]: unknown };
  properties?: Record<string, NotionProperty>;
  [key: string]: unknown;
}

export interface NotionBlock {
  id?: string;
  type?: string;
  has_children?: boolean;
  rich_text?: { plain_text?: string; text?: { content?: string } }[];
  [key: string]: unknown;
}

export interface NotionBlockInput {
  object?: "block";
  type: string;
  [key: string]: unknown;
}

export interface NotionClientDeps {
  token: string;
  fetch?: typeof tauriFetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface NotionClient {
  request<T>(
    method: "GET" | "POST" | "PATCH",
    path: string,
    body?: unknown,
  ): Promise<T>; // path starts with "/v1/"
  me(): Promise<{ id: string; ownerUserId: string | null }>;
  userName(id: string): Promise<string | null>;
  database(id: string): Promise<{ dataSources: { id: string; name: string }[] }>;
  dataSource(id: string): Promise<{ id: string; name: string; properties: Record<string, NotionProperty> }>;
  queryAll(dataSourceId: string, body: object): Promise<NotionPage[]>;
  createPage(body: object): Promise<NotionPage>;
  listChildren(blockId: string): Promise<NotionBlock[]>;
  appendChildren(blockId: string, children: NotionBlockInput[]): Promise<NotionBlock[]>;
  trashPage(pageId: string): Promise<void>;
}

const MAX_ATTEMPTS = 3;

/**
 * Non-retryable statuses map by name. 400/422 are "Notion refused the body";
 * anything else we never anticipated (405, 413, ...) is on us to look at, so
 * NOTION_INTERNAL - not the user-facing "Notion refused the page" copy.
 */
function codeForStatus(status: number): NotionErrorCode {
  switch (status) {
    case 400:
      return "NOTION_INVALID";
    case 401:
      return "NOTION_UNAUTHORIZED";
    case 403:
      return "NOTION_NO_ACCESS";
    case 404:
      return "NOTION_NOT_FOUND";
    case 422:
      return "NOTION_INVALID";
    default:
      return "NOTION_INTERNAL";
  }
}

/**
 * Seconds → ms, honouring ONLY an integer number of seconds and capping at
 * RETRY_AFTER_CAP_MS. "", "0x10", "1e3" and an HTTP-date all fail /^\d+$/ (so
 * an HTTP-date parses to NaN, and a decimal or exponent form is refused), fall
 * back to undefined, and the caller falls back to its own waits; the error
 * carries no value.
 */
function parseRetryAfterMs(headers: Headers): number | undefined {
  const raw = headers.get("retry-after");
  if (raw === null) return undefined;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  return Math.min(Number(trimmed) * 1000, RETRY_AFTER_CAP_MS);
}

export function createNotionClient(deps: NotionClientDeps): NotionClient {
  const doFetch = deps.fetch ?? tauriFetch;
  // performance.now, not Date.now: Date jumps (NTP sync, clock changes) would
  // break the "at least 350 ms after the previous send" guarantee.
  const now = deps.now ?? ((): number => performance.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  // Pacing chain (per instance, never module-global). Serialise concurrent
  // requests through `gate`; `lastSendAt` is the previous attempt's send time.
  let lastSendAt = Number.NEGATIVE_INFINITY;
  let gate: Promise<void> = Promise.resolve();

  async function pace(): Promise<void> {
    const run = gate.then(async () => {
      const gap = lastSendAt + NOTION_MIN_GAP_MS - now();
      if (gap > 0) await sleep(gap);
      lastSendAt = now();
    });
    // A failed attempt must not poison the chain for later calls.
    gate = run.catch(() => undefined);
    return run;
  }

  /** What one attempt leaves behind: a status to classify, or the parsed body. */
  type AttemptResult = { ok: true; parsed: unknown } | { ok: false; status: number; headers: Headers };

  /**
   * One paced attempt. The per-attempt timer covers the fetch AND, on a
   * success, the body read; the flag is set ONLY in the timer callback, then
   * the controller aborted and the raced promise rejected — the timer is the
   * single source of the timeout code.
   */
  async function send(
    method: "GET" | "POST" | "PATCH",
    path: string,
    body?: unknown,
  ): Promise<AttemptResult> {
    // Built ABOVE the try: a body JSON.stringify chokes on, or a header value
    // that is not a string, is a programmer error — it propagates as-is, never
    // mapped onto a transport code.
    const headers: Record<string, string> = {
      Authorization: `Bearer ${deps.token}`,
      "Notion-Version": NOTION_VERSION,
      // Content-Type only when there is something to type.
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    };
    const payload = body !== undefined ? JSON.stringify(body) : undefined;

    await pace();
    const controller = new AbortController();
    let timedOut = false;
    let rejectTimer: (reason: unknown) => void = () => undefined;
    const timerPromise = new Promise<never>((_resolve, reject) => {
      rejectTimer = reject;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      rejectTimer(new Error("notion request timed out"));
    }, NOTION_HTTP_TIMEOUT_MS);
    try {
      const response = (await Promise.race([
        doFetch(`${NOTION_API_BASE}${path}`, {
          method,
          headers,
          body: payload,
          signal: controller.signal,
        }),
        timerPromise,
      ])) as Response;
      if (!response.ok) {
        // Error bodies are NEVER read.
        return { ok: false, status: response.status, headers: response.headers };
      }
      let text: string;
      try {
        text = await Promise.race([response.text(), timerPromise]);
      } catch {
        // The timer firing mid-body is the timeout; a mid-stream failure with
        // the timer NOT fired is the network.
        throw new NotionError(timedOut ? "NOTION_TIMEOUT" : "NOTION_NETWORK");
      }
      try {
        return { ok: true, parsed: JSON.parse(text) as unknown };
      } catch {
        // A success the client cannot read: the caller treats it as Notion
        // refusing the request, not as a transport failure.
        throw new NotionError("NOTION_INVALID");
      }
    } catch (thrown) {
      // A NotionError from above passes through; anything the attempt itself
      // threw (fetch, mid-body) is classified by the timer flag.
      if (thrown instanceof NotionError) throw thrown;
      throw timedOut ? new NotionError("NOTION_TIMEOUT") : new NotionError("NOTION_NETWORK");
    } finally {
      clearTimeout(timer);
    }
  }

  async function request<T>(
    method: "GET" | "POST" | "PATCH",
    path: string,
    body?: unknown,
  ): Promise<T> {
    if (!path.startsWith("/v1/")) {
      // Programmer error, not a Notion outcome: a plain Error, no NotionError.
      throw new Error(`Notion client: path must start with "/v1/" (got ${path})`);
    }
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const result = await send(method, path, body);
      if (result.ok) return result.parsed as T;
      const status = result.status;
      if (status === 429 || status === 409 || (status >= 500 && status < 600)) {
        // 409 joins 5xx: Notion's conflict_error docs say "try again", so it
        // gets the same in-call retries and waits.
        const retryAfterMs = parseRetryAfterMs(result.headers);
        if (attempt === MAX_ATTEMPTS) {
          if (status === 429) {
            throw new NotionError(
              "NOTION_RATE_LIMITED",
              retryAfterMs === undefined ? undefined : { retryAfterMs },
            );
          }
          throw new NotionError("NOTION_SERVER");
        }
        // A mix of retryable statuses still just means "wait and try again";
        // the code of the LAST response decides the final error.
        await sleep(retryAfterMs ?? (attempt === 1 ? 2000 : 4000));
        continue;
      }
      throw new NotionError(codeForStatus(status));
    }
    // Unreachable: the loop exits only by returning or throwing.
    throw new NotionError("NOTION_INTERNAL");
  }

  return {
    request,

    async me() {
      const body = await request<{
        id?: string;
        bot?: { owner?: { user?: { id?: string } } };
      }>("GET", "/v1/users/me");
      return {
        id: body.id ?? "",
        ownerUserId: body.bot?.owner?.user?.id ?? null,
      };
    },

    async userName(id) {
      try {
        const body = await request<{ name?: string }>(
          "GET",
          `/v1/users/${encodeURIComponent(id)}`,
        );
        return body.name ?? null;
      } catch (thrown) {
        if (
          thrown instanceof NotionError &&
          (thrown.code === "NOTION_NO_ACCESS" || thrown.code === "NOTION_NOT_FOUND")
        ) {
          // The owner's identity is cosmetic: not readable is a valid answer.
          return null;
        }
        throw thrown;
      }
    },

    async database(id) {
      const body = await request<{
        data_sources?: { id?: string; name?: string }[];
      }>("GET", `/v1/databases/${encodeURIComponent(id)}`);
      return {
        dataSources: (body.data_sources ?? []).map((ds) => ({ id: ds.id ?? "", name: ds.name ?? "" })),
      };
    },

    async dataSource(id) {
      const body = await request<{
        id?: string;
        name?: string;
        title?: { plain_text?: string }[];
        properties?: Record<string, NotionProperty>;
      }>("GET", `/v1/data_sources/${encodeURIComponent(id)}`);
      // "Team K"+""nowledge"-style titles arrive as separate rich-text runs.
      const name = body.name ?? (body.title ?? []).map((t) => t.plain_text).join("");
      return { id: body.id ?? id, name, properties: body.properties ?? {} };
    },

    async queryAll(dataSourceId, body) {
      const results: NotionPage[] = [];
      let cursor: string | undefined;
      do {
        const page = await request<{
          has_more?: boolean;
          next_cursor?: string;
          results?: NotionPage[];
        }>(
          "POST",
          `/v1/data_sources/${encodeURIComponent(dataSourceId)}/query`,
          { ...body, page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) },
        );
        results.push(...(page.results ?? []));
        cursor = page.has_more ? page.next_cursor : undefined;
      } while (cursor);
      return results;
    },

    async createPage(body) {
      return request<NotionPage>("POST", "/v1/pages", body);
    },

    async listChildren(blockId) {
      const results: NotionBlock[] = [];
      let cursor: string | undefined;
      do {
        const query = cursor ? `page_size=100&start_cursor=${encodeURIComponent(cursor)}` : "page_size=100";
        const page = await request<{
          has_more?: boolean;
          next_cursor?: string;
          results?: NotionBlock[];
        }>("GET", `/v1/blocks/${encodeURIComponent(blockId)}/children?${query}`);
        results.push(...(page.results ?? []));
        cursor = page.has_more ? page.next_cursor : undefined;
      } while (cursor);
      return results;
    },

    async appendChildren(blockId, children) {
      // Batching to 100 blocks per request is the caller's job (limits), not
      // the transport's.
      const body = await request<{ results?: NotionBlock[] }>(
        "PATCH",
        `/v1/blocks/${encodeURIComponent(blockId)}/children`,
        { children },
      );
      return body.results ?? [];
    },

    async trashPage(pageId) {
      await request(
        "PATCH",
        `/v1/pages/${encodeURIComponent(pageId)}`,
        { in_trash: true },
      );
    },
  };
}
