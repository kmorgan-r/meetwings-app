use std::sync::Mutex;
#[cfg(target_os = "macos")]
use tauri::LogicalPosition;
use tauri::{
    App, AppHandle, Manager, PhysicalPosition, PhysicalRect, PhysicalSize, Position, Runtime, Size,
    WebviewWindow, WebviewWindowBuilder,
};

// The offset from the top of the screen to the window
const TOP_OFFSET: i32 = 54;

// Distance between the minimized pill and the work-area edges, in physical px.
const PILL_MARGIN: i32 = 16;

/// Whether app windows should be excluded from screen capture
/// (SetWindowDisplayAffinity on Windows, NSWindow sharing on macOS).
/// The frontend pushes the user's stored setting here on startup and on
/// every change; windows created later - the dashboard - read it at build
/// time, so the global shortcut path (no frontend involvement) stays in
/// sync too.
pub struct ContentProtectionState {
    pub enabled: Mutex<bool>,
}

impl Default for ContentProtectionState {
    fn default() -> Self {
        // First install: protection ON.
        Self {
            enabled: Mutex::new(true),
        }
    }
}

/// The main overlay's pre-minimize geometry, in PHYSICAL pixels:
/// (x, y, width, height). In-memory only — a restart starts un-minimized,
/// and restore falls back to the 600x54 bar when this is None.
///
/// `minimized` is the SOURCE OF TRUTH for whether the window is currently the
/// corner pill. It cannot be derived from `saved`: restore deliberately keeps
/// the snapshot (see `restore_overlay`), so `saved.is_some()` outlives the
/// minimized state. The frontend's flag is a mirror of this one and is reset
/// by anything that resets the webview's JS heap — a reload from the error
/// screen's retry button, a WebView2 renderer restart — while the window
/// itself stays a pill. Rust survives all of those, so Rust holds the truth
/// and the frontend reads it back on mount.
pub struct OverlayMinimizeState {
    pub saved: Mutex<Option<(i32, i32, u32, u32)>>,
    pub minimized: Mutex<bool>,
}

impl Default for OverlayMinimizeState {
    fn default() -> Self {
        Self {
            saved: Mutex::new(None),
            minimized: Mutex::new(false),
        }
    }
}

/// Apply the flag to every app window that exists right now. Capture
/// overlays are deliberately excluded - they ARE the capture UI.
fn apply_content_protection<R: Runtime>(app: &AppHandle<R>, enabled: bool) {
    for label in ["main", "dashboard"] {
        if let Some(window) = app.get_webview_window(label) {
            if let Err(e) = window.set_content_protected(enabled) {
                eprintln!("Failed to set content protection on {}: {}", label, e);
            }
        }
    }
}

#[tauri::command]
pub fn set_content_protection(app: AppHandle, enabled: bool) -> Result<(), String> {
    let state = app.state::<ContentProtectionState>();
    *state.enabled.lock().unwrap() = enabled;
    apply_content_protection(&app, enabled);
    Ok(())
}

/// Sets up the main window with custom positioning
pub fn setup_main_window(app: &mut App) -> Result<(), Box<dyn std::error::Error>> {
    // Try different possible window labels
    let window = app
        .get_webview_window("main")
        .or_else(|| app.get_webview_window("meetwings"))
        .or_else(|| {
            // Get the first window if specific labels don't work
            app.webview_windows().values().next().cloned()
        })
        .ok_or("No window found")?;

    position_window_top_center(&window, TOP_OFFSET)?;

    // Set window as non-focusable on Windows
    // #[cfg(target_os = "windows")]
    // {
    //     let _ = window.set_focusable(false);
    // }

    Ok(())
}

/// Positions a window at the top center of the screen with a specified Y offset
pub fn position_window_top_center(
    window: &WebviewWindow,
    y_offset: i32,
) -> Result<(), Box<dyn std::error::Error>> {
    // Get the primary monitor
    if let Some(monitor) = window.primary_monitor()? {
        let monitor_size = monitor.size();
        let window_size = window.outer_size()?;

        // Calculate center X position
        let center_x = (monitor_size.width as i32 - window_size.width as i32) / 2;

        // Set the window position
        window.set_position(tauri::Position::Physical(tauri::PhysicalPosition {
            x: center_x,
            y: y_offset,
        }))?;
    }

    Ok(())
}

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

