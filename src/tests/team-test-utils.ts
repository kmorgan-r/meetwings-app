import { vi } from "vitest";
import { installMemoryLocalStorage } from "./memory-local-storage";

/**
 * In-memory secure store, Notion keychain and localStorage for the team tests.
 * Wire a fresh fake per test; the mock factories delegate to the current one:
 *
 *   import type { TeamStorageFake } from "./team-test-utils";
 *   const h = vi.hoisted(() => ({ fake: undefined as unknown as TeamStorageFake }));
 *   vi.mock("@/lib/secure-storage", () => ({
 *     secureGet: (k: string) => h.fake.secureModule.secureGet(k),
 *     secureSet: (k: string, v: string) => h.fake.secureModule.secureSet(k, v),
 *     secureDelete: (k: string) => h.fake.secureModule.secureDelete(k),
 *     secureHas: (k: string) => h.fake.secureModule.secureHas(k),
 *   }));
 *   vi.mock("@tauri-apps/api/core", () => ({
 *     invoke: (cmd: string, args?: unknown) => h.fake.invoke(cmd, args),
 *   }));
 *   beforeEach(() => {
 *     h.fake = createTeamStorageFake();
 *     resetSecureProviderConfigsCache();
 *   });
 *
 * failWhen(pred) makes every matching op throw BEFORE it changes anything. Ops:
 * "secureGet" | "secureSet" | "secureDelete" | "secureHas" | "localSet" |
 * "localRemove" (key = storage key), or an invoke command name such as
 * "notion_token_set" (key undefined).
 */
export function createTeamStorageFake() {
  const secure = new Map<string, string>();
  const keychain: { token: string | null } = { token: null };
  let failing: (op: string, key?: string) => boolean = () => false;
  const check = (op: string, key?: string) => {
    if (failing(op, key)) throw new Error(`fake ${op} failure`);
  };

  const local = installMemoryLocalStorage();
  // Call history starts at zero for each fake, so tests can count writes.
  vi.mocked(localStorage.setItem).mockClear();
  vi.mocked(localStorage.removeItem).mockClear();
  vi.mocked(localStorage.setItem).mockImplementation((key: string, value: string) => {
    check("localSet", key);
    local.set(key, String(value));
  });
  vi.mocked(localStorage.removeItem).mockImplementation((key: string) => {
    check("localRemove", key);
    local.delete(key);
  });

  const secureModule = {
    secureGet: vi.fn(async (key: string): Promise<string | null> => {
      check("secureGet", key);
      return secure.get(key) ?? null;
    }),
    secureSet: vi.fn(async (key: string, value: string): Promise<void> => {
      check("secureSet", key);
      secure.set(key, value);
    }),
    secureDelete: vi.fn(async (key: string): Promise<void> => {
      check("secureDelete", key);
      secure.delete(key);
    }),
    secureHas: vi.fn(async (key: string): Promise<boolean> => {
      check("secureHas", key);
      return secure.has(key);
    }),
  };

  const invoke = vi.fn(async (cmd: string, args?: any): Promise<unknown> => {
    check(cmd);
    switch (cmd) {
      case "notion_token_get":
        return keychain.token;
      case "notion_token_set":
        keychain.token = args.token;
        return undefined;
      case "notion_token_clear":
        keychain.token = null;
        return undefined;
      case "notion_keychain_available":
        return true;
      case "google_disconnect":
        return undefined;
      default:
        throw new Error(`fake invoke: unexpected command ${cmd}`);
    }
  });

  const sorted = (m: Map<string, string>) =>
    Object.fromEntries([...m].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

  return {
    secure,
    local,
    keychain,
    invoke,
    secureModule,
    snapshot: (): string =>
      JSON.stringify({ secure: sorted(secure), local: sorted(local), token: keychain.token }),
    failWhen(pred: (op: string, key?: string) => boolean): void {
      failing = pred;
    },
  };
}

export type TeamStorageFake = ReturnType<typeof createTeamStorageFake>;
