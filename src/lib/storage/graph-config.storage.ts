import { secureGet, secureSet } from "@/lib/secure-storage";

export const SECURE_GRAPH_CONFIG_KEY = "secure_graph_config";

/**
 * `/organizations`, NOT `/common`: personal MSA accounts are out of scope for
 * this feature, and narrowing the authority is one of the four registration
 * hygiene measures the design relies on (the others: loopback-only redirect
 * URIs, public client flows disabled, minimum scopes).
 */
export const DEFAULT_AUTHORITY = "https://login.microsoftonline.com/organizations";

export interface GraphConfig {
  /**
   * NOT a secret. A public client ID travels in every authorize URL and is
   * trivially extracted from any native binary, so it is stored beside the
   * Odoo config and passed to Rust on every command rather than persisted
   * there.
   */
  clientId: string;
  authority: string;
}

/**
 * "Absent" and "unreadable" are DIFFERENT states, and this function must not
 * collapse them - the same distinction `loadOdooConfigState` already draws
 * ("Throws ODOO_INTERNAL on an unreadable blob; never throws for 'not set up'").
 *
 * `absent` is the routine v1 state: the app ships no client ID, so almost every
 * user is here, and the correct response is a statically-absent proposal block
 * and a picker identical to today's. `unreadable` is a real failure - a config
 * that once worked and whose store is now corrupt - and returning `absent` for
 * it would take the whole feature away from a previously-connected user with
 * nothing on screen to say why.
 *
 * `unreadable` deliberately carries `config: null`, not the raw values that
 * failed validation - this is the shape Task 13's mocks pin. The consequence
 * is that a caller wanting to prefill a form (the /odoo page's seeding effect)
 * cannot recover an invalid stored authority to show it back to the user; it
 * shows blank fields instead. Accepted v1 limitation - do not widen this arm
 * to work around it.
 */
export type GraphConfigState =
  | { state: "absent"; config: null }
  | { state: "unreadable"; config: null }
  | { state: "complete"; config: GraphConfig };

/**
 * Pure classification of an already-parsed blob. Split out of
 * `loadGraphConfigState` so `/odoo`'s Connect handler can classify the
 * in-memory form the same way storage does, without a save-then-reload round
 * trip through secure storage just to find out whether the form is complete.
 */
export function classifyGraphConfig(parsed: Partial<GraphConfig>): GraphConfigState {
  const clientId = (parsed.clientId ?? "").trim();
  // A blank client ID is "not set up yet", not corruption: the fields exist
  // and are empty, which is exactly what a half-finished setup looks like.
  if (clientId === "") return { state: "absent", config: null };

  const authorityInput = (parsed.authority ?? "").trim();
  // Trailing slash(es) stripped HERE, the one place both the admin-consent URL
  // and the value passed to Rust are built from, so neither has to patch a
  // doubled slash after the fact. Rust re-defends with the same
  // trim_end_matches('/') at auth.rs:333 and :426; this is belt-and-braces,
  // not the only guard.
  const resolved = (authorityInput === "" ? DEFAULT_AUTHORITY : authorityInput).replace(
    /\/+$/,
    ""
  );
  // Validated here as well as in Rust. Rust's check is the one that actually
  // protects the credentials (see auth::validate_authority); this one exists so
  // the /odoo page can say something useful instead of surfacing a bare
  // GRAPH_AUTH_REJECTED from deep in the connect flow.
  if (!isHttpsUrl(resolved)) return { state: "unreadable", config: null };

  return { state: "complete", config: { clientId, authority: resolved } };
}

export async function loadGraphConfigState(): Promise<GraphConfigState> {
  let raw: string | null;
  try {
    raw = await secureGet(SECURE_GRAPH_CONFIG_KEY);
  } catch {
    return { state: "unreadable", config: null };
  }
  if (!raw) return { state: "absent", config: null };

  let parsed: Partial<GraphConfig>;
  try {
    parsed = JSON.parse(raw) as Partial<GraphConfig>;
  } catch {
    return { state: "unreadable", config: null };
  }

  return classifyGraphConfig(parsed);
}

export function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Thin wrapper for the callers that only need the config and treat every
 * non-complete state the same way. `useCalendarProposal` does NOT use this -
 * it needs to tell "absent" from "unreadable" apart to decide between a silent
 * absence and an error state.
 */
export async function loadGraphConfig(): Promise<GraphConfig | null> {
  return (await loadGraphConfigState()).config;
}

export async function saveGraphConfig(config: GraphConfig): Promise<void> {
  await secureSet(
    SECURE_GRAPH_CONFIG_KEY,
    JSON.stringify({
      clientId: config.clientId.trim(),
      authority: config.authority.trim(),
    })
  );
}
