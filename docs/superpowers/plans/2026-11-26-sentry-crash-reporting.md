# Sentry Crash Reporting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upload Rust panics, frontend JS errors and native crash minidumps from Meetwings to Sentry, with readable native stacks, and only when a DSN is compiled in.

**Architecture:** A new Rust module `crash_reporting` parses the compiled-in DSN and calls `sentry::init` (with `tauri-plugin-sentry` as an integration and the minidump integration) before `tauri::Builder`, so the re-executed crash-reporter process exits before it reaches single-instance. The plugin injects `@sentry/browser` as `window.Sentry` into every webview (`initialization_script` has no window filter); only `main` and `dashboard` get the `sentry:default` capability, so in `capture-overlay-*` windows its IPC calls are denied. A small TS helper reports render errors caught by React error boundaries. CI uploads debug files with `sentry-cli`.

**Tech Stack:** Rust (Tauri 2.8.2), `sentry` 0.49.3, `tauri-plugin-sentry` 0.8.0, React 19, Vitest, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-11-26-sentry-crash-reporting-design.md`

## Global Constraints

- `tauri-plugin-sentry = "=0.8.0"`; `sentry = { version = "0.49.3", features = ["minidump"] }`.
- `src-tauri/Cargo.lock` keeps `tauri` at 2.8.2. Adding the deps must not bump it.
- Rust toolchain: 1.99.1, the CI pin (`cargo +1.99.1 ...`). Never 1.100+.
- CI runs `cargo clippy --all-targets --all-features -- -D warnings` and `cargo test --all-features`. Code behind the `crash-test` feature must be warning-free too.
- Empty or unparseable DSN: no `sentry::init`, no plugin, no crash-reporter process.
- Never use the `sentry::init((dsn, opts))` tuple form. It panics on a bad DSN.
- No session tracking; `send_default_pii` left at its default (off).
- `environment` is not set by hand. `sentry` already defaults it to `development` in debug builds and `production` in release (`sentry-0.49.3/src/defaults.rs`).
- `publish.yml` never enables `crash-test`.
- Commit messages end with the two attribution lines this session uses.

## Review Focus

1. A DSN secret pasted with surrounding whitespace or a trailing newline should still work, not silently disable reporting. Pinned by `parse_dsn_accepts_valid_and_trims` (Task 1).
2. A bad DSN secret should leave the app starting normally. Pinned by `parse_dsn_rejects_garbage` (Task 1).
3. A no-DSN build must not throw from the render-error handler. Pinned by `does not throw without the SDK` (Task 3).
4. An SDK that throws inside `captureException` must still let the error reach `console.error`. Pinned by `still logs when the SDK throws` (Task 3).
5. An unknown `MEETWINGS_CRASH_TEST` value, or any value on a build without the feature, must do nothing. Pinned by `crash_kind_ignores_unknown_values` (Task 2). The feature-off half is enforced by `cfg`.

---

### Task 1: Rust crash reporting behind a compiled-in DSN

**Files:**
- Modify: `src-tauri/Cargo.toml` (`[dependencies]`)
- Modify: `src-tauri/build.rs`
- Create: `src-tauri/src/crash_reporting.rs`
- Modify: `src-tauri/src/lib.rs` (module list, `run()` at ~lines 133-216)
- Modify: `src-tauri/capabilities/default.json`, `src-tauri/capabilities/cross-platform.json`

**Interfaces:**
- Produces:
  - `pub(crate) fn parse_dsn(raw: Option<&str>) -> Option<sentry::types::Dsn>`
  - `pub(crate) fn init() -> Option<(sentry::ClientInitGuard, tauri_plugin_sentry::Sentry)>`

- [ ] **Step 0: Environment.** Linux build deps (`libwebkit2gtk-4.1-dev librsvg2-dev libgtk-3-dev pkg-config libasound2-dev libpulse-dev libssl-dev`) and `rustup toolchain install 1.99.1` must be present. `src-tauri/.env` must exist (gitignored); use dummy values as in `ci.yml` if it does not. For Task 5 also `xvfb` (`xvfb-run`) and `dbus-x11` (`dbus-run-session`; single-instance needs a session bus). Nothing to commit.

- [ ] **Step 1: Add the deps.** In `[dependencies]` add `sentry = { version = "0.49.3", features = ["minidump"] }` and `tauri-plugin-sentry = "=0.8.0"`. Run `cargo +1.99.1 fetch --manifest-path src-tauri/Cargo.toml`. Then run `grep -A1 '^name = "tauri"$' src-tauri/Cargo.lock`. Expected: `version = "2.8.2"`. If not, run `cargo +1.99.1 update --manifest-path src-tauri/Cargo.toml -p tauri --precise 2.8.2` and check again. If that conflicts, stop and report; do not commit.

- [ ] **Step 2: Write the failing tests** in `src-tauri/src/crash_reporting.rs` (`#[cfg(test)] mod tests`). Add `mod crash_reporting;` to `lib.rs`:

