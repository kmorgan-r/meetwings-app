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
  lines. A line said after the page went out would never reach it: for Kevin the later row isn't
  Notion-bound, so it isn't joined.
- **Two pages for one meeting** when a hand press and the background check run at the same time.

## Constraints

- No database migration.
- The Meetings page runs in the dashboard window. Recording state lives in the overlay. The two
  share `localStorage`, which the app already uses for `active_conversation_id` and
  `capturing_conversation_id`.
- The Notion scheduler (`src/lib/notion/scheduler.ts`) runs in the overlay. The Meetings page only
  writes to the database and emits `NOTION_KICK_EVENT`.

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
  `setMeetingConversationId` / `getMeetingConversationId` in
  `src/lib/storage/active-conversation.storage.ts`, next to the capturing key. Only `useCompletion`
  writes it.
- **What it holds:** the overlay's current conversation id while that conversation can still gain
  meeting lines, otherwise nothing. That window is:
  - from the moment Meeting Assist capture is active (`meetingCaptureActive`, `useCompletion.ts:1543`)
    and the conversation has an id (the id can arrive later, at the first autosave),
  - through the stop, and
  - until the overlay's existing "over" point: the `meetingOver` check at `useCompletion.ts:1605-1626`
    (last meeting line + `NEW_CONVERSATION_GAP_MS`, 1 minute). This is the rollover's own rule
    (`useCompletion.ts:1543-1580`). After it, the next capture starts a new conversation, so this
    one can never gain another meeting line.
- **It follows the id.** A new conversation or a loaded conversation during capture moves the key to
  the new id. A new conversation started after the stop clears it, because the old one has lost
  its refs and can't gain lines.
- **Cleared:**
  - at the `meetingOver` dispatch;
  - when that check finds nothing was said (the `lastLineAt === 0` return at line 1618). Otherwise
    a chat that was open during a silent capture stays refused;
  - on overlay startup, next to the existing `clearActiveConversationId()` (`useCompletion.ts:1735`).
- **Shared check:** `isConversationRecording(id)` returns `id === getCapturingConversationId() ||
  id === getMeetingConversationId()`. It replaces the active-id check in `sendConversationToNotion`
  (`actions.ts:39`) and in `enqueueConversation` (`src/lib/odoo/meeting-log-actions.ts:584`).
- **Wording, on both pages:** "This meeting is still being recorded. Send it once it ends." It
  replaces `SEND_OUTCOME_MESSAGE.active` (`src/hooks/useNotionQueue.ts`) and `SEND_ACTIVE_COPY`
  (`src/hooks/useMeetingLogQueue.ts:168`).
- **Behaviour change:** a chat reopened from history in the overlay is now sendable. A capture
  started on it would roll over to a new conversation anyway.

### Part 2: opening the send on the press

- Pull the step in `tick` (`scheduler.ts:41-64`) that turns one joined set of waiting rows into a
  send (the calendar snapshot lookup plus `createSendAndLink`) into a shared function. `tick` keeps
  its own guards around it: system-audio skip, live-send skip, quiet check.
- `sendConversationToNotion`, on its `queued` paths (rows marked waiting, or fresh rows inserted):
  reads this conversation's waiting, unlinked rows, runs `joinSets` on them, opens a send per set
  through the shared function, then kicks. There's no quiet check: Part 1 already guarantees
  nothing more can be said into it.
- `sendRowsToNotion` (the button on an *offered* item) does the same after `offerRowsToWaiting`,
  but only when its rows' conversation isn't recording. If it is recording, the rows wait as today.
  Rows with no conversation id come from recovery of an earlier run, so they open now. *(My call:
  it's also a hand press, and keeps the "hand press of an ended meeting sends now" rule whole.)*
- **A race with a concurrent tick is safe.** Both pick the same set id (its first row). `insertSend`
  is `ON CONFLICT(id) DO NOTHING`, and linking only touches rows still `waiting` with no send id.
- **What the user sees:** the badge goes straight to "Sending to Notion" (a new send starts as
  `retry`), then "In Notion" once the overlay's next tick writes the summary and the page.

## Left to the builder

- Whether the `"active"` outcome is renamed (for example to `"recording"`) or keeps its name.
- How the overlay works out "can still gain lines". For example, a state set false at capture start
  and true at `meetingOver` or nothing-said, combined with `meetingCaptureActive` and the current id
  in one effect.
- The shared function's name and home: `scheduler.ts` or `join.ts`.

## Tests

- `useCompletion`: the key is set during capture once an id exists, kept through the stop, and
  cleared at `meetingOver`, at nothing-said, at a new conversation after the stop, and on startup.
- `sendConversationToNotion`:
  - an open but ended conversation is queued, with a send record created and its rows joined
    straight away;
  - a recording conversation returns the refusal and changes no rows;
  - a press racing a tick gives exactly one send.
- `sendRowsToNotion`: an ended conversation opens now; a recording one stays waiting.
- `enqueueConversation`: an open but ended conversation is queued.
- Update the existing tests that set `active_conversation_id` to get a refusal
  (`meetings-page.notion.test.tsx`, `send-conversation-to-odoo.test.ts`, `meetings-page.test.tsx`)
  to set the meeting key instead.

## Known ceiling

If the overlay crashes mid-meeting, the key stays set until the app restarts, and the send buttons
refuse that one conversation until then. Restarting clears it.
