import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchCurrentGoogleMeetings = vi.hoisted(() => vi.fn());
vi.mock("@/lib/calendar/fetch-google-meetings", () => ({ fetchCurrentGoogleMeetings }));

const fetchCurrentMeetings = vi.hoisted(() => vi.fn());
vi.mock("@/lib/calendar/fetch-current-meetings", () => ({ fetchCurrentMeetings }));

const saveCalendarSnapshot = vi.hoisted(() => vi.fn());
const deleteCalendarSnapshot = vi.hoisted(() => vi.fn());
vi.mock("@/lib/database/calendar-snapshot.action", () => ({
  saveCalendarSnapshot,
  deleteCalendarSnapshot,
}));

const listeners = vi.hoisted(() => new Map<string, Set<(e: unknown) => void>>());
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, handler: (e: unknown) => void) => {
    const set = listeners.get(name) ?? new Set();
    set.add(handler);
    listeners.set(name, set);
    return () => set.delete(handler);
  }),
}));

import { useGoogleMeetingCapture } from "@/hooks/useGoogleMeetingCapture";
import { STORAGE_KEYS } from "@/config/constants";
import { OUTLOOK_CHECK_TIMEOUT_MS } from "@/lib/calendar/auto-notion";
import { GOOGLE_CONNECTION_CHANGED_EVENT } from "@/lib/storage/google-config.storage";
import type { CalendarEvent } from "@/types";
import {
  autoRecordingStarted,
  autoRecordingStopped,
  getActiveAutoRecording,
  getMeetingCard,
  resetMeetingCardsForTests,
  setAmberError,
  showAmber,
} from "@/lib/meeting-cards.store";

const startRecording = (gated: boolean) =>
  autoRecordingStarted({ app: gated ? "Google Meet" : "Microsoft Teams", gated, stop: () => {} });

const MIN = 60_000;

function eventWith(id: string): CalendarEvent {
  const now = Date.now();
  return {
    id,
    subject: `Meeting ${id}`,
    startMs: now - 5 * MIN,
    endMs: now + 25 * MIN,
    isCancelled: false,
    isAllDay: false,
    ownResponse: "accepted",
    hasMeetLink: false,
    participants: [
      { address: "me@example.org", name: "Me", type: "required", isOrganizer: true },
      { address: `${id}@guest.example`, name: `Guest ${id}`, type: "required", isOrganizer: false },
    ],
  };
}

