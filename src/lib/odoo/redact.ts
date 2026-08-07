/**
 * Credential scrubbing (§8.3).
 *
 * ODOO_API_KEY is parameter #3 of every execute_kw envelope, so the request
 * body carries it in plaintext. Redaction must cover BOTH forms: the raw value,
 * and the xmlEscape()d value that actually appears in the envelope. A key
 * containing & < > " ' shows up as &amp; / &lt; / ... and a naive
 * body.replaceAll(key, '***') misses it entirely.
 */

const XML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
};

export function xmlEscape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => XML_ESCAPES[c]);
}

export const REDACTED = '[REDACTED]';

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Returns a function stripping every configured secret from a string, in both
 * raw and XML-escaped form.
 *
 * Undefined and empty secrets are skipped. That is not defensive noise: a
 * missing env var is a realistic input (it becomes QUOTE_ENV_MISSING later, but
 * redaction can run first on the error path), and replacing '' would blank the
 * entire string.
 */
export function buildRedactor(
  secrets: ReadonlyArray<string | undefined>,
): (input: string) => string {
  const needles = new Set<string>();
  for (const secret of secrets) {
    if (typeof secret !== 'string' || secret.length === 0) continue;
    needles.add(secret);
    // The XML-escaped form: what the key looks like inside an execute_kw envelope.
    needles.add(xmlEscape(secret));
    // The JSON-escaped form: createDraftQuote redacts the SERIALIZED envelope
    // (§8.3), where a key containing `"` appears as `\"` and a `\` as `\\`.
    // Without this the raw needle misses it entirely — and a partial match on a
    // backslash would leave a dangling escape, producing invalid JSON on stdout.
    needles.add(JSON.stringify(secret).slice(1, -1));
    // And the composition of the two: an XML-escaped envelope body that is then
    // JSON-serialized into an error context. Differs from the XML form only
    // when the secret contains a backslash — xmlEscape leaves `\` alone,
    // JSON.stringify doubles it.
    needles.add(JSON.stringify(xmlEscape(secret)).slice(1, -1));
  }

  if (needles.size === 0) return (input: string): string => input;

  // Longest first, so a secret that is a prefix of another cannot leave a tail.
  const pattern = new RegExp(
    [...needles].sort((a, b) => b.length - a.length).map(escapeRegExp).join('|'),
    'g',
  );

  return (input: string): string => input.replace(pattern, REDACTED);
}
