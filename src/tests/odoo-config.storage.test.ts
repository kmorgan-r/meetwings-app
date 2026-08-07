import { beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, string>();
vi.mock("@/lib/secure-storage", () => ({
  secureSet: vi.fn(async (k: string, v: string) => void store.set(k, v)),
  secureGet: vi.fn(async (k: string) => store.get(k) ?? null),
  secureDelete: vi.fn(async (k: string) => void store.delete(k)),
}));

import { OdooError } from "@/lib/odoo/errors";
import { resetOdooRedactor, setOdooRedactor } from "@/lib/odoo/redactor";
import {
  clearOdooConfig,
  instanceFingerprint,
  loadOdooConfig,
  loadOdooConfigState,
  requireOdooConfig,
  saveOdooConfig,
  SECURE_ODOO_CONFIG_KEY,
} from "@/lib/storage/odoo-config.storage";

const KEY = 'a1b2&c3d4<e5f6>g7h8"i9j0';
const CONFIG = {
  url: "http://157.151.163.177:8069",
  db: "odoo",
  login: 'bob&<test>@example.com',
  apiKey: KEY,
};

async function codeOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (err) {
    return err instanceof OdooError ? err.code : `not-an-OdooError:${String(err)}`;
  }
  return "no-throw";
}

describe("odoo-config.storage", () => {
  // The redactor is module-level and survives between test files in a worker,
  // so it is reset per test. Tests that assert on error TEXT arm it themselves:
  // construction-time redaction is fail-closed and blanks everything otherwise.
  beforeEach(() => {
    store.clear();
    resetOdooRedactor();
  });

  it("round-trips a config", async () => {
    await saveOdooConfig(CONFIG);
    await expect(loadOdooConfig()).resolves.toEqual(CONFIG);
  });

  it("returns null when nothing is stored", async () => {
    await expect(loadOdooConfig()).resolves.toBeNull();
  });

  it("throws ODOO_NOT_CONFIGURED when absent", async () => {
    expect(await codeOf(requireOdooConfig)).toBe("ODOO_NOT_CONFIGURED");
  });

  // Shipping `undefined` for db or login would surface as
  // ODOO_PAYLOAD_UNSERIALIZABLE or, worse, a confusing auth failure.
  it.each(["url", "db", "login", "apiKey"])(
    "throws ODOO_NOT_CONFIGURED when %s is missing",
    async (field) => {
      const partial = { ...CONFIG, [field]: "" };
      store.set(SECURE_ODOO_CONFIG_KEY, JSON.stringify(partial));
      expect(await codeOf(requireOdooConfig)).toBe("ODOO_NOT_CONFIGURED");
    }
  );

  // "Never set up" and "set up, one field blank" need different sentences.
  // Collapsing both to null told the user to start over when they were one
  // field away.
  it("tells absent apart from incomplete, and names the blank fields", async () => {
    await expect(loadOdooConfigState()).resolves.toEqual({ state: "absent", config: null });

    store.set(SECURE_ODOO_CONFIG_KEY, JSON.stringify({ ...CONFIG, db: "", apiKey: "" }));
    await expect(loadOdooConfigState()).resolves.toEqual({
      state: "incomplete",
      config: null,
      missing: ["db", "apiKey"],
    });
  });

  // The blank-field message names FIELDS. If it ever names values it leaks the
  // api key into a toast.
  //
  // The redactor is deliberately NOT armed by this test. Redaction is
  // fail-closed, so if loadOdooConfigState armed only on the `complete` branch
  // this message would arrive blanked and suppressed - which is what production
  // sees on a cold start. Arming here by hand would hide exactly that bug.
  it("names the blank fields without the test arming the redactor", async () => {
    store.set(SECURE_ODOO_CONFIG_KEY, JSON.stringify({ ...CONFIG, db: "" }));
    let caught: OdooError | null = null;
    try {
      await requireOdooConfig();
    } catch (err) {
      caught = err as OdooError;
    }
    expect(caught?.message).toContain("db");
    expect(`${caught?.message}${JSON.stringify(caught?.details)}`).not.toContain("i9j0");
  });

  // The other side of arming-before-the-check: a partial config still arms from
  // whatever secrets it DOES hold, so nothing built afterwards can leak them.
  it("arms the redactor from a partial config", async () => {
    store.set(SECURE_ODOO_CONFIG_KEY, JSON.stringify({ ...CONFIG, db: "" }));
    await loadOdooConfigState();
    const { isRedactorInitialised } = await import("@/lib/odoo/redactor");
    expect(isRedactorInitialised()).toBe(true);
  });

  it("throws ODOO_INTERNAL when the stored blob is not JSON", async () => {
    store.set(SECURE_ODOO_CONFIG_KEY, "{not json");
    expect(await codeOf(requireOdooConfig)).toBe("ODOO_INTERNAL");
  });

  it("clears the config", async () => {
    await saveOdooConfig(CONFIG);
    await clearOdooConfig();
    await expect(loadOdooConfig()).resolves.toBeNull();
  });

  describe("instanceFingerprint", () => {
    // Without normalization a cosmetic credential edit orphans - and then
    // deletes - the entire cache.
    it("normalizes a trailing slash and host case to one fingerprint", () => {
      expect(instanceFingerprint("http://Odoo.Example.COM:8069/", "db")).toBe(
        instanceFingerprint("http://odoo.example.com:8069", "db")
      );
    });

    it("keeps an explicit port significant", () => {
      expect(instanceFingerprint("http://h:8069", "db")).not.toBe(
        instanceFingerprint("http://h:8070", "db")
      );
    });

    it("distinguishes databases on the same host", () => {
      expect(instanceFingerprint("http://h:8069", "prod")).not.toBe(
        instanceFingerprint("http://h:8069", "staging")
      );
    });
  });

  // The brief's "Interfaces" section names only `instanceChanged`, but the
  // Context and Ambiguity Resolution sections are explicit: saveOdooConfig
  // returns BOTH flags, and Tasks 8/10/11/12 depend on both. toEqual is
  // shape-strict, so the assertions include becameUsable rather than
  // silently accepting a return value one field short of the mandate.
  it("reports whether the instance changed on save", async () => {
    await expect(saveOdooConfig(CONFIG)).resolves.toEqual({
      instanceChanged: true,
      becameUsable: true,
    });
    await expect(saveOdooConfig({ ...CONFIG, apiKey: "rotated" })).resolves.toEqual({
      instanceChanged: false,
      becameUsable: false,
    });
    await expect(saveOdooConfig({ ...CONFIG, db: "staging" })).resolves.toEqual({
      instanceChanged: true,
      becameUsable: false,
    });
  });

  // The other side of becameUsable: instanceChanged stays false for a repair
  // that fills in a previously-blank login on the SAME server, which is
  // exactly why the picker needs a second flag to know to refresh.
  it("reports becameUsable true when a repair fixes a blank field on the same instance", async () => {
    store.set(
      SECURE_ODOO_CONFIG_KEY,
      JSON.stringify({ ...CONFIG, login: "" })
    );
    await expect(saveOdooConfig(CONFIG)).resolves.toEqual({
      instanceChanged: false,
      becameUsable: true,
    });
  });
});
