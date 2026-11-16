import { MEETING_CONVERSATION_GAP_MS } from "@/config/constants";

/**
 * Input for the silent-updater install gate: everything that decides whether
 * installing right now would interrupt the user.
 */
export interface GateInput {
  capturing: boolean;
  meetingActive: boolean;
  lastCaptureEndedAt: number | null;
  /** App work a restart would cut off (a first team join); no tail after. */
  appBusy: boolean;
  now: number;
}

/**
 * Whether the silent auto-updater may install right now. Defers while any
 * capture runs, a meeting is detected or the app is busy, and for
 * MEETING_CONVERSATION_GAP_MS after the last capture or meeting ended (the
 * busy flag has no tail), so a follow-up capture inside a
 * conversation (or a meeting re-detected after a flap) is not interrupted by
 * a restart.
 */
export function canInstallNow(input: GateInput): boolean {
  if (input.capturing || input.meetingActive || input.appBusy) return false;
  if (input.lastCaptureEndedAt === null) return true;
  return input.now - input.lastCaptureEndedAt >= MEETING_CONVERSATION_GAP_MS;
}
