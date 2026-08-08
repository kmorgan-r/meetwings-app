import { describe, expect, it } from "vitest";
import { buildRedactor, REDACTED, xmlEscape } from "@/lib/odoo/redact";

const KEY = 'a1b2&c3d4<e5f6>g7h8"i9j0';
const LOGIN = 'bob&<test>@example.com';

describe("buildRedactor", () => {
  it("strips the raw secret", () => {
    expect(buildRedactor([KEY])(`key=${KEY}!`)).toBe(`key=${REDACTED}!`);
  });

  // The key travels inside an XML envelope. A naive replaceAll(key, '***')
  // misses this entirely, and this is the form that actually leaks.
  it("strips the XML-escaped secret", () => {
    expect(buildRedactor([KEY])(`<value><string>${xmlEscape(KEY)}</string></value>`))
      .toBe(`<value><string>${REDACTED}</string></value>`);
  });

  it("strips the JSON-escaped secret", () => {
    expect(buildRedactor([KEY])(JSON.stringify({ k: KEY }))).toContain(REDACTED);
    expect(buildRedactor([KEY])(JSON.stringify({ k: KEY }))).not.toContain("i9j0");
  });

  // Differs from the XML form ONLY when the secret contains a backslash:
  // xmlEscape leaves `\` alone, JSON.stringify doubles it. Upstream's test
  // covers plain JSON escaping but never this composition.
  it("strips the XML-then-JSON-escaped secret", () => {
    const withSlash = 'p\\q&r<s>t';
    const envelope = `<string>${xmlEscape(withSlash)}</string>`;
    const serialized = JSON.stringify({ body: envelope });
    const out = buildRedactor([withSlash])(serialized);
    expect(out).toContain(REDACTED);
    expect(out).not.toContain("q&amp;r");
  });

  // A secret that is a prefix of another must not leave a tail.
  it("sorts needles longest-first", () => {
    const out = buildRedactor(["abc", "abcdef"])("abcdef");
    expect(out).toBe(REDACTED);
  });

  it("redacts BOTH the api key and the login", () => {
    const out = buildRedactor([KEY, LOGIN])(`login=${LOGIN} key=${KEY}`);
    expect(out).toBe(`login=${REDACTED} key=${REDACTED}`);
  });

  // Replacing '' would blank the entire string.
  it("skips empty and undefined secrets", () => {
    expect(buildRedactor(["", undefined])("untouched")).toBe("untouched");
  });
});
