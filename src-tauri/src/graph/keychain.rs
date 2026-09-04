//! The refresh token at rest, and the ONLY place this feature touches disk.
//!
//! Isolated in its own file because Probe 2 (Task 1) decides what backs it:
//! `tauri-plugin-keychain`'s Rust API if it has one, the `keyring` crate
//! otherwise. Nothing else in the module changes with that answer.
//!
//! On Linux with no Secret Service running, `available()` is false and the
//! caller REFUSES TO PERSIST and re-authenticates each launch. A silent
//! plaintext fallback is not acceptable: src/lib/secure-storage.ts is
//! plaintext JSON on disk and says so in its own doc comment - that is the one
//! existing pattern this feature must not copy.

use super::NO_KEYCHAIN;

const SERVICE: &str = "com.meetwings.graph";
const ACCOUNT: &str = "refresh-token";

fn entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, ACCOUNT).map_err(|_| NO_KEYCHAIN.to_string())
}

/// **DEVIATION from the task brief, reported per its instructions:** the
/// brief's verbatim `available()` body (see the heuristic on the
/// `cfg(not(target_os = "linux"))` variant below) was written as the whole
/// function on every platform. On Linux that is the "keyring mock trap"
/// Cargo.toml's own `keyring` comment and the controller ruling for this task
/// both warn about: with only `windows-native`/`apple-native` enabled,
/// `keyring::Entry::new` on Linux resolves to the crate's in-memory `mock`
/// backend, and an empty mock entry's `get_password()` returns `NoEntry` -
/// the SAME variant a real, working keychain returns for "nothing stored
/// yet." `NoEntry` doesn't match `PlatformFailure`/`NoStorageAccess`, so the
/// heuristic below would report `true` on a backend that cannot actually
/// hold a secret past process exit. That is the opposite of "refuse to
/// persist": `store_refresh_token` would go on to "succeed" into memory that
/// evaporates at exit, and a caller trusting this signal would believe it has
/// a durable credential. So Linux is hard-coded to `false` here instead of
/// probed - closing the decision Cargo.toml's comment left for the
/// controller, without adding `sync-secret-service`/`dbus-secret-service`
/// (which the ruling reserves for the user, since it pulls libdbus as a
/// build-time dependency).
#[allow(dead_code)]
#[cfg(target_os = "linux")]
pub fn available() -> bool {
    false
}

/// Whether a keychain service is reachable at all. Only compiled on
/// non-Linux targets - see the `cfg(target_os = "linux")` stub above, which
/// never reaches this code and is hard-coded to `false` instead. Probed by
/// opening an entry and reading it: a locked keychain, no login session, or
/// similar platform-level unavailability fails at the
/// `PlatformFailure`/`NoStorageAccess` boundary matched below.
///
/// **This is a HEURISTIC and Task 11 must not trust it.** It decides by matching
/// error variants, and which variant an unavailable keychain actually produces
/// is a question Probe 2 records rather than one this code can know. Guessing
/// wrong here is expensive in the worst place: `available()` returns true, the
/// write then fails, and `graph_connect` errors AFTER `exchange_code` has already
/// burnt the authorization code - so a credential that was successfully obtained
/// is discarded and the user redoes the whole browser flow. Task 11 therefore
/// degrades to session-only on a persist FAILURE as well, and this function is
/// only the fast path.
///
/// `NoEntry` is success: it means the keychain answered, and answered "nothing
/// stored yet" - the normal state before a first connect.
#[allow(dead_code)]
#[cfg(not(target_os = "linux"))]
pub fn available() -> bool {
    match entry() {
        Ok(e) => !matches!(
            e.get_password(),
            Err(keyring::Error::PlatformFailure(_)) | Err(keyring::Error::NoStorageAccess(_))
        ),
        Err(_) => false,
    }
}

/// **DEVIATION, same root cause as `available()` above:** on Linux, the mock
/// backend would accept this write and return `Ok(())` while holding the
/// token only in memory for the life of the process - "pretending
/// persistence worked," which is precisely what the refuse-to-persist rule
/// forbids. A caller that only degrades to session-only on an `Err` (as the
/// brief describes for Task 11) would never see one. So this refuses
/// outright on Linux rather than reporting a false success.
#[cfg(target_os = "linux")]
pub fn store_refresh_token(_token: &str) -> Result<(), String> {
    Err(NO_KEYCHAIN.to_string())
}

#[cfg(not(target_os = "linux"))]
pub fn store_refresh_token(token: &str) -> Result<(), String> {
    entry()?
        .set_password(token)
        .map_err(|_| NO_KEYCHAIN.to_string())
}

/// `Ok(None)` means "no entry", which is NOT an error - it is the normal state
/// before a first connect and after a disconnect.
#[allow(dead_code)]
pub fn load_refresh_token() -> Result<Option<String>, String> {
    match entry()?.get_password() {
        Ok(token) => Ok(Some(token)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err(NO_KEYCHAIN.to_string()),
    }
}

#[allow(dead_code)]
pub fn delete_refresh_token() -> Result<(), String> {
    match entry()?.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        // NO_KEYCHAIN, matching store/load above. This is a keychain-access
        // failure and calling it NETWORK would send the user chasing their
        // connection over a problem that has nothing to do with the network.
        Err(_) => Err(NO_KEYCHAIN.to_string()),
    }
}
