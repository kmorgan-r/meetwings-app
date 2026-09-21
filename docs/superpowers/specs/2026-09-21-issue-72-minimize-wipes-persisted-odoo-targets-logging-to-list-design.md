# Minimize wipes persisted Odoo targets (Logging to list) — issue #72

**Date:** 2026-09-21
**Status:** Approved, ready for implementation plan
**Source:** GitHub issue #72 (bug, part of #71, reporter-confirmed)

## Problem

Restoring the overlay from its minimized pill loses the Odoo target list: the
"Logging to (N)" count is gone, and the reporter describes the *persisted*
target list itself as wiped — not just in-memory picker/proposal state.

What exploration already established, and what this design treats as ground:

- **Minimize is visibility-only.** The `Card` subtree is hidden, never
  unmounted (`src/pages/app/index.tsx:165`), and
  `src/tests/overlay-minimize-keeps-mounted.test.tsx` pins that a
  minimize/restore cycle re-runs zero mount effects. Nothing in the
  minimize/restore geometry code touches React state below the wrapper.
- **Targets are designed to survive minimize.** They live in SQLite
  (`odoo_selected_targets`, `src/lib/database/odoo-contacts.action.ts:279-341`)
  and rehydrate on mount (`src/hooks/useOdooTarget.ts:655-682`).
- **Every wipe dispatch found so far is an explicit user action.**
  `newConversationStarted` → `handleNewChat` → `clearTargets(instance)`
  (`src/hooks/useOdooTarget.ts:771-794`), dispatched from
  `src/hooks/useCompletion.ts:860` (clear-transcript) and `:1529`
  (start-new-conversation); `onClearTargets` fires only from the picker's
  "Clear all" confirm click (`src/pages/app/components/completion/ContactPicker.tsx:416`).
  No minimize-path dispatch was found.
- **One deletion path needs no user click:** `purgeOtherInstances`
  (`src/lib/database/odoo-contacts.action.ts:241`), called from `runSync`. It
  deletes rows for every instance OTHER than the one passed in — safe iff the
  resolved instance is both stable and correct. The `odoo-instance-changed`
  event's only emitter is the Odoo settings page
  (`src/pages/odoo/index.tsx:111`), so a settings-driven instance switch is
  rejected as the minimize-path trigger — but a *value* drift (e.g.
  `currentInstance()` normalizing differently on a later resolve) would make
  purge/load target the wrong key, and that is exactly what instance-key
  logging verifies.
- **A separate, real, insufficient defect:** the Minimize button click is a
  Radix interact-outside dismissal for an open ContactPicker, whose close
  effect wipes calendar-proposal state
  (`src/hooks/useCalendarProposal.ts:448-456`, the `!isPickerOpen` branch's
  `reset()`).

So the mechanism is genuinely unknown. The issue is explicit about the order:
**instrumentation first, then fix the found mechanism** — never a guessed fix.

## Solution

Three steps in the issue's order, plus one scoped secondary fix:

1. Log the target DB operations — `loadTargets`, `addSelectedTarget`,
   `removeSelectedTarget`, `clearTargets`, `clearAllTargets`'s underlying
   `clearTargets` call, and `purgeOtherInstances` — each carrying the
   `instance` key.
2. Extend `src/tests/overlay-minimize-keeps-mounted.test.tsx` to assert the
   SQLite target list survives a minimize/restore cycle.
3. Fix the mechanism the logs reveal, selected by signature (table below),
   with a regression test reproducing it.
4. Independently, stop the Minimize button from dismissing an open
   ContactPicker (the confirmed interact-outside wipe of calendar-proposal
   state).

### Decisions taken

