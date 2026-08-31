# Unified Meetings page, conversation renaming, speaker-labelled transcripts

Date: 2026-08-31
Branch: `feat/unified-meetings-page`, cut from `feat/odoo-multi-target-assignment-design`

## Why this branch point

`main` does not have the multi-target work. It has no migration 14
(`odoo-multi-target.sql`), and its `QueueRow.tsx` has no `onRetryTarget`,
`onRemoveTarget` or `listTargets`. The action strip specified below composes
those, and a migration added off `main` would take number 14 and collide with
the multi-target branch's own 14.

`feat/odoo-multi-target-assignment-design` is merge-pending, not speculative:
its live checks ran 14/14 against a production Odoo 17 on 2026-08-30. This work
stacks on it and takes migration 15.

## Scope

Four items, from a brainstorming session on 2026-08-31.

1. Merge the Chats and Meeting log pages into one page.
2. Let the user rename a conversation, and stop the automatic titlers
   overwriting that rename.
3. Make the downloaded transcript name its speakers instead of labelling every
   line `## USER:`.
4. Investigate whether conversations are being saved twice. (Investigation
   complete — findings below. The code fix is in scope; repairing historical
   rows is not.)

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

**Candidate cause**, read from source and not yet reproduced: seven call sites
mint a conversation id inline. Four read `currentConversationIdRef.current`;
three read `state.currentConversationId` — stale React state — at
`useCompletion.ts:882`, `:1080` and `:1434`. Two paths firing before `setState`
flushes each mint their own id.

**Out of scope:** repairing the five historical pairs. That is surgery on data
that cannot be regenerated, and the two shapes differ — deleting a 2-message
orphan is not the same operation as merging 297 and 267 messages into one
ordered conversation. It gets its own decision after the code fix lands.

## 1. The unified Meetings page

### Constraint: compose, do not rewrite

`src/pages/meeting-log/index.tsx` is 1013 lines, and most of its length is
defensive. It uses token-ordered reads so a focus refresh cannot repaint rows an
action has already moved (`loadToken`, mirroring the `selectionToken` pattern at
`useOdooTarget.ts:111,192-215`). It keeps write-only mirror refs so the focus
listener does not re-register a Tauri listener on every render. It carries its
own `FAILURE_COPY` map because `/odoo`'s `describe()` renders
`"ODOO_INTERNAL: ODOO_INTERNAL"` on a fresh dashboard webview.

Each of those is a fixed bug. The queue logic is therefore **lifted verbatim**
into a `useMeetingLogQueue()` hook, and `QueueRow` / `AssignDialog` /
`ProviderConfigReader` are mounted unchanged. If the lift turns out to need
edits to work, that is a signal to stop and re-scope rather than to improvise.

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

### Where each queue group lands

| Status | Placement | Reason |
|---|---|---|
| `failed`, `pending` at >= `ESCALATE_AFTER_ATTEMPTS`, `unassigned` | Action strip, full `QueueRow` | The only rows that will not reach Odoo without the user |
| `held`, `pending`, `sending` | Badge on the conversation row | In flight; no action available |
| `sent` | Badge on the conversation row | Done |
| Queued for a different Odoo database | Action strip, collapsed one-liner | Instance-scoped, so it cannot badge onto a view filtered to the current instance; hiding it silently is how a backlog is lost |
| `conversation_id IS NULL` | Action strip, no link | Reachable via `useMeetingLog.ts:330`, where `conversationId ?? getActiveConversationId()` can be null; renders as a transcript-only row |

### The badge needs its own query

`listActionableRows` is scoped to
`status IN ('held','pending','sending','unassigned','failed')`, deliberately
excluding `sent` and `cancelled`, so it cannot drive a sent badge. Add one
statement, folded into a map once per load:

```sql
SELECT conversation_id, status, instance
  FROM meeting_log_queue
 WHERE conversation_id IS NOT NULL
```

**No `WHERE instance = ?`.** `QUEUE_SQL.listActionable` does not filter by
instance either — it uses `?1` only inside its `ORDER BY CASE`, returning every
instance's rows and leaving classification to `groupOf(row, instance)`, which
tests instance *first* (`meeting-log.ts:340`). Filtering the badge query by
instance would hide a `sent` row that a previous Odoo configuration pushed
successfully, which is exactly the history the badge exists to show.

