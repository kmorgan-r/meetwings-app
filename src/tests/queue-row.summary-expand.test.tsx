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

import { QueueRow, type QueueRowProps } from "@/pages/meetings/components/QueueRow";
import type { MeetingLogListRow, MeetingSummary } from "@/types";

const BASE_ROW: MeetingLogListRow = {
  id: "qr-1",
  session_key: "s1",
  conversation_id: null,
  instance: "http://h:8069|odoo",
  contact_id: null,
  lead_id: null,
  transcript_start_at: 1_700_000_000_000,
  transcript_end_at: 1_700_000_060_000,
  attachment_id: null,
  message_id: null,
  status: "pending",
  attempts: 0,
  claimed_at: null,
  last_error: null,
  last_error_code: null,
  meeting_started_at: 1_700_000_000_000,
  created_at: 1_700_000_000_000,
  sent_at: null,
  targets: [],
};

function baseProps(rowOver: Partial<MeetingLogListRow>): QueueRowProps {
  return {
    row: { ...BASE_ROW, ...rowOver },
    targetName: "Someone",
    conversationTitle: null,
    isRenaming: false,
    instance: "http://h:8069|odoo",
    busy: false,
    stale: false,
    outcome: null,
    transcript: null,
    contacts: new Map(),
    onRetry: vi.fn(),
    onAssign: vi.fn(),
    onDelete: vi.fn(),
    onToggleTranscript: vi.fn(),
    onReloadTranscript: vi.fn(),
    onRetryTarget: vi.fn(),
    onRemoveTarget: vi.fn(),
    onStartRename: vi.fn(),
    onCommitRename: vi.fn(async () => true),
    onCancelRename: vi.fn(),
  };
}

const SUMMARY: MeetingSummary = {
  id: "s1", conversationId: "c1", summary: "The meeting summary.",
  title: "T", topics: [], goals: [], actionItems: [], nextSteps: [],
  decisions: [], teamUpdates: [], participants: [], exchangeCount: 4,
  durationSeconds: null, meetingStartedAt: null, meetingEndedAt: null,
  createdAt: 1, updatedAt: 1,
};

beforeEach(() => {
  getMeetingSummaryByConversation.mockReset();
  getEntitiesForSummary.mockClear();
});

describe("QueueRow summary expand", () => {
  it("does not fetch until expanded", () => {
    render(<QueueRow {...baseProps({ conversation_id: "c1" })} />);
    expect(getMeetingSummaryByConversation).not.toHaveBeenCalled();
  });

  it("fetches and renders the summary on expand", async () => {
    getMeetingSummaryByConversation.mockResolvedValue(SUMMARY);
    render(<QueueRow {...baseProps({ conversation_id: "c1" })} />);
    await userEvent.click(screen.getByRole("button", { name: /summary/i }));
    await waitFor(() => expect(screen.getByText("The meeting summary.")).toBeInTheDocument());
    expect(getMeetingSummaryByConversation).toHaveBeenCalledWith("c1");
  });

  it("renders 'No summary available' when there is none", async () => {
    getMeetingSummaryByConversation.mockResolvedValue(null);
    render(<QueueRow {...baseProps({ conversation_id: "c1" })} />);
    await userEvent.click(screen.getByRole("button", { name: /summary/i }));
    await waitFor(() => expect(screen.getByText("No summary available")).toBeInTheDocument());
  });

  it("renders no expand affordance at all when conversation_id is null", () => {
    render(<QueueRow {...baseProps({ conversation_id: null })} />);
    expect(screen.queryByRole("button", { name: /summary/i })).not.toBeInTheDocument();
  });

  it("falls back to 'No summary available' when the read throws", async () => {
    getMeetingSummaryByConversation.mockRejectedValueOnce(new Error("db unavailable"));
    render(<QueueRow {...baseProps({ conversation_id: "c1" })} />);
    await userEvent.click(screen.getByRole("button", { name: /summary/i }));
    await waitFor(() => expect(screen.getByText("No summary available")).toBeInTheDocument());
    expect(screen.queryByText("Loading summary…")).not.toBeInTheDocument();
  });
});
