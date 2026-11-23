# Send an Ended Meeting to Notion Right Away: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Send to Notion and Send to Odoo accept a conversation as soon as its meeting is over (not while the overlay merely has it open). A hand-pressed Notion send of an ended meeting opens the Notion send at once instead of after 30 quiet minutes.

**Architecture:**
- The overlay (`useCompletion`) keeps a new `localStorage` key, `meeting_conversation_id`. It is written imperatively from two refs: an open-window flag and the current conversation id ref. The Meetings page refuses only that conversation (or the system-audio capture).
- The scheduler step that turns a joined set of waiting rows into a send is pulled into one shared function, `openSends`, in `src/lib/notion/join.ts`. It can't live in `scheduler.ts`: `actions.ts` (dashboard window) must import neither `./scheduler` nor `./send`, and a source-scan test pins that (`notion-scheduler.test.ts:572-576`). The press paths in `src/lib/notion/actions.ts` call it with no quiet check. The tick calls it with its quiet check plus a heal re-link.
- A new send is inserted "held" (not yet due) and released only after its rows are linked. So no send runs before its rows are linked.

**Tech Stack:** React 19 hooks, Tauri 2 shared `localStorage`, SQLite through `@tauri-apps/plugin-sql` (no transactions), Vitest + Testing Library, sql.js for DB tests.

**Spec:** `docs/superpowers/specs/2026-11-23-send-ended-meeting-design.md`

**Spec amendment (made with this plan):** the spec's "No send runs before its rows are linked" bullet first proposed a linked-rows `EXISTS` on the `due` query. This plan instead holds a new send (`next_at = createdAt + 60 000`) and releases it (`next_at = 0`) right after its rows are linked, and only when that call inserted it.
- It gives the same guarantee, because every tick's join/heal loop runs before its due loop.
- It doesn't change `due`.
- It doesn't strand the many tests that insert bare sends.

The spec bullet is updated to match.

## Global Constraints

- **No database migration.** No `BEGIN`/`COMMIT` in JS (`notion-queue.action.ts` header): ordering plus compare-and-set only.
- **Refusal copy, exact, on both pages:** `This meeting is still being recorded, or only just ended. Try again in a minute.`
- **Storage key name:** `STORAGE_KEYS.MEETING_CONVERSATION_ID = "meeting_conversation_id"`. Only `useCompletion` writes it.
- **The refusal outcome keeps its name.** `"active"` (Notion) and `{ kind: "active" }` (Odoo) are not renamed.
- **Leaf-path import in `useCompletion`.** It imports the new storage helper from the leaf path `@/lib/storage/active-conversation.storage`, not the `@/lib` barrel. `useCompletion.meeting-assist.test.tsx` replaces `@/lib` wholesale (see the comment at `useCompletion.ts:38-41`).
- **`active_conversation_id` is unchanged.** Its writers and its readers (`knowledge-compactor.ts:84`, `useMeetingLog.ts:474`) stay as they are.
- **Automatic sends keep the 30-minute quiet wait.** Only a hand press skips it.
- **Verification.**
  - Run `npm run lint` and `npm run type-check` (the script is `type-check`, not `check:types`), plus the scoped `npx vitest run <files>`.
  - Tests are not type-checked by `tsconfig` (`src/tests` is excluded). Check an edited test file with a scratch tsconfig that extends the root one and `include`s it.
  - Don't run the full vitest suite as a gate: some tests flake under full-run load and fail on `main` too.

## Review Focus

1. **A silence of more than a minute during a live call** must not release the key. The late-line re-arm is only while capture is off. Test: Task 2, `keeps the key through a long silence while capturing`.
2. **Capture restarting while the over-point flush is in flight** (a rollover) must not leave the open flag false for the new meeting. Test: Task 2, `a capture restart during the over-point flush keeps the new meeting keyed`. It is a regression guard, not a pin for the `cancelled` flag: the save queue (`useCompletion.ts:360-367`) makes the release resume before the rollover's own flush, so the flag is defensive.
3. **The over-point save failing** keeps the key rather than letting the page go out without its tail. Test: Task 2, `keeps the key when the over-point save fails`.
4. **A press racing a background tick** gives exactly one send when the conversation's rows have no Notion state yet (`NULL` or `offered`). The heal-branch race is a known ceiling (Task 4). Test: Task 4, `a press racing a tick gives exactly one send`.
5. **A crash between inserting a send and linking its rows** must not run an empty send, and must heal. Tests:
   - Task 3, `a send whose link failed is held, then healed by the next tick`;
   - Task 4, `a re-press after a failed link heals the send`.

---

### Task 1: The meeting key, the shared check, and the new copy

**Files:**
- Modify: `src/config/constants.ts:67-72` (add the key after `CAPTURING_CONVERSATION_ID`)
- Modify: `src/lib/storage/active-conversation.storage.ts`
- Modify: `src/lib/notion/actions.ts:14-17, 39-41`
- Modify: `src/lib/odoo/meeting-log-actions.ts:584-589` (and its import at `:23`)
- Modify: `src/hooks/useNotionQueue.ts:160`
- Modify: `src/hooks/useMeetingLogQueue.ts:168`
- Test: `src/tests/notion-scheduler.test.ts:21-42, 119-123, 430-440`
- Test: `src/tests/send-conversation-to-odoo.test.ts:31-35, 137-143`
- Test: `src/tests/meetings-page.notion.test.tsx:678-685`
- Test: `src/tests/meetings-page.test.tsx:501-512`

