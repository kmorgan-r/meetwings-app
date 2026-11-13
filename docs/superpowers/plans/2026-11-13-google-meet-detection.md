# Google Meet Detection (Windows step) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Google Meet call in Chrome that is on the user's Google Calendar starts and stops recording on its own on Windows, and the Teams and Meet "recording started/ended" notices become large cards.

**Architecture:** The Rust poll loop gets a second, calendar-gated state machine for `chrome.exe`. It emits candidate events, and a combined `meeting-*` stream that only a frontend calendar confirmation can open for Chrome. A frontend gate controller, owned by `useMeetingDetection`, checks Google Calendar on each candidate and confirms through a shared slot that the poll thread reads. A module-level card store, fed by `useMeetingAutoRecord` and the two calendar capture hooks, drives the cards and the window size.

**Tech Stack:** Tauri 2 (Rust, WASAPI via `windows` crate), React 19 + TypeScript, Vitest + Testing Library, Tailwind 4 + `tw-animate-css`.

**Spec:** `docs/superpowers/specs/2026-11-13-google-meet-detection-design.md` (section 8 step 1 only).

## Global Constraints

- Scope is spec section 8 step 1 (Windows). Every `isWindows()` gate stays closed: `useMeetingDetection.ts:36`, `useMeetingAutoRecord.ts:122`, `settings/index.tsx:39`, `UNSUPPORTED_PLATFORM`.
- Teams behaviour is unchanged: `START_DEBOUNCE = 2`, `END_DEBOUNCE = 3`, exact-modulo-case matching (R9). Every existing `meeting_detect` test (R1-R14) must pass unchanged.
- Gated machine: `GATED_END_DEBOUNCE = 5` polls, start debounce 2, `CARRY_OVER_MS = 120_000` measured on wall-clock `now_ms` passed in, never `Instant::now()` inside the pure code.
- Calendar match: Meet link required; not cancelled, not all-day, not declined (`isDeclined` exported from `current-meeting.ts`, not copied); `startMs - EARLY_JOIN_MS <= now < endMs`. Never `isMeetingEvent`.
- Re-check interval `MEET_RECHECK_MS = 60_000`, measured from when the previous check *finishes*. Amber snooze `AMBER_SNOOZE_MS = 3_600_000`. Same-app quiet restart `RESTART_QUIET_MS = 120_000`. Ended-card wait `ENDED_CARD_DELAY_MS = 30_000`. Red-card drain about 6s.
- Pop-up label for `chrome.exe` is exactly `"Google Meet"`.
- Amber copy, verbatim from spec 6.3: headline `If this is a Meet call, it isn't being recorded`. Reconnect body: `Google Calendar is disconnected, so Meetwings can't confirm the call. Reconnect and recording starts on its own. You won't need to rejoin.` Can't-reach body: `Meetwings can't reach Google Calendar right now. If this is a Meet call, start recording by hand, or it will start on its own once Google is reachable again.` Buttons: `Not now`, `Reconnect Google`, `Got it`.
- Toggle copy: `Automatically record Teams and Google Meet calls`.
- Every `meeting-*` event still comes from Rust. The poll thread is the only emitter and the only decider. Watcher commands from the frontend go through `useMeetingDetection`'s `enqueue` chain only.
- Rust items used only from `poll_loop` or the commands carry `#[cfg_attr(not(target_os = "windows"), allow(dead_code))]` like their siblings. The Linux CI clippy job runs `-D warnings` on the stub build.
- Toolchain: Rust 1.99.1 (as CI). Cargo always with `CARGO_TARGET_DIR=C:/Users/kmorg/meetwings-app/src-tauri/target`.
- The npm script is `type-check`, not `check:types`. Tests under `src/tests` are not type-checked by `tsc` (see the exit gate).
- Docs under `docs/` are gitignored. Stage any doc change with `git add -f`.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A candidate that fires before the gate's listeners exist.** Examples: launch during a call, or the watcher start winning the `listen()` race. Expected: the candidate is still checked. Pinned by registering the gate's listeners in `useMeetingDetection` effect 2, behind `listenersReadyRef` (Task 7 test "candidate listener is subscribed before the first start").
2. **A new episode while the previous episode's check is still in flight.** Expected: the new episode is checked at once and the old result is discarded (Task 7 test "new episode during an in-flight check").
3. **A connection change during an in-flight check.** Expected: exactly one follow-up check after the current one finishes, never two at once, never lost (Task 7 test "connection change during a check reruns once").
4. **`confirm_meeting_candidate` rejects** (the watcher died between check and confirm). Expected: no unhandled rejection; the loop schedules its next check (Task 7 test "confirm rejection keeps the loop").
5. **A card timer fires while the pill is being restored.** Expected: a restored window is never re-pilled (Task 10 Rust test `stale_restyle_is_a_noop`, frontend test "card change during restore does not restyle").

## Not in this plan (section 8 step 2, a later pipeline)

- 7.5: the `workflow_dispatch` Mac build workflow, as its own PR to `main`.
- 7.1: `meeting_detect/macos.rs`, the Core Audio process-object enumeration, and the synchronous older-macOS start error.
- 7.2: lifting the `isWindows()` gates; the per-platform Mac lists; the Mac bundle-ID prefix rule.
- 7.4: the macOS CI job.
- The Mac half of 6.5: rendering the toggle on Mac, the Meet-only Mac copy, the "Connect Google Calendar to auto-record Meet calls" note.
- The §9 "Platform (platform mocked to Mac)" Vitest cases and the manual Mac checks.

The seams for step 2 that land here: the watcher takes separate `direct`/`gated` lists; all matching stays in cfg-free pure code; labels go through `meetingLabel()`.

## Spec → task map

| Spec | Task |
|---|---|
| 6.1 two machines, candidate events, carry-over, 6.4 gated debounce | 1 |
| 6.1 combined stream, confirm slot, health once per poll, commands | 2 |
| 6.2 `EVENT_FIELDS`, Meet link on `CalendarEvent` | 3 |
| 6.2 match rule, 6.3 code grouping, 6.1 watch-list rule, label | 4 |
| 6.1 "when Chrome is watched", list update via `enqueue` | 5 |
| 6.6 card store, flap suppression, snooze state | 6 |
| 6.2 check loop, 6.3 once-per-episode amber, restart confirm | 7 |
| 6.6 publish start/stop from all four paths, card content | 8 |
| 6.6 card UI, 6.3 Reconnect/settings/Got it, amber shows window, toast removal | 9 |
| 6.6 resize decisions, pill grows upward, restore | 10 |
| 6.5 copy, 7.3 diagnostic readout | 11 |

## File map

- Create `src-tauri/src/meeting_detect/gate.rs`: pure gated machine.
- Modify `src-tauri/src/meeting_detect/mod.rs`: `WatchLists`, `Combined`, `tick`, confirm slot, new commands, readout.
- Modify `src-tauri/src/graph/mod.rs`, `src-tauri/src/graph/calendar.rs`, `src-tauri/src/google/calendar.rs`: `has_meet_link`.
- Modify `src-tauri/src/window.rs` (restyle guard), `src-tauri/src/shortcuts.rs` (`reveal_overlay`), `src-tauri/src/lib.rs` (registration).
- Create `src/lib/meeting-detect.ts`: pure watch-list, label, match and amber-kind rules.
- Create `src/lib/meet-gate.ts`: the check-loop controller (no React).
- Create `src/lib/meeting-cards.store.ts`: the card store and size helpers.
- Create `src/lib/calendar/google-connect.ts`: `reconnectGoogle`, `broadcastGoogleConnectionChanged`.
- Create `src/pages/app/components/MeetingCard.tsx`: the card UI.
- Create `src/hooks/useMeetingCardHost.ts`: subscribes to the card, reveals the window for amber, and sizes the window or pill.
- Modify `src/hooks/useMeetingDetection.ts`, `src/hooks/useMeetingAutoRecord.ts`, `src/hooks/useGoogleMeetingCapture.ts`, `src/hooks/useCalendarAutoSelect.ts`, `src/hooks/useWindow.ts`, `src/pages/app/index.tsx`, `src/pages/app/components/index.ts`, `src/pages/odoo/components/GoogleCalendarCard.tsx`, `src/pages/settings/components/MeetingAutoRecordToggle.tsx`, `src/config/constants.ts`, `src/lib/calendar/current-meeting.ts`, `src/types/calendar.ts`.

---

### Task 1: Gated state machine (Rust, pure)

**Files:**
- Create: `src-tauri/src/meeting_detect/gate.rs` (code and its `#[cfg(test)] mod tests`)
- Modify: `src-tauri/src/meeting_detect/mod.rs` (add `mod gate;` near the top, cfg-free, and make `START_DEBOUNCE` `pub(crate)` or re-declare it in `gate.rs` with a comment pointing at the original)