/// Pull a window rect back inside a work area, returning the corrected
/// top-left. A free function beside `bottom_right_position` for the same
/// reason: the geometry is unit-testable without a live window. PHYSICAL
/// pixels throughout.
///
/// The overlay keeps its drag handle and its minimize button at the RIGHT end
/// of the bar, so a bar that hangs off the right edge of the screen is a bar
/// the user cannot move or minimize — the controls that would rescue it are
/// the part that is off-screen. Clamping on every resize makes that
/// unreachable state impossible whatever produced the position.
///
/// Overflow beats underflow: a window WIDER than the work area pins to the
/// work area's origin (min then max), keeping its left edge — where the app
/// draws its content — on screen rather than its right.
fn clamp_into_work_area(
    work_area: &PhysicalRect<i32, u32>,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
) -> (i32, i32) {
    let max_x = work_area.position.x + work_area.size.width as i32 - width as i32;
    let max_y = work_area.position.y + work_area.size.height as i32 - height as i32;
    (
        x.min(max_x).max(work_area.position.x),
        y.min(max_y).max(work_area.position.y),
    )
}

/// Best-effort: pull `window` back inside its monitor's work area. Never
/// fails the caller — a window that is merely mispositioned is a better
/// outcome than a resize or a restore that reports failure, and every caller
/// here has already committed the geometry it cares about.
fn keep_window_on_screen(window: &WebviewWindow) {
    let monitor = match window.current_monitor() {
        Ok(Some(monitor)) => Some(monitor),
        // A window parked entirely outside every monitor reads as None; the
        // primary is then the only sane place to pull it back to.
        _ => window.primary_monitor().ok().flatten(),
    };
    let Some(monitor) = monitor else { return };
    let (Ok(position), Ok(size)) = (window.outer_position(), window.outer_size()) else {
        return;
    };

    let (x, y) = clamp_into_work_area(
        monitor.work_area(),
        position.x,
        position.y,
        size.width,
        size.height,
    );
    if (x, y) != (position.x, position.y) {
        if let Err(e) = window.set_position(Position::Physical(PhysicalPosition::new(x, y))) {
            eprintln!("Failed to keep the overlay on screen: {}", e);
        }
    }
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

/// Future function for centering window completely (both X and Y)
#[allow(dead_code)]
pub fn center_window_completely(window: &WebviewWindow) -> Result<(), Box<dyn std::error::Error>> {
    if let Some(monitor) = window.primary_monitor()? {
        let monitor_size = monitor.size();
        let window_size = window.outer_size()?;

        let center_x = (monitor_size.width as i32 - window_size.width as i32) / 2;
        let center_y = (monitor_size.height as i32 - window_size.height as i32) / 2;

        window.set_position(tauri::Position::Physical(tauri::PhysicalPosition {
            x: center_x,
            y: center_y,
        }))?;
    }

    Ok(())
}

#[tauri::command]
pub fn set_window_height(
    app: AppHandle,
    window: tauri::WebviewWindow,
    height: u32,
) -> Result<(), String> {
    use tauri::{LogicalSize, Size};

    // The backstop for the frontend's `getMinimized()` gate in useWindow.ts.
    // That one lives in the webview's JS heap and is gone the moment the page
    // reloads; this one is not. Without it, a reload while minimized lets the
    // MutationObserver stretch the pill back to a 600px bar from the pill's
    // bottom-right anchor — most of it off the right edge of the screen —
    // before the frontend has finished reading the flag back.
    if *app
        .state::<OverlayMinimizeState>()
        .minimized
        .lock()
        .unwrap()
    {
        return Ok(());
    }

    // Simply set the window size with fixed width and new height
    let new_size = LogicalSize::new(600.0, height as f64);
    window
        .set_size(Size::Logical(new_size))
        .map_err(|e| format!("Failed to resize window: {}", e))?;

    // Growing from a bottom or right anchor is what pushes the bar off the
    // work area; this is the one place every expand/collapse passes through.
    keep_window_on_screen(&window);

    Ok(())
}

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
                let _ = window
                    .set_position(Position::Physical(PhysicalPosition::new(saved.0, saved.1)));
                return Err(e);
            }
        }
        None => apply()?,
    }

    // Set only once the geometry is actually committed. The rollback arm above
    // leaves the window expanded, and a flag raised before the apply would gate
    // `set_window_height` against a window that is not a pill — freezing the
    // overlay at whatever height it happened to have.
    *state.minimized.lock().unwrap() = true;

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

    // Cleared last: an early return above leaves the window a pill, and the
    // flag must still say so — the frontend keeps the pill rendered on a
    // failed restore and the user retries.
    *state.minimized.lock().unwrap() = false;

    // The snapshot was taken on whatever monitor the overlay sat on before it
    // was minimized. Wake a laptop on a different display arrangement and
    // those coordinates can land nowhere — the overlay would come back
    // invisible, which is the same trap as coming back unreachable.
    keep_window_on_screen(&window);

    Ok(())
}

