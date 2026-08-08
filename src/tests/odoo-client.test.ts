import { beforeEach, describe, expect, it, vi } from "vitest";

// The default mock THROWS, so an unstubbed call fails as "unexpected network
// call" rather than as "Cannot read properties of undefined".
vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: vi.fn(() => {
    throw new Error("unexpected network call: stub tauriFetch in this test");
  }),
}));

// The mock above does NOT intercept a bare webview fetch, so an accidental
// `fetch(...)` would leak to the real network under happy-dom. Fail loudly.
global.fetch = vi.fn(() => {
  throw new Error("webview fetch is forbidden here - use tauriFetch");
}) as unknown as typeof fetch;

import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { createOdooClient } from "@/lib/odoo/client";
import { OdooError } from "@/lib/odoo/errors";
import { isRedactorInitialised, resetOdooRedactor, setOdooRedactor } from "@/lib/odoo/redactor";

const mockFetch = vi.mocked(tauriFetch);

const KEY = 'a1b2&c3d4<e5f6>g7h8"i9j0';
const LOGIN = 'bob&<test>@example.com';
const CONFIG = { url: "http://157.151.163.177:8069", db: "odoo", login: LOGIN, apiKey: KEY };

// `headers` is NOT decoration. Task 8 Step 3 adds
// `lastServerDate = response.headers.get("date")` to post(), so a fixture
// without a headers object turns every Task 4 test into a TypeError the moment
// Task 8 lands. Every stubbed Response in this file carries one.
const HEADERS = () => new Headers({ date: "Tue, 04 Aug 2026 12:00:00 GMT" });

function xmlResponse(inner: string, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Server Error",
    headers: HEADERS(),
    text: async () =>
      `<?xml version="1.0"?><methodResponse><params><param>${inner}</param></params></methodResponse>`,
  } as unknown as Response;
}

// The faultString is XML-escaped, because that is how a real fault carrying a
// key with `&` and `<` in it arrives - and the escaped form is exactly the
// needle a naive replaceAll(key, '***') misses.
function faultResponse(faultString: string, faultCode = 3): Response {
  const escaped = faultString
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return {
    ok: true,
    status: 200,
    headers: HEADERS(),
    text: async () =>
      '<?xml version="1.0"?><methodResponse><fault><value><struct>' +
      `<member><name>faultCode</name><value><int>${faultCode}</int></value></member>` +
      `<member><name>faultString</name><value><string>${escaped}</string></value></member>` +
      "</struct></value></fault></methodResponse>",
  } as unknown as Response;
}

async function codeOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (err) {
    return err instanceof OdooError ? err.code : `not-an-OdooError:${String(err)}`;
  }
  return "no-throw";
}