**Interfaces:**
- Produces (all `pub(crate)`):
  - `const GATED_END_DEBOUNCE: u32 = 5;`
  - `const CARRY_OVER_MS: i64 = 120_000;`
  - `enum GatedInput { Active(String), Inactive, Hold }`
  - `enum GatedEvent { CandidateStarted(u64), CandidateEnded(u64), EnteredCall(String), LeftCall(String) }`, derive `Debug, Clone, PartialEq, Eq`.
  - `struct GatedState`: `Default`, `Clone`, `Debug`, `PartialEq`. Private fields: phase `Idle | Candidate(u64) | Confirmed(u64)`, `active_streak`, `inactive_streak`, `current_process: Option<String>`, `last_confirmed_end_ms: Option<i64>`.
  - `impl GatedState { fn in_call_process(&self) -> Option<&str> }`: `Some` only while `Confirmed`.
  - `fn gated_step(state: GatedState, input: GatedInput, now_ms: i64, confirmed: Option<u64>, next_episode: &mut dyn FnMut() -> u64) -> (GatedState, Vec<GatedEvent>)`

**Transition table.** The pre-step runs on every input, `Hold` included: if the phase is `Candidate(e)` and `confirmed == Some(e)`, it becomes `Confirmed(e)` and emits `EnteredCall(current_process)`. The streaks are kept. Then:

| Phase | Input | Result |
|---|---|---|
| Idle | Hold | unchanged |
| Idle | Inactive | `active_streak = 0` |
| Idle | Active(n) | `active_streak += 1`. At 2: `e = next_episode()`, `current_process = n`, streaks reset. If `last_confirmed_end_ms = Some(t)` and `0 <= now_ms - t < CARRY_OVER_MS`, the phase becomes `Confirmed(e)` and emits `EnteredCall(n)`, with no candidate event. Otherwise it becomes `Candidate(e)` and emits `CandidateStarted(e)`. |
| Candidate / Confirmed | Hold | unchanged (both streaks kept) |
| Candidate / Confirmed | Active | `inactive_streak = 0` |
| Candidate(e) | Inactive | `inactive_streak += 1`. At 5: Idle, emits `CandidateEnded(e)`. Leaves `last_confirmed_end_ms` alone. |
| Confirmed(e) | Inactive | `inactive_streak += 1`. At 5: Idle, sets `last_confirmed_end_ms = Some(now_ms)`, emits `LeftCall(current_process)` |

- [ ] **Step 1: Write the failing tests** in `gate.rs`.

  Helper: `run_gated(seq: &[(GatedInput, i64, Option<u64>)]) -> (GatedState, Vec<GatedEvent>)`, with a local counter closure starting at 1. Use `A` = `Active("chrome.exe")`, `I` = Inactive, `H` = Hold, and `now = 2_000 * poll_index` unless a test says otherwise.

  - `candidate_after_two_active_polls`: `[A, A]` gives `[CandidateStarted(1)]`. `[A]` gives `[]`.
  - `three_poll_drop_does_not_end_a_gated_episode`: `[A, A, I, I, I, A]` gives only `[CandidateStarted(1)]`.
  - `five_poll_drop_ends_an_unconfirmed_episode`: `[A, A, I×5]` gives `[CandidateStarted(1), CandidateEnded(1)]`. No `LeftCall`.
  - `confirm_enters_the_call_and_leaving_emits_left_call`: `[A, A]`, then `A` with `Some(1)`, then `I×5` gives `[CandidateStarted(1), EnteredCall("chrome.exe"), LeftCall("chrome.exe")]`.
  - `a_confirmation_for_another_episode_does_nothing`: `Some(99)` on every poll gives no `EnteredCall`.
  - `a_confirmation_after_the_episode_ended_does_nothing`: end episode 1, then `[A, A]` with `Some(1)` gives `CandidateStarted(2)` and no `EnteredCall`.
  - `confirming_twice_enters_once`: `Some(1)` on 3 consecutive polls gives exactly one `EnteredCall`.
  - `hold_neither_resets_nor_advances_the_streaks`: `[A, A, I, I, H×10, I, I, I]`. `CandidateEnded(1)` appears on the last poll, not earlier.
  - `confirm_on_the_dying_poll_enters_then_leaves`: candidate at inactive streak 4; poll 5 is `I` with `Some(1)`. That poll gives `[EnteredCall, LeftCall]`, and a new `[A, A]` 10s later gives `EnteredCall` with no `CandidateStarted` (carry-over armed).
  - `carry_over_just_under_two_minutes_confirms_at_once`: confirmed episode leaves at `t`; the start poll at `t + 119_999` gives `[EnteredCall("chrome.exe")]` and no `CandidateStarted`.
  - `carry_over_at_exactly_two_minutes_is_a_candidate`: the start poll at `t + 120_000` gives `CandidateStarted(2)`.
  - `an_unconfirmed_end_arms_no_carry_over`: candidate ends at `t`; `[A, A]` at `t + 10_000` gives `CandidateStarted(2)`.
  - `a_long_wall_clock_gap_does_not_carry_over`: confirmed episode leaves at `t`; the next two `A` polls at `t + 3_600_000` and `t + 3_602_000` give `CandidateStarted(2)`.
  - `in_call_process_is_some_only_while_confirmed`.

- [ ] **Step 2: Run them, expect compile failure / FAIL**

  Run: `CARGO_TARGET_DIR=C:/Users/kmorg/meetwings-app/src-tauri/target cargo test --manifest-path src-tauri/Cargo.toml meeting_detect::gate`

- [ ] **Step 3: Implement `gated_step`** per the table.

- [ ] **Step 4: Run Step 2's command, then the whole module (`meeting_detect`).** Expected: all pass, R1-R14 untouched.

- [ ] **Step 5: Commit**

  `git add src-tauri/src/meeting_detect/gate.rs src-tauri/src/meeting_detect/mod.rs`
  `git commit -m "feat(meeting-detect): calendar-gated state machine for Chrome"`

---

### Task 2: Two lists, combined stream, confirm slot (Rust)

**Files:**
- Modify: `src-tauri/src/meeting_detect/mod.rs`
- Modify: `src-tauri/src/lib.rs:233-235` (register the new commands)
- Modify: `src/hooks/useMeetingDetection.ts:94-95` (minimal caller switch, so this commit still starts a watcher)
- Test: `src/tests/useMeetingDetection.lifecycle.test.tsx` (the four `processes:` assertions)

**Interfaces:**
- Consumes: Task 1's `gated_step`, `GatedInput`, `GatedEvent`, `GatedState`.
- Produces:
  - `#[derive(Debug, Clone, Default, PartialEq, Eq)] pub struct WatchLists { pub direct: Vec<String>, pub gated: Vec<String> }`. `MeetingWatcherState.watch_list` becomes `Arc<Mutex<WatchLists>>`. One mutex holds both lists, so a poll never reads a torn pair.
  - `MeetingWatcherState.confirmed: Arc<Mutex<Option<u64>>>`, passed into `poll_loop`.
  - `WatcherEvent` gains `CandidateStarted(u64)` and `CandidateEnded(u64)`.
  - `struct Combined { direct: bool, gated: bool, open: Option<String> }` (`Default`) with `fn apply(&mut self, side: Side, entered: bool, process: &str) -> Option<WatcherEvent>`, where `enum Side { Direct, Gated }`.
    - It emits `Detected(process)` when neither side was in a call before.
    - It emits `Ended(open)` when neither side is in a call after. The ended event carries the process that **opened** the combined call.
  - `#[derive(Default)] struct WatcherCore { direct: MachineState, gated: GatedState, combined: Combined }`
  - `fn tick(core: &mut WatcherCore, direct: PollOutcome, gated: PollOutcome, now_ms: i64, confirmed: Option<u64>, next_episode: &mut dyn FnMut() -> u64) -> Vec<WatcherEvent>`
    - `direct` goes through the existing `step`, which stays unchanged. Its `Detected`/`Ended` feed `combined.apply(Side::Direct, ..)` and are not returned raw. Its `Degraded`/`Stopped` are returned as-is, so health is counted once per poll.
    - `gated` maps to a `GatedInput`: `Classified(Active(n))` → `Active(n)`, `Classified(Inactive)` → `Inactive`, and `Unknown` or `Failed` → `Hold`. The result goes through `gated_step`. `CandidateStarted`/`CandidateEnded` are returned as `WatcherEvent`s, and `EnteredCall`/`LeftCall` feed `combined.apply(Side::Gated, ..)`.
    - Return order: candidate events, then combined events in the order they occurred (direct edges first, then gated), then `Degraded`/`Stopped`.
  - `static NEXT_EPISODE: AtomicU64 = AtomicU64::new(1);`. `poll_loop` passes `&mut || NEXT_EPISODE.fetch_add(1, Ordering::SeqCst)`. It is process-wide, so episode ids stay unique across watcher restarts.
  - Commands, each returning `Err(UNSUPPORTED_PLATFORM)` off Windows like their siblings:
    - `start_meeting_watcher(app, direct: Vec<String>, gated: Vec<String>) -> Result<(), String>`. Same plan as today; it stores `WatchLists { direct, gated }`.
    - `update_meeting_watch_lists(app, direct, gated) -> Result<(), String>`. It writes the lists **only while `running`**; otherwise it returns `Ok(())` and does nothing. It never spawns. The logic sits in a pure `fn apply_list_update(running: bool, slot: &Mutex<WatchLists>, lists: WatchLists)`.
    - `confirm_meeting_candidate(app, episode: u64) -> Result<(), String>` sets `*confirmed = Some(episode)` and emits nothing.
  - Events emitted by `poll_loop`: `meeting-candidate-started { episode }` and `meeting-candidate-ended { episode }`, through a new `#[derive(Serialize, Clone)] struct EpisodePayload { episode: u64 }`. `meeting-detected` and `meeting-ended` keep `ProcessPayload`.
  - `poll_loop`: reads `watch_list` and `confirmed` at the top of each poll. On `Ok(sessions)` it builds `PollOutcome::Classified(classify(&sessions, &lists.direct, own_pid))` and the same for `lists.gated`; on an error or panic, both are `Failed`. The existing `error_episode` / recovered logic keeps reading the **direct** outcome. `now_ms` comes from `SystemTime::now()` since `UNIX_EPOCH`, in milliseconds. It emits every returned event and breaks after `Stopped`, as today.

