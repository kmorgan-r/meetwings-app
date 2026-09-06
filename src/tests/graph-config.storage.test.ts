import { beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({
  secureGet: vi.fn(async () => null as string | null),
  secureSet: vi.fn(async () => {}),
  secureDelete: vi.fn(async () => {}),
}));
vi.mock("@/lib/secure-storage", () => store);

import {
  DEFAULT_AUTHORITY,
  loadGraphConfig,
  loadGraphConfigState,
  saveGraphConfig,
} from "@/lib/storage/graph-config.storage";

beforeEach(() => {
  vi.clearAllMocks();
  store.secureGet.mockResolvedValue(null);
});

describe("loadGraphConfig", () => {
  // v1 ships NO client ID: the defaults are empty and setup is two fields on
  // the /odoo page. "Nothing stored" must therefore be a first-class state,
  // not an error.
  it("returns null when nothing is stored", async () => {
    await expect(loadGraphConfig()).resolves.toBeNull();
  });

  it("returns null when the client ID is blank", async () => {
    store.secureGet.mockResolvedValue(JSON.stringify({ clientId: "  ", authority: "" }));
    await expect(loadGraphConfig()).resolves.toBeNull();
  });

  // Pins the OTHER non-complete collapse: the two existing cases above cover
  // "absent" collapsing to null, this one covers "unreadable" collapsing to
  // null too - loadGraphConfig treats both non-complete states the same way.
  it("returns null when the stored blob is unreadable", async () => {
    store.secureGet.mockResolvedValue("{not json");
    await expect(loadGraphConfig()).resolves.toBeNull();
  });

  it("defaults the authority to /organizations", async () => {
    store.secureGet.mockResolvedValue(JSON.stringify({ clientId: "abc" }));
    await expect(loadGraphConfig()).resolves.toEqual({
      clientId: "abc",
      authority: DEFAULT_AUTHORITY,
    });
  });

  // /common would admit personal MSA accounts, which are out of scope.
  it("uses the /organizations authority as its default", () => {
    expect(DEFAULT_AUTHORITY).toBe("https://login.microsoftonline.com/organizations");
    expect(DEFAULT_AUTHORITY).not.toContain("/common");
  });

  // "Never set up" and "corrupt" must not be the same state. Collapsing them
  // takes the feature away from a previously-connected user with nothing on
  // screen to say why - the exact distinction loadOdooConfigState draws.
  it("reports an unreadable blob as unreadable, not absent", async () => {
    store.secureGet.mockResolvedValue("{not json");
    await expect(loadGraphConfigState()).resolves.toEqual({
      state: "unreadable",
      config: null,
    });
  });

  // The outer try/catch around secureGet, not just the JSON.parse one below -
  // a rejecting read (a locked or corrupt store file) must land on the same
  // "unreadable" state as a corrupt blob, never on "absent". Every other test
  // in this file drives secureGet with mockResolvedValue; this is the only one
  // that exercises a rejection.
  it("reports a secureGet rejection as unreadable", async () => {
    store.secureGet.mockRejectedValue(new Error("keychain locked"));
    await expect(loadGraphConfigState()).resolves.toEqual({
      state: "unreadable",
      config: null,
    });
  });

  it("reports nothing stored as absent, not unreadable", async () => {
    store.secureGet.mockResolvedValue(null);
    await expect(loadGraphConfigState()).resolves.toEqual({
      state: "absent",
      config: null,
    });
  });

  // A blank client ID is a half-finished setup, not corruption.
  it("reports a blank client ID as absent", async () => {
    store.secureGet.mockResolvedValue(JSON.stringify({ clientId: "  " }));
    await expect(loadGraphConfigState()).resolves.toMatchObject({ state: "absent" });
  });

  // The authority is the host that receives the auth code, the PKCE verifier
  // and later the refresh token. Rust rejects a non-https one outright; this
  // check exists so /odoo can say something useful first.
  it.each(["http://login.microsoftonline.com/x", "login.microsoftonline.com/x", "ftp://x.test"])(
    "reports %s as unreadable rather than handing it to Rust",
    async (authority) => {
      store.secureGet.mockResolvedValue(JSON.stringify({ clientId: "abc", authority }));
      await expect(loadGraphConfigState()).resolves.toMatchObject({ state: "unreadable" });
    }
  );
});

describe("saveGraphConfig", () => {
  it("trims both fields before storing", async () => {
    await saveGraphConfig({ clientId: "  abc  ", authority: "  https://x/tenant  " });
    expect(store.secureSet).toHaveBeenCalledWith(
      expect.any(String),
      JSON.stringify({ clientId: "abc", authority: "https://x/tenant" })
    );
  });
});
