import { describe, it, expect } from "vitest";
import { canInstallNow, type GateInput } from "@/lib/updater/install-gate";
import { MEETING_CONVERSATION_GAP_MS } from "@/config/constants";

const GAP = MEETING_CONVERSATION_GAP_MS;

const base: GateInput = {
  capturing: false,
  meetingActive: false,
  lastCaptureEndedAt: null,
  appBusy: false,
  now: 1_000_000_000,
};

describe("canInstallNow", () => {
  it("installs when idle with no capture since start", () => {
    expect(canInstallNow(base)).toBe(true);
  });

  it("defers while capturing", () => {
    expect(canInstallNow({ ...base, capturing: true })).toBe(false);
  });

  it("defers while a meeting is detected", () => {
    expect(canInstallNow({ ...base, meetingActive: true })).toBe(false);
  });

  it("defers while the app is busy (a team join applying), with no tail after", () => {
    expect(canInstallNow({ ...base, appBusy: true })).toBe(false);
    expect(canInstallNow({ ...base, appBusy: false })).toBe(true);
  });

  it("defers until the last capture ended 30 min ago", () => {
    expect(canInstallNow({ ...base, lastCaptureEndedAt: base.now - GAP + 1 })).toBe(
      false
    );
    expect(canInstallNow({ ...base, lastCaptureEndedAt: base.now - GAP })).toBe(
      true
    );
  });
});