- [ ] **Step 1: Write the failing tests** in `mod.rs` tests.

  Helper: `run_core(seq: Vec<(PollOutcome, PollOutcome, Option<u64>)>) -> Vec<WatcherEvent>`, with `now = 2_000 * i` and a local episode counter. Helper outcomes are `teams()`, `chrome()`, `inactive()`, `unknown()`, `failed()`.

  - `classify_per_list_in_both_enumeration_orders`: for sessions `[chrome active 300, teams active 301]` and the reverse, `classify(.., &direct)` is `Active("ms-teams.exe")` and `classify(.., &["chrome.exe"])` is `Active("chrome.exe")`.
  - `chrome_matching_mirrors_the_teams_rules`: `CHROME.EXE` matches (case); own pid excluded; all unresolved is `Unknown`.
  - `teams_starts_while_chrome_is_a_candidate`: gated `chrome()` ×2 (candidate), then direct `teams()` ×2 gives `[CandidateStarted(1), Detected("ms-teams.exe")]`.
  - `an_unconfirmed_gated_episode_emits_no_meeting_events`: gated `chrome()` ×2, `inactive()` ×5 gives only candidate events.
  - `confirm_then_leave_emits_detected_then_ended`: candidate, then a confirm poll gives `Detected("chrome.exe")`; then gated `inactive()` ×5 gives `Ended("chrome.exe")`.
  - `teams_ending_inside_a_confirmed_meet_call_emits_no_ended`: confirmed Meet; Teams starts (no new `Detected`); Teams ends after 3 inactive polls (no `Ended`); Meet ends gives `Ended("chrome.exe")`.
  - `ended_carries_the_process_that_opened_the_call`: Teams opens, Meet is confirmed, Teams ends, then Meet ends: one `Ended("ms-teams.exe")`.
  - `teams_only_sequences_are_unchanged`: the R1/R2/R3 sequences fed as `(seq[i], inactive(), None)` give exactly the events `run(seq)` gives.
  - `one_bad_poll_raises_one_degraded`: 15 polls of `(unknown(), unknown())` give exactly one `Degraded`. 30 polls of `(failed(), failed())` give exactly one `Stopped`.
  - `emptying_the_gated_list_ends_a_live_episode_after_the_debounce`: confirmed Meet; then sessions still show chrome active but are classified against an empty gated list. That is `Inactive`, and the fifth such poll gives `Ended`.
  - `list_update_is_ignored_while_not_running`: `apply_list_update(false, ..)` leaves the slot unchanged; `true` replaces it.

- [ ] **Step 2: Run, expect FAIL.** Command: `CARGO_TARGET_DIR=C:/Users/kmorg/meetwings-app/src-tauri/target cargo test --manifest-path src-tauri/Cargo.toml meeting_detect`

- [ ] **Step 3: Implement.**
  - Register `update_meeting_watch_lists` and `confirm_meeting_candidate` in `lib.rs` next to the other `meeting_detect::` commands.
  - Switch the caller in the same commit, so no commit ships a watcher that fails to start and flips the toggle off: `startWatcher = () => invoke("start_meeting_watcher", { direct: MEETING_DETECT_PROCESSES, gated: [] })`.
  - Change the four `processes: MEETING_DETECT_PROCESSES` expectations in `useMeetingDetection.lifecycle.test.tsx` (lines ~131, 145, 423, 453) to `{ direct: MEETING_DETECT_PROCESSES, gated: [] }`.
  - Task 5 replaces the fixed lists with the Google-aware ones.

- [ ] **Step 4: Run Step 2's command, then `CARGO_TARGET_DIR=C:/Users/kmorg/meetwings-app/src-tauri/target cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings`, then `npx vitest run src/tests/useMeetingDetection.lifecycle.test.tsx`.** Expected: all pass, no warnings.

- [ ] **Step 5: Commit**

  `git add src-tauri/src/meeting_detect/mod.rs src-tauri/src/lib.rs src/hooks/useMeetingDetection.ts src/tests/useMeetingDetection.lifecycle.test.tsx`
  `git commit -m "feat(meeting-detect): direct and gated lists, combined stream, candidate confirm"`

---

### Task 3: Meet link on the calendar event (Rust + type)

**Files:**
- Modify: `src-tauri/src/graph/mod.rs:31-44` (field) and the test literal at `:891`
- Modify: `src-tauri/src/graph/calendar.rs:214` (`has_meet_link: false`)
- Modify: `src-tauri/src/google/calendar.rs:11` (`EVENT_FIELDS`), `:237` (parse), tests
- Modify: `src/types/calendar.ts:69-80`
- Test: `src/tests/current-meeting.test.ts`, `src/tests/fetch-google-meetings.test.ts` (fixtures)

**Interfaces:**
- Produces:
  - Rust `CalendarEvent.has_meet_link: bool` with `#[serde(default)]`, serialized as `hasMeetLink`.
  - TS `CalendarEvent.hasMeetLink: boolean`.
  - `EVENT_FIELDS` gains `hangoutLink,conferenceData(conferenceSolution(key(type)))` inside `items(...)`.
  - Google parse: `has_meet_link = hangoutLink is a non-empty string || conferenceData.conferenceSolution.key.type == "hangoutsMeet"`. Graph always sets `false`.

