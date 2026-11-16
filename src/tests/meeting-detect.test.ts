import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/storage/google-config.storage", async (orig) => ({
  ...(await orig<typeof import("@/lib/storage/google-config.storage")>()),
  loadGoogleConfigState: async () => ({ state: "absent", config: null }),
}));

import {
  amberKindFor,
  currentWatchLists,
  isGatedProcess,
  meetingLabel,
} from "@/lib/meeting-detect";
import { MEETING_DETECT_PROCESSES } from "@/config/constants";
import type { GoogleErrorCode } from "@/types";

describe("amberKindFor", () => {
  const reconnect: GoogleErrorCode[] = [
    "GOOGLE_AUTH_EXPIRED",
    "GOOGLE_AUTH_REJECTED",
    "GOOGLE_CONSENT_REQUIRED",
    "GOOGLE_AUTH_CANCELLED",
    "GOOGLE_NOT_CONNECTED",
  ];
  const offline: GoogleErrorCode[] = [
    "GOOGLE_NETWORK",
    "GOOGLE_THROTTLED",
    "GOOGLE_BAD_RESPONSE",
    "GOOGLE_NO_KEYCHAIN",
  ];
  it.each(reconnect)("%s -> reconnect", (c) => {
    expect(amberKindFor(c, "complete")).toBe("reconnect");
  });
  it.each(offline)("%s -> offline", (c) => {
    expect(amberKindFor(c, "complete")).toBe("offline");
  });
  it("unreadable config -> settings", () => {
    expect(amberKindFor("GOOGLE_AUTH_REJECTED", "unreadable")).toBe("settings");
  });
});

describe("currentWatchLists", () => {
  it("watches Chrome even when Google is not set up", async () => {
    await expect(currentWatchLists()).resolves.toEqual({
      direct: MEETING_DETECT_PROCESSES,
      gated: ["chrome.exe"],
    });
  });
});

describe("meetingLabel", () => {
  it("maps known processes case-insensitively", () => {
    expect(meetingLabel("CHROME.EXE")).toBe("Google Meet");
    expect(meetingLabel("MS-Teams.exe")).toBe("Teams");
  });
  it("labels Zoom.exe as Zoom", () => {
    expect(meetingLabel("Zoom.exe")).toBe("Zoom");
  });
  it("falls back", () => {
    expect(meetingLabel(undefined)).toBe("Meeting");
    expect(meetingLabel("notepad.exe")).toBe("Meeting");
  });
});

describe("isGatedProcess", () => {
  it("is case-insensitive membership", () => {
    expect(isGatedProcess("Chrome.exe")).toBe(true);
    expect(isGatedProcess("ms-teams.exe")).toBe(false);
  });
  it("never gates Zoom", () => {
    expect(isGatedProcess("Zoom.exe")).toBe(false);
  });
});

// Zoom joins Teams as a directly watched process: audio from the desktop
// client alone proves a call, with no calendar gate.
describe("Zoom detection entry", () => {
  it("watches Zoom.exe directly", () => {
    expect(MEETING_DETECT_PROCESSES).toContain("Zoom.exe");
  });
});
