//! Microsoft Teams call detection via WASAPI capture-session polling.
//!
//! All decision logic lives here as pure functions with no COM dependency, so it
//! compiles and is unit-tested on every target including the Linux CI runner.
//! `win32.rs` / `stub.rs` contribute only session enumeration.

// Calendar-gated detection for Chrome (Google Meet): a second, independent
// pure state machine, driven by the same poll loop.
mod gate;
use gate::{gated_step, GatedEvent, GatedInput, GatedState};

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
pub(crate) const START_DEBOUNCE: u32 = 2;
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
    CandidateStarted(u64),
    CandidateEnded(u64),
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

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
#[derive(Debug, Clone, Copy)]
enum Side {
    Direct,
    Gated,
}

/// Merges the direct (Teams) and gated (Chrome) machines into one meeting
/// stream: `Detected` when neither side was in a call, `Ended` when neither is.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
#[derive(Default)]
struct Combined {
    direct: bool,
    gated: bool,
    /// The process that opened the combined call; `Ended` carries it.
    open: Option<String>,
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
impl Combined {
    fn apply(&mut self, side: Side, entered: bool, process: &str) -> Option<WatcherEvent> {
        let was_in = self.direct || self.gated;
        match side {
            Side::Direct => self.direct = entered,
            Side::Gated => self.gated = entered,
        }
        match (was_in, self.direct || self.gated) {
            (false, true) => {
                self.open = Some(process.to_string());
                Some(WatcherEvent::Detected(process.to_string()))
            }
            (true, false) => self.open.take().map(WatcherEvent::Ended),
            _ => None,
        }
    }
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
#[derive(Default)]
struct WatcherCore {
    direct: MachineState,
    gated: GatedState,
    combined: Combined,
}

/// One poll through both machines. Order: candidate events, then combined
/// meeting events (direct edges first, then gated), then health events.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn tick(
    core: &mut WatcherCore,
    direct: PollOutcome,
    gated: PollOutcome,
    now_ms: i64,
    confirmed: Option<u64>,
    next_episode: &mut dyn FnMut() -> u64,
) -> Vec<WatcherEvent> {
    let mut candidate = Vec::new();
    let mut meeting = Vec::new();
    let mut health = Vec::new();

    let (next, event) = step(std::mem::take(&mut core.direct), direct);
    core.direct = next;
    match event {
        Some(WatcherEvent::Detected(p)) => {
            meeting.extend(core.combined.apply(Side::Direct, true, &p))
        }
        Some(WatcherEvent::Ended(p)) => {
            meeting.extend(core.combined.apply(Side::Direct, false, &p))
        }
        Some(other) => health.push(other),
        None => {}
    }

    let input = match gated {
        PollOutcome::Classified(PollResult::Active(n)) => GatedInput::Active(n),
        PollOutcome::Classified(PollResult::Inactive) => GatedInput::Inactive,
        PollOutcome::Classified(PollResult::Unknown) | PollOutcome::Failed => GatedInput::Hold,
    };
    let (next, events) = gated_step(
        std::mem::take(&mut core.gated),
        input,
        now_ms,
        confirmed,
        next_episode,
    );
    core.gated = next;
    for event in events {
        match event {
            GatedEvent::CandidateStarted(e) => candidate.push(WatcherEvent::CandidateStarted(e)),
            GatedEvent::CandidateEnded(e) => candidate.push(WatcherEvent::CandidateEnded(e)),
            GatedEvent::EnteredCall(p) => {
                meeting.extend(core.combined.apply(Side::Gated, true, &p))
            }
            GatedEvent::LeftCall(p) => meeting.extend(core.combined.apply(Side::Gated, false, &p)),
        }
    }

    candidate.into_iter().chain(meeting).chain(health).collect()
}

/// What the poll thread re-emits after a webview reload, so a fresh frontend
/// gate learns about a candidate that is already live.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn reannounce_event(core: &WatcherCore) -> Option<WatcherEvent> {
    core.gated
        .candidate_episode()
        .map(WatcherEvent::CandidateStarted)
}

/// Process-wide so episode ids stay unique across watcher restarts.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
static NEXT_EPISODE: AtomicU64 = AtomicU64::new(1);

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

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

use serde::Serialize;
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

