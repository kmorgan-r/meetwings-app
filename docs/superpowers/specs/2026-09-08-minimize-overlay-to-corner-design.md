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

- **`minimize_overlay(window, width: u32, height: u32)`** - reads
  `outer_position()` and `outer_size()` and stores them in `saved`, converts
  the logical pill dimensions to physical via `window.scale_factor()`, sets
  the size, then sets the position. Resize must happen before positioning
  because the corner x coordinate depends on the new width.
- **`restore_overlay(window)`** - takes the saved rect and applies size then
  position. If `saved` is `None`, falls back to a 600x54 logical size plus
  `position_window_top_center(&window, TOP_OFFSET)`.

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

### Frontend state: `src/lib/overlay-minimize.store.ts`

A module-level flag with a listener set, exposing `getMinimized()`,
`setMinimized(value)`, and `subscribe(callback)`.

It lives outside React because the `MutationObserver` callback in
`useWindow.ts` has no render scope and cannot read a hook or a context. React
consumers read it through `useSyncExternalStore(subscribe, getMinimized)`.

### The gate: `src/hooks/useWindow.ts`

```ts
const resizeWindow = useCallback(async (expanded: boolean) => {
  if (getMinimized()) return;
  // ...existing body unchanged
}, []);
```

One line, at the single choke point. It must gate both `expanded` values:
`resizeWindow(false)` is the stomp, and `resizeWindow(true)` would silently
un-minimize the window when a popover opens.

### Components

**`src/pages/app/components/MinimizedPill.tsx`** - renders the variant named
by the current setting. The whole pill surface is the expand click target;
clicking invokes `restore_overlay` and calls `setMinimized(false)`.

The pill carries no `data-tauri-drag-region`. A drag region covering the
click target makes the expand click unreliable, and dragging remains an
expanded-overlay affordance via the existing `DragButton`.

**`src/pages/app/index.tsx`** - subscribes to the store; when minimized it
renders `MinimizedPill` in place of the `Card` body. A minimize button is
added to the overlay bar next to `DragButton`; it invokes `minimize_overlay`
with the dimensions of the current style, then `setMinimized(true)`.

### Pill styles

| Style key | Content | Logical size |
|---|---|---|
| `status-count` (default) | Status dot, segment count, expand chevron | 148 x 40 |
| `icon-only` | Wing icon plus status dot | 52 x 52 |
| `status-last-line` | Status dot plus the latest transcript line, truncated | 320 x 48 |

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
with the new style's dimensions so the pill resizes in place.

## Edge cases

1. **Hidden versus minimized.** `isHidden` (the Windows
   `toggle-window-visibility` shortcut) only adds `hidden pointer-events-none`
   to a wrapper div; it never touches window geometry. The two states are
   orthogonal and need no ordering logic. Hiding while minimized leaves a
   148x40 invisible window in the corner; unhiding brings the pill back.
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
- `overlay-minimize.store.test.ts` - get, set, subscribe, unsubscribe.
- `useWindow.minimize-gate.test.ts` - `resizeWindow(true)` and
  `resizeWindow(false)` both no-op while minimized, and both resume once it
  is cleared.
- `minimized-pill.test.tsx` - all three variants render; clicking invokes
  `restore_overlay`.
- `settings-page.overlay-pill.test.tsx` - the selector renders, writes
  storage, and emits `overlay-pill-style-changed`.

Rust `#[test]` on `bottom_right_position`: a plain work area, one with a
taskbar inset, and one with a negative origin (a monitor positioned to the
left of the primary).

**Manual gate.** `npm run tauri dev`, start capture, minimize. Arriving
transcript segments are exactly the continuous DOM mutation that drives the
`MutationObserver`. A pill that survives 30 seconds of active transcription
without snapping back to a 600px bar confirms the gate holds.
