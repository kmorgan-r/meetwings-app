//! Microsoft Teams call detection via WASAPI capture-session polling.
//!
//! All decision logic lives here as pure functions with no COM dependency, so it
//! compiles and is unit-tested on every target including the Linux CI runner.
//! `win32.rs` / `stub.rs` contribute only session enumeration.

#[cfg(target_os = "windows")]
mod win32;
#[cfg(target_os = "windows")]
use win32::enumerate_capture_sessions;

#[cfg(not(target_os = "windows"))]
mod stub;
#[cfg(not(target_os = "windows"))]
use stub::enumerate_capture_sessions;

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

/// Two consecutive Active polls (~4s) enter a call.
const START_DEBOUNCE: u32 = 2;
/// Three consecutive Inactive polls (~6s) end it. Survives a short reconnect.
const END_DEBOUNCE: u32 = 3;
/// 30 consecutive failed polls (~60s) is terminal. Deliberately far clear of
/// END_DEBOUNCE so a brief COM hiccup mid-meeting cannot truncate a call.
const FAILURE_LIMIT: u32 = 30;
/// 15 consecutive Unknown polls (~30s) is degraded but NOT terminal. Covers the
/// host where OpenProcess is denied for every session: sessions enumerate,
/// nothing ever resolves, so no poll ever "fails" and detection can never fire.
const UNKNOWN_LIMIT: u32 = 15;

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PollOutcome {
    /// A poll that ran and observed something.
    Classified(PollResult),
    /// A poll that could not run at all: endpoint resolution or enumeration
    /// errored, or the poll body panicked.
    Failed,
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WatcherEvent {
    Detected(String),
    Ended(String),
    Degraded(String),
    Stopped(String),
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MachineState {
    in_call: bool,
    /// Image name of the call currently in progress, so `meeting-ended` can
    /// carry it and the frontend never has to remember it across a reload.
    current_process: Option<String>,
    active_streak: u32,
    inactive_streak: u32,
    failure_streak: u32,
    unknown_streak: u32,
    degraded_reported: bool,
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn step(mut state: MachineState, outcome: PollOutcome) -> (MachineState, Option<WatcherEvent>) {
    match outcome {
        PollOutcome::Failed => {
            // Holds state: preserves BOTH debounce counters and the unknown
            // counter. Only the failure counter advances.
            state.failure_streak += 1;
            if state.failure_streak >= FAILURE_LIMIT {
                let event = WatcherEvent::Stopped(format!(
                    "{} consecutive failed polls",
                    state.failure_streak
                ));
                return (state, Some(event));
            }
            (state, None)
        }

        PollOutcome::Classified(result) => {
            // Any classified poll is an observation, so the failure streak resets.
            state.failure_streak = 0;

            match result {
                PollResult::Unknown => {
                    // Holds state: preserves both debounce counters.
                    state.unknown_streak += 1;
                    if state.unknown_streak >= UNKNOWN_LIMIT && !state.degraded_reported {
                        state.degraded_reported = true;
                        let event = WatcherEvent::Degraded(
                            "audio sessions are present but none can be identified".to_string(),
                        );
                        return (state, Some(event));
                    }
                    (state, None)
                }

                PollResult::Active(name) => {
                    state.unknown_streak = 0;
                    state.degraded_reported = false;
                    state.inactive_streak = 0;

                    if state.in_call {
                        return (state, None);
                    }

                    state.active_streak += 1;
                    if state.active_streak >= START_DEBOUNCE {
                        state.in_call = true;
                        state.active_streak = 0;
                        state.current_process = Some(name.clone());
                        return (state, Some(WatcherEvent::Detected(name)));
                    }
                    (state, None)
                }

                PollResult::Inactive => {
                    state.unknown_streak = 0;
                    state.degraded_reported = false;
                    state.active_streak = 0;

                    if !state.in_call {
                        return (state, None);
                    }

                    state.inactive_streak += 1;
                    if state.inactive_streak >= END_DEBOUNCE {
                        state.in_call = false;
                        state.inactive_streak = 0;
                        let name = state.current_process.take().unwrap_or_default();
                        return (state, Some(WatcherEvent::Ended(name)));
                    }
                    (state, None)
                }
            }
        }
    }
}

use std::sync::atomic::{AtomicBool, Ordering};

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StartAction {
    Spawn,
    UpdateWatchList,
    Retryable(&'static str),
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StopAction {
    Nothing,
    Signal,
    ReapCorpse,
    AlreadyStopping,
}

/// `stopping` is read from an explicit state flag, never derived from whether a
/// generation is in the slot: `stop_meeting_watcher` removes the generation
/// before it waits, so a slot-derived rule could never observe a stop in flight
/// and `Retryable` would be dead code.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn plan_start(running: bool, stopping: bool) -> StartAction {
    match (running, stopping) {
        (false, _) => StartAction::Spawn,
        (true, true) => StartAction::Retryable("watcher is still stopping, retry"),
        (true, false) => StartAction::UpdateWatchList,
    }
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn plan_stop(running: bool, has_generation: bool) -> StopAction {
    match (running, has_generation) {
        (false, false) => StopAction::Nothing,
        (true, true) => StopAction::Signal,
        (true, false) => StopAction::AlreadyStopping,
        (false, true) => StopAction::ReapCorpse,
    }
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn apply_spawn_outcome(running: &AtomicBool, spawned: Result<(), ()>) -> Result<(), String> {
    match spawned {
        Ok(()) => Ok(()),
        Err(()) => {
            running.store(false, Ordering::SeqCst);
            Err("failed to spawn the meeting detection thread".to_string())
        }
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

    fn active() -> PollOutcome {
        PollOutcome::Classified(PollResult::Active("ms-teams.exe".to_string()))
    }
    fn inactive() -> PollOutcome {
        PollOutcome::Classified(PollResult::Inactive)
    }
    fn unknown() -> PollOutcome {
        PollOutcome::Classified(PollResult::Unknown)
    }
    fn failed() -> PollOutcome {
        PollOutcome::Failed
    }

    /// Feed a sequence and collect every emitted event.
    fn run(seq: Vec<PollOutcome>) -> (MachineState, Vec<WatcherEvent>) {
        let mut state = MachineState::default();
        let mut events = Vec::new();
        for outcome in seq {
            let (next, event) = step(state, outcome);
            state = next;
            if let Some(e) = event {
                events.push(e);
            }
        }
        (state, events)
    }

    // R1
    #[test]
    fn start_debounce_is_two_polls_and_fires_once() {
        let (_, one) = run(vec![active()]);
        assert!(one.is_empty(), "a single Active poll must not transition");

        let (_, two) = run(vec![active(), active()]);
        assert_eq!(
            two,
            vec![WatcherEvent::Detected("ms-teams.exe".to_string())]
        );

        let (_, four) = run(vec![active(), active(), active(), active()]);
        assert_eq!(four.len(), 1, "emitted on the transition only");
    }

    // R2
    #[test]
    fn end_debounce_is_three_polls_and_fires_once() {
        let base = vec![active(), active()];

        let mut two_inactive = base.clone();
        two_inactive.extend([inactive(), inactive()]);
        let (_, events) = run(two_inactive);
        assert_eq!(events.len(), 1, "two Inactive polls must not end the call");

        let mut three_inactive = base.clone();
        three_inactive.extend([inactive(), inactive(), inactive()]);
        let (_, events) = run(three_inactive);
        assert_eq!(
            events,
            vec![
                WatcherEvent::Detected("ms-teams.exe".to_string()),
                WatcherEvent::Ended("ms-teams.exe".to_string()),
            ]
        );

        let mut five_inactive = base;
        five_inactive.extend([inactive(), inactive(), inactive(), inactive(), inactive()]);
        let (_, events) = run(five_inactive);
        assert_eq!(events.len(), 2, "emitted on the transition only");
    }

    // R3 — the reconnect case
    #[test]
    fn active_poll_resets_the_end_counter() {
        let (_, events) = run(vec![
            active(),
            active(),
            inactive(),
            inactive(),
            active(),
            inactive(),
            inactive(),
        ]);
        assert_eq!(
            events.len(),
            1,
            "only the Detected event; the call never ended"
        );
    }

    // R4
    #[test]
    fn unknown_and_failed_hold_state_and_preserve_counters() {
        let (_, events) = run(vec![
            active(),
            active(),
            unknown(),
            unknown(),
            unknown(),
            failed(),
            failed(),
            failed(),
        ]);
        assert_eq!(
            events.len(),
            1,
            "COM trouble during a call must never end it"
        );

        let (_, events) = run(vec![active(), unknown(), active()]);
        assert_eq!(
            events,
            vec![WatcherEvent::Detected("ms-teams.exe".to_string())],
            "Unknown preserves the start counter, so this is two consecutive Actives"
        );
    }

    // R5
    #[test]
    fn unknown_counter_degrades_at_fifteen_once_per_episode() {
        let (_, events) = run(vec![unknown(); 14]);
        assert!(events.is_empty(), "14 Unknown polls are not degraded yet");

        let (_, events) = run(vec![unknown(); 15]);
        assert_eq!(events.len(), 1);
        assert!(matches!(events[0], WatcherEvent::Degraded(_)));

        let (_, events) = run(vec![unknown(); 30]);
        assert_eq!(
            events.len(),
            1,
            "once per episode, not every poll from 15 on"
        );

        let mut reset = vec![unknown(); 14];
        reset.push(inactive());
        reset.extend(vec![unknown(); 14]);
        let (_, events) = run(reset);
        assert!(events.is_empty(), "an Inactive poll re-arms the counter");

        // Cross-episode re-arm: Inactive must clear degraded_reported too, not
        // just unknown_streak. A wrong impl that resets the counter on Inactive
        // but never clears degraded_reported passes every assertion above and
        // then silently suppresses every Degraded after the first in the field.
        let mut second = vec![unknown(); 15];
        second.push(inactive());
        second.extend(vec![unknown(); 15]);
        let (_, events) = run(second);
        assert_eq!(
            events.len(),
            2,
            "Inactive re-arms degraded_reported so a second episode fires again"
        );
        assert!(events
            .iter()
            .all(|e| matches!(e, WatcherEvent::Degraded(_))));
    }

    // R6
    #[test]
    fn failure_counter_terminates_at_thirty_and_unknown_does_not_reset_it() {
        let (_, events) = run(vec![failed(); 29]);
        assert!(events.is_empty(), "29 failures are not terminal");

        let (_, events) = run(vec![failed(); 30]);
        assert_eq!(events.len(), 1);
        assert!(matches!(events[0], WatcherEvent::Stopped(_)));

        let mut with_success = vec![failed(); 29];
        with_success.push(inactive());
        with_success.push(failed());
        let (_, events) = run(with_success);
        assert!(
            events.is_empty(),
            "a classified poll resets the failure counter"
        );

        let mut with_unknown = vec![failed(); 29];
        with_unknown.push(unknown());
        with_unknown.push(failed());
        let (_, events) = run(with_unknown);
        assert!(
            events.is_empty(),
            "Classified(Unknown) is an observation, so it resets the failure counter"
        );

        // Alternating: neither counter may stall. Failed must PRESERVE the unknown
        // counter (not reset it), or this sequence advances nothing forever and the
        // settings card reports healthy on a machine where detection can never fire.
        let alternating: Vec<PollOutcome> =
            (0..30).flat_map(|_| vec![unknown(), failed()]).collect();
        let (_, events) = run(alternating);
        assert!(
            events
                .iter()
                .any(|e| matches!(e, WatcherEvent::Degraded(_))),
            "an alternating Unknown/Failed run must still reach Degraded"
        );
    }

    // R13
    #[test]
    fn plan_start_spawns_when_not_running() {
        assert_eq!(plan_start(false, false), StartAction::Spawn);
        assert_eq!(
            plan_start(false, true),
            StartAction::Spawn,
            "a stale stopping flag with nothing running still spawns"
        );
    }

    // R14 — the two-concurrent-threads regression test
    #[test]
    fn plan_start_is_retryable_while_a_stop_is_in_flight() {
        assert!(matches!(plan_start(true, true), StartAction::Retryable(_)));
        // Spawning here would leave two poll threads alive emitting duplicate
        // events, and whichever exited first would clear `running` out from
        // under the other.
        assert_ne!(plan_start(true, true), StartAction::Spawn);
    }

    // R15
    #[test]
    fn plan_start_is_idempotent_when_already_running() {
        assert_eq!(plan_start(true, false), StartAction::UpdateWatchList);
    }

    // R16
    #[test]
    fn plan_stop_covers_all_four_states() {
        assert_eq!(plan_stop(false, false), StopAction::Nothing);
        assert_eq!(plan_stop(true, true), StopAction::Signal);
        assert_eq!(
            plan_stop(true, false),
            StopAction::AlreadyStopping,
            "the post-TimedOut state: must not report NotRunning, which the \
             frontend would read as success while a live thread keeps polling"
        );
        assert_eq!(
            plan_stop(false, true),
            StopAction::ReapCorpse,
            "a terminal exit leaves the generation in the slot; join and drop it"
        );
    }

    // R17
    #[test]
    fn apply_spawn_outcome_rolls_running_back_on_failure() {
        use std::sync::atomic::{AtomicBool, Ordering};

        let running = AtomicBool::new(true);
        assert!(apply_spawn_outcome(&running, Err(())).is_err());
        assert!(
            !running.load(Ordering::SeqCst),
            "a failed spawn must not leave running=true with no thread, or every \
             later start returns Ok(()) with nothing polling"
        );

        let running = AtomicBool::new(true);
        assert!(apply_spawn_outcome(&running, Ok(())).is_ok());
        assert!(running.load(Ordering::SeqCst));
    }
}
