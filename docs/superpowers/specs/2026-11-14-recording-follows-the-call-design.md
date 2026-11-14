# Recording follows the call: always-on meeting mode, auto-stop, Ask icon

Date: 2026-11-14. Branch: `feat/recording-follows-the-call` (based on main 159fdb4).

## Why

The user only ever records **calls** (Teams, Google Meet in Chrome). They never record in-person meetings.

Three things go wrong today:

1. **Forgotten mic records the room.** After a call the mic stays on and transcribes
   people talking in the same room. Real data, 2026-10-27: a call ran 9:01-9:50, the mic
   stayed on until ~20:00, and that produced **20 extra `meeting_log_queue` rows** (0-35
   min each, 10-40 min apart) that the user deleted by hand. Same pattern on 10/26, 10/29,
   11/3, 11/10. Auto-record already stops the mic on `meeting-ended`, but only when it
   opened the mic itself (`decideOnEnded` returns `"ignore"` when `startedModeRef` is
   null, `src/hooks/useMeetingAutoRecord.ts:501-511`). A mic the user opened, or that was
   already open when the call began, is never stopped.
2. **Meeting mode loads off.** The pill's record button turns meeting mode off when it
   stops (`src/hooks/usePillRecordAction.ts:82-84`), the value is persisted
   (`src/hooks/useCompletion.ts:174-204`), so the next launch starts with meeting mode off
   and the mic auto-submits speech to the AI as questions.
3. **The Ask box is cramped** to a ~40 px stub showing "Ask" between the mic and the
   system-audio buttons.

A speech-silence timer alone cannot fix (1): room chatter is speech. The call ending is the
signal.

## Goals

### G1. Meeting mode is always on
- Remove the meeting-mode toggle from the overlay (`MeetingAssistToggle`, rendered at
  `src/pages/app/components/completion/index.tsx:275`).
- `meetingAssistMode` is `true` from first render regardless of any stored
  `meeting_assist_mode_enabled` value, and no production code sets it to `false`.
- The record button (pill and overlay mic button) only opens/closes the mic (`enableVAD`).
  It never touches meeting mode.
- **The meeting-end signal moves with it.** Today two things hang off meeting mode's
  true->false edge: the unsaved-transcript flush in `setMeetingAssistMode`'s wrapper
  (`useCompletion.ts:563-578`) and the meeting-log "pill-off" trigger
  (`src/hooks/useMeetingLog.ts:589-594`). Both must instead fire on the **recording
  true->false edge** (`meetingAssistMode && enableVAD`), whoever closed the mic: the user,
  auto-stop (G2), or auto-record. Flush first, then trigger, so the row includes the tail.

### G2. Recording stops when the call ends
- On `meeting-ended`, if the mic is open, start a **2-minute grace timer**. When it fires,
  close the mic the same way auto-record's `stop-meeting` path does (flush, `setEnableVAD(false)`,
  confirm), **regardless of who opened the mic**.
- A `meeting-detected` during the grace cancels the timer; recording continues with no
  interruption and no new "recording" card. (Detection drops out mid-call; the memory note
  measured 9-13 sessions in one call, and nobody has measured how long a dropout lasts.)
- **Any new other-side transcript line (system audio, `audio_source = 'system'`) restarts
  the 2-minute grace.** The call's far end only arrives via system audio, while room chatter
  only arrives via the mic, so a forgotten mic still stops 2 minutes after the far end goes
  quiet, but a detection dropout, a long self-mute, or a Meet call running past its calendar
  slot (which the Chrome gate will not re-detect, `src/lib/meeting-detect.ts:60-61`) does not
  cut a live call.
- The user stopping or starting the mic during the grace cancels the timer.
- This replaces today's immediate stop on `meeting-ended` for auto-started recordings: all
  call-end stops wait the grace.
