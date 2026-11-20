import type { ReactNode } from "react";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SpeakerIdFactory, type TranscriptEntry } from "@/types";

// One SpeakerTaggingPopover per row that has a speaker, so its render count
// is the number of rows React actually re-rendered.
const popoverRenders = vi.hoisted(() => ({ count: 0 }));

vi.mock("@/components", () => ({
  Button: ({ children, onClick }: { children: ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
  CopyButton: () => null,
  ScrollArea: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SpeakerTaggingPopover: ({ children }: { children: ReactNode }) => {
    popoverRenders.count += 1;
    return <>{children}</>;
  },
}));
vi.mock("@/contexts", () => ({ useApp: () => ({ sttTranslationEnabled: false }) }));

import { MeetingTranscriptPanel } from "@/pages/app/components/completion/MeetingTranscriptPanel";

const line = (i: number, label = "Guest"): TranscriptEntry => ({
  original: `line ${i}`,
  timestamp: 1000 + i,
  audioSource: "system",
  speaker: { speakerId: SpeakerIdFactory.guest(1000 + i), speakerLabel: label, confirmed: false },
});

// Stable, like useCompletion's useCallback([]) versions.
const clearMeetingTranscript = vi.fn(async () => {});
const assignSpeaker = vi.fn();

const panel = (meetingTranscript: TranscriptEntry[]) => (
  <MeetingTranscriptPanel
    meetingTranscript={meetingTranscript}
    clearMeetingTranscript={clearMeetingTranscript}
    assignSpeaker={assignSpeaker}
  />
);

describe("MeetingTranscriptPanel rows", () => {
  beforeEach(() => {
    popoverRenders.count = 0;
  });

  it("renders only the new row when a line is appended", () => {
    const first = [line(0), line(1), line(2)];
    const { rerender } = render(panel(first));
    expect(popoverRenders.count).toBe(3);

    popoverRenders.count = 0;
    rerender(panel([...first, line(3)]));

    expect(popoverRenders.count).toBe(1);
    expect(screen.getByText("line 3")).toBeInTheDocument();
  });

  it("re-renders a row whose entry was replaced", () => {
    // assignSpeaker/updateEntrySpeaker/updateTranscriptTranslation replace the
    // edited entry with a new object and keep every other one.
    const entries = [line(0), line(1), line(2)];
    const { rerender } = render(panel(entries));

    popoverRenders.count = 0;
    rerender(panel([entries[0], line(1, "Dana"), entries[2]]));

    expect(popoverRenders.count).toBe(1);
    expect(screen.getByText("Dana")).toBeInTheDocument();
  });
});
