import { REDACTED, buildRedactor } from "@/lib/odoo/redact";

/**
 * The Notion redactor is module-level, like the Odoo one.
 *
 * The token lives in the OS keychain and loads asynchronously, while the
 * user-facing surfaces (notionErrorText, catch blocks) call synchronously -
 * so nothing downstream can build a redactor on demand. The same instance must
 * cover the token and any custom AI provider key handed in.
 */

/**
 * Fail-closed. Before the token (and the AI key) have loaded we cannot prove a
 * string is clean, so an unarmed redactor blanks EVERYTHING instead of passing
 * text through.
 */
let redactor: ((s: string) => string) | null = null;

/**
 * Arming with an EMPTY usable set leaves the redactor unarmed, the same rule as
 * setOdooRedactor: buildRedactor([]) is the identity, which would flip
 * isNotionRedactorArmed() to true while redacting nothing - a fail-OPEN state,
 * reachable with a token and an AI key that are both unset.
 */
export function armNotionRedactor(
  secrets: ReadonlyArray<string | undefined>,
): void {
  const usable = secrets.filter(
    (s): s is string => typeof s === "string" && s.length > 0,
  );
  redactor = usable.length > 0 ? buildRedactor(usable) : null;
}

export function resetNotionRedactor(): void {
  redactor = null;
}

export function isNotionRedactorArmed(): boolean {
  return redactor !== null;
}

export function redactNotion(s: string): string {
  return redactor ? redactor(s) : REDACTED;
}