- `meeting-ended` no longer fires the meeting-log trigger directly
  (`useMeetingLog.ts:569`). The row is cut when recording actually stops (G1's edge), so
  a detection blip no longer splits one call into two rows.
- The 5-minute idle meeting-log trigger (`useMeetingLog.ts:632-636`) does **not** arm while
  recording. It still arms once the mic is closed, as the safety net it is today. Net
  effect: a call produces one row, cut when recording stops; a mid-call silence no longer
  splits it.
- Add Zoom: `Zoom.exe` to `MEETING_DETECT_PROCESSES` (direct, not gated) with a "Zoom"
  label in `MEETING_DETECT_LABELS` (`src/config/constants.ts:97-110`). The user uses Zoom
  occasionally and asked for no more than low effort; if anything beyond the one-line list
  entry turns out to be needed, skip Zoom and say so.

### G3. Silence backup
- While recording, if no new transcript entry has arrived for **15 minutes** (counting from
  the later of: recording start, newest entry), stop recording the same way, regardless of
  whether a call is detected. Covers a mic opened with no call running, and platforms with
  no detection watcher (macOS/Linux).

### G4. Scraps never become meeting rows
- A transcript slice spanning **under 60 seconds, or with fewer than 3 lines**, is not
  written as a `meeting_log_queue` row by the **live trigger** (`useMeetingLog.ts` `trigger`,
  before `insertQueueRow`, for all of its callers) or by **startup recovery**
  (`runMeetingRecovery`). With G2's changes the live trigger only cuts at a real recording
  stop or after the mic has been closed for 5 minutes, so a short slice there is a genuine
  scrap (a mic opened and closed by accident, a few words after hanging up), not the edge
  of a longer call.
- A deliberate stop/start with the record button mid-call is a meeting end: it cuts a row,
  as the pill does today. Accepted. The skipped
  span must be consumed (advance the skip watermark, as `skipUnwritten()` does), so it is
  never glued onto the next meeting's row.
- Manual "Send to Odoo" / "Send to Notion" on a conversation (`enqueueConversation`,
  `sendConversationToNotion`) stay unfiltered: the user asked explicitly.
- The messages themselves stay in the conversation; only the queue row is skipped.

### G5. Clear live / stopped signal
- While recording, the record button reads unmistakably as live (red, pulsing); idle reads
  plain. If the current styling already does this, leave it.
- When recording stops on its own (G2 or G3), the overlay shows a short notice for a few
  seconds: **"Recording stopped - call ended"** or **"Recording stopped - 15 min of
  silence"**. Reuse the meeting-cards `ended` card (`src/lib/meeting-cards.store.ts`,
  `autoRecordingStopped` / `setCard`), adding the reason; it must also show for mics the
  user opened by hand (today the card only exists for auto-record sessions).
