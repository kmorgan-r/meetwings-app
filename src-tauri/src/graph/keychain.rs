//! The Graph refresh token at rest. The keychain logic (including the Linux
//! refuse-to-persist rule) lives in `crate::oauth::keychain`; this file pins
//! Graph's service name and its `GRAPH_*` error string.

use super::NO_KEYCHAIN;
use crate::oauth::keychain;

const SERVICE: &str = "com.meetwings.graph";

pub fn available() -> bool {
    keychain::available(SERVICE)
}

pub fn store_refresh_token(token: &str) -> Result<(), String> {
    keychain::store(SERVICE, token).map_err(|_| NO_KEYCHAIN.to_string())
}

/// `Ok(None)` means "no entry", which is NOT an error - it is the normal state
/// before a first connect and after a disconnect.
pub fn load_refresh_token() -> Result<Option<String>, String> {
    keychain::load(SERVICE).map_err(|_| NO_KEYCHAIN.to_string())
}

pub fn delete_refresh_token() -> Result<(), String> {
    keychain::delete(SERVICE).map_err(|_| NO_KEYCHAIN.to_string())
}
