import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { useSyncExternalStore } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  invoke: vi.fn(async (..._args: unknown[]): Promise<unknown> => undefined),
  reconnect: vi.fn(async (): Promise<unknown> => ({ ok: true })),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
vi.mock("@/lib/calendar/google-connect", () => ({ reconnectGoogle: h.reconnect }));

import { useMeetingCardHost } from "@/hooks/useMeetingCardHost";
import { GOOGLE_COPY } from "@/lib/calendar/google-errors";
import {
  autoRecordingStarted,
  autoRecordingStopped,
  cardHeight,
  getMeetingCard,
  resetMeetingCardsForTests,
  setAmberError,
  setCardEvent,
  showAmber,
  subscribeToMeetingCard,
} from "@/lib/meeting-cards.store";
import { MeetingCard } from "@/pages/app/components/MeetingCard";
import type { CalendarEvent, CalendarParticipant } from "@/types";

function Harness({ compact }: { compact?: boolean }) {
  const card = useSyncExternalStore(subscribeToMeetingCard, getMeetingCard);
  return card ? <MeetingCard card={card} compact={compact} /> : null;
}

const person = (name: string, address: string): CalendarParticipant => ({
  address,
  name,
  type: "required",
  isOrganizer: false,
});

const T0 = new Date(2026, 10, 13, 10, 0).getTime();

function event(subject: string, n = 5): CalendarEvent {
  const names = ["Ada Kay", "Jo Smith", "Max Reed", "Dan Poe", "Eve Fox"].slice(0, n);
  return {
    id: "e1",
    subject,
    startMs: T0,
    endMs: T0 + 30 * 60_000,
    isCancelled: false,
    isAllDay: false,
    ownResponse: "accepted",
    participants: names.map((nm, i) => person(nm, `p${i}@x.com`)),
    hasMeetLink: true,
  };
}

const start = (stop = () => {}) => autoRecordingStarted({ app: "Google Meet", gated: true, stop });
const tick = (ms: number) => act(() => void vi.advanceTimersByTime(ms));
const run = (fn: () => void) => act(fn);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  vi.clearAllMocks();
  h.invoke.mockImplementation(async () => undefined);
  h.reconnect.mockResolvedValue({ ok: true });
  resetMeetingCardsForTests();
});

afterEach(() => {
  cleanup();
  resetMeetingCardsForTests();
  vi.useRealTimers();
});

