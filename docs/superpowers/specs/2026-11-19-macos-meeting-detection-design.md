# Meeting detection on Mac (parity with Windows)

Status: design, sent to build by the owner via /ship (2026-11-19); spec review applied
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
  no bundle ID, or an empty one, falls back to its executable name (from the PID), or to `None` if that
  fails too, which feeds the existing `Unknown` path.
- **Only the list read can fail a poll.** A process can exit between the list read and its own
  `pid`/`bundle_id`/`is_running_input` reads (`hardware.rs:257-275`, each a separate `os::Result`). A
  failed `pid` or `is_running_input` read skips that process, as `win32.rs:109-117` skips a session
  whose PID can't be read. A failed or empty `bundle_id` read is **not** a skip: it counts as "no bundle
  ID" and takes the fallback above, as `win32.rs:125` turns a failed name lookup into `None`. Dropping
  it would hide exactly the process 5.3 worries about from the readout and `detection.log`.
- The step from raw per-process data (pid, bundle ID or none, executable name or none, running-input
  flag) to `Vec<SessionInfo>` is a pure, cfg-free function, unit tested on every platform (section 8).
  `macos.rs` only reads Core Audio and calls it.
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
- Every place that compares a session ID against a list entry or against another session ID applies the
  same rule, through one shared matcher per language:
  - Rust: `classify`, and `describe_sessions` (`mod.rs:1019-1025`), which decides the readout's
    "Watched" column with its own exact-match closure today. Without it a helper row would read "Not
    watched" while `classify` watches it, M1 would fail, and section 7 step 3 would "correct" a constant
    that was right.
  - TypeScript: `meetingLabel` and `isGatedProcess` (`src/lib/meeting-detect.ts`), so a helper ID gets
    the right card label and the gated path; `isSameCall` (`src/lib/functions/meeting-auto-record.ts`),
    so a helper ID and its app ID count as the same call; and the inline returning-call comparison in
    `onDetected` (`useMeetingAutoRecord.ts:813-818`, `g.endedProcess.toLowerCase() !==
    process.toLowerCase()`), which runs before `isSameCall`. Left exact, a call flapping between a helper
    ID and its app ID would read as a new call, skip the calendar read, and reset the conversation
    mid-call.
- **Two session IDs are the same call** when they are equal (case-insensitive) or both match the same
  list entry. `isSameCall` and the `onDetected` comparison compare two session IDs, not an entry and an
  ID, so the test must be symmetric: helper-then-app and app-then-helper are both the same call.
- The matcher is **case-insensitive on both sides**. `meetingLabel` and `isGatedProcess` lowercase only
  their input today (`meeting-detect.ts:22, 29`), so the mixed-case constant `com.google.Chrome` added
  verbatim would never match, and the card would lose its calendar event (`useGoogleMeetingCapture.ts:137`).
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
- `start_meeting_watcher` **probes** before spawning. Auto-record also records through the system-audio
  process tap, so the feature's floor is the higher of the two APIs' floors, and the probe covers
  **both**: the process-object list and the process-tap API. (Probing only the process list would let a
  macOS between the two floors pass, turn the toggle on, and then fail at tap creation on every call.)
  The builder confirms both floors from Apple's headers (believed 14.x and 14.2) and may probe only the
  higher one if the headers show it implies the other. Probe, don't hardcode a version check.
- **Unsupported vs. transient.** The "unsupported macOS" verdict comes only from a property-existence
  test (`has_prop` / `AudioObjectHasProperty`, `hardware.rs:47-50`). A read that fails on a supported
  macOS (for example, coreaudiod restarting) is an ordinary, retryable start error with its own wording,
  never "unsupported".
- The probe is one pure function, taking the platform reads as injectable inputs, and both
  `start_meeting_watcher` and `list_capture_sessions` call it, so the readout gives the same error. On
  failure the watcher is not spawned, and the error never reaches the poll loop, where 30 failed polls
  would replace it with "30 consecutive failed polls". The testable seam: the probe's result feeds a
  cfg-free start planner (as `plan_start` does today) and a shared inner function behind
  `list_capture_sessions`, so "not spawned" and "same error" are tested on every platform, not only the
  probe itself. Both commands take an `AppHandle` and return at the platform guard on Linux
  (`mod.rs:760-767, 1057-1058`), so the commands themselves can't carry the test.
- **Toggle-on runs the probe first** (Mac). The toggle-on path (5.6) asks the probe before any permission
  request. On an unsupported macOS it shows the "unsupported" note and prompts for nothing. Otherwise the
  tap-building system-audio request would fail first, `check_system_audio_access` would map that to
  `false` (`commands.rs:505-512`), and the user would get a mic prompt and a wrong "permission missing"
  note instead of the clear message.
