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
- A never-configured Google (config `absent`) stays silent everywhere.

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

- `GoogleTokens` gains `scope: Option<String>`, parsed from the token response.
- A pure `grants_calendar(scope: Option<&str>) -> bool` checks for `https://www.googleapis.com/auth/calendar.events.readonly` among the space-separated scopes. A response with no `scope` field counts as granted, because Google always sends one on the code exchange, and refusing on a missing field would break a working connect.
- `google_connect` returns `GOOGLE_CONSENT_REQUIRED` when the grant is missing, before adopting or persisting anything.
- `GOOGLE_COPY.GOOGLE_CONSENT_REQUIRED` gets reworded to name the box: "Google didn't grant calendar access. Connect again and tick the calendar permission."

### 2. The settings card proves the read (`GoogleCalendarCard`)

- When `google_status` says connected (on mount, and after a successful Connect), the card makes one read through `fetchCurrentGoogleMeetings()`.
- Status line:
  - while the read runs: "Connected · checking calendar…"
  - when it succeeds: "Connected · calendar readable"
  - when it fails: `GOOGLE_COPY[code]`, styled as the error
- Disconnect stays available whenever `status.connected`.
- The read is guarded by the existing mounted ref.

### 3. Warning card on a failed read at recording start (`useGoogleMeetingCapture` + store + `MeetingCard`)

- In `run()`, after the existing staleness checks:
  - When `result.kind === "error"`, call `showAmber({ variant: amberKindFor(code, configState), episode })`. `configState` comes from the fetch result itself: the error variant of `FetchGoogleMeetingsResult` gains `config: "complete" | "unreadable"`.
  - `episode` is a module-level counter. It only has to change per showing.
  - `absent` and `ok` (any pick) show nothing.
- `showAmber` drops its `|| active` refusal. That guard dates from the calendar-gated era, when amber meant "not recording". Now amber comes up during a recording and takes the card slot from the 6-second recording card. The existing snooze (`AMBER_SNOOZE_MS`) still applies. The store test "no amber while an auto recording is active" gets inverted.
- New copy in `MeetingCard.tsx`:
  - Headline: "Couldn't read Google Calendar".
  - `reconnect`: "Recording continues, but this meeting's Notion page won't list who was invited. Reconnect Google to fix it."
  - `settings`: "Recording continues, but Meetwings can't read your saved Google Calendar setup. Open settings to fix it."
  - `offline`: "Recording continues, but Meetwings couldn't reach Google Calendar, so this meeting's Notion page may not list who was invited."
  - Buttons stay as they are. Fixed card heights in `cardHeight` must still fit, so keep the bodies no longer than today's.
- **Reconnect re-reads this meeting.** When a capture-start read in the current conversation ended in an error, the hook arms a re-read. The next `google-connection-changed` event runs the read again with the original capture-start time, so a reconnect hours later can never pick a later meeting. That read saves the snapshot and the card event, and dismisses the amber on success. It never re-runs the Outlook read or the Notion tick. The arm is cleared by `newConversationStarted`, `conversationLoaded` and any read that does not error. Without the re-read, "Reconnect Google to fix it" would be false for the current meeting.

### 4. detection.log line (`useGoogleMeetingCapture`)

One `detectionLog` line per read, written after the staleness checks:

- `google read ok events=<n> pick=one|none|several`
- `google read error <CODE>`
- `google read absent`

A dropped (stale) read logs `google read stale`. Counts and codes only.

## Left to the builder

- The exact test layout (extend the existing `google-meeting-capture`, `google-calendar-card`, `meeting-cards.store` and `meeting-card` tests, plus Rust unit tests in `google/auth.rs` for the `scope` parse and `grants_calendar`).
- Where the episode counter lives.

## Verification

- Vitest, scoped to the touched test files (full-suite flakes are known).
- `npm run type-check`.
- `cargo test --lib google`.
- `cargo fmt --check`.
- `cargo clippy`.
