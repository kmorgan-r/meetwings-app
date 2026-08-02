import { describe, expect, it } from "vitest";
import {
  decideOnDetected,
  decideOnEnded,
  decideOnWatcherStopped,
  type StartedMode,
} from "@/lib/functions/meeting-auto-record";

// The all-clear input. Every case below flips exactly one field from this, so no
// branch can be deleted without a failure.
const ALL_CLEAR = {
  enabled: true,
  capturing: false,
  globalCaptureHeld: false,
  setupLoading: false,
  setupComplete: true,
  meetingMode: false,
  vadOpen: false,
  vadEnabled: true,
};

describe("decideOnDetected", () => {
  it("starts when everything is clear", () => {
    expect(decideOnDetected(ALL_CLEAR)).toBe("start");
  });

  it("ignores when the switch is off", () => {
    expect(decideOnDetected({ ...ALL_CLEAR, enabled: false })).toBe("ignore-off");
  });

  it("ignores when a session is already open", () => {
    expect(decideOnDetected({ ...ALL_CLEAR, capturing: true })).toBe("ignore-busy");
  });

  it("ignores when Rust reports the global capture is already held", () => {
    expect(
      decideOnDetected({ ...ALL_CLEAR, globalCaptureHeld: true })
    ).toBe("ignore-active");
  });

  it("ignores while setup status is still loading", () => {
    expect(decideOnDetected({ ...ALL_CLEAR, setupLoading: true })).toBe(
      "ignore-undecided"
    );
  });

  it("explains when setup is incomplete", () => {
    expect(decideOnDetected({ ...ALL_CLEAR, setupComplete: false })).toBe(
      "tell-setup"
    );
  });

  it("explains when VAD is disabled", () => {
    expect(decideOnDetected({ ...ALL_CLEAR, vadEnabled: false })).toBe("tell-vad");
  });
});

// The ordering cases. These are where the real bugs live: two conditions are true
// at once and the earlier branch must win.
describe("decideOnDetected branch ordering", () => {
  it("prefers ignore-busy over tell-vad", () => {
    // A manual CONTINUOUS session is exactly this shape. Getting it backwards
    // toasts "enable voice detection" at a user who is already recording.
    expect(
      decideOnDetected({ ...ALL_CLEAR, capturing: true, vadEnabled: false })
    ).toBe("ignore-busy");
  });

  it("prefers ignore-busy over tell-setup", () => {
    expect(
      decideOnDetected({ ...ALL_CLEAR, capturing: true, setupComplete: false })
    ).toBe("ignore-busy");
  });

  it("prefers ignore-undecided over tell-setup", () => {
    // The cold-start case. Getting it backwards burns the once-per-run toast
    // budget on a wrong diagnosis while the app is still initialising.
    expect(
      decideOnDetected({ ...ALL_CLEAR, setupLoading: true, setupComplete: false })
    ).toBe("ignore-undecided");
  });

  it("prefers ignore-busy over the meeting fork", () => {
    // capturing must still be tested before the meetingMode fork, or a busy
    // session would be silently reinterpreted as a meeting-mode start.
    expect(
      decideOnDetected({ ...ALL_CLEAR, meetingMode: true, capturing: true })
    ).toBe("ignore-busy");
  });

  it("prefers ignore-active over the meeting fork", () => {
    // globalCaptureHeld must still be tested before the meetingMode fork, or a
    // live meeting session already holding the capture would be reconsidered
    // as a fresh meeting-mode start instead of being left alone.
    expect(
      decideOnDetected({ ...ALL_CLEAR, meetingMode: true, globalCaptureHeld: true })
    ).toBe("ignore-active");
  });
});

describe("decideOnDetected meeting mode", () => {
  it("starts meeting mode when the pill is on", () => {
    expect(decideOnDetected({ ...ALL_CLEAR, meetingMode: true })).toBe(
      "start-meeting"
    );
  });

  it("declines to claim a mic that is already listening", () => {
    expect(
      decideOnDetected({ ...ALL_CLEAR, meetingMode: true, vadOpen: true })
    ).toBe("ignore-mic-open");
  });

  it("still starts the transcribing pipeline when the pill is off, even with vadOpen true", () => {
    // Mandatory: a mutant that tests vadOpen BEFORE the meetingMode fork would
    // survive every other case here and silently disable auto-record for every
    // transcribing user whose mic happens to be open.
    expect(decideOnDetected({ ...ALL_CLEAR, vadOpen: true })).toBe("start");
  });

  it("ignores the transcribing VAD setting on the meeting path", () => {
    // vadEnabled governs useSystemAudio's transcribing pipeline only;
    // useMeetingAudio hardcodes its own VAD config. Testing it before the fork
    // would wrongly refuse meeting starts over a setting that does not apply.
    expect(
      decideOnDetected({ ...ALL_CLEAR, meetingMode: true, vadEnabled: false })
    ).toBe("start-meeting");
  });
});

describe("decideOnEnded", () => {
  it("stops the meeting pipeline for a meeting-mode session", () => {
    expect(decideOnEnded({ startedMode: "meeting" })).toBe("stop-meeting");
  });

  it("stops the transcribing pipeline for a transcribing session", () => {
    expect(decideOnEnded({ startedMode: "transcribing" })).toBe(
      "stop-transcribing"
    );
  });

  it("ignores a session it did not start", () => {
    expect(decideOnEnded({ startedMode: null })).toBe("ignore");
  });
});

describe("decideOnWatcherStopped", () => {
  it("warns while auto-recording in meeting mode", () => {
    expect(decideOnWatcherStopped({ startedMode: "meeting" })).toBe("warn");
  });

  it("warns while auto-recording in transcribing mode", () => {
    expect(decideOnWatcherStopped({ startedMode: "transcribing" })).toBe("warn");
  });

  it("stays quiet when nothing is being auto-recorded", () => {
    expect(decideOnWatcherStopped({ startedMode: null })).toBe("ignore");
  });

  it("degrades a stale call-site shape to ignore rather than warn", () => {
    // Simulates a call site that was never migrated off the pre-#32 shape
    // (`{ autoStarted: true }`). decideOnWatcherStopped tests TRUTHINESS of
    // startedMode, so the missing field reads as undefined -> falsy -> "ignore".
    // A mutant written as `startedMode !== null` would instead see
    // `undefined !== null` as true and wrongly return "warn".
    const stale = { autoStarted: true } as unknown as { startedMode: StartedMode };
    expect(decideOnWatcherStopped(stale)).toBe("ignore");
  });
});
