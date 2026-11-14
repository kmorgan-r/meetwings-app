import { useEffect, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  getMeetingCard,
  subscribeToMeetingCard,
  type MeetingCardState,
} from "@/lib/meeting-cards.store";
import type { OverlayPillStyle } from "@/lib/storage";

/**
 * Reads the card slot and reveals a hidden bar for an amber warning.
 *
 * Plain useSyncExternalStore on purpose: the store's notify() runs between
 * useMeetingAutoRecord's mode write and its enableVAD flip, which is safe only
 * because React schedules this re-render rather than committing inline. No
 * flushSync or synchronous setState in a listener here.
 *
 * Task 10 adds the window resize subscription (hence pillStyle).
 */
export function useMeetingCardHost(_pillStyle: OverlayPillStyle): MeetingCardState {
  const card = useSyncExternalStore(subscribeToMeetingCard, getMeetingCard);
  // A new amber episode re-reveals; an error update on the same episode does not.
  const amberEpisode = card?.kind === "amber" ? card.episode : null;

  useEffect(() => {
    // Red and ended cards never force the window open.
    if (amberEpisode === null) return;
    invoke("reveal_overlay").catch((error) => {
      console.error("Failed to reveal the overlay:", error);
    });
  }, [amberEpisode]);

  return card;
}
