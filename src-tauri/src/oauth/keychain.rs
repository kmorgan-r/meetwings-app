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

/// A primary entry holding `CHUNKED<n>` means the token is too long for one
/// credential and lives in accounts `refresh-token.1` ..= `refresh-token.<n>`.
const CHUNKED: &str = "meetwings-chunked:";

fn chunk(service: &str, i: usize) -> Result<keyring::Entry, NoKeychain> {
    keyring::Entry::new(service, &format!("{ACCOUNT}.{i}")).map_err(|_| NoKeychain)
}

/// store, load and delete each span several entries, and callers load without
/// their `persist_op` lock, so serialize them here: a load must never stitch
/// chunks from two different stores.
/// ponytail: one lock for every service; per-service if it ever contends.
fn op_lock() -> std::sync::MutexGuard<'static, ()> {
    static OP: std::sync::Mutex<()> = std::sync::Mutex::new(());
    OP.lock().unwrap_or_else(|e| e.into_inner())
}

/// Windows caps a credential blob at 2560 bytes (CRED_MAX_CREDENTIAL_BLOB_SIZE)
/// and keyring stores UTF-16, so 1280 units per entry. Microsoft refresh tokens
/// routinely exceed it; keyring then fails with `TooLong` and the connect used
/// to degrade to session-only, i.e. disconnect on every restart.
#[cfg(any(not(target_os = "linux"), test))]
const CHUNK_UNITS: usize = 1280;

/// Splits on `char` boundaries, so a surrogate pair is never cut in half.
#[cfg(any(not(target_os = "linux"), test))]
fn split_utf16(token: &str) -> Vec<&str> {
    let mut parts = Vec::new();
    let (mut start, mut units) = (0, 0);
    for (i, c) in token.char_indices() {
        if units + c.len_utf16() > CHUNK_UNITS {
            parts.push(&token[start..i]);
            (start, units) = (i, 0);
        }
        units += c.len_utf16();
    }
    parts.push(&token[start..]);
    parts
}