- [ ] **Step 1: Write the failing Rust tests** in `google/calendar.rs`.
  - `meet_link_from_hangout_link`: `ONE_OFF` plus `"hangoutLink":"https://meet.google.com/abc-defg-hij"` gives `has_meet_link == true`.
  - `meet_link_from_a_hangouts_meet_conference`: `"conferenceData":{"conferenceSolution":{"key":{"type":"hangoutsMeet"}}}` gives `true`.
  - `another_conference_type_is_not_a_meet_link`: `"type":"addOn"` (how Zoom's add-on appears) gives `false`.
  - `no_conference_is_not_a_meet_link`: `ONE_OFF` gives `false`.
  - `event_fields_ask_for_the_meet_link`: `EVENT_FIELDS` contains `"hangoutLink"` and `"conferenceData(conferenceSolution(key(type)))"` and still not `"description"`. Extend the existing `events_url_asks_for_single_events_and_never_the_description` rather than adding a duplicate URL test.
  - In `graph/calendar.rs`, add `assert!(!event.has_meet_link)` to the existing normalization test that checks one parsed Graph event.

- [ ] **Step 2: Run, expect FAIL.** `CARGO_TARGET_DIR=C:/Users/kmorg/meetwings-app/src-tauri/target cargo test --manifest-path src-tauri/Cargo.toml calendar`

- [ ] **Step 3: Implement** the field, the parse and the literals. In TS, add `hasMeetLink: boolean` to `CalendarEvent` with a one-line doc ("Google: Meet link present; Graph: always false"). Add `hasMeetLink: false` to the event builders in the two test files named above.

- [ ] **Step 4: Run** Step 2's command and `npm run type-check`, then `npx vitest run src/tests/current-meeting.test.ts src/tests/fetch-google-meetings.test.ts`. Expected: all pass.

- [ ] **Step 5: Commit**

  `git add src-tauri/src/graph/mod.rs src-tauri/src/graph/calendar.rs src-tauri/src/google/calendar.rs src/types/calendar.ts src/tests/current-meeting.test.ts src/tests/fetch-google-meetings.test.ts`
  `git commit -m "feat(calendar): read the Google Meet link into CalendarEvent"`

---

### Task 4: Pure frontend rules

**Files:**
- Create: `src/lib/meeting-detect.ts`
- Modify: `src/config/constants.ts:95-107`, `src/lib/calendar/current-meeting.ts:26` (`export function isDeclined`)
- Test: `src/tests/meeting-detect.test.ts`

**Interfaces:**
- Consumes: Task 3's `hasMeetLink`.
- Produces:
  - Constants: `MEETING_DETECT_GATED_PROCESSES = ["chrome.exe"]`; `MEETING_DETECT_LABELS["chrome.exe"] = "Google Meet"`; `MEET_RECHECK_MS = 60_000`.
  - `export interface WatchLists { direct: string[]; gated: string[] }`
  - `export function computeWatchLists(configState: GoogleConfigState["state"]): WatchLists`: `direct = MEETING_DETECT_PROCESSES`; `gated = configState === "absent" ? [] : MEETING_DETECT_GATED_PROCESSES`.
  - `export async function currentWatchLists(): Promise<WatchLists>`: `computeWatchLists((await loadGoogleConfigState()).state)`.
  - `export function meetingLabel(process?: string): string`: the lowercased lookup into `MEETING_DETECT_LABELS`, otherwise `MEETING_DETECT_FALLBACK_LABEL`.
  - `export function isGatedProcess(process?: string): boolean`: case-insensitive membership in `MEETING_DETECT_GATED_PROCESSES`.
  - `export function hasQualifyingMeetEvent(events: CalendarEvent[], nowMs: number): boolean`
  - `export type AmberKind = "reconnect" | "settings" | "offline"`
  - `export function amberKindFor(code: GoogleErrorCode, configState: GoogleConfigState["state"]): AmberKind`:
    - `configState !== "complete"` → `"settings"`;
    - `GOOGLE_AUTH_EXPIRED | GOOGLE_AUTH_REJECTED | GOOGLE_CONSENT_REQUIRED | GOOGLE_AUTH_CANCELLED | GOOGLE_NOT_CONNECTED` → `"reconnect"`;
    - everything else (`NETWORK`, `THROTTLED`, `BAD_RESPONSE`, `NO_KEYCHAIN`) → `"offline"`.

- [ ] **Step 1: Write the failing tests** (`meeting-detect.test.ts`). Use an event builder with `hasMeetLink: true`, a 30-min event `startMs = NOW + 10min`, and two participants.
  - Match rule:
    - `requires a Meet link` (`hasMeetLink: false` → false).
    - `accepts now == startMs - EARLY_JOIN_MS` → true; `startMs - EARLY_JOIN_MS - 1` → false.
    - `rejects now == endMs` → false; `endMs - 1` → true.
    - `accepts a solo event` (1 participant) → true.
    - `rejects declined, cancelled and all-day` (three cases) → false.
    - `any qualifying event among several` → true.
  - `amberKindFor`: each of the 5 reconnect codes with `"complete"` → `"reconnect"`; each of the 4 others → `"offline"`; `"unreadable"` with `GOOGLE_AUTH_REJECTED` → `"settings"`.
  - `computeWatchLists`: `"absent"` → `{ direct: MEETING_DETECT_PROCESSES, gated: [] }`; `"unreadable"` and `"complete"` → `gated: ["chrome.exe"]`.
  - `meetingLabel`: `"CHROME.EXE"` → `"Google Meet"`; `"MS-Teams.exe"` → `"Teams"`; `undefined` and `"zoom.exe"` → `"Meeting"`.
  - `isGatedProcess("Chrome.exe")` → true; `("ms-teams.exe")` → false.

- [ ] **Step 2: Run, expect FAIL.** `npx vitest run src/tests/meeting-detect.test.ts`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** Step 2's command, plus `npx vitest run src/tests/current-meeting.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `git add src/lib/meeting-detect.ts src/config/constants.ts src/lib/calendar/current-meeting.ts src/tests/meeting-detect.test.ts`, then `git commit -m "feat(meeting-detect): watch-list, label and Meet match rules"`

---

### Task 5: Watcher lists from the Google setup

**Files:**
- Modify: `src/hooks/useMeetingDetection.ts:16-18` (`label` → `meetingLabel`), `:94-95` (`startWatcher`), effect 2 (connection-changed listener)
- Test: `src/tests/useMeetingDetection.lifecycle.test.tsx`

**Interfaces:**
- Consumes: Task 2's `start_meeting_watcher { direct, gated }` and `update_meeting_watch_lists { direct, gated }`; Task 4's `currentWatchLists`, `meetingLabel`.
- Produces: `startWatcher = async () => invoke("start_meeting_watcher", { ...(await currentWatchLists()) })`. This is used by both the lifecycle start and the Retry path.

The list is computed **inside** the enqueued op (it reads secure storage asynchronously). The connection-changed handler, registered in effect 2 for `GOOGLE_CONNECTION_CHANGED_EVENT`, does:
`enqueue(async () => { if (!enabledRef.current) return; await invoke("update_meeting_watch_lists", { ...(await currentWatchLists()) }); })`.
It never stops or starts the watcher. Rust ignores the update when no watcher is running.

- [ ] **Step 1: Add tests.** Mock `@/lib/storage/google-config.storage`'s `loadGoogleConfigState` with `vi.mock` + `importActual`, so `GOOGLE_CONNECTION_CHANGED_EVENT` stays real. By default it resolves `{ state: "absent", config: null }`, which keeps Task 2's four `{ direct, gated: [] }` assertions true.
  - `starts with Chrome gated once Google is set up`: config `complete` gives `gated: ["chrome.exe"]`; config `unreadable` gives the same.
  - `a connection change updates the lists in place`: enabled and started; config becomes `complete`; fire the connection-changed event. Exactly one `update_meeting_watch_lists` with `gated: ["chrome.exe"]`, and no further `start_meeting_watcher` or `stop_meeting_watcher`.
  - `no list update while auto-record is off`.
  - `the list update waits behind an in-flight watcher command`: hold `start_meeting_watcher` on a deferred promise; fire connection-changed; the update is not invoked until the start resolves.

- [ ] **Step 2: Run, expect FAIL.** `npx vitest run src/tests/useMeetingDetection.lifecycle.test.tsx`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** Step 2's command. Expected: PASS, including the unchanged StrictMode/F-series tests.
- [ ] **Step 5: Commit** `git add src/hooks/useMeetingDetection.ts src/tests/useMeetingDetection.lifecycle.test.tsx`, then `git commit -m "feat(meeting-detect): watch Chrome when Google Calendar is set up"`

---

### Task 6: Meeting card store

**Files:**
- Create: `src/lib/meeting-cards.store.ts`
- Test: `src/tests/meeting-cards.store.test.ts`

**Interfaces:**
- Consumes: `participantsOf` (`src/lib/calendar/match-attendees.ts`), `PILL_DIMENSIONS` and `OverlayPillStyle`, Task 4's `AmberKind`.
- Produces:

```ts
export const RESTART_QUIET_MS = 120_000;
export const ENDED_CARD_DELAY_MS = 30_000;
export const AMBER_SNOOZE_MS = 3_600_000;
export const BAR_HEIGHT = 54;
export const CARD_GAP = 8;
export const PILL_CARD_WIDTH = 300;
export interface CardEvent { title: string | null; startMs: number; endMs: number; initials: string[]; extraCount: number }
export type MeetingCard =
  | { kind: "recording"; recordingId: number; app: string; startedAt: number; event: CardEvent | null }
  | { kind: "ended"; app: string; title: string | null; durationMs: number }
  | { kind: "amber"; variant: AmberKind; episode: number; error: string | null }
  | null;
export interface ActiveAutoRecording { id: number; app: string; gated: boolean; startedAt: number; event: CardEvent | null }
export function getMeetingCard(): MeetingCard;            // stored reference (useSyncExternalStore)
export function subscribeToMeetingCard(l: () => void): () => void;
export function autoRecordingStarted(input: { app: string; gated: boolean; stop: () => void }, now?: number): number;
export function autoRecordingStopped(now?: number): void; // idempotent
export function getActiveAutoRecording(): ActiveAutoRecording | null;
export function stopActiveRecording(): void;              // calls the registered stop
export function setCardEvent(recordingId: number, event: CalendarEvent): void;
export function showAmber(a: { variant: AmberKind; episode: number }, now?: number): void;
export function setAmberError(message: string | null): void;
export function snoozeAmber(now?: number): void;
export function dismissAmber(): void;                     // clears only an amber card
export function dismissCard(): void;                      // clears whatever is shown
export function cardHeight(card: MeetingCard, compact: boolean): number; // 0 for null
export function pillWindowSize(style: OverlayPillStyle, card: MeetingCard): { width: number; height: number };
export function resetMeetingCardsForTests(): void;
```

Rules (one slot, so the last writer wins, with the exceptions below):
- **Card heights** are per-variant constants (full and compact), not measured, because jsdom has no layout. `MeetingCard.tsx` renders each variant at exactly `cardHeight(card, compact)` px. A recording card with an event is taller than one without. The values are the builder's, within the mockups.
- **`pillWindowSize`**:
  - `card === null` → `PILL_DIMENSIONS[style]`.
  - Otherwise `{ width: max(pill.width, PILL_CARD_WIDTH), height: pill.height + CARD_GAP + cardHeight(card, true) }`.
- **`autoRecordingStarted`** assigns `id = ++seq`.
  - If the same app's last auto stop was under `RESTART_QUIET_MS` ago, it is a **quiet restart**:
    - cancel that app's pending ended card;
    - carry `startedAt` and `event` over from the stopped recording;
    - leave the card slot unchanged.
  - Otherwise the slot becomes a recording card. That replaces amber or ended.
- **`autoRecordingStopped`**: a no-op with no active recording. Otherwise it:
  - records `{ at: now, startedAt, event }` as the app's last stop;
  - clears the slot if it holds this recording's card;
  - schedules the ended card after `ENDED_CARD_DELAY_MS`, with `durationMs = now - startedAt` and `title = event?.title ?? null`. When the timer fires, the ended card is skipped if the slot holds an amber card.
- **`setCardEvent(id, ev)`**: ignored unless `id` is the active recording's id. It sets `active.event`, and the card if the card is that recording's.
  - `initials` come from `participantsOf(ev)`: the first letters of the first and last words of the name, or else the first letter of the address. At most 3 are kept, and the rest go to `extraCount`.
- **`showAmber`**: a no-op while `now < snoozedUntil` or while an auto recording is active. Otherwise the slot becomes amber with `error: null`. `snoozeAmber` sets `snoozedUntil = now + AMBER_SNOOZE_MS` and dismisses the amber card.

- [ ] **Step 1: Write the failing tests** (fake timers; `resetMeetingCardsForTests()` in `beforeEach`).
  - `a start shows the red card`: kind `recording`, app `"Google Meet"`, id returned.
  - `same-app restart within 2 minutes shows no red card and cancels the ended card`: start, stop, `dismissCard()`, restart at +60s gives `null`; advance 30s gives still `null`.
  - `a different app within 2 minutes gets its own red card`.
  - `same-app restart after 2 minutes gets a red card`.
  - `the ended card waits 30s`: `null` at +29_999, `ended` at +30_000 with `durationMs` = stop − start.
  - `a quiet restart carries the start time and event`: start at 0, stop at 60s, restart at 90s, stop at 300s; the ended card has `durationMs === 300_000` and the first recording's title.
  - `stopping twice schedules one ended card`.
  - `setCardEvent fills the current card and ignores a stale id`: 5 participants give 3 initials and `extraCount: 2`; a resource attendee is not counted.
  - `amber shows, snoozes for an hour, and shows again after it`: snooze at 0; `showAmber` at +3_599_999 gives `null`; at +3_600_000 gives `amber`.
  - `no amber while an auto recording is active`.
  - `a red card replaces amber; an ended card never does`.
  - `dismissAmber leaves a recording card alone`.
  - `getMeetingCard is reference-stable between changes` (`Object.is`).
  - `pillWindowSize`: `null` → `PILL_DIMENSIONS["icon-only"]`; with a card → width 300 and height `52 + 8 + cardHeight(card, true)`.
  - `stopActiveRecording calls the registered stop once`.

- [ ] **Step 2: Run, expect FAIL.** `npx vitest run src/tests/meeting-cards.store.test.ts`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** Step 2's command. Expected: PASS.
- [ ] **Step 5: Commit** `git add src/lib/meeting-cards.store.ts src/tests/meeting-cards.store.test.ts`, then `git commit -m "feat(cards): meeting card store with flap suppression and snooze"`

---

### Task 7: The calendar check loop

**Files:**
- Create: `src/lib/meet-gate.ts`
- Modify: `src/hooks/useMeetingDetection.ts` (create the controller, register its listeners in effect 2, stop it on setting-off, watcher-stopped and effect-2 cleanup)
- Test: `src/tests/meet-gate.test.ts`, `src/tests/useMeetingDetection.lifecycle.test.tsx`

**Interfaces:**
- Consumes:
  - Task 2's `confirm_meeting_candidate { episode }` and the candidate events;
  - Task 4's `hasQualifyingMeetEvent`, `amberKindFor`, `MEET_RECHECK_MS`;
  - Task 6's `showAmber`, `dismissAmber`, `getActiveAutoRecording`;
  - `fetchCurrentGoogleMeetings`, `loadGoogleConfigState`.
- Produces:

```ts
export interface MeetGateDeps {
  loadConfigState: () => Promise<GoogleConfigState["state"]>;
  fetchMeetings: (now: number) => Promise<FetchGoogleMeetingsResult>;
  confirm: (episode: number) => Promise<unknown>;
  captureRunning: () => Promise<boolean>;
  gatedRecordingRunning: () => boolean;
  showAmber: (a: { variant: AmberKind; episode: number }) => void;
  dismissAmber: () => void;
  now: () => number;
}
export interface MeetGate {
  candidateStarted(episode: number): void;
  candidateEnded(episode: number): void;
  connectionChanged(): void;
  stop(): void;
}
export function createMeetGate(deps: MeetGateDeps): MeetGate;
export function defaultMeetGateDeps(): MeetGateDeps;
```

`defaultMeetGateDeps` wiring:
- `captureRunning` = `invoke<boolean>("get_capture_status").catch(() => false)`, OR an active auto recording. It defaults to false, so an unreadable status shows the warning rather than hiding it. `getPillData()` is not used: it is written only by `<Completion />` and goes stale when that unmounts.
- `gatedRecordingRunning` = `getActiveAutoRecording()?.gated === true`.
- `confirm` = `invoke("confirm_meeting_candidate", { episode })`.

Controller behaviour. State: `live: number | null`, `inFlight: number | null`, `rerun: boolean`, `timer`, `amberShownFor: number | null`.
- `candidateStarted(e)`:
  - sets `live = e`, clears the timer, sets `amberShownFor = null`;
  - if `gatedRecordingRunning()` (the watcher restarted under a gate-confirmed recording), it calls `confirm(e)` with no fetch and sets `live = null`;
  - otherwise it calls `runCheck(e)`.
- `runCheck(e)`:
  - if `inFlight === e`, set `rerun = true` and return;
  - otherwise `inFlight = e`, `configState = await loadConfigState()`, `result = await fetchMeetings(now())`, `inFlight = null`;
  - if `live !== e`, return (the result is discarded).
- Result handling:
  - **`ok` with a qualifying event:** `await confirm(e)`. On success: `live = null`, `dismissAmber()`, return. On rejection: log it and fall through to scheduling.
  - **`ok` with no qualifying event:** `dismissAmber()`. The calendar is reachable, so the card's claim no longer holds. *(My call, see the PR body.)*
  - **`error`:** if `amberShownFor !== e` and `!(await captureRunning())`, set `amberShownFor = e` and call `showAmber({ variant: amberKindFor(code, configState), episode: e })`.
  - **`absent`:** nothing.
- Then: if `rerun`, clear it and `runCheck(e)` now; otherwise schedule `runCheck(e)` in `MEET_RECHECK_MS`.
- `connectionChanged()`: if `live !== null`, clear the timer and call `runCheck(live)`.
- `candidateEnded(e)`: if `live === e`, set `live = null`, clear the timer and `dismissAmber()`. `stop()` does the same unconditionally.

Wiring in `useMeetingDetection`:
- The controller is created in effect 2's body (`gateRef.current = createMeetGate(defaultMeetGateDeps())`) and stopped in its cleanup, so a StrictMode remount leaks no timer.
- Effect 2's `Promise.all` registers these handlers, so the `listenersReadyRef` gate covers them:
  - `meeting-candidate-started` → `if (enabledRef.current) gateRef.current?.candidateStarted(payload.episode)`;
  - `meeting-candidate-ended` → `candidateEnded`;
  - `GOOGLE_CONNECTION_CHANGED_EVENT` → `connectionChanged()`, alongside Task 5's list update.
- `meeting-watcher-stopped` also calls `gateRef.current?.stop()`.
- Effect 1's `meeting-detection-setting-changed` calls `gateRef.current?.stop()` when `enabled` is false.

- [ ] **Step 1: Write the failing tests.**

  `meet-gate.test.ts` uses fake timers and fake deps; `fetchMeetings` is a `vi.fn` returning controllable deferreds.
  - `checks on candidate start and confirms a qualifying event`: `confirm(1)` called; no fetch after advancing 60s.
  - `rechecks 60s after the previous check finishes`: fetch 1 resolves (no match) at +5s; fetch 2 starts at +65s, not at +60s.
  - `never overlaps checks`: a fetch held 90s gives no second fetch until it resolves.
  - `candidate end stops the loop and dismisses the amber card`.
  - `stop stops the loop and dismisses`.
  - `a result for an ended episode is discarded`: `candidateEnded(1)` while fetch 1 is pending; a qualifying result gives no `confirm` and no `showAmber`.
  - `connection change checks at once`: a pending 60s timer; `connectionChanged()` gives an immediate fetch.
  - `connection change during a check reruns once`: two `connectionChanged()` calls mid-fetch give exactly one more fetch, which starts after the first resolves.
  - `new episode during an in-flight check`: `candidateStarted(2)` while fetch 1 is pending gives fetch 2 at once; fetch 1's qualifying result gives no `confirm(1)`.
  - `confirm rejection keeps the loop`: `confirm` rejects; no unhandled rejection; the next fetch comes at +60s.
  - `the amber card shows once per episode`: two failing checks give one `showAmber`. The variant is `"reconnect"` for `GOOGLE_AUTH_EXPIRED` and `"settings"` when `loadConfigState` gives `"unreadable"`.
  - `no amber while a capture is running`.
  - `a gated recording already running confirms without a check`: `gatedRecordingRunning() === true` gives `confirm(1)` and no fetch.
  - `a successful read with no Meet event dismisses the amber card`.

  `useMeetingDetection.lifecycle.test.tsx`: mock `@/lib/meet-gate` so `createMeetGate` returns spies.
  - `candidate listener is subscribed before the first start`.
  - `candidate events reach the gate only while auto-record is on`.
  - `turning auto-record off stops the gate`.
  - `meeting-watcher-stopped stops the gate`.
  - `StrictMode creates one live gate`: the first gate's `stop` is called on the discarded mount.

- [ ] **Step 2: Run, expect FAIL.** `npx vitest run src/tests/meet-gate.test.ts src/tests/useMeetingDetection.lifecycle.test.tsx`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** Step 2's command. Expected: PASS.
- [ ] **Step 5: Commit** `git add src/lib/meet-gate.ts src/hooks/useMeetingDetection.ts src/tests/meet-gate.test.ts src/tests/useMeetingDetection.lifecycle.test.tsx`, then `git commit -m "feat(meeting-detect): calendar check loop confirms Meet candidates"`

---

### Task 8: Publish recordings and card content

**Files:**
- Modify: `src/hooks/useMeetingAutoRecord.ts`. The changes are at `:178` (release branch), `:294` (`handleDetected` signature), `:396-409` (meeting start), `:434-436` (transcribing start), `:497` (`handleStop`), `:553-559` (unmount), `:594-596` (listener passes `payload?.process`) and `:608-610` (`capture-stopped`).
- Modify: `src/hooks/useGoogleMeetingCapture.ts:115-137`, `src/hooks/useCalendarAutoSelect.ts:88-99`
- Test: `src/tests/useMeetingAutoRecord.lifecycle.test.tsx`, `src/tests/google-meeting-capture.test.tsx`, `src/tests/useCalendarAutoSelect.test.tsx`

**Interfaces:**
- Consumes: Task 6's `autoRecordingStarted`, `autoRecordingStopped`, `getActiveAutoRecording`, `setCardEvent`; Task 4's `meetingLabel`, `isGatedProcess`.
- Produces: no new exports.

Pinned edits:
- `register("meeting-detected", (payload) => enqueue(() => handleDetected(payload?.process)))`.
- **Meeting mode.** In the `start-meeting` branch, in the same synchronous block, call `autoRecordingStarted({ app: meetingLabel(process), gated: isGatedProcess(process), stop: () => setEnableVADRef.current(false) })` right **before** `setEnableVADRef.current(true)`. That way, when `meetingCaptureStarted` fires, the capture hooks see the new recording.
- **Transcribing mode.** Right after `startedModeRef.current = "transcribing"`, call the same with `stop: () => void systemAudioRef.current.stopCapture()`.
- **`autoRecordingStopped()` on all four stop paths:**
  - `handleStop`, right after the `startedModeRef.current = null` at `:497`;
  - the layout effect's release branch, next to `startedModeRef.current = null` at `:178`;
  - **inside** the existing `if (startedModeRef.current === "transcribing")` guard in `capture-stopped`. That guard is what ignores the internal stop issued before a VAD start;
  - the unmount cleanup, inside `if (startedModeRef.current)`.
  - The store is idempotent, so the unmount-then-`handleStop` double call is harmless.
- **`useGoogleMeetingCapture.run`.** Read `const rec = getActiveAutoRecording()` synchronously at the top. After the `seq`/`gen` guard, when `rec?.gated` is true and `pick?.kind === "one"`, call `setCardEvent(rec.id, pick.event)`.
- **`useCalendarAutoSelect.run`.** Read `rec` the same way at the top of `run`. After `fetched.kind === "ok"`, when `rec && !rec.gated` and `pickCurrentMeeting(fetched.events, Date.now())` gives `"one"`, call `setCardEvent(rec.id, …)`.
- **Card content only comes from reads that already happen.** `meetingCaptureStarted` fires only on the meeting-assist edge of a conversation with no meeting lines (`useCompletion.ts:1554-1587`), and auto-select fetches only when it is enabled and contacts are loaded. A transcribing-mode recording, or a Teams call without auto-select, therefore shows the top row only. That is the spec's no-single-event form. Do not add new calendar reads.

- [ ] **Step 1: Write the failing tests** (`resetMeetingCardsForTests()` in `beforeEach`).

  `useMeetingAutoRecord.lifecycle.test.tsx`:
  - `a transcribing auto start publishes the recording with its app`: `meeting-detected { process: "chrome.exe" }` gives an active recording with app `"Google Meet"`, `gated: true`, and a recording card.
  - `a meeting-mode auto start publishes before the mic opens`: the active recording exists by the time the `setEnableVAD(true)` spy runs.
  - `a detection that starts nothing publishes nothing`: auto-record off; capturing by hand.
  - `meeting-ended publishes the stop`: the ended card is shown after 30s.
  - `the user closing the mic in meeting mode publishes the stop`.
  - `capture-stopped during a transcribing auto recording publishes the stop`.
  - `the internal stop before a VAD start publishes nothing`: the `startCapture` mock fires `capture-stopped` before resolving, and the recording is still active afterwards.
  - `unmount during an auto recording publishes the stop`.
  - `the card's Stop closes the mic in meeting mode`: `stopActiveRecording()` gives `setEnableVAD(false)`.

  `google-meeting-capture.test.tsx`:
  - `a gated auto recording gets the picked event`;
  - `several or no events leave the card empty`;
  - `no auto recording publishes nothing`.

  `useCalendarAutoSelect.test.tsx`: `a Teams auto recording gets the picked Outlook event`.

- [ ] **Step 2: Run, expect FAIL.** `npx vitest run src/tests/useMeetingAutoRecord.lifecycle.test.tsx src/tests/google-meeting-capture.test.tsx src/tests/useCalendarAutoSelect.test.tsx`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** Step 2's command. Expected: PASS, with every existing F-series test unchanged.
- [ ] **Step 5: Commit** `git add src/hooks/useMeetingAutoRecord.ts src/hooks/useGoogleMeetingCapture.ts src/hooks/useCalendarAutoSelect.ts src/tests/useMeetingAutoRecord.lifecycle.test.tsx src/tests/google-meeting-capture.test.tsx src/tests/useCalendarAutoSelect.test.tsx`, then `git commit -m "feat(cards): publish auto recordings and their calendar event"`

---

### Task 9: The cards, Reconnect, and showing a hidden bar

**Files:**
- Create: `src/pages/app/components/MeetingCard.tsx` (export it from `src/pages/app/components/index.ts`)
- Create: `src/lib/calendar/google-connect.ts`
- Modify: `src/pages/odoo/components/GoogleCalendarCard.tsx:20-27` (import the shared broadcast)
- Modify: `src/pages/app/index.tsx` (render the card, host effects)
- Modify: `src/hooks/useMeetingDetection.ts:178-185` (drop the `meeting-detected` / `meeting-ended` toasts)
- Modify: `src-tauri/src/shortcuts.rs`, `src-tauri/src/lib.rs` (`reveal_overlay`)
- Test: `src/tests/meeting-card.test.tsx`, `src/tests/google-connect.test.ts`, `src/tests/useMeetingDetection.lifecycle.test.tsx`

**Interfaces:**
- Consumes: Task 6 store; `GOOGLE_COPY`, `toGoogleCode`; `loadGoogleConfigState`, `GOOGLE_CONNECTION_CHANGED_EVENT`.
- Produces:
  - `export async function broadcastGoogleConnectionChanged(): Promise<void>`: best-effort `emit`, moved verbatim from `GoogleCalendarCard`.
  - `export async function reconnectGoogle(): Promise<{ ok: true } | { ok: false; code: GoogleErrorCode }>`:
    - a config that is not `complete` gives `{ ok: false, code: "GOOGLE_AUTH_REJECTED" }` with no invoke;
    - otherwise `invoke("google_connect", { clientId, clientSecret })` from the saved config, then `await broadcastGoogleConnectionChanged()`, then `{ ok: true }`;
    - a rejection gives `{ ok: false, code: toGoogleCode(err) }`.
  - `export function MeetingCard({ card, compact }: { card: NonNullable<MeetingCard>; compact?: boolean })`
  - Rust `#[tauri::command] pub fn reveal_overlay(app: AppHandle) -> Result<(), String>`.
    - **Windows:** set `WindowVisibility.is_hidden` to `true`, emit `toggle-window-visibility` with `true`, then `window.show()`, and **no** `set_focus` (it must not steal focus from the call). This is the existing inverted polarity: `useApp.ts:69` sets `isHidden = !payload`, and `handle_toggle_window` never calls `hide()` on Windows. Do not rename the flag.
    - **Elsewhere:** `show()` if `!is_visible()`.

Card content (mockups in spec 6.3/6.6):
- **recording**:
  - top row `◉ REC  {app} · recording started  mm:ss`, a 1s ticking timer from `startedAt`, and a `■ Stop` button calling `stopActiveRecording()`;
  - when `event` is set: the title, `HH:MM – HH:MM`, and up to 3 initials chips plus `+N`;
  - a bottom drain bar that is a CSS animation of about 6s. Its `onAnimationEnd` calls `dismissCard()`. Hovering the card sets `data-paused="true"` and `animation-play-state: paused`.
- **ended**: `✓  Recording saved` and `{title ?? app}  ·  {N} min`; `dismissCard()` after 5s.
- **amber**, per variant:
  - `reconnect`: `Not now` → `snoozeAmber()`; `Reconnect Google` → `reconnectGoogle()`, and on failure `setAmberError(GOOGLE_COPY[code])` with the button kept.
  - `settings`: body `Meetwings can't read your saved Google Calendar setup. Open Integrations → Google Calendar in settings to fix it.`; `Not now`; `Open settings` → `invoke("open_dashboard")`. There is no deep link, because the dashboard has no route-navigation event.
  - `offline`: the can't-reach body and a single `Got it` → `snoozeAmber()`.
  - `error`, when set, renders under the body.
- **compact** (pill): one line per variant, for example `◉ REC  {title ?? app}  00:04`. Amber compact keeps its primary button.
- **Styling:** red, green and amber accents, light and dark themes. Each root has `style={{ height: cardHeight(card, compact) }}`. The pulse and the slide use `tw-animate-css` / Tailwind classes, all prefixed `motion-safe:`. Under reduced motion only a fade remains.

Host:
- Create `src/hooks/useMeetingCardHost.ts`: `export function useMeetingCardHost(pillStyle: OverlayPillStyle): MeetingCard`.
  - It reads `useSyncExternalStore(subscribeToMeetingCard, getMeetingCard)` and returns it.
  - In an effect on `card?.kind`: when it becomes `"amber"`, it calls `invoke("reveal_overlay")` with a logged catch. Red and ended cards never reveal.
  - Task 10 adds the resize subscription here.
- `src/pages/app/index.tsx` calls it once, next to `useMeetingDetection()`.
- Render `<MeetingCard card={card} />` under the bar's `<Card>` inside the non-minimized wrapper, and the compact form above the pill (layout in Task 10).

- [ ] **Step 1: Write the failing tests.**

  `google-connect.test.ts`:
  - `reconnect connects with the saved config and then broadcasts`: assert the order `google_connect`, then `emit(GOOGLE_CONNECTION_CHANGED_EVENT)`;
  - `a rejected connect returns its code and broadcasts nothing`;
  - `an incomplete config returns AUTH_REJECTED without connecting`.

  `meeting-card.test.tsx`:
  - `the recording card shows app, timer and Stop`: `"Google Meet · recording started"`, `00:04` after 4s, Stop → stop spy.
  - `the recording card fills in the event`: title, time range, 3 initials and `+2`.
  - `without an event only the top row shows`.
  - `the drain bar dismisses at its end and pauses on hover`: `fireEvent.animationEnd` → card `null`; `mouseEnter` → `data-paused="true"`.
  - `the ended card shows title and minutes, then leaves`: `"Recording saved"`, `"42 min"`; gone after 5s.
  - `amber reconnect: headline, Not now snoozes, Reconnect failure shows Google copy and keeps the button`.
  - `amber settings opens the dashboard`.
  - `amber offline has Got it only`.
  - `animation classes are motion-safe only`: no `animate-*` or `slide-*` class without the `motion-safe:` prefix.
  - `an amber card reveals the window; a red card does not`: `renderHook(() => useMeetingCardHost("icon-only"))`, drive the store, and assert `invoke("reveal_overlay")`.

  `useMeetingDetection.lifecycle.test.tsx`:
  - replace the toast assertions at ~118-122 and the label test at ~487-510 with `meeting-detected and meeting-ended show no toast`. The label cases already live in `meeting-detect.test.ts`.
  - keep the `meeting-watcher-stopped` toast test.

- [ ] **Step 2: Run, expect FAIL.** `npx vitest run src/tests/meeting-card.test.tsx src/tests/google-connect.test.ts src/tests/useMeetingDetection.lifecycle.test.tsx src/tests/google-calendar-card.test.tsx`
- [ ] **Step 3: Implement.** Register `shortcuts::reveal_overlay` in `lib.rs`.
- [ ] **Step 4: Run** Step 2's command, plus `CARGO_TARGET_DIR=C:/Users/kmorg/meetwings-app/src-tauri/target cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings`. Expected: PASS and clean.
- [ ] **Step 5: Commit** `git add src/pages/app/components/MeetingCard.tsx src/pages/app/components/index.ts src/hooks/useMeetingCardHost.ts src/lib/calendar/google-connect.ts src/pages/odoo/components/GoogleCalendarCard.tsx src/pages/app/index.tsx src/hooks/useMeetingDetection.ts src-tauri/src/shortcuts.rs src-tauri/src/lib.rs src/tests/meeting-card.test.tsx src/tests/google-connect.test.ts src/tests/useMeetingDetection.lifecycle.test.tsx`, then `git commit -m "feat(cards): recording, ended and calendar-warning cards"`

---

### Task 10: Window size follows the card

**Files:**
- Modify: `src/hooks/useWindow.ts:26-44`, `src/hooks/useMeetingCardHost.ts` (from Task 9)
- Modify: `src/pages/app/index.tsx`:
  - `:56-75` (`handleMinimize`);
  - `:103-139` (restyle listener);
  - the minimized render branch (`:259`);
  - a new card-change effect.
- Modify: `src-tauri/src/window.rs:283-358` (stale restyle guard)
- Test: `src/tests/useWindow.minimize-gate.test.ts`, `src/tests/meeting-card-window.test.tsx`

**Interfaces:**
- Consumes: Task 6's `getMeetingCard`, `cardHeight`, `pillWindowSize`, `BAR_HEIGHT`, `CARD_GAP`, `subscribeToMeetingCard`.
- Produces:
  - `resizeWindow(expanded)` keeps its signature. Its height becomes `Math.max(expanded ? 600 : BAR_HEIGHT, card ? BAR_HEIGHT + CARD_GAP + cardHeight(card, false) : BAR_HEIGHT)` with `card = getMeetingCard()`. The MutationObserver and mouseup paths already route through it, so all three agree.
  - Rust: a pure `fn restyle_is_stale(restyle: bool, minimized: bool) -> bool` (`restyle && !minimized`). `minimize_overlay` returns `Ok(())` without touching the geometry or the flag when it is true. This guards a card timer firing during `handleExpand`'s `await restore_overlay`.

Pinned edits:
- **All three pill-size call sites** use `pillWindowSize(pillStyle, getMeetingCard())`: `handleMinimize`, the `overlay-pill-style-changed` restyle, and the new card effect.
- **Card effect**, in `useMeetingCardHost` (`subscribeToMeetingCard`):
  - if `getMinimized()`: `invoke("minimize_overlay", { ...pillWindowSize(style, card), restyle: true })`, with the style read through a ref;
  - else: `resizeWindow(isAnyPopoverOpen())`.
  - It never calls `setMinimized`. A card never un-minimizes.
- **Minimized layout:** a `w-full h-full flex flex-col items-end justify-end` column, with the compact card on top (`gap` = `CARD_GAP`) and the pill in a box of exactly `PILL_DIMENSIONS[style]` at the bottom-right. The window grows upward from Rust's bottom-right anchor.
- **Restore** needs no new code. `MinimizedPill.handleExpand` already calls `resizeWindow(isAnyPopoverOpen())` after `restore_overlay`, and that call is now card-aware.

- [ ] **Step 1: Write the failing tests.**
  - Rust (`window.rs` tests): `stale_restyle_is_a_noop`. `restyle_is_stale(true, false)` is true; `(true, true)`, `(false, false)` and `(false, true)` are false.
  - `useWindow.minimize-gate.test.ts`:
    - `a transcript mutation does not shrink the window under a card`: with a recording card, a body mutation gives `set_window_height` with `54 + 8 + cardHeight(card, false)`;
    - `a popover still wins with 600`;
    - `no card keeps 54`.
  - `meeting-card-window.test.tsx`. Host cases use `renderHook(useMeetingCardHost)`. The minimize and restyle cases render `App` with the same mocks `overlay-minimize-keeps-mounted.test.tsx` uses.
    - `a card while minimized restyles the pill and never resizes the bar`: `minimize_overlay` with `restyle: true` and `pillWindowSize(style, card)`; no `set_window_height`; `getMinimized()` stays true.
    - `minimizing with a card up uses the card-aware size`.
    - `a pill style change with a card up uses the card-aware size`.
    - `card change during restore does not restyle`: `restore_overlay` held on a deferred; a card shows; then resolve. Assert at most the one `restyle: true` call sent while minimized, and a final `set_window_height` that is card-aware. Pair it with the Rust guard.

- [ ] **Step 2: Run, expect FAIL.** `npx vitest run src/tests/useWindow.minimize-gate.test.ts src/tests/meeting-card-window.test.tsx`, then `CARGO_TARGET_DIR=C:/Users/kmorg/meetwings-app/src-tauri/target cargo test --manifest-path src-tauri/Cargo.toml window`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** Step 2's commands, plus `npx vitest run src/tests/minimized-pill.test.tsx src/tests/overlay-minimize-keeps-mounted.test.tsx src/tests/overlay-minimize-rehydrate.test.tsx src/tests/settings-page.overlay-pill.test.tsx`. Expected: PASS. `overlay-minimize-keeps-mounted` is a known full-run flake, so run it alone if it times out.
- [ ] **Step 5: Commit** `git add src/hooks/useWindow.ts src/hooks/useMeetingCardHost.ts src/pages/app/index.tsx src-tauri/src/window.rs src/tests/useWindow.minimize-gate.test.ts src/tests/meeting-card-window.test.tsx`, then `git commit -m "feat(cards): window and pill grow to fit the card"`

---

### Task 11: Settings copy and the microphone readout

**Files:**
- Modify: `src/pages/settings/components/MeetingAutoRecordToggle.tsx`
- Modify: `src-tauri/src/meeting_detect/mod.rs` (readout command), `src-tauri/src/lib.rs`
- Test: `src/tests/MeetingAutoRecordToggle.note.test.tsx`, `src/tests/settings-page.meeting-auto-record.test.tsx`, Rust tests in `mod.rs`

**Interfaces:**
- Consumes: Task 2's `WatchLists` and `classify` matching rule; Task 4's `currentWatchLists`, `meetingLabel`.
- Produces:
  - Rust `#[derive(Serialize)] #[serde(rename_all = "camelCase")] pub struct MicSession { pub name: String, pub pid: u32, pub active: bool, pub kind: &'static str }`. `kind` is `"direct"`, `"gated"` or `"ignored"`.
  - Pure `fn describe_sessions(sessions: &[SessionInfo], lists: &WatchLists, own_pid: u32) -> Vec<MicSession>`:
    - skips sessions with no image name and the own pid;
    - kind uses the same case-insensitive exact match as `classify`;
    - sorts active first, then by name.
  - `#[tauri::command] pub async fn list_capture_sessions(direct: Vec<String>, gated: Vec<String>) -> Result<Vec<MicSession>, String>`:
    - off Windows: `Err(UNSUPPORTED_PLATFORM)`;
    - on Windows: runs inside `tauri::async_runtime::spawn_blocking`, which calls `CoInitializeEx(None, COINIT_MULTITHREADED)`, `enumerate_capture_sessions()`, and `CoUninitialize()` only if the init succeeded, then `describe_sessions`. It needs no watcher and works with auto-record off.

Copy:
- Header description `Record Teams and Google Meet calls automatically`.
- Label and Switch `aria-label` `Automatically record Teams and Google Meet calls`.
- Paragraph: `Starts recording when a Teams call begins, or when a Google Meet call on your Google Calendar starts in Chrome, and stops when it ends. Requires voice detection to be enabled in audio settings. Windows only. Participants may need to be told the call is being recorded — rules vary by country.`

Readout:
- A `Check microphone apps` button under the toggle that calls `list_capture_sessions` with `await currentWatchLists()`.
- It renders one row per session: `{name}`, `On the microphone` or `Idle`, and `Watched ({meetingLabel(name)})`, `Watched after a calendar check ({meetingLabel(name)})` or `Not watched`.
- An empty list renders `No apps are using the microphone.`. A rejection renders `Couldn't list microphone apps.`.

- [ ] **Step 1: Write the failing tests.**
  - Rust `describe_sessions_marks_each_list`: chrome is `gated`, `MS-TEAMS.EXE` is `direct`, `spotify.exe` is `ignored`; own pid and unnamed sessions are dropped; active rows come first.
  - `MeetingAutoRecordToggle.note.test.tsx` / `settings-page.meeting-auto-record.test.tsx`: update the old copy strings to the new ones.
  - `the readout lists sessions with their kind`: mocked `list_capture_sessions` gets `{ direct: MEETING_DETECT_PROCESSES, gated: ["chrome.exe"] }` (config mocked `complete`) and renders `chrome.exe` with `Watched after a calendar check (Google Meet)`.
  - `the readout shows its error copy on rejection`.

- [ ] **Step 2: Run, expect FAIL.** `npx vitest run src/tests/MeetingAutoRecordToggle.note.test.tsx src/tests/settings-page.meeting-auto-record.test.tsx`, then `CARGO_TARGET_DIR=C:/Users/kmorg/meetwings-app/src-tauri/target cargo test --manifest-path src-tauri/Cargo.toml meeting_detect`
- [ ] **Step 3: Implement.** Register `meeting_detect::list_capture_sessions` in `lib.rs`.
- [ ] **Step 4: Run** Step 2's commands. Expected: PASS.
- [ ] **Step 5: Commit** `git add src/pages/settings/components/MeetingAutoRecordToggle.tsx src-tauri/src/meeting_detect/mod.rs src-tauri/src/lib.rs src/tests/MeetingAutoRecordToggle.note.test.tsx src/tests/settings-page.meeting-auto-record.test.tsx`, then `git commit -m "feat(settings): Meet copy and microphone apps readout"`

---

## Exit gate

Run all of these at the final commit. Each must pass before P5:

1. `CARGO_TARGET_DIR=C:/Users/kmorg/meetwings-app/src-tauri/target cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check`
2. `CARGO_TARGET_DIR=C:/Users/kmorg/meetwings-app/src-tauri/target cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings`
3. `CARGO_TARGET_DIR=C:/Users/kmorg/meetwings-app/src-tauri/target cargo test --manifest-path src-tauri/Cargo.toml --all-features`
4. `npm run lint`: 0 errors. The warning count must not rise above main's baseline.
5. `npm run type-check`: clean.
6. Scoped Vitest over every test file this plan touched or created (`npx vitest run <files>`). Not the full suite: the full suite has known load flakes on main.
7. A scratch `tsc` over the touched tests: a `tsconfig` in the scratchpad that extends the repo one and `include`s exactly those test files. Pre-existing errors on untouched lines are allowed, new ones are not.

The manual Windows checks 1-15 (spec section 9) run with Kevin after the PR is open, through `npm run tauri dev` with the installed Meetwings quit first.
