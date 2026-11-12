import { useCallback, useRef, useState, type RefObject } from "react";
import { STORAGE_KEYS } from "@/config/constants";
import { safeLocalStorage } from "@/lib/storage/helper";

export interface UseNotionPickReturn {
  picked: boolean;
  /** Always current, even within the same tick as a toggle. */
  pickedRef: RefObject<boolean>;
  toggle: () => void;
  clear: () => void;
}

/**
 * Whether the user picked Notion for the current meeting. Persisted so a
 * remount mid-meeting keeps it; cleared wherever the Odoo targets are.
 *
 * The ref is written BEFORE setState so a meeting-ended trigger firing in the
 * same tick as a toggle snapshots the new value.
 */
export function useNotionPick(): UseNotionPickReturn {
  const [picked, setPicked] = useState(
    () => safeLocalStorage.getItem(STORAGE_KEYS.NOTION_PICKED) === "true"
  );
  const pickedRef = useRef(picked);

  const set = useCallback((next: boolean) => {
    pickedRef.current = next;
    safeLocalStorage.setItem(STORAGE_KEYS.NOTION_PICKED, String(next));
    setPicked(next);
  }, []);

  const toggle = useCallback(() => set(!pickedRef.current), [set]);
  const clear = useCallback(() => set(false), [set]);

  return { picked, pickedRef, toggle, clear };
}
