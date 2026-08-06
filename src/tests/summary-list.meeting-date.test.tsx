import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { MeetingSummary } from "@/types";

vi.mock("@/lib/database", () => ({
  getAllMeetingSummaries: vi.fn(async () => [BACKFILLED_SUMMARY]),
  deleteMeetingSummary: vi.fn(),
}));

import { SummaryList } from "@/pages/context-memory/components/SummaryList";

/** The meeting: 2026-01-29, 21 minutes long. */
const MEETING_START = new Date(2026, 0, 29, 7, 18).getTime();
const MEETING_END = MEETING_START + 21 * 60 * 1000;
/** The summary row: written months later by the knowledge backfill. */
const WRITTEN_AT = new Date(2026, 6, 2, 8, 14).getTime();

const BACKFILLED_SUMMARY: MeetingSummary = {
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
  meetingEndedAt: MEETING_END,
  createdAt: WRITTEN_AT,
  updatedAt: WRITTEN_AT,
};

beforeEach(() => {
  // Pinned so "is this the current year" formatting can't drift with the clock.
  // shouldAdvanceTime keeps Testing Library's async polling alive — without it
  // findBy* waits on a clock that never moves and times out.
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date(2026, 7, 6, 9, 0));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("meeting summary list dates", () => {
  it("dates a summary by its meeting, not by when it was written", async () => {
    render(<SummaryList onSelectSummary={() => {}} />);

    // The backfill stamps a whole batch of old conversations with one write
    // time, so showing createdAt files a January meeting under July.
    expect(await screen.findByText(/Jan 29/)).toBeTruthy();
    expect(screen.queryByText(/Jul 2/)).toBeNull();
  });

  it("shows how long the meeting ran", async () => {
    render(<SummaryList onSelectSummary={() => {}} />);

    expect(await screen.findByText("21min")).toBeTruthy();
  });
});