describe("MeetingCard", () => {
  it("the recording card shows app, timer and Stop", () => {
    const stop = vi.fn();
    render(<Harness />);
    run(() => void start(stop));
    expect(screen.getByText("Google Meet · recording started")).toBeTruthy();
    expect(screen.getByTestId("meeting-card-timer").textContent).toBe("00:00");
    tick(4000);
    expect(screen.getByTestId("meeting-card-timer").textContent).toBe("00:04");
    fireEvent.click(screen.getByRole("button", { name: /Stop/ }));
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("the recording card fills in the event", () => {
    render(<Harness />);
    run(() => setCardEvent(start(), event("Weekly IC sync")));
    expect(screen.getByText("Weekly IC sync")).toBeTruthy();
    expect(screen.getByText("10:00 – 10:30")).toBeTruthy();
    const chips = screen.getByTestId("meeting-card-chips");
    expect(chips.textContent).toBe("AKJSMR+2");
    expect(chips.querySelectorAll("span.rounded-full")).toHaveLength(3);
  });

  it("without an event only the top row shows", () => {
    render(<Harness />);
    run(() => void start());
    expect(screen.queryByTestId("meeting-card-title")).toBeNull();
    expect(screen.queryByTestId("meeting-card-chips")).toBeNull();
    expect(screen.getByRole("button", { name: /Stop/ })).toBeTruthy();
    expect(screen.getByTestId("meeting-card").style.height).toBe(`${cardHeight(getMeetingCard(), false)}px`);
  });

  it("hovering holds the red card", () => {
    render(<Harness />);
    run(() => void start());
    const root = () => screen.getByTestId("meeting-card");
    tick(2000);
    fireEvent.mouseEnter(root());
    expect(root().getAttribute("data-paused")).toBe("true");
    expect(screen.getByTestId("meeting-card-drain").style.animationPlayState).toBe("paused");
    tick(10_000);
    expect(getMeetingCard()?.kind).toBe("recording");

    fireEvent.mouseLeave(root());
    expect(root().getAttribute("data-paused")).toBe("false");
    tick(3999);
    expect(getMeetingCard()?.kind).toBe("recording");
    tick(1);
    expect(getMeetingCard()).toBeNull();
    expect(screen.queryByTestId("meeting-card")).toBeNull();
  });

  it("the red card leaves without an animation event, full and compact", () => {
    for (const compact of [false, true]) {
      const { unmount } = render(<Harness compact={compact} />);
      run(() => void start());
      expect(screen.getByTestId("meeting-card")).toBeTruthy();
      tick(6000);
      expect(screen.queryByTestId("meeting-card")).toBeNull();
      unmount();
      resetMeetingCardsForTests();
    }
  });

  it("the compact recording card is a single row with the event title", () => {
    render(<Harness compact />);
    run(() => setCardEvent(start(), event("Sync")));
    const root = screen.getByTestId("meeting-card");
    expect(root.textContent).toContain("REC");
    expect(root.textContent).toContain("Sync");
    expect(root.textContent).toContain("00:00");
    // No second row: no title block, no chips, no time range, no separate divider.
    expect(screen.queryByTestId("meeting-card-title")).toBeNull();
    expect(screen.queryByTestId("meeting-card-chips")).toBeNull();
    expect(root.textContent).not.toContain("10:00");
    expect(root.querySelector(".h-px")).toBeNull();
    expect(root.firstElementChild?.children).toHaveLength(1);
    expect(root.style.height).toBe("48px");
  });

  it("the full recording card puts Stop on its own bottom row", () => {
    render(<Harness />);
    run(() => setCardEvent(start(), event("Weekly IC sync")));
    const stop = screen.getByRole("button", { name: "Stop" });
    const when = screen.getByTestId("meeting-card-chips");
    expect(stop.parentElement).not.toBe(when.parentElement?.parentElement);
    expect(stop.parentElement?.contains(when)).toBe(false);
    expect(stop.parentElement?.className).toContain("justify-end");
  });

  it("decorative glyphs are hidden from assistive tech and red and ended cards are status regions", () => {
    render(<Harness />);
    run(() => void start());
    expect(screen.getByTestId("meeting-card").getAttribute("role")).toBe("status");
    expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
  });

  it("the ended card shows title and minutes, then leaves", () => {
    render(<Harness />);
    run(() => setCardEvent(start(), event("Weekly IC sync", 2)));
    vi.setSystemTime(T0 + 42 * 60_000);
    run(() => autoRecordingStopped(Date.now()));
    tick(30_000);
    expect(screen.getByText("Recording saved")).toBeTruthy();
    expect(screen.getByText(/Weekly IC sync/).textContent).toContain("42 min");
    tick(5000);
    expect(screen.queryByText("Recording saved")).toBeNull();
  });

  it("amber reconnect: headline, Not now snoozes, Reconnect failure shows Google copy and keeps the button", async () => {
    render(<Harness />);
    run(() => showAmber({ variant: "reconnect", episode: 1 }));
    expect(screen.getByText("If this is a Meet call, it isn't being recorded")).toBeTruthy();
    expect(screen.getByText(/Google Calendar is disconnected/)).toBeTruthy();

    h.reconnect.mockResolvedValue({ ok: false, code: "GOOGLE_NETWORK" });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Reconnect Google" }));
    });
    expect(h.reconnect).toHaveBeenCalledTimes(1);
    expect(screen.getByText(GOOGLE_COPY.GOOGLE_NETWORK)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reconnect Google" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(screen.queryByTestId("meeting-card")).toBeNull();
    run(() => showAmber({ variant: "reconnect", episode: 2 }));
    expect(getMeetingCard()).toBeNull(); // snoozed
  });

  it("amber settings opens the dashboard", () => {
    render(<Harness />);
    run(() => showAmber({ variant: "settings", episode: 1 }));
    expect(screen.getByText(/Open Integrations → Google Calendar in settings to fix it\./)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Not now" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open settings" }));
    expect(h.invoke).toHaveBeenCalledWith("open_dashboard");
  });

  it("amber offline has Got it only", () => {
    render(<Harness />);
    run(() => showAmber({ variant: "offline", episode: 1 }));
    expect(screen.getByText(/can't reach Google Calendar right now/)).toBeTruthy();
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["Got it"]);
    fireEvent.click(screen.getByRole("button", { name: "Got it" }));
    expect(getMeetingCard()).toBeNull();
  });

  it("an amber error renders under the body, untruncated, and the card grows", () => {
    render(<Harness />);
    run(() => showAmber({ variant: "reconnect", episode: 1 }));
    const before = getMeetingCard();
    expect(screen.getByTestId("meeting-card").style.height).toBe(`${cardHeight(before, false)}px`);
    run(() => setAmberError(GOOGLE_COPY.GOOGLE_AUTH_REJECTED));
    const err = screen.getByTestId("meeting-card-error");
    expect(err.textContent).toBe(GOOGLE_COPY.GOOGLE_AUTH_REJECTED);
    expect(err.className).not.toContain("truncate");
    const body = screen.getByText(/Google Calendar is disconnected/);
    expect(body.compareDocumentPosition(err) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(cardHeight(getMeetingCard(), false)).toBeGreaterThan(cardHeight(before, false));
    expect(screen.getByTestId("meeting-card").style.height).toBe(`${cardHeight(getMeetingCard(), false)}px`);
  });

  it("compact amber with an error shows it in place of the headline, with a title", () => {
    render(<Harness compact />);
    run(() => showAmber({ variant: "reconnect", episode: 1 }));
    run(() => setAmberError(GOOGLE_COPY.GOOGLE_NETWORK));
    const err = screen.getByTestId("meeting-card-error");
    expect(err.getAttribute("title")).toBe(GOOGLE_COPY.GOOGLE_NETWORK);
    expect(screen.queryByText("If this is a Meet call, it isn't being recorded")).toBeNull();
    expect(screen.getByRole("button", { name: "Reconnect Google" })).toBeTruthy();
  });

  it("a replacement card of the same kind does not inherit hover or busy state", () => {
    render(<Harness />);
    run(() => void start());
    fireEvent.mouseEnter(screen.getByTestId("meeting-card"));
    expect(screen.getByTestId("meeting-card").getAttribute("data-paused")).toBe("true");
    run(() => {
      autoRecordingStopped();
      vi.setSystemTime(T0 + 10 * 60_000);
      start();
    });
    expect(screen.getByTestId("meeting-card").getAttribute("data-paused")).toBe("false");
  });

  it("animation classes are motion-safe only, on every card form", () => {
    const seen: string[] = [];
    const scenarios: Array<() => void> = [
      () => setCardEvent(start(), event("X")),
      () => void start(),
      () => {
        setCardEvent(start(), event("X", 2));
        autoRecordingStopped();
        vi.advanceTimersByTime(30_000);
      },
      () => showAmber({ variant: "reconnect", episode: 1 }),
      () => {
        showAmber({ variant: "settings", episode: 1 });
        setAmberError("boom");
      },
      () => showAmber({ variant: "offline", episode: 1 }),
    ];
    for (const compact of [false, true]) {
      for (const make of scenarios) {
        resetMeetingCardsForTests();
        const { unmount } = render(<Harness compact={compact} />);
        run(make);
        expect(screen.getByTestId("meeting-card")).toBeTruthy();
        document.body.querySelectorAll("*").forEach((el) => {
          seen.push(...(el.getAttribute("class") ?? "").split(/\s+/).filter(Boolean));
        });
        unmount();
      }
    }
    const motion = seen.filter((c) => /(^|:)(animate-|slide-)/.test(c));
    expect(motion.length).toBeGreaterThan(0);
    expect(motion.filter((c) => !c.startsWith("motion-safe:"))).toEqual([]);
    // The reduced-motion fade: no animate-* class, so it survives motion-reduce.
    expect(seen).toContain("transition-opacity");
    expect(seen).toContain("starting:opacity-0");
  });
});

describe("useMeetingCardHost", () => {
  it("an amber card reveals the window; a red card does not", () => {
    const { result } = renderHook(() => useMeetingCardHost("icon-only"));
    run(() => void start());
    expect(result.current?.kind).toBe("recording");
    expect(h.invoke).not.toHaveBeenCalledWith("reveal_overlay");

    tick(6000);
    expect(result.current).toBeNull();
    run(() => autoRecordingStopped()); // amber never shows while a capture runs
    run(() => showAmber({ variant: "reconnect", episode: 1 }));
    expect(result.current?.kind).toBe("amber");
    expect(h.invoke).toHaveBeenCalledWith("reveal_overlay");
  });

  it("a new amber episode re-reveals; an error update on the same episode does not", () => {
    renderHook(() => useMeetingCardHost("icon-only"));
    run(() => showAmber({ variant: "reconnect", episode: 1 }));
    run(() => setAmberError("x"));
    const reveals = () => h.invoke.mock.calls.filter((c) => c[0] === "reveal_overlay").length;
    expect(reveals()).toBe(1);
    run(() => showAmber({ variant: "reconnect", episode: 2 }));
    expect(reveals()).toBe(2);
  });
});
