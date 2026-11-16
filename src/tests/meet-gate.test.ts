import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));
const fetchGoogle = vi.hoisted(() => vi.fn());
vi.mock("@/lib/calendar/fetch-google-meetings", () => ({
  fetchCurrentGoogleMeetings: fetchGoogle,
}));

import { createMeetGate, defaultMeetGateDeps } from "@/lib/meet-gate";

beforeEach(() => {
  invoke.mockReset();
  fetchGoogle.mockReset();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("createMeetGate", () => {
  it("confirms a Chrome candidate at once, with no calendar read", async () => {
    const confirm = vi.fn(async () => undefined);
    createMeetGate({ confirm }).candidateStarted(7);
    expect(confirm).toHaveBeenCalledWith(7);
    expect(fetchGoogle).not.toHaveBeenCalled();
  });

  it("a failed confirm is logged, never an unhandled rejection", async () => {
    const confirm = vi.fn(async () => {
      throw new Error("WATCHER_NOT_RUNNING");
    });
    createMeetGate({ confirm }).candidateStarted(3);
    await vi.waitFor(() =>
      expect(console.warn).toHaveBeenCalledWith(
        "confirm_meeting_candidate failed:",
        expect.any(Error)
      )
    );
  });
});

describe("defaultMeetGateDeps", () => {
  it("confirm invokes confirm_meeting_candidate with the episode", async () => {
    invoke.mockResolvedValue(undefined);
    await defaultMeetGateDeps().confirm(7);
    expect(invoke).toHaveBeenCalledWith("confirm_meeting_candidate", {
      episode: 7,
    });
  });
});
