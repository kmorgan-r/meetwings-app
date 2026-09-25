# Outlook Connection Survives invalid_grant — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop deleting the Outlook (Graph) keychain credential on the first Entra `invalid_grant`, add a single-instance guard, and stop reporting a transient keychain read failure as "disconnected".

**Architecture:** Rust keeps an in-memory `invalid_grant_streak` on `GraphState`; a new `record_invalid_grant_with` counts confirmed failures against the CURRENT credential under `persist_op` and deletes only at 3. `refresh_and_adopt` is split into an injectable `refresh_and_adopt_with` seam so the arm is testable without a network or a real keychain. `tauri-plugin-single-instance` surfaces the dashboard on a second launch. In the webview, `GRAPH_NO_KEYCHAIN` becomes retryable with a reconnect hint; the hook's `readStatus` is deliberately left as is (see Task 4's deviation note) and only gains pinning tests.

**Tech Stack:** Tauri 2 (Rust, tokio), React 19 + TypeScript (strict), Vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-09-21-issue-73-outlook-connection-dies-on-invalid-grant-manual-reconnect-only-design.md`

## Global Constraints

- Threshold: `INVALID_GRANT_FORGET_THRESHOLD: u32 = 3`; the comparison is `streak >= INVALID_GRANT_FORGET_THRESHOLD`.
- The streak is in memory only; never persisted. It resets ONLY on a successful `adopt` inside `adopt_and_persist_with`, and is NOT reset after reaching the threshold.
- Only `AUTH_EXPIRED` (Entra `invalid_grant`) counts. `NETWORK`, `THROTTLED`, `AUTH_REJECTED`, `CONSENT_REQUIRED`, `BAD_RESPONSE`, `NO_KEYCHAIN` never touch the streak.
- No Rust test may reach a real keychain: every test that can reach `persist`/`delete` injects them, and every seam test seeds a refresh token in memory and makes no call after one that cleared memory on the normal (non-session-only) path.
- New dependency allowed: `tauri-plugin-single-instance = "2"` only. No new npm packages.
- `AUTH_EXPIRED` copy, verbatim: `Your Microsoft sign-in expired. Reconnect from the Odoo page's Calendar section.`
- `GRAPH_NO_KEYCHAIN` hint copy, verbatim: `Couldn't read the saved calendar connection from this device's secure storage. If this keeps happening, reconnect from the Odoo page's Calendar section.`
- `AUTH_EXPIRED` stays non-retryable. `GRAPH_NO_KEYCHAIN` becomes retryable.
- `useCalendarProposal`'s `readStatus` keeps setting `connected = false` on EVERY status error, `GRAPH_NO_KEYCHAIN` included, and the fetch effect is not changed — a deliberate deviation from spec §3, recorded in Task 4.
- Comments that the change makes false are rewritten in the same task that makes them false (the spec's "Explicit supersessions" list, items 1–12).

**Environment (fresh worktree):** `node_modules` must exist (if not: `cmd //c "mklink /J node_modules C:\Users\kmorg\meetwings-app\node_modules"`). Run Rust tests from the repo root with `--manifest-path` (no `cd`) and the shared target dir to avoid a cold build:
`CARGO_TARGET_DIR=C:/Users/kmorg/meetwings-app/src-tauri/target cargo test --manifest-path src-tauri/Cargo.toml --lib graph::`
Run Vitest scoped to one file, never the full suite: `npx vitest run <file>`. Type-check with `npx tsc --noEmit` (`npm run lint` is eslint only and does not type-check).

## Review Focus

1. **Session-only (Linux, no keychain service) at the threshold** — memory must be cleared and the keychain delete must NOT be called. Pinned in Task 1 (`record_invalid_grant_on_the_session_only_path_clears_memory_without_a_delete`).
2. **Fresh launch (memory empty, token read from the keychain)** — the failure must still count; an empty memory is "still current". Pinned in Task 1 (`record_invalid_grant_counts_when_memory_is_empty`).
3. **Keychain delete fails at the threshold (locked Credential Manager)** — the error must surface and the streak must stay at 3 so the next failure retries the delete. Pinned in Task 1 (`record_invalid_grant_surfaces_a_failed_delete_and_keeps_the_streak`) and Task 2 (seam variant).
4. **`GRAPH_NO_KEYCHAIN` on a fresh mount** (the connected state was never read) — the block must show the retryable error, and "Try again" that succeeds must restore the real connection state. Pinned in Task 4 (`recovers from a keychain read failure on mount via Try again`).
5. **`GRAPH_NO_KEYCHAIN` from the fetch path, not the status path** — it must render as retryable with the hint, not as "reconnect". Pinned in Task 5 (the retryable `it.each` plus the hint test; the render branch is keyed on the code alone, so both paths share it).

---

### Task 1: invalid_grant streak, threshold, and identity check (Rust)

**Files:**
- Modify: `src-tauri/src/graph/mod.rs` (constants ~62-70, imports ~87, `GraphState` doc + fields ~116-173, `adopt_and_persist_with` ~309-326, `forget_refresh_token_with`/`forget_refresh_token` ~338-385, the `AUTH_EXPIRED` arm ~464-470, `graph_disconnect` comment ~609-619, test docs ~925-927 and ~1013-1014, new tests at the end of `mod tests`)
- Modify: `src-tauri/src/graph/auth.rs` (doc ~366-369, test name ~920)

**Interfaces:**
- Consumes: existing `GraphState`, `adopt_and_persist_with(state, tokens, generation, persist)`, `keychain::delete_refresh_token`.
- Produces (used by Task 2):
  - `const INVALID_GRANT_FORGET_THRESHOLD: u32 = 3;`
  - `fn should_forget(streak: u32) -> bool`
  - field `GraphState::invalid_grant_streak: AtomicU32` (private)
  - `fn clear_and_delete(state: &GraphState, delete: impl FnOnce() -> Result<(), String>) -> Result<(), String>` — caller must hold `persist_op`
  - `fn record_invalid_grant_with(state: &GraphState, failed: &str, delete: impl FnOnce() -> Result<(), String>) -> Result<(), String>` — takes `persist_op` itself
  - `forget_refresh_token` is DELETED; `forget_refresh_token_with` keeps its signature.

- [ ] **Step 1: Write the failing tests**

Append inside `mod tests` in `src-tauri/src/graph/mod.rs`, after the last existing test:

```rust
    fn state_holding(refresh_token: Option<&str>, streak: u32) -> GraphState {
        let state = GraphState::default();
        state
            .session
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .refresh_token = refresh_token.map(str::to_string);
        state.invalid_grant_streak.store(streak, Ordering::Relaxed);
        state
    }

    fn streak(state: &GraphState) -> u32 {
        state.invalid_grant_streak.load(Ordering::Relaxed)
    }

    fn memory_token(state: &GraphState) -> Option<String> {
        state
            .session
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .refresh_token
            .clone()
    }

    fn some_tokens() -> auth::Tokens {
        auth::Tokens {
            access_token: "fresh".into(),
            expires_at_ms: i64::MAX,
            refresh_token: Some("rotated".into()),
            id_token: None,
        }
    }

    /// `>=`, not `==`: after a FAILED delete the streak keeps climbing past 3,
    /// and the next failure must retry the delete instead of waiting.
    #[test]
    fn should_forget_is_false_below_the_threshold_and_true_at_and_above_it() {
        assert!(!should_forget(0));
        assert!(!should_forget(1));
        assert!(!should_forget(2));
        assert!(should_forget(3));
        assert!(should_forget(4));
    }

    #[test]
    fn a_new_state_starts_with_no_invalid_grant_streak() {
        assert_eq!(streak(&GraphState::default()), 0);
    }

    #[test]
    fn a_successful_adoption_resets_the_invalid_grant_streak() {
        let state = state_holding(None, 2);
        let generation = state.session.lock().unwrap_or_else(|e| e.into_inner()).generation;
        assert_eq!(
            adopt_and_persist_with(&state, &some_tokens(), generation, |_| Ok(())),
            Ok(())
        );
        assert_eq!(streak(&state), 0);
    }

    /// The reset sits BEFORE the session-only early return - a session-only
    /// adoption is a working credential too.
    #[test]
    fn a_session_only_adoption_also_resets_the_invalid_grant_streak() {
        let state = state_holding(None, 2);
        *state.session_only.lock().unwrap_or_else(|e| e.into_inner()) = true;
        let generation = state.session.lock().unwrap_or_else(|e| e.into_inner()).generation;
        assert_eq!(
            adopt_and_persist_with(&state, &some_tokens(), generation, |_| Ok(())),
            Ok(())
        );
        assert_eq!(streak(&state), 0);
    }

    /// Nothing was adopted, so nothing is evidence that the credential works.
    #[test]
    fn an_adoption_lost_to_a_disconnect_leaves_the_streak_alone() {
        let state = state_holding(None, 2);
        let generation = state.session.lock().unwrap_or_else(|e| e.into_inner()).generation;
        state.clear_session();
        assert_eq!(
            adopt_and_persist_with(&state, &some_tokens(), generation, |_| Ok(())),
            Err(NOT_CONNECTED.to_string())
        );
        assert_eq!(streak(&state), 2);
    }

    #[test]
    fn record_invalid_grant_below_the_threshold_keeps_the_credential() {
        let state = state_holding(Some("rt"), 0);
        let delete_calls = std::cell::Cell::new(0u32);
        for _ in 0..2 {
            let result = record_invalid_grant_with(&state, "rt", || {
                delete_calls.set(delete_calls.get() + 1);
                Ok(())
            });
            assert_eq!(result, Ok(()));
        }
        assert_eq!(delete_calls.get(), 0);
        assert_eq!(streak(&state), 2);
        assert_eq!(memory_token(&state).as_deref(), Some("rt"));
    }

    #[test]
    fn record_invalid_grant_at_the_threshold_forgets_exactly_once() {
        let state = state_holding(Some("rt"), 2);
        let delete_calls = std::cell::Cell::new(0u32);
        let result = record_invalid_grant_with(&state, "rt", || {
            delete_calls.set(delete_calls.get() + 1);
            Ok(())
        });
        assert_eq!(result, Ok(()));
        assert_eq!(delete_calls.get(), 1);
        assert_eq!(memory_token(&state), None);
    }

    /// A reconnect adopted a different credential while the failing
    /// redemption was in flight. The failure is evidence about the OLD token
    /// only: no count, no delete, the new token untouched.
    #[test]
    fn record_invalid_grant_ignores_a_failure_against_a_replaced_credential() {
        let state = state_holding(Some("t-new"), 2);
        let delete_was_called = std::cell::Cell::new(false);
        let result = record_invalid_grant_with(&state, "t-old", || {
            delete_was_called.set(true);
            Ok(())
        });
        assert_eq!(result, Ok(()));
        assert!(!delete_was_called.get());
        assert_eq!(streak(&state), 2);
        assert_eq!(memory_token(&state).as_deref(), Some("t-new"));
    }

    /// Fresh launch: memory is empty and the failing token came from the
    /// keychain. Nothing was adopted since that read, so it is still current.
    #[test]
    fn record_invalid_grant_counts_when_memory_is_empty() {
        let state = state_holding(None, 0);
        let result = record_invalid_grant_with(&state, "from-keychain", || {
            panic!("one failure must not delete")
        });
        assert_eq!(result, Ok(()));
        assert_eq!(streak(&state), 1);
    }

    /// "Dead AND stuck on disk" is surfaced, and the streak is NOT reset, so
    /// the very next failure (4 >= 3) retries the delete.
    #[test]
    fn record_invalid_grant_surfaces_a_failed_delete_and_keeps_the_streak() {
        let state = state_holding(Some("rt"), 2);
        let result = record_invalid_grant_with(&state, "rt", || Err(NO_KEYCHAIN.to_string()));
        assert_eq!(result, Err(NO_KEYCHAIN.to_string()));
        assert_eq!(streak(&state), 3);
    }

    #[test]
    fn record_invalid_grant_on_the_session_only_path_clears_memory_without_a_delete() {
        let state = state_holding(Some("in-memory-only"), 2);
        *state.session_only.lock().unwrap_or_else(|e| e.into_inner()) = true;
        let delete_was_called = std::cell::Cell::new(false);
        let result = record_invalid_grant_with(&state, "in-memory-only", || {
            delete_was_called.set(true);
            Ok(())
        });
        assert_eq!(result, Ok(()));
        assert!(!delete_was_called.get());
        assert_eq!(memory_token(&state), None);
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `CARGO_TARGET_DIR=C:/Users/kmorg/meetwings-app/src-tauri/target cargo test --manifest-path src-tauri/Cargo.toml --lib graph::`
Expected: compile errors — `cannot find function should_forget`, `no field invalid_grant_streak`, `cannot find function record_invalid_grant_with`, `cannot find type Ordering`.

- [ ] **Step 3: Add the import, the constant, and the field**

In `mod.rs`, change `use std::sync::Mutex;` (line ~87) to:

```rust
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
```

After `pub const NO_KEYCHAIN: &str = "GRAPH_NO_KEYCHAIN";` (line ~70) add:

```rust

/// Consecutive confirmed `invalid_grant` responses, against the SAME current
/// credential, before that credential is deleted.
///
/// Why not 1 (the old behavior): one response must never destroy a ~90-day
/// credential, and while the credential is retained `graph_status` keeps
/// reporting connected, so the calendar block stays visible with a
/// "sign-in expired, reconnect" remedy instead of silently vanishing.
///
/// Why not "never": deletion is the backstop that stops re-redeeming a dead
/// string. Every attempt re-reads the same stored token, so a retry cannot
/// revive it; if the cause was Entra replay detection the family is already
/// revoked, and the at-most-2 extra redemptions change nothing about that.
///
/// The streak is counted per picker open (one token-endpoint call each) and
/// lives in memory only, so it restarts every launch: a user who opens the
/// picker fewer than 3 times per launch keeps a dead credential until they
/// reconnect. Accepted - the Odoo page's "Connect calendar" button is always
/// rendered, and a reconnect overwrites the entry.
const INVALID_GRANT_FORGET_THRESHOLD: u32 = 3;
```

In `GraphState`, after the `refresh_op` field (line ~172), add:

```rust
    /// Consecutive confirmed `invalid_grant` responses against the CURRENT
    /// credential. Bumped by `record_invalid_grant_with`, reset to 0 by
    /// `adopt_and_persist_with` on any successful adoption; both run under
    /// `persist_op`. Never persisted: each launch re-earns deletion from zero.
    /// An atomic rather than another `Mutex`, so it adds nothing to the lock
    /// invariant above.
    invalid_grant_streak: AtomicU32,
```

(`AtomicU32` implements `Default`, so `#[derive(Default)]` still works.)

- [ ] **Step 4: Reset the streak on a successful adoption**

In `adopt_and_persist_with`, replace:

```rust
    if !adopt(state, tokens, generation) {
        return Err(NOT_CONNECTED.to_string());
    }
    if *state.session_only.lock().unwrap_or_else(|e| e.into_inner()) {
```

with:

```rust
    if !adopt(state, tokens, generation) {
        return Err(NOT_CONNECTED.to_string());
    }
    // A working credential was just adopted, so evidence against the old one
    // is void. BEFORE the session-only early return: a session-only adoption
    // is a working credential too.
    state.invalid_grant_streak.store(0, Ordering::Relaxed);
    if *state.session_only.lock().unwrap_or_else(|e| e.into_inner()) {
```

- [ ] **Step 5: Split `forget_refresh_token_with`, delete `forget_refresh_token`, add `should_forget` and `record_invalid_grant_with`**

Replace the whole block from `/// The shared clear-and-decide sequence behind both \`forget_refresh_token\`` (line ~338) through the end of `fn forget_refresh_token` (line ~385) with:

```rust
/// The clear-then-delete sequence behind `graph_disconnect` (a user-initiated
/// disconnect). `record_invalid_grant_with` runs the same `clear_and_delete`
/// under the same lock once confirmed `invalid_grant` failures reach
/// `INVALID_GRANT_FORGET_THRESHOLD`.
///
/// Held under `state.persist_op` for its entire body - the SAME lock
/// `adopt_and_persist_with` holds for its own adopt-then-persist sequence
/// (Task 11 review round 2, Finding B). That is what stops a refresh's
/// persist and a disconnect's clear-then-delete from interleaving: whichever
/// of the two acquires `persist_op` first runs to completion, keychain I/O
/// included, before the other's body even starts. See `adopt_and_persist_
/// with`'s doc comment (rule 2) for the failure this closes.
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
    let _persist_guard = state.persist_op.lock().unwrap_or_else(|e| e.into_inner());
    clear_and_delete(state, delete)
}

