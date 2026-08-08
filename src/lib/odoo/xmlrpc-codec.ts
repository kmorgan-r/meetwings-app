import { odooError } from "./errors";
import { xmlEscape } from "./redact";

/**
 * XML-RPC serialization. Pure — no fetch.
 *
 * This is NOT a port of supabase/functions/record-signup-request/xmlrpc.ts.
 * That module silently corrupts three of the values this design passes:
 *
 *   undefined  -> <nil/>                 an omitted field ships as explicit null
 *   Date       -> empty <struct>         Object.entries(new Date()) is []
 *   NaN / Inf  -> <double>NaN</double>   a non-finite price reaches Odoo
 *
 * Only bigint throws there, and zod cannot produce one — so the realistic
 * corruptions were exactly the silent ones. Here every unsupported type throws,
 * checked BEFORE the generic object branch. Formatting a Date is the
 * caller's job: pass a 'YYYY-MM-DD' string.
 */

export type XmlRpcValue =
  | string
  | number
  | boolean
  | null
  | XmlRpcValue[]
  | { [k: string]: XmlRpcValue };

function unserializable(detail: string) {
  return odooError("ODOO_PAYLOAD_UNSERIALIZABLE", `Cannot serialize value for XML-RPC: ${detail}`, {
    detail,
  });
}

