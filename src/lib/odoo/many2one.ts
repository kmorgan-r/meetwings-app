/**
 * A many2one is `[id, display_name]` or `false`. Nothing else is readable, and
 * guessing would put the wrong company name beside a contact.
 *
 * Extracted from contacts-sync.ts and opportunities.ts, which held byte-for-byte
 * identical copies. NOT in xmlrpc-codec.ts: that module owns wire encode/decode,
 * whereas this interprets an already-decoded field value.
 *
 * This does NOT read a many2MANY (`attachment_ids` is a plain integer list) -
 * value[1] is a number there, so it returns null.
 */
export function many2one(value: unknown): { id: number; name: string } | null {
  if (Array.isArray(value) && typeof value[0] === "number" && typeof value[1] === "string") {
    return { id: value[0], name: value[1] };
  }
  return null;
}
