use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rand::RngCore;
use sha2::{Digest, Sha256};

use super::{AUTH_EXPIRED, AUTH_REJECTED, BAD_RESPONSE, NETWORK, THROTTLED};

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

use std::io::{BufRead, BufReader, Read, Write};
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

/// LITERAL `127.0.0.1`, never `localhost` (which can resolve to `::1` or, in a
/// poisoned hosts file, off-box) and never `0.0.0.0` (which would accept from
/// the network). Port 0 asks the OS for a random ephemeral port, chosen per
/// attempt.
///
/// Split out from `listen_once` so a test can pin down exactly what address
/// this binds to - `listen_once` returns only a `u16` port, which cannot
/// distinguish a `127.0.0.1` bind from a `0.0.0.0` one from the outside: a
/// `0.0.0.0` listener answers on `127.0.0.1` too, so a client that connects
/// successfully proves nothing about which interfaces are exposed.
fn bind_loopback_ephemeral() -> Result<TcpListener, String> {
    TcpListener::bind(("127.0.0.1", 0)).map_err(|_| NETWORK.to_string())
}

/// The post-accept read timeout, distinct from the caller-supplied `timeout`
/// (the consent-screen window `LISTENER_TIMEOUT` covers). Once `accept`
/// returns, the peer is already connected - a browser that has completed the
/// OAuth redirect has the request line ready immediately. A connection that
/// accepts and then sends nothing (or trickles bytes with no `\n`) is not a
/// slow human deciding; it must not park this thread for the life of
/// `timeout`, let alone forever.
const CALLBACK_READ_TIMEOUT: Duration = Duration::from_secs(10);

/// The request line is capped so a peer that streams bytes with no `\n`
/// cannot grow the buffer without limit. A real OAuth callback request line
/// is a few hundred bytes at most.
const MAX_REQUEST_LINE_BYTES: u64 = 8192;

