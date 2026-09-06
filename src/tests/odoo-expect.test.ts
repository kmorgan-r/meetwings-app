import { describe, expect, it, beforeEach } from "vitest";
import { expectInt } from "@/lib/odoo/expect";
import { OdooError } from "@/lib/odoo/errors";
import { resetOdooRedactor, setOdooRedactor } from "@/lib/odoo/redactor";

const KEY = 'a1b2&c3d4<e5f6>g7h8"i9j0';

describe("expectInt", () => {
  beforeEach(() => {
    resetOdooRedactor();
    setOdooRedactor([KEY]);
  });
  it("returns an integer unchanged", () => {
    expect(expectInt(42, "partner id")).toBe(42);
  });

  it.each([
    ["a float", 1.5],
    ["a string", "7"],
    ["false", false],
    ["a list", [1]],
  ])("raises ODOO_UNEXPECTED_ROW for %s", (_label, value) => {
    try {
      expectInt(value as never, "partner id");
      throw new Error("expected expectInt to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(OdooError);
      expect((err as OdooError).code).toBe("ODOO_UNEXPECTED_ROW");
    }
  });

  // The message names WHAT was expected, so a fault can be placed without
  // echoing any server prose.
  it("names the thing it expected, and carries no value", () => {
    try {
      expectInt("nope" as never, "partner id");
    } catch (err) {
      expect((err as OdooError).message).toContain("partner id");
      expect((err as OdooError).message).not.toContain("nope");
    }
  });
});
