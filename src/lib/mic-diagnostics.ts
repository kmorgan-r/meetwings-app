import { invoke } from "@tauri-apps/api/core";

/**
 * Logs every microphone this webview opens to detection.log (#114): the voice
 * processing WebKit actually applied (echo cancellation, gain control, noise
 * suppression) and the rate. Release builds have no console, and how many
 * times the mic opens, and with what, is evidence for the Mac lag report.
 */
export function logMicOpens(windowLabel: string): void {
  const devices = navigator.mediaDevices;
  if (!devices?.getUserMedia) return;
  const open = devices.getUserMedia.bind(devices);
  devices.getUserMedia = async (constraints) => {
    const stream = await open(constraints);
    const s = stream.getAudioTracks()[0]?.getSettings();
    if (s) {
      const line =
        `mic open window=${windowLabel} ec=${s.echoCancellation} ` +
        `agc=${s.autoGainControl} ns=${s.noiseSuppression} ` +
        `sr=${s.sampleRate} ch=${s.channelCount}`;
      invoke("log_detection", { line }).catch(() => {});
    }
    return stream;
  };
}
