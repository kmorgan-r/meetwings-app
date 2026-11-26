# Make Google Calendar Failures Visible Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a broken Google Calendar connection visible. "Connected" must mean the calendar can actually be read, a failed read at recording start shows a warning card with a fix, and every capture-start read leaves a line in detection.log.

**Architecture:** Changes per layer:
- **Rust:** `google_connect` refuses a token that lacks the calendar scope.
- **Settings card:** after a successful status read, the card proves one read.
- **Capture hook:** `useGoogleMeetingCapture` already reads Google once per capture start. It now shows the dormant amber card on an error, re-reads after a reconnect, and logs each read.

**Tech Stack:** Tauri 2 (Rust), React 19 + TypeScript, Vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-11-26-google-calendar-failures-visible-design.md`

## Global Constraints

- **detection.log content:** counts and codes only. No calendar title, guest name or address, ever.
- **Silent outcomes:** "No meeting found" (`ok` with zero or several events) and a never-configured Google (`absent`) show nothing.
- **Consent copy:** `GOOGLE_CONSENT_REQUIRED` copy is exactly: `Google didn't grant calendar access. Connect again and tick the calendar permission.`
- **Amber headline:** exactly `Couldn't read Google Calendar`.
- **Amber bodies:**
  - `reconnect`: `Recording continues, but this meeting's Notion page won't list who was invited. Reconnect Google to fix it.`
  - `settings`: `Recording continues, but Meetwings can't read your saved Google Calendar setup. Open settings to fix it.`
  - `offline`: `Recording continues, but Meetwings couldn't reach Google Calendar, so this meeting's Notion page may not list who was invited.`
- **Settings status lines:** exactly `Connected · checking calendar…`, `Connected · calendar readable` and `Not connected`. A failed read shows `GOOGLE_COPY[code]`.
- **Calendar scope:** `https://www.googleapis.com/auth/calendar.events.readonly`.
- **Out of scope:** the Odoo attendee block (`useCalendarProposal`, `useCalendarAutoSelect`), Notion sending and the summary pipeline.
- **Running tests:** vitest scoped to the named files (full-suite runs flake). Rust: `CARGO_TARGET_DIR=C:/Users/kmorg/meetwings-app/src-tauri/target cargo test --manifest-path src-tauri/Cargo.toml --lib google`.
- **Before the final commit:** run `cargo fmt --manifest-path src-tauri/Cargo.toml --check`, `cargo clippy` and `npm run type-check`.
- **Worktree commands:** keep every git command plain, one per call, with no pipes or `&&` chains.

## Review Focus

1. **A reconnect hours after the call** must not re-label the conversation with a later meeting. The re-read uses the original capture-start time, never "now". (Task 4 test: "a reconnect re-read uses the capture-start time".)
2. **A cancelled or failed reconnect** keeps the amber card and the error text the card itself set. It must not flash a fresh card. (Task 4 test: "a re-read that fails again keeps the warning without re-showing it".)
3. **Overlapping card reads:** Connect pressed while the mount read is still in flight must not be overwritten by the older result. (Task 2 test: "an older calendar read never overwrites a newer one".)
4. **Card unmounted mid-read:** a read resolving after unmount must not set state. No test can pin this, because React 19 does not warn. The existing `mountedRef` guard must wrap every `setCalendar`, and code review checks it.
5. **"Not now" snooze:** a second recording's failed read within the hour stays hidden. This is already pinned by `meeting-cards.store.test.ts` "amber shows, snoozes for an hour…" and must keep passing after Task 3.

---

### Task 1: Connect refuses a sign-in without calendar access

**Files:**
- Modify: `src-tauri/src/google/auth.rs` (add the `scope` field, a pure body parser and `grants_calendar`)
- Modify: `src-tauri/src/google/mod.rs` (`google_connect` gains the check; the test helper `tokens()` gets `scope: None`)
- Modify: `src/lib/calendar/google-errors.ts` (consent copy)
- Test: `src-tauri/src/google/auth.rs` (`mod tests`), `src/tests/google-errors.test.ts`

