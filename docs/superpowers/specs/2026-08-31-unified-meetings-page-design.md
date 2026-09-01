# Unified Meetings page, conversation renaming, speaker-labelled transcripts

Date: 2026-08-31 (revised 2026-09-01 after spec review)
Branch: `feat/unified-meetings-page`

## Branch point

Originally cut from `feat/odoo-multi-target-assignment-design` because `main`
lacked the multi-target work. **That branch has since merged** (PR #48, merged
2026-08-30), so this branch is now simply `main` plus this document.

The consequences of the original branch point still hold and are now facts
rather than assumptions:

- `main` carries migration 14 (`odoo-multi-target.sql`). `src-tauri/src/db/main.rs`
  registers versions 1-14, so **15 is the next free version**.
- `QueueRow.tsx` on `main` has `onRetryTarget`, `onRemoveTarget` and
  `listTargets`. The action strip composes those directly.

## Scope

Four items, from a brainstorming session on 2026-08-31.

1. Merge the Chats and Meeting log pages into one page.
2. Let the user rename a conversation, and stop the automatic titlers
   overwriting that rename.
3. Make the downloaded transcript name its speakers instead of labelling every
   line `## USER:`.
4. Fix the duplicate-conversation mint. (Investigation complete — findings
   below. The code fix is in scope; repairing historical rows is not.)

**Order dependency:** item 1 lands before item 2. Item 2's rename UI is
specified against item 1's artifacts — the new list row, and the `ViewChat`
header after it moves to `/meetings/view/:id`. Items 3 and 4 are independent of
both.

## Item 4 findings, as investigated

Read from the live database at
`AppData/Roaming/com.meetwings.app/meetwings.db` (9.7 MB, 71 conversations),
copied to a scratch directory and opened read-only.

**Wednesday 2026-08-26 is clean.** Five conversations, no duplicates. Two of
them share the title "Brief Sign-off Exchange" (12:01, 52 messages; 13:00, 64
messages) but their contents differ. The AI titler gave both the same generic
name because both opened with "Bye." This is a naming defect, addressed by item
2, not a double-save.

**Five double-mint pairs do exist**, spread over months:

| Gap | Rows |
|---|---|
| 15.5s | 2026-08-19 12:30:55 (2 msgs) + 12:31:11 (856 msgs) |
| 10.7s | 2026-08-25 13:30:59 (297 msgs) + 13:31:10 (267 msgs) |
| 45.4s | 2026-08-01 01:02:49 (6 msgs) + 01:03:34 (4 msgs) |
| 59.6s | 2026-07-01 16:08:20 (6 msgs) + 16:09:20 (4 msgs) |
| 119.5s | 2026-01-21 21:44:52 (12 msgs) + 21:46:52 (4 msgs) |

The signature is a small stub conversation minted seconds from the real one.
The 2026-08-25 pair is the worst case: one recording session split across two
rows, each holding both microphone and system-audio messages
(297 = 161 mic + 136 system; 267 = 144 mic + 123 system).

Title collisions across all history: 12x "What should I say?", 3x "Casual
Greeting Exchange", 2x "Brief Sign-off Exchange", 2x "Brief Greeting Exchange".

### Mechanism, read from source

The gaps are 10 to 120 seconds, not sub-second, so this is **not** a same-tick
batching race. Three distinct defects produce it. Naming them matters, because
each is fixed by a different subset of the seven mint sites.

**(a) A stale memoized closure.** `submit` is memoized on
`[state.input, state.attachedFiles, selectedAIProvider, allAiProviders, systemPrompt]`
(`src/hooks/useCompletion.ts:1025-1032`). `state.currentConversationId` is *not*
a dependency. On the speech path — `submit(speechText)`, which never types into
`state.input` — the closure keeps a minutes-old `state` snapshot and reads
`currentConversationId: null` long after `setState` flushed. That is the
multi-second gap.

**(b) A missing write-back.** `saveCurrentConversation` at
`src/hooks/useCompletion.ts:1433-1434` computes
`state.currentConversationId || generateConversationId("chat")` and **never
assigns it to `currentConversationIdRef.current`**. Every other mint site does
(`:324`, `:572`, `:613`, `:699`, `:883`, `:1081`, `:1361`). So this site can
mint a second id against a conversation the ref already holds — the "small stub
minted seconds from the real one" signature exactly.

**(c) A remount.** `src/hooks/useMeetingLog.ts:323-326` documents it: a remount
re-initialises `state.currentConversationId` to null while the persisted id
survives, and mid-meeting remounts are reachable from `useOdooTarget.ts:73-80`.
A remount also produces a *fresh ref*, so a ref-based fix cannot see the old id.
This is the plausible cause of the 2026-08-25 mixed-source pair.