**Interfaces:**
- Produces, all in `src/lib/storage/active-conversation.storage.ts`:
  - `setMeetingConversationId(id: string | null): void` (null removes the key, like `setCapturingConversationId`);
  - `getMeetingConversationId(): string | null`;
  - `isConversationRecording(id: string): boolean`, which is `id === getCapturingConversationId() || id === getMeetingConversationId()`.
- Produces: `STORAGE_KEYS.MEETING_CONVERSATION_ID`.

- [ ] **Step 1: Update the test mocks and write the failing tests**

`notion-scheduler.test.ts`:
- Add `meeting: null as string | null` to `m.active`. Reset it to `null` in `beforeEach`.
- Give the storage mock factory:
  - `getMeetingConversationId: () => m.active.meeting`;
  - `isConversationRecording: (id: string) => id === m.active.capturing || id === m.active.meeting`.
- Replace the test at `:430-440` with two tests:

```ts
it("refuses the recording and the capturing conversation, and an unconfigured Notion", async () => {
  m.active.meeting = "c1";
  expect(await sendConversationToNotion("c1", T0)).toBe("active");
  m.active.meeting = null;
  m.active.capturing = "c1";
  expect(await sendConversationToNotion("c1", T0)).toBe("active");
  m.active.capturing = null;
  m.isConfigured.mockResolvedValue(false);
  expect(await sendConversationToNotion("c1", T0)).toBe("not-configured");
  expect(m.emit).not.toHaveBeenCalled();
});

it("accepts the conversation the overlay only has open", async () => {
  m.active.id = "c1";
  seedRow({ id: "r1", notion_status: "offered" });
  expect(await sendConversationToNotion("c1", T0)).toBe("queued");
});
```

`send-conversation-to-odoo.test.ts`:
- Add `meeting: null as string | null` to `active`, with the same two mock functions.
- Reset `active.meeting = null` wherever the suite resets `active.id`.
- Replace `:137-143` with:
  - `refuses the conversation a meeting is still recording into`: set `active.meeting = "conv_1"` and expect `{ kind: "active" }` with `queue()` empty;
  - `sends the conversation the overlay only has open`: keep the old test's `message({ content: "said aloud" })` seed (with no saved line the outcome is `empty`), set `active.id = "conv_1"`, expect `kind` `"queued"`, and expect `queue()` to have length 1.

`meetings-page.notion.test.tsx:678-685`:
- Rename the test to `the 'active' outcome says the meeting is still being recorded`.
- Change the key the `getItem` spy answers to `"meeting_conversation_id"`.
- Expect the exact copy from Global Constraints.