/// The body `forget_refresh_token_with` and `record_invalid_grant_with`
/// share. The CALLER must hold `state.persist_op`: this does not take it,
/// because `record_invalid_grant_with` already holds it for its identity
/// check and a `std::sync::Mutex` is not reentrant.
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
fn clear_and_delete(
    state: &GraphState,
    delete: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    let was_session_only = *state.session_only.lock().unwrap_or_else(|e| e.into_inner());
    state.clear_session();
    if was_session_only {
        return Ok(());
    }
    delete()
}

/// Pure: whether a streak this long deletes the credential. `>=`, not `==`:
/// after a FAILED delete the streak keeps climbing, and the next failure must
/// retry the delete rather than wait three more.
fn should_forget(streak: u32) -> bool {
    streak >= INVALID_GRANT_FORGET_THRESHOLD
}

/// Record one confirmed `invalid_grant` for `failed` - the refresh token the
/// token endpoint just rejected - and delete the credential once
/// `INVALID_GRANT_FORGET_THRESHOLD` consecutive failures have been seen.
///
/// Takes `persist_op` for the whole body, so the identity check, the bump and
/// any forget are one step with respect to `adopt_and_persist_with` (which
/// resets the streak under the same lock). The caller must NOT hold it.
///
/// The identity check: `graph_connect` adopts under `persist_op` but NOT
/// under `refresh_op`, so a reconnect can land while a refresh of the OLD
/// token is awaiting Entra. When memory now holds a DIFFERENT refresh token,
/// the failure is evidence about the old one only - it must neither count
/// against nor delete the new one. An EMPTY memory (fresh launch, token read
/// from the keychain) is still current: nothing has been adopted since.
///
/// The streak is deliberately NOT reset at the threshold. After a successful
/// delete this is unreachable until a reconnect resets it; after a failed
/// delete the dead token is still on disk, so the next refresh re-reads it,
/// fails, and `4 >= 3` retries the delete straight away.
fn record_invalid_grant_with(
    state: &GraphState,
    failed: &str,
    delete: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    let _persist_guard = state.persist_op.lock().unwrap_or_else(|e| e.into_inner());
    let current = state
        .session
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .refresh_token
        .clone();
    if current.is_some_and(|token| token != failed) {
        return Ok(());
    }
    let streak = state.invalid_grant_streak.fetch_add(1, Ordering::Relaxed) + 1;
    if !should_forget(streak) {
        return Ok(());
    }
    clear_and_delete(state, delete)
}
```

- [ ] **Step 6: Route the `AUTH_EXPIRED` arm through the counter**

In `refresh_and_adopt`, replace:

```rust
            forget_refresh_token(state)?;
            return Err(AUTH_EXPIRED.to_string());
