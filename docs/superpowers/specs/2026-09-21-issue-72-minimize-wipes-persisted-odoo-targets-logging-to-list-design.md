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
| Regression test | Extend the keeps-mounted test with a real-`useOdooTarget` case; survival asserted via wipe spies + the hook's own in-memory count (no stateful sql mock exists — the action layer is what this repo's tests mock) |
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

The fix refuses the dismissal when the pointerdown lands on either minimize
control. This matches the documented minimize policy from the 2026-09-08
spec — "minimize only hides it" — under which a popover MAY stay open while
minimized (the portal is already CSS-hidden via the `data-overlay-minimized`
body rule, verified present at `src/global.css:196`:
`body[data-overlay-minimized="true"] [data-radix-popper-content-wrapper]`,
and restore re-shows it):

```tsx
<PopoverContent
  className="w-80 p-3 popover-opaque"
  onPointerDownOutside={(e) => {
    const t = e.detail.originalEvent.target as HTMLElement | null;
    if (t?.closest("[data-overlay-minimize-control]")) e.preventDefault();
  }}
  onFocusOutside={(e) => {
    // Same check: the click also moves focus, and Radix fires this as a
    // separate dismissal — preventing only the pointerdown one leaves the
    // focus dismissal to close the picker anyway.
    const t = e.detail.originalEvent.target as HTMLElement | null;
    if (t?.closest("[data-overlay-minimize-control]")) e.preventDefault();
  }}
>
```

- `data-overlay-minimize-control` is added to BOTH minimize surfaces: the
  Minimize button in the overlay bar (`src/pages/app/index.tsx`) AND the
  root of `MinimizedPill` (`src/pages/app/components/MinimizedPill.tsx`).
  The pill needs it as much as the button: with only the button marked, the
  restore click on the pill is itself a pointerdown outside the still-open
  (CSS-hidden) portal, so Radix dismisses the picker at RESTORE instead —
  `onOpenChange(false)` fires, and the same `!isPickerOpen` close effect
  wipes the proposal state one step later, reproducing the identical end
  state through a different door. Marking both is what makes the picker
  survive the full cycle, which is the policy the 2026-09-08 spec actually
  states.
- `preventDefault()` on a Radix dismissal keeps the popover open; the
  Minimize button still receives the click and still minimizes, and the
  pill's expand click still restores.
- Scoped to this one popover. The other popovers (mic, files, message
  history) have the same interact-outside interaction with the Minimize
  button, but their close wipes nothing — noted here so it cannot read as an
  oversight, and left alone.

### 4. The regression test (the issue's named requirement)

Extend `src/tests/overlay-minimize-keeps-mounted.test.tsx` with a third case.
The current file cannot assert survival — its `useOdooTarget` is a stub — so
the new case swaps the stub for the real hook.

**Verified ground for the scaffold.** The real hook mounts inside the REAL
`Completion` component (`src/pages/app/components/completion/index.tsx:51`
calls `useOdooTarget`), which this file deliberately keeps real while stubbing
its other children — so the `Input` stub (which hides the ContactPicker UI)
does NOT block the hook from mounting. What blocks it is the mock surface the
real hook's mount effect pulls in, which the current file does not carry.

- Scaffold: the `@/hooks` barrel doMock keeps its existing stub object with
  ONLY the `useOdooTarget` entry swapped for the real hook — NOT an
  `importOriginal` spread, which would un-stub every other hook the file
  deliberately stubs and drag their real import trees into a module-mock
  environment built for stubs. The hook's consumer path is Completion, so
  nothing else needs un-stubbing.
- The swap pulls in the real hook's own imports, and the file must add the
  doMocks for them, following the proven scaffold in
  `odoo-target-new-chat-entry-points.test.tsx` — which mocks the ACTION
  MODULE layer, not the sql plugin (there is no stateful plugin-sql mock
  anywhere in this repo's hook tests; `useOdooTarget.test.tsx` also mocks
  the action module via `vi.mock("@/lib/database/odoo-contacts.action",
  () => action)`):
  - `@/lib/database/odoo-contacts.action` — spies (`vi.fn`) over every
    export; `loadTargets` mock-resolves one seeded row (the "seed" is
    configuring the action mock, NOT calling `addSelectedTarget` against a
    real DB — no stateful sql mock exists to receive one).
  - `@/lib/odoo` — `importActual` of `@/lib/odoo/errors` plus
    `runSync`/`currentInstance`/`createOdooClient`/`fetchOpportunities` as
    `vi.fn` (the mount effect branches on `getCurrentWindow().label ===
    "main"` and calls `runSync`; without this mock the mount effect dies
    before `loadTargets` and the length-1 precondition is unreachable).
  - `@/lib/storage/odoo-config.storage`, `sonner`,
    `@tauri-apps/api/window` (label `"main"`) — the same trio the
    entry-points scaffold mocks.
- Mount App — the real hook's mount effect rehydrates through the mocked
  `loadTargets`, so `targets` starts at length 1 (this also asserts the
  rehydrate works inside the overlay tree).