`meetings-page.test.tsx:501-512`:
- Rename the test to `says why under the card when a meeting is still recording into the conversation`.
- Change the matcher to `/still being recorded, or only just ended/`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/tests/notion-scheduler.test.ts src/tests/send-conversation-to-odoo.test.ts src/tests/meetings-page.notion.test.tsx src/tests/meetings-page.test.tsx`
Expected: FAIL. The two "overlay only has open" tests get `"active"`, and the copy tests can't find the new text.

- [ ] **Step 3: Implement**

- `constants.ts`: add `MEETING_CONVERSATION_ID: "meeting_conversation_id"` with a comment: "the conversation a Meeting Assist meeting can still add lines to, from capture start until the over point after the stop; written only by useCompletion, read by the Meetings page."
- Storage file: add the three functions from Interfaces. Keep the doc-comment style of the file.
- `actions.ts`: replace the `:39` check with `if (isConversationRecording(conversationId)) return "active";`. Drop the two getter imports.
- `meeting-log-actions.ts`: make the same change in `enqueueConversation`.
- `SEND_OUTCOME_MESSAGE.active` and `SEND_ACTIVE_COPY`: set both to the exact copy.

- [ ] **Step 4: Run the tests, plus the other suites that load these modules**

First, `grep -rln "active-conversation.storage\|still going\|still open in the overlay" src/tests`. Every hit must be in the run list below; add any that is not, and update any old-copy assertion it holds. At plan time the storage mocks are in `notion-scheduler`, `send-conversation-to-odoo`, `meeting-log-entry-points`, `meeting-log-auto-notion`, `useMeetingLog.enqueue`, `useMeetingLog.hold` and `useSystemAudio.new-conversation`.

Run: `npx vitest run src/tests/notion-scheduler.test.ts src/tests/send-conversation-to-odoo.test.ts src/tests/meetings-page.notion.test.tsx src/tests/meetings-page.test.tsx src/tests/meeting-log-page.test.tsx src/tests/meeting-log-entry-points.test.tsx src/tests/meeting-log-auto-notion.test.tsx src/tests/meeting-log-actions.test.ts src/tests/useMeetingLog.enqueue.test.tsx src/tests/useMeetingLog.hold.test.tsx src/tests/useSystemAudio.new-conversation.test.tsx`
Expected: PASS.
- Any suite that fails with `No "isConversationRecording" export is defined on the mock` gets `isConversationRecording: () => false` added to its `active-conversation.storage` factory (or its shared `conversationStorage` object). Then re-run it.

- [ ] **Step 5: Commit**

```bash
git add src/config/constants.ts src/lib/storage/active-conversation.storage.ts src/lib/notion/actions.ts src/lib/odoo/meeting-log-actions.ts src/hooks/useNotionQueue.ts src/hooks/useMeetingLogQueue.ts src/tests
git commit -m "fix(meetings): refuse a send only while its meeting can still add lines"
```

---

### Task 2: The overlay writes the meeting key

**Files:**
- Modify: `src/hooks/useCompletion.ts`. The touch points:
  - the imports;
  - ref declarations near `currentConversationIdRef`;
  - `flushUnsavedMeetingTranscript` `:552-565`;
  - the three appends `:607-654`, `:660-706`, `:747-799`;
  - the other `ensureConversationId` calls `:402, 962, 1170, 1875`;
  - `clearMeetingTranscript` `:822`, `loadConversation` `:1465`, `startNewConversation` `:1507`;
  - the rollover effect `:1543-1580`;
  - the `meetingOver` effect `:1605-1626`;
  - the startup effect `:1734-1736`.
- Test: `src/tests/useCompletion.meeting-assist.test.tsx` (new `describe("the meeting key", …)` inside the meeting-assist describe that owns `micOn`, at `:1148`)

**Interfaces:**
- Consumes: `setMeetingConversationId(id: string | null)` and `STORAGE_KEYS.MEETING_CONVERSATION_ID` (Task 1).
- Produces: nothing new is exported. The key's contents are the contract: the current conversation id while `meetingOpenRef` is true, otherwise absent.

- [ ] **Step 1: Write the failing tests**

Set up the new describe:
- Use `vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })` and `vi.setSystemTime(new Date(2026, 10, 19, 10, 11))`, as in "the meeting is over" (`:1280-1287`).
- Back `localStorage` with a Map in `beforeEach`:
  - `setItem` writes to `store`, `removeItem` deletes from it, `getItem` returns `store.get(k) ?? null`;
  - `afterEach`: `mockReset()` all three and `vi.useRealTimers()`.
- Helpers:
  - `const key = () => store.get(STORAGE_KEYS.MEETING_CONVERSATION_ID) ?? null`;
  - `after(ms)`, as at `:1298`;
  - `settle = () => act(async () => { await vi.advanceTimersByTimeAsync(0); })`.
- A meeting line is `addMeetingTranscript(text, undefined, "microphone")`.
- `G` = `NEW_CONVERSATION_GAP_MS`.
- **Which save a flush calls:** a conversation's first save is `saveConversation`; every later one is `appendMessagesToConversation` (`useCompletion.ts:436-466`). One line under the autosave threshold is saved by the stop flush, so the over-point flush has work only when a line landed after the stop. To hold the over-point save open, add a post-stop line and give `appendMessagesToConversation` the deferred.

Write these tests (each assertion follows the action named):

| Test | Steps → assertions |
|---|---|
| `keys the conversation while capturing and through the stop` | `micOn()` → `key()` null; line → `"conversation-1"`; `setEnableVAD(false)` → `"conversation-1"`; `after(G - 1000)` → `"conversation-1"` |
| `releases the key at the over point` | line; stop; `after(G + 1000)`; `settle()` → `key()` null, `saveConversation` called |
| `holds the key until the over-point save lands` | line; stop; `settle()`; `after(10_000)`; post-stop line; `appendMessagesToConversation` returns a deferred; `after(G + 1000)`; `settle()` → `"conversation-1"` (save pending); resolve the deferred; `settle()` → null, and `appendMessagesToConversation` got the post-stop line |
| `a line during the over-point save re-arms the check` | as the row above up to the pending save; another line → still `"conversation-1"`; resolve the deferred; `settle()` → `"conversation-1"` (one line still unsaved, check re-armed); `after(G + 1000)`; `settle()` → null |
| `keys an id first assigned by a line appended after the stop` | `micOn` (no line); stop; `after(2_000)`; line → `"conversation-1"` |
| `follows the id to a loaded conversation during capture` | `micOn`; line; `loadConversation({ id: "loaded", … })` → `"loaded"` |
| `keeps the key when the over-point save fails` | `saveConversation.mockRejectedValue(new Error("disk"))`; line; stop; `after(G + 1000)`; `settle()` → `"conversation-1"` |
| `releases a chat that was open during a silent capture` | `loadConversation({ id: "chat-1", messages: [typed user message, no audioSource, timestamp now] , …})`; `micOn` → `"chat-1"`; stop; `after(G + 1000)`; `settle()` → null |
| `a new conversation after the stop releases the key` | line; stop; `await act(() => result.current.startNewConversation())` → null |
| `loading another conversation after the stop releases the key` | line; stop; `loadConversation({ id: "other", … })` → null; `after(G * 2)`; `settle()` → null |
| `follows the id to a new conversation during capture` | `micOn`; line → `"conversation-1"`; `startNewConversation()` → null; `generateConversationId.mockReturnValueOnce("conversation-2")`; line → `"conversation-2"` |
| `the rollover releases the old conversation` | line; `after(30_000)`; stop; `after(31_000)`; `setEnableVAD(true)`; `settle()` → null; `mockReturnValueOnce("conversation-2")`; line → `"conversation-2"` |
| `keeps the key through a long silence while capturing` | `micOn`; line; `after(G * 3)`; `settle()` → `"conversation-1"` |
| `a line after the over point re-keys and re-arms the check` | line; stop; `after(G + 1000)`; `settle()` → null; line → `"conversation-1"`; `after(G + 1000)`; `settle()` → null |
| `a capture restart during the over-point flush keeps the new meeting keyed` | line; stop; `settle()`; `after(10_000)`; post-stop line; `appendMessagesToConversation` returns a deferred; `after(G + 1000)` → over-point save pending, `"conversation-1"`; `setEnableVAD(true)`; resolve the deferred; `settle()`; `mockReturnValueOnce("conversation-2")`; line → `"conversation-2"` (regression guard, see Review Focus 2) |
| `clears a stale key on mount` | `store.set(STORAGE_KEYS.MEETING_CONVERSATION_ID, "stale")` before `renderHook` → null |

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/tests/useCompletion.meeting-assist.test.tsx -t "the meeting key"`
Expected: FAIL. `key()` is null wherever a value is expected, and the stale key survives mount.

