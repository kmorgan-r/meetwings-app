# Ship handoff: notion-meeting-notes-design

**Topic:** notion-meeting-notes-design
**Branch:** `feat/notion-meeting-notes-design`
**PR:** https://github.com/kmorgan-r/meetwings-app/pull/91 (OPEN, awaiting human merge)
**Spec:** `docs/superpowers/specs/2026-11-11-notion-meeting-notes-design.md`
**Plan:** `docs/superpowers/plans/2026-11-11-notion-meeting-notes.md`

## What this ships

Meetwings sends each recorded meeting to a team's Notion meetings database. It works next to Odoo, and on its own for teammates who don't use Odoo.

Each meeting becomes a page in the right weekday sub-table with:
- an AI summary;
- a highlighted Team Practices box;
- the full transcript.

Each new practice also becomes a "Proposed" row in a Team Knowledge database. Those rows carry no names, fees, percentages or deal terms.

The pieces:
- **Migration 17:** an independent Notion lane on `meeting_log_queue`, plus a `notion_sends` record with compare-and-swap claims.
- **The Notion token:** stored in the keychain.
- **The Notion client:** paced, with a typed error model.
- **The send:** resumable, and it checks whether a teammate already sent the same meeting.
- **The scheduler:** runs only in the overlay window.
- **The settings card:** has a Check button.
- **The Meetings page:** a Notion section with actions on each send.

## Pipeline summary

| Phase | Result |
|---|---|
| spec-review | 2 passes: a panel of 3, then an opus `--diff` pass. 1 Critical and 26 Important applied. |
| writing-plans | An 18-task TDD plan. |
| plan-review | 2 passes: a panel of 5, then an opus `--diff` pass. 17 Important applied. Two real bugs were caught here: a NULL-unsafe lane guard, and a restamp that lost the claim. |
| implementation | 18 tasks via subagent-driven-development: mechanical tasks went to the ollama worker, integration tasks to Anthropic models, and every review ran on opus. The final whole-branch review on opus came back "with fixes": 0 Critical, 6 Important, 9 Minor. One fix round (`38c88aa`) covered the 6 Important and 2 of the Minor findings. The P4 gate ran lint, type-check, and 64 named test files (1592 tests). |
| fix-pr-reviews (P6) | 3 iterations, then all clear. (1) An `any` in `loadSummaryProvider`, plus a rustfmt CI failure. (2) The `any` in `ProviderConfig.provider`. (3) A live meeting was dropped when Notion was set up but Odoo was only half set up; it is now offered, and the overlay shows the pick. |
| db-gates (P6.5) | N/A. This repo has no `supabase/` directory. Migration 17 runs through the repo's own Rust/SQLite runner and has its own tests. |

Every ruling made during execution is in the PR's known limitations or in the session's ledger. The ledger is gitignored and was deleted after the final review.

## Before merge: human gates

1. **Live Notion checks 1, 2, 5, 7 and 8** (`.livecheck/notion-live.live.ts`). Run them against throwaway databases with a real token, and paste the `[live]` lines into the PR. The decision rules are in `.livecheck/README.md`.
2. **The AI-judgement fixtures** in that README, against the real summary model:
   - a transcript that names a person;
   - one with a fee;
   - one with a prompt injection;
   - one that repeats a Rejected rule;
   - one where the practices judge omits `topic`.
3. **A merge conflict:** the primary checkout has uncommitted edits to `ContactPicker.tsx` and `src/pages/app/index.tsx`, and this branch also edits `ContactPicker.tsx`.

## Leftovers — not fixed, deliberately

These are listed in the PR body, and none is Critical or Important.

- **Pages lost or trashed:**
  - an orphan page after a step-4 "already";
  - two devices on one personal token with identical titles and spans within 60 s, which can trash both pages;
  - reconnecting the integration between a lost create and its retry, which breaks the creator match;
  - the same-meeting AI judge can be steered by someone with edit access to the team database.
- **Retries:**
  - no strike cap on UNDECIDED retries (the user can now stop them);
  - the same-meeting recheck reruns on every retry;
  - the speaker name is resolved per attempt, so a renamed user's resume fails with `NOTION_PAGE_CHANGED`.
- **Setup and settings:**
  - shared-bot tokens are unsupported;
  - after a disconnect and reconnect, recovery keeps the first setup time as its floor;
  - a half-filled Meeting summaries selection stays in the card while the saved one stays active;
  - the team-time inputs only show after a successful Check.
- **Smaller items:**
  - the redactor is armed but has no production call site yet;
  - a crash between creating a send and linking its rows can leave a zero-row send;
  - Meetwings API stream events are global (pre-existing);
  - two Medium findings from the PR bot, both skipped: the team-time window doesn't wrap at midnight, and the `pruneTranscripts` return count also counts cleared send summaries;
  - `summarySecrets` adds only variables named like key, token or secret to the redactor.

## Next step

**A human merges PR #91** after the gates above. The pipeline never merges. On the next `/ship` call after the merge, ship checks `gh pr view 91 --json state`. Because this pipeline has no DB gate, a `MERGED` state sets `status:"done"`.
