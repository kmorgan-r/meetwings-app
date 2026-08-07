import { describe, expect, it } from "vitest";
import { OdooError } from "@/lib/odoo/errors";
import { buildMethodCall, decodeResponse, serializeValue } from "@/lib/odoo/xmlrpc-codec";

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return err instanceof OdooError ? err.code : `not-an-OdooError:${String(err)}`;
  }
  return "no-throw";
}

describe("serializeValue", () => {
  it("serializes the scalars Odoo actually receives", () => {
    expect(serializeValue(null)).toBe("<value><nil/></value>");
    expect(serializeValue(true)).toBe("<value><boolean>1</boolean></value>");
    expect(serializeValue(42)).toBe("<value><int>42</int></value>");
    expect(serializeValue(1.5)).toBe("<value><double>1.5</double></value>");
    expect(serializeValue("a&b")).toBe("<value><string>a&amp;b</string></value>");
  });

  it("serializes arrays and plain structs", () => {
    expect(serializeValue([1, 2])).toBe(
      "<value><array><data><value><int>1</int></value><value><int>2</int></value></data></array></value>"
    );
    expect(serializeValue({ a: 1 })).toBe(
      "<value><struct><member><name>a</name><value><int>1</int></value></member></struct></value>"
    );
  });

  // Every one of these silently corrupts under a naive serializer.
  it.each([
    ["undefined", undefined],
    ["non-finite", Number.NaN],
    ["exponential", 1e21],
    ["out-of-32-bit-range integer", 2147483648],
    ["Date", new Date(0)],
    ["non-plain object", new Map()],
    ["bigint", 10n],
  ])("throws ODOO_PAYLOAD_UNSERIALIZABLE for %s", (_label, value) => {
    expect(codeOf(() => serializeValue(value))).toBe("ODOO_PAYLOAD_UNSERIALIZABLE");
  });

  it("reports the failing param index from buildMethodCall", () => {
    expect(codeOf(() => buildMethodCall("m", ["ok", undefined]))).toBe(
      "ODOO_PAYLOAD_UNSERIALIZABLE"
    );
  });
});

describe("decodeResponse", () => {
  const wrap = (inner: string) =>
    `<?xml version="1.0"?><methodResponse><params><param>${inner}</param></params></methodResponse>`;

  it("decodes a whole array of structs, not a best-effort first scalar", () => {
    const xml = wrap(
      "<value><array><data>" +
        "<value><struct><member><name>id</name><value><int>7</int></value></member></struct></value>" +
        "<value><struct><member><name>id</name><value><int>12</int></value></member></struct></value>" +
        "</data></array></value>"
    );
    const decoded = decodeResponse(xml);
    expect(decoded).toEqual({ kind: "value", value: [{ id: 7 }, { id: 12 }] });
  });

  it("decodes an empty array as [], not null", () => {
    expect(decodeResponse(wrap("<value><array><data/></array></value>"))).toEqual({
      kind: "value",
      value: [],
    });
  });

  // Odoo answers bad credentials with HTTP 200 and <boolean>0</boolean>.
  it("decodes boolean false", () => {
    expect(decodeResponse(wrap("<value><boolean>0</boolean></value>"))).toEqual({
      kind: "value",
      value: false,
    });
  });

  // A fault is a SUCCESSFUL decode of a fault. It is not a decode failure.
  it("decodes a fault as a fault", () => {
    const xml =
      '<?xml version="1.0"?><methodResponse><fault><value><struct>' +
      "<member><name>faultCode</name><value><int>3</int></value></member>" +
      "<member><name>faultString</name><value><string>Access Denied</string></value></member>" +
      "</struct></value></fault></methodResponse>";
    expect(decodeResponse(xml)).toEqual({
      kind: "fault",
      faultCode: 3,
      faultString: "Access Denied",
    });
  });

  // A proxy login page instead of XML must never read as success.
  it("throws ODOO_MALFORMED_RESPONSE for an HTML login page", () => {
    expect(codeOf(() => decodeResponse("<html><body>Please log in</body></html>"))).toBe(
      "ODOO_MALFORMED_RESPONSE"
    );
  });

  // Self-closing <value/> treated as an open tag is a fail-open hole that
  // decodes a wrong scalar out of malformed XML.
  it("rejects a self-closing <value/> used as an open tag", () => {
    expect(
      codeOf(() => decodeResponse(wrap("<value/><int>999</int></value>")))
    ).toBe("ODOO_MALFORMED_RESPONSE");
  });
});
