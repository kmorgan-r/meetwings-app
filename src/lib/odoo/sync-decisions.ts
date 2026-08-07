/**
 * When a sync may run. Pure, in the shape src/lib/functions/meeting-auto-record.ts
 * established - plain values in, a REASON out, so every branch is reachable
 * from a unit test.
 */

export const SYNC_MIN_INTERVAL_MS = 60 * 60 * 1000;

export type SyncTrigger = "app-start" | "refresh" | "settings";

export type SyncDecision =
  | "run"
  | "skip-no-credentials"
  | "skip-recent"
  | "skip-in-meeting";

/**
 * The ORDER of these branches is part of the specification.
 *
 * Credentials are tested first because without them no trigger can run, manual
 * or not. The manual triggers then bypass BOTH remaining rules: a user who
 * presses Refresh has asked, including mid-meeting.
 */
export const decideSync = (s: {
  trigger: SyncTrigger;
  hasCredentials: boolean;
  lastSyncAt: number | null;
  now: number;
  meetingMode: boolean;
}): SyncDecision =>
  !s.hasCredentials
    ? "skip-no-credentials"
    : s.trigger !== "app-start"
    ? "run"
    : s.meetingMode
    ? "skip-in-meeting"
    : s.lastSyncAt !== null && s.now - s.lastSyncAt < SYNC_MIN_INTERVAL_MS
    ? "skip-recent"
    : "run";