**Scope decision:** the fix below addresses (a) and (b). **(c) is explicitly out
of scope** — a fresh ref cannot recover a lost id without consulting the
persisted active id, which is a larger change to conversation lifetime that
deserves its own decision. It is recorded here so the remaining duplicate class
is known rather than assumed fixed.

**Out of scope:** repairing the five historical pairs. That is surgery on data
that cannot be regenerated, and the two shapes differ — deleting a 2-message
orphan is not the same operation as merging 297 and 267 messages into one
ordered conversation. It gets its own decision after the code fix lands.

## 1. The unified Meetings page

### Files

| Path | Disposition |
|---|---|
| `src/pages/meetings/index.tsx` | **new** — the unified page |
| `src/pages/meetings/components/` | **new** — `ConversationRow`, `QueueStrip`, `DateGroup` |
| `src/hooks/useMeetingLogQueue.ts` | **new** — the lift (see below) |
| `src/pages/chats/index.tsx` | deleted |
| `src/pages/chats/components/View.tsx` | moved to `src/pages/meetings/components/View.tsx`; barrel name `ViewChat` is **kept** so `routes/index.tsx` and the `useChatCompletion` wiring do not churn |
| `src/pages/meeting-log/index.tsx` | deleted after the lift |
| `src/pages/meeting-log/components/*` | moved to `src/pages/meetings/components/` — `QueueRow`, `AssignDialog`, `ProviderConfigReader`, and the `meetingDateOf` / `targetNameOf` / `TranscriptView` exports that `index.tsx:41-45` imports from `./components/QueueRow` |
| `src/pages/index.ts` | barrel: add `Meetings`, remove `Chats` and `MeetingLog`, repoint `ViewChat` |
| `src/hooks/index.ts` | barrel: add `useMeetingLogQueue` |

`src/hooks/useMeetingLog.ts` already exists and does something different —
write-side enqueue and hold. `useMeetingLogQueue.ts` gets a one-line header
distinguishing the two (page-side queue *reads* vs. write-side enqueue) so the
similar names do not invite a mis-import.

### Constraint: compose, do not rewrite

`src/pages/meeting-log/index.tsx` is 1013 lines, and most of its length is
defensive. It uses token-ordered reads so a focus refresh cannot repaint rows an
action has already moved (`loadToken`, mirroring the `selectionToken` pattern at
`useOdooTarget.ts:111,192-215`). It keeps write-only mirror refs so the focus
listener does not re-register a Tauri listener on every render. It carries its
own `FAILURE_COPY` map because `/odoo`'s `describe()` renders
`"ODOO_INTERNAL: ODOO_INTERNAL"` on a fresh dashboard webview.

Each of those is a fixed bug. The queue logic is therefore **lifted into
`useMeetingLogQueue()` with exactly one intentional addition** — the badge query
described below, placed inside the existing token guard. Everything else moves
unchanged, and `QueueRow` / `AssignDialog` / `ProviderConfigReader` are mounted
unchanged.

**Acceptance criterion for the lift:** `src/tests/meeting-log-page.test.tsx`
(2264 lines), repointed at the new page and otherwise unmodified, must pass. Its
mocks bind to the page's module graph — `vi.mock("@/lib/database/meeting-log.action")`
at `:19`, `"@/lib/odoo/meeting-log-actions"` at `:36`, the captured focus handler
at `:88-90` — so passing *is* the proof that the lift was verbatim. Mock paths
may be repointed; **assertions may not**. An assertion that needs an edit to
pass is the stop-and-re-scope signal.

**The hook is called unconditionally**, at the page top level, with the strip
rendered from its returned state. It must not be called from inside a
conditionally-rendered strip: the focus listener's `[]` effect and the write-only
mirror refs (`pages/meeting-log/index.tsx:456-470`) depend on mounting exactly
once, and a conditional mount re-registers the Tauri listener across its lossy
async `listen()` gap. `<ProviderConfigReader>` is mounted outside the
conditional for the same reason — `providerConfigRef` would otherwise be empty
exactly when an action needs it.

### Layout

```
/meetings
├─ Action strip          rendered only when non-empty
│    QueueRow x n         failed | escalated pending | unassigned
└─ Date-grouped list     always rendered
     Mon, Aug 31
       AI LCA Scoping and Ecoinvent Matching   161 msgs · 13:10 · Odoo sent
       Brief Sign-off Exchange                  64 msgs · 13:00
     Sun, Aug 30
       ...
```

The search box carries over from the Chats page and filters the date-grouped
list only. The strip is a worklist and is never filtered out from under the
user.

