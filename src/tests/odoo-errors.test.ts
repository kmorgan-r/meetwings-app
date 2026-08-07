import { beforeEach, describe, expect, it } from "vitest";
import { odooError, OdooError, reportOdooError, toOdooError } from "@/lib/odoo/errors";
import { resetOdooRedactor, setOdooRedactor } from "@/lib/odoo/redactor";

const KEY = 'a1b2&c3d4<e5f6>g7h8"i9j0';

describe("OdooError", () => {
  beforeEach(() => resetOdooRedactor());

  it("redacts the message at construction, not at display", () => {
    setOdooRedactor([KEY]);
    const err = odooError("ODOO_FAULT", `traceback carrying ${KEY}`);
    expect(err.message).not.toContain("i9j0");
    expect(err.stack ?? "").not.toContain("i9j0");
  });

  it("redacts every details value at construction", () => {
    setOdooRedactor([KEY]);
    const err = odooError("ODOO_FAULT", "boom", { faultString: `x ${KEY} y`, faultCode: 3 });
    expect(JSON.stringify(err.details)).not.toContain("i9j0");
    expect(err.details.faultCode).toBe(3);
  });

  // A `cause` chain is one of the four raw-key escape paths.
  it("carries no cause", () => {
    const err = odooError("ODOO_UNREACHABLE", "boom");
    expect((err as unknown as { cause?: unknown }).cause).toBeUndefined();
  });

  it("passes an OdooError through toOdooError unchanged", () => {
    const original = odooError("ODOO_FAULT", "boom");
    expect(toOdooError(original)).toBe(original);
  });

  // SQLite and plugin-store throw plain Errors. Re-throwing them raw would
  // leave a failure with no code, which the picker cannot render.
  //
  // The redactor is ARMED here on purpose. Construction-time redaction is
  // fail-closed - with no redactor, getRedactor() blanks the whole string and
  // `detail` would come back "[REDACTED]". Arming with a key this message does
  // not contain is what lets the diagnostic survive while the guarantee holds.
  it("maps any non-OdooError throwable to ODOO_INTERNAL", () => {
    setOdooRedactor([KEY]);
    const mapped = toOdooError(new Error("database is locked"));
    expect(mapped).toBeInstanceOf(OdooError);
    expect(mapped.code).toBe("ODOO_INTERNAL");
    expect(mapped.details.detail).toContain("database is locked");
  });

  // The other half of the pair above: with NO redactor the same text must not
  // survive. This is the test that fails if someone "repairs" getRedactor()'s
  // default to the identity function.
  it("blanks message and details when built before the redactor is armed", () => {
    const err = odooError("ODOO_INTERNAL", "database is locked", {
      detail: "database is locked",
    });
    expect(err.message).not.toContain("database is locked");
    expect(err.details.detail).not.toContain("database is locked");
  });

  // buildRedactor([]) is the identity function - valid as a redactor, wrong as
  // a state. Arming with nothing usable must leave it uninitialised, or
  // reportOdooError stops suppressing and starts printing raw text.
  it("stays uninitialised when every secret is empty", () => {
    setOdooRedactor(["", undefined]);
    const report = reportOdooError(odooError("ODOO_FAULT", "raw text"), "sync");
    expect(report.message).toBe("ODOO_FAULT");
    expect(report.details).toEqual({});
  });

  it("reportOdooError returns code, message and details with no secret", () => {
    setOdooRedactor([KEY]);
    const report = reportOdooError(odooError("ODOO_FAULT", `bad ${KEY}`), "sync");
    expect(report.code).toBe("ODOO_FAULT");
    expect(JSON.stringify(report)).not.toContain("i9j0");
  });

  // Fail-closed: before credentials load there is no redactor, so nothing that
  // might carry a secret may be rendered.
  it("suppresses message and details when the redactor is uninitialised", () => {
    const report = reportOdooError(odooError("ODOO_FAULT", `bad ${KEY}`), "sync");
    expect(report.code).toBe("ODOO_FAULT");
    expect(report.message).toBe("ODOO_FAULT");
    expect(report.details).toEqual({});
  });
});
