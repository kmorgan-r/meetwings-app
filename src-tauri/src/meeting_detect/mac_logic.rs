use super::{image_name_from_path, SessionInfo};

/// One Core Audio process-object read, already extracted from the API result.
/// `None` means the read failed or there was no value.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct RawProcess {
    pub pid: Option<u32>,
    pub running_input: Option<bool>,
    pub bundle_id: Option<String>,
    pub exe_path: Option<String>,
}

/// A per-process input read failed on every listed process. An empty `Ok` here
/// would look like a healthy "no call" forever, so the poll loop treats it as a
/// failed read (its `FAILURE_LIMIT` path stops the watcher after 60 s).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(super) const INPUT_STATE_UNREADABLE: &str =
    "Couldn't read which Mac apps are using the microphone";

/// The probe's floor: the process-tap API (`kAudioHardwarePropertyTapList`) is
/// macOS 14.2; the process-object list (`kAudioHardwarePropertyProcessObjectList`)
/// is 14.0. Both come from `API_AVAILABLE` in CoreAudio's `AudioHardware.h`.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(super) const UNSUPPORTED_MACOS: &str = "Auto-record needs macOS 14.2 or later";

/// A trial read failed on an otherwise supported system: retryable.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(super) const AUDIO_READ_FAILED: &str = "Couldn't read the Mac's audio system, try again";

/// Map raw per-process reads into `SessionInfo` entries.
///
/// Skips a process whose `pid` or `running_input` read failed, or that is not
/// using the microphone. If every read failed, the result is an error rather
/// than an empty list, so the watcher never mistakes it for "no call".
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(super) fn sessions_from_processes(procs: Vec<RawProcess>) -> Result<Vec<SessionInfo>, String> {
    if !procs.is_empty() && !procs.iter().any(|p| p.running_input.is_some()) {
        return Err(INPUT_STATE_UNREADABLE.to_string());
    }
    Ok(procs
        .into_iter()
        .filter(|p| p.pid.is_some() && p.running_input == Some(true))
        .map(|p| SessionInfo {
            pid: p.pid.unwrap_or(0),
            image_name: p
                .bundle_id
                .map(|b| b.trim().to_string())
                .filter(|b| !b.is_empty())
                .or_else(|| p.exe_path.as_deref().and_then(image_name_from_path)),
            active: true,
        })
        .collect())
}

/// Classify a support probe: both property checks must pass, then a trial read
/// may still fail retryably (its message is appended, never mistaken for an
/// old-macOS verdict).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(super) fn probe_verdict(
    has_process_list: bool,
    has_tap_list: bool,
    trial_read: Result<(), String>,
) -> Result<(), String> {
    if !has_process_list || !has_tap_list {
        return Err(UNSUPPORTED_MACOS.to_string());
    }
    trial_read.map_err(|e| format!("{AUDIO_READ_FAILED} ({e})"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn raw(
        pid: Option<u32>,
        input: Option<bool>,
        bundle: Option<&str>,
        exe: Option<&str>,
    ) -> RawProcess {
        RawProcess {
            pid,
            running_input: input,
            bundle_id: bundle.map(str::to_string),
            exe_path: exe.map(str::to_string),
        }
    }
    fn ok(procs: Vec<RawProcess>) -> Vec<SessionInfo> {
        sessions_from_processes(procs).expect("readable")
    }
    const HELPER: &str =
        "/Applications/Google Chrome.app/Contents/Frameworks/x/Google Chrome Helper";

    #[test]
    fn maps_the_raw_bundle_id() {
        let s = ok(vec![raw(
            Some(7),
            Some(true),
            Some("com.google.Chrome.helper"),
            None,
        )]);
        assert_eq!(
            (s[0].pid, s[0].image_name.as_deref(), s[0].active),
            (7, Some("com.google.Chrome.helper"), true)
        );
    }

    #[test]
    fn missing_empty_or_failed_bundle_id_falls_back_to_exe_name() {
        for bundle in [None, Some(""), Some("  ")] {
            let s = ok(vec![raw(Some(7), Some(true), bundle, Some(HELPER))]);
            assert_eq!(s.len(), 1, "the process stays listed");
            assert_eq!(s[0].image_name.as_deref(), Some("Google Chrome Helper"));
        }
    }

    #[test]
    fn no_bundle_and_no_exe_gives_none_but_stays_listed() {
        let s = ok(vec![raw(Some(7), Some(true), None, None)]);
        assert_eq!(s.len(), 1);
        assert_eq!(s[0].image_name, None);
    }

    #[test]
    fn a_process_not_running_input_is_left_out() {
        assert!(ok(vec![raw(
            Some(7),
            Some(false),
            Some("com.google.Chrome"),
            None
        )])
        .is_empty());
    }

    #[test]
    fn a_failed_pid_or_input_read_skips_only_that_process() {
        let s = ok(vec![
            raw(None, Some(true), Some("a.b"), None),
            raw(Some(2), None, Some("c.d"), None),
            raw(Some(3), Some(true), Some("e.f"), None),
        ]);
        assert_eq!(s.iter().map(|x| x.pid).collect::<Vec<_>>(), vec![3]);
    }

    #[test]
    fn every_input_read_failing_is_an_error_not_silence() {
        let got = sessions_from_processes(vec![
            raw(Some(1), None, Some("a.b"), None),
            raw(Some(2), None, Some("com.google.Chrome"), None),
        ]);
        assert_eq!(got.unwrap_err(), INPUT_STATE_UNREADABLE);
    }

    #[test]
    fn an_empty_process_list_is_ok_and_empty() {
        assert!(ok(vec![]).is_empty());
    }

    #[test]
    fn probe_is_unsupported_when_either_property_is_missing() {
        assert_eq!(
            probe_verdict(false, true, Ok(())),
            Err(UNSUPPORTED_MACOS.to_string())
        );
        assert_eq!(
            probe_verdict(true, false, Ok(())),
            Err(UNSUPPORTED_MACOS.to_string())
        );
    }

    #[test]
    fn probe_read_failure_is_retryable_never_unsupported() {
        let err = probe_verdict(true, true, Err("coreaudiod".into())).unwrap_err();
        assert_ne!(err, UNSUPPORTED_MACOS);
        assert!(err.starts_with(AUDIO_READ_FAILED) && err.contains("coreaudiod"));
    }

    #[test]
    fn probe_passes_on_a_supported_system() {
        assert_eq!(probe_verdict(true, true, Ok(())), Ok(()));
    }
}
