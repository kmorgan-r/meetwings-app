# Probe 2 — tauri-plugin-keychain Rust API

- Version inspected: 2.0.2 (pinned in `src-tauri/Cargo.lock`; `src-tauri/Cargo.toml:34` requests `"2.0"`)
- Public Rust items found:
  - `src/lib.rs`: `pub trait KeychainExt<R: Runtime>` with `fn get_item(&self) -> &Keychain<R>`, `fn save_item(&self) -> &Keychain<R>`, `fn remove_item(&self) -> &Keychain<R>`, plus a blanket `impl<R: Runtime, T: Manager<R>> KeychainExt<R> for T`. This is a genuine extension trait on `Manager` (which `AppHandle` implements) — not a `#[tauri::command]`.
  - `src/lib.rs`: `pub fn init<R: Runtime>() -> TauriPlugin<R>` — the standard plugin builder.
  - `src/lib.rs`: `pub use models::*` (re-exports `KeychainRequest { key: Option<String>, password: Option<String> }` and `KeychainResponse { password: Option<String> }` — plain serde structs, not callable API) and `pub use error::{Error, Result}`.
  - `src/desktop.rs` (compiled under `#[cfg(desktop)]`, i.e. Windows/macOS/Linux — the only targets Meetwings ships): `pub struct Keychain<R: Runtime>(AppHandle<R>);` and `pub fn init(...)  -> crate::Result<Keychain<R>>`. **No `impl Keychain<R>` block exists in this file.** The struct that `KeychainExt::get_item/save_item/remove_item` hand back has zero inherent methods on desktop.
  - `src/mobile.rs` (compiled under `#[cfg(mobile)]`, i.e. Android/iOS — platforms Meetwings does not target): `pub struct Keychain<R: Runtime>(PluginHandle<R>);` WITH `impl<R: Runtime> Keychain<R> { pub fn get_item(&self, payload: KeychainRequest) -> crate::Result<KeychainResponse>`, `save_item`, `remove_item` — each calling `self.0.run_mobile_plugin(...)`. This is the only place in the crate where `get_item`/`save_item`/`remove_item` are actually implemented as callable operations.
  - `src/lib.rs`: `mod commands;` and `.invoke_handler(tauri::generate_handler![commands::keychain])` are both **commented out**. There is no `commands.rs` file in the crate at all (confirmed by directory listing: only `build.rs`, `src/desktop.rs`, `src/error.rs`, `src/lib.rs`, `src/mobile.rs`, `src/models.rs` exist). No `#[tauri::command]` handler exists anywhere in this crate version, on any platform.

- Verdict: JS-ONLY

  **Caveat — this is not a clean fit for either label, and the reasoning matters more than the checkbox:**
  Read literally against the brief's test ("(a) an extension trait on AppHandle/Manager exposing get/save/remove" = pass), `KeychainExt<R>` **is** such a trait, syntactically. `app_handle.get_item()` compiles and is genuine Rust code, not an IPC call. A shallow read stops there and calls this RUST-API-AVAILABLE.

  But the trait's three methods don't perform a get/save/remove — they all return `&Keychain<R>`, the same shared state instance, regardless of which one you call. The actual work would have to happen on `Keychain<R>` itself, and **on desktop that type has no methods at all** (`src/desktop.rs` never writes an `impl Keychain<R>` block). The only `impl` with working `get_item`/`save_item`/`remove_item` bodies is `src/mobile.rs`, gated `#[cfg(mobile)]`, which Meetwings never compiles for. So the call chain Task 9 would need — `app_handle.get_item().<do the read>` — dead-ends: there is no method to chain. This isn't a maybe; it's the literal absence of an `impl` block in the file that owns the desktop `Keychain` type.

  Separately, the JS/webview command surface (what "JS-ONLY" normally implies exists and works) is also inert in this version — `mod commands` and the `invoke_handler` registration are both commented out, so there's no `#[tauri::command]` for the webview to invoke either, despite `src-tauri/capabilities/cross-platform.json:11-14` and `default.json:12-15` still declaring `keychain:allow-get-item` / `allow-save-item` / `allow-remove-item` permissions for commands that don't exist in this crate build. (Also confirmed: nothing in `src-tauri/src/` calls `KeychainExt` or references `get_item`/`save_item`/`remove_item` beyond the `tauri_plugin_keychain::init()` registration at `src-tauri/src/lib.rs:119`, and nothing in `src/` (frontend) invokes a keychain command. The plugin is registered and otherwise completely unused today, matching the brief's "currently unused" note.)

  Net: on every platform Meetwings targets, this plugin at 2.0.2 provides **no working way — from Rust or from the webview — to get/save/remove a secret.** It is closer to "neither" than to either label. JS-ONLY is recorded here because its Decision-for-Task-9 consequence (below) is the one that is actually correct: do not attempt to wrap `KeychainExt`, there is nothing functional to wrap on desktop.

- Decision for Task 9: JS-ONLY -> `keychain.rs` wraps the `keyring` crate exactly as Task 9 specifies; `keyring` stays in Task 6's Cargo additions. (Do not add a dependency on `tauri-plugin-keychain`'s `KeychainExt` — it has no desktop-side implementation to call.)

