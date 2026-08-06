import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MessageHistory } from "@/pages/app/components/completion/MessageHistory";
import { ChatMessage } from "@/types/completion";

// The list only needs to render far enough to reach the sort; the real popover,
// scroll area and markdown pipeline are irrelevant to that and expensive here.
vi.mock("@/components", () => ({
  Popover: ({ children }: never) => <div>{children}</div>,
  PopoverTrigger: ({ children }: never) => <div>{children}</div>,
  PopoverContent: ({ children }: never) => <div>{children}</div>,
  Button: ({ children }: never) => <button>{children}</button>,
  ScrollArea: ({ children }: never) => <div>{children}</div>,
  Markdown: ({ children }: never) => <span>{children}</span>,
}));

vi.mock("@/pages/app/components/completion/QuickActions", () => ({
  QuickActions: () => null,
}));

vi.mock("@/contexts", () => ({
  useApp: () => ({ sttTranslationEnabled: false }),
}));

function message(n: number): ChatMessage {
  return {
    id: `msg-${n}`,
    role: "user",
    content: `segment ${n}`,
    timestamp: 1_000 + n,
  } as ChatMessage;
}

describe("conversation message list", () => {
  it("does not reorder the array it is handed", () => {
    // useCompletion aliases conversationHistoryRef straight to this state array
    // (useCompletion.ts:153), and the meeting autosave decides what to write
    // from it. Array.prototype.sort reorders in place, so sorting during render
    // rewrites live state and hands the autosave a different array than the one
    // the add path built.
    const conversationHistory = [1, 2, 3, 4].map(message);
    const orderBefore = conversationHistory.map((m) => m.id);

    render(
      <MessageHistory
        conversationHistory={conversationHistory}
        currentConversationId="conversation-1"
        onStartNewConversation={vi.fn()}
        messageHistoryOpen
        setMessageHistoryOpen={vi.fn()}
      />
    );

    expect(conversationHistory.map((m) => m.id)).toEqual(orderBefore);
  });
});