**Rendering cost.** The strip re-renders on a 30-second `STALE_TICK_MS` tick
(`pages/meeting-log/index.tsx:71`). Today that only re-renders memoised
`QueueRow`s; merged naively it would re-render the whole conversation list every
30 seconds, over conversations that `getAllConversations` returns with all
messages attached (`pages/chats/index.tsx:12-27`). So: `useMemo` the grouping on
`[conversations]`, and split the strip and the date-grouped list into separate
memoised children, so neither the tick nor a search keystroke crosses into the
other.

### Where each queue group lands

| Status | Placement | Reason |
|---|---|---|
| `failed`, `pending` at >= `ESCALATE_AFTER_ATTEMPTS`, `unassigned` | Action strip, full `QueueRow` | The only rows that will not reach Odoo without the user |
| `held`, `pending`, `sending` | Badge on the conversation row | In flight; no action available |
| `sent` | Badge on the conversation row | Done |
| `cancelled`, `deleted` | Nothing | Both are decisions the user already made |
| Queued for a different Odoo database | Action strip, collapsed one-liner | Instance-scoped, so it cannot badge onto a view filtered to the current instance; hiding it silently is how a backlog is lost |
| `conversation_id IS NULL` | Action strip, no link | Reachable via `useMeetingLog.ts:331`, where `conversationId ?? getActiveConversationId()` can be null; renders as a transcript-only row |

### The badge needs its own query

`listActionableRows` is scoped to
`status IN ('held','pending','sending','unassigned','failed')`, deliberately
excluding `sent`, `cancelled` and `deleted`, so it cannot drive a sent badge.
Add one statement, folded into a map once per load:

```sql
SELECT conversation_id, status, instance
  FROM meeting_log_queue
 WHERE conversation_id IS NOT NULL
```

**No `WHERE instance = ?`.** `QUEUE_SQL.listActionable` does not filter by
instance either — it uses `?1` only inside its `ORDER BY CASE`, returning every
instance's rows and leaving classification to `groupOf(row, instance)`, which
tests instance *first* (`lib/odoo/meeting-log.ts:340`). Filtering the badge
query by instance would hide a `sent` row that a previous Odoo configuration
pushed successfully, which is exactly the history the badge exists to show.

The relation is one-to-many, not one-to-one: `session_key` is
`conversationId:startAt`, so a conversation accumulates one row per meeting.
Resolution, in order:

1. Rows whose `instance` differs from the current one contribute `sent` only.
   Their actionable states belong to the strip's other-database group, never to
   a badge — `groupOf`'s own comment explains why an other-instance row must not
   be offered an action, since `pushQueuedRow` refuses it at the instance check.
2. Among the rest, worst-status-wins:
   `failed` > `unassigned` > `sending` > `pending` > `held` > `sent`.
3. `cancelled` and `deleted` contribute nothing and render no badge. Both are
   meetings the user deliberately removed — `deleteRow` and `deleteTerminalRow`
   set `status = 'deleted'` (`meeting-log.action.ts:304,327`), while
   `'cancelled'` is a distinct status set at `:88`, and `DERIVE_FORBIDDEN`
   (`:611`) already treats the two together. Surfacing either as state would
   resurrect a decision the user already made.
4. A count is shown when more than one row maps to the conversation.

**The badge reads the parent row's `status` column only.** `groupOf` consults
`row.failedTargets` *before* its status switch, because a row with a terminally
failed sibling target still derives `pending`. The badge deliberately does not:
a conversation-row badge is a summary, and the strip is where a partially-failed
multi-target row is actioned. If a `pending` badge on a row with failed targets
proves misleading in use, the fix is to surface it in the strip, not to widen
the badge query.

**The badge query runs inside `reload`'s existing `Promise.all`, under the same
`if (token !== loadToken.current) return;` guard** (`pages/meeting-log/index.tsx:394-453`).
Outside it, a focus refresh could resolve after an action's re-read and repaint
badges the action already moved — reintroducing the exact race `loadToken` was
added to fix.

The strip inherits the existing `LIMIT 201` / `PAGE_CAP = 200` behaviour and its
`REMAINDER_LINE` copy unchanged.

### Degradation when Odoo is not configured

When `configState !== "complete"` the strip is not rendered and no badges are
resolved; the date-grouped list renders normally. For a user who never set up
Odoo the page is a plain conversation history, and must be complete as one.

The existing `stranded` count behaviour is preserved: a half-filled config
still reports how many rows are queued, via `countActionableQueued()`.

**A queue failure must not blank the conversation list.** The lifted `reload`
has a single `catch` that sets `loadError` for the whole page
(`pages/meeting-log/index.tsx:445-452`). On the merged page that would let an
Odoo-side failure blank a conversation history that is not queue data at all.
The conversation-list read gets its own error path; a failed badge or queue read
drops badges and shows the strip's error, and the list still renders.

