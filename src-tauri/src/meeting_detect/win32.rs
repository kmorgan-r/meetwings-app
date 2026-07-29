//! WASAPI capture-session enumeration.
//!
//! Every poll re-resolves the endpoints and rebuilds the enumerator. Caching an
//! IMMDevice across polls would survive a mid-call device change as a stale
//! interface that either fails forever or returns an empty list - and an empty
//! list reads as "the call ended".
//!
//! Callers must have COM initialized (CoInitializeEx) on the calling thread
//! before invoking enumerate_capture_sessions; otherwise CoCreateInstance fails
//! with CO_E_NOTINITIALIZED.

use super::{image_name_from_path, SessionInfo};
use windows::core::Interface;
use windows::Win32::Foundation::CloseHandle;
use windows::Win32::Media::Audio::{
    eCapture, AudioSessionStateActive, IAudioSessionControl2, IAudioSessionManager2,
    IMMDeviceEnumerator, MMDeviceEnumerator, DEVICE_STATE_ACTIVE,
};
use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_ALL};
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_FORMAT, PROCESS_QUERY_LIMITED_INFORMATION,
};

/// Resolve a PID to its bare process image name.
///
/// Failure is routine and not an error: the process may have exited between
/// enumeration and OpenProcess, or be protected/elevated. Callers record None.
unsafe fn process_image_name(pid: u32) -> Option<String> {
    if pid == 0 {
        return None;
    }
    let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;

    let mut buffer = [0u16; 260];
    let mut size = buffer.len() as u32;
    let result = QueryFullProcessImageNameW(
        handle,
        PROCESS_NAME_FORMAT(0),
        windows::core::PWSTR(buffer.as_mut_ptr()),
        &mut size,
    );
    let _ = CloseHandle(handle);
    result.ok()?;

    let full_path = String::from_utf16_lossy(&buffer[..size as usize]);
    image_name_from_path(&full_path)
}

pub fn enumerate_capture_sessions() -> Result<Vec<SessionInfo>, String> {
    unsafe {
        let enumerator: IMMDeviceEnumerator =
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)
                .map_err(|e| format!("Failed to create device enumerator: {}", e))?;

        // All active capture endpoints, not just the default: Teams lets the user
        // pick a microphone independently of the OS default, and watching only the
        // default endpoint silently misses every headset user.
        let devices = enumerator
            .EnumAudioEndpoints(eCapture, DEVICE_STATE_ACTIVE)
            .map_err(|e| format!("Failed to enumerate capture endpoints: {}", e))?;
        let device_count = devices
            .GetCount()
            .map_err(|e| format!("Failed to count capture endpoints: {}", e))?;

        let mut sessions = Vec::new();

        for device_index in 0..device_count {
            let device = match devices.Item(device_index) {
                Ok(d) => d,
                Err(e) => {
                    tracing::debug!("Skipping capture endpoint {}: {}", device_index, e);
                    continue;
                }
            };

            let manager: IAudioSessionManager2 = match device.Activate(CLSCTX_ALL, None) {
                Ok(m) => m,
                Err(e) => {
                    tracing::debug!("Skipping endpoint {} session manager: {}", device_index, e);
                    continue;
                }
            };

            let session_enumerator = match manager.GetSessionEnumerator() {
                Ok(s) => s,
                Err(e) => {
                    tracing::debug!(
                        "Skipping endpoint {} session enumerator: {}",
                        device_index,
                        e
                    );
                    continue;
                }
            };
            let session_count = session_enumerator.GetCount().unwrap_or(0);

            for session_index in 0..session_count {
                let Ok(control) = session_enumerator.GetSession(session_index) else {
                    continue;
                };
                let Ok(control2) = control.cast::<IAudioSessionControl2>() else {
                    continue;
                };
                let Ok(pid) = control2.GetProcessId() else {
                    continue;
                };
                let active = control2
                    .GetState()
                    .map(|s| s == AudioSessionStateActive)
                    .unwrap_or(false);

                sessions.push(SessionInfo {
                    pid,
                    image_name: process_image_name(pid),
                    active,
                });
            }
        }

        Ok(sessions)
    }
}
