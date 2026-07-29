//! Microsoft Teams call detection via WASAPI capture-session polling.
//!
//! All decision logic lives here as pure functions with no COM dependency, so it
//! compiles and is unit-tested on every target including the Linux CI runner.
//! `win32.rs` / `stub.rs` contribute only session enumeration.

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub const UNSUPPORTED_PLATFORM: &str = "Meeting detection is only supported on Windows";

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionInfo {
    pub pid: u32,
    pub image_name: Option<String>,
    pub active: bool,
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PollResult {
    Active(String),
    Inactive,
    Unknown,
}

/// Extract the file name from a Windows process image path.
///
/// `QueryFullProcessImageNameW` returns a full path; `classify` matches on the
/// bare image name, so this conversion is mandatory rather than cosmetic.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn image_name_from_path(path: &str) -> Option<String> {
    let name = path.rsplit(['\\', '/']).next().unwrap_or("");
    if name.is_empty() {
        None
    } else {
        Some(name.to_string())
    }
}

/// Decide what a single poll observed.
///
/// `Inactive` covers a successful enumeration that saw nothing — that is the
/// normal state the instant a call ends and Teams releases the microphone.
/// `Unknown` means sessions existed but none could be identified.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn classify(sessions: &[SessionInfo], watch_list: &[String], own_pid: u32) -> PollResult {
    let mut any_resolved = false;

    for session in sessions {
        let Some(name) = &session.image_name else {
            continue;
        };
        any_resolved = true;

        if session.active
            && session.pid != own_pid
            && watch_list.iter().any(|w| w.eq_ignore_ascii_case(name))
        {
            return PollResult::Active(name.clone());
        }
    }

    if !sessions.is_empty() && !any_resolved {
        PollResult::Unknown
    } else {
        PollResult::Inactive
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn watch() -> Vec<String> {
        vec!["ms-teams.exe".to_string(), "Teams.exe".to_string()]
    }

    fn session(pid: u32, name: Option<&str>, active: bool) -> SessionInfo {
        SessionInfo {
            pid,
            image_name: name.map(|n| n.to_string()),
            active,
        }
    }

    // R12
    #[test]
    fn image_name_from_path_extracts_basename() {
        assert_eq!(
            image_name_from_path(r"C:\Program Files\WindowsApps\MSTeams_x\ms-teams.exe"),
            Some("ms-teams.exe".to_string())
        );
        assert_eq!(
            image_name_from_path(r"C:\Windows\System32\MS-Teams.EXE"),
            Some("MS-Teams.EXE".to_string()),
            "case of the basename is preserved; classify does the case folding"
        );
        assert_eq!(
            image_name_from_path("Teams.exe"),
            Some("Teams.exe".to_string()),
            "a bare name with no separator returns itself"
        );
        assert_eq!(image_name_from_path(r"C:\Program Files\"), None);
        assert_eq!(image_name_from_path(""), None);
    }

    // R7 — the runaway-detection regression test. A successful enumeration that
    // returns nothing must be Inactive, never Unknown.
    #[test]
    fn empty_enumeration_is_inactive_not_unknown() {
        assert_eq!(classify(&[], &watch(), 100), PollResult::Inactive);
    }

    // R8
    #[test]
    fn present_but_inactive_session_is_inactive() {
        let sessions = [session(200, Some("ms-teams.exe"), false)];
        assert_eq!(classify(&sessions, &watch(), 100), PollResult::Inactive);
    }

    // R9
    #[test]
    fn matching_is_case_insensitive_but_exact() {
        let upper = [session(200, Some("MS-TEAMS.EXE"), true)];
        assert_eq!(
            classify(&upper, &watch(), 100),
            PollResult::Active("MS-TEAMS.EXE".to_string())
        );

        let classic = [session(201, Some("teams.exe"), true)];
        assert_eq!(
            classify(&classic, &watch(), 100),
            PollResult::Active("teams.exe".to_string()),
            "matches the second watch-list entry"
        );

        let hyphenless = [session(202, Some("MsTeams.exe"), true)];
        assert_eq!(
            classify(&hyphenless, &watch(), 100),
            PollResult::Inactive,
            "exact modulo case only - no fuzzy or separator-stripping matching"
        );
    }

    // R10
    #[test]
    fn unresolved_sessions_are_skipped_and_all_unresolved_is_unknown() {
        let mixed = [
            session(200, None, true),
            session(201, Some("ms-teams.exe"), true),
        ];
        assert_eq!(
            classify(&mixed, &watch(), 100),
            PollResult::Active("ms-teams.exe".to_string())
        );

        let none_resolved = [session(200, None, true), session(201, None, true)];
        assert_eq!(classify(&none_resolved, &watch(), 100), PollResult::Unknown);
    }

    // R11
    #[test]
    fn own_pid_is_excluded() {
        let sessions = [session(100, Some("ms-teams.exe"), true)];
        assert_eq!(
            classify(&sessions, &watch(), 100),
            PollResult::Inactive,
            "Meetwings must not be able to self-trigger"
        );
    }
}