**`refreshConversations` needs the same discipline if it is wired to focus.**
`useHistory.ts:61-72` has no token ordering and no unmount guard — two
overlapping refreshes can resolve out of order, and it can `setConversations`
after unmount. Either leave the focus listener driving the queue read only, or
give `refreshConversations` the `loadToken` treatment first. Default: queue read
only.

### Routing

| From | To |
|---|---|
| `/meetings` | the new page |
| `/meetings/view/:conversationId` | existing `ViewChat`, moved intact |
| `/chats` | `<Navigate to="/meetings" replace />` |
| `/meeting-log` | `<Navigate to="/meetings" replace />` |
| `/chats/view/:conversationId` | a `useParams` wrapper — `Navigate`'s `to` is a static string and cannot re-interpolate the param |

`/dev-space` at `routes/index.tsx:46` is the house pattern the two static
redirects copy. The `useParams` wrapper builds its target as
`` `/meetings/view/${conversationId}${location.search}${location.hash}` `` — no
current caller passes either, so this is forward-proofing, but a redirect that
silently drops them is a trap.

Four hardcoded links move with it: `pages/chats/index.tsx:74`,
`pages/context-memory/components/SummaryDetail.tsx:259`,
`pages/odoo/index.tsx:559` (`<Link to="/meeting-log">`), and both
`hooks/useMenuItems.tsx` entries, which collapse into one labelled "Meetings".

Sweeps are unaffected. `sweepOrphanTargets`, `reclaimStaleSending` and
`pruneTranscripts` are called from `useMeetingLog` and the push module, never
from the page. Retiring the page strands nothing.

## 2. Renaming a conversation

### The problem

**Three SQL statements** write `conversations.title`, all unconditionally. The
count matters, because the guard is applied per statement, not per caller:

| Statement | Function | Reached by |
|---|---|---|
| `chat-history.action.ts:378` | `updateConversation` | `saveConversation` (`:624`) |
| `chat-history.action.ts:486` | `appendMessagesToConversation` | the meeting transcript autosave, `useCompletion.ts:306` onward |
| `chat-history.action.ts:572` | `updateConversationTitle` | the AI titler (`lib/functions/conversation-title.ts:232`) **and** `applySummaryTitleToConversation` (`:611`), which delegates to it |

The original draft of this spec named `:611` and `:687` as independent writers.
Both were wrong: `:611` delegates to `:572`, and `generateConversationTitle` at
`:687` is `return userMessage.trim()` — a pure string function that writes
nothing. It is a title *producer*; the creation-time writer is
`createConversation`'s `INSERT`.

The two statements the original draft missed are the dangerous ones.
`appendMessagesToConversation` writes the title cached in
`conversationMetaCacheRef` on **every autosave tick**. The comment at
`useCompletion.ts:255-257` states the mechanism outright: the cached copy "has
to be corrected — otherwise the next append writes the stale fallback title back
over it." A rename made during a live meeting is reverted seconds later, not
hours later by the summarizer.

The existing doc comment at `chat-history.action.ts:595-597` anticipated the
feature but not the full writer set:

> That is safe because every title in the system is machine-generated ... If a
> manual rename is ever added, this needs a provenance check so it can't
> overwrite one.

### Migration 15

A new file, `src-tauri/src/db/migrations/conversation-title-source.sql`. The
descriptive name follows migrations 11-14 (`odoo-contacts.sql`,
`meeting-log-queue.sql`, `odoo-lead-only-target.sql`, `odoo-multi-target.sql`),
which dropped the `-vN` suffix. A `chat-history-v15.sql` would be the third
chat-history migration carrying a number, and the suffix already means two
different things in this repo — `api-usage-v2.sql` is migration 4, while
`chat-history-v8.sql` is migration 8. The file header names the version, as
`odoo-multi-target.sql:1` does.

Released migration files are never edited — `meeting-log-queue.sql`'s own header
explains why: sqlx checksums applied migrations, and a changed checksum fails
`Database.load`, which is the single gate for chat history, prompts, cost
tracking and meeting context.

```sql
-- Conversation title provenance (migration 15)
ALTER TABLE conversations ADD COLUMN title_source TEXT NOT NULL DEFAULT 'auto';
```

`DEFAULT 'auto'` leaves all 71 existing rows behaving exactly as they do now.

**Register it.** Add to `migrations()` in `src-tauri/src/db/main.rs:98-103`:

```rust
Migration {
    version: 15,
    description: "conversation_title_source",
    sql: include_str!("migrations/conversation-title-source.sql"),
    kind: MigrationKind::Up,
},
```

