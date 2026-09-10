import { toOdooError } from "@/lib/odoo/errors";
import { secureDelete, secureGet, secureSet } from "@/lib/secure-storage";
import type { OdooConfig } from "@/types";
import { instanceFingerprint } from "./odoo-config.storage";

/**
 * The outcome of the last passing "Test connection", so the credentials page
 * can still show it after a reload.
 *
 * Deliberately a sibling of verification.storage.ts rather than a third slot
 * inside it. That module carries an app-init contract - migrateVerification...
 * / loadVerificationCache must run in app.context before its SYNCHRONOUS
 * getters are safe - which exists only because useSetupStatus needs to read
 * AI/STT verification during render without flashing "Setup Required". Nothing
 * but the Odoo page reads this record, and that page already awaits
 * loadOdooConfig on mount, so an async read costs it nothing and this module
 * needs no cache, no init step and no migration.
 */
export const SECURE_ODOO_VERIFICATION_KEY = "secure_odoo_verification";

interface OdooVerification {
  /** Which Odoo database the check was taken against. */
  fingerprint: string;
  /** SHA-256 of login + api key. See hashCredentials. */
  credentialHash: string;
  /** The uid Odoo resolved. Shown as the check's detail. */
  uid: number;
  verifiedAt: number;
}

/** What a still-valid check tells the caller. */
export interface OdooVerificationRecord {
  uid: number;
  verifiedAt: number;
}

/**
 * A hash, never the values.
 *
 * Both inputs are secrets as far as this app is concerned: setOdooRedactor is
 * armed with exactly [apiKey, login], so writing either one into a second blob
 * on disk would undo that. The hash is only ever compared against a freshly
 * computed one, so it needs no salt and is never reversed.
 *
 * Both fields are covered because either one can change without the other:
 * pointing the same api key at a different user is a different authentication,
 * and Odoo would resolve a different uid for it.
 */
async function hashCredentials(login: string, apiKey: string): Promise<string> {
  // A NUL separator, not a bare concatenation: without it ("ab", "c") and
  // ("a", "bc") hash the same, and a login/key pair that was never verified
  // would inherit a check taken against another.
  const data = new TextEncoder().encode(`${login}\u0000${apiKey}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Records a check that PASSED. There is no failed variant on purpose.
 *
 * verification.storage.ts stores `isVerified: false` alongside an
 * errorMessage; that would be a redaction hazard here for no gain - an Odoo
 * failure message can quote the credentials it was refused with, and the page
 * already renders the failure it just saw from live state. A failing test
 * clears the record instead (see the page's handleTestConnection).
 */
export async function saveOdooVerification(config: OdooConfig, uid: number): Promise<void> {
  const record: OdooVerification = {
    fingerprint: instanceFingerprint(config.url, config.db),
    credentialHash: await hashCredentials(config.login, config.apiKey),
    uid,
    verifiedAt: Date.now(),
  };
  try {
    await secureSet(SECURE_ODOO_VERIFICATION_KEY, JSON.stringify(record));
  } catch (err) {
    // Wrapped for the same reason as saveOdooConfig's secureSet: a raw
    // plugin-store rejection is not an OdooError, so it is never routed
    // through the redactor.
    throw toOdooError(err);
  }
}

/**
 * The check for `config`, or null if there is no proof it applies to it.
 *
 * Never throws for a record it cannot use. Absent, unreadable, unparseable, or
 * taken against other credentials are all the same answer to the page: we
 * cannot claim this connection was verified. Throwing would push a storage
 * fault into the page's config-load catch, which renders a red error line over
 * the credentials form; a missing green check is the honest way to say "press
 * Test connection", and it is what the user gets today on every reload.
 *
 * The one uncaught path is crypto.subtle - the same unguarded dependency
 * verification.storage.ts has had since it shipped. It is present in every
 * secure context, which the Tauri webview is; guarding it here would be dead
 * code no test could reach honestly.
 *
 * Pass the config that is on DISK, not the one in the form. Test connection
 * authenticates with requireOdooConfig's stored values, so a record matched
 * against unsaved edits would vouch for credentials nothing has tried.
 */
export async function loadOdooVerification(
  config: OdooConfig
): Promise<OdooVerificationRecord | null> {
  let raw: string | null;
  try {
    raw = await secureGet(SECURE_ODOO_VERIFICATION_KEY);
  } catch (err) {
    console.error("[Odoo] could not read the stored connection check:", err);
    return null;
  }
  if (!raw) return null;

  let record: Partial<OdooVerification>;
  try {
    record = JSON.parse(raw) as Partial<OdooVerification>;
  } catch (err) {
    console.error("[Odoo] the stored connection check is unreadable:", err);
    return null;
  }

  if (typeof record.uid !== "number" || typeof record.verifiedAt !== "number") return null;
  if (record.fingerprint !== instanceFingerprint(config.url, config.db)) return null;
  if (!record.credentialHash) return null;
  if (record.credentialHash !== (await hashCredentials(config.login, config.apiKey))) return null;

  return { uid: record.uid, verifiedAt: record.verifiedAt };
}

export async function clearOdooVerification(): Promise<void> {
  try {
    await secureDelete(SECURE_ODOO_VERIFICATION_KEY);
  } catch (err) {
    throw toOdooError(err);
  }
}
