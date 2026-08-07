import { buildRedactor } from "./redact";

/**
 * The redactor is module-level, not a closure passed into the client.
 *
 * The port could pass it as a parameter because a CLI has one call site. Here
 * the codec (pure, no config), reportOdooError (synchronous, called from catch
 * blocks) and the client all need it - and credentials come from an ASYNC
 * secureGet, so nothing downstream can build one on demand.
 */

/**
 * Fail-closed default. Before credentials load we do not know the secrets, so
 * we cannot prove a string is clean - callers must therefore suppress anything
 * that could carry one rather than print it. `isInitialised()` is how they know.
 */
let redactor: ((s: string) => string) | null = null;

/**
 * Arming with an EMPTY secret set leaves the redactor uninitialised.
 *
 * `buildRedactor([])` returns the identity function, which is perfectly valid
 * as a redactor and utterly wrong as a state: it would flip
 * `isRedactorInitialised()` to true while redacting nothing, so
 * `reportOdooError` would stop suppressing and start printing raw text. That is
 * fail-OPEN, and the one path that reaches it is real - a config blob whose
 * apiKey and login are both empty strings.
 */
export function setOdooRedactor(secrets: ReadonlyArray<string | undefined>): void {
  const usable = secrets.filter(
    (s): s is string => typeof s === "string" && s.length > 0
  );
  redactor = usable.length > 0 ? buildRedactor(usable) : null;
}

export function resetOdooRedactor(): void {
  redactor = null;
}

export function isRedactorInitialised(): boolean {
  return redactor !== null;
}

/**
 * Returns a redactor that blanks EVERYTHING when uninitialised.
 *
 * DO NOT "fix" this to the identity function. It is tempting when a test
 * asserts on the text of an error built before arming, but identity silently
 * disables construction-time redaction for every error built on that path -
 * and construction time is the only point at which the unhandled-rejection and
 * error-boundary escapes can be closed. The correct fix for such a test is to
 * arm the redactor in the test, which `odoo-errors.test.ts` now does.
 */
export function getRedactor(): (s: string) => string {
  return redactor ?? (() => "[REDACTED]");
}
