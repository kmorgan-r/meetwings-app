//! A refresh token at rest, keyed by a per-provider service name, and the ONLY
//! place OAuth touches disk.
//!
//! On Linux with no Secret Service running, `available()` is false and the
//! caller REFUSES TO PERSIST and re-authenticates each launch. A silent
//! plaintext fallback is not acceptable: src/lib/secure-storage.ts is
//! plaintext JSON on disk and says so in its own doc comment - that is the one
//! existing pattern this feature must not copy.

pub const ACCOUNT: &str = "refresh-token";

/// The keychain is unreachable or refused the operation. Providers map this to
/// their own error string.
#[derive(Debug, PartialEq, Eq)]
pub struct NoKeychain;

fn entry(service: &str) -> Result<keyring::Entry, NoKeychain> {
    keyring::Entry::new(service, ACCOUNT).map_err(|_| NoKeychain)
}

/// **Linux is hard-coded to `false` rather than probed.** With only
/// `windows-native`/`apple-native` enabled, `keyring::Entry::new` on Linux
/// resolves to the crate's in-memory `mock` backend, and an empty mock entry's
/// `get_password()` returns `NoEntry` - the SAME variant a real, working
/// keychain returns for "nothing stored yet." The heuristic below would report
/// `true` on a backend that cannot hold a secret past process exit, which is
/// the opposite of "refuse to persist". This closes the decision Cargo.toml's
/// `keyring` comment left open, without adding `sync-secret-service` /
/// `dbus-secret-service` (which pulls libdbus as a build-time dependency).
#[cfg(target_os = "linux")]
pub fn available(_service: &str) -> bool {
    false
}

/// Whether a keychain service is reachable at all. Only compiled on
/// non-Linux targets - see the `cfg(target_os = "linux")` stub above. Probed by
/// opening an entry and reading it: a locked keychain, no login session, or
/// similar platform-level unavailability fails at the
/// `PlatformFailure`/`NoStorageAccess` boundary matched below.
///
/// **This is a HEURISTIC and callers must not trust it alone.** It decides by
/// matching error variants. Guessing wrong is expensive: `available()` returns
/// true, the write then fails, and a connect errors AFTER the authorization
/// code has already been burnt. Callers therefore also degrade to session-only
/// on a persist FAILURE; this function is only the fast path.
///
/// `NoEntry` is success: it means the keychain answered, and answered "nothing
/// stored yet" - the normal state before a first connect.
#[cfg(not(target_os = "linux"))]
pub fn available(service: &str) -> bool {
    match entry(service) {
        Ok(e) => !matches!(
            e.get_password(),
            Err(keyring::Error::PlatformFailure(_)) | Err(keyring::Error::NoStorageAccess(_))
        ),
        Err(_) => false,
    }
}

/// On Linux the mock backend would accept this write and return `Ok(())` while
/// holding the token only in memory for the life of the process - "pretending
/// persistence worked," which the refuse-to-persist rule forbids. So this
/// refuses outright on Linux rather than reporting a false success.
#[cfg(target_os = "linux")]
pub fn store(_service: &str, _token: &str) -> Result<(), NoKeychain> {
    Err(NoKeychain)
}

#[cfg(not(target_os = "linux"))]
pub fn store(service: &str, token: &str) -> Result<(), NoKeychain> {
    entry(service)?.set_password(token).map_err(|_| NoKeychain)
}

/// `Ok(None)` means "no entry", which is NOT an error - it is the normal state
/// before a first connect and after a disconnect.
pub fn load(service: &str) -> Result<Option<String>, NoKeychain> {
    match entry(service)?.get_password() {
        Ok(token) => Ok(Some(token)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err(NoKeychain),
    }
}

pub fn delete(service: &str) -> Result<(), NoKeychain> {
    match entry(service)?.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        // A keychain-access failure, not a network one: calling it NETWORK
        // would send the user chasing their connection over a problem that has
        // nothing to do with the network.
        Err(_) => Err(NoKeychain),
    }
}

#[cfg(test)]
mod tests {
    #[cfg(target_os = "linux")]
    #[test]
    fn linux_refuses_to_store() {
        use super::*;
        assert_eq!(store("svc", "t"), Err(NoKeychain));
        assert!(!available("svc"));
    }
}
