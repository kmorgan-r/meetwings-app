import { afterEach, describe, expect, it, vi } from "vitest";

// The default mock THROWS, so a client built without an injected fetch stub
// fails as "unexpected network call" instead of silently hitting the network
// with the (fake) token.
vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: vi.fn(() => {
    throw new Error("unexpected network call: inject a fetch stub into the client");
  }),
}));

// A bare webview fetch is not intercepted by the plugin-http mock either: fail
// loudly if one ever sneaks through (same guard as odoo-client.test.ts).
global.fetch = vi.fn(() => {
  throw new Error("webview fetch is forbidden here - the client must use plugin-http");
}) as unknown as typeof fetch;

import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import {
  NOTION_HTTP_TIMEOUT_MS,
  NOTION_MIN_GAP_MS,
  RETRY_AFTER_CAP_MS,
  createNotionClient,
  type NotionBlockInput,
} from "@/lib/notion/client";
import { NOTION_COPY, NotionError } from "@/lib/notion/errors";

// Fake secrets only - never a real Notion id or token.
const TOKEN = "secret_ntn_TEST";
const BASE = "https://api.notion.com";

type StubInit = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
};

/** Success/fixture body with a Headers object, never read on error paths. */
function jsonBody(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const BOT_BODY = { id: "USER_BOT", name: "Meetwings Bot", bot: { owner: { user: { id: "USER_OWNER" } } } };

interface Harness {
  calls: { url: string; init: StubInit }[];
  sendTimes: number[];
  sleeps: number[];
  time: number;
  client: ReturnType<typeof createNotionClient>;
}

/**
 * Builds a client whose clock is fully in hand: `now` reads a fake time and
 * `sleep` records the wait and ADVANCES the fake clock, which is how real
 * elapsed time reaches the pacing math. Every fetch attempt records its send
 * time. An exhausted response list rejects so an extra call cannot pass unseen.
 */
function makeHarness(responses: Response[]): Harness {
  const calls: { url: string; init: StubInit }[] = [];
  const sendTimes: number[] = [];
  const sleeps: number[] = [];
  let time = 0;
  let i = 0;
  const stub = (url: string, init?: StubInit): Promise<Response> => {
    calls.push({ url, init: init ?? {} });
    sendTimes.push(time);
    if (i >= responses.length) {
      return Promise.reject(new Error(`unexpected extra fetch call #${i + 1}`));
    }
    return Promise.resolve(responses[i++]);
  };
  const client = createNotionClient({
    token: TOKEN,
    fetch: stub as unknown as typeof tauriFetch,
    now: () => time,
    sleep: (ms: number) => {
      sleeps.push(ms);
      time += ms;
      return Promise.resolve();
    },
  });
  return { calls, sendTimes, sleeps, client, get time() { return time; } };
}

interface Thrown {
  code?: string;
  retryAfterMs?: number;
  other?: unknown;
}

async function thrownBy(fn: () => Promise<unknown>): Promise<Thrown> {
  try {
    await fn();
    return {};
  } catch (thrown) {
    if (thrown instanceof NotionError) {
      return { code: thrown.code, retryAfterMs: thrown.retryAfterMs };
    }
    return { other: thrown };
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createNotionClient.request", () => {
  it("sends Authorization Bearer and Notion-Version 2025-09-03, no Content-Type on a bodyless GET", async () => {
    const h = makeHarness([jsonBody(BOT_BODY)]);
    await h.client.me();
    expect(h.calls[0].url).toBe(`${BASE}/v1/users/me`);
    expect(h.calls[0].init.method).toBe("GET");
    expect(h.calls[0].init.headers?.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(h.calls[0].init.headers?.["Notion-Version"]).toBe("2025-09-03");
    expect(h.calls[0].init.headers?.["Content-Type"]).toBeUndefined();
  });

  it("honours Retry-After seconds, capped at 60 s", async () => {
    const h = makeHarness([
      jsonBody({}, 429, { "Retry-After": "120" }),
      jsonBody(BOT_BODY),
    ]);
    const body = await h.client.me();
    expect(body.id).toBe("USER_BOT");
    // "120" seconds = 120_000 ms, capped to RETRY_AFTER_CAP_MS.
    expect(h.sleeps).toEqual([RETRY_AFTER_CAP_MS]);
    expect(h.time).toBeLessThan(120_000);
  });

  it("backs off 2 s then 4 s on a 429 without Retry-After, then throws NOTION_RATE_LIMITED with no retryAfterMs", async () => {
    const h = makeHarness([jsonBody({}, 429), jsonBody({}, 429), jsonBody({}, 429)]);
    const thrown = await thrownBy(() => h.client.me());
    expect(thrown).toEqual({ code: "NOTION_RATE_LIMITED" });
    expect(thrown.retryAfterMs).toBeUndefined();
    expect(h.sleeps).toEqual([2000, 4000]);
    expect(h.sendTimes).toHaveLength(3); // 3 fetches, no 4th
  });

  it("a 429 that then succeeds returns the body, no error", async () => {
    const h = makeHarness([jsonBody({}, 429), jsonBody(BOT_BODY)]);
    const body = await h.client.me();
    expect(body.id).toBe("USER_BOT");
    expect(h.sendTimes).toHaveLength(2);
    expect(h.sleeps).toEqual([2000]);
  });

  it.each([
    [401, "NOTION_UNAUTHORIZED"],
    [403, "NOTION_NO_ACCESS"],
  ])("%i throws at once with no retry", async (status, code) => {
    const h = makeHarness([jsonBody({}, status)]);
    const thrown = await thrownBy(() => h.client.me());
    expect(thrown).toEqual({ code });
    expect(h.sendTimes).toHaveLength(1);
    expect(h.sleeps).toEqual([]);
  });

  it.each([
    [400, "NOTION_INVALID"],
    [404, "NOTION_NOT_FOUND"],
    [405, "NOTION_INTERNAL"],
    [422, "NOTION_INVALID"],
  ])("%i → %s with no retry", async (status, code) => {
    const h = makeHarness([jsonBody({}, status)]);
    const thrown = await thrownBy(() => h.client.me());
    expect(thrown).toEqual({ code });
    expect(h.sendTimes).toHaveLength(1);
  });

  it("three 5xx in a row → NOTION_SERVER after 3 fetches", async () => {
    const h = makeHarness([jsonBody({}, 500), jsonBody({}, 502), jsonBody({}, 503)]);
    const thrown = await thrownBy(() => h.client.me());
    expect(thrown).toEqual({ code: "NOTION_SERVER", retryAfterMs: undefined });
    expect(h.sendTimes).toHaveLength(3);
    expect(h.sleeps).toEqual([2000, 4000]);
  });

  it("createPage 502 → NOTION_SERVER after 1 fetch (a write may have committed)", async () => {
    const h = makeHarness([jsonBody({}, 502), jsonBody({ id: "P" })]);
    const thrown = await thrownBy(() => h.client.createPage({}));
    expect(thrown).toEqual({ code: "NOTION_SERVER", retryAfterMs: undefined });
    expect(h.sendTimes).toHaveLength(1);
  });

  it("appendChildren 502 → NOTION_SERVER after 1 fetch", async () => {
    const h = makeHarness([jsonBody({}, 502), jsonBody({ results: [] })]);
    const thrown = await thrownBy(() => h.client.appendChildren("B", []));
    expect(thrown).toEqual({ code: "NOTION_SERVER", retryAfterMs: undefined });
    expect(h.sendTimes).toHaveLength(1);
  });

  it("appendChildren 429 then success → returns the body after 2 fetches", async () => {
    const h = makeHarness([jsonBody({}, 429), jsonBody({ results: [{ id: "X" }] })]);
    expect(await h.client.appendChildren("B", [])).toEqual([{ id: "X" }]);
    expect(h.sendTimes).toHaveLength(2);
  });

  it("three 409s are retried like 5xx → NOTION_SERVER after 3 fetches", async () => {
    // Notion's conflict_error docs say "try again": 409 gets the same waits
    // and the same give-up code as a 5xx.
    const h = makeHarness([jsonBody({}, 409), jsonBody({}, 409), jsonBody({}, 409)]);
    const thrown = await thrownBy(() => h.client.me());
    expect(thrown).toEqual({ code: "NOTION_SERVER", retryAfterMs: undefined });
    expect(h.sendTimes).toHaveLength(3);
    expect(h.sleeps).toEqual([2000, 4000]);
  });

  it("a mix of 429 and 5xx ends with the code of the last response", async () => {
    const h = makeHarness([jsonBody({}, 500), jsonBody({}, 502), jsonBody({}, 429)]);
    const thrown = await thrownBy(() => h.client.me());
    expect(thrown).toEqual({ code: "NOTION_RATE_LIMITED" });
  });

  it("a thrown fetch → NOTION_NETWORK", async () => {
    const rejects = (): Promise<Response> => Promise.reject(new Error("connection refused"));
    let time = 0;
    const client = createNotionClient({
      token: TOKEN,
      fetch: rejects as unknown as typeof tauriFetch,
      now: () => time,
      sleep: (ms: number) => { time += ms; return Promise.resolve(); },
    });
    const thrown = await thrownBy(() => client.me());
    expect(thrown).toEqual({ code: "NOTION_NETWORK" });
  });

  it("the 30 s timeout timer aborting → NOTION_TIMEOUT", async () => {
    vi.useFakeTimers();
    // Rejects only when the client's own signal fires - the abort is the
    // discriminator, exactly how plugin-http behaves.
    const hangsUntilAbort = (_url: string, init?: StubInit): Promise<Response> =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("Request canceled")));
      });
    let time = 0;
    const client = createNotionClient({
      token: TOKEN,
      fetch: hangsUntilAbort as unknown as typeof tauriFetch,
      now: () => time,
      sleep: (ms: number) => { time += ms; return Promise.resolve(); },
    });
    const pending = client.me();
    const assertion = expect(pending).rejects.toMatchObject({ code: "NOTION_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(NOTION_HTTP_TIMEOUT_MS);
    await assertion;
  });

  it("the timer covers a stalled body read: pending at 29_999 ms, NOTION_TIMEOUT at 30_000", async () => {
    vi.useFakeTimers();
    // Headers have arrived (fetch resolved ok) but text() never settles - how
    // a stalled plugin-http body stream looks to the client.
    const stalledBody: Response = {
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({}),
      text: (): Promise<string> => new Promise<string>(() => {}),
    } as unknown as Response;
    let time = 0;
    const client = createNotionClient({
      token: TOKEN,
      fetch: (): Promise<Response> => Promise.resolve(stalledBody),
      now: () => time,
      sleep: (ms: number) => { time += ms; return Promise.resolve(); },
    });
    const pending = client.me();
    const assertion = expect(pending).rejects.toMatchObject({ code: "NOTION_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(NOTION_HTTP_TIMEOUT_MS - 1);
    const settled = await Promise.race([
      pending.then(() => "settled" as const, () => "settled" as const),
      Promise.resolve("pending" as const),
    ]);
    expect(settled).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
  });

  it("clears the timeout timer once the body is read: getTimerCount() is 0", async () => {
    vi.useFakeTimers();
    const h = makeHarness([jsonBody(BOT_BODY)]);
    await h.client.me();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("an abort that does NOT come from the timer → NOTION_NETWORK, not NOTION_TIMEOUT", async () => {
    const rejectsAsAbort = (): Promise<Response> =>
      Promise.reject(new DOMException("x", "AbortError"));
    let time = 0;
    const client = createNotionClient({
      token: TOKEN,
      fetch: rejectsAsAbort as unknown as typeof tauriFetch,
      now: () => time,
      sleep: (ms: number) => { time += ms; return Promise.resolve(); },
    });
    const thrown = await thrownBy(() => client.me());
    expect(thrown).toEqual({ code: "NOTION_NETWORK" });
  });

  it("the final 429 throws NOTION_RATE_LIMITED carrying retryAfterMs from the last header, capped", async () => {
    const h = makeHarness([
      jsonBody({}, 429, { "Retry-After": "5" }),
      jsonBody({}, 429, { "Retry-After": "3" }),
      jsonBody({}, 429, { "Retry-After": "999999" }),
    ]);
    const thrown = await thrownBy(() => h.client.me());
    expect(thrown.code).toBe("NOTION_RATE_LIMITED");
    expect(thrown.retryAfterMs).toBe(RETRY_AFTER_CAP_MS);
    expect(h.sendTimes).toHaveLength(3);
  });

  it("ignores a non-integer Retry-After (empty, HTTP-date, exponent) and falls back to the 2 s/4 s waits", async () => {
    const h = makeHarness([
      jsonBody({}, 429, { "Retry-After": "" }),
      jsonBody({}, 429, { "Retry-After": "Wed, 21 Oct 2026 07:28:00 GMT" }),
      jsonBody({}, 429, { "Retry-After": "1e3" }),
    ]);
    const thrown = await thrownBy(() => h.client.me());
    expect(thrown).toEqual({ code: "NOTION_RATE_LIMITED" });
    expect(h.sleeps).toEqual([2000, 4000]);
  });

  it("an error body echoing the token never reaches the thrown message and is never read", async () => {
    let read = false;
    const leaky: Response = {
      ok: false,
      status: 403,
      headers: new Headers(),
      json: async () => { read = true; return { message: `API token ${TOKEN} is invalid` }; },
      text: async () => { read = true; return `{"message":"API token ${TOKEN} is invalid"}`; },
    } as unknown as Response;
    let time = 0;
    const client = createNotionClient({
      token: TOKEN,
      fetch: (): Promise<Response> => Promise.resolve(leaky),
      now: () => time,
      sleep: (ms: number) => { time += ms; return Promise.resolve(); },
    });
    const err = await client.me().then(() => null, (thrown) => thrown);
    expect(err).toBeInstanceOf(NotionError);
    expect(err.message).toBe(NOTION_COPY.NOTION_NO_ACCESS);
    expect(err.message).not.toContain(TOKEN);
    expect(read).toBe(false);
  });

  it("a success body that is not JSON (JSON.parse throws) → NOTION_INVALID", async () => {
    let time = 0;
    const notJson: Response = {
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => { throw new Error("invalid json"); },
      text: async () => "<html>502 Bad Gateway</html>",
    } as unknown as Response;
    const client = createNotionClient({
      token: TOKEN,
      fetch: (): Promise<Response> => Promise.resolve(notJson),
      now: () => time,
      sleep: (ms: number) => { time += ms; return Promise.resolve(); },
    });
    const thrown = await thrownBy(() => client.me());
    expect(thrown).toEqual({ code: "NOTION_INVALID" });
  });

  it("a path that does not start with /v1/ throws a plain Error and never fetches", async () => {
    const h = makeHarness([jsonBody(BOT_BODY)]);
    const err = await h.client.request("GET", "/users/me").then(() => null, (thrown) => thrown);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(NotionError);
    expect(h.calls).toHaveLength(0);
  });

  it("paces the chain: three concurrent requests sleep exactly [350, 350]", async () => {
    // Three calls through the shared chain: the first sends at once, the
    // second and third each wait NOTION_MIN_GAP_MS after the previous send.
    // Removing the chain collapses this to [350]; removing pacing to [].
    const h = makeHarness([jsonBody(BOT_BODY), jsonBody(BOT_BODY), jsonBody(BOT_BODY)]);
    await Promise.all([h.client.me(), h.client.me(), h.client.me()]);
    expect(h.sendTimes).toHaveLength(3);
    expect(h.sleeps).toEqual([NOTION_MIN_GAP_MS, NOTION_MIN_GAP_MS]);
  });

  it("a retry also waits for pacing: two fetch attempts are never closer than 350 ms", async () => {
    // Retry-After "0" alone would re-send immediately; the pacing gate must be
    // what keeps the gap.
    const h = makeHarness([jsonBody({}, 429, { "Retry-After": "0" }), jsonBody(BOT_BODY)]);
    await h.client.me();
    expect(h.sendTimes).toHaveLength(2);
    expect(h.sendTimes[1] - h.sendTimes[0]).toBeGreaterThanOrEqual(NOTION_MIN_GAP_MS);
  });

  it("a failed request does not break the chain: the next call still succeeds", async () => {
    const h = makeHarness([jsonBody({}, 403), jsonBody(BOT_BODY)]);
    await expect(h.client.me()).rejects.toBeInstanceOf(NotionError);
    const body = await h.client.me();
    expect(body.id).toBe("USER_BOT");
    expect(h.sendTimes).toHaveLength(2);
    expect(h.sendTimes[1] - h.sendTimes[0]).toBeGreaterThanOrEqual(NOTION_MIN_GAP_MS);
  });
});

describe("createNotionClient.endpoints", () => {
  it("me() returns the bot id and bot.owner.user.id", async () => {
    const h = makeHarness([jsonBody(BOT_BODY)]);
    const me = await h.client.me();
    expect(me).toEqual({ id: "USER_BOT", ownerUserId: "USER_OWNER" });
  });

  it("me() survives a bot without an owner", async () => {
    const h = makeHarness([jsonBody({ id: "USER_BOT", bot: {} })]);
    expect(await h.client.me()).toEqual({ id: "USER_BOT", ownerUserId: null });
  });

  it("userName() returns body.name", async () => {
    const h = makeHarness([jsonBody({ id: "USER_HUMAN", name: "Casey Reed" })]);
    expect(await h.client.userName("USER_HUMAN")).toBe("Casey Reed");
    expect(h.calls[0].url).toBe(`${BASE}/v1/users/USER_HUMAN`);
  });

  it("userName() returns null on 403/404 and rethrows every other error", async () => {
    const null404 = makeHarness([jsonBody({}, 404)]);
    expect(await null404.client.userName("USER_GONE")).toBeNull();

    const null403 = makeHarness([jsonBody({}, 403)]);
    expect(await null403.client.userName("USER_HIDDEN")).toBeNull();

    const rethrow = makeHarness([jsonBody({}, 401)]);
    const thrown = await thrownBy(() => rethrow.client.userName("USER_ANYONE"));
    expect(thrown).toEqual({ code: "NOTION_UNAUTHORIZED" });
  });

  it("database() maps data_sources to dataSources", async () => {
    const h = makeHarness([
      jsonBody({ id: "DB1", data_sources: [{ id: "DS1", name: "Team Knowledge" }, { id: "DS2", name: "Archive" }] }),
    ]);
    const db = await h.client.database("DB1");
    expect(db).toEqual({
      dataSources: [
        { id: "DS1", name: "Team Knowledge" },
        { id: "DS2", name: "Archive" },
      ],
    });
    expect(h.calls[0].url).toBe(`${BASE}/v1/databases/DB1`);
  });

  it("dataSource() returns id, properties, and falls back to the title plain_text for the name", async () => {
    const h = makeHarness([
      jsonBody({
        id: "DS1",
        title: [{ plain_text: "Team K" }, { plain_text: "nowledge" }],
        properties: { Rule: { id: "prop1", type: "title" } },
      }),
    ]);
    expect(await h.client.dataSource("DS1")).toEqual({
      id: "DS1",
      name: "Team Knowledge",
      properties: { Rule: { id: "prop1", type: "title" } },
    });
    expect(h.calls[0].url).toBe(`${BASE}/v1/data_sources/DS1`);
  });

  it("dataSource() prefers body.name over the title", async () => {
    const h = makeHarness([
      jsonBody({ id: "DS1", name: "Team Knowledge", title: [{ plain_text: "ignored" }], properties: {} }),
    ]);
    expect((await h.client.dataSource("DS1")).name).toBe("Team Knowledge");
  });

  it("queryAll follows next_cursor until has_more is false, page_size 100, no start_cursor on the first call", async () => {
    const h = makeHarness([
      jsonBody({ has_more: true, next_cursor: "CUR_2", results: [{ id: "PAGE1" }] }),
      jsonBody({ has_more: true, next_cursor: "CUR_3", results: [{ id: "PAGE2" }] }),
      jsonBody({ has_more: false, results: [{ id: "PAGE3" }] }),
    ]);
    const pages = await h.client.queryAll("DS1", { filter: { property: "Date", date: { on_or_after: "2026-11-11" } } });
    expect(pages.map((p) => p.id)).toEqual(["PAGE1", "PAGE2", "PAGE3"]);
    expect(h.calls).toHaveLength(3); // has_more false on page 3: no 4th call
    expect(h.calls.map((c) => c.url)).toEqual([
      `${BASE}/v1/data_sources/DS1/query`,
      `${BASE}/v1/data_sources/DS1/query`,
      `${BASE}/v1/data_sources/DS1/query`,
    ]);
    const bodies = h.calls.map((c) => JSON.parse(c.init.body ?? "{}"));
    expect(bodies[0]).toEqual({ filter: { property: "Date", date: { on_or_after: "2026-11-11" } }, page_size: 100 });
    expect(bodies[1]).toEqual({ filter: { property: "Date", date: { on_or_after: "2026-11-11" } }, page_size: 100, start_cursor: "CUR_2" });
    // Page 2 said has_more with CUR_3, so the third call carries it; the loop
    // then stops on page 3's has_more: false.
    expect(bodies[2].start_cursor).toBe("CUR_3");
    expect(h.calls.every((c) => c.init.method === "POST")).toBe(true);
    expect(h.calls.every((c) => c.init.headers?.["Content-Type"] === "application/json")).toBe(true);
  });

  it("listChildren paginates with start_cursor and concatenates results", async () => {
    const h = makeHarness([
      jsonBody({ has_more: true, next_cursor: "CUR_B", results: [{ id: "BLOCK1", type: "paragraph" }] }),
      jsonBody({ has_more: false, results: [{ id: "BLOCK2", type: "heading_1" }] }),
    ]);
    const blocks = await h.client.listChildren("BLOCK_PARENT");
    expect(blocks.map((b) => b.id)).toEqual(["BLOCK1", "BLOCK2"]);
    expect(h.calls.map((c) => c.url)).toEqual([
      `${BASE}/v1/blocks/BLOCK_PARENT/children?page_size=100`,
      `${BASE}/v1/blocks/BLOCK_PARENT/children?page_size=100&start_cursor=CUR_B`,
    ]);
    expect(h.calls[0].init.method).toBe("GET");
  });

  it("appendChildren PATCHes children and returns body.results", async () => {
    const children: NotionBlockInput[] = [{ object: "block", type: "paragraph", paragraph: { rich_text: [{ text: { content: "hello" } }] } }];
    const h = makeHarness([jsonBody({ results: [{ id: "BLOCK_NEW1", type: "paragraph" }] })]);
    const results = await h.client.appendChildren("BLOCK_PARENT", children);
    expect(results).toEqual([{ id: "BLOCK_NEW1", type: "paragraph" }]);
    expect(h.calls[0].url).toBe(`${BASE}/v1/blocks/BLOCK_PARENT/children`);
    expect(h.calls[0].init.method).toBe("PATCH");
    expect(JSON.parse(h.calls[0].init.body ?? "{}")).toEqual({ children });
  });

  it("createPage POSTs /v1/pages with the body forwarded", async () => {
    const pageBody = { parent: { type: "data_source_id", data_source_id: "DS1" }, properties: {} };
    const h = makeHarness([jsonBody({ id: "PAGE_NEW", url: "https://www.notion.so/PAGE_NEW" })]);
    const page = await h.client.createPage(pageBody);
    expect(page.id).toBe("PAGE_NEW");
    expect(h.calls[0].url).toBe(`${BASE}/v1/pages`);
    expect(h.calls[0].init.method).toBe("POST");
    expect(JSON.parse(h.calls[0].init.body ?? "{}")).toEqual(pageBody);
  });

  it("trashPage PATCHes in_trash true", async () => {
    const h = makeHarness([jsonBody({ id: "PAGE_NEW", in_trash: true })]);
    await h.client.trashPage("PAGE_NEW");
    expect(h.calls[0].url).toBe(`${BASE}/v1/pages/PAGE_NEW`);
    expect(h.calls[0].init.method).toBe("PATCH");
    expect(JSON.parse(h.calls[0].init.body ?? "{}")).toEqual({ in_trash: true });
  });
});
