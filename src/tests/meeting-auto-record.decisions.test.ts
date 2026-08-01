import { describe, expect, it } from "vitest";
import {
  decideOnDetected,
  decideOnEnded,
  decideOnWatcherStopped,
} from "@/lib/functions/meeting-auto-record";

// The all-clear input. Every case below flips exactly one field from this, so no
// branch can be deleted without a failure.
const ALL_CLEAR = {
  enabled: true,
  capturing: false,
  meetingAssistCapturing: false,
  setupLoading: false,
  setupComplete: true,
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

  it("ignores when Meeting Assist Mode is holding the device", () => {
    expect(
      decideOnDetected({ ...ALL_CLEAR, meetingAssistCapturing: true })
    ).toBe("ignore-assist");
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
});

describe("decideOnEnded", () => {
  it("stops a session this feature started", () => {
    expect(decideOnEnded({ autoStarted: true })).toBe("stop");
  });

  it("ignores a session it did not start", () => {
    expect(decideOnEnded({ autoStarted: false })).toBe("ignore");
  });
});

describe("decideOnWatcherStopped", () => {
  it("warns while auto-recording", () => {
    expect(decideOnWatcherStopped({ autoStarted: true })).toBe("warn");
  });

  it("stays quiet when nothing is being auto-recorded", () => {
    expect(decideOnWatcherStopped({ autoStarted: false })).toBe("ignore");
  });
});
