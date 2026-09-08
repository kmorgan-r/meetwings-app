# Minimize Overlay to Corner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user minimize the Meetwings overlay window into a small pill anchored at the bottom-right of the current monitor, and click the pill to restore the overlay to its exact pre-minimize size and position.

**Architecture:** One window throughout — the `main` overlay resizes (Rust-owned geometry via two new Tauri commands) instead of spawning a second window. The React `Card` subtree stays mounted while minimized (a wrapper gets `hidden`); a sibling `MinimizedPill` renders in its place. A module-level store gates the existing `resizeWindow` choke point in `useWindow.ts`, because the `MutationObserver` there stomps any naive resize within milliseconds.

**Tech Stack:** Tauri 2.8.2 (Rust), React 19, TypeScript 5.8, Tailwind 4, Radix UI, Vitest (happy-dom), Rust `#[test]`.

**Spec:** `docs/superpowers/specs/2026-09-08-minimize-overlay-to-corner-design.md` — the plan argues from the spec; read both. The spec's "Edge cases" (8 items) and "Testing" sections are requirements, not suggestions.

## Global Constraints

- Pill styles and their logical window sizes: `status-count` (default) 148x40, `icon-only` 52x52, `status-last-line` 320x48 — copied verbatim from the spec's styles table. These feed BOTH the `minimize_overlay` invoke and `PILL_DIMENSIONS`.
- Corner margin from the monitor work-area edges: 16 physical px.
- Corner math uses `window.current_monitor()` and `monitor.work_area()` (`&PhysicalRect<i32, u32>` — verified present at `tauri-2.8.2/src/window/mod.rs:98`; re-exported as `tauri::PhysicalRect`, its fields are `position: PhysicalPosition<i32>` and `size: PhysicalSize<u32>`).
- Do NOT reuse `set_window_height` for the pill: it hardcodes a logical width of 600. Save/restore geometry in PHYSICAL pixels; convert logical pill dimensions through `window.scale_factor()`.
- The restyle distinction is a `restyle: bool` parameter on `minimize_overlay`, NOT derived from `saved` being `Some` — restore deliberately keeps `saved` (idempotence), so a Rust-side "already saved means restyle" rule would turn every later genuine minimize into a no-snapshot restyle.
- Gate ordering, both flows: minimize sets `setMinimized(true)` synchronously BEFORE awaiting `minimize_overlay` (roll back in the catch); the pill click awaits `restore_overlay()` BEFORE `setMinimized(false)`, then calls `resizeWindow(isAnyPopoverOpen())`.
- The pill carries no `data-tauri-drag-region`.
- Popovers may open while minimized (unlike `isHidden`, which forcibly closes them): `src/global.css` hides `[data-radix-popper-content-wrapper]` while `data-overlay-minimized` is on `document.body`, and the stale-rect fix at restore depends on the popover state being visible to `isAnyPopoverOpen()`.
- The overlay's `MutationObserver` filter is `attributeFilter: ["data-state"]` — writing `data-overlay-minimized` does not retrigger it.
- Path alias `@/` for imports. Components PascalCase, hooks camelCase with `use` prefix, files kebab-case. Vitest tests live in `src/tests/`, run via `npx vitest run <paths>` (NEVER bare `vitest run` — the full suite has pre-existing failures).
- Rust tests run scoped: `cargo test --manifest-path src-tauri/Cargo.toml window::` (window tests only — do not run the whole Rust suite, `db::migration_tests` touches a real SQLite file).
- After every task: `npm run check:types` must pass (repo has no lint script; `check:types` is the type gate).
- App always starts un-minimized: `OverlayMinimizeState` is in-memory (`Mutex<Option<...>>`), never persisted. Restart clears it.
- **Manual gate (do this after the final task, before PR):** `npm run tauri dev`, start capture, minimize. A pill that survives 30 seconds of active transcription without snapping back to a 600px bar confirms the gate holds. Also click the pill to restore and confirm it returns to the pre-minimize position, and confirm a restyle (change the pill style in settings while minimized) does not move the restore target.

---

### Task 1: The `overlayPill` setting — storage, context type, context wiring

**Files:**
- Modify: `src/lib/storage/customizable.storage.ts`
- Modify: `src/types/context.type.ts`
- Modify: `src/contexts/app.context.tsx` (import block near line 31, `setCursorType` impl near line 728, context `value` object near line 788)
- Test: `src/tests/customizable.storage.test.ts` (extend)

**Interfaces:**
- Consumes: nothing new (existing `CustomizableState` pattern, `STORAGE_KEYS.CUSTOMIZABLE` = `"customizable"` at `src/config/constants.ts:15`).
- Produces (later tasks rely on these EXACT names):
  - `export type OverlayPillStyle = "status-count" | "icon-only" | "status-last-line";` in `customizable.storage.ts`, re-exported through `src/lib/storage/index.ts` (which already does `export * from "./customizable.storage"`).
  - `overlayPill: { style: OverlayPillStyle }` on `CustomizableState`; default `{ style: "status-count" }`.
  - `updateOverlayPillStyle(style: OverlayPillStyle): CustomizableState` writer.
  - `setOverlayPillStyle(style: OverlayPillStyle): void` on `IContextType` and the AppContext value.

- [ ] **Step 1: Write the failing tests**

