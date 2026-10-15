# Ship handoff: calendar auto-select

- **Topic:** calendar-auto-select-design
- **Branch:** `feat/calendar-auto-select` (base origin/main `140d175`)
- **PR:** https://github.com/kmorgan-r/meetwings-app/pull/87. It is open and awaiting a human merge. The conductor never merges.
- **Spec:** `docs/superpowers/specs/2026-10-15-calendar-auto-select-design.md`
- **Plan:** `docs/superpowers/plans/2026-10-15-calendar-auto-select.md`

## What shipped

When meeting capture starts, the app adds the current Outlook meeting's attendees as Odoo targets. It also creates contacts for attendees who are clearly new. Both happen with no confirm click, in clear cases only. A switch on `/odoo` controls it, and it is on by default.

## Final review status

- **Per-task reviews (opus):** all 7 tasks approved.
  - Task 3 took one fix round (dispatch order).
  - Task 5 took one fix round (a guard no test covered).
- **Whole-branch review (opus):** "With fixes". The fix wave covered:
  - a wider namesake rule;
  - an own-address guard for addresses with no domain;
  - two comment fixes;
  - test-file typing.

  The re-review found every finding addressed, and RED was confirmed by running the four new tests against the old planner.
- **PR bot review (claude-code-review):** no Critical, High or Bug findings. One Medium finding is out of default scope; see Leftovers.
- **Gate:**
  - `npm run lint`: 0 errors.
  - `npm run type-check`: clean.
  - `npx vitest run` on the 14 affected test files: 327/327.

## Phase log

| Phase | Result |
|---|---|
| init | Reused the existing worktree. The user asked to "go light on reviewing plans": P1 ran 2 reviewers, P3 ran 3, and the `--diff` re-pass was skipped. |
| spec-review | 2/2 reviewers. C=1 I=7 M=4, all applied. The CRITICAL: `meetingTranscript` is session-wide, so the check moved to `audioSource`. |
| writing-plans | 7 tasks plus a manual check. Committed `cf9ab78`. |
| plan-review | 3/3 reviewers. C=0 I=2 M=12; 8 applied (I=2, M=6). The key change: `clearAllTargets` now announces `odooTargetsCleared`. Committed `0dcb655`. |
| implementation | Subagent-driven development. Implementers ran on ollama-worker (glm-5.3-flash): every task was DONE on the first pass. The final fix wave escalated at `max_turns_60` and the controller finished it. Commits `140d175..35dd309`. |
| pr-create | Pushed the branch and opened #87. |
| fix-pr-reviews | Loop complete, no urgent issues (0 rounds). |
| db-gates | P6.5: no DB artifacts. The branch touches no `supabase/`, migrations or `src-tauri/`. |

## DB gate

`db_gate`: null. There are no DB or deploy artifacts.

## Leftovers

1. **Manual check (plan Task 8, not run).** Use a real Teams call with an outside attendee.
   - Start capture. The targets should appear in "Logging to" with no click.
   - Turn the `/odoo` switch off. Auto-select should stop.
2. **Bot Medium / review Minor: the Clear vs in-flight write race.** `useOdooTarget.addTarget` has no token check after its write. If Clear lands during an in-flight auto-select `addSelectedTarget`, the target can come back.
   - The comment at `useOdooTarget.ts:1261` overstates the invariant.
   - Fix: capture `selectionToken` at entry and re-check it after the write, and loop on `clearingRef`.
3. **Namesake rule false positives.** The two-token rule blocks auto-create for different attendees who share a company suffix or name particles. The safe direction: the attendee falls back to the proposal block. A possible fix is to strip parentheticals before comparing attendees.
4. **`inferCompany` writes `parentId` with no confirm.** An internet-provider mail domain missing from `FREE_MAIL` (e.g. `online.no`) can attach a stranger's company.
5. **Deferred cosmetic minors:**
   - Missing trailing newlines in `useCalendarAutoSelect.ts`, `fetch-current-meetings.ts` and their tests.
   - The `console.error` spy in `useCalendarAutoSelect.test.tsx` is never restored.
   - The `cache.kind === "ready"` narrowing is duplicated in `completion/index.tsx`.
   - Import order.
   - The new key in `constants.ts` has no comment.
   - Untested: the post-await guard (`useCompletion.ts` ~1572), the trailing `.catch` (`useOdooTarget.ts:836`), and the off→on toggle write.
6. **UX suggestion.** Mention "flag one coworker as a colleague" in the switch's help text. That is the only remedy for a UPN domain that differs from the mail domain.
