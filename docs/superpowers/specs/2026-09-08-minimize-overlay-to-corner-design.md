# Minimize Overlay to Corner

**Date:** 2026-09-08
**Status:** Approved, ready for implementation plan

## Problem

The main overlay window sits at the top center of the screen (600x54, growing
to 600x600 when the transcript panel or an AI response is showing). During a
meeting the expanded transcript covers the middle of the screen, which is
exactly where the meeting itself is. Users need a way to push it out of the
way without stopping capture, and bring it back with one click.

## Solution

A minimized mode for the `main` overlay window: the whole overlay - control
bar and transcript together - shrinks to a small pill anchored at the bottom
right of the current monitor. Clicking the pill restores the overlay to its
exact pre-minimize size and position.

One window throughout. The transcript is React state inside `useCompletion`,
which does not cross webviews, so splitting the transcript into its own Tauri
window would require an emit/listen bridge and a second entry in the
content-protection window list. Shrinking the single existing window avoids
all of that.

### Decisions taken

| Question | Decision |
|---|---|
| What moves? | The whole overlay, as one window |
| Pill content | User setting, three styles, default "status + count" |
| Expand target | Restores to the pre-minimize position, not the corner |
| Trigger | A minimize button in the overlay bar. No shortcut, no auto-minimize |
| Geometry owner | Rust, in a managed `Mutex` state |
| Persist across restart | No. App always starts un-minimized |

Rejected as YAGNI: global shortcut, auto-minimize on capture start,
auto-minimize on idle. Each can be added later on top of the same commands.

## Architecture

### The blocker this design exists to work around

`src/hooks/useWindow.ts:56-66` runs a `MutationObserver` over `document.body`
that calls `resizeWindow(false)` - height 54, width 600 - on **any** DOM
mutation when no Radix popover is open. Arriving transcript segments mutate
the DOM continuously, so without a gate the pill is yanked back to a 600px bar
within milliseconds of being minimized.

Three other call sites also drive the window size:

- `src/hooks/useCompletion.ts:1960`
- `src/hooks/useSystemAudio.ts:757`
- `src/components/updater/index.tsx:128`

All four go through the single `resizeWindow` callback, so one early-return
inside it covers every path.

### Rust: `src-tauri/src/window.rs`

```rust
pub struct OverlayMinimizeState {
    /// Physical (x, y, width, height) captured immediately before minimizing.
    pub saved: Mutex<Option<(i32, i32, u32, u32)>>,
}
```

Registered with `.manage()` in `src-tauri/src/lib.rs` alongside
`ContentProtectionState`.

Two commands, both added to the `invoke_handler` list:

- **`minimize_overlay(window, width: u32, height: u32, restyle: bool)`** -
  when `restyle` is true this is a restyle of an already-minimized
  pill: it resizes and repositions with the new dimensions and returns
  WITHOUT touching `saved` (see "Cross-window propagation"). Otherwise
  it reads `outer_position()` and `outer_size()` - both must succeed
  before anything is committed - stores them in `saved`, converts the
  logical pill dimensions to physical via `window.scale_factor()`, sets
  the size, then sets the position. Resize must happen before positioning
  because the corner x coordinate depends on the new width. The restyle
  distinction MUST be a parameter, not derived from `saved` being
  `Some`: restore deliberately keeps `saved` (see below), so after one
  minimize/restore cycle `saved` is permanently `Some`, and a Rust-side
  "already saved means restyle" rule would silently turn every later
  genuine minimize into a restyle that never re-snapshots - restore
  would then return the overlay to the FIRST cycle's pre-minimize rect,
  not the current one. The frontend, which owns `getMinimized()`, is
  the only side that knows which invoke is which.
- **`restore_overlay(window)`** - takes the saved rect and applies size then
  position. `saved` is deliberately NOT cleared by restore: restoring is
  idempotent (a double-click on the pill must not fall through to the
  fallback on the second invoke), and the next genuine minimize
  (a `restyle: false` invoke) takes a fresh snapshot anyway. If
  `saved` is `None`, falls back to a 600x54
  logical size plus top-center placement - computed with the same
  `current_monitor()` sensitivity as the pill itself, NOT via
  `position_window_top_center`, whose `primary_monitor()` would teleport a
  second-monitor user's overlay to the primary screen on the fallback path.

