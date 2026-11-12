import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

const config = vi.hoisted(() => ({ loadGoogleConfigState: vi.fn() }));
vi.mock("@/lib/storage/google-config.storage", () => config);

import { fetchCurrentGoogleMeetings } from "@/lib/calendar/fetch-google-meetings";

const COMPLETE = {
  state: "complete" as const,
  config: { clientId: "cid", clientSecret: "sec" },
};

beforeEach(() => {
  invoke.mockReset();
  config.loadGoogleConfigState.mockReset();
  config.loadGoogleConfigState.mockResolvedValue(COMPLETE);
});

describe("fetchCurrentGoogleMeetings", () => {
  it("absent makes no invoke call", async () => {
    config.loadGoogleConfigState.mockResolvedValue({ state: "absent", config: null });
    await expect(fetchCurrentGoogleMeetings()).resolves.toEqual({ kind: "absent" });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("an unreadable config is a rejected sign-in", async () => {
    config.loadGoogleConfigState.mockResolvedValue({ state: "unreadable", config: null });
    await expect(fetchCurrentGoogleMeetings()).resolves.toEqual({
      kind: "error",
      code: "GOOGLE_AUTH_REJECTED",
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("passes clientId, clientSecret and a ±15 minute window", async () => {
    invoke.mockResolvedValue({ ownAddress: "me@example.org", events: [] });
    await expect(fetchCurrentGoogleMeetings(Date.UTC(2026, 10, 12, 10))).resolves.toEqual({
      kind: "ok",
      ownAddress: "me@example.org",
      events: [],
    });
    expect(invoke).toHaveBeenCalledWith("google_current_meetings", {
      clientId: "cid",
      clientSecret: "sec",
      startIso: "2026-11-12T09:45:00.000Z",
      endIso: "2026-11-12T10:15:00.000Z",
    });
  });

  it("a rejected invoke resolves to its code and never rejects", async () => {
    invoke.mockRejectedValue("GOOGLE_THROTTLED");
    await expect(fetchCurrentGoogleMeetings()).resolves.toEqual({
      kind: "error",
      code: "GOOGLE_THROTTLED",
    });
  });
});
