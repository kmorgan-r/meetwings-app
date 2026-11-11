//! Notion personal access token in the OS keychain.
//!
//! Notion token: deliberately returns the credential to the webview (spec
//! 7/9: plugin-http + JS redactor). Not a Graph payload. Mirrors
//! graph/keychain.rs, including the Linux split: with only the native
//! keyring backends enabled, Linux resolves to an in-memory mock that would
//! "succeed" without persisting, so Linux refuses everything instead.
//! Error strings are fixed and never echo the token or keyring details.

#[cfg_attr(target_os = "linux", allow(dead_code))]
const SERVICE: &str = "com.meetwings.notion";
#[cfg_attr(target_os = "linux", allow(dead_code))]
const ACCOUNT: &str = "token";
const NO_KEYCHAIN: &str = "The system keychain isn't available on this computer.";

#[cfg(not(target_os = "linux"))]
fn entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, ACCOUNT).map_err(|_| NO_KEYCHAIN.to_string())
}

#[cfg_attr(target_os = "linux", allow(dead_code))]
fn clean(token: &str) -> Result<&str, String> {
    let t = token.trim();
    if t.is_empty() {
        Err("The Notion token is empty.".to_string())
    } else {
        Ok(t)
    }
}

#[cfg(target_os = "linux")]
#[tauri::command(async)]
pub fn notion_keychain_available() -> bool {
    false
}

/// Reports platform support only; real access failures surface through
/// `notion_token_get`, which yields NOTION_KEYCHAIN_UNAVAILABLE at send time.
#[cfg(not(target_os = "linux"))]
#[tauri::command(async)]
pub fn notion_keychain_available() -> bool {
    true
}

#[cfg(target_os = "linux")]
#[tauri::command(async)]
pub fn notion_token_set(token: String) -> Result<(), String> {
    let _ = token;
    Err(NO_KEYCHAIN.to_string())
}

#[cfg(not(target_os = "linux"))]
#[tauri::command(async)]
pub fn notion_token_set(token: String) -> Result<(), String> {
    let t = clean(&token)?;
    entry()?.set_password(t).map_err(|_| NO_KEYCHAIN.to_string())
}

#[cfg(target_os = "linux")]
#[tauri::command(async)]
pub fn notion_token_get() -> Result<Option<String>, String> {
    Err(NO_KEYCHAIN.to_string())
}

/// `Ok(None)` means no entry, which is not an error.
#[cfg(not(target_os = "linux"))]
#[tauri::command(async)]
pub fn notion_token_get() -> Result<Option<String>, String> {
    match entry()?.get_password() {
        Ok(t) => Ok(Some(t)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err(NO_KEYCHAIN.to_string()),
    }
}

#[cfg(target_os = "linux")]
#[tauri::command(async)]
pub fn notion_token_clear() -> Result<(), String> {
    Err(NO_KEYCHAIN.to_string())
}

#[cfg(not(target_os = "linux"))]
#[tauri::command(async)]
pub fn notion_token_clear() -> Result<(), String> {
    match entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err(NO_KEYCHAIN.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_token_is_rejected_without_echo() {
        assert!(clean("  \n").is_err());
        assert_eq!(clean("  secret_abc\n").unwrap(), "secret_abc");
    }
}
