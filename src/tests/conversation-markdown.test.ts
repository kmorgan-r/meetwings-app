import { describe, expect, it } from "vitest";
import { conversationToMarkdown } from "@/lib/functions/conversation-markdown.function";
import type { ChatConversation } from "@/types/completion";

const conversation = (messages: ChatConversation["messages"]): ChatConversation => ({
  id: "conversation-1",
  title: "LCA Scoping",
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_100_000,
  messages,
});

describe("conversationToMarkdown", () => {
  it("names each speaker instead of labelling every line USER", () => {
    const md = conversationToMarkdown(
      conversation([
        { id: "m1", role: "user", content: "Scope of the LCA", timestamp: 1, audioSource: "microphone" },
        { id: "m2", role: "user", content: "And Scope 3?", timestamp: 2, audioSource: "system" },
        { id: "m3", role: "user", content: "Only upstream", timestamp: 3, audioSource: "system", speaker: { speakerId: "diarization_A", speakerLabel: "Sarah Chen" } },
        { id: "m4", role: "assistant", content: "Here is what you could say", timestamp: 4 },
        { id: "m5", role: "user", content: "typed question", timestamp: 5 },
      ])
    );

    expect(md).toContain("You: Scope of the LCA");
    expect(md).toContain("Guest: And Scope 3?");
    expect(md).toContain("Sarah Chen: Only upstream");
    expect(md).toContain("Assistant: Here is what you could say");
    expect(md).toContain("You: typed question");
    expect(md).not.toContain("USER:");
  });

  it("leaves no line unlabelled", () => {
    const md = conversationToMarkdown(
      conversation([
        { id: "m1", role: "user", content: "a", timestamp: 1 },
        { id: "m2", role: "assistant", content: "b", timestamp: 2 },
      ])
    );
    for (const line of md.split("\n").filter((l) => l.startsWith("## "))) {
      expect(line).toMatch(/^## [^:]+: /);
    }
  });

  it("labels a legacy pre-migration-8 row You, the documented limitation", () => {
    // speaker and audio_source are both null on rows written before migration 8,
    // so such a line is indistinguishable from typed chat. Accepted, not solved:
    // the data to do better does not exist. Asserted so the behaviour is a
    // decision on the record rather than a surprise.
    const md = conversationToMarkdown(
      conversation([{ id: "m1", role: "user", content: "legacy line", timestamp: 1 }])
    );
    expect(md).toContain("You: legacy line");
  });

  it("keeps the existing header", () => {
    const md = conversationToMarkdown(conversation([]));
    expect(md).toContain("# LCA Scoping");
    expect(md).toContain("**Messages:** 0");
  });
});
