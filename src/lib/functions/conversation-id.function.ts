import type { MutableRefObject } from "react";
import { generateConversationId } from "@/lib/chat-constants";

/**
 * The one place a chat conversation id is minted.
 *
 * Module scope, not a function in a component body: three call sites live in
 * `useCallback(…, [])` callbacks whose empty dep arrays are load-bearing
 * (useCompletion.ts:593, "No dependencies - uses ref for conversation ID"). A
 * body function would trip react-hooks/exhaustive-deps, and adding it to the
 * deps would change the identity of addMeetingTranscriptEntry /
 * addMeetingTranscriptEntries / addSystemAudioTranscript on every render,
 * re-running every consumer that lists them — Audio.tsx:117 lists
 * addSystemAudioTranscript exactly so.
 *
 * Read and write happen in one synchronous step, before any await, so two
 * paths racing inside one tick cannot each mint an id.
 *
 * NOT for useSystemAudio: startCapture and startNewConversation mint
 * unconditionally on purpose, and that hook has no such ref.
 */
export function ensureConversationId(
  ref: MutableRefObject<string | null>
): string {
  ref.current ??= generateConversationId("chat");
  return ref.current;
}
