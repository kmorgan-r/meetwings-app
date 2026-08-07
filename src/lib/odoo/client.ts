import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import type { OdooConfig } from "@/types";
import { odooError, OdooError } from "./errors";
import { setOdooRedactor } from "./redactor";
import { buildMethodCall, decodeResponse, type XmlRpcValue } from "./xmlrpc-codec";

/**
 * Odoo XML-RPC transport.
 *
 * Two things differ from a plain `fetch` client and both are load-bearing:
 *
 * 1. tauriFetch, per CLAUDE.md - a webview fetch to a bare-IP Odoo host hits
 *    CORS and mixed-content blocking.
 * 2. The failure DISCRIMINATOR cannot be error.name. plugin-http rejects an
 *    aborted request with the plain string "Request canceled" marshalled out of
 *    the Rust Error::RequestCanceled, and DNS/refused/TLS arrive as reqwest
 *    error strings through invoke - never a DOMException or a TypeError. So
 *    `reason` is derived from our own signal and status, which is the pattern
 *    the rest of this repo already uses (useCompletion.ts:936,947).
 */
export const DEFAULT_TIMEOUT_MS = 30_000;

export interface OdooClient {
  authenticate(): Promise<number>;
  execute(
    model: string,
    method: string,
    args: XmlRpcValue[],
    kwargs?: Record<string, XmlRpcValue>
  ): Promise<XmlRpcValue>;
  /** The HTTP `Date` header of the last successful response, or `null` if none has landed yet. */
  serverDate: string | null;
}

export function createOdooClient(config: OdooConfig): OdooClient {
  // Arming is STRUCTURAL, not a convention observed elsewhere. loadOdooConfig
  // also arms, but a client can be built from a config that never went through
  // storage - "Test connection" on unsaved form values is exactly that - and
  // then the credentials go on the wire with nothing armed to strip them back
  // out of the failure. Doing it here means no client can exist without the
  // redactor holding the very secrets that client sends.
  setOdooRedactor([config.apiKey, config.login]);

  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let cachedUid: number | null = null;
  let lastServerDate: string | null = null;

  async function post(endpoint: string, body: string): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await tauriFetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "text/xml" },
        body,
        signal: controller.signal,
      });
      if (!response.ok) {
        throw odooError("ODOO_UNREACHABLE", `Odoo returned HTTP ${response.status}`, {
          reason: "http",
          status: response.status,
        });
      }
      lastServerDate = response.headers.get("date");
      // The abort only covers the REQUEST phase: once headers arrive,
      // plugin-http streams the body through a channel that checks the signal
      // only when a message arrives, so a host that returns headers and then
      // stalls hangs here with the signal already aborted. Race it.
      return await Promise.race([
        response.text(),
        new Promise<never>((_resolve, reject) => {
          controller.signal.addEventListener("abort", () =>
            reject(
              odooError("ODOO_UNREACHABLE", "Odoo stopped responding mid-body", {
                reason: "timeout",
              })
            )
          );
        }),
      ]);
    } catch (thrown) {
      // `instanceof OdooError`, NOT `toOdooError(thrown).code !== "ODOO_INTERNAL"`.
      // The code check was a proxy for this test and a leaky one: a genuine
      // ODOO_INTERNAL raised inside the try - by the codec, or by odooError
      // itself - looks identical to a mapped foreign throwable under it, and
      // gets relabelled ODOO_UNREACHABLE, reporting a healthy server as down.
      if (thrown instanceof OdooError) throw thrown;
      throw odooError("ODOO_UNREACHABLE", "Odoo is unreachable", {
        reason: controller.signal.aborted ? "timeout" : "network",
        // `endpoint` is in the port (odooClient.ts:70) and was dropped in the
        // first draft. Without it a multi-endpoint failure cannot be placed.
        // odooError() redacts it at construction like every other detail.
        endpoint,
        detail: thrown instanceof Error ? thrown.message : String(thrown),
      });
    } finally {
      clearTimeout(timer);
    }
  }

  async function call(
    endpoint: string,
    method: string,
    params: unknown[]
  ): Promise<XmlRpcValue> {
    const raw = await post(endpoint, buildMethodCall(method, params));
    const decoded = decodeResponse(raw);
    if (decoded.kind === "fault") {
      // faultCode/faultString go in details and NEVER become the code: the
      // transport reuses faultCode for HTTP statuses. faultString is a Python
      // traceback that routinely echoes the request payload, so it is redacted
      // by odooError() at construction like everything else.
      throw odooError("ODOO_FAULT", `Odoo fault ${decoded.faultCode}`, {
        faultCode: decoded.faultCode,
        faultString: decoded.faultString,
      });
    }
    return decoded.value;
  }

  async function authenticate(): Promise<number> {
    const uid = await call(`${config.url}/xmlrpc/2/common`, "authenticate", [
      config.db,
      config.login,
      config.apiKey,
      {},
    ]);
    if (typeof uid !== "number" || !Number.isInteger(uid) || uid <= 0) {
      throw odooError(
        "ODOO_AUTH_FAILED",
        "Odoo rejected the credentials - check the API key, login and database",
        { received: typeof uid === "boolean" ? String(uid) : typeof uid }
      );
    }
    cachedUid = uid;
    return uid;
  }

  async function execute(
    model: string,
    method: string,
    args: XmlRpcValue[],
    kwargs: Record<string, XmlRpcValue> = {}
  ): Promise<XmlRpcValue> {
    if (cachedUid === null) await authenticate();
    return call(`${config.url}/xmlrpc/2/object`, "execute_kw", [
      config.db,
      cachedUid,
      config.apiKey,
      model,
      method,
      args,
      kwargs,
    ]);
  }

  return {
    authenticate,
    execute,
    get serverDate() {
      return lastServerDate;
    },
  };
}
