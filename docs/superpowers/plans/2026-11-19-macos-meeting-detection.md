# Meeting Detection on Mac Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On a supported macOS with auto-record on, Chrome using the microphone (a Google Meet call) starts and stops a recording exactly as it does on Windows, and nothing changes on Windows.

**Architecture:** Add a Core Audio enumeration (`meeting_detect/macos.rs`) behind the existing platform-neutral pipeline (`classify` → `tick` → events). Its pure logic (raw-process mapping, the support probe) lives in a cfg-free `mac_logic.rs` that is tested on every platform. One matcher per language adds the Mac helper-prefix rule. The frontend picks per-platform watch lists, opens the three owner gates to macOS, and on Mac asks for permissions at toggle-on and keeps any start failure visible.

**Tech Stack:** Tauri 2 / Rust (cidre 0.11.3, libc), React 19 + TypeScript, Vitest, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-11-19-macos-meeting-detection-design.md`. Read it with this plan. Section numbers below (§5.2 and so on) refer to it.

## Global Constraints

- **Windows does not change.** Lists stay `["ms-teams.exe", "Teams.exe", "Zoom.exe"]` (direct) and `["chrome.exe"]` (gated). `.exe` entries keep exact case-insensitive matching. Timing is the same. Windows makes no permission calls, and its start-failure payload stays exactly `{ enabled: false }`.
- **Mac lists:** direct `[]`, gated `["com.google.Chrome"]` (provisional, §5.3). Label: `Google Meet`.
- **Matching:** case-insensitive on both sides. A Mac entry (one that does not end in `.exe`) also matches an ID that starts with the entry followed by `.`. Nothing on any list matches `com.apple.WebKit.*`.
- **Raw IDs:** the readout and `detection.log` show the raw session ID, never a folded one.
- **New frontend branches** are written as `isMacOS() ? mac : existing`, never `isWindows() ? existing : mac`. Files without a platform mock (`meeting-detect.test.ts`, `MeetingAutoRecordToggle.note.test.tsx`) run as Linux in jsdom and must keep taking the existing path.
- **Platform helpers** are imported from `@/lib/platform`, never from the `@/lib` barrel; several tests mock the barrel wholesale.
- **`tauri-plugin-macos-permissions-api`** is only ever imported dynamically (`await import(...)`). A static import breaks the Windows build.
- **Auto-record stays off by default.** No default changes.
- **Rust:** toolchain 1.99.1. `cargo clippy --all-targets --all-features -- -D warnings` must be clean on Linux, Windows and macOS. Run `cargo fmt --check` before every push.
- **Local commands** (Windows dev box, worktree root):
  - Rust tests: `CARGO_TARGET_DIR=C:/Users/kmorg/meetwings-app/src-tauri/target cargo test --manifest-path src-tauri/Cargo.toml meeting_detect`
  - Clippy: `CARGO_TARGET_DIR=C:/Users/kmorg/meetwings-app/src-tauri/target cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings`
  - Format: `cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check`
  - Frontend: `npm run lint`, `npm run type-check` (the script is `type-check`, not `check:types`), and `npx vitest run <files>`, always scoped and never the full suite.
- **Mac Rust does not compile locally.** cidre's build script needs `xcrun` and `xcodebuild`. Anything under `#[cfg(target_os = "macos")]` is verified only by the macOS CI job (Task 0 adds it; Task 6 runs it on this branch).
- **`src/tests` is excluded from `tsconfig`.** Type errors in test files show up only as Vitest runtime failures, so run every touched test file.
- **Commits** end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never use bare `git stash`. Run one plain command per Bash call: no `&&`, pipes or `$(...)` around git.

## Review Focus

These are the five inputs most likely to bite a Mac user that no automated test can fully exercise.