```

with:

```rust
            record_invalid_grant_with(state, &stored, keychain::delete_refresh_token)?;
            return Err(AUTH_EXPIRED.to_string());
```

(The three-line comment above it — "A keychain failure while forgetting is surfaced, not swallowed..." — stays verbatim.)

- [ ] **Step 7: Rewrite the comments this task made false**

1. `GraphState` lock-invariant doc, part 1 (line ~118-125). Replace:

```rust
///    Where the two meet EACH OTHER the order is `refresh_op` ->
///    `persist_op`: `refresh_and_adopt` holds `refresh_op` while calling
///    `adopt_and_persist`, which takes `persist_op`. That is the only
///    nesting of the two, and `refresh_op` is acquired at exactly one site,
///    so no competing order exists for it to deadlock against.
```

with:

```rust
///    Where the two meet EACH OTHER the order is `refresh_op` ->
///    `persist_op`: `refresh_and_adopt` holds `refresh_op` while calling
///    `adopt_and_persist` or `record_invalid_grant_with`, each of which takes
///    `persist_op`. Those are the only nestings of the two, both in the same
///    order, and `refresh_op` is acquired at exactly one site, so no
///    competing order exists for them to deadlock against.
```

2. Same doc, part 2 (line ~134-138). Replace `` ///    `forget_refresh_token_with` reads `session_only` and only then takes `` with `` ///    `clear_and_delete` reads `session_only` and only then takes `` (the rest of the sentence is unchanged).

3. `persist_op` field doc (line ~145-158). Replace:

```rust
    /// Guards the adopt-then-persist sequence in `adopt_and_persist_with` and
    /// the clear-then-delete sequence in `forget_refresh_token_with` against
    /// EACH OTHER, so the two can never interleave - see both functions' doc
    /// comments for the race this closes (Task 11 review round 2, Finding B).
    ///
    /// A `std::sync::Mutex`, not a `tokio` one, and deliberately so: neither
    /// critical section contains an `.await` (adopting is in-memory; the
```

with:

```rust
    /// Guards three sequences against EACH OTHER, so none can interleave:
    /// adopt-then-persist in `adopt_and_persist_with`, clear-then-delete in
    /// `forget_refresh_token_with`, and check-count-and-maybe-forget in
    /// `record_invalid_grant_with` - see their doc comments for the races this
    /// closes (Task 11 review round 2, Finding B; issue #73). It also
    /// serializes every write to `invalid_grant_streak`.
    ///
    /// A `std::sync::Mutex`, not a `tokio` one, and deliberately so: no
    /// critical section contains an `.await` (adopting is in-memory; the
```

4. `graph_disconnect` comment (line ~609-619). Replace:

```rust
    // Routed through the same clear-then-delete sequence `forget_refresh_token`
    // uses, rather than hand-copied: the two functions differ only in that
    // this one also resets `session_only` to `false` afterwards, and that
```

with:

```rust
    // Routed through the same `clear_and_delete` sequence
    // `record_invalid_grant_with` uses at the threshold, rather than
    // hand-copied: the two differ only in that
    // this one also resets `session_only` to `false` afterwards, and that
```

and in the same comment replace `` // free of a disconnect-specific detail the forget-on-invalid_grant path `` with `` // free of a disconnect-specific detail the invalid_grant threshold path ``.

5. Test doc at line ~925-927. Replace:

```rust
    /// **Ruling 20:** this is routed through `forget_refresh_token_with` with a
    /// spy `delete`, not through the `forget_refresh_token` wrapper. A version
    /// that called `forget_refresh_token(&state)` directly and asserted only
```

with:

```rust
    /// **Ruling 20:** this is routed through `forget_refresh_token_with` with a
    /// spy `delete`, never with the real `keychain::delete_refresh_token`. A
    /// version that called it with the real delete and asserted only
