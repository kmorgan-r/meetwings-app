import { describe, expect, it, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import { logMicOpens } from "@/lib/mic-diagnostics";

describe("logMicOpens", () => {
  it("logs the processing the opened mic track actually got, and returns the stream", async () => {
    const stream = {
      getAudioTracks: () => [
        {
          getSettings: () => ({
            echoCancellation: true,
            autoGainControl: false,
            noiseSuppression: true,
            sampleRate: 48000,
            channelCount: 1,
          }),
        },
      ],
    } as unknown as MediaStream;
    const getUserMedia = vi.fn().mockResolvedValue(stream);
    Object.defineProperty(navigator, "mediaDevices", {
      value: { getUserMedia },
      configurable: true,
    });

    logMicOpens("main");
    const got = await navigator.mediaDevices.getUserMedia({ audio: true });

    expect(got).toBe(stream);
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true });
    expect(invokeMock).toHaveBeenCalledWith("log_detection", {
      line: "mic open window=main ec=true agc=false ns=true sr=48000 ch=1",
    });
  });
});