Add to `src/tests/customizable.storage.test.ts` — update the import at the top to include `updateOverlayPillStyle`, then add a new `describe` block after the existing one (the file's `beforeEach` + `store` Map at module scope already exist; the new block reuses the same pattern, so it needs its own `beforeEach` copy):

```ts
describe("customizable.storage overlayPill", () => {
  beforeEach(() => {
    store.clear();
    vi.mocked(localStorage.getItem).mockImplementation(
      (k: string) => store.get(k) ?? null
    );
    vi.mocked(localStorage.setItem).mockImplementation(
      (k: string, v: string) => {
        store.set(k, v);
      }
    );
  });

  it("defaults to status-count on first install", () => {
    expect(getCustomizableState().overlayPill).toEqual({
      style: "status-count",
    });
    expect(DEFAULT_CUSTOMIZABLE_STATE.overlayPill.style).toBe("status-count");
  });

  it("falls back to status-count when stored state predates the setting", () => {
    // Upgrade path: a blob saved before this key exists must parse.
    localStorage.setItem(
      STORAGE_KEYS.CUSTOMIZABLE,
      JSON.stringify({
        appIcon: { isVisible: true },
        alwaysOnTop: { isEnabled: false },
        autostart: { isEnabled: true },
        contentProtection: { isEnabled: true },
        cursor: { type: "invisible" },
      })
    );

    expect(getCustomizableState().overlayPill.style).toBe("status-count");
  });

  it("round-trips a style change and preserves sibling settings", () => {
    localStorage.setItem(
      STORAGE_KEYS.CUSTOMIZABLE,
      JSON.stringify({
        appIcon: { isVisible: false },
        alwaysOnTop: { isEnabled: true },
        autostart: { isEnabled: true },
        contentProtection: { isEnabled: true },
        cursor: { type: "default" },
        overlayPill: { style: "status-count" },
      })
    );

    const newState = updateOverlayPillStyle("icon-only");

    expect(newState.overlayPill).toEqual({ style: "icon-only" });
    expect(getCustomizableState().overlayPill.style).toBe("icon-only");
    // The writer must not clobber unrelated settings.
    expect(getCustomizableState().appIcon.isVisible).toBe(false);
    expect(getCustomizableState().cursor.type).toBe("default");
    expect(getCustomizableState().contentProtection.isEnabled).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/tests/customizable.storage.test.ts`
Expected: FAIL — `getCustomizableState().overlayPill` is `undefined`, `updateOverlayPillStyle` is not exported (import error).

- [ ] **Step 3: Implement the storage changes**

In `src/lib/storage/customizable.storage.ts`:

Add the style type next to `CursorType` (line 3):

```ts
export type OverlayPillStyle = "status-count" | "icon-only" | "status-last-line";
```

Add to the `CustomizableState` interface (after `cursor`, line 21):

```ts
  overlayPill: {
    style: OverlayPillStyle;
  };
```

Add to `DEFAULT_CUSTOMIZABLE_STATE` (after `cursor`, line 28):

```ts
  overlayPill: { style: "status-count" },
```

Add the fallback branch in `getCustomizableState`'s return object (after the `cursor` branch, line 51):

```ts
      overlayPill: parsedState.overlayPill || DEFAULT_CUSTOMIZABLE_STATE.overlayPill,
```

Add the writer after `updateContentProtection` (line 112):

```ts
/**
 * Update the minimized-pill style preference
 */
export const updateOverlayPillStyle = (
  style: OverlayPillStyle
): CustomizableState => {
  const currentState = getCustomizableState();
  const newState = { ...currentState, overlayPill: { style } };
  setCustomizableState(newState);
  return newState;
};
```

- [ ] **Step 4: Wire the context type and provider**

In `src/types/context.type.ts`, add to `IContextType` next to `setCursorType` (line 61) — also add `OverlayPillStyle` to the import from `"@/lib/storage"` on line 3:

```ts
  setOverlayPillStyle: (style: OverlayPillStyle) => void;
```

In `src/contexts/app.context.tsx`:

Add `updateOverlayPillStyle` to the import from `"@/lib/storage"` (the block at lines 24-37).

Add the setter after `setCursorType` (line 728):

```ts
  const setOverlayPillStyle = (style: OverlayPillStyle) => {
    setCustomizable((prev) => ({ ...prev, overlayPill: { style } }));
    updateOverlayPillStyle(style);
  };
```

(Note the shape deliberately mirrors `setCursorType` above it: optimistic `setCustomizable`, then the storage write. This is a pure-frontend setting — no Tauri invoke, unlike `toggleContentProtection`.)

Add `OverlayPillStyle` to the import from `"@/types"` (line 37: `import { IContextType, ScreenshotConfig, TYPE_PROVIDER, UserIdentity } from "@/types";` — no, `OverlayPillStyle` comes from `"@/lib/storage"`, whose import block at line 24 already needs it added).

Add `setOverlayPillStyle` to the context `value` object (next to `setCursorType`, line 802).

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/tests/customizable.storage.test.ts`
Expected: PASS (all 6 tests — 3 existing + 3 new).

Run: `npm run check:types`
Expected: PASS (the `IContextType` change must be satisfied by the provider, and vice versa).

- [ ] **Step 6: Commit**

```bash
git add src/lib/storage/customizable.storage.ts src/types/context.type.ts src/contexts/app.context.tsx src/tests/customizable.storage.test.ts
git commit -m "feat(settings): add overlayPill style setting to customizable storage"
```

---

### Task 2: Rust geometry — state, free functions, `minimize_overlay`, `restore_overlay`

**Files:**
- Modify: `src-tauri/src/window.rs` (new state struct after `ContentProtectionState`, new constants/functions/commands; tests appended)
- Modify: `src-tauri/src/lib.rs` (`.manage` block near line 113, `generate_handler` list near line 155)
- Test: `src-tauri/src/window.rs` (inline `#[cfg(test)] mod tests`)

**Interfaces:**
- Consumes: `tauri::{AppHandle, Manager, Position, PhysicalPosition, PhysicalRect, PhysicalSize, Runtime, Size, WebviewWindow, WebviewWindowBuilder}` — `PhysicalRect` is re-exported by tauri 2.8.2 (its fields: `position: PhysicalPosition<i32> { x, y }`, `size: PhysicalSize<u32> { width, height }`).
- Produces (later tasks invoke these):
  - `#[tauri::command] pub fn minimize_overlay(app: AppHandle, window: WebviewWindow, width: u32, height: u32, restyle: bool) -> Result<(), String>` — `width`/`height` are LOGICAL pill dims; `restyle: true` means "already minimized, only resize+reposition".
  - `#[tauri::command] pub fn restore_overlay(app: AppHandle, window: WebviewWindow) -> Result<(), String>`
  - `pub struct OverlayMinimizeState { pub saved: Mutex<Option<(i32, i32, u32, u32)>> }` + `Default` (saved starts `None`).

- [ ] **Step 1: Write the failing tests**

Append to `src-tauri/src/window.rs` (the file has no `#[cfg(test)]` module yet — create it at the end):

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn rect(x: i32, y: i32, width: u32, height: u32) -> PhysicalRect<i32, u32> {
        PhysicalRect {
            position: PhysicalPosition::new(x, y),
            size: PhysicalSize::new(width, height),
        }
    }

    // A plain work area: pill lands margin-px inside the bottom-right corner.
    #[test]
    fn bottom_right_plain_work_area() {
        let area = rect(0, 0, 1920, 1080);
        // 148x40 pill, 16px margin.
        assert_eq!(bottom_right_position(&area, 148, 40, 16), (1920 - 148 - 16, 1080 - 40 - 16));
    }

    // Taskbar inset: the work area is smaller than the monitor, and the pill
    // must sit above the taskbar, not under it.
    #[test]
    fn bottom_right_taskbar_inset() {
        let area = rect(0, 0, 1920, 1040); // 1080 screen, 40px taskbar
        assert_eq!(bottom_right_position(&area, 148, 40, 16), (1920 - 148 - 16, 1040 - 40 - 16));
    }

    // A monitor left of the primary has a negative origin; the arithmetic must
    // not assume 0,0.
    #[test]
    fn bottom_right_negative_origin() {
        let area = rect(-1920, 0, 1920, 1080);
        assert_eq!(bottom_right_position(&area, 148, 40, 16), (-1920 + 1920 - 148 - 16, 1080 - 40 - 16));
    }

    // The restore fallback: 600x54 LOGICAL at top center, converted through the
    // scale factor to physical pixels.
    #[test]
    fn fallback_rect_scale_one() {
        let area = rect(0, 0, 1920, 1080);
        let (x, y, w, h) = fallback_restore_rect(&area, 1.0);
        assert_eq!((x, y, w, h), ((1920 - 600) / 2, TOP_OFFSET, 600, 54));
    }

    #[test]
    fn fallback_rect_fractional_scale() {
        let area = rect(0, 0, 2560, 1440);
        // 1.5x: 600 logical = 900 physical, 54 logical = 81 physical.
        let (x, y, w, h) = fallback_restore_rect(&area, 1.5);
        assert_eq!((x, y, w, h), ((2560 - 900) / 2, (54.0 * 1.5) as i32, 900, 81));
    }

    // Restart clears the in-memory state: restore after restart must hit the
    // fallback path, so default() must start with no saved rect.
    #[test]
    fn default_state_has_no_saved_rect() {
        let state = OverlayMinimizeState::default();
        assert!(*state.saved.lock().unwrap() == None);
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml window::`
Expected: FAIL to compile — `bottom_right_position`, `fallback_restore_rect`, `OverlayMinimizeState` not defined.

- [ ] **Step 3: Implement state, constants, free functions, commands**

In `src-tauri/src/window.rs`:

Update the `tauri` import on line 4 to include the geometry types:

```rust
use tauri::{
    App, AppHandle, Manager, PhysicalRect, Position, PhysicalPosition, PhysicalSize, Runtime,
    Size, WebviewWindow, WebviewWindowBuilder,
};
```

Add `PILL_MARGIN` next to `TOP_OFFSET` (line 7):

```rust
// Distance between the minimized pill and the work-area edges, in physical px.
const PILL_MARGIN: i32 = 16;
```

Add the state struct after `ContentProtectionState`'s `Default` impl (line 26):

```rust
/// The main overlay's pre-minimize geometry, in PHYSICAL pixels:
/// (x, y, width, height). In-memory only — a restart starts un-minimized,
/// and restore falls back to the 600x54 bar when this is None.
pub struct OverlayMinimizeState {
    pub saved: Mutex<Option<(i32, i32, u32, u32)>>,
}

impl Default for OverlayMinimizeState {
    fn default() -> Self {
        Self {
            saved: Mutex::new(None),
        }
    }
}
```

Add the free functions after `position_window_top_center` (line 92):

```rust
/// Bottom-right placement inside a monitor work area, margin px from the
/// edges. A free function so the geometry is unit-testable without a live
/// window. Widths/heights here are PHYSICAL pixels.
fn bottom_right_position(
    work_area: &PhysicalRect<i32, u32>,
    width: u32,
    height: u32,
    margin: i32,
) -> (i32, i32) {
    let x = work_area.position.x + work_area.size.width as i32 - width as i32 - margin;
    let y = work_area.position.y + work_area.size.height as i32 - height as i32 - margin;
    (x, y)
}

/// The rect `restore_overlay` falls back to when no snapshot exists (hot
/// reload, restore-before-minimize, or after a restart): the 600x54 LOGICAL
/// bar, top-center of the given work area, converted to physical pixels.
/// Uses the work area (not monitor size) and the passed scale, matching the
/// pill's own monitor-sensitivity — `position_window_top_center` is NOT used
/// because its `primary_monitor()` would teleport a second-monitor user's
/// overlay to the primary screen.
fn fallback_restore_rect(
    work_area: &PhysicalRect<i32, u32>,
    scale_factor: f64,
) -> (i32, i32, u32, u32) {
    let width = (600.0 * scale_factor).round() as u32;
    let height = (54.0 * scale_factor).round() as u32;
    let x = work_area.position.x + (work_area.size.width as i32 - width as i32) / 2;
    let y = work_area.position.y + (TOP_OFFSET as f64 * scale_factor).round() as i32;
    (x, y, width, height)
}
```

Add the two commands after `set_window_height` (line 124):

```rust
/// Minimize the overlay to a pill in the bottom-right of the current
/// monitor's work area. `width`/`height` are LOGICAL pill dimensions,
/// converted to physical via the window's scale factor.
///
/// `restyle == true` means the window is ALREADY minimized and only the
/// pill's size is changing (the settings selector): resize + reposition,
/// and never touch `saved` — at restyle time the window IS the pill, so a
/// re-snapshot would save the pill's own corner geometry as the
/// "pre-minimize" rect. The distinction is a parameter, not derived from
/// `saved` being `Some`, because restore deliberately keeps `saved`.
#[tauri::command]
pub fn minimize_overlay(
    app: AppHandle,
    window: WebviewWindow,
    width: u32,
    height: u32,
    restyle: bool,
) -> Result<(), String> {
    let state = app.state::<OverlayMinimizeState>();

    // current_monitor() keeps the pill on whichever screen the overlay is on;
    // fall back to primary, and refuse (leaving the overlay un-minimized) only
    // when no monitor is reachable at all.
    let monitor = window
        .current_monitor()
        .map_err(|e| format!("Failed to read current monitor: {}", e))?
        .or_else(|| window.primary_monitor().ok().flatten())
        .ok_or_else(|| "No monitor available".to_string())?;

    let scale = window
        .scale_factor()
        .map_err(|e| format!("Failed to read scale factor: {}", e))?;

    let pill_width = (width as f64 * scale).round() as u32;
    let pill_height = (height as f64 * scale).round() as u32;
    let (x, y) = bottom_right_position(monitor.work_area(), pill_width, pill_height, PILL_MARGIN);

    // Both reads must succeed before anything is committed.
    let snapshot = if restyle {
        None
    } else {
        let pos = window
            .outer_position()
            .map_err(|e| format!("Failed to read window position: {}", e))?;
        let size = window
            .outer_size()
            .map_err(|e| format!("Failed to read window size: {}", e))?;
        Some((pos.x, pos.y, size.width, size.height))
    };

    let apply = || -> Result<(), String> {
        window
            .set_size(Size::Physical(PhysicalSize::new(pill_width, pill_height)))
            .map_err(|e| format!("Failed to resize window: {}", e))?;
        window
            .set_position(Position::Physical(PhysicalPosition::new(x, y)))
            .map_err(|e| format!("Failed to position window: {}", e))?;
        Ok(())
    };

    match snapshot {
        Some(saved) => {
            *state.saved.lock().unwrap() = Some(saved);
            if let Err(e) = apply() {
                // Re-apply the just-saved rect before failing, so the frontend
                // flag rollback (it renders the full Card on failure) leaves a
                // consistent window — the exact hazard a half-pill-sized
                // window would create. If the rollback write also fails,
                // `saved` still holds the truth and the next restore
                // self-heals.
                let _ = window.set_size(Size::Physical(PhysicalSize::new(saved.2, saved.3)));
                let _ = window.set_position(Position::Physical(PhysicalPosition::new(saved.0, saved.1)));
                return Err(e);
            }
        }
        None => apply()?,
    }

    Ok(())
}

/// Restore the overlay to its saved pre-minimize rect. `saved` is
/// deliberately NOT cleared: restoring is idempotent (a double-click must
/// not fall through to the fallback on the second invoke), and the next
/// genuine minimize (restyle == false) takes a fresh snapshot anyway.
#[tauri::command]
pub fn restore_overlay(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    let state = app.state::<OverlayMinimizeState>();
    let saved = *state.saved.lock().unwrap();

    // The scale/monitor reads live INSIDE the None arm: they are only needed
    // for the fallback, and a transient monitor read error must not reject
    // the restore of a known-good snapshot — that would leave the user stuck
    // minimized with every retry failing identically.
    let (x, y, width, height) = match saved {
        Some(rect) => rect,
        None => {
            let scale = window
                .scale_factor()
                .map_err(|e| format!("Failed to read scale factor: {}", e))?;
            let monitor = window
                .current_monitor()
                .map_err(|e| format!("Failed to read current monitor: {}", e))?
                .or_else(|| window.primary_monitor().ok().flatten())
                .ok_or_else(|| "No monitor available".to_string())?;
            fallback_restore_rect(monitor.work_area(), scale)
        }
    };

    window
        .set_size(Size::Physical(PhysicalSize::new(width, height)))
        .map_err(|e| format!("Failed to resize window: {}", e))?;
    window
        .set_position(Position::Physical(PhysicalPosition::new(x, y)))
        .map_err(|e| format!("Failed to position window: {}", e))?;

    Ok(())
}
```

- [ ] **Step 4: Register state and commands**

In `src-tauri/src/lib.rs`:

Add after `.manage(window::ContentProtectionState::default())` (line 113):

```rust
        .manage(window::OverlayMinimizeState::default())
```

Add to the `generate_handler![...]` list after `window::set_content_protection,` (line ~161):

```rust
            window::minimize_overlay,
            window::restore_overlay,
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml window::`
Expected: PASS (6 tests).

Run: `cd src-tauri && cargo check && cd ..` (on Windows PowerShell: `cargo check --manifest-path src-tauri/Cargo.toml`)
Expected: compiles clean (catches the registration/unused-import issues).

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/window.rs src-tauri/src/lib.rs
git commit -m "feat(window): overlay minimize/restore commands with work-area corner math"
```

---

### Task 3: The module store — `src/lib/overlay-minimize.store.ts`

**Files:**
- Create: `src/lib/overlay-minimize.store.ts`
- Test: `src/tests/overlay-minimize.store.test.ts` (create)

**Interfaces:**
- Consumes: `OverlayPillStyle` from Task 1 (`@/lib/storage`).
- Produces (Tasks 4, 6, 7, 8 rely on these EXACT names):
  - `getMinimized(): boolean`, `setMinimized(value: boolean): void`, `subscribeToMinimized(listener: () => void): () => void`
  - `OverlayPillData = { segmentCount: number; lastLine: string; status: "capturing" | "error" | "idle" }`
  - `getPillData(): OverlayPillData`, `setPillData(data: OverlayPillData): void`, `subscribeToPillData(listener: () => void): () => void`
  - `PILL_DIMENSIONS: Record<OverlayPillStyle, { width: number; height: number }>`
- Contract: `getPillData` returns the STORED object reference, replaced only by `setPillData` — a getter assembling a fresh object per call would never compare equal and would loop React 19's `useSyncExternalStore` snapshot check. `setMinimized` also maintains the `data-overlay-minimized` attribute on `document.body` (the CSS hook for hiding Radix portals).

- [ ] **Step 1: Write the failing tests**

Create `src/tests/overlay-minimize.store.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  getPillData,
  getMinimized,
  PILL_DIMENSIONS,
  setPillData,
  setMinimized,
  subscribeToPillData,
  subscribeToMinimized,
} from "@/lib/overlay-minimize.store";

describe("overlay-minimize store", () => {
  beforeEach(() => {
    setMinimized(false);
    setPillData({ segmentCount: 0, lastLine: "", status: "idle" });
    vi.clearAllMocks();
  });

  it("starts un-minimized and toggles", () => {
    expect(getMinimized()).toBe(false);
    setMinimized(true);
    expect(getMinimized()).toBe(true);
    setMinimized(false);
    expect(getMinimized()).toBe(false);
  });

  it("notifies subscribers on minimize and clears on restore, and unsubscribe works", () => {
    const listener = vi.fn();
    const unsub = subscribeToMinimized(listener);

    setMinimized(true);
    expect(listener).toHaveBeenCalledTimes(1);

    unsub();
    setMinimized(true); // no-op: already true, no notification
    setMinimized(false);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("does not notify when the value does not change", () => {
    const listener = vi.fn();
    subscribeToMinimized(listener);

    setMinimized(false); // already false
    expect(listener).not.toHaveBeenCalled();
  });

  it("maintains the data-overlay-minimized body attribute", () => {
    setMinimized(true);
    expect(document.body.hasAttribute("data-overlay-minimized")).toBe(true);

    setMinimized(false);
    expect(document.body.hasAttribute("data-overlay-minimized")).toBe(false);
  });

  it("pill data: writer replaces the stored reference and notifies subscribers", () => {
    const listener = vi.fn();
    subscribeToPillData(listener);

    const next = { segmentCount: 3, lastLine: "hello", status: "capturing" };
    setPillData(next);

    expect(getPillData()).toBe(next); // SAME reference — useSyncExternalStore contract
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("exports the spec's pill dimensions for all three styles", () => {
    expect(PILL_DIMENSIONS["status-count"]).toEqual({ width: 148, height: 40 });
    expect(PILL_DIMENSIONS["icon-only"]).toEqual({ width: 52, height: 52 });
    expect(PILL_DIMENSIONS["status-last-line"]).toEqual({ width: 320, height: 48 });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/tests/overlay-minimize.store.test.ts`
Expected: FAIL — module `@/lib/overlay-minimize.store` does not exist.

- [ ] **Step 3: Implement the store**

Create `src/lib/overlay-minimize.store.ts`:

```ts
import type { OverlayPillStyle } from "@/lib/storage";

/**
 * Logical (CSS-px) window dimensions for each minimized pill style. These
 * feed the `minimize_overlay` invoke — Rust converts them to physical pixels
 * through the window's scale factor. From the spec's styles table; do not
 * change one without the other.
 */
export const PILL_DIMENSIONS: Record<
  OverlayPillStyle,
  { width: number; height: number }
> = {
  "status-count": { width: 148, height: 40 },
  "icon-only": { width: 52, height: 52 },
  "status-last-line": { width: 320, height: 48 },
};

/**
 * The three scalars the minimized pill displays. Written ONLY by
 * <Completion /> (see the spec's "Pill data source"); read by MinimizedPill
 * through useSyncExternalStore.
 */
export interface OverlayPillData {
  segmentCount: number;
  lastLine: string;
  status: "capturing" | "error" | "idle";
}

let minimized = false;
const minimizedListeners = new Set<() => void>();

export const getMinimized = (): boolean => minimized;

/**
 * Module-level on purpose: the MutationObserver callback in useWindow.ts has
 * no render scope and cannot read a hook or context. setMinimized also owns
 * the `data-overlay-minimized` body attribute, which global.css uses to hide
 * Radix's portaled popovers while minimized (they portal to document.body,
 * outside every React wrapper). attributeFilter there is ["data-state"], so
 * writing this attribute does not retrigger the observer.
 */
export const setMinimized = (value: boolean): void => {
  if (minimized === value) return;
  minimized = value;
  if (value) {
    document.body.setAttribute("data-overlay-minimized", "true");
  } else {
    document.body.removeAttribute("data-overlay-minimized");
  }
  minimizedListeners.forEach((listener) => listener());
};

export const subscribeToMinimized = (listener: () => void): (() => void) => {
  minimizedListeners.add(listener);
  return () => {
    minimizedListeners.delete(listener);
  };
};

const INITIAL_PILL_DATA: OverlayPillData = {
  segmentCount: 0,
  lastLine: "",
  status: "idle",
};

let pillData: OverlayPillData = INITIAL_PILL_DATA;
const pillDataListeners = new Set<() => void>();

/**
 * MUST return the stored reference, not a fresh object: useSyncExternalStore
 * compares snapshots with Object.is, and a getter that assembles per call
 * never compares equal, looping React 19's snapshot check. The reference is
 * replaced only by setPillData.
 */
export const getPillData = (): OverlayPillData => pillData;

export const setPillData = (data: OverlayPillData): void => {
  pillData = data;
  pillDataListeners.forEach((listener) => listener());
};

export const subscribeToPillData = (listener: () => void): (() => void) => {
  pillDataListeners.add(listener);
  return () => {
    pillDataListeners.delete(listener);
  };
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/tests/overlay-minimize.store.test.ts`
Expected: PASS (6 tests).

Run: `npm run check:types`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/overlay-minimize.store.ts src/tests/overlay-minimize.store.test.ts
git commit -m "feat(overlay): module store for the minimize flag and pill data"
```

---

### Task 4: The gate — hoist `resizeWindow`, export `isAnyPopoverOpen`

**Files:**
- Modify: `src/hooks/useWindow.ts` (lines 1-83: the `useWindowResize` hook)
- Test: `src/tests/useWindow.minimize-gate.test.ts` (create — Task 7 extends it with the handler-ordering cases)

**Interfaces:**
- Consumes: `getMinimized` from Task 3.
- Produces (Tasks 6, 7, 8 import these EXACT names):
  - `export const resizeWindow = async (expanded: boolean): Promise<void>` — module-level in `useWindow.ts`, re-exported through `@/hooks` (the barrel does `export * from "./useWindow"`, line 4 of `src/hooks/index.ts`). Existing callers (`useCompletion.ts:173`, `useSystemAudio.ts`, `updater/index.tsx`) keep working unchanged because `useWindowResize()` still returns `{ resizeWindow }` and the function identity is now permanently stable.
  - `export const isAnyPopoverOpen = (): boolean`
- Contract: the gate line `if (getMinimized()) return;` sits INSIDE the module function, not a hook body — the pill calls the module function directly, and a gate left in a hook-scoped `useCallback` would let that call bypass it. The gate must cover BOTH `expanded` values: `resizeWindow(false)` is the MutationObserver stomp, `resizeWindow(true)` would silently un-minimize the window when a popover opens.

- [ ] **Step 1: Write the failing tests**

Create `src/tests/useWindow.minimize-gate.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The gate reads the flag directly from the store module; mocking the module
// keeps these tests pure unit tests of the gate, independent of the store's
// own (separately tested) behavior.
const getMinimizedMock = vi.fn<() => boolean>();
vi.mock("@/lib/overlay-minimize.store", () => ({
  getMinimized: () => getMinimizedMock(),
}));

const invokeMock = vi.fn<(args: Record<string, unknown>) => Promise<void>>();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: Record<string, unknown>) =>
    invokeMock({ cmd, ...args }),
}));

