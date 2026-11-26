# Sentry crash reporting — design (short)

## Intent

A colleague's Meetwings on macOS crashes intermittently. Today nothing records
why: Rust `tracing` goes to stdout (lost in a shipped build), there is no panic
hook, no global JS error handler, and `detection.log` covers meeting detection
only. We want crashes uploaded automatically so the cause can be diagnosed
without the colleague having to notice, find and send files.

Audience: colleagues only, for now. Not yet a public-user feature.

## Goals

- Capture Rust panics, frontend JS errors (uncaught errors, unhandled
  rejections, and render errors caught by React error boundaries), and native
  crashes (segfaults in `cidre` / `tauri-nspanel` / `xcap`, as minidumps) and
  upload them to Sentry.
- Native stacks readable in Sentry (function + file:line), not bare addresses.
- Off unless a DSN is compiled in, the same way `POSTHOG_API_KEY` works.

## Non-goals (later)

- Opt-in setting and scrubbing of transcript text. Required before public
  users get a build with a DSN; not needed for colleagues.
- JS source-map upload. JS stacks stay minified for now.
- WebKit content-process crash reports (blank window on macOS). Needs
  `tauri-plugin-sentry` 0.9, which needs Tauri ≥ 2.12; the lockfile is on
  2.8.2. Comes with the next Tauri bump.
- Release-health (session) tracking. Tauri's event loop ends the process with
  `std::process::exit` (`.run(...)` at `src-tauri/src/lib.rs:401-403` never
  returns), so the Sentry guard never drops and sessions never end cleanly;
  crash-free-rate numbers would be wrong.
- Error reports from the `capture-overlay-*` windows. No capability covers
  them (both capability files list only `main` and `dashboard`), so the
  injected SDK's IPC calls there are denied. Revisit if overlays turn out to
  crash.

## Anti-goals

- Sentry setup that can stop the app starting, or that fights
  `tauri-plugin-single-instance`.
- A build that fails when the Sentry secrets are absent (forks, local builds).
- Deliberately attaching transcripts, screenshots or meeting text to events.

## Approaches

- **A. Local crash log** — panic hook + JS error handler writing to a file in
  the app data dir; native crashes left to macOS `.ips` reports. ~40 lines, no
  service, but colleagues must notice and send files. Not picked: intermittent
  crashes on someone else's machine slip through.
- **B. Sentry via `tauri-plugin-sentry`** — **picked.** One plugin covers
  panics, JS errors (it injects `@sentry/browser` into every webview as
  `window.Sentry`, no npm package needed) and native minidumps. Automatic
  upload and grouping.
- **C. PostHog error tracking** — already wired, but cannot capture native
  crashes, the likeliest cause on macOS. Dropped.

## Design

1. **Dependencies** (`src-tauri/Cargo.toml`):
   `sentry = { version = "0.49.3", features = ["minidump"] }`,
   `tauri-plugin-sentry = "=0.8.0"`. Pinned: 0.8.0 is the newest release that
   accepts Tauri `^2` (0.9.0 requires `^2.12`). `0.49.3` is the first `sentry`
   with the `minidump` feature; the app names `MinidumpIntegration` directly, so
   it asks for the feature itself instead of relying on the plugin's default
   feature.
2. **Debug info** (`[profile.release]`): `debug = "line-tables-only"`,
   `split-debuginfo = "packed"`, so symbols go to a separate file (dSYM on
   macOS) instead of growing the shipped binary. Linux `packed` produces split
   DWARF (`.dwp`); see Verification for the Linux fallback.
3. **DSN** (`src-tauri/build.rs`): pass `SENTRY_DSN` through to
   `cargo:rustc-env`, like `POSTHOG_API_KEY`. Also emit
   `cargo:rerun-if-env-changed=SENTRY_DSN`, and `cargo:rerun-if-changed=.env`
   only when `.env` exists (cargo treats a missing path as always stale, which
   would rebuild every fork and fresh clone). `tauri_build::build()` emits its
   own `rerun-if` lines, so without these cargo keeps replaying a stale DSN after
   it changes.
4. **Init** (`src-tauri/src/lib.rs`, `run()`): right after `init_tracing()` and
   before `tauri::Builder`, read `option_env!("SENTRY_DSN")` and parse it with
   `.parse::<sentry::types::Dsn>().ok()`. Do not use the
   `sentry::init((dsn, opts))` tuple form, which panics on a malformed DSN.
   Empty or unparseable → `tracing::warn!` (unparseable only), and skip both
   init and the plugin. No crash-reporter process starts.
   Valid DSN → `sentry::init` with the plugin as an integration,
   `MinidumpIntegration`, `release_name!()`, and `environment` =
   `development` in debug builds. No session tracking (see Non-goals). Keep the
   guard bound in `run()`. Then add the plugin to the builder.
   The plugin is only added when init ran: its `initialize` returns `Err` when
   no Sentry client exists (`tauri-plugin-sentry-0.8.0/src/lib.rs:107-109`),
   which would stop startup.
   The minidump integration re-runs the same executable as a crash-reporter
   process, and everything before `sentry::init` runs in both. The reporter
   never returns from `sentry::init`: `run_crash_reporter` is `-> !` and calls
   `exit(0)` or `exit(1)` (`sentry-minidump-0.49.3/src/lib.rs:394-433`). Because
   init sits before the builder, the reporter never reaches the single-instance
   plugin. This must be checked on a real Mac (see Verification).
