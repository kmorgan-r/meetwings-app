# Send an ended meeting to Notion right away: design

2026-11-23. A small change. The approach (A + X below) is Kevin's pick.

## Intent

Kevin finished a call (Chrome's call ended 10:05:26, the recording stopped 10:05:31). The Odoo note
and its AI summary showed up on the Meetings page a minute later, and that summary was his cue that
the meeting was done. He pressed **Send to Notion** and got "This conversation is still going. Send
it once it ends." The meeting had ended. The message was wrong.

The refusal comes from `sendConversationToNotion` (`src/lib/notion/actions.ts:39`). It refuses
the conversation the overlay has open (`active_conversation_id`), not the one being recorded. The
overlay keeps its conversation open after a call until the user starts a new one or restarts the
app, so every meeting that just ended is refused.

He wants: once a meeting has ended, one press of Send to Notion puts it in Notion within a minute
or two.

## Goals

1. Send to Notion accepts a conversation as soon as the meeting in it has ended.
2. A hand-pressed send of an ended meeting opens the Notion send immediately, so the 30-minute wait
   doesn't apply to it.
3. The **Send to Odoo** button (`enqueueConversation`, the same check) gets the same rule.

## Non-goals

- Automatic sends (ticked or Notion-only) keep the 30-minute quiet wait (spec 2026-11-11, section 5).
- Auto-Notion's calendar rules (Google event, no Outlook, inside the event) are unchanged.
- `active_conversation_id` keeps its other jobs unchanged: the knowledge backfill skip
  (`knowledge-compactor.ts:84`) and meeting-log recovery (`useMeetingLog.ts:474`).
- System-audio conversations still can't be sent to Notion.

## Anti-goals

- **A partial Notion page.** A send must never open while the conversation can still gain meeting
  lines, or while lines it already has are only in the overlay's memory. A line missing when the
  page went out would never reach it: for Kevin the later row isn't Notion-bound, so it isn't
  joined.
- **Two pages for one meeting** when a hand press and the background check run at the same time.

## Constraints

- No database migration.
- The Meetings page runs in the dashboard window. Recording state lives in the overlay. The two
  share `localStorage`, which the app already uses for `active_conversation_id` and
  `capturing_conversation_id`.
- The Notion scheduler (`src/lib/notion/scheduler.ts`) runs in the overlay. The Meetings page only
  writes to the database and emits `NOTION_KICK_EVENT`.
- SQLite access has no transactions (`notion-queue.action.ts` header): ordering plus
  compare-and-set replaces atomicity, so every multi-step write needs a stated heal path.

## Approaches

**Part 1: how the Meetings page learns the meeting has ended.**
- **A (picked).** The overlay keeps a "still recording into conversation X" key in shared storage
  and clears it once the meeting is over. The send buttons check it. It's cheap and uses the same
  rule as the rollover.
- B. The Meetings page asks the overlay live, over a Tauri event, on every press. Nothing is
  stored, but each press waits on the other window and needs timeout handling. More code for the
  same answer.
- Dropped: guessing from saved lines. A quiet stretch mid-call looks ended, which gives a partial
  page.
- Dropped: clearing `active_conversation_id` at meeting end. That would change knowledge backfill
  and recovery.

**Part 2: skipping the wait for a hand-pressed send.**
- **X (picked).** The press opens the Notion send itself: the same step the scheduler does after
  30 quiet minutes, pulled into one shared function. It's stored in the database, so it survives
  a restart. No migration.
- Y. A "send now" flag on rows that the scheduler honours. Just as durable, but it needs a
  migration and touches more queries.
- Dropped: a "send now" payload on the kick event. It's lost if the overlay misses it, and the
  meeting silently falls back to waiting 30 minutes.

## Design

### Part 1: the meeting key

- New key `STORAGE_KEYS.MEETING_CONVERSATION_ID` (`"meeting_conversation_id"`), with
  `setMeetingConversationId` / `getMeetingConversationId` / `clearMeetingConversationId` and
  `isConversationRecording(id)` in `src/lib/storage/active-conversation.storage.ts`, next to the
  capturing key. Only `useCompletion` writes it.
- **What it holds:** the overlay's current conversation id while that conversation can still gain
  meeting lines, or still has meeting lines not yet saved; otherwise nothing.
- **Not derived from React state.** A meeting-only conversation never gets its id into
  `state.currentConversationId`: the transcript appends and the autosave assign it to
  `currentConversationIdRef` only (`ensureConversationId`, `useCompletion.ts:402, 633, 679, 776`;
  `setActiveConversationId` at `:467`; see the stale-null note at `:1665`). An effect keyed on
  state would never see the id. So the key is written imperatively from two refs:
  - **`meetingOpenRef`**, a boolean, is the "open window":
    - set true at the capture edge (`meetingCaptureActive` false→true);
    - set true again, and the over check re-armed, when a meeting line is appended while it is
      false (guards a line whose STT round trip lands after `meetingOver`);
    - set false at the `meetingOver` dispatch and at the nothing-said return
      (`useCompletion.ts:1618`), each **after** the flush below;
    - set false when the user starts or loads another conversation while capture is off. The old
      conversation has lost its refs and can't gain lines;
    - set false on overlay startup, next to `clearActiveConversationId()` (`useCompletion.ts:1735`).
  - **`currentConversationIdRef`**, the existing ref.
- **One writer, `syncMeetingKey()`.** It does `meetingOpenRef.current && currentConversationIdRef.current ?
  set(that id) : clear()`. It is called after every write to either ref: each `ensureConversationId`
  call and each direct assignment of `currentConversationIdRef` (`useCompletion.ts:822, 1465, 1507,
  1788`; grep `currentConversationIdRef.current =` and `ensureConversationId(`), plus each change
  to `meetingOpenRef`. It reads only refs, so at mount (ref null) it writes nothing, and the startup
  clear has no ordering dependency on other effects.
- **Why it's gated on `meetingOpenRef`, not `meetingCaptureActive`.** The id can be assigned
  *after* the stop. The recording-stop flush (`useCompletion.ts:1593-1597`) runs when capture is
  already off, and a short call that never autosaved gets its id there. That conversation can still
  gain lines until `meetingOver`.
- **At the capture edge,** set `meetingOpenRef` true, but call `syncMeetingKey()` only after the
  rollover decision (after `await startNewConversation()` at `useCompletion.ts:1563`). An ended
  conversation is then never briefly re-marked. A rollover with capture on keeps the flag true, and
  its `startNewConversation` nulls the ref, which clears the key until the first new line assigns
  the new id. So the old conversation is released at the rollover even though the stop timer was
  cancelled (`useCompletion.ts:1625`).
- **Flush before clear.** At `meetingOver` and at nothing-said, `await flushUnsavedMeetingTranscript()`
  first, then set the flag false and sync. Post-stop lines below the autosave threshold
  (`MEETING_TRANSCRIPT_AUTOSAVE_INTERVAL` = 4) otherwise live only in memory, and the press reads
  only the database. If the flush rejects, keep the key (see Known ceiling).
- **The over check reads the right conversation.** The flag ends when the user switches
  conversation after the stop, so whenever the timer fires with the flag still true, the current
  conversation is the keyed one.
- **Shared check:** `isConversationRecording(id)` returns `id === getCapturingConversationId() ||
  id === getMeetingConversationId()`. It replaces the active-id check in `sendConversationToNotion`
  (`actions.ts:39`) and in `enqueueConversation` (`src/lib/odoo/meeting-log-actions.ts:584`).
- **Wording, on both pages:** "This meeting is still being recorded, or only just ended. Try again
  in a minute." It replaces `SEND_OUTCOME_MESSAGE.active` (`src/hooks/useNotionQueue.ts`) and
  `SEND_ACTIVE_COPY` (`src/hooks/useMeetingLogQueue.ts:168`). It has to be true both while
  recording and in the minute after the stop. The key covers both, because a capture inside that
  minute continues the same conversation.
- **Behaviour change:** a chat reopened from history in the overlay is now sendable. A capture
  started on it would roll over to a new conversation anyway.

### Part 2: opening the send on the press

- **Shared function.** Pull out the step in `tick` (`scheduler.ts:41-66`) that turns one joined set
  of waiting rows into a send. It includes:
  - the system-audio skip and the live-send skip (`scheduler.ts:44-45`);
  - the calendar snapshot lookup;
  - `createSendAndLink`.

  `tick` keeps only the quiet check around it.
- **`sendConversationToNotion`, on its `queued` paths** (rows marked waiting, or fresh rows
  inserted): it reads this conversation's waiting, unlinked rows, runs `joinSets` on them, opens a
  send per set through the shared function, then kicks. There's no quiet check: Part 1 already
  guarantees nothing more can be said into the conversation and that its lines are saved.
- **Saved tail beyond the rows.** Before marking existing rows waiting, compare their max
  `transcript_end_at` with `lastSpokenLineAt(conversationId)`. If saved meeting lines run past the
  rows (lines that landed after the stop trigger cut its row), take the fresh-rows path, which
  rebuilds from the saved transcript, instead of sending the stop row alone.
- **`sendRowsToNotion`** (the button on an *offered* item) does the same after
  `offerRowsToWaiting`, but only when its rows' conversation isn't recording. If it is recording,
  the rows wait as today. Rows with no conversation id come from recovery of an earlier run, so they
  open now. *(My call: it's also a hand press, and keeps the "hand press of an ended meeting sends
  now" rule whole.)* It deliberately joins any sibling waiting rows of the same conversation into
  the set. The conversation has ended, and leaving them would put the same meeting on a second
  page. It needs the item's conversation id, which `NotionItem` already carries.
- **A race with a concurrent tick is safe.** Both pick the same set id (its first row). The
  "already" check means no other waiting rows exist in the conversation, and `markRowsWaiting` is
  one UPDATE, so both compute the same set. `insertSend` is `ON CONFLICT(id) DO NOTHING`, and
  linking only touches rows still `waiting` with no send id.
- **Heal a crash between insert and link.** `createSendAndLink` relies on a repeat call to heal
  (`notion-queue.action.ts:163`), and a new send is due at once (`'retry', 0`). So:
  - `tick` re-links a set regardless of the quiet check when a send with that set's id already
    exists.
  - A press on a conversation whose lane-open rows are all `waiting` with no send runs the open
    step again and returns `queued`, rather than `already`. So a press that failed partway can be
    retried and doesn't fall back to the 30-minute wait.
- **What the user sees:** the badge goes straight to "Sending to Notion" (a new send starts as
  `retry`), then "In Notion" once the overlay's next tick writes the summary and the page.

## Left to the builder

- Whether the `"active"` outcome is renamed (for example to `"recording"`) or keeps its name.
- The shared function's name and home: `scheduler.ts` or `join.ts`.
- How `sendRowsToNotion` gets the conversation id: a new parameter from the item, or a lookup.

## Tests

The host files:
- `src/tests/useCompletion.meeting-assist.test.tsx` for the key;
- `src/tests/notion-scheduler.test.ts` for `sendConversationToNotion` and `sendRowsToNotion`;
- `src/tests/send-conversation-to-odoo.test.ts` for `enqueueConversation`.

Use fake timers.

- **`useCompletion`.** The key:
  - is set during capture once an id exists, including an id first assigned by the recording-stop
    flush;
  - is kept through the stop;
  - follows the id to a new or loaded conversation during capture;
  - is cleared at the rollover's `startNewConversation` and re-set to the new id at its first line;
  - is cleared at `meetingOver`, at nothing-said, at a new or loaded conversation after the stop,
    and on startup;
  - is set again by a meeting line appended after `meetingOver`;
  - is cleared only after the flush lands, and is kept when the flush rejects.
- **`sendConversationToNotion`:**
  - With only `active_conversation_id` set, the conversation is queued, a send record is created
    and its rows are joined straight away. Cover this on both the mark-waiting path and the
    fresh-rows path.
  - With the meeting key or the capturing key set, it returns the refusal and changes no rows.
  - Saved lines past the stop row (one line after the stop, under the autosave threshold, then
    flushed) appear in the opened send.
  - A press racing a tick gives exactly one send. Make it deterministic:
    - seed already-quiet waiting rows on the real sql.js DB;
    - start the tick and the press together, with the snapshot lookup held so they interleave;
    - assert one `notion_sends` row;
    - also cover the sequential case, where a press then a tick leaves one send.
  - A failure between insert and link heals, through the next tick's re-link and through a
    re-press.
- **`sendRowsToNotion`:**
  - an ended conversation opens now, with sibling waiting rows joined;
  - a recording one stays waiting;
  - a null-conversation row opens now;
  - a system-audio conversation is not opened.
- **`enqueueConversation`:** with only `active_conversation_id` set, the conversation is queued.
  With the meeting key set, it is refused.
- **Existing tests:**
  - **Rewrite them for the new behaviour:**
    - `notion-scheduler.test.ts`: the refusal test at `:430-440`, and the "page actions" assertions
      that expect `waiting` after a press (`:424-427, 453, 460-467, 473-477, 490-497, 539, 550`).
      Those now expect `joined` rows plus a `notion_sends` row, except for a recording
      conversation.
    - `meetings-page.notion.test.tsx:678-684`, `meetings-page.test.tsx:501-512` and
      `send-conversation-to-odoo.test.ts`: set the meeting key instead of `active_conversation_id`,
      assert the new wording, and rename the "overlay still holds the conversation" title.
  - **Fix the storage mocks.** The factory mocks of `active-conversation.storage` export only the
    two old getters (`notion-scheduler.test.ts:39-42`, `send-conversation-to-odoo.test.ts:32-35`,
    `meeting-log-auto-notion.test.tsx:66`, `meeting-log-entry-points.test.tsx:230`,
    `useMeetingLog.*.test.tsx`). Extend every one the changed code reaches with the new
    functions, or switch it to a partial mock over `importActual`. Then run each affected file.

## Known ceiling

- **Overlay crash mid-meeting.** The key stays set until the app restarts, and the send buttons
  refuse that one conversation until then. Restarting clears it.
- **A press in the first minute after the stop is refused.** The window runs to the last line plus
  `NEW_CONVERSATION_GAP_MS`, because a capture started inside it continues the same conversation.
  The wording says so.
- **A failed flush at the over point keeps the key.** The conversation stays refused until the
  next meeting's over point or a restart, rather than sending a page without its tail.
- **The Odoo stop trigger runs past the over point.** For example, it may still be waiting on the
  Outlook read (`useMeetingLog.ts:532-537`). A Send to Odoo press in that window could insert a
  second row. The accepted protection is the 60-second margin plus the "already-queued" badge
  check (`meeting-log-actions.ts:595`) once the trigger's row lands.