- **The message stays visible after the toggle flips itself off.** Today that cannot happen. The start
  runs in the main window (`useMeetingDetection.ts:242-271`). Its catch shows only the generic toast
  "Could not turn on auto-record" (`:267`), and Settings, in another window and often not open at all
  (for example at app launch with the toggle on), receives only `{enabled:false}`
  (`MeetingAutoRecordToggle.tsx:110-115`). The note renders only while `isEnabled` is true (`:173-176`),
  and a pre-spawn `Err` never writes the watcher's `last_error` (`mod.rs:765-767, 793-795`). *(My call:)*
  a start failure is **persisted** as a small record in localStorage (a new `STORAGE_KEYS` entry: the
  message and a kind such as `unsupported`, `permission-reset` or `permission-denied`), and also carried
  as an optional reason in the `meeting-detection-setting-changed` payload. The toggle reads the record on
  mount and on that event, and renders the note when the record exists **regardless of `isEnabled`**.
  The next toggle-on clears it. The record and the note-while-off are **Mac only**. Windows' start
  catch (`useMeetingDetection.ts:258-269`, shared code) keeps today's toast-and-flip, so its behaviour
  does not change (section 2).

### 5.6 Permissions (Mac only)

An auto-start on Mac opens the mic (WebKit `getUserMedia`, `AutoSpeechVad.tsx:98`) and builds a
system-audio process tap (`speaker/macos.rs`). The first time, each raises a macOS permission prompt.
On Windows neither exists, and `useMeetingAutoRecord.ts:63` says the access check "cannot fail there".
On Mac it can.
- **Ask when the toggle is turned on, not mid-call.** On Mac, turning the toggle on triggers both
  permission requests while the user is looking at Settings. *(My call: otherwise the first detected
  call pops two system dialogs over the meeting.)*
- **Order at toggle-on (Mac).** Today `handleSwitchChange` saves `"true"` and emits
  `meeting-detection-setting-changed` at once (`MeetingAutoRecordToggle.tsx:133-145`), and the main window
  starts the watcher and sets `enabledRef` on that event (`useMeetingDetection.ts:242-271`,
  `useMeetingAutoRecord.ts:978-986`). On Mac the toggle-on path instead **awaits both requests before it
  saves or emits anything**. While they are pending the Switch is disabled (or a per-attempt token
  discards a stale result), so a late answer can never re-save `true` after the user flipped it off. A
  denial never emits `enabled: true`. Windows keeps today's immediate path, with no permission calls.
- **On denial,** the toggle stays off and the note says which permission is missing, with a button that
  opens the matching System Settings pane (`request_system_audio_access` already opens the audio-capture
  pane; the mic pane needs its own URL).
- **Unverified: which call raises the system-audio prompt.** No code path is known to raise it.
  `request_system_audio_access` only opens the Settings pane (`commands.rs:516-527`), and
  `check_system_audio_access` builds a tap (`macos.rs:58-59`) without creating the aggregate device or
  starting IO, which only happen in `start_device` (`macos.rs:136-138`). If building the tap alone does
  not prompt, the toggle-on request must briefly start the aggregate device's IO and then tear it down.
  The builder plans room for that; M2 settles it.
- **Unverified: what a denied system-audio permission does** — tap creation fails, or it succeeds and
  delivers silence. If it fails, the toggle-on request reports the denial like the mic's. If it delivers
  silence, a denial cannot be detected in this work. The existing empty-transcription report is **not** a
  backstop: it counts only segments where VAD already heard speech (`useMeetingAudio.ts:138-153`), and a
  silent tap produces none. *(My call:)* this work does not add a silence detector. The denial note's
  copy tells the user what to check, and M10 records which behaviour macOS shows. If it is silence, a
  follow-up issue designs a detector.
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
- **Where the start check lives.** Inside `startWatcher` (`useMeetingDetection.ts:98-99`), the one
  function both start paths use, so launch, toggle-on and retry all get it. Because toggle-on now waits
  for its prompts first (above), the check sees the fresh grant there and does not misfire.
  - macOS only, behind `isMacOS()` and a **dynamic** `import("tauri-plugin-macos-permissions-api")`, as
    `useCompletion.ts:2190-2195` does. A static import would break the Windows build.
  - Effect 3 tests `cancelled` only before `startWatcher()` today (`useMeetingDetection.ts:254-259`),
    and that flag is local to effect 3, out of `startWatcher`'s scope. The new `await` opens a gap, so
    effect 3 passes its cancel test into `startWatcher`, which re-tests it **between the check and the
    invoke**. No `start_meeting_watcher` invoke may follow a `cancelled` that flipped during the check;
    otherwise a start can fire after the user turned the toggle off and the cleanup's stop was queued.
  - **Retry path** (effect 1, `useMeetingDetection.ts:124-150`). Today a failed retry reports
    `watcher-restarted {ok:false}` and leaves the toggle on, so the Retry button stays reachable.
    *(My call:)* a missing mic grant is the one retry failure that turns the toggle off, with the
    "permission was reset" record (5.5), because retrying cannot restore a grant and toggle-on can.
    Every other retry failure keeps today's behaviour. This is new code on that path.

