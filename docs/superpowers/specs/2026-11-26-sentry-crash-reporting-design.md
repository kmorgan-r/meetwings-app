# Sentry crash reporting — design (short)

## Intent

A colleague's Meetwings on macOS crashes intermittently. Today nothing records
why: Rust `tracing` goes to stdout (lost in a shipped build), there is no panic
hook, no global JS error handler, and `detection.log` covers meeting detection
only. We want crashes uploaded automatically so the cause can be diagnosed
without the colleague having to notice, find and send files.

Audience: colleagues only, for now. Not yet a public-user feature.

## Goals

- Capture Rust panics, frontend JS errors, and native crashes (segfaults in
  `cidre` / `tauri-nspanel` / `xcap`, as minidumps) and upload them to Sentry.
- Native stacks readable in Sentry (function + file:line), not bare addresses.
- Off unless a DSN is compiled in, the same way `POSTHOG_API_KEY` works.

## Non-goals (later)

- Opt-in setting and scrubbing of transcript text. Required before public
  users get a build with a DSN; not needed for colleagues.
- JS source-map upload. JS stacks stay minified for now.
- WebKit content-process crash reports (blank window on macOS). Needs
  `tauri-plugin-sentry` 0.9, which needs Tauri ≥ 2.12; the lockfile is on
  2.8.2. Comes with the next Tauri bump.

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
  panics, JS errors (it injects `@sentry/browser` into every webview, no npm
  package needed) and native minidumps. Automatic upload and grouping.
- **C. PostHog error tracking** — already wired, but cannot capture native
  crashes, the likeliest cause on macOS. Dropped.

## Design

1. **Dependencies** (`src-tauri/Cargo.toml`): `sentry = "0.49"`,
   `tauri-plugin-sentry = "=0.8.0"`. Pinned: 0.8.0 is the newest release that
   accepts Tauri `^2` (0.9.0 requires `^2.12`). Default features (includes
   `minidump`).
2. **Debug info** (`[profile.release]`): `debug = "line-tables-only"`,
   `split-debuginfo = "packed"`, so symbols go to a separate file (dSYM on
   macOS) instead of growing the shipped binary.
3. **DSN** (`src-tauri/build.rs`): pass `SENTRY_DSN` through to
   `cargo:rustc-env`, like `POSTHOG_API_KEY`.
4. **Init** (`src-tauri/src/lib.rs`, `run()`): right after `init_tracing()` and
   before `tauri::Builder`, when `option_env!("SENTRY_DSN")` is non-empty:
   `sentry::init` with the plugin as an integration, `MinidumpIntegration`,
   `release_name!()`, `environment` = `development` in debug builds, session
   tracking on. Keep the guard alive for the whole of `run()`. Add the plugin
   to the builder. When the DSN is empty, do neither, so no crash-reporter
   process starts.
   The minidump integration re-runs the same executable as a crash-reporter
   process, and everything before `sentry::init` runs in both. Because init sits
   before the builder, the reporter never reaches the single-instance plugin.
   This must be checked on a real Mac (see Verification).
5. **Capability**: add `sentry:default` to `capabilities/default.json` and
   `capabilities/cross-platform.json`.
6. **CI** (`publish.yml`, `macos-test-build.yml`): add `SENTRY_DSN` to the
   generated `.env` and to the build env. After the build, add a step that
   runs `sentry-cli debug-files upload --include-sources` on the target release
   dir, using `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, `SENTRY_PROJECT`. The step is
   skipped when `SENTRY_AUTH_TOKEN` is empty, so builds without the secrets
   still pass.
   Note: once `SENTRY_DSN` is set, public GitHub releases report crashes too.
   That is acceptable while colleagues are the only users.
7. **Privacy defaults**: `send_default_pii` stays off. Default JS breadcrumbs
   (console, fetch URLs) stay on for diagnosis; revisit with the opt-in work.

## Verification

- Linux, here: point `SENTRY_DSN` at a local fake endpoint, trigger a Rust panic
  and a native abort in a debug build, and confirm an event and a minidump
  envelope arrive. Confirm the app starts normally with the DSN empty.
- macOS, a colleague or the owner: install a `macos-test-build.yml` DMG built
  with the DSN, then confirm three things: the app starts, a second launch
  still focuses the dashboard, and a test crash appears in Sentry with
  symbolicated frames.

## Owner to-do

Create a Sentry project (platform: Rust). Add repo secrets `SENTRY_DSN`,
`SENTRY_AUTH_TOKEN` (scope `project:releases` + `project:write`), `SENTRY_ORG`,
`SENTRY_PROJECT`.

## Left to the builder

The exact panic/abort trigger used for verification (debug-only, not shipped),
and the target-dir path for each matrix entry in the upload step.
