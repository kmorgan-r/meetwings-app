import { useEffect, useMemo, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  answerOfferFromSettings,
  maybeShowAutoRecordOffer,
} from "@/lib/auto-record-offer";

/**
 * Asks once per launch, in the main window, whether to turn auto-record on
 * (lib/auto-record-offer.ts decides who is asked). `ready` is "setup is
 * complete": the same gate <Completion /> renders behind, so the card never
 * covers the setup message.
 *
 * Also listens for the setting changing elsewhere (Settings) while the card is
 * up: that counts as the answer.
 */
export function useAutoRecordOffer(ready: boolean): void {
  const isMain = useMemo(() => getCurrentWindow().label === "main", []);
  const askedRef = useRef(false);

  useEffect(() => {
    if (!isMain || !ready || askedRef.current) return;
    askedRef.current = true;
    void maybeShowAutoRecordOffer();
  }, [isMain, ready]);

  useEffect(() => {
    if (!isMain) return;
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    listen("meeting-detection-setting-changed", () => answerOfferFromSettings())
      .then((un) => {
        if (cancelled) un();
        else unlisten = un;
      })
      .catch((error) => console.error("Failed to subscribe to the auto-record setting:", error));
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [isMain]);
}
