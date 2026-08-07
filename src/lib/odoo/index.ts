export * from "./client";
export * from "./contact-ordering";
export * from "./contacts-sync";
export * from "./errors";
export * from "./opportunities";
export * from "./redact";
export * from "./redactor";
export * from "./sync-decisions";
export * from "./watermark";
export * from "./xmlrpc-codec";

import { getSyncState } from "@/lib/database/odoo-contacts.action";
import { instanceFingerprint, requireOdooConfig } from "@/lib/storage/odoo-config.storage";
import type { SyncResult } from "@/types";
import { createOdooClient } from "./client";
import { syncContacts } from "./contacts-sync";
import { odooError } from "./errors";
import { decideSync, type SyncDecision, type SyncTrigger } from "./sync-decisions";

/**
 * Module-level single flight.
 *
 * `syncNow` returns the in-flight promise if there is one, and the promise
 * clears ITSELF in `.finally()`. Callers never touch `inFlight`.
 *
 * Note the polarity is the OPPOSITE of useMeetingAutoRecord.ts:544-550, where
 * `mountedRef` is lowered by cleanup and so must be re-armed in the effect's
 * create body. That latch is owned by the component; this one is owned by the
 * run. Re-arming this one in a create body would discard the promise the first
 * StrictMode create armed and start exactly the second concurrent paged pull it
 * exists to prevent.
 */
let inFlight: Promise<SyncOutcome> | null = null;

/**
 * "Did not run" and "ran and nothing had changed" are DIFFERENT outcomes.
 *
 * Returning a zero SyncResult for a skip made them identical, so a caller had
 * no way to tell a suppressed app-start sync from a completed one - and the
 * picker would report "0 contacts updated" for a sync that never happened,
 * which reads as a working, empty Odoo.
 */
export type SyncOutcome =
  | { ran: false; reason: Exclude<SyncDecision, "run"> }
  | ({ ran: true } & SyncResult);

/**
 * The guard is the FIRST thing this function does, and `inFlight` is assigned
 * synchronously with the check.
 *
 * Reading `inFlight` after `await requireOdooConfig()` / `await getSyncState()`
 * is racy: two callers that reach the check at different await depths - an
 * app-start sync mid-`getSyncState` and a Refresh click, say - both see `null`,
 * both assign, and the second is then refused by `claimSync` with
 * ODOO_SYNC_BUSY instead of joining the first. Worse, the first run's
 * `.finally` clears `inFlight` while the second is still live. Everything that
 * can await now lives INSIDE the wrapped run, so nothing separates the test
 * from the assignment.
 */
export async function runSync(trigger: SyncTrigger, meetingMode = false): Promise<SyncOutcome> {
  // A joiner gets the SAME outcome the in-flight run produces, skip included -
  // `inFlight` holds a SyncOutcome, not a SyncResult the joiner would have to
  // re-label `ran: true`. Labelling at the join point is how a joined skip
  // turns back into the zeroed "0 contacts updated" this type exists to stop.
  if (inFlight) return inFlight;

  const run = (async (): Promise<SyncOutcome> => {
    const config = await requireOdooConfig();
    const instance = instanceFingerprint(config.url, config.db);
    const state = await getSyncState(instance);

    const decision = decideSync({
      trigger,
      // Hardcoded true because requireOdooConfig() above already threw
      // ODOO_NOT_CONFIGURED otherwise. "skip-no-credentials" is therefore
      // unreachable from this caller BY CONSTRUCTION, not by accident - the
      // missing-credentials case has exactly one representation in this
      // feature, and it is the thrown code. decideSync keeps the member
      // because it is a pure function with its own tests.
      hasCredentials: true,
      lastSyncAt: state?.last_sync_at ?? null,
      now: Date.now(),
      meetingMode,
    });
    if (decision !== "run") return { ran: false, reason: decision };

    const result = await syncContacts({
      client: createOdooClient(config),
      instance,
      now: Date.now(),
    });
    return { ran: true, ...result };
  })();

  inFlight = run.finally(() => {
    inFlight = null;
  });
  return inFlight;
}

export async function testOdooConnection(): Promise<number> {
  const config = await requireOdooConfig();
  return createOdooClient(config).authenticate();
}

/** Exposed so a caller can prove a target belongs to the live instance. */
export async function currentInstance(): Promise<string> {
  const config = await requireOdooConfig();
  return instanceFingerprint(config.url, config.db);
}

export { odooError };