`every_migration_file_is_registered` would catch the omission, but discovering a
plan step through a failing test is not a plan.

**Forward-only, and safe to strand.** `main.rs` registers only
`MigrationKind::Up`; there is no down migration. If migration 15 lands and the
UI does not, the column is additive with a default and old code degrades
gracefully — renames lose their protection, nothing errors. No rollback is
specified because none is needed. There is also no new-frontend/old-schema
window in a released build: `tauri-plugin-sql` runs `migrations()` at
`Database.load` before any query, and the Rust migration ships in the same
binary as the frontend that reads the column.

### The guard is a SQL clause, not a read-then-write

`updateConversationTitle` (`:572`) keeps its name, becomes the automatic path,
and takes the clause directly:

```sql
UPDATE conversations SET title = ? WHERE id = ? AND title_source = 'auto'
```

Its doc comment at `:552-553` — "Returns false when no row matched — e.g. the
conversation was deleted while the title was being generated" — becomes
incomplete and must be updated: `false` now also means "manually renamed."

`updateConversation` (`:378`) and `appendMessagesToConversation` (`:486`)
**cannot take the clause verbatim.** Both also bump `updated_at`, and both throw
`"Conversation not found"` on `rowsAffected === 0` — so a single guarded
statement would skip the timestamp bump and raise a spurious error on every
autosave after a rename. Each splits into two statements:

```sql
UPDATE conversations SET updated_at = ? WHERE id = ?;          -- unconditional, keeps the rowsAffected check
UPDATE conversations SET title = ? WHERE id = ? AND title_source = 'auto';
```

A new `renameConversationManually(id, title)` sets
`title = ?, title_source = 'manual'` and, like `updateConversationTitle`,
**leaves `updated_at` alone**. That is not incidental: the list sorts on
`updatedAt`, so bumping it would make the row jump date groups mid-edit and
unmount the input under a new heading, losing the caret.

There is no check-then-act window anywhere here, so a summarizer or an autosave
completing mid-rename cannot win a race that does not exist.

### Cross-window propagation

The original draft claimed both rename entry points "dispatch the existing
`conversation-title-updated` CustomEvent ... so the overlay resyncs without new
plumbing." **That is false, and it is the mechanism that would revert a rename.**

The rename UI lives on `/meetings` and `ViewChat`, both dashboard-webview
routes. `useCompletion` — whose `conversationMetaCacheRef` feeds
`appendMessagesToConversation` — runs in the **overlay** webview
(`routes/index.tsx:27`, `<Route path="/" element={<App />} />`; the hook is
consumed only under `src/pages/app/components/completion/`).
`window.dispatchEvent` does not cross Tauri webviews. The codebase says so
twice: `useHistory.ts:184` uses `localStorage` with the comment "Use
localStorage to communicate between windows", and `pages/meeting-log/index.tsx:50-56`
describes per-webview module state. The event works today only because
`applyAIConversationTitle` fires it *inside* the overlay.

So the rename must propagate cross-window the way the codebase already does it —
a `localStorage` key the overlay watches via the `storage` event, mirroring
`handleAttachToOverlay` (`useHistory.ts:183-193`). The overlay's handler
**invalidates** the cached title by id rather than patching it, so the next
append re-reads the row instead of trusting a value that may itself be stale.

The SQL guard is the backstop; the cross-window channel is what keeps the
*displayed* title correct. Neither alone is sufficient.

### UI

Rename is available in two places:

- inline on the list row — pencil on hover, input, Enter commits and Escape
  cancels
- on the `ViewChat` header, which currently renders `messages?.title` read-only
  at `View.tsx:89`

The list is where duplicate titles are noticed; the detail view is where the
user knows enough to fix one.

**Same-window resync is also incomplete.** `useHistory:97` patches
`conversations` and `viewingConversation`, but `ViewChat` renders from its own
`messages` state, loaded by `getConversationById` at `View.tsx:63` and never
patched. So a rename on the header would not update the header, and one made in
the list would not reach a mounted detail view. `View.tsx` subscribes to
`conversation-title-updated` itself and calls `setMessages`.

No focus-loss loop results from dispatching on commit: the row key is `doc.id`,
the list sorts on `updatedAt`, and neither `updateConversationTitle` nor
`renameConversationManually` touches `updated_at`.

### Existing tests that break

`src/tests/chat-history.update-title.test.ts:37-40` asserts the SQL as an exact
string:

```ts
expect(String(sql).replace(/\s+/g, " ").trim()).toBe(
  "UPDATE conversations SET title = ? WHERE id = ?"
);
```

