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
  or any other Chrome mic use outside a Meet calendar event must produce no pop-up, no recording and no
  meeting-log row.
- **A silent miss.** If the app cannot check the calendar, the user is told, not left to find out later
  that nothing was recorded.
- **A Teams regression.** Chrome holding the mic must never hide or delay a Teams call.

## 3. How it works today

**The detector** (`src-tauri/src/meeting_detect/mod.rs`, Windows only). Every 2s (`POLL_INTERVAL`) the
poll loop lists every capture-endpoint audio session (`win32.rs`, WASAPI) and `classify`
(`mod.rs:56`) returns `Active(image_name)` for the first active session whose image name is on the watch
list. A pure state machine (`step`, `mod.rs:126`) turns polls into events: 2 active polls
(`START_DEBOUNCE`) emit `meeting-detected { process }`, 3 inactive polls (`END_DEBOUNCE`, about 6s) emit
`meeting-ended { process }`. The watch list comes from the frontend:
`MEETING_DETECT_PROCESSES = ["ms-teams.exe", "Teams.exe"]` (`src/config/constants.ts:97`). macOS and
Linux compile `stub.rs` and report `UNSUPPORTED_PLATFORM`.

**Who reacts to the events.** `meeting-detected` / `meeting-ended` are broadcast to every window and
read by at least five consumers: `useMeetingDetection` (pop-ups), `useMeetingAutoRecord` (starts and
stops capture), `useMeetingLog` (meeting-end rows and the Notion/Odoo triggers), `useOdooTarget`, and the
chat `Completion` component. This is why the calendar check has to happen **before** these events are
emitted (section 6.1).

**Windows-only gates:** `useMeetingDetection.ts:36`, `useMeetingAutoRecord.ts:122`,
`src/pages/settings/index.tsx:39` (the toggle is only rendered on Windows), `UNSUPPORTED_PLATFORM` in
`mod.rs:18`.

**The calendar.** `fetchCurrentGoogleMeetings` (`src/lib/calendar/fetch-google-meetings.ts:13`) calls
`google_current_meetings` for now ±15 min. The Rust request asks only for the fields in `EVENT_FIELDS`
(`src-tauri/src/google/calendar.rs:11`). **It does not ask for `hangoutLink` or `conferenceData`,** so
the app cannot yet tell a Meet event from any other. The test
`events_url_asks_for_single_events_and_never_the_description` pins that field string.

**Attendees.** `useGoogleMeetingCapture` already captures the Google event when capture starts
(`onCaptureStarted`), so a Meet-triggered recording gets its attendees with no extra work.

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
  steps. It was not reproduced in the supervised run and is unexplained. The manual checks in section 9
  re-test this.

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
against each list and steps each machine. With a single machine, Chrome holding the mic for anything
would put the detector in its "in a call" state and a Teams call starting afterwards would never fire.
A single `classify` also returns the first match in enumeration order, so Chrome could shadow Teams.

Events:
- The direct machine emits `meeting-detected` / `meeting-ended` as today.
- The gated machine emits **new** candidate events (names left to the builder, e.g.
  `meeting-candidate-started` / `meeting-candidate-ended`). None of the five consumers listen to them.
- When the frontend confirms a candidate (6.2), it calls a new command. Rust then emits the ordinary
  `meeting-detected { process: "chrome.exe" }` for the gated machine's current episode. When that
  confirmed episode ends, Rust emits the ordinary `meeting-ended`. An unconfirmed episode that ends emits
  only the candidate-ended event.

This keeps every `meeting-*` event coming from Rust and leaves all five consumers untouched. *(Builder:
this is the recommended shape. Any shape is fine that meets the constraint: no `meeting-*` event, and so
no consumer reaction, for an unconfirmed Chrome episode, and no change to the Teams path.)*

Chrome is on the gated list **only when Google Calendar is set up** (`loadGoogleConfigState()` is not
`absent`). Users who never set up Google, which includes every Teams-only user, watch exactly what they
watch today. A user who set Google up and is now disconnected still watches Chrome, so the notice in 6.3
can reach them. *(My call.)*

