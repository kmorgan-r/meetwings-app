import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { getMeetingSummaryByConversation, getEntitiesForSummary } = vi.hoisted(() => ({
  getMeetingSummaryByConversation: vi.fn(),
  getEntitiesForSummary: vi.fn(async () => []),
}));
vi.mock("@/lib/database", () => ({
  getMeetingSummaryByConversation,
  getEntitiesForSummary,
}));

import { ConversationRow, type ConversationRowProps } from "@/pages/meetings/components/ConversationRow";
import type { MeetingSummary } from "@/types";

function baseProps(over: Partial<ConversationRowProps>): ConversationRowProps {
  return {
    id: "conv-1",
    title: "Quarterly review",
    messageCount: 8,
    updatedAt: 1_700_000_000_000,
    badgeStatus: null,
    badgeCount: 0,
    whoLabel: null,
    onOpen: vi.fn(),
    isRenaming: false,
    onStartRename: vi.fn(),
    onCommitRename: vi.fn(async () => true),
    onCancelRename: vi.fn(),
    ...over,
  };
}

const SUMMARY: MeetingSummary = {
  id: "s1", conversationId: "conv-1", summary: "The meeting summary.",
  title: "T", topics: [], goals: [], actionItems: [], nextSteps: [],
  decisions: [], teamUpdates: [], participants: [], exchangeCount: 4,
  durationSeconds: null, meetingStartedAt: null, meetingEndedAt: null,
  createdAt: 1, updatedAt: 1,
};

beforeEach(() => {
  getMeetingSummaryByConversation.mockReset();
  getEntitiesForSummary.mockClear();
});

describe("ConversationRow summary expand", () => {
  it("does not fetch until expanded", () => {
    render(<ConversationRow {...baseProps({ id: "conv-1" })} />);
    expect(getMeetingSummaryByConversation).not.toHaveBeenCalled();
  });

  it("fetches and renders the summary on expand, keyed on the id prop", async () => {
    getMeetingSummaryByConversation.mockResolvedValue(SUMMARY);
    render(<ConversationRow {...baseProps({ id: "conv-1" })} />);
    await userEvent.click(screen.getByRole("button", { name: /summary/i }));
    await waitFor(() => expect(screen.getByText("The meeting summary.")).toBeInTheDocument());
    expect(getMeetingSummaryByConversation).toHaveBeenCalledWith("conv-1");
  });

  it("does not navigate when toggling the summary or clicking inside its content", async () => {
    const onOpen = vi.fn();
    getMeetingSummaryByConversation.mockResolvedValue(SUMMARY);
    render(<ConversationRow {...baseProps({ id: "conv-1", onOpen })} />);

    // The toggle button's own stopPropagation: clicking it must not navigate.
    await userEvent.click(screen.getByRole("button", { name: /summary/i }));
    await waitFor(() => expect(screen.getByText("The meeting summary.")).toBeInTheDocument());
    expect(onOpen).not.toHaveBeenCalled();

    // The wrapper <div>'s own, separate stopPropagation: a click that lands
    // on the rendered summary content (not the toggle button) must also not
    // bubble up to the Card's navigating onClick.
    await userEvent.click(screen.getByText("The meeting summary."));
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("falls back to 'No summary available' when the read throws", async () => {
    getMeetingSummaryByConversation.mockRejectedValueOnce(new Error("db unavailable"));
    render(<ConversationRow {...baseProps({ id: "conv-1" })} />);
    await userEvent.click(screen.getByRole("button", { name: /summary/i }));
    await waitFor(() => expect(screen.getByText("No summary available")).toBeInTheDocument());
    expect(screen.queryByText("Loading summary…")).not.toBeInTheDocument();
  });
});
