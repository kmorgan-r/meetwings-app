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
| 1 | `invalid_grant` keeps the credential until **3 consecutive confirmed failures** | Rust |
| 2 | Single-instance plugin: second launch focuses the existing window | Rust |
| 3 | `GRAPH_NO_KEYCHAIN` is reported as transient, not "disconnected" | Frontend |

### Decisions taken

| Question | Decision |
|---|---|
| Delete on which `invalid_grant`? | The 3rd consecutive confirmed one (in-memory streak) |
| Streak persisted across launches? | No. In-memory, resets on any successful token adoption |
| What resets the streak? | Successful `adopt_and_persist` (covers connect and refresh). Nothing else |
| What leaves the streak untouched? | Transport errors, 5xx, 429, every non-`invalid_grant` code |
| Second instance behavior | Focus the existing `main` window; argv ignored |
| `GRAPH_NO_KEYCHAIN` remedy | "Try again" (moved to the retryable set); `connected` not flipped |
| Persist-failure latch | Out of scope (see non-goals) |

## Architecture

### 1. `invalid_grant` keeps the credential until repeated confirmed failure

The issue's fix direction is "delete only after repeated confirmed failures".
"Confirmed" means a real Entra token-endpoint response mapped to
`AUTH_EXPIRED` by `classify_token_error` (`auth.rs:370-387`): an HTTP 200
error body with `"error": "invalid_grant"`. Transport failures (mapped
`NETWORK`), 5xx (also `NETWORK`), 429 (`THROTTLED`), malformed bodies
(`AUTH_REJECTED`), and consent errors are NOT evidence about the refresh token
and must never count toward deletion — this is `auth.rs:366-369`'s existing
retain rule, kept exactly.

#### State

`GraphState` gains one field:

```rust
/// Consecutive confirmed invalid_grant responses from the token endpoint.
/// Bumped in `refresh_and_adopt`'s AUTH_EXPIRED arm, reset to 0 by
/// `adopt_and_persist_with` on any successful adoption. Never persisted:
/// each launch re-earns deletion from zero.
invalid_grant_streak: std::sync::atomic::AtomicU32,
```

An atomic, not another `Mutex`, so it adds nothing to the module's lock-order
invariant (the doc comment block at `mod.rs:116-138` stays true as written).
Both writers are serialized anyway: the bump happens inside
`refresh_and_adopt` while holding `refresh_op`; the reset happens inside
`adopt_and_persist_with` while holding `persist_op`. The only writer that does
not already hold `refresh_op` is `graph_connect`'s `adopt_and_persist` call
(`mod.rs:601`) — and a connect's reset is *correct* even if it interleaves
with a failing refresh's bump: a reset means a new working token was adopted,
which is exactly when accumulated evidence about the OLD token must be
discarded. Worst case of an interleave is a deletion delayed by one cycle;
no race can produce a premature deletion.

`INVALID_GRANT_FORGET_THRESHOLD: u32 = 3`, a module constant next to the
error-code constants, with a doc comment stating the trade-off (below).

#### The arm

`refresh_and_adopt`'s `AUTH_EXPIRED` arm becomes:

```rust
Err(code) if code == AUTH_EXPIRED => {
    let streak = state.invalid_grant_streak.fetch_add(1, Ordering::Relaxed) + 1;
    if streak >= INVALID_GRANT_FORGET_THRESHOLD {
        state.invalid_grant_streak.store(0, Ordering::Relaxed);
        forget_refresh_token(state)?;
    }
    return Err(AUTH_EXPIRED.to_string());
}
```

Below threshold: memory and keychain both keep the credential, `graph_status`
keeps reporting `connected: true`, and the function returns `AUTH_EXPIRED` as
before — the block stays visible with a reconnect remedy instead of collapsing
into the "never set up" state. At threshold: current behavior (clear memory,
delete keychain, surface a keychain delete failure via `?` — that half of the
existing comment at `mod.rs:465-467` is kept verbatim).

The reset lives in `adopt_and_persist_with`'s success path (after `adopt`
returns true), not in `refresh_and_adopt`: `graph_connect` adopts through the
same function, so a fresh connection starts at zero without a second reset
site. `adopt` returning `false` (disconnect race) returns `Err` before the
reset is reachable — correct, nothing was adopted.

The streak does NOT reset on `graph_disconnect`. It is dead state there —
`stored_refresh_token` returns `NOT_CONNECTED` until a reconnect adopts a new
token, which resets it. Adding a second reset site in `graph_disconnect` would
be harmless but touches a lock-adjacent function for no observable gain.

#### Why retrying the same token string is bounded and acceptable

`refresh_and_adopt` re-reads `stored_refresh_token` (`mod.rs:461`, defined at
`mod.rs:484-500`) at EVERY attempt — memory first, keychain on memory-empty.
So between the first `invalid_grant` and the threshold, each retry re-redeems
the same stored string. Three properties make this safe to accept:

