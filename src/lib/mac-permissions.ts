// macOS only. The macOS permissions plugin is imported dynamically because a
// static import breaks the Windows build.
import { invoke } from "@tauri-apps/api/core";

/**
 * Whether the app holds the microphone permission.
 *
 * Fails open: if the check itself throws we log a warning and return true, so
 * that a broken permission check does not turn auto-record off at every launch.
 */
export async function hasMicGrant(): Promise<boolean> {
  try {
    const { checkMicrophonePermission } = await import(
      "tauri-plugin-macos-permissions-api"
    );
    return await checkMicrophonePermission();
  } catch (error) {
    console.warn("Could not check microphone permission:", error);
    return true;
  }
}

/**
 * Ask the user for microphone access through getUserMedia and stop every track
 * once granted.
 *
 * Returns false on any rejection (NotAllowedError, NotFoundError, ...) or when
 * navigator.mediaDevices is missing. We deliberately do not use the plugin's
 * request here: `request_microphone_permission` passes a nil completion handler
 * and returns before the user answers, while getUserMedia settles on the answer
 * and runs on the same WebKit path the auto-start opens.
 */
export async function requestMicAccess(): Promise<boolean> {
  try {
    if (!navigator.mediaDevices) return false;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    for (const track of stream.getTracks()) {
      track.stop();
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Ask for system-audio recording permission. Resolves null once granted, or the
 * rejection text (the Rust detail) when the command rejects.
 */
export async function requestSystemAudioAccess(): Promise<string | null> {
  try {
    await invoke("prime_system_audio_access");
    return null;
  } catch (error) {
    return String(error);
  }
}

/** Open the microphone pane of macOS privacy settings. */
export async function openMicSettings(): Promise<void> {
  await invoke("open_microphone_settings");
}

/** Open the screen & system audio pane of macOS privacy settings. */
export async function openSystemAudioSettings(): Promise<void> {
  await invoke("request_system_audio_access");
}
