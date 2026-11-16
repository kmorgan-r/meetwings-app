import { getCurrentWindow } from "@tauri-apps/api/window";
import { disable, enable, isEnabled } from "@tauri-apps/plugin-autostart";
import { STORAGE_KEYS } from "@/config/constants";
import { isWindows } from "@/lib/platform";
import { safeLocalStorage } from "@/lib/storage/helper";

/**
 * Applies the autostart setting on the very first launch. Later Windows
 * release launches re-enable an enabled entry so it points at the running
 * exe: the silent MSI -> NSIS upgrade moves the app, and the Run entry would
 * keep launching the old MSI copy. Never in dev (it would point the owner's
 * startup at a debug binary), never when disabled, and only from `main` so a
 * dashboard opening does not repeat it.
 */
export async function initializeAutostart(enabledSetting: boolean): Promise<void> {
  try {
    if (!safeLocalStorage.getItem(STORAGE_KEYS.AUTOSTART_INITIALIZED)) {
      if (enabledSetting) {
        await enable();
      } else {
        await disable();
      }
      // Mark as initialized so this never runs again
      safeLocalStorage.setItem(STORAGE_KEYS.AUTOSTART_INITIALIZED, "true");
    } else if (
      import.meta.env.PROD &&
      isWindows() &&
      getCurrentWindow().label === "main" &&
      (await isEnabled())
    ) {
      await enable();
    }
  } catch (error) {
    console.debug("Autostart initialization skipped:", error);
  }
}