describe("createOdooClient", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    resetOdooRedactor();
    setOdooRedactor([KEY, LOGIN]);
  });

  it("authenticates and returns the uid", async () => {
    mockFetch.mockResolvedValueOnce(xmlResponse("<value><int>7</int></value>"));
    await expect(createOdooClient(CONFIG).authenticate()).resolves.toBe(7);
    expect(mockFetch.mock.calls[0][0]).toBe("http://157.151.163.177:8069/xmlrpc/2/common");
  });

  // Odoo answers bad credentials with HTTP 200 and a well-formed
  // <boolean>0</boolean>: no transport error, no fault. Without this guard the
  // settings page reports a resolved uid of `false` and execute_kw then ships
  // `false` in the uid slot, surfacing later as a confusing ODOO_FAULT.
  it("treats a false uid on HTTP 200 as ODOO_AUTH_FAILED", async () => {
    mockFetch.mockResolvedValueOnce(xmlResponse("<value><boolean>0</boolean></value>"));
    expect(await codeOf(() => createOdooClient(CONFIG).authenticate())).toBe("ODOO_AUTH_FAILED");
  });

  it.each([0, -1, 1.5])("treats a non-positive-integer uid (%s) as ODOO_AUTH_FAILED", async (uid) => {
    const inner = Number.isInteger(uid)
      ? `<value><int>${uid}</int></value>`
      : `<value><double>${uid}</double></value>`;
    mockFetch.mockResolvedValueOnce(xmlResponse(inner));
    expect(await codeOf(() => createOdooClient(CONFIG).authenticate())).toBe("ODOO_AUTH_FAILED");
  });

  // Deliberate divergence from the port, which re-stamps faults during
  // authenticate as AUTH_FAILED. A wrong `db` faults with a readable message
  // and the user needs to see it.
  it("keeps a fault as ODOO_FAULT during authenticate", async () => {
    mockFetch.mockResolvedValueOnce(faultResponse("database odoo does not exist"));
    expect(await codeOf(() => createOdooClient(CONFIG).authenticate())).toBe("ODOO_FAULT");
  });

  // THE highest-value leak in the whole feature. An Odoo faultString is a
  // Python traceback that routinely echoes the request payload, and the
  // authenticate payload contains BOTH the api key and the login. This is the
  // only test that pins details.faultString specifically - the network-failure
  // leak test below exercises a rejected fetch Error, which is a different
  // code path entirely.
  it("redacts the api key AND the login out of a surfaced faultString", async () => {
    mockFetch.mockResolvedValueOnce(
      faultResponse(`Traceback: authenticate('odoo', '${LOGIN}', '${KEY}', {})`)
    );
    let caught: OdooError | null = null;
    try {
      await createOdooClient(CONFIG).authenticate();
    } catch (err) {
      caught = err as OdooError;
    }
    expect(caught?.code).toBe("ODOO_FAULT");
    const surfaced = `${caught?.message}${JSON.stringify(caught?.details)}`;
    expect(surfaced).not.toContain("i9j0");
    expect(surfaced).not.toContain("example.com");
    // ...and the traceback is still there, redacted rather than discarded.
    expect(String(caught?.details.faultString)).toContain("Traceback");
  });

  it("throws ODOO_MALFORMED_RESPONSE for a proxy login page", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: HEADERS(),
      text: async () => "<html><body>Sign in</body></html>",
    } as unknown as Response);
    expect(await codeOf(() => createOdooClient(CONFIG).authenticate())).toBe(
      "ODOO_MALFORMED_RESPONSE"
    );
  });

  // plugin-http rejects an aborted request with the plain string
  // "Request canceled" marshalled out of Rust - NOT a DOMException. So
  // error.name is `undefined` and the discriminator must come from the
  // client's own signal, exactly as useCompletion.ts:936,947 already does.
  //
  // The mock waits for the REAL abort instead of dispatching an abort Event.
  // Dispatching the event fires listeners but does NOT set `signal.aborted`,
  // and only `controller.abort()` does - so a dispatched event leaves the
  // discriminator reading `false` and the test fails against a CORRECT
  // implementation, reporting "network". Waiting on the signal also removes the
  // ordering assumption: the 1 ms timer is a macrotask and could not otherwise
  // fire before the rejection's microtask.
  it("reports a timeout as reason 'timeout', derived from its own signal", async () => {
    mockFetch.mockImplementationOnce(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          (init as { signal: AbortSignal }).signal.addEventListener("abort", () =>
            reject("Request canceled")
          );
        })
    );
    const client = createOdooClient({ ...CONFIG, timeoutMs: 1 });
    let caught: OdooError | null = null;
    try {
      await client.authenticate();
    } catch (err) {
      caught = err as OdooError;
    }
    expect(caught?.code).toBe("ODOO_UNREACHABLE");
    expect(caught?.details.reason).toBe("timeout");
  });

  it("reports a non-2xx as reason 'http' with the status", async () => {
    mockFetch.mockResolvedValueOnce(xmlResponse("<value><int>1</int></value>", 500));
    let caught: OdooError | null = null;
    try {
      await createOdooClient(CONFIG).authenticate();
    } catch (err) {
      caught = err as OdooError;
    }
    expect(caught?.code).toBe("ODOO_UNREACHABLE");
    expect(caught?.details.reason).toBe("http");
    expect(caught?.details.status).toBe(500);
  });

  it("reports a connection failure as reason 'network'", async () => {
    mockFetch.mockRejectedValueOnce(new Error("error sending request for url"));
    let caught: OdooError | null = null;
    try {
      await createOdooClient(CONFIG).authenticate();
    } catch (err) {
      caught = err as OdooError;
    }
    expect(caught?.details.reason).toBe("network");
  });

  it("never leaks the api key or the login in a surfaced error", async () => {
    mockFetch.mockRejectedValueOnce(
      new Error(`POST failed with body <string>${KEY}</string> as ${LOGIN}`)
    );
    let caught: OdooError | null = null;
    try {
      await createOdooClient(CONFIG).authenticate();
    } catch (err) {
      caught = err as OdooError;
    }
    const surfaced = `${caught?.message}${JSON.stringify(caught?.details)}`;
    expect(surfaced).not.toContain("i9j0");
    expect(surfaced).not.toContain("example.com");
  });

  // Arming used to be a CONVENTION: loadOdooConfig happened to call
  // setOdooRedactor, so a client built from a config object that never went
  // through storage - a settings-page "Test connection" against unsaved form
  // values, a test, a future caller - would send credentials with nothing armed
  // to strip them back out. createOdooClient arms it from its OWN config, which
  // makes the tie structural: the secrets that are redacted are by construction
  // the exact secrets this client sends.
  it("arms the redactor from its own config, with no help from storage", async () => {
    resetOdooRedactor();
    // Proves the precondition is real: nothing armed yet.
    expect(isRedactorInitialised()).toBe(false);
    mockFetch.mockRejectedValueOnce(new Error(`POST body <string>${KEY}</string> as ${LOGIN}`));
    const client = createOdooClient(CONFIG);
    // The assertion that actually binds this test to client.ts's arming call:
    // the fail-closed default in getRedactor() blanks the whole message
    // regardless of whether arming happened, so the string assertions below
    // cannot by themselves detect a missing `setOdooRedactor(...)` call.
    expect(isRedactorInitialised()).toBe(true);
    let caught: OdooError | null = null;
    try {
      await client.authenticate();
    } catch (err) {
      caught = err as OdooError;
    }
    const surfaced = `${caught?.message}${JSON.stringify(caught?.details)}`;
    expect(surfaced).not.toContain("i9j0");
    expect(surfaced).not.toContain("example.com");
  });

  // The catch in post() used to discriminate on `code !== "ODOO_INTERNAL"` as a
  // stand-in for `instanceof OdooError`. Those are not the same set: a genuine
  // ODOO_INTERNAL raised INSIDE the try - by the codec, or by odooError itself -
  // would be caught by the proxy and re-labelled ODOO_UNREACHABLE, reporting a
  // healthy server as unreachable.
  it("does not relabel an ODOO_INTERNAL raised inside the request", async () => {
    mockFetch.mockImplementationOnce(async () => {
      throw new OdooError("ODOO_INTERNAL", "codec blew up", {});
    });
    expect(await codeOf(() => createOdooClient(CONFIG).authenticate())).toBe("ODOO_INTERNAL");
  });

  // THREE queued responses for three requests. Two is not enough: the third
  // call falls through to the module factory's implementation, which throws
  // "unexpected network call" - and mockReset() in beforeEach RESTORES that
  // implementation rather than erasing it (Vitest 4 keeps the impl passed to
  // vi.fn(impl)), so the second execute rejects before the assertion runs.
  it("authenticates once, then reuses the uid for execute", async () => {
    mockFetch
      .mockResolvedValueOnce(xmlResponse("<value><int>7</int></value>"))
      .mockResolvedValueOnce(xmlResponse("<value><array><data/></array></value>"))
      .mockResolvedValueOnce(xmlResponse("<value><array><data/></array></value>"));
    const client = createOdooClient(CONFIG);
    await client.execute("res.partner", "search_read", [[]], { limit: 1 });
    await client.execute("res.partner", "search_read", [[]], { limit: 1 });
    // 1 authenticate + 2 execute
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(mockFetch.mock.calls[1][0]).toBe("http://157.151.163.177:8069/xmlrpc/2/object");
  });
});