export function serializeValue(v: unknown): string {
  if (v === null) return "<value><nil/></value>";

  if (v === undefined) {
    // Deliberately distinguished from null: an omitted field and an explicit
    // null mean different things to Odoo, and conflating them is silent.
    throw unserializable("undefined (did you mean null?)");
  }

  const t = typeof v;

  if (t === "string") return `<value><string>${xmlEscape(v as string)}</string></value>`;

  if (t === "boolean") return `<value><boolean>${(v as boolean) ? "1" : "0"}</boolean></value>`;

  if (t === "number") {
    const n = v as number;
    if (!Number.isFinite(n)) throw unserializable(`non-finite number (${String(n)})`);

    // XML-RPC <int>/<double> grammar is fixed-point only. String(n) switches
    // to exponential for |n| >= 1e21 or 0 < |n| < 1e-6, which would emit
    // syntactically invalid XML-RPC (e.g. <int>1e+21</int>) without complaint.
    if (/e/i.test(String(n))) {
      throw unserializable(
        "number requires exponential notation, which is not valid XML-RPC int/double grammar"
      );
    }

    if (Number.isInteger(n)) {
      // <int>/<i4> is a signed 32-bit integer; values outside that range
      // would silently round-trip through Odoo as a different number.
      if (Math.abs(n) > 2147483647) {
        throw unserializable(
          "integer exceeds signed 32-bit range (XML-RPC <int> max magnitude is 2147483647)"
        );
      }
      return `<value><int>${n}</int></value>`;
    }

    return `<value><double>${n}</double></value>`;
  }

  if (t === "bigint") throw unserializable("bigint");
  if (t === "function") throw unserializable("function");
  if (t === "symbol") throw unserializable("symbol");

  if (Array.isArray(v)) {
    const parts: string[] = [];
    for (const [i, entry] of v.entries()) {
      try {
        parts.push(serializeValue(entry));
      } catch (err) {
        throw unserializable(`array index ${i}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return `<value><array><data>${parts.join("")}</data></array></value>`;
  }

  if (t === "object") {
    // Must precede the generic object branch: Object.entries(new Date()) is [],
    // so without this a Date serializes to an empty struct with no error at all.
    if (v instanceof Date) throw unserializable("Date (format to YYYY-MM-DD first)");

    // Generalizes the Date guard rather than adding more special cases.
    // Object.entries only sees own-enumerable string keys, so Map, Set,
    // Error, RegExp, and class instances (incl. prototype getters) all
    // silently serialize to an empty or incomplete <struct> with no error.
    // Only plain object literals and Object.create(null) objects are safe.
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) {
      throw unserializable("non-plain object (not a plain object literal)");
    }

    const parts: string[] = [];
    for (const [key, entry] of Object.entries(v as Record<string, unknown>)) {
      try {
        parts.push(`<member><name>${xmlEscape(key)}</name>${serializeValue(entry)}</member>`);
      } catch (err) {
        throw unserializable(`struct member "${key}": ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return `<value><struct>${parts.join("")}</struct></value>`;
  }

  throw unserializable(`unsupported type ${t}`);
}

export function buildMethodCall(method: string, params: unknown[]): string {
  const parts: string[] = [];
  for (const [i, p] of params.entries()) {
    try {
      parts.push(`<param>${serializeValue(p)}</param>`);
    } catch (err) {
      throw unserializable(`param ${i}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return (
    `<?xml version="1.0"?><methodCall><methodName>${xmlEscape(method)}</methodName>` +
    `<params>${parts.join("")}</params></methodCall>`
  );
}

/* ------------------------------------------------------------------ decoding */

/**
 * Full XML-RPC value decoding.
 *
 * The edge client's parseResponse extracts the FIRST <int>, else <boolean>,
 * else <string>, else null — no <array>, no <struct>. Every read in this design
 * returns a container, so under that parser:
 *
 *   search -> [7, 12]        decoded as 7      "exactly one match" — writes to
 *                                              the wrong partner, fails OPEN
 *   search_read -> [{...}]   unparseable       no candidate list, no default_code
 *   search -> []             decoded as null   indistinguishable from a parse miss
 *
 * So: decode the whole tree, or throw. Never a best-effort scalar.
 */

interface Token {
  name: string;
  close: boolean;
  self: boolean;
  /** Character data preceding this tag — the content of the element it closes. */
  text: string;
}

function tokenize(xml: string): Token[] {
  const tokens: Token[] = [];
  // Deliberately ignores <?xml ... ?>: `\s*` cannot match the leading '?'.
  const re = /<\s*(\/?)([A-Za-z0-9_.]+)[^>]*?(\/?)\s*>/g;
  let last = 0;
  let m: RegExpExecArray | null = re.exec(xml);
  while (m !== null) {
    tokens.push({
      name: m[2],
      close: m[1] === "/",
      self: m[3] === "/",
      text: xml.slice(last, m.index),
    });
    last = re.lastIndex;
    m = re.exec(xml);
  }
  return tokens;
}

function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCharCode(Number(d)))
    // &amp; last, so "&amp;lt;" round-trips to "&lt;" rather than to "<".
    .replace(/&amp;/g, "&");
}

function malformed(detail: string) {
  return odooError("ODOO_MALFORMED_RESPONSE", `Malformed XML-RPC response: ${detail}`, { detail });
}

/**
 * A self-closing tag (`<value/>`) is NOT an open tag. Treating it as one is a
 * fail-open hole: `<value/><int>999</int></value>` would be read as an open
 * `<value>` wrapping `<int>999</int>` closed by the trailing `</value>` —
 * decoding `999` from malformed XML. Rejecting self-closing here makes the
 * malformed payload throw instead of decoding a wrong-customer scalar.
 */
function isOpen(t: Token | undefined, name: string): boolean {
  return t !== undefined && !t.close && !t.self && t.name === name;
}

function isClose(t: Token | undefined, name: string): boolean {
  return t !== undefined && t.close && t.name === name;
}

function decodeScalar(type: string, raw: string): XmlRpcValue {
  const text = raw.trim();
  switch (type) {
    case "nil":
      return null;
    case "int":
    case "i4":
      if (!/^-?\d+$/.test(text)) throw malformed(`bad <${type}>: ${JSON.stringify(raw)}`);
      return Number.parseInt(text, 10);
    case "double": {
      const n = Number.parseFloat(text);
      if (!Number.isFinite(n)) throw malformed(`bad <double>: ${JSON.stringify(raw)}`);
      return n;
    }
    case "boolean":
      if (text === "1") return true;
      if (text === "0") return false;
      throw malformed(`bad <boolean>: ${JSON.stringify(raw)}`);
    case "string":
      return unescapeXml(raw);
    case "dateTime.iso8601":
    case "base64":
      return text;
    default:
      throw malformed(`unsupported XML-RPC type <${type}>`);
  }
}

type Decoded = readonly [XmlRpcValue, number];

/**
 * Recursion ceiling for value/array/struct nesting. A pathological payload
 * (thousands of nested `<array><data><value>…`) would otherwise throw an
 * uncaught `RangeError` — violating the throw-only-OdooError contract. 64 is
 * far above any real Odoo response (a many2one is 2 levels; a set of them 3)
 * and below the V8 stack budget for this function pair.
 */
const MAX_DECODE_DEPTH = 64;

function decodeValueAt(t: Token[], i: number, depth = 0): Decoded {
  if (depth > MAX_DECODE_DEPTH) throw malformed(`nesting deeper than ${MAX_DECODE_DEPTH}`);
  if (!isOpen(t[i], "value")) throw malformed(`expected <value> at token ${i}`);

  const next = t[i + 1];
  if (next === undefined) throw malformed("truncated after <value>");

  // <value>raw text</value> — an untyped value is a string per the spec.
  if (isClose(next, "value")) return [unescapeXml(next.text), i + 2] as const;

  if (next.self) {
    if (next.name !== "nil") throw malformed(`unexpected self-closing <${next.name}/>`);
    if (!isClose(t[i + 2], "value")) throw malformed("expected </value> after <nil/>");
    return [null, i + 3] as const;
  }

  if (next.name === "array") return decodeArrayAt(t, i, depth + 1);
  if (next.name === "struct") return decodeStructAt(t, i, depth + 1);

  const closeType = t[i + 2];
  if (!isClose(closeType, next.name)) throw malformed(`unclosed <${next.name}>`);
  if (!isClose(t[i + 3], "value")) throw malformed(`expected </value> after </${next.name}>`);

  const scalar = decodeScalar(next.name, closeType?.text ?? "");
  return [scalar, i + 4] as const;
}

function decodeArrayAt(t: Token[], i: number, depth = 0): Decoded {
  if (depth > MAX_DECODE_DEPTH) throw malformed(`nesting deeper than ${MAX_DECODE_DEPTH}`);
  const data = t[i + 2];
  if (data === undefined || data.close || data.name !== "data") {
    throw malformed("expected <data> inside <array>");
  }

  if (data.self) {
    if (!isClose(t[i + 3], "array")) throw malformed("expected </array> after <data/>");
    if (!isClose(t[i + 4], "value")) throw malformed("expected </value> after </array>");
    return [[], i + 5] as const;
  }

  const out: XmlRpcValue[] = [];
  let j = i + 3;
  while (isOpen(t[j], "value")) {
    const entry = decodeValueAt(t, j, depth + 1);
    out.push(entry[0]);
    j = entry[1];
  }

  if (!isClose(t[j], "data")) throw malformed("expected </data>");
  if (!isClose(t[j + 1], "array")) throw malformed("expected </array>");
  if (!isClose(t[j + 2], "value")) throw malformed("expected </value> after </array>");
  return [out, j + 3] as const;
}

function decodeStructAt(t: Token[], i: number, depth = 0): Decoded {
  if (depth > MAX_DECODE_DEPTH) throw malformed(`nesting deeper than ${MAX_DECODE_DEPTH}`);
  const out: Record<string, XmlRpcValue> = {};
  let j = i + 2;

  while (isOpen(t[j], "member")) {
    if (!isOpen(t[j + 1], "name")) throw malformed("expected <name> inside <member>");
    const nameClose = t[j + 2];
    if (!isClose(nameClose, "name")) throw malformed("unclosed <name>");
    const key = unescapeXml(nameClose?.text ?? "");

    const entry = decodeValueAt(t, j + 3, depth + 1);
    out[key] = entry[0];

    const after = entry[1];
    if (!isClose(t[after], "member")) throw malformed(`expected </member> after "${key}"`);
    j = after + 1;
  }

  if (!isClose(t[j], "struct")) throw malformed("expected </struct>");
  if (!isClose(t[j + 1], "value")) throw malformed("expected </value> after </struct>");
  return [out, j + 2] as const;
}

export type DecodedResponse =
  | { kind: "value"; value: XmlRpcValue }
  | { kind: "fault"; faultCode: number; faultString: string };

/**
 * A fault is a SUCCESSFUL decode of a fault — throwing is reserved for XML
 * this function cannot structure. Callers convert a fault into an ODOO_* code
 * at their own call site; the fault's own faultCode never becomes an
 * OdooError.code, because xmlrpc.ts stuffs HTTP statuses in there.
 */
export function decodeResponse(xml: string): DecodedResponse {
  const t = tokenize(xml);

  const faultIdx = t.findIndex((tok) => isOpen(tok, "fault"));
  if (faultIdx >= 0) {
    const valIdx = t.findIndex((tok, k) => k > faultIdx && isOpen(tok, "value"));
    if (valIdx < 0) throw malformed("<fault> with no <value>");
    const decoded = decodeValueAt(t, valIdx);

    const payload = decoded[0];
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
      throw malformed("<fault> payload is not a struct");
    }
    const code = payload.faultCode;
    const message = payload.faultString;
    return {
      kind: "fault",
      faultCode: typeof code === "number" ? code : -1,
      faultString: typeof message === "string" ? message : "Unparseable Odoo fault",
    };
  }

  const paramIdx = t.findIndex((tok) => isOpen(tok, "param"));
  if (paramIdx < 0) throw malformed("no <param> in methodResponse");
  const valIdx = t.findIndex((tok, k) => k > paramIdx && isOpen(tok, "value"));
  if (valIdx < 0) throw malformed("no <value> inside <param>");

  const decoded = decodeValueAt(t, valIdx);
  return { kind: "value", value: decoded[0] };
}