The relation is one-to-many, not one-to-one: `session_key` is
`conversationId:startAt`, so a conversation accumulates one row per meeting.
Resolution, in order:

1. Rows whose `instance` differs from the current one contribute `sent` only.
   Their actionable states belong to the strip's other-database group, never to
   a badge — `groupOf`'s own comment explains why an other-instance row must not
   be offered an action, since `pushQueuedRow` refuses it at the instance check.
2. Among the rest, worst-status-wins:
   `failed` > `unassigned` > `sending` > `pending` > `held` > `sent`.
3. `cancelled` contributes nothing and renders no badge. A cancelled row is a
   meeting the user deliberately removed; surfacing it as state would
   resurrect a decision they already made.
4. A count is shown when more than one row maps to the conversation.

The strip inherits the existing `LIMIT 201` / `PAGE_CAP = 200` behaviour and its
`REMAINDER_LINE` copy unchanged.

### Degradation when Odoo is not configured

When `configState !== "complete"` the strip is not rendered and no badges are
resolved; the date-grouped list renders normally. For a user who never set up
Odoo the page is a plain conversation history, and must be complete as one.

The existing `stranded` count behaviour is preserved: a half-filled config
still reports how many rows are queued, via `countActionableQueued()`.

### Routing

| From | To |
|---|---|
| `/meetings` | the new page |
| `/meetings/view/:conversationId` | existing `ViewChat`, moved intact |
| `/chats` | `<Navigate to="/meetings" replace />` |
| `/meeting-log` | `<Navigate to="/meetings" replace />` |
| `/chats/view/:conversationId` | a `useParams` wrapper — `Navigate`'s `to` is a static string and cannot re-interpolate the param |

Four hardcoded links move with it: `pages/chats/index.tsx:74`,
`pages/context-memory/components/SummaryDetail.tsx:259`,
`pages/odoo/index.tsx:559` (`<Link to="/meeting-log">`), and both
`hooks/useMenuItems.tsx` entries, which collapse into one labelled "Meetings".

Sweeps are unaffected. `sweepOrphanTargets`, `reclaimStaleSending` and
`pruneTranscripts` are called from `useMeetingLog` and the push module, never
from the page — `pages/meeting-log/index.tsx:50` states this. Retiring the page
strands nothing.

## 2. Renaming a conversation

### The problem

Three writers set `conversations.title`, all unconditionally:

| Writer | Location |
|---|---|
| `generateConversationTitle()` at creation | `chat-history.action.ts:687` |
| the AI titler | `conversation-title.ts:232` |
| `applySummaryTitleToConversation()` | `chat-history.action.ts:611` |

The third runs after summarization, which can be hours after a meeting. Without
a guard, a rename made in the afternoon is silently reverted that night. The
existing doc comment at `chat-history.action.ts:602` anticipates this:

> That is safe because every title in the system is machine-generated ... If a
> manual rename is ever added, this needs a provenance check so it can't
> overwrite one.

### Migration 15

A new file, `src-tauri/src/db/migrations/chat-history-v15.sql`. Released
migration files are never edited — `meeting-log-queue.sql`'s own header explains
why: sqlx checksums applied migrations, and a changed checksum fails
`Database.load`, which is the single gate for chat history, prompts, cost
tracking and meeting context.

```sql
ALTER TABLE conversations ADD COLUMN title_source TEXT NOT NULL DEFAULT 'auto';
```

`DEFAULT 'auto'` leaves all 71 existing rows behaving exactly as they do now.

### The guard is a SQL clause, not a read-then-write

Both automatic titlers become:

```sql
UPDATE conversations SET title = ? WHERE id = ? AND title_source = 'auto'
```

A new `renameConversationManually(id, title)` sets
`title = ?, title_source = 'manual'`. There is no check-then-act window, so a
summarizer completing mid-rename cannot win a race that does not exist.
`updateConversationTitle` keeps its name and becomes the automatic path.

### UI