```

6. Test doc at line ~1013-1014. Replace `` /// **Finding A (Task 11 review round 2):** the same seam Ruling 20 `` / `` /// required for `forget_refresh_token`, one level up. The pre-fix version `` with `` /// **Finding A (Task 11 review round 2):** the same seam Ruling 20 `` / `` /// required for `forget_refresh_token_with`, one level up. The pre-fix version ``.

7. `src-tauri/src/graph/auth.rs`, `classify_token_error`'s doc (line ~366-369). Replace:

```rust
/// ONLY `invalid_grant` proves the refresh token is dead (revoked, expired,
/// password changed). Everything else RETAINS it: destroying a working ~90-day
/// credential over a transport blip can need an administrator to undo, in a
/// consent-blocked tenant.
```

with:

```rust
/// `invalid_grant` (revoked, expired, password changed) is the ONLY code
/// mapped to `AUTH_EXPIRED`, and even that is strong-but-not-immediate
/// evidence: `mod.rs`'s `record_invalid_grant_with` deletes the credential
/// only after `INVALID_GRANT_FORGET_THRESHOLD` consecutive confirmed failures.
/// Everything else is not evidence about the refresh token at all and never
/// counts: destroying a working ~90-day credential over a transport blip can
/// need an administrator to undo, in a consent-blocked tenant.
```

8. `auth.rs` test at line ~920: rename `fn only_invalid_grant_means_the_refresh_token_is_dead()` to `fn only_invalid_grant_maps_to_auth_expired()`. Assertions unchanged.

- [ ] **Step 8: Run the tests to verify they pass**

Run: `CARGO_TARGET_DIR=C:/Users/kmorg/meetwings-app/src-tauri/target cargo test --manifest-path src-tauri/Cargo.toml --lib graph::`
Expected: all `graph::` tests PASS, including the 11 new ones and every pre-existing one. No `dead_code` warning for `forget_refresh_token` (it is gone) and no warning for any new item.

Then confirm no stray references: `grep -rn "forget_refresh_token\b" src-tauri/src` — expected: no output (grep exits 1). `\b` does not match inside `forget_refresh_token_with` (`_` is a word character), so any hit is a leftover mention of the deleted wrapper.

- [ ] **Step 9: Commit**

```bash
git add src-tauri/src/graph/mod.rs src-tauri/src/graph/auth.rs
git commit -m "fix(graph): keep the credential until 3 confirmed invalid_grants (#73)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: `refresh_and_adopt_with` seam and arm tests (Rust)

**Files:**
- Modify: `src-tauri/src/graph/mod.rs` (`refresh_and_adopt` doc + body ~403-476; new tests at the end of `mod tests`)

