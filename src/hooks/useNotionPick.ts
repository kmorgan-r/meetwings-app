import { useCallback, useRef, useState, type RefObject } from "react";
import { STORAGE_KEYS } from "@/config/constants";
import { safeLocalStorage } from "@/lib/storage/helper";

/**
 * Who set the Notion tick: "auto" when the calendar flow ticked it, "hand"
 * when the user (or anything user-classed) did.
 */
export type NotionPickSource = "auto" | "hand";

export interface UseNotionPickReturn {
  picked: boolean;
  /** Always current, even within the same tick as a toggle. */
  pickedRef: RefObject<boolean>;
  /** Always current, even within the same tick as any mutator. */
  sourceRef: RefObject<NotionPickSource>;
  /**
   * Hand touches since mount: toggle/clear bump it, autoTick/autoUntick never
   * do. Never persisted; starts at 0 on every mount.
   */
  handTouchesRef: RefObject<number>;
  toggle: () => void;
  clear: () => void;
  /**
   * Tick from the calendar: a no-op once Notion is ticked, or after any hand
   * touch since the caller captured `touchesAtStart`.
   */
  autoTick: (touchesAtStart: number) => void;
  /** Unticks only a meetwings-set tick; a hand tick survives it. */
  autoUntick: () => void;
}

/**
 * Whether the user picked Notion for the current meeting, and whether that
 * tick is theirs or Meetwings'. Persisted so a remount mid-meeting keeps
 * both; cleared wherever the Odoo targets are.
 *
 * The refs are written BEFORE setState so a meeting-ended trigger firing in
 * the same tick as a toggle snapshots the new value and source. Only
 * toggle/clear bump handTouchesRef, which is how a late autoTick knows the
 * user touched the box since its check began.
 */
export function useNotionPick(): UseNotionPickReturn {
  const [picked, setPicked] = useState(
    () => safeLocalStorage.getItem(STORAGE_KEYS.NOTION_PICKED) === "true"
  );
  const pickedRef = useRef(picked);
  // Lazy, read once on mount: nothing renders from the source, so no state.
  const [initialSource] = useState<NotionPickSource>(() =>
    safeLocalStorage.getItem(STORAGE_KEYS.NOTION_PICK_SOURCE) === "auto"
      ? "auto"
      : "hand"
  );
  const sourceRef = useRef<NotionPickSource>(initialSource);
  const handTouchesRef = useRef(0);

  const set = useCallback((next: boolean, nextSource: NotionPickSource) => {
    pickedRef.current = next;
    sourceRef.current = nextSource;
    setPicked(next);
    safeLocalStorage.setItem(STORAGE_KEYS.NOTION_PICK_SOURCE, nextSource);
    safeLocalStorage.setItem(STORAGE_KEYS.NOTION_PICKED, String(next));
  }, []);

  const toggle = useCallback(() => {
    handTouchesRef.current += 1;
    set(!pickedRef.current, "hand");
  }, [set]);
  const clear = useCallback(() => {
    handTouchesRef.current += 1;
    set(false, "hand");
  }, [set]);

  const autoTick = useCallback(
    (touchesAtStart: number) => {
      if (pickedRef.current || handTouchesRef.current !== touchesAtStart) return;
      set(true, "auto");
    },
    [set]
  );

  const autoUntick = useCallback(() => {
    if (!pickedRef.current || sourceRef.current !== "auto") return;
    set(false, "auto");
  }, [set]);

  return {
    picked,
    pickedRef,
    sourceRef,
    handTouchesRef,
    toggle,
    clear,
    autoTick,
    autoUntick,
  };
}
