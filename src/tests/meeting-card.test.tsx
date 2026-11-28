import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { useSyncExternalStore } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  invoke: vi.fn(async (..._args: unknown[]): Promise<unknown> => undefined),
  reconnect: vi.fn(async (): Promise<unknown> => ({ ok: true })),
  accept: vi.fn(async (): Promise<void> => undefined),
  decline: vi.fn((): void => undefined),
  platform: { current: "macos" as "macos" | "windows" | "linux" },
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
vi.mock("@/lib/calendar/google-connect", () => ({ reconnectGoogle: h.reconnect }));
vi.mock("@/lib/platform", () => ({
  getPlatform: () => h.platform.current,
  isWindows: () => h.platform.current === "windows",
  isMacOS: () => h.platform.current === "macos",
  isLinux: () => h.platform.current === "linux",
}));
// The copy is real; only the actions are spied (their logic is tested in
// auto-record-offer.test.ts).
vi.mock("@/lib/auto-record-offer", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  acceptAutoRecordOffer: h.accept,
  declineAutoRecordOffer: h.decline,
}));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({ label: "main" }),
}));

import { useMeetingCardHost } from "@/hooks/useMeetingCardHost";
import { OFFER_BODY, OFFER_FOOTNOTE, OFFER_TITLE } from "@/lib/auto-record-offer";
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
  setOfferState,
  showOffer,
  showStopNotice,
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
  h.platform.current = "macos";
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
    expect(screen.getByTestId("meeting-card-people").textContent).toBe(
      "with Ada Kay, Jo Smith, Max Reed +2",
    );
  });

  it("the recording card leaves out the people line when nobody else is invited", () => {
    render(<Harness />);
    run(() => setCardEvent(start(), event("Focus", 1), "p0@x.com"));
    expect(screen.getByText("Focus")).toBeTruthy();
    expect(screen.queryByTestId("meeting-card-people")).toBeNull();
  });

  it("without an event only the top row shows", () => {
    render(<Harness />);
    run(() => void start());
    expect(screen.queryByTestId("meeting-card-title")).toBeNull();
    expect(screen.queryByTestId("meeting-card-people")).toBeNull();
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

  it("the compact recording card is the title row plus a people line", () => {
    render(<Harness compact />);
    run(() => setCardEvent(start(), event("Sync")));
    const root = screen.getByTestId("meeting-card");
    expect(root.textContent).toContain("REC");
    expect(root.textContent).toContain("Sync");
    expect(root.textContent).toContain("00:00");
    expect(screen.getByTestId("meeting-card-people").textContent).toBe(
      "with Ada Kay, Jo Smith, Max Reed +2",
    );
    // No title block, no time range, no divider.
    expect(screen.queryByTestId("meeting-card-title")).toBeNull();
    expect(root.textContent).not.toContain("10:00");
    expect(root.querySelector(".h-px")).toBeNull();
    expect(root.firstElementChild?.children).toHaveLength(2);
    expect(root.style.height).toBe(`${cardHeight(getMeetingCard(), true)}px`);
    expect(cardHeight(getMeetingCard(), true)).toBeGreaterThan(48);
  });

  it("the compact recording card stays one row when nobody else is invited", () => {
    render(<Harness compact />);
    run(() => setCardEvent(start(), event("Focus", 1), "p0@x.com"));
    const root = screen.getByTestId("meeting-card");
    expect(screen.queryByTestId("meeting-card-people")).toBeNull();
    expect(root.firstElementChild?.children).toHaveLength(1);
    expect(root.style.height).toBe("48px");
  });

  it("the full recording card puts Stop on its own bottom row", () => {
    render(<Harness />);
    run(() => setCardEvent(start(), event("Weekly IC sync")));
    const stop = screen.getByRole("button", { name: "Stop" });
    const when = screen.getByTestId("meeting-card-people");
    expect(stop.parentElement).not.toBe(when.parentElement?.parentElement);
    expect(stop.parentElement?.contains(when)).toBe(false);
    expect(stop.parentElement?.className).toContain("justify-end");
  });

  it("glyphs are aria-hidden, and only static text is a live region", () => {
    const hidden = (g: string) => screen.getByText(g).getAttribute("aria-hidden");
    render(<Harness />);
    run(() => void start());
    expect(hidden("◉")).toBe("true");
    expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
    // Red card: the root is not a live region; the timer sits outside the one that exists.
    expect(screen.getByTestId("meeting-card").getAttribute("role")).toBeNull();
    const region = screen.getByRole("status");
    expect(region.contains(screen.getByTestId("meeting-card-timer"))).toBe(false);
    expect(region.textContent).toBe("Google Meet · recording started");
    cleanup();
    resetMeetingCardsForTests();

    render(<Harness />);
    run(() => showAmber({ variant: "offline", episode: 1 }));
    expect(hidden("⚠")).toBe("true");
    cleanup();
    resetMeetingCardsForTests();

    render(<Harness />);
    run(() => showStopNotice("call-ended"));
    expect(screen.getByTestId("meeting-card").getAttribute("data-kind")).toBe("ended");
    expect(screen.getByTestId("meeting-card").getAttribute("role")).toBe("status");
    expect(hidden("✓")).toBe("true");
  });

  it("the ended card shows the stop reason, compact and full, then leaves", () => {
    for (const compact of [false, true]) {
      render(<Harness compact={compact} />);
      run(() => showStopNotice("call-ended"));
      expect(screen.getByText("Recording stopped - call ended")).toBeTruthy();
      expect(screen.getByTestId("meeting-card").style.height).toBe(
        `${cardHeight(getMeetingCard(), compact)}px`
      );
      cleanup();
      resetMeetingCardsForTests();
    }
    render(<Harness compact />);
    run(() => showStopNotice("silence"));
    expect(screen.getByText("Recording stopped - 15 min of silence")).toBeTruthy();
    tick(5000);
    expect(screen.queryByTestId("meeting-card")).toBeNull();
  });

  it("amber reconnect: headline, Not now snoozes, Reconnect failure shows Google copy and keeps the button", async () => {
    render(<Harness />);
    run(() => showAmber({ variant: "reconnect", episode: 1 }));
    expect(screen.getByText("Couldn't read Google Calendar")).toBeTruthy();
    expect(screen.getByText(/won't list who was invited\. Reconnect Google/)).toBeTruthy();

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
    expect(screen.getByText(/Open settings to fix it\./)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Not now" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open settings" }));
    expect(h.invoke).toHaveBeenCalledWith("open_dashboard");
  });

  it("amber settings body names the saved setup", () => {
    render(<Harness />);
    run(() => showAmber({ variant: "settings", episode: 1 }));
    expect(screen.getByText(/can't read your saved Google Calendar setup/)).toBeTruthy();
  });

  it("amber offline has Got it only", () => {
    render(<Harness />);
    run(() => showAmber({ variant: "offline", episode: 1 }));
    expect(screen.getByText(/couldn't reach Google Calendar/)).toBeTruthy();
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
    const body = screen.getByText(/won't list who was invited\. Reconnect Google/);
    expect(body.compareDocumentPosition(err) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(cardHeight(getMeetingCard(), false)).toBeGreaterThan(cardHeight(before, false));
    expect(screen.getByTestId("meeting-card").style.height).toBe(`${cardHeight(getMeetingCard(), false)}px`);
  });

  it("only the amber card sits above an open response popover (z-50 portal)", () => {
    render(<Harness />);
    run(() => showAmber({ variant: "reconnect", episode: 1 }));
    const amber = screen.getByTestId("meeting-card").className.split(/\s+/);
    expect(amber).toContain("relative");
    expect(amber).toContain("z-[60]");
    run(() => autoRecordingStarted({ app: "Google Meet", gated: false, stop: () => {} }));
    expect(screen.getByTestId("meeting-card").className).not.toContain("z-[60]");
  });

  it("the compact amber headline wraps to two lines instead of truncating", () => {
    render(<Harness compact />);
    run(() => showAmber({ variant: "reconnect", episode: 1 }));
    const headline = screen.getByText("Couldn't read Google Calendar");
    expect(headline.className).toContain("line-clamp-2");
    expect(headline.className).toContain("text-xs");
    expect(headline.className).not.toContain("truncate");
    run(() => setAmberError(GOOGLE_COPY.GOOGLE_NETWORK));
    expect(screen.getByTestId("meeting-card-error").className).toContain("line-clamp-2");
  });

  it("compact amber with an error shows it in place of the headline, with a title", () => {
    render(<Harness compact />);
    run(() => showAmber({ variant: "reconnect", episode: 1 }));
    run(() => setAmberError(GOOGLE_COPY.GOOGLE_NETWORK));
    const err = screen.getByTestId("meeting-card-error");
    expect(err.getAttribute("title")).toBe(GOOGLE_COPY.GOOGLE_NETWORK);
    expect(screen.queryByText("Couldn't read Google Calendar")).toBeNull();
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
      () => showStopNotice("silence"),
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
  it("an offer card reveals the window", () => {
    const { result } = renderHook(() => useMeetingCardHost("icon-only"));
    expect(h.invoke).not.toHaveBeenCalledWith("reveal_overlay");
    run(() => void showOffer());
    expect(result.current?.kind).toBe("offer");
    expect(h.invoke).toHaveBeenCalledWith("reveal_overlay");
  });

  it("an amber card reveals the window; a red card does not", () => {
    const { result } = renderHook(() => useMeetingCardHost("icon-only"));
    run(() => void start());
    expect(result.current?.kind).toBe("recording");
    expect(h.invoke).not.toHaveBeenCalledWith("reveal_overlay");

    tick(6000);
    expect(result.current).toBeNull();
    run(() => autoRecordingStopped()); // with the capture stopped, the amber takes the slot
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

describe("MeetingCard: auto-record offer", () => {
  it("mac copy; Turn on calls accept, Not now calls decline", () => {
    run(() => void showOffer());
    render(<Harness />);
    expect(screen.getByTestId("meeting-card").getAttribute("data-kind")).toBe("offer");
    expect(screen.getByText(OFFER_TITLE)).toBeTruthy();
    expect(screen.getByText(OFFER_BODY.macos)).toBeTruthy();
    expect(screen.getByText(OFFER_FOOTNOTE)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Turn on" }));
    expect(h.accept).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(h.decline).toHaveBeenCalledTimes(1);
  });

  it("windows copy", () => {
    h.platform.current = "windows";
    run(() => void showOffer());
    render(<Harness />);
    expect(screen.getByText(OFFER_BODY.windows)).toBeTruthy();
  });

  it("busy disables every button", () => {
    run(() => {
      showOffer();
      setOfferState({ busy: true, error: null });
    });
    render(<Harness />);
    const buttons = screen.getAllByRole("button");
    expect(buttons.length).toBeGreaterThan(0);
    for (const b of buttons) expect((b as HTMLButtonElement).disabled).toBe(true);
  });

  it("an error shows the message; Open settings replaces Turn on and opens the dashboard", () => {
    run(() => {
      showOffer();
      setOfferState({ busy: false, error: "Mic blocked" });
    });
    render(<Harness />);
    expect(screen.getByText("Mic blocked")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Turn on" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open settings" }));
    expect(h.invoke).toHaveBeenCalledWith("open_dashboard");
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(h.decline).toHaveBeenCalledTimes(1);
  });

  it("renders at the store's height, full and compact, with and without an error", () => {
    run(() => void showOffer());
    const { rerender } = render(<Harness />);
    const px = () => (screen.getByTestId("meeting-card") as HTMLElement).style.height;
    expect(px()).toBe(`${cardHeight(getMeetingCard(), false)}px`);
    rerender(<Harness compact />);
    expect(px()).toBe(`${cardHeight(getMeetingCard(), true)}px`);
    run(() => setOfferState({ busy: false, error: "x" }));
    expect(px()).toBe(`${cardHeight(getMeetingCard(), true)}px`);
  });
});
