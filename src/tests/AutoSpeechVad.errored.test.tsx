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
// AudioContext, none of which this suite stubs. This mock only covers the
// "@/hooks" module id, so AutoSpeechVad.tsx's OWN
// `import { isUsableTranscription } from "@/hooks/useMeetingAudio"` (a
// different, deep module id) still resolves to the real implementation.
vi.mock("@/hooks", () => ({
  useTranslation: () => ({ translate: vi.fn(), isEnabled: false }),
}));

// Deep-imported (not the @/lib barrel): both AutoSpeechVad.tsx and the real
// @/hooks/useMeetingAudio (pulled in for isUsableTranscription) do
// `import { fetchSTT } from '@/lib'`, which re-exports from
// `@/lib/functions/stt.function` - mocking this exact module id intercepts
// both without needing to stub every other @/lib export.
vi.mock("@/lib/functions/stt.function", () => ({ fetchSTT: mocks.fetchSTT }));

// @/hooks/useMeetingAudio also imports these two at module scope.
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

describe("AutoSpeechVAD - a failing mic-side STT provider does not poison the transcript", () => {
  it('fetchSTT resolving "Meetwings STT Error: 401" is never written or submitted', async () => {
    mocks.fetchSTT.mockResolvedValue("Meetwings STT Error: 401");

    const addMeetingTranscript = vi.fn();
    const props = {
      ...baseProps(),
      meetingAssistMode: true,
      addMeetingTranscript,
    };
    render(<AutoSpeechVAD {...props} />);

    expect(mocks.onSpeechEnd).toBeDefined();
    await act(async () => {
      await mocks.onSpeechEnd!(new Float32Array([0.1, 0.2, 0.3]));
    });

    expect(addMeetingTranscript).not.toHaveBeenCalled();
    expect(props.submit).not.toHaveBeenCalled();
  });
});