fn read(e: keyring::Entry) -> Result<Option<String>, NoKeychain> {
    match e.get_password() {
        Ok(s) => Ok(Some(s)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err(NoKeychain),
    }
}

/// Deletes chunk `i` and every chunk after it, stopping at the first gap.
fn delete_chunks_from(service: &str, mut i: usize) -> Result<(), NoKeychain> {
    loop {
        match chunk(service, i)?.delete_credential() {
            Ok(()) => i += 1,
            Err(keyring::Error::NoEntry) => return Ok(()),
            Err(_) => return Err(NoKeychain),
        }
    }
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

/// One entry when the token fits; chunks only when the backend says `TooLong`
/// (Windows), so storage elsewhere is unchanged.
///
/// ponytail: chunks are rewritten in place, so a store that fails midway under
/// an older marker leaves a mixed token; the refresh then fails and the user
/// reconnects. Alternate between two chunk sets if that ever matters.
#[cfg(not(target_os = "linux"))]
pub fn store(service: &str, token: &str) -> Result<(), NoKeychain> {
    let _op = op_lock();
    // A token that looks like the marker goes chunked, or load would misread it.
    let direct = !token.starts_with(CHUNKED)
        && match entry(service)?.set_password(token) {
            Ok(()) => true,
            Err(keyring::Error::TooLong(..)) => false,
            Err(_) => return Err(NoKeychain),
        };
    let used = if direct {
        0
    } else {
        let parts = split_utf16(token);
        for (i, part) in parts.iter().enumerate() {
            chunk(service, i + 1)?
                .set_password(part)
                .map_err(|_| NoKeychain)?;
        }
        // Marker last, so it never names a chunk that was not written.
        entry(service)?
            .set_password(&format!("{CHUNKED}{}", parts.len()))
            .map_err(|_| NoKeychain)?;
        parts.len()
    };
    // Chunks past `used` are left over from a longer token. Load never reads
    // them (the marker names its count), so a failed cleanup is garbage, not
    // corruption, and must not fail a store that landed: the caller would go
    // session-only with a good token on disk.
    let _ = delete_chunks_from(service, used + 1);
    Ok(())
}

/// `Ok(None)` means "no entry", which is NOT an error - it is the normal state
/// before a first connect and after a disconnect.
pub fn load(service: &str) -> Result<Option<String>, NoKeychain> {
    let _op = op_lock();
    let Some(head) = read(entry(service)?)? else {
        return Ok(None);
    };
    // Not a marker: a token that fit one entry, including every token written
    // by builds that predate chunking.
    let Some(count) = head.strip_prefix(CHUNKED) else {
        return Ok(Some(head));
    };
    // A damaged marker or a missing chunk reads as "not connected", never as a
    // partial token; the next connect rewrites the whole set.
    let Ok(count) = count.parse::<usize>() else {
        return Ok(None);
    };
    let mut token = String::new();
    for i in 1..=count {
        match read(chunk(service, i)?)? {
            Some(part) => token.push_str(&part),
            None => return Ok(None),
        }
    }
    Ok(Some(token))
}

pub fn delete(service: &str) -> Result<(), NoKeychain> {
    let _op = op_lock();
    match entry(service)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => {}
        // A keychain-access failure, not a network one: calling it NETWORK
        // would send the user chasing their connection over a problem that has
        // nothing to do with the network.
        Err(_) => return Err(NoKeychain),
    }
    delete_chunks_from(service, 1)
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

    #[test]
    fn split_utf16_cuts_at_the_limit_without_breaking_surrogate_pairs() {
        use super::*;
        assert_eq!(split_utf16(&"a".repeat(1280)).len(), 1);

        let ascii = "a".repeat(2000);
        let parts = split_utf16(&ascii);
        assert_eq!(
            parts.iter().map(|p| p.len()).collect::<Vec<_>>(),
            [1280, 720]
        );
        assert_eq!(parts.concat(), ascii);

        // 1279 units + a 2-unit pair = 1281: the pair moves whole to chunk 2.
        let astral = format!("{}\u{1F600}b", "a".repeat(1279));
        let parts = split_utf16(&astral);
        assert_eq!(parts, [&astral[..1279], "\u{1F600}b"]);
        assert_eq!(parts.concat(), astral);
    }

    /// Against the REAL Credential Manager, under a throwaway service name.
    #[cfg(windows)]
    #[test]
    fn long_tokens_round_trip_through_credential_manager() {
        use super::*;
        const SVC: &str = "com.meetwings.test-long-token";
        struct Cleanup;
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let _ = delete(SVC);
            }
        }
        let _cleanup = Cleanup;
        let _ = delete(SVC);
        let chunk_exists = |i| chunk(SVC, i).unwrap().get_password().is_ok();

        // A single entry written by a pre-chunking build loads unchanged.
        entry(SVC).unwrap().set_password("legacy-token").unwrap();
        assert_eq!(load(SVC), Ok(Some("legacy-token".to_string())));

        let three = "x".repeat(3000);
        store(SVC, &three).unwrap();
        assert_eq!(load(SVC), Ok(Some(three)));
        assert!(chunk_exists(3));

        // Fewer chunks than before: the stale third one must go.
        let two = "y".repeat(2000);
        store(SVC, &two).unwrap();
        assert_eq!(load(SVC), Ok(Some(two)));
        assert!(!chunk_exists(3));

        store(SVC, "short").unwrap();
        assert_eq!(load(SVC), Ok(Some("short".to_string())));
        assert!(!chunk_exists(1));

        // A token that looks like the marker is chunked, not misread.
        store(SVC, "meetwings-chunked:7").unwrap();
        assert_eq!(load(SVC), Ok(Some("meetwings-chunked:7".to_string())));

        // A damaged marker, or one naming a missing chunk, is "not connected".
        entry(SVC)
            .unwrap()
            .set_password("meetwings-chunked:x")
            .unwrap();
        assert_eq!(load(SVC), Ok(None));
        entry(SVC)
            .unwrap()
            .set_password("meetwings-chunked:2")
            .unwrap();
        assert_eq!(load(SVC), Ok(None));

        store(SVC, &"z".repeat(3000)).unwrap();
        delete(SVC).unwrap();
        assert_eq!(load(SVC), Ok(None));
        assert!(!chunk_exists(1));
        assert_eq!(delete(SVC), Ok(()));
    }
}