```rust
#[test]
fn parse_dsn_none_and_empty_are_off() {
    assert!(parse_dsn(None).is_none());
    assert!(parse_dsn(Some("")).is_none());
    assert!(parse_dsn(Some("  \n")).is_none());
}

#[test]
fn parse_dsn_rejects_garbage() {
    assert!(parse_dsn(Some("not-a-dsn")).is_none());
}

#[test]
fn parse_dsn_accepts_valid_and_trims() {
    let dsn = parse_dsn(Some(" https://abc@o1.ingest.sentry.io/42\n")).unwrap();
    assert_eq!(dsn.public_key(), "abc");
    assert_eq!(dsn.project_id().to_string(), "42");
}
```

- [ ] **Step 3: Run the tests to see them fail.** Run `cargo +1.99.1 test --manifest-path src-tauri/Cargo.toml --lib crash_reporting`. Expected: compile error, `parse_dsn` not found.

- [ ] **Step 4: Implement `parse_dsn` and `init` in `src-tauri/src/crash_reporting.rs`.**
  - `parse_dsn`: trim first. Empty → `None`. Parse failure → `tracing::warn!` without the value (the DSN holds a key), then `None`.
  - `init`: `parse_dsn(option_env!("SENTRY_DSN"))?`. Build `let plugin = tauri_plugin_sentry::Sentry::new();` and `sentry::ClientOptions { dsn: Some(dsn), release: sentry::release_name!(), ..Default::default() }`. Add `.add_integration(plugin.clone())` and `.add_integration(sentry::integrations::minidump::MinidumpIntegration::new())`. Return `Some((sentry::init(options), plugin))`.
  - Doc comment on `init`, one line: the minidump integration re-executes this binary as the crash reporter. That process never returns from `sentry::init` (`run_crash_reporter` is `-> !`), so `init` must run before `tauri::Builder`.
  - No extra handling for a reporter that fails to start. `setup` logs a spawn `Err` with `sentry_debug!` and carries on (`sentry-minidump-0.49.3/src/lib.rs:469-476`). `init` still returns `Some`, and the plugin is still added; the client exists. Worst case, startup waits `client_connect_timeout` (default 3000 ms, `minidumper-child-0.5.0/src/lib.rs:71`).

- [ ] **Step 5: Run the tests to see them pass.** Same command as Step 3. Expected: 3 passed.

- [ ] **Step 6: Wire it into `run()`.**
  - In `lib.rs` `run()`, right after `init_tracing();`, add `let crash_reporting = crash_reporting::init();`. Comment why it sits before the builder.
  - After the builder chain ends (`.plugin(tauri_plugin_machine_uid::init());`) and before the `#[cfg(target_os = "macos")]` nspanel block, add `if let Some((_, sentry_plugin)) = &crash_reporting { builder = builder.plugin(sentry_plugin.clone()); }`.
  - Do not use `let _ = ...` or `let _crash_reporting`-style drops. The guard must live to the end of `run()`.

- [ ] **Step 7: Pass the DSN through `build.rs`.**
  - Before `tauri_build::build()`, add the `SENTRY_DSN` block in the same shape as `POSTHOG_API_KEY`.
  - Add `println!("cargo:rerun-if-env-changed=SENTRY_DSN");`.
  - Add `println!("cargo:rerun-if-changed=.env");`, emitted only `if std::path::Path::new(".env").exists()`.

- [ ] **Step 8: Add the capability.** Append `"sentry:default"` to the `permissions` array of `src-tauri/capabilities/default.json` and of `src-tauri/capabilities/cross-platform.json`. Do not touch their `windows` lists.

- [ ] **Step 9: Lint.** Run `cargo +1.99.1 clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings`. Expected: no warnings. Then run `cargo +1.99.1 fmt --manifest-path src-tauri/Cargo.toml --all -- --check`. Expected: clean.

- [ ] **Step 10: Commit** `Cargo.toml`, `Cargo.lock`, `build.rs`, `crash_reporting.rs`, `lib.rs` and both capability files: `feat(sentry): report Rust panics and native crashes when a DSN is compiled in`.

### Task 2: `crash-test` feature for verifying reports

**Files:**
- Modify: `src-tauri/Cargo.toml` (new `[features]` section)
- Modify: `src-tauri/src/crash_reporting.rs`
- Modify: `src-tauri/src/lib.rs` (`run()`)

