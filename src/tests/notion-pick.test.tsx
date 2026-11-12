import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// setup.ts swaps the global localStorage for an inert stub, so the hook is
// observed through a Map-backed safeLocalStorage.
const ls = vi.hoisted(() => {
  const map = new Map<string, string>();
  return {
    map,
    safeLocalStorage: {
      getItem: vi.fn((key: string): string | null => map.get(key) ?? null),
      setItem: vi.fn((key: string, value: string): void => void map.set(key, value)),
      removeItem: (key: string): void => void map.delete(key),
    },
  };
});
vi.mock("@/lib/storage/helper", () => ({ safeLocalStorage: ls.safeLocalStorage }));

import { useNotionPick } from "@/hooks/useNotionPick";

beforeEach(() => {
  ls.map.clear();
  vi.clearAllMocks();
});

describe("useNotionPick", () => {
  it("starts false and updates the ref before the re-render", () => {
    const { result } = renderHook(() => useNotionPick());
    expect(result.current.pickedRef.current).toBe(false);

    let seenInTick: boolean | undefined;
    act(() => {
      result.current.toggle();
      // Same tick, before React re-renders: a trigger firing now must see it.
      seenInTick = result.current.pickedRef.current;
    });

    expect(seenInTick).toBe(true);
    expect(result.current.picked).toBe(true);
  });

  it("persists true/false and reads the stored value once, on mount", () => {
    const { result, unmount } = renderHook(() => useNotionPick());
    act(() => result.current.toggle());
    expect(ls.map.get("notion_picked")).toBe("true");
    act(() => result.current.toggle());
    expect(ls.map.get("notion_picked")).toBe("false");
    act(() => result.current.toggle());
    unmount();

    ls.safeLocalStorage.getItem.mockClear();
    const remounted = renderHook(() => useNotionPick());
    expect(remounted.result.current.picked).toBe(true);
    expect(remounted.result.current.pickedRef.current).toBe(true);
    remounted.rerender();
    expect(ls.safeLocalStorage.getItem).toHaveBeenCalledTimes(2);
    expect(ls.safeLocalStorage.getItem).toHaveBeenCalledWith("notion_picked");
    expect(ls.safeLocalStorage.getItem).toHaveBeenCalledWith("notion_pick_source");
  });

  it("clear sets false, in the ref at once and in storage", () => {
    ls.map.set("notion_picked", "true");
    const { result } = renderHook(() => useNotionPick());
    expect(result.current.picked).toBe(true);

    let seenInTick: boolean | undefined;
    act(() => {
      result.current.clear();
      seenInTick = result.current.pickedRef.current;
    });

    expect(seenInTick).toBe(false);
    expect(result.current.picked).toBe(false);
    expect(ls.map.get("notion_picked")).toBe("false");
  });

  it("writes the source key before NOTION_PICKED", () => {
    const { result } = renderHook(() => useNotionPick());
    ls.safeLocalStorage.setItem.mockClear();

    act(() => result.current.autoTick(0));

    const calls = ls.safeLocalStorage.setItem.mock.calls;
    expect(calls[0]).toEqual(["notion_pick_source", "auto"]);
    expect(calls[1]).toEqual(["notion_picked", "true"]);
  });

  it("unticking writes NOTION_PICKED before the source key", () => {
    const toggled = renderHook(() => useNotionPick());
    act(() => toggled.result.current.toggle());
    ls.safeLocalStorage.setItem.mockClear();
    act(() => toggled.result.current.toggle());
    expect(ls.safeLocalStorage.setItem.mock.calls).toEqual([
      ["notion_picked", "false"],
      ["notion_pick_source", "hand"],
    ]);

    ls.map.set("notion_picked", "true");
    ls.map.set("notion_pick_source", "auto");
    const cleared = renderHook(() => useNotionPick());
    ls.safeLocalStorage.setItem.mockClear();
    act(() => cleared.result.current.clear());
    expect(ls.safeLocalStorage.setItem.mock.calls).toEqual([
      ["notion_picked", "false"],
      ["notion_pick_source", "hand"],
    ]);

    ls.map.clear();
    const auto = renderHook(() => useNotionPick());
    act(() => auto.result.current.autoTick(0));
    ls.safeLocalStorage.setItem.mockClear();
    act(() => auto.result.current.autoUntick());
    expect(ls.safeLocalStorage.setItem.mock.calls).toEqual([
      ["notion_picked", "false"],
      ["notion_pick_source", "auto"],
    ]);
  });

  it("a stored tick with no source key reads as hand", () => {
    ls.map.set("notion_picked", "true");
    const { result } = renderHook(() => useNotionPick());
    expect(result.current.picked).toBe(true);
    expect(result.current.sourceRef.current).toBe("hand");
  });

  it("any toggle sets hand", () => {
    const { result } = renderHook(() => useNotionPick());

    act(() => result.current.toggle());

    expect(result.current.picked).toBe(true);
    expect(result.current.sourceRef.current).toBe("hand");
    expect(result.current.handTouchesRef.current).toBe(1);
    expect(ls.map.get("notion_pick_source")).toBe("hand");
  });

  it("autoTick does nothing when Notion is already ticked", () => {
    ls.map.set("notion_picked", "true");
    const { result } = renderHook(() => useNotionPick());
    const t = result.current.handTouchesRef.current;

    act(() => result.current.autoTick(t));

    expect(result.current.picked).toBe(true);
    expect(result.current.sourceRef.current).toBe("hand");
    expect(ls.map.has("notion_pick_source")).toBe(false);
  });

  it("autoTick does nothing after a toggle or clear since the check began", () => {
    const { result } = renderHook(() => useNotionPick());
    const t = result.current.handTouchesRef.current;

    act(() => result.current.toggle());
    act(() => result.current.toggle());
    act(() => result.current.autoTick(t));
    expect(result.current.picked).toBe(false);
    expect(result.current.sourceRef.current).toBe("hand");

    // Captured again: a clear on its own must also block the late tick.
    const t2 = result.current.handTouchesRef.current;
    act(() => result.current.clear());
    act(() => result.current.autoTick(t2));
    expect(result.current.picked).toBe(false);
    expect(result.current.sourceRef.current).toBe("hand");
  });

  it("a stored auto source reads back as auto", () => {
    ls.map.set("notion_picked", "true");
    ls.map.set("notion_pick_source", "auto");
    const { result } = renderHook(() => useNotionPick());

    expect(result.current.sourceRef.current).toBe("auto");
    act(() => result.current.autoUntick());
    expect(result.current.picked).toBe(false);
  });

  it("autoUntick clears an auto tick and leaves a hand tick", () => {
    const { result } = renderHook(() => useNotionPick());

    act(() => result.current.autoTick(0));
    expect(result.current.picked).toBe(true);
    act(() => result.current.autoUntick());
    expect(result.current.picked).toBe(false);
    expect(result.current.sourceRef.current).toBe("auto");
    expect(result.current.handTouchesRef.current).toBe(0);

    // A hand tick survives autoUntick.
    act(() => result.current.toggle());
    expect(result.current.picked).toBe(true);
    act(() => result.current.autoUntick());
    expect(result.current.picked).toBe(true);
    expect(result.current.sourceRef.current).toBe("hand");
  });

  it("pickedRef and sourceRef update in the same tick as the call", () => {
    const { result } = renderHook(() => useNotionPick());
    let seenPicked: boolean | undefined;
    let seenSource: "auto" | "hand" | undefined;

    act(() => {
      result.current.autoTick(0);
      seenPicked = result.current.pickedRef.current;
      seenSource = result.current.sourceRef.current;
    });

    expect(seenPicked).toBe(true);
    expect(seenSource).toBe("auto");
  });
});
