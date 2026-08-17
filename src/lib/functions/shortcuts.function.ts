import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getShortcutsConfig } from "@/lib/storage/shortcuts.storage";

// Global shortcuts are registered process-wide, but every window runs the same
// frontend and reads the same localStorage config. Letting each one push means
// `update_shortcuts` unregisters and re-registers the whole set once per window,
// leaving a gap where no shortcut is live. The main window owns the push.
const OWNER_WINDOW_LABEL = "main";

/**
 * Push the stored shortcuts config to the backend. No-op on any window other
 * than the owner. Returns whether the push actually happened.
 */
export const pushShortcutsConfig = async (): Promise<boolean> => {
  if (getCurrentWindow().label !== OWNER_WINDOW_LABEL) {
    return false;
  }

  try {
    const config = getShortcutsConfig();
    await invoke("update_shortcuts", { config });
    return true;
  } catch (error) {
    console.error("Failed to update shortcuts:", error);
    return false;
  }
};