The pop-up label for `chrome.exe` is "Google Meet" (`MEETING_DETECT_LABELS`). The Mac identifiers get
the same label.

### 6.2 The calendar check

It runs in the main window (the same single-owner rule as `useMeetingDetection`), on candidate start,
then **every 60 seconds while the candidate is still unconfirmed and the mic is still held**. It stops
when the candidate ends or is confirmed. The re-check covers joining more than 5 minutes early and
reconnecting the calendar mid-call. *(My call.)*

Each check calls `fetchCurrentGoogleMeetings()` and confirms if any event satisfies all of these:
- **has a Meet link:** `hangoutLink` present, or `conferenceData.conferenceSolution.key.type ==
  "hangoutsMeet"`. Add these to `EVENT_FIELDS`, carry a `meetLink` (or boolean) on the Google event, and
  update the test that pins the field string.
- not cancelled, not all-day, and not declined by the user;
- `startMs - EARLY_JOIN_MS <= now < endMs` (5 minutes early, reusing `EARLY_JOIN_MS`).

**It does not use `isMeetingEvent`.** That rejects events with fewer than two participants, and a Meet
event the user made alone ("Focus call", or one they share by link) is still a call. A Meet link is
enough evidence. All-day events stay excluded: an all-day event with a Meet link would make every
Chrome mic use that day a meeting. Timed events of any length count. *(My call.)*

**A confirmation carries over a short flap.** If a gated episode starts within **2 minutes** of a
*confirmed* gated episode ending, it is confirmed at once, with no calendar check. Without this, a
mid-call flap during an overrun (event already ended) or while Google is unreachable would end the
recording for good. The cost is that Chrome mic use within 2 minutes of leaving a call (a voice note)
is recorded too, and the 30-minute transcript gap rule folds it into the same meeting. *(My call.)*

The calendar only decides whether to **start**. After confirmation, the event's end time does not
matter. Meetings run over, and the recording continues until Chrome lets go of the mic. *(My call.)*

If two Meet events qualify at once, confirm anyway. This check only asks "is a Meet call plausible
now". Picking which event the recording belongs to is the attendee capture's job, unchanged.

### 6.3 When the calendar cannot be checked

If the check fails, nothing starts and the user gets the **amber warning card** (6.6). It shows **once
per candidate episode**, not on every 60s re-check, and the re-checks continue silently. *(My call.)*

- **Signed out / sign-in rejected** (the error codes that mean "reconnect will fix it"):
  ```
  ╭────────────────────────────────────────────────────────╮
  │  ⚠  This Meet call isn't being recorded                │
  │                                                        │
  │     Google Calendar is disconnected, so Meetwings      │
  │     can't confirm the call. Reconnect and recording    │
  │     starts on its own. You won't need to rejoin.       │
  │                                                        │
  │                       [ Not now ]  [ Reconnect Google ]│
  ╰────────────────────────────────────────────────────────╯
  ```
  **Reconnect** runs the same flow as the Connect button in `GoogleCalendarCard` (`handleConnect`: saved
  config, then `google_connect`, which opens the browser sign-in). On success, run a check straight away
  instead of waiting up to 60s. If that check confirms, the card turns into the red "recording started"
  card. On failure, the card shows the existing Google error copy (`GOOGLE_COPY`) and keeps the button.
- **Network / other errors:** the same card with no Reconnect button. Its text is "Meetwings can't reach
  Google Calendar right now. Start recording by hand, or it will start on its own once Google is
  reachable again." and it has a single **Got it** button. Reconnecting does not fix being offline.
  *(My call.)*

The card stays until it is dismissed, recording starts, or the candidate ends (the user left). It does
not time out. Which `toGoogleCode` codes fall in which group is left to the builder.

### 6.4 Ending

