//! Mac mic-session enumeration through Core Audio process objects.
//!
//! Only the reads live here; mapping and probe classification are the pure
//! functions in `mac_logic.rs`. Needs no per-thread setup (no COM equivalent).

use cidre::{arc, cf, core_audio as ca};

use super::mac_logic::{probe_verdict, sessions_from_processes, RawProcess};
use super::SessionInfo;

fn exe_path(pid: u32) -> Option<String> {
    let mut buf = [0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
    // SAFETY: `buf` is a live, writable array of exactly `buf.len()` bytes, and
    // that length is passed as `buffersize`, so proc_pidpath cannot write past it.
    let n = unsafe { libc::proc_pidpath(pid as i32, buf.as_mut_ptr().cast(), buf.len() as u32) };
    if n <= 0 {
        return None;
    }
    Some(String::from_utf8_lossy(&buf[..n as usize]).into_owned())
}

pub fn enumerate_capture_sessions() -> Result<Vec<SessionInfo>, String> {
    let procs = ca::System::processes().map_err(|e| format!("Core Audio process list: {e:?}"))?;
    let raw = procs
        .iter()
        .map(|p| {
            let pid = p.pid().ok().and_then(|v| u32::try_from(v).ok());
            RawProcess {
                pid,
                running_input: p.is_running_input().ok(),
                // Not `p.bundle_id()`: it would wrap a NULL string in an `arc::R`.
                bundle_id: p
                    .prop::<Option<arc::R<cf::String>>>(
                        &ca::PropSelector::PROCESS_BUNDLE_ID.global_addr(),
                    )
                    .ok()
                    .flatten()
                    .map(|s| s.to_string()),
                exe_path: pid.and_then(exe_path),
            }
        })
        .collect();
    sessions_from_processes(raw)
}

pub fn probe() -> Result<(), String> {
    let has_list = ca::System::OBJ.has_prop(&ca::PropSelector::HW_PROCESS_OBJ_LIST.global_addr());
    let has_taps = ca::System::OBJ.has_prop(&ca::PropSelector::HW_TAP_LIST.global_addr());
    let read = if has_list {
        ca::System::processes()
            .map(|_| ())
            .map_err(|e| format!("{e:?}"))
    } else {
        Ok(())
    };
    probe_verdict(has_list, has_taps, read)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn probe_passes_on_this_runner() {
        assert_eq!(probe(), Ok(()));
    }

    #[test]
    fn enumerate_works_on_this_runner() {
        assert!(enumerate_capture_sessions().is_ok());
    }
}