- **A reload can never produce a newer token than the one just attempted.**
  Within one process `refresh_op` serializes all redemptions, and
  `adopt_and_persist` writes memory and keychain together on success. On the
  healthy path keychain == memory; on the persist-failure-latch path the
  keychain holds an OLDER token (memory is preferred, so a keychain reload is
  not even reached). Change 2 removes the one cross-process writer that could
  otherwise rotate the keychain token between attempts.
- **If the cause is Entra replay detection, the family is already revoked** —
  that is what produced the `invalid_grant`. The bounded extra redemptions
  (at most threshold−1 = 2) change nothing about that, and reaching the
  threshold deletes the credential, which STOPS the re-use. Deletion remains
  the terminal backstop.
- **The count is bounded at 3 per connection state.** A success, a disconnect,
  or the threshold each end the streak.

Threshold = 3 (not 2): two failures must survive a mid-session keychain
hiccup + one genuine failure without deleting; not more, because every
increment past the first is an additional same-string redemption in the
replay case.

#### Explicit supersessions (comments that lie after this change)

The codebase currently codifies "invalid_grant proves dead" in four places.
All four must be rewritten in the same commit, or a reader trusts a comment
that no longer describes the code:

1. `auth.rs:366-369` — `classify_token_error`'s doc comment ("ONLY
   `invalid_grant` proves the refresh token is dead"). Reword to: invalid_grant
   is the only code mapped to `AUTH_EXPIRED`, and it is treated as
   *strong-but-not-immediate* evidence — deletion requires the threshold.
2. `mod.rs:380-382` — `forget_refresh_token`'s doc ("the one response that
   proves the refresh token is genuinely dead"). Reword to threshold
   semantics.
3. `mod.rs:338-340` — `forget_refresh_token_with`'s header ("called on an
   explicit `invalid_grant`"). Reword: called once confirmed `invalid_grant`
   failures reach the threshold, or on user disconnect.
4. `CalendarProposal.tsx:63-66` — the remedy-table comment claiming
   `AUTH_EXPIRED` "reaches here only after refresh_and_adopt has already
   deleted the stored refresh token". False after this change; rewrite, and
   with it the justification for keeping `AUTH_EXPIRED` non-retryable (it
   stays non-retryable, but because retrying re-derives the same
   `invalid_grant`, not because the credential is already gone).

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
credential), and change 1 means the resulting `invalid_grant` gets a bounded
retry and a clean threshold deletion instead of an immediate delete. Reworking
the latch itself (e.g. a retry-on-next-launch flag) is out of scope; the issue's
fix direction does not include it.

### 2. Single-instance guard

- `src-tauri/Cargo.toml`: add `tauri-plugin-single-instance = "2"` to the
  dependencies.
- `src-tauri/src/lib.rs`: register it FIRST in the builder chain — the
  plugin's own documented requirement, and the natural place next to the
  existing "before the builder" comment at line 98. On Windows the plugin
  uses a named mutex, so the second process detects the first and exits
  before any state or window setup runs.

Callback body: focus the existing window, ignore argv and cwd. This app has
no deep-link or protocol-handler surface for the argv to feed:

```rust
.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}))
```

`get_webview_window` comes from `tauri::Manager`, already imported in
`lib.rs`. No capability/permission entries: the plugin exposes no frontend
API. This is the change that makes Decision 1's retry sound — with one
process, nothing else rotates the keychain credential between attempts.

### 3. `GRAPH_NO_KEYCHAIN` is transient, not disconnected

`GraphState::status` already does the right thing in Rust — it propagates a
keychain read failure as `Err(GRAPH_NO_KEYCHAIN)` and its doc comment
(`mod.rs:185-193`) explicitly forbids collapsing it into `connected: false`.
The collapse happens in the webview, in two places:

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
next successful read — mount, or any `graph-connection-changed` broadcast —
clears `statusError` and restores the true state, which is the retry path
this design relies on instead of adding a poller.

**The remedy table** (`CalendarProposal.tsx:90-105`). Move
`GRAPH_NO_KEYCHAIN` out of `CALENDAR_SETTINGS_REMEDY` and add it to
`RETRYABLE_CODES` (`CalendarProposal.tsx:49-53`). Retrying a keychain read
CAN fix a transient failure — the block already renders a "Try again" button
for retryable codes wired to `onRetry` (the status path re-runs `readStatus`
at `useCalendarProposal.ts:487-491`; the fetch path refetches), and both
paths' "Try again" genuinely re-attempt the read. TypeScript makes the move
mechanical: the table's key type is
`Exclude<GraphErrorCode, RetryableGraphErrorCode>`, so leaving the stale
entry behind fails to compile.

