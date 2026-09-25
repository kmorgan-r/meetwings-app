# Ship handoff — issue 75 (Odoo fault legibility, probe-before-create, contacts-sync page isolation)

- **PR:** https://github.com/kmorgan-r/meetwings-app/pull/77 (OPEN, against `main`)
- **Branch:** `feat/issue-75-odoo-sync-wedges-on-odoo-fault-2-faultstring-never-rendered` (worktree `C:\Users\kmorg\ship-fleet\meetwings-app\issue-75`)
- **Spec:** `docs/superpowers/specs/2026-09-21-issue-75-odoo-sync-wedges-on-odoo-fault-2-faultstring-never-rendered-design.md`
- **Plan:** `docs/superpowers/plans/2026-09-21-issue-75-odoo-sync-wedges-on-odoo-fault-2-faultstring-never-rendered.md`
- **Head:** `5344c95`

## What shipped

1. `queueErrorText` renders `details.faultString` — redacted before the 400-char cap (surrogate-safe cut), only for non-empty string faultString, every other shape byte-identical; wire-to-storage needle test proves the end-to-end chain.
2. Existence probe in `createOrAdoptAttachment` before every `ir.attachment.create` with no known id (`limit: 1`, `context: { active_test: false }`, no catch); empty result → terminal `ODOO_FAULT: target record N missing or inaccessible (search returned 0 rows)`; non-empty unusable → `ODOO_UNEXPECTED_ROW`; rejections propagate (UNREACHABLE stays retryable).
3. Contacts-sync page-fault machinery: ODOO_FAULT on a page fetch → id-only field-less plain `search` → bisection (fault-catch only) → singleton skip (counted, cursor folds it) → multi-record zero-upsert pages fail loudly (read-evidence condition exempts the all-vanished-mid-window race); `machineryIdCount`/`machineryMaxId` keep the break/breaker/cursor honest against mid-window deletes and re-types.
4. AssignDialog: archived gates (`disabled={!c.active}`, opacity-50, disproven comments) removed; `adopted-archived` copy merged into `adopted-active`; the `Archived` tag is the only trace.

## Review status

- Spec: 2 applying passes at the ceiling (11 findings applied; human accepted pass 2 and advanced without a reset — `review_passes[spec-review]` stays 2).
- Plan: 5-reviewer panel + `--diff` re-review; 2 Criticals fixed pre-implementation (bisection only on fault; breaker single-record exemption).
- Implementation: 4 tasks, per-task opus reviews; final whole-branch review (opus — `fable` returned 404 from this backend) = **ready to merge, 0 Critical/Important**; one comment-sweep fix wave, re-reviewed clean.
- PR review loop (`fix-pr-reviews`): **3 iterations, all clear** — final review reports no critical/high/medium issues. Three Mediums fixed (surrogate-cap test; `machineryIdCount` silent-drop race; breaker read-evidence + `machineryMaxId` cursor fold), one Medium skipped as the spec's accepted sub-watermark fate (skip-ledger follow-up). Round ledger 3/8.

## Gate evidence

- `eslint`: 0 errors (62 pre-existing-class warnings); `check:types` script absent → skipped (noted in state).
- Scoped vitest over the branch's six test files: 224/224 at the P4 gate; contacts-sync suite grew to 29 through the PR loop.
- No DB artifacts vs merge-base (P6.5) — no migrations, no edge functions, no secrets.

## Leftovers / for the human

- **Parked ruling (follow-up issue recommended):** the disproven archived gate survives in `ContactPicker.tsx:537` + `AddToggle.tsx:16-19` doc comment — spec scoped the removal to AssignDialog; the branch leaves ContactPicker inconsistent with AssignDialog for archived contacts. Both task-loop and final reviewer judged the ruling sound; open a follow-up issue.
- **Accepted residual (spec):** the probe proves search-visibility, not write rights; a readable-but-unwritable record can still strand an orphan on `message_post` fault. Record-level write probe = follow-up work.
- **Skipped PR-loop finding:** sub-watermark silent loss of machinery-skipped records — spec-accepted; a persisted skip ledger (picker-visible) is the designed follow-up.
- **Historical stored error texts are NOT backfilled** (spec Out-list) — old `last_error` texts stay until a retry rewrites them.
- Ollama worker ran Tasks 1 and 4 (glm-5.3-flash:cloud, 17 + 36 turns, no escalations); Tasks 2-3 were sonnet; all reviewers opus; the final-review tier `fable` was unavailable (404) and fell back to opus.

## Rulings made (conductor-level, with costs if wrong)

1. **Plan defect (T2):** the brief's fake-client stub resId chain was one nesting too deep; fixed minimally. Cost if wrong: none — provable against the probe's args shape.
2. **Plan defect (T3):** the two cursor tests' mocks ignored the domain's id-cursor (a correct implementation would spin forever under them); fixed mock-side only. Cost if wrong: none — the repaired mocks model a real Odoo.
3. **Single-record breaker exemption:** spec items 4/5 conflict for a one-record page; item 4 wins (no table-walk to hide; recovers when a page-mate appears). Cost if wrong: a drift hitting a table whose every page is single-record walks silently — an edge-of-edge the multi-record breaker still covers.
4. **ContactPicker/AddToggle archived gate ruled out of scope:** the spec's In-list is AssignDialog-only. Cost if wrong: the archived-contact inconsistency between the two surfaces persists until a follow-up; the gate is dead weight, not a safety mechanism.
5. **Sub-watermark skip finding skipped in the PR loop:** spec-accepted fate. Cost if wrong: a transiently-faulting record whose page-mate advances the watermark stays unsynced until edited or a full re-sync — visible via the skipped count, made durable only by the skip-ledger follow-up.
6. **PR-loop Medium fixes beyond urgent scope (iters 2-3):** fixed a reviewer Medium outside the loop's urgent-only default because the fix was one line and the race was a silent permanent drop in a PR themed on preventing exactly that. Cost if wrong: two extra review cycles (~10 min).