const one = (id: string) => ({
  kind: "ok" as const,
  ownAddress: "me@example.org",
  events: [eventWith(id)],
});
const none = { kind: "ok" as const, ownAddress: "me@example.org", events: [] as CalendarEvent[] };
const several = {
  kind: "ok" as const,
  ownAddress: "me@example.org",
  events: [eventWith("S1"), eventWith("S2")],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const autoTick = vi.fn();
const autoUntick = vi.fn();
const handTouchesRef = { current: 0 };

function setup(id: string | null = null, tickEnabled = false) {
  return renderHook(
    (p: { id: string | null; tickEnabled?: boolean }) =>
      useGoogleMeetingCapture({
        currentConversationId: p.id,
        tickEnabled: p.tickEnabled ?? tickEnabled,
        notionPick: { autoTick, autoUntick, handTouchesRef },
      }),
    { initialProps: { id } as { id: string | null; tickEnabled?: boolean } }
  );
}

async function dispatch(name = "meetingCaptureStarted") {
  await act(async () => {
    window.dispatchEvent(new CustomEvent(name));
  });
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function connectionChanged() {
  await act(async () => {
    for (const fn of listeners.get(GOOGLE_CONNECTION_CHANGED_EVENT) ?? []) fn({});
  });
}

const failure = (
  code: string,
  config: "complete" | "unreadable" = "complete"
) => ({ kind: "error" as const, code, config });

function savedKeys(): string[] {
  return saveCalendarSnapshot.mock.calls.map((c) => c[1].key);
}

beforeEach(() => {
  vi.clearAllMocks();
  resetMeetingCardsForTests();
  listeners.clear();
  saveCalendarSnapshot.mockReset();
  saveCalendarSnapshot.mockResolvedValue(undefined);
  deleteCalendarSnapshot.mockReset();
  deleteCalendarSnapshot.mockResolvedValue(undefined);
  fetchCurrentGoogleMeetings.mockReset();
  fetchCurrentMeetings.mockReset();
  autoTick.mockReset();
  autoUntick.mockReset();
  handTouchesRef.current = 0;
  localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("useGoogleMeetingCapture", () => {
  it("a result that arrives before the conversation id is held, then stored", async () => {
    fetchCurrentGoogleMeetings.mockResolvedValue(one("A"));
    const view = setup(null);
    await dispatch();
    await settle();
    expect(saveCalendarSnapshot).not.toHaveBeenCalled();
    view.rerender({ id: "c1" });
    await settle();
    expect(saveCalendarSnapshot).toHaveBeenCalledTimes(1);
    expect(saveCalendarSnapshot.mock.calls[0][0]).toBe("c1");
    expect(savedKeys()).toEqual(["A"]);
  });

  it("a result that arrives after the id exists is stored at once", async () => {
    fetchCurrentGoogleMeetings.mockResolvedValue(one("A"));
    setup("c1");
    await dispatch();
    await settle();
    expect(saveCalendarSnapshot).toHaveBeenCalledTimes(1);
    expect(saveCalendarSnapshot.mock.calls[0][0]).toBe("c1");
  });

  it("a newer read replaces an older pending one", async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    fetchCurrentGoogleMeetings
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const view = setup(null);
    await dispatch();
    await dispatch();
    await act(async () => {
      second.resolve(one("B"));
    });
    await act(async () => {
      first.resolve(one("A"));
    });
    await settle();
    view.rerender({ id: "c1" });
    await settle();
    expect(savedKeys()).toEqual(["B"]);
  });

  it("a newer none removes a stored snapshot", async () => {
    fetchCurrentGoogleMeetings.mockResolvedValueOnce(one("A"));
    setup("c1");
    await dispatch();
    await settle();
    expect(savedKeys()).toEqual(["A"]);
    fetchCurrentGoogleMeetings.mockResolvedValueOnce(none);
    await dispatch();
    await settle();
    expect(deleteCalendarSnapshot).toHaveBeenCalledWith("c1");
  });

  it("a result after newConversationStarted is dropped", async () => {
    const d = deferred<unknown>();
    fetchCurrentGoogleMeetings.mockReturnValueOnce(d.promise);
    setup("c1");
    await dispatch();
    await dispatch("newConversationStarted");
    await act(async () => {
      d.resolve(one("A"));
    });
    await settle();
    expect(saveCalendarSnapshot).not.toHaveBeenCalled();
    expect(deleteCalendarSnapshot).not.toHaveBeenCalled();
  });

  it("a result in flight when another conversation is loaded is dropped", async () => {
    const d = deferred<unknown>();
    fetchCurrentGoogleMeetings.mockReturnValueOnce(d.promise);
    const view = setup("c1");
    await dispatch();
    await dispatch("conversationLoaded");
    view.rerender({ id: "c2" });
    await act(async () => {
      d.resolve(one("A"));
    });
    await settle();
    expect(saveCalendarSnapshot).not.toHaveBeenCalled();
    expect(deleteCalendarSnapshot).not.toHaveBeenCalled();
  });

  it("a result held for a missing id is discarded when a conversation is loaded", async () => {
    fetchCurrentGoogleMeetings.mockResolvedValue(one("A"));
    const view = setup(null);
    await dispatch();
    await settle();
    await dispatch("conversationLoaded");
    view.rerender({ id: "c2" });
    await settle();
    expect(saveCalendarSnapshot).not.toHaveBeenCalled();
  });

  it("odooTargetsCleared does not drop the snapshot", async () => {
    const d = deferred<unknown>();
    fetchCurrentGoogleMeetings.mockReturnValueOnce(d.promise);
    setup("c1");
    await dispatch();
    await dispatch("odooTargetsCleared");
    await act(async () => {
      d.resolve(one("A"));
    });
    await settle();
    expect(savedKeys()).toEqual(["A"]);
  });

  it("drops an in-flight read when the Google connection changes", async () => {
    const d = deferred<unknown>();
    fetchCurrentGoogleMeetings.mockReturnValueOnce(d.promise);
    setup("c1");
    await settle();
    await dispatch();
    await act(async () => {
      for (const fn of listeners.get(GOOGLE_CONNECTION_CHANGED_EVENT) ?? []) fn({});
    });
    await act(async () => {
      d.resolve(one("A"));
    });
    await settle();
    expect(saveCalendarSnapshot).not.toHaveBeenCalled();
    expect(deleteCalendarSnapshot).not.toHaveBeenCalled();
  });

  it("a connection change discards a result held for a missing conversation id", async () => {
    fetchCurrentGoogleMeetings.mockResolvedValue(one("A"));
    const view = setup(null);
    await settle();
    await dispatch();
    await settle();
    await act(async () => {
      for (const fn of listeners.get(GOOGLE_CONNECTION_CHANGED_EVENT) ?? []) fn({});
    });
    view.rerender({ id: "c1" });
    await settle();
    expect(saveCalendarSnapshot).not.toHaveBeenCalled();
    expect(deleteCalendarSnapshot).not.toHaveBeenCalled();
  });

  it("a Google failure or hang never throws into the capture dispatch", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      setup("c1");
      fetchCurrentGoogleMeetings.mockRejectedValueOnce(new Error("boom"));
      window.dispatchEvent(new CustomEvent("meetingCaptureStarted"));
      await settle();
      fetchCurrentGoogleMeetings.mockReturnValueOnce(new Promise(() => {}));
      window.dispatchEvent(new CustomEvent("meetingCaptureStarted"));
      await settle();
      await Promise.resolve();
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("a result held for a missing id is discarded by newConversationStarted", async () => {
    fetchCurrentGoogleMeetings.mockResolvedValue(one("A"));
    const view = setup(null);
    await dispatch();
    await settle();
    await dispatch("newConversationStarted");
    view.rerender({ id: "c1" });
    await settle();
    expect(saveCalendarSnapshot).not.toHaveBeenCalled();
  });

  it("a rejected write does not block the next one", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      saveCalendarSnapshot.mockRejectedValueOnce(new Error("db"));
      setup("c1");
      fetchCurrentGoogleMeetings.mockResolvedValueOnce(one("A"));
      await dispatch();
      await settle();
      fetchCurrentGoogleMeetings.mockResolvedValueOnce(one("B"));
      await dispatch();
      await settle();
      expect(savedKeys()).toEqual(["A", "B"]);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("a Google error result deletes the stored snapshot", async () => {
    setup("c1");
    fetchCurrentGoogleMeetings.mockResolvedValueOnce({
      kind: "error",
      code: "GOOGLE_NETWORK",
      config: "complete",
    });
    await dispatch();
    await settle();
    expect(deleteCalendarSnapshot).toHaveBeenCalledWith("c1");
    expect(saveCalendarSnapshot).not.toHaveBeenCalled();
  });

  it("several and absent store nothing", async () => {
    setup("c1");
    fetchCurrentGoogleMeetings.mockResolvedValueOnce(several);
    await dispatch();
    await settle();
    fetchCurrentGoogleMeetings.mockResolvedValueOnce({ kind: "absent" });
    await dispatch();
    await settle();
    expect(saveCalendarSnapshot).not.toHaveBeenCalled();
    expect(deleteCalendarSnapshot).toHaveBeenCalledTimes(2);
    expect(deleteCalendarSnapshot).toHaveBeenCalledWith("c1");
  });
});

describe("useGoogleMeetingCapture card content", () => {
  it("a gated auto recording gets the picked event", async () => {
    fetchCurrentGoogleMeetings.mockResolvedValue(one("A"));
    startRecording(true);
    setup("c1");
    await dispatch();
    await settle();
    expect(getActiveAutoRecording()?.event?.title).toBe("Meeting A");
  });

  it("several or no events leave the card empty", async () => {
    startRecording(true);
    setup("c1");
    fetchCurrentGoogleMeetings.mockResolvedValueOnce(several);
    await dispatch();
    await settle();
    fetchCurrentGoogleMeetings.mockResolvedValueOnce(none);
    await dispatch();
    await settle();
    expect(getActiveAutoRecording()?.event).toBeNull();
  });

  it("no auto recording publishes nothing", async () => {
    fetchCurrentGoogleMeetings.mockResolvedValue(one("A"));
    setup("c1");
    await dispatch();
    await settle();
    expect(getActiveAutoRecording()).toBeNull();
  });

  it("a Teams auto recording gets no Google event", async () => {
    fetchCurrentGoogleMeetings.mockResolvedValue(one("A"));
    startRecording(false);
    setup("c1");
    await dispatch();
    await settle();
    expect(getActiveAutoRecording()?.event).toBeNull();
  });

  it("a result that lands after the recording stopped publishes nothing", async () => {
    const d = deferred<unknown>();
    fetchCurrentGoogleMeetings.mockReturnValueOnce(d.promise);
    startRecording(true);
    setup("c1");
    await dispatch();
    autoRecordingStopped();
    // A newer recording must not inherit the older read's event either.
    startRecording(true);
    await act(async () => {
      d.resolve(one("A"));
    });
    await settle();
    expect(getActiveAutoRecording()?.event).toBeNull();
  });
});

describe("useGoogleMeetingCapture check 1 (Notion tick)", () => {
  it("ticks on Google one with Outlook absent", async () => {
    fetchCurrentGoogleMeetings.mockResolvedValue(one("A"));
    fetchCurrentMeetings.mockResolvedValue({ kind: "absent" });
    setup("c1", true);
    await dispatch();
    await settle();
    expect(autoTick).toHaveBeenCalledTimes(1);
    expect(autoUntick).not.toHaveBeenCalled();
  });

  it("does not tick when Outlook has a meeting", async () => {
    fetchCurrentGoogleMeetings.mockResolvedValue(one("A"));
    fetchCurrentMeetings.mockResolvedValue(one("O"));
    setup("c1", true);
    await dispatch();
    await settle();
    expect(autoTick).not.toHaveBeenCalled();
    expect(autoUntick).toHaveBeenCalledTimes(1);
  });

  it("reads Outlook even when calendar auto-select is off", async () => {
    localStorage.setItem(STORAGE_KEYS.CALENDAR_AUTO_SELECT_ENABLED, "false");
    fetchCurrentGoogleMeetings.mockResolvedValue(one("A"));
    fetchCurrentMeetings.mockResolvedValue({ kind: "absent" });
    setup("c1", true);
    await dispatch();
    await settle();
    expect(fetchCurrentMeetings).toHaveBeenCalledTimes(1);
  });

  it("a late result after newConversationStarted neither ticks nor stores", async () => {
    const g = deferred<unknown>();
    fetchCurrentGoogleMeetings.mockReturnValueOnce(g.promise);
    fetchCurrentMeetings.mockResolvedValue({ kind: "absent" });
    setup("c1", true);
    await dispatch();
    await dispatch("newConversationStarted");
    await act(async () => {
      g.resolve(one("A"));
    });
    await settle();
    expect(saveCalendarSnapshot).not.toHaveBeenCalled();
    expect(autoTick).not.toHaveBeenCalled();
    expect(autoUntick).not.toHaveBeenCalled();
  });

  it("odooTargetsCleared drops a late tick but still stores the snapshot", async () => {
    const o = deferred<unknown>();
    fetchCurrentGoogleMeetings.mockResolvedValue(one("A"));
    fetchCurrentMeetings.mockReturnValueOnce(o.promise);
    setup("c1", true);
    await dispatch();
    await settle();
    expect(savedKeys()).toEqual(["A"]);
    await dispatch("odooTargetsCleared");
    await act(async () => {
      o.resolve({ kind: "absent" });
    });
    await settle();
    expect(autoTick).not.toHaveBeenCalled();
    expect(autoUntick).not.toHaveBeenCalled();
    expect(savedKeys()).toEqual(["A"]);
  });

  it("a newer refusing read unticks an auto tick", async () => {
    fetchCurrentGoogleMeetings.mockResolvedValueOnce(one("A"));
    fetchCurrentMeetings.mockResolvedValueOnce({ kind: "absent" });
    setup("c1", true);
    await dispatch();
    await settle();
    expect(autoTick).toHaveBeenCalledTimes(1);
    fetchCurrentGoogleMeetings.mockResolvedValueOnce(one("B"));
    fetchCurrentMeetings.mockResolvedValueOnce(one("O"));
    await dispatch();
    await settle();
    expect(autoUntick).toHaveBeenCalledTimes(1);
    expect(autoTick).toHaveBeenCalledTimes(1);
  });

  it("tickEnabled false makes no Outlook read and never ticks", async () => {
    fetchCurrentGoogleMeetings.mockResolvedValue(one("A"));
    setup("c1", false);
    await dispatch();
    await settle();
    expect(fetchCurrentMeetings).not.toHaveBeenCalled();
    expect(autoTick).not.toHaveBeenCalled();
    expect(autoUntick).not.toHaveBeenCalled();
    expect(savedKeys()).toEqual(["A"]);
  });

  it("passes the touch count captured at the event", async () => {
    const o = deferred<unknown>();
    handTouchesRef.current = 3;
    fetchCurrentGoogleMeetings.mockResolvedValue(one("A"));
    fetchCurrentMeetings.mockReturnValueOnce(o.promise);
    setup("c1", true);
    await dispatch();
    await settle();
    handTouchesRef.current = 4;
    await act(async () => {
      o.resolve({ kind: "absent" });
    });
    await settle();
    expect(autoTick).toHaveBeenCalledWith(3);
  });

  it("an older capture's late Outlook result never ticks after a newer read saw an Outlook meeting", async () => {
    const o1 = deferred<unknown>();
    fetchCurrentGoogleMeetings.mockResolvedValue(one("A"));
    fetchCurrentMeetings.mockReturnValueOnce(o1.promise).mockResolvedValueOnce(one("O"));
    setup("c1", true);
    await dispatch();
    await settle();
    await dispatch();
    await settle();
    await act(async () => {
      o1.resolve({ kind: "absent" });
    });
    await settle();
    expect(autoTick).not.toHaveBeenCalled();
  });

  it("an older capture's late refuse never unticks after a newer read ticked", async () => {
    const o1 = deferred<unknown>();
    fetchCurrentGoogleMeetings.mockResolvedValue(one("A"));
    fetchCurrentMeetings.mockReturnValueOnce(o1.promise).mockResolvedValueOnce({ kind: "absent" });
    setup("c1", true);
    await dispatch();
    await settle();
    await dispatch();
    await settle();
    expect(autoTick).toHaveBeenCalledTimes(1);
    await act(async () => {
      o1.resolve(one("O"));
    });
    await settle();
    expect(autoUntick).not.toHaveBeenCalled();
  });

  it("a Google connection change while Outlook is pending drops the tick", async () => {
    const o = deferred<unknown>();
    fetchCurrentGoogleMeetings.mockResolvedValue(one("A"));
    fetchCurrentMeetings.mockReturnValueOnce(o.promise);
    setup("c1", true);
    await settle();
    await dispatch();
    await settle();
    await act(async () => {
      for (const fn of listeners.get(GOOGLE_CONNECTION_CHANGED_EVENT) ?? []) fn({});
    });
    await act(async () => {
      o.resolve({ kind: "absent" });
    });
    await settle();
    expect(autoTick).not.toHaveBeenCalled();
    expect(autoUntick).not.toHaveBeenCalled();
  });

  it("newConversationStarted while Outlook is pending drops the tick", async () => {
    const o = deferred<unknown>();
    fetchCurrentGoogleMeetings.mockResolvedValue(one("A"));
    fetchCurrentMeetings.mockReturnValueOnce(o.promise);
    setup("c1", true);
    await dispatch();
    await settle();
    await dispatch("newConversationStarted");
    await act(async () => {
      o.resolve({ kind: "absent" });
    });
    await settle();
    expect(autoTick).not.toHaveBeenCalled();
    expect(autoUntick).not.toHaveBeenCalled();
  });

  it("loading another conversation while Outlook is pending drops the tick", async () => {
    const o = deferred<unknown>();
    fetchCurrentGoogleMeetings.mockResolvedValue(one("A"));
    fetchCurrentMeetings.mockReturnValueOnce(o.promise);
    setup("c1", true);
    await dispatch();
    await settle();
    await dispatch("conversationLoaded");
    await act(async () => {
      o.resolve({ kind: "absent" });
    });
    await settle();
    expect(autoTick).not.toHaveBeenCalled();
    expect(autoUntick).not.toHaveBeenCalled();
  });

  it("tickEnabled turning false while Outlook is pending never ticks", async () => {
    const o = deferred<unknown>();
    fetchCurrentGoogleMeetings.mockResolvedValue(one("A"));
    fetchCurrentMeetings.mockReturnValueOnce(o.promise);
    const view = setup("c1", true);
    await dispatch();
    await settle();
    view.rerender({ id: "c1", tickEnabled: false });
    await act(async () => {
      o.resolve({ kind: "absent" });
    });
    await settle();
    expect(autoTick).not.toHaveBeenCalled();
    expect(autoUntick).not.toHaveBeenCalled();
  });

  it("a hung Outlook read never holds up the snapshot", async () => {
    vi.useFakeTimers();
    fetchCurrentGoogleMeetings.mockResolvedValue(one("A"));
    fetchCurrentMeetings.mockReturnValue(new Promise(() => {}));
    setup("c1", true);
    await act(async () => {
      window.dispatchEvent(new CustomEvent("meetingCaptureStarted"));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(saveCalendarSnapshot).toHaveBeenCalledTimes(1);
    expect(autoUntick).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(OUTLOOK_CHECK_TIMEOUT_MS);
    });
    expect(autoUntick).toHaveBeenCalledTimes(1);
    expect(autoTick).not.toHaveBeenCalled();
  });
});

describe("useGoogleMeetingCapture warning and re-read", () => {
  const isAmber = () => getMeetingCard()?.kind === "amber";

  async function captureError(err: ReturnType<typeof failure>, id = "c1") {
    fetchCurrentGoogleMeetings.mockResolvedValueOnce(err);
    const view = setup(id);
    await dispatch();
    await settle();
    return view;
  }

  it("a Google error at capture start shows the reconnect warning", async () => {
    await captureError(failure("GOOGLE_AUTH_EXPIRED"));
    expect(getMeetingCard()).toMatchObject({ kind: "amber", variant: "reconnect" });
  });

  it("an unreadable config shows the settings warning", async () => {
    await captureError(failure("GOOGLE_AUTH_REJECTED", "unreadable"));
    expect(getMeetingCard()).toMatchObject({ kind: "amber", variant: "settings" });
  });

  it("a network error shows the offline warning", async () => {
    await captureError(failure("GOOGLE_NETWORK"));
    expect(getMeetingCard()).toMatchObject({ kind: "amber", variant: "offline" });
  });

  it("no meeting, several and absent show no warning", async () => {
    setup("c1");
    for (const r of [none, several, { kind: "absent" as const }]) {
      fetchCurrentGoogleMeetings.mockResolvedValueOnce(r);
      await dispatch();
      await settle();
      expect(isAmber()).toBe(false);
    }
  });

  it("a stale error shows no warning", async () => {
    const d = deferred<unknown>();
    fetchCurrentGoogleMeetings.mockReturnValueOnce(d.promise);
    setup("c1");
    await dispatch();
    await dispatch("newConversationStarted");
    await act(async () => {
      d.resolve(failure("GOOGLE_AUTH_EXPIRED"));
    });
    await settle();
    expect(isAmber()).toBe(false);
  });

  it("after an error, a connection change re-reads, stores the snapshot and clears the warning", async () => {
    await captureError(failure("GOOGLE_AUTH_EXPIRED"));
    expect(isAmber()).toBe(true);
    fetchCurrentGoogleMeetings.mockResolvedValueOnce(one("A"));
    await connectionChanged();
    await settle();
    expect(savedKeys()).toEqual(["A"]);
    expect(isAmber()).toBe(false);
  });

  it("a reconnect re-read uses the capture-start time", async () => {
    vi.useFakeTimers();
    fetchCurrentGoogleMeetings.mockResolvedValueOnce(failure("GOOGLE_AUTH_EXPIRED"));
    setup("c1");
    const t0 = Date.now();
    await act(async () => {
      window.dispatchEvent(new CustomEvent("meetingCaptureStarted"));
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3 * 60 * MIN);
    });
    fetchCurrentGoogleMeetings.mockResolvedValueOnce(one("A"));
    await act(async () => {
      for (const fn of listeners.get(GOOGLE_CONNECTION_CHANGED_EVENT) ?? []) fn({});
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchCurrentGoogleMeetings).toHaveBeenCalledTimes(2);
    expect(fetchCurrentGoogleMeetings.mock.calls[1][0]).toBe(t0);
  });

  it("a re-read that fails again keeps the warning without re-showing it", async () => {
    await captureError(failure("GOOGLE_NETWORK"));
    const before = getMeetingCard();
    setAmberError("x");
    fetchCurrentGoogleMeetings.mockResolvedValueOnce(failure("GOOGLE_AUTH_EXPIRED"));
    await connectionChanged();
    await settle();
    expect(getMeetingCard()).toMatchObject({
      kind: "amber",
      variant: "offline",
      error: "x",
      episode: (before as { episode: number }).episode,
    });
  });

  it("a reconnect re-read never ticks Notion", async () => {
    fetchCurrentMeetings.mockResolvedValue({ kind: "absent" });
    fetchCurrentGoogleMeetings.mockResolvedValueOnce(failure("GOOGLE_AUTH_EXPIRED"));
    setup("c1", true);
    await dispatch();
    await settle();
    autoTick.mockClear();
    autoUntick.mockClear();
    fetchCurrentMeetings.mockClear();
    fetchCurrentGoogleMeetings.mockResolvedValueOnce(one("A"));
    await connectionChanged();
    await settle();
    expect(autoTick).not.toHaveBeenCalled();
    expect(autoUntick).not.toHaveBeenCalled();
    expect(fetchCurrentMeetings).not.toHaveBeenCalled();
  });

  it("a re-read labels the original recording when it is still active", async () => {
    startRecording(true);
    await captureError(failure("GOOGLE_AUTH_EXPIRED"));
    fetchCurrentGoogleMeetings.mockResolvedValueOnce(one("A"));
    await connectionChanged();
    await settle();
    expect(getActiveAutoRecording()?.event?.title).toBe("Meeting A");
  });

  it("no re-read after a capture read that did not error", async () => {
    fetchCurrentGoogleMeetings.mockResolvedValueOnce(one("A"));
    setup("c1");
    await dispatch();
    await settle();
    await connectionChanged();
    await settle();
    expect(fetchCurrentGoogleMeetings).toHaveBeenCalledTimes(1);
  });

  it("newConversationStarted disarms the re-read", async () => {
    await captureError(failure("GOOGLE_AUTH_EXPIRED"));
    await dispatch("newConversationStarted");
    await connectionChanged();
    await settle();
    expect(fetchCurrentGoogleMeetings).toHaveBeenCalledTimes(1);
  });

  it("a saved config that was never connected shows the reconnect warning", async () => {
    await captureError(failure("GOOGLE_NOT_CONNECTED"));
    expect(getMeetingCard()).toMatchObject({ kind: "amber", variant: "reconnect" });
  });

  it("a later capture read that does not error clears the warning", async () => {
    await captureError(failure("GOOGLE_AUTH_EXPIRED"));
    expect(isAmber()).toBe(true);
    fetchCurrentGoogleMeetings.mockResolvedValueOnce(none);
    await dispatch();
    await settle();
    expect(isAmber()).toBe(false);
  });

  it("a new or loaded conversation clears the warning", async () => {
    for (const name of ["newConversationStarted", "conversationLoaded"]) {
      resetMeetingCardsForTests();
      const view = await captureError(failure("GOOGLE_AUTH_EXPIRED"));
      expect(isAmber()).toBe(true);
      await dispatch(name);
      expect(isAmber()).toBe(false);
      view.unmount();
    }
  });

  it("a second capture error keeps the same warning card", async () => {
    await captureError(failure("GOOGLE_AUTH_EXPIRED"));
    const first = getMeetingCard() as { episode: number };
    setAmberError("x");
    fetchCurrentGoogleMeetings.mockResolvedValueOnce(failure("GOOGLE_AUTH_EXPIRED"));
    await dispatch();
    await settle();
    expect(getMeetingCard()).toMatchObject({ kind: "amber", episode: first.episode, error: "x" });
  });

  it("the re-read labels the original recording", async () => {
    startRecording(true);
    await captureError(failure("GOOGLE_AUTH_EXPIRED"));
    autoRecordingStopped();
    startRecording(true);
    expect(getActiveAutoRecording()?.id).toBe(2);
    fetchCurrentGoogleMeetings.mockResolvedValueOnce(one("A"));
    await connectionChanged();
    await settle();
    expect(getActiveAutoRecording()?.event).toBeNull();
  });

  it("a re-read leaves an unrelated amber alone", async () => {
    await captureError(failure("GOOGLE_AUTH_EXPIRED"));
    act(() => showAmber({ variant: "offline", episode: 999 }));
    fetchCurrentGoogleMeetings.mockResolvedValueOnce(one("A"));
    await connectionChanged();
    await settle();
    expect(getMeetingCard()).toMatchObject({ kind: "amber", episode: 999 });
  });
});