const POLL_INTERVAL: Duration = Duration::from_secs(2);
/// The poll sleep is sliced so shutdown is observed within ~200ms rather than
/// after a full poll, which is what makes stop's 3s bound meaningful.
const SHUTDOWN_SLICE: Duration = Duration::from_millis(200);
const STOP_TIMEOUT: Duration = Duration::from_secs(3);

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
struct Generation {
    handle: JoinHandle<()>,
    /// Owned by THIS thread only. Per-generation rather than shared: cancelling
    /// generation N can never affect generation N+1, so no "reset the flag before
    /// spawning" rule is needed.
    shutdown: Arc<AtomicBool>,
    done_rx: Receiver<()>,
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
#[derive(Default)]
pub struct MeetingWatcherState {
    current: Arc<Mutex<Option<Generation>>>,
    /// Authoritative liveness - NOT the presence of a JoinHandle.
    running: Arc<AtomicBool>,
    /// A stop is in flight or timed out. Observable independently of the slot,
    /// because stop removes the generation before it waits.
    stopping: Arc<AtomicBool>,
    last_error: Arc<Mutex<Option<String>>>,
    watch_list: Arc<Mutex<WatchLists>>,
    /// The frontend's confirmed candidate episode, read by the poll thread.
    confirmed: Arc<Mutex<Option<u64>>>,
    /// Set by a start on a running watcher (a webview reload); the poll thread
    /// swaps it and re-announces a live candidate.
    reannounce: Arc<AtomicBool>,
}

/// One mutex holds both lists, so a poll never reads a torn pair.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct WatchLists {
    pub direct: Vec<String>,
    pub gated: Vec<String>,
}

/// The three per-poll slots, bundled to keep `poll_loop` at 7 parameters.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
#[derive(Clone)]
struct PollSlots {
    lists: Arc<Mutex<WatchLists>>,
    confirmed: Arc<Mutex<Option<u64>>>,
    reannounce: Arc<AtomicBool>,
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
#[derive(Debug, Clone, Serialize)]
// camelCase so the frontend reads `lastError`, matching the settings card.
#[serde(rename_all = "camelCase")]
pub struct WatcherStatus {
    pub running: bool,
    pub last_error: Option<String>,
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum StopOutcome {
    Stopped,
    NotRunning,
    TimedOut,
}

#[derive(Serialize, Clone)]
struct ProcessPayload {
    process: String,
}

#[derive(Serialize, Clone)]
struct EpisodePayload {
    episode: u64,
}

#[derive(Serialize, Clone)]
struct MessagePayload {
    message: String,
}

#[derive(Serialize, Clone)]
struct ReasonPayload {
    reason: String,
}

/// Poison-recovering lock, matching src-tauri/src/lib.rs:161-163. A caught panic
/// in the poll body is designed-in, so mapping poisoning to Err would make every
/// later command fail permanently.
fn lock_recover<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Runs on unwind as well as on a normal return, so a panic outside the poll
/// body cannot strand `running == true` with no thread. It is also the SOLE
/// emitter of the terminal event - emitting at both the step site and here would
/// produce two toasts, which frontend test F17 forbids.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
struct ExitGuard {
    app: AppHandle,
    running: Arc<AtomicBool>,
    stopping: Arc<AtomicBool>,
    last_error: Arc<Mutex<Option<String>>>,
    done_tx: Sender<()>,
    /// Set when the exit came from an explicit stop_meeting_watcher, which
    /// suppresses the terminal event.
    explicit_stop: bool,
    /// True only after a successful CoInitializeEx, so Drop pairs every
    /// CoUninitialize with an init and never calls it on the failure early-return.
    com_initialized: bool,
    reason: Option<String>,
}

impl Drop for ExitGuard {
    fn drop(&mut self) {
        self.running.store(false, Ordering::SeqCst);
        self.stopping.store(false, Ordering::SeqCst);

        // Release the COM apartment reference here, on every exit path including
        // unwind - the poll loop's trailing CoUninitialize would be skipped by a
        // panic in the lock/emit/sleep paths that unwind past it. Gated on
        // com_initialized so a CoInitializeEx failure (which early-returns with
        // the flag still false) does not make an unbalanced call.
        #[cfg(target_os = "windows")]
        if self.com_initialized {
            unsafe {
                ::windows::Win32::System::Com::CoUninitialize();
            }
        }

        if !self.explicit_stop {
            let reason = self
                .reason
                .clone()
                .unwrap_or_else(|| "meeting detection stopped unexpectedly".to_string());
            *lock_recover(&self.last_error) = Some(reason.clone());
            if let Err(e) = self
                .app
                .emit("meeting-watcher-stopped", ReasonPayload { reason })
            {
                tracing::warn!("Failed to emit meeting-watcher-stopped: {}", e);
            }
        }

        // The receiver is legitimately gone after a timed-out stop followed by a
        // new spawn. This is the one carve-out from the never-discard rule; an
        // unwrap here would panic in the exit path and skip the rest of Drop.
        if self.done_tx.send(()).is_err() {
            tracing::debug!("Meeting watcher exit signal had no receiver");
        }
    }
}

/// Emits the detection-stream events; health events are handled by the caller.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn emit_detection(app: &AppHandle, event: &WatcherEvent) {
    let (name, result) = match event {
        WatcherEvent::Detected(p) => (
            "meeting-detected",
            app.emit("meeting-detected", ProcessPayload { process: p.clone() }),
        ),
        WatcherEvent::Ended(p) => (
            "meeting-ended",
            app.emit("meeting-ended", ProcessPayload { process: p.clone() }),
        ),
        WatcherEvent::CandidateStarted(e) => (
            "meeting-candidate-started",
            app.emit("meeting-candidate-started", EpisodePayload { episode: *e }),
        ),
        WatcherEvent::CandidateEnded(e) => (
            "meeting-candidate-ended",
            app.emit("meeting-candidate-ended", EpisodePayload { episode: *e }),
        ),
        WatcherEvent::Degraded(_) | WatcherEvent::Stopped(_) => return,
    };
    if let Err(e) = result {
        tracing::warn!("Failed to emit {}: {}", name, e);
    }
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn poll_loop(
    app: AppHandle,
    shutdown: Arc<AtomicBool>,
    running: Arc<AtomicBool>,
    stopping: Arc<AtomicBool>,
    last_error: Arc<Mutex<Option<String>>>,
    slots: PollSlots,
    done_tx: Sender<()>,
) {
    let mut guard = ExitGuard {
        app: app.clone(),
        running,
        stopping,
        last_error: last_error.clone(),
        done_tx,
        explicit_stop: false,
        com_initialized: false,
        reason: None,
    };

    #[cfg(target_os = "windows")]
    {
        // Leading `::` is mandatory here even with the submodule renamed to
        // win32 - it keeps the path unambiguously on the crate.
        use ::windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
        // MULTITHREADED deliberately: APARTMENTTHREADED on a thread with no
        // message pump is a known WASAPI/MMDevice footgun.
        let hr = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
        if hr.is_err() {
            guard.reason = Some(format!("CoInitializeEx failed: {:?}", hr));
            return;
        }
        // Only pair CoUninitialize with a SUCCESSFUL init - the Drop guard reads
        // this to avoid an unbalanced CoUninitialize on the failure early-return.
        guard.com_initialized = true;
    }

    let own_pid = std::process::id();
    let mut core = WatcherCore::default();
    let mut error_episode = false;

    loop {
        if shutdown.load(Ordering::SeqCst) {
            guard.explicit_stop = true;
            break;
        }

        let lists = lock_recover(&slots.lists).clone();
        let confirmed = *lock_recover(&slots.confirmed);

        if slots.reannounce.swap(false, Ordering::SeqCst) {
            if let Some(event) = reannounce_event(&core) {
                emit_detection(&app, &event);
            }
        }

        // catch_unwind is scoped to a body that carries no COM state across it -
        // raw COM wrappers are not UnwindSafe, and the per-poll re-resolution
        // rule is what makes that scoping possible.
        let polled = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            enumerate_capture_sessions()
        }));

