import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The default mock is a bare vi.fn, so an unmocked call resolves to undefined
// and fails loudly on `.status` instead of silently hitting the network.
vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: vi.fn(),
}));

// A bare webview fetch is not intercepted by the plugin-http mock either: fail
// loudly if one ever sneaks through (same guard as notion-client.test.ts).
global.fetch = vi.fn(() => {
  throw new Error("webview fetch is forbidden");
}) as unknown as typeof fetch;

import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { GIST_API_BASE, TEAM_FETCH_TIMEOUT_MS, fetchTeamBlob } from "@/lib/team/team-fetch";

// Fake id only - never a real gist id.
const ID = "b".repeat(32);
const OWNER = "octo-cat";

type FakeResponseInit = {
  status?: number;
  body?: string;
};

/** Fake response: only the fields fetchTeamBlob is allowed to read. */
function gistResponse({ status = 200, body = "" }: FakeResponseInit = {}): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: () => Promise.resolve(body),
  } as unknown as Response;
}

/** A gist API body; it carries `owner.login` unless `body` overrides `owner`. */
function gistJson(body: Record<string, unknown>): Response {
  return gistResponse({ body: JSON.stringify({ owner: { login: OWNER }, ...body }) });
}

const blobOf = (blob: string, ownerLogin = OWNER) => ({ ok: true, value: { blob, ownerLogin } });
const VALID_FILES = { files: { "team.txt": { content: "mwt1.x.y" } } };

function okResponseWithTextBody(text: string): Response {
  return { status: 200, ok: true, text: () => Promise.resolve(text) } as unknown as Response;
}

