# Make Google Calendar failures visible (short design)

Date: 2026-11-26. Base: origin/main 0e1c3d2 (v1.7.2). Approved in conversation ("go").

## Why

A colleague on a Mac joined with a team setup code. They got a transcript, but no summary and no sign of the calendar, while settings said "Connected". Nothing in the app could say why:

- "Connected" (`google_status`) only means a refresh token is stored. `google_connect` never checks the granted scope, so an unticked calendar box connects fine and every read then 403s (`GOOGLE_CONSENT_REQUIRED`). A token Google later revoked also stays "Connected".
- `showAmber` has no callers since PR #109, so a failed read at recording start shows nothing.
- `useGoogleMeetingCapture` writes nothing to detection.log, and release builds have no console.

Google data feeds Notion, not Odoo: who was invited goes on the page, and the meeting key keeps teammates on one page. A silent read failure quietly loses both.

## Goals

1. "Connected" means the calendar can actually be read.
2. A failed Google read at recording start is shown, with a way to fix it.
3. Every capture-start Google read leaves one line in detection.log.

## Non-goals

- The overlay's Odoo attendee block (`useCalendarProposal` / `useCalendarAutoSelect`) stays Outlook-only. It exists only to log meetings to Odoo, and Google meetings are not logged to Odoo. (Dropped "gap 4".)
- No change to how recording starts, to Notion sending, or to the summary pipeline.

## Anti-goals

- Never put a calendar title, guest name or address in detection.log.
- "No meeting found" (zero or several events) stays silent. It is not an error.
- A never-configured Google (config `absent`) stays silent in the UI. Its `google read absent` detection.log line still writes.

## Approaches (picked in conversation)

Gap 1:
- (a) Check the granted scope at connect.
- (b) Do a test read on the settings card.
- **Picked: both.** (a) stops the bad connect. (b) catches a revoke or expiry later.

Gap 2:
- (a) Show the warning card for Meet calls only.
- (b) Show it for any recording.
- **Picked: (b).** Notion takes Google guests for every call.

Gap 3: there was one sensible way to do it.

## Design

### 1. Connect refuses a missing calendar grant (Rust)

- `GoogleTokens` gains `scope: Option<String>`, parsed from the token response. The body parse moves out of the async `post_token_to` into a pure `tokens_from_body(body, now_ms)` so it can be unit-tested without a network.
- A pure `grants_calendar(scope: Option<&str>) -> bool` checks for `https://www.googleapis.com/auth/calendar.events.readonly` among the space-separated scopes, as an exact token: a prefix or a substring of it does not count, and an empty string is not granted. A response with no `scope` field (`None`) counts as granted, because Google always sends one on the code exchange, and refusing on a missing field would break a working connect.
- `google_connect` returns `GOOGLE_CONSENT_REQUIRED` when the grant is missing, before adopting or persisting anything.
- `GOOGLE_COPY.GOOGLE_CONSENT_REQUIRED` gets reworded to name the box: "Google didn't grant calendar access. Connect again and tick the calendar permission."

### 2. The settings card proves the read (`GoogleCalendarCard`)

- When `google_status` says connected, the card makes one read through `fetchCurrentGoogleMeetings()`. That happens on mount, after a successful Connect, and in the existing `GOOGLE_CONNECTION_CHANGED_EVENT` listener. The listener matters because a Reconnect from the overlay's warning card happens in the other window.
- Status line:
  - while the read runs: "Connected · checking calendar…"
  - when it succeeds: "Connected · calendar readable"
  - when it fails: `GOOGLE_COPY[code]`, styled as the error
- Disconnect stays available whenever `status.connected`, including while a check runs or after one failed.
- Reads are ordered by a sequence ref. Every read start bumps it, and so does Disconnect, which also clears the read state. A result is applied only when its sequence is still current. Without this, a slow mount read can land after a Connect and overwrite "readable" with an old error. A read cut off by Disconnect can also come back `GOOGLE_NOT_CONNECTED` and leave an error under "Not connected". The existing mounted ref still guards unmount.

### 3. Warning card on a failed read at recording start (`useGoogleMeetingCapture` + store + `MeetingCard`)

