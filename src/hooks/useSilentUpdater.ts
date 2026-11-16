import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isLinux } from "@/lib/platform";
import { startSilentUpdater } from "@/lib/updater/silent-updater";
import { setMeetingActive } from "@/lib/updater/recording-activity.store";

/**
 * Runs the silent updater in the `main` window on Windows and macOS, and feeds
 * the install gate's meeting flag. Linux keeps the click-to-install Updater.
 */
export function useSilentUpdater(): void {
  useEffect(() => {
    if (getCurrentWindow().label !== "main") return;
    if (isLinux()) return;
    let cancelled = false;
    const unlisteners: Array<() => void> = [];

    // The cancelled flag is mandatory under StrictMode: listen() is async, so
    // the first mount's promises resolve AFTER cleanup and would leak handlers.
    const register = async (event: string, handler: () => void) => {
      const un = await listen(event, handler);
      if (cancelled) un();
      else unlisteners.push(un);
    };

    void Promise.all([
      register("meeting-detected", () => setMeetingActive(true)),
      register("meeting-ended", () => setMeetingActive(false)),
      // A watcher that stops mid-call emits no meeting-ended; without this the
      // flag would block updates until restart.
      register("meeting-watcher-stopped", () => setMeetingActive(false)),
    ]);

    const stop = startSilentUpdater();
    return () => {
      cancelled = true;
      stop();
      unlisteners.forEach((un) => un());
    };
  }, []);
}
