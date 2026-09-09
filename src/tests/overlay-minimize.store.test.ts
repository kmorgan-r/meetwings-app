import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  getPillActions,
  getPillData,
  getMinimized,
  PILL_DIMENSIONS,
  setPillActions,
  setPillData,
  setMinimized,
  subscribeToPillActions,
  subscribeToPillData,
  subscribeToMinimized,
} from "@/lib/overlay-minimize.store";

describe("overlay-minimize store", () => {
  beforeEach(() => {
    setMinimized(false);
    setPillData({ segmentCount: 0, lastLine: "", status: "idle", recording: false });
    setPillActions({ toggleRecording: null });
    vi.clearAllMocks();
  });

  it("starts un-minimized and toggles", () => {
    expect(getMinimized()).toBe(false);
    setMinimized(true);
    expect(getMinimized()).toBe(true);
    setMinimized(false);
    expect(getMinimized()).toBe(false);
  });

  it("notifies subscribers on minimize and clears on restore, and unsubscribe works", () => {
    const listener = vi.fn();
    const unsub = subscribeToMinimized(listener);

    setMinimized(true);
    expect(listener).toHaveBeenCalledTimes(1);

    unsub();
    setMinimized(true); // no-op: already true, no notification
    setMinimized(false);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("does not notify when the value does not change", () => {
    const listener = vi.fn();
    subscribeToMinimized(listener);

    setMinimized(false); // already false
    expect(listener).not.toHaveBeenCalled();
  });

  it("maintains the data-overlay-minimized body attribute", () => {
    setMinimized(true);
    expect(document.body.hasAttribute("data-overlay-minimized")).toBe(true);

    setMinimized(false);
    expect(document.body.hasAttribute("data-overlay-minimized")).toBe(false);
  });

  it("pill data: writer replaces the stored reference and notifies subscribers", () => {
    const listener = vi.fn();
    subscribeToPillData(listener);

    const next = {
      segmentCount: 3,
      lastLine: "hello",
      status: "capturing" as const,
      recording: true,
    };
    setPillData(next);

    expect(getPillData()).toBe(next); // SAME reference — useSyncExternalStore contract
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("exports the spec's pill dimensions for all three styles", () => {
    expect(PILL_DIMENSIONS["status-count"]).toEqual({ width: 180, height: 40 });
    expect(PILL_DIMENSIONS["icon-only"]).toEqual({ width: 84, height: 52 });
    expect(PILL_DIMENSIONS["status-last-line"]).toEqual({ width: 352, height: 48 });
  });

  it("pill actions: start out unregistered", () => {
    expect(getPillActions().toggleRecording).toBeNull();
  });

  it("pill actions: writer replaces the stored reference and notifies subscribers", () => {
    const listener = vi.fn();
    subscribeToPillActions(listener);

    const next = { toggleRecording: vi.fn() };
    setPillActions(next);

    expect(getPillActions()).toBe(next); // SAME reference - useSyncExternalStore contract
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("pill actions: unsubscribe stops notifications", () => {
    const listener = vi.fn();
    const unsub = subscribeToPillActions(listener);

    setPillActions({ toggleRecording: vi.fn() });
    expect(listener).toHaveBeenCalledTimes(1);

    unsub();
    setPillActions({ toggleRecording: null });
    expect(listener).toHaveBeenCalledTimes(1);
  });
});