Rename is available in two places:

- inline on the list row — pencil on hover, input, Enter commits and Escape
  cancels
- on the `ViewChat` header, which currently renders `messages?.title` read-only
  at `pages/chats/components/View.tsx:89`

The list is where duplicate titles are noticed; the detail view is where the
user knows enough to fix one. Both dispatch the existing
`conversation-title-updated` CustomEvent, which `useHistory:97` and
`useCompletion:267` already listen for, so the overlay resyncs without new
plumbing.

## 3. Speaker names in the downloaded transcript

### The problem

`hooks/useHistory.ts:222` labels each line from the message role:

```ts
const roleLabel = message.role.toUpperCase();
markdown += `## ${roleLabel}: ${message.content}\n`;
```

Every captured meeting message has role `user`, so microphone and system audio
both render `## USER:`. The data needed is already stored and already read:
migration 8 added `messages.speaker` and `messages.audio_source`, and the read
path maps both into the message objects at `chat-history.action.ts:241,335`.

### Fix

`labelFor` already exists twice, copy-pasted, at `useCompletion.ts:1045` and
`lib/odoo/meeting-log.ts:200`. The second carries the comment "mirroring
labelFor (useCompletion.ts:1037-1043) EXACTLY, including its three-way null",
which is a maintenance hazard stated as a promise. Extract one shared helper
into `lib/odoo/meeting-log.ts`, beside the tested copy, and have all three
callers use it.

The download needs one case the Odoo renderer does not: `labelFor` returns
`null` for assistant messages, which have no `audioSource`. The export adds a
role fallback — `Assistant:` for AI replies, `You:` for typed chat — so no line
is ever unlabelled.

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
chosen over a blind fix. `renderHook` on `useCompletion`, fire two completion
paths within one tick, assert exactly one conversation id is minted.

If `useCompletion` proves too entangled to mount under vitest, extract
`ensureConversationId` as a standalone testable unit and drive it directly. The
test ships either way.

### Fix

Seven inline mint sites collapse into one helper:

```ts
function ensureConversationId(): string {
  currentConversationIdRef.current ??= generateConversationId("chat");
  return currentConversationIdRef.current;
}
```

The ref is read and written in the same synchronous step, before any await.
Sites: `useCompletion.ts:323,571,612,698,882,1080,1434`. `useSystemAudio.ts:590`
and `:876` get the same treatment with the `"sysaudio"` source.

## Testing

| Area | Test |
|---|---|
| Duplicate mint | Two paths in one tick mint one id — the option-B deliverable |
| Migration 15 | Extend `src-tauri/src/db/migration_tests.rs`; assert pre-existing rows default to `'auto'` |
| Rename guard | Rename, then run the summary titler; assert the manual title survives |
| Transcript labels | Fixture with microphone, system, assistant and typed rows; assert four distinct labels and no unlabelled line |
| Badge resolution | One conversation with several queue rows resolves worst-status-wins |
| Unconfigured Odoo | Page renders the conversation list with no strip and no badges |
| Route redirects | `/chats`, `/meeting-log` and `/chats/view/:id` all land on their `/meetings` equivalents |

## Risks

- **Reintroducing a fixed race.** Mitigated by lifting the queue logic verbatim.
  If the lift needs edits to compile or run, stop and re-scope.
- **Migration checksum drift on the development database.** A recurring issue in
  this project. Migration 15 will likely need the `_sqlx_migrations` checksum
  patched via `node:sqlite`, sweeping every version, not only the new one.
- **`useCompletion` may resist mounting under vitest.** Fallback stated above.
- **Stacking on an unmerged branch.** If
  `feat/odoo-multi-target-assignment-design` changes materially before merging,
  the action strip follows it.

## Decisions taken, for the record

| Question | Answer |
|---|---|
| Merged page shape | One list; queue state is metadata on a conversation |
| Grouping | Date-grouped history with an action strip pinned above it |
| Configurable display name | No — `You` is kept |
| Rename provenance | Migration adding `title_source` |
| Duplicate fix scope | Reproduce, then fix; historical rows held |
| Route | New `/meetings`, both old routes redirect |
