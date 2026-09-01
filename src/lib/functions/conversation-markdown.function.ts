import type { ChatConversation, ChatMessage } from "@/types/completion";
import { speakerLabelFor } from "./speaker-label.function";

/**
 * The downloaded transcript.
 *
 * Extracted from a closure inside useHistory so the label behaviour can be
 * asserted directly instead of through a Blob/createObjectURL intercept.
 *
 * speakerLabelFor returns null for anything without an audioSource - assistant
 * replies and typed chat - so this adds the role fallback it deliberately
 * refuses to guess at. A legacy pre-migration-8 row has neither column and is
 * indistinguishable from typed chat; it renders "You:". That is a known
 * limitation, not an oversight: once addMeetingTranscriptEntries carries the
 * fields, no new rows join that class.
 */
function labelOf(message: ChatMessage): string {
  return (
    speakerLabelFor(message) ?? (message.role === "assistant" ? "Assistant" : "You")
  );
}

export function conversationToMarkdown(conversation: ChatConversation): string {
  let markdown = `# ${conversation.title}\n\n`;
  markdown += `**Created:** ${new Date(
    conversation.createdAt
  ).toLocaleString()}\n`;
  markdown += `**Updated:** ${new Date(
    conversation.updatedAt
  ).toLocaleString()}\n`;
  markdown += `**Messages:** ${conversation.messages.length}\n\n---\n\n`;

  conversation.messages.forEach((message, index) => {
    markdown += `## ${labelOf(message)}: ${message.content}\n`;

    if (index < conversation.messages.length - 1) {
      markdown += "\n";
    }
  });

  return markdown;
}
