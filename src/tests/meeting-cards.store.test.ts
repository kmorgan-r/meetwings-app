import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AMBER_SNOOZE_MS,
  autoRecordingStarted,
  autoRecordingStopped,
  cardHeight,
  dismissAmber,
  dismissCard,
  ENDED_CARD_MS,
  getActiveAutoRecording,
  getMeetingCard,
  holdCard,
  pillWindowSize,
  RESTART_QUIET_MS,
  resetMeetingCardsForTests,
  setCardEvent,
  setAmberError,
  showAmber,
  showStopNotice,
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

  it("same-app restart within 2 minutes shows no red card", () => {
    start("Google Meet", 0);
    autoRecordingStopped({ auto: true }, 0);
    dismissCard();
    goto(60_000);
    start("Google Meet", 60_000);
    expect(getMeetingCard()).toBeNull();
    autoRecordingStopped({ auto: true }, 90_000);
    goto(100_000);
    start("Google Meet", 100_000);
    expect(getMeetingCard()).toBeNull();
  });

  it("a different app within 2 minutes gets its own red card", () => {
    start("Google Meet", 0);
    autoRecordingStopped({ auto: true }, 0);
    goto(60_000);
    start("Zoom", 60_000);
    expect(getMeetingCard()?.kind).toBe("recording");
  });

  it("same-app restart after 2 minutes gets a red card", () => {
    start("Google Meet", 0);
    autoRecordingStopped({ auto: true }, 0);
    goto(120_000);
    start("Google Meet", 120_000);
    expect(getMeetingCard()?.kind).toBe("recording");
  });

  it("a user stop (non-auto) does not open the quiet-restart window", () => {
    start("Google Meet", 0);
    autoRecordingStopped({}, 0);
    goto(60_000);
    start("Google Meet", 60_000);
    const card = getMeetingCard();
    expect(card?.kind).toBe("recording");
    if (card?.kind === "recording") expect(card.startedAt).toBe(60_000);
  });

  it("autoRecordingStopped arms no card", () => {
    start("Google Meet", 0);
    autoRecordingStopped({ auto: true }, 0);
    // The old delayed card showed in [30_000, 35_000).
    goto(30_000);
    expect(getMeetingCard()).toBeNull();

    start("Zoom", 40_000);
    autoRecordingStopped(); // non-auto, at the fake clock's 30_000
    // The removed delayed card would have shown in [60_000, 65_000) from here.
    goto(62_000);
    expect(getMeetingCard()).toBeNull();
    goto(70_000);
    expect(getMeetingCard()).toBeNull();
    goto(120_000);
    expect(getMeetingCard()).toBeNull();
  });

  it("a quiet restart carries the start time and event", () => {
    const id = start("Google Meet", 0);
    setCardEvent(id, event("Weekly sync"));
    goto(60_000);
    autoRecordingStopped({ auto: true }, 60_000);
    goto(90_000);
    start("Google Meet", 90_000);
    const active = getActiveAutoRecording();
    expect(active?.startedAt).toBe(0);
    expect(active?.event?.title).toBe("Weekly sync");
  });

  it("showStopNotice shows the ended card at once with no active recording", () => {
    showStopNotice("silence", 0);
    expect(getMeetingCard()).toEqual({ kind: "ended", reason: "silence" });
  });

  it("showStopNotice does nothing over an amber card", () => {
    showAmber({ variant: "reconnect", episode: 1 }, 0);
    showStopNotice("call-ended", 0);
    const card = getMeetingCard();
    expect(card?.kind).toBe("amber");
    if (card?.kind === "amber") expect(card.episode).toBe(1);
  });

  it("the quiet restart clears a showing notice", () => {
    start("Teams", 0);
    autoRecordingStopped({ auto: true }, 0);
    showStopNotice("call-ended", 1_000);
    expect(getMeetingCard()?.kind).toBe("ended");
    start("Teams", RESTART_QUIET_MS - 1);
    expect(getMeetingCard()).toBeNull();
  });

  it("a fresh start replaces the notice with the recording card", () => {
    showStopNotice("silence", 0);
    start("Google Meet", 1_000);
    const card = getMeetingCard();
    expect(card?.kind).toBe("recording");
    if (card?.kind === "recording") expect(card.app).toBe("Google Meet");
  });

  it("stopping twice arms no card", () => {
    start("Google Meet", 0);
    autoRecordingStopped({ auto: true }, 0);
    autoRecordingStopped({ auto: true }, 5_000);
    goto(30_000);
    expect(getMeetingCard()).toBeNull();
    goto(60_000);
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
        person("Me Myself", "ME@x.com"),
        person("Ada Lovelace", "ada@x.com"),
        person("Grace Brewster Hopper", "grace@x.com"),
        person(null, "bob@x.com"),
        { ...person("Gone", "gone@x.com"), response: "declined" },
        person("Dan", "dan@x.com"),
        person("Eve Adams", "eve@x.com"),
        person("Room 3", "room3@x.com", "resource"),
      ]),
      "me@x.com",
    );
    const card = getMeetingCard();
    expect(card?.kind).toBe("recording");
    if (card?.kind === "recording") {
      expect(card.event?.title).toBe("Planning");
      // You, the room and a declined guest are left out; a nameless guest shows its address.
      expect(card.event?.names).toEqual(["Ada Lovelace", "Grace Brewster Hopper", "bob@x.com"]);
      expect(card.event?.extraCount).toBe(2);
    }
    expect(getActiveAutoRecording()?.event?.title).toBe("Planning");
  });

  it("setCardEvent with no other guest leaves names empty", () => {
    const id = start();
    setCardEvent(id, event("Focus", [person("Me", "me@x.com")]), "me@x.com");
    const card = getMeetingCard();
    expect(card?.kind === "recording" && card.event?.names).toEqual([]);
    expect(card?.kind === "recording" && card.event?.extraCount).toBe(0);
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

  it("amber shows over an active auto recording, and the recording's stop leaves it", () => {
    start();
    showAmber({ variant: "offline", episode: 1 });
    expect(getMeetingCard()?.kind).toBe("amber");
    autoRecordingStopped();
    expect(getMeetingCard()?.kind).toBe("amber");
  });

  it("the snooze holds while a recording is active", () => {
    start();
    snoozeAmber();
    showAmber({ variant: "offline", episode: 1 });
    expect(getMeetingCard()?.kind).toBe("recording");
  });

  it("showing the same episode again keeps the card and its error", () => {
    showAmber({ variant: "reconnect", episode: 4 });
    setAmberError("x");
    const before = getMeetingCard();
    showAmber({ variant: "reconnect", episode: 4 });
    expect(getMeetingCard()).toBe(before);
    const card = getMeetingCard();
    expect(card?.kind === "amber" && card.error).toBe("x");
  });

  it("the same episode with a new variant updates the variant and keeps the error", () => {
    showAmber({ variant: "offline", episode: 4 });
    setAmberError("x");
    showAmber({ variant: "reconnect", episode: 4 });
    expect(getMeetingCard()).toEqual({ kind: "amber", variant: "reconnect", episode: 4, error: "x" });
  });

  it("a new episode replaces the amber", () => {
    showAmber({ variant: "reconnect", episode: 4 });
    setAmberError("x");
    showAmber({ variant: "settings", episode: 5 });
    const card = getMeetingCard();
    expect(card?.kind).toBe("amber");
    if (card?.kind === "amber") {
      expect(card.episode).toBe(5);
      expect(card.error).toBeNull();
    }
  });

  it("dismissAmber with an episode leaves another episode's amber", () => {
    showAmber({ variant: "offline", episode: 2 });
    dismissAmber(1);
    expect(getMeetingCard()?.kind).toBe("amber");
    dismissAmber(2);
    expect(getMeetingCard()).toBeNull();
  });

  it("a stop notice yields to the amber", () => {
    showAmber({ variant: "offline", episode: 1 });
    showStopNotice("call-ended");
    expect(getMeetingCard()?.kind).toBe("amber");
  });

  it("a red card replaces amber; an auto stop does not resurrect it", () => {
    showAmber({ variant: "settings", episode: 1 }, 0);
    start("Google Meet", 0);
    expect(getMeetingCard()?.kind).toBe("recording");
    autoRecordingStopped({ auto: true }, 0);
    showAmber({ variant: "settings", episode: 2 }, 0);
    goto(60_000);
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

  it("the notice leaves 5s after it shows", () => {
    showStopNotice("call-ended", 0);
    goto(ENDED_CARD_MS - 1);
    expect(getMeetingCard()?.kind).toBe("ended");
    goto(ENDED_CARD_MS);
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
