import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ChatConversation } from "@/types";
import { ConversationList } from "@/pages/meetings/components/ConversationList";

// ConversationList's page never sets `renamingId` yet - nothing in the app
// renders a rename UI (Task 14). But the branch that reads it ships today, and
// nothing in meetings-page.test.tsx or elsewhere can reach it with the page
// hardcoding `null`. This file exercises the component directly so the branch
// is not dead code with zero coverage.

const OLDER_DATE = 1_700_000_000_000;
const NEWER_DATE = OLDER_DATE + 86_400_000;

function conversation(over: Partial<ChatConversation> = {}): ChatConversation {
  return {
    id: "c1",
    title: "Quarterly review",
    messages: [],
    createdAt: OLDER_DATE,
    updatedAt: OLDER_DATE,
    ...over,
  };
}

describe("ConversationList", () => {
  it("filters out a date group with no title match when nothing is being renamed", () => {
    const matching = conversation({ id: "c1", title: "Quarterly review", updatedAt: NEWER_DATE });
    const nonMatching = conversation({ id: "c2", title: "Supplier onboarding", updatedAt: OLDER_DATE });

    render(
      <ConversationList
        conversations={[matching, nonMatching]}
        search="quarterly"
        badges={new Map()}
        onOpen={vi.fn()}
        onStartRename={vi.fn()}
        onCommitRename={vi.fn()}
        onCancelRename={vi.fn()}
        renamingId={null}
      />
    );

    expect(screen.getByText("Quarterly review")).toBeInTheDocument();
    expect(screen.queryByText("Supplier onboarding")).toBeNull();
  });

  it("keeps a date group alive for the row being renamed even with zero title matches", () => {
    const matching = conversation({ id: "c1", title: "Quarterly review", updatedAt: NEWER_DATE });
    // Its title does not match "zzz-no-match", and it is on its own date group,
    // so without the renamingId escape hatch the whole group - and this row's
    // open editor - would unmount.
    const beingRenamed = conversation({ id: "c2", title: "Supplier onboarding", updatedAt: OLDER_DATE });

    render(
      <ConversationList
        conversations={[matching, beingRenamed]}
        search="zzz-no-match"
        badges={new Map()}
        onOpen={vi.fn()}
        onStartRename={vi.fn()}
        onCommitRename={vi.fn()}
        onCancelRename={vi.fn()}
        renamingId="c2"
      />
    );

    expect(screen.queryByText("Quarterly review")).toBeNull();
    // c2's row survives - and ConversationRow renders it as the open editor
    // (an input, not the read-only title text) because `renamingId` matches
    // its id, so the title shows up as the input's value, not as text.
    expect(document.querySelector('[data-conversation-id="c2"]')).not.toBeNull();
    expect(screen.getByRole("textbox")).toHaveValue("Supplier onboarding");
  });

  it("drops that same group once renamingId is null again", () => {
    // Counter-case for the test above: proves the previous pass was the
    // renamingId branch, not the search term coincidentally matching.
    const beingRenamed = conversation({ id: "c2", title: "Supplier onboarding", updatedAt: OLDER_DATE });

    render(
      <ConversationList
        conversations={[beingRenamed]}
        search="zzz-no-match"
        badges={new Map()}
        onOpen={vi.fn()}
        onStartRename={vi.fn()}
        onCommitRename={vi.fn()}
        onCancelRename={vi.fn()}
        renamingId={null}
      />
    );

    expect(screen.queryByText("Supplier onboarding")).toBeNull();
  });
});
