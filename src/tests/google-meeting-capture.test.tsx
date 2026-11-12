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

function savedKeys(): string[] {
  return saveCalendarSnapshot.mock.calls.map((c) => c[1].key);
}

beforeEach(() => {
  vi.clearAllMocks();
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
    fetchCurrentGoogleMeetings.mockResolvedValueOnce({ kind: "error", code: "GOOGLE_NETWORK" });
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
