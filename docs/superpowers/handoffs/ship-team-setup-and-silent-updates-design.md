# Ship handoff: team-setup-and-silent-updates-design

**Topic:** team-setup-and-silent-updates-design
**Branch:** `feat/team-setup-and-silent-updates`
**PR:** https://github.com/kmorgan-r/meetwings-app/pull/104 (OPEN, awaiting human merge)
**Spec:** `docs/superpowers/specs/2026-11-15-team-setup-and-silent-updates-design.md`
**Plan:** `docs/superpowers/plans/2026-11-15-team-setup-and-silent-updates.md`

## What this ships

Two pieces, so colleagues get updates and company settings with no clicks and no copying of keys.

- **Silent auto-updates on every Windows and Mac install.**
  - The app checks at start and every 4 hours, downloads in the background, and installs and restarts only when nothing is recording.
  - The install gate waits for no open capture, no detected meeting and no team join applying, plus 30 minutes since the last capture or meeting ended.
  - The updater starts at module scope in `main.tsx`, outside the React root, so a crashed overlay can't stop it.
  - NSIS installs silently. The MSI is dropped from the release.
  - `tauri-plugin-process` is added for the macOS relaunch.
  - Settings gains a status line, and an "Updated to X" note shows while that version runs.
- **Team setup by link.**
  - The owner's **Copy team settings** produces an AES-256-GCM blob that goes in a secret gist. Colleagues click `meetwings://team/<gistId>#<key>`.
  - Before the first apply or a gist switch, the dashboard prompt names the gist owner's GitHub login.
  - The file wins for the fields it covers. A failed first join rolls back. Settings re-sync at start and every 4 hours.
  - Google `profile` scope fills a blank Notion name.
  - A per-send Notion ref stops colleagues who share one token from adopting or trashing each other's pages.

## Pipeline summary

| Phase | Result |
|---|---|
| spec-review | 2 passes: a panel of 3, then an opus `--diff` pass. 3 Critical applied. |
| writing-plans | A 14-task TDD plan. |
| plan-review | 2 passes: a panel of 5, then an opus `--diff` pass. 0 Critical, 22 Important applied. |
| implementation | 14 tasks via subagent-driven-development, with opus task reviews. A security hook flagged the join prompt (it named only the gist id), so the prompt now previews the file and names the gist owner (spec amended in `5b2d4f3`). The final whole-branch opus review gave "With fixes" with 0 Critical: I1 (the updater died with an App render crash) and I2 (a cold-start link was re-handled after an update relaunch). One fix dispatch (`76447ed`..`bf4dd25`) covered I1, I2 and minors M1/M2/M3/M5/M6. The controller added `85d3216` (the macOS relaunch flag) and `e5b582c` (a try around the updater start). A scoped re-review confirmed all addressed. The exit gate at `e5b582c` passed: lint 0 errors, type-check, scoped vitest 37 files (568 tests). |
| pr-create (P5) | The secret scan of the branch diff was clean. The lockfile diff only adds deep-link 2.4.5 plus optional bundled entries. PR #104 opened. |
| fix-pr-reviews (P6) | CI's Rust format check failed and was fixed in `67ccace`. Review 1 had 1 High (`any` in the new tests) and 1 Medium (the "one-time" note wording), both fixed in `9b7269d`. Review 2 found no Critical, High or bug items; its one Medium (an unhandled rejection from the losing promise in the team-fetch timeout race) is skipped. CI is green on `9b7269d`. |
| db-gates (P6.5) | N/A. The branch has no `supabase/` or migration changes. |

## Before merge: human gates

1. **Run a clean `npm ci`** in a fresh clone from the committed lockfile, without the shared `node_modules` junction.
2. **Read the PR's "Risks" section** before sending a team link:
   - turn on two-factor sign-in for the GitHub account that owns the gist;
   - warn colleagues about lookalike logins;
   - send the link privately.
3. **Device checklist in the PR body, before publishing a release to colleagues.** Item 4 is the one tests can't prove: cold-start from a team link, decline, then let a silent update land. The prompt must not come back. That shows the relaunch flag reached disk before the NSIS `exit(0)`. If it comes back, move the flag to a Rust-side write.
4. **Website and MSI:** update the meetwings.com download links (the MSI link will 404). `build.bat:22` still prints the MSI path. Tell MSI users to uninstall the old copy after their first silent update.
5. **Rollout:** colleagues on 1.5.0 need one manual click-to-install to reach the silent updater. **macOS is untested**, so one Mac colleague should report back after the first silent update.

## Leftovers, not fixed on purpose

None of these is Critical or Important. The rulings are in the SDD ledger (`.superpowers/sdd/2026-11-15-team-setup-and-silent-updates/progress.md`, git-ignored).
- **M4:** the join-action link is broadcast via `emit`. Tauri 2's global `listen` receives every target, and all windows are first-party.
- **M7:** the macOS keychain is read on every sync. Mac colleagues should click "Always Allow".
- **Windows command line:** the NSIS installer command line carries the cold-start link, key included, at each update. The updater re-passes argv and offers no hook to strip it.
- **Relaunch flag survives** a failed or cancelled NSIS launch, or an App that never mounts. Cost: one ignored cold-start click.
- **Install race:** a team join starting between the gate read and the Rust install is not blocked (a window of milliseconds).
- **Linux:** a manual-update relaunch replays argv, so a link that cold-started the app returns. The user starts that update.
- **PR bot Medium:** `team-fetch.ts:83-103` leaves the losing promise of the timeout race without a rejection handler. The fetch still fails cleanly. Follow-up: add `.catch(() => {})` to the raced promises.
