import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_CUSTOMIZABLE_STATE,
  getCustomizableState,
  updateContentProtection,
} from "@/lib/storage/customizable.storage";
import { STORAGE_KEYS } from "@/config/constants";

// setup.ts replaces the global localStorage with no-op vi.fn()s, so a
// round-trip needs a real backing store wired to those mocks.
const store = new Map<string, string>();

describe("customizable.storage contentProtection", () => {
  beforeEach(() => {
    store.clear();
    vi.mocked(localStorage.getItem).mockImplementation(
      (k: string) => store.get(k) ?? null
    );
    vi.mocked(localStorage.setItem).mockImplementation(
      (k: string, v: string) => {
        store.set(k, v);
      }
    );
  });

  it("defaults to enabled on first install", () => {
    // No stored state at all: the window must start hidden from
    // screenshots/recording, per the first-install default.
    expect(getCustomizableState().contentProtection).toEqual({
      isEnabled: true,
    });
    expect(DEFAULT_CUSTOMIZABLE_STATE.contentProtection.isEnabled).toBe(true);
  });

  it("falls back to enabled when stored state predates the setting", () => {
    // A user upgrading from an older build has a stored blob with no
    // contentProtection key - they must get the default, not undefined.
    localStorage.setItem(
      STORAGE_KEYS.CUSTOMIZABLE,
      JSON.stringify({
        appIcon: { isVisible: true },
        alwaysOnTop: { isEnabled: false },
        autostart: { isEnabled: true },
        cursor: { type: "invisible" },
      })
    );

    expect(getCustomizableState().contentProtection.isEnabled).toBe(true);
  });

  it("round-trips a toggle-off and preserves sibling settings", () => {
    localStorage.setItem(
      STORAGE_KEYS.CUSTOMIZABLE,
      JSON.stringify({
        appIcon: { isVisible: false },
        alwaysOnTop: { isEnabled: true },
        autostart: { isEnabled: false },
        cursor: { type: "default" },
        contentProtection: { isEnabled: true },
      })
    );

    const newState = updateContentProtection(false);

    expect(newState.contentProtection).toEqual({ isEnabled: false });
    expect(getCustomizableState().contentProtection.isEnabled).toBe(false);
    // updateContentProtection must not clobber unrelated settings.
    expect(getCustomizableState().appIcon.isVisible).toBe(false);
    expect(getCustomizableState().alwaysOnTop.isEnabled).toBe(true);
    expect(getCustomizableState().cursor.type).toBe("default");
  });
});