5. **Capability**: add `sentry:default` to `capabilities/default.json` (macOS)
   and `capabilities/cross-platform.json` (Windows, Linux).
6. **Render errors** (`src/main.tsx`): React 19 sends errors caught by an error
   boundary to `console.error`, not `window.onerror`, so the injected SDK only
   records a breadcrumb. Pass `onCaughtError` to the `createRoot` call that
   renders `main` and `dashboard` (not the overlay root; see Non-goals): call
   `window.Sentry?.captureException(error)` (absent when no DSN), then keep the
   default `console.error` output. A vitest test pins the handler: it calls
   `captureException` when `window.Sentry` exists, does not throw when it is
   absent, and still logs.
7. **Optional crash trigger**: a `crash-test` cargo feature, off by default,
   defined as `crash-test = ["tauri/devtools"]` so a release test build also
   has devtools for the JS checks.
   When on, `MEETWINGS_CRASH_TEST=panic|abort`, checked right after
   `sentry::init`, calls a named function
   (`sentry_crash_test`) that panics or calls `std::process::abort()`.
   `macos-test-build.yml` builds with `--features crash-test`; `publish.yml`
   never does, so public builds carry no trigger.
8. **CI** (`publish.yml`, `macos-test-build.yml`): add `SENTRY_DSN` to the
   generated `.env` and to the build env. Add an upload step as the **last**
   step of the job, so a failed symbol upload cannot skip any existing step
   (e.g. publish.yml's "Upload stable-name copies"). The step:
   - sets `shell: bash` (the Windows runner defaults to pwsh, where the guard
     below is a parse error);
   - maps `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, `SENTRY_PROJECT` into its `env`;
   - starts its script with `[ -n "$SENTRY_AUTH_TOKEN" ] || exit 0`, because
     `secrets.*` is not allowed in a step `if:`;
   - installs the CLI with `npm i -g @sentry/cli@<pinned version>` (Node is
     already set up in both workflows);
   - runs `sentry-cli debug-files upload --include-sources` on the build
     output: `src-tauri/target/<triple>/release` for the macOS entries (built
     with `--target`), `src-tauri/target/release` for Ubuntu and Windows.
   Note: once `SENTRY_DSN` is set, public GitHub releases report crashes too.
   That is acceptable while colleagues are the only users.
9. **Privacy defaults**: `send_default_pii` stays off. Default JS breadcrumbs
   (console, fetch URLs) stay on for diagnosis; revisit with the opt-in work.

## Verification

- **Linux, here.** Prerequisites: the Tauri Linux system deps (as in
  publish.yml's Ubuntu step), `xvfb-run` for a display, and `dbus`
  (single-instance). Run the app with `HTTP_PROXY`, `HTTPS_PROXY`,
  `http_proxy` and `https_proxy` unset (`env -u ...`): `sentry` copies them
  into explicit proxy settings (`sentry-0.49.3/src/defaults.rs:99-110`), which
  `NO_PROXY` does not override, so events to the local fake DSN would go to the
  outbound proxy instead. With
  `SENTRY_DSN=http://key@127.0.0.1:<port>/1` and `--features crash-test`:
  - `MEETWINGS_CRASH_TEST=panic` → an event arrives;
    `MEETWINGS_CRASH_TEST=abort` → a minidump envelope arrives.
  - From devtools, throw an uncaught error and an unhandled rejection in both
    the `main` and `dashboard` windows; an event arrives for each.
    Boundary-caught render errors are covered by the vitest test (step 6).
  - `ps` shows exactly one `Crash Reporter (Sentry Rust SDK)` per app process.
  - Rebuild with `SENTRY_DSN` empty: the app starts normally, and `ps` shows no
    reporter process.
  - Run `sentry-cli debug-files check` on a Linux release binary and its
    `.dwp`. If line info is missing, set
    `CARGO_PROFILE_RELEASE_SPLIT_DEBUGINFO=off` for the Ubuntu job only.
- **CI.** Dispatch `macos-test-build.yml` before the Sentry secrets exist: the
  build passes and the upload step exits early. Dispatch it again after: the
  upload step runs and Sentry lists the dSYM.
- **macOS, a colleague or the owner.** Install a `macos-test-build.yml` DMG
  built with the DSN. Then confirm:
  - the app starts, and the dashboard does not pop up at plain startup;
  - a second launch with `open -n` (or the binary path) still focuses the
    dashboard; after waiting ~5 s (the reporter's stale timeout,
    `minidumper-child-0.5.0/src/lib.rs:70`), `ps` shows one app process and one
    reporter;
  - running the binary from Terminal with `MEETWINGS_CRASH_TEST=abort` puts a
    crash in Sentry whose frames show `sentry_crash_test` with file:line;
  - a JS error thrown from the dashboard's devtools reaches Sentry (this proves
    the macOS capability file).

## Owner to-do

Create a Sentry project (platform: Rust). Add repo secrets `SENTRY_DSN`,
`SENTRY_AUTH_TOKEN` (scope `project:releases` + `project:write`), `SENTRY_ORG`,
`SENTRY_PROJECT`.

## Left to the builder

The pinned `@sentry/cli` version.
