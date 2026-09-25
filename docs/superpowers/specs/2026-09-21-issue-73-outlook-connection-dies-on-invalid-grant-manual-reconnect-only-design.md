# Outlook Connection Survives invalid_grant

**Date:** 2026-09-21
**Status:** Approved, ready for implementation plan
**Source:** GitHub issue #73 (bug), part of #71. Issue title/body treated as
requirements data; every claim below was re-verified against the code at
`9591756` before being written down here.

## Problem

The Outlook (Microsoft Graph) calendar connection dies on Entra `invalid_grant`
and the only recovery is a manual PKCE reconnect on the integrations page —
matching the report: "Outlook sync gets disconnected and I have to go manually
fix it on the integrations page."

Every `invalid_grant` is treated as terminal today. `refresh_and_adopt`'s
`AUTH_EXPIRED` arm (`src-tauri/src/graph/mod.rs:464-470`) calls
`forget_refresh_token`, which deletes the keychain credential
(`mod.rs:367-385` → `keychain.rs:105-114`). But `invalid_grant` also arrives
for conditions that are recoverable or at least not "delete the credential
now": a password change, an admin revocation, a Conditional Access change,
inactivity expiry, and replay detection after a double redemption. Deleting on
the first one converts every such event into a full reconnect, and makes the
connection *vanish* rather than degrade.

Three contributors, all verified in the code:

1. **No single-instance guard.** `tauri-plugin-single-instance` is absent from
   `src-tauri/Cargo.toml`. Two app processes share one keychain refresh
   token, both redeem it, and Entra's replay detection revokes the whole token
   family — the hazard is already documented in-code at `mod.rs:163-167`.
2. **Transient keychain read error shown as disconnected.** Any keychain read
   failure becomes `GRAPH_NO_KEYCHAIN` (`keychain.rs:97-103`); the frontend
   catch sets `connected = false` (`src/hooks/useCalendarProposal.ts:172-177`)
   and the block renders remedy copy telling the user to reconnect
   (`CalendarProposal.tsx:103-104`) — exactly what `GraphState::status`'s doc
   comment (`mod.rs:185-193`) warns against.
3. **Persist-failure latch** (medium): one transient keychain write failure
   latches `session_only` (`mod.rs:322-324`) while the keychain keeps the
   already-rotated-away token — dead on next launch. Recorded as a non-goal
   below; it is not in the issue's fix direction.

## Solution

Three changes, one per fix direction in the issue:

| # | Change | Layer |
|---|--------|-------|
| 1 | `invalid_grant` keeps the credential until **3 consecutive confirmed failures** against the current credential | Rust |
| 2 | Single-instance plugin: a second launch surfaces the existing process's dashboard | Rust |
| 3 | `GRAPH_NO_KEYCHAIN` is reported as transient, not "disconnected" | Frontend |

### Decisions taken

| Question | Decision |
|---|---|
| Delete on which `invalid_grant`? | The 3rd consecutive confirmed one against the CURRENT credential (in-memory streak) |
| Streak persisted across launches? | No. In-memory, resets on any successful token adoption. Consequence accepted — see "Why in-memory" below |
| What resets the streak? | Successful `adopt` inside `adopt_and_persist_with` (covers connect and refresh, session-only included). Nothing else |
| What leaves the streak untouched? | Transport errors, 5xx, 429, every non-`invalid_grant` code, and an `invalid_grant` for a token that is no longer the current credential |
| Second instance behavior | Route to the existing `open_dashboard` path; argv ignored |
| `GRAPH_NO_KEYCHAIN` remedy | "Try again" (moved to the retryable set) plus a "if this keeps happening, reconnect" hint; `connected` not flipped; no calendar fetch while the status read is failing |
| Persist-failure latch | Out of scope (see non-goals) |
| Dev builds vs the installed app | Share the identifier, so one blocks the other. Accepted and documented (see §2) |

## Architecture

### 1. `invalid_grant` keeps the credential until repeated confirmed failure

