import { invoke } from "@tauri-apps/api/core";

/**
 * One line into detection.log in the app data dir (written by Rust, which
 * also logs capture sessions and watcher events there). Release builds have no
 * console, so this is how a dropped or never-restarted recording gets
 * explained. Decisions and states only: no transcript, no calendar text.
 *
 * Fire and forget. Mocked in src/tests/setup.ts so it never adds to the
 * invoke calls the auto-record tests count.
 */
export const detectionLog = (line: string): void => {
  invoke("log_detection", { line }).catch(() => {});
};
