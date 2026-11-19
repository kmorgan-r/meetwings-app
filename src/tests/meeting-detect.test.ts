import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/storage/google-config.storage", async (orig) => ({
  ...(await orig<typeof import("@/lib/storage/google-config.storage")>()),
  loadGoogleConfigState: async () => ({ state: "absent", config: null }),
}));

import {
  amberKindFor,
  currentWatchLists,
  entryMatches,
  isGatedProcess,
  meetingLabel,
  sameCallId,
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

describe("entryMatches", () => {
  it("applies the helper-prefix rule to Mac entries only", () => {
    expect(entryMatches("com.google.Chrome", "com.google.Chrome")).toBe(true);
    expect(entryMatches("com.google.Chrome", "COM.GOOGLE.CHROME.HELPER")).toBe(true);
    expect(entryMatches("com.google.Chrome", "com.google.ChromeX")).toBe(false);
    expect(entryMatches("chrome.exe", "chrome.exe.foo")).toBe(false);
    expect(entryMatches("Teams.exe", "teams.exe")).toBe(true);
  });
});

// Mac and Windows share one matcher, so a Mac bundle ID flows through the same
// label, gate and same-call decisions without a second code path.
describe("Mac IDs through the shared matcher", () => {
  it("labels a Chrome helper and the mixed-case constant as Google Meet", () => {
    expect(meetingLabel("com.google.Chrome")).toBe("Google Meet");
    expect(meetingLabel("com.google.Chrome.helper")).toBe("Google Meet");
    expect(meetingLabel("com.google.ChromeX")).toBe("Meeting");
  });
  it("gates Chrome helpers, never WebKit", () => {
    expect(isGatedProcess("com.google.Chrome")).toBe(true);
    expect(isGatedProcess("COM.GOOGLE.CHROME.HELPER")).toBe(true);
    expect(isGatedProcess("com.google.ChromeX")).toBe(false);
    expect(isGatedProcess("com.apple.WebKit.WebContent")).toBe(false);
    expect(meetingLabel("com.apple.WebKit.GPU")).toBe("Meeting");
  });
  it("treats a helper and its app as the same call, in both directions", () => {
    expect(sameCallId("com.google.Chrome", "com.google.Chrome.helper")).toBe(true);
    expect(sameCallId("com.google.Chrome.helper", "com.google.Chrome")).toBe(true);
    expect(sameCallId("com.google.Chrome.helper", "com.google.Chrome.helper.Renderer")).toBe(true);
    expect(sameCallId("com.google.Chrome", "com.google.ChromeX")).toBe(false);
    expect(sameCallId("chrome.exe", "chrome.exe.foo")).toBe(false);
    expect(sameCallId("ms-teams.exe", "Zoom.exe")).toBe(false);
    expect(sameCallId("Teams.exe", "teams.exe")).toBe(true);
  });
});
