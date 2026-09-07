import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { SummaryContent } from "@/pages/context-memory/components/SummaryContent";
import type { MeetingSummary, KnowledgeEntity } from "@/types";

const SUMMARY: MeetingSummary = {
  id: "s1", conversationId: "c1", summary: "We discussed the roadmap.",
  title: "Roadmap Sync", topics: ["roadmap"], goals: ["ship v2"],
  actionItems: ["write the doc"], nextSteps: ["review Friday"],
  decisions: ["go with plan B"], teamUpdates: ["Ada joined the team"],
  participants: ["Ada", "Bo"], exchangeCount: 6, durationSeconds: 300,
  meetingStartedAt: 1000, meetingEndedAt: 1300, createdAt: 1, updatedAt: 1,
};

const ENTITIES: KnowledgeEntity[] = [
  // Deliberately NOT "Ada" — SUMMARY.participants already contains "Ada",
  // and the entity badge renders as a SEPARATE "organization:" span plus a
  // bare "Ada" text node inside the same Badge, which risks getByText("Ada")
  // resolving ambiguously against the participant badge depending on how
  // Testing Library's text matcher normalizes split text nodes. A distinct
  // fixture value sidesteps the ambiguity outright rather than relying on
  // matcher internals.
  { id: "e1", entityType: "company", name: "Acme Corp", description: null, firstSeen: 1, lastSeen: 1, mentionCount: 1 },
];

describe("SummaryContent", () => {
  it("renders the summary text and every non-empty section", () => {
    render(<SummaryContent summary={SUMMARY} entities={ENTITIES} />);
    expect(screen.getByText("We discussed the roadmap.")).toBeInTheDocument();
    expect(screen.getByText("roadmap")).toBeInTheDocument();
    expect(screen.getByText("ship v2")).toBeInTheDocument();
    expect(screen.getByText("write the doc")).toBeInTheDocument();
    expect(screen.getByText("review Friday")).toBeInTheDocument();
    expect(screen.getByText("go with plan B")).toBeInTheDocument();
    expect(screen.getByText("Ada joined the team")).toBeInTheDocument();
    expect(screen.getByText("Ada")).toBeInTheDocument();
    expect(screen.getByText("Bo")).toBeInTheDocument();
    expect(screen.getByText(/Acme Corp/)).toBeInTheDocument();
  });

  it("omits a section entirely when its array is empty, rather than rendering an empty heading", () => {
    render(<SummaryContent summary={{ ...SUMMARY, goals: [] }} entities={[]} />);
    expect(screen.queryByText("Goals")).not.toBeInTheDocument();
  });

  it("omits its own summary text when showSummary is false, without touching any other section", () => {
    // SummaryDetail.tsx passes showSummary={false} while isEditing, so it can
    // render its OWN Textarea for the summary without this component's
    // read-only paragraph duplicating the same text underneath it.
    render(<SummaryContent summary={SUMMARY} entities={[]} showSummary={false} />);
    expect(screen.queryByText("We discussed the roadmap.")).not.toBeInTheDocument();
    expect(screen.getByText("roadmap")).toBeInTheDocument();
  });

  it("does not render an exchange-count footer at all — that stays in SummaryDetail.tsx's own chrome", () => {
    render(<SummaryContent summary={SUMMARY} entities={[]} />);
    expect(screen.queryByText(/transcript lines/)).not.toBeInTheDocument();
    expect(screen.queryByText(/exchanges/)).not.toBeInTheDocument();
  });
});
