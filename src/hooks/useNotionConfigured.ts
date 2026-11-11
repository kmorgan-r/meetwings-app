import { useEffect, useRef, useState } from "react";
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
function useReread<T>(
  read: () => Promise<T>,
  eventName: string,
  onError: (thrown: unknown) => void,
): T | null {
  const [value, setValue] = useState<T | null>(null);
  // Only the latest read may set state: a slow earlier read must not overwrite.
  const latest = useRef(0);

  useEffect(() => {
    let cancelled = false;
    const reread = () => {
      const id = ++latest.current;
      void read().then(
        (next) => {
          if (!cancelled && id === latest.current) setValue(next);
        },
        (thrown) => {
          // The previous value stays.
          onError(thrown);
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
  }, [read, eventName, onError]);

  return value;
}

const readNotion = (): Promise<boolean> => isNotionConfigured();
// Module-scope so the effect's deps stay stable. Name only: never the message.
const logNotion = (thrown: unknown): void => {
  notionErrorText(thrown);
};
const logOdoo = (thrown: unknown): void => {
  console.error("[odoo] setup unreadable:", thrown instanceof Error ? thrown.name : typeof thrown);
};
const readOdoo = async () => (await loadOdooConfigState()).state;

/** `null` while loading (or while every read has failed). */
export function useNotionConfigured(): boolean | null {
  return useReread(readNotion, NOTION_CONFIG_CHANGED_EVENT, logNotion);
}

/** The overlay has no other Odoo-setup reader; same pattern as above. */
export function useOdooSetupState(): "absent" | "incomplete" | "complete" | null {
  return useReread(readOdoo, "odoo-instance-changed", logOdoo);
}
