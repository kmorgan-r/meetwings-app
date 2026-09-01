import type { TranscriptEntry } from "@/types/completion";

/**
 * The one speaker-label resolver, shared by the Odoo note renderer, the meeting
 * context prompt, and the transcript download.
 *
 * Named `speakerLabelFor`, not `labelFor`: src/lib/index.ts star-exports
 * ./functions, ./database and ./odoo into one flat namespace, so a bare
 * `labelFor` is a collision waiting to happen.
 *
 * The three-way null is deliberate. A two-way form defaulting to "Guest"
 * attributes the user's own unattributed lines to the customer, in a note the
 * customer can read. Callers that must label every line supply their own
 * fallback from context.
 *
 * Typed on the structural subset so both a TranscriptEntry (.original) and a
 * ChatMessage (.content) satisfy it.
 */
export function speakerLabelFor(
  m: Pick<TranscriptEntry, "speaker" | "audioSource">
): string | null {
  return (
    m.speaker?.speakerLabel ||
    (m.audioSource === "microphone"
      ? "You"
      : m.audioSource === "system"
      ? "Guest"
      : null)
  );
}
