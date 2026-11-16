import { useEffect } from "react";

/** Where a capture comes from; each source reports its own activity. */
export type CaptureSource = "system-audio" | "mic";

/** App work a restart must not cut off (a first team join writing settings). */
export type AppBusySource = "team-join";

// Module-level store: which capture sources are currently active, whether a
// meeting is detected, and when the last capture or meeting ended. Consumers
// the silent updater reads via getActivitySnapshot()/canInstallNow().
const activeSources = new Set<CaptureSource>();
let meetingActive = false;
let lastCaptureEndedAt: number | null = null;
const busySources = new Set<AppBusySource>();

/**
 * Report one capture source starting or stopping. `lastCaptureEndedAt` is
 * stamped only when the set of active sources goes from non-empty to empty,
 * so a system-audio capture continuing after the mic stops keeps no stamp.
 */
export function setCaptureActive(
  source: CaptureSource,
  active: boolean,
  now: number = Date.now()
): void {
  if (active) {
    activeSources.add(source);
    return;
  }
  if (!activeSources.has(source)) return;
  activeSources.delete(source);
  if (activeSources.size === 0) {
    lastCaptureEndedAt = now;
  }
}

/**
 * Report whether a meeting is currently detected. A meeting that ends stamps
 * `lastCaptureEndedAt` like a capture does, so the gate's quiet tail covers a
 * detection flap mid-call; an end with no meeting active stamps nothing.
 */
export function setMeetingActive(active: boolean, now: number = Date.now()): void {
  if (meetingActive && !active) lastCaptureEndedAt = now;
  meetingActive = active;
}

/** Report app work that blocks the gate while set; no quiet tail after. */
export function setAppBusy(source: AppBusySource, active: boolean): void {
  if (active) busySources.add(source);
  else busySources.delete(source);
}

/** The store's current state for gate consumers. */
export function getActivitySnapshot(): {
  capturing: boolean;
  meetingActive: boolean;
  lastCaptureEndedAt: number | null;
  appBusy: boolean;
} {
  return {
    capturing: activeSources.size > 0,
    meetingActive,
    lastCaptureEndedAt,
    appBusy: busySources.size > 0,
  };
}

/**
 * Report `source` as active while `active` is true. Its deps are only
 * `source` and `active`, so a re-render that changes anything else (a
 * conversation switch) never stamps a false end.
 */
export function useReportCaptureActivity(
  source: CaptureSource,
  active: boolean
): void {
  useEffect(() => {
    setCaptureActive(source, active);
    return () => setCaptureActive(source, false);
  }, [source, active]);
}

/** Wipe all module state between tests. */
export function __resetActivityForTests(): void {
  activeSources.clear();
  meetingActive = false;
  lastCaptureEndedAt = null;
  busySources.clear();
}