- `setMinimized(true)` → `setMinimized(false)`.
- Assert, in this order of load-bearing-ness:
  1. **In-memory survival** (covers the UI-only-wipe candidate, which every
     DB-side assertion would miss): the stub's `setTargetCount` — the real
     hook pushes `targets.length` to it on every targets change
     (`useOdooTarget.ts:251-253`) — is last called with `1` after restore;
     and the `[odoo-targets] targets` console lines (spy `console.info`)
     contain no count-0 line inside the cycle window.
  2. **No wipe ops** — the action spies `clearTargets`,
     `removeSelectedTarget` AND `purgeOtherInstances` (the only wipe vector
     needing no user click — omitting it would leave the purge mechanism
     covered only by the manual gate) were never called during the cycle.
  3. **Instance stability** — the instance string in the action-layer spy
     calls is identical across the cycle.
  4. `completionMountSpy` still fired exactly once (App-mount variant only —
     see the fallback below).
  5. The mounted Minimize button carries `data-overlay-minimize-control` —
     the real button's attribute wiring, enforced here because the
     picker-dismiss test's button is a test-local stand-in (see the Testing
     section's control-provenance note).
- **Fallback, corrected.** If the real hook inside the full App graph proves
  too entangled, the fallback is the entry-points-SHAPE harness:
  `renderHook` mounting `useCompletion` (stub) and `useOdooTarget` (real)
  together — the shape `odoo-target-new-chat-entry-points.test.tsx` already
  uses — driven by the store's `setMinimized` around it. Its assertion set
  is NOT identical, and the design does not pretend it is: a bare
  `setMinimized` cycle fires NO trigger this hook listens for (its wipe
  paths are the `newConversationStarted` window listener and the
  `odoo-instance-changed` Tauri listener — neither reads the minimize
  store), so the bare cycle is a no-op CONTROL, not the mechanism test. The
  fallback drops `completionMountSpy` (it lives inside the useCompletion
  stub's effect and only fires under the App-mount variant), keeps
  assertions 1–3 as the control, and the mechanism test proper — whichever
  trigger the signature table names — fires that trigger around the cycle
  and asserts the fix suppresses the wipe. The scaffold choice is left to
  the plan; the trigger-firing requirement is not.

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
  open, clicking the Minimize control keeps it open (`isContactPickerOpen`
  stays true; `onOpenChange` is never called with `false`), and clicking the
  RESTORED pill likewise keeps it open. The automated assertion set is the
  OPEN-STATE survival only — `useCalendarProposal`'s `reset` is an internal
  callback of a hook this scaffold does not render a consumer for, so a
  "reset not fired" assertion would need an unstated module mock that then
  masks the very effect it claims to watch (the same vacuous-pass hazard the
  scaffold warning below describes); proposal-state survival stays with the
  manual gate, which covers it. Also pins the boundary: a pointerdown on
  anything else outside the picker still closes it — the `preventDefault` is
  scoped to `[data-overlay-minimize-control]`.
  **Control provenance.** The restore-click case renders the REAL
  `MinimizedPill` (a standalone component; its root must carry the marker
  attribute — that is the pass-1 restore-click regression, and rendering the
  real pill is what makes it an enforced assertion). The Minimize button is
  a test-local stand-in stamped with the same attribute — the real button
  lives inline in the overlay bar and this scaffold cannot mount
  `app/index.tsx` — so the real button's attribute WIRING is enforced
  instead by a cheap attribute-presence assertion in the keeps-mounted
  App-mount variant, where the real overlay bar is mounted.
  **Scaffold warning (this is a NEW scaffold, not a reused one).** There is
  no proven rendered-ContactPicker precedent to copy: both
  `odoo-target-new-chat-entry-points.test.tsx` and
  `odoo-target-create-contact.test.tsx` are `renderHook` harnesses that
  render no components, and the keeps-mounted file stubs `Input` to null and
  the Popover primitives to passthroughs — under either of those, a real
  Radix `onPointerDownOutside` can never fire and the test would pass
  vacuously while the fix's props are never exercised. So this test renders
  the REAL `ContactPicker` with the REAL `@/components` Popover primitives
  (the shadcn wrapper over `@radix-ui/react-popover`), stubbing only Tauri
  core/event/window, contexts, `sonner`, and the odoo surface (action spies
  + `@/lib/odoo` + `odoo-config.storage`). Two hazards to plan for: jsdom
  lacks `PointerEvent` and `Element.hasPointerCapture`, which Radix's
  DismissableLayer needs (standard test-setup polyfills); and the scaffold's
  own sanity check comes FIRST — assert that a pointerdown on a plain
  outside element CLOSES the picker, proving the dismissal machinery fires
  in jsdom at all, before the minimize-control case is allowed to assert
  anything.
- **Manual gate.** `npm run tauri dev`, configure Odoo, open the picker, add
  two targets, note "Logging to (2)", minimize, restore. The count is intact;
  `loadTargets` lines occur only at mount (exact count depends on the
  reload leg and the StrictMode double-mount in dev — do not read the count,
  read the WINDOW), and no `clearTargets`/`purgeOtherInstances` lines appear
  in the minimize→restore window. Repeat with the picker open during the
  minimize, then click the restored pill — the proposal state survives both
  clicks. If the mechanism reproduces, the log names it before any fix is
  written.