**Interfaces:**
- Produces:
  - `pub const CALENDAR_SCOPE: &str`
  - `pub fn grants_calendar(scope: Option<&str>) -> bool`
  - `pub(crate) fn tokens_from_body(body: &str, now_ms: i64) -> Result<GoogleTokens, String>`
  - `GoogleTokens.scope: Option<String>`

- [ ] **Step 1: Write the failing Rust tests** in `auth.rs` `mod tests`:

```rust
#[test]
fn the_requested_scopes_include_the_calendar_scope() {
    assert!(GOOGLE_SCOPES.split(' ').any(|s| s == CALENDAR_SCOPE));
}

#[test]
fn grants_calendar_needs_the_exact_scope_token() {
    assert!(grants_calendar(Some("openid https://www.googleapis.com/auth/calendar.events.readonly email")));
    assert!(!grants_calendar(Some("openid email profile")));
    assert!(!grants_calendar(Some("https://www.googleapis.com/auth/calendar.events.readonly.x")));
    assert!(!grants_calendar(Some("https://www.googleapis.com/auth/calendar.events")));
    assert!(!grants_calendar(Some("")));
    // Google always sends `scope` on the code exchange; a missing field is not a refusal.
    assert!(grants_calendar(None));
}

#[test]
fn the_token_body_keeps_its_scope() {
    let t = tokens_from_body(r#"{"access_token":"a","expires_in":3600,"scope":"openid email"}"#, 0).unwrap();
    assert_eq!(t.scope.as_deref(), Some("openid email"));
    let t = tokens_from_body(r#"{"access_token":"a"}"#, 0).unwrap();
    assert_eq!(t.scope, None);
    // Unlike refresh_token, an empty scope is kept, so grants_calendar refuses it.
    let t = tokens_from_body(r#"{"access_token":"a","scope":""}"#, 0).unwrap();
    assert_eq!(t.scope.as_deref(), Some(""));
    assert_eq!(tokens_from_body("{}", 0).err().as_deref(), Some("GOOGLE_BAD_RESPONSE"));
}
```

- [ ] **Step 2: Run it and check it fails.** Run: `CARGO_TARGET_DIR=C:/Users/kmorg/meetwings-app/src-tauri/target cargo test --manifest-path src-tauri/Cargo.toml --lib google::auth`. Expected: compile errors (`CALENDAR_SCOPE`, `grants_calendar`, `tokens_from_body` and `scope` are not found).

- [ ] **Step 3: Implement in `auth.rs`.**
  - `CALENDAR_SCOPE` holds the scope from Global Constraints. Leave the `GOOGLE_SCOPES` literal unchanged.
  - `GoogleTokens` gains `pub scope: Option<String>`, documented as Google's space-separated granted scopes.
  - Move the JSON parsing in `post_token_to` (everything after the `status != 200` return) into `tokens_from_body`. `post_token_to` then calls it. `scope` is the `scope` string when it is present; an empty string stays `Some("")`.
  - `grants_calendar`: `None` gives true; otherwise it is true only when some space-separated token equals `CALENDAR_SCOPE`.

- [ ] **Step 4: Wire `google_connect` in `mod.rs`.** Right after the `tokens.refresh_token.is_none()` check and before `session_only` is set, return `Err(CONSENT_REQUIRED.to_string())` when `!auth::grants_calendar(tokens.scope.as_deref())`. Nothing is adopted or persisted on that path. Add `scope: None` to the `tokens()` helper in `mod.rs` tests.

- [ ] **Step 5: Update the copy test, then the copy.** In `src/tests/google-errors.test.ts`, change the `GOOGLE_CONSENT_REQUIRED` entry to the Global Constraints string. Set the same string in `GOOGLE_COPY` in `google-errors.ts`.

- [ ] **Step 6: Run the tests and check they pass.**
  - `CARGO_TARGET_DIR=C:/Users/kmorg/meetwings-app/src-tauri/target cargo test --manifest-path src-tauri/Cargo.toml --lib google`: PASS.
  - `npx vitest run src/tests/google-errors.test.ts src/tests/meeting-detect.test.ts`: PASS.
  - `cargo fmt --manifest-path src-tauri/Cargo.toml` first (the Step 1 test lines are wider than rustfmt allows), then `cargo fmt --manifest-path src-tauri/Cargo.toml --check`: no output.

