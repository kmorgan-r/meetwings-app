import type { GraphErrorCode } from "@/types";

export type GraphErrorDetails = Record<string, string | number>;

const CODES: ReadonlySet<string> = new Set<GraphErrorCode>([
  "GRAPH_NOT_CONNECTED",
  "GRAPH_CONSENT_REQUIRED",
  "GRAPH_AUTH_CANCELLED",
  "GRAPH_AUTH_EXPIRED",
  "GRAPH_AUTH_REJECTED",
  "GRAPH_BAD_RESPONSE",
  "GRAPH_THROTTLED",
  "GRAPH_NETWORK",
  "GRAPH_NO_KEYCHAIN",
]);

/**
 * `message` IS the code. There is deliberately no free-text message parameter:
 * meeting subjects and attendee addresses are per-event values that no
 * pre-built needle list can redact, so they are never passed in at all.
 *
 * `details` takes only non-identifying values - counts, retry seconds, the
 * operation name. Never an address, never a subject, never a token.
 */
export class GraphError extends Error {
  readonly code: GraphErrorCode;
  readonly details: GraphErrorDetails;

  constructor(code: GraphErrorCode, details: GraphErrorDetails) {
    super(code);
    this.name = "GraphError";
    this.code = code;
    this.details = details;
  }
}

export function graphError(
  code: GraphErrorCode,
  details: GraphErrorDetails = {}
): GraphError {
  return new GraphError(code, details);
}

/**
 * The boundary catch. Rust returns a BARE `GRAPH_*` code string as its Err
 * value, which `invoke` rejects with; `plugin-sql` and friends throw plain
 * Errors that are not GraphError at all.
 *
 * DELIBERATE DIVERGENCE from toOdooError: the thrown value's text is DROPPED,
 * not attached as a `detail`. A subject or address lifted from a raw reqwest
 * or serde failure would otherwise survive into the report.
 */
export function toGraphError(thrown: unknown): GraphError {
  if (thrown instanceof GraphError) return thrown;
  const raw = thrown instanceof Error ? thrown.message : String(thrown);
  return CODES.has(raw)
    ? new GraphError(raw as GraphErrorCode, {})
    : new GraphError("GRAPH_NETWORK", {});
}

export interface GraphErrorReport {
  code: GraphErrorCode;
  message: string;
  details: GraphErrorDetails;
}

/**
 * The single reporting choke point, mirroring reportOdooError - except that
 * `message` is always the code. There is no isRedactorInitialised branch here
 * because there is nothing to redact: nothing identifying was ever put in.
 */
export function reportGraphError(thrown: unknown, where: string): GraphErrorReport {
  const err = toGraphError(thrown);
  return {
    code: err.code,
    message: err.code,
    details: { ...err.details, where },
  };
}
