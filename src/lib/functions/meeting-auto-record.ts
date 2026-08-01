/**
 * Pure decisions for auto-recording detected meeting calls (issue #32).
 *
 * These take plain booleans read at the call site rather than reading refs or
 * storage themselves, so every branch is reachable from a unit test on the Linux
 * CI runner even though the feature only runs on Windows.
 */

export type DetectedDecision =
  | "start"
  | "ignore-off" // the switch is off
  | "ignore-busy" // a session is already open
  | "ignore-assist" // Meeting Assist Mode is holding the capture device
  | "ignore-undecided" // setup status has not finished loading
  | "tell-setup" // no AI/STT provider, and not a cloud subscriber
  | "tell-vad"; // VAD disabled, so nothing would actually record

export type EndedAction = "stop" | "ignore";

export type WatcherStoppedAction = "warn" | "ignore";

/**
 * Returns a REASON, not a boolean, so the choice between starting, ignoring
 * silently and explaining is made here rather than in the hook.
 *
 * The ORDER of these branches is part of the specification. `capturing` must be
 * tested before `setupComplete` and `vadEnabled`: a manual continuous session is
 * `capturing: true` with `vadEnabled: false`, and must be ignored in silence
 * rather than drawing the "enable voice detection" toast.
 *
 * `meetingAssistCapturing` is "Meeting Assist Mode is HOLDING the capture", not
 * "the Meeting Assist setting is on". The two are not the same: useMeetingAudio
 * only captures while `meetingAssistMode && enableVAD` (Audio.tsx:124), and
 * enableVAD defaults to false. Passing the bare setting here disables the whole
 * feature for every user who leaves the Meeting pill on with the mic closed -
 * silently, since this branch does not toast. The caller resolves it against
 * `get_capture_status`; see useMeetingAutoRecord.
 */
export const decideOnDetected = (s: {
  enabled: boolean;
  capturing: boolean;
  meetingAssistCapturing: boolean;
  setupLoading: boolean;
  setupComplete: boolean;
  vadEnabled: boolean;
}): DetectedDecision =>
  !s.enabled
    ? "ignore-off"
    : s.capturing
    ? "ignore-busy"
    : s.meetingAssistCapturing
    ? "ignore-assist"
    : s.setupLoading
    ? "ignore-undecided"
    : !s.setupComplete
    ? "tell-setup"
    : !s.vadEnabled
    ? "tell-vad"
    : "start";

/**
 * `autoStarted` alone carries the whole guarantee: it is only set after a start is
 * confirmed against Rust, and it is cleared on `capture-stopped` and by the stop
 * link itself. It deliberately does NOT read the React `capturing` mirror - an op
 * queued behind an in-flight start resumes on a microtask, while the ref sync runs
 * in a passive effect on a macrotask, so a `capturing` term would drop the stop.
 */
export const decideOnEnded = (s: { autoStarted: boolean }): EndedAction =>
  s.autoStarted ? "stop" : "ignore";

/**
 * `meeting-watcher-stopped` fires on ANY unexpected watcher death, most of which
 * happen with nothing recording. Without this guard the app would tell users to
 * "stop the recording manually" when there is no recording.
 */
export const decideOnWatcherStopped = (s: {
  autoStarted: boolean;
}): WatcherStoppedAction => (s.autoStarted ? "warn" : "ignore");