- [ ] **Step 3: Implement in `useCompletion.ts`**

1. **Imports and declarations.**
   - Import `setMeetingConversationId` from `@/lib/storage/active-conversation.storage` (leaf path; add a one-line comment pointing at `:38-41`).
   - Move `const meetingCaptureActive = meetingAssistMode && enableVAD;`, `wasMeetingCaptureActiveRef` and the over effect's `hadCaptureRef` up, to just after the state they read. The helpers below read them. The comment blocks stay with their effects.
   - Declare `meetingOpenRef = useRef(false)` and `const [overCheckEpoch, setOverCheckEpoch] = useState(0)` next to `currentConversationIdRef`.
   - No ref for the flush: `flushUnsavedMeetingTranscript` is already stable (its chain `:565` → `:512` → `:367`/`:295` is all `[]`-deps), so the over effect lists it in its deps directly.
2. **`syncMeetingKey = useCallback(() => setMeetingConversationId(meetingOpenRef.current ? currentConversationIdRef.current : null), [])`.**
3. **`hasUnsavedMeetingTranscript = useCallback((): boolean => …, [])`** holds exactly the three-part guard now inlined in `flushUnsavedMeetingTranscript` (`:553-560`). The flush returns early when it is false.
4. **`noteMeetingLine = useCallback(() => …, [])`.** If `meetingOpenRef.current` or `wasMeetingCaptureActiveRef.current` is true, it returns. Otherwise it sets `meetingOpenRef.current = true` and `hadCaptureRef.current = true` (so the over effect's launch guard, `:1611`, can't leave a keyed conversation with no release path), then calls `setOverCheckEpoch((n) => n + 1)`.
5. **Appends:**
   - `addMeetingTranscript`: call `noteMeetingLine()` when `audioSource != null`.
   - `addMeetingTranscriptEntries`: call it when any entry has an `audioSource`.
   - `addSystemAudioTranscript`: always call it.

   In each, call `noteMeetingLine()` before `ensureConversationId`, then `syncMeetingKey()` right after it.
6. **Every other `ensureConversationId(currentConversationIdRef)` call** (`:402, 962, 1170, 1875`): add `syncMeetingKey()` right after it.
7. **`clearMeetingTranscript`, `loadConversation`, `startNewConversation`:** right after the line that assigns `currentConversationIdRef.current`, add `if (!wasMeetingCaptureActiveRef.current) meetingOpenRef.current = false;` then `syncMeetingKey();`.
8. **Rollover effect:** directly after the `if (history.length > 0) { … }` block, add `meetingOpenRef.current = true; syncMeetingKey();`. The early `return` inside that block (capture stopped during the flush) skips it on purpose. The IIFE's `.catch` handler (`:1579`) also does `if (wasMeetingCaptureActiveRef.current) { meetingOpenRef.current = true; syncMeetingKey(); }`: a rejected `startNewConversation` must not leave a live capture unkeyed.
9. **`meetingOver` effect:**
   - Deps: `[meetingCaptureActive, overCheckEpoch, flushUnsavedMeetingTranscript, hasUnsavedMeetingTranscript, syncMeetingKey]`.
   - Add `let cancelled = false`, set to true in the cleanup next to `clearTimeout`.
   - Add an async `release()`:
     - `const lenBefore = meetingTranscriptLengthRef.current`;
     - `await flushUnsavedMeetingTranscript().catch((e) => console.error("Over-point flush failed:", e))`;
     - return if `cancelled`;
     - if `hasUnsavedMeetingTranscript()`: when `meetingTranscriptLengthRef.current !== lenBefore` (a line landed during the flush, and `noteMeetingLine` skipped it because the flag was still true), call `setOverCheckEpoch((n) => n + 1)` to re-arm the check; then return. A failed save with no new line just keeps the key (spec ceiling). Don't re-arm on that case: each re-armed check dispatches `meetingOver` again, and `useOdooTarget.ts:865` clears the overlay's Odoo targets on it;
     - else `meetingOpenRef.current = false; syncMeetingKey();`.
   - The `lastLineAt === 0` return becomes `{ void release(); return; }`.
   - The `else` branch keeps dispatching `meetingOver` synchronously, exactly as now (its existing tests pin that timing), then calls `void release()`.
