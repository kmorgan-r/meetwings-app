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
   null, `src/lib/functions/meeting-auto-record.ts:91-96`, and `handleStop` returns early
   on it, `src/hooks/useMeetingAutoRecord.ts:501-511`). A mic the user opened, or that was
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
- Copy that names the removed toggle changes: `useMeetingAutoRecord.ts:64` ("Turn the
  Meeting pill off to end it.") must instead point at the record button.
- **The meeting-end signal moves with it.** Today two things hang off meeting mode's
  true->false edge: the unsaved-transcript flush in `setMeetingAssistMode`'s wrapper
  (`useCompletion.ts:566-587`, flush at 580-584) and the meeting-log "pill-off" trigger
  (`src/hooks/useMeetingLog.ts:589-594`). Both must instead fire on the **recording
  true->false edge**, whoever closed the mic: the user, auto-stop (G2/G3), or auto-record.
  - **One derived value:** `recording = meetingAssistMode && enableVAD`, computed in
    `useCompletion`. `useMeetingLog` receives it in place of `meetingAssistMode` (it has no
    `enableVAD` input today, `useMeetingLog.ts:150`).
  - **Edge detection pattern:** every detector of this edge compares before it assigns, in
    one layout effect (the `useMeetingLog.ts:580-594` pattern). Never a passive effect: a
    passive compare after a layout mirror is a permanently dead trigger
    (`useMeetingLog.ts:580-588`), and the passive pattern at `useCompletion.ts:1554-1559`
    must not be copied for this.
  - **No edge on mount or remount**: the edge ref is seeded from the first render's value.
  - **A stop and a start batched into one commit is no edge.** Accepted: no row is cut and
    no flush runs for it.
  - **Order of flush and trigger does not matter for the row.** The trigger copies the
    in-memory transcript (`useMeetingLog.ts:350-352, 450`); the flush only writes the DB
    copy that remount and startup recovery read. Both run on the edge.
  - **Exactly one flush per stop.** Today an auto-record stop already flushes in
    `handleStop` (`useMeetingAutoRecord.ts:526`) and in the ownership layout effect's
    release branch (`useMeetingAutoRecord.ts:182`); back-to-back flushes can overlap and
    write a duplicate save (the "second flush sees `unsavedCount <= 0`" argument at
    `:197-200` only holds once the first save resolved). With the edge flush in place,
    either remove those two flushes or make `flushUnsavedMeetingTranscript` single-flight.
  - **STT tail.** Speech-to-text requests still in flight when the mic closes land after
    the cut. Accepted: the trigger does not wait for them. Such a line stays in the
    conversation; it is not added back to the row that was just cut.

### G2. Recording stops when the call ends
- On `meeting-ended`, if the mic is open, start a **2-minute grace timer**. When it fires,
  close the mic **regardless of who opened it**.
  - **The grace stop does not consult `decideOnEnded`** and needs no `startedModeRef`
    provenance: it is its own op (or a new `handleStop` mode) that clears provenance,
    calls `setEnableVAD(false)` and confirms the stop like the `stop-meeting` path
    (`useMeetingAutoRecord.ts:522-536`). It is enqueued on the op chain
    (`useMeetingAutoRecord.ts:290-298`), never run directly. Flushing is left to G1's edge.
  - **The row a grace stop cuts ends at the call's end**, not at the stop: its cap is the
    later of the `meeting-ended` time and the newest system-audio line's timestamp. Lines
    after the cap (mic-only room talk during the grace) are consumed, not written, so they
    never reach a customer-visible note (`src/lib/odoo/meeting-log.ts:116-118`), the next
    meeting's row, or a recovered row. They stay in the conversation.
    - **Consumed for real:** the queue watermark is `MAX(transcript_end_at)`
      (`meeting-log.ts:161-162`) and a written row sets no skip mark
      (`useMeetingLog.ts:518-521`), while recovery reads only the queue watermark
      (`meeting-log-recovery.ts:150-179`). So the capped row is written with
      `transcript_end_at` = the consumed end (G4's definition: the newest timestamp the
      trigger read), and only the lines up to the cap are rendered into it.
    - **Channel:** `trigger` fires on G1's edge whoever stopped the mic, so it must learn
      "this stop is a grace stop, cap at T". The grace stop sets that cap in a shared value
      before `setEnableVAD(false)`, and the next trigger reads and clears it. The builder
      picks the channel (a ref passed through `useCompletion`, or a small module store),
      but it must be named in the plan and cleared on every trigger so a stale cap never
      applies to a later stop.
- **Cancelling and restarting the grace:**
  - A `meeting-detected` during the grace for the **same call** cancels the timer;
    recording continues with no interruption and no new "recording" card. (Detection drops
    out mid-call; 9-13 detection sessions have been measured in one call, and nobody has
    measured how long a dropout lasts.)
  - **Same call** means the same process and the same current calendar event as at
    `meeting-ended`. A detection that differs in either is a **new call** (back-to-back
    calls usually start within 2 minutes).
    - **Process:** the `meeting-ended` handler gets no payload
      (`useMeetingAutoRecord.ts:622-625`), so the process "at `meeting-ended`" is the last
      `meeting-detected` payload's process (`:618-619`). Unknown (for example a call
      already running at launch, `:100-101`) counts as the same call.
    - **Current calendar event** at a moment: the event whose slot `[start, end)` contains
      it, without the early-join allowance; if two do, the later-starting one; none if none.
      Both none counts as the same; an unreadable calendar counts as the same.
    - The same/new decision needs an async calendar read, so it runs as an op on the chain,
      not inside the listener.
    - **New call:** the grace stop runs at once, cutting call A's row (the edge trigger
      snapshots A's targets synchronously, `useMeetingLog.ts:352-353`). Then, still before
      B's start, a **new conversation starts**, which clears the targets
      (`useCompletion.ts:1540-1541`, `completion/index.tsx:75-76`). Without it B would join
      A's conversation, because the new-conversation rule is gap-based (30 min,
      `useCompletion.ts:1544-1553`), and auto-select runs once per fresh meeting capture
      (`completion/index.tsx:94-96`), so B's row could carry A's targets. This is a
      new-call start action, not part of the stop, so G5's "targets survive every stop"
      still holds for the stop itself. Then the detection is handled as a fresh one,
      enqueued behind the stop, so it sees the mic closed and starts a new recording with
      calendar auto-select as today. The new-call stop does not open the quiet-restart
      window (it stops with `auto: false`, `meeting-cards.store.ts:163`), or B would take
      the quiet branch (`:130-139`) and inherit A's card start time and event.
  - **Any new other-side transcript line (`audioSource === 'system'`) restarts the
    2-minute grace.** The call's far end only arrives via system audio, while room chatter
    only arrives via the mic, so a forgotten mic still stops 2 minutes after the far end
    goes quiet, but a detection dropout, a long self-mute, or a Meet call running past its
    calendar slot (which the Chrome gate will not re-detect, `src/lib/meeting-detect.ts:60-61`)
    does not cut a live call.
  - "New" is counted by **arrival**, not by the entry's `timestamp`: some entries are
    appended with caller-supplied timestamps (`useCompletion.ts:681-696`), so array order
    and timestamps are not arrival order. System lines are appended at
    `useCompletion.ts:784-817`. Only system lines appended after the grace was
    armed count; mic lines never restart it. `useMeetingAutoRecord` takes no transcript
    today (`useMeetingAutoRecord.ts:77-90`), so it gains an input for this (for example a
    layout-mirrored count or arrival stamp of system lines, so the effect is not re-run on
    every entry).
  - The user stopping or starting the mic during the grace cancels the timer (any
    `enableVAD` change).
  - Turning Auto-record off (`meeting-detection-setting-changed`) or `meeting-watcher-stopped`
    cancels a running grace.
