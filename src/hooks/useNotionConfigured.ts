import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { loadOdooConfigState } from "@/lib/storage/odoo-config.storage";
import {
  isNotionConfigured,
  NOTION_CONFIG_CHANGED_EVENT,
} from "@/lib/storage/notion-config.storage";
import { notionErrorText } from "@/lib/notion/errors";

/**
 * Re-reads `read` on mount, on window focus and on a Tauri event (the settings
 * card lives in the dashboard window, so a `window` event would never reach the
 * overlay). A throw KEEPS the previous value: null on the first read, the last
 * good one afterwards. Never an unhandled rejection.
 */
function useReread<T>(read: () => Promise<T>, eventName: string): T | null {
  const [value, setValue] = useState<T | null>(null);

  useEffect(() => {
    let cancelled = false;
    const reread = () => {
      void read().then(
        (next) => {
          if (!cancelled) setValue(next);
        },
        (thrown) => {
          // Logs the code only; the previous value stays.
          notionErrorText(thrown);
        },
      );
    };
    reread();
    window.addEventListener("focus", reread);
    let un: (() => void) | undefined;
    void listen(eventName, reread).then((fn) => {
      if (cancelled) fn();
      else un = fn;
    });
    return () => {
      cancelled = true;
      window.removeEventListener("focus", reread);
      un?.();
    };
  }, [read, eventName]);

  return value;
}

const readNotion = (): Promise<boolean> => isNotionConfigured();
const readOdoo = async () => (await loadOdooConfigState()).state;

/** `null` while loading (or while every read has failed). */
export function useNotionConfigured(): boolean | null {
  return useReread(readNotion, NOTION_CONFIG_CHANGED_EVENT);
}

/** The overlay has no other Odoo-setup reader; same pattern as above. */
export function useOdooSetupState(): "absent" | "incomplete" | "complete" | null {
  return useReread(readOdoo, "odoo-instance-changed");
}
