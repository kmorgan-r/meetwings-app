/**
 * Holds the `meeting-ended` time of a capped stop for the next meeting-log
 * trigger. A widening cap (grace, silence, hand or unmount stop) caps the row
 * at `max(endedAt, newest system line)`, for a call that outran the signal. A
 * non-widening one (the new-call stop) caps it at `endedAt` exactly: by then
 * the newest system lines belong to the next call.
 *
 * Pure in-module state, deliberately unshared: the cap is a single value
 * handed from one trigger to the next, and any durable store would outlive
 * the process that set it and wrongly cap a later, unrelated row.
 */
export interface RecordingStopCap {
  endedAt: number;
  widen: boolean;
}

let held: RecordingStopCap | null = null;

/** Record the call-end time to cap the next trigger at (or clear with null). */
export function setRecordingStopCap(endedAt: number | null, widen = true): void {
  held = endedAt === null ? null : { endedAt, widen };
}

/** Return the held cap, or null when none is set, and clear it. */
export function takeRecordingStopCap(): RecordingStopCap | null {
  const value = held;
  held = null;
  return value;
}

/** The held cap, left in place. Compare by identity to tell whose it is. */
export function peekRecordingStopCap(): RecordingStopCap | null {
  return held;
}
