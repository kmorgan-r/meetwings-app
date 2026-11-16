import type { ReactNode, Ref } from "react";
import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TranscriptEntry } from "@/types";

// jsdom has no layout, so the viewport's geometry is faked here. scrollTop
// clamps like a browser's, and both scrollTo() and a scrollTop write move it.
const geom = vi.hoisted(() => ({ scrollTop: 0, scrollHeight: 0, clientHeight: 300 }));

const fakeViewport = (el: HTMLDivElement | null) => {
  if (!el) return;
  const set = (v: number) => {
    geom.scrollTop = Math.max(0, Math.min(v, geom.scrollHeight - geom.clientHeight));
  };
  Object.defineProperties(el, {
    scrollTop: { configurable: true, get: () => geom.scrollTop, set },
    scrollHeight: { configurable: true, get: () => geom.scrollHeight },
    clientHeight: { configurable: true, get: () => geom.clientHeight },
  });
  el.scrollTo = ((opts: ScrollToOptions) => set(opts.top ?? geom.scrollTop)) as typeof el.scrollTo;
};

vi.mock("@/components", () => ({
  Button: ({ children }: { children: ReactNode }) => <button type="button">{children}</button>,
  ScrollArea: ({ children, ref }: { children: ReactNode; ref?: Ref<HTMLDivElement> }) => (
    <div ref={ref}>
      <div data-radix-scroll-area-viewport="" ref={fakeViewport}>
        {children}
      </div>
    </div>
  ),
  SpeakerTaggingPopover: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("@/contexts", () => ({ useApp: () => ({ sttTranslationEnabled: false }) }));

import { MeetingTranscriptPanel } from "@/pages/app/components/completion/MeetingTranscriptPanel";

const line = (i: number): TranscriptEntry => ({
  original: `line ${i}`,
  timestamp: 1000 + i,
  audioSource: "system",
});
const clearMeetingTranscript = vi.fn(async () => {});

const panel = (meetingTranscript: TranscriptEntry[]) => (
  <MeetingTranscriptPanel
    meetingTranscript={meetingTranscript}
    clearMeetingTranscript={clearMeetingTranscript}
  />
);

describe("MeetingTranscriptPanel scroll follow", () => {
  beforeEach(() => {
    geom.scrollTop = 0;
    geom.scrollHeight = 1000;
    geom.clientHeight = 300;
  });

  it("opens at the newest line", () => {
    render(panel([line(0), line(1)]));
    expect(geom.scrollTop).toBe(700);
  });

  it("follows a new line while the reader is at the bottom", () => {
    const { rerender } = render(panel([line(0), line(1)]));
    geom.scrollHeight = 1100;
    rerender(panel([line(0), line(1), line(2)]));
    expect(geom.scrollTop).toBe(800);
  });

  it("keeps the reader's place when they have scrolled up", () => {
    const { rerender } = render(panel([line(0), line(1)]));
    geom.scrollTop = 200; // reader scrolls back
    geom.scrollHeight = 1100;
    rerender(panel([line(0), line(1), line(2)]));
    expect(geom.scrollTop).toBe(200);
  });

  it("follows again once the reader scrolls back to the bottom", () => {
    const { rerender } = render(panel([line(0), line(1)]));
    geom.scrollTop = 200;
    geom.scrollHeight = 1100;
    rerender(panel([line(0), line(1), line(2)]));
    geom.scrollTop = 800; // reader returns to the bottom by hand
    geom.scrollHeight = 1200;
    rerender(panel([line(0), line(1), line(2), line(3)]));
    expect(geom.scrollTop).toBe(900);
  });
});
