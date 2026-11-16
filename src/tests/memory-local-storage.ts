import { vi } from "vitest";

/**
 * setup.ts replaces the global localStorage with inert vi.fn() stubs, so a
 * round-trip needs a backing store wired to them (precedent:
 * customizable.storage.test.ts). Points getItem/setItem/removeItem/clear at a
 * fresh Map and returns it, so a test can seed, assert and enumerate.
 */
export function installMemoryLocalStorage(): Map<string, string> {
  const store = new Map<string, string>();
  vi.mocked(localStorage.getItem).mockImplementation(
    (key: string) => store.get(key) ?? null
  );
  vi.mocked(localStorage.setItem).mockImplementation(
    (key: string, value: string) => {
      store.set(key, String(value));
    }
  );
  vi.mocked(localStorage.removeItem).mockImplementation((key: string) => {
    store.delete(key);
  });
  vi.mocked(localStorage.clear).mockImplementation(() => {
    store.clear();
  });
  return store;
}
