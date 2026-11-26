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
