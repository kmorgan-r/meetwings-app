import { MEETING_CONVERSATION_GAP_MS } from "@/config/constants";

/**
 * Input for the silent-updater install gate: everything that decides whether
 * installing right now would interrupt the user.
 */
export interface GateInput {
  capturing: boolean;
  meetingActive: boolean;
  lastCaptureEndedAt: number | null;
  now: number;
}

/**
 * Whether the silent auto-updater may install right now. Defers while any
 * capture runs or a meeting is detected, and for MEETING_CONVERSATION_GAP_MS
 * after the last capture ended, so a follow-up capture inside a conversation
 * is not interrupted by a restart.
 */
export function canInstallNow(input: GateInput): boolean {
  if (input.capturing || input.meetingActive) return false;
  if (input.lastCaptureEndedAt === null) return true;
  return input.now - input.lastCaptureEndedAt >= MEETING_CONVERSATION_GAP_MS;
}