The issue's fix direction is "delete only after repeated confirmed failures".
"Confirmed" means a real Entra token-endpoint response mapped to
`AUTH_EXPIRED` by `classify_token_error` (`auth.rs:370-387`): a non-200
response (Entra sends HTTP 400) whose body carries `"error": "invalid_grant"`.
`post_token` only classifies non-200 responses (`auth.rs:441-443`); a 200 with
an error body becomes `BAD_RESPONSE` and never reaches this path. Transport
failures (mapped `NETWORK`), 5xx (also `NETWORK`), 429 (`THROTTLED`),
malformed bodies (`AUTH_REJECTED`), and consent errors are NOT evidence about
the refresh token and must never count toward deletion — this is
`auth.rs:366-369`'s existing retain rule, kept exactly. Keychain failures
never reach `classify_token_error` at all: they surface as `NO_KEYCHAIN` or
the `session_only` latch.

#### State

`GraphState` gains one field:

```rust
/// Consecutive confirmed invalid_grant responses against the CURRENT
/// credential. Bumped by `record_invalid_grant_with`, reset to 0 by
/// `adopt_and_persist_with` on any successful adoption. Both run under
/// `persist_op`. Never persisted: each launch re-earns deletion from zero.
invalid_grant_streak: std::sync::atomic::AtomicU32,
```

An atomic, not another `Mutex`, so it adds nothing to the module's lock-order
invariant (the doc comment block at `mod.rs:116-138` stays true as written).
Every read-modify-write of it happens while holding `persist_op`: the bump in
`record_invalid_grant_with` (below) and the reset in `adopt_and_persist_with`.
`graph_connect`'s adopt (`mod.rs:601`) goes through `adopt_and_persist_with`
too, so a connect and a failing refresh's bump are fully serialized. Together
with the identity check below, a failure against an old token can never be
counted against, or delete, a newer one.

`INVALID_GRANT_FORGET_THRESHOLD: u32 = 3`, a module constant next to the
error-code constants, with a doc comment stating the trade-off (below). The
comparison is a pure function, `should_forget(streak: u32) -> bool`
(`streak >= INVALID_GRANT_FORGET_THRESHOLD`), per the module header's contract.

#### The seam and the arm

`refresh_and_adopt` is split, following the file's established injection
pattern (`adopt_and_persist_with` injects `persist`,
`forget_refresh_token_with` injects `delete`), into:

- `refresh_and_adopt_with(state, generation, stale, refresh, persist, delete)`
  — the whole current body, with the token-endpoint call, the keychain write,
  and the keychain delete all injected:

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
      Fut: std::future::Future<Output = Result<auth::Tokens, String>>,
  ```

  `persist` is passed to `adopt_and_persist_with` on the success arm, `delete`
  to `record_invalid_grant_with` on the `AUTH_EXPIRED` arm. A test closure
  returns `std::future::ready(...)`; no async closures needed.
- `refresh_and_adopt(state, authority, client_id, generation, stale)` — the
  real wrapper, unchanged signature, passing
  `|stored| async move { auth::refresh(authority, client_id, &stored, now_ms()).await }`,
  `auth::persist_rotated`, and `keychain::delete_refresh_token`. Both call
  sites in `graph_current_meetings` keep calling it.

`forget_refresh_token_with`'s body (read `session_only`, `clear_session`,
`delete` unless session-only) moves into a lock-free helper
`clear_and_delete(state, delete)` whose doc comment says the caller must hold
`persist_op`. `forget_refresh_token_with` becomes "take `persist_op`, call
`clear_and_delete`", so `graph_disconnect` is unchanged in behavior.

A new function records a confirmed failure:

```rust
/// Caller must NOT hold `persist_op`; this takes it.
fn record_invalid_grant_with(
    state: &GraphState,
    failed: &str,
    delete: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    let _persist_guard = state.persist_op.lock().unwrap_or_else(|e| e.into_inner());
    // A graph_connect that adopted a DIFFERENT credential while this
    // redemption was in flight: the failure is evidence about the old token
    // only, and must neither count against nor delete the new one.
    let current = state.session.lock().unwrap_or_else(|e| e.into_inner()).refresh_token.clone();
    if current.is_some_and(|t| t != failed) {
        return Ok(());
    }
    let streak = state.invalid_grant_streak.fetch_add(1, Ordering::Relaxed) + 1;
    if !should_forget(streak) {
        return Ok(());
    }
    clear_and_delete(state, delete)
}
```

The `session` lock is a statement-scoped temporary, dropped before
`clear_and_delete` takes it again, so lock-invariant part 2 holds. A memory
that is EMPTY (fresh launch, token read from the keychain) is treated as
"still current" — nothing has been adopted since the read.

The streak is NOT reset after reaching the threshold. After a successful
delete the arm is unreachable until a reconnect adopts a new token (which
resets it); after a FAILED delete, memory is clear but the dead token is still
on disk, so the next refresh re-reads it, fails, and `4 >= 3` retries the
delete immediately instead of waiting three more failures.

`refresh_and_adopt_with`'s `AUTH_EXPIRED` arm becomes:

```rust
Err(code) if code == AUTH_EXPIRED => {
    // A keychain failure while forgetting is surfaced, not swallowed:
    // "your credential is dead AND it is stuck on disk" is a different
    // problem from "reconnect", and the user can act on it.
    record_invalid_grant_with(state, &stored, delete)?;
    return Err(AUTH_EXPIRED.to_string());
}
```

Below threshold: memory and keychain both keep the credential, `graph_status`
keeps reporting `connected: true`, and the function returns `AUTH_EXPIRED` as
before — the block stays visible with a reconnect remedy instead of collapsing
into the "never set up" state. At threshold: current behavior (clear memory,
delete keychain, surface a keychain delete failure via `?` — the existing
comment at `mod.rs:465-467` is kept verbatim).

The reset lives in `adopt_and_persist_with`, **immediately after `adopt`
returns true and BEFORE the `session_only` early return** (`mod.rs:316-320`),
so session-only adoptions reset it too. `graph_connect` adopts through the
same function, so a fresh connection starts at zero without a second reset
site. `adopt` returning `false` (disconnect race) returns `Err` before the
reset is reachable — correct, nothing was adopted.

The streak does NOT reset on `graph_disconnect`. It is dead state there —
`stored_refresh_token` returns `NOT_CONNECTED` until a reconnect adopts a new
token, which resets it.

#### How often the streak moves, and why 3

The threshold is reached by user actions, not within seconds. Each picker
open makes one `graph_current_meetings` call (`hasFetched`,
`useCalendarProposal.ts:448-464`); a first-call-site `AUTH_EXPIRED` returns via
`?` before the 401-retry arm (`mod.rs:651-653`); and `AUTH_EXPIRED` is not
retryable, so the block offers no "Try again" to add counts. Three failures
means three picker opens in one launch.

`refresh_and_adopt_with` re-reads `stored_refresh_token` (`mod.rs:461`,
defined at `mod.rs:484-500`) at every attempt, so each retry re-redeems the
same stored string, and a reload can never produce a newer token than the one
just attempted: within one process `refresh_op` serializes all redemptions and
`adopt_and_persist` writes memory and keychain together; on the
persist-failure-latch path the keychain holds an OLDER token and memory is
preferred. Change 2 removes the one cross-process writer. So retaining the
credential does not make a dead token come back. What it buys:

- **Visibility instead of vanishing.** While the credential is retained,
  `graph_status` reports `connected: true`, so after a restart the block is
  still present and says "sign-in expired, reconnect" rather than the feature
  silently disappearing — which is what the report describes.
- **One response never destroys a ~90-day credential.**

Deletion stays as the backstop the issue asks for: it stops the per-open
same-string redemptions within a launch. If the cause is Entra replay
detection the family is already revoked, and the at-most-2 extra redemptions
change nothing about that. 3 rather than 2 or "never" is a judgement call:
low enough that an active user's session converges to the clean "not
connected" state, high enough that one or two picker opens never delete.

#### Why in-memory, and what that costs

Persisting the streak would need a new store write on the token path. Not
done. The accepted consequence: a user who opens the picker fewer than 3
times per launch keeps a dead credential across launches. Each launch's opens
show the sign-in-expired copy and cost one token-endpoint call each, and the
Odoo page shows the calendar as connected. Recovery is never blocked by the
retained credential: the Odoo page's "Connect calendar" button is always
rendered (`src/pages/odoo/index.tsx:922`, the Disconnect button beside it only
when connected), and a reconnect overwrites the keychain entry
(`keychain.rs` `set_password`) and resets the streak.

#### Explicit supersessions (comments and names that lie after this change)

The codebase currently codifies "invalid_grant proves dead" and the old
remedy classification in several places. All must be rewritten in the same
change, or a reader trusts a comment that no longer describes the code:

1. `auth.rs:366-369` — `classify_token_error`'s doc comment ("ONLY
   `invalid_grant` proves the refresh token is dead"). Reword to: invalid_grant
   is the only code mapped to `AUTH_EXPIRED`, and it is treated as
   *strong-but-not-immediate* evidence — deletion requires the threshold.
2. `auth.rs:920` — the test name `only_invalid_grant_means_the_refresh_token_is_dead`.
   Rename to `only_invalid_grant_maps_to_auth_expired`; the assertions stay.
3. `mod.rs:380-385` — `forget_refresh_token` and its doc ("the one response
   that proves the refresh token is genuinely dead"). Its only caller is the
   `AUTH_EXPIRED` arm (`mod.rs:468`), which now calls
   `record_invalid_grant_with`, so delete the function (it would be dead
   code). Reword the comments that name it — `mod.rs:609`, `mod.rs:926-927`,
   `mod.rs:1014` — to name `record_invalid_grant_with` or
   `forget_refresh_token_with` as appropriate.
4. `mod.rs:338-340` — `forget_refresh_token_with`'s header ("called on an
   explicit `invalid_grant`"). Reword: `clear_and_delete` is reached by
   `graph_disconnect` and by `record_invalid_grant_with` at the threshold.
5. `mod.rs:406-409` — `refresh_and_adopt`'s doc calling "the dead credential
   sitting in the keychain forever" a defect. Keep the point that both call
   sites share one arm; add that a dead credential is now retained
   deliberately until the threshold or a reconnect.
6. `CalendarProposal.tsx:40-43` — `RETRYABLE_CODES`'s doc ("The three codes
   where re-running the SAME call is the correct action: a transient network
   failure, a rate limit, or ... unparseable"). Four codes now; add the
   transient keychain read and drop the count.
7. `CalendarProposal.tsx:63-66` — the remedy-table comment claiming
   `AUTH_EXPIRED` "reaches here only after refresh_and_adopt has already
   deleted the stored refresh token". False after this change; rewrite, and
   with it the justification for keeping `AUTH_EXPIRED` non-retryable (it
   stays non-retryable, but because retrying re-derives the same
   `invalid_grant`, not because the credential is already gone).
8. `CalendarProposal.tsx:67-68` — "GRAPH_NOT_CONNECTED, GRAPH_CONSENT_REQUIRED
   and GRAPH_NO_KEYCHAIN are milder versions of the same gap". Drop
   `GRAPH_NO_KEYCHAIN`; it is no longer in this table.

#### Copy: `AUTH_EXPIRED`

`CalendarProposal.tsx:99-100` says "Your Microsoft sign-in expired, and the
connection was reset." The reset no longer happens. New copy:

> Your Microsoft sign-in expired. Reconnect from the Odoo page's Calendar
> section.

Reconnect stays the remedy — it is the correct recovery for a genuinely dead
token — but the copy stops claiming the connection was destroyed.

#### Non-goal: the persist-failure latch

`adopt_and_persist_with`'s degrade-to-`session_only` on a persist failure
(`mod.rs:322-324`) stays as designed: it keeps a working in-memory credential
alive rather than discarding it. Its dead-on-next-launch tail (keychain holds
the rotated-away token) is mitigated from two directions in this change —
change 2 removes the main amplifier (two processes rotating the same
credential), and change 1 means the resulting `invalid_grant` leaves the block
visible with a reconnect remedy and a clean threshold deletion instead of an
immediate delete. Reworking the latch itself (e.g. a retry-on-next-launch
flag) is out of scope; the issue's fix direction does not include it.

### 2. Single-instance guard

- `src-tauri/Cargo.toml`: add `tauri-plugin-single-instance = "2"` to the
  dependencies.
- `src-tauri/src/lib.rs`: register it FIRST in the builder chain (before
  `tauri_plugin_sql`) — the plugin's own documented requirement, and the
  natural place next to the existing "before the builder" comment at line 98.
  On Windows the plugin uses a named mutex, so the second process detects the
  first and exits before any state or window setup runs.

Callback body: surface the dashboard through the existing `open_dashboard`
command (`src-tauri/src/window.rs:432`), ignoring argv and cwd. This app has
no deep-link or protocol-handler surface for the argv to feed:

```rust
.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
    // The dashboard, not the overlay: `main` is the 54px skipTaskbar overlay
    // whose visibility the toggle shortcut tracks in its own state
    // (shortcuts.rs `is_hidden`), which a direct show() here would desync.
    // `open_dashboard` is async for the reason on its own doc comment, so it
    // runs on the async runtime, not on this callback's thread.
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let _ = window::open_dashboard(app).await;
    });
}))
```

No capability/permission entries: the plugin exposes no frontend API. This is
the change that makes Decision 1's retry sound — with one process, nothing
else rotates the keychain credential between attempts.

**Dev builds.** `tauri dev` and the installed app share the identifier
`com.meetwings.app` (`tauri.conf.json:5`), which names the plugin's mutex. With
the installed app running (it autostarts), `npm run tauri dev` exits at once
and surfaces the installed app's dashboard, and dev builds from two worktrees
cannot run side by side. Accepted, not worked around: dev and installed builds
also share the keychain service `com.meetwings.graph` (`keychain.rs:15`), so
two of them running together is exactly the double redemption this guard
exists to stop. Gating the plugin on `debug_assertions` would bring that
back. Workflow: quit the installed app before `tauri dev`.

### 3. `GRAPH_NO_KEYCHAIN` is transient, not disconnected

`GraphState::status` already does the right thing in Rust — it propagates a
keychain read failure as `Err(GRAPH_NO_KEYCHAIN)` and its doc comment
(`mod.rs:185-193`) explicitly forbids collapsing it into `connected: false`.
The collapse happens in the webview:

**`readStatus`** (`src/hooks/useCalendarProposal.ts:172-177`). The catch
currently sets `connected = false` for every failure code. Split one code out:

```ts
} catch (err) {
  if (mine === statusGen.current) {
    const code = toGraphError(err).code;
    // A keychain read failure says nothing about the connection: Rust
    // propagates it and the block below renders it as a transient error.
    // Flipping connected here is the exact collapse GraphState::status's
    // doc comment forbids.
    if (code !== "GRAPH_NO_KEYCHAIN") {
      setConnected(false);
    }
    setStatusError(code);
  }
}
```

`connected` is left at its previous value — after a successful connect, a
transient keychain failure must not flip the page to "disconnected". On a
fresh mount (initial state `false`) the block is still not vanished:
`blockPresent` is `statusError !== null || present`
(`useCalendarProposal.ts:123`), so the error state renders either way. The
next successful read — mount, "Try again", or any `graph-connection-changed`
broadcast — clears `statusError` and restores the true state, which is the
retry path this design relies on instead of adding a poller.

The observable difference from today: with `connected` no longer flipping,
the fetch effect's `connectedChanged` branch (`useCalendarProposal.ts:448-464`)
no longer fires `reset()` on the hiccup and again on the recovery, so a
proposal the open picker already fetched survives the hiccup and is shown
again on recovery with no refetch.

**The fetch effect is gated on `statusError === null`.** Today every status
error also forces `connected` false, so `present` is false and the fetch
effect can never start while a status error is showing. The carve-out above
breaks that for `GRAPH_NO_KEYCHAIN`: `connected` can stay true alongside
`statusError`, and without a gate a picker reopen during the hiccup would fire
a `graph_current_meetings` call whose result is hidden behind the status error
and whose `hasFetched` latch then suppresses a fresh fetch after recovery.
Change the effect's early return to
`if (!present || statusError !== null || hasFetched.current) return;` and add
`statusError` to its dependency array. When `statusError` clears, the effect
re-runs and fetches if this open has not fetched yet.

**The remedy table** (`CalendarProposal.tsx:90-105`). Move
`GRAPH_NO_KEYCHAIN` out of `CALENDAR_SETTINGS_REMEDY` and add it to
`RETRYABLE_CODES` (`CalendarProposal.tsx:49-53`). Retrying a keychain read
CAN fix a transient failure — the block already renders a "Try again" button
for retryable codes wired to `onRetry` (the status path re-runs `readStatus`
via `retryStatus`, `useCalendarProposal.ts:490`; the fetch path refetches),
and both paths' "Try again" genuinely re-attempt the read. TypeScript makes
the move mechanical: the table's key type is
`Exclude<GraphErrorCode, RetryableGraphErrorCode>`, so leaving the stale
entry behind fails to compile.

`load_refresh_token` maps EVERY non-`NoEntry` error to this code
(`keychain.rs:97-103`), persistent ones included (access denied, no storage
access), and retryable codes render no remedy line today
(`CalendarProposal.tsx:652-660`). So a persistently failing keychain would
show the raw code and a "Try again" that never works, with nothing pointing
at the one fix that does (a reconnect degrades to session-only,
`mod.rs:595`). Add a small hint table beside the remedy table:

```ts
/** Rendered under "Try again" for retryable codes that can also be persistent. */
const RETRYABLE_HINT: Partial<Record<RetryableGraphErrorCode, string>> = {
  GRAPH_NO_KEYCHAIN:
    "Couldn't read the saved calendar connection from this device's secure storage. If this keeps happening, reconnect from the Odoo page's Calendar section.",
};
```

and render `RETRYABLE_HINT[state.code]` (when defined) in the retryable branch,
in the same muted `<p>` style as the remedy line.

The `AUTH_EXPIRED` entry stays in the non-retryable table with the reworded
copy above. The fetch path can also surface `NO_KEYCHAIN` — from
`stored_refresh_token`'s keychain read when memory is empty on a fresh
launch (`mod.rs:499`) — and gets the same retryable treatment; `fetchNow`'s
catch writes only `state`, never `connected` or `statusError`.

**Unchanged on purpose.** The odoo page's `graph_status` catch
(`src/pages/odoo/index.tsx:497-500`) already surfaces the code as an error
message rather than a false disconnect — it complies. The connect-path
`NO_KEYCHAIN` info copy (`index.tsx:740-743`) describes persist
unavailability (session-only), a different situation; it stays.

## Edge cases

1. **Password change.** Terminal for the refresh token in Entra — the fix
   never claims otherwise. The user still reconnects; what changes is that
   the credential and `connected: true` survive until the threshold, so the
   block shows "sign-in expired, reconnect" instead of collapsing to the
   setup state on the first failure.
2. **Replay detection.** Covered above: bounded same-string retries, family
   already revoked when this is the cause, deletion at threshold stops the
   re-use. Accepted trade-off, recorded at the threshold constant.
3. **"Try again" on an `AUTH_EXPIRED` block.** Not offered — `AUTH_EXPIRED`
   stays non-retryable. A user who wants to retry has the reconnect remedy.
4. **User-initiated disconnect.** `graph_disconnect`
   (`mod.rs:606-623`) is untouched in behavior: it deletes immediately,
   unconditionally. Only the automatic invalid_grant path gains the threshold.
5. **Session-only (Linux, no keychain service).** The streak logic is
   identical; at threshold `clear_and_delete`'s session-only branch clears
   memory and skips the delete, as today. Session-only adoptions reset the
   streak (the reset precedes the session-only early return).
6. **Below-threshold state seen by the odoo page.** `graph_status` still
   reports `connected: true` (keychain untouched), so the Disconnect button
   and the session-only banner behave as before. "Connect calendar" is
   rendered at every point, so the manual reconnect remains available — it is
   just no longer the *only* thing standing between the user and a transient
   failure.
7. **Stale streak across a reconnect.** A successful connect adopts a new
   token, which resets the streak under `persist_op`, and
   `record_invalid_grant_with` ignores a failure whose token differs from the
   current in-memory one. A streak can only reach the threshold with 3
   confirmed failures against the CURRENT credential.
8. **Reconnect racing an in-flight refresh.** `refresh_and_adopt` reads T_old
   and awaits Entra; the user reconnects (adopting T_new under `persist_op`,
   without `refresh_op`); Entra answers `invalid_grant` for T_old. The
   identity check sees memory = T_new ≠ T_old and returns without counting or
   deleting. Today this sequence deletes T_new.
9. **Dead credential across launches.** A user opening the picker fewer than
   3 times per launch keeps the dead credential; see "Why in-memory".
10. **Two instances of an older version.** Nothing this change can do; the
    guard takes effect once the updated build is running. Both instances of
    an OLD build keep the current (delete-on-first) behavior, which is the
    status quo, not a regression.

## Testing

Rust, in `src-tauri/src/graph/mod.rs`'s existing test module (the module
header's contract: decision logic as pure functions, unit-tested on every
target):

- **`should_forget`.** Below threshold returns false; at and above (3, 4)
  returns true — pins that a failed delete is retried on the next failure.
- **`GraphState::default()`** asserts the streak starts at 0.
- **Reset on success.** Extend an existing `adopt_and_persist_with` fake-persist
  test: bump the streak first, run a successful adopt-then-persist, assert the
  streak reads 0. A session-only variant (reset still happens despite the
  early return). The disconnect-race variant: `adopt` returning `false` must
  NOT reset it.
- **`refresh_and_adopt_with` seam.** Every seam test injects all three of
  `refresh`, `persist`, and `delete`, seeds a refresh token in memory first,
  and never makes a call after one that cleared memory on the normal path —
  `stored_refresh_token` would otherwise read the developer's real keychain
  (`mod.rs:499`), the defect class recorded at `mod.rs:1013-1026`. Tests, one
  per behavior the change adds:
  - two fake `invalid_grant` responses: delete spy NOT called, memory still
    holds the credential, streak reads 2, result is `AUTH_EXPIRED` both times;
  - third consecutive: delete spy called exactly once, memory cleared, result
    `AUTH_EXPIRED`;
  - `invalid_grant` → success (injected `persist` spy, no real write) →
    `invalid_grant` ×2: delete spy not called (streak was reset by the
    success);
  - a `NETWORK` failure between `invalid_grant`s: delete spy not called,
    streak value unchanged by the transport error;
  - delete spy returning `Err` at threshold: the error propagates, and the
    streak is NOT reset (reads 3);
  - identity check: the injected `refresh` closure adopts a different token
    into memory (simulating a concurrent `graph_connect`) and then returns
    `invalid_grant`, with the streak pre-set to 2: delete spy not called,
    streak unchanged, memory still holds the new token.
- The existing loopback tests of the post-lock shortcut
  (`refresh_and_adopt_does_not_shortcut_on_the_token_the_caller_just_had_rejected`,
  `refresh_and_adopt_still_takes_the_shortcut_when_memory_holds_a_different_token`,
  `mod.rs:~1180-1267`) call the real wrapper and must pass unchanged.

Vitest, matching the existing files under `src/tests/`:

- `useCalendarProposal.test.tsx` — the hook does not return `connected`
  (`UseCalendarProposalReturn`, `useCalendarProposal.ts:37-42`), and while
  `statusError` is set its return is identical whether `connected` flipped or
  not. Assert through the fetch effect instead:
  - **Hiccup keeps the proposal.** `graph_status` ok → picker open → proposal
    fetched → broadcast `graph-connection-changed` with `graph_status` throwing
    `GRAPH_NO_KEYCHAIN` (state is the error) → broadcast again with
    `graph_status` ok. Assert `graph_current_meetings` was invoked exactly
    once in total and the state after recovery equals the pre-hiccup state.
    On today's code the `connected` flip resets and refetches (2 calls).
  - **No fetch while the status read fails.** Mount with `graph_status`
    ok → then broadcast with it throwing `GRAPH_NO_KEYCHAIN` while the picker
    is closed → open the picker: `graph_current_meetings` not invoked → recover
    via `onRetry`: invoked exactly once. Pins the `statusError` gate.
  - The existing "surfaces an unreadable connection state as an error" and
    "publishes the same presence" cases (~line 138-165) stay as they are.
- `CalendarProposal.states.test.tsx` — `GRAPH_NO_KEYCHAIN` moves from the
  settings-pointer table (~line 174) to a retryable assertion: "Try again"
  renders, clicking it calls `onRetry`, and the hint copy (/keeps happening/)
  renders. `GRAPH_AUTH_EXPIRED` stays in the settings-pointer table but the
  doc comment above it (~lines 163-170) is rewritten — its "already deleted"
  premise is false now — and the copy assertion becomes the new text (a
  NOT-/was reset/ guard pins the removal).
- `graph-errors.test.ts` — unchanged; the code set does not change.
- `odoo-settings-page.test.tsx` — existing `GRAPH_NO_KEYCHAIN` cases
  (connect-path info copy, `graph_status` error surfacing) are unchanged
  behavior; assert they still pass unchanged.

**Manual gates.**

1. Single-instance: quit any installed Meetwings first (it shares the
   identifier). Launch the built app twice. The second process exits, and the
   first instance's dashboard opens or comes to the front.
2. The fix's own success criterion: with a calendar connected, make the
   stored refresh token fail with `invalid_grant` (e.g. revoke sessions for
   the account in Entra). Open the picker once: the block shows the
   sign-in-expired copy, and the Odoo page still shows the calendar connected.
   Restart the app: the block still appears and shows sign-in-expired (today
   it vanishes). Open the picker three times in one launch: the third deletes
   the credential, and the Odoo page shows no Disconnect button after a
   reload. A reconnect at any point restores a working connection.