1. **A fresh mic grant must pass the next launch's check.** The toggle-on grant comes from WebKit `getUserMedia`. The start check reads `AVCaptureDevice` through the plugin. If those two disagree, every launch turns the toggle off with "permission was reset". This can't be automated. It is manual check **M2a** (Task 11's manual list): relaunch after M2, and the toggle must stay on with no note.
2. **Chrome's mic process may have no bundle ID.** Its executable name (for example `Google Chrome Helper`) must still appear in the readout and `detection.log`. Pinned by Task 2's `missing_empty_or_failed_bundle_id_falls_back_to_exe_name`.
3. **Several Chrome helpers can hold the mic at once.** Every row must read "gated" with its raw name, and `classify` must go Active. Pinned by Task 1's `describe_sessions_marks_mac_helpers`.
4. **Non-ASCII IDs, or IDs shorter than the entry.** The matcher runs on the poll thread and must never panic. Pinned by Task 1's `entry_matches_does_not_panic_on_odd_input`.
5. **No microphone hardware.** `getUserMedia` rejects with `NotFoundError`. The toggle must show the mic note, whose copy also says to check that a microphone is connected, and save nothing. Pinned by Task 9's `requestMicAccess` cases and Task 11's mic-denial test.

## File map

| File | Change |
|---|---|
| `.github/workflows/ci.yml` | + `backend-macos` job (Task 0) |
| `.github/workflows/macos-test-build.yml` | new: `workflow_dispatch` DMG artifact (Task 0) |
| `src-tauri/Cargo.toml` | + `libc = "0.2"` under macOS deps (Task 3) |
| `src-tauri/src/meeting_detect/mod.rs` | `entry_matches`; `classify`/`describe_sessions` use it; module wiring; probe seam; guards (Tasks 1, 3, 4) |
| `src-tauri/src/meeting_detect/mac_logic.rs` | new, cfg-free: `RawProcess`, `sessions_from_processes`, `probe_verdict` (Task 2) |
| `src-tauri/src/meeting_detect/macos.rs` | new, macOS only: `enumerate_capture_sessions`, `probe` (Task 3) |
| `src-tauri/src/speaker/commands.rs`, `src-tauri/src/lib.rs` | + `prime_system_audio_access`, `open_microphone_settings` (Task 5) |
| `src/config/constants.ts` | Mac lists, Mac label, `STORAGE_KEYS.MEETING_AUTO_RECORD_START_FAILURE` (Tasks 7, 9) |
| `src/lib/meeting-detect.ts` | `entryMatches`, `sameCallId`, `isMeetingDetectionPlatform`, per-platform `currentWatchLists`, `meetingLabel`/`isGatedProcess` through the matcher (Task 7) |
| `src/lib/functions/meeting-auto-record.ts` | `isSameCall` uses `sameCallId` (Task 7) |
| `src/lib/mac-permissions.ts` | new: thin wrappers over the plugin, `getUserMedia` and the two Rust commands (Task 9) |
| `src/lib/meeting-start-failure.ts` | new: the persisted start-failure record, copy, `toStartFailure`, `macToggleOnCheck` (Task 9). Separate file so it may import `@/lib` without a cycle (`@/lib` → `functions` → `meeting-auto-record` → `meeting-detect`). |
| `src/hooks/useMeetingDetection.ts` | gate; `startWatcher(isCancelled)` with the Mac mic check; effect 3 and retry failure handling (Tasks 8, 10) |
| `src/hooks/useMeetingAutoRecord.ts` | gate; `onDetected` comparison (Tasks 7, 8) |
| `src/pages/settings/index.tsx` | gate (Task 8) |
| `src/pages/settings/components/MeetingAutoRecordToggle.tsx` | Mac toggle-on flow, failure note, per-platform copy (Task 11) |

**P4 `test_paths`** (the conductor writes this list into ship state):
`src/tests/meeting-detect.test.ts`, `src/tests/meeting-detect.platform.test.ts`, `src/tests/meeting-auto-record.decisions.test.ts`, `src/tests/useMeetingAutoRecord.auto-stop.test.tsx`, `src/tests/useMeetingAutoRecord.lifecycle.test.tsx`, `src/tests/useMeetingDetection.lifecycle.test.tsx`, `src/tests/settings-page.meeting-auto-record.test.tsx`, `src/tests/settings-page.content-protection.test.tsx`, `src/tests/settings-page.overlay-pill.test.tsx`, `src/tests/overlay-meeting-targets-survive.test.tsx`, `src/tests/MeetingAutoRecordToggle.note.test.tsx`, `src/tests/MeetingAutoRecordToggle.mac.test.tsx`, `src/tests/mac-permissions.test.ts`, `src/tests/meeting-start-failure.test.ts`. Plus the Rust commands above.

**Routing hints for P4:**

| Task | Who | Why |
|---|---|---|
| 0, 6 | conductor | push, PR, CI |
| 3 | Anthropic implementer | no local compile |
| 5 | either | macOS arm copies an existing command |
| 1, 2, 4, 7, 8, 9 | ollama-suitable | |
| 10, 11 | Anthropic preferred | async ordering |

---

### Task 0 (conductor-run): the macOS CI PR to main

Spec §5.7 says to add the CI job first, against unchanged code. Spec §5.8 says the test-build workflow lands as its own PR to `main`. Both go in **one** small PR, cut from `origin/main`. Its pull-request run is the macOS job against unchanged code, which surfaces any Mac lints that predate this feature before feature commits depend on them. This combination is my call; log it in ship state. No later task waits for this PR to merge. Only the manual DMG step after the feature PR needs it on `main`.

**Files:**
- Modify: `.github/workflows/ci.yml` (append a job after `backend-windows`, before `backend-format`)
- Create: `.github/workflows/macos-test-build.yml`

- [ ] **Step 1: Branch from origin/main at a clean tree.** Run these one at a time: `git fetch origin`, `git status --porcelain` (expect empty apart from untracked state files), then `git switch -c ci/macos-build origin/main`.

- [ ] **Step 2: Add the `backend-macos` job to `ci.yml`.** Copy `backend-windows` (`ci.yml:100-129`) with these changes:
  - `name: Backend Lint & Test (macOS)` and `runs-on: macos-latest`.
  - The same pinned `toolchain: 1.99.1` with the clippy component.
  - The same `shell: bash` dummy `.env` step and Rust cache.
  - The same Clippy command.
  - Also the `Run backend tests` step from the Linux job (`ci.yml:91-92`).
  - A comment above it: Mac code (`cfg(target_os = "macos")`) is otherwise compiled only by `publish.yml` at release, and never linted.

- [ ] **Step 3: Create `macos-test-build.yml`.**
  - Trigger: `on: workflow_dispatch` only. `permissions: contents: read`.
  - Header comment: manual only; builds an unsigned DMG uploaded as a workflow **artifact**; creates no release and does not touch `latest.json`; run it with `gh workflow run macos-test-build.yml --ref <branch>`; testers open it the way `publish.yml:125` describes.
  - One job, `runs-on: macos-latest`, with `strategy.fail-fast: false`. The matrix `include` lists `{target: aarch64-apple-darwin, arch: arm64}` and `{target: x86_64-apple-darwin, arch: x64}`.
  - Steps reuse `publish.yml`'s macOS steps as written:
    - checkout;
    - `setup-node` `lts/*`;
    - Rust 1.99.1 with `targets: aarch64-apple-darwin,x86_64-apple-darwin` (`publish.yml:84-88`);
    - the environment-file step from secrets (`publish.yml:102-107`);
    - `npm ci`;
    - `tauri-apps/tauri-action@v0.5.16` with `args: --target ${{ matrix.target }} --bundles dmg`. Pass **no** `tagName`, `releaseName` or `releaseId`, so it only builds. Set env `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (`createUpdaterArtifacts` is `true` in `tauri.conf.json:37`, so the build needs the key), `API_ACCESS_KEY`, `PAYMENT_ENDPOINT`, `APP_ENDPOINT` and `POSTHOG_API_KEY` from secrets, as `publish.yml:114-121` does, minus `GITHUB_TOKEN`;
    - `actions/upload-artifact@v4` with `name: meetwings-macos-${{ matrix.arch }}`, `path: src-tauri/target/${{ matrix.target }}/release/bundle/dmg/*.dmg`, `if-no-files-found: error` and `retention-days: 14`.

- [ ] **Step 4: Commit, push, open the PR.**
  - `git add .github/workflows/ci.yml .github/workflows/macos-test-build.yml`
  - `git commit -m "ci: lint and test the Mac build; add a manual macOS test-build workflow"`
  - `git push -u origin ci/macos-build`
  - `gh pr create --base main --title "ci: macOS lint/test job and a manual macOS test-build workflow" --body <file>`. The body explains both files: the dispatch workflow must be on `main` before it can be run, and it produces no release. Record the PR number in ship state's `phase_log`.

- [ ] **Step 5: Put the commits on the feature branch.** `git switch feat/macos-meeting-detection-design`, then `git cherry-pick <sha>` for each Task 0 commit. Identical changes mean a later merge of `main` into this branch is clean (§5.8).

- [ ] **Step 6: Watch the macOS job on the CI PR** (`gh pr checks <n>`, polled through Monitor). If clippy or a test fails on code that predates this feature (`speaker/macos.rs`, the macOS blocks in `lib.rs`):
  - fix it on `ci/macos-build` at a clean tree, one commit per fix, and run `cargo fmt --check` first;
  - push, then cherry-pick each fix onto the feature branch;
  - an Anthropic implementer writes the fix, since it can't be compiled locally.

  Exit: every check on the CI PR is green. Later tasks may run while you wait.

---

### Task 1: The shared Rust matcher

**Files:**
- Modify: `src-tauri/src/meeting_detect/mod.rs`. Add `entry_matches` beside `classify` (`:59-87`). Use it at `:76` and in `describe_sessions` (`:1019-1025`). Update the doc comment at `:1019`.
- Test: the `tests` module in the same file (starts `:1079`; helpers `session()` at `:1087`, `run_core` at `:1504`, `confirmed_meet()` at `:1516`).

**Interfaces:**
- Produces: `fn entry_matches(entry: &str, name: &str) -> bool`.
  - Case-insensitive equality.
  - Or, when `entry` does not end in `.exe` (case-insensitive), `name` starts with `entry` (case-insensitive) and the next byte is `.`.
  - Must not panic on any input. Slice with `name.get(..entry.len())`; never index by byte position.
  - Carries `#[cfg_attr(not(target_os = "windows"), allow(dead_code))]`, like its neighbours.

- [ ] **Step 1: Write the failing tests**

```rust
#[test]
fn entry_matches_mac_helper_prefix() {
    assert!(entry_matches("com.google.Chrome", "com.google.Chrome"));
    assert!(entry_matches("com.google.Chrome", "com.google.Chrome.helper"));
    assert!(entry_matches("com.google.Chrome", "COM.GOOGLE.CHROME.HELPER"));
    assert!(!entry_matches("com.google.Chrome", "com.google.ChromeX"));
}

#[test]
fn entry_matches_exe_entries_stay_exact() {
    assert!(entry_matches("chrome.exe", "CHROME.EXE"));
    assert!(entry_matches("Teams.exe", "teams.exe"));
    assert!(!entry_matches("chrome.exe", "chrome.exe.foo"));
}

#[test]
fn entry_matches_never_matches_webkit() {
    let entries = ["com.google.Chrome", "ms-teams.exe", "Teams.exe", "Zoom.exe", "chrome.exe"];
    for id in ["com.apple.WebKit.GPU", "com.apple.WebKit.WebContent"] {
        assert!(entries.iter().all(|e| !entry_matches(e, id)), "{id} must never match");
    }
}

#[test]
fn entry_matches_does_not_panic_on_odd_input() {
    assert!(!entry_matches("com.google.Chrome", "com.google.Chromé"));
    assert!(!entry_matches("com.google.Chromé", "com.google.Chrome.helper"));
    assert!(!entry_matches("com.google.Chrome", "c"));
    assert!(!entry_matches("com.google.Chrome", ""));
}

#[test]
fn classify_matches_a_mac_helper_and_keeps_its_raw_id() {
    let gated = vec!["com.google.Chrome".to_string()];
    let sessions = [
        session(5, Some("com.apple.WebKit.GPU"), true),
        session(7, Some("com.google.Chrome.helper"), true),
    ];
    assert_eq!(
        classify(&sessions, &gated, 100),
        PollResult::Active("com.google.Chrome.helper".to_string())
    );
    assert_eq!(classify(&sessions[..1], &gated, 100), PollResult::Inactive);
}

#[test]
fn describe_sessions_marks_mac_helpers() {
    let lists = WatchLists { direct: vec![], gated: vec!["com.google.Chrome".to_string()] };
    let rows = describe_sessions(
        &[
            session(7, Some("com.google.Chrome.helper"), true),
            session(8, Some("com.google.Chrome.helper.Renderer"), true),
            session(9, Some("com.apple.WebKit.GPU"), true),
        ],
        &lists,
        100,
    );
    let got: Vec<(&str, &str)> = rows.iter().map(|r| (r.name.as_str(), r.kind)).collect();
    assert_eq!(
        got,
        vec![
            ("com.apple.WebKit.GPU", "ignored"),
            ("com.google.Chrome.helper", "gated"),
            ("com.google.Chrome.helper.Renderer", "gated"),
        ]
    );
}
```

Add one `tick` test. The spec requires one with the direct list empty (§5.3, §8).
- Name it `tick_gated_path_is_unchanged_with_an_empty_direct_list`.
- Build each poll's outcomes through `classify`: direct from `classify(&s, &[], 100)` and gated from `classify(&s, &["com.google.Chrome".into()], 100)`.
- Use the session sets `[session(7, Some("com.google.Chrome.helper"), true)]` and `[]`, in the same order and with the same `confirmed` values as `confirmed_meet()` followed by its end polls.
- Assert the emitted events equal the existing `chrome()`-fixture run with each process name swapped for `com.google.Chrome.helper`.

- [ ] **Step 2: Run, expect failure.** Run the Rust tests command. Expected: compile error, `cannot find function entry_matches`.

- [ ] **Step 3: Implement `entry_matches`.** Replace the closure at `:76` with `watch_list.iter().any(|w| entry_matches(w, name))`. Make `describe_sessions`' `listed` closure call `entry_matches`.

- [ ] **Step 4: Run the Rust tests and clippy.** Expected: PASS. Every existing `classify`/`describe_sessions` (R9) test is unchanged and green.

- [ ] **Step 5: Commit.** `git add src-tauri/src/meeting_detect/mod.rs`, then `git commit -m "feat(meeting-detect): one matcher with the Mac helper-prefix rule"`.

---

### Task 2: Pure Mac logic (`mac_logic.rs`)

**Files:**
- Create: `src-tauri/src/meeting_detect/mac_logic.rs`, with a `#[cfg(test)] mod tests` at the bottom.
- Modify: `src-tauri/src/meeting_detect/mod.rs`. Add `mod mac_logic;` (no cfg) next to the other `mod` lines (`:16-24`).

**Interfaces:**
- Consumes: `super::SessionInfo`, `super::image_name_from_path` (`mod.rs:50`).
- Produces. Every item carries `#[cfg_attr(not(target_os = "macos"), allow(dead_code))]`, because only `macos.rs` and tests call them:
  - `pub(super) struct RawProcess { pub pid: Option<u32>, pub running_input: Option<bool>, pub bundle_id: Option<String>, pub exe_path: Option<String> }`. `None` means the read failed or there was no value.
  - `pub(super) fn sessions_from_processes(procs: Vec<RawProcess>) -> Vec<SessionInfo>`:
    - skip a process whose `pid` is `None`, or whose `running_input` is `None` or `Some(false)`;
    - `image_name` = the bundle ID if non-empty after `trim()`, else `exe_path.and_then(image_name_from_path)`, else `None`;
    - `active: true`.
  - `pub(super) const UNSUPPORTED_MACOS: &str = "Auto-record needs macOS 14.2 or later";`. The floor is the process-tap API, macOS 14.2 (`kAudioHardwarePropertyTapList`). The process-object list is 14.0 (`kAudioHardwarePropertyProcessObjectList`). Both values come from the `API_AVAILABLE` annotations in CoreAudio's `AudioHardware.h`. The probe still tests both (§5.5).
  - `pub(super) const AUDIO_READ_FAILED: &str = "Couldn't read the Mac's audio system, try again";`
  - `pub(super) fn probe_verdict(has_process_list: bool, has_tap_list: bool, trial_read: Result<(), String>) -> Result<(), String>`:
    - either flag false → `Err(UNSUPPORTED_MACOS)`;
    - else `trial_read` `Err(e)` → `Err(format!("{AUDIO_READ_FAILED} ({e})"))`;
    - else `Ok(())`.

- [ ] **Step 1: Write the failing tests** (in `mac_logic.rs`)

```rust
fn raw(pid: Option<u32>, input: Option<bool>, bundle: Option<&str>, exe: Option<&str>) -> RawProcess {
    RawProcess {
        pid,
        running_input: input,
        bundle_id: bundle.map(str::to_string),
        exe_path: exe.map(str::to_string),
    }
}
const HELPER: &str = "/Applications/Google Chrome.app/Contents/Frameworks/x/Google Chrome Helper";

#[test]
fn maps_the_raw_bundle_id() {
    let s = sessions_from_processes(vec![raw(Some(7), Some(true), Some("com.google.Chrome.helper"), None)]);
    assert_eq!((s[0].pid, s[0].image_name.as_deref(), s[0].active), (7, Some("com.google.Chrome.helper"), true));
}

#[test]
fn missing_empty_or_failed_bundle_id_falls_back_to_exe_name() {
    for bundle in [None, Some(""), Some("  ")] {
        let s = sessions_from_processes(vec![raw(Some(7), Some(true), bundle, Some(HELPER))]);
        assert_eq!(s.len(), 1, "the process stays listed");
        assert_eq!(s[0].image_name.as_deref(), Some("Google Chrome Helper"));
    }
}

#[test]
fn no_bundle_and_no_exe_gives_none_but_stays_listed() {
    let s = sessions_from_processes(vec![raw(Some(7), Some(true), None, None)]);
    assert_eq!(s.len(), 1);
    assert_eq!(s[0].image_name, None);
}

#[test]
fn a_process_not_running_input_is_left_out() {
    assert!(sessions_from_processes(vec![raw(Some(7), Some(false), Some("com.google.Chrome"), None)]).is_empty());
}

#[test]
fn a_failed_pid_or_input_read_skips_only_that_process() {
    let s = sessions_from_processes(vec![
        raw(None, Some(true), Some("a.b"), None),
        raw(Some(2), None, Some("c.d"), None),
        raw(Some(3), Some(true), Some("e.f"), None),
    ]);
    assert_eq!(s.iter().map(|x| x.pid).collect::<Vec<_>>(), vec![3]);
}

#[test]
fn probe_is_unsupported_when_either_property_is_missing() {
    assert_eq!(probe_verdict(false, true, Ok(())), Err(UNSUPPORTED_MACOS.to_string()));
    assert_eq!(probe_verdict(true, false, Ok(())), Err(UNSUPPORTED_MACOS.to_string()));
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
```

- [ ] **Step 2: Run, expect failure** (unresolved items).
- [ ] **Step 3: Implement** the items to the Interfaces above.
- [ ] **Step 4: Run the Rust tests, clippy and fmt.** Expected: PASS, with no dead-code warning on Windows.
- [ ] **Step 5: Commit.** `git add src-tauri/src/meeting_detect/mac_logic.rs src-tauri/src/meeting_detect/mod.rs`, then `git commit -m "feat(meeting-detect): pure Mac session mapping and support probe"`.

---

### Task 3: The Core Audio enumeration (`macos.rs`). No local compile.

**Files:**
- Create: `src-tauri/src/meeting_detect/macos.rs`
- Modify: `src-tauri/src/meeting_detect/mod.rs:16-24`. Add `#[cfg(target_os = "macos")] mod macos;` and `#[cfg(target_os = "macos")] use macos::enumerate_capture_sessions;`. Change both stub lines to `#[cfg(not(any(target_os = "windows", target_os = "macos")))]`.
- Modify: `src-tauri/Cargo.toml:82-85`. Add `libc = "0.2"` to the macOS dependencies. It is already in `Cargo.lock` transitively.

**Interfaces:**
- Consumes: `mac_logic::{RawProcess, sessions_from_processes, probe_verdict}` (Task 2).
- Produces, used by Task 4:
  - `pub fn enumerate_capture_sessions() -> Result<Vec<SessionInfo>, String>`
  - `pub fn probe() -> Result<(), String>`

The cidre calls (0.11.3, `use cidre::core_audio as ca;`, as `speaker/macos.rs:2` imports it):
- **List:** `ca::System::processes()` returns `os::Result<Vec<ca::Process>>` (`hardware.rs:373`). Only this read can fail the whole call. Map its error with `format!("Core Audio process list: {e:?}")`.
- **Per process:**
  - `pid: p.pid().ok().and_then(|v| u32::try_from(v).ok())` (`hardware.rs:257`; `sys::Pid` is `i32`);
  - `running_input: p.is_running_input().ok()` (`:269`);
  - `bundle_id: p.bundle_id().ok().map(|s| s.to_string())` (`:261`; `cf::String` implements `Display`);
  - `exe_path: pid.and_then(exe_path)`.
- **`fn exe_path(pid: u32) -> Option<String>`:** `libc::proc_pidpath(pid as i32, buf.as_mut_ptr().cast(), buf.len() as u32)` into a `[0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize]` buffer. Return `None` when the result is `<= 0`. Otherwise `String::from_utf8_lossy(&buf[..n])`. The `unsafe` block gets a `// SAFETY:` comment naming the buffer length.
- **`probe()`:**
  - `has_list = ca::System::OBJ.has_prop(&ca::PropSelector::HW_PROCESS_OBJ_LIST.global_addr())`;
  - `has_taps` is the same with `HW_TAP_LIST` (`hardware.rs:344, 413, 431`; `System` derefs to `Obj`, `:328`);
  - the trial read is `ca::System::processes().map(|_| ())` with the error mapped to a `String`, run only when `has_list` is true (otherwise `Ok(())`);
  - return `probe_verdict(has_list, has_taps, read)`.
- The module doc says the poll loop needs no per-thread setup on Mac. The COM block stays `#[cfg(target_os = "windows")]` (§5.1).
- `detection.log` needs no change. `log_line` and `session_signature` already work on any platform, and the latter logs the raw names.

- [ ] **Step 1: Write `macos.rs`** to the above.
- [ ] **Step 2: Local regression check.** Run clippy, the Rust tests and fmt on Windows. Expected: PASS, because `macos.rs` is not compiled here. The macOS compile is verified in Task 6.
- [ ] **Step 3: Commit.** `git add src-tauri/src/meeting_detect/macos.rs src-tauri/src/meeting_detect/mod.rs src-tauri/Cargo.toml src-tauri/Cargo.lock`, then `git commit -m "feat(meeting-detect): enumerate Mac mic sessions through Core Audio"`.

---

### Task 4: The probe seam and the platform guards

**Files:**
- Modify: `src-tauri/src/meeting_detect/mod.rs`:
  - `UNSUPPORTED_PLATFORM` (`:27`);
  - `StartAction` (`:328-334`) and `plan_start` (`:349-356`);
  - `start_meeting_watcher` (`:760-795`);
  - `list_capture_sessions` (`:1052-1077`);
  - the guards at `:765, 873, 897, 924, 991, 1057`;
  - the `plan_start_*` tests (`~:1413-1434`).

**Interfaces:**
- Consumes: `macos::probe` (Task 3), and `mac_logic::{probe_verdict, UNSUPPORTED_MACOS}` in tests (Task 2).
- Produces:
  - `pub const UNSUPPORTED_PLATFORM: &str = "Meeting detection is not supported on this platform";`
  - `fn platform_support() -> Result<(), String>`. Windows: `Ok(())`. macOS: `macos::probe()`. Otherwise: `Err(UNSUPPORTED_PLATFORM.to_string())`. One `#[cfg]` block per arm.
  - `StartAction::Refuse(String)`. A start that must not spawn; the command returns the message as its `Err` and writes **no** state (`watch_list`, `confirmed` and `last_error` are untouched).
  - `fn plan_start(running: bool, stopping: bool, support: impl FnOnce() -> Result<(), String>) -> StartAction`. `support` is called only on the `(false, _)` arm: `Ok` gives `Spawn`, `Err(e)` gives `Refuse(e)`. The two running arms are unchanged and never probe.
  - `fn capture_rows(support: Result<(), String>, enumerate: impl FnOnce() -> Result<Vec<SessionInfo>, String>, lists: &WatchLists, own_pid: u32) -> Result<Vec<MicSession>, String>`. Return `support`'s error without calling `enumerate`; otherwise `describe_sessions(&enumerate()?, lists, own_pid)`.
- Wiring:
  - All six guards become `cfg!(not(any(target_os = "windows", target_os = "macos")))`.
  - `start_meeting_watcher` calls `plan_start(running, stopping, platform_support)` and adds the match arm `StartAction::Refuse(message) => Err(message)`. The existing `log_line` before the match records the refusal.
  - `list_capture_sessions`' blocking closure keeps the Windows COM init and uninit around `capture_rows(platform_support(), enumerate_capture_sessions, &lists, std::process::id())`.
  - Leave the existing `#[cfg_attr(not(target_os = "windows"), allow(dead_code))]` attributes as they are. An `allow` on an item that is now used is not a lint, and narrowing 40 of them could only be checked on the macOS job.

- [ ] **Step 1: Write the failing tests.** Update every existing `plan_start(a, b)` call to `plan_start(a, b, || Ok(()))`, then add:

```rust
#[test]
fn plan_start_refuses_without_spawning_on_an_unsupported_mac() {
    assert_eq!(
        plan_start(false, false, || mac_logic::probe_verdict(true, false, Ok(()))),
        StartAction::Refuse(mac_logic::UNSUPPORTED_MACOS.to_string())
    );
}

#[test]
fn plan_start_a_failed_read_is_a_retryable_refusal_not_unsupported() {
    let StartAction::Refuse(msg) =
        plan_start(false, false, || mac_logic::probe_verdict(true, true, Err("x".into())))
    else {
        panic!("expected Refuse")
    };
    assert_ne!(msg, mac_logic::UNSUPPORTED_MACOS);
}

#[test]
fn plan_start_never_probes_a_running_watcher() {
    let probed = std::cell::Cell::new(false);
    let support = || {
        probed.set(true);
        Err("x".to_string())
    };
    assert_eq!(plan_start(true, false, support), StartAction::UpdateWatchList);
    assert!(!probed.get());
}

#[test]
fn capture_rows_returns_the_probe_error_without_enumerating() {
    let called = std::cell::Cell::new(false);
    let lists = WatchLists { direct: vec![], gated: vec!["com.google.Chrome".into()] };
    let got = capture_rows(
        mac_logic::probe_verdict(false, true, Ok(())),
        || {
            called.set(true);
            Ok(vec![])
        },
        &lists,
        1,
    );
    assert_eq!(got.unwrap_err(), mac_logic::UNSUPPORTED_MACOS);
    assert!(!called.get());
}

#[test]
fn capture_rows_describes_sessions_when_supported() {
    let lists = WatchLists { direct: vec![], gated: vec!["com.google.Chrome".into()] };
    let rows = capture_rows(Ok(()), || Ok(vec![session(7, Some("com.google.Chrome.helper"), true)]), &lists, 1).unwrap();
    assert_eq!(rows[0].kind, "gated");
}

#[test]
fn unsupported_platform_text_names_no_platform() {
    assert!(!UNSUPPORTED_PLATFORM.contains("Windows"));
}
```

- [ ] **Step 2: Run, expect failure** (signature mismatch, `Refuse` and `capture_rows` missing).
- [ ] **Step 3: Implement** to the Interfaces.
- [ ] **Step 4: Run the Rust tests, clippy and fmt.** Expected: PASS.
- [ ] **Step 5: Commit.** `git add src-tauri/src/meeting_detect/mod.rs`, then `git commit -m "feat(meeting-detect): probe Mac support before starting or listing"`.

---

### Task 5: Two Mac permission commands

**Files:**
- Modify: `src-tauri/src/speaker/commands.rs`. Add both commands after `request_system_audio_access` (`:516-…`).
- Modify: `src-tauri/src/lib.rs:233-234`. Register `speaker::prime_system_audio_access` and `speaker::open_microphone_settings` next to `speaker::request_system_audio_access`. Also re-export them wherever `speaker/mod.rs` re-exports the other commands. Follow that file's existing pattern.

**Interfaces** (consumed by Task 9):
- `#[tauri::command] pub async fn prime_system_audio_access() -> Result<bool, String>`.
  - Why it exists: which call raises the system-audio prompt is unverified (§5.6). Building the tap alone (`check_system_audio_access`) may not prompt; starting IO does. `SpeakerInput::stream()` reaches `start_device` (`speaker/macos.rs:143, 168`).
  - macOS body, in `tauri::async_runtime::spawn_blocking`:
    - `std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| { let s = SpeakerInput::new()?.stream(); std::thread::sleep(Duration::from_millis(300)); drop(s); anyhow::Ok(()) }))`;
    - `Ok(Ok(()))` gives `Ok(true)`;
    - an inner `Err`, or a panic (`stream()` unwraps `start_device`, `speaker/macos.rs:168`), is logged with `error!` and gives `Ok(false)`.
  - Non-macOS body: `Ok(true)`. It is never called there.
  - If M2 shows building the tap alone prompts, this body may shrink; the frontend does not change.
- `#[tauri::command] pub async fn open_microphone_settings(app: AppHandle) -> Result<(), String>`. Same shape as `request_system_audio_access`'s macOS arm (`:517-527`) with the URL `x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone`. Non-macOS: `Ok(())`. The opener plugin is not used, because its default scope allows only http, https, mailto and tel.

- [ ] **Step 1: Implement both commands and register them.**
- [ ] **Step 2: Run clippy and fmt on Windows.** Expected: PASS. The macOS arms are verified in Task 6.
- [ ] **Step 3: Commit.** `git add src-tauri/src/speaker/commands.rs src-tauri/src/speaker/mod.rs src-tauri/src/lib.rs`, then `git commit -m "feat(speaker): commands to raise the Mac system-audio prompt and open the mic pane"`.

---

### Task 6 (conductor-run): a draft PR so the macOS job runs on this branch

`ci.yml` runs only on pull requests to `main`. Without an open PR, no Mac compile happens before P6. This deviates from ship's P5 order; log it. P5 later turns this draft into the real PR and updates its body.

- [ ] **Step 1:** `git push -u origin feat/macos-meeting-detection-design`.
- [ ] **Step 2:** `gh pr create --draft --base main --title "feat(meeting-detect): auto-record Google Meet in Chrome on Mac" --body-file <tmp>`. The body is a one-paragraph summary plus "Draft: opened early so the macOS CI job compiles the Mac code". Write `pr` into ship state.
- [ ] **Step 3: Watch `Backend Lint & Test (macOS)`.** For each failure in Tasks 3–5's Mac code, dispatch an Anthropic implementer with the failing log, the file and the cidre source path. Make one commit per fix, run `cargo fmt --check`, push, and repeat. Exit: the macOS job is green. Tasks 7–11 may run meanwhile; P5 waits for this exit.

---

### Task 7: The TS matcher, Mac lists and platform helper

**Files:**
- Modify: `src/config/constants.ts:108-127`. Add the Mac lists and the Mac label.
- Modify: `src/lib/meeting-detect.ts:1-31`.
- Modify: `src/lib/functions/meeting-auto-record.ts:35-37`.
- Modify: `src/hooks/useMeetingAutoRecord.ts:813-818`.
- Test: `src/tests/meeting-detect.test.ts` (extend; no platform mock); `src/tests/meeting-detect.platform.test.ts` (new); `src/tests/meeting-auto-record.decisions.test.ts` (extend `describe("isSameCall")` at `:167`); `src/tests/useMeetingAutoRecord.auto-stop.test.tsx` (extend next to "same app and same slot" at `:1016`).

**Interfaces:**
- `constants.ts`:
  - `export const MEETING_DETECT_PROCESSES_MAC: string[] = [];`
  - `export const MEETING_DETECT_GATED_PROCESSES_MAC = ["com.google.Chrome"];`
  - A comment above them: Mac IDs are bundle IDs matched with the helper-prefix rule (`entryMatches`), and they are provisional until the readout on a real Mac confirms Chrome's ID (spec §7 step 3).
  - In `MEETING_DETECT_LABELS`: `"com.google.chrome": "Google Meet"`.
- `meeting-detect.ts` (imports `isMacOS` and `isWindows` from `@/lib/platform`):
  - `export function entryMatches(entry: string, id: string): boolean` follows the same rule as Rust's `entry_matches`.
  - `export function sameCallId(a: string, b: string): boolean` is true when `a` equals `b` case-insensitively, or when some entry of the static union of all four lists (both platforms' direct and gated) matches both. `.exe` entries never prefix-match, so the union cannot change Windows results.
  - `export const isMeetingDetectionPlatform = (): boolean => isWindows() || isMacOS();`
  - `currentWatchLists()` returns `isMacOS() ? { direct: MEETING_DETECT_PROCESSES_MAC, gated: MEETING_DETECT_GATED_PROCESSES_MAC } : <today's>`.
  - `meetingLabel(process)` returns the label of the first `MEETING_DETECT_LABELS` key for which `entryMatches(key, process)` holds, else the fallback.
  - `isGatedProcess(process)` is `!!process && [...MEETING_DETECT_GATED_PROCESSES, ...MEETING_DETECT_GATED_PROCESSES_MAC].some((e) => entryMatches(e, process))`.
- `isSameCall` step 1: `if (s.endedProcess && s.process && !sameCallId(s.endedProcess, s.process)) return false;`.
- `onDetected` (`useMeetingAutoRecord.ts:813-818`): `g.endedProcess && process && !sameCallId(g.endedProcess, process) ? null : await readCalendarEvents(...)`.

- [ ] **Step 1: Write the failing tests.** In `meeting-detect.test.ts`:

```ts
describe("entryMatches", () => {
  it("applies the helper-prefix rule to Mac entries only", () => {
    expect(entryMatches("com.google.Chrome", "com.google.Chrome")).toBe(true);
    expect(entryMatches("com.google.Chrome", "COM.GOOGLE.CHROME.HELPER")).toBe(true);
    expect(entryMatches("com.google.Chrome", "com.google.ChromeX")).toBe(false);
    expect(entryMatches("chrome.exe", "chrome.exe.foo")).toBe(false);
    expect(entryMatches("Teams.exe", "teams.exe")).toBe(true);
  });
});

describe("Mac IDs through the shared matcher", () => {
  it("labels a Chrome helper and the mixed-case constant as Google Meet", () => {
    expect(meetingLabel("com.google.Chrome")).toBe("Google Meet");
    expect(meetingLabel("com.google.Chrome.helper")).toBe("Google Meet");
    expect(meetingLabel("com.google.ChromeX")).toBe("Meeting");
  });
  it("gates Chrome helpers, never WebKit", () => {
    expect(isGatedProcess("com.google.Chrome")).toBe(true);
    expect(isGatedProcess("COM.GOOGLE.CHROME.HELPER")).toBe(true);
    expect(isGatedProcess("com.google.ChromeX")).toBe(false);
    expect(isGatedProcess("com.apple.WebKit.WebContent")).toBe(false);
    expect(meetingLabel("com.apple.WebKit.GPU")).toBe("Meeting");
  });
  it("treats a helper and its app as the same call, in both directions", () => {
    expect(sameCallId("com.google.Chrome", "com.google.Chrome.helper")).toBe(true);
    expect(sameCallId("com.google.Chrome.helper", "com.google.Chrome")).toBe(true);
    expect(sameCallId("com.google.Chrome.helper", "com.google.Chrome.helper.Renderer")).toBe(true);
    expect(sameCallId("com.google.Chrome", "com.google.ChromeX")).toBe(false);
    expect(sameCallId("chrome.exe", "chrome.exe.foo")).toBe(false);
    expect(sameCallId("ms-teams.exe", "Zoom.exe")).toBe(false);
    expect(sameCallId("Teams.exe", "teams.exe")).toBe(true);
  });
});
```

The existing `currentWatchLists` test (`:42-49`) stays as it is. jsdom is not a Mac, so it gets today's lists.

Create `meeting-detect.platform.test.ts`. It mocks `@/lib/platform` with `let platform: "windows" | "macos" | "linux"` and exposes `getPlatform`, `isWindows`, `isMacOS` and `isLinux` derived from it. It asserts:
- `currentWatchLists()` on `"macos"` equals `{ direct: [], gated: ["com.google.Chrome"] }`;
- on `"windows"` it equals `{ direct: MEETING_DETECT_PROCESSES, gated: ["chrome.exe"] }`;
- `isMeetingDetectionPlatform()` is true on `"windows"` and `"macos"` and false on `"linux"`.

In `meeting-auto-record.decisions.test.ts`, inside `describe("isSameCall")`, use `it.each` over `[["com.google.Chrome","com.google.Chrome.helper"],["com.google.Chrome.helper","com.google.Chrome"]]`:
- `isSameCall({ endedProcess: a, process: b, events: null, endedAt, now })` is `true`;
- with `events: [meetingEvent()]` it is also `true`;
- and `isSameCall({ endedProcess: "com.google.Chrome", process: "com.google.ChromeX", events: null, endedAt, now })` is `false`.

In `useMeetingAutoRecord.auto-stop.test.tsx`, next to `:1016`, add `it.each(...)("a Chrome helper returning in the grace is the same call (%s then %s)")` with `startAndEnd(first)`:
- record `const reads = mocks.fetchGoogle.mock.calls.length` before the re-detect;
- `await fireActed("meeting-detected", { process: second })`, then `settle(GRACE * 2)`;
- assert the same three outcomes as `:1032-1034`;
- also assert `mocks.fetchGoogle.mock.calls.length === reads + 1`. This proves `onDetected` did not skip the calendar read as a "new call"; an exact comparison passes the other three assertions anyway.

Three test files mock `@/lib/platform` with `isWindows` only: `useMeetingAutoRecord.auto-stop.test.tsx:42`, `useMeetingAutoRecord.lifecycle.test.tsx:37` and `useMeetingDetection.lifecycle.test.tsx:26`. A Vitest factory mock throws when code reads an export it does not define, and `currentWatchLists` now calls `isMacOS()`. Add `isMacOS: () => false` to all three factories in this task so they keep passing. Task 8 replaces them with three-state mocks.

- [ ] **Step 2: Run, expect failure.** `npx vitest run src/tests/meeting-detect.test.ts src/tests/meeting-detect.platform.test.ts src/tests/meeting-auto-record.decisions.test.ts src/tests/useMeetingAutoRecord.auto-stop.test.tsx`.
- [ ] **Step 3: Implement** to the Interfaces.
- [ ] **Step 4: Run the same command plus `src/tests/useMeetingAutoRecord.lifecycle.test.tsx src/tests/useMeetingDetection.lifecycle.test.tsx`, then `npm run lint` and `npm run type-check`.** Expected: PASS, with every pre-existing case unchanged.
- [ ] **Step 5: Commit.** `git add src/config/constants.ts src/lib/meeting-detect.ts src/lib/functions/meeting-auto-record.ts src/hooks/useMeetingAutoRecord.ts src/tests/meeting-detect.test.ts src/tests/meeting-detect.platform.test.ts src/tests/meeting-auto-record.decisions.test.ts src/tests/useMeetingAutoRecord.auto-stop.test.tsx src/tests/useMeetingAutoRecord.lifecycle.test.tsx src/tests/useMeetingDetection.lifecycle.test.tsx`, then `git commit -m "feat(meeting-detect): Mac watch lists and one TS matcher for labels, gating and same-call"`.

---

### Task 8: Open the three owner gates to macOS

**Files:**
- Modify: `src/hooks/useMeetingDetection.ts:7, 35`; `src/hooks/useMeetingAutoRecord.ts:14, 170`; `src/pages/settings/index.tsx:14, 44`. Each uses `isMeetingDetectionPlatform()` from `@/lib/meeting-detect`. Drop any `isWindows` import that becomes unused.
- Test, mock updates found by `grep -rn 'Mock("@/lib/platform"' src/tests` (the spec's §8 list plus what grep found):
  - `useMeetingAutoRecord.auto-stop.test.tsx:29, 42, 454, 553` and `useMeetingAutoRecord.lifecycle.test.tsx:26, 37, 386, 466, 486`: replace Task 7's `isMacOS: () => false` with `isMacOS: vi.fn(() => false)` in the hoisted `mocks` and the factory, and reset it in `beforeEach` beside `mocks.isWindows.mockReturnValue(true)`. The existing "off Windows" cases set `isWindows` false with `isMacOS` false, so they now mean Linux and stay inactive.
  - `useMeetingDetection.lifecycle.test.tsx:26`: replace `let onWindows` with `let platform: "windows" | "macos" | "linux" = "windows"`, use a factory with `isWindows: () => platform === "windows"` and `isMacOS: () => platform === "macos"`, and turn every `onWindows = false` into `platform = "linux"`.
  - `settings-page.meeting-auto-record.test.tsx:5-11`: use the same three-state `platform` with all four exports.
  - `settings-page.content-protection.test.tsx`, `settings-page.overlay-pill.test.tsx` and `overlay-meeting-targets-survive.test.tsx` need no edit (their mocks already expose `isWindows: () => true`, and `isMacOS` or a spread original). Run them to confirm.

- [ ] **Step 1: Write the failing tests.**
  - `settings-page.meeting-auto-record.test.tsx`: rename F28 to "renders the toggle on Windows and Mac only". Windows: present. `"macos"`: present. `"linux"`: absent.
  - `useMeetingAutoRecord.lifecycle.test.tsx`: next to F30b (`:485`), add "F30c: registers listeners on Mac". With `mocks.isWindows` returning false and `mocks.isMacOS` returning true, after mount and flush, `registered("meeting-detected")` and `registered("meeting-ended")` are both `1`.
  - `useMeetingDetection.lifecycle.test.tsx`: add "owns the watcher on Mac, not on Linux". With the setting seeded on:
    - `platform = "macos"` gives `cmdCount("start_meeting_watcher") === 1`, with args `{ direct: [], gated: ["com.google.Chrome"] }`;
    - `platform = "linux"` gives `0`.
    - Mock `@/lib/mac-permissions` here already, with `hasMicGrant: vi.fn(async () => true)`. Task 10 adds the check; until then the mock is unused but harmless.
- [ ] **Step 2: Run, expect failure** in the new Mac cases.
- [ ] **Step 3: Implement** the three gate swaps.
- [ ] **Step 4: Run every file in this task, then lint and type-check.** Expected: PASS.
- [ ] **Step 5: Commit** the three source files and the edited tests: `git commit -m "feat(meeting-detect): run the detection owners and the toggle on Mac"`.

---

### Task 9: The Mac permission wrappers and the start-failure record

**Files:**
- Create: `src/lib/mac-permissions.ts`
- Create: `src/lib/meeting-start-failure.ts`
- Modify: `src/config/constants.ts`. Add `MEETING_AUTO_RECORD_START_FAILURE: "meeting_auto_record_start_failure"` to `STORAGE_KEYS` (after `:55`), with a comment: a Mac-only JSON `StartFailure`, shown by the toggle until the next toggle-on.
- Test: `src/tests/mac-permissions.test.ts`, `src/tests/meeting-start-failure.test.ts` (both new).

**Interfaces:**

`mac-permissions.ts` (header comment: macOS only; the plugin is imported dynamically because a static import breaks the Windows build):
- `export async function hasMicGrant(): Promise<boolean>` calls `checkMicrophonePermission()` from `await import("tauri-plugin-macos-permissions-api")`. It **fails open**: if the check throws, log `console.warn` and return `true`. A broken check must not turn auto-record off at every launch.
- `export async function requestMicAccess(): Promise<boolean>` calls `navigator.mediaDevices.getUserMedia({ audio: true })`, stops every track and returns `true`. Any rejection (`NotAllowedError`, `NotFoundError`, …), or a missing `navigator.mediaDevices`, returns `false`. Why not the plugin's request: `request_microphone_permission` passes a nil completion handler and returns before the user answers (plugin `commands.rs:198-212`). `getUserMedia` settles on the answer and is the same WebKit path the auto-start opens (`AutoSpeechVad.tsx:98`).
- `export async function requestSystemAudioAccess(): Promise<boolean>` is `invoke<boolean>("prime_system_audio_access")`, with a rejection mapped to `false`.
- `export async function openMicSettings(): Promise<void>` is `invoke("open_microphone_settings")`. `export async function openSystemAudioSettings(): Promise<void>` is `invoke("request_system_audio_access")`.

`meeting-start-failure.ts` (imports `safeLocalStorage` from `@/lib`, `STORAGE_KEYS`, `invoke`, `currentWatchLists`, and the `mac-permissions` functions):
- `export type StartFailureKind = "start-error" | "mic-denied" | "audio-denied" | "permission-reset";` and `export interface StartFailure { message: string; kind: StartFailureKind }`.
- `export function readStartFailure(): StartFailure | null` returns `null` on a missing value, invalid JSON, or a value without a string `message` and a known `kind`. `export function writeStartFailure(f: StartFailure): void` and `export function clearStartFailure(): void` (`removeItem`).
- The copy below is exact, so the tests can pin it:
  - `export const MIC_DENIED_MESSAGE = "Meetwings can't use the microphone. Allow it in System Settings → Privacy & Security → Microphone, and check that a microphone is connected.";`
  - `export const AUDIO_DENIED_MESSAGE = "Meetwings can't record system audio. Allow it in System Settings → Privacy & Security → Screen & System Audio Recording, then turn auto-record on again.";`
  - `export const PERMISSION_RESET_MESSAGE = "Microphone permission was reset (this can happen after an update). Turn auto-record on again to allow it.";`
- `export class MicGrantMissingError extends Error {}`.
- `export function toStartFailure(error: unknown): StartFailure`. A `MicGrantMissingError` becomes `{ kind: "permission-reset", message: PERMISSION_RESET_MESSAGE }`; anything else becomes `{ kind: "start-error", message: String(error) }` (Tauri rejects with the Rust string itself).
- `export async function macToggleOnCheck(): Promise<StartFailure | null>`, in strict order and stopping at the first failure:
  1. `invoke("list_capture_sessions", { ...(await currentWatchLists()) })`. A rejection gives `start-error` with its text. This is the same probe the watcher runs (Task 4), and asking it first means an unsupported macOS prompts for nothing (§5.5).
  2. `requestMicAccess()`. False gives `mic-denied`.
  3. `requestSystemAudioAccess()`. False gives `audio-denied`.
  4. Otherwise `null`.

- [ ] **Step 1: Write the failing tests.**
  - `mac-permissions.test.ts`: mock `tauri-plugin-macos-permissions-api` and `@tauri-apps/api/core`, and stub `navigator.mediaDevices`.
    - `requestMicAccess`: resolves `true` and calls `stop()` on every track; `false` on a `DOMException` named `NotAllowedError`; `false` on `NotFoundError`; `false` with `mediaDevices` undefined.
    - `hasMicGrant`: returns the plugin's `true` or `false`; returns `true` and warns when the plugin throws.
    - `requestSystemAudioAccess`: invokes `prime_system_audio_access` and passes its boolean through; `false` on a rejection.
    - The two `open*` functions invoke `open_microphone_settings` and `request_system_audio_access`.
  - `meeting-start-failure.test.ts`: mock `@/lib` (spread original, plus a `stored`-backed `safeLocalStorage`, as `MeetingAutoRecordToggle.note.test.tsx:30-45` does), `@/lib/mac-permissions` and `@tauri-apps/api/core`.
    - The record round-trips; invalid JSON and `{"kind":"nope"}` both read `null`; clear removes it.
    - `toStartFailure(new MicGrantMissingError())` gives the permission-reset pair. `toStartFailure("Auto-record needs macOS 14.2 or later")` gives the `start-error` kind with that message.
    - `macToggleOnCheck`:
      - a probe rejection gives `start-error`, and neither request is called;
      - mic `false` gives `mic-denied`, and system audio is not requested;
      - system audio `false` gives `audio-denied`;
      - all OK gives `null`, and `requestMicAccess` ran before `requestSystemAudioAccess` (compare `mock.invocationCallOrder`).
- [ ] **Step 2: Run, expect failure.** `npx vitest run src/tests/mac-permissions.test.ts src/tests/meeting-start-failure.test.ts`.
- [ ] **Step 3: Implement** to the Interfaces.
- [ ] **Step 4: Run the same command, then lint and type-check.** Expected: PASS.
- [ ] **Step 5: Commit** both modules, `constants.ts` and both tests: `git commit -m "feat(meeting-detect): Mac permission wrappers and a persisted start-failure record"`.

---

### Task 10: Mac start checks in `useMeetingDetection`

**Files:**
- Modify: `src/hooks/useMeetingDetection.ts`: `startWatcher` (`:97-99`), the retry handler (`:131-150`) and effect 3 (`:254-271`).
- Test: `src/tests/useMeetingDetection.lifecycle.test.tsx`, using the Task 8 three-state mock and `@/lib/mac-permissions` mock.

**Interfaces:**
- Consumes: `hasMicGrant` (Task 9); `MicGrantMissingError`, `toStartFailure` and `writeStartFailure` (Task 9); `isMacOS` from `@/lib/platform`.
- `const startWatcher = async (isCancelled: () => boolean = () => false): Promise<boolean>`:
  - on Mac, `if (isMacOS() && !(await hasMicGrant())) throw new MicGrantMissingError()`;
  - then `const lists = await currentWatchLists()`;
  - then **`if (isCancelled()) return false`**. This is the last statement before the invoke, after every await (§5.6);
  - then `await invoke("start_meeting_watcher", { ...lists })` and `return true`.
- Effect 3 calls `const started = await startWatcher(() => cancelled)`. After the try/catch it adds `if (!started) return;` before emitting `watcher-restarted`. The catch keeps its four statements and order. The only change is the emit payload: on Mac (`isMacOS()`), `const failure = toStartFailure(error)`, then `writeStartFailure(failure)` and emit `{ enabled: false, failure }`. On Windows the payload stays exactly `{ enabled: false }` and nothing is written.
- Retry handler catch: if `isMacOS() && error instanceof MicGrantMissingError`:
  - set the setting `"false"`;
  - `setEnabled(false)`;
  - `writeStartFailure(failure)`;
  - emit `meeting-detection-setting-changed` `{ enabled: false, failure }` **first**;
  - then emit `meeting-detection-watcher-restarted` `{ ok: false, error: failure.message }`, because every exit path must reply (`:132-136`).

  Every other error keeps today's `{ ok: false, error }` reply and leaves the toggle on.

- [ ] **Step 1: Write the failing tests** (`platform = "macos"` unless stated; seed `STORAGE_KEYS.MEETING_AUTO_RECORD_ENABLED = "true"`):
  - "Mac: a start with the mic grant missing never invokes the watcher and turns the toggle off". With `hasMicGrant` resolving `false`, after mount and flush:
    - `cmdCount("start_meeting_watcher") === 0`;
    - the stored setting is `"false"`;
    - `emit` was called with `("meeting-detection-setting-changed", { enabled: false, failure: { kind: "permission-reset", message: PERMISSION_RESET_MESSAGE } })`;
    - the stored record parses to the same pair.
  - "Mac: a refused start is persisted and carried". With `hasMicGrant` `true` and `start_meeting_watcher` rejecting `"Auto-record needs macOS 14.2 or later"`, the emit payload and the stored record are `{ kind: "start-error", message: "Auto-record needs macOS 14.2 or later" }`.
  - "Mac: turning off during the mic check fires no start". `hasMicGrant` returns a deferred promise. Mount and flush, then fire `meeting-detection-setting-changed` `{ enabled: false }` and flush. Resolve the deferred with `true` and flush. Expect `cmdCount("start_meeting_watcher") === 0`.
  - "Mac: retry with the mic grant gone turns the toggle off".
    - Start healthy (`hasMicGrant` `true`), then make `hasMicGrant` resolve `false`, fire `meeting-detection-retry-requested` and flush.
    - `stop_meeting_watcher` was invoked, and `start_meeting_watcher` was invoked exactly once overall.
    - The setting-changed emit with the permission-reset failure comes before `watcher-restarted` `{ ok: false, … }` (compare indexes in `emit.mock.calls`).
  - "Windows: no permission calls, and the failure payload is unchanged". With `platform = "windows"`, run a start, a retry, and a start whose invoke rejects. `hasMicGrant` is never called, and the failure emit is exactly `{ enabled: false }`.
- [ ] **Step 2: Run, expect failure.** `npx vitest run src/tests/useMeetingDetection.lifecycle.test.tsx`.
- [ ] **Step 3: Implement** to the Interfaces.
- [ ] **Step 4: Run it again, then lint and type-check.** Expected: PASS, with every pre-existing case green.
- [ ] **Step 5: Commit:** `git commit -m "feat(meeting-detect): check the Mac mic grant before every watcher start"`.

---

### Task 11: The Mac toggle

**Files:**
- Modify: `src/pages/settings/components/MeetingAutoRecordToggle.tsx`
- Test: `src/tests/MeetingAutoRecordToggle.mac.test.tsx` (new). Copy the harness of `MeetingAutoRecordToggle.note.test.tsx:1-79`, and add a three-state `@/lib/platform` mock (default `"macos"`) and an `@/lib/mac-permissions` mock (all `vi.fn`, default resolving `true`). `MeetingAutoRecordToggle.note.test.tsx` stays untouched and must stay green; it is the non-Mac path.

**Interfaces:**
- Consumes: `macToggleOnCheck`, `readStartFailure`, `writeStartFailure`, `clearStartFailure` and `StartFailure` (Task 9); `openMicSettings` and `openSystemAudioSettings` (Task 9); `isMacOS` from `@/lib/platform`.
- **State.** `const [startFailure, setStartFailure] = useState<StartFailure | null>(() => (isMacOS() ? readStartFailure() : null))`, and `const [requesting, setRequesting] = useState(false)`.
- **The `meeting-detection-setting-changed` listener** (`:110-122`) also runs `if (payload?.failure) setStartFailure(payload.failure)` and, when `enabled`, `setStartFailure(null)`.
- **`handleSwitchChange(checked)`:** if `!isMacOS() || !checked`, run today's body unchanged. Otherwise:
  - `setRequesting(true)`, `clearStartFailure()`, `setStartFailure(null)`;
  - `const failure = await macToggleOnCheck()`;
  - on a failure: `writeStartFailure(failure)`, `setStartFailure(failure)`, and **no** save or emit;
  - otherwise run today's body (save `"true"`, set status pending, emit `{ enabled: true }`);
  - `setRequesting(false)` in a `finally`.
- **The Switch** gets `disabled={requesting}`. A flip cannot overtake the pending requests (§5.6).
- **The failure note** renders when `startFailure` is set, **regardless of `isEnabled`**. It reuses the existing note's container classes and shows `startFailure.message`.
  - `kind === "mic-denied"` adds `<Button size="sm" variant="outline" onClick={openMicSettings}>Open Microphone settings</Button>`.
  - `kind === "audio-denied"` adds `Open System Audio settings`, calling `openSystemAudioSettings`.
  - The other kinds have no button.
  - The existing `showNote` block (`:173-176, 206-218`) is unchanged.
- **Copy:** `const copy = isMacOS() ? MAC_COPY : WINDOWS_COPY`. It feeds the Header `title`/`description`, the Label, the paragraph and the Switch's `aria-label`.
  - `WINDOWS_COPY` is today's strings (`:181-203`), except that the paragraph drops `Windows only.`.
  - `MAC_COPY`:
    - title `Auto-record meetings`;
    - description `Record Google Meet calls in Chrome automatically`;
    - label and aria-label `Automatically record Google Meet calls in Chrome`;
    - paragraph `Starts recording when Chrome starts using the microphone (a Google Meet call or anything else), and stops when it ends. Requires voice detection to be enabled in audio settings. Turning this on asks for microphone and system audio permission. Participants may need to be told the call is being recorded — rules vary by country.`

- [ ] **Step 1: Write the failing tests** in `MeetingAutoRecordToggle.mac.test.tsx`. Let `sw()` be `screen.getByLabelText("Automatically record Google Meet calls in Chrome")`.
  - "an unsupported macOS shows that error and asks for nothing". `invoke` rejects `list_capture_sessions` with `"Auto-record needs macOS 14.2 or later"`. Click `sw()` and flush. Then:
    - the text is on screen;
    - `requestMicAccess` and `requestSystemAudioAccess` were not called;
    - `stored[ENABLED]` is not `"true"`, and `emit` was not called with `enabled: true`;
    - `sw()` is not checked.
  - "asks for both permissions before saving or emitting". `requestMicAccess` returns a deferred promise. Click and flush, then:
    - no setting-changed emit has happened, `stored[ENABLED]` is undefined, and `sw()` is disabled;
    - resolve the mic with `true` and flush: `requestSystemAudioAccess` was called;
    - afterwards `stored[ENABLED] === "true"`, `emit` was called with `("meeting-detection-setting-changed", { enabled: true })`, and `sw()` is enabled.
  - "a mic denial keeps it off and names the microphone". `requestMicAccess` gives `false`. Then:
    - `MIC_DENIED_MESSAGE` is visible;
    - clicking "Open Microphone settings" calls `openMicSettings`;
    - `requestSystemAudioAccess` was not called, and nothing emitted `enabled: true`.
  - "a system-audio denial names system audio". `AUDIO_DENIED_MESSAGE` is visible, and "Open System Audio settings" calls `openSystemAudioSettings`.
  - "a click while the requests are pending changes nothing". With the mic deferred, click twice. `requestMicAccess` was called once. Resolve `false`; `stored[ENABLED]` is not `"true"`.
  - "a failure stored before mount shows while the toggle is off". Seed `stored[START_FAILURE]` with `{ kind: "start-error", message: "Auto-record needs macOS 14.2 or later" }` and render: the text is visible and `sw()` is unchecked. This is the Settings window mounted after the failure (§8).
  - "a failure carried by setting-changed shows at once". Fire `{ enabled: false, failure: { kind: "permission-reset", message: PERMISSION_RESET_MESSAGE } }`: the text is visible.
  - "the next toggle-on clears the failure". Seed a failure, then click with everything granted: the note is gone and `stored[START_FAILURE]` is undefined.
  - "the readout shows the probe's error". `list_capture_sessions` rejects `"Auto-record needs macOS 14.2 or later"`. Click "Check microphone apps": `"Couldn't list microphone apps."` and the message are both visible.
  - "Mac copy names Google Meet in Chrome only": `screen.queryByText(/teams/i)` is null.
  - "Windows: immediate save, no permission calls, no lasting note" (`platform = "windows"`, a failure seeded in storage).
    - Clicking `getByLabelText("Automatically record Teams and Google Meet calls")` saves `"true"` and emits at once.
    - No `mac-permissions` mock was called.
    - The seeded failure's text is not shown.
    - `screen.queryByText(/windows only/i)` is null.
- [ ] **Step 2: Run, expect failure.** `npx vitest run src/tests/MeetingAutoRecordToggle.mac.test.tsx src/tests/MeetingAutoRecordToggle.note.test.tsx`.
- [ ] **Step 3: Implement** to the Interfaces.
- [ ] **Step 4: Run the same command, the whole `test_paths` list, lint and type-check.** Expected: PASS.
- [ ] **Step 5: Commit:** `git commit -m "feat(settings): Mac auto-record toggle asks for permissions and keeps start failures visible"`.

**Manual checks, after the PR (owner and tester, spec §7 steps 3–5 and §8).** These are not P4 tasks. Run M1, M2, M2b, M5–M10 from the spec, plus:
- **M2a.** After M2's grants, quit and relaunch Meetwings with the toggle on. The toggle stays on, with no "permission was reset" note, and the next Meet call records. This is Review Focus 1.

Dispatch the test DMG with `gh workflow run macos-test-build.yml --ref feat/macos-meeting-detection-design` once Task 0's PR has merged to `main`. The feature branch already carries the file, from Task 0 step 5.