        let (outcome, gated_outcome) = match polled {
            Ok(Ok(sessions)) => (
                PollOutcome::Classified(classify(&sessions, &lists.direct, own_pid)),
                PollOutcome::Classified(classify(&sessions, &lists.gated, own_pid)),
            ),
            Ok(Err(message)) => {
                tracing::warn!("Meeting detection poll failed: {}", message);
                if !error_episode {
                    error_episode = true;
                    *lock_recover(&last_error) = Some(message.clone());
                    if let Err(e) = app.emit("meeting-watcher-error", MessagePayload { message }) {
                        tracing::warn!("Failed to emit meeting-watcher-error: {}", e);
                    }
                }
                (PollOutcome::Failed, PollOutcome::Failed)
            }
            Err(_) => {
                tracing::error!("Meeting detection poll panicked");
                (PollOutcome::Failed, PollOutcome::Failed)
            }
        };

        // An episode ends only on Active/Inactive. A Classified(Unknown) poll must
        // NOT end it, or the Degraded message written at unknown-poll 15 is wiped
        // by poll 16 and the settings card reports healthy while detection can
        // never fire.
        if matches!(
            outcome,
            PollOutcome::Classified(PollResult::Active(_))
                | PollOutcome::Classified(PollResult::Inactive)
        ) && error_episode
        {
            error_episode = false;
            *lock_recover(&last_error) = None;
            if let Err(e) = app.emit("meeting-watcher-recovered", ()) {
                tracing::warn!("Failed to emit meeting-watcher-recovered: {}", e);
            }
        }

        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        let events = tick(
            &mut core,
            outcome,
            gated_outcome,
            now_ms,
            confirmed,
            &mut || NEXT_EPISODE.fetch_add(1, Ordering::SeqCst),
        );