/// Whether the overlay window is currently the corner pill. The frontend's
/// flag is a mirror of this one and does not survive a page reload; the app
/// page reads this back on mount so a reload cannot leave the full bar
/// rendering inside pill geometry.
#[tauri::command]
pub fn is_overlay_minimized(app: AppHandle) -> bool {
    *app.state::<OverlayMinimizeState>()
        .minimized
        .lock()
        .unwrap()
}

/// `async` is load-bearing, not stylistic: on Windows `build()` deadlocks when
/// it runs on the main thread inside a command or an event handler (the
/// WebView2 controller is created asynchronously and its completion handler
/// needs the message loop that the command is currently blocking - wry#583).
/// A sync command runs ON that thread; an async one runs on the async runtime,
/// which is what leaves the loop free to finish the webview. The symptom of
/// getting this wrong is not a hang but a window that opens blank forever: the
/// shell is created, the webview never navigates, and the overlay stops
/// responding for as long as the loop is wedged. `start_screen_capture` is
/// async for the same reason.
#[tauri::command]
pub async fn open_dashboard(app: tauri::AppHandle) -> Result<(), String> {
    // Check if dashboard window already exists
    if let Some(dashboard_window) = app.get_webview_window("dashboard") {
        // Window exists, just focus and show it
        dashboard_window
            .set_focus()
            .map_err(|e| format!("Failed to focus dashboard window: {}", e))?;
        dashboard_window
            .show()
            .map_err(|e| format!("Failed to show dashboard window: {}", e))?;
    } else {
        // Window doesn't exist, create it with platform-aware defaults
        create_dashboard_window(&app)
            .map_err(|e| format!("Failed to create dashboard window: {}", e))?;
    }

    Ok(())
}

/// `async` for the reason spelled out on `open_dashboard`: this one also
/// reaches `create_dashboard_window` when the window is gone.
#[tauri::command]
pub async fn toggle_dashboard(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(dashboard_window) = app.get_webview_window("dashboard") {
        match dashboard_window.is_visible() {
            Ok(true) => {
                // Window is visible, hide it
                dashboard_window
                    .hide()
                    .map_err(|e| format!("Failed to hide dashboard window: {}", e))?;
            }
            Ok(false) => {
                // Window is hidden, show and focus it
                dashboard_window
                    .show()
                    .map_err(|e| format!("Failed to show dashboard window: {}", e))?;
                dashboard_window
                    .set_focus()
                    .map_err(|e| format!("Failed to focus dashboard window: {}", e))?;
            }
            Err(e) => {
                return Err(format!("Failed to check dashboard visibility: {}", e));
            }
        }
    } else {
        // Window doesn't exist, create it
        create_dashboard_window(&app)
            .map_err(|e| format!("Failed to create dashboard window: {}", e))?;
    }

    Ok(())
}

#[tauri::command]
pub fn move_window(app: tauri::AppHandle, direction: String, step: i32) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        let current_pos = window
            .outer_position()
            .map_err(|e| format!("Failed to get window position: {}", e))?;

        let (new_x, new_y) = match direction.as_str() {
            "up" => (current_pos.x, current_pos.y - step),
            "down" => (current_pos.x, current_pos.y + step),
            "left" => (current_pos.x - step, current_pos.y),
            "right" => (current_pos.x + step, current_pos.y),
            _ => return Err(format!("Invalid direction: {}", direction)),
        };

        window
            .set_position(tauri::Position::Physical(tauri::PhysicalPosition {
                x: new_x,
                y: new_y,
            }))
            .map_err(|e| format!("Failed to set window position: {}", e))?;
    } else {
        return Err("Main window not found".to_string());
    }

    Ok(())
}

