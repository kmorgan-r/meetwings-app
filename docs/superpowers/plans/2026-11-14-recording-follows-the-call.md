# Recording Follows the Call Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Meeting mode is always on, the mic closes itself when the call ends (2-min grace) or after 15 min of silence, scraps never become meeting rows, stops are visible, and the Ask box folds to an icon.

**Architecture:** One derived `recording` value (`meetingAssistMode && enableVAD`, already computed as `meetingCaptureActive` in `useCompletion`) replaces meeting mode's on/off edge as the meeting-end signal: a layout-effect edge in `useCompletion` flushes and hides the transcript, and a second one in `useMeetingLog` cuts the row. `useMeetingAutoRecord` gains one shared stop op (enqueued on its existing chain) that the call-end grace, the silence timer and the new-call path all use; a tiny module store hands the grace stop's call-end time to the next meeting-log trigger. Scrap filtering is a pure predicate in `meeting-log.ts`, used by the live trigger (skip) and by recovery (merge into a neighbour).

**Tech Stack:** React 19, TypeScript 5.8, Tauri 2 events, Vitest + Testing Library (happy-dom).

**Spec:** `docs/superpowers/specs/2026-11-14-recording-follows-the-call-design.md` (reviewed, commit 36f9495). Read it beside this plan; section ids (G1-G6) below refer to it.

## Global Constraints

- Grace: `CALL_END_GRACE_MS = 2 * 60 * 1000`. Silence: `SILENCE_STOP_MS = 15 * 60 * 1000`. Same-call calendar read bound: `SAME_CALL_READ_TIMEOUT_MS = 5_000`. All three live in `src/config/constants.ts` next to `STOP_CONFIRM_ATTEMPTS` (tests override them through the existing `vi.mock("@/config/constants", ...)` pattern; the hook tests never use fake timers, see `useMeetingAutoRecord.lifecycle.test.tsx:134-146`).
- Scrap: `endAt - startAt < 60_000` **or** fewer than 3 entries. Exactly 60 000 ms or exactly 3 entries is kept. Constants `SCRAP_MIN_MS = 60_000`, `SCRAP_MIN_ENTRIES = 3` in `src/lib/odoo/meeting-log.ts` beside `IDLE_FLUSH_MS`.
- Stop-notice copy, verbatim: `"Recording stopped - call ended"` and `"Recording stopped - 15 min of silence"`. Shown for `ENDED_CARD_MS` (5 s).
- Watcher-stopped toast copy (replaces `useMeetingAutoRecord.ts:64`): `"Meeting detection stopped — still recording this call. Press the record button to end it."`
- Zoom: `"Zoom.exe"` in `MEETING_DETECT_PROCESSES`; `"zoom.exe": "Zoom"` in `MEETING_DETECT_LABELS` (lowercase key).
- Grace and same-call logic sit behind `useMeetingAutoRecord`'s existing owner gate (`label === "main" && isWindows()`). The silence timer and the shared stop op are gated on `label === "main"` only.
- Every edge detector of `recording` compares before it assigns, in a `useLayoutEffect`, seeded from the first render (no edge on mount). Never a passive effect.
- New timers and listeners follow the file's existing patterns: cancelled flag on async `listen`, cleanup on unmount, capture commands only through `enqueue` (`useMeetingAutoRecord.ts:290-298`).
- No Rust changes. Do not add `msedgewebview2.exe` anywhere.
- Test files are not type-checked by `npm run type-check`; run Vitest scoped (`npx vitest run <paths>`), never the full suite as a gate (known flakes: `overlay-minimize-keeps-mounted`, `meeting-log-page`, `odoo-settings-page`).
- Merge note: open PR #98 replaces `getAllConversations()` with `listConversations()`; do not add new mocks of `getAllConversations`.

## Review Focus

1. **The calendar read in the same-call check hangs or throws.** Expected: after at most `SAME_CALL_READ_TIMEOUT_MS` the redetection counts as the same call and the op chain moves on (a hung Graph call must not block every later stop). Test in Task 9.
2. **Edits that don't append a line** (translation arriving, speaker assigned) replace entries in the array without changing its length. Expected: they restart neither the silence timer nor the grace. Tests in Tasks 7 and 8.
3. **Clear transcript during the grace.** The system-line count drops to 0. Expected: no re-arm or stop from the drop itself; a later system line re-arms the grace as usual. Test in Task 8.
4. **An auto-stop fires while the user is reading an AI answer.** Expected: the answer stays open; only the transcript view is hidden. Test in Task 4.
5. **Remount mid-call with a hand-opened mic.** Expected: the unmount flush runs (recovery has the lines), and a later `meeting-ended` with the mic closed still runs the meeting-log trigger. Tests in Tasks 4 and 7.

## Test paths (P4 gate runs exactly these)

```
src/tests/odoo-meeting-log-slice.test.ts
src/tests/odoo-meeting-log-recovery.test.ts
src/tests/meeting-cards.store.test.ts
src/tests/meeting-card.test.tsx
src/tests/meeting-card-window.test.tsx
src/tests/minimized-pill.test.tsx
src/tests/current-meeting.test.ts
src/tests/meeting-auto-record.decisions.test.ts
src/tests/meeting-detect.test.ts
src/tests/useCompletion.meeting-assist.test.tsx
src/tests/useMeetingLog.enqueue.test.tsx
src/tests/useMeetingLog.hold.test.tsx
src/tests/meeting-log-entry-points.test.tsx
src/tests/meeting-log-auto-notion.test.tsx
src/tests/meeting-log-watermark.test.ts
src/tests/usePillRecordAction.test.tsx
src/tests/useMeetingAutoRecord.lifecycle.test.tsx
src/tests/useMeetingAutoRecord.auto-stop.test.tsx
src/tests/completion-ask-box.test.tsx
src/tests/completion-calendar-wiring.test.tsx
src/tests/completion-notion-picker.test.tsx
src/tests/overlay-meeting-targets-survive.test.tsx
src/tests/overlay-minimize-keeps-mounted.test.tsx
src/tests/settings-page.meeting-auto-record.test.tsx
src/tests/summarize-current-conversation.slice.test.tsx
src/tests/odoo-target-new-chat-entry-points.test.tsx
src/tests/useSystemAudio.new-conversation.test.tsx
```

## Routing

Tasks 1-3 are short, self-contained pure-module work: suitable for the ollama worker. Tasks 4-10 touch the hook timing contracts and large test harnesses: Anthropic implementers.

---

### Task 1: Scrap rule and recovery merge (G4, pure)

**Files:**
- Modify: `src/lib/odoo/meeting-log.ts` (add after `segmentByGap`, :202-231)
- Modify: `src/lib/odoo/meeting-log-recovery.ts:195`
- Test: `src/tests/odoo-meeting-log-slice.test.ts`, `src/tests/odoo-meeting-log-recovery.test.ts`

**Interfaces:**
- Produces (in `meeting-log.ts`): `export const SCRAP_MIN_MS = 60_000;` `export const SCRAP_MIN_ENTRIES = 3;` `export function isScrap(slice: TranscriptSlice): boolean;` `export function mergeScraps(segments: TranscriptSlice[]): TranscriptSlice[];`