        let mut stopped = false;
        for event in events {
            match event {
                WatcherEvent::Degraded(message) => {
                    // Opening an episode here is what lets the recovery block above
                    // close it. Without this the degraded note survives for the rest
                    // of the process lifetime after the condition self-heals, because
                    // that block is gated on error_episode.
                    error_episode = true;
                    *lock_recover(&last_error) = Some(message.clone());
                    if let Err(e) = app.emit("meeting-watcher-error", MessagePayload { message }) {
                        tracing::warn!("Failed to emit meeting-watcher-error: {}", e);
                    }
                }
                WatcherEvent::Stopped(reason) => {
                    guard.reason = Some(reason);
                    stopped = true;
                    break;
                }
                other => emit_detection(&app, &other),
            }
        }
        if stopped {
            break;
        }

        let mut slept = Duration::ZERO;
        while slept < POLL_INTERVAL {
            if shutdown.load(Ordering::SeqCst) {
                break;
            }
            thread::sleep(SHUTDOWN_SLICE);
            slept += SHUTDOWN_SLICE;
        }
    }

    // NOTE: CoUninitialize is NOT called here. catch_unwind wraps only
    // enumerate_capture_sessions(); a panic in the lock/emit/sleep paths
    // unwinds past this trailing block, leaking the COM apartment for the
    // process lifetime. CoUninitialize lives in ExitGuard::drop instead, which
    // runs on every exit path including unwind.
}

#[tauri::command]
pub fn start_meeting_watcher(
    app: AppHandle,
    direct: Vec<String>,
    gated: Vec<String>,
) -> Result<(), String> {
    if cfg!(not(target_os = "windows")) {
        return Err(UNSUPPORTED_PLATFORM.to_string());
    }

    let state = app.state::<MeetingWatcherState>();

    match plan_start(
        state.running.load(Ordering::SeqCst),
        state.stopping.load(Ordering::SeqCst),
    ) {
        StartAction::UpdateWatchList => {
            *lock_recover(&state.watch_list) = WatchLists { direct, gated };
            // A start on a running watcher is what a webview reload does: the
            // fresh frontend gate knows no live candidate, so have the poll
            // thread re-announce one.
            state.reannounce.store(true, Ordering::SeqCst);
            Ok(())
        }
        StartAction::Retryable(message) => Err(message.to_string()),
        StartAction::Spawn => {
            *lock_recover(&state.watch_list) = WatchLists { direct, gated };
            *lock_recover(&state.confirmed) = None;
            *lock_recover(&state.last_error) = None;

            let shutdown = Arc::new(AtomicBool::new(false));
            let (done_tx, done_rx) = channel();
            // Set BEFORE the spawn, while the Generation can only be stored
            // after it (see the comment on the store below). If poll_loop exits
            // immediately - a CoInitializeEx failure - ExitGuard::drop clears
            // `running` inside that window. A CONCURRENT start would then read
            // running == false, spawn a second thread, and this call's store
            // would clobber the slot with its dead Generation, orphaning the
            // live thread: no handle, no shutdown flag, polling until exit.
            // Accepted, not fixed: reaching it needs two OVERLAPPING starts,
            // and every watcher command in the owner window is serialized
            // through a single chainRef promise (useMeetingDetection.ts:74).
            // Closing it properly means holding `current` across the atomics,
            // the spawn and the store - a lifecycle change worth its own pass.
            state.running.store(true, Ordering::SeqCst);

            let thread_args = (
                app.clone(),
                shutdown.clone(),
                state.running.clone(),
                state.stopping.clone(),
                state.last_error.clone(),
                PollSlots {
                    lists: state.watch_list.clone(),
                    confirmed: state.confirmed.clone(),
                    reannounce: state.reannounce.clone(),
                },
                done_tx,
            );

            let spawned = thread::Builder::new()
                .name("meeting-detect".to_string())
                .spawn(move || {
                    let (app, shutdown, running, stopping, last_error, slots, done_tx) =
                        thread_args;
                    poll_loop(app, shutdown, running, stopping, last_error, slots, done_tx);
                });

            match spawned {
                Ok(handle) => {
                    apply_spawn_outcome(&state.running, Ok(()))?;
                    // Stored AFTER the spawn - Generation holds the JoinHandle,
                    // which only exists once spawn returns. The thread may already
                    // have exited (a CoInitializeEx failure whose Drop guard ran
                    // first), leaving a corpse with running == false: exactly the
                    // ReapCorpse case plan_stop handles.
                    *lock_recover(&state.current) = Some(Generation {
                        handle,
                        shutdown,
                        done_rx,
                    });
                    Ok(())
                }
                Err(e) => {
                    tracing::error!("Failed to spawn meeting detection thread: {}", e);
                    apply_spawn_outcome(&state.running, Err(()))
                }
            }
        }
    }
}

