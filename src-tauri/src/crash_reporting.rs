use sentry::types::Dsn;

/// Parses a compiled-in DSN; empty or invalid means crash reporting is off.
pub(crate) fn parse_dsn(raw: Option<&str>) -> Option<Dsn> {
    let raw = raw?.trim();
    if raw.is_empty() {
        return None;
    }
    match raw.parse() {
        Ok(dsn) => Some(dsn),
        // Never log the value: the DSN holds a key.
        Err(_) => {
            tracing::warn!("SENTRY_DSN is set but not a valid DSN; crash reporting disabled");
            None
        }
    }
}

/// The minidump integration re-executes this binary as the crash reporter; that process never
/// returns from `sentry::init` (`run_crash_reporter` is `-> !`), so this must run before `tauri::Builder`.
pub(crate) fn init() -> Option<(sentry::ClientInitGuard, tauri_plugin_sentry::Sentry)> {
    let dsn = parse_dsn(option_env!("SENTRY_DSN"))?;
    let plugin = tauri_plugin_sentry::Sentry::new();
    // ClientOptions is non-exhaustive: no struct-literal syntax outside the crate.
    let mut options = sentry::ClientOptions::default();
    options.dsn = Some(dsn);
    options.release = sentry::release_name!();
    let options = options
        .add_integration(plugin.clone())
        .add_integration(sentry::integrations::minidump::MinidumpIntegration::new());
    Some((sentry::init(options), plugin))
}

#[cfg(feature = "crash-test")]
#[derive(Debug, PartialEq)]
enum CrashKind {
    Panic,
    Abort,
}

#[cfg(feature = "crash-test")]
fn crash_kind(raw: Option<&str>) -> Option<CrashKind> {
    match raw? {
        "panic" => Some(CrashKind::Panic),
        "abort" => Some(CrashKind::Abort),
        _ => None,
    }
}

/// Real, non-inlined function so its name shows up in the Sentry stack frame.
#[cfg(feature = "crash-test")]
#[inline(never)]
fn sentry_crash_test(kind: CrashKind) -> ! {
    match kind {
        CrashKind::Panic => panic!("sentry crash test"),
        CrashKind::Abort => std::process::abort(),
    }
}

/// Crashes on purpose when `MEETWINGS_CRASH_TEST` is `panic` or `abort`, to verify reports arrive.
#[cfg(feature = "crash-test")]
pub(crate) fn maybe_crash_test() {
    if let Some(kind) = crash_kind(std::env::var("MEETWINGS_CRASH_TEST").ok().as_deref()) {
        sentry_crash_test(kind);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
}

#[cfg(all(test, feature = "crash-test"))]
mod crash_test_tests {
    use super::*;

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
}
