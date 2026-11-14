import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AMBER_SNOOZE_MS,
  autoRecordingStarted,
  autoRecordingStopped,
  cardHeight,
  dismissAmber,
  dismissCard,
  getActiveAutoRecording,
  getMeetingCard,
  holdCard,
  pillWindowSize,
  resetMeetingCardsForTests,
  setCardEvent,
  showAmber,
  snoozeAmber,
  stopActiveRecording,
  type MeetingCardState,
} from "@/lib/meeting-cards.store";
import { PILL_DIMENSIONS } from "@/lib/overlay-minimize.store";
import type { CalendarEvent, CalendarParticipant } from "@/types";

const noop = () => {};
const goto = (t: number) => vi.advanceTimersByTime(t - Date.now());

function person(name: string | null, address: string, type: CalendarParticipant["type"] = "required"): CalendarParticipant {
  return { address, name, type, isOrganizer: false };
}

function event(subject: string | null, participants: CalendarParticipant[] = []): CalendarEvent {
  return {
    id: "e1",
    subject,
    startMs: 1000,
    endMs: 2000,
    isCancelled: false,
    isAllDay: false,
    ownResponse: "accepted",
    participants,
    hasMeetLink: true,
  };
}

function start(app = "Google Meet", now = Date.now()): number {
  return autoRecordingStarted({ app, gated: false, stop: noop }, now);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  resetMeetingCardsForTests();
});

afterEach(() => {
  resetMeetingCardsForTests();
  vi.useRealTimers();
});