/// Writes the lists only while the watcher runs; never spawns.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn apply_list_update(running: bool, slot: &Mutex<WatchLists>, lists: WatchLists) {
    if running {
        *lock_recover(slot) = lists;
    }
}

#[tauri::command]
pub fn update_meeting_watch_lists(
    app: AppHandle,
    direct: Vec<String>,
    gated: Vec<String>,
) -> Result<(), String> {
    if cfg!(not(target_os = "windows")) {
        return Err(UNSUPPORTED_PLATFORM.to_string());
    }
    let state = app.state::<MeetingWatcherState>();
    apply_list_update(
        state.running.load(Ordering::SeqCst),
        &state.watch_list,
        WatchLists { direct, gated },
    );
    Ok(())
}

/// Records the confirmed episode for the poll thread; emits nothing itself.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn apply_confirm(running: bool, slot: &Mutex<Option<u64>>, episode: u64) -> Result<(), String> {
    if !running {
        return Err("WATCHER_NOT_RUNNING".to_string());
    }
    *lock_recover(slot) = Some(episode);
    Ok(())
}

#[tauri::command]
pub fn confirm_meeting_candidate(app: AppHandle, episode: u64) -> Result<(), String> {
    if cfg!(not(target_os = "windows")) {
        return Err(UNSUPPORTED_PLATFORM.to_string());
    }
    let state = app.state::<MeetingWatcherState>();
    apply_confirm(
        state.running.load(Ordering::SeqCst),
        &state.confirmed,
        episode,
    )
}

/// async because it waits up to 3s: a non-async Tauri v2 command runs on the
/// main thread and would freeze both windows for that long. NOTE: `#[tauri::command]`
/// infers async behavior from the `async fn` signature - there is no `(async)`
/// argument in Tauri v2 (and the repo's speaker commands all use this exact form).
#[tauri::command]
pub async fn stop_meeting_watcher(app: AppHandle) -> Result<StopOutcome, String> {
    if cfg!(not(target_os = "windows")) {
        return Err(UNSUPPORTED_PLATFORM.to_string());
    }

    let state = app.state::<MeetingWatcherState>();

    // Set BEFORE the generation leaves the slot, so a concurrent start can
    // observe that a stop is in flight.
    state.stopping.store(true, Ordering::SeqCst);

    let has_generation = lock_recover(&state.current).is_some();

    match plan_stop(state.running.load(Ordering::SeqCst), has_generation) {
        StopAction::Nothing => {
            state.stopping.store(false, Ordering::SeqCst);
            Ok(StopOutcome::NotRunning)
        }
        StopAction::AlreadyStopping => Ok(StopOutcome::TimedOut),
        StopAction::ReapCorpse => {
            let generation = { lock_recover(&state.current).take() };
            if let Some(generation) = generation {
                // The slot may have been refilled by a concurrent start between
                // the has_generation read and this take(); signal before joining so
                // a wrongly-reaped LIVE generation exits instead of blocking here.
                generation.shutdown.store(true, Ordering::SeqCst);
                let _ = generation.handle.join();
            }
            state.stopping.store(false, Ordering::SeqCst);
            Ok(StopOutcome::NotRunning)
        }
        StopAction::Signal => {
            // Taken in its own scope so no guard is held across the wait.
            let generation = { lock_recover(&state.current).take() };
            let Some(generation) = generation else {
                return Ok(StopOutcome::TimedOut);
            };

            generation.shutdown.store(true, Ordering::SeqCst);

            match generation.done_rx.recv_timeout(STOP_TIMEOUT) {
                Ok(()) | Err(RecvTimeoutError::Disconnected) => {
                    let _ = generation.handle.join();
                    // Drop has ALREADY cleared running/stopping before done_tx
                    // returned (Drop stores, then sends), so by the time recv
                    // returns Ok the flags are false. A store here would race a
                    // concurrent start_meeting_watcher: plan_start(false, false)
                    // returns Spawn, the new thread sets running=true, and this
                    // redundant store(false) would clobber it - leaving a live poll
                    // thread with running == false, so the NEXT start spawns a
                    // second thread (the duplicate-event bug R14 exists to catch).
                    Ok(StopOutcome::Stopped)
                }
                Err(RecvTimeoutError::Timeout) => {
                    tracing::warn!("Meeting detection thread did not stop within 3s");
                    // running and stopping are left alone: the thread's Drop guard
                    // clears them when it finally exits, and until then start
                    // correctly reports Retryable.
                    Ok(StopOutcome::TimedOut)
                }
            }
        }
    }
}