**Interfaces:**
- Consumes: `crash_reporting::init()` (Task 1).
- Produces: `#[cfg(feature = "crash-test")] pub(crate) fn maybe_crash_test()`.

- [ ] **Step 1: Add the feature.** In `Cargo.toml`, add `[features]` with `crash-test = ["tauri/devtools"]`. A release test build then has devtools for the JS checks.

- [ ] **Step 2: Write the failing tests** (`#[cfg(all(test, feature = "crash-test"))]`):

```rust
#[test]
fn crash_kind_reads_known_values() {
    assert_eq!(crash_kind(Some("panic")), Some(CrashKind::Panic));
    assert_eq!(crash_kind(Some("abort")), Some(CrashKind::Abort));
}

#[test]
fn crash_kind_ignores_unknown_values() {
    assert_eq!(crash_kind(None), None);
    assert_eq!(crash_kind(Some("")), None);
    assert_eq!(crash_kind(Some("segv")), None);
}
```

- [ ] **Step 3: Run to see them fail.** Run `cargo +1.99.1 test --manifest-path src-tauri/Cargo.toml --lib --features crash-test crash_reporting`. Expected: compile error, `crash_kind` and `CrashKind` not found.

- [ ] **Step 4: Implement** in `crash_reporting.rs`, all behind `#[cfg(feature = "crash-test")]`:
  - `#[derive(Debug, PartialEq)] enum CrashKind { Panic, Abort }`
  - `fn crash_kind(raw: Option<&str>) -> Option<CrashKind>`: exact `"panic"` / `"abort"` only.
  - `#[inline(never)] fn sentry_crash_test(kind: CrashKind) -> !`: `panic!("sentry crash test")` or `std::process::abort()`. The name must appear in the Sentry frame, so keep it a real, non-inlined function.
  - `pub(crate) fn maybe_crash_test()`: reads `std::env::var("MEETWINGS_CRASH_TEST").ok()`. On a known kind, calls `sentry_crash_test`.

- [ ] **Step 5: Call it.** In `run()`, right after `let crash_reporting = crash_reporting::init();`, add `#[cfg(feature = "crash-test")] crash_reporting::maybe_crash_test();`.

- [ ] **Step 6: Run the tests and lint.** Run the Step 3 command. Expected: 5 passed. Then run the Task 1 Step 9 clippy command (`--all-features` covers this code). Expected: no warnings.

- [ ] **Step 7: Commit** `Cargo.toml`, `crash_reporting.rs`, `lib.rs`: `feat(sentry): add crash-test feature to trigger a panic or abort on demand`.

### Task 3: Report render errors caught by React error boundaries

**Files:**
- Create: `src/lib/report-caught-error.ts`
- Modify: `src/main.tsx` (the non-overlay `createRoot` call, ~line 44)
- Test: `src/tests/report-caught-error.test.ts` (create), `src/tests/main-entry.test.tsx` (modify)

**Interfaces:**
- Consumes: `window.Sentry`, injected by the plugin (Task 1) as the whole `@sentry/browser` namespace (`tauri-plugin-sentry-0.8.0/js/inject.ts:12`). It is absent in no-DSN builds. In overlay windows it is present, but its IPC is denied (no capability).
- Produces: `export function reportCaughtError(error: unknown, errorInfo: { componentStack?: string }): void`. The same file declares `interface Window { Sentry?: { captureException(error: unknown, hint?: unknown): unknown } }` in `declare global`.

- [ ] **Step 1: Write the failing tests** in `src/tests/report-caught-error.test.ts`:
  - `sends the error with its component stack when the SDK is present`. Set `window.Sentry = { captureException: vi.fn() }`. Call `reportCaughtError(err, { componentStack: "\n  at Boom" })`. Expect `captureException` toHaveBeenCalledWith `(err, { contexts: { react: { componentStack: "\n  at Boom" } } })`. Expect a `console.error` spy toHaveBeenCalledWith `(err, "\n  at Boom")`.
  - `does not throw without the SDK`. `delete window.Sentry`. The call does not throw, and `console.error` is still called.
  - `still logs when the SDK throws`. `captureException` throws. The call does not throw, and `console.error` is still called.
  - Restore `window.Sentry` and the spy in `afterEach`.