10. **Startup effect:** add `setMeetingConversationId(null);` next to `clearActiveConversationId();`.

- [ ] **Step 4: Run the whole file to verify all pass**

Run: `npx vitest run src/tests/useCompletion.meeting-assist.test.tsx src/tests/useCompletion.responded-model.test.tsx src/tests/odoo-target-new-chat-entry-points.test.tsx src/tests/summarize-current-conversation.slice.test.tsx src/tests/settings-page.meeting-auto-record.test.tsx`
Expected: PASS, including the existing "the meeting is over" tests (`:1303-1398`), unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useCompletion.ts src/tests/useCompletion.meeting-assist.test.tsx
git commit -m "fix(overlay): mark the conversation a meeting can still add lines to"
```

---

### Task 3: Hold a new send until it is linked; the shared `openSends`; the tick heal

**Files:**
- Modify: `src/lib/database/notion-queue.action.ts:42-45` (`insertSend`), `:163-172` (`createSendAndLink`)
- Modify: `src/lib/notion/join.ts` (add `openSends`; it may import `@/lib/database/notion-queue.action`, `@/lib/database/calendar-snapshot.action` and `@/lib/odoo/meeting-log`, never `./scheduler` or `./send`)
- Modify: `src/lib/notion/scheduler.ts:35-67`
- Test: `src/tests/notion-scheduler.test.ts` (new `describe("held sends and the heal", …)`)
- Test: `src/tests/notion-queue.action.test.ts` (its `next_at: 0` assertions at `:119, 254-255` must still hold; two new assertions, below)

**Interfaces:**
- Produces, in `join.ts`:

  ```ts
  export async function openSends(
    rows: WaitingRow[],
    now: number,
    ready: (set: WaitingRow[]) => Promise<boolean> = async () => true,
  ): Promise<void>
  ```

  It works out the live set with `conversationsWithLiveSend(now - STALE_CLAIM_MS)`. For each set in `joinSets(rows)`, it skips:
  - system audio (`conversation_id` starts with `sysaudio_conv_`);
  - a set whose conversation is live;
  - a set where `!(await ready(set))`.

  Otherwise it does the calendar snapshot (null for a null conversation) and `createSendAndLink`, exactly as `tick` does now.
- Changes `createSendAndLink(s, rowIds)` (same signature):
  - The insert writes `next_at = s.createdAt + SEND_HOLD_MS`, with `const SEND_HOLD_MS = 60_000` in `notion-queue.action.ts`.
  - It links the rows when `rowIds` is non-empty (today's early return at `:170` goes).
  - Then, only if the insert's `rowsAffected > 0`, it runs a new `NOTION_SQL.release` (`UPDATE notion_sends SET next_at = 0 WHERE id = ? AND status = 'retry'`). That includes an insert with empty `rowIds`: there is nothing to link, so it is released at once. `notion-send.test.ts:474-477` and `notion-queue.action.test.ts:122-129` insert that way and then claim or expect `next_at: 0`.
  - The doc comment says why: a send must not be due before its rows are linked, and a heal call (insert no-op) must not wipe a retry backoff.

- [ ] **Step 1: Write the failing tests**

New describe in `notion-scheduler.test.ts`. The constants:
- `Q = T0 + 10 * MIN + GAP + MIN` (seeded row quiet);
- `joinedSql = "SET notion_status = 'joined'"`.

| Test | Steps → assertions |
|---|---|
| `a new send is released once its rows are linked` | `seedRow({ id: "r1" })`; `await runNotionTick(deps(Q))` → `(await sends())[0]` has `next_at: 0`; `rowOf("r1").notion_status` `"joined"`; `m.runNotionSend` called with `"r1"` |
| `a send whose link failed is held, then healed by the next tick` | `seedRow({ id: "r1" })`; `m.execute` throws once for SQL containing `joinedSql` (else `rawExecute`); `await runNotionTick(deps(Q))` → one send `r1` with `next_at === Q + 60_000`, `rowOf("r1").notion_status` `"waiting"`, `runNotionSend` not called; `await runNotionTick(deps(Q + MIN / 2))` → `rowOf("r1").notion_status` `"joined"`, `runNotionSend` still not called; `await runNotionTick(deps(Q + 60_000))` → `runNotionSend` called once with `"r1"` |
| `the tick re-links a set whose send exists even when it is not quiet` | insert send `r1` (`status 'retry', next_at` = far future); `seedRow({ id: "r1", transcript_end_at: Q - MIN })`; `await runNotionTick(deps(Q))` → `rowOf("r1").notion_status` `"joined"`, `notion_send_id` `"r1"` |
| `openSends skips system audio and a conversation with a live send` | `openSends([wrow("a","sysaudio_conv_1",T0,T0+MIN), wrow("b","c2",T0,T0+MIN)], Q)` with a `sending` send for `c2` claimed at `Q` → `sends()` holds only the pre-seeded one |

In `notion-queue.action.test.ts`, next to the `createSendAndLink` tests (`:110-130`):
- `an insert with no rows to link is released at once`: `createSendAndLink(s, [])` → the send has `next_at: 0`.
- `a heal call does not wipe a retry backoff`: insert send `s` with `status 'retry'` and `next_at = NOW + 5 * MIN`; `createSendAndLink(s with the same id, ["r1"])` → `next_at` still `NOW + 5 * MIN`, and `r1` linked to `s`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/tests/notion-scheduler.test.ts -t "held sends and the heal"`
Expected: FAIL. `next_at` is 0 at insert, there's no re-link when not quiet, and `openSends` is not exported.

