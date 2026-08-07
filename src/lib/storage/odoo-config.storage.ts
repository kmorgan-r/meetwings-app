import { odooError, toOdooError } from "@/lib/odoo/errors";
import { setOdooRedactor } from "@/lib/odoo/redactor";
import { secureDelete, secureGet, secureSet } from "@/lib/secure-storage";
import type { OdooConfig } from "@/types";

/**
 * Odoo credentials.
 *
 * Mirrors secure-provider-configs.ts, including its honest caveat: the
 * plugin-store file is plaintext JSON on disk, NOT encrypted at rest. The
 * settings page repeats that caveat where the key is entered.
 */
export const SECURE_ODOO_CONFIG_KEY = "secure_odoo_config";

/**
 * A stable identity for one Odoo database.
 *
 * Every cached row is scoped to this. Without it, pointing the app at a staging
 * database and back leaves a cache of ids that name DIFFERENT partners while
 * the advanced watermark stops the sync ever re-pulling them - and the
 * { contactId, leadId } handed to slice 2 is poisoned.
 *
 * Normalized so that a cosmetic edit (a trailing slash, a capitalised host)
 * does not read as a different instance and wipe the cache.
 */
export function instanceFingerprint(url: string, db: string): string {
  let normalized = url.trim().replace(/\/+$/, "");
  try {
    const parsed = new URL(normalized);
    parsed.protocol = parsed.protocol.toLowerCase();
    parsed.hostname = parsed.hostname.toLowerCase();
    normalized = parsed.origin + parsed.pathname.replace(/\/+$/, "");
  } catch {
    // Not a parseable URL - fall back to the trimmed string. A bad URL fails
    // loudly at Test connection; it must not throw here.
    normalized = normalized.toLowerCase();
  }
  return `${normalized}|${db.trim()}`;
}

function isComplete(c: Partial<OdooConfig>): c is OdooConfig {
  return Boolean(c.url && c.db && c.login && c.apiKey);
}

/**
 * "Nothing stored" and "stored but half-filled" are DIFFERENT states and the
 * user needs different sentences for them - one says "set Odoo up", the other
 * says "you already started, a field is blank". Collapsing both to `null` loses
 * that, so the state is returned explicitly and `loadOdooConfig` is a thin
 * wrapper over it. Existing callers that only want the config keep working.
 */
export type OdooConfigState =
  | { state: "absent"; config: null }
  | { state: "incomplete"; config: null; missing: string[] }
  | { state: "complete"; config: OdooConfig };

/** Throws ODOO_INTERNAL on an unreadable blob; never throws for "not set up". */
export async function loadOdooConfigState(): Promise<OdooConfigState> {
  let raw: string | null;
  try {
    raw = await secureGet(SECURE_ODOO_CONFIG_KEY);
  } catch (err) {
    throw toOdooError(err);
  }
  if (!raw) return { state: "absent", config: null };

  let parsed: Partial<OdooConfig>;
  try {
    parsed = JSON.parse(raw) as Partial<OdooConfig>;
  } catch (err) {
    throw toOdooError(err);
  }
  // Armed BEFORE the completeness check, not after.
  //
  // Redaction is fail-closed, so an error constructed while the redactor is
  // uninitialised has its message blanked and is then suppressed entirely by
  // reportOdooError. Arming only on the `complete` branch therefore made the
  // incomplete-config message unreachable in production: the user saw
  // "ODOO_NOT_CONFIGURED: ODOO_NOT_CONFIGURED" instead of "fill in db, apiKey",
  // and the test that asserts on that text only passed because it armed the
  // redactor by hand - a state nothing in production reaches on that path.
  //
  // Arming from a PARTIAL config is safe: setOdooRedactor filters empty and
  // undefined values, so a blank apiKey contributes no needle, and if every
  // value is blank the redactor stays uninitialised (fail-closed) exactly as
  // before.
  setOdooRedactor([parsed.apiKey, parsed.login]);

  if (!isComplete(parsed)) {
    // Field NAMES only. Never a value - one of them is the api key.
    const missing = (["url", "db", "login", "apiKey"] as const).filter(
      (field) => !parsed[field]
    );
    return { state: "incomplete", config: null, missing };
  }

  return { state: "complete", config: parsed };
}

/** Returns null for BOTH absent and incomplete. Prefer loadOdooConfigState. */
export async function loadOdooConfig(): Promise<OdooConfig | null> {
  return (await loadOdooConfigState()).config;
}

export async function requireOdooConfig(): Promise<OdooConfig> {
  const loaded = await loadOdooConfigState();
  if (loaded.state === "incomplete") {
    throw odooError(
      "ODOO_NOT_CONFIGURED",
      `Odoo is set up but incomplete - fill in ${loaded.missing.join(", ")} in Settings > Odoo`,
      { missing: loaded.missing.join(",") }
    );
  }
  if (loaded.state === "absent") {
    throw odooError("ODOO_NOT_CONFIGURED", "Odoo is not set up yet - open Settings > Odoo");
  }
  return loaded.config;
}

export async function saveOdooConfig(
  config: OdooConfig
): Promise<{ instanceChanged: boolean; becameUsable: boolean }> {
  // Armed FIRST, before any await. secureGet/secureSet throw raw plugin-store
  // errors, and a rejection carrying the just-submitted payload would otherwise
  // be constructed while the redactor still holds only the PREVIOUS instance's
  // secrets - the same hole closed for createOdooClient. Arming from the config
  // we are about to write is what makes the redaction match the payload at
  // risk.
  setOdooRedactor([config.apiKey, config.login]);

  const previous = await secureGet(SECURE_ODOO_CONFIG_KEY);
  let previousFingerprint: string | null = null;
  let previousUsable = false;
  if (previous) {
    try {
      const old = JSON.parse(previous) as Partial<OdooConfig>;
      if (old.url && old.db) previousFingerprint = instanceFingerprint(old.url, old.db);
      previousUsable = Boolean(old.url && old.db && old.login && old.apiKey);
    } catch {
      // An unreadable previous blob means we cannot prove the instance is the
      // same, so treat it as changed - which purges the cache. Losing a cache
      // is cheap; keeping one that names other partners is not.
      previousFingerprint = null;
    }
  }
  await secureSet(SECURE_ODOO_CONFIG_KEY, JSON.stringify(config));

  // TWO flags, because the cross-window notification must fire on either.
  //
  // `instanceChanged` alone misses the exact repair path the picker's
  // `not-configured` state creates: a user who stored url + db with a blank
  // login sees a state that deliberately offers NO Refresh, fills the login in,
  // and saves - the fingerprint is unchanged, so no event fires and the picker
  // stays on "Odoo is not set up yet" until the app restarts. That is verbatim
  // the failure the notification was added to close.
  return {
    instanceChanged: instanceFingerprint(config.url, config.db) !== previousFingerprint,
    becameUsable: !previousUsable,
  };
}

export async function clearOdooConfig(): Promise<void> {
  await secureDelete(SECURE_ODOO_CONFIG_KEY);
}
