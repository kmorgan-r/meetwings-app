/**
 * Holds the `meeting-ended` time of a grace stop for the next meeting-log
 * trigger, which caps the row at `max(endedAt, newest system line)`.
 *
 * Pure in-module state, deliberately unshared: the cap is a single value
 * handed from one trigger to the next, and any durable store would outlive
 * the process that set it and wrongly cap a later, unrelated row.
 */
let held: number | null = null;

/** Record the call-end time to cap the next trigger at (or clear with null). */
export function setRecordingStopCap(endedAt: number | null): void {
  held = endedAt;
}

/** Return the held cap, or null when none is set, and clear it. */
export function takeRecordingStopCap(): number | null {
  const value = held;
  held = null;
  return value;
}
