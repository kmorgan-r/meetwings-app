# Google Meet detection on Windows and Mac

Status: design, approved (2026-11-13)
Owner: Kevin Morgan-Rothschild
Issue: #95
Builds on: `2026-11-12-google-calendar-attendees-design.md` (PR #96, merged to `main` as `d5f1cd5`).
It needs the Google sign-in and the `google_current_meetings` command from that work.

Code references are against `main` at `d5f1cd5` (same tree as `6e21866`).

## 1. Why

IC teammates send meeting notes to Notion. Many are on Mac and run Google Meet in Chrome. Today they
start recording by hand, and a forgotten start loses the meeting: the Notion meeting-notes design lists
"A meeting's transcript is lost because the app didn't record it" as a failure case.

Teams calls on Windows already start and stop recording on their own (`src-tauri/src/meeting_detect/`,
`useMeetingDetection`, `useMeetingAutoRecord`). This design gives Google Meet in Chrome the same thing, on
Windows and on Mac.

Users:
- **IC teammates.** Mac, Chrome, Google Meet, Google Calendar connected (slice 1).
- **Kevin.** Windows. Teams for Odoo meetings, Meet for IC meetings, both calendars connected. The
  Windows half is built and tested on Kevin's machine.

## 2. Goals, non-goals, anti-goals

Goals:
- A Google Meet call in Chrome that is on the user's Google Calendar starts recording without the user
  doing anything, and stops when the user leaves the call. Windows and Mac.
- Teams detection keeps working exactly as it does today.

Non-goals (decided with Kevin):
- Meet calls that are not on the calendar (a link pasted in chat). "Most times it will be in the
  calendar." The user starts those by hand.
- Browsers other than Chrome (Edge, Safari, Arc). Chrome first; others can follow.
- Zoom or any other web call.
- Teams on Mac. Cheap once the Mac detector exists, but not asked for. Not in this work.

Anti-goals (failures even if the feature "works"):
- **Recording that stops mid-call.** Muting, a brief mic drop when joining, or the calendar event's end
  time passing must not stop a recording while the user is still in the call.
- **Chrome mic use that is not a Meet call becomes a "meeting".** Voice typing, a WhatsApp Web voice note
  or any other Chrome mic use outside a Meet calendar event must produce no recording and no meeting-log
  row. While the calendar can't be checked (including after the user pressed Disconnect), the amber card
  in 6.3 may show for such use. It is limited there by a 1-hour snooze and worded so it doesn't claim a
  Meet call. *(My call: the silent-miss anti-goal and Kevin's "notice with a Reconnect button" win over
  "no pop-up" only while the calendar can't be checked, and only in that limited form.)*
- **A silent miss.** If the app cannot check the calendar, the user is told, not left to find out later
  that nothing was recorded.
- **A Teams regression.** Chrome holding the mic must never hide or delay a Teams call.

## 3. How it works today

**The detector** (`src-tauri/src/meeting_detect/mod.rs`, Windows only). Every 2s (`POLL_INTERVAL`) the
poll loop lists every capture-endpoint audio session (`win32.rs`, WASAPI) and `classify`
(`mod.rs:56`) returns `Active(image_name)` for the first active session whose image name is on the watch
list. Matching is exact modulo case (test R9). A pure state machine (`step`, `mod.rs:126`) turns polls
into events: 2 active polls (`START_DEBOUNCE`) emit `meeting-detected { process }`, 3 inactive polls
(`END_DEBOUNCE`, about 6s) emit `meeting-ended { process }`. `MachineState` also holds the watcher's
health counters (failures, unknowns, degraded; `mod.rs:113-123`). The watch list comes from the frontend:
`MEETING_DETECT_PROCESSES = ["ms-teams.exe", "Teams.exe"]` (`src/config/constants.ts:97`), and an
in-place list swap already exists (`UpdateWatchList`, `mod.rs:545-548`). macOS and Linux compile
`stub.rs` and report `UNSUPPORTED_PLATFORM`.

**Who reacts to the events.** `meeting-detected` / `meeting-ended` are broadcast to every window and
read by at least five consumers: `useMeetingDetection` (pop-ups), `useMeetingAutoRecord` (starts and
stops capture), `useMeetingLog` (meeting-end rows and the Notion/Odoo triggers), `useOdooTarget`, and the
chat `Completion` component. This is why the calendar check has to happen **before** these events are
emitted (section 6.1). `useMeetingAutoRecord` stops on any `meeting-ended`, whatever the process
(`useMeetingAutoRecord.ts:598-600`).

**Windows-only gates:** `useMeetingDetection.ts:36`, `useMeetingAutoRecord.ts:122`,
`src/pages/settings/index.tsx:39` (the toggle is only rendered on Windows), `UNSUPPORTED_PLATFORM` in
`mod.rs:18`.

**The calendar.** `fetchCurrentGoogleMeetings` (`src/lib/calendar/fetch-google-meetings.ts:13`) calls
`google_current_meetings` for now ±15 min. The Rust request asks only for the fields in `EVENT_FIELDS`
(`src-tauri/src/google/calendar.rs:11`). **It does not ask for `hangoutLink` or `conferenceData`,** so
the app cannot yet tell a Meet event from any other. The test
`events_url_asks_for_single_events_and_never_the_description` only checks that the URL has a `fields`
parameter and no `description`; it does not pin the field string. Google events are normalized into the
shared `crate::graph::CalendarEvent` (`graph/mod.rs:33`), so a new field changes the Graph (Outlook) side
and every struct literal too.

**The Google connection.** `google_status` returns `{ connected, sessionOnly }`. An expired or rejected
refresh keeps the stored credential (`invalid_grant_keeps_the_credential`, `google/mod.rs:644`), and
calls fail with `GOOGLE_AUTH_EXPIRED`. The credential is forgotten by the Disconnect button
(`google_disconnect`), and a session-only connection (no usable keychain) also ends when the app quits;
`google_status` itself rejects with `GOOGLE_NO_KEYCHAIN` when the keychain can't be read. So
"not connected" does not mean "the user chose to disconnect", and the watch rule in 6.1 does not use it.
Connect and Disconnect both broadcast the Google connection-changed event (`GoogleCalendarCard.tsx:77`,
`:95`).

**Attendees.** `useGoogleMeetingCapture` already captures the Google event when capture starts
(`onCaptureStarted`), so a Meet-triggered recording gets its attendees with no extra work. It picks the
event with `pickCurrentMeeting` and returns nothing to its caller (`useGoogleMeetingCapture.ts:35-36`).

**The window.** `resizeWindow` (`useWindow.ts:26`) only knows heights 54 and 600 and is a no-op while
minimized. A MutationObserver on `document.body` calls `resizeWindow(false)` on every DOM change while no
Radix popover is open (`useWindow.ts:76-88`), which transcript segments trigger constantly. The pill's
window size is fixed (`PILL_DIMENSIONS`, `overlay-minimize.store.ts:9-16`).

**Mac system audio.** `src-tauri/src/speaker/macos.rs` already records system audio through a Core Audio
process tap (via `cidre`), which itself needs macOS 14.2 or later. So the Mac can already record; only
the detector is missing.

## 4. What we measured (Kevin's Windows machine, 2026-11-13)

A throwaway logger made the same WASAPI calls as `win32.rs` every 2s while Kevin ran a Meet call in
Chrome:

| Moment | `chrome.exe` capture session |
|---|---|
| Idle | present, inactive |
| Meet preview screen | ACTIVE |
| Preview to in-call | inactive for about 6s (3 polls), then ACTIVE |
| Muted for about 2.5 minutes | ACTIVE throughout |
| Left the call | inactive within about 10s, and stays inactive |

What follows from it:
- Chrome's mic use shows up as one steady `chrome.exe` session. That is the same kind of entry Teams
  produces, so the existing enumeration works unchanged on Windows.
- **Muting keeps the session active.** "Chrome released the mic" means the user left, not that they
  muted.
- Detection starts on the preview screen, slightly before joining. That is acceptable: it never misses
  the start.
- The drop when joining is exactly 3 polls, which is today's `END_DEBOUNCE`. With Teams' debounce, the
  join drop would end and restart the recording. Chrome needs a longer end debounce (section 6.4).
- An earlier, unsupervised run showed only 18s of activity for what should have been about 2 minutes of
  steps. It was not reproduced in the supervised run and is unexplained. Manual check 2 in section 9
  re-tests this.

## 5. Decided in conversation (Kevin, 2026-11-13)

- Mac and Windows both. Chrome first.
- Calendar-required: only Meet calls on the Google Calendar are detected.
- People rarely mute in meetings, but muting must not stop a recording. Measured: it doesn't.
- If the calendar cannot be checked while Chrome is on the mic, show a small notice saying the calendar
  is disconnected, **with a Reconnect button**.
- The Mac teammate who will test runs the latest macOS.
- The notices must be larger and better-looking than today's toasts. The recording-started and ended
  notices get the same treatment, for Teams too (mockups in 6.3 and 6.6, approved in chat).
- The Mac test build comes from a manually triggered GitHub Actions build (7.5).

## 6. How it works

### 6.1 Two kinds of watched app

The watch list splits in two:
- **Direct** apps (`ms-teams.exe`, `Teams.exe`): exactly today's behaviour. Mic active means a meeting.
- **Calendar-gated** apps (Chrome): mic active only makes a **candidate**. A candidate becomes a meeting
  only once the calendar confirms a Meet event (6.2).

The two kinds need **independent state machines** in the poll loop. Each poll classifies the sessions
against each list separately and steps each machine. With a single machine, Chrome holding the mic for
anything would put the detector in its "in a call" state and a Teams call starting afterwards would never
fire. A single `classify` also returns the first match in enumeration order, so Chrome could shadow
Teams. Each machine holds only its own call and debounce state. The **health counters stay at watcher
level**, counted once per poll, so one bad poll raises one `Degraded` and at most one `Stopped`, not one
per machine (`mod.rs:331-334`: the guard is the sole emitter of the terminal event).

Events:
- The gated machine emits **new** candidate events (names left to the builder, e.g.
  `meeting-candidate-started { episode }` / `meeting-candidate-ended { episode }`). None of the five
  consumers listen to them. `episode` is unique across watcher restarts (a process-wide counter), so a
  confirmation from an old run can never match a new one.
- **One combined `meeting-*` stream.** Rust emits `meeting-detected` when the first of the two machines
  enters a call (Teams in a call, or a confirmed Chrome episode), and `meeting-ended` only when **neither**
  is in a call any more. While no Chrome episode is confirmed, the stream is exactly today's Teams stream.
  This is what stops a Teams call that ends during a Meet call (or the reverse) from stopping the
  recording while the user is still in the other call: `useMeetingAutoRecord` stops on any
  `meeting-ended`. The event carries the process that opened the combined call.
- **Confirming.** When the frontend confirms a candidate (6.2), it calls a new command with the episode
  id. The command does **not** emit anything. It records "episode N confirmed" in state shared with the
  poll thread, under the same lock the poll loop holds while it steps and emits. The poll thread acts on
  it at its next step: if episode N is still the live gated episode, the gated machine enters its call
  and the combined stream emits as above. A confirmation for an episode that has ended, or for any other
  episode id, does nothing. Confirming twice is the same as confirming once. So every `meeting-detected`
  is followed by the poll thread's own `meeting-ended`, **unless the watcher stops** (an explicit stop,
  or a terminal stop after repeated failures, `mod.rs:434-437`, `:509-512`), which emits no
  `meeting-ended`. Consumers already handle that case through `meeting-watcher-stopped`
  (`useMeetingAutoRecord.ts:613-627`) and the setting-changed path.
- An unconfirmed episode that ends emits only the candidate-ended event.

This keeps every `meeting-*` event coming from Rust and leaves all five consumers untouched. *(Builder:
this is the recommended shape. Any shape is fine that meets the constraints: no `meeting-*` event, and so
no consumer reaction, for an unconfirmed Chrome episode; `meeting-ended` only when no confirmed call
remains; no change to the Teams-only path.)*

**The 2-minute carry-over lives in the gated machine.** If a gated episode starts within **2 minutes** of
a *confirmed* gated episode ending, the machine treats it as confirmed at once: no candidate event, no
calendar check. Only a confirmed episode arms it. The window is wall-clock time passed into the pure
machine as `now` (not a poll count, and not `Instant::now()` read inside it), so tests drive it and a
laptop that slept for an hour does not count as "within 2 minutes". Without the carry-over, a mid-call
flap during an overrun (event already ended) or while Google is unreachable would end the recording for
good. The cost is that Chrome mic use within 2 minutes of leaving a call (a voice note) is recorded too,
and the 30-minute transcript gap rule folds it into the same meeting. *(My call.)*

**When Chrome is watched.** Chrome is on the gated list **only when Google Calendar is set up**
(`loadGoogleConfigState()` is not `absent`). Users who never set up Google, which includes every
Teams-only user, watch exactly what they watch today. A user who set Google up and is now disconnected,
for any reason (expired, rejected, session-only relaunch, keychain error, or the Disconnect button),
still watches Chrome, so the notice in 6.3 reaches them, as Kevin asked (section 5). *(My call.)* The
list is recomputed on the Google connection-changed event. It is sent to the watcher with the existing
in-place `UpdateWatchList` path, **never by restarting the watcher** (a restart would drop a confirmed
episode's state while its recording keeps running), and only while auto-record is on and the watcher is
running: `start_meeting_watcher` is the only route to `UpdateWatchList` and spawns a watcher when none is
running (`mod.rs:226-232`, `:545-553`). The call goes through `useMeetingDetection`'s serialized command
queue (`enqueue`, `useMeetingDetection.ts:52-63`), like every other watcher command, because overlapping
starts are only safe while serialized (`mod.rs:556-567`).

If the watcher restarts anyway (the Retry after a watcher failure does stop then start,
`useMeetingDetection.ts:133-134`), a gated candidate that starts while an auto recording started by a
gated confirmation is still running is confirmed at once by the frontend, with no calendar check.

The pop-up label for `chrome.exe` is "Google Meet" (`MEETING_DETECT_LABELS`). The Mac identifiers get
the same label.

### 6.2 The calendar check

It runs in the main window (the same single-owner rule as `useMeetingDetection`), on candidate start,
then **every 60 seconds while the candidate is still unconfirmed and the mic is still held**. The re-check
covers joining more than 5 minutes early and reconnecting the calendar mid-call. *(My call.)*

The loop:
- Runs **one check at a time**. The next check is scheduled 60s after the previous one *finishes*, not on
  a fixed 60s timer. A single check can take more than 60s (a 30s HTTP timeout plus a refresh and retry,
  `google/mod.rs:33`, `:285-291`).
- Stops, and dismisses any amber card, when the candidate ends, when it is confirmed, when the user
  turns auto-record off, and when the watcher stops. Rust's explicit stop emits no candidate-ended, so the
  setting and watcher-stopped paths must tear the loop down themselves.
- Runs a check at once on the Google connection-changed event, so a Reconnect done anywhere (the card in
  6.3, Settings, the Odoo page in another window) is noticed straight away. A Disconnect during a live
  candidate therefore shows the amber Reconnect card at once (unless snoozed). That is intended: Chrome
  is on the mic and the calendar can no longer be checked.
- Discards a result that returns after its episode ended. (Rust ignores a stale confirmation anyway,
  6.1.)
- Is one effect, cleaned up on unmount. Its handlers are registered once, like the existing ones
  (`useMeetingDetection.ts:157-158`, deps `[isOwner]`), so the timer reads the setting, the episode and
  the config through refs, not captured values.

Each check calls `fetchCurrentGoogleMeetings()` and confirms if any event satisfies all of these:
- **has a Meet link:** `hangoutLink` present, or `conferenceData.conferenceSolution.key.type ==
  "hangoutsMeet"`. Add these to `EVENT_FIELDS` and carry a `meetLink` (or boolean) on the shared
  `CalendarEvent` (Graph events carry none). Another conference type (Zoom) is not a Meet link.
- not cancelled, not all-day, and not declined by the user (reuse `isDeclined` from `current-meeting.ts`
  by exporting it; do not copy it);
- `startMs - EARLY_JOIN_MS <= now < endMs` (5 minutes early, reusing `EARLY_JOIN_MS`; start edge
  inclusive, end edge exclusive).

**It does not use `isMeetingEvent`.** That rejects events with fewer than two participants, and a Meet
event the user made alone ("Focus call", or one they share by link) is still a call. A Meet link is
enough evidence. All-day events stay excluded: an all-day event with a Meet link would make every
Chrome mic use that day a meeting. Timed events of any length count. *(My call.)*

The calendar only decides whether to **start**. After confirmation, the event's end time does not
matter. Meetings run over, and the recording continues until Chrome lets go of the mic. *(My call.)*

If two Meet events qualify at once, confirm anyway. This check only asks "is a Meet call plausible
now". Picking which event the recording belongs to is the attendee capture's job, unchanged, and the
cards show the capture's pick (6.6), so the card and the stored attendees always agree.

### 6.3 When the calendar cannot be checked

If the check fails, nothing starts and the user gets the **amber warning card** (6.6). It shows **once
per candidate episode**, not on every 60s re-check, and the re-checks continue silently. It is never
shown while any capture is already running. *(My call.)*

Which codes go where (`toGoogleCode`, `google-errors.ts`):
- **Reconnect** group: `GOOGLE_AUTH_EXPIRED`, `GOOGLE_AUTH_REJECTED`, `GOOGLE_CONSENT_REQUIRED`,
  `GOOGLE_AUTH_CANCELLED`, `GOOGLE_NOT_CONNECTED`. Exception: an unreadable or incomplete saved config,
  which `fetchCurrentGoogleMeetings` also reports as `GOOGLE_AUTH_REJECTED`
  (`fetch-google-meetings.ts:18`), has no Client ID to reconnect with. That case shows the card with a
  button that opens the Google Calendar settings instead of Reconnect. The builder distinguishes it
  before the fetch (`loadGoogleConfigState()` is not `complete`).
- **Can't reach** group: `GOOGLE_NETWORK`, `GOOGLE_THROTTLED`, `GOOGLE_BAD_RESPONSE`,
  `GOOGLE_NO_KEYCHAIN`.

- **Reconnect group:**
  ```
  ╭────────────────────────────────────────────────────────╮
  │  ⚠  If this is a Meet call, it isn't being recorded    │
  │                                                        │
  │     Google Calendar is disconnected, so Meetwings      │
  │     can't confirm the call. Reconnect and recording    │
  │     starts on its own. You won't need to rejoin.       │
  │                                                        │
  │                       [ Not now ]  [ Reconnect Google ]│
  ╰────────────────────────────────────────────────────────╯
  ```
  The headline is hedged ("If this is a Meet call") because the app cannot know: Chrome could be on the
  mic for a voice note. *(My call; the approved mockup said "This Meet call isn't being recorded".)*
  **Reconnect** runs the same flow as the Connect button in `GoogleCalendarCard` (`handleConnect`: saved
  config, then `google_connect`, which opens the browser sign-in, then the connection-changed broadcast).
  The broadcast goes out right after `google_connect` succeeds and **before** the immediate check, so
  every listener (including the attendee capture) sees the new account first. The broadcast triggers
  the check (6.2). If that check confirms, the card turns into the red "recording started" card. On
  failure, the card shows the existing Google error copy (`GOOGLE_COPY`) and keeps the button.
- **Can't reach group:** the same card with no Reconnect button. Its text is "Meetwings can't reach
  Google Calendar right now. If this is a Meet call, start recording by hand, or it will start on its
  own once Google is reachable again." and it has a single **Got it** button. Reconnecting does not fix
  being offline. *(My call.)*

**Not now** and **Got it** snooze the amber card for **1 hour**: later episodes in that hour still get
their silent checks and still auto-start if a check confirms, but show no card. *(My call: limits the
nag on non-Meet Chrome mic use while the calendar is broken.)*

The card stays until it is dismissed, recording starts, the candidate ends (the user left), auto-record
is turned off, or the watcher stops. It does not time out.

### 6.4 Ending

The gated machine uses a **longer end debounce** than Teams, long enough to ride over the measured 3-poll
join drop with margin: 5 polls, about 10s, is the suggested value. Teams keeps `END_DEBOUNCE = 3`. The
start debounce stays 2 polls. *(My call.)* Leaving a Meet call therefore stops the recording about 20s
later: about 10s for Chrome to release the mic (section 4), then the debounce.

The meeting's boundaries in the history still come from the 30-minute transcript gap, not from detection
events. A flap longer than the debounce costs a short stop and restart of capture (each flap also fires
`meeting-ended`, as Teams flaps already do), and the 2-minute carry-over in 6.1 makes the restart
independent of the calendar. It never splits a meeting.

### 6.5 The setting

The same "auto-record" toggle (`STORAGE_KEYS.MEETING_AUTO_RECORD_ENABLED`, default off) covers Teams and
Meet. There is no second toggle. *(My call.)* Its copy changes from Teams-only to name both, for example
"Automatically record Teams and Google Meet calls". On Mac, where there is no Teams detection in this
work, the copy names Google Meet only. The toggle is rendered on Mac as well as Windows (lift the gate
at `settings/index.tsx:39`, in the Mac step, section 8).

On Mac the direct list is empty, so with Google not set up (config `absent`) the watcher watches
nothing. The settings section then shows a note, "Connect Google Calendar to auto-record Meet calls",
with a link to the Google Calendar settings, so a Mac user is never left with a toggle that silently does
nothing.

### 6.6 The meeting cards (decided with Kevin)

Kevin finds today's sonner toasts ("Teams call detected", "Teams call ended") too small and dull. They
are replaced, for **Teams and Meet alike**, by cards that drop down from the bar. Mockups approved in
chat on 2026-11-13:

**Recording started** (red):
```
╭────────────────────────────────────────────────────────╮
│  ◉ REC  Google Meet · recording started         00:04  │
│ ────────────────────────────────────────────────────── │
│  Weekly IC sync                                        │
│  10:00 – 10:30   ·   (AK)(JS)(MR) +2                   │
│                                                        │
│                                            [ ■ Stop ]  │
│ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━──────────── │
╰────────────────────────────────────────────────────────╯
```
- The ◉ pulses gently (an "on air" light) and the timer counts up from the recording's start.
- The title, time and attendee initials come from the event the **attendee or calendar capture
  resolves** (Google for Meet; the existing calendar capture for Teams), not from the gate's match, so
  the card and the stored attendees always name the same event. The capture resolves after an IPC and
  HTTP round trip, so the card first shows only its top row and Stop, and fills in when the event lands.
  When the capture resolves no single event (none, several, a solo event `pickCurrentMeeting` rejects),
  the card keeps only the first row ("Teams call · recording started") and Stop. Show at most 3
  initials, then "+N".
- The thin bar along the bottom drains over about 6s, then the card slides back up. Hovering pauses it.
- **Stop** stops the recording, the same as stopping it by hand. It is there for the rare false catch.

**Recording ended:**
```
╭────────────────────────────────────────────────────────╮
│  ✓  Recording saved                                    │
│     Weekly IC sync  ·  42 min                          │
╰────────────────────────────────────────────────────────╯
```
Shown briefly, then it slides away. The duration runs from the recording's start to its stop. The title
line falls back to the app name.

**Pill (bar minimized):** a compact one-line card under the pill, e.g. `◉ REC  Weekly IC sync  00:04`.
The ended and amber cards get equally compact forms. Showing a card **must not un-minimize the bar**.

**Amber warning:** the card in 6.3. Same shape, amber accent, no timeout.

Where the state lives:
- A **module-level card store** read with `useSyncExternalStore`, in the style of
  `overlay-minimize.store.ts`. It holds the current card, its event details, the time of the last auto
  stop per app, and the suppression timers. It must outlive `<Completion />`, which unmounts on a
  setup-status flip (`useMeetingAutoRecord.ts:87-108`). Timers are cleared on teardown.
- `useMeetingAutoRecord` publishes "auto recording started" and "auto recording stopped" into it. Start
  is the moment it turns capture on (in meeting mode the mic flag flipping is the only start signal,
  `useMeetingAutoRecord.ts:407-409`). Stop must be published from **every** stop path: `handleStop`
  (`:481-541`), the release branch for a user-closed mic in meeting mode (`:166-201`), the
  `capture-stopped` listener that clears an auto recording stopped by hand in transcribing mode
  (`:602-611`; the card's own Stop goes this way in that mode), and the unmount cleanup (`:551-571`). The
  `capture-stopped` publish must ignore the internal stop that `startCapture` issues before every VAD
  start.
- The attendee and calendar capture hooks publish the resolved event into the same store, keyed to the
  recording that asked.

Rules:
- The cards report **recording**, not raw detection. The red card shows when an auto-started recording
  actually starts (`useMeetingAutoRecord`), and the ended card when it actually stops. Detection events
  that start nothing (auto-record off, already recording by hand) show nothing.
- **Flaps must not produce card pairs.** Teams flaps several times per call. A recording that restarts
  within 2 minutes of the previous auto stop **of the same app** shows no red card. The ended card waits
  about 30s and is cancelled if the same app's recording restarts in that time. A different app (Teams,
  then Meet) is a new meeting and gets its own cards. *(My call.)*
- The cards live in the main window, the same window as the bar, so like the bar they are hidden from
  screen sharing. The window grows **to the card's size**, not to the 600px popover height, so a
  transparent window never covers the Meet or Teams controls under it.
- **The card's height is part of every resize decision.** Replace the 54/600 boolean with a required
  height: `max(popover open ? 600 : 54, card height)`, used by `resizeWindow`, the MutationObserver and
  the mouseup handler alike. Otherwise the observer shrinks the window to 54px under a visible card on
  the next transcript segment.
- **The pill grows too.** While minimized, `resizeWindow` returns early and the pill size is fixed, so a
  card under the pill needs its own path: a card-aware pill window size set through the minimize command
  or a sibling command. Restoring from the pill takes the card height into account.
- If the bar is hidden (window not visible), the **amber** card shows the window so the warning can't
  be missed. The red and ended cards do not force the window open. *(My call.)*
- Light and dark themes both. Motion respects `prefers-reduced-motion`: no pulse and no slide, only a
  fade.
- The other toasts (VAD, stuck, start/stop failures, watcher stopped) stay as they are. *(My call.)*

## 7. Mac

### 7.1 The detector

A new `meeting_detect/macos.rs` produces the same `Vec<SessionInfo>` from Core Audio's **process
objects**:
- `kAudioHardwarePropertyProcessObjectList`
- for each process: `kAudioProcessPropertyPID`, `kAudioProcessPropertyBundleID`,
  `kAudioProcessPropertyIsRunningInput`

The process objects arrived in macOS 14.2, the same release the existing process tap needs. Use
`cidre`'s `core_audio` wrappers, which are already a dependency, if they expose these. `image_name`
carries the **bundle ID** on Mac. `stub.rs` remains for Linux only. Only the enumeration is Mac-only;
matching and every decision stay in the cfg-free pure code, whose tests run in the Linux and the new
macOS CI jobs (the Windows CI job runs clippy only, `ci.yml:128-129`; Kevin runs `cargo test` locally).

Chrome on Mac does its audio in helper processes, so the identity seen is expected to be
`com.google.Chrome` and/or `com.google.Chrome.helper`. **This is not verified.** The gated list for Mac
is set from the diagnostic in 7.3. If matching needs a bundle-ID prefix, scope it to the **gated Mac
list only** (for example a separate prefix list). Teams matching stays exact modulo case (R9), and the
label lookup learns the same prefix rule.

The poll loop's COM initialisation is Windows-only (`#[cfg(target_os = "windows")]`). The Mac path needs
none.

An older macOS that lacks the property must fail **at start**: `start_meeting_watcher` checks it
synchronously and returns a clear error. The settings section shows that message, and keeps showing it
even after the toggle flips itself off (today a start failure shows a generic toast and flips the toggle
off, which hides the note, `useMeetingDetection.ts:235-243`, `MeetingAutoRecordToggle.tsx:143-146`). It
must not fail silently, and must not reach the poll loop, where the message would be replaced after 30
polls by "30 consecutive failed polls" (`mod.rs:373`).

### 7.2 Gates to lift

`useMeetingDetection.ts:36` and `useMeetingAutoRecord.ts:122` (`isWindows()` becomes Windows or Mac),
`settings/index.tsx:39`, and `UNSUPPORTED_PLATFORM`'s wording and the cfg gates in `mod.rs`.
`MEETING_DETECT_PROCESSES` becomes per-platform: Windows direct = Teams and gated = `chrome.exe`; Mac
direct = none and gated = the Chrome bundle IDs. All of these land together in the Mac step (section 8).
The first Mac build, for the teammate only, carries a **provisional** gated list (the expected IDs in
7.1), corrected from what the readout shows. No build that reaches users shows Mac users a toggle that
does nothing.

### 7.3 Diagnostic readout

Release builds show no console logs (DevTools and the log plugin are off). So the Mac identity has to be
checked inside the app. The auto-record settings section gets a small readout listing the apps
currently on the microphone, and whether each one is watched, gated or ignored. A new read-only command
**enumerates the sessions on demand** with the same code the detector uses, so it works with auto-record
off. On Windows that enumeration needs COM on the calling thread (`win32.rs:8-10`), so the command
initialises COM (multithreaded) on its own thread the way `poll_loop` does (`mod.rs:412-427`), or runs
the enumeration on such a thread. It is the **first Mac deliverable**. The teammate opens Settings with a Meet call running and
reports what it lists, and the gated Mac list is set from that. It stays in the product on both platforms
afterwards, as the answer to "why didn't it record?". *(My call.)*

### 7.4 Compile checking

`ci.yml` has no macOS job. Mac builds only happen in `publish.yml` on a version-bumped push to `main`.
Without a check, Mac-only Rust code reaches `main` uncompiled. Add a macOS job to `ci.yml` for PRs that
runs `cargo clippy` **and `cargo test`**, so the pure detector tests also run on a Mac target. Use the
same pinned Rust toolchain as the other jobs (1.99.1).

### 7.5 The Mac test build (decided with Kevin)

A manually triggered workflow (`workflow_dispatch`) builds the Mac app and uploads the `.dmg` as a
workflow **artifact**. It creates no release, does not touch `latest.json`, and reaches no other user.
Reuse the macOS build steps from `publish.yml` instead of copying them, if that can be done cleanly;
otherwise keep the new workflow minimal.

GitHub only lets you dispatch a workflow whose file exists on the default branch. So the workflow file
ships first as **its own small PR to `main`** (Kevin merges it). After that it can be run against
`feat/google-meet-detection` with `--ref`.

The build is unsigned. The teammate opens it the way the release notes already say
(`publish.yml:125`): System Settings → Privacy & Security → Security, find the "meetwings was blocked"
message, click **Allow Anyway**, then reopen the app.

## 8. Order of work

1. **Windows.** Sections 6.1-6.4 and 6.6, the 6.5 copy change, the Google `EVENT_FIELDS` change, and the
   diagnostic readout (7.3), since it costs the same on both platforms. The cards (6.6) are
   platform-neutral and land here too. Tested on Kevin's machine with `npm run tauri dev` (quit the
   installed Meetwings first: single-instance guard).
2. **Mac.** The 7.5 workflow PR to `main` first. Then 7.1, 7.2 (including the Mac toggle gate and the
   6.5 Mac note) and 7.4 together. First a build with the readout for the teammate, then the gated Mac
   list from what it shows, then the checks in section 9 on the teammate's Mac.

Branch: `feat/google-meet-detection`, cut from `main` (PR #96 merged). *(My call.)*

## 9. Checks before rollout

**Automated, Rust** (`meeting_detect/mod.rs`, pure and cfg-free, so they run in the Linux and the new
macOS CI jobs, and in Kevin's local `cargo test` on Windows):
- `classify` per list: mixed Chrome and Teams sessions in **both** enumeration orders, each list
  matching only its own app; the existing single-list cases (case-insensitive match, own-pid exclusion,
  Unknown) repeated for `chrome.exe`; the Mac gated prefix rule (if used) matching helpers while Teams
  stays exact (R9).
- Two machines: a Teams call starting while Chrome is a candidate fires; a gated 3-poll drop does not end;
  a gated 5-poll drop does; an unconfirmed gated episode emits no `meeting-*` event; Unknown and Failed
  polls hold the gated machine's state; emptying the gated list (Google disconnected) ends a live episode
  after the debounce.
- Health counters: one bad poll raises one `Degraded` and at most one `Stopped`, not one per machine.
- Combined stream: Teams ending during a confirmed Meet call emits no `meeting-ended`; the second one
  ending does; Teams-only sequences are unchanged.
- Confirmation: confirm then leave emits `meeting-detected` then `meeting-ended`; a confirmation for an
  old episode id does nothing; a confirmation after the episode ended does nothing; confirming twice
  emits once.
- Carry-over (with injected `now`): a gated episode starting just under 2 minutes after a confirmed one
  ended is confirmed with no candidate event; just over 2 minutes is a candidate; an unconfirmed episode
  ending arms nothing; few polls across a long wall-clock gap (sleep) do not carry over.

**Automated, Rust** (`google/calendar.rs`): `parse_events` cases for `hangoutLink` present, a
`hangoutsMeet` conference, a non-Meet conference type (Zoom), and neither. Graph events carry no Meet
link. The existing URL test gets the new fields.

**Automated, Vitest** (fake timers, `fetchCurrentGoogleMeetings` and `invoke` mocked):
- Match rule: Meet link required; `now == startMs - EARLY_JOIN_MS` accepted, `now == endMs` rejected; solo
  event accepted; declined, cancelled and all-day rejected. Existing fixtures in `current-meeting.test.ts`
  and `fetch-google-meetings.test.ts` gain the new field.
- Check loop: the next check starts 60s after the previous one finishes and never overlaps; the loop
  stops on confirm, on candidate end, on auto-record off and on watcher stopped; a result arriving after
  its episode ended is discarded; the connection-changed event triggers a check at once.
- Watch list: Chrome absent when Google config is absent and present otherwise, whether or not Google is
  connected; on the connection-changed event the list is sent through the command queue with
  `UpdateWatchList` (never a restart), and not at all while auto-record is off or the watcher is not
  running; after a watcher restart, a candidate during a running gate-confirmed recording is confirmed
  without a check.
- Notice: once per episode; Reconnect group vs Can't-reach group vs unreadable config (settings button);
  Reconnect success broadcasts before the immediate check; Reconnect failure shows `GOOGLE_COPY` and
  keeps the button; Not now / Got it snooze for 1 hour; no card while a capture is running.
- Cards: no red card for a same-app restart within 2 minutes; a different app's start within 2 minutes
  does get one; an ended card cancelled by a same-app restart within its 30s wait; no card for detection
  that starts no recording; each of the four stop paths publishes the ended card, and the internal stop
  before a VAD start does not; a late capture result
  fills the card in; no card content when the capture resolves no single event.
- Window: while a card is up, a transcript mutation does not shrink the window; a card shown while
  minimized never calls the normal `set_window_height` path and never un-minimizes.
- Platform (platform mocked to Mac): the toggle renders; the copy names Google Meet only; the "Connect
  Google Calendar" note shows with Google not set up; per-platform watch lists (Mac direct = none); an
  unsupported-macOS start error stays visible after the toggle flips off.

**Manual, on Windows (Kevin)**, with auto-record on and Google connected:
1. A calendar event with a Meet link, starting now. Open it in Chrome and join. Recording starts and the
   red card says Google Meet, filling in the event when the attendee capture lands.
2. Stay in the call for at least 3 minutes, muting and unmuting several times. Still recording throughout
   (re-tests the unexplained 18s run in section 4).
3. Leave. Recording stops within about 20s, and the ended card shows.
4. Wait more than 2 minutes (the carry-over). No calendar event: open `meet.new` and join. No card, no
   recording, and no new row on the Meetings page.
5. No Meet event now: use Chrome's mic for something else (voice typing in Google Docs, or a WhatsApp Web
   voice note). No card, no recording.
6. An event starting in 8 minutes: join now. Nothing yet; recording starts once the event is within 5
   minutes.
7. Revoke Meetwings' access in the Google Account (Security → third-party connections), so the saved
   sign-in is rejected. Join a Meet event. The amber card appears with Reconnect. Reconnect, sign in,
   and recording starts without rejoining.
8. Press Disconnect on the Google Calendar card, then join a Meet event. The amber card appears with
   Reconnect. Press Not now, leave, and join again within the hour: no card (the snooze). Reconnect from
   the Google Calendar card: recording starts without rejoining.
9. Create a Meet event starting in about 7 minutes and open its preview screen (Chrome on the mic). The
   first check finds no event in the window, silently. Turn Wi-Fi off before the next re-check: the amber
   "can't reach" card appears with Got it. Once the event is within 5 minutes, turn Wi-Fi back on:
   recording starts within about a minute.
10. Hide the bar, then repeat check 7's trigger. The amber card shows the window.
11. With `meet.new` open on its preview screen (Chrome holding the mic), start a Teams call. Teams is
    detected as today.
12. In a confirmed Meet call, start and end a Teams call. Recording continues until the Meet call is left.
13. A call that runs past the event's end time keeps recording.
14. The cards: the red card drains away and pauses on hover; Stop stops. The pill shows compact cards and
    stays a pill. Click the Meet controls just below the bar while a card is up: they respond (the window
    has not grown over them). Light and dark theme. With Windows animation effects off, cards only fade.
15. A Teams call: the red card says Teams. A Teams flap (leave and rejoin within a minute) shows no extra
    card pair.

**Manual, on the teammate's Mac:** the readout first (7.3), then checks 1-5 and 7.

## 10. Left to the builder

- Event and command names.
- Notice copy beyond the mockups in 6.3.
- Whether `meetLink` is a string or a boolean on the event type.
- The exact gated end debounce, as long as it rides over a 3-poll drop.
- How the diagnostic readout looks.
- The cards' exact colours, spacing, fonts and animation timing, within the mockups and rules in 6.6.
- Which process the combined `meeting-*` stream carries when Teams and Meet overlap, as long as the
  stream follows 6.1.