#[tauri::command]
pub fn get_meeting_watcher_status(app: AppHandle) -> Result<WatcherStatus, String> {
    if cfg!(not(target_os = "windows")) {
        return Err(UNSUPPORTED_PLATFORM.to_string());
    }

    let state = app.state::<MeetingWatcherState>();
    let running = state.running.load(Ordering::SeqCst);
    // Bound to a variable rather than inlined into the struct literal below: a
    // MutexGuard temporary created inside a function's tail expression has its
    // drop scope extended to the whole function body, which would require
    // `state` to outlive it and fails to borrow-check.
    let last_error = lock_recover(&state.last_error).clone();
    Ok(WatcherStatus {
        running,
        last_error,
    })
}

/// One app holding the microphone, for the settings readout.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MicSession {
    pub name: String,
    pub pid: u32,
    pub active: bool,
    /// "direct", "gated" or "ignored".
    pub kind: &'static str,
}

/// Same matching rule as `classify`: case-insensitive exact image name.
fn describe_sessions(
    sessions: &[SessionInfo],
    lists: &WatchLists,
    own_pid: u32,
) -> Vec<MicSession> {
    let listed = |list: &[String], name: &str| list.iter().any(|w| w.eq_ignore_ascii_case(name));
    let mut rows: Vec<MicSession> = sessions
        .iter()
        .filter(|s| s.pid != own_pid)
        .filter_map(|s| {
            let name = s.image_name.as_ref()?;
            let kind = if listed(&lists.direct, name) {
                "direct"
            } else if listed(&lists.gated, name) {
                "gated"
            } else {
                "ignored"
            };
            Some(MicSession {
                name: name.clone(),
                pid: s.pid,
                active: s.active,
                kind,
            })
        })
        .collect();
    rows.sort_by(|a, b| b.active.cmp(&a.active).then_with(|| a.name.cmp(&b.name)));
    rows
}