Adding `AND title_source = 'auto'` breaks it outright. Update its expected SQL
and params, and audit these in the same pass for hardcoded SQL or retired URLs:

- `chat-history.title-adoption.test.ts`, `meeting-summarizer.title-sync.test.ts`,
  `conversation-title.test.ts` — SQL shape and params
- `summary-detail.conversation-link.test.tsx` — the `/chats/view/` link
- `meeting-log-entry-points.test.tsx`,
  `odoo-target-new-chat-entry-points.test.tsx` — the `/meeting-log` link

## 3. Speaker names in the downloaded transcript

### The problem

`hooks/useHistory.ts:222` labels each line from the message role:

```ts
const roleLabel = message.role.toUpperCase();
markdown += `## ${roleLabel}: ${message.content}\n`;
```

Every captured meeting message has role `user`, so microphone and system audio
both render `## USER:`. Migration 8 added `messages.speaker` and
`messages.audio_source`, and the read path maps both into the message objects at
`chat-history.action.ts:241,335`.

### One capture path stores no speaker at all

`addMeetingTranscript` (`useCompletion.ts:574-581`) and
`addSystemAudioTranscript` (`:701-708`) both carry `speaker` and `audioSource`
onto the message. **`addMeetingTranscriptEntries` (`:615-620`) does not** — it
builds `userMessages` with only `id`, `role`, `content` and `timestamp`, so
those rows persist with both columns null.

Under the design below that makes the label helper return `null`, and the role
fallback then labels **every diarized batch line `You:`, including guest lines**.
That is the misattribution `lib/odoo/meeting-log.ts:203-205` warns against, in
reverse. Fix it in scope — it is one line: carry `entry.speaker` and
`entry.audioSource` onto each message, matching its two sibling functions.

### Fix

`labelFor` already exists twice, copy-pasted, at `useCompletion.ts:1046` and
`lib/odoo/meeting-log.ts:207`. The second carries the comment "mirroring
labelFor (useCompletion.ts:1037-1043) EXACTLY, including its three-way null" —
a maintenance hazard stated as a promise, and one whose cited line range is
already stale (the real range is 1046-1052).

Extract one shared helper to **`src/lib/functions/speaker-label.function.ts`**,
exported as **`speakerLabelFor`**, and have all three callers use it.

Not `lib/odoo/meeting-log.ts` "beside the tested copy", as the original draft
said, for two reasons. The transcript download is a general chat concern with
nothing to do with Odoo, and CLAUDE.md organises `lib/` by concern
(`lib/functions/` is core logic). And that module's own comment at `:40-41`
warns that "`src/lib/index.ts` star-exports this module and `./database` into
one flat namespace" — which is why `isClaimStale` is named for the claim rather
than "stale". A bare `labelFor` in that flat namespace is precisely the
collision that comment guards against; `speakerLabelFor` survives it.

**The signature must widen.** The existing helper takes a `TranscriptEntry`
(`.original`, `.timestamp`, `.speaker`, `.audioSource`), but the download
iterates `ChatConversation["messages"]` — `ChatMessage` objects with `.content`.
The label logic touches only two fields, so:

```ts
export function speakerLabelFor(
  m: Pick<TranscriptEntry, "speaker" | "audioSource">
): string | null
```

**Extract the markdown generator.** `generateConversationMarkdown` is a closure
declared inside the `useHistory` hook body at `:209` and is not exported; the
only way to reach it is `handleDownloadConversation` (`:109`), which builds a
`Blob`, calls `URL.createObjectURL` and clicks a synthetic anchor. Extract it as
an exported `conversationToMarkdown(conversation)` so the label behaviour can be
asserted directly instead of through a `Blob` intercept.

The download needs one case the Odoo renderer does not: `speakerLabelFor`
returns `null` for assistant messages, which have no `audioSource`. The export
adds a role fallback — `Assistant:` for AI replies, `You:` for typed chat — so
no line is ever unlabelled.

Resulting file:

```
You: Right, so the scope of the LCA...
Guest: And that covers Scope 3?
Sarah Chen: Only the upstream part.
Assistant: Here's what you could say...
```

Labels stay `You` / `Guest` / tagged speaker name. The user decided against a
configurable display name, so there is no new settings field, no change to
`MEETING_ASSIST_SYSTEM_PROMPT`, and no change to the customer-visible Odoo note.

## 4. The duplicate-conversation fix

### Reproduction first

The repro test is a deliverable, not a nicety — it is the reason option B was
chosen over a blind fix. **The original draft's assertion was wrong** and must
not be built: "fire two completion paths within one tick, assert exactly one id
is minted" is satisfiable by two *ref-reading* paths (`:571` + `:612`), which
already dedupe today. Such a test passes green against unfixed code.

