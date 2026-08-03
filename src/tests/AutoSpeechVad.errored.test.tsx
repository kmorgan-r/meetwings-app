import { act, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock factories are hoisted above these imports, so shared spies must come
// from vi.hoisted or the factory dereferences a const still in its temporal
// dead zone and the whole file fails to load, reporting "no tests" rather
// than failures.
const mocks = vi.hoisted(() => ({
  toast: { error: vi.fn() },
  fetchSTT: vi.fn(),
  vad: {
    errored: false as string | false,
    listening: false,
    loading: false,
    userSpeaking: false,
    pause: vi.fn(),
    start: vi.fn(),
  },
  // Captured from useMicVAD's options so a test can drive onSpeechEnd
  // directly, the way real VAD would after a speech segment ends.
  onSpeechEnd: undefined as
    | ((audio: Float32Array) => void | Promise<void>)
    | undefined,
}));

vi.mock("sonner", () => ({ toast: mocks.toast }));

vi.mock("@ricky0123/vad-react", () => ({
  useMicVAD: (options: { onSpeechEnd: (audio: Float32Array) => void }) => {
    mocks.onSpeechEnd = options.onSpeechEnd;
    return mocks.vad;
  },
}));

// AutoSpeechVad.tsx reads useApp() from @/contexts directly (:34).
vi.mock("@/contexts", () => ({
  useApp: () => ({
    selectedSttProvider: { provider: "openai", variables: {} },
    allSttProviders: [{ id: "openai" }],
  }),
}));

// Mocked WHOLE (not `...actual`): useTranslation is the only thing
// AutoSpeechVad.tsx needs from @/hooks (:35), and the real barrel's
// useApp -> useSystemAudio drags in vad-react, navigator.mediaDevices and
// AudioContext, none of which this suite stubs.
vi.mock("@/hooks", () => ({
  useTranslation: () => ({ translate: vi.fn(), isEnabled: false }),
}));

// Deep-imported (not the @/lib barrel): AutoSpeechVad.tsx does
// `import { fetchSTT } from '@/lib'`, which re-exports from
// `@/lib/functions/stt.function` - mocking this exact module id intercepts it
// without needing to stub every other @/lib export.
//
// Spread the real module rather than returning a bare { fetchSTT }:
// isUsableTranscription lives in this same module, so a whole-module factory
// would hand AutoSpeechVad.tsx `undefined` for it and every onSpeechEnd case
// below would die in the catch instead of exercising the branch under test.
vi.mock("@/lib/functions/stt.function", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  fetchSTT: mocks.fetchSTT,
}));

// The real @/lib barrel loads for AutoSpeechVad.tsx's fetchSTT import, and it
// reaches Tauri at module scope.
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

import { AutoSpeechVAD } from "@/pages/app/components/completion/AutoSpeechVad";

const baseProps = () => ({
  submit: vi.fn(),
  setState: vi.fn(),
  setEnableVAD: vi.fn(),
  microphoneDeviceId: "mic-1",
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.vad.errored = false;
  mocks.vad.listening = false;
  mocks.vad.loading = false;
  mocks.vad.userSpeaking = false;
  mocks.onSpeechEnd = undefined;
});

describe("AutoSpeechVAD - failed mic start", () => {
  it("toasts once per mount when the VAD failed to initialise", () => {
    mocks.vad.errored = "Permission denied";
    mocks.vad.listening = false;
    mocks.vad.loading = false;

    const props = baseProps();
    const { rerender } = render(<AutoSpeechVAD {...props} />);
    rerender(<AutoSpeechVAD {...props} />);

    expect(mocks.toast.error).toHaveBeenCalledTimes(1);
  });

  it("does not toast merely because the mic is not listening yet", () => {
    mocks.vad.errored = false;
    mocks.vad.listening = false;
    mocks.vad.loading = true;

    render(<AutoSpeechVAD {...baseProps()} />);

    expect(mocks.toast.error).not.toHaveBeenCalled();
  });
});

/** Drives one speech segment through the real onSpeechEnd. */
const speak = async () => {
  expect(mocks.onSpeechEnd).toBeDefined();
  await act(async () => {
    await mocks.onSpeechEnd!(new Float32Array([0.1, 0.2, 0.3]));
  });
};

/** Applies setState's updater to a bare state so the result is inspectable. */
const stateAfter = (setState: ReturnType<typeof vi.fn>) => {
  expect(setState).toHaveBeenCalledTimes(1);
  const updater = setState.mock.calls[0][0];
  expect(typeof updater).toBe("function");
  return updater({ error: null, response: "" });
};

// The two halves are deliberately asymmetric. Meeting mode must stay
// silent-and-dropped: writing there would forge a "You" line into
// meetingTranscript and its autosave. The transcribing path has no other
// signal at all - fetchSTT RESOLVES these strings, so the component's catch
// never runs - so it must report.
describe("AutoSpeechVAD - a failing mic-side STT provider does not poison the transcript", () => {
  it('meeting mode: fetchSTT resolving "Meetwings STT Error: 401" is dropped silently', async () => {
    mocks.fetchSTT.mockResolvedValue("Meetwings STT Error: 401");

    const addMeetingTranscript = vi.fn();
    const props = {
      ...baseProps(),
      meetingAssistMode: true,
      addMeetingTranscript,
    };
    render(<AutoSpeechVAD {...props} />);

    await speak();

    expect(addMeetingTranscript).not.toHaveBeenCalled();
    expect(props.submit).not.toHaveBeenCalled();
    // Silent: no error surface on this half, by design.
    expect(props.setState).not.toHaveBeenCalled();
  });

  it("transcribing mode: the same resolved sentinel is surfaced, not submitted", async () => {
    mocks.fetchSTT.mockResolvedValue("Meetwings STT Error: 401");

    const addMeetingTranscript = vi.fn();
    const props = {
      ...baseProps(),
      meetingAssistMode: false,
      addMeetingTranscript,
    };
    render(<AutoSpeechVAD {...props} />);

    await speak();

    // Not fed to the AI as if it were speech...
    expect(props.submit).not.toHaveBeenCalled();
    expect(addMeetingTranscript).not.toHaveBeenCalled();
    // ...but the user is told their provider is failing. state.error forces
    // the popover open (useCompletion.ts:1811) and renders at Input.tsx:230.
    expect(stateAfter(props.setState)).toEqual({
      error: "Meetwings STT Error: 401",
      response: "",
    });
  });

  it("transcribing mode: silence is not reported as an error", async () => {
    // A VAD segment that transcribed to nothing is silence or noise, not a
    // provider failure - reporting it would put an error banner on the screen
    // every time the user paused.
    mocks.fetchSTT.mockResolvedValue("   ");

    const props = { ...baseProps(), meetingAssistMode: false };
    render(<AutoSpeechVAD {...props} />);

    await speak();

    expect(props.submit).not.toHaveBeenCalled();
    expect(props.setState).not.toHaveBeenCalled();
  });
});
