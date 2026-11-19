# Meeting detection on Mac (parity with Windows)

Status: design, awaiting approval (2026-11-19)
Owner: Kevin
Issues: #95 (closed as completed, but only its Windows half shipped), #114 (Mac lag, open)
Builds on: `2026-11-13-google-meet-detection-design.md` (the 11-13 spec). Its section 7 designed the Mac
half and its section 8 step 2 scheduled it, and none of that was built. This document is the Mac step,
made self-contained and brought up to date. Where it differs from the 11-13 spec, this one wins.

Code references are against `main` at `4ef2916` (v1.6.2).

## 1. Why

A Mac tester connected Google Calendar, saw no meetings and no sign that Meetwings knew about the
calendar, and asked whether this was a Mac issue. It is. On Windows a Teams, Zoom or Chrome call starts
and stops recording on its own, and the meeting card names the calendar event. On Mac none of that
runs:
- the Rust watcher compiles `meeting_detect/stub.rs` and returns "only supported on Windows"
  (`mod.rs:27`, guards at `mod.rs:765, 873, 897, 924, 991, 1057`);
- the frontend owners are gated on `isWindows()` (`useMeetingDetection.ts:35`,
  `useMeetingAutoRecord.ts:170`);
- Settings hides the toggle (`settings/index.tsx:44`).

The only calendar use left on Mac is the silent snapshot taken when the user starts a capture by hand
(`useGoogleMeetingCapture.ts`), which shows nothing on screen.

Owner decisions (2026-11-19): the Mac should behave the same as the PC. For now that means **Google Meet
in Chrome only**; Safari may follow. A lag reproduced during testing does **not** hold the release
("they can just not install the program"), and auto-record stays off by default.

## 2. Goals, non-goals, anti-goals

Goals:
- On a supported macOS, with auto-record on, a Google Meet call in Chrome starts recording without the
  user doing anything and stops when the user leaves. As on Windows since PR #109, any Chrome mic use
  counts as a call. It uses the same timing, cards and Google Calendar naming as Windows today.
- The Settings toggle, its error note and the "Check microphone apps" readout work on Mac.
- `detection.log` is written on Mac, as on Windows.
- Windows behaviour does not change at all.

Non-goals:
- **Teams and Zoom on Mac** (owner, 2026-11-19: "only concerned about Google Meet in Chrome for now").
  Adding them later is a constants change once someone has seen their IDs in the readout on a real Mac,
  unless their mic turns out to sit in a shared WebKit process (see the Safari bullet).
- **Safari**, and any browser other than Chrome. Safari's mic belongs to WebKit, the same engine as
  Meetwings' own mic, so the two are hard to tell apart. Safari is the expected next step ("we might need
  Safari later"). This work must not make it harder: the readout and `detection.log` keep showing every
  mic-holding process with its raw ID and PID, which is the data a Safari design will need.
- Fixing the Mac lag (#114). It has its own issue and does not block this work (section 7).
- Showing the calendar on a recording started by hand, on either platform. Windows does not do this
  either.
- Linux. It keeps `stub.rs`.
- Changing autostart (`autostart.ts:27` is Windows-only for an unrelated reason).

Anti-goals (failures even if the feature "works"):
- **Meetwings detecting its own mic.** On Mac its mic runs in a WebKit process
  (`com.apple.WebKit.*`), not in Meetwings' own PID. If that ever matched, every recording would detect
  itself and never end.
- **Mac users receiving a toggle that does nothing.** No build that reaches users carries unverified
  bundle IDs (kept from the 11-13 spec, section 7.2).
- **First-run permission prompts popping up unattended in the middle of a call** (section 5).
- **Any Windows regression.** Same lists, same matching, same timing.

## 3. What is superseded in the 11-13 spec

- Section 5's "calendar-required" and section 6's calendar checks: PR #109 dropped them on every
  platform. Any Chrome mic use is a call, and `meet-gate.ts` confirms every candidate at once. Mac
  follows that.
- Section 6.5's Mac note ("Connect Google Calendar to auto-record Meet calls"): dropped. Chrome is now
  watched with or without Google, so the Mac toggle is never left watching nothing. Its Mac copy naming
  Google Meet only is **kept**.
- Section 7.3's readout: already shipped (`list_capture_sessions`, the "Check microphone apps" button in
  `MeetingAutoRecordToggle.tsx`). On Mac it starts working once the enumeration exists.
- Section 9's Mac line, "checks 1-5 and 7": replaced by section 8 below. Checks 4 and 5 there asserted
  calendar-gated behaviour that no longer ships.

