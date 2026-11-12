//! Google Calendar sign-in: OAuth (auth code + PKCE) on the shared
//! `crate::oauth` plumbing, the keychain, and the session state.
//!
//! Unlike Graph there is no `invalid_grant` streak: a dead refresh token is
//! kept until Disconnect or a reconnect replaces it. Keychain access is
//! injected (`load`/`store`/`delete`) so no unit test touches the real OS
//! keychain.

mod auth;

use crate::graph::GraphStatus;
use crate::oauth::{self, keychain, OAuthFail};
use std::future::Future;
use std::sync::Mutex;
use tauri::{AppHandle, Manager};
use tauri_plugin_opener::OpenerExt;

#[allow(dead_code)] // read by the Task 3 calendar read
pub const NOT_CONNECTED: &str = "GOOGLE_NOT_CONNECTED";
pub const CONSENT_REQUIRED: &str = "GOOGLE_CONSENT_REQUIRED";
pub const AUTH_CANCELLED: &str = "GOOGLE_AUTH_CANCELLED";
pub const AUTH_EXPIRED: &str = "GOOGLE_AUTH_EXPIRED";
pub const AUTH_REJECTED: &str = "GOOGLE_AUTH_REJECTED";
pub const BAD_RESPONSE: &str = "GOOGLE_BAD_RESPONSE";
pub const THROTTLED: &str = "GOOGLE_THROTTLED";
pub const NETWORK: &str = "GOOGLE_NETWORK";
pub const NO_KEYCHAIN: &str = "GOOGLE_NO_KEYCHAIN";

pub const GOOGLE_SERVICE: &str = "com.meetwings.google";