**Interfaces:**
- Consumes (from Task 1): `record_invalid_grant_with(state, failed, delete)`, `invalid_grant_streak`, test helpers `state_holding`, `streak`, `memory_token` (defined in Task 1's test block).
- Produces:
  ```rust
  async fn refresh_and_adopt_with<Fut>(
      state: &GraphState,
      generation: u64,
      stale: Option<&str>,
      refresh: impl FnOnce(String) -> Fut,
      persist: impl FnOnce(&auth::Tokens) -> Result<(), String>,
      delete: impl FnOnce() -> Result<(), String>,
  ) -> Result<String, String>
  where
      Fut: std::future::Future<Output = Result<auth::Tokens, String>>;
  ```
  `refresh_and_adopt(state, authority, client_id, generation, stale)` keeps its exact signature and both call sites in `graph_current_meetings` are untouched.

- [ ] **Step 1: Write the failing tests**

Append inside `mod tests`, after Task 1's tests:

```rust
    fn invalid_grant() -> std::future::Ready<Result<auth::Tokens, String>> {
        std::future::ready(Err(AUTH_EXPIRED.to_string()))
    }

    fn generation_of(state: &GraphState) -> u64 {
        state.session.lock().unwrap_or_else(|e| e.into_inner()).generation
    }

    #[tokio::test]
    async fn two_invalid_grants_keep_the_credential() {
        let state = state_holding(Some("rt"), 0);
        let generation = generation_of(&state);
        let delete_calls = std::cell::Cell::new(0u32);
        for _ in 0..2 {
            let result = refresh_and_adopt_with(
                &state,
                generation,
                None,
                |_| invalid_grant(),
                |_| unreachable!("a failed redemption persists nothing"),
                || {
                    delete_calls.set(delete_calls.get() + 1);
                    Ok(())
                },
            )
            .await;
            assert_eq!(result, Err(AUTH_EXPIRED.to_string()));
        }
        assert_eq!(delete_calls.get(), 0);
        assert_eq!(streak(&state), 2);
        assert_eq!(memory_token(&state).as_deref(), Some("rt"));
    }

    /// The third call is the LAST call: memory is cleared afterwards, and a
    /// further call would make `stored_refresh_token` read the real keychain.
    #[tokio::test]
    async fn the_third_consecutive_invalid_grant_forgets_exactly_once() {
        let state = state_holding(Some("rt"), 0);
        let generation = generation_of(&state);
        let delete_calls = std::cell::Cell::new(0u32);
        for _ in 0..3 {
            let result = refresh_and_adopt_with(
                &state,
                generation,
                None,
                |_| invalid_grant(),
                |_| unreachable!("a failed redemption persists nothing"),
                || {
                    delete_calls.set(delete_calls.get() + 1);
                    Ok(())
                },
            )
            .await;
            assert_eq!(result, Err(AUTH_EXPIRED.to_string()));
        }
        assert_eq!(delete_calls.get(), 1);
        assert_eq!(memory_token(&state), None);
    }

    /// The success tokens carry `expires_at_ms: 0`. With this file's usual
    /// `i64::MAX` the later calls would take the post-lock
    /// `fresh_access_token` shortcut, never redeem, and pass vacuously.
    #[tokio::test]
    async fn a_success_between_invalid_grants_resets_the_streak() {
        let state = state_holding(Some("rt"), 0);
        let generation = generation_of(&state);
        let refresh_calls = std::cell::Cell::new(0u32);
        let delete_was_called = std::cell::Cell::new(false);

        let first = refresh_and_adopt_with(
            &state,
            generation,
            None,
            |_| invalid_grant(),
            |_| unreachable!(),
            || {
                delete_was_called.set(true);
                Ok(())
            },
        )
        .await;
        assert_eq!(first, Err(AUTH_EXPIRED.to_string()));
        assert_eq!(streak(&state), 1);

        let persist_calls = std::cell::Cell::new(0u32);
        let success = refresh_and_adopt_with(
            &state,
            generation,
            None,
            |_| {
                std::future::ready(Ok(auth::Tokens {
                    access_token: "a1".into(),
                    expires_at_ms: 0,
                    refresh_token: Some("rt2".into()),
                    id_token: None,
                }))
            },
            |_| {
                persist_calls.set(persist_calls.get() + 1);
                Ok(())
            },
            || unreachable!(),
        )
        .await;
        assert_eq!(success, Ok("a1".to_string()));
        assert_eq!(persist_calls.get(), 1);
        assert_eq!(streak(&state), 0);

        for _ in 0..2 {
            let result = refresh_and_adopt_with(
                &state,
                generation,
                None,
                |stored| {
                    assert_eq!(stored, "rt2");
                    refresh_calls.set(refresh_calls.get() + 1);
                    invalid_grant()
                },
                |_| unreachable!(),
                || {
                    delete_was_called.set(true);
                    Ok(())
                },
            )
            .await;
            assert_eq!(result, Err(AUTH_EXPIRED.to_string()));
        }
        assert_eq!(refresh_calls.get(), 2);
        assert!(!delete_was_called.get());
        assert_eq!(streak(&state), 2);
    }

    #[tokio::test]
    async fn a_network_failure_between_invalid_grants_leaves_the_streak_alone() {
        let state = state_holding(Some("rt"), 0);
        let generation = generation_of(&state);
        let delete_was_called = std::cell::Cell::new(false);
        let outcomes = [AUTH_EXPIRED, NETWORK, AUTH_EXPIRED];
        let expected_streaks = [1u32, 1, 2];
        for (code, expected) in outcomes.iter().zip(expected_streaks) {
            let result = refresh_and_adopt_with(
                &state,
                generation,
                None,
                |_| std::future::ready(Err(code.to_string())),
                |_| unreachable!(),
                || {
                    delete_was_called.set(true);
                    Ok(())
                },
            )
            .await;
            assert_eq!(result, Err(code.to_string()));
            assert_eq!(streak(&state), expected);
        }
        assert!(!delete_was_called.get());
    }

    #[tokio::test]
    async fn a_failed_delete_at_the_threshold_is_surfaced_and_the_streak_kept() {
        let state = state_holding(Some("rt"), 2);
        let generation = generation_of(&state);
        let result = refresh_and_adopt_with(
            &state,
            generation,
            None,
            |_| invalid_grant(),
            |_| unreachable!(),
            || Err(NO_KEYCHAIN.to_string()),
        )
        .await;
        assert_eq!(result, Err(NO_KEYCHAIN.to_string()));
        assert_eq!(streak(&state), 3);
    }

    /// The fake refresh writes the new token straight into memory - NOT via
    /// `adopt_and_persist_with`, whose reset would zero the streak and make
    /// this pass without any identity check. Without the check the streak
    /// would reach 3 and call delete.
    #[tokio::test]
    async fn a_reconnect_during_the_redemption_is_not_counted_against_the_new_credential() {
        let state = state_holding(Some("t-old"), 2);
        let generation = generation_of(&state);
        let delete_was_called = std::cell::Cell::new(false);
        let result = refresh_and_adopt_with(
            &state,
            generation,
            None,
            |_| {
                state
                    .session
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .refresh_token = Some("t-new".into());
                invalid_grant()
            },
            |_| unreachable!(),
            || {
                delete_was_called.set(true);
                Ok(())
            },
        )
        .await;
        assert_eq!(result, Err(AUTH_EXPIRED.to_string()));
        assert!(!delete_was_called.get());
        assert_eq!(streak(&state), 2);
        assert_eq!(memory_token(&state).as_deref(), Some("t-new"));
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `CARGO_TARGET_DIR=C:/Users/kmorg/meetwings-app/src-tauri/target cargo test --manifest-path src-tauri/Cargo.toml --lib graph::`
Expected: compile error `cannot find function refresh_and_adopt_with`.

- [ ] **Step 3: Split `refresh_and_adopt` into the seam and the wrapper**

Replace the whole of `refresh_and_adopt` — from `/// The ONE refresh path.` (line ~403) through its closing `}` (line ~476) — with:

```rust
/// The ONE refresh path. Both call sites in `graph_current_meetings` go through
/// it (via the `refresh_and_adopt` wrapper), which is what keeps the
/// `invalid_grant` handling identical between them.
///
/// The earlier draft special-cased AUTH_EXPIRED at the first call site and used
/// a bare `?` at the second, so a refresh token revoked at the same moment as
/// the access token - a password change, the single commonest cause - skipped
/// the `invalid_grant` handling at one of them. Both now reach the same arm,
/// which counts the failure (`record_invalid_grant_with`) and keeps the
/// credential until `INVALID_GRANT_FORGET_THRESHOLD` consecutive confirmed
/// failures: a dead credential is retained deliberately until then, or until
/// a reconnect replaces it.
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
/// waiting here waits on the NETWORK, and even with `GRAPH_HTTP_TIMEOUT`
/// bounding every `reqwest` call this module makes, that bound is 30
/// seconds - so `graph_disconnect` sharing this lock could still be made to
/// wait that long instead of returning in milliseconds. See `GraphState`'s
/// own doc comment for the full lock order, which is why this function is
/// free to call `adopt_and_persist_with` and `record_invalid_grant_with`
/// (each taking `persist_op`) while still holding `refresh_op`.
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
///
/// `refresh` (the token endpoint), `persist` (the keychain write) and `delete`
/// (the keychain delete) are injected for the same reason
/// `adopt_and_persist_with` and `forget_refresh_token_with` inject theirs
/// (Ruling 20, Finding A): tests drive both arms without a network and
/// without any path to a real keychain. `stored_refresh_token` is NOT
/// injected - it still reads the real keychain when memory is empty - so a
/// test must seed a refresh token in memory and make no call after one that
/// cleared memory on the normal path.
async fn refresh_and_adopt_with<Fut>(
    state: &GraphState,
    generation: u64,
    stale: Option<&str>,
    refresh: impl FnOnce(String) -> Fut,
    persist: impl FnOnce(&auth::Tokens) -> Result<(), String>,
    delete: impl FnOnce() -> Result<(), String>,
) -> Result<String, String>
where
    Fut: std::future::Future<Output = Result<auth::Tokens, String>>,
{
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
    // `refresh` takes the String by value; the arm below still needs `stored`.
    let tokens = match refresh(stored.clone()).await {
        Ok(tokens) => tokens,
        Err(code) if code == AUTH_EXPIRED => {
            // A keychain failure while forgetting is surfaced, not swallowed:
            // "your credential is dead AND it is stuck on disk" is a different
            // problem from "reconnect", and the user can act on it.
            record_invalid_grant_with(state, &stored, delete)?;
            return Err(AUTH_EXPIRED.to_string());
        }
        Err(code) => return Err(code),
    };
    let access = tokens.access_token.clone();
    adopt_and_persist_with(state, &tokens, generation, persist)?;
    Ok(access)
}

/// Called with the real token endpoint, keychain write and keychain delete.
/// See `refresh_and_adopt_with` for the full contract this wraps.
async fn refresh_and_adopt(
    state: &GraphState,
    authority: &str,
    client_id: &str,
    generation: u64,
    stale: Option<&str>,
) -> Result<String, String> {
    refresh_and_adopt_with(
        state,
        generation,
        stale,
        |stored| async move { auth::refresh(authority, client_id, &stored, now_ms()).await },
        auth::persist_rotated,
        keychain::delete_refresh_token,
    )
    .await
}
```

`adopt_and_persist` (the wrapper at ~330-336) may now have no caller other than `graph_connect` — it still has that one; leave it.

- [ ] **Step 3b: Rewrite the comments the split made false**

`refresh_op` is now held by `refresh_and_adopt_with`, which calls `adopt_and_persist_with`, not the wrappers. Three docs still name the wrappers:

1. `GraphState` lock-invariant doc, part 1 (as rewritten by Task 1 Step 7.1). Replace:

```rust
///    `persist_op`: `refresh_and_adopt` holds `refresh_op` while calling
///    `adopt_and_persist` or `record_invalid_grant_with`, each of which takes
```

with:

```rust
///    `persist_op`: `refresh_and_adopt_with` holds `refresh_op` while calling
///    `adopt_and_persist_with` or `record_invalid_grant_with`, each of which takes
```

2. `refresh_op` field doc (line ~160). Replace `` /// Serializes `refresh_and_adopt` calls against EACH OTHER - not against `` with `` /// Serializes `refresh_and_adopt_with` calls against EACH OTHER - not against ``.

3. `fresh_access_token` doc (line ~391). Replace `` /// already there) and the re-read inside `refresh_and_adopt`, immediately `` with `` /// already there) and the re-read inside `refresh_and_adopt_with`, immediately ``.

The mentions in `graph_current_meetings` (~647-675) and the loopback test docs (~1161-1162) name the `refresh_and_adopt` wrapper those sites really call; leave them.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `CARGO_TARGET_DIR=C:/Users/kmorg/meetwings-app/src-tauri/target cargo test --manifest-path src-tauri/Cargo.toml --lib graph::`
Expected: all `graph::` tests PASS, including the 6 new seam tests and the three existing loopback tests (`refresh_and_adopt_finds_a_token_another_call_already_adopted_and_does_not_redeem_again`, `refresh_and_adopt_does_not_shortcut_on_the_token_the_caller_just_had_rejected`, `refresh_and_adopt_still_takes_the_shortcut_when_memory_holds_a_different_token`) unchanged.

Also build the whole crate so the tauri command futures are checked for `Send`: `CARGO_TARGET_DIR=C:/Users/kmorg/meetwings-app/src-tauri/target cargo check --manifest-path src-tauri/Cargo.toml` — expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/graph/mod.rs
git commit -m "refactor(graph): inject refresh/persist/delete into refresh_and_adopt (#73)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Single-instance guard (Rust)

**Files:**
- Modify: `src-tauri/Cargo.toml` (dependencies, next to `tauri-plugin-opener = "2"` at line ~30)
- Modify: `src-tauri/src/lib.rs` (builder chain ~105-110)
- Modify: `CLAUDE.md` (Troubleshooting → Common Issues)

**Interfaces:**
- Consumes: `window::open_dashboard(app: tauri::AppHandle) -> Result<(), String>` (async, `src-tauri/src/window.rs:432`), `tauri::Manager` (already imported at `lib.rs:11`).
- Produces: nothing other tasks use.

No automated test: the plugin's behavior is process-level. Verification is compile + the manual gate in Step 4.

- [ ] **Step 1: Add the dependency**

In `src-tauri/Cargo.toml`, directly under `tauri-plugin-opener = "2"`, add:

```toml
tauri-plugin-single-instance = "2"
```

- [ ] **Step 2: Register the plugin first in the builder**

In `src-tauri/src/lib.rs`, replace:

```rust
    let mut builder = tauri::Builder::default()
        .plugin(
            tauri_plugin_sql::Builder::default()
```

with:

```rust
    let mut builder = tauri::Builder::default()
        // FIRST, per the plugin's own requirement: a second launch must exit
        // before any state or window setup runs. Two processes would share one
        // keychain refresh token and double-redeem it, tripping Entra's replay
        // detection (graph/mod.rs, `GraphState::refresh_op`'s doc comment).
        //
        // `tauri dev` shares the `com.meetwings.app` identifier with the
        // installed app, so it exits at once while the installed app runs.
        // Deliberate: both also share the `com.meetwings.graph` keychain
        // service, and gating this on `debug_assertions` would bring the
        // double redemption back. Quit the installed app before `tauri dev`.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // The dashboard, not the overlay: `main` is the 54px skipTaskbar
            // overlay whose visibility the toggle shortcut tracks in its own
            // state (shortcuts.rs `is_hidden`), which a direct show() here
            // would desync. An existing dashboard is restored directly -
            // `open_dashboard` only calls set_focus then show, and on Windows
            // neither restores a MINIMIZED window.
            if let Some(dashboard) = app.get_webview_window("dashboard") {
                let _ = dashboard.unminimize();
                let _ = dashboard.show();
                let _ = dashboard.set_focus();
            } else {
                // `open_dashboard` is async for the reason on its own doc
                // comment, so it runs on the async runtime, not here.
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = window::open_dashboard(app).await;
                });
            }
        }))
        .plugin(
            tauri_plugin_sql::Builder::default()
```

- [ ] **Step 3: Compile**

Run: `CARGO_TARGET_DIR=C:/Users/kmorg/meetwings-app/src-tauri/target cargo check --manifest-path src-tauri/Cargo.toml`
Expected: no errors (Cargo.lock gains `tauri-plugin-single-instance` and its deps). Then check the lock did not move `tauri` itself: `git diff src-tauri/Cargo.lock | grep -A2 '^ name = "tauri"$'` must show `version = "2.8.2"` as an unchanged context line, never a `-`/`+` pair. If `tauri` was bumped, revert `Cargo.lock` and pin the plugin to the newest release whose `tauri` requirement 2.8.2 satisfies (`tauri-plugin-single-instance = "=2.x.y"`), then rerun. Then `CARGO_TARGET_DIR=C:/Users/kmorg/meetwings-app/src-tauri/target cargo test --manifest-path src-tauri/Cargo.toml --lib graph::` — expected: still all PASS.

- [ ] **Step 4: Document the dev-workflow consequence**

In `CLAUDE.md`, under `### Common Issues`, after the `**Build failures**` paragraph, add:

```markdown
**`npm run tauri dev` exits immediately / focuses another window**: the single-instance guard (`tauri-plugin-single-instance`) keys on the app identifier, which dev and installed builds share. Quit the installed Meetwings (it autostarts) before running `tauri dev`; two dev builds from different worktrees cannot run at once either.
```

- [ ] **Step 5: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/lib.rs CLAUDE.md
git commit -m "feat: single-instance guard surfaces the dashboard on a second launch (#73)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Manual gate (record the result in the PR description; not blocking this task): quit any installed Meetwings, `npm run tauri build`, launch the built app twice — the second process exits and the dashboard opens or comes forward. Repeat with the dashboard minimized (restored) and closed (created).

---

### Task 4: Pin the hook's status-error recovery (tests only)

**Deviation from spec §3 (plan review, pass 1).** Spec §3 had `readStatus` skip `setConnected(false)` for `GRAPH_NO_KEYCHAIN` and gate the fetch effect on `statusError`. Both are dropped: `src/hooks/useCalendarProposal.ts` is NOT modified. Three facts decide it:

1. While `statusError !== null` the hook returns `{ present: blockPresent, state: errorState, onRetry: retryStatus }` (`useCalendarProposal.ts` ~544-551), and `blockPresent` is forced `true` (~123). So `connected` is unobservable to every consumer during a status error. Its only behavioral effect is on recovery: a false → true flip fires `connectedChanged`, which resets and refetches.
2. That reset is a safety mechanism. With the carve-out, a `graph-connection-changed` broadcast from a real Disconnect whose `graph_status` read hits `GRAPH_NO_KEYCHAIN` leaves `connected` true and `hasFetched` latched. A reconnect to a DIFFERENT account then reads `connected: true` again, `connectedChanged` stays false, and the previous account's proposal resurfaces. That is the stale-proposal bug the existing `discards a stale proposal and refetches on a disconnect-then-reconnect while the picker stays open` test pins, reopened through a new door.
3. The issue's requirement (report `GRAPH_NO_KEYCHAIN` as transient, not as "disconnected") is user-visible only through the error block's copy and controls, and Task 5 delivers those: retryable, with a reconnect hint. The internal flag was never on screen.

So this task adds two tests that pin today's behavior: one for Review Focus 4, and one that fails if anyone reintroduces the carve-out.

**Files:**
- Test: `src/tests/useCalendarProposal.test.tsx` (three helpers after `setup`; one test at the end of `presence`, one at the end of `lifecycle`)

**Interfaces:**
- Consumes: the existing hook and test helpers (`mockGraph`, `meeting`, `setup`, `listeners`, `CONTACTS`, `invoke`).
- Produces: nothing other tasks use.

- [ ] **Step 1: Add the tests**

In `src/tests/useCalendarProposal.test.tsx`, add these helpers right after `function setup(...) {...}`:

```ts
async function broadcastConnectionChanged() {
  await act(async () => {
    for (const handler of listeners.get("graph-connection-changed") ?? []) {
      handler({ payload: null });
    }
  });
}

function keychainReadFails() {
  invoke.mockImplementation(async (cmd: string) => {
    if (cmd === "graph_status") throw new Error("GRAPH_NO_KEYCHAIN");
    throw new Error(`unexpected command ${cmd}`);
  });
}

function meetingsCalls() {
  return invoke.mock.calls.filter(([cmd]) => cmd === "graph_current_meetings").length;
}
```

At the end of the `describe("presence", ...)` block add:

```ts
  /**
   * Review Focus 4: a keychain read failure on the very first status read
   * (`connected` was never true) shows the retryable error, and a "Try again"
   * that succeeds restores the real state rather than leaving the error up.
   */
  it("recovers from a keychain read failure on mount via Try again", async () => {
    keychainReadFails();
    const { result } = setup();
    await waitFor(() =>
      expect(result.current.state).toEqual({ kind: "error", code: "GRAPH_NO_KEYCHAIN" })
    );

    mockGraph([]);
    await act(async () => {
      result.current.onRetry();
    });
    await waitFor(() => expect(result.current.state).not.toMatchObject({ kind: "error" }));
    expect(result.current.present).toBe(true);
  });
```

At the end of the `describe("lifecycle", ...)` block add:

```ts
  /**
   * Issue #73: a real Disconnect whose status read hits GRAPH_NO_KEYCHAIN
   * must still count as a transition. `readStatus` sets `connected` false on
   * EVERY status error, so the reconnect that follows flips it back true,
   * `connectedChanged` resets, and the new account's meeting is fetched. A
   * carve-out that kept `connected` true on GRAPH_NO_KEYCHAIN would leave
   * `hasFetched` latched through both broadcasts and resurface the previous
   * account's proposal after only one fetch.
   */
  it("refetches for the reconnected account when the disconnect's status read failed", async () => {
    mockGraph([meeting("e1", "Sync")]);
    const props = { isPickerOpen: true, contacts: CONTACTS, setCalendarBlockPresent: vi.fn() };
    const { result } = renderHook((p: typeof props) => useCalendarProposal(p), {
      initialProps: props,
    });
    await waitFor(() =>
      expect(result.current.state).toMatchObject({ kind: "proposal", subject: "Sync" })
    );

    // Disconnected on /odoo, but this window's status read fails.
    keychainReadFails();
    await broadcastConnectionChanged();
    await waitFor(() =>
      expect(result.current.state).toEqual({ kind: "error", code: "GRAPH_NO_KEYCHAIN" })
    );

    // Reconnected - a DIFFERENT account, with a different meeting live now.
    mockGraph([meeting("e2", "Someone else's meeting")]);
    await broadcastConnectionChanged();
    await waitFor(() =>
      expect(result.current.state).toMatchObject({
        kind: "proposal",
        subject: "Someone else's meeting",
      })
    );
    expect(meetingsCalls()).toBe(2);
  });
```

- [ ] **Step 2: Run the tests**

Run: `npx vitest run src/tests/useCalendarProposal.test.tsx`
Expected: all tests PASS, the two new ones included. They pin behavior the hook already has, so they pass on first run; Step 3 proves the lifecycle one can fail.

- [ ] **Step 3: Mutation check (do it, then revert)**

In `readStatus`'s `catch` in `src/hooks/useCalendarProposal.ts`, wrap `setConnected(false);` in `if (toGraphError(err).code !== "GRAPH_NO_KEYCHAIN") { ... }`. Rerun the file: `refetches for the reconnected account when the disconnect's status read failed` FAILS (the `waitFor` times out with the state still the `Sync` proposal). Revert the hook, then confirm `git diff --stat src/hooks/useCalendarProposal.ts` prints nothing.

Then `npx tsc --noEmit` and `npm run lint`. Expected: no new errors.

- [ ] **Step 4: Commit**

```bash
git add src/tests/useCalendarProposal.test.tsx
git commit -m "test(calendar): pin status-error recovery for GRAPH_NO_KEYCHAIN (#73)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: `GRAPH_NO_KEYCHAIN` retryable with a hint; `AUTH_EXPIRED` copy (component)

**Files:**
- Modify: `src/pages/app/components/completion/CalendarProposal.tsx` (`RETRYABLE_CODES` + doc ~40-55, `CALENDAR_SETTINGS_REMEDY` doc + table ~57-105, error render branch ~645-670)
- Test: `src/tests/CalendarProposal.states.test.tsx` (~161-199)

**Interfaces:**
- Consumes: `GraphErrorCode` from `@/types`, existing `RetryableGraphErrorCode` type (derived from `RETRYABLE_CODES`).
- Produces: `const RETRYABLE_HINT: Partial<Record<RetryableGraphErrorCode, string>>` (module-private).

- [ ] **Step 1: Write the failing tests**

In `src/tests/CalendarProposal.states.test.tsx`, replace the block from the doc comment `/**\n   * IMPORTANT 3's fail-first case.` (line ~161) through the end of the `it.each(["GRAPH_NETWORK", "GRAPH_THROTTLED", "GRAPH_BAD_RESPONSE"] ...)` test (line ~199) with:

```tsx
  /**
   * IMPORTANT 3's fail-first case, as revised by issue #73. GRAPH_AUTH_EXPIRED
   * no longer means the stored refresh token was already deleted - it is
   * retained until three confirmed failures - but "Try again" still cannot
   * help: it re-redeems the same dead token and re-derives the same
   * invalid_grant. A retry button offering a fix that cannot work is worse
   * than none, so these get a pointer at the actual remedy instead.
   */
  it.each([
    ["GRAPH_AUTH_EXPIRED", /reconnect/i],
    ["GRAPH_NOT_CONNECTED", /connect/i],
    ["GRAPH_CONSENT_REQUIRED", /administrator|consent/i],
  ] as const)("offers a settings pointer, not a retry, for %s", async (code, remedyPattern) => {
    invoke.mockClear();
    renderState({ kind: "error", code });
    expect(screen.queryByTestId("calendar-proposal-retry")).toBeNull();
    const settingsButton = screen.getByTestId("calendar-proposal-open-settings");
    expect(screen.getByTestId("calendar-proposal-region")).toHaveTextContent(remedyPattern);

    await userEvent.click(settingsButton);
    expect(invoke).toHaveBeenCalledWith("open_dashboard");
  });

  // Issue #73: the credential is kept below the threshold, so the copy must
  // stop claiming the connection was reset.
  it("says the sign-in expired without claiming the connection was reset", () => {
    renderState({ kind: "error", code: "GRAPH_AUTH_EXPIRED" });
    const region = screen.getByTestId("calendar-proposal-region");
    expect(region).toHaveTextContent(
      "Your Microsoft sign-in expired. Reconnect from the Odoo page's Calendar section."
    );
    expect(region).not.toHaveTextContent(/was reset/i);
  });

  // The four codes retrying can genuinely fix keep the retry control and get
  // no settings pointer - Important 3 narrows the OTHER five, not these.
  it.each(["GRAPH_NETWORK", "GRAPH_THROTTLED", "GRAPH_BAD_RESPONSE", "GRAPH_NO_KEYCHAIN"] as const)(
    "keeps the retry control, with no settings pointer, for %s",
    (code) => {
      renderState({ kind: "error", code });
      expect(screen.getByTestId("calendar-proposal-retry")).toBeInTheDocument();
      expect(screen.queryByTestId("calendar-proposal-open-settings")).toBeNull();
    }
  );

  /**
   * Issue #73: GRAPH_NO_KEYCHAIN covers persistent keychain failures too
   * (keychain.rs maps every non-NoEntry error to it), and a retryable code
   * renders no remedy line - so without the hint a persistently failing
   * keychain would show a "Try again" that never works and nothing pointing
   * at the reconnect that does.
   */
  it("points a keychain read failure at reconnect if retrying keeps failing", async () => {
    const { onRetry } = renderState({ kind: "error", code: "GRAPH_NO_KEYCHAIN" });
    expect(screen.getByTestId("calendar-proposal-region")).toHaveTextContent(
      "Couldn't read the saved calendar connection from this device's secure storage. If this keeps happening, reconnect from the Odoo page's Calendar section."
    );
    await userEvent.click(screen.getByTestId("calendar-proposal-retry"));
    expect(onRetry).toHaveBeenCalled();
  });

  it.each(["GRAPH_NETWORK", "GRAPH_THROTTLED", "GRAPH_BAD_RESPONSE"] as const)(
    "shows no reconnect hint for %s",
    (code) => {
      renderState({ kind: "error", code });
      expect(screen.getByTestId("calendar-proposal-region")).not.toHaveTextContent(
        /keeps happening/i
      );
    }
  );
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/tests/CalendarProposal.states.test.tsx`
Expected: FAIL — `says the sign-in expired...` (old copy has ", and the connection was reset"), `keeps the retry control ... for GRAPH_NO_KEYCHAIN` (no retry button), `points a keychain read failure at reconnect...` (no hint).

- [ ] **Step 3: Move `GRAPH_NO_KEYCHAIN` to the retryable set**

Replace the `RETRYABLE_CODES` doc and constant:

```tsx
/**
 * The three codes where re-running the SAME call is the correct action: a
 * transient network failure, a rate limit, or a response Graph sent this time
 * that happened to be unparseable. Every other code gets a settings pointer
 * instead - see `CALENDAR_SETTINGS_REMEDY` below.
```

with:

```tsx
/**
 * The codes where re-running the SAME call is the correct action: a
 * transient network failure, a rate limit, a response Graph sent this time
 * that happened to be unparseable, or a keychain read that failed this time
 * (issue #73 - it says nothing about the connection, and the status path's
 * retry re-reads it). Every other code gets a settings pointer instead - see
 * `CALENDAR_SETTINGS_REMEDY` below.
```

and change the array to:

```tsx
const RETRYABLE_CODES = [
  "GRAPH_NETWORK",
  "GRAPH_THROTTLED",
  "GRAPH_BAD_RESPONSE",
  "GRAPH_NO_KEYCHAIN",
] as const satisfies readonly GraphErrorCode[];
```

- [ ] **Step 4: Rewrite the remedy doc, drop the stale entry, fix the copy**

In `CALENDAR_SETTINGS_REMEDY`'s doc comment, replace:

```tsx
 * Retrying cannot fix any of these. GRAPH_AUTH_EXPIRED reaches here only
 * after mod.rs's refresh_and_adopt has already deleted the stored refresh
 * token (the AUTH_EXPIRED arm), so a second attempt just re-derives
 * GRAPH_NOT_CONNECTED - "Try again" promises a fix it cannot deliver.
 * GRAPH_NOT_CONNECTED, GRAPH_CONSENT_REQUIRED and GRAPH_NO_KEYCHAIN are
 * milder versions of the same gap. GRAPH_AUTH_REJECTED (a rejected stored
```

with:

```tsx
 * Retrying cannot fix any of these. GRAPH_AUTH_EXPIRED is Entra's
 * invalid_grant: mod.rs keeps the stored refresh token until three
 * consecutive confirmed failures (issue #73), but a second attempt just
 * re-redeems the same dead token and re-derives the same invalid_grant -
 * "Try again" promises a fix it cannot deliver. GRAPH_NOT_CONNECTED and
 * GRAPH_CONSENT_REQUIRED are milder versions of the same gap.
 * GRAPH_AUTH_REJECTED (a rejected stored
```

In the table, replace the `GRAPH_AUTH_EXPIRED` value with:

```tsx
  GRAPH_AUTH_EXPIRED:
    "Your Microsoft sign-in expired. Reconnect from the Odoo page's Calendar section.",
```

and delete the entry:

```tsx
  GRAPH_NO_KEYCHAIN:
    "The saved calendar connection could not be read from this device's secure storage. Reconnect from the Odoo page's Calendar section.",
```

(TypeScript now requires this deletion: the key type is `Exclude<GraphErrorCode, RetryableGraphErrorCode>`.)

- [ ] **Step 5: Add the hint table and render it**

Directly after the closing `};` of `CALENDAR_SETTINGS_REMEDY`, add:

```tsx
/**
 * Rendered under "Try again" for the retryable codes that can also be
 * PERSISTENT. keychain.rs maps every non-NoEntry keychain error to
 * GRAPH_NO_KEYCHAIN, access-denied included, and a retryable code renders no
 * remedy line - so without this, a keychain that keeps failing shows a
 * "Try again" that never works and nothing pointing at the reconnect that
 * does (graph_connect degrades to session-only when the keychain is
 * unusable). Static copy only, the same rule as the table above.
 */
const RETRYABLE_HINT: Partial<Record<RetryableGraphErrorCode, string>> = {
  GRAPH_NO_KEYCHAIN:
    "Couldn't read the saved calendar connection from this device's secure storage. If this keeps happening, reconnect from the Odoo page's Calendar section.",
};
```

In the error render branch, replace:

```tsx
    const retryable = RETRYABLE_CODE_SET.has(state.code);
    return region(
      <>
        <p className="text-[11px] text-destructive">{state.code}</p>
```

with:

```tsx
    const retryable = RETRYABLE_CODE_SET.has(state.code);
    // Cast for the same reason the remedy lookup below casts: `retryable` is a
    // Set.has boolean, not a type guard.
    const hint = retryable
      ? RETRYABLE_HINT[state.code as RetryableGraphErrorCode]
      : undefined;
    return region(
      <>
        <p className="text-[11px] text-destructive">{state.code}</p>
        {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run src/tests/CalendarProposal.states.test.tsx`
Expected: all PASS.

Then the neighbours that read the same component or codes, each scoped:
`npx vitest run src/tests/CalendarProposal.create.test.tsx`, `npx vitest run src/tests/CalendarProposal.slots.test.tsx`, `npx vitest run src/tests/graph-errors.test.ts`, `npx vitest run src/tests/odoo-settings-page.test.tsx` — expected: all PASS unchanged (the `odoo-settings-page` `GRAPH_NO_KEYCHAIN` cases are connect/status-path copy on the Odoo page, untouched here). If `odoo-settings-page` times out on the calendar-seed case, rerun that file alone once — it is a known full-run flake that passes alone.

Then `npx tsc --noEmit` and `npm run lint` — expected: no new errors.

- [ ] **Step 7: Commit**

```bash
git add src/pages/app/components/completion/CalendarProposal.tsx src/tests/CalendarProposal.states.test.tsx
git commit -m "fix(calendar): keychain read failure is retryable; sign-in-expired copy (#73)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Manual gates (after all tasks; record results in the PR description)

1. **Single-instance** — see Task 3's manual gate.
2. **The fix's own success criterion.** With a calendar connected, make the stored refresh token fail with `invalid_grant` (e.g. revoke sessions for the account in Entra), then RESTART the app before the first picker open — a still-valid in-memory access token (~55 minutes) would otherwise serve the open without redeeming the refresh token (`mod.rs:645-653`). Open the picker once: the block shows "Your Microsoft sign-in expired. Reconnect from the Odoo page's Calendar section.", and the Odoo page still shows the calendar connected (Disconnect visible). Restart the app: the block still appears with the same copy (before this change it vanished). Open the picker three times in one launch: the third deletes the credential, and the Odoo page shows no Disconnect button after a reload. A reconnect at any point restores a working connection.

## PR description notes (accepted, not fixed here)

- The `GRAPH_NO_KEYCHAIN` hint says "Couldn't read", but a FAILED DELETE at the invalid_grant threshold also surfaces `GRAPH_NO_KEYCHAIN` (Task 1's `record_invalid_grant_surfaces_a_failed_delete_and_keeps_the_streak`). The remedy it names (reconnect) is still right for that case; only the verb is loose.
- Follow-up, out of #73's scope: a reconnect to a different account WITHOUT a disconnect in between (the Odoo page's "Connect calendar" is always rendered) keeps `connected` true → true, so `useCalendarProposal` does not reset and an open picker can keep the previous account's proposal. Pre-existing; Task 4 deliberately does not widen the broadcast listener to cover it.
