//! Calendar-gated meeting detection for Chrome (Google Meet).
//!
//! A second pure state machine, independent of `step` in `mod.rs`: Chrome's
//! capture sessions look exactly like a call's, so a candidate raised from
//! Chrome only counts once the frontend confirms it against the calendar.
//! Like `mod.rs`, all decision logic is pure and cfg-free - time arrives as
//! the `now_ms` argument, never as a clock, and there is no I/O here.

use super::START_DEBOUNCE;

/// Five consecutive Inactive polls (~10s) end a gated episode.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub(crate) const GATED_END_DEBOUNCE: u32 = 5;
/// A start within this window of a confirmed leave is confirmed at once.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub(crate) const CARRY_OVER_MS: i64 = 120_000;

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
#[derive(Debug, Clone)]
pub(crate) enum GatedInput {
    Active(String),
    Inactive,
    Hold,
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum GatedEvent {
    CandidateStarted(u64),
    CandidateEnded(u64),
    EnteredCall(String),
    LeftCall(String),
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
#[derive(Debug, Clone, Copy, Default, PartialEq)]
enum Phase {
    #[default]
    Idle,
    Candidate(u64),
    Confirmed(u64),
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct GatedState {
    phase: Phase,
    active_streak: u32,
    inactive_streak: u32,
    current_process: Option<String>,
    last_confirmed_end_ms: Option<i64>,
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
impl GatedState {
    /// `Some(e)` only while the phase is `Candidate(e)`.
    pub(crate) fn candidate_episode(&self) -> Option<u64> {
        match self.phase {
            Phase::Candidate(e) => Some(e),
            _ => None,
        }
    }
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub(crate) fn gated_step(
    mut state: GatedState,
    input: GatedInput,
    now_ms: i64,
    confirmed: Option<u64>,
    next_episode: &mut dyn FnMut() -> u64,
) -> (GatedState, Vec<GatedEvent>) {
    let mut events = Vec::new();
    let process = |s: &GatedState| s.current_process.clone().unwrap_or_default();

    // Pre-step, every input: a matching confirmation promotes the candidate.
    if let Phase::Candidate(e) = state.phase {
        if confirmed == Some(e) {
            state.phase = Phase::Confirmed(e);
            events.push(GatedEvent::EnteredCall(process(&state)));
        }
    }

    match (state.phase, input) {
        (_, GatedInput::Hold) => {}
        (Phase::Idle, GatedInput::Inactive) => state.active_streak = 0,
        (Phase::Idle, GatedInput::Active(name)) => {
            state.active_streak += 1;
            if state.active_streak >= START_DEBOUNCE {
                let e = next_episode();
                state.current_process = Some(name.clone());
                state.active_streak = 0;
                state.inactive_streak = 0;
                let carried = state
                    .last_confirmed_end_ms
                    .is_some_and(|t| (0..CARRY_OVER_MS).contains(&(now_ms - t)));
                if carried {
                    state.phase = Phase::Confirmed(e);
                    events.push(GatedEvent::EnteredCall(name));
                } else {
                    state.phase = Phase::Candidate(e);
                    events.push(GatedEvent::CandidateStarted(e));
                }
            }
        }
        (_, GatedInput::Active(_)) => state.inactive_streak = 0,
        (phase, GatedInput::Inactive) => {
            state.inactive_streak += 1;
            if state.inactive_streak >= GATED_END_DEBOUNCE {
                match phase {
                    Phase::Candidate(e) => events.push(GatedEvent::CandidateEnded(e)),
                    Phase::Confirmed(_) => {
                        state.last_confirmed_end_ms = Some(now_ms);
                        events.push(GatedEvent::LeftCall(process(&state)));
                    }
                    Phase::Idle => {}
                }
                state.phase = Phase::Idle;
                state.active_streak = 0;
                state.inactive_streak = 0;
            }
        }
    }
    (state, events)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn a(now_ms: i64, confirmed: Option<u64>) -> (GatedInput, i64, Option<u64>) {
        (
            GatedInput::Active("chrome.exe".to_string()),
            now_ms,
            confirmed,
        )
    }

    fn i(now_ms: i64, confirmed: Option<u64>) -> (GatedInput, i64, Option<u64>) {
        (GatedInput::Inactive, now_ms, confirmed)
    }

    fn h(now_ms: i64, confirmed: Option<u64>) -> (GatedInput, i64, Option<u64>) {
        (GatedInput::Hold, now_ms, confirmed)
    }

    /// Feed a sequence and collect every emitted event. The `next_episode`
    /// counter starts at 1, so the first transition of a run is episode 1.
    fn run_gated(seq: &[(GatedInput, i64, Option<u64>)]) -> (GatedState, Vec<GatedEvent>) {
        let mut state = GatedState::default();
        let mut events = Vec::new();
        let mut episode = 0u64;
        let mut next_episode = || {
            episode += 1;
            episode
        };
        for (input, now_ms, confirmed) in seq {
            let (next, emitted) =
                gated_step(state, input.clone(), *now_ms, *confirmed, &mut next_episode);
            state = next;
            events.extend(emitted);
        }
        (state, events)
    }

    #[test]
    fn candidate_after_two_active_polls() {
        let (_, one) = run_gated(&[a(0, None)]);
        assert!(one.is_empty(), "a single Active poll must not transition");

        let (_, two) = run_gated(&[a(0, None), a(2_000, None)]);
        assert_eq!(two, vec![GatedEvent::CandidateStarted(1)]);
    }

    #[test]
    fn three_poll_drop_does_not_end_a_gated_episode() {
        let (_, events) = run_gated(&[
            a(0, None),
            a(2_000, None),
            i(4_000, None),
            i(6_000, None),
            i(8_000, None),
            a(10_000, None),
        ]);
        assert_eq!(
            events,
            vec![GatedEvent::CandidateStarted(1)],
            "three Inactive polls do not end a gated episode"
        );
    }

    #[test]
    fn five_poll_drop_ends_an_unconfirmed_episode() {
        let (_, events) = run_gated(&[
            a(0, None),
            a(2_000, None),
            i(4_000, None),
            i(6_000, None),
            i(8_000, None),
            i(10_000, None),
            i(12_000, None),
        ]);
        assert_eq!(
            events,
            vec![
                GatedEvent::CandidateStarted(1),
                GatedEvent::CandidateEnded(1),
            ],
            "an unconfirmed episode ends with CandidateEnded only, never LeftCall"
        );
    }

    #[test]
    fn confirm_enters_the_call_and_leaving_emits_left_call() {
        let (_, events) = run_gated(&[
            a(0, None),
            a(2_000, None),
            a(4_000, Some(1)),
            i(6_000, None),
            i(8_000, None),
            i(10_000, None),
            i(12_000, None),
            i(14_000, None),
        ]);
        assert_eq!(
            events,
            vec![
                GatedEvent::CandidateStarted(1),
                GatedEvent::EnteredCall("chrome.exe".to_string()),
                GatedEvent::LeftCall("chrome.exe".to_string()),
            ]
        );
    }

    #[test]
    fn a_confirmation_for_another_episode_does_nothing() {
        let (_, events) = run_gated(&[
            a(0, Some(99)),
            a(2_000, Some(99)),
            a(4_000, Some(99)),
            a(6_000, Some(99)),
        ]);
        assert_eq!(
            events,
            vec![GatedEvent::CandidateStarted(1)],
            "a confirmation numbered for a different episode must not enter the call"
        );
    }

    #[test]
    fn a_confirmation_after_the_episode_ended_does_nothing() {
        let (_, events) = run_gated(&[
            a(0, None),
            a(2_000, None),
            i(4_000, None),
            i(6_000, None),
            i(8_000, None),
            i(10_000, None),
            i(12_000, None),
            a(14_000, Some(1)),
            a(16_000, Some(1)),
        ]);
        assert_eq!(
            events,
            vec![
                GatedEvent::CandidateStarted(1),
                GatedEvent::CandidateEnded(1),
                GatedEvent::CandidateStarted(2),
            ],
            "a stale confirmation must not enter the next episode"
        );
    }

    #[test]
    fn confirming_twice_enters_once() {
        let (_, events) = run_gated(&[
            a(0, None),
            a(2_000, None),
            a(4_000, Some(1)),
            a(6_000, Some(1)),
            a(8_000, Some(1)),
        ]);
        assert_eq!(
            events,
            vec![
                GatedEvent::CandidateStarted(1),
                GatedEvent::EnteredCall("chrome.exe".to_string()),
            ],
            "exactly one EnteredCall, on the transition only"
        );
    }

    #[test]
    fn hold_neither_resets_nor_advances_the_streaks() {
        let full = vec![
            a(0, None),
            a(2_000, None),
            i(4_000, None),
            i(6_000, None),
            h(8_000, None),
            h(10_000, None),
            h(12_000, None),
            h(14_000, None),
            h(16_000, None),
            h(18_000, None),
            h(20_000, None),
            h(22_000, None),
            h(24_000, None),
            h(26_000, None),
            i(28_000, None),
            i(30_000, None),
            i(32_000, None),
        ];

        let (_, events) = run_gated(&full);
        assert_eq!(
            events,
            vec![
                GatedEvent::CandidateStarted(1),
                GatedEvent::CandidateEnded(1),
            ],
            "two counts before the Hold block plus three after reach the five-poll end"
        );

        let (_, prefix) = run_gated(&full[..full.len() - 1]);
        assert!(
            !prefix
                .iter()
                .any(|e| matches!(e, GatedEvent::CandidateEnded(_))),
            "CandidateEnded(1) appears on the last poll, not earlier - Hold preserved \
             the two-count streak without advancing it"
        );
    }

    #[test]
    fn confirm_on_the_dying_poll_enters_then_leaves() {
        let (_, events) = run_gated(&[
            a(0, None),
            a(2_000, None),
            i(4_000, None),
            i(6_000, None),
            i(8_000, None),
            i(10_000, None),
            i(12_000, Some(1)),
            a(22_000, None),
            a(24_000, None),
        ]);
        assert_eq!(
            events,
            vec![
                GatedEvent::CandidateStarted(1),
                GatedEvent::EnteredCall("chrome.exe".to_string()),
                GatedEvent::LeftCall("chrome.exe".to_string()),
                GatedEvent::EnteredCall("chrome.exe".to_string()),
            ],
            "the confirmation lands at inactive streak 5, so that poll emits \
             EnteredCall then LeftCall in order, and the immediate re-entry is \
             carry-over with no CandidateStarted(2)"
        );
    }

    #[test]
    fn carry_over_just_under_two_minutes_confirms_at_once() {
        let (_, events) = run_gated(&[
            a(0, None),
            a(2_000, None),
            a(4_000, Some(1)),
            i(6_000, None),
            i(8_000, None),
            i(10_000, None),
            i(12_000, None),
            i(14_000, None),
            a(131_999, None),
            a(133_999, None),
        ]);
        assert_eq!(
            events,
            vec![
                GatedEvent::CandidateStarted(1),
                GatedEvent::EnteredCall("chrome.exe".to_string()),
                GatedEvent::LeftCall("chrome.exe".to_string()),
                GatedEvent::EnteredCall("chrome.exe".to_string()),
            ],
            "a start poll 119_999ms after the confirmed leave confirms at once, \
             with no CandidateStarted(2)"
        );
    }

    #[test]
    fn carry_over_at_exactly_two_minutes_is_a_candidate() {
        let (_, events) = run_gated(&[
            a(0, None),
            a(2_000, None),
            a(4_000, Some(1)),
            i(6_000, None),
            i(8_000, None),
            i(10_000, None),
            i(12_000, None),
            i(14_000, None),
            a(132_000, None),
            a(134_000, None),
        ]);
        assert_eq!(
            events,
            vec![
                GatedEvent::CandidateStarted(1),
                GatedEvent::EnteredCall("chrome.exe".to_string()),
                GatedEvent::LeftCall("chrome.exe".to_string()),
                GatedEvent::CandidateStarted(2),
            ],
            "at exactly 120_000ms the carry-over window is closed"
        );
    }

    #[test]
    fn an_unconfirmed_end_arms_no_carry_over() {
        let (_, events) = run_gated(&[
            a(0, None),
            a(2_000, None),
            i(4_000, None),
            i(6_000, None),
            i(8_000, None),
            i(10_000, None),
            i(12_000, None),
            a(22_000, None),
            a(24_000, None),
        ]);
        assert_eq!(
            events,
            vec![
                GatedEvent::CandidateStarted(1),
                GatedEvent::CandidateEnded(1),
                GatedEvent::CandidateStarted(2),
            ],
            "an episode that never confirmed leaves no carry-over"
        );
    }

    #[test]
    fn a_long_wall_clock_gap_does_not_carry_over() {
        let (_, events) = run_gated(&[
            a(0, None),
            a(2_000, None),
            a(4_000, Some(1)),
            i(6_000, None),
            i(8_000, None),
            i(10_000, None),
            i(12_000, None),
            i(14_000, None),
            a(3_614_000, None),
            a(3_616_000, None),
        ]);
        assert_eq!(
            events,
            vec![
                GatedEvent::CandidateStarted(1),
                GatedEvent::EnteredCall("chrome.exe".to_string()),
                GatedEvent::LeftCall("chrome.exe".to_string()),
                GatedEvent::CandidateStarted(2),
            ],
            "an hour later must go through the full two-poll candidate debounce again"
        );
    }

    #[test]
    fn an_inactive_poll_resets_the_start_streak() {
        let (_, events) = run_gated(&[a(0, None), i(2_000, None), a(4_000, None)]);
        assert!(
            events.is_empty(),
            "A, I, A is not two consecutive Active polls"
        );
    }

    #[test]
    fn an_active_poll_resets_the_end_streak() {
        let (_, events) = run_gated(&[
            a(0, None),
            a(2_000, None),
            i(4_000, None),
            i(6_000, None),
            i(8_000, None),
            i(10_000, None),
            a(12_000, None),
            i(14_000, None),
        ]);
        assert_eq!(events, vec![GatedEvent::CandidateStarted(1)]);
    }

    #[test]
    fn candidate_episode_is_some_only_while_a_candidate() {
        let (idle, _) = run_gated(&[]);
        assert_eq!(idle.candidate_episode(), None);

        let (candidate, _) = run_gated(&[a(0, None), a(2_000, None)]);
        assert_eq!(candidate.candidate_episode(), Some(1));

        let (confirmed, _) = run_gated(&[a(0, None), a(2_000, None), a(4_000, Some(1))]);
        assert_eq!(confirmed.candidate_episode(), None);
    }
}
