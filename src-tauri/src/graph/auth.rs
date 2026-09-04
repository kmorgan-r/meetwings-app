use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rand::RngCore;
use sha2::{Digest, Sha256};

use super::AUTH_REJECTED;

/// `allow(dead_code)`: unused until Tasks 8, 9 and 11 wire the listener and
/// token lifecycle that call these - same reason `graph::mod` allows its
/// structs per-item.
#[allow(dead_code)]
pub struct Pkce {
    pub verifier: String,
    pub challenge: String,
}

/// URL-safe base64 of 32 CSPRNG bytes: 43 characters, inside RFC 7636's
/// 43..128 range, and made only of unreserved characters so it needs no
/// further escaping in the token request body.
#[allow(dead_code)]
pub fn random_token(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    rand::thread_rng().fill_bytes(&mut buf);
    URL_SAFE_NO_PAD.encode(buf)
}

/// S256: base64url(SHA256(ASCII(verifier))) over the RAW DIGEST BYTES.
/// Encoding the hex digest instead is the classic silent break.
#[allow(dead_code)]
pub fn challenge_for(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

#[allow(dead_code)]
pub fn new_pkce() -> Pkce {
    let verifier = random_token(32);
    let challenge = challenge_for(&verifier);
    Pkce { verifier, challenge }
}

/// A mismatched or absent `state` is rejected BEFORE the code is redeemed -
/// nothing is sent to the token endpoint.
#[allow(dead_code)]
pub fn validate_state(expected: &str, received: Option<&str>) -> Result<(), String> {
    match received {
        Some(value) if value == expected => Ok(()),
        _ => Err(AUTH_REJECTED.to_string()),
    }
}

/// The ID token's payload segment, decoded. NOT a signature verification: the
/// token arrived over TLS directly from the token endpoint, so this reads
/// claims rather than establishing trust.
#[allow(dead_code)]
fn id_token_claims(id_token: &str) -> Option<serde_json::Value> {
    let payload = id_token.split('.').nth(1)?;
    let bytes = URL_SAFE_NO_PAD.decode(payload).ok()?;
    serde_json::from_slice(&bytes).ok()
}

#[allow(dead_code)]
pub fn nonce_from_id_token(id_token: &str) -> Option<String> {
    Some(id_token_claims(id_token)?.get("nonce")?.as_str()?.to_string())
}

/// The nonce check, as its OWN function for the same reason `validate_state` is
/// one: a comparison inlined in an async `#[tauri::command]` body cannot be unit
/// tested, and this is a security check.
///
/// **An ABSENT `id_token` is a rejection, not a skip.** The scopes request
/// `openid profile` explicitly, so a token response without an ID token means
/// something other than what we asked for came back - and the earlier inline
/// form, guarded by `if let Some(id_token)`, would have silently accepted it and
/// bound nothing.
#[allow(dead_code)]
pub fn validate_nonce(expected: &str, id_token: Option<&str>) -> Result<(), String> {
    match id_token.and_then(nonce_from_id_token) {
        Some(actual) if actual == expected => Ok(()),
        _ => Err(AUTH_REJECTED.to_string()),
    }
}

/// `preferred_username`, falling back to `upn`.
///
/// Best-effort BY DESIGN. `/me` would return the primary SMTP address - the
/// exact string in `attendees[]` - but that needs `User.Read`, and widening a
/// mailbox-adjacent grant to improve a cosmetic exclusion is a bad exchange
/// when the failure mode is one extra visible row.
#[allow(dead_code)]
pub fn own_address_from_id_token(id_token: &str) -> Option<String> {
    let claims = id_token_claims(id_token)?;
    for key in ["preferred_username", "upn"] {
        if let Some(value) = claims.get(key).and_then(|v| v.as_str()) {
            if !value.trim().is_empty() {
                return Some(value.to_string());
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    /// RFC 7636 Appendix B's published vector. A hand-rolled S256 that base64s
    /// the HEX digest instead of the raw bytes still "looks right" and fails
    /// only against a real server - this vector is what catches it.
    #[test]
    fn pkce_challenge_matches_rfc7636_appendix_b() {
        let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        assert_eq!(
            challenge_for(verifier),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn pkce_verifier_is_url_safe_and_long_enough() {
        let pkce = new_pkce();
        assert!(pkce.verifier.len() >= 43 && pkce.verifier.len() <= 128);
        assert!(pkce
            .verifier
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "-._~".contains(c)));
        assert_eq!(pkce.challenge, challenge_for(&pkce.verifier));
    }

    #[test]
    fn random_tokens_do_not_repeat() {
        assert_ne!(random_token(32), random_token(32));
    }

    #[test]
    fn state_mismatch_is_rejected() {
        assert!(validate_state("abc", Some("abc")).is_ok());
        assert_eq!(validate_state("abc", Some("xyz")), Err(AUTH_REJECTED.to_string()));
        // A callback with no `state` at all is a mismatch, not a pass.
        assert_eq!(validate_state("abc", None), Err(AUTH_REJECTED.to_string()));
    }

    // Not a signature check - Entra's own transport is TLS and the token came
    // straight from the token endpoint. This reads the claim the flow binds.
    fn fake_id_token(claims: &str) -> String {
        use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
        format!("header.{}.sig", URL_SAFE_NO_PAD.encode(claims))
    }

    #[test]
    fn nonce_is_read_from_the_id_token() {
        let token = fake_id_token(r#"{"nonce":"n-123","preferred_username":"a@b.test"}"#);
        assert_eq!(nonce_from_id_token(&token), Some("n-123".to_string()));
    }

    /// The spec asks for "nonce validation in the returned ID token" — a
    /// REJECTION behaviour, not extraction. Extraction passing tells you
    /// nothing about whether a wrong nonce is refused.
    #[test]
    fn nonce_mismatch_is_rejected() {
        let good = fake_id_token(r#"{"nonce":"n-123"}"#);
        let wrong = fake_id_token(r#"{"nonce":"n-999"}"#);
        assert!(validate_nonce("n-123", Some(&good)).is_ok());
        assert_eq!(
            validate_nonce("n-123", Some(&wrong)),
            Err(AUTH_REJECTED.to_string())
        );
    }

    /// An ABSENT id_token, or one carrying no nonce claim, is a rejection - not
    /// a skip. The scopes ask for `openid profile` explicitly, so a response
    /// without an ID token is not what we requested, and an `if let Some(...)`
    /// guard around the comparison would accept it while binding nothing.
    #[test]
    fn a_missing_id_token_or_nonce_claim_is_rejected_not_skipped() {
        assert_eq!(validate_nonce("n-123", None), Err(AUTH_REJECTED.to_string()));
        let no_claim = fake_id_token(r#"{"sub":"x"}"#);
        assert_eq!(
            validate_nonce("n-123", Some(&no_claim)),
            Err(AUTH_REJECTED.to_string())
        );
        assert_eq!(
            validate_nonce("n-123", Some("not-a-jwt")),
            Err(AUTH_REJECTED.to_string())
        );
    }

    #[test]
    fn own_address_prefers_preferred_username() {
        let token =
            fake_id_token(r#"{"preferred_username":"k.morgan@corp.test","upn":"other@corp.test"}"#);
        assert_eq!(
            own_address_from_id_token(&token),
            Some("k.morgan@corp.test".to_string())
        );
    }

    #[test]
    fn own_address_falls_back_to_upn() {
        let token = fake_id_token(r#"{"upn":"k.morgan@corp.test"}"#);
        assert_eq!(
            own_address_from_id_token(&token),
            Some("k.morgan@corp.test".to_string())
        );
    }

    // The safe failure: match-attendees.ts proposes the user's own row rather
    // than dropping an attendee when this is None.
    #[test]
    fn own_address_is_none_when_neither_claim_is_present() {
        assert_eq!(own_address_from_id_token(&fake_id_token(r#"{"sub":"x"}"#)), None);
        assert_eq!(own_address_from_id_token("not-a-jwt"), None);
    }
}