- In `run()`, after the existing staleness checks:
  - When `result.kind === "error"`, call `showAmber({ variant: amberKindFor(code, configState), episode })`. `configState` comes from the fetch result itself: the error variant of `FetchGoogleMeetingsResult` gains `config: Exclude<GoogleConfigState["state"], "absent">`, which today means `"complete" | "unreadable"`.
  - `episode` comes from a module-level counter. While a warning is armed (see the re-read below), a later errored read reuses the armed episode instead of taking a new one. `showAmber` with the episode of the amber already showing keeps that card, with its error text and Reconnect `busy` state, and only updates `variant` in place when it differs. The card's key is the episode, so it does not remount, and an `offline` card can still become `reconnect` when a later read returns an auth code. Otherwise detection flaps, which re-run the read at every capture start, would remount `AmberCard` (its key includes the episode). That would wipe a failure message and re-enable a Reconnect button that is mid-connect.
  - `absent` and `ok` (any pick) show nothing.
  - **A saved config with no connection is shown, on purpose.** `GOOGLE_NOT_CONNECTED` with a `complete` config maps to the `reconnect` variant and shows the warning at each recording, snoozable for an hour. Examples are a team-joined colleague who never pressed Connect, or someone who pressed Disconnect, which keeps the Client ID and secret. The setup is half done, and Notion quietly loses the guests, so it is not silent like `absent`.
- `showAmber` drops its `|| active` refusal. That guard dates from the calendar-gated era, when amber meant "not recording". Now amber comes up during a recording and takes the card slot from the 6-second recording card. The existing snooze (`AMBER_SNOOZE_MS`) still applies, including while a recording is active. The store test "no amber while an auto recording is active" gets inverted. Existing store behavior that stays:
  - `autoRecordingStopped` clears only a `recording` card, so the amber outlives the recording.
  - `showStopNotice` yields to an amber.
  - `setCardEvent` still updates the active recording's event while the slot shows the amber.
- **How the amber leaves:**
  - "Got it" or "Not now".
  - A successful re-read (below).
  - Any later capture-start read in the same conversation that does not error.
  - The arm clearing on `newConversationStarted` or `conversationLoaded`.
  - A new non-quiet auto-recording start, which takes the slot for its recording card (existing `autoRecordingStarted` behavior). This one does not disarm: the re-read still applies.

  Each of the last three dismisses only an amber whose episode is the armed one, never an unrelated amber. `dismissAmber` gains an optional episode argument for this. Outside these, the amber stays up after the recording stops, because it is still actionable: a Reconnect still fixes that conversation's Notion guests.
- New copy in `MeetingCard.tsx`:
  - Headline: "Couldn't read Google Calendar".
  - `reconnect`: "Recording continues, but this meeting's Notion page won't list who was invited. Reconnect Google to fix it."
  - `settings`: "Recording continues, but Meetwings can't read your saved Google Calendar setup. Open settings to fix it."
  - `offline`: "Recording continues, but Meetwings couldn't reach Google Calendar, so this meeting's Notion page may not list who was invited."
  - Buttons stay as they are. Fixed card heights in `cardHeight` must still fit, so keep the bodies no longer than today's.
- **Reconnect re-reads this meeting.** Without the re-read, "Reconnect Google to fix it" would be false for the current meeting.
  - **Arming.** When a capture-start read in the current conversation ends in an error, the hook arms a re-read. The arm holds four things from the most recent errored capture start: its capture-start time `at`, its active recording, its conversation generation, and its amber episode.
  - **When it runs.** Every `google-connection-changed` event re-reads while the arm is set. That event also fires on a cancelled or failed connect and on Disconnect, because `connectGoogle` broadcasts in `finally`.
  - **Staleness.** The re-read takes a fresh read sequence after the listener's own bump, and goes through the same staleness checks as a capture read.
  - **Original context.** It uses the arm's `at`, so a reconnect hours later can never pick a later meeting. It uses the arm's recording for `setCardEvent`, so it never labels a newer recording with the earlier meeting.
  - **On error.** The re-read stays armed and never calls `showAmber`. The showing card and its error text stay untouched.
  - **On success.** Any non-error result saves the snapshot (when there is exactly one meeting), sets the card event, dismisses the armed episode's amber, and disarms.
  - **What it skips.** It never re-runs the Outlook read or the Notion tick.
  - **Disarming.** The arm is cleared by `newConversationStarted`, `conversationLoaded` and any read that does not error.

