import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock factories are hoisted above these imports, so shared spies must come
// from vi.hoisted or the factory dereferences a const still in its temporal
// dead zone and the whole file fails to load, reporting "no tests" rather
// than failures.
const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  fetchSTT: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

// Deep-imported (not the @/lib barrel): useMeetingAudio does
// `import { fetchSTT } from '@/lib'`, which re-exports from
// `@/lib/functions/stt.function` - mocking this exact module id intercepts
// that import without needing to stub every other @/lib export.
//
// Spread the real module rather than returning a bare { fetchSTT }:
// isUsableTranscription and the failure literals now live in this same module,
// and a whole-module factory would hand useMeetingAudio `undefined` for the
// predicate at import time. Only fetchSTT is replaced - the predicate under
// test below is the REAL one, which is the entire point of pinning it.
vi.mock("@/lib/functions/stt.function", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  fetchSTT: mocks.fetchSTT,
}));

// Registry keyed by event name holding EVERY registered callback, so a leak
// (double registration) would be observable, and unlisten removes only its
// own callback.
const listeners = new Map<string, Set<(e: { payload: unknown }) => void>>();
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(
    async (event: string, cb: (e: { payload: unknown }) => void) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(cb);
      return () => listeners.get(event)?.delete(cb);
    }
  ),
}));

import {
  useMeetingAudio,
  EMPTY_TRANSCRIPTION_MESSAGE,
} from "@/hooks/useMeetingAudio";
import {
  EMPTY_TRANSCRIPTION_REPORT_THRESHOLD,
  STT_FAILURE_REPORT_THRESHOLD,
} from "@/config";
// The literals are imported, never re-typed here: a copy typed into this file
// is exactly the desync the pinning is supposed to catch. Asserting on
// `${STT_ERROR_PREFIX} ...` pins the SHAPE fetchSTT builds, whatever the text
// happens to be, and the returns in stt.function.ts are built from these same
// constants.
import {
  isUsableTranscription,
  STT_ERROR_PREFIX,
  STT_NO_TRANSCRIPTION_FOUND,
  STT_TRANSCRIPTION_FAILED,
} from "@/lib/functions/stt.function";

type Props = Parameters<typeof useMeetingAudio>[0];

// A single stable reference reused across every rerender in this file.
// processQueue's deps include selectedSttProvider, so a fresh object literal
// on every rerender would recreate processQueue, re-run the main effect, and
// silently reset the failure counters under test - the exact trap Step 2
// warns about for the "re-arms per session" case.
const SELECTED_STT_PROVIDER = { provider: "openai", variables: {} };

const FAKE_AUDIO = btoa("fake-audio-bytes");

const makeProps = (overrides: Partial<Props> = {}): Props => ({
  enabled: true,
  onSystemAudioTranscript: vi.fn(),
  onError: vi.fn(),
  selectedSttProvider: SELECTED_STT_PROVIDER,
  sttLanguage: "en",
  ...overrides,
});

const mount = (props: Props) =>
  renderHook((p: Props) => useMeetingAudio(p), { initialProps: props });

/** Drains pending microtasks (e.g. a resolved/rejected fetchSTT promise). */
const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

const fire = async (event: string, payload: unknown = FAKE_AUDIO) => {
  const cbs = [...(listeners.get(event) ?? [])];
  await act(async () => {
    cbs.forEach((cb) => cb({ payload }));
  });
  await flush();
};

/** Rule 1: settle on a positive marker before asserting an absence. */
const waitForSetup = () =>
  waitFor(() => expect(listeners.get("speech-detected")?.size ?? 0).toBe(1));

beforeEach(() => {
  vi.clearAllMocks();
  listeners.clear();
  mocks.invoke.mockReset().mockResolvedValue(undefined);
  mocks.fetchSTT.mockReset();
});

describe("isUsableTranscription - pinned against the real stt.function.ts literals", () => {
  // fetchMeetwingsSTT's bare fallback (`response.error || STT_TRANSCRIPTION_
  // FAILED`), reached when the Meetwings command resolves without a
  // transcription or an error string.
  it("rejects the bare Meetwings fallback", () => {
    expect(isUsableTranscription(STT_TRANSCRIPTION_FAILED)).toBe(false);
  });

  // The real rejection shape: src-tauri/src/api.rs:270 is Err(...), so
  // `invoke` rejects and fetchMeetwingsSTT's catch prefixes the message.
  // Built the way fetchMeetwingsSTT builds it - prefix, space, message.
  it("rejects the prefixed rejection text", () => {
    expect(
      isUsableTranscription(
        `${STT_ERROR_PREFIX} Transcription failed. Please try again.`
      )
    ).toBe(false);
  });

  // fetchSTT joins warnings AHEAD of the no-transcription tail, so an anchored
  // ^-regex would miss this - the sentinel is deliberately unanchored at the
  // head.
  it("rejects a warning joined ahead of the no-transcription tail", () => {
    expect(
      isUsableTranscription(
        `Language auto-detect may not be fully supported by OpenAI; ${STT_NO_TRANSCRIPTION_FOUND}`
      )
    ).toBe(false);
  });

  it("accepts a genuine transcription", () => {
    expect(isUsableTranscription("Let's kick off the standup.")).toBe(true);
  });
});