- [ ] **Step 7: Commit.**

```bash
git add src-tauri/src/google/auth.rs src-tauri/src/google/mod.rs src/lib/calendar/google-errors.ts src/tests/google-errors.test.ts
git commit -m "fix(google): refuse a connect that did not grant calendar access"
```

---

### Task 2: The settings card proves the calendar read

**Files:**
- Modify: `src/pages/odoo/components/GoogleCalendarCard.tsx`
- Test: `src/tests/google-calendar-card.test.tsx`

**Interfaces:**
- Consumes: `fetchCurrentGoogleMeetings(now?: number): Promise<FetchGoogleMeetingsResult>` from `@/lib/calendar/fetch-google-meetings` (existing). Only `kind` and `code` are read here.

- [ ] **Step 1: Mock the fetch in the test file.** Add `fetchGoogle: vi.fn()` to the hoisted `h`. Add `vi.mock("@/lib/calendar/fetch-google-meetings", () => ({ fetchCurrentGoogleMeetings: h.fetchGoogle }))`. In `beforeEach`, `h.fetchGoogle.mockResolvedValue({ kind: "ok", events: [], ownAddress: null })`. Make the `listen` mock record handlers by name, the same way `google-meeting-capture.test.tsx` does, so a test can fire `google-connection-changed`.

- [ ] **Step 2: Write the failing tests.**
  - `"a connected card reads the calendar once and says it is readable"`: COMPLETE plus a connected status. Expect `h.fetchGoogle` called once and the text `Connected · calendar readable`.
  - `"shows the checking line while the read runs"`: a deferred fetch. Expect `Connected · checking calendar…`, then resolve and expect `Connected · calendar readable`.
  - `"a failed read shows that error's copy and keeps Disconnect"`: the fetch resolves `{ kind: "error", code: "GOOGLE_CONSENT_REQUIRED", config: "complete" }`. Expect `GOOGLE_COPY.GOOGLE_CONSENT_REQUIRED` and the Disconnect button.
  - `"not connected makes no calendar read"`: COMPLETE plus `connected: false`. Expect `h.fetchGoogle` not called.
  - `"a successful Connect verifies the read"`: the existing connect flow. Expect `h.fetchGoogle` called after `google_connect` (invocation order), then `Connected · calendar readable`.
  - `"Disconnect clears the calendar line"`: connected and readable, then click Disconnect. Expect `Not connected` and no `calendar readable` text.
  - `"a connection change from another window re-verifies"`: connected; fire the recorded `google-connection-changed` handler with status connected. Expect `h.fetchGoogle` called twice.
  - `"an older calendar read never overwrites a newer one"`: the mount read is deferred and still pending. Connect, whose read resolves ok. Then resolve the mount read with an error. Expect the line still reads `Connected · calendar readable`.
  - No unmount test. React 19 logs nothing for a state update after unmount, so a `console.error` spy can never fail. The `mountedRef` guard is checked in code review.
  - `"a read cut off by Disconnect leaves Not connected clean"`: deferred read, click Disconnect, then resolve it with `{ kind: "error", code: "GOOGLE_NOT_CONNECTED", config: "complete" }`. Expect `Not connected` and no `GOOGLE_COPY.GOOGLE_NOT_CONNECTED` text. This pins only the visible result: the not-connected line renders first, so the Disconnect sequence bump is defence in depth and no test observes it.
  - `"a failed read then a successful one shows readable"`: the first fetch errors, then fire the connection-changed handler with the next fetch ok. Expect `Connected · calendar readable` and no error copy.
  - `"Disconnect stays enabled while checking"`: deferred read. Expect the Disconnect button present and enabled.

- [ ] **Step 3: Update the existing assertions.** The tests that assert `"Connected"` for a connected card ("Connect saves…", "a failed emit…") now assert `Connected · calendar readable`. "an unreadable config…" is different: a connected card with an unreadable config really reads `GOOGLE_AUTH_REJECTED`. Have its fetch mock return `{ kind: "error", code: "GOOGLE_AUTH_REJECTED", config: "unreadable" }` and assert `GOOGLE_COPY.GOOGLE_AUTH_REJECTED`. Run `npx vitest run src/tests/google-calendar-card.test.tsx` and check the new tests FAIL.

