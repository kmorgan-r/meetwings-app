/**
 * Pure decisions for auto-recording detected meeting calls (issue #32).
 *
 * These take plain booleans read at the call site rather than reading refs or
 * storage themselves, so every branch is reachable from a unit test on the Linux
 * CI runner even though the feature only runs on Windows.
 */

export type StartedMode = "meeting" | "transcribing" | null;

export type DetectedDecision =
  | "start" // transcribing mode
  | "start-meeting" // meeting mode
  | "ignore-off" // the switch is off
  | "ignore-busy" // useSystemAudio's own mirror says a session is open
  | "ignore-active" // Rust says the global capture is already held
  | "ignore-mic-open" // the mic is already listening - not ours to claim
  | "ignore-undecided" // setup status has not finished loading
  | "tell-setup" // no AI/STT provider, and not a cloud subscriber
  | "tell-vad"; // VAD disabled, so a transcribing start would record nothing

/**
 * REPLACES the old single "stop" member. Replacement rather than augmentation is
 * deliberate: it turns `useMeetingAutoRecord`'s `!== "stop"` comparison into a
 * TS2367 compile error instead of a silent regression that would swallow both
 * new stop actions.
 */
export type EndedAction = "stop-meeting" | "stop-transcribing" | "ignore";

export type WatcherStoppedAction = "warn" | "ignore";

/**
 * Returns a REASON, not a boolean, so the choice between starting, ignoring
 * silently and explaining is made here rather than in the hook.
 *
 * The ORDER of these branches is part of the specification.
 *
 * `capturing` is tested before `vadEnabled` because a manual continuous session
 * is `capturing: true` with `vadEnabled: false`, and must be ignored in silence
 * rather than drawing the "enable voice detection" toast.
 *
 * `globalCaptureHeld` means "something already holds the global capture device",
 * resolved by the caller against `get_capture_status`. It is tested before the
 * meeting fork, which makes `ignore-mic-open` a NARROW branch: a healthy live
 * meeting session holds the capture, so it returns `ignore-active` first.
 * `ignore-mic-open` therefore fires only when the mic is open AND Rust reports
 * idle - the guest half failed to start, or is mid device-change re-run, or the
 * user opened the mic with the pill on before anything captured.
 *
 * `vadEnabled` is `useSystemAudio`'s `vadConfig.enabled`, which governs the
 * TRANSCRIBING pipeline only - useMeetingAudio hardcodes MEETING_VAD_CONFIG
 * with `enabled: true`. Testing it before the fork would refuse meeting starts
 * over a setting that does not apply.
 */
export const decideOnDetected = (s: {
  enabled: boolean;
  capturing: boolean;
  globalCaptureHeld: boolean;
  setupLoading: boolean;
  setupComplete: boolean;
  meetingMode: boolean;
  vadOpen: boolean;
  vadEnabled: boolean;
}): DetectedDecision =>
  !s.enabled
    ? "ignore-off"
    : s.capturing
    ? "ignore-busy"
    : s.globalCaptureHeld
    ? "ignore-active"
    : s.setupLoading
    ? "ignore-undecided"
    : !s.setupComplete
    ? "tell-setup"
    : s.meetingMode
    ? s.vadOpen
      ? "ignore-mic-open"
      : "start-meeting"
    : !s.vadEnabled
    ? "tell-vad"
    : "start";

/**
 * `startedMode` carries both "did we start this" and "which pipeline".
 *
 * For the meeting path it is also the mic-ownership flag: set when this hook
 * writes `enableVAD` false->true, released at the first commit observing
 * `enableVAD` false. It is never set from `get_capture_status` - that query is
 * used only to DECLINE, never to claim.
 *
 * `capture-stopped` must NOT clear meeting provenance: it fires on any stop,
 * including a mid-call useMeetingAudio deps re-run, and clearing there
 * permanently disarms auto-stop while the capture keeps running.
 */
export const decideOnEnded = (s: { startedMode: StartedMode }): EndedAction =>
  s.startedMode === "meeting"
    ? "stop-meeting"
    : s.startedMode === "transcribing"
    ? "stop-transcribing"
    : "ignore";

/**
 * Tests TRUTHINESS, not `!== null`, so a stale `{ autoStarted: … }` call site
 * degrades to "ignore" rather than "warn".
 */
export const decideOnWatcherStopped = (s: {
  startedMode: StartedMode;
}): WatcherStoppedAction => (s.startedMode ? "warn" : "ignore");
