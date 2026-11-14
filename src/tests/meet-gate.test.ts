import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

import {
  createMeetGate,
  defaultMeetGateDeps,
  type MeetGateDeps,
} from "@/lib/meet-gate";
import type { CalendarEvent } from "@/types/calendar";
import type { FetchGoogleMeetingsResult } from "@/lib/calendar/fetch-google-meetings";
import {
  autoRecordingStarted,
  resetMeetingCardsForTests,
} from "@/lib/meeting-cards.store";

const T0 = 1_000_000;
const HOUR = 3_600_000;

const meetEvent: CalendarEvent = {
  id: "ev1",
  subject: "Standup",
  hasMeetLink: true,
  isCancelled: false,
  isAllDay: false,
  startMs: T0 - 60_000,
  endMs: T0 + HOUR,
  participants: [],
  ownResponse: "accepted",
};
const MATCH: FetchGoogleMeetingsResult = {
  kind: "ok",
  events: [meetEvent],
  ownAddress: null,
};
const NO_MATCH: FetchGoogleMeetingsResult = {
  kind: "ok",
  events: [],
  ownAddress: null,
};
const ERR: FetchGoogleMeetingsResult = {
  kind: "error",
  code: "GOOGLE_AUTH_EXPIRED",
};

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Every fetch is a held deferred, resolved by the test. */
function makeMocks(fetches: Array<Deferred<FetchGoogleMeetingsResult>>) {
  return {
    loadConfigState: vi.fn<MeetGateDeps["loadConfigState"]>(async () => "complete"),
    fetchMeetings: vi.fn<MeetGateDeps["fetchMeetings"]>(() => {
      const d = deferred<FetchGoogleMeetingsResult>();
      fetches.push(d);
      return d.promise;
    }),
    confirm: vi.fn<MeetGateDeps["confirm"]>(async () => undefined),
    captureRunning: vi.fn<MeetGateDeps["captureRunning"]>(async () => false),
    gatedRecordingRunning: vi.fn<MeetGateDeps["gatedRecordingRunning"]>(() => false),
    showAmber: vi.fn<MeetGateDeps["showAmber"]>(),
    dismissAmber: vi.fn<MeetGateDeps["dismissAmber"]>(),
    now: vi.fn<MeetGateDeps["now"]>(() => T0),
  };
}

/** Overrides keep their mock types, so tests can still call mockClear etc. */
function setup(over: Partial<ReturnType<typeof makeMocks>> = {}) {
  const fetches: Array<Deferred<FetchGoogleMeetingsResult>> = [];
  const deps = { ...makeMocks(fetches), ...over };
  const typed: MeetGateDeps = deps;
  return { deps, fetches, gate: createMeetGate(typed) };
}

