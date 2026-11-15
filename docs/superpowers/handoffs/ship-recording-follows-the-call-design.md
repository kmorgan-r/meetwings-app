# Ship handoff: recording-follows-the-call-design

**Topic:** recording-follows-the-call-design
**Branch:** `feat/recording-follows-the-call`
**PR:** https://github.com/kmorgan-r/meetwings-app/pull/99 (OPEN, awaiting human merge)
**Spec:** `docs/superpowers/specs/2026-11-14-recording-follows-the-call-design.md`
**Plan:** `docs/superpowers/plans/2026-11-14-recording-follows-the-call.md`

## What this ships

Recording now follows the call instead of the meeting-mode toggle.

- **Meeting mode is always on.** The toggle is gone, and any open mic records.
- **2-minute grace after a call ends.** When `meeting-ended` fires with the mic open, a 2-minute grace runs, then the mic closes.
  - Far-end audio restarts the grace.
  - Touching the mic, turning Auto-record off, or the watcher stopping cancels it.
  - The meeting-log row is capped at the call's end, so room talk during the grace stays out of the customer-visible Odoo note. A hand stop or an unmount during the grace is capped the same way.
- **Same call or new call.** A re-detect during the grace is checked against the calendar.
  - Same app and same event: it is the same call, and recording continues.
  - Anything else is a new call. Call A is stopped and capped at its end, with no widening into B. A's conversation and Odoo targets are reset, and B starts fresh.
  - The Undo strip labels the held row from that row's own contact.
- **Silence stop:** recording stops after 15 minutes of silence, as a backup.
- **Short segments:** a segment under 1 minute, or with only a few lines, never becomes a meeting row.
- **Transcript panel:** it hides when the mic closes.
- **Ask box:** it folds to an icon. Ctrl+Shift+I or a click expands it, and it folds back when empty and unfocused. The meeting-log Undo strip always stays visible.
- **Zoom** is added to meeting detection.
- **No Rust changes.**

## Pipeline summary

| Phase | Result |
|---|---|
| spec-review | 2 passes: a panel of 3, then an opus `--diff` pass. 4 Critical applied: the grace stop bypassing `decideOnEnded`, the silence timer's main-window gate, a missing "tests that change" section, and the same-call rule for back-to-back calls. |
| writing-plans | An 11-task TDD plan. |
| plan-review | 1 pass: a panel of 4, with 0 Critical and 8 Important applied. |
| implementation | 11 tasks via subagent-driven-development. Tasks 1-3 ran on the ollama worker, Tasks 4-10 on Anthropic implementers, and every task review ran on opus. Fix rounds caught a cap that a trigger re-run dropped (`pendingCapRef`) and two cross-task test reds. The final whole-branch review on opus found 0 Critical, 4 Important and 34 Minor. One fix wave (`ebc822a`, `86fc06b`, `c7031f0`) covered I1, I3, I4 and 7 minors, and a scoped re-review confirmed all of them addressed. The exit gate at `c7031f0` passed: lint (0 errors), type-check, 33 feature test files (610/610) and the full suite (166/166 files, 3066 passed, 2 skipped). |
| fix-pr-reviews (P6) | No fixes needed. The PR bot found no Critical or High issues. Its one Medium (a stop cap lost when a trigger is stuck in flight) is skipped; it is already deferred as Minor #1b. |
| db-gates (P6.5) | N/A. The branch has no `supabase/` changes. |

## Before merge: human gates

1. **Decide I2** (top of the PR body). A call detected after the grace stop but inside the 30-minute gap keeps the previous call's conversation and Odoo contacts. Main behaves the same way, and the plan accepted it. Fix it, file a follow-up issue, or add it to the spec's accepted residuals.
2. **Run the manual Windows checks** in the PR body. All of them are still unrun:
   - Zoom open with no call;
   - Teams hang-up: the mic closes about 2 minutes later, and exactly one row is written;
   - a hand stop during the grace;
   - the red record pulse;
   - the Ask box fold, including with the answer panel open;
   - truncation of the silence notice.
3. **Merge order with PR #98:** any branch that mocks `getAllConversations` must switch to `listConversations`. This branch adds no such mock.

## Leftovers, not fixed on purpose

All of these are listed in the PR body, and none is Critical or Important.
- **Uncapped room talk on two more grace paths.** Turning Auto-record off or the watcher stopping during the grace leaves the mic open, so room talk until the user's stop is written uncapped.
- **Rare cap loss.** The cap can be dropped on a trigger stuck in flight outside the Notion check. This is near-unreachable; the PR bot flagged it as Medium.
- **New-call catch path.** If `startNewConversation` rejects, B can be misfiled into A's conversation. This is effectively unreachable.
- **Recovery can pick up dropped room talk.** Recovery ignores the scrap skip-watermark, so dropped room talk can reach an unassigned recovered row. That row is unassigned, so the user reviews it before anything is sent.
- **Smaller items:**
  - `meeting-ended`'s `{process}` payload is ignored;
  - a Clear restarts the silence timer;
  - `animate-pulse` ignores reduced-motion;
  - a remount during a hold shows a generic Undo label.
- **Test gaps:**
  - the gen-mismatch branch of `graceStop`;
  - the skip-the-read branch;
  - the overlay mic close-then-reopen case;
  - default `waitFor` timeouts;
  - phantom-grace preconditions;
  - `replaceEntry`;
  - decline provenance;
  - `isSameCall` with an unknown current process;
  - repeated scrap merge;
  - a line exactly at the cap;
  - `recording` passed to `useOdooTarget`;
  - a `TranscriptSlice` import that does not exist.
- **Comment rot** in `meeting-log.ts`, `meeting-log-recovery.ts`, `meeting-cards.store.ts`, `constants.ts`, `useMeetingLog.ts`, `index.tsx` and `recording-stop-cap.ts`.

The session ledger and the review reports were gitignored. The workspace was deleted after the final review. Copies remain in the session scratchpad.

## Next step

**A human merges PR #99** after the gates above. The pipeline never merges. On the next `/ship` after the merge, ship checks `gh pr view 99 --json state`. This pipeline has no DB gate, so `MERGED` sets `status:"done"`.