The gated machine uses a **longer end debounce** than Teams, long enough to ride over the measured 3-poll
join drop with margin: 5 polls, about 10s, is the suggested value. Teams keeps `END_DEBOUNCE = 3`. The
start debounce stays 2 polls. *(My call.)*

The meeting's boundaries in the history still come from the 30-minute transcript gap, not from detection
events. A flap longer than the debounce costs a short stop and restart of capture (each flap also fires
`meeting-ended`, as Teams flaps already do), and the 2-minute carry-over in 6.2 makes the restart
independent of the calendar. It never splits a meeting.

### 6.5 The setting

The same "auto-record" toggle (`STORAGE_KEYS.MEETING_AUTO_RECORD_ENABLED`, default off) covers Teams and
Meet. There is no second toggle. *(My call.)* Its copy changes from Teams-only to name both, for example
"Automatically record Teams and Google Meet calls". On Mac, where there is no Teams detection in this
work, the copy names Google Meet only. The toggle is rendered on Mac as well as Windows (lift the gate
at `settings/index.tsx:39`).

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
- The title, time and attendee initials come from the calendar event when one is known: the Google event
  the gate matched, or the event the attendee or calendar capture resolves for a Teams call. Show at most
  3 initials, then "+N". With no event, show only the first row ("Teams call · recording started") and
  the Stop button.
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

Rules:
- The cards report **recording**, not raw detection. The red card shows when an auto-started recording
  actually starts (`useMeetingAutoRecord`), and the ended card when it actually stops. Detection events
  that start nothing (auto-record off, already recording by hand) show nothing.
- **Flaps must not produce card pairs.** Teams flaps several times per call. A recording that restarts
  within 2 minutes of the previous auto stop shows no red card. The ended card waits about 30s and is
  cancelled if the recording restarts in that time. *(My call.)*
- The cards live in the main window, the same window as the bar, so like the bar they are hidden from
  screen sharing. The window grows **to the card's size**, not to the 600px popover height, so a
  transparent window never covers the Meet or Teams controls under it. Today `resizeWindow`
  (`useWindow.ts:26`) only knows 54 and 600, and is a no-op while minimized.
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
carries the **bundle ID** on Mac. `stub.rs` remains for Linux only.

Chrome on Mac does its audio in helper processes, so the identity seen is expected to be
`com.google.Chrome` and/or `com.google.Chrome.helper`. **This is not verified.** The gated list for Mac
is set from the diagnostic in 7.3, and matching may need to be a bundle-ID prefix rather than exact.

The poll loop's COM initialisation is Windows-only (`#[cfg(target_os = "windows")]`). The Mac path needs
none.

An older macOS that lacks the property should make the watcher fail with a clear message in the settings
section, as the unsupported-platform path does today. It must not fail silently.

### 7.2 Gates to lift

`useMeetingDetection.ts:36` and `useMeetingAutoRecord.ts:122` (`isWindows()` becomes Windows or Mac),
`settings/index.tsx:39`, and `UNSUPPORTED_PLATFORM`'s wording and the cfg gates in `mod.rs`.
`MEETING_DETECT_PROCESSES` becomes per-platform: Windows direct = Teams and gated = `chrome.exe`; Mac
direct = none and gated = the Chrome bundle IDs.

### 7.3 Diagnostic readout

Release builds show no console logs (DevTools and the log plugin are off). So the Mac identity has to be
checked inside the app. The auto-record settings section gets a small readout listing the apps
currently on the microphone, and whether each one is watched, gated or ignored. It is the same data the
detector sees: a new read-only command returning the last poll's sessions. It is the **first Mac
deliverable**. The teammate opens Settings with a Meet call running and reports what it lists, and the
gated Mac list is set from that. It stays in the product on both platforms afterwards, as the answer to
"why didn't it record?". *(My call.)*

### 7.4 Compile checking

`ci.yml` has no macOS job. Mac builds only happen in `publish.yml` on a version-bumped push to `main`.
Without a check, Mac-only Rust code reaches `main` uncompiled. Add a macOS `cargo check` (or `clippy`)
job to `ci.yml` for PRs.