| Question | Decision |
|---|---|
| First step | Instrumentation at the action-module choke point, not a named fix |
| Where the logs live | `odoo-contacts.action.ts` — every wipe already funnels through it |
| Caller attribution | Short captured stack in each log line; no signature changes |
| UI-side visibility | One effect-based count log in `useOdooTarget` — makes a UI-only wipe diagnosable in one round |
| Log permanence | Kept permanently, `[odoo-targets]` prefix — ops fire at user frequency, and a future reporter can paste them |
| Regression test | Extend the keeps-mounted test with a real-`useOdooTarget` case against the mocked sql plugin |
| Fix selection | By log signature per the candidate table; each fix ships with a test reproducing its mechanism |
| Interact-outside defect | In scope, secondary — same click, damage confirmed by code reading |

## Architecture

### 1. Instrumentation

The choke point is `odoo-contacts.action.ts`, not the hook: `clearTargets` is
called by BOTH `handleNewChat` (the `newConversationStarted` listener) and
`clearAllTargets` (`useOdooTarget.ts:1209-1214` funnels through it), so one
log site covers four of the issue's named operations; `purgeOtherInstances`
is the one deletion no user action drives. Logging there catches any future
caller too — including whichever one the bug turns out to be.

```ts
// odoo-contacts.action.ts
/**
 * Frames 2-5 of the captured stack: the immediate caller chain. Enough to
 * tell handleNewChat from clearAllTargets from purgeOtherInstances' runSync
 * caller without threading an origin parameter through every call site
 * (signature changes would touch every hook and test that calls these).
 */
const logTargetOp = (
  op: string,
  instance: string | null,
  detail: Record<string, unknown> = {}
) => {
  const stack = (new Error().stack ?? "").split("\n").slice(2, 6).join(" <- ");
  console.info("[odoo-targets]", op, { instance, ...detail, stack });
};
```

Each op logs before its DB round trip and its outcome after — a failed wipe
must still be visible:

- `loadTargets` — instance, returned row count.
- `addSelectedTarget` — instance, model/resId, the `{ ok, reason }` result
  (the cap rejection is as interesting as a write).
- `removeSelectedTarget` — instance, model/resId.
- `clearTargets` — instance; outcome (or the error) after.
- `purgeOtherInstances` — instance and the `execute` result's `rowsAffected`.
  The row count comes from the DELETE result — no new SELECT is added to
  derive it.

The one hook-side line. A UI-only wipe (in-memory list emptied with zero DB
writes — candidate D below) is invisible at the action layer; without this
line it takes a second instrumentation round to diagnose. It must be
effect-based, not logged inside `applyTargets`'s `setTargets` updater —
updaters run during render and twice under StrictMode, and a side effect
there is exactly the impurity StrictMode punishes:

```ts
// useOdooTarget.ts — a dedicated effect, next to the rehydrate mount effect
useEffect(() => {
  console.info("[odoo-targets]", "targets", { count: targets.length });
}, [targets]);
```

`instance` stability is read straight off these lines: every op prints the
resolved instance, `instanceRef` caches the first resolve
(`useOdooTarget.ts:418-423`), and only `handleInstanceChanged` resets it — so
two different instance strings in one session means drift, and the lines say
which op saw which value.

### 2. The signature table — how the fix is chosen

Reproduction is five seconds: configure Odoo, open the picker, add a target,
minimize, restore, with the devtools console open. The log window around
`setMinimized(true)` → restore decides the fix:

| Log signature | Mechanism | Fix shape |
|---|---|---|
| `clearTargets` (or `removeSelectedTarget`) fires during the cycle; stack → `handleNewChat` | a `newConversationStarted` dispatch fires on the minimize path — the exploration's "all explicit" audit predates the pill: `usePillRecordAction`, auto-record, or meeting-detection paths may call `startNewConversation`/`clearMeetingTranscript` | make the caller not fire on the minimize path (or the minimize button not trigger it); regression test reproduces that caller's trigger |
| wipe fires; stack → `clearAllTargets` | something drives the picker's Clear-all confirm programmatically | find the driver; guard the confirm |
| `purgeOtherInstances` fires with the CURRENT instance's rows deleted | instance drift — a later `currentInstance()` resolve returned a differently-normalized string, so "other instances" matched the real one | fix the resolve/normalization; pin `instanceRef` semantics |
| `targets` effect drops to 0 with NO DB op in the window | UI-only wipe — in-memory cleared, SQLite intact. The report's "persisted list is wiped" inference came from the count being gone after restore, not from an app restart; rows would come back on next mount | fix the in-memory wiper (likely the same event chain as row 1, minus the DB leg) |
| mount-effect `loadTargets` re-runs mid-cycle, and the keeps-mounted probe (`completionMountSpy`) re-fires | a real remount the current keeps-mounted test somehow misses (ErrorBoundary reset, route change) | fix the unmount path; the probe catches it |
| nothing fires, rows intact, count restored | cannot reproduce in this build | the permanent `[odoo-targets]` logs ARE the deliverable — ask the reporter for their console around a recurrence |

The fix is whichever mechanism the logs name; it is implemented only after the
mechanism is reproduced in a failing test (TDD order holds for it too — the
mechanism test is written first, the fix second).

### 3. Secondary fix: the Minimize button must not dismiss the picker

Confirmed by code reading, independent of the unknown mechanism: the Minimize
button sits in the bar, outside `ContactPicker`'s `PopoverContent`. Radix
dismisses on pointerdown outside the layer, and the dismissal wins the race —
the picker's `onOpenChange(false)` runs before the button's own onClick. The
close effect in `useCalendarProposal.ts:448-456` (`!isPickerOpen` branch)
then calls `reset()`, wiping calendar-proposal state. Even if it cannot
explain the DB wipe, minimize currently destroys the proposal the user was
about to confirm.

The fix refuses the dismissal when the pointerdown lands on the minimize
control. This matches the documented minimize policy from the 2026-09-08
spec — "minimize only hides it" — under which a popover MAY stay open while
minimized (the portal is already CSS-hidden via the `data-overlay-minimized`
body rule, and restore re-shows it):

```tsx
<PopoverContent
  className="w-80 p-3 popover-opaque"
  onPointerDownOutside={(e) => {
    const t = e.detail.originalEvent.target as HTMLElement | null;
    if (t?.closest("[data-minimize-button]")) e.preventDefault();
  }}
  onFocusOutside={(e) => {
    // Same check: the click also moves focus, and Radix fires this as a
    // separate dismissal — preventing only the pointerdown one leaves the
    // focus dismissal to close the picker anyway.
    const t = e.detail.originalEvent.target as HTMLElement | null;
    if (t?.closest("[data-minimize-button]")) e.preventDefault();
  }}
>
```

- `data-minimize-button` is added to the Minimize button in the overlay bar
  (`src/pages/app/index.tsx`). Not on the pill — the pill is a sibling of the
  `Card` and exists only while minimized, when the picker surface is already
  hidden.
- `preventDefault()` on a Radix dismissal keeps the popover open; the
  Minimize button still receives the click and still minimizes.
- Scoped to this one popover. The other popovers (mic, files, message
  history) have the same interact-outside interaction with the Minimize
  button, but their close wipes nothing — noted here so it cannot read as an
  oversight, and left alone.

### 4. The regression test (the issue's named requirement)

Extend `src/tests/overlay-minimize-keeps-mounted.test.tsx` with a third case.
The current file cannot assert SQLite survival — its `useOdooTarget` is a
stub — so the new case swaps the stub for the real hook:

- Scaffold: reuse `useOdooTarget.test.tsx`'s proven plugin-sql/window/event
  mock scaffold. `vi.doMock("@/hooks", ...)` keeps the real `useOdooTarget`
  (importOriginal spread) and overrides only `useCompletion` exactly as the
  file already does; the action module is wrapped in a doMock that spies its
  exports over the actual implementations.
- Seed one row via `addSelectedTarget` against the mocked DB before render.
- Mount App — the real hook's mount effect rehydrates, so targets starts at
  length 1 (this also asserts the rehydrate itself works inside the overlay
  tree).
