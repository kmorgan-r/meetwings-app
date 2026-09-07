# Ship handoff: unify-meeting-summarization

**Topic:** unify-meeting-summarization
**Branch:** `docs/unify-meeting-summarization`
**PR:** https://github.com/kmorgan-r/meetwings-app/pull/57 (OPEN, awaiting human merge)
**Spec:** `docs/superpowers/specs/2026-09-07-unify-meeting-summarization-design.md`
**Plan:** `docs/superpowers/plans/2026-09-07-unify-meeting-summarization.md`

## What this ships

Unifies two redundant AI-summarization code paths — Odoo's transcript-based
`generateMeetingLogSummary` (cached in the now-dropped `meeting_log_queue.summary_json`
column) and Context Memory's chat-based `generateConversationSummary`/`summarizeConversation`
(cached in `meeting_summaries`) — onto one shared `ensureMeetingSummary` helper backed
solely by `meeting_summaries`. Adds a SQLite migration (16) that backfills the old
column's data into `meeting_summaries` and drops the column, rewires every caller
(Odoo push, Context Memory backfill, system-audio capture), fixes a conversation-scoping
bug in `summarizeCurrentConversation` found during spec review, and adds an inline
"expand to see summary" affordance to the meetings dashboard.

## Pipeline summary

| Phase | Result |
|---|---|
| spec-review | 2 passes (panel of 3, then Opus `--diff`). 6 Critical / 23 Important / 16 Minor found and applied across both passes. |
| writing-plans | 8-task TDD plan, ~2716 lines after review. |
| plan-review | 2 passes (panel of 5, then Opus `--diff`). 7 Critical / 17 Important / 8 Minor found and applied. |
| implementation | All 8 tasks implemented via subagent-driven-development. 3 of 8 needed 1 fix round each (missing regression coverage on real risks). Whole-branch final review: 0 Critical, 0 Important, "Ready to merge: Yes". One fix wave (6 bundled Minor findings) + one scoped re-review: clean. |
| fix-pr-reviews (P6) | All-clear on first check — no fix iterations needed. |
| db-gates (P6.5) | N/A — no `supabase/` artifacts in this repo; the branch's one SQLite migration (16) is this repo's own Rust migration runner, gated by spec/plan review and migration tests, not by this phase. |

Full phase-by-phase detail (every reviewer finding, every ruling, every commit) is in
`.claude-ship-state.json`'s `phase_log` (gitignored, local to this machine).

## A real CI-only bug caught after the SDD final review

The final whole-branch review and its fix wave were both clean locally, but
`finishing-a-development-branch`'s Step 1 full-suite run surfaced a genuine CI failure
that neither review pass had reason to check: PR #57's "Backend Format Check (Rust)"
job was failing because an `assert_eq!` added to `migration_tests.rs` (Task 2) needed
`cargo fmt`'s line-wrap. Fixed and pushed as `3a1ee1c`. Also surfaced (and independently
confirmed via CI's own green "Frontend Tests" run) an unrelated, pre-existing, load-
dependent flake in `odoo-settings-page.test.tsx` — not this branch's file, not this
branch's responsibility.

## Leftovers — not fixed, deliberately

Parked as low-severity, explicitly non-blocking by the reviewers who found them:

- **Collapse-during-fetch race** in the dashboard expand affordance (`QueueRow.tsx`,
  `ConversationRow.tsx`) — no `AbortController`/generation-counter guard, inherited from
  the plan's own design. Deterministic on any read slower than a fast double-click;
  bounded blast radius (an uninvited panel re-open, not wrong data).
- **3 test-coverage gaps**: the cache-hit-vs-`minEntries` ordering is untested; the
  Context-Memory slice test can't discriminate conversation id by position; neither
  expand-affordance test suite has a collapse-click test.
- **2 overclaiming comments** in `useMeetingLogQueue.ts` (~line 636, ~666) that assert
  with certainty a failed/unassigned row has no cached summary "by construction" — no
  longer strictly true now that `useSystemAudio`'s capture-stop path and the
  Context-Memory backfill can populate the shared cache independently of the Odoo row's
  own timing. Same overclaim class the fix wave correctly softened at `meeting-log.ts:112`
  but missed at these two sites.
- **1 stale comment** at `summary-content.render.test.tsx:17-18`, self-inflicted by the
  fix wave's own EntityType-fixture correction (still says the badge renders
  `"organization:"`; it now renders `"company:"`).
- **3 more comment-rot sites** in `meeting-log-page.test.tsx` (~671, ~2253, ~2284),
  same shape as the 9 fixed in the fix wave but out of that wave's named scope.
- **2 pre-existing spec-doc-only nits** noted by the final PR review comment: a stale
  `ConversationRow.tsx:507` line citation and a `getMeetingSummaryByConversation`
  "swallows every DB failure" premise wording issue — both in the spec's prose only,
  not in code.
- **SummaryContent's location** (`src/pages/context-memory/components/`, imported by
  two `src/pages/meetings/` components) — a layering preference, not a defect.

None of these are Critical or Important by any reviewer's own severity call. Worth a
follow-up pass, not a blocker.

## DB gate

Not applicable — this repo has no `supabase/` directory. Migration 16
(`src-tauri/src/db/migrations/meeting-log-queue-v2.sql`) is this repo's own Rust/SQLite
migration runner, reviewed and tested through spec-review, plan-review, and the
migration's own test suite (11 cases, including a mutation-verified malformed-JSON
fallback guard) — not something P6.5's Supabase-specific detection covers or needs to.

## Next step

**Human merges PR #57 manually.** The pipeline does not merge on its own. On the next
`/ship` invocation after the merge, ship checks `gh pr view 57 --json state`; a clean
`MERGED` state (this pipeline has no DB gate to re-check) sets `status:"done"`.