/// Binds a single-use loopback listener and returns its port immediately, so
/// the authorize URL can be built with the real redirect before the browser
/// opens.
///
/// The accept loop runs EXACTLY ONCE. A second callback to a consumed listener
/// finds nothing listening - that is the single-use property, and it is why
/// the listener is moved into the thread rather than borrowed.
#[allow(dead_code)]
pub fn listen_once(timeout: Duration) -> Result<(u16, Receiver<Result<Callback, String>>), String> {
    let listener = bind_loopback_ephemeral()?;
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
                let outcome = if stream.set_read_timeout(Some(CALLBACK_READ_TIMEOUT)).is_err() {
                    Err(NETWORK.to_string())
                } else {
                    let mut reader = BufReader::new(&stream).take(MAX_REQUEST_LINE_BYTES);
                    let mut request_line = String::new();
                    match reader.read_line(&mut request_line) {
                        Ok(_) => Ok(parse_callback(&request_line)),
                        // Covers a read timeout (WouldBlock/TimedOut) the same
                        // way as any other read failure: no code, no state,
                        // no reflection of anything the peer sent.
                        Err(_) => Err(NETWORK.to_string()),
                    }
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

/// SEE PROBE 1 (Task 2). ReadBasic additionally withholds the meeting body -
/// text this feature never needs and would rather not hold - so it is the
/// default. If the probe found any filter property absent under ReadBasic,
/// this becomes `Calendars.Read` and nothing else changes.
#[allow(dead_code)]
pub const GRAPH_SCOPES: &str =
    "openid profile offline_access https://graph.microsoft.com/Calendars.ReadBasic";

#[allow(dead_code)]
pub struct Tokens {
    pub access_token: String,
    pub expires_at_ms: i64,
    /// Entra ROTATES the refresh token on every redemption. `None` means the
    /// response carried none and the caller keeps the one it has.
    pub refresh_token: Option<String>,
    pub id_token: Option<String>,
}

/// The authority is FREE TEXT the user typed on the `/odoo` page, and it is the
/// host this module sends credentials to: `post_token` POSTs the authorization
/// code, the PKCE verifier and later the refresh token to
/// `{authority}/oauth2/v2.0/token`. An unvalidated authority is therefore not a
/// cosmetic problem — it is an arbitrary exfiltration target, and a plain `http`
/// one puts those values on the wire in clear.
///
/// So: parse it, require `https`, and reject anything else. The previous draft
/// used `.expect("authority is validated before this point")` when nothing
/// validated it anywhere — a typo would have PANICKED the Rust side mid-connect,
/// bypassing the whole GRAPH_*/redaction path this feature is built on.
///
/// Returning `Result` rather than validating only in the TypeScript layer is
/// deliberate: this is the last point before credentials move, and a check that
/// lives only on the caller's side is one refactor away from being skipped.
#[allow(dead_code)]
pub fn validate_authority(authority: &str) -> Result<url::Url, String> {
    let parsed = url::Url::parse(authority.trim_end_matches('/')).map_err(|_| AUTH_REJECTED.to_string())?;
    if parsed.scheme() != "https" {
        return Err(AUTH_REJECTED.to_string());
    }
    if !parsed.has_host() {
        return Err(AUTH_REJECTED.to_string());
    }
    Ok(parsed)
}

#[allow(dead_code)]
pub fn authorize_url(
    authority: &str,
    client_id: &str,
    port: u16,
    challenge: &str,
    state: &str,
    nonce: &str,
) -> Result<String, String> {
    let redirect = format!("http://127.0.0.1:{port}");
    let base = validate_authority(authority)?;
    let mut url = url::Url::parse(&format!("{}/oauth2/v2.0/authorize", base.as_str().trim_end_matches('/')))
        .map_err(|_| AUTH_REJECTED.to_string())?;
    url.query_pairs_mut()
        .append_pair("client_id", client_id)
        .append_pair("response_type", "code")
        .append_pair("redirect_uri", &redirect)
        .append_pair("response_mode", "query")
        .append_pair("scope", GRAPH_SCOPES)
        .append_pair("code_challenge", challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("state", state)
        .append_pair("nonce", nonce);
    Ok(url.to_string())
}

/// ONLY `invalid_grant` proves the refresh token is dead (revoked, expired,
/// password changed). Everything else RETAINS it: destroying a working ~90-day
/// credential over a transport blip can need an administrator to undo, in a
/// consent-blocked tenant.
#[allow(dead_code)]
pub fn classify_token_error(status: u16, body: &str) -> &'static str {
    if status == 429 {
        return THROTTLED;
    }
    if status >= 500 {
        return NETWORK;
    }
    let Ok(json) = serde_json::from_str::<serde_json::Value>(body) else {
        return AUTH_REJECTED;
    };
    match json.get("error").and_then(|v| v.as_str()) {
        Some("invalid_grant") => AUTH_EXPIRED,
        Some("consent_required") | Some("interaction_required")
        | Some("admin_consent_required") => CONSENT_REQUIRED,
        _ => AUTH_REJECTED,
    }
}

async fn post_token(
    authority: &str,
    form: &[(&str, &str)],
    now_ms: i64,
) -> Result<Tokens, String> {
    // Validated HERE too, not only in authorize_url. This is the call that
    // actually carries the authorization code, the PKCE verifier and the
    // refresh token, so it does its own check rather than trusting that some
    // earlier caller did one.
    let base = validate_authority(authority)?;
    let endpoint = format!("{}/oauth2/v2.0/token", base.as_str().trim_end_matches('/'));
    // A transport failure is NETWORK, never AUTH_EXPIRED. This mapping is the
    // one that decides whether a working credential survives a flaky café
    // wifi.
    let response = reqwest::Client::new()
        .post(&endpoint)
        .form(form)
        .send()
        .await
        .map_err(|_| NETWORK.to_string())?;
    let status = response.status().as_u16();
    let body = response.text().await.map_err(|_| NETWORK.to_string())?;
    if status != 200 {
        return Err(classify_token_error(status, &body).to_string());
    }
    let json: serde_json::Value =
        serde_json::from_str(&body).map_err(|_| BAD_RESPONSE.to_string())?;
    let access_token = json
        .get("access_token")
        .and_then(|v| v.as_str())
        .ok_or_else(|| BAD_RESPONSE.to_string())?
        .to_string();
    let expires_in = json.get("expires_in").and_then(|v| v.as_i64()).unwrap_or(3600);
    Ok(Tokens {
        access_token,
        // 60s of slack so a call started just under the wire does not race the
        // expiry it just checked.
        expires_at_ms: now_ms + (expires_in - 60).max(0) * 1000,
        refresh_token: json
            .get("refresh_token")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        id_token: json.get("id_token").and_then(|v| v.as_str()).map(str::to_string),
    })
}

#[allow(dead_code)]
pub async fn exchange_code(
    authority: &str,
    client_id: &str,
    code: &str,
    verifier: &str,
    port: u16,
    now_ms: i64,
) -> Result<Tokens, String> {
    let redirect = format!("http://127.0.0.1:{port}");
    post_token(
        authority,
        &[
            ("client_id", client_id),
            ("grant_type", "authorization_code"),
            ("code", code),
            ("redirect_uri", &redirect),
            ("code_verifier", verifier),
            ("scope", GRAPH_SCOPES),
        ],
        now_ms,
    )
    .await
}

#[allow(dead_code)]
pub async fn refresh(
    authority: &str,
    client_id: &str,
    refresh_token: &str,
    now_ms: i64,
) -> Result<Tokens, String> {
    post_token(
        authority,
        &[
            ("client_id", client_id),
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh_token),
            ("scope", GRAPH_SCOPES),
        ],
        now_ms,
    )
    .await
}

/// Rotation: WRITE THE NEW TOKEN BEFORE DELETING THE OLD ONE.
///
/// keyring's set_password overwrites the same entry, so there is no separate
/// delete to order wrongly - but the ordering is stated because a future
/// backend with distinct create/delete calls must preserve it. Deleting first
/// and then failing the write leaves the user with no credential and no way
/// back.
#[allow(dead_code)]
pub fn persist_rotated(tokens: &Tokens) -> Result<(), String> {
    match &tokens.refresh_token {
        Some(token) => super::keychain::store_refresh_token(token),
        None => Ok(()),
    }
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

    /// Both the authorization code and `state` pass through `percent_decode`
    /// on every real callback - its safety on malformed escapes is otherwise
    /// established only by hand-tracing the bounds check.
    #[test]
    fn percent_decode_handles_malformed_escapes_without_panicking() {
        // A trailing '%' with nothing after it.
        assert_eq!(percent_decode("abc%"), "abc%");
        // '%' followed by only one character - one short of a full escape.
        assert_eq!(percent_decode("abc%2"), "abc%2");
        // '%' followed by two characters that are not valid hex digits.
        assert_eq!(percent_decode("abc%ZZdef"), "abc%ZZdef");
        // '+' decodes to a literal space.
        assert_eq!(percent_decode("a+b"), "a b");
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

    /// The property in this test's name is NOT checked by connecting: a
    /// `0.0.0.0` listener answers a `TcpStream::connect(("127.0.0.1", port))`
    /// exactly as a `127.0.0.1` listener does, because `0.0.0.0` means "every
    /// interface, loopback included" - a successful connect (or its observed
    /// addresses) is identical either way and cannot tell them apart.
    /// `listen_once` also only returns a `u16` port, not the bind address, so
    /// there is nothing to inspect on its own return value either.
    ///
    /// What DOES distinguish them is the bound socket's own address, which is
    /// why this pins down `bind_loopback_ephemeral` - the exact call
    /// `listen_once` uses - directly. Mutating that call's `"127.0.0.1"` to
    /// `"0.0.0.0"` makes this assertion fail (verified by hand for this fix;
    /// see the fix report for the observed output).
    #[test]
    fn bind_loopback_ephemeral_binds_only_to_the_loopback_interface() {
        let listener = bind_loopback_ephemeral().unwrap();
        assert_eq!(
            listener.local_addr().unwrap().ip(),
            std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST)
        );
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

    // The three-way split is load-bearing, not bookkeeping. A test that only
    // asserted "auth failure clears the token" would lock in the exact defect
    // the spec corrected.
    #[test]
    fn only_invalid_grant_means_the_refresh_token_is_dead() {
        assert_eq!(
            classify_token_error(400, r#"{"error":"invalid_grant"}"#),
            AUTH_EXPIRED
        );
        assert_eq!(
            classify_token_error(400, r#"{"error":"consent_required"}"#),
            CONSENT_REQUIRED
        );
        assert_eq!(
            classify_token_error(400, r#"{"error":"invalid_client"}"#),
            AUTH_REJECTED
        );
        assert_eq!(classify_token_error(429, "{}"), THROTTLED);
        assert_eq!(classify_token_error(503, "{}"), NETWORK);
        // A body that is not JSON at all is unusable, not a dead credential.
        assert_eq!(classify_token_error(400, "<html>"), AUTH_REJECTED);
    }

    /// The authority is the host this module POSTs the auth code, the PKCE
    /// verifier and later the refresh token to. An unvalidated one is an
    /// arbitrary exfiltration target, and a plain-http one puts those values on
    /// the wire in clear - so anything that is not an absolute https URL with a
    /// host is rejected BEFORE a browser is ever opened.
    #[test]
    fn a_non_https_or_malformed_authority_is_rejected_not_panicked_on() {
        for bad in [
            "login.microsoftonline.com/organizations", // no scheme - the typo case
            "http://login.microsoftonline.com/organizations", // clear text
            "ftp://example.test",
            "https://",  // no host
            "",
            "not a url",
        ] {
            assert_eq!(
                validate_authority(bad),
                Err(AUTH_REJECTED.to_string()),
                "authority {bad:?} must be rejected"
            );
            assert!(
                authorize_url(bad, "client-1", 8123, "c", "s", "n").is_err(),
                "authorize_url must return Err, never panic, for {bad:?}"
            );
        }
    }

    #[test]
    fn authorize_url_carries_pkce_state_nonce_and_the_loopback_redirect() {
        let url = authorize_url(
            "https://login.microsoftonline.com/organizations",
            "client-1",
            8123,
            "challenge-x",
            "state-y",
            "nonce-z",
        )
        .expect("a well-formed https authority");
        assert!(url.starts_with(
            "https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize?"
        ));
        for expected in [
            "client_id=client-1",
            "response_type=code",
            "code_challenge=challenge-x",
            "code_challenge_method=S256",
            "state=state-y",
            "nonce=nonce-z",
            // Literal 127.0.0.1, percent-encoded in the query.
            "redirect_uri=http%3A%2F%2F127.0.0.1%3A8123",
            // openid and profile are requested EXPLICITLY - the own-address
            // exclusion depends on the ID token carrying a username claim.
            "openid",
            "profile",
            "offline_access",
        ] {
            assert!(url.contains(expected), "authorize URL is missing {expected}");
        }
        assert!(!url.contains("localhost"));
    }

    #[test]
    fn scopes_request_exactly_one_calendars_permission() {
        let calendars: Vec<&str> = GRAPH_SCOPES
            .split_whitespace()
            .filter(|s| s.contains("Calendars."))
            .collect();
        assert_eq!(calendars.len(), 1, "exactly one Calendars scope: {calendars:?}");
    }
}
