# Ship handoff: macos-meeting-detection-design

**Topic:** macos-meeting-detection-design
**Branch:** `feat/macos-meeting-detection-part2`. The original `feat/macos-meeting-detection-design` was merged early as #116.
**PR:** https://github.com/kmorgan-r/meetwings-app/pull/117 (OPEN, awaiting human merge)
**Related:** #115, the CI PR (merged). #116 holds Tasks 0-5 and was merged early by accident at the Task 5 head, `29b0f89`.
**Spec:** `docs/superpowers/specs/2026-11-19-macos-meeting-detection-design.md`
**Plan:** `docs/superpowers/plans/2026-11-19-macos-meeting-detection.md`

## What this ships

Meeting detection and auto-record on macOS, for Google Meet in Chrome only. It matches Windows after #109, where any Chrome mic use counts as a call. Auto-record stays off by default.

- **Rust (on main via #116).**
  - A Core Audio enumeration of processes capturing the mic, on macOS 14.2 and later, mapped to the same session rows the Windows path uses.
  - A support probe runs before every start and every readout, and refuses with a message on an unsupported macOS.
  - `start_meeting_watcher` is now async.
  - New commands: `prime_system_audio_access` and `open_microphone_settings`.
- **Frontend (#117).**
  - Mac watch lists. `com.google.Chrome` is gated, through one shared `entryMatches` matcher.
  - Detection owners and the toggle now run on Mac.
  - Permission wrappers, and a persisted start-failure record.
  - A mic-grant check before every watcher start, with cancellation guards.
  - The Mac toggle runs probe, then mic, then system audio before it saves. A failure stays visible as a note.
- **Windows behaviour is unchanged.** Tests pin this.

## Pipeline summary

| Phase | Result |
|---|---|
| spec-review | 2 passes: a panel of 3 (13 Important applied), then an opus `--diff` pass (2 Important introduced by pass 1, fixed). |
| writing-plans | A 12-task plan (Tasks 0-11). Tasks 0 and 6 were conductor-run CI steps. |
| plan-review | 2 passes: a panel of 5 (5 Important applied), then a `--diff` pass (3 Minor wording fixes). |
| implementation | 11 tasks via subagent-driven-development, with every task review on opus. Details below. |
| pr (P5) | #116 was merged early, so the 7 unmerged commits moved to a new branch as PR #117. No rebase was needed, because #116 used a merge commit. |
| fix-pr-reviews (P6) | No fixes needed. claude-review on `b752e10` found no Critical, High or Bug issues. One CI job was cancelled by its runner (its Clippy step had passed); a single-job re-run went green. |
| db-gates (P6.5) | N/A. The branch has no `supabase/` or migration changes. |

Implementation detail:
- **Who implemented what.** Task 2 and Tasks 7-9 ran on the ollama worker (glm-5.3-flash). The haiku forwarder died with `wrapper_died` on Tasks 1 and 4, so Tasks 7-9 went through the transport fallback instead. Tasks 1 and 4 escalated to sonnet. Tasks 3, 5, 10 and 11 ran on Anthropic sonnet.
- **Task 10** needed one fix round: a test for the two cancel guards, and the `any`s removed.
- **Final whole-branch review (opus).** It found 0 Critical and 2 Important, both fixed in `b752e10`:
  - no test for Mac toggle-off, a consent failure under mutation;
  - two silent catches.
  It also found 2 comment fixes. A scoped re-review confirmed all of them addressed.
- **Exit gate at `b752e10`:**
  - lint: 0 errors;
  - type-check: clean;
  - vitest: 14 files, 291/291;
  - `cargo test meeting_detect`: 73/73;
  - clippy `-D warnings` and `cargo fmt --check`: clean;
  - the macOS CI job compiled the Mac code and ran both smoke tests on a real runner.

## Before merge: human gates

Spec §7 puts the manual checks before merge.

1. Build a test DMG: `gh workflow run macos-test-build.yml --ref feat/macos-meeting-detection-part2`. It has no signing key and no updater artifacts.
2. **Run the tester's Mac checks** in the PR body: M1, M2, M2a, M2b, M5, M6, M7, M8, M9 (#114 evidence) and M10 (last). M1 confirms Chrome's real mic process and bundle ID. M2a confirms that a WebKit mic grant passes the next launch's AVCaptureDevice check.
3. **Windows regression:** one Teams call and one Meet call auto-record as before.

## Rulings made during the run (each with its cost if wrong)

1. **The async `start_meeting_watcher` stands**, despite "Windows does not change". Only the calling thread changes. If wrong: a Windows start-ordering regression, which the lifecycle tests or a Windows smoke run would catch.
2. **The test-build workflow passes no updater signing key** and turns off updater artifacts; the plan had passed the key. If wrong: the dispatch build needs a one-line config fix.
3. **Worker Tasks 7-9 went through the transport fallback**: the conductor's own PowerShell in the background, instead of the haiku forwarder. If wrong: the same `wrapper_died`, then a route to sonnet.
4. **The Task 10 cancel guards are not Mac-gated.** On Windows, a toggle-off during list load no longer starts and then stops the watcher. If wrong: one Windows edge loses a transient start/stop and an `ok:true` emit. Nothing persisted or visible depends on them.
5. **9 items the final review declined to judge are accepted as set aside.** Each is a spec-accepted limit, a non-goal, out of scope, or settled by M1, M2, M2a, M2b or M10. If wrong: a Mac defect surfaces in the tester's checks, before merge.
6. **The DOMException name is not appended to the mic-denied note**, because the copy is spec-fixed. If wrong: a tester's screenshot lacks the cause. Revisit after M2.
7. **`if (!navigator.mediaDevices) return false;` stays unlogged.** It is not a catch, and WKWebView serves `tauri://` as a secure context. If wrong: a tester sees "grant microphone" copy for a missing API. One `console.warn` line fixes it.
8. **P6 ran with `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` unset.** If wrong: a mid-iteration compaction loses an in-flight fix, which `--continue` recovers.

## Leftovers, not fixed on purpose

None of these is Critical or Important.
- **First-time system-audio denial is not caught at toggle-on.** claude-review rated it Medium. `prime_system_audio_access` returns Ok whatever the user answers, so a first "Don't Allow" leaves the toggle on with silent system audio. This is a spec §5.6 known limit, and M10 decides whether a silence-detector follow-up is needed.
- **The Mac retry path ignores cancellation** (`useMeetingDetection.ts:163`). The window is a single status read.
- **The readout drops processes with no name** (`mod.rs:1100`). This predates the branch. Note it for the Safari design.
- **`payload.failure` is not guarded by `isStartFailure`** before `setState`. The emitter is in-repo and typed.
- **Test gaps:**
  - three retry-path mutants (`writeStartFailure`, `failure.message`, `setEnabled(false)`);
  - the listener clearing the note on `enabled: true`;
  - persistence of the failure record after a failed toggle-on;
  - the `capture_rows` Err passthrough;
  - TS/Rust odd-input parity cases.
- **Polish:**
  - stale test names ("non-Windows" now means Linux);
  - pre-existing console noise in the lifecycle suites;
  - `gap-3` on the failure note;
  - unhandled "Open settings" click rejections;
  - inline spy restores.

The session ledger and the review reports were gitignored. The workspace was deleted after the final review; a copy remains in the session scratchpad.

## Next step

**A human merges PR #117** after the gates above. The pipeline never merges. On the next `/ship` after the merge, ship checks `gh pr view 117 --json state`. This pipeline has no DB gate, so `MERGED` sets `status:"done"`.
