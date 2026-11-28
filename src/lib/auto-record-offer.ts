// The one-time "turn on auto-record?" card shown at launch (spec
// 2026-11-28-auto-record-first-launch-prompt-design.md). Auto-record stays off
// by default; this asks once, and only people who never set the toggle.
import { invoke } from "@tauri-apps/api/core";
import { safeLocalStorage } from "@/lib";
import { STORAGE_KEYS } from "@/config/constants";
import { isMacOS } from "@/lib/platform";
import { currentWatchLists, isMeetingDetectionPlatform } from "@/lib/meeting-detect";
import { turnOnAutoRecord } from "@/lib/auto-record-setting";
import { detectionLog } from "@/lib/detection-log";
import {
  dismissOffer,
  getMeetingCard,
  setOfferState,
  showOffer,
} from "@/lib/meeting-cards.store";

export const OFFER_TITLE = "Record your calls automatically?";
export const OFFER_BODY: Record<"macos" | "windows", string> = {
  macos:
    "Meetwings can start recording when you join a Google Meet call in Chrome, and stop when you leave.",
  windows:
    "Meetwings can start recording when you join a Teams or Google Meet call, and stop when you leave.",
};
export const OFFER_FOOTNOTE = "Let people know when you record.";
export const OFFER_FAILED_MESSAGE = "Couldn't turn on auto-record. Try again in Settings.";

type OfferAnswer = "on" | "later" | "settings";

const recordAnswer = (answer: OfferAnswer) => {
  safeLocalStorage.setItem(STORAGE_KEYS.MEETING_AUTO_RECORD_OFFER, answer);
  detectionLog(`offer answer=${answer}`);
};

const idleOfferUp = () => {
  const c = getMeetingCard();
  return c?.kind === "offer" && !c.busy;
};

/**
 * Whether to ask: a detection platform, the toggle never set (a failed start
 * writes "false", so those users are not asked either), not asked before, and
 * on a Mac a supported macOS (the probe never prompts).
 */
export async function shouldOfferAutoRecord(): Promise<boolean> {
  if (!isMeetingDetectionPlatform()) return false;
  if (safeLocalStorage.getItem(STORAGE_KEYS.MEETING_AUTO_RECORD_ENABLED) !== null) return false;
  if (safeLocalStorage.getItem(STORAGE_KEYS.MEETING_AUTO_RECORD_OFFER) !== null) return false;
  if (isMacOS()) {
    try {
      await invoke("list_capture_sessions", { ...(await currentWatchLists()) });
    } catch {
      return false;
    }
  }
  return true;
}

export async function maybeShowAutoRecordOffer(): Promise<void> {
  if (!(await shouldOfferAutoRecord())) return;
  if (showOffer()) detectionLog("offer shown");
}

/** "Turn on". One flow at a time: a click while busy does nothing. */
export async function acceptAutoRecordOffer(): Promise<void> {
  if (!idleOfferUp()) return;
  setOfferState({ busy: true, error: null });
  try {
    const failure = await turnOnAutoRecord();
    if (failure) {
      // Not recorded: they said yes, so ask again next launch if left unanswered.
      setOfferState({ busy: false, error: failure.message });
      detectionLog(`offer answer=failed:${failure.kind}`);
      return;
    }
    recordAnswer("on");
    dismissOffer();
  } catch (error) {
    console.error("Auto-record offer: turning on failed:", error);
    setOfferState({ busy: false, error: OFFER_FAILED_MESSAGE });
    detectionLog("offer answer=failed:start-error");
  }
}

/** "Not now": never asked again. Settings stays the place to change it. */
export function declineAutoRecordOffer(): void {
  recordAnswer("later");
  dismissOffer();
}

/**
 * The setting changed elsewhere (Settings) while the card is up: the user has
 * chosen. Ignored while our own turn-on runs, so its own setting-changed event
 * never overwrites "on".
 */
export function answerOfferFromSettings(): void {
  if (!idleOfferUp()) return;
  recordAnswer("settings");
  dismissOffer();
}