- [ ] **Step 2: Extend `src/tests/main-entry.test.tsx`.**
  - Make the `createRoot` mock record its second argument into `h.rootOptions` (reset in `beforeEach`).
  - Add `reportCaughtError: vi.fn()` to `h`, and `vi.mock("@/lib/report-caught-error", () => ({ reportCaughtError: h.reportCaughtError }))`. A mock is needed because `boot` calls `vi.resetModules()`, so a directly imported `reportCaughtError` would be a different instance from the one `main.tsx` gets.
  - Add `it.each(["main", "dashboard"])("passes reportCaughtError as onCaughtError in %s")`: `boot(label)` → `expect(h.rootOptions[0]?.onCaughtError).toBe(h.reportCaughtError)`.
  - Add a separate `it("does not pass onCaughtError in overlay windows")`: `boot("capture-overlay-0")` → `expect(h.rootOptions[0]?.onCaughtError).toBeUndefined()`. Each `it` boots once, so index 0 is always that boot's root.
  - The existing tests must stay unchanged and passing.

- [ ] **Step 3: Run to see them fail.** Run `npx vitest run src/tests/report-caught-error.test.ts src/tests/main-entry.test.tsx`. Expected: the new tests FAIL. The module is not found, and `onCaughtError` is undefined.

- [ ] **Step 4: Implement `reportCaughtError`** in `src/lib/report-caught-error.ts`:
  - Wrap `window.Sentry?.captureException(...)` in try/catch.
  - Then always `console.error(error, errorInfo.componentStack)`. The handler replaces React's default logging, so it must log itself.
  - Add a one-line comment saying why: React 19 does not send boundary-caught errors to `window.onerror`.

- [ ] **Step 5: Wire it.** In `src/main.tsx`, import it. Pass `{ onCaughtError: reportCaughtError }` as the second argument of the non-overlay `ReactDOM.createRoot(...)` only. Overlay windows have no capability (spec Non-goals).

- [ ] **Step 6: Run the tests and checks.**
  - Run the Step 3 command. Expected: all pass.
  - Run `npm run lint`. Expected: clean.
  - Run `npm run type-check`. Expected: clean.

- [ ] **Step 7: Commit** the three files plus `main.tsx`: `feat(sentry): report render errors caught by error boundaries`.

### Task 4: Release debug info and CI symbol upload

**Files:**
- Modify: `src-tauri/Cargo.toml` (new `[profile.release]`)
- Modify: `.github/workflows/publish.yml`
- Modify: `.github/workflows/macos-test-build.yml`

**Interfaces:**
- Consumes: the `SENTRY_DSN` `build.rs` passthrough (Task 1) and the `crash-test` feature (Task 2).
- Produces: none.

- [ ] **Step 1: Release profile.** Add `[profile.release]` with `debug = "line-tables-only"` and `split-debuginfo = "packed"`.

- [ ] **Step 2: `publish.yml`.**
  - Give each `matrix.include` entry a `symbols` key:
    - `src-tauri/target/aarch64-apple-darwin/release` (macOS arm64)
    - `src-tauri/target/x86_64-apple-darwin/release` (macOS x64)
    - `src-tauri/target/release` (Ubuntu and Windows)
  - In "Create environment file", append `echo "SENTRY_DSN=${{ secrets.SENTRY_DSN }}" >> src-tauri/.env`.
  - Add `SENTRY_DSN: ${{ secrets.SENTRY_DSN }}` to the "Build & publish" `env`.
  - Append a new **last** step, "Upload debug symbols to Sentry", after "Upload stable-name copies". It needs:
    - `shell: bash`;
    - `env` with `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, `SENTRY_PROJECT` from secrets.

    Its script, in this order:
    1. `[ -n "$SENTRY_AUTH_TOKEN" ] || { echo "SENTRY_AUTH_TOKEN not set; skipping"; exit 0; }`
    2. `set -euo pipefail`
    3. `npm i -g @sentry/cli@3.8.2`
    4. `sentry-cli debug-files upload --include-sources "${{ matrix.symbols }}"/meetwings*`. The glob covers the binary, `.dSYM`, `.pdb` or `.dwp`, and skips `deps/`.

- [ ] **Step 3: `macos-test-build.yml`.**
  - Add the same `.env` line and `SENTRY_DSN` build env.
  - Change `args` to `--target ${{ matrix.target }} --bundles dmg --features crash-test --config ${{ runner.temp }}/no-updater.json`.
  - Append the same upload step as the last step, with `"src-tauri/target/${{ matrix.target }}/release"/meetwings*`.

- [ ] **Step 4: Validate.**
  - Run `python3 -I -c 'import sys,yaml; [yaml.safe_load(open(f)) for f in sys.argv[1:]]' .github/workflows/publish.yml .github/workflows/macos-test-build.yml`. Expected: no error.
  - Run `grep -c crash-test .github/workflows/publish.yml`. Expected: `0`.

- [ ] **Step 5: Commit** `Cargo.toml` and both workflows: `ci(sentry): ship split debug info and upload it to Sentry`.

### Task 5: Linux end-to-end verification

No product code, unless a check fails. A failure is fixed in the owning task's files and committed as `fix(sentry): <what>`.

**Files:**
- Create (scratch, not committed): a fake Sentry endpoint script in the session scratchpad.

**Interfaces:**
- Consumes: everything above.
- Produces: none.

- [ ] **Step 1: Fake endpoint.**
  - Write a stdlib `http.server` script that listens on `127.0.0.1:8977` and answers every POST with `200 {}`.
  - For each request, append one line to `envelopes.log`: the path, plus each envelope item header's `type` (`event`, `attachment`, `session`, ...). For `event` items, also the first `exception.values[].value`.
  - Decompress `gzip` bodies if `Content-Encoding` says so.
  - Throughout Steps 2-5, `pgrep -fc '^Crash Reporter \(Sentry Rust SDK\)'` counts reporters. The parentheses must be escaped: `pgrep` reads an extended regex.

- [ ] **Step 2: Run with a DSN and `crash-test`.**
  - Run from the repo root, with `HTTP_PROXY HTTPS_PROXY http_proxy https_proxy` removed via `env -u`. `sentry` turns these into explicit proxies, and `NO_PROXY` does not bypass them.
  - Command: `SENTRY_DSN=http://k@127.0.0.1:8977/1 xvfb-run -a dbus-run-session -- bash -c 'env | grep -E "^(DISPLAY|DBUS_SESSION_BUS_ADDRESS)=" > <scratchpad>/session.env; exec npm run tauri dev -- --features crash-test'`. `session.env` lets Step 5 reach the same display and bus.
  - Expected:
    - the app window comes up;
    - the reporter count is `1`.

