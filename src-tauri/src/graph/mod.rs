//! Microsoft Graph: OAuth (auth code + PKCE), the keychain, and calendarView.
//!
//! All decision logic lives here as pure functions with no network dependency,
//! so it compiles and is unit-tested on every target - the same shape as
//! `meeting_detect`.

mod auth;
mod calendar;
mod keychain;

use serde::{Deserialize, Serialize};

/// Mirrors `src/types/calendar.ts` exactly. `rename_all = "camelCase"` is what
/// makes `start_ms` arrive in the webview as `startMs`; the two files must be
/// changed together.
///
/// `allow(dead_code)`: unused until Tasks 7-11 wire commands that construct
/// and return these - same reason `meeting_detect` allows it per-item.
#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CalendarParticipant {
    pub address: String,
    pub name: Option<String>,
    /// "required" | "optional" | "resource". Kept as a string rather than an
    /// enum: an unknown value from Graph must not fail the whole response, and
    /// the only value any rule tests for is "resource".
    pub r#type: String,
    pub is_organizer: bool,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CalendarEvent {
    pub id: String,
    pub subject: Option<String>,
    /// Epoch MILLISECONDS. See `parse_graph_utc` in calendar.rs for why the
    /// normalization happens here and not in the webview.
    pub start_ms: i64,
    pub end_ms: i64,
    pub is_cancelled: bool,
    pub is_all_day: bool,
    pub own_response: String,
    pub participants: Vec<CalendarParticipant>,
}

/// NO TOKEN FIELD, EVER - enforced by the test at the bottom of this file.
#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GraphStatus {
    pub connected: bool,
    pub session_only: bool,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CurrentMeetings {
    pub own_address: Option<String>,
    pub events: Vec<CalendarEvent>,
}

/// Every failure this module can produce, as the bare string the webview's
/// `toGraphError` maps back to a code. No message text ever accompanies one:
/// a subject or address lifted from a raw reqwest or serde failure would
/// otherwise survive into the report.
///
/// `allow(dead_code)`: unused until Tasks 7-11 return these from commands.
#[allow(dead_code)]
pub const NOT_CONNECTED: &str = "GRAPH_NOT_CONNECTED";
#[allow(dead_code)]
pub const CONSENT_REQUIRED: &str = "GRAPH_CONSENT_REQUIRED";
#[allow(dead_code)]
pub const AUTH_CANCELLED: &str = "GRAPH_AUTH_CANCELLED";
#[allow(dead_code)]
pub const AUTH_EXPIRED: &str = "GRAPH_AUTH_EXPIRED";
#[allow(dead_code)]
pub const AUTH_REJECTED: &str = "GRAPH_AUTH_REJECTED";
#[allow(dead_code)]
pub const BAD_RESPONSE: &str = "GRAPH_BAD_RESPONSE";
#[allow(dead_code)]
pub const THROTTLED: &str = "GRAPH_THROTTLED";
#[allow(dead_code)]
pub const NETWORK: &str = "GRAPH_NETWORK";
#[allow(dead_code)]
pub const NO_KEYCHAIN: &str = "GRAPH_NO_KEYCHAIN";

use std::sync::Mutex;
use tauri::{AppHandle, Manager};
use tauri_plugin_opener::OpenerExt;

/// The access token lives HERE and nowhere else - process memory, never
/// plugin-store, never localStorage, never a log line.
#[derive(Default)]
pub struct Session {
    pub access_token: Option<String>,
    pub expires_at_ms: i64,
    /**
     * The refresh token IN MEMORY - the session-only path's only copy.
     *
     * On Linux with no keychain service nothing is written to disk, so without
     * this field the connection would die at ACCESS-token expiry (~55 minutes)
     * rather than at app quit. The spec says re-authenticate each LAUNCH.
     *
     * On the normal path this mirrors the keychain entry, and the refresh path
     * reads memory first so a keychain hiccup mid-session does not force a
     * reconnect.
     */
    pub refresh_token: Option<String>,
    pub own_address: Option<String>,
    /// Bumped by disconnect. An in-flight call captures it before awaiting and
    /// discards its result if the value moved - which is how "aborts in-flight
    /// calls" is delivered without cancellation tokens threaded everywhere.
    pub generation: u64,
}

/// **Lock invariant:** `persist_op` and `refresh_op` are always outermost -
/// each is held for its whole function body (`refresh_op` even across an
/// `.await`; see its own doc comment). `session` and `session_only` are
/// never held AT THE SAME TIME, so there is no ordering between them to
/// violate: nothing anywhere in this module - production code or tests -
/// ever takes one of the two while already holding the other. In the
/// production code (outside `mod tests`), only `clear_session`, `adopt`, and
/// `fresh_access_token` bind either to a local variable for their own body;
/// every other acquisition is a statement-scoped temporary that drops
/// immediately. `forget_refresh_token_with` reads `session_only` and only
/// then takes `session` (via `clear_session`) - the reverse of the order an
/// earlier version of this comment claimed was universal - and that is
/// harmless for exactly this reason: the two locks are never nested, in
/// either direction.
#[derive(Default)]
pub struct GraphState {
    pub session: Mutex<Session>,
    /// True when no keychain service was available: the connection works for
    /// this launch and NOTHING is written to disk.
    pub session_only: Mutex<bool>,
    /// Guards the adopt-then-persist sequence in `adopt_and_persist_with` and
    /// the clear-then-delete sequence in `forget_refresh_token_with` against
    /// EACH OTHER, so the two can never interleave - see both functions' doc
    /// comments for the race this closes (Task 11 review round 2, Finding B).
    ///
    /// A `std::sync::Mutex`, not a `tokio` one, and deliberately so: neither
    /// critical section contains an `.await` (adopting is in-memory; the
    /// keychain write/delete is a synchronous OS call), so a caller can only
    /// ever block here on the OTHER critical section's keychain I/O -
    /// milliseconds, never the network. That matters concretely for
    /// `graph_disconnect`, which takes this same lock: it must never be able
    /// to block on a `reqwest` call, and this codebase sets no timeout on any
    /// of them.
    persist_op: Mutex<()>,
    /// Serializes `refresh_and_adopt` calls against EACH OTHER - not against
    /// `persist_op`; see that field's own doc comment for why disconnect must
    /// not be made to wait on this one (Task 11 review round 2, Finding C).
    /// Entra rotates the refresh token on every redemption, so two
    /// overlapping `graph_current_meetings` calls redeeming the same stored
    /// token concurrently would leave memory and the keychain holding two
    /// different tokens, or trip Entra's replay detection and revoke the
    /// whole token family.
    ///
    /// A `tokio::sync::Mutex`, not a `std` one: this one IS held across the
    /// `.await` on the token endpoint, which a `std::sync::MutexGuard` must
    /// never do.
    refresh_op: tokio::sync::Mutex<()>,
}