const settle = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("createMeetGate", () => {
  it("checks on candidate start and confirms a qualifying event", async () => {
    const { deps, fetches, gate } = setup();
    gate.candidateStarted(1);
    await settle();
    fetches[0].resolve(MATCH);
    await settle();
    expect(deps.confirm).toHaveBeenCalledWith(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(deps.fetchMeetings).toHaveBeenCalledTimes(1);
  });

  it("rechecks 60s after the previous check finishes", async () => {
    const { deps, fetches, gate } = setup();
    gate.candidateStarted(1);
    await vi.advanceTimersByTimeAsync(5_000);
    fetches[0].resolve(NO_MATCH);
    await settle();
    await vi.advanceTimersByTimeAsync(59_000);
    expect(deps.fetchMeetings).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(deps.fetchMeetings).toHaveBeenCalledTimes(2);
  });

  it("never overlaps checks", async () => {
    const { deps, fetches, gate } = setup();
    gate.candidateStarted(1);
    await vi.advanceTimersByTimeAsync(90_000);
    expect(deps.fetchMeetings).toHaveBeenCalledTimes(1);
    fetches[0].resolve(NO_MATCH);
    await settle();
    expect(deps.fetchMeetings).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(deps.fetchMeetings).toHaveBeenCalledTimes(2);
  });

  it("candidate end stops the loop and dismisses the amber card", async () => {
    const { deps, fetches, gate } = setup();
    gate.candidateStarted(1);
    await settle();
    fetches[0].resolve(NO_MATCH);
    await settle();
    deps.dismissAmber.mockClear();
    gate.candidateEnded(1);
    expect(deps.dismissAmber).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(180_000);
    expect(deps.fetchMeetings).toHaveBeenCalledTimes(1);
  });

  it("stop stops the loop and dismisses", async () => {
    const { deps, fetches, gate } = setup();
    gate.candidateStarted(1);
    await settle();
    fetches[0].resolve(NO_MATCH);
    await settle();
    deps.dismissAmber.mockClear();
    gate.stop();
    expect(deps.dismissAmber).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(180_000);
    expect(deps.fetchMeetings).toHaveBeenCalledTimes(1);
  });

  it("a result for an ended episode is discarded", async () => {
    const { deps, fetches, gate } = setup();
    gate.candidateStarted(1);
    await settle();
    gate.candidateEnded(1);
    fetches[0].resolve(MATCH);
    await settle();
    expect(deps.confirm).not.toHaveBeenCalled();
    expect(deps.showAmber).not.toHaveBeenCalled();
  });

  it("connection change checks at once", async () => {
    const { deps, fetches, gate } = setup();
    gate.candidateStarted(1);
    await settle();
    fetches[0].resolve(NO_MATCH);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(deps.fetchMeetings).toHaveBeenCalledTimes(1);
    gate.connectionChanged();
    await settle();
    expect(deps.fetchMeetings).toHaveBeenCalledTimes(2);
  });

  it("connection change during a check reruns once", async () => {
    const { deps, fetches, gate } = setup();
    gate.candidateStarted(1);
    await settle();
    gate.connectionChanged();
    gate.connectionChanged();
    await settle();
    expect(deps.fetchMeetings).toHaveBeenCalledTimes(1);
    fetches[0].resolve(NO_MATCH);
    await settle();
    expect(deps.fetchMeetings).toHaveBeenCalledTimes(2);
    fetches[1].resolve(NO_MATCH);
    await settle();
    expect(deps.fetchMeetings).toHaveBeenCalledTimes(2);
  });

  it("new episode during an in-flight check", async () => {
    const { deps, fetches, gate } = setup();
    gate.candidateStarted(1);
    await settle();
    gate.candidateStarted(2);
    await settle();
    expect(deps.fetchMeetings).toHaveBeenCalledTimes(2);
    fetches[0].resolve(MATCH);
    await settle();
    expect(deps.confirm).not.toHaveBeenCalledWith(1);
  });

  it("a stale check does not free the new episode's slot", async () => {
    const { deps, fetches, gate } = setup();
    gate.candidateStarted(1);
    await settle();
    gate.candidateEnded(1);
    gate.candidateStarted(2);
    await settle();
    expect(deps.fetchMeetings).toHaveBeenCalledTimes(2);
    fetches[0].resolve(NO_MATCH);
    await settle();
    gate.connectionChanged();
    await settle();
    expect(deps.fetchMeetings).toHaveBeenCalledTimes(2);
    fetches[1].resolve(NO_MATCH);
    await settle();
    expect(deps.fetchMeetings).toHaveBeenCalledTimes(3);
    fetches[2].resolve(NO_MATCH);
    await settle();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(deps.fetchMeetings).toHaveBeenCalledTimes(4);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a re-announced live episode is ignored", async () => {
    const { deps, fetches, gate } = setup({
      fetchMeetings: vi.fn(async () => ERR),
    });
    void fetches;
    gate.candidateStarted(1);
    await settle();
    gate.candidateStarted(1);
    await settle();
    expect(deps.fetchMeetings).toHaveBeenCalledTimes(1);
    expect(deps.showAmber).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(deps.fetchMeetings).toHaveBeenCalledTimes(2);
    expect(deps.showAmber).toHaveBeenCalledTimes(1);
  });

  it("an episode that ends while confirm is pending is left alone", async () => {
    const confirmD = deferred<unknown>();
    const { deps, fetches, gate } = setup({
      confirm: vi.fn(() => confirmD.promise),
    });
    gate.candidateStarted(1);
    await settle();
    fetches[0].resolve(MATCH);
    await settle();
    expect(deps.confirm).toHaveBeenCalledWith(1);
    gate.candidateEnded(1);
    confirmD.resolve(undefined);
    await settle();
    expect(deps.dismissAmber).toHaveBeenCalledTimes(1);
    expect(deps.fetchMeetings).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("confirm rejection keeps the loop", async () => {
    const { deps, fetches, gate } = setup({
      confirm: vi.fn(async () => {
        throw new Error("WATCHER_NOT_RUNNING");
      }),
    });
    gate.candidateStarted(1);
    await settle();
    fetches[0].resolve(MATCH);
    await settle();
    expect(deps.confirm).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(deps.fetchMeetings).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(deps.fetchMeetings).toHaveBeenCalledTimes(2);
  });

  it("a stale confirm rejection does not disturb the live episode's timer", async () => {
    const confirmD = deferred<unknown>();
    const confirm = vi
      .fn<(episode: number) => Promise<unknown>>()
      .mockReturnValueOnce(confirmD.promise)
      .mockResolvedValue(undefined);
    const { deps, fetches, gate } = setup({ confirm });
    gate.candidateStarted(1);
    await settle();
    fetches[0].resolve(MATCH);
    await settle();
    gate.candidateEnded(1);
    gate.candidateStarted(2);
    await settle();
    fetches[1].resolve(NO_MATCH);
    await settle();
    expect(deps.fetchMeetings).toHaveBeenCalledTimes(2);
    confirmD.reject(new Error("WATCHER_NOT_RUNNING"));
    await settle();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(deps.fetchMeetings).toHaveBeenCalledTimes(3);
    // The re-check must belong to episode 2: a stale episode-1 check would be
    // discarded, so only episode 2's own check can confirm.
    fetches[2].resolve(MATCH);
    await settle();
    expect(deps.confirm).toHaveBeenLastCalledWith(2);
  });

  it("the amber card shows once per episode", async () => {
    const { deps, gate } = setup({ fetchMeetings: vi.fn(async () => ERR) });
    gate.candidateStarted(1);
    await settle();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(deps.fetchMeetings).toHaveBeenCalledTimes(2);
    expect(deps.showAmber).toHaveBeenCalledTimes(1);
    expect(deps.showAmber).toHaveBeenCalledWith({
      variant: "reconnect",
      episode: 1,
    });

    const unreadable = setup({
      fetchMeetings: vi.fn(async () => ERR),
      loadConfigState: vi.fn(async () => "unreadable" as const),
    });
    unreadable.gate.candidateStarted(1);
    await settle();
    expect(unreadable.deps.showAmber).toHaveBeenCalledWith({
      variant: "settings",
      episode: 1,
    });
  });

  it("no amber while a capture is running", async () => {
    const { deps, gate } = setup({
      fetchMeetings: vi.fn(async () => ERR),
      captureRunning: vi.fn(async () => true),
    });
    gate.candidateStarted(1);
    await settle();
    expect(deps.fetchMeetings).toHaveBeenCalledTimes(1);
    expect(deps.showAmber).not.toHaveBeenCalled();
  });

  it("a gated recording already running confirms without a check", async () => {
    const { deps, gate } = setup({ gatedRecordingRunning: vi.fn(() => true) });
    gate.candidateStarted(1);
    await settle();
    expect(deps.confirm).toHaveBeenCalledWith(1);
    expect(deps.fetchMeetings).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(deps.fetchMeetings).not.toHaveBeenCalled();
  });

  it("a successful read with no Meet event dismisses the amber card", async () => {
    const { deps, fetches, gate } = setup();
    gate.candidateStarted(1);
    await settle();
    fetches[0].resolve(NO_MATCH);
    await settle();
    expect(deps.dismissAmber).toHaveBeenCalledTimes(1);
  });
});

describe("defaultMeetGateDeps", () => {
  beforeEach(() => {
    invoke.mockReset();
    resetMeetingCardsForTests();
  });

  it("captureRunning is true when get_capture_status is true", async () => {
    invoke.mockResolvedValue(true);
    expect(await defaultMeetGateDeps().captureRunning()).toBe(true);
    expect(invoke).toHaveBeenCalledWith("get_capture_status");
  });

  it("captureRunning is false when get_capture_status rejects", async () => {
    invoke.mockRejectedValue(new Error("nope"));
    expect(await defaultMeetGateDeps().captureRunning()).toBe(false);
  });

  it("captureRunning is true when the status is false but an auto recording is active", async () => {
    invoke.mockResolvedValue(false);
    autoRecordingStarted({ app: "chrome.exe", gated: true, stop: () => {} });
    expect(await defaultMeetGateDeps().captureRunning()).toBe(true);
  });

  it("gatedRecordingRunning is false for a Teams recording and true for a Meet one", () => {
    const deps = defaultMeetGateDeps();
    autoRecordingStarted({ app: "ms-teams.exe", gated: false, stop: () => {} });
    expect(deps.gatedRecordingRunning()).toBe(false);
    resetMeetingCardsForTests();
    autoRecordingStarted({ app: "chrome.exe", gated: true, stop: () => {} });
    expect(deps.gatedRecordingRunning()).toBe(true);
  });

  it("confirm invokes confirm_meeting_candidate with the episode", async () => {
    invoke.mockResolvedValue(undefined);
    await defaultMeetGateDeps().confirm(7);
    expect(invoke).toHaveBeenCalledWith("confirm_meeting_candidate", {
      episode: 7,
    });
  });
});