Corner math is extracted as a free function so it can be unit tested without
a live window:

```rust
fn bottom_right_position(
    work_area: &PhysicalRect<i32, u32>,
    width: u32,
    height: u32,
    margin: i32,
) -> (i32, i32)
```

It uses `window.current_monitor()`, not `primary_monitor()`. The existing
`position_window_top_center` uses `primary_monitor()`, which would drop the
pill on the wrong screen whenever the user has dragged the overlay to a
second monitor. It reads `monitor.work_area()`, not `monitor.size()`, so the
pill sits above the Windows taskbar rather than under it. `work_area()` is
available in tauri 2.8.2 (`tauri/src/window/mod.rs:98`).

Margin from the work-area edges: 16 physical px.

`current_monitor()` returns `Option` and can be `None` (monitor disconnect).
`minimize_overlay` falls back to `primary_monitor()`; if that is `None` too,
it returns `Err`, the frontend catch leaves the overlay un-minimized (see
"Components"), and nothing is committed.

A geometry-write failure needs the same care, one step later: if `set_size`
or `set_position` fails AFTER `saved` was committed and one write landed,
`minimize_overlay` re-applies the saved rect before returning `Err` - a
half-pill-sized window with the frontend flag rolled back would render the
full `Card` inside a pill-sized window, the exact hazard the restore-catch
rationale in "Components" names. If the rollback write itself fails, the
error still propagates and the frontend catch surfaces it; the window may be
mis-sized but `saved` remains accurate, so the next restore self-heals.

### Frontend state: `src/lib/overlay-minimize.store.ts`

A module-level flag with a listener set, exposing `getMinimized()`,
`setMinimized(value)`, and `subscribe(callback)`.

It lives outside React because the `MutationObserver` callback in
`useWindow.ts` has no render scope and cannot read a hook or a context. React
consumers read it through `useSyncExternalStore(subscribe, getMinimized)`.

`getMinimized()` returns a boolean, which has no snapshot-stability hazard.
The pill-data getter (see "Pill data source") does not have that luxury:
its `useSyncExternalStore` snapshot must return the stored object
reference, replaced only by the writer - a getter that assembles a fresh
object per call never compares equal and loops React 19's snapshot check.
The stored-reference invariant is part of the store's contract.

### The gate: `src/hooks/useWindow.ts`

