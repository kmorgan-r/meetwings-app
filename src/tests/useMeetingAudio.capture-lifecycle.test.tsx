import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Capture must stop and start only when recording is switched off/on or the
// output device changes - not whenever the app reloads its settings (#114).
//
// app.context's loadData() JSON.parses the stored speech provider, so every
// reload hands useMeetingAudio a NEW selectedSttProvider object with the SAME
// contents. Reloads fire on any cross-window settings write (the dashboard's
// Responses or System Prompts pages, for example) and after a team settings
// sync. On a Mac each restart tears down and rebuilds the Core Audio process
// tap and aggregate device, and queued speech was discarded with it.
// Reproduced on 1.7.2: an unrelated dashboard change mid-recording logged
// `capture stop` + `capture start` with no mic toggle.

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  fetchSTT: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

// Same deep-import mock as useMeetingAudio.stt-failures.test.tsx: only fetchSTT
// is replaced, isUsableTranscription stays real.
vi.mock("@/lib/functions/stt.function", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  fetchSTT: mocks.fetchSTT,
}));

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

import { useMeetingAudio } from "@/hooks/useMeetingAudio";

type Props = Parameters<typeof useMeetingAudio>[0];

const FAKE_AUDIO = btoa("fake-audio-bytes");

const makeProps = (overrides: Partial<Props> = {}): Props => ({
  enabled: true,
  onSystemAudioTranscript: vi.fn(),
  onError: vi.fn(),
  selectedSttProvider: { provider: "openai", variables: {} },
  sttLanguage: "en",
  ...overrides,
});

const mount = (props: Props) =>
  renderHook((p: Props) => useMeetingAudio(p), { initialProps: props });

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

const waitForSetup = () =>
  waitFor(() => expect(listeners.get("speech-detected")?.size ?? 0).toBe(1));

const callsTo = (command: string) =>
  mocks.invoke.mock.calls.filter(([name]) => name === command).length;

/** What loadData() produces on a reload: same contents, new identity. */
const reloadedProvider = () => ({ provider: "openai", variables: {} });

beforeEach(() => {
  vi.clearAllMocks();
  listeners.clear();
  mocks.invoke.mockReset().mockResolvedValue(undefined);
  mocks.fetchSTT.mockReset();
});

describe("useMeetingAudio - capture survives a settings reload", () => {
  it("does not stop or restart capture when the STT settings object is replaced with an identical one", async () => {
    const props = makeProps();
    const view = mount(props);
    await waitForSetup();
    expect(callsTo("start_system_audio_capture")).toBe(1);

    view.rerender({ ...props, selectedSttProvider: reloadedProvider() });
    await flush();

    expect(callsTo("stop_system_audio_capture")).toBe(0);
    expect(callsTo("start_system_audio_capture")).toBe(1);
    expect(listeners.get("speech-detected")?.size).toBe(1);
  });

  it("still transcribes speech that was queued when the settings reloaded", async () => {
    // First segment stays in fetchSTT until released; the second waits in the
    // queue behind it. The reload lands while both are pending.
    let releaseFirst!: (text: string) => void;
    mocks.fetchSTT
      .mockImplementationOnce(
        () =>
          new Promise<string>((resolve) => {
            releaseFirst = resolve;
          })
      )
      .mockResolvedValueOnce("Second point: the budget is approved.");
    const onSystemAudioTranscript = vi.fn();
    const props = makeProps({ onSystemAudioTranscript });
    const view = mount(props);
    await waitForSetup();

    await fire("speech-detected");
    await fire("speech-detected");

    view.rerender({ ...props, selectedSttProvider: reloadedProvider() });
    await flush();

    releaseFirst("First point: we ship on Friday.");
    await waitFor(() =>
      expect(onSystemAudioTranscript).toHaveBeenCalledTimes(2)
    );
    expect(onSystemAudioTranscript.mock.calls.map(([text]) => text)).toEqual([
      "First point: we ship on Friday.",
      "Second point: the budget is approved.",
    ]);
  });

  it("uses a changed speech language for the next segment without restarting capture", async () => {
    mocks.fetchSTT.mockResolvedValue("Guten Morgen zusammen.");
    const props = makeProps({ sttLanguage: "en" });
    const view = mount(props);
    await waitForSetup();

    view.rerender({ ...props, sttLanguage: "de" });
    await flush();
    await fire("speech-detected");

    await waitFor(() => expect(mocks.fetchSTT).toHaveBeenCalledTimes(1));
    expect(mocks.fetchSTT.mock.calls[0][0].language).toBe("de");
    expect(callsTo("start_system_audio_capture")).toBe(1);
    expect(callsTo("stop_system_audio_capture")).toBe(0);
  });
});