- [ ] **Step 3: Implement**

- `insertSend` takes `next_at` as a bound parameter instead of the literal `0`, and `createSendAndLink` behaves as in Interfaces.
- In `join.ts`, add `openSends`. In `scheduler.ts`, import it from `./join` and make `tick`'s loop:

  ```ts
  await openSends(await listWaitingRows(), now, async (set) =>
    (await getSend(set[0].id)) !== null || isQuiet(await lastOf(set), now))
  ```

  - `lastOf` is today's `last` computation (`scheduler.ts:46-50`), moved into a local `async` function (it awaits `lastSpokenLineAt`).
  - `live` and the system-audio skip move into `openSends`.
  - `getSend` is already exported from `notion-queue.action.ts`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/tests/notion-scheduler.test.ts src/tests/notion-queue.action.test.ts src/tests/notion-send.test.ts`
Expected: PASS. The existing `next_at: 0` assertions still hold, because a call that inserts releases.

- [ ] **Step 5: Commit**

```bash
git add src/lib/database/notion-queue.action.ts src/lib/notion/join.ts src/lib/notion/scheduler.ts src/tests/notion-scheduler.test.ts src/tests/notion-queue.action.test.ts
git commit -m "fix(notion): hold a new send until its rows are linked, heal a broken link"
```

---

### Task 4: A press opens the send now

**Files:**
- Modify: `src/lib/database/notion-queue.action.ts:118-127, 284-293` (`conversationRows` also selects `meeting_log_queue.transcript_start_at` and `meeting_log_queue.transcript_end_at`; `ConversationNotionRow` gains `transcript_start_at: number` and `transcript_end_at: number`)
- Modify: `src/lib/notion/actions.ts`
- Modify: `src/hooks/useNotionQueue.ts:236-245` (`onSendRows(rowIds, conversationId)`)
- Modify: `src/pages/meetings/components/NotionSection.tsx:11, 89` (pass `item.conversationId`)
- Test: `src/tests/notion-scheduler.test.ts` ("page actions" `:419-526` and "fix round 1" `:535-553`)
- Test: `src/tests/meetings-page.notion.test.tsx:64-75, 426-434`. It mocks `@/lib/database/notion-queue.action` with seven functions, and `actions.ts` runs for real on top of the mock. The press path now also calls `lastSpokenLineAt` (via `tailBeyond`), `listWaitingRows`, and, through `openSends`, `conversationsWithLiveSend` and `createSendAndLink`. Add them to the `notionQueue` mock, with defaults set in its `beforeEach`: `lastSpokenLineAt` resolves `null`, `listWaitingRows` resolves `[]`, `conversationsWithLiveSend` resolves `new Set()`, `createSendAndLink` resolves. Without them `:408-424` throws before `markRowsWaiting`. Rewrite the "already" test (`:426-434`). Its row (`waiting`, `notion_send_id: null`) now takes the heal branch, so use a row truly on its way instead: `notion_status: "joined"`, `notion_send_id: "r1"`, `lane_open: 1`, `send_status: "retry"`.

**Interfaces:**
- Consumes:
  - `openSends(rows, now, ready?)` from `./join` (Task 3; `actions.ts` still imports neither `./scheduler` nor `./send`);
  - `isConversationRecording(id)` (Task 1);
  - `lastSpokenLineAt(conversationId)` and `listWaitingRows()` (existing).
- Produces:
  - `sendRowsToNotion(rowIds: string[], conversationId: string | null, now: number = Date.now()): Promise<void>`;
  - `onSendRows: (rowIds: string[], conversationId: string | null) => Promise<void>` in `useNotionQueue` and in `NotionSectionProps`.

- [ ] **Step 1: Rewrite the existing assertions and write the failing tests**

Rewrite these existing tests in `notion-scheduler.test.ts` for "a press opens now":
- `:420-428`: `r1` and `r2` end `"joined"`, `notion_send_id` `"r1"` and `"r2"`, and two sends (the rows are more than `GAP` apart).
- `:442-454`: delete the `:443-444` lines from this test (it continues from the `joined` row). Add a separate test, `a press opens a conversation auto-Notion already queued`: `seedRow({ id: "r1" })` (waiting); the press gives `"queued"`, `r1` is `"joined"`, and there is one send.
- `:456-468`, `:470-479`: fresh rows end with `notion_status: "joined"`. In `:456-468` also set `m.active.id = "c1"` (spec: the overlay-only-open case is covered on the fresh-rows path too).
- `:486-493`: call `sendRowsToNotion(["r1"], "c1")` and expect `"joined"`.
- `:495-509`: call `sendRowsToNotion(["r1"], "c1")`. Assert the `s1` send by id (`(await sends()).find((s) => s.id === "s1")`), not `[0]`.
- `:535-545` (line `:544`), `:547-553` (line `:552`): expect `"joined"` where they expected `"waiting"`.

New tests:

| Test | Steps → assertions |
|---|---|
| `a press opens the offered rows now, with no quiet wait` | `seedRow({ id: "r1", notion_status: "offered" })`; press at `T0 + 11 * MIN` → `"queued"`, `r1` `"joined"`, one send with `next_at: 0`, `m.emit` called with `NOTION_KICK_EVENT` |
| `saved lines past the rows rebuild the send from the transcript` | `seedRow({ id: "r1", notion_status: null })` (ends `T0 + 10 * MIN`); `message("c1", T0 + 5 * MIN)`; `message("c1", T0 + 10 * MIN + 30_000, { content: "late words" })`; press at `T0 + 20 * MIN` → `r1.notion_status` stays `null`; exactly one other row, `"joined"`, its transcript contains `"late words"`; one send |
| `the tail rule applies to an auto-queued conversation too` | as above but `r1` seeded `"waiting"` → `r1` `"cancelled"`; the fresh row is `"joined"` with `"late words"`; one send |
| `sendRowsToNotion opens an ended conversation and joins its waiting siblings` | `seedRow({ id: "r1", notion_status: "offered" })`; `seedRow({ id: "r2", transcript_start_at: T0 + 15 * MIN, transcript_end_at: T0 + 20 * MIN })` (waiting); `sendRowsToNotion(["r1"], "c1", T0 + 21 * MIN)` → both `"joined"` to send `"r1"`; one send |
| `sendRowsToNotion rebuilds from the transcript when saved lines pass the rows` | offered `r1` (ends `T0 + 10 * MIN`); `message("c1", T0 + 5 * MIN)`; `message("c1", T0 + 10 * MIN + 30_000, { content: "late words" })`; `sendRowsToNotion(["r1"], "c1", T0 + 20 * MIN)` → `r1` `"cancelled"`; one other row, `"joined"`, transcript contains `"late words"`; one send |
| `a saved line exactly at the row end does not rebuild` | `seedRow({ id: "r1", notion_status: "offered" })`; `message("c1", T0 + 10 * MIN)` (= `transcript_end_at`); press at `T0 + 20 * MIN` → `r1` `"joined"` to send `"r1"`; no other row; one send |
| `a typed line past the row end does not rebuild` | offered `r1`; `message("c1", T0 + 15 * MIN, { audio_source: null })`; press at `T0 + 20 * MIN` → `r1` `"joined"`; no other row; one send |
| `sendRowsToNotion on a stale item sends nothing` | `seedRow({ id: "r1", notion_status: "cancelled" })`; `message("c1", T0 + 15 * MIN)`; `sendRowsToNotion(["r1"], "c1", T0 + 20 * MIN)` → no new row, no sends, kick emitted |
| `a tail rebuild leaves an earlier meeting already in Notion alone` | `seedRow({ id: "r1", notion_status: "joined", notion_send_id: "s1" })` with send `s1` `sent`; `message("c1", T0 + 5 * MIN)`; offered `r2` (`transcript_start_at: T0 + 50 * MIN`, `transcript_end_at: T0 + 60 * MIN`); `message("c1", T0 + 55 * MIN)`; `message("c1", T0 + 60 * MIN + 30_000, { content: "late words" })`; `sendRowsToNotion(["r2"], "c1", T0 + 70 * MIN)` → `r2` `"cancelled"`; exactly one new row, starting at `T0 + 55 * MIN`, `"joined"`, with `"late words"`; no new row before `T0 + 50 * MIN`; sends are `s1` plus one |
| `a failed fresh insert leaves nothing queued twice` | waiting `r1`; `message("c1", T0 + 5 * MIN)`; `message("c1", T0 + 10 * MIN + 30_000)`; `m.execute` throws once on `INSERT INTO meeting_log_queue`; press at `T0 + 20 * MIN` rejects → `r1` `"cancelled"`, no other row, no sends; a second press → `"queued"`, one fresh `"joined"` row, one send |
| `sendRowsToNotion leaves a recording conversation waiting` | `m.active.meeting = "c1"`; offered `r1`; `sendRowsToNotion(["r1"], "c1")` → `r1` `"waiting"`, no sends, kick emitted |
| `sendRowsToNotion opens a row with no conversation now` | `seedRow({ id: "r1", conversation_id: null, notion_status: "offered" })`; `sendRowsToNotion(["r1"], null)` → `r1` `"joined"`, one send with `conversation_id` null |
| `sendRowsToNotion does not open system audio` | `seedRow({ id: "r1", conversation_id: "sysaudio_conv_1", notion_status: "offered" })`; `sendRowsToNotion(["r1"], "sysaudio_conv_1")` → `r1` `"waiting"`, no sends |
| `a press racing a tick gives exactly one send` | `seedRow({ id: "r1", notion_status: null })`; `N = T0 + 10 * MIN + 2 * GAP`. Wrap `m.select`: the first SQL containing `calendar_snapshots` waits on a gate opened by the second. Start `p = sendConversationToNotion("c1", N)`; `await vi.waitFor` until `r1` is `"waiting"`; start `t = runNotionTick(deps(N))`; `await Promise.all([p, t])` → `sends()` length 1, `r1` `"joined"` to `"r1"` |
| `a press then a tick leaves one send` | same seed; press at `N`; `runNotionTick(deps(N))` → one send |
| `a re-press after a failed link heals the send` | offered `r1`; `m.execute` throws once on SQL containing `"SET notion_status = 'joined'"`; `await expect(sendConversationToNotion("c1", N)).rejects.toThrow()`; then `await sendConversationToNotion("c1", N)` → `"queued"`, `r1` `"joined"`, one send, `next_at` `N + 60_000` (held: the healing call didn't insert, so it doesn't release; the tick runs it at the hold's end) |

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/tests/notion-scheduler.test.ts -t "page actions|fix round 1"`
Expected: FAIL. Rows are left `"waiting"` with no send, the waiting-row press returns `"already"`, and `sendRowsToNotion` has no conversation parameter.