The resize body is hoisted to a module-level exported function (the
pill needs to call it without mounting a second observer - see "Restore
must re-derive the height"), and the gate line lives inside it:

```ts
// module scope in useWindow.ts
export const resizeWindow = async (expanded: boolean) => {
  if (getMinimized()) return;
  // ...existing body unchanged
};

// the existing hook becomes a thin wrapper; its callers are unchanged
export const useWindowResize = () => ({ resizeWindow });
```

One line, at the single choke point. It must gate both `expanded` values:
`resizeWindow(false)` is the stomp, and `resizeWindow(true)` would silently
un-minimize the window when a popover opens. The gate must sit in the
module function, not the hook wrapper - the pill calls the module function
directly, and a gate left in a hook-scoped `useCallback` body would let
that call bypass it.

#### Restore must re-derive the height, not replay the snapshot

The saved rect is a snapshot taken at minimize time, and the gate means the
window's height stops tracking reality while minimized. If the first
transcript segment arrives *after* minimizing, the popover opens, the gated
`resizeWindow(true)` is dropped, and replaying the snapshot restores a 600x54
bar with a 600x600 popover clipped inside it.

Nothing self-heals this. The `useCompletion.ts:1960` effect is driven purely
by boolean flags (`isPopoverOpen`, `micOpen`, `messageHistoryOpen`,
`isFilesPopoverOpen`, `isContactPickerOpen`) that do not change on restore, so
it will not re-fire; `useOdooTarget.ts:200` confirms it is the sole
`resizeWindow(true)` caller. The `MutationObserver` only ever calls `(false)`.

So restore is: `restore_overlay()`, then `setMinimized(false)` to clear the
gate, then `resizeWindow(isAnyPopoverOpen())`. `isAnyPopoverOpen` is already
module-level in `useWindow.ts` and needs exporting. The final height then
reflects the current popover state rather than the state at minimize time.

The third step needs an owner, and the obvious one is a trap: the pill is a
sibling of the `Card`, so it has no `resizeWindow` - and calling
`useWindowResize()` inside the pill would mount a SECOND
`MutationObserver` plus a second pair of document drag listeners
alongside the instance `useCompletion` already owns. Instead, the
`resizeWindow` body moves to a module-level exported function in
`useWindow.ts` (it closes over nothing but `isAnyPopoverOpen`, the store
gate, and Tauri APIs), `useWindowResize` becomes a thin wrapper returning
it, and the pill's click handler imports and calls it directly. The gate
ordering matters on both flows and is pinned: the pill click awaits
`restore_overlay()` BEFORE `setMinimized(false)`, so the gate stays
closed while the window is still pill-sized; the minimize button is the
mirror image (see "Components").

### Components

**`src/pages/app/components/MinimizedPill.tsx`** - renders the variant named
by the current setting. The whole pill surface is the expand click target;
clicking runs the full restore sequence in order, and the order is
load-bearing: `await invoke("restore_overlay")` FIRST (the gate is still
closed while the window is pill-sized, so no `resizeWindow` can race the
geometry), then `setMinimized(false)` to clear the gate, then the
module-level `resizeWindow(isAnyPopoverOpen())` from `useWindow.ts`. The
invoke is wrapped in try/catch matching the `useWindow.ts` convention: on
rejection the flag is NOT cleared, the pill stays, and the error is logged -
clearing the flag after a failed restore would render the full `Card`
inside a pill-sized window.

The pill carries no `data-tauri-drag-region`. A drag region covering the
click target makes the expand click unreliable, and dragging remains an
expanded-overlay affordance via the existing `DragButton`.

**`src/pages/app/index.tsx`** - subscribes to the store; when minimized it
hides the existing `Card` tree and renders `MinimizedPill` as a sibling. A
minimize button is added to the overlay bar next to `DragButton`. Its
handler is the mirror image of the pill's: `setMinimized(true)`
SYNCHRONOUSLY first - closing the gate before the async invoke closes the
window in which a transcript arrival could fire the `MutationObserver`'s
`resizeWindow(false)` and race the pill geometry - then
`await invoke("minimize_overlay", ...)` with the dimensions of the current
style, and in the catch, `setMinimized(false)` to roll the flag back so a
failed minimize cannot leave a pill rendered inside an un-minimized window.
Setting the flag before the invoke is harmless: the pill renders from
React state, and one paint of the pill in a still-600px window beats one
paint of the full bar in a pill-sized one.

#### Hide, do not swap

The overlay content must stay mounted while minimized. `useCompletion()` is
called at `src/pages/app/components/completion/index.tsx:28`, inside the
`Completion` component, inside the `Card`. Rendering the pill *in place of*
that subtree would unmount the hook and destroy `meetingTranscript`, the
current conversation, and the popover's open state and scroll position mid
meeting - and would re-run every effect in a 2400-line hook on restore.
`useWindow.ts`'s owner (`useCompletion.ts:176`) would unmount with it.

So minimizing is a visibility change, like the existing `isHidden` path in
`src/pages/app/index.tsx:47-49`. The layout in `app/index.tsx` becomes three
nested levels, and the nesting is what keeps the two states from colliding:

```
<div className={isHidden ? "hidden pointer-events-none" : ""}>   // unchanged
  <div className={minimized ? "hidden" : ""}>
    <Card>...</Card>                                             // stays mounted
  </div>
  {minimized && <MinimizedPill />}
</div>
```

`isHidden` is the outer wrapper, so hiding the app hides the pill too, which
is what the shortcut means. The minimized wrapper is inner, so it hides the
`Card` without touching the pill. Nothing unmounts either way.

The Radix portal needs one extra rule. `PopoverContent` is portaled to
`document.body`, outside both wrappers, so hiding the wrapper leaves an
expanded popover on screen. The store therefore also sets
`data-overlay-minimized` on `document.body`, and `src/global.css` hides
`[data-radix-popper-content-wrapper]` while it is present.
`src/hooks/useApp.ts:66-85` already fights this same portal imperatively for
`isHidden`; the CSS rule is the cleaner equivalent. Writing that attribute
does not retrigger the `MutationObserver` loop, whose `attributeFilter` is
`["data-state"]`.

The two paths deliberately take OPPOSITE policies toward
popover-open-while-hidden, and this is stated so it cannot read as an
omission: `isHidden` forcibly closes the popover (it means "the app is
invisible, leave nothing running"); minimize only hides it, because the
stale-rect fix above depends on the popover being able to open while
minimized - `resizeWindow(isAnyPopoverOpen())` at restore must see it. The
`onOpenChange` side effects are benign here: `Input.tsx`'s `reset()` fires
only on close-with-no-content, the same as when expanded, and the popover
being CSS-hidden does not affect Radix's open state bookkeeping. The
manual gate below covers a popover opening while minimized.

#### Pill data source

The pill's `status-count` variant needs the segment count and
`status-last-line` needs the latest transcript line. Both live in
`meetingTranscript` inside `useCompletion`, which `app/index.tsx` cannot see -
it receives only `systemAudio`.

Since the layout above requires the pill to be a sibling of the `Card` rather
than a descendant of it, the data is pushed up instead: `Completion`
(`completion/index.tsx`, which already holds `completion`) writes
`{ segmentCount, lastLine, status, recording }` into the same module store the
gate reads, in an effect keyed on `meetingTranscript`. `MinimizedPill` reads it
through `useSyncExternalStore`.

Four scalars, one-way, written from one place. The transcript itself is not
duplicated into the store.

The store also carries the pill's one OUTBOUND action, `toggleRecording`,
registered by `usePillRecordAction` (mounted from `Completion`) for the same
sibling reason: the record button starts and stops a meeting without
expanding first. `null` is the unregistered state, and the pill hides the
button rather than rendering a dead one.

### Pill styles

| Style key | Content | Logical size |
|---|---|---|
| `status-count` (default) | Status dot, segment count, expand chevron, record button | 180 x 40 |
| `icon-only` | Wing icon plus status dot, record button | 84 x 52 |
| `status-last-line` | Status dot plus the latest transcript line (truncated), record button | 352 x 48 |

### Settings

Follows commit `5c29f9a` (screen capture protection toggle) file for file:

- `src/lib/storage/customizable.storage.ts` - add `overlayPill: { style }` to
  `CustomizableState`, default `"status-count"` in
  `DEFAULT_CUSTOMIZABLE_STATE`, a fallback branch in `getCustomizableState`
  so state stored before this key exists still parses, and an
  `updateOverlayPillStyle` writer.
- `src/types/context.type.ts` - `setOverlayPillStyle`.
- `src/contexts/app.context.tsx` - `setOverlayPillStyle`, exposed on the
  context value.
- `src/pages/settings/components/OverlayPillStyleSelect.tsx`, exported from
  the components barrel and placed in `src/pages/settings/index.tsx` after
  `ContentProtectionToggle`.

Unlike content protection, this setting has no Rust side. It is pure
frontend state.

### Cross-window propagation

Settings renders in the `dashboard` window; the pill renders in `main`. Both
webviews share an origin and therefore share `localStorage`, but the `main`
window's React state will not re-read it on its own.

The selector emits `overlay-pill-style-changed` with the new style, the same
pattern `src/pages/settings/components/MeetingAutoRecordToggle.tsx:126` uses
for `meeting-detection-setting-changed`. The `main` window listens and
updates. If it is minimized at the time, it re-invokes `minimize_overlay`
with the new style's dimensions so the pill resizes in place. This restyle
invoke is exactly the case `minimize_overlay`'s conditional snapshot exists
for: at restyle time the window IS the pill, so the command must not
re-snapshot `outer_position()`/`outer_size()` - it would save the pill's own
corner geometry as the "pre-minimize" rect.

## Edge cases

1. **Hidden versus minimized.** `isHidden` (the Windows
   `toggle-window-visibility` shortcut) only adds `hidden pointer-events-none`
   to a wrapper div; it never touches window geometry. The two states are
   orthogonal and need no ordering logic. Hiding while minimized leaves a
   180x40 invisible window in the corner; unhiding brings the pill back. The
   nesting in "Hide, do not swap" is what produces this: `isHidden` wraps the
   pill, the minimized wrapper does not.
2. **Multi-monitor.** `current_monitor()` keeps the pill on whichever screen
   the overlay was already on.
3. **Taskbar.** `work_area()` keeps the pill clear of the Windows taskbar.
4. **DPI.** Save and restore in physical pixels; convert the logical pill
   dimensions through `scale_factor()`. Do not reuse `set_window_height`,
   which hardcodes a logical width of 600 - mixing logical and physical
   coordinates drifts on fractional-scale displays.
5. **`move_window` while minimized.** The arrow-key move shortcut still moves
   the pill. Restore returns to the saved pre-minimize rect regardless, not
   to wherever the pill was moved. Accepted.
6. **Restore with no saved rect** (hot reload, or `restore_overlay` reaching
   Rust first) falls back to 600x54 at top center.
7. **Restart while minimized.** `OverlayMinimizeState` is in-memory, so the
   app starts un-minimized. Intentional.
8. **Content protection.** The pill is the `main` window, already covered by
   `apply_content_protection`'s `["main", "dashboard"]` list. No change.

## Testing

Vitest, matching the existing files under `src/tests/`:

- `customizable.storage.test.ts` - extend with the `overlayPill` default and
  the fallback for state stored before the key existed.
- `overlay-minimize.store.test.ts` - get, set, subscribe, unsubscribe, and
  the pill-data writer.
- `useWindow.minimize-gate.test.ts` - `resizeWindow(true)` and
  `resizeWindow(false)` both no-op while minimized, and both resume once it
  is cleared. Plus the stale-rect regression: minimize, open a popover while
  minimized, restore, and assert the window ends at 600 rather than 54. Plus
  the ordering assertions: the minimize handler closes the gate before its
  invoke (a `resizeWindow` fired during the await is swallowed), and the
  restore handler does not clear the gate until its invoke resolves.
- `minimized-pill.test.tsx` - all three variants render; clicking invokes
  `restore_overlay` and only clears the flag once it resolves.
- `overlay-minimize-keeps-mounted.test.tsx` - the regression that motivates
  the whole "hide, do not swap" section: render the overlay with a non-empty
  `meetingTranscript`, minimize, restore, and assert the transcript is still
  there and `useCompletion`'s mount effects did not re-run. "Did not re-run"
  needs a concrete probe, not an eyeball: mock `@tauri-apps/api/core`,
  `@tauri-apps/api/webviewWindow`, `@tauri-apps/api/event`, and the sql/http
  plugins (the overlay mounts a 2400-line hook pulling all of them), then
  assert a mount-only side effect - e.g. the initial conversation DB load's
  invoke - is called exactly once across the minimize/restore cycle.
- `hidden-and-minimized.test.tsx` - pin edge case 1: with `isHidden` true
  and minimized true, the pill is invisible and not clickable; toggling
  `isHidden` back false brings the pill back clickable. No geometry invoke
  happens on either hide or unhide.
- `settings-page.overlay-pill.test.tsx` - the selector renders, writes
  storage, and emits `overlay-pill-style-changed`. Plus the `main`-window
  side of the same flow: with `listen("overlay-pill-style-changed")` mocked,
  minimized=true → `minimize_overlay` re-invoked with the new style's
  dimensions (all three style→dimension mappings); minimized=false → the
  event is a no-op, no geometry invoke.

Rust `#[test]` on `bottom_right_position`: a plain work area, one with a
taskbar inset, and one with a negative origin (a monitor positioned to the
left of the primary). Plus tests for the restore fallback: the fallback
rect (600x54 logical at top center of the given monitor's work area) is
extracted into a free function next to `bottom_right_position` and tested,
and `OverlayMinimizeState::default()` asserts `saved` starts `None` - the
guaranteed post-restart state that drives the fallback path.

**Manual gate.** `npm run tauri dev`, start capture, minimize. Arriving
transcript segments are exactly the continuous DOM mutation that drives the
`MutationObserver`. A pill that survives 30 seconds of active transcription
without snapping back to a 600px bar confirms the gate holds.