- [ ] **Step 1: Write the failing tests** in `odoo-meeting-log-slice.test.ts` (build slices with the file's existing entry helpers):
  - `isScrap: 59_999 ms with 3 entries is a scrap` → `true`
  - `isScrap: exactly 60_000 ms with exactly 3 entries is kept` → `false`
  - `isScrap: 60_000 ms with 2 entries is a scrap` → `true`
  - `mergeScraps: a scrap merges into the nearer neighbour` — `[A long (0..120s, 5 lines), B scrap (126s..130s, 2 lines), C long (20min..25min)]` → 2 slices; first has A's and B's entries, `startAt` = A's, `endAt` = B's; second deep-equals C.
  - `mergeScraps: a scrap nearer the next segment merges forward`.
  - `mergeScraps: an equal gap goes to the previous segment`.
  - `mergeScraps: a lone scrap is dropped` → `[]`.
  - `mergeScraps: two adjacent scraps alone merge, and are dropped if still a scrap` (2 lines + 2 lines spanning 4 min → kept as one slice of 4 lines; 1 + 1 line spanning 10 s → `[]`).
  - `mergeScraps: non-scrap segments pass through unchanged`.
- [ ] **Step 2: Run** `npx vitest run src/tests/odoo-meeting-log-slice.test.ts`. Expected: FAIL (`isScrap` / `mergeScraps` not exported).
- [ ] **Step 3: Implement.** `isScrap` is the Global Constraints predicate. `mergeScraps` takes chronological input (what `segmentByGap` returns) and repeats: find the first scrap while more than one segment remains; merge it into the neighbour with the smaller gap (`seg.startAt - prev.endAt` vs `next.startAt - seg.endAt`; tie → previous; only one neighbour → that one); the merged slice is `sliceOf` of the timestamp-sorted concatenation. When no scrap remains or one segment is left, drop a remaining scrap and return.
- [ ] **Step 4: Recovery test first** in `odoo-meeting-log-recovery.test.ts`:
  - `recovery merges a short tail into its call` — one conversation, a 10-min 20-line segment then a 2-line 30 s segment 6 min later → exactly one `insertQueueRow` call; its transcript contains the tail lines; `transcriptEndAt` = the tail's last timestamp.
  - `recovery skips a lone scrap` — a conversation with only 2 lines → `insertQueueRow` not called, returns 0, and `setSkipWatermark` is not called.
  - Update any existing fixture that expects a row but is under the thresholds (fewer than 3 lines or under 60 s) so it meets them.
- [ ] **Step 5: Implement** at `meeting-log-recovery.ts:195`: `for (const slice of mergeScraps(segmentByGap(group, IDLE_FLUSH_MS)))`.
- [ ] **Step 6: Run** `npx vitest run src/tests/odoo-meeting-log-slice.test.ts src/tests/odoo-meeting-log-recovery.test.ts`. Expected: PASS.
- [ ] **Step 7: Commit**
```bash
git add src/lib/odoo/meeting-log.ts src/lib/odoo/meeting-log-recovery.ts src/tests/odoo-meeting-log-slice.test.ts src/tests/odoo-meeting-log-recovery.test.ts
git commit -m "feat(meeting-log): scrap rule; recovery merges short segments"
```

---

### Task 2: Stop notice and live record button (G5 visuals)

**Files:**
- Modify: `src/lib/meeting-cards.store.ts` (:8, :26-30, :60, :125-180, :270-281)
- Modify: `src/pages/app/components/MeetingCard.tsx:153-190` (`EndedCard`)
- Modify: `src/pages/app/components/completion/AutoSpeechVad.tsx:166-178` (button class)
- Modify: `src/pages/app/components/MinimizedPill.tsx:155-161` (stop square)
- Test: `src/tests/meeting-cards.store.test.ts`, `src/tests/meeting-card.test.tsx`, `src/tests/meeting-card-window.test.tsx`, `src/tests/useMeetingAutoRecord.lifecycle.test.tsx` (the case at ~:2010-2020 importing `ENDED_CARD_DELAY_MS`)

**Interfaces:**
- Produces: `export type StopNoticeReason = "call-ended" | "silence";` `export const STOP_NOTICE_TEXT: Record<StopNoticeReason, string>` (copy from Global Constraints); `export function showStopNotice(reason: StopNoticeReason, now: number = Date.now()): void;`
- Changes: the `ended` variant of `MeetingCardState` becomes `{ kind: "ended"; reason: StopNoticeReason }` (no app/title/duration: a hand-opened mic has none). `ENDED_CARD_DELAY_MS` and `endedTimers` are deleted.

- [ ] **Step 1: Write the failing store tests** (`meeting-cards.store.test.ts`; keep its fake-timer setup):
  - `showStopNotice shows the ended card at once with no active recording` → `getMeetingCard()` equals `{ kind: "ended", reason: "silence" }` immediately; `null` after `ENDED_CARD_MS`.
  - `showStopNotice does nothing over an amber card`.
  - `autoRecordingStopped arms no card` — auto-start, `autoRecordingStopped({ auto: true })`, advance 60 000 ms → `getMeetingCard()` is `null`; same for `autoRecordingStopped()`.
  - `an auto stop still opens the quiet window` — existing quiet-restart cases keep passing (adapt only their ended-card assertions).
  - `the quiet restart clears a showing notice` — auto-start "Teams", auto stop, `showStopNotice("call-ended")`, `autoRecordingStarted({ app: "Teams", ... })` within `RESTART_QUIET_MS` → `getMeetingCard()` is `null`.
  - `a fresh start replaces the notice with the recording card`.
  - Rewrite the old delayed-ended-card cases (:120-160, :285-295) to the new behaviour; do not delete the suite.
- [ ] **Step 2: Run** `npx vitest run src/tests/meeting-cards.store.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** `showStopNotice`: return if `card?.kind === "amber"`, else `setCard({ kind: "ended", reason }, ENDED_CARD_MS, now)`. `autoRecordingStopped` keeps its `active`/`lastStops` handling and the recording-card clear (:159-165) and loses the timer block (:166-179). The quiet branch of `autoRecordingStarted` (:133-140) adds `if (card?.kind === "ended") clearCard();`. Remove `endedTimers` from `resetMeetingCardsForTests`.
- [ ] **Step 4: Card test first** (`meeting-card.test.tsx`): `the ended card shows the stop reason` → rendering `{ kind: "ended", reason: "call-ended" }` shows `"Recording stopped - call ended"`, compact and full; `"silence"` shows the silence copy. Update `meeting-card-window.test.tsx` fixtures that build an ended card.
- [ ] **Step 5: Implement** `EndedCard`: headline/body from `STOP_NOTICE_TEXT[card.reason]`; keep `data-kind="ended"`, `role="status"` and the heights from `cardHeight`.
- [ ] **Step 6: Lifecycle case.** At `useMeetingAutoRecord.lifecycle.test.tsx` ~:2010-2020 drop the `ENDED_CARD_DELAY_MS` import and assert that no ended card appears after an auto-record stop (the 30 s card is gone).
- [ ] **Step 7: Live styling** (no test, class only). `AutoSpeechVad.tsx` button: `className={cn("cursor-pointer", vad.listening && "bg-red-600 text-white hover:bg-red-600/90 animate-pulse")}` (import `cn` from `@/lib/utils`). `MinimizedPill.tsx` `Square`: add `animate-pulse`. Note: PR #98 also edits `AutoSpeechVad.tsx`; touch only the button's `className`.
- [ ] **Step 8: Run** `npx vitest run src/tests/meeting-cards.store.test.ts src/tests/meeting-card.test.tsx src/tests/meeting-card-window.test.tsx src/tests/minimized-pill.test.tsx src/tests/useMeetingAutoRecord.lifecycle.test.tsx` and `npm run type-check`. Expected: PASS, 0 errors.
- [ ] **Step 9: Commit**
```bash
git add src/lib/meeting-cards.store.ts src/pages/app/components/MeetingCard.tsx src/pages/app/components/completion/AutoSpeechVad.tsx src/pages/app/components/MinimizedPill.tsx src/tests/meeting-cards.store.test.ts src/tests/meeting-card.test.tsx src/tests/meeting-card-window.test.tsx src/tests/useMeetingAutoRecord.lifecycle.test.tsx
git commit -m "feat(cards): immediate stop notice; live record button"
```

---

### Task 3: Same-call rule, constants, Zoom, stop-cap store (G2 pure parts)

**Files:**
- Modify: `src/lib/calendar/current-meeting.ts` (add `slotEventAt`)
- Modify: `src/lib/functions/meeting-auto-record.ts` (add `isSameCall`)
- Modify: `src/config/constants.ts:97-106` (Zoom) and beside `STOP_CONFIRM_ATTEMPTS` (:200) (three timing constants)
- Create: `src/lib/recording-stop-cap.ts`
- Test: `src/tests/current-meeting.test.ts`, `src/tests/meeting-auto-record.decisions.test.ts`, `src/tests/meeting-detect.test.ts`

**Interfaces:**
- Produces:
  - `export function slotEventAt(events: CalendarEvent[], at: number): CalendarEvent | null` — among events passing `isMeetingEvent`, those with `startMs <= at < endMs` (no early-join, no ended grace); the latest `startMs` wins, ties by `id` (last after ascending `localeCompare`); `null` if none. Filtering through `isMeetingEvent` is this plan's call: an all-day or cancelled entry contains every moment and would make every pair of moments "the same event".
  - `export function isSameCall(s: { endedProcess?: string; process?: string; events: CalendarEvent[] | null; endedAt: number; now: number }): boolean` — `false` when both processes are known and differ case-insensitively; otherwise `true` when `events` is `null` (unreadable calendar); otherwise `slotEventAt(events, endedAt)?.id === slotEventAt(events, now)?.id` (none/none is the same).
  - `CALL_END_GRACE_MS`, `SILENCE_STOP_MS`, `SAME_CALL_READ_TIMEOUT_MS` (values in Global Constraints).
  - `src/lib/recording-stop-cap.ts`: `export function setRecordingStopCap(endedAt: number | null): void;` `export function takeRecordingStopCap(): number | null;` (returns the held value and clears it). Doc comment: holds the `meeting-ended` time of a grace stop for the next meeting-log trigger, which caps the row at `max(endedAt, newest system line)`.

- [ ] **Step 1: Write the failing tests.**
  - `current-meeting.test.ts`: `slotEventAt includes the start and excludes the end`; `slotEventAt ignores an event starting 4 minutes later (no early join)`; `slotEventAt prefers the later-starting of two overlapping events`; `slotEventAt ignores cancelled, declined, all-day and solo events`; `slotEventAt returns null when nothing covers the moment`.
  - `meeting-auto-record.decisions.test.ts`: `isSameCall: same process, same slot`→true; `different process`("ms-teams.exe" vs "Zoom.exe")→false; `process case differs only`("Teams.exe" vs "teams.exe")→true; `unknown ended process ignores the process check`; `unreadable calendar with the same process`→true; `slot A at ended, slot B now`→false; `no event at either moment`→true; `slot at ended, none now`→false. Keep every existing `decideOnEnded`/`decideOnDetected` case.
  - `meeting-detect.test.ts`: `meetingLabel("Zoom.exe")` is `"Zoom"`; `isGatedProcess("Zoom.exe")` is `false`; `MEETING_DETECT_PROCESSES` contains `"Zoom.exe"`.
- [ ] **Step 2: Run** `npx vitest run src/tests/current-meeting.test.ts src/tests/meeting-auto-record.decisions.test.ts src/tests/meeting-detect.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the Interfaces above.
- [ ] **Step 4: Run** the same command plus `npm run type-check`. Expected: PASS, 0 errors.
- [ ] **Step 5: Commit**
```bash
git add src/lib/calendar/current-meeting.ts src/lib/functions/meeting-auto-record.ts src/config/constants.ts src/lib/recording-stop-cap.ts src/tests/current-meeting.test.ts src/tests/meeting-auto-record.decisions.test.ts src/tests/meeting-detect.test.ts
git commit -m "feat(auto-record): same-call rule, timing constants, Zoom"
```

---

### Task 4: `recording` becomes the meeting-end signal (G1 edge, G5 transcript hide)

Meeting mode still exists after this task (the toggle goes in Task 6); everything here already keys on `recording`.

**Files:**
- Modify: `src/hooks/useCompletion.ts` — new state beside `meetingPanelHidden` (:166); delete the flush branch of the `setMeetingAssistMode` wrapper (:580-584); new layout edge after the capture-edge effect (after :1591); `hasMeetingTranscript` (:2059); return object (:2458-2524)
- Modify: `src/types/completion.hook.ts` (add the three new members)
- Modify: `src/hooks/useMeetingLog.ts` — options (:128-152, :173-181), mirror (:202-217), `meeting-ended` listener (:562-577), edge (:579-594), idle effect (:632-636)
- Modify: `src/hooks/useMeetingAutoRecord.ts` — delete the flush at :182 (release branch) and at :526 (`stop-meeting`), and rewrite the comments that justify them (:173-181, :197-204, :513-517) to say G1's edge in `useCompletion` owns the flush
- Modify: `src/pages/app/components/completion/Input.tsx:93-95`
- Modify: `src/pages/app/components/completion/index.tsx:179-189` (`useMeetingLog`), :236 (`setPillData`)
- Test: `src/tests/useCompletion.meeting-assist.test.tsx`, `src/tests/useMeetingLog.enqueue.test.tsx`, `src/tests/useMeetingLog.hold.test.tsx`, `src/tests/meeting-log-entry-points.test.tsx`, `src/tests/meeting-log-auto-notion.test.tsx`, `src/tests/useMeetingAutoRecord.lifecycle.test.tsx` (flush-count cases, e.g. F55)

**Interfaces:**
- Produces on `UseCompletionReturn`: `recording: boolean` (the existing `meetingCaptureActive`, `useCompletion.ts:1554`), `meetingTranscriptHidden: boolean`, `setMeetingTranscriptHidden: Dispatch<SetStateAction<boolean>>`.
- Changes `UseMeetingLogOptions`: `recording: boolean` replaces `meetingAssistMode: boolean`.

`useMeetingLog` reads `recording` with three polarities. Do not rename blindly:
- edge: trigger on `prev && !recording`;
- `meeting-ended` listener: trigger only when `!recordingRef.current` (a remount leaves the mic closed, and the trigger's DB union still writes the row);
- idle effect: `if (!isOwner || recording || newestEntryAt === 0) return;` (it must not arm while recording; it arms once the mic is closed).

- [ ] **Step 1: Write the failing `useCompletion` tests** (`useCompletion.meeting-assist.test.tsx`, reuse its harness and save spy):
  - `closing the mic flushes the unsaved transcript once` — meeting mode on, mic on, one unsaved line, mic off → one save.
  - `mount is no edge` — no save on first render.
  - `a stop and a start in one commit is no edge` — mic off and on inside one `act` → no save.
  - `the stop hides the transcript only` — mic on, a line, popover open; mic off → `isPopoverOpen` false and `meetingTranscriptHidden` true.
  - `an answer being read survives a stop` (Review Focus 4) — `setResponse("answer")` while recording; mic off → `isPopoverOpen` stays true.
  - `a trailing line after the stop does not reopen the panel`.
  - `starting again clears the hide`.
  - `a stop starts no conversation` — no `newConversationStarted` event dispatched, `currentConversationId` unchanged.
- [ ] **Step 2: Write the failing `useMeetingLog` tests** (switch the existing harnesses from driving `meetingAssistMode` to driving `recording`; transcript fixtures must meet the scrap threshold from now on, ≥3 lines over ≥60 s, because Task 5 adds the filter):
  - `recording true->false triggers once`; `mount with recording false triggers nothing`.
  - `meeting-ended while recording does not trigger`; `meeting-ended with the mic closed triggers` (Review Focus 5).
  - `the idle trigger does not arm while recording` — mount with entries and `recording` true, advance `IDLE_FLUSH_MS` → no `insertQueueRow`. `the idle trigger arms with the mic closed` — mount with entries and `recording` false (no edge, so only the idle timer can fire), advance `IDLE_FLUSH_MS` → the trigger runs once.
- [ ] **Step 3: Run** `npx vitest run src/tests/useCompletion.meeting-assist.test.tsx src/tests/useMeetingLog.enqueue.test.tsx src/tests/useMeetingLog.hold.test.tsx src/tests/meeting-log-entry-points.test.tsx`. Expected: FAIL.
- [ ] **Step 4: Implement `useCompletion`.**
  - `const [meetingTranscriptHidden, setMeetingTranscriptHidden] = useState(false);`
  - `hasMeetingTranscript = meetingAssistMode && meetingTranscript.length > 0 && !meetingTranscriptHidden`.
  - The edge, placed after the capture-edge effect so the length mirror (`:529-531`, a layout effect) has already run in the same commit:
    ```ts
    const prevRecordingRef = useRef(meetingCaptureActive);
    useLayoutEffect(() => {
      const prev = prevRecordingRef.current;
      prevRecordingRef.current = meetingCaptureActive;
      if (prev === meetingCaptureActive) return;
      setMeetingTranscriptHidden(!meetingCaptureActive);
      if (prev) void flushUnsavedMeetingTranscript().catch((e) => console.error("Recording-stop flush failed:", e));
    }, [meetingCaptureActive, flushUnsavedMeetingTranscript]);
    ```
  - Delete the flush in the setter wrapper (:580-584); return `recording: meetingCaptureActive`, `meetingTranscriptHidden`, `setMeetingTranscriptHidden`; add them to `UseCompletionReturn`.
- [ ] **Step 5: Implement `useMeetingLog`** with the three polarities above. Mirror `recording` into `recordingRef` in the existing layout mirror (:205-217); rename `prevPillRef` to `prevRecordingRef`. Update the hook's doc comment (:160-172), which still speaks of the pill.
- [ ] **Step 6: Wire it.** `index.tsx`: `useMeetingLog({ ..., recording: completion.recording })` and `setPillData({ ..., recording: completion.recording })`. `Input.tsx` `onOpenChange`: `if (open) { setMeetingPanelHidden(false); setMeetingTranscriptHidden(false); }`. Destructure the new prop.
- [ ] **Step 7: Remove the auto-record flushes** at `useMeetingAutoRecord.ts:182` and `:526`. In `useMeetingAutoRecord.lifecycle.test.tsx`, cases that count `flushTranscript` calls on a stop now expect 0 from the hook; the unmount flush case (:575-583) is unchanged.
- [ ] **Step 8: Run** the Step 3 command plus `src/tests/meeting-log-auto-notion.test.tsx src/tests/useMeetingAutoRecord.lifecycle.test.tsx src/tests/useSystemAudio.new-conversation.test.tsx`, then `npm run type-check`. Expected: PASS, 0 errors.
- [ ] **Step 9: Commit**
```bash
git add src/hooks/useCompletion.ts src/types/completion.hook.ts src/hooks/useMeetingLog.ts src/hooks/useMeetingAutoRecord.ts src/pages/app/components/completion/Input.tsx src/pages/app/components/completion/index.tsx src/tests/useCompletion.meeting-assist.test.tsx src/tests/useMeetingLog.enqueue.test.tsx src/tests/useMeetingLog.hold.test.tsx src/tests/meeting-log-entry-points.test.tsx src/tests/meeting-log-auto-notion.test.tsx src/tests/useMeetingAutoRecord.lifecycle.test.tsx
git commit -m "feat(meeting): recording edge cuts the row, flushes, hides transcript"
```

---

### Task 5: Trigger skips scraps and caps grace stops (G4 live, G2 cap)

**Files:**
- Modify: `src/hooks/useMeetingLog.ts` `trigger` (:342-546)
- Test: `src/tests/useMeetingLog.enqueue.test.tsx` (new cases), `src/tests/meeting-log-auto-notion.test.tsx`, `src/tests/meeting-log-watermark.test.ts` (fixtures only if they hit the rule)

**Interfaces:**
- Consumes: `isScrap` (Task 1), `takeRecordingStopCap` (Task 3).

The pipeline order inside `trigger`, pinned:
1. `if (!isOwner) return;`
2. `const capEndedAt = takeRecordingStopCap();` — before the in-flight latch, so every trigger call clears it, including one the latch drops. Accepted cost: a grace stop landing while an earlier trigger is still in flight loses its cap (that earlier trigger must run for over 2 minutes for the two to meet).
3. In-flight latch, synchronous snapshot, config reads and destination decision: unchanged (their `skipUnwritten()` keeps the snapshot-only consumed end, as today).
4. Watermark, then the recovery union into `all` (unchanged).
5. `consumedTo = Math.max(consumedTo, newest timestamp in all)`. `consumedTo` becomes a `let`; `skipUnwritten` reads it at call time.
6. `const slice = sliceTranscript(all, watermark); if (!slice) return;` (unchanged).
7. Cap: if `capEndedAt !== null`, `cap = Math.max(capEndedAt, newest timestamp among slice.entries with audioSource === "system")` and `written = sliceTranscript(slice.entries.filter((e) => e.timestamp <= cap), watermark)`; otherwise `written = slice`.
8. `if (!written || isScrap(written)) { skipUnwritten(); return; }`. No toast, no Outlook read, no insert.
9. The Notion check's span, `sessionKey`, `transcript`, `transcriptStartAt` and `meetingStartedAt` come from `written`. `transcriptEndAt` is `consumedTo` (equal to `slice.endAt` when uncapped, so only capped rows change).

- [ ] **Step 1: Write the failing tests** (`useMeetingLog.enqueue.test.tsx`):
  - `a 2-line slice writes no row and skip-marks its end` — no `insertQueueRow`, no `toast.error`, `getSkipWatermark()` = the newest timestamp.
  - `59 s of 5 lines is a scrap; 60 s of 3 lines is a row`.
  - `a scrap recovered from the DB after a remount is consumed` — empty in-memory transcript, `readMeetingMessages` returns 2 lines → `getSkipWatermark()` = the newest of those.
  - `a scrap reads no Outlook` — auto Notion tick held → `fetchMeetingsBetween` / `autoNotionAllowed` not called.
  - `a grace stop's row ends at the call` — `setRecordingStopCap(T)`; system lines up to T-5 s, mic lines up to T+90 s; edge trigger → `transcript` holds only lines ≤ T; `transcriptEndAt` = the newest mic line.
  - `the cap follows a later system line` — a system line at T+30 s is rendered, mic lines after it are not.
  - `a capped slice that is a scrap writes no row and consumes the room talk`.
  - `the cap is cleared by every trigger` — first trigger held in flight (pending `loadOdooConfigState`), `setRecordingStopCap(T)`, a second trigger is dropped by the latch; release; a third trigger with lines after T writes them all (uncapped) and `takeRecordingStopCap()` is `null`.
- [ ] **Step 2: Run** `npx vitest run src/tests/useMeetingLog.enqueue.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement** the pipeline above.
- [ ] **Step 4: Run** `npx vitest run src/tests/useMeetingLog.enqueue.test.tsx src/tests/useMeetingLog.hold.test.tsx src/tests/meeting-log-entry-points.test.tsx src/tests/meeting-log-auto-notion.test.tsx src/tests/meeting-log-watermark.test.ts` and `npm run type-check`. Expected: PASS, 0 errors.
- [ ] **Step 5: Commit**
```bash
git add src/hooks/useMeetingLog.ts src/tests/useMeetingLog.enqueue.test.tsx src/tests/meeting-log-auto-notion.test.tsx src/tests/meeting-log-watermark.test.ts
git commit -m "feat(meeting-log): skip scraps, cap grace-stop rows at call end"
```

---

### Task 6: Meeting mode always on, toggle removed (G1)

**Files:**
- Modify: `src/hooks/useCompletion.ts` — state (:173-178) becomes `const meetingAssistMode = true;` (its `meetingAssistModeRef` goes too: only the wrapper reads it); delete the persistence effect (:201-204) and the `setMeetingAssistMode` wrapper (:566-587); drop `setMeetingAssistMode` from the return. `STORAGE_KEYS.MEETING_ASSIST_MODE_ENABLED` stays in `constants.ts` (tests reference it); nothing writes it any more
- Modify: `src/types/completion.hook.ts:142-143` (drop `setMeetingAssistMode`)
- Modify: `src/hooks/usePillRecordAction.ts` (options and toggle)
- Modify: `src/hooks/useMeetingAutoRecord.ts:63-64` (toast copy)
- Modify: `src/pages/app/components/completion/index.tsx` — delete the import (:23) and render (:275-279) of the toggle; `usePillRecordAction` call (:254-260)
- Delete: `src/pages/app/components/completion/MeetingAssistToggle.tsx`
- Test: `src/tests/useCompletion.meeting-assist.test.tsx`, `src/tests/usePillRecordAction.test.tsx`, and remove the `MeetingAssistToggle` `vi.doMock` lines from `completion-calendar-wiring.test.tsx:155-156`, `completion-notion-picker.test.tsx:70`, `overlay-meeting-targets-survive.test.tsx:397-398`, `overlay-minimize-keeps-mounted.test.tsx:231-232`, `settings-page.meeting-auto-record.test.tsx:274-275, 425-426, 589-590`; check `summarize-current-conversation.slice.test.tsx` and `odoo-target-new-chat-entry-points.test.tsx` for the setter or the storage key

**Interfaces:**
- Changes `usePillRecordAction` options to `{ recording: boolean; setEnableVAD: Dispatch<SetStateAction<boolean>>; canRecord: boolean }`; the registered toggle calls `setEnableVAD(!recording)` from its mirror and nothing else.
- `useMeetingAutoRecord` keeps its `meetingAssistMode` option. Completion passes the constant `true`, so the pill-off branch (:185-207) and the transcribing start become unreachable in production. They stay as they are: deleting that pipeline is a non-goal, and the lifecycle suite keeps covering it with `meetingAssistMode: false`.

- [ ] **Step 1: Write the failing tests.**
  - `useCompletion.meeting-assist.test.tsx`: `meeting mode is on at first render even when storage says "false"`; `no setter is returned` (`result.current.setMeetingAssistMode` is `undefined`); `nothing writes meeting_assist_mode_enabled` (`localStorage.setItem` never called with `STORAGE_KEYS.MEETING_ASSIST_MODE_ENABLED` across mount and mic toggles). Replace the old persistence and setter-flush cases with these.
  - `usePillRecordAction.test.tsx`: `stop closes the mic only` → `setEnableVAD(false)`, nothing else; `start opens the mic` → `setEnableVAD(true)`.
- [ ] **Step 2: Run** `npx vitest run src/tests/useCompletion.meeting-assist.test.tsx src/tests/usePillRecordAction.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement** the Files list. `index.tsx`: `usePillRecordAction({ recording: completion.recording, setEnableVAD: completion.setEnableVAD, canRecord: ... })`. Update `usePillRecordAction`'s doc comment (:25-44), which describes the pill flipping meeting mode.
- [ ] **Step 4: Run** `npm run type-check`, `npm run lint`, and `npx vitest run src/tests/useCompletion.meeting-assist.test.tsx src/tests/usePillRecordAction.test.tsx src/tests/completion-calendar-wiring.test.tsx src/tests/completion-notion-picker.test.tsx src/tests/overlay-meeting-targets-survive.test.tsx src/tests/overlay-minimize-keeps-mounted.test.tsx src/tests/settings-page.meeting-auto-record.test.tsx src/tests/summarize-current-conversation.slice.test.tsx src/tests/odoo-target-new-chat-entry-points.test.tsx src/tests/useMeetingAutoRecord.lifecycle.test.tsx`. Expected: PASS (a known flake in `overlay-minimize-keeps-mounted` passes when re-run alone).
- [ ] **Step 5: Commit**
```bash
git rm src/pages/app/components/completion/MeetingAssistToggle.tsx
git add src/hooks/useCompletion.ts src/types/completion.hook.ts src/hooks/usePillRecordAction.ts src/hooks/useMeetingAutoRecord.ts src/pages/app/components/completion/index.tsx src/tests
git commit -m "feat(meeting): meeting mode always on; toggle removed"
```

---

### Task 7: Shared stop op, silence auto-stop, unmount flush (G3, G2 base)

**Files:**
- Modify: `src/hooks/useMeetingAutoRecord.ts` — options (:77-83), owner memo (:126-129), layout mirror (:164-208), unmount cleanup (:573-595)
- Modify: `src/pages/app/components/completion/index.tsx:39-45`
- Create: `src/tests/useMeetingAutoRecord.auto-stop.test.tsx`

**Interfaces:**
- Consumes: `showStopNotice`, `StopNoticeReason` (Task 2); `setRecordingStopCap` (Task 3); `SILENCE_STOP_MS` (Task 3).
- Changes `MeetingAutoRecordOptions`: adds `meetingTranscript: TranscriptEntry[]`. Completion passes `completion.meetingTranscript`.
- Produces (internal, used by Tasks 8-9): `const isMain = useMemo(() => getCurrentWindow().label === "main", [])`; `isOwner` becomes `isMain && isWindows()`.
  `const stopRecording = async (o: { reason: StopNoticeReason; auto: boolean; capEndedAt: number | null }): Promise<void>`, in this order:
  1. return if `!mountedRef.current || !enableVADRef.current`;
  2. `startedModeRef.current = null` (before the write, so the release branch at :171-184 never runs and never calls `autoRecordingStopped()` without `auto`);
  3. `autoRecordingStopped({ auto: o.auto })`;
  4. `showStopNotice(o.reason)`;
  5. `setRecordingStopCap(o.capEndedAt)`;
  6. `setEnableVADRef.current(false)`;
  7. `const ok = await confirmMeetingStopped()`; then `setRecordingStopCap(null)` (the edge trigger read it synchronously at the stop commit; this clears a cap no edge consumed, for example a stop and start batched into one commit); toast `MEETING_STOP_FAILED_MESSAGE` on `!ok` with the same guard as :533.
  Always called through `enqueue`.

- [ ] **Step 1: Create the test file.** Copy the hoisted mocks, the listen registry, `emit`/`fire`/`fireActed`/`flush`/`sleep`/`drainStopConfirm`/`makeAudio`/`seedStatus` and the `mount` harness from `useMeetingAutoRecord.lifecycle.test.tsx:1-330`. Extend `Probe` with `meetingTranscript` state (exposed as `appendLine(audioSource)`, `replaceEntry(index)` that keeps the length, and `clearTranscript()`) and a `startNewConversation` spy (Task 9). Override in the constants mock: `STOP_CONFIRM_INTERVAL_MS: 5, SILENCE_STOP_MS: 80, CALL_END_GRACE_MS: 40, SAME_CALL_READ_TIMEOUT_MS: 30`. Mock `@/lib/recording-stop-cap` with spies. Real timers only.
- [ ] **Step 2: Write the failing tests:**
  - `silence closes a hand-opened mic` — `setMicOpen(true)`, wait 80 ms + drain → `setEnableVAD` called with `false`; `getMeetingCard()` is `{ kind: "ended", reason: "silence" }`.
  - `each appended line restarts the silence timer` — line at 50 ms → open at 100 ms → closed by ~180 ms.
  - `lines already there at start do not count` — mount with 5 lines, open the mic → closed after ~80 ms.
  - `editing an entry in place is not an arrival` (Review Focus 2) — `replaceEntry` at 50 ms → closed by ~100 ms.
  - `silence runs on the main window when not Windows` (`mocks.isWindows` → false) and `never on another window` (label "dashboard").
  - `the stop keeps the quiet window for an auto-started call` — auto-start via `meeting-detected`, silence stop, then `autoRecordingStarted` for the same app inside `RESTART_QUIET_MS` takes the quiet branch (no recording card).
  - `an unconfirmed stop warns` — status queue all `true` → `toast.error(MEETING_STOP_FAILED_MESSAGE)`.
  - `unmount with a hand-opened mic flushes once` (Review Focus 5).
- [ ] **Step 3: Run** `npx vitest run src/tests/useMeetingAutoRecord.auto-stop.test.tsx`. Expected: FAIL.
- [ ] **Step 4: Implement.** Silence effect:
  ```ts
  useEffect(() => {
    if (!isMain || !enableVAD) return;
    const t = setTimeout(() => void enqueue(() => stopRecording({ reason: "silence", auto: true, capEndedAt: null })), SILENCE_STOP_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- enqueue/stopRecording close over refs only (see :672-679)
  }, [isMain, enableVAD, meetingTranscript.length]);
  ```
  Unmount cleanup: flush when `startedModeRef.current || enableVADRef.current`; `autoRecordingStopped()` stays under `startedModeRef.current`. Pass `meetingTranscript` from `index.tsx`.
- [ ] **Step 5: Run** `npx vitest run src/tests/useMeetingAutoRecord.auto-stop.test.tsx src/tests/useMeetingAutoRecord.lifecycle.test.tsx` and `npm run type-check`. Expected: PASS, 0 errors.
- [ ] **Step 6: Commit**
```bash
git add src/hooks/useMeetingAutoRecord.ts src/pages/app/components/completion/index.tsx src/tests/useMeetingAutoRecord.auto-stop.test.tsx
git commit -m "feat(auto-record): shared stop op, 15-min silence stop"
```

---

### Task 8: Call-end grace (G2)

**Files:**
- Modify: `src/hooks/useMeetingAutoRecord.ts` — listener effect (:602-680), layout effects, unmount cleanup
- Test: `src/tests/useMeetingAutoRecord.auto-stop.test.tsx`, `src/tests/useMeetingAutoRecord.lifecycle.test.tsx` (cases asserting the immediate meeting-mode stop on `meeting-ended`)

**Interfaces:**
- Consumes: `stopRecording` (Task 7), `CALL_END_GRACE_MS`.
- Produces (internal, used by Task 9):
  - `type Grace = { endedAt: number; endedProcess: string | undefined; gen: number; timer: ReturnType<typeof setTimeout> | null };` `graceRef = useRef<Grace | null>(null)`, `graceGenRef = useRef(0)`, `lastProcessRef = useRef<string | undefined>(undefined)`.
  - `armGrace(endedAt: number, endedProcess: string | undefined): void` — bumps `graceGenRef`, clears any running timer, and **mutates** an existing `graceRef.current` (keeps its identity; Task 9 compares by identity) or creates one; starts the timer.
  - `cancelGrace(): void` — clears the timer, `graceRef.current = null`, bumps `graceGenRef`.
  - Timer fire: if `!enableVADRef.current` → `cancelGrace()`; else `const gen = graceGenRef.current; g.timer = null; enqueue(() => graceStop(gen))`.
  - `graceStop(gen)`: `const g = graceRef.current; if (!g || g.gen !== gen) return; graceRef.current = null; await stopRecording({ reason: "call-ended", auto: true, capEndedAt: g.endedAt });`

Wiring:
- `meeting-detected` listener: after enqueuing, `lastProcessRef.current = payload?.process`.
- `meeting-ended` listener: capture `const endedAt = Date.now(), endedProcess = lastProcessRef.current;` synchronously. If `startedModeRef.current === "transcribing"`, enqueue `handleStop({ auto: true })` as today and return. Otherwise `enqueue(async () => { if (enableVADRef.current || startedModeRef.current === "meeting") armGrace(endedAt, endedProcess); })`. The decision runs inside the op because a queued op resumes before the `enableVAD` mirror updates; meeting provenance counts as an open mic.
- System lines: `const systemLineCount = useMemo(() => meetingTranscript.filter((e) => e.audioSource === "system").length, [meetingTranscript]);` and a compare-before-assign layout effect: on `systemLineCount > prev` with `graceRef.current` set, `armGrace(g.endedAt, g.endedProcess)`. A drop (Clear) only updates `prev`.
- Any `enableVAD` change (compare-before-assign layout effect, no mount edge) → `cancelGrace()`.
- `meeting-detection-setting-changed` (disabled) and `meeting-watcher-stopped` → `cancelGrace()` before their existing bodies.
- Unmount cleanup → `cancelGrace()`.

- [ ] **Step 1: Write the failing tests** (`auto-stop` file):
  - `meeting-ended with the mic open waits the grace, then stops` — hand-opened mic; at 20 ms still open; by ~60 ms closed; card reason `"call-ended"`; `setRecordingStopCap` called with the ended time, earlier (`invocationCallOrder`) than `setEnableVAD(false)`.
  - `an auto-started recording is no longer stopped at once` — open at 20 ms, closed after the grace.
  - `meeting-ended with the mic closed arms nothing` — no `setEnableVAD` call within 100 ms.
  - `a system line restarts the grace; a mic line does not`.
  - `the user moving the mic cancels the grace` — close at 10 ms, reopen at 20 ms → open at 100 ms.
  - `turning auto-record off cancels the grace`; `watcher stopped cancels the grace`.
  - `a second meeting-ended re-arms and never stacks` — two events 20 ms apart → exactly one `setEnableVAD(false)`.
  - `StrictMode runs one grace` — `mount(..., { strict: true })` → exactly one `setEnableVAD(false)`.
  - `unmount clears the grace` — unmount at 10 ms → no further `setEnableVAD`.
  - `a line arriving after the fire, before the queued stop, still cancels it` — hold the chain with a deferred `get_capture_status`, let the grace fire, append a system line, release → mic still open.
  - `clearing the transcript during the grace neither stops nor re-arms; a later system line re-arms` (Review Focus 3).
- [ ] **Step 2: Run** `npx vitest run src/tests/useMeetingAutoRecord.auto-stop.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement** the wiring above. In `useMeetingAutoRecord.lifecycle.test.tsx`, rewrite the meeting-mode "`meeting-ended` stops at once" cases to wait the grace (override `CALL_END_GRACE_MS` in that file's constants mock); leave transcribing cases as they are.
- [ ] **Step 4: Run** `npx vitest run src/tests/useMeetingAutoRecord.auto-stop.test.tsx src/tests/useMeetingAutoRecord.lifecycle.test.tsx` and `npm run type-check`. Expected: PASS, 0 errors.
- [ ] **Step 5: Commit**
```bash
git add src/hooks/useMeetingAutoRecord.ts src/tests/useMeetingAutoRecord.auto-stop.test.tsx src/tests/useMeetingAutoRecord.lifecycle.test.tsx
git commit -m "feat(auto-record): 2-min call-end grace, restarted by far-end audio"
```

---

### Task 9: Same call or new call during the grace (G2)

**Files:**
- Modify: `src/hooks/useMeetingAutoRecord.ts` — options, layout mirror, `meeting-detected` listener
- Modify: `src/pages/app/components/completion/index.tsx:39-45`
- Test: `src/tests/useMeetingAutoRecord.auto-stop.test.tsx` (mock `@/lib/calendar/fetch-current-meetings`)

**Interfaces:**
- Consumes: `isSameCall` (Task 3), `fetchCurrentMeetings` (`src/lib/calendar/fetch-current-meetings.ts:17`), `SAME_CALL_READ_TIMEOUT_MS`, the grace refs (Task 8), `stopRecording` (Task 7).
- Changes `MeetingAutoRecordOptions`: adds `startNewConversation: () => Promise<void>`, mirrored into `startNewConversationRef` in the layout mirror (its identity changes with every transcript line). Completion passes `completion.startNewConversation`.
- Produces (internal): `readCalendarEvents(): Promise<CalendarEvent[] | null>` — `Promise.race` of `fetchCurrentMeetings()` and a `SAME_CALL_READ_TIMEOUT_MS` timer resolving `null`; `kind !== "ok"` or a throw → `null`.
- `meeting-detected` listener enqueues `onDetected(process)` instead of `handleDetected(process)`. `onDetected` is one op, so no queued `meeting-ended` can slip in between the stop and B's start:
  ```ts
  const onDetected = async (process?: string) => {
    const g = graceRef.current;
    if (g) {
      const events = g.endedProcess && process && g.endedProcess.toLowerCase() !== process.toLowerCase()
        ? null // already a new call; skip the read
        : await readCalendarEvents();
      if (graceRef.current === g) {
        const same = isSameCall({ endedProcess: g.endedProcess, process, events, endedAt: g.endedAt, now: Date.now() });
        cancelGrace();
        if (same) return; // recording continues; no card
        await stopRecording({ reason: "call-ended", auto: false, capEndedAt: g.endedAt }); // auto:false: no quiet window for B
        await startNewConversationRef.current(); // clears A's targets before B
      }
    }
    return handleDetected(process);
  };
  ```

- [ ] **Step 1: Write the failing tests:**
  - `same app and same slot: the grace is cancelled` — auto-start "ms-teams.exe", `meeting-ended`, re-detect "ms-teams.exe" (calendar: one event over both moments) → mic open at 100 ms; the card's `recordingId` unchanged; `startNewConversation` not called.
  - `a hand-opened mic with no prior detection and an unreadable calendar counts as the same call`.
  - `another app is a new call` — re-detect "Zoom.exe" → `setEnableVAD(false)`, then `startNewConversation`, then `setEnableVAD(true)` in that `invocationCallOrder`; `setRecordingStopCap` received the ended time; a new recording card is shown (non-quiet: new `recordingId`).
  - `the same app in a different slot is a new call`.
  - `a hung calendar read counts as the same call and frees the chain` (Review Focus 1) — `fetchCurrentMeetings` never resolves → grace cancelled after ~30 ms; a later `meeting-ended` arms a new grace that stops the mic.
  - `a detection after the grace stop already ran starts fresh` — `startNewConversation` not called.
- [ ] **Step 2: Run** `npx vitest run src/tests/useMeetingAutoRecord.auto-stop.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement** the Interfaces above and pass `startNewConversation` from `index.tsx`.
- [ ] **Step 4: Run** `npx vitest run src/tests/useMeetingAutoRecord.auto-stop.test.tsx src/tests/useMeetingAutoRecord.lifecycle.test.tsx src/tests/overlay-meeting-targets-survive.test.tsx` and `npm run type-check`. Expected: PASS, 0 errors.
- [ ] **Step 5: Commit**
```bash
git add src/hooks/useMeetingAutoRecord.ts src/pages/app/components/completion/index.tsx src/tests/useMeetingAutoRecord.auto-stop.test.tsx
git commit -m "feat(auto-record): back-to-back call starts a new recording"
```

---

### Task 10: Ask box folds to an icon (G6)

**Files:**
- Modify: `src/pages/app/components/completion/index.tsx` (state, listener, conditional render :280-305)
- Modify: `src/pages/app/components/completion/Input.tsx` (props, trigger content :106-149, `PopoverContent` :152-157)
- Modify: `src/hooks/useCompletion.ts` (`attachInput`; drop `registerInputRef` from the effect at :2445-2456) and `src/types/completion.hook.ts`
- Create: `src/tests/completion-ask-box.test.tsx`
- Test harnesses that render `<Completion />` and now need `@tauri-apps/api/event` mocked (`listen: vi.fn(async () => () => {})`) where they don't already: `completion-calendar-wiring`, `completion-notion-picker`, `overlay-meeting-targets-survive`, `overlay-minimize-keeps-mounted`, `settings-page.meeting-auto-record`; their `useCompletion` mocks gain `setIsFilesPopoverOpen: vi.fn()`.

**Interfaces:**
- Produces on `UseCompletionReturn`: `attachInput: (el: HTMLInputElement | null) => void` — sets `inputRef.current = el` and calls `globalShortcuts.registerInputRef(el)` (null on unmount, so the shortcut never holds a detached node).
- `Input` props gain `askExpanded: boolean; onAskExpand: () => void; onAskCollapse: () => void`. `export const ASK_COLLAPSE_DEBOUNCE_MS = 300;` in `Input.tsx` (longer than the 100 ms post-answer re-focus, `useCompletion.ts:1105-1110`).
- Completion owns `const [askExpanded, setAskExpanded] = useState(false)`. `expandAsk()` calls `completion.setIsContactPickerOpen(false)` and `completion.setIsFilesPopoverOpen(false)`, then `setAskExpanded(true)`. `collapseAsk()` calls `setAskExpanded(false)`. Its own `listen("focus-text-input", () => expandAskRef.current())` in a `[]` effect with the cancelled-flag pattern (`useMeetingAutoRecord.ts:608-615`) and a `.catch` that logs.

Render contract:
- Collapsed: inside the persistent `PopoverTrigger asChild` div, a ghost icon `Button` (`aria-label="Ask"`, lucide `MessageSquare`) whose `onClick` calls `setMeetingPanelHidden(false)`, `setMeetingTranscriptHidden(false)` and `onAskExpand()` itself. The input and `MessageHistory` are not mounted.
- Expanded: the input (`ref={attachInput}`, `autoFocus`, `onFocus`/`onBlur` driving a local `focused` state) and the thread indicator, as today. The wrapper gets `flex-1` only when expanded.
- `PopoverContent` gets `onOpenAutoFocus={(e) => e.preventDefault()}`.
- Completion, while expanded: `ContactPicker`, `Screenshot` and `Files` are not rendered. `MeetingLogStrip` still renders whenever `holding || undoBlockedMessage`. `Audio` always renders.
- Collapse: an effect keyed on `[askExpanded, input, focused, isLoading, messageHistoryOpen, isContactPickerOpen, isFilesPopoverOpen]`. When expanded, the input is empty, it isn't focused, nothing is loading and none of the three popovers is open, it sets a `ASK_COLLAPSE_DEBOUNCE_MS` timer whose fire re-checks `document.activeElement !== inputRef.current` and then calls `onAskCollapse()`. The cleanup clears the timer.

- [ ] **Step 1: Write the failing tests** (`completion-ask-box.test.tsx`). For `Input`: render it with a typed partial props object, and mock `@/contexts` and the four child panels (`MessageHistory`, `QuickActions`, `MeetingTranscriptPanel`, `ActiveModels`) to null. For `Completion`: copy `completion-notion-picker.test.tsx`'s harness, mocking `Input` to capture its props and the other children to test-id stubs.
  - `collapsed shows the Ask icon and no text box`.
  - `clicking the icon expands and clears both hides`.
  - `expanded focuses the text box` (`document.activeElement` is the input).
  - `empty and blurred collapses after the debounce, not before`.
  - `typed text keeps it open`; `loading keeps it open`; `open message history keeps it open`.
  - `refocus inside the debounce cancels the collapse`.
  - `attachInput gets the element on mount and null on unmount`.
  - `Completion: collapsed renders picker, screenshot and files`; `expanded renders none of them, keeps Audio`; `expanded keeps the meeting-log Undo strip during a hold`.
  - `Completion: expanding closes the picker and files popovers first`.
  - `Completion: focus-text-input expands`; `the listener is removed on unmount`; `StrictMode registers one listener`.
- [ ] **Step 2: Run** `npx vitest run src/tests/completion-ask-box.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement** the Interfaces and render contract above.
- [ ] **Step 4: Run** `npx vitest run src/tests/completion-ask-box.test.tsx src/tests/completion-calendar-wiring.test.tsx src/tests/completion-notion-picker.test.tsx src/tests/overlay-meeting-targets-survive.test.tsx src/tests/overlay-minimize-keeps-mounted.test.tsx src/tests/settings-page.meeting-auto-record.test.tsx`, then `npm run type-check` and `npm run lint`. Expected: PASS, 0 errors.
- [ ] **Step 5: Commit**
```bash
git add src/pages/app/components/completion/index.tsx src/pages/app/components/completion/Input.tsx src/hooks/useCompletion.ts src/types/completion.hook.ts src/tests
git commit -m "feat(overlay): Ask box folds to an icon"
```

---

### Task 11: Branch verification

- [ ] **Step 1:** `npm run lint`. Expected: 0 errors.
- [ ] **Step 2:** `npm run type-check`. Expected: 0 errors.
- [ ] **Step 3:** `npx vitest run` over every path in **Test paths**. Expected: all pass. A failure in a known-flake file is re-run alone before it counts as real.
- [ ] **Step 4:** `git grep -n "MeetingAssistToggle\|ENDED_CARD_DELAY_MS\|setMeetingAssistMode" -- src` → only `useMeetingAutoRecord.ts` comments or the lifecycle suite's own harness setter may remain; no production caller.
- [ ] **Step 5: Manual checks for the PR body** (a human runs them on Windows; record the results there, unrun ones as unrun):
  - Zoom open with no call: no `meeting-detected` within 30 s. If it fires, drop the Zoom entries and say so in the PR.
  - A real Teams call: hang up → the mic closes about 2 minutes later, the "call ended" notice shows, one `meeting_log_queue` row ends at the hang-up.
  - The record button pulses red while recording, in the overlay and on the pill.
  - Ctrl+Shift+I expands the Ask box focused; clicking away with it empty folds it back.