/// Bounds every `reqwest` call this module makes, so `persist_op` and
/// `refresh_op` waiters can never be held up by a hung network path.
pub(crate) const GOOGLE_HTTP_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// Maps the neutral failure to Google's `GOOGLE_*` error strings.
pub(crate) fn google_code(f: OAuthFail) -> String {
    match f {
        OAuthFail::Rejected => AUTH_REJECTED,
        OAuthFail::Cancelled => AUTH_CANCELLED,
        OAuthFail::ConsentRequired => CONSENT_REQUIRED,
        OAuthFail::Network => NETWORK,
    }
    .to_string()
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// The access token lives in process memory only.
#[derive(Default)]
pub struct GoogleSession {
    access_token: Option<String>,
    expires_at_ms: i64,
    /// The in-memory copy: the session-only path's only one, and the
    /// preferred read on the normal path.
    refresh_token: Option<String>,
    own_address: Option<String>,
    /// Bumped by disconnect and by a reconnect. An in-flight refresh captures
    /// it before awaiting and loses its adopt if it moved.
    generation: u64,
}

/// Lock order: `refresh_op` -> `persist_op`; `session` and `session_only` are
/// never held at the same time. `persist_op` never spans an `.await`.
#[derive(Default)]
pub struct GoogleState {
    pub session: Mutex<GoogleSession>,
    /// No keychain: the connection lives for this launch and nothing is
    /// written to disk.
    pub session_only: Mutex<bool>,
    /// Serializes adopt-then-persist against clear-then-delete.
    persist_op: Mutex<()>,
    /// Serializes refreshes (held across the token POST).
    #[allow(dead_code)] // taken by refresh_and_adopt_with
    refresh_op: tokio::sync::Mutex<()>,
}

impl GoogleState {
    pub fn clear_session(&self) {
        let mut session = self.session.lock().unwrap_or_else(|e| e.into_inner());
        session.access_token = None;
        session.refresh_token = None;
        session.expires_at_ms = 0;
        session.own_address = None;
        session.generation = session.generation.wrapping_add(1);
    }

    /// A keychain read failure is `Err`, never `connected: false`: a silent
    /// "disconnected" would make the calendar block vanish without a word.
    pub fn status(&self) -> Result<GraphStatus, String> {
        let session_only = *self.session_only.lock().unwrap_or_else(|e| e.into_inner());
        // The refresh token, not the access token: an expired access token is
        // still a connection.
        let in_memory = self
            .session
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .refresh_token
            .is_some();
        let connected = if session_only || in_memory {
            in_memory
        } else {
            keychain::load(GOOGLE_SERVICE)
                .map_err(|_| NO_KEYCHAIN.to_string())?
                .is_some()
        };
        Ok(GraphStatus {
            connected,
            session_only,
        })
    }
}

/// Returns `false` when the generation moved (a disconnect or reconnect landed
/// while the caller was awaiting); the caller must then write nothing. The
/// comparison is inside the session lock.
fn adopt(state: &GoogleState, t: &auth::GoogleTokens, generation: u64) -> bool {
    let mut session = state.session.lock().unwrap_or_else(|e| e.into_inner());
    if session.generation != generation {
        return false;
    }
    session.access_token = Some(t.access_token.clone());
    session.expires_at_ms = t.expires_at_ms;
    // `None` means the response carried no new one: the stored one stands.
    if t.refresh_token.is_some() {
        session.refresh_token = t.refresh_token.clone();
    }
    if let Some(email) = t.id_token.as_deref().and_then(auth::email_from_id_token) {
        session.own_address = Some(email);
    }
    true
}

/// Adopt into memory, then persist, under `persist_op` so a disconnect cannot
/// land between the two. A `store` failure degrades to session-only and still
/// counts as adopted: we already hold a working credential.
fn adopt_and_persist_with(
    state: &GoogleState,
    t: &auth::GoogleTokens,
    generation: u64,
    store: impl Fn(&str) -> Result<(), String>,
) -> bool {
    let _persist = state.persist_op.lock().unwrap_or_else(|e| e.into_inner());
    if !adopt(state, t, generation) {
        return false;
    }
    if *state.session_only.lock().unwrap_or_else(|e| e.into_inner()) {
        return true;
    }
    if let Some(refresh) = t.refresh_token.as_deref() {
        if store(refresh).is_err() {
            *state.session_only.lock().unwrap_or_else(|e| e.into_inner()) = true;
        }
    }
    true
}

/// Clear memory first, unconditionally; then delete from the keychain unless
/// session-only (nothing was ever written, and a real delete would error).
fn forget_with(
    state: &GoogleState,
    delete: impl Fn() -> Result<(), String>,
) -> Result<(), String> {
    let _persist = state.persist_op.lock().unwrap_or_else(|e| e.into_inner());
    let was_session_only = *state.session_only.lock().unwrap_or_else(|e| e.into_inner());
    state.clear_session();
    if was_session_only {
        return Ok(());
    }
    delete()
}

#[allow(dead_code)] // consumed by the Task 3 calendar read
pub(crate) fn fresh_access_token(state: &GoogleState) -> Option<String> {
    let session = state.session.lock().unwrap_or_else(|e| e.into_inner());
    match &session.access_token {
        Some(token) if session.expires_at_ms > now_ms() => Some(token.clone()),
        _ => None,
    }
}

/// The one refresh path. Held under `refresh_op` across the token POST, so
/// concurrent callers redeem once. `stale` is a token the caller knows is bad
/// (a 401): the post-lock re-read must not hand it back. Errors from `redeem`,
/// `GOOGLE_AUTH_EXPIRED` included, pass through with the credential kept.
#[allow(dead_code)] // consumed by the Task 3 calendar read
pub(crate) async fn refresh_and_adopt_with<F, Fut>(
    state: &GoogleState,
    generation: u64,
    stale: Option<&str>,
    redeem: F,
    load: impl Fn() -> Result<Option<String>, String>,
    store: impl Fn(&str) -> Result<(), String>,
) -> Result<String, String>
where
    F: FnOnce(String) -> Fut,
    Fut: Future<Output = Result<auth::GoogleTokens, String>>,
{
    let _refresh = state.refresh_op.lock().await;

    if let Some(token) = fresh_access_token(state) {
        if Some(token.as_str()) != stale {
            return Ok(token);
        }
    }

    let in_memory = state
        .session
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .refresh_token
        .clone();
    let stored = match in_memory {
        Some(token) => token,
        None => {
            if *state.session_only.lock().unwrap_or_else(|e| e.into_inner()) {
                return Err(NOT_CONNECTED.to_string());
            }
            load()?.ok_or_else(|| NOT_CONNECTED.to_string())?
        }
    };

    let tokens = redeem(stored).await?;
    let access = tokens.access_token.clone();
    if !adopt_and_persist_with(state, &tokens, generation, store) {
        return Err(NOT_CONNECTED.to_string());
    }
    Ok(access)
}

/// Production wrapper: the real keychain behind `load` and `store`.
#[allow(dead_code)] // consumed by the Task 3 calendar read
pub(crate) async fn refresh_and_adopt<F, Fut>(
    state: &GoogleState,
    generation: u64,
    stale: Option<&str>,
    redeem: F,
) -> Result<String, String>
where
    F: FnOnce(String) -> Fut,
    Fut: Future<Output = Result<auth::GoogleTokens, String>>,
{
    refresh_and_adopt_with(
        state,
        generation,
        stale,
        redeem,
        || keychain::load(GOOGLE_SERVICE).map_err(|_| NO_KEYCHAIN.to_string()),
        |t| keychain::store(GOOGLE_SERVICE, t).map_err(|_| NO_KEYCHAIN.to_string()),
    )
    .await
}

#[tauri::command]
pub async fn google_connect(
    app: AppHandle,
    client_id: String,
    client_secret: String,
) -> Result<GraphStatus, String> {
    let state = app.state::<GoogleState>();
    if client_id.trim().is_empty() || client_secret.trim().is_empty() {
        return Err(AUTH_REJECTED.to_string());
    }

    // Bind before opening the browser: the redirect URI carries the port.
    let (port, rx) = oauth::listen_once(oauth::LISTENER_TIMEOUT, google_code)?;
    // Releases the listener on every exit, `?` returns included.
    let _guard = oauth::ListenerGuard(port);

    let pkce = oauth::new_pkce();
    let expected_state = oauth::random_token(24);
    let expected_nonce = oauth::random_token(24);

    let url = auth::authorize_url(
        &client_id,
        port,
        &pkce.challenge,
        &expected_state,
        &expected_nonce,
    );
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|_| NETWORK.to_string())?;

    // Read the channel exactly once (see graph_connect for why).
    let callback = tauri::async_runtime::spawn_blocking(move || rx.recv())
        .await
        .map_err(|_| NETWORK.to_string())?
        .map_err(|_| AUTH_CANCELLED.to_string())??;

    if let Some(error) = &callback.error {
        return Err(google_code(oauth::classify_callback_error(error)));
    }
    oauth::validate_state(&expected_state, callback.state.as_deref()).map_err(google_code)?;
    let code = callback.code.ok_or_else(|| AUTH_CANCELLED.to_string())?;

    let tokens = auth::exchange_code(
        &client_id,
        &client_secret,
        &code,
        &pkce.verifier,
        port,
        now_ms(),
    )
    .await?;

    oauth::validate_nonce(&expected_nonce, tokens.id_token.as_deref()).map_err(google_code)?;
    if tokens
        .id_token
        .as_deref()
        .and_then(auth::email_from_id_token)
        .is_none()
    {
        return Err(AUTH_REJECTED.to_string());
    }
    // Without a refresh token the connection would die in an hour.
    if tokens.refresh_token.is_none() {
        return Err(BAD_RESPONSE.to_string());
    }

    // `available()` is only the fast path; a failed store degrades anyway.
    *state.session_only.lock().unwrap_or_else(|e| e.into_inner()) =
        !keychain::available(GOOGLE_SERVICE);
    // Bump the generation so an old account's refresh still in flight loses
    // its adopt.
    let generation = {
        let mut session = state.session.lock().unwrap_or_else(|e| e.into_inner());
        session.generation = session.generation.wrapping_add(1);
        session.generation
    };
    adopt_and_persist_with(&state, &tokens, generation, |t| {
        keychain::store(GOOGLE_SERVICE, t).map_err(|_| NO_KEYCHAIN.to_string())
    });
    state.status()
}