- A user-initiated stop shows no notice.
- **Every stop (auto or user) closes the transcript panel** so the overlay shrinks back to
  the slim bar, as stopping does today. Today that happens because meeting mode turns off
  (`isPopoverOpen`, `useCompletion.ts:2062-2068`); with meeting mode always on, use the
  existing hide flag (`meetingPanelHidden`, from the issue #72 fix) or equivalent. The
  transcript is not cleared; opening the Ask icon shows it again, and the next recording
  start shows it again.

### G6. Ask box collapses to an icon
- In place of the input, a small chat icon button. It expands to the input, focused, on:
  a click on the icon, or the `focus-text-input` event from Rust (sent for both Ctrl+Shift+I
  and the show-window shortcut, `src-tauri/src/shortcuts.rs:212, 247, 664`; no Rust change).
  Other programmatic focus calls (after each AI answer, `useCompletion.ts:1109, 1282, 1943`;
  Ctrl+K, `:2171`) do **not** expand it; simplest is that the input is not mounted while
  collapsed, so those calls are no-ops. `registerInputRef` (`:2447`) must tolerate that.
- Expanded, the input takes the space of the controls between the record button and the
  right-hand window controls (contact picker, screenshot, files) and covers or hides them
  while open. The record button and the system-audio button stay visible, so the live
  signal (G5) is always on screen; settings, drag and minimize stay too.
- It collapses back to the icon when the input is **empty, not focused, and not loading**.
  Typed-but-unsent text keeps it open.
- Everything the input does today keeps working: typing and Enter to submit, paste
  (screenshots/files), the conversation-thread indicator, quick actions, and the
  transcript/answer popover, which is anchored to the input today (`PopoverTrigger`,
  `src/pages/app/components/completion/Input.tsx:104-115`) and must still open below the
  pill when the input is collapsed (e.g. a new transcript line or AI response arrives).

## Non-goals
- In-person meeting recording.
- Changing the 30-minute conversation gap (`MEETING_CONVERSATION_GAP_MS`), the 5-minute
  idle trigger's duration (`IDLE_FLUSH_MS`; only its arming changes, G2), or the Rust
  detection debounce.
- Detecting Meet/Teams in Edge or other browsers.
- Settings UI for the grace, silence or scrap thresholds (constants only).
- Deleting the now-unreachable non-meeting-mode pipeline (mic auto-submitting to the AI).
  Leave it unless removal is trivial and safe.
- The RAM leaks (VAD session per mic start, dashboard loading every message, untrimmed
  transcript) and the Outlook token fix: separate work.

## Anti-goals (fails even if it "works")
- A detection blip mid-call stops a real call's recording.
- Auto-stop loses the transcript tail (must flush before the mic closes).
- A skipped scrap reappears glued to the next meeting's row.
- Stopping recording (any path) clears the selected Odoo/Notion targets or starts a new
  conversation. Issue #72's history: wiping targets mid-meeting is the bug users notice most.
- Two meeting-log rows for one stop (the mic-off edge plus some leftover trigger).

## Constraints and known facts
- Detection runs only on Windows, only while the Auto-record setting is on (the user has it
  on), polls every 2 s, and emits `meeting-ended` after 3 inactive polls
  (`src-tauri/src/meeting_detect/mod.rs:86-88, 382`). Watched apps: `ms-teams.exe`,
  `Teams.exe` directly, and `chrome.exe` gated on a current Google Meet calendar event
  (`src/config/constants.ts:97, 112`). Zoom is not watched.
- Meetwings' own mic capture runs in a WebView2 child process, which the self-detection
  guard does not cover (issue #33). That is latent because `msedgewebview2.exe` is not on any
  watch list; don't add it.
- `useMeetingAutoRecord` is heavily commented about ref-mirror timing (layout vs passive
  effects), StrictMode double-mount, and an op chain that serializes capture commands. New
  timers and listeners must follow the same patterns (cancelled flags on async `listen`,
  cleanup on unmount, enqueue through the chain rather than calling capture commands
  directly).
- The quiet-restart window in `meeting-cards.store.ts` (`RESTART_QUIET_MS`) exists for
  auto stop -> re-detect; it should keep working, but with the grace it will rarely matter.
- Tests: Vitest, scoped runs (full-suite has known flakes). Test files are not
  type-checked by `npm run type-check` (tsconfig excludes `src/tests`). Many tests call
  `setMeetingAssistMode(true)`; whether the setter survives is the builder's call.
- No Rust changes are expected.

## Left to the builder
- Where the grace and silence timers live (likely `useMeetingAutoRecord` for the grace, as
  it already owns `meeting-ended` handling; the silence timer near `useMeetingLog`'s
  `newestEntryAt` or in the same hook).
- How the `ended` card learns the stop reason, and the exact notice styling.
- The chat icon and expand/collapse animation; how the popover is anchored when collapsed.
- Whether to delete `setMeetingAssistMode`, the persistence effect and the toggle component
  outright or leave inert pieces.

## Decided with the user
- Calls only (Teams desktop, Meet in Chrome, occasionally Zoom); no in-person recording.
- Meeting mode always on; toggle removed.
- 2-minute call-end grace; 15-minute silence backup; scraps under 1 minute skipped.
- Stop notice on the overlay (not a Windows toast).
- Every stop closes the transcript panel.
- Ask box becomes an icon that folds back when empty and unfocused.

## Calls made without the user (check these)
- 3-line minimum alongside the 60 s scrap rule ("under 1 min or only a few lines").
- Other-side (system audio) lines restart the call-end grace.
- `meeting-ended` stops firing the meeting-log trigger directly, and the idle trigger
  doesn't arm while recording (one row per call).
- Silence timer runs even during a detected call (15 min is above the longest measured
  in-call silence, 13 min).
- Manual Send-to-Odoo/Notion stays unfiltered.
- The show-window shortcut also opens the Ask box (it shares Rust's event with Ctrl+Shift+I).
- Expanded Ask box covers picker/screenshot/files; record and system-audio buttons stay.