- [ ] **Step 3: Panic and abort.**
  - Relaunch with `MEETWINGS_CRASH_TEST=panic`. Expected: an `event` line in `envelopes.log`.
  - Relaunch with `MEETWINGS_CRASH_TEST=abort`. Expected: a line with `event` and `attachment` (the minidump) from the reporter.

- [ ] **Step 4: JS errors.**
  - Make a temporary, uncommitted edit to `src/main.tsx`. It schedules `setTimeout(() => { throw new Error("sentry-js-test " + windowLabel) }, 3000)` and `setTimeout(() => Promise.reject(new Error("sentry-js-rejection " + windowLabel)), 3000)` in every window.
  - Relaunch. Expected: 4 `event` lines, one per error per window (`main` and `dashboard`), told apart by the label in the logged exception value. `setup` creates the dashboard at startup (`src-tauri/src/lib.rs:317-322`), so no opening is needed.
  - Across Steps 2-4, `envelopes.log` has no `session` item (no session tracking).
  - Revert with `git checkout src/main.tsx`.

- [ ] **Step 5: Second instance.**
  - With the app running, start a second instance on the same display and bus: `env $(cat <scratchpad>/session.env) SENTRY_DSN=http://k@127.0.0.1:8977/1 src-tauri/target/debug/meetwings; echo $?` (proxy vars still removed).
  - Expected: the second process exits with `0`, and `envelopes.log` gets no new `event` line.
  - After 6 s, the reporter count is `1`.

- [ ] **Step 6: No DSN.**
  - Relaunch with `SENTRY_DSN` unset and `.env` without it. Expected:
    - the build script reruns (`rerun-if-env-changed`);
    - the app starts;
    - the reporter count is `0`;
    - `envelopes.log` gets nothing new.

- [ ] **Step 7: Linux release symbols.**
  - Run `cargo +1.99.1 build --manifest-path src-tauri/Cargo.toml --release`.
  - Run `sentry-cli debug-files check src-tauri/target/release/meetwings`, and the same on `meetwings.dwp` if present.
  - Expected: debug info with line info ("has debug info" / "has symbols").
  - If it lacks line info: matrix entries in `publish.yml` have no `env`, and the "Build & publish" `env` is shared. So add a `split_debuginfo` key to every matrix entry (`off` for Ubuntu, `packed` for the rest), map it in that `env` as `CARGO_PROFILE_RELEASE_SPLIT_DEBUGINFO: ${{ matrix.split_debuginfo }}`, and commit.

- [ ] **Step 8: Report.**
  - List each of Steps 2-7 as passed, failed and fixed, or not run (with why).
  - Kill the app, the reporter and the fake endpoint.
  - The spec's CI-dispatch and macOS checks stay with the owner (they need the
    Sentry secrets and a Mac). List them as "owner" in the report.
