//! Provider-neutral OAuth loopback helpers: PKCE, state/nonce checks, the
//! single-use loopback listener. Errors are the neutral `OAuthFail`; each
//! provider module maps it to its own error strings.

pub mod keychain;

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rand::RngCore;
use sha2::{Digest, Sha256};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::sync::mpsc::{self, Receiver};
use std::time::Duration;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OAuthFail {
    Rejected,
    Cancelled,
    ConsentRequired,
    Network,
}

pub struct Pkce {
    pub verifier: String,
    pub challenge: String,
}

/// URL-safe base64 of CSPRNG bytes: 32 bytes give 43 characters, inside RFC
/// 7636's 43..128 range, and made only of unreserved characters so it needs no
/// further escaping in the token request body.
pub fn random_token(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    rand::thread_rng().fill_bytes(&mut buf);
    URL_SAFE_NO_PAD.encode(buf)
}

/// S256: base64url(SHA256(ASCII(verifier))) over the RAW DIGEST BYTES.
/// Encoding the hex digest instead is the classic silent break.
pub fn challenge_for(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

pub fn new_pkce() -> Pkce {
    let verifier = random_token(32);
    let challenge = challenge_for(&verifier);
    Pkce {
        verifier,
        challenge,
    }
}

/// A mismatched or absent `state` is rejected BEFORE the code is redeemed -
/// nothing is sent to the token endpoint.
pub fn validate_state(expected: &str, received: Option<&str>) -> Result<(), OAuthFail> {
    match received {
        Some(value) if !expected.is_empty() && value == expected => Ok(()),
        _ => Err(OAuthFail::Rejected),
    }
}

/// The ID token's payload segment, decoded. NOT a signature verification: the
/// token arrived over TLS directly from the token endpoint, so this reads
/// claims rather than establishing trust.
pub fn id_token_claims(id_token: &str) -> Option<serde_json::Value> {
    let payload = id_token.split('.').nth(1)?;
    let bytes = URL_SAFE_NO_PAD.decode(payload).ok()?;
    serde_json::from_slice(&bytes).ok()
}

pub fn nonce_from_id_token(id_token: &str) -> Option<String> {
    Some(
        id_token_claims(id_token)?
            .get("nonce")?
            .as_str()?
            .to_string(),
    )
}

/// The nonce check, as its OWN function so it can be unit tested (a comparison
/// inlined in an async `#[tauri::command]` body cannot be), and this is a
/// security check.
///
/// **An ABSENT `id_token` is a rejection, not a skip.** The scopes request
/// `openid` explicitly, so a token response without an ID token means
/// something other than what we asked for came back, and a guard like
/// `if let Some(id_token)` would silently accept it and bind nothing.
pub fn validate_nonce(expected: &str, id_token: Option<&str>) -> Result<(), OAuthFail> {
    match id_token.and_then(nonce_from_id_token) {
        Some(actual) if !expected.is_empty() && actual == expected => Ok(()),
        _ => Err(OAuthFail::Rejected),
    }
}

/// Long enough for a real consent screen with an MFA prompt, short enough that
/// an abandoned flow does not leave a socket open all session.
pub const LISTENER_TIMEOUT: Duration = Duration::from_secs(300);

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Callback {
    pub code: Option<String>,
    pub state: Option<String>,
    pub error: Option<String>,
}

pub(crate) fn percent_decode(value: &str) -> String {
    let bytes = value.replace('+', " ").into_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(byte) =
                u8::from_str_radix(std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or(""), 16)
            {
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
pub fn classify_callback_error(error: &str) -> OAuthFail {
    match error {
        "access_denied" => OAuthFail::Cancelled,
        "consent_required" | "interaction_required" | "admin_consent_required" => {
            OAuthFail::ConsentRequired
        }
        _ => OAuthFail::Rejected,
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
pub(crate) fn bind_loopback_ephemeral() -> Result<TcpListener, OAuthFail> {
    TcpListener::bind(("127.0.0.1", 0)).map_err(|_| OAuthFail::Network)
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
///
/// `map` turns the neutral failure into the caller's own error type.
pub fn listen_once<E: Send + 'static>(
    timeout: Duration,
    map: fn(OAuthFail) -> E,
) -> Result<(u16, Receiver<Result<Callback, E>>), E> {
    let listener = bind_loopback_ephemeral().map_err(map)?;
    let port = listener
        .local_addr()
        .map_err(|_| map(OAuthFail::Network))?
        .port();
    listener
        .set_nonblocking(false)
        .map_err(|_| map(OAuthFail::Network))?;

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
            let _ = timeout_tx.send(Err(map(OAuthFail::Cancelled)));
            let _ = std::net::TcpStream::connect(("127.0.0.1", port));
        });

        match listener.accept() {
            Ok((stream, _)) => {
                let outcome = if stream
                    .set_read_timeout(Some(CALLBACK_READ_TIMEOUT))
                    .is_err()
                {
                    Err(map(OAuthFail::Network))
                } else {
                    let mut reader = BufReader::new(&stream).take(MAX_REQUEST_LINE_BYTES);
                    let mut request_line = String::new();
                    match reader.read_line(&mut request_line) {
                        Ok(_) => Ok(parse_callback(&request_line)),
                        // Covers a read timeout (WouldBlock/TimedOut) the same
                        // way as any other read failure: no code, no state,
                        // no reflection of anything the peer sent.
                        Err(_) => Err(map(OAuthFail::Network)),
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
                let _ = tx.send(Err(map(OAuthFail::Network)));
            }
        }
        // `listener` drops here. The port stops accepting: single-use.
    });

    Ok((port, rx))
}

/// Wakes a still-blocked `listen_once` accept loop the same way its own
/// timeout watchdog does - a self-connect, not a socket-level cancellation
/// API, because `TcpListener` offers none. Sending nothing to `rx` and
/// dropping the connection immediately lets the accept thread's `accept()`
/// return, finish its (fruitless) read, and drop `listener` - releasing the
/// port in milliseconds instead of leaving it bound for the rest of
/// `LISTENER_TIMEOUT`.
///
/// Idempotent and safe to call after the listener has already been consumed:
/// a connect to a port nothing is listening on simply fails, and the caller
/// discards that failure exactly as the watchdog's own self-connect does.
pub fn cancel_listener(port: u16) {
    let _ = std::net::TcpStream::connect(("127.0.0.1", port));
}

/// Cancels the listener on drop, so an early return before the callback is
/// read (a bad authorize URL, a failed browser open) does not leave the accept
/// thread parked and the loopback port bound for the rest of `LISTENER_TIMEOUT`.
/// On the path that does reach the callback the listener is already dropped, so
/// the self-connect just fails against a closed port and is discarded.
pub struct ListenerGuard(pub u16);

impl Drop for ListenerGuard {
    fn drop(&mut self) {
        cancel_listener(self.0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shared_state_check_returns_a_neutral_error() {
        assert_eq!(validate_state("a", Some("b")), Err(OAuthFail::Rejected));
        assert_eq!(validate_state("", Some("")), Err(OAuthFail::Rejected));
        assert_eq!(validate_state("a", None), Err(OAuthFail::Rejected));
        assert_eq!(validate_state("a", Some("a")), Ok(()));
    }

    #[test]
    fn shared_callback_errors_are_neutral() {
        assert_eq!(classify_callback_error("access_denied"), OAuthFail::Cancelled);
        assert_eq!(
            classify_callback_error("consent_required"),
            OAuthFail::ConsentRequired
        );
        assert_eq!(classify_callback_error("server_error"), OAuthFail::Rejected);
    }

    #[test]
    fn listener_timeout_goes_through_the_callers_mapping() {
        let (_port, rx) = listen_once(Duration::from_millis(150), |f| format!("X_{f:?}")).unwrap();
        let outcome = rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(outcome, Err("X_Cancelled".to_string()));
    }
}