- [ ] **Step 4: Implement in `GoogleCalendarCard.tsx`.**
  - New state `calendar: "checking" | "ok" | GoogleErrorCode | null`.
  - `verify()` is guarded by a sequence ref and `mountedRef`. It sets `"checking"` and awaits `fetchCurrentGoogleMeetings()`. Then: `ok` sets `"ok"`, `error` sets its `code`, and `absent` sets `null`.
  - Every place that sets a status (mount `reload`, `handleConnect` success, the `GOOGLE_CONNECTION_CHANGED_EVENT` listener) calls `verify()` when `connected` is true, and sets `calendar` to `null` otherwise.
  - `handleDisconnect` bumps the sequence ref and sets `null`, so a read still running from before is dropped.
  - Rendering when there is no `error`:
    - not connected: `Not connected`
    - `"checking"`: the checking line
    - `"ok"`: the readable line
    - an error code: `GOOGLE_COPY[code]` with the `text-destructive` class
    - `null` while connected: `Connected`

- [ ] **Step 5: Run and check it passes.** `npx vitest run src/tests/google-calendar-card.test.tsx`: PASS.

- [ ] **Step 6: Commit.**

```bash
git add src/pages/odoo/components/GoogleCalendarCard.tsx src/tests/google-calendar-card.test.tsx
git commit -m "feat(google): settings card proves the calendar can be read"
```

---

### Task 3: The amber card is allowed during a recording, with new copy

**Files:**
- Modify: `src/lib/meeting-cards.store.ts` (`showAmber`, `dismissAmber`)
- Modify: `src/pages/app/components/MeetingCard.tsx` (`AMBER_HEADLINE`, `AMBER_BODY`)
- Test: `src/tests/meeting-cards.store.test.ts`, `src/tests/meeting-card.test.tsx`

