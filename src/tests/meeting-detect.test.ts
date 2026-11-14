import { describe, expect, it } from "vitest";
import {
  amberKindFor,
  computeWatchLists,
  hasQualifyingMeetEvent,
  isGatedProcess,
  meetingLabel,
} from "@/lib/meeting-detect";
import { EARLY_JOIN_MS } from "@/lib/calendar/current-meeting";
import { MEETING_DETECT_PROCESSES } from "@/config/constants";
import type { CalendarEvent, GoogleErrorCode } from "@/types";

const NOW = Date.UTC(2026, 10, 13, 14, 0, 0);
const MIN = 60_000;

function event(over: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: "e1",
    subject: "Sync",
    startMs: NOW + 10 * MIN,
    endMs: NOW + 40 * MIN,
    isCancelled: false,
    isAllDay: false,
    ownResponse: "accepted",
    hasMeetLink: true,
    participants: [
      { address: "me@corp.test", name: null, type: "required", isOrganizer: true },
      { address: "a@acme.example", name: null, type: "required", isOrganizer: false },
    ],
    ...over,
  };
}

describe("hasQualifyingMeetEvent", () => {
  it("requires a Meet link", () => {
    const inWindow = NOW + 8 * MIN;
    expect(hasQualifyingMeetEvent([event()], inWindow)).toBe(true);
    expect(hasQualifyingMeetEvent([event({ hasMeetLink: false })], inWindow)).toBe(false);
  });
  it("accepts now == startMs - EARLY_JOIN_MS", () => {
    const e = event();
    expect(hasQualifyingMeetEvent([e], e.startMs - EARLY_JOIN_MS)).toBe(true);
    expect(hasQualifyingMeetEvent([e], e.startMs - EARLY_JOIN_MS - 1)).toBe(false);
  });
  it("rejects now == endMs", () => {
    const e = event();
    expect(hasQualifyingMeetEvent([e], e.endMs)).toBe(false);
    expect(hasQualifyingMeetEvent([e], e.endMs - 1)).toBe(true);
  });
  it("accepts a solo event", () => {
    const e = event({ participants: [event().participants[0]] });
    expect(hasQualifyingMeetEvent([e], NOW + 8 * MIN)).toBe(true);
  });
  it("rejects declined, cancelled and all-day", () => {
    expect(hasQualifyingMeetEvent([event({ ownResponse: "declined" })], NOW + 8 * MIN)).toBe(false);
    expect(hasQualifyingMeetEvent([event({ isCancelled: true })], NOW + 8 * MIN)).toBe(false);
    expect(hasQualifyingMeetEvent([event({ isAllDay: true })], NOW + 8 * MIN)).toBe(false);
  });
  it("any qualifying event among several", () => {
    const events = [event({ hasMeetLink: false }), event({ id: "e2" })];
    expect(hasQualifyingMeetEvent(events, NOW + 8 * MIN)).toBe(true);
  });
});

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

describe("computeWatchLists", () => {
  it("absent has no gated list", () => {
    expect(computeWatchLists("absent")).toEqual({ direct: MEETING_DETECT_PROCESSES, gated: [] });
  });
  it("unreadable and complete gate chrome", () => {
    expect(computeWatchLists("unreadable").gated).toEqual(["chrome.exe"]);
    expect(computeWatchLists("complete").gated).toEqual(["chrome.exe"]);
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
