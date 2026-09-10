import { beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, string>();
vi.mock("@/lib/secure-storage", () => ({
  secureSet: vi.fn(async (k: string, v: string) => void store.set(k, v)),
  secureGet: vi.fn(async (k: string) => store.get(k) ?? null),
  secureDelete: vi.fn(async (k: string) => void store.delete(k)),
}));

import { resetOdooRedactor } from "@/lib/odoo/redactor";
import {
  clearOdooVerification,
  loadOdooVerification,
  saveOdooVerification,
  SECURE_ODOO_VERIFICATION_KEY,
} from "@/lib/storage/odoo-verification.storage";

const CONFIG = {
  url: "http://157.151.163.177:8069",
  db: "odoo",
  login: "bob@example.com",
  apiKey: "a1b2c3d4e5f6",
};

describe("odoo-verification.storage", () => {
  beforeEach(() => {
    store.clear();
    resetOdooRedactor();
  });

  it("remembers a passing check for the credentials it was taken against", async () => {
    await saveOdooVerification(CONFIG, 7);
    await expect(loadOdooVerification(CONFIG)).resolves.toMatchObject({ uid: 7 });
  });

  it("returns null when no check has ever been taken", async () => {
    await expect(loadOdooVerification(CONFIG)).resolves.toBeNull();
  });

  it("forgets the check when the api key changes", async () => {
    await saveOdooVerification(CONFIG, 7);
    await expect(
      loadOdooVerification({ ...CONFIG, apiKey: "different" })
    ).resolves.toBeNull();
  });

  it("forgets the check when the login changes", async () => {
    await saveOdooVerification(CONFIG, 7);
    await expect(
      loadOdooVerification({ ...CONFIG, login: "alice@example.com" })
    ).resolves.toBeNull();
  });

  it("forgets the check when the database changes", async () => {
    await saveOdooVerification(CONFIG, 7);
    await expect(loadOdooVerification({ ...CONFIG, db: "staging" })).resolves.toBeNull();
  });

  it("forgets the check when the url points at another instance", async () => {
    await saveOdooVerification(CONFIG, 7);
    await expect(
      loadOdooVerification({ ...CONFIG, url: "http://other:8069" })
    ).resolves.toBeNull();
  });

  it("keeps the check across a cosmetic url edit", async () => {
    await saveOdooVerification(CONFIG, 7);
    await expect(
      loadOdooVerification({ ...CONFIG, url: "http://157.151.163.177:8069/" })
    ).resolves.toMatchObject({ uid: 7 });
  });

  it("stores neither the api key nor the login", async () => {
    await saveOdooVerification(CONFIG, 7);
    const raw = store.get(SECURE_ODOO_VERIFICATION_KEY) ?? "";
    expect(raw).not.toContain(CONFIG.apiKey);
    expect(raw).not.toContain(CONFIG.login);
  });

  it("does not claim a check it cannot read back", async () => {
    store.set(SECURE_ODOO_VERIFICATION_KEY, "{ not json");
    await expect(loadOdooVerification(CONFIG)).resolves.toBeNull();
  });

  it("forgets the check when it is cleared", async () => {
    await saveOdooVerification(CONFIG, 7);
    await clearOdooVerification();
    await expect(loadOdooVerification(CONFIG)).resolves.toBeNull();
  });

  it("records when the check was taken", async () => {
    const before = Date.now();
    await saveOdooVerification(CONFIG, 7);
    const loaded = await loadOdooVerification(CONFIG);
    expect(loaded?.verifiedAt).toBeGreaterThanOrEqual(before);
  });
});