- [ ] **Step 3: Implement**

`actions.ts`:
- Private `tailBeyond(conversationId: string, rowsEnd: number): Promise<boolean>` returns `((await lastSpokenLineAt(conversationId)) ?? 0) > rowsEnd`.
- Private `insertFreshRows(conversationId: string, now: number, supersede: string[], fromAt: number): Promise<boolean>`. This is today's fresh-rows block (`:70-93`) with two changes:
  - It keeps only segments whose end is `>= fromAt`, so a rebuild never re-sends an earlier meeting of the same conversation. Callers pass the earliest `transcript_start_at` of the rows being replaced, or `0` when there are none.
  - It runs `cancelOfferedRows(supersede)` **before** the inserts, not after. The superseded rows now include `waiting` ones. If a failure lands between the two steps after the inserts, old and fresh waiting rows overlap, `joinSets` joins them, and the page shows every line twice. Cancelling first means a failure leaves nothing queued, and a re-press rebuilds.

  It returns `false`, and cancels nothing, when no segment is left (compute the segments first).
- Private `openConversation(conversationId: string, now: number): Promise<void>` calls `openSends((await listWaitingRows()).filter((r) => r.conversation_id === conversationId), now)`.

`sendConversationToNotion`, after the recording and config checks:
1. `heal = rows.filter((r) => r.notion_status === "waiting" && r.notion_send_id === null)`.
2. The "already" test excludes heal rows from the lane-open arm: `r.lane_open && r.notion_status !== "offered" && !heal.includes(r)`. The other arms are unchanged.
3. `candidates` is unchanged. `pending = [...candidates, ...heal]`.
4. If `pending.length > 0`, every candidate transcript is non-blank, and `!(await tailBeyond(id, max transcript_end_at of pending))`: `markRowsWaiting(candidate ids)`.
5. Otherwise: if `!(await insertFreshRows(id, now, [...offered candidate ids, ...heal ids], earliest transcript_start_at of pending, or 0 when pending is empty))`, return `"empty"`.
6. `await openConversation(id, now)`, then `await kick()`, then return `"queued"`.