#[tauri::command]
pub async fn google_disconnect(app: AppHandle) -> Result<(), String> {
    let state = app.state::<GoogleState>();
    let result = forget_with(&state, || {
        keychain::delete(GOOGLE_SERVICE).map_err(|_| NO_KEYCHAIN.to_string())
    });
    *state.session_only.lock().unwrap_or_else(|e| e.into_inner()) = false;
    result
}

#[tauri::command]
pub fn google_status(app: AppHandle) -> Result<GraphStatus, String> {
    app.state::<GoogleState>().status()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::oauth::{self, OAuthFail};
    use std::cell::Cell;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    fn tokens(access: &str, refresh: Option<&str>) -> auth::GoogleTokens {
        auth::GoogleTokens {
            access_token: access.to_string(),
            expires_at_ms: now_ms() + 3_600_000,
            refresh_token: refresh.map(str::to_string),
            id_token: None,
        }
    }

    fn seeded(refresh: &str) -> GoogleState {
        let state = GoogleState::default();
        state.session.lock().unwrap().refresh_token = Some(refresh.to_string());
        state
    }

    fn mem_refresh(state: &GoogleState) -> Option<String> {
        state.session.lock().unwrap().refresh_token.clone()
    }

    fn mem_access(state: &GoogleState) -> Option<String> {
        state.session.lock().unwrap().access_token.clone()
    }

    #[test]
    fn google_codes_never_say_graph() {
        for v in [
            OAuthFail::Rejected,
            OAuthFail::Cancelled,
            OAuthFail::ConsentRequired,
            OAuthFail::Network,
        ] {
            assert!(google_code(v).starts_with("GOOGLE_"));
        }
        let (_port, rx) = oauth::listen_once(Duration::from_millis(150), google_code).unwrap();
        let outcome = rx.recv_timeout(Duration::from_secs(2)).unwrap();
        assert_eq!(outcome.err().as_deref(), Some("GOOGLE_AUTH_CANCELLED"));
    }

    #[test]
    fn state_and_nonce_mismatch_are_rejected_as_google_codes() {
        assert_eq!(
            oauth::validate_state("a", Some("b")).map_err(google_code),
            Err("GOOGLE_AUTH_REJECTED".to_string())
        );
        assert_eq!(
            oauth::validate_nonce("n", None).map_err(google_code),
            Err("GOOGLE_AUTH_REJECTED".to_string())
        );
    }

    #[test]
    fn a_disconnect_beats_an_in_flight_refresh() {
        let state = seeded("r1");
        let generation = state.session.lock().unwrap().generation;
        state.clear_session();
        let stores = Cell::new(0);
        let adopted = adopt_and_persist_with(&state, &tokens("A", Some("r2")), generation, |_| {
            stores.set(stores.get() + 1);
            Ok(())
        });
        assert!(!adopted);
        assert_eq!(mem_access(&state), None);
        assert_eq!(mem_refresh(&state), None);
        assert_eq!(stores.get(), 0);
    }

    #[tokio::test]
    async fn refresh_is_single_flight() {
        let state = seeded("r1");
        let calls = AtomicUsize::new(0);
        let redeem = |_: String| {
            calls.fetch_add(1, Ordering::SeqCst);
            async {
                tokio::time::sleep(Duration::from_millis(50)).await;
                Ok(tokens("A", Some("r2")))
            }
        };
        let redeem2 = |_: String| {
            calls.fetch_add(1, Ordering::SeqCst);
            async {
                tokio::time::sleep(Duration::from_millis(50)).await;
                Ok(tokens("A", Some("r2")))
            }
        };
        let load = || Ok(None);
        let store = |_: &str| Ok(());
        let (a, b) = tokio::join!(
            refresh_and_adopt_with(&state, 0, None, redeem, load, store),
            refresh_and_adopt_with(&state, 0, None, redeem2, load, store),
        );
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(a, Ok("A".to_string()));
        assert_eq!(b, Ok("A".to_string()));
    }

    #[tokio::test]
    async fn a_stale_token_forces_a_real_redemption() {
        let state = seeded("r1");
        assert!(adopt(&state, &tokens("A", Some("r1")), 0));
        let calls = AtomicUsize::new(0);
        let redeem = |_: String| {
            calls.fetch_add(1, Ordering::SeqCst);
            async { Ok(tokens("B", None)) }
        };
        let load = || Ok(None);
        let store = |_: &str| Ok(());

        let fresh = refresh_and_adopt_with(&state, 0, None, redeem, load, store).await;
        assert_eq!(fresh, Ok("A".to_string()));
        assert_eq!(calls.load(Ordering::SeqCst), 0);

        let redeem = |_: String| {
            calls.fetch_add(1, Ordering::SeqCst);
            async { Ok(tokens("B", None)) }
        };
        let forced = refresh_and_adopt_with(&state, 0, Some("A"), redeem, load, store).await;
        assert_eq!(forced, Ok("B".to_string()));
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn a_failed_store_degrades_to_session_only() {
        let state = GoogleState::default();
        let adopted = adopt_and_persist_with(&state, &tokens("A", Some("r1")), 0, |_| {
            Err("GOOGLE_NO_KEYCHAIN".to_string())
        });
        assert!(adopted);
        assert!(*state.session_only.lock().unwrap());
        assert_eq!(mem_refresh(&state), Some("r1".to_string()));
    }

    #[test]
    fn forgetting_session_only_never_deletes_and_normal_deletes_once() {
        let deletes = Cell::new(0);
        let delete = || {
            deletes.set(deletes.get() + 1);
            Ok(())
        };

        let state = seeded("r1");
        *state.session_only.lock().unwrap() = true;
        assert_eq!(forget_with(&state, delete), Ok(()));
        assert_eq!(deletes.get(), 0);
        assert_eq!(mem_refresh(&state), None);

        let state = seeded("r1");
        assert_eq!(forget_with(&state, delete), Ok(()));
        assert_eq!(deletes.get(), 1);
        assert_eq!(mem_refresh(&state), None);
    }

    #[tokio::test]
    async fn invalid_grant_keeps_the_credential() {
        let state = seeded("r1");
        let stores = Cell::new(0);
        let result = refresh_and_adopt_with(
            &state,
            0,
            None,
            |_| async { Err::<auth::GoogleTokens, _>("GOOGLE_AUTH_EXPIRED".to_string()) },
            || Ok(None),
            |_| {
                stores.set(stores.get() + 1);
                Ok(())
            },
        )
        .await;
        assert_eq!(result, Err("GOOGLE_AUTH_EXPIRED".to_string()));
        assert_eq!(mem_refresh(&state), Some("r1".to_string()));
        // No store and (by construction) no delete seam on this path.
        assert_eq!(stores.get(), 0);
    }

    #[tokio::test]
    async fn the_refresh_token_comes_from_load_when_memory_is_empty() {
        let state = GoogleState::default();
        let seen = std::sync::Mutex::new(None);
        let result = refresh_and_adopt_with(
            &state,
            0,
            None,
            |rt| {
                *seen.lock().unwrap() = Some(rt);
                async { Ok(tokens("A", None)) }
            },
            || Ok(Some("from-keychain".to_string())),
            |_| Ok(()),
        )
        .await;
        assert_eq!(result, Ok("A".to_string()));
        assert_eq!(seen.lock().unwrap().as_deref(), Some("from-keychain"));

        let empty = GoogleState::default();
        let none = refresh_and_adopt_with(
            &empty,
            0,
            None,
            |_| async { Ok(tokens("A", None)) },
            || Ok(None),
            |_| Ok(()),
        )
        .await;
        assert_eq!(none, Err("GOOGLE_NOT_CONNECTED".to_string()));
    }

    #[test]
    fn a_refresh_without_a_new_refresh_token_keeps_the_old_one() {
        let state = seeded("r1");
        let stores = Cell::new(0);
        assert!(adopt_and_persist_with(&state, &tokens("A", None), 0, |_| {
            stores.set(stores.get() + 1);
            Ok(())
        }));
        assert_eq!(mem_refresh(&state), Some("r1".to_string()));
        assert_eq!(mem_access(&state), Some("A".to_string()));
        assert_eq!(stores.get(), 0);
    }

    #[test]
    fn a_reconnect_beats_an_old_accounts_in_flight_refresh() {
        let state = seeded("old");
        let generation = state.session.lock().unwrap().generation;
        // google_connect step 7.
        {
            let mut s = state.session.lock().unwrap();
            s.generation = s.generation.wrapping_add(1);
        }
        let stores = Cell::new(0);
        let adopted =
            adopt_and_persist_with(&state, &tokens("A", Some("r-old-acct")), generation, |_| {
                stores.set(stores.get() + 1);
                Ok(())
            });
        assert!(!adopted);
        assert_eq!(mem_refresh(&state), Some("old".to_string()));
        assert_eq!(mem_access(&state), None);
        assert_eq!(stores.get(), 0);
    }
}
