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
    expect(ls.safeLocalStorage.getItem).toHaveBeenCalledTimes(1);
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
});
