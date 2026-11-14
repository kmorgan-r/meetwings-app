import { act, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// The exact onnxruntime instance vad-web builds its model with. vad-web's index
// does not re-export it, so this is the file that does (real-time-vad.js:35) -
// the same file vad-react's require chain loads, so the same instance.
import { ort } from "@ricky0123/vad-web/dist/real-time-vad";

// The REAL vad-react and vad-web run here. Only what they reach outside
// themselves is stubbed: the mic, Web Audio, the model download, and the
// onnxruntime session factory (no wasm in a unit test).

const mocks = vi.hoisted(() => ({ toast: { error: vi.fn() } }));
vi.mock("sonner", () => ({ toast: mocks.toast }));
vi.mock("@/contexts", () => ({
  useApp: () => ({
    selectedSttProvider: { provider: "openai", variables: {} },
    allSttProviders: [{ id: "openai" }],
  }),
}));
vi.mock("@/hooks", () => ({
  useTranslation: () => ({ translate: vi.fn(), isEnabled: false }),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

import { AutoSpeechVAD } from "@/pages/app/components/completion/AutoSpeechVad";

type ScriptNode = {
  onaudioprocess: ((e: unknown) => Promise<void>) | null;
  connect: () => void;
  disconnect: () => void;
};

let track: { stop: ReturnType<typeof vi.fn> };
let scriptNodes: ScriptNode[];
const session = {
  run: vi.fn(async (_inputs: Record<string, unknown>) => ({
    output: { data: [0.1] },
    hn: {},
    cn: {},
  })),
};
let create: ReturnType<typeof vi.spyOn>;

class FakeAudioContext {
  // 16 kHz so vad-web's resampler passes frames straight through.
  sampleRate = 16000;
  destination = {};
  close = vi.fn();
  // No `audioWorklet`: vad-web takes its ScriptProcessor fallback
  // (real-time-vad.js:245-283), which is plain JS this test can drive.
  createScriptProcessor() {
    const node: ScriptNode = { onaudioprocess: null, connect: vi.fn(), disconnect: vi.fn() };
    scriptNodes.push(node);
    return node;
  }
  createGain() {
    return { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() };
  }
}
class FakeSourceNode {
  connect = vi.fn();
  disconnect = vi.fn();
}

beforeEach(() => {
  vi.clearAllMocks();
  track = { stop: vi.fn() };
  scriptNodes = [];
  vi.stubGlobal("AudioContext", FakeAudioContext);
  vi.stubGlobal("MediaStreamAudioSourceNode", FakeSourceNode);
  // Only ever an `instanceof` target (destroy, real-time-vad.js:198): the
  // context has no `audioWorklet`, so the fallback is still taken.
  vi.stubGlobal("AudioWorkletNode", class {});
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ arrayBuffer: async () => new ArrayBuffer(1024) }))
  );
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [track] })) },
  });
  create = vi.spyOn(ort.InferenceSession, "create").mockResolvedValue(session as never);
});

afterEach(() => {
  create.mockRestore();
  vi.unstubAllGlobals();
});

const props = () => ({
  submit: vi.fn(),
  setState: vi.fn(),
  setEnableVAD: vi.fn(),
  microphoneDeviceId: "mic-1",
});

/** Mounts, waits until vad-react reports the mic listening, unmounts. */
async function micStartStop(onListening?: () => Promise<void>) {
  const { container, unmount } = render(<AutoSpeechVAD {...props()} />);
  await waitFor(() => expect(container.querySelector(".animate-pulse")).not.toBeNull());
  await onListening?.();
  unmount();
}

describe("AutoSpeechVAD - the VAD model session", () => {
  // Every enableVAD toggle and mic change remounts this component, and
  // vad-web 0.0.24 builds a new onnxruntime session per mount that destroy()
  // never releases. Ten meeting starts/stops used to mean ten live sessions.
  it("is built once across repeated mic starts, and every stop still releases the mic", async () => {
    const STARTS = 5;
    for (let i = 0; i < STARTS; i++) await micStartStop();

    expect(create).toHaveBeenCalledTimes(1);
    // Stream teardown is untouched: the OS mic indicator goes off on every stop.
    expect(track.stop).toHaveBeenCalledTimes(STARTS);
  });

  it("is the one a later mount actually runs its frames on", async () => {
    await micStartStop();
    await micStartStop(async () => {
      const node = scriptNodes[scriptNodes.length - 1];
      const samples = new Float32Array(4096);
      await act(async () => {
        await node.onaudioprocess!({
          inputBuffer: { getChannelData: () => samples },
          outputBuffer: { getChannelData: () => new Float32Array(4096) },
        });
      });
    });

    expect(create).toHaveBeenCalledTimes(1);
    expect(session.run).toHaveBeenCalled();
    // The silero legacy model's recurrent state rides in each call's inputs,
    // not in the session - which is what makes sharing the session safe.
    expect(Object.keys(session.run.mock.calls[0][0]).sort()).toEqual(["c", "h", "input", "sr"]);
  });

  it("is built again after a failed build rather than caching the failure", async () => {
    create.mockRejectedValueOnce(new Error("wasm fetch failed"));

    const first = render(<AutoSpeechVAD {...props()} />);
    await waitFor(() => expect(mocks.toast.error).toHaveBeenCalledTimes(1));
    first.unmount();

    await micStartStop();
    expect(create).toHaveBeenCalledTimes(2);
  });
});
