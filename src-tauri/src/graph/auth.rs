use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rand::RngCore;
use sha2::{Digest, Sha256};

use super::{AUTH_REJECTED, NETWORK};

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
        Some(value) if !expected.is_empty() && value == expected => Ok(()),
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
        Some(actual) if !expected.is_empty() && actual == expected => Ok(()),
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

use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::sync::mpsc::{self, Receiver};
use std::time::Duration;

use super::{AUTH_CANCELLED, CONSENT_REQUIRED};

/// Long enough for a real consent screen with an MFA prompt, short enough that
/// an abandoned flow does not leave a socket open all session.
#[allow(dead_code)]
pub const LISTENER_TIMEOUT: Duration = Duration::from_secs(300);

#[allow(dead_code)]
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Callback {
    pub code: Option<String>,
    pub state: Option<String>,
    pub error: Option<String>,
}

fn percent_decode(value: &str) -> String {
    let bytes = value.replace('+', " ").into_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(byte) = u8::from_str_radix(
                std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or(""),
                16,
            ) {
                out.push(byte);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Parses `GET /?code=...&state=... HTTP/1.1` - the only line of the request
/// this listener reads. Anything it cannot parse yields an empty Callback,
/// which the caller treats as a rejected redemption rather than a success.
#[allow(dead_code)]
pub fn parse_callback(request_line: &str) -> Callback {
    let mut callback = Callback::default();
    let Some(target) = request_line.split_whitespace().nth(1) else {
        return callback;
    };
    let Some((_, query)) = target.split_once('?') else {
        return callback;
    };
    for pair in query.split('&') {
        let Some((key, value)) = pair.split_once('=') else {
            continue;
        };
        let decoded = percent_decode(value);
        match key {
            "code" => callback.code = Some(decoded),
            "state" => callback.state = Some(decoded),
            "error" => callback.error = Some(decoded),
            _ => {}
        }
    }
    callback
}

/// `access_denied` is the user clicking Cancel. It is the COMMONEST outcome of
/// this flow and it is not a failure.
#[allow(dead_code)]
pub fn classify_callback_error(error: &str) -> &'static str {
    match error {
        "access_denied" => AUTH_CANCELLED,
        "consent_required" | "interaction_required" | "admin_consent_required" => CONSENT_REQUIRED,
        _ => AUTH_REJECTED,
    }
}

/// Binds a single-use loopback listener and returns its port immediately, so
/// the authorize URL can be built with the real redirect before the browser
/// opens.
///
/// LITERAL `127.0.0.1`, never `localhost` (which can resolve to `::1` or, in a
/// poisoned hosts file, off-box) and never `0.0.0.0` (which would accept from
/// the network). Port 0 asks the OS for a random ephemeral port, chosen per
/// attempt.
///
/// The accept loop runs EXACTLY ONCE. A second callback to a consumed listener
/// finds nothing listening - that is the single-use property, and it is why
/// the listener is moved into the thread rather than borrowed.
#[allow(dead_code)]
pub fn listen_once(timeout: Duration) -> Result<(u16, Receiver<Result<Callback, String>>), String> {
    let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|_| NETWORK.to_string())?;
    let port = listener.local_addr().map_err(|_| NETWORK.to_string())?.port();
    listener
        .set_nonblocking(false)
        .map_err(|_| NETWORK.to_string())?;

    let (tx, rx) = mpsc::channel();
    let timeout_tx = tx.clone();

    std::thread::spawn(move || {
        // A watchdog rather than a socket read timeout: `accept` has no
        // per-call timeout on a blocking listener, and an abandoned flow must
        // not hold the thread for the life of the process.
        //
        // The self-connect on the last line is the whole point. Sending the
        // timeout into the channel does NOT unblock `accept`, so a watchdog
        // that only sent would leave this thread parked and the loopback port
        // bound until the process exits - one leaked thread and one leaked
        // port per abandoned connect attempt. Dialling our own port wakes
        // `accept`, which lets the thread finish and DROP the listener, which
        // is also what makes the port genuinely stop listening after a timeout
        // rather than merely stop being read.
        std::thread::spawn(move || {
            std::thread::sleep(timeout);
            let _ = timeout_tx.send(Err(AUTH_CANCELLED.to_string()));
            let _ = std::net::TcpStream::connect(("127.0.0.1", port));
        });

        match listener.accept() {
            Ok((stream, _)) => {
                let mut reader = BufReader::new(&stream);
                let mut request_line = String::new();
                let outcome = match reader.read_line(&mut request_line) {
                    Ok(_) => Ok(parse_callback(&request_line)),
                    Err(_) => Err(NETWORK.to_string()),
                };
                // A static page that NEVER echoes the code back into the
                // browser's history, title or DOM.
                let body = "<!doctype html><meta charset=utf-8><title>Meetwings</title>\
                            <p>You can close this tab and return to Meetwings.";
                let mut stream = stream;
                let _ = write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                let _ = stream.flush();
                let _ = tx.send(outcome);
            }
            Err(_) => {
                let _ = tx.send(Err(NETWORK.to_string()));
            }
        }
        // `listener` drops here. The port stops accepting: single-use.
    });

    Ok((port, rx))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

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

    /// An empty `expected` must never be satisfiable - if it were, a caller
    /// that failed to generate a `state` (or passed one through unset) would
    /// have its CSRF check pass while binding nothing.
    #[test]
    fn empty_expected_state_is_rejected() {
        assert_eq!(validate_state("", Some("")), Err(AUTH_REJECTED.to_string()));
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

    /// Malformed shapes `nonce_from_id_token` must fail closed on, not panic
    /// on - locked in by test rather than left to inspection of the `?` chain.
    #[test]
    fn nonce_from_id_token_is_none_for_malformed_shapes() {
        // Only one `.`-separated segment: no payload to index.
        assert_eq!(nonce_from_id_token("not-a-jwt"), None);
        // A payload segment that is not valid base64.
        assert_eq!(nonce_from_id_token("header.not!valid!base64.sig"), None);
        // Valid base64, but the decoded bytes are not valid JSON.
        assert_eq!(
            nonce_from_id_token(&format!(
                "header.{}.sig",
                URL_SAFE_NO_PAD.encode("not json")
            )),
            None
        );
        // Valid JSON, but not an object - `.get("nonce")` has nothing to index.
        assert_eq!(
            nonce_from_id_token(&format!("header.{}.sig", URL_SAFE_NO_PAD.encode("[1,2,3]"))),
            None
        );
        // A `nonce` claim present but not a string.
        assert_eq!(
            nonce_from_id_token(&fake_id_token(r#"{"nonce":123}"#)),
            None
        );
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

    /// An empty `expected` must never be satisfiable, even against an ID
    /// token that itself carries an empty `nonce` claim - the same failure
    /// mode as `empty_expected_state_is_rejected`, for the other CSRF-shaped
    /// check in this file.
    #[test]
    fn empty_expected_nonce_is_rejected() {
        let empty_claim = fake_id_token(r#"{"nonce":""}"#);
        assert_eq!(
            validate_nonce("", Some(&empty_claim)),
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

    #[test]
    fn parses_the_success_callback() {
        let cb = parse_callback("GET /?code=abc123&state=xyz HTTP/1.1");
        assert_eq!(cb.code.as_deref(), Some("abc123"));
        assert_eq!(cb.state.as_deref(), Some("xyz"));
        assert!(cb.error.is_none());
    }

    #[test]
    fn parses_percent_encoded_values() {
        let cb = parse_callback("GET /?code=a%2Bb%2Fc&state=x%20y HTTP/1.1");
        assert_eq!(cb.code.as_deref(), Some("a+b/c"));
        assert_eq!(cb.state.as_deref(), Some("x y"));
    }

    #[test]
    fn parses_the_error_callback_form() {
        let cb = parse_callback("GET /?error=access_denied&error_description=User+cancelled HTTP/1.1");
        assert_eq!(cb.error.as_deref(), Some("access_denied"));
        assert!(cb.code.is_none());
    }

    #[test]
    fn a_malformed_request_line_yields_an_empty_callback() {
        let cb = parse_callback("garbage");
        assert!(cb.code.is_none() && cb.state.is_none() && cb.error.is_none());
    }

    // The commonest outcome of a loopback flow is not a failure and must not
    // be dressed as one.
    #[test]
    fn cancellation_forms_map_to_auth_cancelled() {
        assert_eq!(classify_callback_error("access_denied"), AUTH_CANCELLED);
        assert_eq!(classify_callback_error("consent_required"), CONSENT_REQUIRED);
        assert_eq!(classify_callback_error("interaction_required"), CONSENT_REQUIRED);
        assert_eq!(classify_callback_error("something_else"), AUTH_REJECTED);
    }

    #[test]
    fn listener_binds_loopback_only_and_reports_its_port() {
        let (port, _rx) = listen_once(Duration::from_millis(200)).unwrap();
        assert!(port > 0);
    }

    /// Single-use: the accept loop runs exactly once, so a SECOND connection to
    /// the same port after the first was consumed is never redeemed.
    #[test]
    fn a_second_callback_to_a_consumed_listener_is_not_redeemed() {
        use std::io::Write;
        use std::net::TcpStream;

        let (port, rx) = listen_once(Duration::from_secs(5)).unwrap();
        let mut first = TcpStream::connect(("127.0.0.1", port)).unwrap();
        first
            .write_all(b"GET /?code=first&state=s HTTP/1.1\r\n\r\n")
            .unwrap();
        let received = rx.recv_timeout(Duration::from_secs(5)).unwrap().unwrap();
        assert_eq!(received.code.as_deref(), Some("first"));

        // The listener is dropped after one accept, so this either refuses or
        // connects to nothing that will ever deliver a second Callback.
        if let Ok(mut second) = TcpStream::connect(("127.0.0.1", port)) {
            let _ = second.write_all(b"GET /?code=second&state=s HTTP/1.1\r\n\r\n");
        }
        assert!(rx.recv_timeout(Duration::from_millis(300)).is_err());
    }

    #[test]
    fn the_listener_times_out_rather_than_waiting_forever() {
        let (_port, rx) = listen_once(Duration::from_millis(150)).unwrap();
        let outcome = rx.recv_timeout(Duration::from_secs(2)).unwrap();
        assert_eq!(outcome, Err(AUTH_CANCELLED.to_string()));
    }

    /// The spec's third listener case: "a second callback to a consumed OR
    /// STALE listener is rejected, not redeemed."
    ///
    /// This is the one that fails against a watchdog which only messages the
    /// channel. Sending `Err(AUTH_CANCELLED)` does not unblock `accept`, so
    /// without the self-connect the thread stays parked, the port stays bound,
    /// and a late callback is still accepted and parsed - the listener has
    /// "timed out" only from the receiver's point of view.
    #[test]
    fn a_callback_arriving_after_the_timeout_is_not_redeemed() {
        use std::io::Write;
        use std::net::TcpStream;

        let (port, rx) = listen_once(Duration::from_millis(150)).unwrap();
        assert_eq!(
            rx.recv_timeout(Duration::from_secs(2)).unwrap(),
            Err(AUTH_CANCELLED.to_string())
        );

        // Give the watchdog's self-connect time to wake `accept` and drop the
        // listener, then try to deliver a code to the dead port.
        std::thread::sleep(Duration::from_millis(200));
        if let Ok(mut late) = TcpStream::connect(("127.0.0.1", port)) {
            let _ = late.write_all(b"GET /?code=late&state=s HTTP/1.1\r\n\r\n");
        }
        // Nothing carrying a code may ever arrive.
        while let Ok(outcome) = rx.recv_timeout(Duration::from_millis(300)) {
            assert!(
                !matches!(&outcome, Ok(cb) if cb.code.is_some()),
                "a callback arriving after the timeout was redeemed"
            );
        }
    }
}
