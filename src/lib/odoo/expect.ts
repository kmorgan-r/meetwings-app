import { odooError } from "./errors";
import type { XmlRpcValue } from "./xmlrpc-codec";

/**
 * Shared because two features validate the same thing: `create` returns an id,
 * and both `meeting-log-push` and `create-contact` have to refuse anything that
 * is not one rather than caching or persisting a junk value.
 *
 * `what` names the expected thing and NEVER the received value: the message
 * reaches a toast, and a server-supplied value there would be exactly the
 * prose leak this feature's error rule forbids.
 */
export function expectInt(value: XmlRpcValue, what: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw odooError("ODOO_UNEXPECTED_ROW", `Odoo returned a non-integer ${what}`);
  }
  return value;
}
