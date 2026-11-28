import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

const h = vi.hoisted(() => ({
  label: { current: "main" },
  listeners: new Map<string, Set<(e: { payload: unknown }) => void>>(),
  maybeShow: vi.fn(async () => {}),
  answerFromSettings: vi.fn(() => {}),
}));

const listen = vi.fn(async (event: string, cb: (e: { payload: unknown }) => void) => {
  if (!h.listeners.has(event)) h.listeners.set(event, new Set());
  h.listeners.get(event)!.add(cb);
  return () => {
    h.listeners.get(event)?.delete(cb);
  };
});

vi.mock("@tauri-apps/api/event", () => ({
  listen: (...a: Parameters<typeof listen>) => listen(...a),
  emit: vi.fn(async () => {}),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ label: h.label.current }),
}));
vi.mock("@/lib/auto-record-offer", () => ({
  maybeShowAutoRecordOffer: h.maybeShow,
  answerOfferFromSettings: h.answerFromSettings,
}));

import { useAutoRecordOffer } from "@/hooks/useAutoRecordOffer";

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

const fire = (event: string, payload?: unknown) =>
  act(() => {
    h.listeners.get(event)?.forEach((cb) => cb({ payload }));
  });

beforeEach(() => {
  h.label.current = "main";
  h.listeners.clear();
  h.maybeShow.mockClear();
  h.answerFromSettings.mockClear();
  listen.mockClear();
});

describe("useAutoRecordOffer", () => {
  it("does nothing until ready", () => {
    renderHook(() => useAutoRecordOffer(false));
    expect(h.maybeShow).not.toHaveBeenCalled();
  });

  it("asks once per launch, even across re-renders and ready flips", () => {
    const { rerender } = renderHook(({ r }) => useAutoRecordOffer(r), {
      initialProps: { r: false },
    });
    rerender({ r: true });
    rerender({ r: true });
    rerender({ r: false });
    rerender({ r: true });
    expect(h.maybeShow).toHaveBeenCalledTimes(1);
  });

  it("is inert outside the main window", async () => {
    h.label.current = "dashboard";
    renderHook(() => useAutoRecordOffer(true));
    await flush();
    expect(h.maybeShow).not.toHaveBeenCalled();
    expect(listen).not.toHaveBeenCalled();
  });

  it("routes a setting change to answerOfferFromSettings", async () => {
    renderHook(() => useAutoRecordOffer(true));
    await flush();
    fire("meeting-detection-setting-changed", { enabled: true });
    expect(h.answerFromSettings).toHaveBeenCalledTimes(1);
  });

  it("stops listening on unmount", async () => {
    const { unmount } = renderHook(() => useAutoRecordOffer(true));
    await flush();
    unmount();
    fire("meeting-detection-setting-changed", { enabled: false });
    expect(h.answerFromSettings).not.toHaveBeenCalled();
  });
});
