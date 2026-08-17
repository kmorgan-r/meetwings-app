import { describe, expect, it } from "vitest";
import { many2one } from "@/lib/odoo/many2one";

describe("many2one", () => {
  it("reads an [id, display_name] tuple", () => {
    expect(many2one([7, "Analytical Ltd"])).toEqual({ id: 7, name: "Analytical Ltd" });
  });

  it("returns null for Odoo's unset-field false", () => {
    expect(many2one(false)).toBeNull();
  });

  it("returns null for a bare string", () => {
    expect(many2one("Analytical Ltd")).toBeNull();
  });

  it("returns null for a truncated tuple with no name", () => {
    expect(many2one([7])).toBeNull();
  });
});
