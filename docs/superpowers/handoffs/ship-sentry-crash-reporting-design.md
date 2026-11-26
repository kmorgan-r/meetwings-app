# Ship handoff: sentry-crash-reporting-design

**Topic:** sentry-crash-reporting-design
**Branch:** `claude/jolly-planck-ur0ll8`. The session harness required this branch name instead of `feat/<slug>`.
**PR:** https://github.com/kmorgan-r/meetwings-app/pull/125 (OPEN, awaiting human merge)
**Spec:** `docs/superpowers/specs/2026-11-26-sentry-crash-reporting-design.md`
**Plan:** `docs/superpowers/plans/2026-11-26-sentry-crash-reporting.md`

## What this ships

Crash reports go to Sentry, so a colleague's intermittent macOS crash can be diagnosed without anyone collecting files by hand. Reporting is off in every build until a `SENTRY_DSN` is compiled in.

- **Rust.** `crash_reporting::init()` runs `sentry::init` before `tauri::Builder`, with the `minidump` feature. Panics and native crashes are captured; the crash-reporter child process exits inside `init`. `tauri-plugin-sentry` (=0.8.0) is added only when `init` ran. `build.rs` passes `SENTRY_DSN` through from the environment or `src-tauri/.env`.
- **JS.** The plugin injects `@sentry/browser`, which catches uncaught errors and unhandled rejections. React 19 boundary-caught render errors reach Sentry through `onCaughtError` → `reportCaughtError` on the non-overlay root.
- **Test trigger.** The `crash-test` cargo feature (`sentry_crash_test`, `maybe_crash_test()`) is built only by `macos-test-build.yml`. Public builds carry no trigger.
- **Symbols.** The release profile uses `debug = "line-tables-only"` and `split-debuginfo = "packed"`, which produce a dSYM on macOS and a PDB on Windows. The Ubuntu release leg builds with `CARGO_PROFILE_RELEASE_DEBUG=false`, so Linux frames show function names only. The last step of both workflows uploads symbols with `@sentry/cli@3.8.2`, and skips when `SENTRY_AUTH_TOKEN` is unset.

## Pipeline summary

| Phase | Result |
|---|---|
| spec-review | 2 passes: a panel of 2 (7 Important applied), then an opus `--diff` pass (2 Important applied). |
| writing-plans | A 5-task plan. |
| plan-review | 2 passes: a panel of 4 (5 Important applied), then a `--diff` pass (1 Important applied). |
| implementation | 5 tasks via subagent-driven-development. The final whole-branch review found no Critical or Important issues; its fix wave changed 2 comments. |
| pr (P5) | Full suites green: vitest 3526 passed / 2 skipped, cargo 245 passed. |
| fix-pr-reviews (P6) | claude-review on `0f2f63d` raised 1 High and 1 Medium, and no Critical. **High** (public releases report crashes once the DSN is set, with no opt-in or scrubbing): the owner decided to keep it as designed. The spec's CI step 8 accepts this while colleagues are the only users ([reply](https://github.com/kmorgan-r/meetwings-app/pull/125#issuecomment-7197021293)). **Medium** (`@sentry/cli@3.8.2` existence): verified on npm, no change. All 7 CI checks are green. |
| db-gates (P6.5) | N/A: no DB artifacts. The branch has no `supabase/` or migration changes. |

## Parked rulings (also in the PR body)

1. `ClientOptions::default()` plus field assignment, because the struct is `#[non_exhaustive]`.
2. Task 1 had no separate RED run.
3. Ubuntu releases build without debug info, so Linux frames show function names only.
4. The test timer is 4000 ms, because the SDK drops a same-tick rejection right after a throw.
5. A caught-panic poll flood in Windows `meeting_detect` could burn quota. Mitigation: set a rate limit on the DSN key.
6. Local and fork Linux builds come out at 134 MB plus a `.dwp`.
7. macOS keeps `strip = none`, so the DMG size growth is unmeasured.
8. The hostname is sent as `server_name`.

## Owner to-do

1. Create a Sentry project with platform Rust.
2. Add the repository secrets `SENTRY_DSN`, `SENTRY_AUTH_TOKEN`, `SENTRY_ORG` and `SENTRY_PROJECT`.
3. Set a rate limit on the DSN key, under Client Keys → Configure → Rate Limiting.
4. Dispatch `macos-test-build.yml` on this branch, then confirm that the dSYM appears under Debug Files.
5. Run the Mac checks in the spec's Testing section, including a test crash from the `crash-test` build.
6. Before Meetwings has public users, add an opt-in setting and transcript scrubbing. The spec makes this a prerequisite, because public releases report crashes once the DSN is set.
