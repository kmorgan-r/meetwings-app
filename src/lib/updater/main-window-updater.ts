import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isLinux } from "@/lib/platform";
import { startSilentUpdater } from "@/lib/updater/silent-updater";
import { setMeetingActive } from "@/lib/updater/recording-activity.store";
import { recordAppVersion } from "@/lib/updater/version-note";

/**
 * Runs the silent updater in the `main` window on Windows and macOS, and feeds
 * the install gate's meeting flag. Linux keeps the click-to-install Updater.
 * Started from main.tsx outside React, so a render crash in the overlay can
 * neither stop nor prevent it. Returns stop.
 */
export function startMainWindowUpdater(): () => void {
  if (getCurrentWindow().label !== "main") return () => {};
  // Record the running version on every OS (Settings shows the "Updated to
  // X" note); use invoke directly — getAppVersion() returns "Unknown" on
  // failure, which would be recorded as a version change.
  invoke<string>("get_app_version")
    .then((v) => recordAppVersion(v, Date.now()))
    .catch(() => {});
  if (isLinux()) return () => {};
  let cancelled = false;
  const unlisteners: Array<() => void> = [];

  // listen() is async: a stop() before it resolves must still unlisten.
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
  ]).catch(() => {});

  const stop = startSilentUpdater();
  return () => {
    cancelled = true;
    stop();
    unlisteners.forEach((un) => un());
  };
}