describe("fetchTeamBlob", () => {
  beforeEach(() => {
    vi.mocked(tauriFetch).mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns the blob and calls only the gist API with redirects off", async () => {
    vi.mocked(tauriFetch).mockResolvedValue(gistJson({ files: { "team.txt": { content: "mwt1.x.y", truncated: false } } }));

    const result = await fetchTeamBlob(ID);

    expect(result).toEqual(blobOf("mwt1.x.y"));
    expect(tauriFetch).toHaveBeenCalledTimes(1);
    expect(tauriFetch).toHaveBeenCalledWith(
      GIST_API_BASE + ID,
      expect.objectContaining({
        method: "GET",
        maxRedirections: 0,
        connectTimeout: TEAM_FETCH_TIMEOUT_MS,
        headers: expect.objectContaining({
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        }),
      }),
    );
  });

  it("accepts a valid 20-character hex gist id and sends it to the gist API", async () => {
    const gistId = "c".repeat(20);
    vi.mocked(tauriFetch).mockResolvedValue(gistJson({ files: { "team.txt": { content: "mwt1.x.y" } } }));

    const result = await fetchTeamBlob(gistId);

    expect(result).toEqual(blobOf("mwt1.x.y"));
    expect(tauriFetch).toHaveBeenCalledWith(GIST_API_BASE + gistId, expect.anything());
  });

  it.each([404, 500, 301])("status %i -> TEAM_FETCH_FAILED", async (status) => {
    vi.mocked(tauriFetch).mockResolvedValue(gistResponse({ status }));

    const result = await fetchTeamBlob(ID);

    expect(result).toEqual({ ok: false, code: "TEAM_FETCH_FAILED" });
  });

  it("network error -> TEAM_FETCH_FAILED", async () => {
    vi.mocked(tauriFetch).mockRejectedValue(new Error("connection refused"));

    const result = await fetchTeamBlob(ID);

    expect(result).toEqual({ ok: false, code: "TEAM_FETCH_FAILED" });
  });

  it("the headers never arrive -> TEAM_FETCH_FAILED exactly at TEAM_FETCH_TIMEOUT_MS and the signal is aborted", async () => {
    vi.useFakeTimers();
    vi.mocked(tauriFetch).mockImplementation(() => new Promise<Response>(() => {}));

    const pending = fetchTeamBlob(ID);
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(TEAM_FETCH_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    const result = await pending;

    expect(result).toEqual({ ok: false, code: "TEAM_FETCH_FAILED" });
    const options = vi.mocked(tauriFetch).mock.calls[0][1] as RequestInit;
    expect(options.signal?.aborted).toBe(true);
  });

  it("headers arrive but the body never does -> TEAM_FETCH_FAILED after TEAM_FETCH_TIMEOUT_MS and the signal is aborted", async () => {
    vi.useFakeTimers();
    vi.mocked(tauriFetch).mockResolvedValue({
      status: 200,
      ok: true,
      text: () => new Promise<string>(() => {}),
    } as unknown as Response);

    const pending = fetchTeamBlob(ID);
    await vi.advanceTimersByTimeAsync(TEAM_FETCH_TIMEOUT_MS);
    // Bound the wait so a regression (stalled body raced by nothing) fails
    // instead of hanging: the sentinel losing is the assertion.
    const result = await Promise.race([pending, Promise.resolve({ ok: true, value: "sentinel-won" })]);

    expect(result).toEqual({ ok: false, code: "TEAM_FETCH_FAILED" });
    const options = vi.mocked(tauriFetch).mock.calls[0][1] as RequestInit;
    expect(options.signal?.aborted).toBe(true);
  });

  it("200 with a body that is not JSON -> TEAM_FETCH_FAILED", async () => {
    vi.mocked(tauriFetch).mockResolvedValue(okResponseWithTextBody("<html>gateway error</html>"));

    const result = await fetchTeamBlob(ID);

    expect(result).toEqual({ ok: false, code: "TEAM_FETCH_FAILED" });
  });

  it.each([{}, { files: null }, { files: "x" }, { files: [] }])("200 with malformed files %j -> TEAM_FETCH_FAILED, no throw", async (body) => {
    vi.mocked(tauriFetch).mockResolvedValue(gistJson(body));

    const result = await fetchTeamBlob(ID);

    expect(result).toEqual({ ok: false, code: "TEAM_FETCH_FAILED" });
  });

  it("a file whose content is not a string is skipped", async () => {
    vi.mocked(tauriFetch).mockResolvedValue(gistJson({ files: { a: { content: null }, b: { content: "mwt1.x.y" } } }));

    const result = await fetchTeamBlob(ID);

    expect(result).toEqual(blobOf("mwt1.x.y"));
  });

  it("picks the mwt1 file next to a README and trims the trailing newline", async () => {
    vi.mocked(tauriFetch).mockResolvedValue(
      gistJson({ files: { "README.md": { content: "hello\n" }, "team.txt": { content: "mwt1.x.y\n" } } }),
    );

    const result = await fetchTeamBlob(ID);

    expect(result).toEqual(blobOf("mwt1.x.y"));
  });

  it("two mwt1 files -> TEAM_FILE_INVALID", async () => {
    vi.mocked(tauriFetch).mockResolvedValue(gistJson({ files: { a: { content: "mwt1.one" }, b: { content: "mwt1.two" } } }));

    const result = await fetchTeamBlob(ID);

    expect(result).toEqual({ ok: false, code: "TEAM_FILE_INVALID" });
  });

  it("no files -> TEAM_FILE_INVALID", async () => {
    vi.mocked(tauriFetch).mockResolvedValue(gistJson({ files: {} }));

    const result = await fetchTeamBlob(ID);

    expect(result).toEqual({ ok: false, code: "TEAM_FILE_INVALID" });
  });

  it("truncated file -> TEAM_FILE_INVALID", async () => {
    vi.mocked(tauriFetch).mockResolvedValue(gistJson({ files: { "team.txt": { content: "mwt1.x.y", truncated: true } } }));

    const result = await fetchTeamBlob(ID);

    expect(result).toEqual({ ok: false, code: "TEAM_FILE_INVALID" });
  });

  it.each(["", "short", "Z".repeat(32), "c".repeat(33), `${"b".repeat(20)}!`])(
    "malformed gist id %j -> TEAM_LINK_INVALID and no request",
    async (gistId) => {
      const result = await fetchTeamBlob(gistId);

      expect(result).toEqual({ ok: false, code: "TEAM_LINK_INVALID" });
      expect(tauriFetch).not.toHaveBeenCalled();
    },
  );

  it.each(["a", "Team-Owner-1", "x".repeat(39)])("returns the gist owner's login %j with the blob", async (login) => {
    vi.mocked(tauriFetch).mockResolvedValue(gistJson({ owner: { login }, ...VALID_FILES }));

    const result = await fetchTeamBlob(ID);

    expect(result).toEqual(blobOf("mwt1.x.y", login));
  });

  it.each([
    ["no owner", { ...VALID_FILES }],
    ["owner null", { owner: null, ...VALID_FILES }],
    ["owner without login", { owner: {}, ...VALID_FILES }],
  ])("%s -> TEAM_FETCH_FAILED", async (_name, body) => {
    vi.mocked(tauriFetch).mockResolvedValue(gistResponse({ body: JSON.stringify(body) }));

    const result = await fetchTeamBlob(ID);

    expect(result).toEqual({ ok: false, code: "TEAM_FETCH_FAILED" });
  });

  it.each<unknown>(["a b", "", "x".repeat(40), "-lead", "a_b", 42, null, ["octo"]])(
    "owner.login %j has a bad shape -> TEAM_FETCH_FAILED",
    async (login) => {
      vi.mocked(tauriFetch).mockResolvedValue(gistJson({ owner: { login }, ...VALID_FILES }));

      const result = await fetchTeamBlob(ID);

      expect(result).toEqual({ ok: false, code: "TEAM_FETCH_FAILED" });
    },
  );
});
