import { beforeEach, describe, expect, it } from "vitest";
import { STORAGE_KEYS } from "@/config/constants";
import { recordAppVersion, readUpdatedNote } from "@/lib/updater/version-note";
import { installMemoryLocalStorage } from "./memory-local-storage";

let store: Map<string, string>;

beforeEach(() => {
  store = installMemoryLocalStorage();
});

describe("version note", () => {
  it("first install records the version and shows no note", () => {
    recordAppVersion("1.6.0", 1736900000000);

    expect(store.get(STORAGE_KEYS.APP_LAST_VERSION)).toBe("1.6.0");
    expect(store.has(STORAGE_KEYS.APP_UPDATED_TO)).toBe(false);
    expect(readUpdatedNote("1.6.0")).toBeNull();
  });

  it("same version again shows no note", () => {
    recordAppVersion("1.6.0", 1736900000000);

    recordAppVersion("1.6.0", 1736900060000);

    expect(store.get(STORAGE_KEYS.APP_LAST_VERSION)).toBe("1.6.0");
    expect(store.has(STORAGE_KEYS.APP_UPDATED_TO)).toBe(false);
    expect(readUpdatedNote("1.6.0")).toBeNull();
  });

  it("a changed version shows the note once for that version", () => {
    recordAppVersion("1.5.0", 1736900000000);

    recordAppVersion("1.6.0", 1736900600000);

    expect(readUpdatedNote("1.6.0")).toEqual({
      version: "1.6.0",
      at: 1736900600000,
    });
    // The replaced version gets no note back — the note is for the new one.
    expect(readUpdatedNote("1.5.0")).toBeNull();
  });

  it("a stale note for another version is ignored", () => {
    store.set(
      STORAGE_KEYS.APP_UPDATED_TO,
      JSON.stringify({ version: "1.6.0", at: 1736900000000 })
    );

    expect(readUpdatedNote("1.6.1")).toBeNull();
  });
});
