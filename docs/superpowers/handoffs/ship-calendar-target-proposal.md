# Ship handoff — calendar-target-proposal

**Topic:** calendar-target-proposal · **Branch:** `feat/calendar-target-proposal`
**PR:** https://github.com/kmorgan-r/meetwings-app/pull/51 (open, all six CI checks green)
**Spec:** `docs/superpowers/specs/2026-09-01-calendar-target-proposal-design.md` (issue #47)
**Plan:** `docs/superpowers/plans/2026-09-02-calendar-target-proposal.md` — 16 tasks, 4 slices
**Range:** `b7a2ad5..53b820c` — 47 commits, 40 files, +14,136 / −13

## Phase outcomes

| Phase | Result |
|---|---|
| P0 init | Branch adopted (already carried the brainstorming commits); `main` fast-forwarded **before** rebasing, so `test_paths` derivation could not sweep in PR #49's files |
| P1 spec-review | PASS, 2 passes. `3/3` then `1/1`; C=4 I=15 M=6 applied, then C=0 I=2 M=3 |
| P2 writing-plans | 4,242 lines; both probes became Tasks 1–2, with Probe 2 gating all auth work |
| P3 plan-review | PASS, 2 passes, ceiling reached. `5/5` then `1/1`; C=7 I=20 applied. Five of the seven CRITICALs were one root cause — a rule correct at the first call site and hand-copied wrong at the second |
| P4 implementation | All 16 tasks complete and reviewed. Exit gate green (below) |
| P5 pr-create | PR #51 opened. Not merged — the human merges |
| P6 fix-pr-reviews | **No actionable feedback, and not because the branch is clean.** See "Repo defect" below |
| P6.5 db-gates | Not applicable — no `supabase/` directory |

## Final gate (run on the merge tree)

| Check | Result |
|---|---|
| `npm run type-check` | clean |
| `npm run lint` | 0 errors, 60 warnings (unchanged baseline) |
| `npm test -- --run` | 79 files, 1386 passed, 2 skipped, **0 failed** |
| `cargo test` | 98 passed |
| `cargo clippy --all-targets -- -D warnings` | clean |
| `cargo fmt --check` | clean |
| `npm run build` | clean |

## Repo defect found during P6 — worth fixing before the next PR relies on it

The `claude-review` workflow **produces a review and silently loses it.** Its own execution result on this PR reads `num_turns: 49`, `is_error: false`, `permission_denials_count: 14`, and the PR carries zero reviews, zero review comments and zero issue comments. So it did about five minutes of real work and every attempt to publish was denied, while the job reported success.

The workflow's own prompt already documents this failure mode ("the call is denied, and the review is silently lost even though the job reports success"), so it is known rather than novel — but it means **a green `claude-review` check currently carries no information at all.** It was not treated as all-clear here: zero findings from a failed review is byte-identical to zero findings from a clean one.

This did not block the pipeline, because the branch already carries 16 task reviews, 7 scoped re-reviews, and a whole-branch Opus review whose three Important cross-task findings were fixed and mutation-verified.

## Before merging

**1. A deliberate breach of a spec constraint, shipped as a tradeoff.** `present = connected && rows.length > 0`, and both resolve asynchronously after mount, so the reserved 112px region can appear inside an already-open popover and disappear from one — breaching "the popover's footprint must not change after it opens."

This is a design choice, not an oversight: a late-appearing block beats no block for the rest of that open session. Fixing it means either reserving the region before `present` is known — reintroducing exactly the cost the static/dynamic split exists to avoid, for the majority of users who have no client ID — or blocking the popover on two async resolutions. **That decision belongs to the spec's author.** Two manual-acceptance steps measure its real severity rather than arguing about it.

**2. Eight manual acceptance items remain unrun** — `docs/superpowers/plans/probe-results/2026-09-02-manual-acceptance.md`. Nothing automated can cover them: a loopback browser round-trip cannot be proven in jsdom, and jsdom has no window bounds. The three that matter most:

- **Linux with no keychain service** — a stated security requirement with no other place to be exercised. `keyring` 3.x ships no default backend and silently resolves to an in-memory mock, so `keychain.rs` hard-codes the refusal rather than inferring it.
- **A meeting with a booked room.** `attendees[].type == "resource"` was never observed live — the Graph probe window contained no room mailbox — so the resource-drop rule ships unexercised against real data.
- **`invalid_grant` clears the token, and a transport failure retains it.** The codes are unit-tested; the branch that *acts* on them lives in an async command making real network calls.

## Follow-ups, deliberately not in this PR

- **Account switch without disconnecting.** Signing in as B while connected as A never transitions `connected`, so A's proposal stays on screen and actionable. Pre-existing; the fix needs a connection epoch threaded into the fetch effect's dependencies. A listener-only `reset()` is *not* sufficient — the deps would not change, so nothing refetches and the block renders a permanent phantom spinner.
- **Freeing a slot does not re-tick rows.** The reconciliation cannot distinguish "the user unchecked this" from "the slot rule said nothing fits" without tracking user-initiated unchecks.
- **A contact renamed while the proposal is open shows the stale name** until the next fetch. The id is what gets written, so it mislabels but never misroutes.
- `graph_status` performs synchronous keychain I/O on a UI-relevant path; a stale-generation call issues one discarded `calendarView` request before a backstop drops it.
- **No test covers the `persist_op` critical sections** — every cargo test is single-threaded, so removing that lock from either section survives the whole suite. Closed by construction and review, not by test. A deterministic regression test needs a third seam and self-deadlocks in its naive form.

## What this pipeline learned that the code does not show

Recorded because these shaped decisions a reader would otherwise have to re-derive.

**Four agents died mid-task** — three wedged ending a turn on a build-progress note (Tasks 7, 11, 13), one hit a watchdog stall (Task 16). Every time, the work was already on disk; the controller ran the gates and committed. Task 16's dispatch required *incremental commits* specifically because of the earlier three, and that is why its stall cost nothing.

**Tests that cannot fail were this plan's most frequent defect — four separate tasks.** Twice the *brief itself* shipped them. Two recurring shapes: `toMatchObject` is a subset check, so it tolerates a mutant returning a *richer* object (this is what would have let a mutant push every attendee address into UI state); and `waitFor` runs its callback synchronously before any await, so asserting a value already true at `t=0` asserts nothing. The corroborating tell is timing — vacuous `waitFor` tests cost 6–7ms where genuinely-waiting ones cost 47–180ms.

**"Break the code, confirm *that* test fails, restore" was the highest-value instruction in these dispatches** — ahead of flag-don't-fix. It converted at least one bad controller prescription into a real test instead of another unfalsifiable one, before it shipped.

**Seven controller prescriptions were corrected downstream.** The instructive ones: a prescribed `try/finally` that would have *introduced* a data-corruption bug (React batches the last `setTargets` with `setWriting(false)`, so resetting the ref synchronously unblocks a guard one render too early — a reviewer proved this with a standalone React replica rather than arguing it); a prescribed `toMatchObject` that would not have killed the mutant it targeted; and a `#[allow(dead_code)]` count of "46" that was a substring match catching three doc comments — the real count was 43, and *all* 43 were live code, so the attributes were stale scaffolding rather than cover for dead code.

**Briefs went stale in one direction, twice.** Task 14's brief predated Task 13's discovery of a state it had to render; Task 16's sweep list predated a fix Task 11's own review round had already applied. Any brief item naming a specific test or line deserves an "is this still true" check before acting on it.

**A whole-branch review earns its keep even after every task was reviewed.** All three of its Important findings spanned two tasks' guarantees, so no per-task reviewer had both halves in view. The sharpest one traced to a controller instruction: a stabilization ordered in Task 13 to protect Task 15's memo silently removed the re-projection that Task 4's colleague/archived exclusion depended on — leaving a path where confirming would log a meeting onto a coworker's record.

**The closing fix round introduced a regression, and that is a different category from a residual.** Its intersect-only reconciliation silently dropped the slot rule, so adding unrelated targets elsewhere in the popover left more rows checked than there was room to write — the confirm button offering "Add 3 to log" beside a notice reading "2 slots left". Shipping it would have meant the last thing the pipeline did was break something that worked, so it was fixed rather than tracked.

The full reasoning — 56 numbered rulings — was kept in `.superpowers/sdd/2026-09-02-calendar-target-proposal/progress.md` during execution. That directory is git-ignored scratch; this document is the durable record.