Kept as written there: the section 2 non-goals for Teams and Zoom on Mac, section 7.1 (the detector, and
failing at start on old macOS with a message that stays visible), section 7.2 (per-platform lists with
Mac direct = none, and no unverified IDs reaching users), section 7.4 (macOS CI job), and section 7.5 (a
`workflow_dispatch` test DMG, landed as its own PR first). Each is restated below.

## 4. Approaches

- **Chosen: a Mac version of the OS query.** On Windows, everything after "which apps hold the mic"
  is already platform-neutral pure Rust (`classify`, `step`, `gate.rs`, `tick`) and platform-neutral
  TypeScript. Only `win32.rs` and the platform switches are Windows-only. `cidre` 0.11.3 is already a
  Mac dependency (`Cargo.toml:84`) and exposes exactly the needed calls: `ca::System::processes()`, and
  per process `pid()`, `bundle_id()` and `is_running_input()` (`cidre-0.11.3/src/core_audio/hardware.rs:257-289, 373`).
- Rejected: **start recording when a calendar event begins.** The owner rejected calendar-driven meeting
  boundaries ("a meeting ends when the call app closes", and "people don't always follow their calendars").
- Rejected: **ask Core Audio only whether the mic is busy anywhere** (`kAudioDevicePropertyDeviceIsRunningSomewhere`).
  It works on older macOS, but it cannot say which app is using the mic. Meetwings' own recording keeps
  the mic busy, so a call would never end.
- Deferred: **Safari** (see section 2).

## 5. Design

### 5.1 The detector (`meeting_detect/macos.rs`, new)

`enumerate_capture_sessions() -> Result<Vec<SessionInfo>, String>`, with the same signature as
`win32.rs`:
- List Core Audio's process objects. Keep **only those running input**. On Mac, a process that merely
  plays audio is not a mic session, and listing it would make the readout's "Idle" rows meaningless.
- `SessionInfo { pid, image_name, active: true }`. `image_name` is the **raw bundle ID**. A process with
  no bundle ID falls back to its executable name (from the PID), or to `None` if that fails too, which
  feeds the existing `Unknown` path.
- Wire it with `#[cfg(target_os = "macos")]` beside the Windows one. `stub.rs` becomes Linux and other
  platforms only.

The poll loop's COM block stays `#[cfg(target_os = "windows")]`. The Mac path needs no per-thread setup
unless the builder finds Core Audio does.

### 5.2 Matching rule for Mac helper processes

Mac apps often do their audio in helper processes whose bundle ID extends the app's ID (for example
`com.google.Chrome.helper`). Which process holds the mic for Chrome is **not verified**. The rule:
- An entry on a **Mac** list matches a session whose ID equals it, or starts with it followed by `.`
  (case-insensitive). So `com.google.Chrome` matches `com.google.Chrome.helper`.