describe("meeting card store", () => {
  it("a start shows the red card", () => {
    const id = start("Google Meet");
    const card = getMeetingCard();
    expect(card?.kind).toBe("recording");
    if (card?.kind === "recording") {
      expect(card.app).toBe("Google Meet");
      expect(card.recordingId).toBe(id);
    }
  });

  it("same-app restart within 2 minutes shows no red card and cancels the ended card", () => {
    start("Google Meet", 0);
    goto(40_000);
    autoRecordingStopped(40_000);
    dismissCard();
    goto(60_000);
    start("Google Meet", 60_000);
    expect(getMeetingCard()).toBeNull();
    goto(120_000);
    expect(getMeetingCard()).toBeNull();
  });

  it("a different app within 2 minutes gets its own red card", () => {
    start("Google Meet", 0);
    autoRecordingStopped(0);
    goto(60_000);
    start("Zoom", 60_000);
    expect(getMeetingCard()?.kind).toBe("recording");
  });

  it("same-app restart after 2 minutes gets a red card", () => {
    start("Google Meet", 0);
    autoRecordingStopped(0);
    goto(120_000);
    start("Google Meet", 120_000);
    expect(getMeetingCard()?.kind).toBe("recording");
  });

  it("the ended card waits 30s", () => {
    start("Google Meet", 0);
    goto(10_000);
    autoRecordingStopped(10_000);
    goto(39_999);
    expect(getMeetingCard()).toBeNull();
    goto(40_000);
    const card = getMeetingCard();
    expect(card?.kind).toBe("ended");
    if (card?.kind === "ended") expect(card.durationMs).toBe(10_000);
  });

  it("a quiet restart carries the start time and event", () => {
    const id = start("Google Meet", 0);
    setCardEvent(id, event("Weekly sync"));
    goto(60_000);
    autoRecordingStopped(60_000);
    goto(85_000);
    start("Google Meet", 85_000);
    goto(300_000);
    autoRecordingStopped(300_000);
    goto(330_000);
    const card = getMeetingCard();
    expect(card?.kind).toBe("ended");
    if (card?.kind === "ended") {
      expect(card.durationMs).toBe(300_000);
      expect(card.title).toBe("Weekly sync");
    }
  });

  it("stopping twice schedules one ended card", () => {
    start("Google Meet", 0);
    autoRecordingStopped(0);
    autoRecordingStopped(5_000);
    goto(30_000);
    const first = getMeetingCard();
    expect(first?.kind).toBe("ended");
    goto(35_000); // ended card leaves after 5s; a second scheduled card would not
    expect(getMeetingCard()).toBeNull();
    goto(100_000);
    expect(getMeetingCard()).toBeNull();
  });

  it("setCardEvent fills the current card and ignores a stale id", () => {
    const id = start();
    setCardEvent(id + 99, event("Stale"));
    const before = getMeetingCard();
    expect(before?.kind === "recording" && before.event).toBeNull();

    setCardEvent(
      id,
      event("Planning", [
        person("Ada Lovelace", "ada@x.com"),
        person("Grace Brewster Hopper", "grace@x.com"),
        person(null, "bob@x.com"),
        person("Dan", "dan@x.com"),
        person("Eve Adams", "eve@x.com"),
        person("Room 3", "room3@x.com", "resource"),
      ]),
    );
    const card = getMeetingCard();
    expect(card?.kind).toBe("recording");
    if (card?.kind === "recording") {
      expect(card.event?.title).toBe("Planning");
      expect(card.event?.initials).toEqual(["AL", "GH", "B"]);
      expect(card.event?.extraCount).toBe(2);
    }
    expect(getActiveAutoRecording()?.event?.title).toBe("Planning");
  });

  it("amber shows, snoozes for an hour, and shows again after it", () => {
    showAmber({ variant: "reconnect", episode: 1 }, 0);
    expect(getMeetingCard()?.kind).toBe("amber");
    snoozeAmber(0);
    expect(getMeetingCard()).toBeNull();
    goto(AMBER_SNOOZE_MS - 1);
    showAmber({ variant: "reconnect", episode: 1 }, AMBER_SNOOZE_MS - 1);
    expect(getMeetingCard()).toBeNull();
    goto(AMBER_SNOOZE_MS);
    showAmber({ variant: "reconnect", episode: 1 }, AMBER_SNOOZE_MS);
    expect(getMeetingCard()?.kind).toBe("amber");
  });

  it("no amber while an auto recording is active", () => {
    start();
    showAmber({ variant: "offline", episode: 1 });
    expect(getMeetingCard()?.kind).toBe("recording");
  });

  it("a red card replaces amber; an ended card never does", () => {
    showAmber({ variant: "settings", episode: 1 }, 0);
    start("Google Meet", 0);
    expect(getMeetingCard()?.kind).toBe("recording");
    autoRecordingStopped(0);
    showAmber({ variant: "settings", episode: 2 }, 0);
    goto(30_000);
    expect(getMeetingCard()?.kind).toBe("amber");
  });

  it("dismissAmber leaves a recording card alone", () => {
    start();
    dismissAmber();
    expect(getMeetingCard()?.kind).toBe("recording");
    dismissCard();
    showAmber({ variant: "offline", episode: 1 });
    dismissAmber();
    expect(getMeetingCard()).toBeNull();
  });

  it("getMeetingCard is reference-stable between changes", () => {
    start();
    expect(Object.is(getMeetingCard(), getMeetingCard())).toBe(true);
    const a = getMeetingCard();
    holdCard(true);
    holdCard(false);
    expect(Object.is(getMeetingCard(), a)).toBe(true);
  });

  it("pillWindowSize", () => {
    expect(pillWindowSize("icon-only", null)).toEqual(PILL_DIMENSIONS["icon-only"]);
    start();
    const card: MeetingCardState = getMeetingCard();
    expect(pillWindowSize("icon-only", card)).toEqual({
      width: 300,
      height: 52 + 8 + cardHeight(card, true),
    });
    expect(cardHeight(null, true)).toBe(0);
  });

  it("stopActiveRecording calls the registered stop once", () => {
    const stop = vi.fn();
    autoRecordingStarted({ app: "Google Meet", gated: true, stop }, 0);
    stopActiveRecording();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("the red card leaves after 6s on its own", () => {
    start("Google Meet", 0);
    goto(5_999);
    expect(getMeetingCard()?.kind).toBe("recording");
    goto(6_000);
    expect(getMeetingCard()).toBeNull();
  });

  it("holding the red card pauses it and resumes with the remainder", () => {
    start("Google Meet", 0);
    goto(2_000);
    holdCard(true, 2_000);
    goto(12_000);
    expect(getMeetingCard()?.kind).toBe("recording");
    holdCard(false, 12_000);
    goto(15_999);
    expect(getMeetingCard()?.kind).toBe("recording");
    goto(16_000);
    expect(getMeetingCard()).toBeNull();
  });

  it("the event arriving keeps the red card's timer", () => {
    const id = start("Google Meet", 0);
    goto(2_000);
    setCardEvent(id, event("Sync"));
    goto(5_999);
    const card = getMeetingCard();
    expect(card?.kind === "recording" && card.event?.title).toBe("Sync");
    goto(6_000);
    expect(getMeetingCard()).toBeNull();
  });

  it("the ended card leaves 5s after it shows", () => {
    start("Google Meet", 0);
    autoRecordingStopped(0);
    goto(30_000);
    expect(getMeetingCard()?.kind).toBe("ended");
    goto(34_999);
    expect(getMeetingCard()?.kind).toBe("ended");
    goto(35_000);
    expect(getMeetingCard()).toBeNull();
  });

  it("a replaced card's timer does not clear its successor", () => {
    start("Google Meet", 0);
    goto(3_000);
    start("Zoom", 3_000);
    goto(6_000);
    expect(getMeetingCard()?.kind).toBe("recording");
    goto(9_000);
    expect(getMeetingCard()).toBeNull();
  });
});