### 7.5 The Mac test build (decided with Kevin)

A manually triggered workflow (`workflow_dispatch`, any branch) builds the Mac app and uploads the
`.dmg` as a workflow **artifact**. It creates no release, does not touch `latest.json`, and reaches no
other user. The build is unsigned, so the teammate opens it with right-click → Open. Reuse the macOS
build steps from `publish.yml` instead of copying them, if that can be done cleanly; otherwise keep the
new workflow minimal.

## 8. Order of work

1. **Windows.** Sections 6.1-6.6 and the Google `EVENT_FIELDS` change, plus the diagnostic readout (7.3)
   since it costs the same on both platforms. The cards (6.6) are platform-neutral and land here too. Tested on Kevin's machine with `npm run tauri dev` (quit
   the installed Meetwings first: single-instance guard).
2. **Mac.** 7.1, 7.2 and 7.4. First a build with the readout for the teammate, then the gated Mac list
   from what it shows, then the checks in section 9 on the teammate's Mac.

Branch: `feat/google-meet-detection`, cut from `main` (PR #96 merged). *(My call.)*

## 9. Checks before rollout

Automated: the state-machine and classify tests in `mod.rs` extend to two machines (a Teams call
starting while Chrome is a candidate fires; a gated 3-poll drop does not end; a gated 5-poll drop does;
an unconfirmed gated episode emits no `meeting-*` event). The calendar-match rule gets unit tests:
Meet link required, early-join edge, solo event accepted, declined and all-day rejected. A gated episode
starting within 2 minutes of a confirmed one is confirmed without a check; one starting later is not. The
notice fires once per episode. The card rules: no red card for a restart within 2 minutes, an ended
card cancelled by a restart within its 30s wait, and no card for detection that starts no recording.

Manual, on Windows (Kevin), with auto-record on and Google connected:
1. A calendar event with a Meet link, starting now. Open it in Chrome and join. Recording starts and
   the pop-up says Google Meet.
2. Mute for a minute. Still recording.
3. Leave. Recording stops within about 10s.
4. No calendar event: open `meet.new` and join. No pop-up, no recording, and no new row on the Meetings
   page.
5. An event starting in 8 minutes: join now. Nothing yet; recording starts once the event is within 5
   minutes.
6. Disconnect Google, then join a Meet event. The notice appears with Reconnect. Reconnect, sign in, and
   recording starts without rejoining.
7. With `meet.new` open on its preview screen (Chrome holding the mic), start a Teams call. Teams is
   detected as today.
8. A call that runs past the event's end time keeps recording.
9. The cards: the red card on start, with title and initials for a calendar call; it drains away and
   pauses on hover; Stop stops. The ended card on leaving. The pill shows compact cards and stays a pill.
   Click the Meet controls just below the bar while a card is up: they respond (the window has not grown
   over them). Light and dark theme.
10. A Teams call: the red card says Teams. A Teams flap (leave and rejoin within a minute) shows no extra
    card pair.

Manual, on the teammate's Mac: the readout first (7.3), then checks 1-4 and 6.

## 10. Left to the builder

- Event and command names; how the confirmation command identifies the episode it confirms (a stale
  confirmation must not promote a later episode).
- How the watch lists reach Rust. Today it is one `processes` argument to `start_meeting_watcher`. The
  list also changes when Google is set up or removed: decide whether to restart the watcher or update
  its list.
- Notice copy and the error-code grouping in 6.3.
- Whether `meetLink` is a string or a boolean on the event type.
- The exact gated end debounce, as long as it rides over a 3-poll drop.
- Behaviour when a Teams call and a confirmed Meet call overlap. It is rare; one recording is fine.
- How the diagnostic readout looks.
- The cards' exact colours, spacing, fonts and animation timing, within the mockups and rules in 6.6.
- How the window resize for a card fits the existing popover and minimize logic.
