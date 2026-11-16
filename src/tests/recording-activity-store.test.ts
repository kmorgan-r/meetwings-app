import { describe, it, expect, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import {
  setCaptureActive,
  setMeetingActive,
  setAppBusy,
  getActivitySnapshot,
  useReportCaptureActivity,
  __resetActivityForTests,
} from "@/lib/updater/recording-activity.store";
import { canInstallNow } from "@/lib/updater/install-gate";

const MIN = 60_000;

beforeEach(() => {
  __resetActivityForTests();
});

describe("recording-activity store", () => {
  it("stays capturing while any source is active and stamps the end when the last stops", () => {
    setCaptureActive("system-audio", true, 10);
    setCaptureActive("mic", true, 20);

    setCaptureActive("system-audio", false, 30);
    expect(getActivitySnapshot()).toMatchObject({
      capturing: true,
      lastCaptureEndedAt: null,
    });

    setCaptureActive("mic", false, 40);
    expect(getActivitySnapshot()).toMatchObject({
      capturing: false,
      lastCaptureEndedAt: 40,
    });
  });

  it("an inactive source set inactive again does not stamp", () => {
    setCaptureActive("mic", false, 50);
    expect(getActivitySnapshot().lastCaptureEndedAt).toBeNull();
  });

  it("meeting state is independent of capture", () => {
    setMeetingActive(true);
    expect(getActivitySnapshot()).toMatchObject({
      meetingActive: true,
      capturing: false,
    });
  });

  it("a meeting that ended holds the install gate for the same 30-minute tail as a capture", () => {
    // Detection flaps mid-call: an ended meeting may be re-detected minutes later.
    const END = 1_000_000_000;
    setMeetingActive(true, END - 60 * MIN);
    setMeetingActive(false, END);
    const gate = (now: number) => canInstallNow({ ...getActivitySnapshot(), now });

    expect(gate(END + 10 * MIN)).toBe(false);
    expect(gate(END + 31 * MIN)).toBe(true);
  });

  it("a meeting end with no meeting active starts no tail", () => {
    // meeting-watcher-stopped also fires when nothing was detected.
    setMeetingActive(false, 50);
    expect(getActivitySnapshot().lastCaptureEndedAt).toBeNull();
  });

  it("an app-busy source blocks the gate while set and leaves no quiet tail", () => {
    setAppBusy("team-join", true);
    expect(getActivitySnapshot().appBusy).toBe(true);
    expect(canInstallNow({ ...getActivitySnapshot(), now: 0 })).toBe(false);

    setAppBusy("team-join", false);
    expect(getActivitySnapshot()).toMatchObject({ appBusy: false, lastCaptureEndedAt: null });
    expect(canInstallNow({ ...getActivitySnapshot(), now: 0 })).toBe(true);
  });

  it("useReportCaptureActivity stamps the end on true -> false and on unmount, not on unrelated re-renders", () => {
    const first = renderHook(
      ({ active, other }: { active: boolean; other: number }) => {
        useReportCaptureActivity("system-audio", active);
        return other;
      },
      { initialProps: { active: true, other: 1 } }
    );
    expect(getActivitySnapshot()).toMatchObject({
      capturing: true,
      lastCaptureEndedAt: null,
    });

    // A re-render that changes something unrelated (a conversation switch)
    // must never stamp a false capture end.
    first.rerender({ active: true, other: 2 });
    expect(getActivitySnapshot()).toMatchObject({
      capturing: true,
      lastCaptureEndedAt: null,
    });

    // true -> false stamps the end.
    first.rerender({ active: false, other: 2 });
    expect(getActivitySnapshot()).toMatchObject({ capturing: false });
    expect(getActivitySnapshot().lastCaptureEndedAt).not.toBeNull();

    // A second hook instance goes active, then unmounts; capture ends again.
    // (The earlier end stamp is not cleared on becoming active - the gate
    // defers on capturing regardless - it is re-stamped on this new end.)
    const second = renderHook(() => useReportCaptureActivity("mic", true));
    expect(getActivitySnapshot()).toMatchObject({ capturing: true });
    second.unmount();
    expect(getActivitySnapshot()).toMatchObject({ capturing: false });
  });
});
