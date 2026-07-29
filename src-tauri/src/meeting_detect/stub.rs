//! Non-Windows placeholder. The commands are registered on every target so they
//! can return a clear "unsupported platform" error rather than being missing.

use super::{SessionInfo, UNSUPPORTED_PLATFORM};

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub fn enumerate_capture_sessions() -> Result<Vec<SessionInfo>, String> {
    Err(UNSUPPORTED_PLATFORM.to_string())
}