### 5.7 CI

`ci.yml` has Linux and Windows jobs only (`ci.yml:89, 102-129`). Mac code is compiled only by
`publish.yml` at release. Add a `macos-latest` job running `cargo clippy ... -D warnings` and
`cargo test`, with the same pinned toolchain as the other jobs. The repo is public, so the macOS
minutes are free.

The existing Mac-only code (`speaker/macos.rs`, the macOS blocks in `lib.rs`) has never been through
clippy `-D warnings`: the Linux job never parses cfg-gated modules (`ci.yml:94-99`), and `publish.yml`
only builds. The first macOS job run may fail on lints that predate this feature. The plan adds the job
first, against unchanged code, and fixes whatever it finds before the feature commits depend on it. The
full `cargo test` then runs on macOS too, so any existing test that asserts the old
`UNSUPPORTED_PLATFORM` text or relies on the stub is updated with the string change.

### 5.8 The Mac test build (from the 11-13 spec, section 7.5)

A manually triggered workflow (`workflow_dispatch`) builds the Mac app and uploads the `.dmg` as a
workflow **artifact**. It creates no release, does not touch `latest.json`, and reaches no other user.
GitHub only lets you dispatch a workflow whose file is on the default branch, so it lands as **its own
small PR to `main` first**. It then runs against the feature branch with `--ref`. A dispatch with `--ref`
runs the workflow file as it exists on that ref, so the feature branch must contain it too: merge or
rebase `main` into the feature branch after the workflow PR merges. It builds **both** architectures,
arm64 and x64, as `publish.yml:60-65` does, because the tester's chip is not yet known (#114 asks for it).
Reuse `publish.yml`'s macOS steps if that can be done cleanly. The build is unsigned; the tester opens it
the way the release notes say (`publish.yml:125`).

## 6. What the tester will see afterwards

- Settings → "Auto-record meetings" is present. Turning it on asks for mic and system-audio permission.
- With it on: joining a Google Meet call in Chrome starts recording within about 4-6 s, and the red card
  drops down from the bar, labelled Google Meet. When the call is on the Google Calendar, the card fills
  in the event's title and guests once the calendar read lands. That is the visible sign Google Calendar
  is working.
- Leaving the call stops the recording within about 15-25 s, and the "Recording saved" card shows. An
  auto-started recording is the open-mic path, which waits out the gated end debounce (5 polls, about
  10 s) and then the `CALL_END_GRACE_MS` grace (5 s, `constants.ts:230`) before it stops
  (`useMeetingAutoRecord.ts:931-943`); only a transcribing session stops at once. Chrome's own delay in
  releasing the mic adds to that.
- Teams, Zoom and Safari calls are not detected (non-goals).
- A recording started by hand looks the same as today: no calendar shown (a non-goal).

## 7. Order of work

1. **The test-build workflow PR** (section 5.8) to `main`. Kevin merges it.
2. **Feature branch:** sections 5.1 to 5.7, with the provisional Mac lists. The macOS CI job goes in
   first, against unchanged code (5.7). Merge `main` in after step 1 so the branch carries the workflow.
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
- `describe_sessions` with Mac IDs: a Chrome helper row has `kind == "gated"` and keeps its raw name;
  a `com.apple.WebKit.*` row is "ignored".
- The 5.1 mapping function: a missing, empty or failed-to-read bundle ID falls back to the executable
  name, then to `None`, and the process stays listed; a process not running input is left out; a failed
  `pid` or `is_running_input` read skips only that process.
- `tick` with an empty direct list and a live Chrome episode: the gated path behaves exactly as with a
  non-empty direct list.
- The 5.5 probe, through the seam 5.5 names, with injected reads: a missing property gives the
  "unsupported" error and the start planner says **don't spawn**; a failed read on a supported system
  gives the retryable error, never "unsupported"; the shared inner function behind
  `list_capture_sessions` returns the same error. A test of an error-mapping helper alone is not enough,
  because it passes with the wiring broken.

**Automated, Rust on the macOS CI job only:** `macos.rs` compiles under clippy `-D warnings`. If the runner
allows it, a smoke test that `enumerate_capture_sessions()` returns `Ok`. That smoke test proves only that
the calls link and run; a runner with no mic user returns an empty list, so it says nothing about
correctness. The mapping tests above carry that.

