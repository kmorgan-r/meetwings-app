import { useEffect, useRef, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { isAnyPopoverOpen, resizeWindow } from "@/hooks/useWindow";
import {
  cardHeight,
  getMeetingCard,
  pillWindowSize,
  subscribeToMeetingCard,
  type MeetingCardState,
} from "@/lib/meeting-cards.store";
import { getMinimized } from "@/lib/overlay-minimize.store";
import type { OverlayPillStyle } from "@/lib/storage";

/**
 * Reads the card slot and reveals a hidden bar for an amber warning.
 *
 * Plain useSyncExternalStore on purpose: the store's notify() runs between
 * useMeetingAutoRecord's mode write and its enableVAD flip, which is safe only
 * because React schedules this re-render rather than committing inline. No
 * flushSync or synchronous setState in a listener here.
 *
 * The window follows the card: expanded goes through resizeWindow (card-aware),
 * minimized restyles the pill. A card never calls setMinimized.
 */
export function useMeetingCardHost(pillStyle: OverlayPillStyle): MeetingCardState {
  const card = useSyncExternalStore(subscribeToMeetingCard, getMeetingCard);
  // A new amber episode re-reveals; an error update on the same episode does not.
  // The auto-record offer reveals once when it appears (its busy/error updates
  // keep the same key).
  const revealKey =
    card?.kind === "amber" ? `amber:${card.episode}` : card?.kind === "offer" ? "offer" : null;

  useEffect(() => {
    // Red and ended cards never force the window open.
    if (revealKey === null) return;
    invoke("reveal_overlay").catch((error) => {
      console.error("Failed to reveal the overlay:", error);
    });
  }, [revealKey]);

  // Style through a ref so a style change never re-subscribes (the app page's
  // restyle listener owns that path).
  const styleRef = useRef(pillStyle);
  useEffect(() => {
    styleRef.current = pillStyle;
  }, [pillStyle]);

  // Every notify that changes a height re-sizes the window, not just a kind
  // change: setAmberError grows an amber card in place.
  useEffect(() => {
    let last = "0:0";
    const sync = () => {
      const c = getMeetingCard();
      const key = `${cardHeight(c, false)}:${cardHeight(c, true)}`;
      if (key === last) return;
      last = key;
      if (getMinimized()) {
        invoke("minimize_overlay", { ...pillWindowSize(styleRef.current, c), restyle: true }).catch(
          (error) => console.error("Failed to resize the minimized pill:", error)
        );
      } else {
        resizeWindow(isAnyPopoverOpen());
      }
    };
    sync();
    return subscribeToMeetingCard(sync);
  }, []);

  return card;
}