pub fn create_dashboard_window<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<WebviewWindow<R>, tauri::Error> {
    // Follow the user's stored setting rather than hardcoding it: on Windows
    // a protected window blacks out in every capture tool (Snipping Tool,
    // OBS, Print Screen), which users read as the window vanishing.
    let enabled = *app
        .state::<ContentProtectionState>()
        .enabled
        .lock()
        .unwrap();

    let base_builder =
        WebviewWindowBuilder::new(app, "dashboard", tauri::WebviewUrl::App("/meetings".into()));

    #[cfg(target_os = "macos")]
    let base_builder = base_builder
        .title("Meetwings - Dashboard")
        .center()
        .decorations(true)
        .inner_size(1200.0, 800.0)
        .min_inner_size(800.0, 600.0)
        .hidden_title(true)
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .content_protected(enabled)
        .visible(true)
        .traffic_light_position(LogicalPosition::new(14.0, 18.0));

    #[cfg(not(target_os = "macos"))]
    let base_builder = base_builder
        .title("Meetwings - Dashboard")
        .center()
        .decorations(true)
        .inner_size(800.0, 600.0)
        .min_inner_size(800.0, 600.0)
        .content_protected(enabled)
        .visible(true);

    base_builder.build()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A compile-time guard, not a behavioral test: both dashboard commands
    /// must stay `async`. A sync command runs on the main thread, and
    /// `create_dashboard_window` -> `build()` there leaves the dashboard a
    /// blank shell that never navigates (wry#583). Making either one sync
    /// again returns `Result`, which is not a `Future`, and this stops
    /// compiling — the failure the runtime cannot show us.
    #[test]
    fn the_dashboard_commands_stay_async() {
        fn returns_a_future<F, Fut>(_command: F)
        where
            F: Fn(AppHandle) -> Fut,
            Fut: std::future::Future,
        {
        }

        returns_a_future(open_dashboard);
        returns_a_future(toggle_dashboard);
    }

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
        assert_eq!(
            bottom_right_position(&area, 148, 40, 16),
            (1920 - 148 - 16, 1080 - 40 - 16)
        );
    }

    // Taskbar inset: the work area is smaller than the monitor, and the pill
    // must sit above the taskbar, not under it.
    #[test]
    fn bottom_right_taskbar_inset() {
        let area = rect(0, 0, 1920, 1040); // 1080 screen, 40px taskbar
        assert_eq!(
            bottom_right_position(&area, 148, 40, 16),
            (1920 - 148 - 16, 1040 - 40 - 16)
        );
    }

    // A monitor left of the primary has a negative origin; the arithmetic must
    // not assume 0,0.
    #[test]
    fn bottom_right_negative_origin() {
        let area = rect(-1920, 0, 1920, 1080);
        assert_eq!(
            bottom_right_position(&area, 148, 40, 16),
            (-1920 + 1920 - 148 - 16, 1080 - 40 - 16)
        );
    }

    // A window already inside the work area is left exactly where it is.
    #[test]
    fn clamp_leaves_an_on_screen_window_alone() {
        let area = rect(0, 0, 1920, 1040);
        assert_eq!(clamp_into_work_area(&area, 660, 54, 600, 54), (660, 54));
    }

    // The reported bug: the bar keeps the pill's bottom-right anchor and is
    // stretched back to 600px wide, so 400px of it — the drag handle and the
    // minimize button — hang off the right edge.
    #[test]
    fn clamp_pulls_a_right_overflowing_bar_back() {
        let area = rect(0, 0, 1920, 1040);
        // y (984) is already inside 1040 - 54, so only x moves.
        let (x, y) = clamp_into_work_area(&area, 1724, 984, 600, 54);
        assert_eq!((x, y), (1920 - 600, 984));
    }

    // Growing downward from a bottom anchor (the 54 -> 600 popover expand)
    // pushes the window under the taskbar; the work area, not the monitor
    // size, is the limit.
    #[test]
    fn clamp_pulls_a_bottom_overflowing_window_back() {
        let area = rect(0, 0, 1920, 1040); // 1080 screen, 40px taskbar
        assert_eq!(
            clamp_into_work_area(&area, 660, 1000, 600, 600),
            (660, 1040 - 600)
        );
    }

    // A monitor left of the primary has a negative origin, and a window
    // dragged past its left/top edge must come back to that origin, not to 0.
    #[test]
    fn clamp_respects_a_negative_origin() {
        let area = rect(-1920, -200, 1920, 1080);
        assert_eq!(
            clamp_into_work_area(&area, -2600, -900, 600, 54),
            (-1920, -200)
        );
    }

    // Wider than the work area: pin to the origin so the LEFT edge stays
    // visible. min-then-max ordering is what produces this.
    #[test]
    fn clamp_pins_an_oversized_window_to_the_origin() {
        let area = rect(0, 0, 500, 400);
        assert_eq!(clamp_into_work_area(&area, 300, 300, 600, 600), (0, 0));
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
        assert_eq!(
            (x, y, w, h),
            ((2560 - 900) / 2, (54.0 * 1.5) as i32, 900, 81)
        );
    }

    // Restart clears the in-memory state: restore after restart must hit the
    // fallback path, so default() must start with no saved rect.
    #[test]
    fn default_state_has_no_saved_rect() {
        let state = OverlayMinimizeState::default();
        assert!(state.saved.lock().unwrap().is_none());
    }
}