## Second question, same probe: which error variant means "no keychain service"?

`keyring` is not yet a dependency of this repo (Task 6 adds it; `docs/superpowers/plans/2026-09-02-calendar-target-proposal.md:1309` pins `keyring = "3"`), so there is no vendored copy under `~/.cargo/registry/src` to read locally. Per the brief's own step, fetched `keyring` 3.6.3's public docs and the tagged `v3.6.3` source on GitHub (`open-source-cooperative/keyring-rs`) for the `Error` enum and each platform backend's `decode_error` mapping. The dev machine here is Windows; Meetwings also ships macOS and Linux builds, so all three in-scope desktop backends were checked, not just the Linux one the brief used as an example.

`keyring::Error` (from `src/error.rs` in `keyring` 3.6.3) variants, verbatim from docs.rs:
- `PlatformFailure` — "runtime failure in the underlying platform storage system"
- `NoStorageAccess` — "the underlying secure storage holding saved items could not be accessed... credential store is locked"
- `NoEntry` — "no underlying credential entry... either one was never set, or it was deleted"
- `BadEncoding`, `TooLong`, `Invalid`, `Ambiguous` — not service-availability conditions (bad UTF-8, attribute length/validity, duplicate matches).

Per-backend `decode_error` mapping (from the `v3.6.3` tag):
- **Windows** (`src/windows.rs`): `ERROR_NOT_FOUND -> NoEntry`; `ERROR_NO_SUCH_LOGON_SESSION -> NoStorageAccess`; every other Win32 error `-> PlatformFailure` (catch-all).
- **macOS** (`src/macos.rs`): `errSecItemNotFound (-25300) -> NoEntry`; `errSecNotAvailable`, `errSecReadOnly`, `errSecNoSuchKeychain`, `errSecInvalidKeychain` (-25291/-25292/-25294/-25295) `-> NoStorageAccess`; every other OSStatus `-> PlatformFailure`.
- **Linux / secret-service** (`src/secret_service.rs`): `Error::Locked | Error::NoResult | Error::Prompt -> NoStorageAccess`; **everything else, including a D-Bus connection failure when no Secret Service daemon is running at all, falls to the `_` catch-all -> `PlatformFailure`.** This is the one that matters most for "no keychain service": the fully-absent-daemon case does **not** land on `NoStorageAccess` on Linux — it lands on `PlatformFailure`.

- Variant returned by `Entry::new` / `get_password` when no Secret Service is
  running: on Linux this is `PlatformFailure` (the D-Bus-unreachable case falls through `secret_service.rs`'s match to its default arm, not the `Locked`/`NoResult`/`Prompt` arms that produce `NoStorageAccess`). On Windows, the closest analog — no interactive logon session, e.g. running as a bare service — is `NoStorageAccess`; other Windows platform errors are `PlatformFailure`. On macOS, an explicitly-absent/unavailable keychain (`errSecNotAvailable`, `errSecNoSuchKeychain`, etc.) is `NoStorageAccess`; anything unrecognized is `PlatformFailure`.
- Variant(s) `available()` must therefore treat as "unavailable": **both `PlatformFailure` and `NoStorageAccess`.** Neither variant alone is sufficient across all three shipped platforms — matching only `NoStorageAccess` would misclassify the fully-absent-daemon case on Linux as a generic platform failure rather than "no keychain, fall back to session-only." `Invalid` is confirmed NOT part of this set on any of the three backends inspected — none of their `decode_error` functions ever produce it; it is reserved for bad credential-attribute values, an unrelated failure mode.

This confirms, rather than merely repeats, what the plan already has at `docs/superpowers/plans/2026-09-02-calendar-target-proposal.md:2124`: `Err(keyring::Error::PlatformFailure(_)) | Err(keyring::Error::NoStorageAccess(_))`. The existing match arm is correct and, per the Linux evidence above, is not just conservative — omitting `PlatformFailure` would be a real miss on Linux specifically.

**Whatever this probe finds, Task 9's `available()` is still a heuristic and Task 11
must not depend on it being right** — see Task 11's degrade-to-session-only rule.
