import { secureGet, secureSet } from "@/lib/secure-storage";

export const SECURE_GOOGLE_CONFIG_KEY = "secure_google_config";

/** Dispatched after connect/disconnect so listeners re-read the connection. */
export const GOOGLE_CONNECTION_CHANGED_EVENT = "google-connection-changed";

export interface GoogleConfig {
  clientId: string;
  /** Secret: stored through secureSet only, never localStorage, never logged. */
  clientSecret: string;
}

/**
 * "Absent" and "unreadable" are different states (same split as Graph): absent
 * is the routine not-set-up state, unreadable is a corrupt or locked store.
 */
export type GoogleConfigState =
  | { state: "absent"; config: null }
  | { state: "unreadable"; config: null }
  | { state: "complete"; config: GoogleConfig };

/** A blank client ID or secret is absent: a half-finished setup has no calendar to read. */
export function classifyGoogleConfig(parsed: Partial<GoogleConfig>): GoogleConfigState {
  const clientId = (parsed.clientId ?? "").trim();
  const clientSecret = (parsed.clientSecret ?? "").trim();
  if (clientId === "" || clientSecret === "") return { state: "absent", config: null };
  return { state: "complete", config: { clientId, clientSecret } };
}

export async function loadGoogleConfigState(): Promise<GoogleConfigState> {
  let raw: string | null;
  try {
    raw = await secureGet(SECURE_GOOGLE_CONFIG_KEY);
  } catch {
    return { state: "unreadable", config: null };
  }
  if (!raw) return { state: "absent", config: null };

  let parsed: Partial<GoogleConfig>;
  try {
    parsed = JSON.parse(raw) as Partial<GoogleConfig>;
  } catch {
    return { state: "unreadable", config: null };
  }
  // Parsed but the wrong shape: unreadable, never a throw (callers rely on a
  // non-rejecting read).
  if (typeof parsed !== "object" || parsed === null) return { state: "unreadable", config: null };
  for (const v of [parsed.clientId, parsed.clientSecret]) {
    if (v !== undefined && typeof v !== "string") return { state: "unreadable", config: null };
  }
  return classifyGoogleConfig(parsed);
}

export async function saveGoogleConfig(c: GoogleConfig): Promise<void> {
  await secureSet(
    SECURE_GOOGLE_CONFIG_KEY,
    JSON.stringify({ clientId: c.clientId.trim(), clientSecret: c.clientSecret.trim() })
  );
}