- Windows entries keep exact-modulo-case matching (the 11-13 spec's R9). The prefix rule must not apply
  to them.
- `meetingLabel` and `isGatedProcess` (`src/lib/meeting-detect.ts`) apply the same rule, so a helper ID
  gets the right card label and the gated path. So does `isSameCall`
  (`src/lib/functions/meeting-auto-record.ts`), so a helper ID and its app ID count as the same call.
- The readout and `detection.log` always show the **raw** ID, never the folded one. That raw ID is how
  we learn the real identities.
- Nothing matches `com.apple.WebKit.*` (anti-goal 1). A test pins this.

How the rule is expressed (a separate Mac list type, a flag per entry, or the dot-prefix test applied
only to entries containing a `.` with no `.exe` suffix) is the builder's call. It has to be pure
cfg-free code tested on every platform.

### 5.3 Watch lists

Per-platform, chosen in the frontend (`currentWatchLists()`, `src/lib/meeting-detect.ts`), with
Windows' lists unchanged:

| | Windows (unchanged) | Mac |
|---|---|---|
| direct | `ms-teams.exe`, `Teams.exe`, `Zoom.exe` | none |
| gated | `chrome.exe` | `com.google.Chrome` (provisional, section 7) |

Label: Google Meet, as on Windows. The Chrome ID is provisional until the readout on the tester's Mac
confirms it (section 7). If Chrome's mic sits in a process the 5.2 rule can match, correcting it is a
constants change. If it doesn't (for example, no bundle ID at all), the matching needs a Rust change
before merge; the builder plans room for that.

With the direct list empty, the direct state machine on Mac simply never fires. That's intended, and
`tick` must keep working with one list empty (a test pins it).

### 5.4 Platform switches

- One helper (for example `isMeetingDetectionPlatform()`: Windows or macOS) replaces the three
  `isWindows()` gates: `useMeetingDetection.ts:35`, `useMeetingAutoRecord.ts:170`, `settings/index.tsx:44`.
- Rust: the six `cfg!(not(target_os = "windows"))` guards become "not Windows and not macOS".
  `UNSUPPORTED_PLATFORM` loses "only supported on Windows". The `#[cfg_attr(not(target_os =
  "windows"), allow(dead_code))]` attributes are adjusted so that clippy `-D warnings` stays clean on all
  three platforms.
- Toggle copy (`MeetingAutoRecordToggle.tsx:182-203`) becomes per-platform. Windows keeps its wording
  minus "Windows only". Mac names Google Meet in Chrome only (any Chrome mic use counts). Exact wording
  is the builder's call.

### 5.5 Old macOS: the toggle shows, the start fails visibly

Change from what I told the owner on 2026-11-19 ("hide the toggle"): the 11-13 spec's rule is kept. The
toggle is shown, and on a macOS that cannot do this, turning it on fails at once with a clear message.
- `start_meeting_watcher` **probes** before spawning: it reads the process list once. If Core Audio lacks
  the property, it returns an error naming the requirement. Auto-record also records through the
  system-audio process tap, so the feature's floor is the higher of the two APIs' floors. The message
  states that floor once the builder has verified it against Apple's headers (believed to be 14.2, but
  probe, don't hardcode a version check).
- `list_capture_sessions` returns the same error, so the readout says it too.
- The message **stays visible after the toggle flips itself off**. Today a start failure shows the
  generic toast "Could not turn on auto-record" (`useMeetingDetection.ts:267`) and flips the toggle off,
  which hides the note. It must never reach the poll loop, where 30 failed polls would replace it with
  "30 consecutive failed polls".

### 5.6 Permissions (Mac only)

An auto-start on Mac opens the mic (WebKit `getUserMedia`, `AutoSpeechVad.tsx:98`) and builds a
system-audio process tap (`speaker/macos.rs`). The first time, each raises a macOS permission prompt.
On Windows neither exists, and `useMeetingAutoRecord.ts:63` says the access check "cannot fail there".
On Mac it can.
- **Ask when the toggle is turned on, not mid-call.** On Mac, turning the toggle on triggers both
  permission requests while the user is looking at Settings. *(My call: otherwise the first detected
  call pops two system dialogs over the meeting.)*
- **On denial,** the toggle stays off and the note says which permission is missing, with a button that
  opens the matching System Settings pane (`request_system_audio_access` already opens the audio-capture
  pane; the mic pane needs its own URL).
- **Unverified:** whether a denied system-audio permission makes tap creation fail, or succeed and
  deliver silence. If silence, a denial can't be detected up front. Then the existing
  empty-transcription report in `useMeetingAudio` is the backstop, and the note's copy tells the user
  what to check. The builder confirms which on the tester's Mac.
- Reading the process list is believed to need no permission. Also unverified; the readout settles it.
- **Grants lost while the toggle stays on.** The Mac build has no Apple signing identity. If macOS ties
  the grants to each build's ad-hoc signature, every silent update drops them. A user can also revoke
  them in System Settings. *(My call:)* every watcher start on Mac (app launch with the toggle on, and a
  retry) first checks the **mic** grant without prompting, using the already-installed
  `tauri-plugin-macos-permissions` check. If the grant is missing, the watcher does not start. The toggle
  turns off with a note saying the permission was reset and asking the user to turn auto-record back on,
  which re-runs the toggle-on prompts. The **system-audio** grant has no public check that cannot prompt
  (`check_system_audio_access` builds a real tap), so it is not checked at start. A lost system-audio
  grant can still prompt mid-call. That is a known limit, and M2b below measures how often it happens.

### 5.7 CI

`ci.yml` has Linux and Windows jobs only (`ci.yml:89, 102-129`). Mac code is compiled only by
`publish.yml` at release. Add a `macos-latest` job running `cargo clippy ... -D warnings` and
`cargo test`, with the same pinned toolchain as the other jobs. The repo is public, so the macOS
minutes are free.

### 5.8 The Mac test build (from the 11-13 spec, section 7.5)

A manually triggered workflow (`workflow_dispatch`) builds the Mac app and uploads the `.dmg` as a
workflow **artifact**. It creates no release, does not touch `latest.json`, and reaches no other user.
GitHub only lets you dispatch a workflow whose file is on the default branch, so it lands as **its own
small PR to `main` first**. It then runs against the feature branch with `--ref`. Reuse `publish.yml`'s
macOS steps if that can be done cleanly. The build is unsigned; the tester opens it the way the release
notes say (`publish.yml:125`).

## 6. What the tester will see afterwards

- Settings → "Auto-record meetings" is present. Turning it on asks for mic and system-audio permission.
- With it on: joining a Google Meet call in Chrome starts recording within about 4-6 s, and the red card
  drops down from the bar, labelled Google Meet. When the call is on the Google Calendar, the card fills
  in the event's title and guests once the calendar read lands. That is the visible sign Google Calendar
  is working.
- Leaving the call stops the recording within about 10-20 s, and the "Recording saved" card shows.
- Teams, Zoom and Safari calls are not detected (non-goals).
- A recording started by hand looks the same as today: no calendar shown (a non-goal).

## 7. Order of work

1. **The test-build workflow PR** (section 5.8) to `main`. Kevin merges it.
2. **Feature branch:** sections 5.1 to 5.7, with the provisional Mac lists.
3. **Test DMG to the tester, readout first.** With auto-record **off** and a Meet call open in Chrome,
   the tester presses "Check microphone apps" and reports the raw IDs. This step records nothing, so it
   does not touch the capture path behind #114. Correct the Chrome ID from what it shows.
4. **Recording checks** (section 8, M2 onward), in the same live session that collects #114's evidence
   (Activity Monitor and `sample`, as #114 lays out). They run the capture path that lagged on this
   tester's Mac, so they may reproduce the lag. **A reproduced lag does not block the merge** (owner,
   2026-11-19); its evidence goes to #114.
5. Merge once the detection checks pass. Auto-record stays **off by default** on Mac, as on Windows.

## 8. Checks

**Automated, Rust** (pure, cfg-free; runs on the Linux and new macOS jobs, and locally on Windows):
- `classify` with Mac IDs: `com.google.Chrome` and a Chrome helper ID both matching the gated entry
  through the dot-prefix rule; `com.google.ChromeX` not matching; `com.apple.WebKit.GPU` never
  matching; the Windows R9 cases unchanged (no prefix rule on `.exe` entries).
- `tick` with an empty direct list and a live Chrome episode: the gated path behaves exactly as with a
  non-empty direct list.
- The 5.5 probe failure maps to the clear error (with the probe injectable or factored so it's testable
  without a Mac).

**Automated, Rust on the macOS CI job only:** `macos.rs` compiles under clippy `-D warnings`. If the runner
allows it, a smoke test that `enumerate_capture_sessions()` returns `Ok`.

**Automated, Vitest** (platform mocked to Mac):
- Both owners (`useMeetingDetection`, `useMeetingAutoRecord`) are active on Mac and still inactive on
  Linux.
- The toggle renders on Mac. `currentWatchLists()` returns the Mac lists on Mac and the unchanged
  Windows lists on Windows.
- `meetingLabel` and `isGatedProcess` handle helper IDs.
- An unsupported-macOS start error stays visible after the toggle flips off.
- Permission denial keeps the toggle off and names the missing permission.

**Manual, on the tester's Mac** (test DMG, Google connected):
- M1. Readout, auto-record off: with a Meet call open in Chrome, Chrome's mic process is listed with
  its raw ID, shown as watched. Meetwings' own mic (start a recording by hand, no call) is listed as not
  watched. Note every row's raw ID and PID for the later Safari work.
- M2. Turn the toggle on: both permission prompts appear now, not later.
- M2b. Install the next test DMG over the current one with the toggle on, then relaunch. Note whether
  the grants survived. If the mic grant is gone, the toggle is off with the "permission was reset" note.
  Note whether the system-audio prompt appears at the next call.
- M5. Instant Meet in Chrome (`meet.new`, no calendar event): records, card says Google Meet. Leave: stops
  within about 20 s.
- M6. Meet from a Google Calendar event: the card shows the event's title and guests.
- M7. Stay in a Meet call for 3 minutes, muting and unmuting: recording continues.
- M8. A recording started by hand with no call app open: no detection, no card.
- M9. During M5-M7, Activity Monitor is open and #114's evidence is collected. Lag here is recorded, not
  a failure of this work.

(M3 and M4, Teams and Zoom, were dropped with the Mac scope; the numbers are kept so the reports stay
comparable.)

**Manual, on Windows (Kevin):** one Teams call and one Meet call auto-record as before (regression).

## 9. Open, not blocking

- Which browser the tester uses for Meet. If Safari, they won't get auto-record from this work (see the
  Safari non-goal).
- Chrome's real bundle ID and which process holds the mic (settled by M1).
- The macOS floor, and how a denied system-audio permission behaves (settled by the builder and M2).

## 10. Left to the builder

- Function, type and helper names; how the 5.2 rule is expressed.
- Toggle and note copy, within 5.4 to 5.6.
- How the permission requests are triggered (5.6), and the mic settings-pane URL.
- How the test-build workflow shares steps with `publish.yml`.
- Test layout.