describe("useMeetingAudio - failing STT provider visibility", () => {
  it("reports once at the threshold and not before", async () => {
    mocks.fetchSTT.mockRejectedValue(new Error("network error"));
    const onError = vi.fn();
    mount(makeProps({ onError }));
    await waitForSetup();

    // threshold - 1 = 2 failing segments: no report yet.
    await fire("speech-detected");
    await fire("speech-detected");
    await waitFor(() => expect(mocks.fetchSTT).toHaveBeenCalledTimes(2));
    expect(onError).not.toHaveBeenCalled();

    // The 3rd (threshold) segment reports exactly once.
    await fire("speech-detected");
    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));

    // 5 more failing segments: still exactly once - the report is latched
    // for the session, not re-armed on every failure past the threshold.
    for (let i = 0; i < 5; i++) {
      await fire("speech-detected");
    }
    await waitFor(() => expect(mocks.fetchSTT).toHaveBeenCalledTimes(8));
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("treats a resolved error sentinel as a failure and never posts it", async () => {
    // Deliberately NOT built from STT_TRANSCRIPTION_FAILED: this is the Rust
    // command's terminal error text as a user would actually receive it
    // (src-tauri/src/api.rs:270). Because it is written out in full, editing
    // the constant in stt.function.ts fails HERE - the shape-pins above would
    // follow the edit and stay green.
    mocks.fetchSTT.mockResolvedValue(
      "Transcription failed. Please try again."
    );
    const onError = vi.fn();
    const onSystemAudioTranscript = vi.fn();
    mount(makeProps({ onError, onSystemAudioTranscript }));
    await waitForSetup();

    for (let i = 0; i < 3; i++) {
      await fire("speech-detected");
    }
    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));

    expect(onSystemAudioTranscript).not.toHaveBeenCalled();
  });

  it("a success between failures does not re-arm the report", async () => {
    const onError = vi.fn();
    mocks.fetchSTT
      .mockRejectedValueOnce(new Error("boom"))
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce("Let's move to the next agenda item.")
      .mockRejectedValueOnce(new Error("boom"))
      .mockRejectedValueOnce(new Error("boom"))
      .mockRejectedValueOnce(new Error("boom"));
    mount(makeProps({ onError }));
    await waitForSetup();

    // Segments 1-2 fail, segment 3 succeeds and resets the counter, segments
    // 4-5 fail again - only 2 consecutive failures since the reset, still
    // below the threshold of 3. Asserting on the SEGMENT INDEX (not "the Nth
    // failure") is deliberate: five failures land across six segments, so
    // counting failures directly is off by one against a correct
    // implementation.
    for (let i = 0; i < 5; i++) {
      await fire("speech-detected");
    }
    await waitFor(() => expect(mocks.fetchSTT).toHaveBeenCalledTimes(5));
    expect(onError).not.toHaveBeenCalled();

    // Segment 6: the 3rd consecutive failure since the reset.
    await fire("speech-detected");
    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
  });

  it("end-of-call drop is loud and does not count as an STT failure", async () => {
    let resolveFetch!: (value: string) => void;
    mocks.fetchSTT.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          resolveFetch = resolve;
        })
    );
    const onError = vi.fn();
    const onSystemAudioTranscript = vi.fn();
    const props = makeProps({ onError, onSystemAudioTranscript });
    const view = mount(props);
    await waitForSetup();

    // Exactly ONE in-flight segment with an EMPTY queue: processQueue's own
    // top-of-loop guard fires its own onError ("N audio segment(s) not
    // transcribed") for anything still queued when disabled is observed, so
    // a 2-segment setup would fail against a correct implementation for an
    // unrelated reason.
    await fire("speech-detected");

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    // The call ends while this segment is still awaiting fetchSTT.
    view.rerender({ ...props, enabled: false });

    resolveFetch("Thanks everyone, that covers it for today.");
    await flush();

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      "[MeetingAudio] Discarding a segment that resolved after the session ended"
    );
    expect(onSystemAudioTranscript).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  it("silence is not a failure", async () => {
    mocks.fetchSTT.mockResolvedValue("");
    const onError = vi.fn();
    mount(makeProps({ onError }));
    await waitForSetup();

    for (let i = 0; i < 3; i++) {
      await fire("speech-detected");
    }
    await waitFor(() => expect(mocks.fetchSTT).toHaveBeenCalledTimes(3));

    expect(onError).not.toHaveBeenCalled();
  });

  it("empty transcriptions never trip the provider-failure report", async () => {
    // Pins the two counters apart in the direction that matters for a live
    // call: a run of empties long enough to trip its OWN report must never
    // reach for the "check your API key" copy, which is what the pre-existing
    // "silence is not a failure" case guards at 3 segments. Deliberately
    // driven past STT_FAILURE_REPORT_THRESHOLD so a shared counter is visible.
    mocks.fetchSTT.mockResolvedValue("");
    const onError = vi.fn();
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mount(makeProps({ onError }));
    await waitForSetup();

    for (let i = 0; i < EMPTY_TRANSCRIPTION_REPORT_THRESHOLD; i++) {
      await fire("speech-detected");
    }

    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(onError.mock.calls[0][0].message).toBe(EMPTY_TRANSCRIPTION_MESSAGE);

    spy.mockRestore();
  });

  it("the report re-arms per session", async () => {
    mocks.fetchSTT.mockRejectedValue(new Error("boom"));
    const onError = vi.fn();
    const props = makeProps({ onError });
    const view = mount(props);
    await waitForSetup();

    for (let i = 0; i < 3; i++) {
      await fire("speech-detected");
    }
    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));

    // End the session and start a new one. selectedSttProvider (and every
    // other processQueue dependency) stays referentially stable across the
    // toggle - a fresh object literal here would ALSO re-run the effect and
    // reset the counters, passing this case for the wrong reason.
    view.rerender({ ...props, enabled: false });
    view.rerender({ ...props, enabled: true });
    await waitForSetup();

    for (let i = 0; i < 3; i++) {
      await fire("speech-detected");
    }
    await waitFor(() => expect(onError).toHaveBeenCalledTimes(2));
  });
});

