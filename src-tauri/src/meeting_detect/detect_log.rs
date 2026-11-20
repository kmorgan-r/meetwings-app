//! Append-only `detection.log` in the app data dir.
//!
//! Release builds have no console, so this file is the only record of why a
//! call stopped or failed to restart. It holds transitions only: process image
//! names, pids, session states, watcher events and the frontend's decisions,
//! plus system-audio capture start/stop, 10 s capture stats and clip sizes
//! (#114). No transcript and no calendar text. One line is `<epoch ms> <text>`.
//!
//! Writes never panic and never surface an error: the poll thread calls this
//! outside its catch_unwind, and a diagnostic must not be able to stop the
//! watcher it is diagnosing.

use super::{lock_recover, SessionInfo};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Manager};

const FILE_NAME: &str = "detection.log";
/// Past this the file is renamed to `detection.log.old` (one generation kept).
const MAX_BYTES: u64 = 1_000_000;

static PATH: OnceLock<Option<PathBuf>> = OnceLock::new();
/// Serializes the size check, rotation and append across the poll thread and
/// the frontend command.
static WRITE: Mutex<()> = Mutex::new(());

pub(crate) fn log_line(app: &AppHandle, line: &str) {
    let path = PATH.get_or_init(|| app.path().app_data_dir().ok().map(|d| d.join(FILE_NAME)));
    if let Some(path) = path {
        let _guard = lock_recover(&WRITE);
        let _ = append(path, line, MAX_BYTES);
    }
}

fn append(path: &Path, line: &str, max_bytes: u64) -> std::io::Result<()> {
    if fs::metadata(path).is_ok_and(|m| m.len() > max_bytes) {
        let _ = fs::rename(path, path.with_extension("log.old"));
    }
    let ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let mut file = OpenOptions::new().create(true).append(true).open(path)?;
    file.write_all(format!("{ms} {line}\n").as_bytes())
}

/// Every capture session but our own process, sorted so an unchanged set gives
/// an identical string: `chrome.exe/25836=A ?/412=I` (`?` = unresolved image,
/// A/I = active/inactive). A session that is gone is simply absent.
pub(super) fn session_signature(sessions: &[SessionInfo], own_pid: u32) -> String {
    let mut parts: Vec<String> = sessions
        .iter()
        .filter(|s| s.pid != own_pid)
        .map(|s| {
            format!(
                "{}/{}={}",
                s.image_name.as_deref().unwrap_or("?"),
                s.pid,
                if s.active { 'A' } else { 'I' }
            )
        })
        .collect();
    parts.sort();
    format!("sessions {}", parts.join(" "))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(pid: u32, name: Option<&str>, active: bool) -> SessionInfo {
        SessionInfo {
            pid,
            image_name: name.map(str::to_string),
            active,
        }
    }

    #[test]
    fn signature_is_order_independent_and_skips_own_pid() {
        let a = [
            s(9, Some("chrome.exe"), true),
            s(7, None, false),
            s(1, Some("meetwings.exe"), true),
        ];
        let b = [a[2].clone(), a[1].clone(), a[0].clone()];
        assert_eq!(session_signature(&a, 1), "sessions ?/7=I chrome.exe/9=A");
        assert_eq!(session_signature(&a, 1), session_signature(&b, 1));
        assert_eq!(session_signature(&[], 1), "sessions ");
    }

    #[test]
    fn append_rotates_past_the_cap() {
        let dir = std::env::temp_dir().join(format!("mw-detect-log-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join(FILE_NAME);

        // One line is ~18 bytes: the cap sits between one line and two.
        append(&path, "one", 30).unwrap();
        append(&path, "two", 30).unwrap();
        assert!(!path.with_extension("log.old").exists(), "under the cap");
        append(&path, "three", 30).unwrap();

        let old = fs::read_to_string(path.with_extension("log.old")).unwrap();
        let new = fs::read_to_string(&path).unwrap();
        assert!(old.ends_with(" two\n") && old.contains(" one\n"));
        assert!(new.ends_with(" three\n") && new.lines().count() == 1);
        let _ = fs::remove_dir_all(&dir);
    }
}
