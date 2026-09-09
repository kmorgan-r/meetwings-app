import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";

import { usePillRecordAction } from "@/hooks/usePillRecordAction";
import { getPillActions, setPillActions } from "@/lib/overlay-minimize.store";

type Options = Parameters<typeof usePillRecordAction>[0];

const opts = (over: Partial<Options> = {}): Options => ({
  meetingAssistMode: false,
  setMeetingAssistMode: vi.fn(),
  enableVAD: false,
  setEnableVAD: vi.fn(),
  canRecord: true,
  ...over,
});

describe("usePillRecordAction", () => {
  beforeEach(() => {
    setPillActions({ toggleRecording: null });
  });

  it("registers a toggle while recording is possible", () => {
    renderHook(() => usePillRecordAction(opts()));
    expect(typeof getPillActions().toggleRecording).toBe("function");
  });

  it("registers nothing when no speech provider can serve the recording", () => {
    renderHook(() => usePillRecordAction(opts({ canRecord: false })));
    // null, not a no-op function: the pill hides the button entirely rather
    // than showing one that silently does nothing.
    expect(getPillActions().toggleRecording).toBeNull();
  });

  it("unregisters on unmount so the pill cannot call into a dead tree", () => {
    const { unmount } = renderHook(() => usePillRecordAction(opts()));
    expect(getPillActions().toggleRecording).not.toBeNull();
    unmount();
    expect(getPillActions().toggleRecording).toBeNull();
  });

  it("start turns on BOTH the meeting pill and the mic", () => {
    const setMeetingAssistMode = vi.fn();
    const setEnableVAD = vi.fn();
    renderHook(() =>
      usePillRecordAction(opts({ setMeetingAssistMode, setEnableVAD }))
    );

    getPillActions().toggleRecording?.();

    expect(setMeetingAssistMode).toHaveBeenCalledWith(true);
    expect(setEnableVAD).toHaveBeenCalledWith(true);
  });

  it("stop turns both off - the pill-off transition is what logs the meeting", () => {
    const setMeetingAssistMode = vi.fn();
    const setEnableVAD = vi.fn();
    renderHook(() =>
      usePillRecordAction(
        opts({
          meetingAssistMode: true,
          enableVAD: true,
          setMeetingAssistMode,
          setEnableVAD,
        })
      )
    );

    getPillActions().toggleRecording?.();

    expect(setEnableVAD).toHaveBeenCalledWith(false);
    expect(setMeetingAssistMode).toHaveBeenCalledWith(false);
  });

  it("meeting mode on with the mic closed is NOT recording - the toggle starts", () => {
    const setMeetingAssistMode = vi.fn();
    const setEnableVAD = vi.fn();
    renderHook(() =>
      usePillRecordAction(
        opts({
          meetingAssistMode: true,
          enableVAD: false,
          setMeetingAssistMode,
          setEnableVAD,
        })
      )
    );

    getPillActions().toggleRecording?.();

    expect(setEnableVAD).toHaveBeenCalledWith(true);
    expect(setMeetingAssistMode).toHaveBeenCalledWith(true);
  });

  it("keeps ONE registered reference across state flips, and still reads current state", () => {
    const setEnableVAD = vi.fn();
    const { rerender } = renderHook(
      (props: Options) => usePillRecordAction(props),
      { initialProps: opts({ setEnableVAD }) }
    );
    const first = getPillActions().toggleRecording;

    rerender(opts({ meetingAssistMode: true, enableVAD: true, setEnableVAD }));

    // Same function: re-registering per render would wake the pill's
    // useSyncExternalStore on every streamed AI token.
    expect(getPillActions().toggleRecording).toBe(first);
    // ...but it acts on the CURRENT state, not the one it closed over.
    first?.();
    expect(setEnableVAD).toHaveBeenCalledWith(false);
  });

  it("re-registers when canRecord flips, because that changes whether a button exists", () => {
    const { rerender } = renderHook(
      (props: Options) => usePillRecordAction(props),
      { initialProps: opts({ canRecord: true }) }
    );
    expect(getPillActions().toggleRecording).not.toBeNull();

    rerender(opts({ canRecord: false }));
    expect(getPillActions().toggleRecording).toBeNull();

    rerender(opts({ canRecord: true }));
    expect(getPillActions().toggleRecording).not.toBeNull();
  });

  it("a re-render that changes nothing does not churn the registered reference", () => {
    const { rerender } = renderHook(
      (props: Options) => usePillRecordAction(props),
      { initialProps: opts() }
    );
    const first = getPillActions().toggleRecording;

    // Fresh props object with fresh setter identities - exactly what
    // <Completion /> hands it on every streamed token.
    rerender(opts());

    expect(getPillActions().toggleRecording).toBe(first);
  });
});