**Interfaces:**
- Produces:
  - `showAmber({ variant, episode }, now?)` now shows during an active auto-recording; only the snooze refuses it. When the slot already shows an amber with the same `episode`, it keeps that card's `error`. With the same variant it is a full no-op (same object, no notify). With a different variant it swaps in `{ ...card, variant }` and notifies. The React key is the episode, so `AmberCard` does not remount either way. The signature is unchanged.
  - `dismissAmber(episode?: number): void`. With no argument it behaves as today. With an argument it clears the slot only when it shows an amber whose `episode` equals it. Existing callers (`snoozeAmber`, the card's buttons) keep calling it with no argument.

- [ ] **Step 1: Store tests.** In `meeting-cards.store.test.ts`:
  - Replace `"no amber while an auto recording is active"` with `"amber shows over an active auto recording, and the recording's stop leaves it"`. Steps: `start()`, then `showAmber({ variant: "offline", episode: 1 })`, and expect `kind` `"amber"`. Then stop that recording through the test's existing stop path and expect `kind` still `"amber"`.
  - `"the snooze holds while a recording is active"`: `start()`, `snoozeAmber()`, then `showAmber(...)`. Expect the card not amber.
  - `"showing the same episode again keeps the card and its error"`: `showAmber({ variant: "reconnect", episode: 4 })`, `setAmberError("x")`, keep the card object, then `showAmber({ variant: "reconnect", episode: 4 })`. Expect `getMeetingCard()` to be the same object (`toBe`) with `error: "x"`.
  - `"the same episode with a new variant updates the variant and keeps the error"`: `showAmber({ variant: "offline", episode: 4 })`, `setAmberError("x")`, then `showAmber({ variant: "reconnect", episode: 4 })`. Expect `{ kind: "amber", variant: "reconnect", episode: 4, error: "x" }`.
  - `"a new episode replaces the amber"`: episode 4 with an error, then episode 5. Expect `episode: 5` and `error: null`.
  - `"dismissAmber with an episode leaves another episode's amber"`: show episode 2. `dismissAmber(1)` keeps it; `dismissAmber(2)` clears it.
  - `"a stop notice yields to the amber"`: show an amber, then `showStopNotice("call-ended")`. Expect the card still amber.

- [ ] **Step 2: Update the card tests to the new copy.** In `meeting-card.test.tsx`:
  - Every `"If this is a Meet call, it isn't being recorded"` becomes `"Couldn't read Google Calendar"`.
  - `/Google Calendar is disconnected/` becomes `/won't list who was invited\. Reconnect Google/`.
  - `/can't reach Google Calendar right now/` becomes `/couldn't reach Google Calendar/`.
  - Add `"amber settings body names the saved setup"`, which expects `/can't read your saved Google Calendar setup/`.
  - Fix the stale comment at the `autoRecordingStopped()` line (~375).
  - Run `npx vitest run src/tests/meeting-cards.store.test.ts src/tests/meeting-card.test.tsx` and check it FAILS.

- [ ] **Step 3: Implement.**
  - `showAmber`: drop `|| active` from the guard, and comment that amber now reports a failed calendar read during a recording. When `card?.kind === "amber" && card.episode === a.episode`: if the variant also matches, return. Otherwise set `card = { ...card, variant: a.variant }`, `notify()` and return, leaving the timer untouched.
  - `dismissAmber(episode?)`: clear only when the card is amber and `episode` is `undefined` or equals `card.episode`.
  - `MeetingCard.tsx`: set the headline and the three bodies from Global Constraints. Leave buttons and `cardHeight` unchanged (each new body is no longer than the old one).

- [ ] **Step 4: Run and check it passes.** `npx vitest run src/tests/meeting-cards.store.test.ts src/tests/meeting-card.test.tsx src/tests/meeting-card-window.test.tsx`: PASS.

- [ ] **Step 5: Commit.**

```bash
git add src/lib/meeting-cards.store.ts src/pages/app/components/MeetingCard.tsx src/tests/meeting-cards.store.test.ts src/tests/meeting-card.test.tsx
git commit -m "feat(cards): amber warns about an unreadable Google Calendar during a recording"
```

---

### Task 4: A failed capture-start read shows the warning; a reconnect re-reads

**Files:**
- Modify: `src/lib/calendar/fetch-google-meetings.ts` (the error result carries the config state)
- Modify: `src/hooks/useGoogleMeetingCapture.ts`
- Test: `src/tests/fetch-google-meetings.test.ts`, `src/tests/google-meeting-capture.test.tsx`

**Interfaces:**
- Consumes:
  - `showAmber` (Task 3: same-episode is a no-op)
  - `dismissAmber(episode?: number)` (Task 3) and `getMeetingCard()` from `@/lib/meeting-cards.store`
  - `amberKindFor(code: GoogleErrorCode, configState: GoogleConfigState["state"]): AmberKind` from `@/lib/meeting-detect`
- Produces:
  - `FetchGoogleMeetingsResult` error variant becomes `{ kind: "error"; code: GoogleErrorCode; config: Exclude<GoogleConfigState["state"], "absent"> }` (today `"complete" | "unreadable"`; import the type from `@/lib/storage/google-config.storage`).
  - Inside the hook, the read becomes `read(src: "capture" | "reconnect", at: number): Promise<void>`. Task 5 logs from inside it.

- [ ] **Step 1: Fetch tests.** In `fetch-google-meetings.test.ts`:
  - The unreadable-config case expects `{ kind: "error", code: "GOOGLE_AUTH_REJECTED", config: "unreadable" }`.
  - The invoke-failure case expects `config: "complete"` alongside its code.

- [ ] **Step 2: Hook tests.** In `google-meeting-capture.test.tsx`, add a `describe("useGoogleMeetingCapture warning and re-read")`. Error results are built as `{ kind: "error", code, config }`.
  - `"a Google error at capture start shows the reconnect warning"`: `GOOGLE_AUTH_EXPIRED` with `complete`. Expect `getMeetingCard()` to match `{ kind: "amber", variant: "reconnect" }`.
  - `"an unreadable config shows the settings warning"`: `GOOGLE_AUTH_REJECTED` with `unreadable` gives variant `"settings"`.
  - `"a network error shows the offline warning"`: `GOOGLE_NETWORK` gives `"offline"`.
  - `"no meeting, several and absent show no warning"`: `none`, `several` and `{ kind: "absent" }` each leave the card not amber.
  - `"a stale error shows no warning"`: deferred error, then `newConversationStarted`, then resolve. Expect no amber.
  - `"after an error, a connection change re-reads, stores the snapshot and clears the warning"`: error, then amber. Next fetch is `one("A")`. Fire the `GOOGLE_CONNECTION_CHANGED_EVENT` handlers, settle. Expect `savedKeys()` to contain A's snapshot key and the card not amber.
  - `"a reconnect re-read uses the capture-start time"`: fake timers. Capture at T0 errors. Advance 3 h. Fire connection change. Expect the second `fetchCurrentGoogleMeetings` call's argument to equal T0.
  - `"a re-read that fails again keeps the warning without re-showing it"`: error, then amber, then `setAmberError("x")`. Fire connection change with the next fetch erroring. Expect the card still amber with `error: "x"` and the same `episode`.
  - `"a reconnect re-read never ticks Notion"`: `tickEnabled` true, `fetchCurrentMeetings` mocked. A capture error, then settle; the capture read has run its own Outlook read and tick or untick. Clear the `autoTick`, `autoUntick` and `fetchCurrentMeetings` mocks. Fire a connection change whose fetch resolves `one("A")` and settle. Expect all three called zero times.
  - `"a re-read labels the original recording when it is still active"`: `startRecording(true)`, then a capture error. Fire a connection change whose fetch resolves `one("A")` and settle. Expect `getActiveAutoRecording()?.event?.title` to be `"Meeting A"`.
  - `"no re-read after a capture read that did not error"`: `one("A")`, then connection change. Expect the fetch called once.
  - `"newConversationStarted disarms the re-read"`: error, then `newConversationStarted`, then connection change. Expect the fetch called once.
  - `"a saved config that was never connected shows the reconnect warning"`: `GOOGLE_NOT_CONNECTED` with `complete` gives variant `"reconnect"`.
  - `"a later capture read that does not error clears the warning"`: a capture error, then amber. A second `meetingCaptureStarted` whose fetch is `none`. Expect the card not amber.
  - `"a new or loaded conversation clears the warning"`: a capture error, then amber, then `newConversationStarted`. Expect the card not amber. Repeat with `conversationLoaded`.
  - `"a second capture error keeps the same warning card"`: a capture error, then amber, then `setAmberError("x")`. A second `meetingCaptureStarted` that also errors. Expect the same `episode` and `error: "x"`.
  - `"the re-read labels the original recording"`: `startRecording(true)` (id 1), then a capture error. Start a second auto recording (id 2) in the same conversation. Fire a connection change with the next fetch `one("A")`. Expect `getActiveAutoRecording()` (id 2) to have `event: null`.
  - `"a re-read leaves an unrelated amber alone"`: a capture error (the hook's episode). Then `showAmber({ variant: "offline", episode: 999 })` from the test. Fire a connection change with the next fetch ok. Expect the card still amber with `episode: 999`.
  - Run both files and check the new tests FAIL.

- [ ] **Step 3: Implement the fetch change.** Unreadable config returns `config: "unreadable"`. The `catch` returns `config: "complete"`.

- [ ] **Step 4: Implement the hook.**
  - Hoist the existing `run` body into a ref-held `read(src, at)`, so both the capture listener and the connection-changed listener can call it. The capture listener calls `read("capture", Date.now())`. `at` replaces the internal `Date.now()` for both the fetch argument and `pickCurrentMeeting`.
  - Add an `arm` ref: `{ at: number; rec: ActiveAutoRecording | null; gen: number; episode: number } | null`. Also add a module-level `let amberEpisode = 0`.
  - A capture read takes `rec = getActiveAutoRecording()` and `gen = convGen.current` at its start, as today. A reconnect read takes `rec` and `gen` from the arm instead, and still takes a fresh `readSeq` after the listener's bump. The existing `seq`/`gen` staleness check then applies to both.
  - After the existing staleness check:
    - **Error from a capture read:** `const episode = arm.current?.episode ?? ++amberEpisode`. Call `showAmber({ variant: amberKindFor(result.code, result.config), episode })`, then set `arm.current = { at, rec, gen, episode }`.
    - **Error from a reconnect read:** leave the card and the arm as they are. Never call `showAmber`.
    - **Any non-error result** (`ok` with any pick, or `absent`): if armed, `dismissAmber(arm.current.episode)`. Then set `arm.current = null`.
  - The Outlook read and the tick run only when `src === "capture"`.
  - `onNewConversation`: if armed, `dismissAmber(arm.current.episode)`. Then set `arm.current = null`.
  - The `GOOGLE_CONNECTION_CHANGED_EVENT` listener keeps its bump and pending clear. Then, if armed, it calls `read("reconnect", arm.current.at)` (with `.catch(() => {})`).

- [ ] **Step 5: Run and check it passes.** `npx vitest run src/tests/fetch-google-meetings.test.ts src/tests/google-meeting-capture.test.tsx src/tests/meet-gate.test.ts`: PASS. Then `npm run type-check`: no errors (the exported `FetchGoogleMeetingsResult` changed).

- [ ] **Step 6: Commit.**

```bash
git add src/lib/calendar/fetch-google-meetings.ts src/hooks/useGoogleMeetingCapture.ts src/tests/fetch-google-meetings.test.ts src/tests/google-meeting-capture.test.tsx
git commit -m "feat(google): warn when the capture-start calendar read fails, re-read after reconnect"
```

---

### Task 5: Every Google read leaves one detection.log line

**Files:**
- Modify: `src/hooks/useGoogleMeetingCapture.ts`
- Test: `src/tests/google-meeting-capture.test.tsx`

**Interfaces:**
- Consumes:
  - `read(src, at)` (Task 4)
  - `detectionLog(line: string): void` from `@/lib/detection-log` (already mocked globally in `src/tests/setup.ts`)

- [ ] **Step 1: Write the failing tests.** Import `detectionLog` from `@/lib/detection-log`.
  - `"logs ok reads with the event count and the pick"`: `one("A")` gives `google read ok events=1 pick=one src=capture`. `several` gives `google read ok events=2 pick=several src=capture`. `none` gives `google read ok events=0 pick=none src=capture`.
  - `"logs errors by code and absent as absent"`: an error gives `google read error GOOGLE_CONSENT_REQUIRED src=capture`. Absent gives `google read absent src=capture`.
  - `"logs a dropped read as stale"`: deferred, then `newConversationStarted`, then resolve gives `google read stale src=capture`.
  - `"logs a reconnect re-read with its source"`: an error, then a connection change, then `one("A")`. The last call is `google read ok events=1 pick=one src=reconnect`.
  - `"a log line never carries calendar text"`: after `one("A")`, no logged string contains `Meeting A`, `A@guest.example` or `me@example.org`.
  - `"each read logs exactly one line"`: filter `detectionLog.mock.calls` to lines starting with `google read`. After one ok capture read, expect length 1. Clear the mock, then after one stale read (the deferred `newConversationStarted` case), expect length 1 again.
  - Run and check they FAIL.

- [ ] **Step 2: Implement.** In `read`:
  - Right after `await g`: if the staleness check fails, log `google read stale src=<src>` and return.
  - Otherwise log exactly one line:
    - `google read ok events=<n> pick=<one|none|several> src=<src>`
    - `google read error <CODE> src=<src>`
    - `google read absent src=<src>`

- [ ] **Step 3: Run and check it passes.** `npx vitest run src/tests/google-meeting-capture.test.tsx`: PASS.

- [ ] **Step 4: Final gates.**
  - `npm run type-check`: no errors.
  - `cargo fmt --manifest-path src-tauri/Cargo.toml --check`: no output.
  - `CARGO_TARGET_DIR=C:/Users/kmorg/meetwings-app/src-tauri/target cargo clippy --manifest-path src-tauri/Cargo.toml`: no new warnings in `google/`.
  - Run every test file named in Tasks 1–5 together: PASS.

- [ ] **Step 5: Commit.**

```bash
git add src/hooks/useGoogleMeetingCapture.ts src/tests/google-meeting-capture.test.tsx
git commit -m "feat(google): log each capture-start calendar read to detection.log"
```