- `setMinimized(true)` → `setMinimized(false)`.
- Assert: the wipe spies (`clearTargets`, `removeSelectedTarget`) were never
  called; `loadTargets(instance)` still returns the row after the cycle; the
  instance string in the action-layer spy calls is identical across the
  cycle; `completionMountSpy` still fired exactly once.

Named fallback: if the real hook inside the full App graph proves too
entangled with the stubs this file already carries (the real hook pulls the
odoo API surface and `getCurrentWindow`), mount a minimal harness component
calling `useOdooTarget` directly — the shape `useOdooTarget.test.tsx` already
uses — and drive the store's `setMinimized` around it. The assertion set is
identical; the scaffold choice is left to the plan so it cannot stall the
case.

## Edge cases

1. **StrictMode double-mount** logs `loadTargets` twice — the second log is
   the remount, not a defect. Do not dedupe; the log's job is to make
   remounts visible, and one of the candidate mechanisms IS a remount.
2. **keepEngaged double dispatch** — the keepEngaged close button awaits
   `startNewConversation` then `clearMeetingTranscript`, dispatching
   `newConversationStarted` twice; two `clearTargets` lines appear. Already
   documented as safe (`src/hooks/useCompletion.ts:853-859`); expected in the
   log.
3. **Failed wipe** — every op logs before its DB call and its outcome after,
   so a rejected `clearTargets` (e.g. database locked) is still on the record.
4. **Log volume** — ops fire at user frequency; the `targets` effect adds one
   line per committed targets change. Negligible, and permanent by decision:
   a future reporter paste replaces a fresh investigation.
5. **purgeOtherInstances row count** — taken from the DELETE's
   `rowsAffected`; the instrumentation adds no SELECT.
6. **Instance drift shape** — `instanceRef` caches the first resolve and only
   `handleInstanceChanged` clears it; two different instance strings within
   one session localize the drift to the resolve path, not the event path.
7. **If the mechanism IS the dismissal** — exploration says the picker-close
   effect wipes only calendar-proposal state, but if the fix phase finds a
   target wipe downstream of it, the secondary fix's
   `preventDefault()` changes the picker's open state on the minimize path
   and the mechanism test must be written against the pre-fix behavior
   before the interact-outside change lands.

## Testing

- `src/tests/odoo-contacts.action.test.ts` — extend: each op emits its
  `[odoo-targets]` line carrying the `instance` key (spy `console.info`);
  `purgeOtherInstances` logs instance + rowsAffected; a rejected
  `addSelectedTarget` (cap) logs `ok: false`.
- `src/tests/useOdooTarget.test.tsx` — extend: the `targets` effect logs the
  count transitions, and `handleNewChat`'s wipe sequence
  (applyTargets → clearTargets) is visible in the log lines.
- `src/tests/overlay-minimize-keeps-mounted.test.tsx` — third case as
  specified in "The regression test" above.
- New `src/tests/overlay-minimize-picker-dismiss.test.tsx` — with the picker
  open and a calendar proposal present, clicking the Minimize button keeps
  the picker open (`isContactPickerOpen` stays true) and does not fire
  `useCalendarProposal`'s reset (observable as no wipe of the proposal
  state / no refetch on restore). Also pins the boundary: a pointerdown on
  anything else outside the picker still closes it — the `preventDefault`
  is scoped to `[data-minimize-button]`. Follows the proven ContactPicker
  mount scaffold from `odoo-target-new-chat-entry-points.test.tsx`.
- **Manual gate.** `npm run tauri dev`, configure Odoo, open the picker, add
  two targets, note "Logging to (2)", minimize, restore. The count is intact
  and the console shows one mount-time `loadTargets` line and no
  `clearTargets`/`purgeOtherInstances` lines in the cycle window. Repeat with
  the picker open during the minimize — the proposal state survives. If the
  mechanism reproduces, the log names it before any fix is written.