### 4. detection.log line (`useGoogleMeetingCapture`)

One `detectionLog` line per read, capture-start and re-read alike, written after the staleness checks. `<src>` is `capture` or `reconnect`.

- `google read ok events=<n> pick=one|none|several src=<src>`
- `google read error <CODE> src=<src>`
- `google read absent src=<src>`

A dropped (stale) read logs `google read stale src=<src>`. Counts and codes only.

## Left to the builder

- The exact test layout (extend the existing `google-meeting-capture`, `google-calendar-card`, `meeting-cards.store` and `meeting-card` tests, plus Rust unit tests in `google/auth.rs` for the `scope` parse and `grants_calendar`).
- Where the episode counter lives.

## Verification

Cases the tests must pin, beyond the builder's own:

- **Rust (`google/auth.rs`):**
  - `tokens_from_body` keeps the `scope`, and keeps `"scope": ""` as `Some("")`, unlike the empty-`refresh_token` filter next to it, so it is not granted. `{}` is `GOOGLE_BAD_RESPONSE`.
  - `grants_calendar`: `None` is granted, the scope among several is granted, an empty string is not, a prefix or substring of the scope is not, and the other scopes without the calendar one are not.
- **Card (`google-calendar-card` test):**
  - Mock `@/lib/calendar/fetch-google-meetings`, not `invoke`.
  - Each of the 3 status lines.
  - No read when not connected.
  - A read after Connect.
  - A read from the connection-changed listener.
  - A fail then a success.
  - An older read never overwrites a newer one.
  - A read cut off by Disconnect leaves "Not connected" clean.
  - An unmount before `google_status` resolves makes no calendar read. React 19 logs nothing for a set after unmount, so the `mountedRef` guard on the read result is checked in code review.
  - Disconnect stays enabled while checking and after a failure.
- **Fetch (`fetch-google-meetings` test):**
  - An unreadable config gives `config: "unreadable"`.
  - A failed invoke gives `config: "complete"`.
  - Hook mocks must now include `config`.
- **Store (`meeting-cards.store` test):**
  - The amber shows over an active recording card.
  - The snooze still holds with a recording active.
  - The same-episode `showAmber` keeps the card's error text and updates only a changed `variant`.
  - The amber survives `autoRecordingStopped`.
  - A stop notice yields to it.
  - `dismissAmber(episode)` leaves another episode's amber.
- **Hook (`google-meeting-capture` test):**
  - The amber variant for each code and config pair: `unreadable` gives `settings`, network gives `offline`, `NOT_CONNECTED` with `complete` gives `reconnect`.
  - `absent` and `ok` show none.
  - A later non-error read dismisses.
  - A new conversation, and a loaded conversation, each disarm and dismiss.
  - Re-read, driven through the fake `listen` handler map:
    - It runs only when armed.
    - `fetchCurrentGoogleMeetings` gets the original `at`.
    - It never calls `fetchCurrentMeetings` or the tick.
    - It saves the snapshot and the card event with the original recording.
    - On success it dismisses.
    - On error it stays armed and never re-shows.
- **Log:**
  - Assert through the globally mocked `detectionLog` from `src/tests/setup.ts`, not a re-mock.
  - Exactly one line per read, with the exact text for each outcome and `src`.
  - No line contains the event title, a guest's name or an address.
- **Manual, dev build:** a human runs these before release. `google_connect` takes an `AppHandle` and does a live OAuth round trip, so unit tests reach `grants_calendar` and not the call order.
  1. Start disconnected, then Connect with the calendar box unticked. Expect the new copy in the status line and no Disconnect button.
  2. Record with a revoked token. Expect the amber and a `google read error` line.
  3. Reconnect. Expect the amber to leave and the snapshot to be saved.

Gates:

- Vitest, scoped to the touched test files (full-suite flakes are known).
- `npm run type-check`.
- `cargo test --lib google`.
- `cargo fmt --check`.
- `cargo clippy`.