The `AUTH_EXPIRED` entry stays in the non-retryable table with the reworded
copy above. The fetch path can also surface `NO_KEYCHAIN` — from
`stored_refresh_token`'s keychain read when memory is empty on a fresh
launch (`mod.rs:499`) — and gets the same retryable treatment.

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
   (`mod.rs:606-623`) is untouched: it deletes immediately, unconditionally.
   Only the automatic invalid_grant path gains the threshold.
5. **Session-only (Linux, no keychain service).** The streak logic is
   identical; at threshold `forget_refresh_token_with`'s session-only branch
   clears memory and skips the delete, as today.
6. **Below-threshold state seen by the odoo page.** `graph_status` still
   reports `connected: true` (keychain untouched), so the Disconnect button
   and the session-only banner behave as before. The manual reconnect on the
   integrations page remains available at every point — the report's remedy
   still exists, it is just no longer the *only* thing standing between the
   user and a transient failure.
7. **Stale streak across a reconnect.** Impossible to misuse: a successful
   connect adopts a new token, which resets the streak before any failure
   against the new token can be counted. A streak can only reach the
   threshold with 3 confirmed failures against the CURRENT credential.
8. **Two instances of an older version.** Nothing this change can do; the
   guard takes effect once the updated build is running. Both instances of
   an OLD build keep the current (delete-on-first) behavior, which is the
   status quo, not a regression.

## Testing

Rust, in `src-tauri/src/graph/mod.rs`'s existing test module (the module
header's contract: decision logic as pure functions, unit-tested on every
target):

- **Threshold decision function.** Extract the comparison as a pure function
  and test it directly: below threshold returns keep, at and above returns
  forget. This follows the module's own stated contract ("All decision logic
  lives here as pure functions with no network dependency").
- **`GraphState::default()`** asserts the streak starts at 0.
- **Reset on success.** Extend an existing `adopt_and_persist_with` fake-persist
  test: bump the streak first, run a successful adopt-then-persist, assert the
  streak reads 0. Plus the disconnect-race variant: `adopt` returning `false`
  must NOT reset it.
- **`refresh_and_adopt_with` seam.** Following the file's established
  injection pattern (`adopt_and_persist_with` injects `persist`,
  `forget_refresh_token_with` injects `delete` — Ruling 20's reasoning:
  "did delete actually get invoked" is only observable to a fake in the
  dispatch position), the refresh call and the forget call are injected and
  `refresh_and_adopt` becomes the real wrapper. `refresh` is
  `impl FnOnce(String) -> Fut, Fut: Future<Output = Result<auth::Tokens,
  String>>` (a test closure returns `std::future::ready(...)`; no async
  closures needed). Tests, one per behavior the change adds:
  - two fake `invalid_grant` responses: forget spy NOT called, memory and
    injected-keychain both retain the credential, result is `AUTH_EXPIRED`;
  - third consecutive: spy called exactly once, memory cleared, result
    `AUTH_EXPIRED`;
  - `invalid_grant` → success → `invalid_grant` ×2: spy not called (streak
    was reset by the success);
  - a `NETWORK` failure between `invalid_grant`s: spy not called, streak
    value unchanged by the transport error;
  - delete-spy returning `Err` at threshold propagates (the surfaced
    "dead AND stuck on disk" case).
  - the post-lock re-read shortcut (`mod.rs:455-459`) still short-circuits
    before the token endpoint when a concurrent winner adopted a different
    token — pin the existing behavior with a fake so the streak arm cannot
    regress it.

Vitest, matching the existing files under `src/tests/`:

- `useCalendarProposal.test.tsx` — update the `GRAPH_NO_KEYCHAIN`
  readStatus case (line ~140): `statusError` is set AND `connected` keeps its
  prior value. Add: after a recovery, the next `graph_status` success clears
  `statusError` and writes the true `connected`.
- `CalendarProposal.states.test.tsx` — `GRAPH_NO_KEYCHAIN` moves from the
  settings-pointer table (~line 174) to a retryable assertion: "Try again"
  renders, clicking it re-runs the read/fetch. `GRAPH_AUTH_EXPIRED` stays in
  the settings-pointer table but the doc comment above it (~lines 163-170)
  is rewritten — its "already deleted" premise is false now — and the copy
  assertion becomes the new text (a NOT-/was reset/ guard pins the removal).
- `graph-errors.test.ts` — unchanged; the code set does not change.
- `odoo-settings-page.test.tsx` — existing `GRAPH_NO_KEYCHAIN` cases
  (connect-path info copy, `graph_status` error surfacing) are unchanged
  behavior; assert they still pass unchanged.

**Manual gates.**

1. Single-instance: launch the built app twice. The second process exits, the
   first instance's `main` window is focused.
2. The fix's own success criterion: with a calendar connected, force two
   consecutive `invalid_grant`s (e.g. rotate the credential out from under
   the app via a script that re-redeems it) — the connection block stays
   visible with the sign-in-expired remedy, `graph_status` still reports
   connected, and the third failure deletes the credential. A single
   `invalid_grant` followed by a recovery (reconnect then retry) never
   deletes.