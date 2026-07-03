/**
 * Chat and Conversation Constants
 *
 * Centralized constants for chat functionality to replace magic numbers
 * and improve code maintainability.
 */

/**
 * MESSAGE_ID_OFFSET
 *
 * When creating user and assistant message pairs at nearly the same time,
 * we add this offset to ensure unique IDs even if timestamps are identical.
 *
 * Usage: assistantMsg.id = `msg_${timestamp + MESSAGE_ID_OFFSET}_assistant`
 */
export const MESSAGE_ID_OFFSET = 1;

/**
 * CONVERSATION_SAVE_DEBOUNCE_MS
 *
 * Debounce delay for auto-saving conversations to prevent race conditions
 * and reduce unnecessary database writes. Saves only after this many
 * milliseconds of inactivity.
 *
 * 500ms provides a good balance between:
 * - Responsiveness (changes are saved quickly)
 * - Performance (not saving on every keystroke)
 */
export const CONVERSATION_SAVE_DEBOUNCE_MS = 500;

/**
 * CHUNK_POLL_INTERVAL_MS
 *
 * How frequently to check for new streaming chunks from Meetwings API.
 *
 * 50ms provides smooth streaming without excessive CPU usage.
 * Lower = more responsive but higher CPU usage
 * Higher = lower CPU but choppier streaming
 */
export const CHUNK_POLL_INTERVAL_MS = 50;

/**
 * DOWNLOAD_SUCCESS_DISPLAY_MS
 *
 * How long to show the "Downloaded successfully" checkmark/indicator
 * before hiding it.
 *
 * 1000ms (1 seconds) gives users enough time to see the feedback
 * without it feeling too slow.
 */
export const DOWNLOAD_SUCCESS_DISPLAY_MS = 1000;

/**
 * CONVERSATION_ID_RANDOM_LENGTH
 *
 * Length of the random suffix in conversation IDs.
 *
 * 9 characters provides good uniqueness (36^9 = ~1 trillion combinations)
 * while keeping IDs reasonably short.
 */
export const CONVERSATION_ID_RANDOM_LENGTH = 9;

/**
 * Centralized ID Generation Functions
 *
 * These ensure consistent ID formats across the application
 */

/**
 * Generate a unique conversation ID
 *
 * @param source - The source of the conversation ('chat' or 'sysaudio')
 * @returns A unique conversation ID in the format: {prefix}_{timestamp}_{random}
 *
 * Examples:
 * - conv_1696291234567_k3j9m2n4p
 * - sysaudio_conv_1696291234567_x7z2w5q8r
 */
export function generateConversationId(
  source: "chat" | "sysaudio" = "chat"
): string {
  const timestamp = Date.now();
  const random = Math.random()
    .toString(36)
    .substring(2, 2 + CONVERSATION_ID_RANDOM_LENGTH);
  const prefix = source === "sysaudio" ? "sysaudio_conv" : "conv";
  return `${prefix}_${timestamp}_${random}`;
}

/**
 * Monotonic per-session counter. Guarantees IDs generated within a single app
 * session never collide, even when many messages are created in the same
 * millisecond (a same-ms + same-random + same-role collision would otherwise be
 * possible and cause silent message loss on save).
 */
let messageIdSequence = 0;

/**
 * Generate a unique message ID
 *
 * @param role - The role of the message ('user', 'assistant', or 'system')
 * @param timestamp - Optional timestamp (defaults to Date.now())
 * @returns A unique message ID in the format: msg_{timestamp}_{suffix}_{role}
 *
 * Examples:
 * - msg_1696291234567_0k3j9_user
 * - msg_1696291234568_1m2n4_assistant
 *
 * The suffix combines a monotonic session counter (collision-proof within a
 * session) with a random segment (guards cross-session collisions), so no two
 * messages can share an ID regardless of creation timing.
 */
export function generateMessageId(
  role: "user" | "assistant" | "system",
  timestamp: number = Date.now()
): string {
  // Wrap the counter well below Number.MAX_SAFE_INTEGER; base36-encoded it stays
  // short. Uniqueness within a session comes from this counter; the random tail
  // guards against two separate sessions minting the same timestamp+counter.
  messageIdSequence = (messageIdSequence + 1) % 0xffffffff;
  const counter = messageIdSequence.toString(36);
  // Pad before slicing: for small fractions toString(36) can yield fewer than 4
  // post-"0." chars (e.g. 0.5 -> "0.i").
  const random = (Math.random().toString(36).substring(2) + "0000").substring(0, 4);
  return `msg_${timestamp}_${counter}${random}_${role}`;
}

/**
 * Generate a unique request ID for tracking API requests
 *
 * @returns A unique request ID in the format: req_{timestamp}_{random}
 *
 * Example: req_1696291234567_k3j9m2n4p
 */
export function generateRequestId(): string {
  const timestamp = Date.now();
  const random = Math.random()
    .toString(36)
    .substring(2, 2 + CONVERSATION_ID_RANDOM_LENGTH);
  return `req_${timestamp}_${random}`;
}

/**
 * Validate a conversation ID format
 *
 * @param id - The ID to validate
 * @returns true if the ID matches the expected format
 */
export function isValidConversationId(id: string): boolean {
  return /^(conv|sysaudio_conv)_\d+_[a-z0-9]{9}$/.test(id);
}

/**
 * Validate a message ID format
 *
 * @param id - The ID to validate
 * @returns true if the ID matches the expected format
 *
 * Supports both old format (msg_{timestamp}_{role}) and
 * new format (msg_{timestamp}_{suffix}_{role}), where suffix is one or more
 * base36 chars (counter + random).
 */
export function isValidMessageId(id: string): boolean {
  return /^msg_\d+_([a-z0-9]+_)?(user|assistant|system)$/.test(id);
}