// Rust's VAD has already decided a segment is speech before it reaches
// processQueue (MEETING_VAD_CONFIG's min_speech_chunks / peak_threshold), so a
// COMPLETED transcription that comes back empty is two detectors disagreeing,
// not silence. Reported on its own counter and with its own copy: the
// provider-failure ladder points at the API key, which is the wrong thing to
// check when the provider is answering fine and the audio is the problem.
describe("useMeetingAudio - audio captured but nothing transcribed", () => {
  const warnSpy = () => vi.spyOn(console, "warn").mockImplementation(() => {});

  it("reports once at the empty threshold and not before", async () => {
    mocks.fetchSTT.mockResolvedValue("");
    const onError = vi.fn();
    const spy = warnSpy();
    mount(makeProps({ onError }));
    await waitForSetup();

    for (let i = 0; i < EMPTY_TRANSCRIPTION_REPORT_THRESHOLD - 1; i++) {
      await fire("speech-detected");
    }
    await waitFor(() =>
      expect(mocks.fetchSTT).toHaveBeenCalledTimes(
        EMPTY_TRANSCRIPTION_REPORT_THRESHOLD - 1
      )
    );
    expect(onError).not.toHaveBeenCalled();

    await fire("speech-detected");
    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(onError.mock.calls[0][0].message).toBe(EMPTY_TRANSCRIPTION_MESSAGE);

    // Latched for the session, matching the provider-failure report: onError
    // lands on an unbudgeted toast in Audio.tsx, so re-arming turns a bad
    // audio source into a toast storm for the rest of the call.
    for (let i = 0; i < 5; i++) {
      await fire("speech-detected");
    }
    expect(onError).toHaveBeenCalledTimes(1);

    spy.mockRestore();
  });

  it("a usable transcription resets the empty run", async () => {
    const onError = vi.fn();
    const spy = warnSpy();
    // One short of the threshold, then real speech, then one short again.
    // Asserting on segment index rather than "the Nth empty" for the same
    // reason the provider-failure reset case does.
    mocks.fetchSTT.mockImplementation(async () => {
      const call = mocks.fetchSTT.mock.calls.length;
      return call === EMPTY_TRANSCRIPTION_REPORT_THRESHOLD
        ? "Let's move to the next agenda item."
        : "";
    });
    mount(makeProps({ onError }));
    await waitForSetup();

    const segments = 2 * EMPTY_TRANSCRIPTION_REPORT_THRESHOLD - 1;
    for (let i = 0; i < segments; i++) {
      await fire("speech-detected");
    }
    await waitFor(() =>
      expect(mocks.fetchSTT).toHaveBeenCalledTimes(segments)
    );
    expect(onError).not.toHaveBeenCalled();

    await fire("speech-detected");
    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));

    spy.mockRestore();
  });

  it("logs every dropped segment so the loss is diagnosable from the console", async () => {
    mocks.fetchSTT.mockResolvedValue("");
    const spy = warnSpy();
    mount(makeProps({}));
    await waitForSetup();

    await fire("speech-detected");
    await fire("speech-detected");

    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
    expect(spy.mock.calls[0][0]).toContain("transcribed empty");

    spy.mockRestore();
  });

  it("a provider failure is not counted as an empty segment", async () => {
    // The mirror of the case above: rejections must keep reaching the
    // provider-failure copy. A single shared counter would surface whichever
    // report crossed its threshold first, which for a dead API key is the
    // wrong one.
    mocks.fetchSTT.mockRejectedValue(new Error("network error"));
    const onError = vi.fn();
    mount(makeProps({ onError }));
    await waitForSetup();

    for (let i = 0; i < STT_FAILURE_REPORT_THRESHOLD; i++) {
      await fire("speech-detected");
    }

    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(onError.mock.calls[0][0].message).not.toBe(
      EMPTY_TRANSCRIPTION_MESSAGE
    );
  });
});
