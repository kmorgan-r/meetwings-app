import type { OdooErrorCode } from "@/types";
import { getRedactor, isRedactorInitialised } from "./redactor";

export type OdooErrorDetails = Record<string, string | number>;

/**
 * Every failure in this feature is one of these.
 *
 * `message` and every `details` value are redacted AT CONSTRUCTION, not at
 * display. That is what closes the two escape paths nothing downstream can
 * catch: an unhandled rejection, and a React error boundary (the boundaries at
 * src/pages/app/index.tsx:39 and src/layouts/DashboardLayout.tsx:24 use
 * fallbackRender with no onError, and createRoot sets no onCaughtError, so
 * React's default console.error would print the raw error and stack).
 *
 * There is deliberately NO `cause`: the port attaches the raw fetch Error,
 * whose message can carry the request body.
 */
export class OdooError extends Error {
  readonly code: OdooErrorCode;
  readonly details: OdooErrorDetails;

  constructor(code: OdooErrorCode, message: string, details: OdooErrorDetails) {
    super(message);
    this.name = "OdooError";
    this.code = code;
    this.details = details;
  }
}

export function odooError(
  code: OdooErrorCode,
  message: string,
  details: OdooErrorDetails = {}
): OdooError {
  const redact = getRedactor();
  const safeDetails: OdooErrorDetails = {};
  for (const [key, value] of Object.entries(details)) {
    safeDetails[key] = typeof value === "number" ? value : redact(value);
  }
  return new OdooError(code, redact(message), safeDetails);
}

/**
 * The boundary catch. SQLite (plugin-sql) and plugin-store throw plain Errors
 * that are not OdooError at all; re-throwing them raw would leave a failure
 * with no code, which no UI in this feature can render.
 */
export function toOdooError(thrown: unknown): OdooError {
  if (thrown instanceof OdooError) return thrown;
  const detail = thrown instanceof Error ? thrown.message : String(thrown);
  return odooError("ODOO_INTERNAL", "Something failed outside Odoo", { detail });
}

export interface OdooErrorReport {
  code: OdooErrorCode;
  message: string;
  details: OdooErrorDetails;
}

/**
 * The single reporting choke point. Every toast and every log line in this
 * feature is built from this and nothing else.
 *
 * It builds the object explicitly rather than JSON.stringify(err): `message`
 * and `stack` are non-enumerable own properties of Error, so stringifying an
 * Error silently drops exactly the field we most need to redact and show.
 */
export function reportOdooError(thrown: unknown, where: string): OdooErrorReport {
  const err = toOdooError(thrown);
  if (!isRedactorInitialised()) {
    // We cannot prove the text is clean, so we show only the code.
    return { code: err.code, message: err.code, details: {} };
  }
  const redact = getRedactor();
  return {
    code: err.code,
    message: redact(err.message),
    details: { ...err.details, where: redact(where) },
  };
}
