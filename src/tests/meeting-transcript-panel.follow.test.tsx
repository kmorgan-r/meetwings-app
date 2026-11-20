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

import {
  MeetingTranscriptPanel,
  resetTranscriptScrollMemory,
} from "@/pages/app/components/completion/MeetingTranscriptPanel";

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

/** The reader scrolls: a browser moves scrollTop, then fires `scroll`. */
const readerScrollsTo = (container: HTMLElement, top: number) => {
  geom.scrollTop = top;
  container
    .querySelector("[data-radix-scroll-area-viewport]")!
    .dispatchEvent(new Event("scroll"));
};

describe("MeetingTranscriptPanel scroll follow", () => {
  beforeEach(() => {
    resetTranscriptScrollMemory();
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
    const { container, rerender } = render(panel([line(0), line(1)]));
    readerScrollsTo(container, 200);
    geom.scrollHeight = 1100;
    rerender(panel([line(0), line(1), line(2)]));
    expect(geom.scrollTop).toBe(200);
  });

  it("keeps the reader's place when they have scrolled up only one line", () => {
    const { container, rerender } = render(panel([line(0), line(1)]));
    readerScrollsTo(container, 640); // 60 px above the bottom
    geom.scrollHeight = 1100;
    rerender(panel([line(0), line(1), line(2)]));
    expect(geom.scrollTop).toBe(640);
  });

  it("follows again once the reader scrolls back to the bottom", () => {
    const { container, rerender } = render(panel([line(0), line(1)]));
    readerScrollsTo(container, 200);
    geom.scrollHeight = 1100;
    rerender(panel([line(0), line(1), line(2)]));
    readerScrollsTo(container, 800);
    geom.scrollHeight = 1200;
    rerender(panel([line(0), line(1), line(2), line(3)]));
    expect(geom.scrollTop).toBe(900);
  });

  // The panel unmounts whenever an answer, a hide or a mic stop takes its
  // place. Coming back must not snap a reader to the newest line.
  it("puts the reader back where they were when the panel comes back", () => {
    const first = render(panel([line(0), line(1)]));
    readerScrollsTo(first.container, 200);
    first.unmount();

    geom.scrollTop = 0; // a fresh scroll area starts at the top
    geom.scrollHeight = 1100;
    render(panel([line(0), line(1), line(2)]));
    expect(geom.scrollTop).toBe(200);
  });

  it("keeps following after the panel comes back when the reader was at the bottom", () => {
    render(panel([line(0), line(1)])).unmount();

    geom.scrollTop = 0;
    geom.scrollHeight = 1100;
    render(panel([line(0), line(1), line(2)]));
    expect(geom.scrollTop).toBe(800);
  });

  it("opens the next meeting at its newest line", () => {
    const first = render(panel([line(0), line(1)]));
    readerScrollsTo(first.container, 200);
    first.unmount();

    geom.scrollTop = 0;
    render(panel([line(5), line(6)]));
    expect(geom.scrollTop).toBe(700);
  });
});
