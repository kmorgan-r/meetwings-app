# Ship handoff — create an Odoo contact from an unmatched calendar attendee

| | |
|---|---|
| **Topic** | `create-contact-from-attendee` |
| **Branch** | `feat/create-contact-from-attendee` |
| **PR** | https://github.com/kmorgan-r/meetwings-app/pull/54 (open, awaiting human merge) |
| **Spec** | `docs/superpowers/specs/2026-09-05-create-odoo-contact-from-attendee-design.md` |
| **Plan** | `docs/superpowers/plans/2026-09-05-create-contact-from-attendee.md` |
| **Range** | `6a4cbe3..400a998` (25 commits) |
| **DB gate** | N/A — no `supabase/` directory in this repo; P6.5 detection matched nothing |

## Outcome

Ships the `Create in Odoo` action on the greyed `no-contact` attendee rows in the meeting-overlay
proposal, behind its own confirm gate, with two independent duplicate guards: a live exact-email
adopt-or-create against Odoo (Layer 1) and a cached name-similarity warning offering the existing
contact as a target instead (Layer 2).

**Verification at merge time**

- `npm run lint` — 0 errors, 61 pre-existing warnings, 0 new
- `npm run type-check` — clean
- Full suite — 85 files, 1512 passed, 2 skipped, 0 failed
- The 9 test files this branch adds or changes contribute 222 tests
- CI: success · Claude Code Review: success, no blocking findings

## Phase log

| Phase | Result |
|---|---|
| P0 init | Branch **adopted**, not re-cut — the spec is committed at `af25336` and nowhere else, so the literal recipe would have produced a branch on which the spec does not exist. |
| P1 spec-review | PASS, 2 passes, 3-reviewer panel. 3 CRITICALs applied. |
| P2 writing-plans | 9 tasks, 3132 → 3647 lines after review. |
| P3 plan-review | PASS, 2 passes, 5-reviewer panel. 3 CRITICALs applied; both pass-2 CRITICALs had been *introduced by* the pass-1 revision. |
| P4 implementation | PASS. See below. |
| P5 pr-create | PR #54 opened against `main`. Fresh remote branch. |
| P6 fix-pr-reviews | All-clear on the first check — no urgent items. |
| P6.5 db-gates | No DB artifacts. Advanced straight to P7. |

## P4 — what execution actually found

Nine tasks, each with a task review and, where needed, a fix loop; then a whole-branch review, one
fix wave, one scoped re-review.

### Four defects in shipped code

Two of these overrode the plan's own text, with the spec as the tiebreaker.

1. **Layer 1 used Odoo `=ilike`**, which is SQL `LIKE` pattern matching rather than exact — so an
   email containing `_` could adopt a *different* person's production CRM record. The false
   positives land in the same result set as the true row, so `preferForAdoption` could pick the
   wrong one *even when the right one was present*. The spec's binding words are "a live
   **exact-email** adopt-or-create", so the finding beat the plan. Fixed by filtering parsed rows to
   an exact normalized email before the comparator runs.
2. **An open create form kept rendering on a row a reprojection had reclassified to `archived`**,
   violating the constraint that archived rows get no form. Inert at the time; write-capable one
   task later.
3. **The `acting` flag had an epoch-guarded release with no reset path**, so an Odoo instance change
   during a `Use` write latched the component's *entire* write surface off for the rest of the
   mount. The idle-reset effect's own doc comment documents that exact hazard for the sibling flag,
   three lines above.
4. **Stale-state clearing sat on the wrong side of the write guard** while the event-id ref was
   consumed unconditionally above it, so a proposal change landing mid-write leaked `createResult`
   into the next meeting permanently.

### Nine unfailable tests

The dominant finding of this phase. Nine separate tests passed against the exact mutant they were
written to catch — including a regex test written with the wrong character, two fixture ids that had
to differ and were both `7`, a test that could not tell a guard inside a `try` from one outside it,
a fixture ordering plus a five-row cap hiding *both* halves of a test's own title, and a `disabled`
attribute suppressing the very click a test meant to fire.

Three of the nine were caught by implementers mutation-testing their own work and reporting instead
of banking the green.

**The recurring lesson:** a pass count is never evidence, and a comment or report claiming coverage
the assertion does not deliver is *itself* the defect — it is a standing licence for a future reader
to delete the line.

## Leftovers

### Recommended follow-up (not filed — needs a human decision)

**Extract the create form from `CalendarProposal.tsx`.** The file is now ~1171 lines with 12
`useState`, five refs, four effects and three async write handlers. Both the whole-branch reviewer
and the PR review flagged it, and both agreed deferring was right: restructuring at the final gate
is the unforced risk the process spent the whole branch avoiding. The suggested shape is either the
form JSX into a `CreateContactForm` child receiving draft state and the three handlers as props, or
the draft/candidates/acting cluster into a `useCreateForm` hook — keeping `openForm` and the latches
at the parent, where the cross-row invariants live.

### Carried minors (15, all triaged and accepted)

Raw `U+2019` rather than an escape at three sites in `similar-contacts.ts`; `preferForAdoption`
duplicating two tie-break lines from `preferForDuplicateEmail`; no empty-address guard in
`createOrAdoptContact` (unreachable through the only caller); `createResult.address` written and
never read (brief-mandated shape); a `react-refresh/only-export-components` warning caused by the
brief's own instruction to export `prefillName` from the component file; and a duplicated "112px
scroll region" rationale.

### Also worth a follow-up

`resolveWithExisting` could clear the cap-rejection message it itself set, on its own success path —
otherwise a later successful `Use` can leave "The log is full" standing beside "added Jane Doe".
Handler-side, so it respects the spec's "cleared in exactly two places" rule, which targets the
reactive effects.

### One item the PR review raised, non-blocking

`inferCompany`'s tie-break relies on the reader noticing that `winner !== null` is guaranteed once
`best > 0`. A one-line comment would save a future reader the trip through the loop.

## Rulings made during execution

Fifteen decisions were taken on the human's behalf; the full text of each, with its reasoning and
what it costs if wrong, is in `.claude-ship-state.json` under the `implementation` phase-log entry.
The ones that changed shipped code are the four defects above. Three deserve explicit mention here:

- **`submitCreate`'s guard omits `writingRef`** while its two sibling handlers check both flags.
  Deliberately *not* changed: no defect was demonstrated, the asymmetry is documented, and adding
  the check would make a create during a confirm write silently no-op — strictly worse than two
  messages rendering together. The whole-branch reviewer, seeing all three handlers at once,
  independently confirmed this.
- **The plan contradicts itself** on where `resolvedByHand`/`createdInvisible` are cleared: its
  self-review says Task 8, its Task 9 text repeats the edit. `noUnusedLocals` settles it — Task 8
  cannot pass its own type-check gate without the clearing, so Task 9 was forbidden from re-adding it.
- **Two rulings were corrected mid-flight**, both mine: one under-specified a fixture fix to a single
  render site when the file had twelve, and one told a task to verify the clearing was *present*
  rather than where it was *placed*. In both cases a correct implementer stopped precisely at the
  edge of the instruction and reported the gap rather than silently widening scope.

## Next step

**A human merges PR #54.** The conductor does not merge.
