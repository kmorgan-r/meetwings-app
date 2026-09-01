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
each is fixed by a different subset of the mint sites.

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
(`:324`, `:572`, `:613`, `:699`, `:883`, `:1081`). So this site can mint a
second id against a conversation the ref already holds — the "small stub minted
seconds from the real one" signature exactly. It *does* mirror the bad id into
state at `:1495`, which is how the stub becomes the app's current conversation.

`:1361` is a ref write-back but **not** a mint: it is `loadConversation`
adopting an existing conversation (`currentConversationIdRef.current =
conversation.id`). It is therefore absent from the Sites list below, by design.

**State writers are a different set from mint sites**, and the substitution
below makes the ref authoritative at three sites that previously read state — so
the audit has to cover both. `setState` writes `currentConversationId` at
`:588`, `:630`, `:717`, `:748`, `:888`, `:1085`, `:1223`, `:1372`, `:1402`,
`:1495`. Of those, `:1223` is benign (its id descends from the `:1080` mint,
which writes the ref at `:1081`) and `:1495` is defect (b)'s mirror. Before the
substitution lands, **every** `setState(… currentConversationId …)` must be
confirmed to write the ref in the same synchronous step, as the reset paths
already do. Any adopt-an-existing-conversation path that sets state alone is
repaired today by `:882`'s unconditional overwrite and would break under `??=`;
it must be fixed at its own site first, and that audit is a precondition of this
change rather than part of it.

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
| `src/lib/functions/speaker-label.function.ts` | **new** (item 3) — `speakerLabelFor`, the one shared label helper |
| `src/lib/functions/conversation-markdown.function.ts` | **new** (item 3) — `conversationToMarkdown`, extracted from the `useHistory` closure |
| `src/lib/functions/conversation-id.function.ts` | **new** (item 4) — `ensureConversationId`, module scope so the `[]` deps hold |

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

**Acceptance criterion for the lift.** `src/tests/meeting-log-page.test.tsx`
(2264 lines) is the check that the lift preserved behaviour. It cannot be frozen
wholesale, because this design deliberately changes what the page *renders* —
`held`/`pending`/`sending` leave the queue groups for badges, and the
other-database group collapses to a one-liner, so two of the four `GROUPS`
(`pages/meeting-log/index.tsx:75-82`) no longer exist. A blanket "no assertion
may change" would fire the stop signal on the first assertion this spec exists
to change.

So the freeze is scoped to **behaviour, not placement**:

- **Frozen — any edit here is the stop-and-re-scope signal.** Token ordering
  under `loadToken`, focus-listener registration (exactly once, via the captured
  handler at `:88-90`), every action outcome, `FAILURE_COPY` strings, and the
  `LIMIT 201` / `PAGE_CAP = 200` / `REMAINDER_LINE` paging behaviour.
- **Expected to change, enumerated up front.** Assertions that a `held`,
  `pending` or `sending` row appears in a queue group; assertions about the
  other-database group's full-row rendering. These are listed in the plan before
  work starts, and any placement assertion *not* on that list is treated as a
  frozen one.
- **Mocks may be added, not rewritten.** Existing mocks bind to the Odoo module
  graph (`vi.mock("@/lib/database/meeting-log.action")` at `:19`,
  `"@/lib/odoo/meeting-log-actions"` at `:36`) and the suite deliberately does
  not mock `@/lib` (`:72-77`). The merged page also mounts `useHistory`, whose
  `getAllConversations` would otherwise run against a real `getDatabase()`, and
  the new badge-query export would be `undefined` inside the wholesale
  `meeting-log.action` mock — throwing inside `reload` and failing every test.
  Adding a leaf mock for `@/lib/database/chat-history.action` and adding the
  badge function to the hoisted factory with a `beforeEach`
  `mockResolvedValue([])` default are **required amendments, not stop signals**.
  Rewriting an existing mock's behaviour is a stop signal.

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

Memoising the grouping is necessary but not sufficient, and three things defeat
it if left alone:

- `React.memo` only stops a re-render when **every** prop is referentially
  stable. `useMeetingLogQueue()` must return `useCallback`-stable handlers and
  state, or a fresh object per render defeats the boundary entirely.
- Group, sort and search-filter all belong **inside one memo owned by the list
  child** — `sortedDates` (`pages/chats/index.tsx:25-27`) and the filter
  (`:54-63`) rebuild per render today.
- The badge map is rebuilt on every `reload` — every focus refresh and every
  action's re-read — so passing the `Map` itself as a prop re-renders the whole
  list. Each row receives **only its own badge value**, so an unchanged row
  keeps its props.

Note also that `conversations` gets a new identity on every
`conversation-title-updated` (`useHistory.ts:87-91`), not only on refresh, so
the 30-second tick is not the only invalidator. And memoisation does not touch
the cost this section cites — `getAllConversations` attaching every message —
since a row renders only `doc.messages.length`. A `COUNT(*)`-shaped list read is
the real remedy there; it is **out of scope** for this change and recorded as a
known cost.

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
(`pages/meeting-log/index.tsx:445-452`). On the merged page that must not blank
a conversation history that is not queue data at all.

**The isolation is structural, not new error handling.** The badge query stays
inside `reload`'s `Promise.all` under the shared catch, so a badge failure sets
`loadError` — but `loadError` renders *above the strip only*, and the list is
`useHistory`-owned state that `reload` never touches. `useHistory` is therefore
**not modified**, consistent with "Default: queue read only" below;
`refreshConversations` keeps its existing swallow-and-empty behaviour
(`useHistory.ts:61-72`). Nothing in this change gives the list a new error path
— it simply stops sharing the queue's.

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
    description: "add_title_source_to_conversations",
    sql: include_str!("migrations/conversation-title-source.sql"),
    kind: MigrationKind::Up,
},
```

The description is verb-first because every one of the fourteen registered
descriptions is (`create_*`, `add_*`, `remove_*`, `adopt_*`, `allow_*`), and
migration 8's `add_speaker_to_messages` is the exact structural sibling — the
same `ALTER TABLE … ADD COLUMN` shape. It is also the lookup key in the sibling
pinning tests (`migration_tests.rs:51,69,91,109` all `.find(|m| m.description == …)`),
so this string and the test must agree.

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

So a commit fires **both** channels, and dropping either one breaks a window:

1. **In-window:** dispatch `conversation-title-updated`, as
   `applyAIConversationTitle` already does (`conversation-title.ts:240-244`).
   The dashboard's own `useHistory:97` listener and the `View.tsx` listener
   below depend on it — `storage` does **not** fire in the window that wrote the
   value, so the event is the only thing that updates the window the user is
   actually looking at.
2. **Cross-window:** write a `localStorage` key the overlay watches via the
   `storage` event, mirroring `handleAttachToOverlay` (`useHistory.ts:183-193`).
   The payload carries `{ id, title, timestamp }`. The `timestamp` is
   load-bearing, not decoration: `storage` does not fire when the written string
   is byte-identical to the stored one, so without a nonce, renaming the same
   conversation to the same title twice is silently dropped — which is exactly
   why `handleAttachToOverlay` carries one at `:187`.

The overlay's handler **patches** `conversationMetaCacheRef` with the title from
the payload, exactly as the shipped in-window handler does at
`useCompletion.ts:261-264`. It does **not** invalidate the entry. An earlier
draft of this section said "invalidate", which is wrong: a cache miss sends the
autosave into the re-read branch at `useCompletion.ts:326-340`, and
`getConversationById` "returns null on a failed read, which makes a transient
error indistinguishable from 'no such row'" (`chat-history.action.ts:345-351`).
A transient failure would then invent a `Meeting transcript - <date>` title with
`hasStoredTitle = false` — the one state that hands the conversation to the AI
titler. Patching cannot do that. Invalidation is used only when the cached id
does not match the payload's.

Both the writer and the listener import one exported key constant, so a test
cannot pass against a hardcoded key the writer never writes.

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
`conversation-title-updated` itself.

Its listener must be a `[]`-deped effect with a **functional, id-checked**
updater, modelled on `useHistory.ts:82-103`:

```ts
setMessages((prev) => (prev && prev.id === id ? { ...prev, title } : prev));
```

Not a `[messages]`-deped listener closing over state. `setMessages` is shared
with `useChatCompletion(conversationId, messages, setMessages)` (`View.tsx:55-59`),
which appends during a live completion: a `[messages]` dep would re-register the
listener on every streamed chunk — the re-registration hazard this spec guards
against at `pages/meeting-log/index.tsx:456-470` — while a `[]`-deped listener
writing `{ ...messages, title }` from a stale closure would clobber everything
appended since mount.

The load effect at `View.tsx:61-67` also needs an ignore flag: it has no
cancellation and no id check, so an in-flight `getConversationById` can resolve
*after* a title patch and overwrite it. That is the same discipline this spec
demands of `refreshConversations`.

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
and params, and audit these in the same pass:

- `chat-history.title-adoption.test.ts`, `meeting-summarizer.title-sync.test.ts`,
  `conversation-title.test.ts` — SQL shape and params
- `chat-history.append-silent.test.ts`, `chat-history.speaker.test.ts`,
  `chat-history.create-rollback.test.ts` — **call-count and index breakage, not
  SQL-string breakage.** These drive `appendMessagesToConversation` and
  `updateConversation`, and splitting one header `UPDATE` into two shifts every
  positional `mockExecute.mock.calls[N]` index in the house style shown at
  `chat-history.update-title.test.ts:32-40`. This is the audit item most likely
  to be missed, because the failure looks unrelated to titles.
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
an exported `conversationToMarkdown(conversation)` in
**`src/lib/functions/conversation-markdown.function.ts`**, so the label
behaviour can be asserted directly instead of through a `Blob` intercept.

The download needs one case the Odoo renderer does not: `speakerLabelFor`
returns `null` for assistant messages, which have no `audioSource`. The export
adds a role fallback — `Assistant:` for AI replies, `You:` for typed chat — so
no line is ever unlabelled.

**Accepted limitation: legacy rows.** A message written before migration 8 has
`speaker` and `audio_source` both null, so it is indistinguishable from typed
chat and the role fallback labels it `You:` — even when a guest spoke. That is
the same misattribution class this section cites `lib/odoo/meeting-log.ts:203-205`
against, and it is accepted rather than solved: the columns are empty, so the
data to do better does not exist. Once `addMeetingTranscriptEntries` is fixed,
no *new* rows join this class. The test fixture includes such a row and asserts
`You:` deliberately, as the documented behaviour rather than an oversight.

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

Four cases, all required:

1. **Stale closure.** Establish a conversation id via a ref-writing path that
   does not touch `submit`'s deps — `addMeetingTranscript` (`:571`) — then fire
   `submit(speechText)` and assert it reuses the ref's id.

   **The test must prove the closure is actually stale, or it proves nothing.**
   The defect only reproduces if `submit`'s `useCallback` identity survives the
   render that set the id, which requires all five deps (`:1025-1032`) —
   including `selectedAIProvider`, `allAiProviders` and `systemPrompt` from the
   mocked `@/contexts` — to be referentially stable across that render. If the
   suite's context mock returns a fresh object per render, `submit` is rebuilt,
   the closure is fresh, and this row silently degrades into the same-tick test
   this spec just rejected: green against unfixed code, with nothing in the
   assertions revealing it. So capture `const before = result.current.submit`
   before establishing the id and assert `expect(result.current.submit).toBe(before)`
   before firing. That assertion is the test.
2. **Stale closure, meeting-context path.** The same setup driving
   `submitWithMeetingContext` (`:1080`). It is named as load-bearing and is the
   cheapest of the three to drive in a suite already built for meeting assist.
3. **Missing write-back.** Establish the id on one path, flush awaits/timers,
   then fire `saveCurrentConversation` (`:1433`). Assert it reuses the id.
   `currentConversationIdRef` is private, so "the ref was written" is not
   directly observable — observe it through a following ref-reading call
   (`:571`) reusing the same id.
4. **Negative — a reset still mints fresh.** After `clearMeetingTranscript`
   (`:742`), `startNewConversation` (`:1396`) or the delete path (`:1581`), fire
   a completion path and assert a **different** id is minted. Without this, a
   `??=` regression that pinned the app to one conversation would ship green.
   The delete path is driven by the `conversationDeleted` listener, whose
   `detail` is a **bare id string**, not `{ id }` (`useHistory.ts:167-171`).

The plan records, before work starts, which of these entry points are on
`useCompletion`'s returned surface (`src/types/completion.hook.ts`) and names a
driver for each that is not. `src/tests/useCompletion.meeting-assist.test.tsx`
already does `renderHook(() => useCompletion())` at `:139` and drives
`addSystemAudioTranscript` directly at `:420` and `:475`, so mounting and
transcript-driving are solved — extend that suite's scaffolding. The original
draft's fallback ("if `useCompletion` proves too entangled to mount") is dead
weight and is withdrawn.

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

It lives in **`src/lib/functions/conversation-id.function.ts`**, matching the
`*.function.ts` convention used for `speakerLabelFor` in item 3, so both
`useCompletion.ts` and the tests import it by the same path.

Module scope, not a function in the component body. Three call sites live in
`useCallback(…, [])` callbacks whose empty dep arrays are load-bearing and
commented as such ("No dependencies - uses ref for conversation ID",
`useCompletion.ts:593`). A body function would trip `react-hooks/exhaustive-deps`,
and "fixing" that by adding it to deps would change the identity of
`addMeetingTranscriptEntry` / `addMeetingTranscriptEntries` /
`addSystemAudioTranscript` every render, re-running every downstream consumer
that lists them in a dep array — `pages/app/components/completion/Audio.tsx:117`
lists `addSystemAudioTranscript` exactly so. (An earlier draft cited
`useSystemAudio.ts:573,868-873` here; those dep arrays list
`conversation.*` fields, not these callbacks, and that hook is not a consumer.)
Module scope is stable by construction, and it is the standalone unit the tests
drive directly.

**Sites:** `useCompletion.ts:323, 571, 612, 698, 882, 1080` — six. `:1434` is
handled differently; see below.

Only two of the six change behaviour. `:323`, `:571`, `:612` and `:698` already
read `currentConversationIdRef.current || generateConversationId("chat")` and
write it back — semantically identical to `??=`, so those edits are refactors.
The load-bearing edits are `:882` and `:1080`, which read stale
`state.currentConversationId`.

At those two, today's code assigns the ref **unconditionally** after reading
state. That overwrite is not load-bearing — it *is* defect (a): a stale snapshot
holding `null` destroys a live ref id and replaces it with a fresh mint. `??=`
is the correct direction. It is safe only because of the state-writer audit
recorded above; that audit is a precondition, not a formality.

**The `setState` mirror is kept, but not verbatim.** The helper replaces the
mint *expression*, and the mirror must still run — `state.currentConversationId`
is consumed downstream, and `useMeetingLog.ts:330-331` takes
`conversationId ?? getActiveConversationId()`, so losing it sends every enqueue
to the recovery path and writes the `conversation_id IS NULL` rows the placement
table in section 1 has to render.

But the shipped mirror guards on the snapshot —
`if (!state.currentConversationId) setState(…)` — and after the substitution the
value comes from the ref while the guard still reads stale state. The two no
longer share a source, and the mismatch is reachable: `clearMeetingTranscript`
does not clear `state.input`, so `submit`'s memo does not re-form; the snapshot
still holds the pre-reset id, the guard is falsy, the mirror never fires, and
real `state.currentConversationId` stays null — the exact outcome the paragraph
above exists to prevent. So the mirror becomes a functional update keyed on the
live value:

```ts
setState((prev) =>
  prev.currentConversationId === conversationId
    ? prev
    : { ...prev, currentConversationId: conversationId }
);
```

**`:1434` takes the turn's id as an argument instead of recomputing it.**
`saveCurrentConversation(userMessage, assistantResponse, attachedFiles)` runs at
end-of-turn from `:1002` and `:1748`, and its closure is captured at turn start.
If a reset lands mid-turn, `state.currentConversationId` is null and the
finishing turn mints a fresh id — and simply making it write the ref would
*pin the ref to that id*, seeding the user's brand-new conversation with the
previous turn's content. Passing the id already computed at `:882` down into
`saveCurrentConversation` makes the turn's identity correct by construction, so
no ref write is needed there at all and no mid-turn reset can be captured.

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

Every row below is a statement-shape or hook-observable assertion. The project's
only DB harness is a mocked `execute` (`chat-history.update-title.test.ts:6-8,22`),
so no row may be phrased as a real-table outcome — "the manual title survives"
is not observable through a `vi.fn()`, and a row written that way either invites
a fake SQL engine or asserts nothing.

| Area | Test | File |
|---|---|---|
| Duplicate — stale closure | `submit` identity is unchanged (`expect(result.current.submit).toBe(before)`), **then** the speech path reuses the ref's id. The identity assertion is mandatory — without it the row silently degrades to a same-tick test | `useCompletion.meeting-assist.test.tsx` |
| Duplicate — meeting context | Same setup driving `submitWithMeetingContext` (`:1080`) | `useCompletion.meeting-assist.test.tsx` |
| Duplicate — turn id | `saveCurrentConversation` uses the id passed from the turn; a following `:571` call reuses it | `useCompletion.meeting-assist.test.tsx` |
| Duplicate — negative | After each reset path, a completion mints a **different** id (delete driven by a `conversationDeleted` event whose `detail` is a bare id string) | `useCompletion.meeting-assist.test.tsx` |
| Mirror survives | After a chat-only completion, the hook's exposed `currentConversationId` is populated and equals the ref-driven id — the regression that would otherwise write `conversation_id IS NULL` rows | `useCompletion.meeting-assist.test.tsx` |
| System audio — negative | Two consecutive `startNewConversation` calls (`:875`, pure state — not `startCapture`, which needs Tauri and media mocks for a hook this fix does not touch) mint two distinct ids | `useSystemAudio.new-conversation.test.tsx` (new) |
| Migration 15 pinning | `title_source_migration_is_version_15_and_points_at_its_own_file` — `.find(|m| m.description == "add_title_source_to_conversations")`, version 15, `include_str!` identity; matching the siblings at `migration_tests.rs:48,66,88,105` | `src-tauri/src/db/migration_tests.rs` |
| Guarded titler SQL | `updateConversationTitle` emits `… WHERE id = ? AND title_source = 'auto'` and still never names `updated_at` | `chat-history.update-title.test.ts` |
| Titler zero-match | `applySummaryTitleToConversation` returns `false` without throwing when the guarded update matches zero rows | `chat-history.rename-guard.test.ts` (new) |
| Split — autosave | `appendMessagesToConversation` emits **two** statements: unconditional `updated_at`, then guarded `title` | `chat-history.rename-guard.test.ts` (new) |
| Split — save | Same two-statement shape for `updateConversation` | `chat-history.rename-guard.test.ts` (new) |
| Split — semantics | Both split **functions** still raise on `rowsAffected: 0` (from the first statement), and the guarded title statement never names `updated_at` | `chat-history.rename-guard.test.ts` (new) |
| `renameConversationManually` | Exact SQL and params (both columns, no `updated_at`), false on zero rows, refusal on empty id/title, rejection propagated — mirroring `chat-history.update-title.test.ts:34-65` | `chat-history.rename-guard.test.ts` (new) |
| Rename commit fires both | The commit handler dispatches `conversation-title-updated` **and** writes the shared localStorage key constant with an `{ id, title, timestamp }` payload | `useCompletion.meeting-assist.test.tsx` |
| Cross-window listener | A synthesized `StorageEvent` on the shared key **patches** `conversationMetaCacheRef` with the payload title; a mismatched id invalidates instead | `useCompletion.meeting-assist.test.tsx` |
| Transcript labels | Fixture with microphone, system, assistant, typed, **and a legacy pre-migration-8 row with null `speaker`/`audio_source` asserting the documented `You:`** | `conversation-markdown.test.ts` (new) |
| Diarized batch carries speaker | `addMeetingTranscriptEntries` writes `speaker`/`audioSource` onto each message — a `useCompletion` behaviour, not a markdown one | `useCompletion.meeting-assist.test.tsx` |
| Badge — other instance | An other-instance `sent` row badges; an other-instance `failed` row does **not** | `meetings-page.badges.test.tsx` (new) |
| Badge — worst status | One conversation with several rows resolves worst-status-wins | `meetings-page.badges.test.tsx` (new) |
| Badge — suppressed | `cancelled` and `deleted` contribute nothing | `meetings-page.badges.test.tsx` (new) |
| Badge — count | More than one row maps to a conversation, count shown | `meetings-page.badges.test.tsx` (new) |
| Behaviour lift | `meeting-log-page.test.tsx` passes with mocks repointed, leaf mocks **added**, and every frozen-behaviour assertion unedited; only the enumerated placement assertions change | `meeting-log-page.test.tsx` |
| Unconfigured Odoo | Page renders the conversation list with no strip and no badges | `meetings-page.test.tsx` (new) |
| Half-config | `stranded` count still reported via `countActionableQueued()` | `meetings-page.test.tsx` (new) |
| Queue failure isolation | A failing queue/badge read sets `loadError` above the strip and leaves the conversation list rendered | `meetings-page.test.tsx` (new) |
| Search scope | Search filters the date-grouped list and never the strip | `meetings-page.test.tsx` (new) |
| Null conversation row | `conversation_id IS NULL` renders in the strip as transcript-only, no link | `meetings-page.test.tsx` (new) |
| Redirect wrapper | The `useParams` wrapper under `MemoryRouter` forwards `${location.search}${location.hash}` — the only redirect with real logic. The two static redirects are asserted declaratively, **not** by mounting `AppRoutes`, which hardcodes `BrowserRouter` and eagerly imports every page | `routes.redirects.test.tsx` (new) |
| Menu | Two `useMenuItems` entries collapse to one "Meetings" — belongs where entry points are already tested, not in the page suite | `meeting-log-entry-points.test.tsx` |

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
- **This is large for one review unit.** See "Delivery shape" below.

## Delivery shape — open decision

The review flagged that this has grown past a comfortable single change: a
schema migration, a page deletion, a 1013-line lift, a 2264-line suite
repointed, a cross-window channel, two module extractions, and 28 test rows. It
is *executable* as one branch, but a single review-and-rollback unit spanning a
migration and a page merge is where the first review round's regressions came
from.

The recommended split, in the order this spec already states:

1. **Page merge + routing** — items 1, plus the link and barrel moves.
2. **Migration 15 + guard + rename UI + cross-window channel** — item 2. Its own
   change so the migration can be reverted independently of the page merge.
3. **Transcript labels** — item 3, including the
   `addMeetingTranscriptEntries` fix.
4. **Duplicate fix** — item 4, including the state-writer audit.

3 and 4 are independent of 1 and 2 and of each other, so they can land in any
order. 2 depends on 1 only for where the rename UI mounts.

**Decision: one branch, four commits** — one per numbered item, in the order
above. The user asked for these four changes together, and `/ship` opens one PR
per pipeline; splitting into four PRs would mean four pipelines and three more
merge gates for work that was requested as a unit. Commit boundaries give the
independent-revert property that matters most here — migration 15 lands in its
own commit, so it can be reverted without touching the page merge.

If review of the finished branch proves it too large to review as one PR, the
commit boundaries are already the split points.

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
