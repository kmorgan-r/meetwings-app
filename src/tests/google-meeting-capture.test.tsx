import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchCurrentGoogleMeetings = vi.hoisted(() => vi.fn());
vi.mock("@/lib/calendar/fetch-google-meetings", () => ({ fetchCurrentGoogleMeetings }));

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

function setup(id: string | null = null) {
  return renderHook((p: { id: string | null }) => useGoogleMeetingCapture({ currentConversationId: p.id }), {
    initialProps: { id },
  });
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
});

afterEach(() => {
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
      expect(() => window.dispatchEvent(new CustomEvent("meetingCaptureStarted"))).not.toThrow();
      await settle();
      fetchCurrentGoogleMeetings.mockReturnValueOnce(new Promise(() => {}));
      expect(() => window.dispatchEvent(new CustomEvent("meetingCaptureStarted"))).not.toThrow();
      await settle();
      await Promise.resolve();
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
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