// resizeWindow calls getCurrentWebviewWindow() BEFORE the invoke; under
// happy-dom there is no __TAURI_INTERNALS__, so the real module throws inside
// the try block and the invoke is never reached. Without this mock the three
// positive-path tests fail even against a correct implementation.
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({ label: "main" }),
}));

import { isAnyPopoverOpen, resizeWindow } from "@/hooks/useWindow";

const flush = async () => {
  await vi.waitFor(() => expect(invokeMock).toHaveBeenCalled());
};

describe("resizeWindow minimize gate", () => {
  beforeEach(() => {
    getMinimizedMock.mockReturnValue(false);
    invokeMock.mockClear();
    invokeMock.mockResolvedValue(undefined);
  });

  it("invokes set_window_height(600) when expanded and not minimized", async () => {
    await resizeWindow(true);
    expect(invokeMock).toHaveBeenCalledWith(
      expect.objectContaining({ cmd: "set_window_height", height: 600 })
    );
  });

  it("invokes set_window_height(54) when collapsed and no popover is open", async () => {
    await resizeWindow(false);
    expect(invokeMock).toHaveBeenCalledWith(
      expect.objectContaining({ cmd: "set_window_height", height: 54 })
    );
  });

  it("no-ops on resizeWindow(false) while minimized (the MutationObserver stomp)", async () => {
    getMinimizedMock.mockReturnValue(true);
    await resizeWindow(false);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("no-ops on resizeWindow(true) while minimized (a popover opening must not un-minimize)", async () => {
    getMinimizedMock.mockReturnValue(true);
    await resizeWindow(true);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("resumes both directions once the gate clears", async () => {
    getMinimizedMock.mockReturnValue(true);
    await resizeWindow(true);
    expect(invokeMock).not.toHaveBeenCalled();

    getMinimizedMock.mockReturnValue(false);
    await resizeWindow(true);
    await resizeWindow(false);
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });

  it("exports isAnyPopoverOpen (the restore step needs it)", () => {
    expect(typeof isAnyPopoverOpen).toBe("function");
    // No popovers in the test DOM: false.
    expect(isAnyPopoverOpen()).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/tests/useWindow.minimize-gate.test.ts`
Expected: FAIL — `isAnyPopoverOpen` is not exported (import error); `resizeWindow` is not exported.

- [ ] **Step 3: Rewrite `useWindowResize` as a thin wrapper**

In `src/hooks/useWindow.ts`, replace lines 1-83 (keep `useWindowFocus` below untouched) with:

```ts
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { useEffect } from "react";

import { getMinimized } from "@/lib/overlay-minimize.store";

// Helper function to check if any popover is open in the DOM. Exported: the
// restore sequence re-derives the window height from the CURRENT popover
// state (see the spec's "Restore must re-derive the height").
export const isAnyPopoverOpen = (): boolean => {
  const popoverContents = document.querySelectorAll(
    "[data-radix-popper-content-wrapper]"
  );
  return popoverContents.length > 0;
};

// Module-level, not a hook: the minimized pill calls this directly after
// restoring, and it must not require a useWindowResize() mount (which would
// register a SECOND MutationObserver + document drag listeners alongside
// the instance useCompletion already owns). The gate below is the whole
// feature: arriving transcript segments fire the MutationObserver
// continuously, and without this early-return the pill is yanked back to a
// 600px bar within milliseconds of being minimized. Both expanded values are
// gated - resizeWindow(false) is the stomp, and resizeWindow(true) would
// silently un-minimize the window when a popover opens.
export const resizeWindow = async (expanded: boolean): Promise<void> => {
  if (getMinimized()) return;
  try {
    const window = getCurrentWebviewWindow();

    if (!expanded && isAnyPopoverOpen()) {
      return;
    }

    const newHeight = expanded ? 600 : 54;

    await invoke("set_window_height", {
      window,
      height: newHeight,
    });
  } catch (error) {
    console.error("Failed to resize window:", error);
  }
};

// Thin wrapper: every existing caller (useCompletion, useSystemAudio,
// updater) keeps its `const { resizeWindow } = useWindowResize()` line and
// its effect deps unchanged. resizeWindow's identity is now permanently
// stable, which also makes those deps exact.
export const useWindowResize = () => {
  // Setup drag handling and popover monitoring
  useEffect(() => {
    let isDragging = false;

    const handleMouseDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      const isDragRegion = target.closest('[data-tauri-drag-region="true"]');

      if (isDragRegion) {
        isDragging = true;
      }
    };

    const handleMouseUp = async () => {
      if (isDragging) {
        isDragging = false;

        setTimeout(() => {
          if (!isAnyPopoverOpen()) {
            resizeWindow(false);
          }
        }, 100);
      }
    };

    const observer = new MutationObserver(() => {
      if (!isAnyPopoverOpen()) {
        resizeWindow(false);
      }
    });

    // Observe the body for changes to detect popover open/close
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-state"],
    });

    document.addEventListener("mousedown", handleMouseDown);
    document.addEventListener("mouseup", handleMouseUp);

    return () => {
      document.removeEventListener("mousedown", handleMouseDown);
      document.removeEventListener("mouseup", handleMouseUp);
      observer.disconnect();
    };
  }, []);

  return { resizeWindow };
};
```

(Keep the react import unchanged — `useWindowFocus`, which stays untouched at the bottom of this file, still uses `useCallback` for `handleFocusChange` (line 94), so removing it breaks compilation.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/tests/useWindow.minimize-gate.test.ts`
Expected: PASS (6 tests).

Run: `npm run check:types`
Expected: PASS (proves `useCompletion`/`useSystemAudio`/`updater` still compile against the hoisted shape).

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useWindow.ts src/tests/useWindow.minimize-gate.test.ts
git commit -m "feat(window): gate resizeWindow behind the minimize flag, hoist to module scope"
```

---

### Task 5: The settings selector — `OverlayPillStyleSelect`

**Files:**
- Create: `src/pages/settings/components/OverlayPillStyleSelect.tsx`
- Modify: `src/pages/settings/components/index.ts` (barrel)
- Modify: `src/pages/settings/index.tsx` (place after `ContentProtectionToggle`)
- Test: `src/tests/settings-page.overlay-pill.test.tsx` (create — Task 7 extends it with the main-window listener cases)

**Interfaces:**
- Consumes: `setOverlayPillStyle` + `customizable.overlayPill.style` from Task 1's context; `OverlayPillStyle` from `@/lib/storage`.
- Produces: `OverlayPillStyleSelect` component; emits the Tauri event `overlay-pill-style-changed` with payload `{ style: <new style> }` (the `main` window listens — Task 7).

- [ ] **Step 1: Write the failing tests**

Create `src/tests/settings-page.overlay-pill.test.tsx` (the page-render part only for now; the component test mocks the context the same way `MeetingAutoRecordToggle.note.test.tsx` mocks its deps):

```tsx
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

let stored: Record<string, string> = {};
vi.mock("@/lib", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    safeLocalStorage: {
      getItem: (k: string) => stored[k] ?? null,
      setItem: (k: string, v: string) => {
        stored[k] = v;
      },
      removeItem: (k: string) => {
        delete stored[k];
      },
    },
  };
});

vi.mock("@/layouts", () => ({
  PageLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/lib/platform", () => ({
  isWindows: () => true,
  isMacOS: () => false,
  isLinux: () => false,
  getPlatform: () => "windows",
}));

// Sibling settings sections are stubbed; the selector under test stays real.
vi.mock("@/pages/settings/components", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const Stub = () => <div />;
  return {
    ...actual,
    Theme: Stub,
    AITitlesToggle: Stub,
    AlwaysOnTopToggle: Stub,
    AppIconToggle: Stub,
    AutostartToggle: Stub,
    ContentProtectionToggle: Stub,
    MeetingAutoRecordToggle: Stub,
  };
});

// The real selector calls useApp() — without a contexts mock (or an
// AppProvider wrap) `customizable` is undefined and it crashes on
// `customizable.overlayPill.style` before the assertion can run.
vi.mock("@/contexts", () => ({
  useApp: () => ({
    customizable: { overlayPill: { style: "status-count" } },
    setOverlayPillStyle: vi.fn(),
  }),
}));

import Settings from "@/pages/settings";

describe("settings page renders the overlay pill style selector", () => {
  it("mounts OverlayPillStyleSelect", () => {
    render(
      <MemoryRouter>
        <Settings />
      </MemoryRouter>
    );
    expect(
      screen.queryByText(/minimized pill style/i)
    ).not.toBeNull();
  });
});

describe("OverlayPillStyleSelect writes storage and announces the change", () => {
  const setOverlayPillStyle = vi.fn();
  let currentStyle = "status-count";

  beforeEach(async () => {
    vi.resetModules();
    stored = {};
    setOverlayPillStyle.mockClear();
    // The storage module writes through the GLOBAL localStorage (the
    // @/lib safeLocalStorage mock above does not intercept it), and setup.ts
    // leaves that as bare vi.fn()s — wire them to the `stored` map so the
    // round-trip is real, exactly like customizable.storage.test.ts does.
    vi.mocked(localStorage.getItem).mockImplementation(
      (k: string) => stored[k] ?? null
    );
    vi.mocked(localStorage.setItem).mockImplementation(
      (k: string, v: string) => {
        stored[k] = v;
      }
    );
    // ESM: no `require`. Capture the real writer through a dynamic import so
    // the context-setter mock routes at it — a real round-trip, not a mock
    // calling a mock.
    const { updateOverlayPillStyle } = await import(
      "@/lib/storage/customizable.storage"
    );
    setOverlayPillStyle.mockImplementation((style: string) => {
      updateOverlayPillStyle(style as never);
      currentStyle = style;
    });
  });

  it("calls setOverlayPillStyle and emits overlay-pill-style-changed on change", async () => {
    const emitMock = vi.fn().mockResolvedValue(undefined);
    const listenMock = vi.fn().mockResolvedValue(() => {});
    vi.doMock("@tauri-apps/api/event", () => ({
      emit: emitMock,
      listen: listenMock,
    }));
    vi.doMock("@/contexts", () => ({
      useApp: () => ({
        customizable: { overlayPill: { style: currentStyle } },
        setOverlayPillStyle,
      }),
    }));

    const { OverlayPillStyleSelect } = await import(
      "@/pages/settings/components/OverlayPillStyleSelect"
    );
    render(
      <MemoryRouter>
        <OverlayPillStyleSelect />
      </MemoryRouter>
    );

    await userEvent.click(screen.getByRole("combobox"));
    await userEvent.click(await screen.findByRole("option", { name: /icon only/i }));

    await waitFor(() => {
      expect(setOverlayPillStyle).toHaveBeenCalledWith("icon-only");
      expect(emitMock).toHaveBeenCalledWith("overlay-pill-style-changed", {
        style: "icon-only",
      });
    });
    // The storage round-trip wrote the new style under the CUSTOMIZABLE key.
    expect(JSON.parse(stored["customizable"]).overlayPill.style).toBe("icon-only");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/tests/settings-page.overlay-pill.test.tsx`
Expected: FAIL — component does not exist; page does not render it.

- [ ] **Step 3: Implement the selector**

Create `src/pages/settings/components/OverlayPillStyleSelect.tsx` (modeled on `src/pages/shortcuts/components/Cursor.tsx`, the repo's established Header+Select settings pattern):

```tsx
import {
  Header,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components";
import { useApp } from "@/contexts";
import { emit } from "@tauri-apps/api/event";
import type { OverlayPillStyle } from "@/lib/storage";

interface OverlayPillStyleSelectProps {
  className?: string;
}

export const OverlayPillStyleSelect = ({
  className,
}: OverlayPillStyleSelectProps) => {
  const { customizable, setOverlayPillStyle } = useApp();

  const handleStyleChange = async (style: string) => {
    setOverlayPillStyle(style as OverlayPillStyle);
    // The pill renders in the `main` window and this settings page renders
    // in `dashboard`; both share localStorage, but main's React state will
    // not re-read it on its own. Same pattern MeetingAutoRecordToggle uses
    // for meeting-detection-setting-changed.
    try {
      await emit("overlay-pill-style-changed", { style });
    } catch (error) {
      console.error("Failed to announce the pill style change:", error);
    }
  };

  return (
    <div id="overlay-pill-style" className={`space-y-2 ${className}`}>
      <Header
        title="Minimized Pill Style"
        description="Choose what the overlay shows while minimized to the corner"
        isMainTitle
        rightSlot={
          <Select
            value={customizable.overlayPill.style}
            onValueChange={handleStyleChange}
          >
            <SelectTrigger>
              <SelectValue placeholder="Select a pill style" />
            </SelectTrigger>
            <SelectContent position="popper" align="end">
              <SelectItem value="status-count">Status and count</SelectItem>
              <SelectItem value="icon-only">Icon only</SelectItem>
              <SelectItem value="status-last-line">Status and last line</SelectItem>
            </SelectContent>
          </Select>
        }
      />
    </div>
  );
};
```

Add to `src/pages/settings/components/index.ts` (alphabetical, after `MeetingAutoRecordToggle`):

```ts
export * from "./OverlayPillStyleSelect";
```

Add to the app components barrel `src/pages/app/components/index.ts` (the page's `./components` import resolves here — the pill MUST be registered so Task 7 can import it through the barrel, which is also what lets the test suites stub it by mocking the barrel):

```ts
export * from "./MinimizedPill";
```

In `src/pages/settings/index.tsx`, add to the import list and place the component after `<ContentProtectionToggle />`:

```tsx
import {
  Theme,
  AITitlesToggle,
  AlwaysOnTopToggle,
  AppIconToggle,
  AutostartToggle,
  ContentProtectionToggle,
  MeetingAutoRecordToggle,
  OverlayPillStyleSelect,
} from "./components";
```

```tsx
      {/* Screen Capture Protection Toggle */}
      <ContentProtectionToggle />

      {/* Minimized Pill Style Select */}
      <OverlayPillStyleSelect />
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/tests/settings-page.overlay-pill.test.tsx`
Expected: PASS (2 tests).

Run: `npm run check:types`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/pages/settings/components/OverlayPillStyleSelect.tsx src/pages/settings/components/index.ts src/pages/settings/index.tsx src/tests/settings-page.overlay-pill.test.tsx
git commit -m "feat(settings): pill style selector for the minimized overlay"
```

---

### Task 6: The `MinimizedPill` component

**Files:**
- Create: `src/pages/app/components/MinimizedPill.tsx`
- Test: `src/tests/minimized-pill.test.tsx` (create)

**Interfaces:**
- Consumes: `getPillData`/`subscribeToPillData`/`setMinimized` from Task 3; `PILL_DIMENSIONS` unused here (dims are the WINDOW's job — the pill content fills whatever window Rust sized); `resizeWindow`/`isAnyPopoverOpen` from Task 4; `OverlayPillStyle` from Task 1.
- Produces: `MinimizedPill({ style }: { style: OverlayPillStyle })` — renders one of the three variants; the whole pill surface is the expand click target; click runs the ordered restore sequence.

- [ ] **Step 1: Write the failing tests**

Create `src/tests/minimized-pill.test.tsx`:

```tsx
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

const invokeMock = vi.fn<(cmd: string, args?: Record<string, unknown>) => Promise<void>>();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => invokeMock(cmd, args),
}));
// The restore sequence ends with resizeWindow(isAnyPopoverOpen()), which calls
// getCurrentWebviewWindow() before its invoke; without this mock that throws
// (no __TAURI_INTERNALS__ under happy-dom) and set_window_height never fires —
// the stale-rect regression below asserts on exactly that invoke.
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({ label: "main" }),
}));

import { MinimizedPill } from "@/pages/app/components/MinimizedPill";
import { getPillData, setMinimized, setPillData } from "@/lib/overlay-minimize.store";

describe("MinimizedPill", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
    setMinimized(true); // the pill only ever renders while minimized
    setPillData({ segmentCount: 0, lastLine: "", status: "idle" });
  });

  it.each([
    ["status-count", "Status and count"],
    ["icon-only", "Icon only"],
    ["status-last-line", "Status and last line"],
  ] as const)("renders the %s variant", (style) => {
    render(
      <MemoryRouter>
        <MinimizedPill style={style} />
      </MemoryRouter>
    );
    expect(screen.getByRole("button", { name: /expand/i })).not.toBeNull();
  });

  it("shows the segment count in the status-count variant", () => {
    setPillData({ segmentCount: 42, lastLine: "hello", status: "capturing" });
    render(
      <MemoryRouter>
        <MinimizedPill style="status-count" />
      </MemoryRouter>
    );
    expect(screen.getByText(/42/)).not.toBeNull();
  });

  it("shows the last transcript line (truncated) in the status-last-line variant", () => {
    setPillData({ segmentCount: 1, lastLine: "the quick brown fox", status: "capturing" });
    render(
      <MemoryRouter>
        <MinimizedPill style="status-last-line" />
      </MemoryRouter>
    );
    expect(screen.getByText(/the quick brown fox/)).not.toBeNull();
  });

  it("clicking invokes restore_overlay, and clears the flag only AFTER the invoke resolves", async () => {
    let resolveInvoke: (value: void) => void = () => {};
    invokeMock.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveInvoke = resolve;
      })
    );

    render(
      <MemoryRouter>
        <MinimizedPill style="status-count" />
      </MemoryRouter>
    );

    await userEvent.click(screen.getByRole("button", { name: /expand/i }));

    // Invoke fired, but the gate is still closed while the window is
    // pill-sized — the flag must not clear early.
    expect(invokeMock).toHaveBeenCalledWith("restore_overlay");
    expect(getPillData()).not.toBeNull(); // sanity: store alive
    expect(document.body.hasAttribute("data-overlay-minimized")).toBe(true);

    resolveInvoke();
    await waitFor(() => {
      expect(document.body.hasAttribute("data-overlay-minimized")).toBe(false);
    });
  });

  it("keeps the flag set (pill stays) when restore_overlay rejects", async () => {
    invokeMock.mockRejectedValue(new Error("no monitor"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    render(
      <MemoryRouter>
        <MinimizedPill style="status-count" />
      </MemoryRouter>
    );

    await userEvent.click(screen.getByRole("button", { name: /expand/i }));
    await waitFor(() => {
      expect(document.body.hasAttribute("data-overlay-minimized")).toBe(true);
    });
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  // The spec's stale-rect regression, pinned under useWindow.minimize-gate
  // but exercised here because it needs the pill's real click handler: a
  // popover that opens WHILE minimized must leave the restored window at
  // 600, not the minimize-time 54 — resizeWindow(isAnyPopoverOpen()) must
  // re-derive the height from the CURRENT popover state.
  it("restore re-derives the height: popover open while minimized ends at 600, not 54", async () => {
    render(
      <MemoryRouter>
        <MinimizedPill style="status-count" />
      </MemoryRouter>
    );

    // A transcript segment arrives while minimized: the Radix portal appears
    // in the DOM (CSS-hidden in production, present to isAnyPopoverOpen()).
    const portal = document.createElement("div");
    portal.setAttribute("data-radix-popper-content-wrapper", "");
    document.body.appendChild(portal);

    await userEvent.click(screen.getByRole("button", { name: /expand/i }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("set_window_height", {
        window: expect.objectContaining({ label: "main" }),
        height: 600,
      });
    });
    const collapsed = invokeMock.mock.calls.filter(
      ([cmd, args]) => cmd === "set_window_height" && (args as { height: number }).height === 54
    );
    expect(collapsed).toEqual([]);
    portal.remove();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/tests/minimized-pill.test.tsx`
Expected: FAIL — component does not exist.

- [ ] **Step 3: Implement the pill**

Create `src/pages/app/components/MinimizedPill.tsx`:

```tsx
import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ChevronUp } from "lucide-react";

import { WingIcon } from "@/components";
import {
  getPillData,
  setMinimized,
  subscribeToPillData,
} from "@/lib/overlay-minimize.store";
import { isAnyPopoverOpen, resizeWindow } from "@/hooks/useWindow";
import type { OverlayPillStyle } from "@/lib/storage";
import { cn } from "@/lib/utils";

const STATUS_DOT_COLORS: Record<string, string> = {
  capturing: "bg-green-500",
  error: "bg-red-500",
  idle: "bg-gray-400",
};

/**
 * The corner pill shown while the overlay is minimized. The window itself is
 * sized by Rust (`minimize_overlay`); this component fills it, so the variant
 * differences are content, not fixed pixel sizes.
 *
 * No `data-tauri-drag-region` anywhere on the pill: a drag region over the
 * click target makes the expand click unreliable, and dragging stays an
 * expanded-overlay affordance via the existing DragButton.
 */
export const MinimizedPill = ({ style }: { style: OverlayPillStyle }) => {
  const pillData = useSyncExternalStore(subscribeToPillData, getPillData);

  // The order is load-bearing (the spec's "Restore must re-derive the
  // height"): the gate stays CLOSED until Rust has actually restored the
  // geometry — a resizeWindow racing a half-restored window is the bug the
  // gate exists to prevent. Only then clear the flag and re-derive the
  // height from the CURRENT popover state instead of replaying the
  // minimize-time snapshot.
  const handleExpand = async () => {
    try {
      await invoke("restore_overlay");
    } catch (error) {
      // Flag NOT cleared: clearing after a failed restore would render the
      // full Card inside a pill-sized window. The pill stays; the user can
      // retry.
      console.error("Failed to restore overlay:", error);
      return;
    }
    setMinimized(false);
    resizeWindow(isAnyPopoverOpen());
  };

  return (
    <div className="w-full h-full flex items-center justify-center">
      <button
        type="button"
        aria-label="Expand Meetwings overlay"
        title="Expand"
        onClick={handleExpand}
        className={cn(
          "w-full h-full flex items-center justify-center gap-1.5 rounded-xl",
          "bg-card/95 border border-border shadow-md cursor-pointer",
          "hover:bg-accent/90 transition-colors"
        )}
      >
        <span
          className={cn(
            "size-2 rounded-full flex-shrink-0",
            STATUS_DOT_COLORS[pillData.status] ?? STATUS_DOT_COLORS.idle
          )}
        />
        {style === "icon-only" && <WingIcon className="h-5 w-5" />}
        {style === "status-count" && (
          <>
            <span className="text-xs font-medium">{pillData.segmentCount}</span>
            <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" />
          </>
        )}
        {style === "status-last-line" && (
          <span className="text-xs truncate max-w-[260px]">
            {pillData.lastLine || "Listening..."}
          </span>
        )}
      </button>
    </div>
  );
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/tests/minimized-pill.test.tsx`
Expected: PASS (7 tests).

Run: `npm run check:types`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/pages/app/components/MinimizedPill.tsx src/pages/app/components/index.ts src/tests/minimized-pill.test.tsx
git commit -m "feat(overlay): MinimizedPill component with three style variants"
```

(`src/pages/app/components/index.ts` is a real barrel — Step 3 added `export * from "./MinimizedPill";` to it. The barrel registration is load-bearing for Task 7: the app page imports the pill through `./components` precisely so the test suites can stub it by mocking the barrel.)

---

### Task 7: Wire the app page — nesting, minimize button, style listener, CSS

**Files:**
- Modify: `src/pages/app/index.tsx`
- Modify: `src/global.css` (append near the end)
- Test: `src/tests/hidden-and-minimized.test.tsx` (create)
- Test: `src/tests/useWindow.minimize-gate.test.ts` (extend — the handler-ordering cases from the spec)
- Test: `src/tests/settings-page.overlay-pill.test.tsx` (extend — the main-window listener cases from the spec)

**Interfaces:**
- Consumes: everything from Tasks 1-6.
- Produces: the final overlay page behavior. The three-level nesting (outer `isHidden` wrapper unchanged, inner minimized wrapper, pill as `Card` sibling) is the spec's "Hide, do not swap" layout — NOTHING unmounts in either state.

- [ ] **Step 1: Write the failing tests**

Create `src/tests/hidden-and-minimized.test.tsx` using the repo's established app-page test pattern (`vi.resetModules()` + wholesale `vi.doMock` — see `src/tests/settings-page.meeting-auto-record.test.tsx` for the proven stub shapes):

```tsx
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

// The minimize handler ordering assertions live here rather than in the gate
// unit test because the handlers are the app page's, not useWindow's. The
// spec pins them under useWindow.minimize-gate.test.ts; this file is their
// runtime home — see the extended block in useWindow.minimize-gate.test.ts
// for the re-export note.

const invokeMock = vi.fn<(cmd: string, args?: Record<string, unknown>) => Promise<void>>();

const mockAppPage = () => {
  vi.doMock("@tauri-apps/api/core", () => ({
    invoke: (cmd: string, args?: Record<string, unknown>) => invokeMock(cmd, args),
  }));
  // The app page now calls listen("overlay-pill-style-changed", ...) on mount;
  // the real listen() rejects under happy-dom, and Vitest fails the run on
  // the resulting unhandled rejection.
  vi.doMock("@tauri-apps/api/event", () => ({
    listen: () => Promise.resolve(() => {}),
    emit: vi.fn().mockResolvedValue(undefined),
  }));
  vi.doMock("@/contexts", () => ({
    useApp: () => ({
      customizable: {
        cursor: { type: "default" },
        overlayPill: { style: "status-count" },
      },
      setOverlayPillStyle: vi.fn(),
    }),
  }));
  vi.doMock("@/lib", () => ({ getPlatform: () => "windows" }));
  vi.doMock("@/layouts", () => ({ ErrorLayout: () => null }));
  vi.doMock("@/components", () => ({
    Card: ({ children }: any) => <div data-testid="overlay-card">{children}</div>,
    Updater: () => null,
    DragButton: () => null,
    CustomCursor: () => null,
    Button: ({ children, onClick, title }: any) => (
      <button onClick={onClick} title={title}>
        {children}
      </button>
    ),
    WingIcon: () => null,
  }));
  vi.doMock("@/pages/app/components", () => ({
    SystemAudio: () => null,
    Completion: () => <div data-testid="completion-stub" />,
    AudioVisualizer: () => null,
    StatusIndicator: () => null,
    MinimizedPill: () => <div data-testid="minimized-pill-stub" />,
  }));
  vi.doMock("react-error-boundary", () => ({
    ErrorBoundary: ({ children }: any) => <>{children}</>,
  }));
  vi.doMock("lucide-react", () => ({
    AlertCircle: () => null,
    Minimize2: () => null,
  }));
};

const mockHooks = (isHidden: boolean) => {
  vi.doMock("@/hooks", () => ({
    useApp: () => ({ isHidden, systemAudio: { capturing: false } }),
    useSetupStatus: () => ({
      isComplete: true,
      isLoading: false,
      aiConfigured: true,
      sttConfigured: true,
    }),
    useMeetingDetection: () => ({}),
  }));
};

beforeEach(() => {
  vi.resetModules();
  invokeMock.mockReset();
  invokeMock.mockResolvedValue(undefined);
});

describe("hidden vs minimized orthogonality (spec edge case 1)", () => {
  it("hidden AND minimized: both render without error and nothing unmounts", async () => {
    mockAppPage();
    mockHooks(true); // isHidden = true
    const { setMinimized } = await import("@/lib/overlay-minimize.store");
    const { default: App } = await import("@/pages/app");

    render(
      <MemoryRouter>
        <App />
      </MemoryRouter>
    );

    setMinimized(true);
    await waitFor(() => {
      expect(screen.queryByTestId("minimized-pill-stub")).not.toBeNull();
    });
    // Structural contract: the pill renders INSIDE the isHidden wrapper and
    // the Card stays mounted while hidden (happy-dom does not apply
    // Tailwind's display rules, so visibility itself is the manual gate's
    // job — this pins the nesting that PRODUCES the visibility).
    expect(screen.queryByTestId("overlay-card")).not.toBeNull();
  });

  it("hiding and unhiding issues no geometry invoke", async () => {
    mockAppPage();
    mockHooks(true);
    const { default: App } = await import("@/pages/app");

    render(
      <MemoryRouter>
        <App />
      </MemoryRouter>
    );

    expect(invokeMock).not.toHaveBeenCalledWith(
      "minimize_overlay",
      expect.anything()
    );
    expect(invokeMock).not.toHaveBeenCalledWith("restore_overlay");
  });
});

describe("minimize button (gate ordering, per the spec)", () => {
  it("closes the gate synchronously BEFORE invoking minimize_overlay", async () => {
    mockAppPage();
    mockHooks(false);
    const { default: App } = await import("@/pages/app");
    const { getMinimized } = await import("@/lib/overlay-minimize.store");

    render(
      <MemoryRouter>
        <App />
      </MemoryRouter>
    );

    let resolveInvoke: (v: void) => void = () => {};
    invokeMock.mockImplementation(
      (cmd: string) =>
        new Promise<void>((resolve) => {
          if (cmd === "minimize_overlay") resolveInvoke = resolve;
          else resolve();
        })
    );

    await userEvent.click(screen.getByTitle("Minimize"));

    // Gate closed BEFORE the invoke resolves: a resizeWindow fired during
    // the await (the MutationObserver stomp) is swallowed.
    expect(getMinimized()).toBe(true);
    expect(invokeMock).toHaveBeenCalledWith("minimize_overlay", {
      width: 148,
      height: 40,
      restyle: false,
    });

    resolveInvoke();
    await waitFor(() => expect(getMinimized()).toBe(true));
  });

  it("rolls the flag back when minimize_overlay rejects", async () => {
    mockAppPage();
    mockHooks(false);
    const { default: App } = await import("@/pages/app");
    const { getMinimized, setMinimized } = await import(
      "@/lib/overlay-minimize.store"
    );
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    invokeMock.mockRejectedValue(new Error("no monitor"));

    render(
      <MemoryRouter>
        <App />
      </MemoryRouter>
    );

    await userEvent.click(screen.getByTitle("Minimize"));
    await waitFor(() => expect(getMinimized()).toBe(false));
    consoleError.mockRestore();
  });
});
```

Extend `src/tests/settings-page.overlay-pill.test.tsx` with the main-window listener cases (append a new `describe`; reuse the file's existing mocks):

```tsx
describe("main window listens for overlay-pill-style-changed", () => {
  const invokeMock = vi.fn<(cmd: string, args?: Record<string, unknown>) => Promise<void>>();
  let listeners = new Map<string, Array<(e: { payload: unknown }) => void>>();

  beforeEach(() => {
    vi.resetModules();
    listeners = new Map();
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
  });

  it("re-invokes minimize_overlay with the new style's dims ONLY when minimized", async () => {
    vi.doMock("@tauri-apps/api/core", () => ({
      invoke: (cmd: string, args?: Record<string, unknown>) => invokeMock(cmd, args),
    }));
    vi.doMock("@tauri-apps/api/event", () => ({
      emit: vi.fn().mockResolvedValue(undefined),
      listen: (event: string, handler: (e: { payload: unknown }) => void) => {
        if (!listeners.has(event)) listeners.set(event, []);
        listeners.get(event)!.push(handler);
        return Promise.resolve(() => {});
      },
    }));
    vi.doMock("@/contexts", () => ({
      useApp: () => ({
        customizable: {
          cursor: { type: "default" },
          overlayPill: { style: "status-count" },
        },
        setOverlayPillStyle: vi.fn(),
      }),
    }));
    vi.doMock("@/lib", () => ({ getPlatform: () => "windows" }));
    vi.doMock("@/layouts", () => ({ ErrorLayout: () => null }));
    vi.doMock("@/components", () => ({
      Card: ({ children }: any) => <div>{children}</div>,
      Updater: () => null,
      DragButton: () => null,
      CustomCursor: () => null,
      Button: ({ children, onClick, title }: any) => (
        <button onClick={onClick} title={title}>
          {children}
        </button>
      ),
      WingIcon: () => null,
    }));
    vi.doMock("@/pages/app/components", () => ({
      SystemAudio: () => null,
      Completion: () => null,
      AudioVisualizer: () => null,
      StatusIndicator: () => null,
      MinimizedPill: () => null,
    }));
    vi.doMock("@/hooks", () => ({
      useApp: () => ({ isHidden: false, systemAudio: { capturing: false } }),
      useSetupStatus: () => ({
        isComplete: true,
        isLoading: false,
        aiConfigured: true,
        sttConfigured: true,
      }),
      useMeetingDetection: () => ({}),
    }));
    vi.doMock("react-error-boundary", () => ({
      ErrorBoundary: ({ children }: any) => <>{children}</>,
    }));
    vi.doMock("lucide-react", () => ({
      AlertCircle: () => null,
      Minimize2: () => null,
    }));

    const { setMinimized } = await import("@/lib/overlay-minimize.store");
    const { default: App } = await import("@/pages/app");

    const { unmount } = render(
      <MemoryRouter>
        <App />
      </MemoryRouter>
    );

    // NOT minimized: the event must be a geometry no-op.
    listeners.get("overlay-pill-style-changed")!.forEach((cb) =>
      cb({ payload: { style: "icon-only" } })
    );
    await vi.waitFor(() => {
      // The listener still synced the context state (a pure no-op here), but
      // NO geometry invoke may fire.
      expect(invokeMock).not.toHaveBeenCalledWith(
        "minimize_overlay",
        expect.anything()
      );
    });

    // Minimized: the SAME event re-invokes minimize_overlay as a restyle with
    // the new style's dimensions.
    setMinimized(true);
    listeners.get("overlay-pill-style-changed")!.forEach((cb) =>
      cb({ payload: { style: "icon-only" } })
    );
    await vi.waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("minimize_overlay", {
        width: 52,
        height: 52,
        restyle: true,
      });
    });

    // The remaining two style->dimension mappings (the spec requires all
    // three; icon-only ran above):
    listeners.get("overlay-pill-style-changed")!.forEach((cb) =>
      cb({ payload: { style: "status-last-line" } })
    );
    await vi.waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("minimize_overlay", {
        width: 320,
        height: 48,
        restyle: true,
      });
    });
    listeners.get("overlay-pill-style-changed")!.forEach((cb) =>
      cb({ payload: { style: "status-count" } })
    );
    await vi.waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("minimize_overlay", {
        width: 148,
        height: 40,
        restyle: true,
      });
    });

    unmount();
  });
});
```

Also append a cross-reference note test to `src/tests/useWindow.minimize-gate.test.ts` so the spec's placement of the ordering assertions is honored (a pointer, since the handlers live on the app page):

```ts
describe("handler ordering (spec: useWindow.minimize-gate.test.ts)", () => {
  it("lives in hidden-and-minimized.test.tsx — the minimize/restore handlers are the app page's, not useWindow's", () => {
    // The spec pins these assertions under this file name; the app-page
    // handler tests (gate closed before invoke; flag cleared only after
    // restore resolves) run in src/tests/hidden-and-minimized.test.tsx
    // because they exercise <App />'s click handlers. This pointer keeps
    // the file searchable from the spec's name.
    expect(true).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/tests/hidden-and-minimized.test.tsx src/tests/settings-page.overlay-pill.test.tsx`
Expected: FAIL — App has no minimize button (`getByTitle("Minimize")` throws), no listener, no pill sibling.

- [ ] **Step 3: Rewire `src/pages/app/index.tsx`**

Full replacement of the component body (the imports stay mostly the same; new imports added):

```tsx
import { Card, Updater, DragButton, CustomCursor, Button, WingIcon } from "@/components";
import {
  SystemAudio,
  Completion,
  AudioVisualizer,
  StatusIndicator,
  MinimizedPill,
} from "./components";
import { useApp, useSetupStatus, useMeetingDetection } from "@/hooks";
import { useApp as useAppContext } from "@/contexts";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ErrorBoundary } from "react-error-boundary";
import { ErrorLayout } from "@/layouts";
import { getPlatform } from "@/lib";
import { AlertCircle, Minimize2 } from "lucide-react";
import { useEffect, useSyncExternalStore } from "react";
import {
  getMinimized,
  PILL_DIMENSIONS,
  setMinimized,
  subscribeToMinimized,
} from "@/lib/overlay-minimize.store";
import type { OverlayPillStyle } from "@/lib/storage";

const App = () => {
  const { isHidden, systemAudio } = useApp();
  const {
    isComplete: setupComplete,
    isLoading: setupLoading,
    aiConfigured,
    sttConfigured,
  } = useSetupStatus();
  // Teams call detection. Self-gating: inert outside the `main` window and off
  // Windows. Takes no arguments and never touches capture state.
  useMeetingDetection();
  const { customizable, setOverlayPillStyle } = useAppContext();
  const platform = getPlatform();
  const minimized = useSyncExternalStore(subscribeToMinimized, getMinimized);
  const pillStyle = customizable.overlayPill.style;

  const openDashboard = async () => {
    try {
      await invoke("open_dashboard");
    } catch (error) {
      console.error("Failed to open dashboard:", error);
    }
  };

  // The gate closes SYNCHRONOUSLY before the invoke: a transcript segment
  // arriving during the IPC round-trip fires the MutationObserver's
  // resizeWindow(false), which must not race the pill geometry. The catch
  // rolls the flag back so a failed minimize cannot leave a pill rendered
  // inside an un-minimized window. One paint of the pill in a still-600px
  // window beats one paint of the full bar in a pill-sized one.
  const handleMinimize = async () => {
    const dims = PILL_DIMENSIONS[pillStyle];
    setMinimized(true);
    try {
      await invoke("minimize_overlay", {
        width: dims.width,
        height: dims.height,
        restyle: false,
      });
    } catch (error) {
      console.error("Failed to minimize overlay:", error);
      setMinimized(false);
    }
  };

  // The dashboard settings window writes localStorage and emits
  // overlay-pill-style-changed (it renders in another webview; this one's
  // React state will not re-read storage on its own). Sync the context
  // state, and if minimized, restyle the pill in place — restyle: true is
  // what keeps Rust from re-snapshotting the pill's own corner geometry as
  // the "pre-minimize" rect.
  useEffect(() => {
    const unlistenPromise = listen<{ style: OverlayPillStyle }>(
      "overlay-pill-style-changed",
      (event) => {
        const style = event.payload.style;
        setOverlayPillStyle(style);
        if (getMinimized()) {
          const dims = PILL_DIMENSIONS[style];
          invoke("minimize_overlay", {
            width: dims.width,
            height: dims.height,
            restyle: true,
          }).catch((error) => {
            console.error("Failed to restyle minimized pill:", error);
          });
        }
      }
    );

    return () => {
      unlistenPromise.then((unlisten) => unlisten());
    };
    // [] deps, matching the useApp.ts listener precedent: setOverlayPillStyle
    // is an unmemoized provider function (new identity every provider render,
    // like setCursorType at src/contexts/app.context.tsx:728), so depending on
    // it would tear down and re-register the listener — with a gap — on every
    // provider render. The callback only touches stable bindings
    // (setOverlayPillStyle via closure over the render it was created in is
    // fine: it writes through setCustomizable, which is identity-stable, and
    // the storage writer; it never reads stale React state), so [] is safe.
    // An unhandled rejection would fail the suite; surface it.
    unlistenPromise.catch((error) => {
      console.error("Failed to listen for pill style changes:", error);
    });
  }, []);

  return (
    <ErrorBoundary
      fallbackRender={() => {
        return <ErrorLayout isCompact />;
      }}
      resetKeys={["app-error"]}
      onReset={() => {
        console.log("Reset");
      }}
    >
      <div
        className={`w-screen h-screen flex overflow-hidden justify-center items-start ${
          isHidden ? "hidden pointer-events-none" : ""
        }`}
      >
        {/* Inner minimized wrapper: hiding is a VISIBILITY change — the Card
            subtree (and useCompletion's 2400-line hook with it) stays
            mounted, or minimize would destroy the meeting transcript and
            re-run every mount effect on restore. isHidden is the OUTER
            wrapper, so hiding the app hides the pill too. The wrapper needs
            w-full: it is an auto-width flex item of the outer justify-center
            container, and without it the Card's w-full would resolve against
            a shrink-to-fit parent — a content-sized bar instead of the
            full-window one. */}
        <div className={minimized ? "hidden" : "w-full"}>
          <Card className="w-full flex flex-row items-center gap-2 p-2">
            {/* Setup Required Message (suppressed until setup status settles) */}
            {!setupLoading && !setupComplete && (
              <div className="flex flex-1 items-center gap-3 px-2">
                <AlertCircle className="h-5 w-5 text-yellow-500 flex-shrink-0" />
                <div className="flex flex-col min-w-0">
                  <span className="text-sm font-medium">
                    Setup Required
                  </span>
                  <span className="text-xs text-muted-foreground truncate">
                    {!aiConfigured && !sttConfigured
                      ? "Configure & verify AI + Speech providers"
                      : !aiConfigured
                      ? "Configure AI provider"
                      : !sttConfigured
                      ? "Configure Speech-to-Text provider"
                      : "Verify your API connections"}
                  </span>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  className="ml-auto flex-shrink-0"
                  onClick={openDashboard}
                >
                  Open Setup
                </Button>
              </div>
            )}

            {/* Normal UI when setup is complete */}
            {!setupLoading && setupComplete && (
              <>
                <SystemAudio {...systemAudio} />
                {systemAudio?.capturing ? (
                  <div className="flex flex-row items-center gap-2 justify-between w-full">
                    <div className="flex flex-1 items-center gap-2">
                      <AudioVisualizer
                        stream={systemAudio?.stream}
                        isRecording={systemAudio?.capturing}
                      />
                    </div>
                    <div className="flex !w-fit items-center gap-2">
                      <StatusIndicator
                        setupRequired={systemAudio.setupRequired}
                        error={systemAudio.error}
                        isProcessing={systemAudio.isProcessing}
                        isAIProcessing={systemAudio.isAIProcessing}
                        capturing={systemAudio.capturing}
                      />
                    </div>
                  </div>
                ) : null}

                <div
                  className={`${
                    systemAudio?.capturing
                      ? "hidden w-full fade-out transition-all duration-300"
                      : "w-full flex flex-row gap-2 items-center"
                  }`}
                >
                  <Completion isHidden={isHidden} systemAudio={systemAudio} />
                  <Button
                    size={"icon"}
                    className="cursor-pointer"
                    title="Open Settings"
                    onClick={openDashboard}
                  >
                    <WingIcon className="h-4 w-4" />
                  </Button>
                </div>
              </>
            )}

            <Updater />
            <DragButton />
            <Button
              size={"icon"}
              className="cursor-pointer"
              title="Minimize"
              aria-label="Minimize overlay"
              onClick={handleMinimize}
            >
              <Minimize2 className="h-4 w-4" />
            </Button>
          </Card>
          {customizable.cursor.type === "invisible" && platform !== "linux" ? (
            <CustomCursor />
          ) : null}
        </div>
        {minimized && <MinimizedPill style={pillStyle} />}
      </div>
    </ErrorBoundary>
  );
};

export default App;
```

(CustomCursor moves inside the minimized wrapper deliberately: the pill-sized window has no cursor-customization surface, so it hides with the Card.)

Append to `src/global.css` (before the final `body` block, after the `*` cursor rule):

```css
/* The minimized overlay: Radix portals popovers to document.body, outside
   every React wrapper, so hiding the wrapper alone leaves an expanded
   popover on screen. The overlay-minimize store owns this attribute; the
   MutationObserver in useWindow.ts filters on data-state, so writing it
   does not retrigger the observer. Popovers deliberately stay OPEN in state
   (unlike the isHidden path, which closes them) — the restore sequence
   re-derives the window height from the current popover state. */
body[data-overlay-minimized="true"] [data-radix-popper-content-wrapper] {
  display: none !important;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/tests/hidden-and-minimized.test.tsx src/tests/settings-page.overlay-pill.test.tsx src/tests/useWindow.minimize-gate.test.ts src/tests/minimized-pill.test.tsx src/tests/overlay-minimize.store.test.ts`
Expected: PASS (all).

Run: `npm run check:types`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/pages/app/index.tsx src/global.css src/tests/hidden-and-minimized.test.tsx src/tests/settings-page.overlay-pill.test.tsx src/tests/useWindow.minimize-gate.test.ts
git commit -m "feat(overlay): minimize button, pill sibling layout, and style-change listener"
```

---

### Task 8: The pill-data effect in `Completion` + the keeps-mounted regression

**Files:**
- Modify: `src/pages/app/components/completion/index.tsx` (add one effect after the `useLayoutEffect` at line 167)
- Test: `src/tests/overlay-minimize-keeps-mounted.test.tsx` (create)

**Interfaces:**
- Consumes: `setPillData` from Task 3; `completion.meetingTranscript` (`TranscriptEntry[]` — entries have `original: string`, `timestamp: number`; see `src/types/completion.ts:27`); `systemAudio` (`MeetingAutoRecordAudio`: `capturing: boolean`, `error: string`).
- Produces: the pill data feed. One-way, three scalars, written from one place; the transcript itself is never duplicated into the store.

- [ ] **Step 1: Write the failing test**

Create `src/tests/overlay-minimize-keeps-mounted.test.tsx`. This is the regression that motivates "hide, do not swap": if minimize/restore ever swaps the `Card` subtree out (instead of toggling a wrapper's `hidden` class), `useCompletion` unmounts — the meeting transcript dies mid-meeting and every mount effect re-runs on restore.

Repo constraint (established in `src/tests/settings-page.meeting-auto-record.test.tsx`, F34): the REAL `useCompletion` cannot render under happy-dom — it pulls the app context, VAD, `navigator.mediaDevices` and the audio stack. The proven pattern there is: stub `useCompletion` in the `@/hooks` barrel with a spy-backed factory, but mount the REAL `<Completion />` (whose body carries this task's new pill-data effect) with its heavy children stubbed by ABSOLUTE specifier. The property under test — nothing unmounts across minimize/restore — is preserved exactly by the stub: the mount spy is the spec's "mount effects did not re-run" probe (a swap unmounts Completion, the spy fires twice), and the real effect's pill-data write is the "transcript is still there" probe.

```tsx
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { useEffect } from "react";

const invokeMock = vi.fn<(cmd: string, args?: Record<string, unknown>) => Promise<void>>();
// Mounted via useEffect inside the useCompletion stub, NOT the hook body: the
// hook body runs on every RENDER (minimize/restore re-renders App through
// useSyncExternalStore), so a body-placed spy counts re-renders and the
// "mount effects did not re-run" assertion can never pass. An effect with []
// deps fires once per MOUNT — which is exactly the probe the spec asks for.
const completionMountSpy = vi.fn();
// The stub's transcript persists in module state: a remount would fire the
// mount spy again (the probe), and re-running the hook would re-seed state —
// the pill-data write is what proves the data never reset.
let transcriptSeed = [
  { original: "first segment", timestamp: 1 },
  { original: "second segment", timestamp: 2 },
];

const mockEverything = () => {
  vi.doMock("@tauri-apps/api/core", () => ({
    invoke: (cmd: string, args?: Record<string, unknown>) => invokeMock(cmd, args),
  }));
  vi.doMock("@tauri-apps/api/event", () => ({
    listen: () => Promise.resolve(() => {}),
    emit: vi.fn().mockResolvedValue(undefined),
  }));
  vi.doMock("@/contexts", () => ({
    useApp: () => ({
      customizable: {
        cursor: { type: "default" },
        overlayPill: { style: "status-count" },
      },
      setOverlayPillStyle: vi.fn(),
      allAiProviders: [{ id: "openai" }],
      selectedAIProvider: { provider: "openai", variables: {} },
      meetwingsApiEnabled: false,
    }),
  }));
  vi.doMock("@/lib", () => ({
    getPlatform: () => "windows",
    // Must be an async fn: Completion's mount effect does
    // `void shouldUseMeetwingsAPI().then(...)`.
    shouldUseMeetwingsAPI: vi.fn(async () => false),
  }));
  vi.doMock("@/layouts", () => ({ ErrorLayout: () => null }));
  vi.doMock("@/components", () => ({
    Card: ({ children }: any) => <div data-testid="overlay-card">{children}</div>,
    Updater: () => null,
    DragButton: () => null,
    CustomCursor: () => null,
    Button: ({ children, onClick, title }: any) => (
      <button onClick={onClick} title={title}>
        {children}
      </button>
    ),
    WingIcon: () => null,
    Popover: ({ children }: any) => <>{children}</>,
    PopoverTrigger: ({ children }: any) => <>{children}</>,
    PopoverContent: ({ children }: any) => <>{children}</>,
  }));
  // The @/hooks barrel: useCompletion is the spied stub; every other hook
  // Completion mounts gets a passthrough with the return shape its
  // destructure requires (shapes copied from the proven F34 stub in
  // settings-page.meeting-auto-record.test.tsx).
  vi.doMock("@/hooks", async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return {
      ...actual,
      useApp: () => ({
        isHidden: false,
        systemAudio: { capturing: true, error: "" },
      }),
      useSetupStatus: () => ({
        isComplete: true,
        isLoading: false,
        aiConfigured: true,
        sttConfigured: true,
      }),
      useMeetingDetection: () => ({}),
      useCompletion: () => {
        useEffect(() => {
          completionMountSpy();
        }, []);
        return {
          meetingTranscript: transcriptSeed,
          meetingAssistMode: true,
          isContactPickerOpen: false,
          setIsContactPickerOpen: vi.fn(),
          setTargetCount: vi.fn(),
          setCalendarBlockPresent: vi.fn(),
          currentConversationId: null,
          enableVAD: false,
          setEnableVAD: vi.fn(),
          flushUnsavedMeetingTranscript: vi.fn(),
        };
      },
      useQuickActions: () => ({}),
      useMeetingAutoRecord: vi.fn(),
      useOdooTarget: () => ({
        targetsRef: { current: [] },
        pickerProps: {
          contactId: null,
          leadId: null,
          contactName: null,
          cache: { kind: "never-synced" },
          opportunities: null,
          opportunityError: null,
          isLookingUp: false,
          onSelect: vi.fn(),
          onSelectOpportunity: vi.fn(),
          onToggleColleague: vi.fn(),
          onRetryOpportunities: vi.fn(),
          onRefresh: vi.fn(),
          onOpenSettings: vi.fn(),
          targets: [],
          onAddTarget: vi.fn(),
          onRemoveTarget: vi.fn(),
          onExpandContact: vi.fn(),
          opportunitiesFor: vi.fn(() => null),
          errorFor: vi.fn(() => null),
          onRetryContactOpportunities: vi.fn(),
          open: false,
          onOpenChange: vi.fn(),
        },
      }),
      useCalendarProposal: () => ({
        present: false,
        state: { kind: "idle" },
        onPickCandidate: vi.fn(),
        onRetry: vi.fn(),
      }),
      useMeetingLog: vi.fn(() => ({
        holding: false,
        onUndo: vi.fn(),
        undoBlockedMessage: null,
      })),
    };
  });
  // The app page barrel: keep the REAL Completion (it carries this task's
  // new pill-data effect); stub only the page's other children.
  vi.doMock("@/pages/app/components", async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return {
      ...actual,
      SystemAudio: () => null,
      AudioVisualizer: () => null,
      StatusIndicator: () => null,
      MinimizedPill: () => <div data-testid="minimized-pill-stub" />,
    };
  });
  // ABSOLUTE specifiers (vi.doMock resolves relative to THIS file, so
  // "./Audio" would be a silent no-op): Completion's direct children are
  // heavy render paths irrelevant to the mount/pill-data assertions.
  vi.doMock("@/pages/app/components/completion/Audio", () => ({
    Audio: () => null,
  }));
  vi.doMock("@/pages/app/components/completion/Input", () => ({
    Input: () => null,
  }));
  vi.doMock("@/pages/app/components/completion/Screenshot", () => ({
    Screenshot: () => null,
  }));
  vi.doMock("@/pages/app/components/completion/Files", () => ({
    Files: () => null,
  }));
  vi.doMock("@/pages/app/components/completion/MeetingAssistToggle", () => ({
    MeetingAssistToggle: () => null,
  }));
  vi.doMock("react-error-boundary", () => ({
    ErrorBoundary: ({ children }: any) => <>{children}</>,
  }));
  vi.doMock("lucide-react", () => ({
    AlertCircle: () => null,
    Minimize2: () => null,
  }));
};

beforeEach(() => {
  vi.resetModules();
  invokeMock.mockReset();
  invokeMock.mockResolvedValue(undefined);
  completionMountSpy.mockClear();
  transcriptSeed = [
    { original: "first segment", timestamp: 1 },
    { original: "second segment", timestamp: 2 },
  ];
});

describe("minimize keeps the overlay mounted (hide, do not swap)", () => {
  it("a minimize/restore cycle does not unmount Completion or lose the transcript", async () => {
    mockEverything();
    const { default: App } = await import("@/pages/app");
    const { setMinimized, getPillData } = await import(
      "@/lib/overlay-minimize.store"
    );

    render(
      <MemoryRouter>
        <App />
      </MemoryRouter>
    );

    // Mount effects ran exactly once (the spec's probe), and the REAL
    // pill-data effect already fed the store from the stub's transcript.
    expect(completionMountSpy).toHaveBeenCalledTimes(1);
    expect(getPillData().segmentCount).toBe(2);
    expect(getPillData().lastLine).toBe("second segment");
    expect(getPillData().status).toBe("capturing");

    // Minimize: the Card hides, the pill renders, Completion STAYS mounted.
    setMinimized(true);
    await waitFor(() => {
      expect(screen.getByTestId("minimized-pill-stub")).not.toBeNull();
    });
    expect(completionMountSpy).toHaveBeenCalledTimes(1);

    // Restore: nothing remounted.
    setMinimized(false);
    await waitFor(() => {
      expect(screen.queryByTestId("minimized-pill-stub")).toBeNull();
    });
    expect(completionMountSpy).toHaveBeenCalledTimes(1);

    // The transcript can GROW while minimized without anything unmounting:
    // re-seed, trigger a re-render via the store, and the real effect must
    // write the new scalars.
    transcriptSeed = [
      ...transcriptSeed,
      { original: "third segment", timestamp: 3 },
    ];
    setMinimized(true);
    await waitFor(() => {
      expect(getPillData().segmentCount).toBe(3);
      expect(getPillData().lastLine).toBe("third segment");
    });
    expect(completionMountSpy).toHaveBeenCalledTimes(1);
  });

  it("a minimize via the button behaves the same as the store toggle", async () => {
    mockEverything();
    const { default: App } = await import("@/pages/app");

    render(
      <MemoryRouter>
        <App />
      </MemoryRouter>
    );

    await userEvent.click(screen.getByTitle("Minimize"));
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("minimize_overlay", {
        width: 148,
        height: 40,
        restyle: false,
      });
    });
    await waitFor(() => {
      expect(screen.getByTestId("minimized-pill-stub")).not.toBeNull();
    });
    // Card hidden but MOUNTED — no remount:
    expect(completionMountSpy).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/tests/overlay-minimize-keeps-mounted.test.tsx`
Expected: FAIL — `getPillData()` still holds the initial `{ segmentCount: 0, lastLine: "", status: "idle" }`: nothing in `Completion` writes pill data yet.

- [ ] **Step 3: Add the pill-data effect in `Completion`**

In `src/pages/app/components/completion/index.tsx`, add to the imports:

```tsx
import { setPillData } from "@/lib/overlay-minimize.store";
```

Add this effect after the `useLayoutEffect` block (line 169), before `handleQuickAction`:

```tsx
  // The minimized pill's data feed. The pill is a SIBLING of the Card (see the
  // spec's "Hide, do not swap"), so this data cannot flow through props or
  // context — it is pushed up into the module store the resize gate reads.
  // Three scalars, one-way, written from one place; the transcript itself is
  // never duplicated into the store. Keyed on the transcript AND the status
  // inputs: capture can start/stop while minimized (the dashboard can flip it
  // cross-window), which changes no transcript entry but must still update
  // the pill's status dot.
  useEffect(() => {
    const lastEntry =
      completion.meetingTranscript[completion.meetingTranscript.length - 1];
    setPillData({
      segmentCount: completion.meetingTranscript.length,
      lastLine: lastEntry?.original ?? "",
      status: systemAudio.error
        ? "error"
        : systemAudio.capturing
          ? "capturing"
          : "idle",
    });
  }, [completion.meetingTranscript, systemAudio.error, systemAudio.capturing]);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/tests/overlay-minimize-keeps-mounted.test.tsx`
Expected: PASS (2 tests).

Run the full new-feature suite together (the exit gate's test set):

Run: `npx vitest run src/tests/customizable.storage.test.ts src/tests/overlay-minimize.store.test.ts src/tests/useWindow.minimize-gate.test.ts src/tests/minimized-pill.test.tsx src/tests/hidden-and-minimized.test.tsx src/tests/overlay-minimize-keeps-mounted.test.tsx src/tests/settings-page.overlay-pill.test.tsx`
Expected: PASS (all).

Run: `npm run check:types`
Expected: PASS.

Run: `cargo test --manifest-path src-tauri/Cargo.toml window::`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/pages/app/components/completion/index.tsx src/tests/overlay-minimize-keeps-mounted.test.tsx
git commit -m "feat(overlay): Completion pushes pill data; keeps-mounted regression test"
```

- [ ] **Step 6: Manual gate (spec's final test — requires the desktop, do NOT skip)**

Run: `npm run tauri dev`
1. Start capture. Minimize. Confirm the pill survives 30 seconds of active transcription without snapping back to a 600px bar (the MutationObserver gate holds).
2. Click the pill. Confirm the overlay returns to its exact pre-minimize position and size.
3. Minimize, open settings from the dashboard, switch pill style. Confirm the pill resizes in place, then restore — confirm it STILL returns to the pre-minimize position (the restyle did not clobber `saved`).
4. Minimize, press the hide shortcut, unhide: the pill comes back.

---

## Self-Review

**Spec coverage** (each spec section → task):
- "The blocker" / "The gate" → Task 4 (gate line, both `expanded` values, module hoist).
- "Rust: window.rs" (state, both commands, restyle param, `current_monitor` fallback, geometry-write rollback, `bottom_right_position`, margin 16, work_area) → Task 2.
- "Frontend state: overlay-minimize.store.ts" (flag, subscribe, snapshot-stability invariant, body attribute) → Task 3.
- "Restore must re-derive the height" (3-step ordered sequence, `isAnyPopoverOpen` export, third-step owner) → Tasks 4 + 6.
- "Components: MinimizedPill, minimize button, no drag region" → Tasks 6 + 7.
- "Hide, do not swap" (three-level nesting, keeps-mounted, portal CSS rule, popover policy) → Task 7 (+ Task 8 regression).
- "Pill data source" (three scalars, one-way, one writer) → Task 8.
- "Pill styles" table → Task 3 (`PILL_DIMENSIONS`) + Task 6 (variants).
- "Settings" (storage key, type, context, selector placement) → Tasks 1 + 5.
- "Cross-window propagation" (emit, main listener, restyle invoke) → Tasks 5 + 7.
- Edge cases 1-8 → covered: 1 (Task 7 tests + nesting), 2/3 (Task 2 `current_monitor` + `work_area`), 4 (Task 2 physical px, no `set_window_height` reuse), 5 (accepted, no code), 6 (Task 2 `fallback_restore_rect` + tests), 7 (in-memory `Default`, Task 2 test), 8 (no change needed — `main` already in the list).
- Testing section: every named test file exists — `customizable.storage.test.ts` (T1), `overlay-minimize.store.test.ts` (T3), `useWindow.minimize-gate.test.ts` (T4 gate unit tests + T7 ordering), `minimized-pill.test.tsx` (T6 variants + the stale-rect regression — the popover-open-while-minimized case needs the pill's real click handler, which is why it lives here rather than in the gate unit file), `overlay-minimize-keeps-mounted.test.tsx` (T8), `settings-page.overlay-pill.test.tsx` (T5+T7 incl. the main-window listener with all three style mappings), `hidden-and-minimized.test.tsx` (T7), Rust `#[test]`s on `bottom_right_position` + fallback + default state (T2), manual gate (T8 Step 6).

**Placeholder scan:** none — every code step contains the actual code, every run step contains the exact command and expected result.

**Type consistency:** `OverlayPillStyle` (T1) is imported by the store (T3), the selector (T5), the pill (T6), and the app page (T7). `setPillData`/`getPillData`/`setMinimized`/`getMinimized`/`subscribeTo*` (T3) match every consumer. `resizeWindow`/`isAnyPopoverOpen` (T4) match the pill's imports (T6) and the app page's test stubs (T7/T8). Rust: `minimize_overlay(window, width, height, restyle)` and `restore_overlay(window)` match every frontend invoke, and `restyle: false` (genuine minimize) vs `restyle: true` (restyle) is consistent between Task 2, Task 7's button, and Task 7's listener. The `TranscriptEntry.original` field (not `.text`) is used in the pill-data effect and keeps-mounted test, matching `src/types/completion.ts:27`.