- **Grace timer lifecycle:** the timer lives in a ref; it is cleared on unmount, on every
  cancel above, and on re-arm (a second `meeting-ended` never stacks timers). Its fire
  callback re-reads `enableVADRef` (no-op if the mic is already closed) and enqueues the
  stop. The queued stop re-checks a grace generation counter when it runs, so a
  same-call detection (decided on the chain, above) or a system line arriving between the
  fire and the queued op still cancels it. A new-call detection never cancels the stop: it
  lets the stop run, then starts fresh. Under StrictMode double-mount there is exactly one live timer.
- This replaces today's immediate stop on `meeting-ended` for auto-started recordings: all
  call-end stops wait the grace.
- **Meeting-log triggers:**
  - `meeting-ended` no longer fires the meeting-log trigger directly
    (`useMeetingLog.ts:569`) **while recording**. The row is cut when recording actually
    stops (G1's edge), so a detection blip no longer splits one call into two rows.
  - `meeting-ended` **still fires the trigger when the mic is closed**. That covers a
    `<Completion />` remount mid-call (documented reachable,
    `useMeetingAutoRecord.ts:103-113`): after it, `enableVAD` starts false and
    `newestEntryAt` is 0, so neither the edge nor the idle trigger would ever write the
    row, while the trigger's DB-recovery union (`useMeetingLog.ts:422-447`) still can.
  - On unmount with the mic open, the unsaved transcript is flushed whoever opened the mic
    (today only auto-started sessions are, `useMeetingAutoRecord.ts:575-583`), so recovery
    has the lines.
  - The 5-minute idle meeting-log trigger (`useMeetingLog.ts:632-636`) does **not** arm
    while recording. It still arms once the mic is closed, as the safety net it is today.
    Net effect: a call produces one row, cut when recording stops; a mid-call silence no
    longer splits it.
- **Platform:** the grace is Windows-only, because `meeting-ended` only exists there. It
  sits behind `useMeetingAutoRecord`'s existing owner gate (`label === "main" &&
  isWindows()`, `useMeetingAutoRecord.ts:126-129, 602-604`).
- Add Zoom: `"Zoom.exe"` to `MEETING_DETECT_PROCESSES` (direct, not gated) with a
  `"zoom.exe": "Zoom"` entry in `MEETING_DETECT_LABELS` (`src/config/constants.ts:97-106`;
  the label key must be lowercase, because the lookup lowercases the process name,
  `src/lib/meeting-detect.ts:33-37`). The user uses Zoom occasionally and asked for no more
  than low effort. Manual check: Zoom open with no call must not emit `meeting-detected`.
  If it does, or if anything beyond the list entries turns out to be needed, drop Zoom and
  say so.

### G3. Silence backup
- While recording, if no new transcript entry has arrived for **15 minutes** (counting from
  the later of: recording start, the **arrival** of the newest entry), stop recording the
  same way as G2, regardless of whether a call is detected. Covers a mic opened with no
  call running, and platforms with no detection watcher (macOS/Linux).
- **Arrival, not `timestamp`:** `newestEntryAt` is the MAX of caller-supplied timestamps
  (`useMeetingLog.ts:599-609`), and the transcript is session-wide, so lines from an
  earlier call or a backdated line could pin it in the past and stop a live call at once.
  The timer restarts whenever an entry is appended (wall clock at append), and starts at
  recording start, ignoring entries that were already there.
- **Platform gate:** the silence timer, and the shared stop routine it calls, are gated on
  the main-window label only, **not** `isWindows()` (as `useMeetingLog` is,
  `useMeetingLog.ts:168-171, 186`). Only the detection listeners keep the Windows gate.
- **Known limitation:** any entry restarts the timer, including room talk on the mic. A
  forgotten mic in a talking room therefore stops only through G2, which needs Windows with
  Auto-record on. On macOS/Linux, or with Auto-record off, G3 only stops a mic in a quiet
  room. Accepted: the user runs Windows with Auto-record on.

### G4. Scraps never become meeting rows
- **The scrap rule:** a slice is a scrap when, measured on the slice actually about to be
  written (after the DB-recovery union and the watermark filter),
  `endAt - startAt < 60_000` **or** it has fewer than 3 entries. Exactly 60 s, or exactly
  3 lines, is kept.
- **Live trigger** (`useMeetingLog.ts` `trigger`, before `insertQueueRow`, for all of its
  callers): a scrap writes no row and advances the skip watermark to the **consumed end**,
  so it is never glued onto the next meeting's row. The consumed end is the newest
  timestamp across everything the trigger read: the in-memory snapshot plus the DB
  recovery union, before any G2 cap. That is not what `skipUnwritten()` uses today
  (`consumedTo` is the newest timestamp in the in-memory snapshot only,
  `useMeetingLog.ts:372-375`); after a remount that snapshot is empty, and a scrap
  recovered from the DB (`:430-450`) would never be consumed. No "could not be queued" toast, no `insertQueueRow`,
  no Outlook read for it. With G2's changes the live trigger only cuts at a real recording
  stop, a `meeting-ended` with the mic closed, or after the mic has been closed for 5
  minutes, so a short slice there is a genuine scrap (a mic opened and closed by accident,
  a few words after hanging up), not the edge of a longer call.
- **Startup recovery** (`runMeetingRecovery`) still splits at 5-minute silences
  (`meeting-log-recovery.ts:195`), and in-call silences reach 13 minutes
  (`meeting-log-actions.ts:596-598`), so a short recovery segment can be the edge of a real
  call. Recovery therefore first merges any segment under the thresholds into its nearer
  neighbour in the same conversation group, and only skips a scrap that has no neighbour.
  Recovery deliberately ignores the skip watermark (`meeting-log-recovery.ts:150-179`) and
  writes none: a skipped lone scrap is re-read and skipped again on later launches inside
  the recovery window, which is harmless.
- A deliberate stop/start with the record button mid-call is a meeting end: it cuts a row,
  as the pill does today. Accepted.
- Manual "Send to Odoo" / "Send to Notion" on a conversation (`enqueueConversation`,
  `sendConversationToNotion`) stay unfiltered: the user asked explicitly.
- The messages themselves stay in the conversation; only the queue row is skipped.

### G5. Clear live / stopped signal
- While recording, the record button reads unmistakably as live (red, pulsing); idle reads
  plain. If the current styling already does this, leave it.
- **Stop notice.** When recording stops on its own (G2 or G3), the overlay shows a short
  notice for a few seconds: **"Recording stopped - call ended"** or **"Recording stopped -
  15 min of silence"**. The existing ended card cannot do this as is: `autoRecordingStopped`
  returns early when there is no `active` auto session (every hand-opened mic,
  `src/lib/meeting-cards.store.ts:159`), shows the card only after `ENDED_CARD_DELAY_MS`
  (30 s, `:8, 168-179`), arms it for user stops too, has no reason field (`:28`), and
  `setCard` is not exported (`:91`). So:
  - The store gains an exported stop-notice entry point taking the reason. It shows the
    `ended` card (with the reason) **immediately**, for `ENDED_CARD_MS` (5 s), with no
    `active` requirement.
  - `autoRecordingStopped` no longer arms the delayed ended card in either case: the
    notice replaces it for auto stops, and a user stop shows nothing. It keeps managing
    `active` and the quiet-restart window (`RESTART_QUIET_MS`) as today.
  - `autoRecordingStarted` replaces a showing notice with the recording card. Its quiet
    branch (`meeting-cards.store.ts:130-139`) returns before `setCard` today, so it must
    clear a showing stop notice itself.
  - An amber card keeps precedence: if one is showing, the notice is not shown (same rule
    as `:172`).
- A user-initiated stop shows no notice.
- **Every stop (auto or user) closes the transcript panel** so the overlay shrinks back to
  the slim bar, as stopping does today. Today that happens because meeting mode turns off
  (`hasMeetingTranscript`, `useCompletion.ts:2059`). `meetingPanelHidden` cannot be reused
  for this: it also hides the AI response, the error and the conversation-mode panel
  (`isPopoverOpen`, `useCompletion.ts:2062-2068`), and it is cleared when loading starts
  (`:2070-2072`), so an auto-stop would close an answer the user is reading.
  - Use a **transcript-only** hide: set on the recording true->false edge, cleared on the
    false->true edge, and cleared when the user opens the panel (the Ask icon or
    `onOpenChange(true)`, `Input.tsx:93-95`). While set, `hasMeetingTranscript` does not
    hold the popover open; a response, error, conversation mode or in-flight request still
    does.
  - A trailing STT line arriving after the stop does not reopen the panel.
  - The transcript is not cleared, no new conversation starts, and the Odoo/Notion targets
    survive, on every stop path (user, grace, silence, auto-record).

### G6. Ask box collapses to an icon
- In place of the input, a small chat icon button. It expands to the input, focused, on:
  a click on the icon, or the `focus-text-input` event from Rust (sent for both Ctrl+Shift+I
  and the show-window shortcut, `src-tauri/src/shortcuts.rs:212, 247, 664`; no Rust change).
  Other programmatic focus calls (after each AI answer, `useCompletion.ts:1109, 1282, 1943`;
  Ctrl+K, `:2171`) do **not** expand it; simplest is that the input is not mounted while
  collapsed, so those calls are no-ops.
- **Wiring the shortcut:** the expanded state lives in a component that is always mounted.
  It owns its own `listen("focus-text-input")` (cancelled-flag pattern,
  `useMeetingAutoRecord.ts:608-615`) that sets it expanded. The input focuses itself when
  it mounts (`autoFocus` or a mount effect), not through the registered element.
  `registerInputRef(inputRef.current)` (`useCompletion.ts:2445-2456`) runs once with stable
  deps, so with a conditionally mounted input it would hold `null` or a detached node
  forever (`useGlobalShortcuts.ts:63-65, 150-156`). Re-register from the input's ref
  callback (null on unmount) or pass the ref object.
- **Layout, as a DOM contract:** expanded, the input takes the space of the controls
  between the record button and the right-hand window controls; while expanded the
  contact picker, screenshot and files buttons are not rendered. The record button and the
  system-audio button are always rendered, so the live signal (G5) is always on screen;
  settings, drag and minimize stay too. The expanded box never covers the meeting-log Undo
  strip (`MeetingLogStrip`, which shows in the picker's slot during the hold,
  `completion/index.tsx:280-295`).
- **Stranded popovers:** Radix does not fire `onOpenChange` when a popover unmounts, and
  `messageHistoryOpen`, `isFilesPopoverOpen` and `isContactPickerOpen` all keep the window
  enlarged (`useCompletion.ts:2093-2099`). Before expanding (which hides picker and files),
  set `isContactPickerOpen` and `isFilesPopoverOpen` false, as `completion/index.tsx:209-211`
  does for the hold. Collapse is suppressed while any of the three is open (the thread
  indicator, `MessageHistory`, sits inside the input wrapper, `Input.tsx:123-140`).
- **Collapse rule:** it collapses back to the icon when the input is **empty, not focused,
  and not loading**, and none of the three popovers above is open. Typed-but-unsent text
  keeps it open. The check runs after a short debounce, longer than the 100 ms post-answer
  re-focus (`useCompletion.ts:1105-1110`), because `disabled={isLoading}` blurs the input
  when a request starts (`Input.tsx:115`); without the debounce it would collapse the
  moment an answer finishes, before the re-focus. `PopoverContent` must not steal focus
  when it opens (`onOpenAutoFocus` prevented), or a new transcript line would blur and
  collapse a box the user just opened.
- **Popover anchor:** the transcript/answer popover is anchored to the input today
  (`PopoverTrigger asChild`, `Input.tsx:106-149`). Keep one anchor mounted in both states
  (the trigger or a `PopoverAnchor` on a persistent wrapper, with the icon or the input
  inside it), so the popover still opens below the pill when collapsed (for example when a
  new transcript line or AI response arrives). The icon's click handler expands the box and
  clears the transcript-only hide (G5) itself; it does not rely on Radix toggling the
  controlled popover.
- Everything the input does today keeps working: typing and Enter to submit, paste
  (screenshots/files), the conversation-thread indicator, quick actions, and the popover.

## Tests that change
Existing suites assert behaviour this removes, and must be updated, not deleted:
- `usePillRecordAction.test.tsx` expects `setMeetingAssistMode(false)` on stop
  (`usePillRecordAction.ts:81-84`).
- `useMeetingLog.enqueue.test.tsx`, `useMeetingLog.hold.test.tsx` and
  `meeting-log-entry-points.test.tsx` drive the pill-off trigger by flipping
  `meetingAssistMode`, and the `meeting-ended` trigger at `useMeetingLog.ts:569`. They
  switch to driving the `recording` input.
- `useCompletion.meeting-assist.test.tsx` covers persistence and the flush on the setter
  (`useCompletion.ts:174-204, 566-587`).
- `useMeetingAutoRecord.lifecycle.test.tsx`'s harness owns `meetingAssistMode`
  (`useMeetingAutoRecord.ts:197-204`) and exercises the pill-off branch (`:185-207`) and
  the immediate stop on `meeting-ended`.
- `meeting-cards.store.test.ts` covers the delayed ended card.
- `meeting-auto-record.decisions.test.ts` keeps its pure `decideOnEnded` cases; branches
  that are now unreachable from production (meeting mode off) stay tested as pure
  functions.
- Transcript fixtures with 1-2 lines or under 60 s now hit G4. Fixtures meet the scrap
  threshold unless the test is about scraps.

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
- Auto-stop loses the transcript tail (the transcript must be flushed when the mic closes).
- A skipped scrap reappears glued to the next meeting's row.
- Stopping recording (any path) clears the selected Odoo/Notion targets or starts a new
  conversation. Issue #72's history: wiping targets mid-meeting is the bug users notice most.
- Two meeting-log rows for one stop (the mic-off edge plus some leftover trigger).
- One call's transcript filed under another call's contacts (back-to-back calls merged).

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
- The quiet-restart window in `meeting-cards.store.ts` (`RESTART_QUIET_MS`, 120 s) exists
  for auto stop -> re-detect of the same call; it keeps working for grace and silence
  stops, and is skipped by the new-call stop (G2).
- Tests: Vitest, scoped runs (full-suite has known flakes). Test files are not
  type-checked by `npm run type-check` (tsconfig excludes `src/tests`). Timers are tested
  with fake timers; layout claims are tested as the DOM contract in G6, not as geometry
  (jsdom has no layout).
- No Rust changes are expected.

## Left to the builder
- Where the grace and silence timers live, within the gates above (the grace in
  `useMeetingAutoRecord`, which already owns `meeting-ended`; the silence timer anywhere
  gated on the main window only).
- How the current calendar event is read for G2's same-call check (the read auto-select
  already does is the natural one).
- The notice styling.
- The chat icon and expand/collapse animation.
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
- Other-side (system audio) lines restart the call-end grace, with no ceiling: sound from
  another app (a video) after a call keeps a forgotten mic on until it goes quiet for 2
  minutes. Accepted risk.
- A re-detect during the grace is the same call only if it is the same app and the same
  calendar event; otherwise the first call's recording stops, a new conversation starts,
  and a new recording starts. Residual cases, accepted:
  - Two back-to-back calls in the same app with no calendar events still merge into one row.
  - A call that ends early, with the next call joined before the first call's slot ends,
    merges too (the calendar still says the first slot).
  - A detection dropout straddling a slot boundary splits one overrunning call into two
    rows.
- A grace stop's row ends at the call's end; room talk during the grace is consumed, not
  logged.
- `meeting-ended` stops firing the meeting-log trigger while recording (it still fires with
  the mic closed), and the idle trigger doesn't arm while recording (one row per call).
- Silence timer runs even during a detected call (15 min is above the longest measured
  in-call silence, 13 min); it cannot stop a forgotten mic in a talking room on its own.
- Speech-to-text results still in flight at a stop are not added to the row just cut.
- Startup recovery merges short segments into a neighbour instead of dropping them. A scrap
  the live trigger skipped can therefore be merged into a later unlogged call's recovered
  row (app killed mid-call). Accepted: recovered rows carry no targets until the user
  picks one (`meeting-log-recovery.ts:86-92`).
- Every stop hides the transcript only, not an AI answer the user is reading.
- Manual Send-to-Odoo/Notion stays unfiltered.
- The show-window shortcut also opens the Ask box (it shares Rust's event with Ctrl+Shift+I).
- Expanded Ask box replaces picker/screenshot/files; record and system-audio buttons stay.