Three cases, all required:

1. **Stale closure.** Establish a conversation id, let `submit`'s memoized
   closure go stale (its deps at `:1025-1032` exclude
   `state.currentConversationId`), then fire the speech path. Assert it reuses
   the ref's id rather than minting.
2. **Missing write-back.** Establish the id on one path, flush awaits/timers,
   then fire `saveCurrentConversation` (`:1433`). Assert it reuses the id *and*
   that the ref was written.
3. **Negative — a reset still mints fresh.** After `clearMeetingTranscript`
   (`:742`), `startNewConversation` (`:1396`) or the delete path (`:1581`), fire
   a completion path and assert a **different** id is minted. Without this, a
   `??=` regression that pinned the app to one conversation would ship green.

`src/tests/useCompletion.meeting-assist.test.tsx` already does
`renderHook(() => useCompletion())` at `:139` and elsewhere, so mounting is a
solved problem — extend that suite's scaffolding. The original draft's fallback
("if `useCompletion` proves too entangled to mount") is dead weight and is
withdrawn.

### Fix

The mint sites in `useCompletion` collapse onto one **module-scope** helper:

```ts
export function ensureConversationId(
  ref: MutableRefObject<string | null>
): string {
  ref.current ??= generateConversationId("chat");
  return ref.current;
}
```

Module scope, not a function in the component body. Three call sites live in
`useCallback(…, [])` callbacks whose empty dep arrays are load-bearing and
commented as such ("No dependencies - uses ref for conversation ID",
`useCompletion.ts:593`). A body function would trip `react-hooks/exhaustive-deps`,
and "fixing" that by adding it to deps would change the identity of
`addMeetingTranscriptEntry` / `addMeetingTranscriptEntries` /
`addSystemAudioTranscript` every render, re-running every downstream effect that
lists them (`useSystemAudio.ts:573,868-873`). Module scope is stable by
construction, and it is the standalone unit the tests drive directly.

**Sites:** `useCompletion.ts:323, 571, 612, 698, 882, 1080, 1434`.

Only three change behaviour. `:323`, `:571`, `:612` and `:698` already read
`currentConversationIdRef.current || generateConversationId("chat")` and write it
back — semantically identical to `??=`, so those edits are refactors. The
load-bearing edits are `:882`, `:1080` (which read stale
`state.currentConversationId`) and `:1434` (which reads state and never writes
the ref).

**The `setState` mirror is preserved verbatim** at `:882` and `:1080`. The
helper replaces the mint *expression* only. Those sites also run
`if (!state.currentConversationId) setState(prev => ({...prev, currentConversationId}))`,
and `state.currentConversationId` is still consumed downstream — dropping the
mirror would leave it null for chat-only sessions, and
`useMeetingLog.ts:330-331` takes `conversationId ?? getActiveConversationId()`,
so every enqueue would fall to the recovery path and write the
`conversation_id IS NULL` rows the placement table in section 1 has to render.

**`useSystemAudio.ts:590` and `:876` are removed from this fix.** The original
draft said they "get the same treatment." They must not. `:590` is inside
`startCapture` and `:876` is the body of `startNewConversation`; both mint
unconditionally *on purpose*, each followed by
`selfCreatedConversationIdsRef.current.add(conversationId)` and a
`setConversation({ id, title: "", messages: [], … })` reset. Applying `??=`
there would make "start a new conversation" a no-op and chain every capture
session into the first — the same defect as the bug being fixed, inverted. That
hook has no `currentConversationIdRef` at all; it holds the id in its own
`conversation` state, so the helper does not even apply.

**Reset paths are already correct** and must stay that way: `:742`, `:1396` and
`:1581` each null the ref in the same synchronous step as
`clearActiveConversationId()` and the state clear. `??=` is therefore safe here —
it cannot pin the app to one conversation. Case 3 of the repro test guards this.

## Testing

