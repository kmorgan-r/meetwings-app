import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

const config = vi.hoisted(() => ({ loadGraphConfigState: vi.fn() }));
vi.mock("@/lib/storage/graph-config.storage", () => config);

import { fetchCurrentMeetings, fetchMeetingsBetween } from "@/lib/calendar/fetch-current-meetings";

const COMPLETE = {
  state: "complete" as const,
  config: { clientId: "c", authority: "https://login.microsoftonline.com/organizations" },
};

beforeEach(() => {
  invoke.mockReset();
  config.loadGraphConfigState.mockReset();
  config.loadGraphConfigState.mockResolvedValue(COMPLETE);
});

describe("fetchCurrentMeetings", () => {
  it("queries 15 minutes either side of now and returns the meetings", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2026, 9, 15, 10, 0, 0));
    invoke.mockResolvedValue({ ownAddress: "me@corp.test", events: [] });

    await expect(fetchCurrentMeetings()).resolves.toEqual({ kind: "ok", ownAddress: "me@corp.test", events: [] });
    expect(invoke).toHaveBeenCalledWith("graph_current_meetings", {
      clientId: "c",
      authority: "https://login.microsoftonline.com/organizations",
      startIso: "2026-10-15T09:45:00.000Z",
      endIso: "2026-10-15T10:15:00.000Z",
    });
    vi.useRealTimers();
  });

  it("reports an absent config without calling Graph", async () => {
    config.loadGraphConfigState.mockResolvedValue({ state: "absent", config: null });
    await expect(fetchCurrentMeetings()).resolves.toEqual({ kind: "absent" });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("reports an unreadable config as a rejected authority", async () => {
    config.loadGraphConfigState.mockResolvedValue({ state: "unreadable", config: null });
    await expect(fetchCurrentMeetings()).resolves.toEqual({ kind: "error", code: "GRAPH_AUTH_REJECTED" });
  });

  it("maps a Graph failure to its code instead of rejecting", async () => {
    invoke.mockRejectedValue(new Error("GRAPH_THROTTLED"));
    await expect(fetchCurrentMeetings()).resolves.toEqual({ kind: "error", code: "GRAPH_THROTTLED" });
  });

  it("fetchCurrentMeetings still uses ±15 minutes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2026, 10, 12, 23, 50, 0));
    invoke.mockResolvedValue({ ownAddress: null, events: [] });

    await fetchCurrentMeetings();
    expect(invoke).toHaveBeenCalledWith(
      "graph_current_meetings",
      expect.objectContaining({
        startIso: "2026-11-12T23:35:00.000Z",
        endIso: "2026-11-13T00:05:00.000Z",
      })
    );
    vi.useRealTimers();
  });
});

describe("fetchMeetingsBetween", () => {
  it("fetchMeetingsBetween passes its own window", async () => {
    invoke.mockResolvedValue({ ownAddress: "me@example.org", events: [] });

    await expect(
      fetchMeetingsBetween(Date.UTC(2026, 10, 12, 10, 0, 0), Date.UTC(2026, 10, 12, 10, 47, 30))
    ).resolves.toEqual({ kind: "ok", ownAddress: "me@example.org", events: [] });
    expect(invoke).toHaveBeenCalledWith("graph_current_meetings", {
      clientId: COMPLETE.config.clientId,
      authority: COMPLETE.config.authority,
      startIso: "2026-11-12T10:00:00.000Z",
      endIso: "2026-11-12T10:47:30.000Z",
    });
  });

  it("reports an absent config, and a failed read, the same way fetchCurrentMeetings does", async () => {
    config.loadGraphConfigState.mockResolvedValueOnce({ state: "absent", config: null });
    await expect(fetchMeetingsBetween(0, 1)).resolves.toEqual({ kind: "absent" });
    expect(invoke).not.toHaveBeenCalled();

    invoke.mockRejectedValue(new Error("GRAPH_AUTH_EXPIRED"));
    await expect(fetchMeetingsBetween(0, 1)).resolves.toEqual({ kind: "error", code: "GRAPH_AUTH_EXPIRED" });
  });
});