**Automated, Vitest** (platform mocked to Mac):
- **Platform mock first.** The existing owner and settings tests mock `@/lib/platform` with factories
  that lack the new helper: `useMeetingAutoRecord.auto-stop.test.tsx:42, 553`,
  `useMeetingAutoRecord.lifecycle.test.tsx:37, 466, 486` and `useMeetingDetection.lifecycle.test.tsx:26`
  expose only `isWindows`, and `settings-page.meeting-auto-record.test.tsx:6-8` exposes `isWindows` and
  `isMacOS`. Once the gates and `startWatcher` call the new helper or `isMacOS()`, those tests break. The
  plan updates them to a three-state platform mock (Windows / Mac / Linux), keeping every Windows case
  passing unchanged.
- Both owners (`useMeetingDetection`, `useMeetingAutoRecord`) are active on Mac and still inactive on
  Linux.
- The toggle renders on Mac. `currentWatchLists()` returns the Mac lists on Mac and the unchanged
  Windows lists on Windows.
- The shared TS matcher, through `meetingLabel`, `isGatedProcess`, `isSameCall` and the `onDetected`
  returning-call comparison: a helper ID matches its app entry and is the same call as its app ID, in
  both directions (helper then app, app then helper);
  `com.google.ChromeX` matches nothing; `com.apple.WebKit.*` matches nothing; the mixed-case constant
  `com.google.Chrome` matches; `.exe` entries keep exact matching (`chrome.exe.foo` does not match
  `chrome.exe`).
- An unsupported-macOS start error: after the toggle flips off, the note shows **that error's text**
  (not only a toast), including in a Settings window mounted after the failure; the readout shows the
  same error. On Windows a start failure still only toasts and flips, with no lasting note.
- Permissions, with the permission plugin mocked:
  - toggle-on on Mac runs the probe first: on an unsupported macOS it shows the "unsupported" note and
    makes no permission request;
  - otherwise toggle-on on Mac requests both permissions before anything is saved or emitted;
  - a denial keeps the toggle off, emits no `enabled: true`, and names the missing permission;
  - flipping the toggle off while the requests are pending never re-saves `true`;
  - at a watcher start on Mac with the mic grant missing, `start_meeting_watcher` is never invoked, the
    toggle turns off, and the "permission was reset" note shows; the same on the retry path;
  - Windows makes no permission calls on either path.

**Manual, on the tester's Mac** (test DMG, Google connected):
- M1. Readout, auto-record off: with a Meet call open in Chrome, Chrome's mic process is listed with
  its raw ID, shown as watched. Meetwings' own mic (start a recording by hand, no call) is listed as not
  watched. Note every row's raw ID and PID for the later Safari work.
- M2. Turn the toggle on: both permission prompts appear now, not later. Note which call raised the
  system-audio prompt (5.6).
- M2b. Install the next test DMG over the current one with the toggle on, then relaunch. Note whether
  the grants survived. If the mic grant is gone, the toggle is off with the "permission was reset" note.
  Note whether the system-audio prompt appears at the next call.
- M5. Instant Meet in Chrome (`meet.new`, no calendar event): records, card says Google Meet. Leave: stops
  within about 25 s (the open-mic path, debounce plus grace, section 6).
- M6. Meet from a Google Calendar event: the card shows the event's title and guests.
- M7. Stay in a Meet call for 3 minutes, muting and unmuting: recording continues.
- M8. A recording started by hand with no call app open: no detection, no card.
- M9. During M5-M7, Activity Monitor is open and #114's evidence is collected. Lag here is recorded, not
  a failure of this work.
- M10. Last, after every other check: revoke system-audio permission in System Settings, then join a Meet
  call with the toggle on. Note whether tap creation fails (a visible error) or recording runs with the
  other side silent. The answer decides whether a silence detector follow-up is needed (5.6). Re-grant
  system audio afterwards.

(M3 and M4, Teams and Zoom, were dropped with the Mac scope; the numbers are kept so the reports stay
comparable.)

**Manual, on Windows (Kevin):** one Teams call and one Meet call auto-record as before (regression).

## 9. Open, not blocking

- Which browser the tester uses for Meet. If Safari, they won't get auto-record from this work (see the
  Safari non-goal).
- Chrome's real bundle ID and which process holds the mic (settled by M1).
- The macOS floor (settled by the builder from the headers), which call raises the system-audio prompt
  (M2), and how a denied system-audio permission behaves (M10).

## 10. Left to the builder

- Function, type and helper names; how the 5.2 rule is expressed.
- Toggle and note copy, within 5.4 to 5.6.
- How the permission requests are triggered (5.6), and the mic settings-pane URL.
- How the test-build workflow shares steps with `publish.yml`.
- Test layout.