| Area | Test | File |
|---|---|---|
| Duplicate — stale closure | Speech path with a stale `submit` closure reuses the ref's id | `useCompletion.meeting-assist.test.tsx` |
| Duplicate — write-back | `saveCurrentConversation` reuses the id and writes the ref | `useCompletion.meeting-assist.test.tsx` |
| Duplicate — negative | After each reset path, a completion mints a **different** id | `useCompletion.meeting-assist.test.tsx` |
| System audio — negative | Two consecutive `startCapture` / `startNewConversation` calls mint two distinct ids | `useSystemAudio.new-conversation.test.ts` (new) |
| Migration 15 pinning | `title_source_migration_is_version_15_and_points_at_its_own_file` — version and `include_str!` identity, matching the four siblings at `migration_tests.rs:48,66,88,105` | `src-tauri/src/db/migration_tests.rs` |
| Rename guard — titler | Rename, run the summary titler, manual title survives | `chat-history.rename-guard.test.ts` (new) |
| Rename guard — autosave | Rename, then one `appendMessagesToConversation` tick carrying the **old** cached title; manual title survives | `chat-history.rename-guard.test.ts` (new) |
| Rename guard — save | Same for `updateConversation` via `saveConversation` | `chat-history.rename-guard.test.ts` (new) |
| Rename guard — `updated_at` | Both split statements still bump `updated_at` and still raise on a missing row | `chat-history.rename-guard.test.ts` (new) |
| `renameConversationManually` | Exact SQL and params (both columns, no `updated_at`), false on zero rows, refusal on empty id/title, rejection propagated, event dispatched — mirroring `chat-history.update-title.test.ts:34-65` | `chat-history.rename-guard.test.ts` (new) |
| Existing SQL assertion | `chat-history.update-title.test.ts:37-40` updated for the guard clause | `chat-history.update-title.test.ts` |
| Cross-window rename | Overlay invalidates its cached title on the storage event; a subsequent append does not write the old title | `chat-history.rename-guard.test.ts` (new) |
| Transcript labels | Fixture with microphone, system, assistant, typed, **and a legacy pre-migration-8 row with null `speaker` and null `audio_source`**; assert distinct labels and no unlabelled line | `conversation-markdown.test.ts` (new) |
| Diarized batch labels | `addMeetingTranscriptEntries` rows carry `speaker`/`audioSource`, so guest lines do not export as `You:` | `conversation-markdown.test.ts` (new) |
| Badge — other instance | An other-instance `sent` row badges; an other-instance `failed` row does **not** | `meetings-page.badges.test.tsx` (new) |
| Badge — worst status | One conversation with several rows resolves worst-status-wins | `meetings-page.badges.test.tsx` (new) |
| Badge — suppressed | `cancelled` and `deleted` contribute nothing | `meetings-page.badges.test.tsx` (new) |
| Badge — count | More than one row maps to a conversation, count shown | `meetings-page.badges.test.tsx` (new) |
| Verbatim lift | `meeting-log-page.test.tsx` passes with mocks repointed and **no assertion edited** | `meeting-log-page.test.tsx` |
| Unconfigured Odoo | Page renders the conversation list with no strip and no badges | `meetings-page.test.tsx` (new) |
| Half-config | `stranded` count still reported via `countActionableQueued()` | `meetings-page.test.tsx` (new) |
| Queue failure isolation | A failing queue/badge read leaves the conversation list rendered | `meetings-page.test.tsx` (new) |
| Search scope | Search filters the date-grouped list and never the strip | `meetings-page.test.tsx` (new) |
| Null conversation row | `conversation_id IS NULL` renders in the strip as transcript-only, no link | `meetings-page.test.tsx` (new) |
| Route redirects | `/chats`, `/meeting-log`, `/chats/view/:id` land on their `/meetings` equivalents | `routes.redirects.test.tsx` (new) |
| Menu | Two `useMenuItems` entries collapse to one "Meetings" | `meetings-page.test.tsx` (new) |

## Risks

- **Reintroducing a fixed race.** Mitigated by the verbatim lift, with
  `meeting-log-page.test.tsx` as the mechanical check that it *was* verbatim.
  The badge query is the one sanctioned addition, and it goes inside the
  existing token guard.
- **Migration checksum drift on the development database.** A recurring issue in
  this project. Migration 15 will likely need the `_sqlx_migrations` checksum
  patched via `node:sqlite`, sweeping every version, not only the new one.
- **The remount duplicate class survives.** Item 4 fixes the stale-closure and
  missing-write-back defects, not the remount case (`useMeetingLog.ts:323-326`).
  Duplicates may still appear at a lower rate; that is expected, not a failed
  fix.
- **Cross-window rename is new plumbing.** The `storage`-event channel is
  modelled on `handleAttachToOverlay` but is not the same code path. It needs
  its own test rather than an assumption that the existing mechanism
  generalises.

## Decisions taken, for the record

| Question | Answer |
|---|---|
| Merged page shape | One list; queue state is metadata on a conversation |
| Grouping | Date-grouped history with an action strip pinned above it |
| Configurable display name | No — `You` is kept |
| Rename provenance | Migration adding `title_source` |
| Duplicate fix scope | Reproduce, then fix; historical rows held |
| Route | New `/meetings`, both old routes redirect |
| Remount duplicates | Out of scope, recorded (added 2026-09-01) |
| Badge vs. target-level failure | Badge reads the parent status only (added 2026-09-01) |
