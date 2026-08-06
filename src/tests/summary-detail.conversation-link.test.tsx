import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { MeetingSummary } from "@/types";

const navigate = vi.hoisted(() => vi.fn());

vi.mock("react-router-dom", () => ({
  useNavigate: () => navigate,
}));

vi.mock("@/lib/database", () => ({
  updateMeetingSummary: vi.fn(),
  getEntitiesForSummary: vi.fn(async () => []),
}));

import { SummaryDetail } from "@/pages/context-memory/components/SummaryDetail";

const MEETING_START = new Date(2026, 0, 29, 7, 18).getTime();
const WRITTEN_AT = new Date(2026, 6, 2, 8, 14).getTime();

const SUMMARY: MeetingSummary = {
  id: "sum-1",
  conversationId: "conv-1",
  summary: "Explored a partnership around LCA tooling.",
  title: "Climate Point & LCA NL Partnership Exploration Call",
  topics: [],
  goals: [],
  actionItems: [],
  nextSteps: [],
  decisions: [],
  teamUpdates: [],
  participants: [],
  exchangeCount: 12,
  durationSeconds: 21 * 60,
  meetingStartedAt: MEETING_START,
  meetingEndedAt: MEETING_START + 21 * 60 * 1000,
  createdAt: WRITTEN_AT,
  updatedAt: WRITTEN_AT,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date(2026, 7, 6, 9, 0));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("summary detail", () => {
  it("dates the summary by its meeting, not by when it was written", () => {
    render(
      <SummaryDetail summary={SUMMARY} onClose={() => {}} onUpdate={() => {}} />
    );

    expect(screen.getByText(/January 29, 2026/)).toBeTruthy();
    expect(screen.queryByText(/July 2, 2026/)).toBeNull();
  });

  it("opens the conversation the summary came from", () => {
    render(
      <SummaryDetail summary={SUMMARY} onClose={() => {}} onUpdate={() => {}} />
    );

    // conversation_id is stored on every summary and was never reachable from
    // the UI, leaving Context Memory and Chats as two unconnected features.
    fireEvent.click(screen.getByTitle("Open this conversation"));

    expect(navigate).toHaveBeenCalledWith("/chats/view/conv-1");
  });
});