/// Lists every app on the microphone and whether the watcher would watch it.
/// Needs no watcher, so it works with auto-record off.
#[tauri::command]
pub async fn list_capture_sessions(
    direct: Vec<String>,
    gated: Vec<String>,
) -> Result<Vec<MicSession>, String> {
    if cfg!(not(target_os = "windows")) {
        return Err(UNSUPPORTED_PLATFORM.to_string());
    }
    let lists = WatchLists { direct, gated };
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(target_os = "windows")]
        let com_initialized = {
            use ::windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
            unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }.is_ok()
        };
        let sessions = enumerate_capture_sessions();
        // Only pair CoUninitialize with a SUCCESSFUL init.
        #[cfg(target_os = "windows")]
        if com_initialized {
            unsafe { ::windows::Win32::System::Com::CoUninitialize() };
        }
        Ok(describe_sessions(&sessions?, &lists, std::process::id()))
    })
    .await
    .map_err(|e| e.to_string())?
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

    #[test]
    fn describe_sessions_marks_each_list() {
        let lists = WatchLists {
            direct: vec!["ms-teams.exe".to_string()],
            gated: vec!["chrome.exe".to_string()],
        };
        let rows = describe_sessions(
            &[
                session(1, Some("spotify.exe"), false),
                session(2, Some("MS-TEAMS.EXE"), false),
                session(3, Some("chrome.exe"), true),
                session(4, None, true),
                session(99, Some("chrome.exe"), true),
            ],
            &lists,
            99,
        );
        let got: Vec<(&str, bool, &str)> = rows
            .iter()
            .map(|r| (r.name.as_str(), r.active, r.kind))
            .collect();
        assert_eq!(
            got,
            vec![
                ("chrome.exe", true, "gated"),
                ("MS-TEAMS.EXE", false, "direct"),
                ("spotify.exe", false, "ignored"),
            ]
        );
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

    fn teams() -> PollOutcome {
        active()
    }
    fn chrome() -> PollOutcome {
        PollOutcome::Classified(PollResult::Active("chrome.exe".to_string()))
    }

    type Poll = (PollOutcome, PollOutcome, Option<u64>);

    fn run_core_state(seq: Vec<Poll>) -> (WatcherCore, Vec<WatcherEvent>) {
        let mut core = WatcherCore::default();
        let mut events = Vec::new();
        let mut episode = 0u64;
        let mut next_episode = || {
            episode += 1;
            episode
        };
        for (i, (direct, gated, confirmed)) in seq.into_iter().enumerate() {
            events.extend(tick(
                &mut core,
                direct,
                gated,
                2_000 * i as i64,
                confirmed,
                &mut next_episode,
            ));
        }
        (core, events)
    }

    fn run_core(seq: Vec<Poll>) -> Vec<WatcherEvent> {
        run_core_state(seq).1
    }

    fn detected(p: &str) -> WatcherEvent {
        WatcherEvent::Detected(p.to_string())
    }
    fn ended(p: &str) -> WatcherEvent {
        WatcherEvent::Ended(p.to_string())
    }

    /// Two chrome polls (candidate 1) then a confirm poll: a confirmed Meet call.
    fn confirmed_meet() -> Vec<Poll> {
        vec![
            (inactive(), chrome(), None),
            (inactive(), chrome(), None),
            (inactive(), chrome(), Some(1)),
        ]
    }

    #[test]
    fn classify_per_list_in_both_enumeration_orders() {
        let chrome_s = session(300, Some("chrome.exe"), true);
        let teams_s = session(301, Some("ms-teams.exe"), true);
        for sessions in [
            [chrome_s.clone(), teams_s.clone()],
            [teams_s.clone(), chrome_s.clone()],
        ] {
            assert_eq!(
                classify(&sessions, &watch(), 100),
                PollResult::Active("ms-teams.exe".to_string())
            );
            assert_eq!(
                classify(&sessions, &["chrome.exe".to_string()], 100),
                PollResult::Active("chrome.exe".to_string())
            );
        }
    }

    #[test]
    fn chrome_matching_mirrors_the_teams_rules() {
        let list = ["chrome.exe".to_string()];
        assert_eq!(
            classify(&[session(300, Some("CHROME.EXE"), true)], &list, 100),
            PollResult::Active("CHROME.EXE".to_string())
        );
        assert_eq!(
            classify(&[session(100, Some("chrome.exe"), true)], &list, 100),
            PollResult::Inactive,
            "own pid is excluded"
        );
        assert_eq!(
            classify(
                &[session(300, None, true), session(301, None, true)],
                &list,
                100
            ),
            PollResult::Unknown
        );
    }

    #[test]
    fn teams_starts_while_chrome_is_a_candidate() {
        let events = run_core(vec![
            (inactive(), chrome(), None),
            (inactive(), chrome(), None),
            (teams(), inactive(), None),
            (teams(), inactive(), None),
        ]);
        assert_eq!(
            events,
            vec![WatcherEvent::CandidateStarted(1), detected("ms-teams.exe")]
        );
    }

    #[test]
    fn an_unconfirmed_gated_episode_emits_no_meeting_events() {
        let mut seq = vec![(inactive(), chrome(), None), (inactive(), chrome(), None)];
        seq.extend(vec![(inactive(), inactive(), None); 5]);
        assert_eq!(
            run_core(seq),
            vec![
                WatcherEvent::CandidateStarted(1),
                WatcherEvent::CandidateEnded(1)
            ]
        );
    }

    #[test]
    fn confirm_then_leave_emits_detected_then_ended() {
        let mut seq = confirmed_meet();
        seq.extend(vec![(inactive(), inactive(), None); 5]);
        assert_eq!(
            run_core(seq),
            vec![
                WatcherEvent::CandidateStarted(1),
                detected("chrome.exe"),
                ended("chrome.exe")
            ]
        );
    }

    #[test]
    fn teams_ending_inside_a_confirmed_meet_call_emits_no_ended() {
        let mut seq = confirmed_meet();
        seq.extend(vec![(teams(), chrome(), Some(1)); 2]);
        seq.extend(vec![(inactive(), chrome(), Some(1)); 3]);
        assert_eq!(
            run_core(seq.clone()),
            vec![WatcherEvent::CandidateStarted(1), detected("chrome.exe")],
            "Teams starting and ending inside the Meet call emits nothing"
        );
        seq.extend(vec![(inactive(), inactive(), Some(1)); 5]);
        assert_eq!(
            run_core(seq),
            vec![
                WatcherEvent::CandidateStarted(1),
                detected("chrome.exe"),
                ended("chrome.exe")
            ]
        );
    }

    #[test]
    fn ended_carries_the_process_that_opened_the_call() {
        // Teams opens, a Meet candidate is confirmed, Teams ends, then Meet ends.
        let mut seq = vec![(teams(), inactive(), None); 2];
        seq.extend(vec![(teams(), chrome(), None); 2]);
        seq.push((teams(), chrome(), Some(1)));
        seq.extend(vec![(inactive(), chrome(), Some(1)); 3]);
        seq.extend(vec![(inactive(), inactive(), Some(1)); 5]);
        let events = run_core(seq);
        assert_eq!(
            events,
            vec![
                detected("ms-teams.exe"),
                WatcherEvent::CandidateStarted(1),
                ended("ms-teams.exe")
            ]
        );
    }

    #[test]
    fn teams_only_sequences_are_unchanged() {
        let seqs = vec![
            vec![active()],
            vec![active(), active()],
            vec![active(), active(), active(), active()],
            vec![active(), active(), inactive(), inactive()],
            vec![active(), active(), inactive(), inactive(), inactive()],
            vec![
                active(),
                active(),
                inactive(),
                inactive(),
                active(),
                inactive(),
                inactive(),
            ],
        ];
        for seq in seqs {
            let (_, expected) = run(seq.clone());
            let got = run_core(seq.into_iter().map(|o| (o, inactive(), None)).collect());
            assert_eq!(got, expected);
        }
    }

    #[test]
    fn one_bad_poll_raises_one_degraded() {
        let events = run_core(vec![(unknown(), unknown(), None); 15]);
        assert_eq!(events.len(), 1);
        assert!(matches!(events[0], WatcherEvent::Degraded(_)));

        let events = run_core(vec![(failed(), failed(), None); 30]);
        assert_eq!(events.len(), 1);
        assert!(matches!(events[0], WatcherEvent::Stopped(_)));
    }

    #[test]
    fn emptying_the_gated_list_ends_a_live_episode_after_the_debounce() {
        let sessions = [session(300, Some("chrome.exe"), true)];
        let emptied = classify(&sessions, &[], 100);
        assert_eq!(emptied, PollResult::Inactive);

        let mut seq = confirmed_meet();
        let before = run_core(seq.clone());
        assert_eq!(before.len(), 2);
        for n in 1..=5 {
            seq.push((
                inactive(),
                PollOutcome::Classified(emptied.clone()),
                Some(1),
            ));
            let events = run_core(seq.clone());
            if n < 5 {
                assert_eq!(events, before, "poll {n} must not end the call");
            } else {
                assert_eq!(events.last(), Some(&ended("chrome.exe")));
            }
        }
    }

    #[test]
    fn bad_polls_hold_a_confirmed_meet_call() {
        let mut seq = confirmed_meet();
        seq.extend(vec![(unknown(), unknown(), Some(1)); 10]);
        seq.extend(vec![(failed(), failed(), Some(1)); 10]);
        assert!(
            !run_core(seq.clone())
                .iter()
                .any(|e| matches!(e, WatcherEvent::Ended(_))),
            "bad polls must not end a confirmed call"
        );
        seq.push((inactive(), chrome(), Some(1)));
        seq.extend(vec![(inactive(), inactive(), Some(1)); 5]);
        assert_eq!(
            run_core(seq),
            vec![
                WatcherEvent::CandidateStarted(1),
                detected("chrome.exe"),
                ended("chrome.exe")
            ]
        );
    }

    #[test]
    fn list_update_is_ignored_while_not_running() {
        let initial = WatchLists {
            direct: vec!["a.exe".to_string()],
            gated: vec![],
        };
        let slot = Mutex::new(initial.clone());
        let next = WatchLists {
            direct: vec!["b.exe".to_string()],
            gated: vec!["chrome.exe".to_string()],
        };
        apply_list_update(false, &slot, next.clone());
        assert_eq!(*lock_recover(&slot), initial);
        apply_list_update(true, &slot, next.clone());
        assert_eq!(*lock_recover(&slot), next);
    }

    #[test]
    fn reannounce_event_repeats_only_a_live_candidate() {
        assert_eq!(reannounce_event(&WatcherCore::default()), None);

        let candidate = vec![(inactive(), chrome(), None), (inactive(), chrome(), None)];
        let (core, _) = run_core_state(candidate.clone());
        assert_eq!(
            reannounce_event(&core),
            Some(WatcherEvent::CandidateStarted(1))
        );

        let mut confirmed = candidate.clone();
        confirmed.push((inactive(), chrome(), Some(1)));
        let (core, _) = run_core_state(confirmed);
        assert_eq!(reannounce_event(&core), None);

        let mut ended_seq = candidate;
        ended_seq.extend(vec![(inactive(), inactive(), None); 5]);
        let (core, _) = run_core_state(ended_seq);
        assert_eq!(reannounce_event(&core), None);
    }

    #[test]
    fn confirm_is_rejected_while_not_running() {
        let slot = Mutex::new(None);
        assert_eq!(
            apply_confirm(false, &slot, 7),
            Err("WATCHER_NOT_RUNNING".to_string())
        );
        assert_eq!(*lock_recover(&slot), None);
        assert_eq!(apply_confirm(true, &slot, 7), Ok(()));
        assert_eq!(*lock_recover(&slot), Some(7));
    }
}