impl GraphState {
    pub fn clear_session(&self) {
        let mut session = self.session.lock().unwrap();
        session.access_token = None;
        session.refresh_token = None;
        session.expires_at_ms = 0;
        session.own_address = None;
        session.generation = session.generation.wrapping_add(1);
    }

    /// Returns `Err` when the keychain cannot be READ.
    ///
    /// It must not collapse that into `connected: false`. `matches!(load(),
    /// Ok(Some(_)))` treats a real read failure as "disconnected", so a
    /// genuinely connected user hits a transient keychain problem, gets
    /// `connected: false` with no error anywhere, and the calendar block simply
    /// VANISHES (`present` goes false in Task 13) instead of saying anything.
    /// A feature that disappears silently is indistinguishable from one that
    /// was never set up.
    pub fn status(&self) -> Result<GraphStatus, String> {
        let session_only = *self.session_only.lock().unwrap();
        // The REFRESH token, not the access token: a connection whose access
        // token has expired is still connected - the next call refreshes.
        // Testing the access token would report a disconnection roughly every
        // 55 minutes.
        let in_memory = self.session.lock().unwrap().refresh_token.is_some();
        // Memory first, and on the session-only path memory is all there is.
        let connected = if session_only || in_memory {
            in_memory
        } else {
            keychain::load_refresh_token()?.is_some()
        };
        Ok(GraphStatus {
            connected,
            session_only,
        })
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Adopt a freshly obtained token set into the session.
///
/// Returns `false` when a disconnect landed while the caller was awaiting -
/// the generation moved, so these tokens belong to a connection the user has
/// since destroyed. The caller must then write NOTHING, keychain included.
///
/// Checking the generation INSIDE the lock is what makes THIS comparison
/// sound: a caller that checked first and adopted second would race the very
/// disconnect it is trying to observe.
///
/// That is NOT, by itself, what makes the whole adopt-then-persist sequence
/// safe against a disconnect (Task 11 review round 2, Finding B). A
/// disconnect landing AFTER this function returns `true` but before the
/// caller's keychain write completes is a separate race this function cannot
/// see or close - it only ever looks at the generation at the single instant
/// it holds the session lock. `adopt_and_persist_with` closes that second
/// race, with `GraphState::persist_op`, not with anything in here.
fn adopt(state: &GraphState, tokens: &auth::Tokens, generation: u64) -> bool {
    let mut session = state.session.lock().unwrap();
    if session.generation != generation {
        return false;
    }
    session.access_token = Some(tokens.access_token.clone());
    session.expires_at_ms = tokens.expires_at_ms;
    // Entra ROTATES on every redemption; `None` means this response carried no
    // new one, so the existing value stands rather than being cleared.
    if tokens.refresh_token.is_some() {
        session.refresh_token = tokens.refresh_token.clone();
    }
    if let Some(id_token) = &tokens.id_token {
        if let Some(address) = auth::own_address_from_id_token(id_token) {
            session.own_address = Some(address);
        }
    }
    true
}

/// Adopt into MEMORY first, persist SECOND, and never let a persist failure
/// throw away a credential we already hold.
///
/// Four separate rules live here:
///
/// 1. **A disconnect that landed before this call even started wins.**
///    `adopt` returning false means the user disconnected while we were
///    awaiting, before this function ran; persisting anyway would REWRITE the
///    keychain entry they just destroyed and leave `status()` reporting
///    connected again after a disconnect that appeared to succeed.
/// 2. **A disconnect that lands DURING this call also wins - `persist_op` is
///    why (Task 11 review round 2, Finding B).** Rule 1's generation check
///    only catches a disconnect that finished before `adopt` runs; it says
///    nothing about one that starts partway through THIS function's body,
///    between a successful `adopt` and the `persist` call below - see
///    `adopt`'s own doc comment. Holding `state.persist_op` for this entire
///    function closes that window: `forget_refresh_token_with` (which
///    `graph_disconnect` calls) takes the SAME lock for its own
///    clear-then-delete sequence, so the two can never interleave. Either
///    this function's adopt-then-persist runs to completion first and a
///    disconnect then clears/deletes what it just wrote, or a disconnect's
///    clear-then-delete runs first and `adopt` here sees the bumped
///    generation and returns false before `persist` is ever reached. There is
///    no state in between where a disconnect could observe an adopted-but-
///    not-yet-persisted (or persisted-but-about-to-be-overwritten) token.
/// 3. **Session-only never touches disk.** The write is skipped, not attempted
///    and ignored - `persist` would still run and its `Err` would still need
///    handling, so every request after access-token expiry died on the one
///    platform where the refuse-to-persist rule applies.
/// 4. **A persist failure degrades; it does not discard.** `available()` is a
///    heuristic over error variants (see keychain.rs), so it can be wrong, and
///    the keychain can also go away mid-session. We already hold working tokens
///    in memory at this point - falling back to session-only keeps the user
///    working until quit, where propagating the error would throw away a
///    credential that is fine.
///
/// `persist` is injected rather than calling `auth::persist_rotated` directly,
/// for the same reason `forget_refresh_token_with` injects `delete` (Ruling
/// 20): a test proving "the session-only path never persists" must not be
/// able to reach a real keychain regardless of whether rule 3's early return
/// is even there. A version that called the real `auth::persist_rotated` and
/// only checked `Ok(())` plus the two memory values passed identically with
/// or without that early return - a stored refresh token this test never
/// created has nothing to overwrite - and on a developer machine that DOES
/// have one stored, the same missing guard would silently overwrite it with
/// this test's literal `"rotated"` (Task 11 review round 2, Finding A).
fn adopt_and_persist_with(
    state: &GraphState,
    tokens: &auth::Tokens,
    generation: u64,
    persist: impl FnOnce(&auth::Tokens) -> Result<(), String>,
) -> Result<(), String> {
    let _persist_guard = state.persist_op.lock().unwrap();
    if !adopt(state, tokens, generation) {
        return Err(NOT_CONNECTED.to_string());
    }
    if *state.session_only.lock().unwrap() {
        return Ok(());
    }
    if persist(tokens).is_err() {
        *state.session_only.lock().unwrap() = true;
    }
    Ok(())
}

/// Called with the real keychain write. See `adopt_and_persist_with` for the
/// full contract this wraps.
fn adopt_and_persist(
    state: &GraphState,
    tokens: &auth::Tokens,
    generation: u64,
) -> Result<(), String> {
    adopt_and_persist_with(state, tokens, generation, auth::persist_rotated)
}

/// The shared clear-and-decide sequence behind both `forget_refresh_token`
/// (called on an explicit `invalid_grant`) and `graph_disconnect` (called on a
/// user-initiated disconnect).
///
/// Held under `state.persist_op` for its entire body - the SAME lock
/// `adopt_and_persist_with` holds for its own adopt-then-persist sequence
/// (Task 11 review round 2, Finding B). That is what stops a refresh's
/// persist and a disconnect's clear-then-delete from interleaving: whichever
/// of the two acquires `persist_op` first runs to completion, keychain I/O
/// included, before the other's body even starts. See `adopt_and_persist_
/// with`'s doc comment (rule 2) for the failure this closes.
///
/// Memory is cleared first and unconditionally, before `delete` - whatever the
/// keychain does, a token this caller has decided to discard must not survive
/// in this process. On the session-only path `delete` is never invoked at all:
/// `available()` was false at connect, so a real keychain call would always
/// error, and Disconnect/forget would be impossible on exactly the platform
/// where memory holds the ONLY copy of the credential. Otherwise `delete`'s
/// result is propagated rather than discarded with `let _ =` - a silently
/// failed delete leaves a token on disk while memory says disconnected, so the
/// next launch reads it straight back with nothing telling the user why.
///
/// `delete` is injected rather than calling `keychain::delete_refresh_token`
/// directly so tests can prove BOTH halves of the contract - that it runs
/// exactly once on the normal path, and NOT AT ALL on the session-only path -
/// without any test touching a real keychain entry. A pure-function extraction
/// (returning "should delete: bool" for a caller to act on) would not do this:
/// the defect this seam guards against lives in whether `delete` actually gets
/// invoked, which only a fake in the dispatch position can observe.
fn forget_refresh_token_with(
    state: &GraphState,
    delete: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    let _persist_guard = state.persist_op.lock().unwrap();
    let was_session_only = *state.session_only.lock().unwrap();
    state.clear_session();
    if was_session_only {
        return Ok(());
    }
    delete()
}

/// Called ONLY on an explicit `invalid_grant` - the one response that proves
/// the refresh token is genuinely dead. See `forget_refresh_token_with` for
/// the clear-then-delete sequence this wraps with the real keychain call.
fn forget_refresh_token(state: &GraphState) -> Result<(), String> {
    forget_refresh_token_with(state, keychain::delete_refresh_token)
}

/// The access token already in memory, if any, and not yet expired.
///
/// Shared by two call sites for the same reason: the fast path at the top of
/// `graph_current_meetings` (skip refreshing entirely when a valid token is
/// already there) and the re-read inside `refresh_and_adopt`, immediately
/// after acquiring `refresh_op` (skip a redundant redemption when a
/// concurrent call already refreshed while this one was waiting for the
/// lock - Task 11 review round 2, Finding C).
fn fresh_access_token(state: &GraphState) -> Option<String> {
    let session = state.session.lock().unwrap();
    match &session.access_token {
        Some(token) if session.expires_at_ms > now_ms() => Some(token.clone()),
        _ => None,
    }
}

/// The ONE refresh path. Both call sites in `graph_current_meetings` go through
/// it, which is what keeps the `invalid_grant` handling identical between them.
///
/// The earlier draft special-cased AUTH_EXPIRED at the first call site and used
/// a bare `?` at the second, so a refresh token revoked at the same moment as
/// the access token - a password change, the single commonest cause - left the
/// dead credential sitting in the keychain forever.
///
/// Held under `state.refresh_op` for the whole call, ACROSS the `.await` on
/// the token endpoint (Task 11 review round 2, Finding C) - `refresh_op` is a
/// `tokio::sync::Mutex` specifically so a guard can do that; a
/// `std::sync::MutexGuard` must never cross an `.await`. Two overlapping
/// `graph_current_meetings` calls would otherwise both read the same stored
/// refresh token and both redeem it: Entra rotates on every redemption, so
/// the loser's redemption either fails outright or leaves memory and the
/// keychain disagreeing about which token is current, and a double
/// redemption can also trip Entra's replay detection and revoke the whole
/// token family. Deliberately a SEPARATE lock from `persist_op`: a caller
/// waiting here waits on the NETWORK, and this codebase sets no `reqwest`
/// timeout anywhere, so `graph_disconnect` sharing this lock could hang
/// indefinitely instead of returning in milliseconds. See `GraphState`'s own
/// doc comment for the full lock order, which is why this function is free to
/// call `adopt_and_persist` (itself taking `persist_op`) while still holding
/// `refresh_op`.
///
/// `stale` is the access token the caller already knows is no good - `None`
/// at the initial call site (there is no prior token to disbelieve), and
/// `Some(&access)` at the 401-retry call site, carrying the token that was
/// just rejected. It exists because local expiry (`expires_at_ms`, set ~55
/// minutes out) is not cleared on a 401: without `stale`, the post-lock
/// re-read below would find that same rejected token still sitting in
/// memory, still locally "fresh", and hand it straight back - turning the
/// mandated refresh-and-retry into a no-op that reproduces the identical 401
/// for up to that long. See `graph_current_meetings`'s retry arm for the
/// full consequence.
async fn refresh_and_adopt(
    state: &GraphState,
    authority: &str,
    client_id: &str,
    generation: u64,
    stale: Option<&str>,
) -> Result<String, String> {
    let _refresh_guard = state.refresh_op.lock().await;

    // Re-read AFTER acquiring the lock: a call that was waiting here may have
    // queued behind one that already redeemed and adopted a fresh token. Take
    // the shortcut only when memory now holds a token DIFFERENT from `stale`
    // - proof that a concurrent winner adopted something new, not just that
    // the caller's own already-rejected token is still sitting there
    // unexpired. Redeeming the stored refresh token a second time is skipped
    // only in that first case.
    if let Some(token) = fresh_access_token(state) {
        if Some(token.as_str()) != stale {
            return Ok(token);
        }
    }

    let stored = stored_refresh_token(state)?;
    let tokens = match auth::refresh(authority, client_id, &stored, now_ms()).await {
        Ok(tokens) => tokens,
        Err(code) if code == AUTH_EXPIRED => {
            // A keychain failure while forgetting is surfaced, not swallowed:
            // "your credential is dead AND it is stuck on disk" is a different
            // problem from "reconnect", and the user can act on it.
            forget_refresh_token(state)?;
            return Err(AUTH_EXPIRED.to_string());
        }
        Err(code) => return Err(code),
    };
    let access = tokens.access_token.clone();
    adopt_and_persist(state, &tokens, generation)?;
    Ok(access)
}

/// MEMORY FIRST, then the keychain.
///
/// The session-only path (Linux with no keychain service) has no keychain
/// entry at all, so a keychain-only read would strand it at access-token
/// expiry. On the normal path memory and keychain hold the same value, and
/// preferring memory also survives a transient keychain failure mid-session.
fn stored_refresh_token(state: &GraphState) -> Result<String, String> {
    if let Some(token) = state.session.lock().unwrap().refresh_token.clone() {
        return Ok(token);
    }
    if *state.session_only.lock().unwrap() {
        // Nothing was ever written to disk, so there is nothing to fall back
        // to - this is the re-authenticate-each-launch state.
        return Err(NOT_CONNECTED.to_string());
    }
    keychain::load_refresh_token()?.ok_or_else(|| NOT_CONNECTED.to_string())
}

#[tauri::command]
pub async fn graph_connect(
    app: AppHandle,
    client_id: String,
    authority: String,
) -> Result<GraphStatus, String> {
    let state = app.state::<GraphState>();

    // Bind BEFORE opening the browser: the redirect URI must carry the real
    // port, and a bind failure must not leave a consent screen with nowhere
    // to land.
    let (port, rx) = auth::listen_once(auth::LISTENER_TIMEOUT)?;
    let pkce = auth::new_pkce();
    let expected_state = auth::random_token(24);
    let expected_nonce = auth::random_token(24);

    // Returns Err on a malformed or non-https authority - the user typed it,
    // and it is the host that will receive the code, the verifier and the
    // refresh token. Nothing is opened until it is validated.
    let url = auth::authorize_url(
        &authority,
        &client_id,
        port,
        &pkce.challenge,
        &expected_state,
        &expected_nonce,
    )?;
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|_| NETWORK.to_string())?;

    // Read the channel EXACTLY ONCE. There is no "already delivered" guard
    // downstream - the watchdog/success race in `listen_once` is safe by
    // TIMING, not by construction, and a stale watchdog can dial a RECYCLED
    // ephemeral port belonging to a later listener and deliver a spurious
    // empty `Ok` into this channel. A second read, or a loop, would risk
    // consuming that spurious delivery as if it were real.
    //
    // An empty `Callback` (all fields `None`, as `listen_once` sends on a
    // parse failure or a recycled-port race) fails closed here with no extra
    // guard needed: its `state` is `None`, and `validate_state` below rejects
    // a `None` state exactly like a mismatched one.
    let callback = tauri::async_runtime::spawn_blocking(move || rx.recv())
        .await
        .map_err(|_| NETWORK.to_string())?
        .map_err(|_| AUTH_CANCELLED.to_string())??;

    if let Some(error) = &callback.error {
        return Err(auth::classify_callback_error(error).to_string());
    }
    // Validated BEFORE the code is redeemed - a mismatch sends nothing to the
    // token endpoint.
    auth::validate_state(&expected_state, callback.state.as_deref())?;
    let code = callback.code.ok_or_else(|| AUTH_CANCELLED.to_string())?;

    let tokens = auth::exchange_code(
        &authority,
        &client_id,
        &code,
        &pkce.verifier,
        port,
        now_ms(),
    )
    .await?;

    // The nonce binds this ID token to this authorize request. An ABSENT id
    // token is a rejection, not a skip - see auth::validate_nonce.
    auth::validate_nonce(&expected_nonce, tokens.id_token.as_deref())?;

    // `available()` is only the fast path. adopt_and_persist degrades to
    // session-only if the write fails anyway, so a wrong guess here costs
    // nothing - where propagating a persist failure would discard a credential
    // we have already paid for the browser round trip to obtain, forcing the
    // user through the whole flow again.
    *state.session_only.lock().unwrap() = !keychain::available();
    let generation = state.session.lock().unwrap().generation;
    adopt_and_persist(&state, &tokens, generation)?;
    state.status()
}

#[tauri::command]
pub async fn graph_disconnect(app: AppHandle) -> Result<(), String> {
    let state = app.state::<GraphState>();

    // Routed through the same clear-then-delete sequence `forget_refresh_token`
    // uses, rather than hand-copied: the two functions differ only in that
    // this one also resets `session_only` to `false` afterwards, and that
    // reset is a no-op on every path that matters. On the session-only branch
    // `forget_refresh_token_with` returns before any delete, so there is no
    // delete for the reset to race; on the normal branch the flag is already
    // `false`, so setting it again after `delete()` rather than before is
    // unobservable. Doing it after (rather than threading it through the seam)
    // keeps the seam's contract - clear memory, then run `delete` or not -
    // free of a disconnect-specific detail the forget-on-invalid_grant path
    // has no use for.
    let result = forget_refresh_token_with(&state, keychain::delete_refresh_token);
    *state.session_only.lock().unwrap() = false;
    result
}

#[tauri::command]
pub fn graph_status(app: AppHandle) -> Result<GraphStatus, String> {
    app.state::<GraphState>().status()
}

#[tauri::command]
pub async fn graph_current_meetings(
    app: AppHandle,
    client_id: String,
    authority: String,
    start_iso: String,
    end_iso: String,
) -> Result<CurrentMeetings, String> {
    let state = app.state::<GraphState>();
    let generation = state.session.lock().unwrap().generation;

    let mut token = fresh_access_token(&state);

    // BOTH refresh sites go through refresh_and_adopt, which is what makes the
    // invalid_grant handling identical between them. `stale: None` here -
    // there is no prior token at this call site for the post-lock re-read to
    // mistake for a live one.
    if token.is_none() {
        token = Some(refresh_and_adopt(&state, &authority, &client_id, generation, None).await?);
    }

    let access = token.ok_or_else(|| NOT_CONNECTED.to_string())?;
    let body = match calendar::fetch_calendar_view(&access, &start_iso, &end_iso).await {
        Ok(body) => body,
        // ONE refresh-and-retry on a 401, then give up. A second 401 after a
        // fresh token is a real authorization failure - scopes or tenant
        // policy changed - and the refresh token is RETAINED.
        //
        // `stale: Some(&access)` - the token that was JUST rejected - is what
        // makes this a real retry rather than a no-op. `access` stays locally
        // "fresh" for up to ~55 more minutes (a 401 never clears
        // `expires_at_ms`), so without `stale` the post-lock re-read inside
        // `refresh_and_adopt` would find that same rejected token still in
        // memory and hand it straight back, and this arm would refetch with
        // the identical token Graph just refused, reproducing the identical
        // 401. Passing `stale` forces `refresh_and_adopt` to tell "a
        // concurrent call already adopted something new" (shortcut fires)
        // apart from "memory still holds what I had rejected" (shortcut
        // skipped, a real redemption is attempted).
        Err(code) if code == AUTH_REJECTED => {
            let refreshed =
                refresh_and_adopt(&state, &authority, &client_id, generation, Some(&access))
                    .await?;
            calendar::fetch_calendar_view(&refreshed, &start_iso, &end_iso).await?
        }
        Err(code) => return Err(code),
    };

    // A disconnect that landed while this was in flight invalidates the
    // result: returning it would answer a question the user has withdrawn.
    //
    // This check is now a BACKSTOP rather than the only guard. `adopt` makes
    // the same comparison under the session lock before writing anything, so a
    // disconnect can no longer be undone by a refresh that was already in the
    // air - which is what this check alone, sitting after the fetch, allowed.
    if state.session.lock().unwrap().generation != generation {
        return Err(NOT_CONNECTED.to_string());
    }

    // **DEVIATION from the task brief, reported per its instructions:** the
    // brief's verbatim form read `own_address` inline inside the
    // `CurrentMeetings { .. }` struct literal that is this function's tail
    // expression. That does not compile (E0597): the `MutexGuard` temporary
    // this produces is, per the tail-expression drop-order rule, kept alive
    // until after `state` itself would be dropped at the end of the block,
    // which the borrow checker rejects even though nothing here actually
    // depends on `state` outliving the guard. Hoisting the read into its own
    // `let` - the same pattern `generation` already uses a few lines up -
    // drops the guard immediately, before `state` goes out of scope, and
    // sidesteps the conflict entirely.
    let own_address = state.session.lock().unwrap().own_address.clone();
    Ok(CurrentMeetings {
        own_address,
        events: calendar::parse_events(&body)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The executable form of the spec's central security invariant.
    ///
    /// Every struct an exposed command can return is serialized here and
    /// scanned for credential-shaped keys. A future edit that widens one of
    /// these to carry a token fails this test rather than shipping.
    #[test]
    fn no_exposed_command_return_type_serializes_a_credential() {
        const FORBIDDEN: &[&str] = &[
            "token",
            "access",
            "refresh",
            "secret",
            "credential",
            "verifier",
            "code",
            "assertion",
            "password",
        ];

        let payloads = vec![
            serde_json::to_string(&GraphStatus {
                connected: true,
                session_only: false,
            })
            .unwrap(),
            serde_json::to_string(&CurrentMeetings {
                own_address: Some("me@corp.test".into()),
                events: vec![CalendarEvent {
                    id: "e1".into(),
                    subject: Some("Sync".into()),
                    start_ms: 0,
                    end_ms: 0,
                    is_cancelled: false,
                    is_all_day: false,
                    own_response: "accepted".into(),
                    participants: vec![CalendarParticipant {
                        address: "cfo@acme.example".into(),
                        name: None,
                        r#type: "required".into(),
                        is_organizer: false,
                    }],
                }],
            })
            .unwrap(),
        ];

        for payload in payloads {
            // Keys only: a VALUE may legitimately contain one of these words
            // (a meeting subject is free text), a KEY may not.
            for key in serde_json::from_str::<serde_json::Value>(&payload)
                .unwrap()
                .to_string()
                .split('"')
                .filter(|s| !s.is_empty())
            {
                for needle in FORBIDDEN {
                    assert!(
                        !key.to_lowercase().contains(needle)
                            || !payload.contains(&format!("\"{key}\":")),
                        "exposed return type serializes a credential-shaped key: {key}"
                    );
                }
            }
        }
    }

    #[test]
    fn disconnect_zeroes_the_in_memory_access_token() {
        // Clearing only the keychain leaves a live token in Rust memory that
        // keeps working until its expiry - a disconnect that does not
        // disconnect.
        let state = GraphState::default();
        {
            let mut session = state.session.lock().unwrap();
            session.access_token = Some("live".into());
            session.refresh_token = Some("also-live".into());
            session.expires_at_ms = i64::MAX;
            session.generation = 3;
        }
        state.clear_session();
        let session = state.session.lock().unwrap();
        assert!(session.access_token.is_none());
        // The session-only path's ONLY copy of the refresh token lives here,
        // so a disconnect that left it behind would not disconnect at all.
        assert!(session.refresh_token.is_none());
        assert_eq!(session.expires_at_ms, 0);
        // A bumped generation is what makes an in-flight call abandon its
        // result instead of writing it back after the disconnect.
        assert_eq!(session.generation, 4);
    }

    #[test]
    fn session_only_reports_disconnected_with_nothing_in_memory() {
        let state = GraphState::default();
        *state.session_only.lock().unwrap() = true;
        assert_eq!(
            state.status().unwrap(),
            GraphStatus {
                connected: false,
                session_only: true
            }
        );
    }

    /// A session-only connection lasts until app QUIT, not until access-token
    /// expiry. Reading the access token in `status()` would report a
    /// disconnection roughly every 55 minutes, and `stored_refresh_token`
    /// reading only the keychain would make the next call fail outright - on
    /// the one platform where the refuse-to-persist rule applies.
    #[test]
    fn session_only_survives_access_token_expiry() {
        let state = GraphState::default();
        *state.session_only.lock().unwrap() = true;
        {
            let mut session = state.session.lock().unwrap();
            session.refresh_token = Some("in-memory-only".into());
            session.access_token = Some("stale".into());
            session.expires_at_ms = 0; // long expired
        }
        assert_eq!(
            state.status().unwrap(),
            GraphStatus {
                connected: true,
                session_only: true
            }
        );
        assert_eq!(
            stored_refresh_token(&state),
            Ok("in-memory-only".to_string())
        );
    }

    /// A disconnect landing while a refresh is in the air must not be undone by
    /// that refresh completing. `adopt` compares the generation UNDER the
    /// session lock and writes nothing on a mismatch; `adopt_and_persist_with`
    /// then refuses to touch the keychain at all, so the entry the user just
    /// deleted is not rewritten behind them.
    ///
    /// Routed through `adopt_and_persist_with` with a spy `persist`, not
    /// through the `adopt_and_persist` wrapper, so "persist is never reached"
    /// is an assertion here rather than an accident of `adopt` failing first -
    /// the same reasoning as `session_only_adopts_without_persisting` above.
    #[test]
    fn a_disconnect_mid_flight_beats_a_refresh_that_was_already_running() {
        let state = GraphState::default();
        let generation = state.session.lock().unwrap().generation;
        let tokens = auth::Tokens {
            access_token: "fresh".into(),
            expires_at_ms: i64::MAX,
            refresh_token: Some("rotated".into()),
            id_token: None,
        };

        // The disconnect lands first, bumping the generation.
        state.clear_session();

        assert!(
            !adopt(&state, &tokens, generation),
            "stale generation must not adopt"
        );
        let persist_was_called = std::cell::Cell::new(false);
        assert_eq!(
            adopt_and_persist_with(&state, &tokens, generation, |_| {
                persist_was_called.set(true);
                Ok(())
            }),
            Err(NOT_CONNECTED.to_string())
        );
        assert!(
            !persist_was_called.get(),
            "a stale generation must never reach persist"
        );
        let session = state.session.lock().unwrap();
        assert!(
            session.access_token.is_none(),
            "a disconnected session stayed disconnected"
        );
        assert!(session.refresh_token.is_none());
    }

    /// On the session-only path `available()` was false at connect, so any
    /// keychain call errors. Deleting BEFORE clearing memory therefore made
    /// Disconnect impossible on exactly the platform where memory holds the only
    /// copy of the credential. Memory is cleared unconditionally and first.
    ///
    /// **Ruling 20:** this is routed through `forget_refresh_token_with` with a
    /// spy `delete`, not through the `forget_refresh_token` wrapper. A version
    /// that called `forget_refresh_token(&state)` directly and asserted only
    /// `Ok(())` plus a cleared session - the test's original form - passes
    /// identically whether or not the `if was_session_only { return Ok(()); }`
    /// early return is even present, because `keychain::delete_refresh_token`
    /// maps a missing entry to `Ok(())` too. That is bad on its own (the
    /// "touches no keychain" half of this test's own name was asserted
    /// nowhere) and worse on a developer machine that DOES have a stored
    /// credential: the same missing early return would make `cargo test`
    /// delete it for real. The spy below makes "untouched" an assertion, and -
    /// unlike the wrapper - can never reach a real keychain no matter what this
    /// test does or doesn't catch.
    #[test]
    fn forgetting_on_the_session_only_path_touches_no_keychain_and_clears_memory() {
        let state = GraphState::default();
        *state.session_only.lock().unwrap() = true;
        state.session.lock().unwrap().refresh_token = Some("in-memory-only".into());

        let delete_was_called = std::cell::Cell::new(false);
        let result = forget_refresh_token_with(&state, || {
            delete_was_called.set(true);
            Ok(())
        });

        assert_eq!(result, Ok(()));
        assert!(state.session.lock().unwrap().refresh_token.is_none());
        assert!(
            !delete_was_called.get(),
            "the session-only path must never call the keychain delete"
        );
    }

    /// The other half of the seam's contract: on the normal (non-session-only)
    /// path, `delete` runs, and runs exactly once.
    #[test]
    fn forgetting_on_the_normal_path_calls_delete_exactly_once() {
        let state = GraphState::default();
        state.session.lock().unwrap().refresh_token = Some("stored".into());

        let delete_calls = std::cell::Cell::new(0u32);
        let result = forget_refresh_token_with(&state, || {
            delete_calls.set(delete_calls.get() + 1);
            Ok(())
        });

        assert_eq!(result, Ok(()));
        assert_eq!(delete_calls.get(), 1);
        assert!(state.session.lock().unwrap().refresh_token.is_none());
    }

    /// A delete failure is surfaced, not swallowed - the half of the contract a
    /// real regression is likelier to hit than the "runs at all" half above.
    #[test]
    fn forgetting_surfaces_a_delete_error_rather_than_swallowing_it() {
        let state = GraphState::default();
        state.session.lock().unwrap().refresh_token = Some("stored".into());

        let result = forget_refresh_token_with(&state, || Err(NO_KEYCHAIN.to_string()));

        assert_eq!(result, Err(NO_KEYCHAIN.to_string()));
    }

    /// Session-only must never write to disk, and a skipped write is not a
    /// failure: the tokens still reach memory and the call proceeds.
    ///
    /// **Finding A (Task 11 review round 2):** the same seam Ruling 20
    /// required for `forget_refresh_token`, one level up. The pre-fix version
    /// of this test called the real `adopt_and_persist(&state, &tokens,
    /// generation)` and asserted only `Ok(())` plus the two memory values -
    /// and passed identically whether or not the `if
    /// *state.session_only.lock().unwrap() { return Ok(()); }` guard inside
    /// `adopt_and_persist_with` was even there: with the guard deleted,
    /// `adopt` still succeeds, `persist_rotated` still runs for real, and
    /// `store_refresh_token("rotated")` still succeeds - straight into the
    /// developer's actual Credential Manager entry under
    /// `com.meetwings.graph`, clobbering a live refresh token with the
    /// literal string `"rotated"`. All three of the old assertions still
    /// held. The spy below makes "session-only never persists" an assertion
    /// instead of an accident of which stored value happened to be there.
    #[test]
    fn session_only_adopts_without_persisting() {
        let state = GraphState::default();
        *state.session_only.lock().unwrap() = true;
        let generation = state.session.lock().unwrap().generation;
        let tokens = auth::Tokens {
            access_token: "fresh".into(),
            expires_at_ms: i64::MAX,
            refresh_token: Some("rotated".into()),
            id_token: None,
        };

        let persist_was_called = std::cell::Cell::new(false);
        let result = adopt_and_persist_with(&state, &tokens, generation, |_| {
            persist_was_called.set(true);
            Ok(())
        });

        assert_eq!(result, Ok(()));
        assert!(
            !persist_was_called.get(),
            "the session-only path must never call persist"
        );
        let session = state.session.lock().unwrap();
        assert_eq!(session.access_token.as_deref(), Some("fresh"));
        assert_eq!(session.refresh_token.as_deref(), Some("rotated"));
    }

    /// The other half of the seam's contract: on the normal (non-session-only)
    /// path, `persist` runs, and runs exactly once.
    #[test]
    fn adopt_and_persist_on_the_normal_path_calls_persist_exactly_once() {
        let state = GraphState::default();
        let generation = state.session.lock().unwrap().generation;
        let tokens = auth::Tokens {
            access_token: "fresh".into(),
            expires_at_ms: i64::MAX,
            refresh_token: Some("rotated".into()),
            id_token: None,
        };

        let persist_calls = std::cell::Cell::new(0u32);
        let result = adopt_and_persist_with(&state, &tokens, generation, |_| {
            persist_calls.set(persist_calls.get() + 1);
            Ok(())
        });

        assert_eq!(result, Ok(()));
        assert_eq!(persist_calls.get(), 1);
    }

    /// Rule 4 of `adopt_and_persist_with`'s own doc comment - a persist
    /// failure degrades to session-only rather than discarding the
    /// credential - asserted nowhere before this test. `Ok(())` alone would
    /// also be returned by a version that silently dropped the tokens on a
    /// persist failure, so this checks both the return value AND that the
    /// tokens are still live in memory with `session_only` now `true`.
    #[test]
    fn adopt_and_persist_degrades_to_session_only_on_a_persist_failure() {
        let state = GraphState::default();
        let generation = state.session.lock().unwrap().generation;
        let tokens = auth::Tokens {
            access_token: "fresh".into(),
            expires_at_ms: i64::MAX,
            refresh_token: Some("rotated".into()),
            id_token: None,
        };

        let result =
            adopt_and_persist_with(
                &state,
                &tokens,
                generation,
                |_| Err(NO_KEYCHAIN.to_string()),
            );

        assert_eq!(result, Ok(()));
        assert!(*state.session_only.lock().unwrap());
        let session = state.session.lock().unwrap();
        assert_eq!(session.access_token.as_deref(), Some("fresh"));
        assert_eq!(session.refresh_token.as_deref(), Some("rotated"));
    }

    /// Nothing was written to disk, so there is nothing to fall back to. This
    /// is the re-authenticate-each-launch state, and it must be NOT_CONNECTED
    /// rather than a keychain error.
    #[test]
    fn session_only_with_no_memory_token_is_not_connected() {
        let state = GraphState::default();
        *state.session_only.lock().unwrap() = true;
        assert_eq!(stored_refresh_token(&state), Err(NOT_CONNECTED.to_string()));
    }

    #[test]
    fn fresh_access_token_is_none_when_absent_or_expired_some_when_valid() {
        let state = GraphState::default();
        assert_eq!(fresh_access_token(&state), None);

        {
            let mut session = state.session.lock().unwrap();
            session.access_token = Some("stale".into());
            session.expires_at_ms = 0; // long expired
        }
        assert_eq!(fresh_access_token(&state), None);

        {
            let mut session = state.session.lock().unwrap();
            session.access_token = Some("fresh".into());
            session.expires_at_ms = i64::MAX;
        }
        assert_eq!(fresh_access_token(&state), Some("fresh".to_string()));
    }

    /// **Finding C (Task 11 review round 2):** two overlapping
    /// `graph_current_meetings` calls must not both redeem the same stored
    /// refresh token - Entra rotates on every redemption, so a double
    /// redemption leaves memory and the keychain holding different tokens, or
    /// trips Entra's replay detection outright.
    ///
    /// A literal two-call test can't drive a real redemption without a live
    /// token endpoint, so the FIRST call is simulated directly: it adopts a
    /// fresh token via `adopt_and_persist_with`, exactly as a real
    /// `refresh_and_adopt` would have. The SECOND call goes through the real
    /// `refresh_and_adopt`, with `stale: None` (the initial call site's case
    /// - there is no prior token to disbelieve) and the authority pointed at
    /// a loopback address nothing listens on: if the post-lock re-read were
    /// missing or broken, this call would fall through to `auth::refresh` and
    /// fail with NETWORK (see `post_token_maps_a_refused_connection_to_network`
    /// in auth.rs, which dials the same address) instead of returning the
    /// token the first call already adopted.
    #[tokio::test]
    async fn refresh_and_adopt_finds_a_token_another_call_already_adopted_and_does_not_redeem_again(
    ) {
        let state = GraphState::default();
        let generation = state.session.lock().unwrap().generation;
        let tokens = auth::Tokens {
            access_token: "already-fresh".into(),
            expires_at_ms: i64::MAX,
            refresh_token: Some("rt".into()),
            id_token: None,
        };
        assert_eq!(
            adopt_and_persist_with(&state, &tokens, generation, |_| Ok(())),
            Ok(())
        );

        let result =
            refresh_and_adopt(&state, "https://127.0.0.1:1", "client-1", generation, None).await;
        assert_eq!(result, Ok("already-fresh".to_string()));
    }

    /// The bug this whole parameter exists to fix: the 401-retry call site
    /// passes `stale: Some(&access)`, the token that was just rejected. If
    /// memory still holds exactly that token - because a 401 never clears
    /// `expires_at_ms`, so `fresh_access_token` still calls it "fresh" - the
    /// post-lock shortcut must NOT fire. It must fall through to a real
    /// redemption attempt, which (same loopback trick as the sibling test
    /// above) fails with NETWORK rather than silently handing back the
    /// rejected token and turning the mandated retry into a no-op.
    #[tokio::test]
    async fn refresh_and_adopt_does_not_shortcut_on_the_token_the_caller_just_had_rejected() {
        let state = GraphState::default();
        let generation = state.session.lock().unwrap().generation;
        let tokens = auth::Tokens {
            access_token: "rejected-but-locally-unexpired".into(),
            expires_at_ms: i64::MAX,
            refresh_token: Some("rt".into()),
            id_token: None,
        };
        assert_eq!(
            adopt_and_persist_with(&state, &tokens, generation, |_| Ok(())),
            Ok(())
        );

        let result = refresh_and_adopt(
            &state,
            "https://127.0.0.1:1",
            "client-1",
            generation,
            Some("rejected-but-locally-unexpired"),
        )
        .await;
        assert_eq!(result, Err(NETWORK.to_string()));
    }

    /// Pins the comparison to the STALE value specifically, not to
    /// `stale.is_some()`. Memory holds a token different from `stale`, so the
    /// concurrent-winner shortcut this parameter must not disable still
    /// fires - proving a naive `if stale.is_none()` implementation (which
    /// would also pass the two tests above) is wrong: it would silently skip
    /// the shortcut, and re-redeem, on every single retry.
    #[tokio::test]
    async fn refresh_and_adopt_still_takes_the_shortcut_when_memory_holds_a_different_token() {
        let state = GraphState::default();
        let generation = state.session.lock().unwrap().generation;
        let tokens = auth::Tokens {
            access_token: "adopted-by-a-concurrent-winner".into(),
            expires_at_ms: i64::MAX,
            refresh_token: Some("rt".into()),
            id_token: None,
        };
        assert_eq!(
            adopt_and_persist_with(&state, &tokens, generation, |_| Ok(())),
            Ok(())
        );

        let result = refresh_and_adopt(
            &state,
            "https://127.0.0.1:1",
            "client-1",
            generation,
            Some("some-other-token"),
        )
        .await;
        assert_eq!(result, Ok("adopted-by-a-concurrent-winner".to_string()));
    }
}