`sendRowsToNotion(rowIds, conversationId, now = Date.now())`:
- `await offerRowsToWaiting(rowIds)`.
- If `conversationId === null`: `openSends(waiting rows whose id is in rowIds, now)`.
- Else, if it is not system audio and `!isConversationRecording(conversationId)`:
  - `waiting` = that conversation's waiting rows. If it is empty (a stale item: the offer changed nothing), skip to the kick. The max of an empty list is `-Infinity`, and that would make `tailBeyond` rebuild the whole conversation;
  - if `await tailBeyond(conversationId, max transcript_end_at of waiting)`, run `insertFreshRows(conversationId, now, waiting ids, earliest transcript_start_at of waiting)`;
  - then `openConversation(conversationId, now)`.
- Always `await kick()`.

**Known ceiling (heal-branch race).** A press on a conversation that has both waiting rows and offered rows can race a tick that finds the waiting rows quiet. The two may pick different first rows and make two sends. This sits with the `sendRowsToNotion` race in the spec's Known ceilings. It is not fixed here, and needs no test.

`useNotionQueue.onSendRows(rowIds, conversationId)` passes both through. `NotionSection` calls `onSendRows(item.rowIds, item.conversationId)`. Its prop type matches.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/tests/notion-scheduler.test.ts src/tests/notion-queue.action.test.ts src/tests/meetings-page.notion.test.tsx src/tests/meetings-page.test.tsx src/tests/meeting-log-page.test.tsx`
Expected: PASS.

- [ ] **Step 5: Lint, type-check, and type-check the edited tests**

- Run: `npm run lint` and `npm run type-check`. Expected: no errors.
- Then run `npx tsc --noEmit -p <scratch tsconfig>`. The scratch tsconfig extends `./tsconfig.json` and includes the edited test files. Expected: no new errors in them.

- [ ] **Step 6: Commit**

```bash
git add src/lib/database/notion-queue.action.ts src/lib/notion/actions.ts src/hooks/useNotionQueue.ts src/pages/meetings/components/NotionSection.tsx src/tests/notion-scheduler.test.ts src/tests/meetings-page.notion.test.tsx
git commit -m "feat(notion): a hand-pressed send of an ended meeting goes to Notion now"
```
