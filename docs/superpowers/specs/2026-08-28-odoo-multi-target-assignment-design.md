# Odoo multi-target assignment — design

**Status:** approved, not implemented
**Date:** 2026-08-28
**Revised:** 2026-08-28, applying 38 findings from a five-reviewer spec review
**Supersedes:** the single-target selection introduced in the contact picker
design (2026-08-04) and carried through the meeting log queue (2026-08-08)

## The problem

One meeting can reach exactly one Odoo record. Picking a second contact
silently replaces the first — no warning, no merge; it simply becomes the
target.

The restriction is not a UI rule. It is the same shape at every layer:

- `odoo_selected_target` holds exactly one row, `id = 'current'`, written
  `VALUES ('current', …) ON CONFLICT(id) DO UPDATE`.
- `ResolvedTarget` is one `{ contactId, leadId, leadName }` triple.
- `meeting_log_queue` has one `contact_id`, one `lead_id`, one
  `attachment_id`, one `message_id` per row.
- `pushQueuedRow` resolves them to one record: `resId = row.lead_id ??
  row.contact_id`, then one `ir.attachment` and one `message_post`.

The goal is to log one meeting to several records at once — a colleague, a
partner and a client — without any of them losing the meeting.

## What lands in Odoo

A separate note and a separate transcript attachment on **each** target
record. Each person sees the meeting on their own record's chatter, not only
in a notification inbox.

The note body is identical across targets: one summarizer call, one rendered
transcript, one body string. Per-audience bodies were considered and rejected
— N AI calls, N cost-tracking events, and a rule for what gets cut for whom
is a subsystem of its own, not part of this change.

The note keeps `subtype_xmlid: "mail.mt_note"` on every target. Odoo's
default is an internal note today, but nothing enforces that across versions
or customer-side customisations, and the failure mode if it ever flips is
every customer being emailed their own meeting transcript — now on up to five
records instead of one.

Cap: **5 targets per meeting**. Each target is a separate attachment upload
and `message_post` against a 30-second-timeout client, pushed sequentially.
Five is roughly where a meeting starts taking visibly long to send — and it
is bounded by the claim budget in *The claim must age per target, not per
meeting*, which is what actually decides whether five is safe.

---

## Data model

Migration 14. Migrations 11, 12 and 13 are frozen — sqlx checksums applied
migrations, and a changed checksum fails `Database.load`, which is the single
gate for chat history, prompts, cost tracking and meeting context.

### The file, its registration, and its pin test

The file is `src-tauri/src/db/migrations/odoo-multi-target.sql`. Existing
migrations use kebab-case descriptive names, not numbers
(`odoo-contacts.sql`, `meeting-log-queue.sql`, `odoo-lead-only-target.sql`);
this follows that.

It is registered in `src-tauri/src/db/main.rs` as **version 14**, one new vec
entry, exactly one new `.sql` file — `every_migration_file_is_registered`
counts files against entries.

It also needs its own pin test in `src-tauri/src/db/migration_tests.rs`,
following `lead_only_target_migration_is_version_13_and_points_at_its_own_file`
and its two predecessors. That test is not ceremony. Its own doc comments
record why it exists: the two generic checks bound only the *shape* of the
vec, so a migration registered at an already-used version, or pointing at
another migration's `.sql` file, passes them silently. Either mistake fails
`Database.load` for every existing user — a checksum collision on upgrade, or
a migration that never runs while the app queries tables that do not exist.

### The DDL

Every existing Odoo migration uses `IF NOT EXISTS` / `IF EXISTS` without
exception (3 of 3). Migration 14 matches, so a drifted development database
fails at the checksum rather than part-way through the DDL.

```sql
-- Replaces the odoo_selected_target singleton.
CREATE TABLE IF NOT EXISTS odoo_selected_targets (
  instance        TEXT NOT NULL,
  model           TEXT NOT NULL,      -- 'res.partner' | 'crm.lead'
  res_id          INTEGER NOT NULL,
  name            TEXT,               -- nullable; see "name is nullable on both tables"
  conversation_id TEXT,
  selected_at     INTEGER NOT NULL,
  PRIMARY KEY (instance, model, res_id)
);

CREATE TABLE IF NOT EXISTS meeting_log_targets (
  id              TEXT NOT NULL PRIMARY KEY,
  row_id          TEXT NOT NULL,
  model           TEXT NOT NULL,
  res_id          INTEGER NOT NULL,
  name            TEXT,               -- NULL for backfilled pre-14 rows
  status          TEXT NOT NULL DEFAULT 'pending',   -- pending | sent | failed
  attachment_id   INTEGER,
  message_id      INTEGER,
  last_error      TEXT,
  last_error_code TEXT,
  created_at      INTEGER NOT NULL,
  sent_at         INTEGER,
  UNIQUE (row_id, model, res_id)
);

CREATE INDEX IF NOT EXISTS idx_meeting_log_targets_row
  ON meeting_log_targets (row_id);
```

### Why `model` + `res_id` and not `contact_id` / `lead_id`

That pair is what the push already writes. `resId = lead_id ?? contact_id`
exists only to collapse two columns into the one value Odoo needs; storing
the resolved value deletes the coalesce and makes the table's shape identical
to the flat list in the picker.

### `name` is nullable on both tables

A `crm.lead` is not in the synced contact cache by definition, and the
in-memory list a lookup produced does not survive a `<Completion />` remount.
That is why the column exists at all — the same constraint that put
`lead_name` on `odoo_selected_target` in migration 13.

It must be **nullable on both tables**, not only on `meeting_log_targets`.
Migration 13's own backfill wrote `lead_name = NULL` for every pre-13 row
(`odoo-lead-only-target.sql`, the `SELECT id, instance, contact_id, lead_id,
NULL, …`), and before migration 13 a lead selection always rode on a contact
(`contact_id INTEGER NOT NULL`, migration 11). So a user whose current
selection is a pre-13 contact-plus-opportunity coalesces to a `crm.lead`
whose name is *provably* NULL. A `NOT NULL` column there aborts migration 14
and fails `Database.load` — the whole app's persistence — for exactly the
users who have been using the feature longest.

A contact-only selection is unnamed in the source table too; names live in
`odoo_contacts` and the join can legitimately miss. Both tables therefore use
the same render-time fallback chain: stored `name`, then the contact cache,
then `Contact #12` / `Lead or opportunity #90`.

### No per-target `sending` status

A crash mid-target would leave a target row that is neither `pending` nor
`failed`. Nothing reclaims targets — `reclaimStaleSending` operates on the
parent — so the parent could never derive a terminal status again. The
parent's CAS claim remains the whole concurrency gate.

### The backfill writes zero, one, but never more than one target per row

A pre-14 queue row holding both `contact_id` and `lead_id` means **the lead**
today — that is what `lead_id ?? contact_id` resolves to. So the rule is
`crm.lead` if `lead_id` is set, otherwise `res.partner`.

**A row with neither id set produces no target at all.** This is not an edge
case: `useMeetingLog` writes `contactId: target?.contactId ?? null` with
`status: target ? "held" : "unassigned"`, so *every* meeting that ended
without a contact picked has both ids NULL, and a `deleted` row that was
previously `unassigned` has the same shape. Sending those into the
`res.partner` branch writes `res_id = NULL` against `res_id INTEGER NOT
NULL`: the migration aborts, and every subsequent `Database.load` fails —
chat history, prompts, cost tracking and meeting context, gone, for any user
who ever ended a meeting without selecting anybody.

The backfill is therefore gated:

```sql
INSERT INTO meeting_log_targets (id, row_id, model, res_id, name, status,
                                 attachment_id, message_id, created_at, sent_at)
SELECT hex(randomblob(16)),
       id,
       CASE WHEN lead_id IS NOT NULL THEN 'crm.lead' ELSE 'res.partner' END,
       COALESCE(lead_id, contact_id),
       NULL,
       CASE status WHEN 'sent' THEN 'sent' WHEN 'failed' THEN 'failed'
                   ELSE 'pending' END,
       attachment_id, message_id, created_at, sent_at
  FROM meeting_log_queue
 WHERE contact_id IS NOT NULL OR lead_id IS NOT NULL;
```

`hex(randomblob(16))` mints the child id in pure SQL. Reusing the parent `id`
would also be unique — the backfill writes at most one child per parent — but
a distinct id keeps the two id spaces from being confused later.

It carries `attachment_id` and `message_id` across. Dropping those ids would
make every in-flight queued meeting re-post on the next sweep — duplicate
notes and duplicate transcript files on live customer records, for anyone who
upgrades with a non-empty queue.

The old singleton row migrates by the same coalesce rule.

### Every reader of the dropped table moves with it

`DROP TABLE IF EXISTS odoo_selected_target` is not just a picker change.

`purgeOtherInstances` (`src/lib/database/odoo-contacts.action.ts`) ends with
`DELETE FROM odoo_selected_target WHERE instance <> ?` and runs on **every**
contact sync. After migration 14 that statement throws "no such table" —
*after* the same function has already purged `odoo_contacts` and
`odoo_sync_state`. Contact sync then fails on every run, permanently, for
every user, with the picker painting a sync failure it can never clear.

Migration 14's task list therefore includes repointing that statement at
`odoo_selected_targets`, which carries `instance` and so is a one-line
substitution rather than a deletion. That also supplies the purge rule the
new table would otherwise lack: without it, switching credentials leaves
another database's selected targets live and pickable.

Implementation must sweep for any remaining reader of the dropped table, not
only the ones named here.

### The types that carried the singleton

The spec's claim that `meeting_log_queue.contact_id` and `lead_id` become
unwritten is only true if the code that writes them today changes:

- `ResolvedTarget` (`src/types/odoo.ts`) is replaced by
  `SelectedTargets` — an ordered list of `{ model, resId, name }`, living
  beside it in the same file. It is the type threaded through
  `useOdooTarget`'s `targetRef`, `useMeetingLog`'s
  `UseMeetingLogOptions.targetRef`, and `ContactPickerProps` in place of the
  singular `contactId` / `leadId` / `leadName` fields.
- `NewQueueRow.contactId` and `NewQueueRow.leadId`
  (`src/lib/database/meeting-log.action.ts`) are **removed**. Leaving them in
  place invites an implementer to keep writing the first or last target's ids
  onto the parent row, which contradicts the invariant directly.

`meeting_log_queue.contact_id`, `lead_id`, `attachment_id` and `message_id`
remain on disk, unwritten and unread after migration 14, documented as pre-14
history. Rebuilding a live write-ahead queue table to reclaim four columns is
not worth the risk.

### Migration 14 is one-way

After it runs, an older build finds no `odoo_selected_targets` and has no
target table at all. Back up the database before first run on any machine
holding real queued meetings.

---

## Writing and pushing

### Enqueue orders its writes; it cannot use a transaction

`BEGIN`/`COMMIT` is banned in this codebase. `getDatabase()` returns a
plugin-sql handle whose every `db.execute` is an independent IPC call against
a `Pool<Sqlite>` with no JS-side connection pinning: `BEGIN` and `COMMIT` can
land on different connections, `COMMIT` throws, and the connection that ran
`BEGIN` returns to the pool holding an open write transaction — every later
write in the app gets `SQLITE_BUSY` until restart.

`QUEUE_SQL`'s header comment currently reads "Nothing here writes two rows
that must agree." Multi-target makes that false, and the comment is updated
to say so. Ordering replaces atomicity:

1. Insert the target rows. `rowId` is already a client-side
   `crypto.randomUUID()`, so the children have their foreign key before the
   parent exists.
2. Insert the parent queue row last.

Target rows are inert until a parent references them, and the transcript
watermark is `MAX(transcript_end_at)` over the **parent** table. A crash
between the two steps therefore leaves the meeting un-queued, the watermark
unmoved, and the next trigger re-slices the same span correctly.

On `!created` — the other trigger won the `ON CONFLICT(session_key)` race —
delete the children by `row_id`.

### Every new statement lives where the no-transaction guard can see it

`QUEUE_SQL` is exported for one reason, stated in its own comment: so the
static scan in `meeting-log.action.test.ts` can iterate its VALUES and reject
a `BEGIN`. `reclaimBase`'s comment records that this scan **is the only check
that exists for that rule** — the sql.js test harness is a single in-process
connection and can never reproduce the pool bug at runtime.

Every new `meeting_log_targets` statement — the child insert, the child
delete, the per-target status and id writes, the orphan sweep — is therefore
added to `QUEUE_SQL`, not written inline in an action function. An N-row
child insert is exactly the code most likely to be "improved" into a
transaction by a later contributor, and a statement outside `QUEUE_SQL` is
invisible to the only guard that would catch it.

If the statements are grouped into a sibling exported object instead, the
scan's list is extended in the same commit.

### The orphan sweep

Crash-orphaned children are swept once at startup, age-gated on `created_at`
older than a few minutes. An ungated `NOT IN (SELECT id FROM
meeting_log_queue)` racing a live enqueue would delete the children of a
meeting about to be queued, and that meeting would queue with zero targets.

It follows `runTranscriptPrune`'s shape, for the reasons that function's own
comments give:

- Its own module-level once-per-process latch, surviving a `<Completion />`
  remount.
- Its own try/catch and its own log message — one shared chain makes an
  orphan-sweep failure indistinguishable from a prune failure in the log.
- An explicit `.catch()` at the effect boundary, because an escaping
  rejection in a React effect is the exact path `errors.ts` exists to close.
- It runs **outside** `runMeetingLogSweep`'s `ran` guard, chained alongside
  `runTranscriptPrune`. `runMeetingLogSweep` returns `{ran: false}` before
  doing anything when the Odoo config is absent or half-filled — so an orphan
  sweep placed inside it would never run for exactly the users most likely to
  accumulate orphans. It needs no Odoo config.

### The push loop

The parent claim is unchanged. Summarize once; build one body and one
rendered transcript for the whole meeting.

Then, sequentially, for each target whose status is `pending`:

1. `ir.attachment.create` (preceded by the adopt-search when
   `attemptsBefore > 0`), persist `attachment_id`
2. `message_post` (preceded by its adopt-search), persist `message_id`
3. mark that target `sent`, clearing its `last_error` and `last_error_code`

Targets already `sent` are skipped. That skip is what makes retry
non-duplicating, and it is the reason the per-target ids must survive the
backfill.

`attachmentNameFor(…)` takes **the parent queue row's `id`** and
`transcript_start_at`, unchanged. Both the parent and each target now have an
`id` in scope, so this is stated explicitly: the adopt-search is scoped by
`res_model` and `res_id` as well as by name, and those already differ per
target.

### One target's failure does not strand the others

Each target's attempt is wrapped in **its own error boundary**. Today
`pushQueuedRow` has one try/catch around the entire push, so the natural
port aborts the loop on the first failure — and that is unrecoverable. With a
deterministic fault on target 3 of 5 (an archived record → `ODOO_FAULT`, not
retryable): targets 1 and 2 skip as already sent, target 3 faults again, the
loop aborts. Every pass. Targets 4 and 5 are never attempted even once, and
`selectSweepable` never picks up `failed`.

So:

- A **deterministic** failure is caught for that target, written to its
  `status` / `last_error` / `last_error_code`, and the loop **continues** to
  the next target. The per-target error columns only make sense under this
  rule.
- A **retryable transport** failure (`isRetryable`) **aborts the remaining
  targets** for this pass rather than burning N × 30s against a dead network.
  Untried targets stay `pending`; the next sweep picks the row up again.

`attempts` remains a **parent-level** counter measuring passes, not targets.
`ESCALATE_AFTER_ATTEMPTS` therefore still counts sweep passes, and a row that
advances one target per pass does not escalate faster than a single-target
row would.

### A local write failure after a wire call routes that target to `pending`

`persistenceFailed` exists in the single-target push because a DB write
failing *after* an Odoo write must route to `pending`, not `failed`: failing
there strands an attachment — or a whole posted note — live on a customer
record with the row marked terminal.

Multi-target adds three persistence points per target (attachment id, message
id, mark sent) — up to fifteen per meeting. The same rule applies per target,
and it is a **throw-site** rule, not an error-code rule: any local write
failure after the claim routes *that target* to `pending` with the error
recorded, never to `failed`, regardless of the code. Classifying by code
instead turns a transient `SQLITE_BUSY` into `ODOO_INTERNAL`, `isRetryable`
returns false, and the target goes `failed` with its attachment live in Odoo
— which the retry rules below then make permanently unrecoverable.

The claim that "the adopt-search covers it" holds only if that target comes
back `pending`.

### The claim must age per target, not per meeting

`SUMMARIZE_TIMEOUT_MS`'s doc comment in `src/lib/odoo/meeting-log.ts` carries
an explicit arithmetic budget: "five Odoo calls at 30s AND an AI call. 150s +
60s = 210s against the 300s gate." Multi-target makes that arithmetic false.

A first push of five targets is 5 × 2 wire calls × 30s = **300s**, exactly
`STALE_CLAIM_MS`, before the 60s summarize. A retry, where both adopt-searches
run, is 5 × 4 × 30s = **600s**.

A claim that outlives `STALE_CLAIM_MS` is reclaimed to `pending` by the other
window's `reclaimStaleSending` — whose `claimed` exclusion is per-webview and
cannot see a dashboard-owned push — and the row is pushed again *while the
first push is still running*. "A double execution converges anyway" fails in
exactly that overlap: the second pusher's adopt-search runs against a
`message_post` the first has in flight but not yet committed — the
commit-then-timeout window the adopt-search exists to paper over — and posts
a duplicate note on a customer record.

**The fix is to re-stamp `claimed_at` on the parent after each target
completes**, so the claim ages per target rather than per meeting.
`STALE_CLAIM_MS` keeps its current value and its current meaning: the longest
a single unit of work may run before it is presumed dead.

`SUMMARIZE_TIMEOUT_MS`'s comment is rewritten in the same change. Leaving
stale arithmetic in a comment that a future contributor will tune against is
its own defect.

### Parent status derives from its targets, in this precedence

0. **zero targets → `unassigned`**
1. any target still retryable → `pending`
2. else any target failed → `failed`
3. else all sent → `sent`

**Rule 0 comes first and is not optional.** "All sent" is vacuously true of an
empty set, so without it, removing a row's last target marks a meeting that
reached nothing as `sent`, writes `sent_at`, clears its error, drops it from
`listActionable`, and makes its transcript eligible for retention pruning.

**The order of 1 and 2 is load-bearing.** Failed-wins-over-retryable would
strand the retryable target permanently: `selectSweepable` picks up only
`pending` and `held`, so nothing would ever come back for it.

Derivation is reachable **only from a parent in `sending`**. It never runs on
a parent in `cancelled`, `deleted`, `sent` or `unassigned`. Without that
guard, re-deriving a `deleted` parent that still holds `pending` children
flips it to `pending` — and a `deleted` row has `transcript = ''`, so the
next push sends an empty attachment and a "Summarization failed" note to a
customer record.

### The derived write is a CAS, like every other status write

`toPending`, `toFailed` and `toSent` are each a CAS on `status = 'sending'`,
with a documented zombie-writer rationale. The derived write is no different
and must not be an unconditional `UPDATE`.

The race is concrete: a `failed` row sits on the dashboard; the user clicks
Retry; the main window's sweep claims it (`sending`); the stale dashboard's
Remove re-derives and writes over the live claim; `reclaimStaleSending` or
the next sweep re-claims and re-pushes — two attachments and two
customer-visible notes.

So the derived write carries the status it expects to replace, and the push's
own terminal derive routes through the existing `toSent` / `toFailed` /
`toPending` statements rather than a new statement without a predicate.

### The parent's error is a denormalized mirror

The parent keeps `last_error` and `last_error_code`. Three consumers read
them — `QUEUE_SQL.lastError`, `getQueueCounts().lastError` (the /odoo page's
only sentence explaining why a backlog is stuck), and `runAction`'s
`push-failed` copy — and `recordErrorOnUnsent` still writes them. Dropping
them from the parent leaves all three permanently blank while the writer
keeps writing, so the two sources drift.

On derivation the parent copies the error of the target that determined its
status: the first retryable target, else the first failed one. When it
derives `sent` it clears both columns, mirroring `toSent`. The parent's copy
is a mirror for display, never a second source of truth.

### A partly-failed meeting must not hide in "Waiting"

Precedence rule 1 makes a row with one retryable target and one terminally
failed target derive `pending`. `groupOf` then files it under *waiting*,
`QUEUE_SQL.counts` counts it as `waiting` rather than `needs_attention`, and
`countAll` — which backs /odoo's promise that finishing the credentials will
send these rows — counts it too, though one of its targets never will be
sent. The failure surfaces only once `attempts` reaches
`ESCALATE_AFTER_ATTEMPTS`, if ever.

"Any target failed" is therefore a first-class signal, independent of the
derived parent status: `groupOf` and `QUEUE_SQL.counts` take a
`failedTargets > 0` input and group and count such a row as needing
attention while its parent is still `pending`, and `countAll` excludes it
from its promise.

### Undo is untouched

`startHold(rowId)` holds the parent; `cancelHeld` flips it to `cancelled`; no
target is ever claimed during the hold. One strip, one Cancel, nothing sent
to any target.

`cancelHeld` leaves the target rows in place. They are not orphans — the
parent row still exists — so the startup sweep's `NOT IN (SELECT id FROM
meeting_log_queue)` correctly does not touch them, and they are removed with
the parent when the row is deleted or pruned.

A cancelled meeting is **not** retargetable and does not appear on the queue
page. `listActionable`'s `WHERE` excludes `cancelled`, `groupOf` returns null
for it, and `assignRow`'s CAS accepts only `('unassigned', 'failed')`.
Changing that is a separate piece of work with its own reasoning — not least
because `cancelled` rows are in `QUEUE_SQL.prune`'s scope, so a retargetable
cancelled row could carry a blanked transcript and put an empty attachment on
a customer record.

### Reassign splits on whether anything already landed

Whole-row retarget — insert new children, delete the old ones, flip the
parent last — is permitted **only when no target is `sent`**. On a
2-sent/1-failed row it would delete the only record that those two notes
exist, and the next push would post them again.

**That gate lives in the write predicate, not in which buttons render.** The
spec already argues that the cap must be enforced below the UI because "the
UI can hold stale state; the insert cannot", and this rule is far more
dangerous than the cap. `assignRow`'s CAS is status-only and cannot see
children; `deleteRow`'s own comment documents the stale-dashboard window as
reachable ("the dashboard window only re-reads on focus, mount and action").
So:

```sql
... WHERE id = ?
      AND status IN ('unassigned','failed')
      AND NOT EXISTS (SELECT 1 FROM meeting_log_targets
                       WHERE row_id = ? AND status = 'sent')
```

The three-step retarget gets the same crash-ordering treatment the enqueue
path got, because it has the same exposure and no transaction available:

1. Insert the new children first.
2. Delete the old children.
3. Flip the parent last, under the CAS above.

A crash after step 1 leaves extra `pending` children on a row whose parent
status has not changed — recoverable, and the orphan sweep does not touch
them because the parent exists. Deleting first, as originally written, leaves
a zero-target parent stuck at its prior status. If the parent flip in step 3
is refused, the children are reconciled to match the parent's unchanged
target set rather than left divergent.

A partially-sent row gets per-target actions instead:

- **Retry this one** — sets *that target* to `status = 'pending'`,
  `last_error = NULL`, `last_error_code = NULL`, and *then* flips the parent
  to `pending`. Resetting the child is the load-bearing half: the loop
  filters on `status = 'pending'`, so flipping only the parent leaves the
  button a no-op against the target it names. The whole-row retry path
  (`retryRow`) does the same for every `failed` child, and never touches a
  `sent` one — today it flips the parent and NULLs the parent's error, so
  without the child reset the derive returns `failed` again and the page
  prints "the error on the row says why" beside a row whose error was just
  cleared.
- **Remove** — deletes that one child, then re-derives the parent status.
  **Remove is refused on a `sent` target.** A `sent` target row is immutable
  and is never deleted by any user action: it is the only record that the
  note exists. Allowing its removal destroys that record, and once every
  `sent` child is gone the whole-row retarget gate above passes — re-adding
  the same record then posts a duplicate note and a duplicate transcript file
  with nothing left to skip.

**Any operation that would leave a row with zero targets flips the parent to
`unassigned` in the same write** — Remove of the last child, and the push's
own zero-target check when it finds one. `assignRow`'s comment states the
invariant this protects: "Target and status in ONE statement, so a row can
never be `pending` with no target — the exact collision `unassigned` exists
to prevent." A `pending` row with no targets is unrecoverable:
`selectSweepable` selects it, the push declines it before the claim so
`attempts` never increments and it never escalates, `groupOf` files it under
*waiting* forever, and `assignRow`'s CAS refuses to retarget it.

### Delete must stop claiming nothing was sent

`deleteRow` accepts `held`, `pending`, `unassigned` and `failed`;
`deleteTerminalRow` takes `sent` and `cancelled`. The split exists — per its
own comment — so that a `deleteRow` match **proves** the meeting never
reached Odoo, which is what licenses `DELETED_COPY`'s "Nothing was sent to
Odoo."

Multi-target destroys that proof. A `failed` parent can legitimately have two
of three targets `sent`, with two full notes live on two customers' chatter.
The user is told nothing was sent, and the transcript is blanked in the same
statement. A `pending` partially-sent row breaks the same way.

`deleteRow`'s predicate gains:

```sql
AND NOT EXISTS (SELECT 1 FROM meeting_log_targets
                 WHERE row_id = meeting_log_queue.id AND status = 'sent')
```

so a partially-sent row falls through to `deleteTerminalRow` and the honest
`deleted-after-send` copy.

### The cap is enforced in `meeting-log.action.ts`

Not in the picker, and not in `src/lib/odoo/meeting-log-actions.ts`. Those
two files differ by one hyphen and one letter and have opposite
responsibilities: `src/lib/database/meeting-log.action.ts` is the raw SQLite
layer where `insertQueueRow` and `QUEUE_SQL` live, and is what this codebase
calls "the action layer" elsewhere (see `sliceTranscript`'s doc comment).
`src/lib/odoo/meeting-log-actions.ts` is queue-page orchestration —
`retryMeetingLog`, `assignMeetingLog`, `deleteMeetingLog` — and has no
enqueue path at all, so it cannot cap target rows it never creates.

The cap is enforced **on write to `odoo_selected_targets`**, so the selection
can never exceed five in the first place, and again on the child insert at
enqueue, so a stale caller cannot smuggle a sixth through. Overflow
**rejects**: the add is refused and the caller is told the cap was reached.
It never silently truncates — dropping a target the user believes they
selected is the one outcome worse than refusing the click.

### `stampLastMeeting` stamps every contact target

`stampLastMeeting(instance, id, at)` writes `last_meeting_at` for one
contact, and that column drives recency ordering in the picker. Under
multi-target it is called for **every `res.partner` target** and skipped for
`crm.lead`, which is not in the cache. Left as-is, recency silently degrades
to whichever single contact the caller happened to pass.

---

## The picker

### Trigger line

Three names do not fit a 600px overlay. First name plus a count:

```
0 targets   →  "Who are you meeting?"
1 target    →  "Christian Carron"            (unchanged from today)
2+ targets  →  "Christian Carron + 2 more"
```

### "Logging to" section

Pinned at the top of the popover, above the search box, with its own `max-h`
and scroll:

```
Logging to (3)
  ×  Christian Carron            Contact
  ×  Partnership with ECS        Lead
  ×  Bentley AS                  Contact
```

At the cap the header reads `Logging to (5) · limit reached` and the add
affordances are non-actionable, carrying that reason.

### The overlay resize is content-driven now, and the effect must change

The overlay is fixed 600×54 and grows only through `useCompletion`'s resize
effect, which watches a **fixed flag list** — it fires when the picker opens
and closes.

"Logging to" breaks that assumption. Its height varies from 0 to 5 rows
purely from add and remove clicks *inside an already-open popover*, an
interaction that never toggles `isPickerOpen`. A flag-driven effect has no
dependency that changes, so the window does not grow as targets are added.

**The target count joins the resize effect's dependencies**, so it re-fires
on every add and remove while the picker is open. Reserving the worst-case
five-row height on open was the alternative and is rejected: in a 54px
overlay it hands back a large empty panel to the common case of one target.

### Rows are toggles

Every contact row, every deal row and every lead-search result gets the same
`+ add` / `✓ added` treatment. Clicking an added row removes it. One
interaction across all three sections, because under a flat list they all
produce the same kind of thing.

A target is exactly one Odoo record. Clicking a deal under a contact adds
**the deal**, as its own line — not a deal attached to that contact's line.
Wanting the note on both the person and their lead means adding both, which
is two lines and two notes. What the list shows is exactly what gets written.

At the cap, add affordances use **`aria-disabled`, not the native `disabled`
attribute**. A native `disabled` removes the element from the tab order and
blurs it if it currently holds focus, with no defined recovery target: a
keyboard user focused on one row's `+ add` when a different interaction
reaches the cap loses focus to `<body>`, and a focus loss immediately after a
successful add risks tripping the popover's outside-interaction dismiss.
`aria-disabled` keeps the control focusable and in the tab order while
announcing it as disabled, and the click handler no-ops. Hiding the controls
was already rejected — a search box that vanishes reads as a bug.

### The deal lookup moves from selection-time to browse-time

Today `fetchOpportunities` fires when a contact is *selected*. That cannot
serve a list where selecting no longer means "this is the target".

A contact row gets a disclosure that fetches its leads and opportunities on
expand, keyed by contact id and cached for the popover session so
re-expanding costs nothing.

**It needs its own concurrency primitive.** Every existing async opportunity
fetch is gated on one shared `selectionToken` ref, bumped by `onSelect`,
`onSelectLead`, `handleNewChat` and `handleInstanceChanged`. Reusing that
idiom per row means adding or removing *any* target elsewhere in the list
invalidates an in-flight or just-resolved fetch for an unrelated, still-open
row — the staleness guard swallows the result and that disclosure is stuck on
"Looking up…" with no way back.

So per-row fetches are keyed per contact: a `Map<contactId, number>`
generation counter (or a per-row `AbortController`), independent of
`selectionToken`. Re-expanding a contact whose fetch is in flight, or already
cached, starts no second request.

### The colleague guard moves with it, and is not verbatim

`isColleague` still skips the lookup, but its enforcement moves from
once-per-hook-selection to once-per-row — the same restructuring as above,
and it should be described that way rather than as a survival.

A colleague's expanded row renders **static text**, not the existing "Look
up" control. That control is already reachable-but-inert for colleagues today
(`onRetryOpportunities` early-returns on `isColleague`); carrying a dead
actionable-looking button into a per-row disclosure multiplies it by the
number of colleagues in the list.

This is why "a colleague and a client at the same time" stops being a
conflict: under single-target selection, marking someone a colleague disabled
the deal lookup for the whole selection.

### An archived contact drops one target, not the selection

`reload()` today wipes the entire selection when the selected contact comes
back inactive from a sync (`commit(null, token)`). Ported naively — "any
target's contact archived, wipe everything" — that deletes up to four valid
targets because a fifth one's contact went inactive.

Archival-driven removal operates **per target**: it drops only the
`odoo_selected_targets` row whose contact went inactive, and leaves the rest.

### Destination sentence

Pluralises, and stays exact about each record's kind:

```
1 target   "This meeting will be logged on the lead Partnership with ECS."
3 targets  "This meeting will be logged on 3 records: Christian Carron,
            the lead Partnership with ECS, and Bentley AS."
```

### AssignDialog

`AssignPayload` becomes a list, and the dashboard's assign dialog gets the
same multi-select treatment. Left single-target, assigning from the dashboard
would silently collapse a queued meeting back to one record.

Three things the one-sentence version left unstated:

- **Selection state** mirrors the picker's: an ordered list of
  `{ model, resId, name }` replacing the dialog's single `selected` /
  `leadId` pair, with the same `+ add` / `✓ added` rows.
- **The dialog enforces the cap itself**, with the same `aria-disabled`
  treatment at five — the action layer refuses a sixth regardless, but a
  dialog that lets you pick six and then fails on Confirm is worse.
- **Confirm is unreachable once any target on the row is `sent`.** Confirm
  performs exactly the insert-new / delete-old / flip-parent operation the
  reassign rule forbids on a partially-sent row, and `handleAssign` currently
  opens the dialog for any row regardless of status. On such a row the dialog
  is superseded by the queue page's per-target Retry and Remove. The write
  predicate refuses it anyway; this keeps the UI from offering an action that
  will be rejected.

---

## The queue page

One row per meeting, expandable to per-target state:

```
▼  Meeting with ECS · 14:30           1 of 3 failed
     ✓  Christian Carron        contact     sent
     ✓  Partnership with ECS    lead        sent
     ✗  Bentley AS              contact     ODOO_FAULT
              [ Retry this one ]  [ Remove ]
```

`targetNameOf` currently reads the synced contact cache. It reads
`meeting_log_targets.name` instead. Backfilled pre-14 targets have a NULL
name and fall back to the cache lookup, then to `Contact #12` /
`Lead or opportunity #90`.

`listActionableRows` needs the per-target rows: one extra query fetching all
targets for the listed parent ids, joined in memory. Not N+1, and not a JOIN
that would multiply the parent rows.

---

## Testing

Unit and component coverage in the existing style:

**Migration and backfill**

- an `unassigned` legacy row — both ids NULL — backfills to **zero** targets,
  and the migration applies cleanly
- a legacy row with `lead_id` set backfills to one `crm.lead` target; a row
  with only `contact_id` backfills to one `res.partner` target
- `attachment_id` and `message_id` carry across for an in-flight row
- the legacy singleton with `lead_id` set and `lead_name` NULL migrates
  without violating a constraint
- **Rust:** `multi_target_migration_is_version_14_and_points_at_its_own_file`
  in `migration_tests.rs`, following the three existing precedents

**Data layer**

- the four-way parent status precedence, including rule 0 (zero targets →
  `unassigned`)
- derivation refuses to run on a `cancelled`, `deleted`, `sent` or
  `unassigned` parent
- a zero-target row is excluded from claim and from every "will be sent"
  count
- the derived write is a CAS and loses to a concurrent claim
- `deleteRow` refuses a row with a `sent` target, so it routes to the
  `deleted-after-send` copy
- the reassign predicate refuses a row with a `sent` target
- Remove is refused on a `sent` target
- Remove of the last target flips the parent to `unassigned`
- enqueue ordering under a crash between the two writes
- the three-step retarget under a crash after each step
- the orphan sweep's age gate
- the no-transaction static scan covers every new statement
- the cap at `meeting-log.action.ts`, on both write paths, rejecting rather
  than truncating

**Push**

- retry skips already-`sent` targets
- retry of a `failed` target actually re-attempts it — the child is reset,
  not just the parent
- a deterministic failure on target 3 of 5 does not stop targets 4 and 5
- a retryable transport failure aborts the remaining targets and leaves them
  `pending`
- a local write failure after a successful wire call routes that target to
  `pending`, never `failed`
- the adopt / reuse / short-circuit matrix across **mixed** target states in
  one push — target A short-circuiting on stored ids while target B needs an
  adopt-search
- `claimed_at` is re-stamped between targets
- a target marked `sent` has its error columns cleared

**UI**

- the picker's toggle behaviour, cap state, and pluralised sentence
- a backfilled NULL-name target whose id is also absent from the contact
  cache renders the generic placeholder
- a partly-failed row is grouped and counted as needing attention while its
  parent is `pending`
- expanding two contacts in quick succession resolves both disclosures;
  adding a target elsewhere does not strand an open one on "Looking up…"
- the resize effect re-fires when a target is added or removed while the
  picker is open
- a colleague's expanded row renders static text and no dead control
- an archived contact drops only its own target
- AssignDialog's Confirm is unreachable on a row with a `sent` target

`assignQueueRow`'s two-id signature, its own test, and the roughly 560 lines
of AssignDialog tests built on singular-opportunity semantics are **replaced**
by list-based equivalents, not left to break during implementation. The
replacements must still prove what the originals proved: a zero-row assign
CAS is surfaced rather than swallowed, an individual target can be added and
taken back off, and a still-pending row is refused.

Mutation checks where a passing test proves least:

| Mutant | Must fail |
|---|---|
| parent status precedence inverted (failed before retryable) | a mixed row stays retryable |
| rule 0 removed, so zero targets falls through to "all sent" | removing the last target marks the meeting `sent` |
| the retry loop stops skipping `sent` targets | retry re-posts to a sent target |
| "Retry this one" flips only the parent, not the child | the retry is a no-op against a failed target |
| the loop aborts on the first target failure | a target behind a deterministic fault is never attempted |
| a persistence failure marks the target `failed` | an attachment is stranded on a customer record with no retry path |
| the backfill drops `attachment_id` / `message_id` | an upgraded in-flight row re-posts |
| the backfill loses its `contact_id IS NOT NULL OR lead_id IS NOT NULL` gate | an unassigned legacy row aborts the migration |
| the reassign gate moves from the predicate to the UI | a stale dashboard retargets a partially-sent row |
| `deleteRow` loses its `sent`-target check | a 1-sent/1-failed row deletes under "Nothing was sent to Odoo" |
| the derived write drops its CAS | a stale dashboard overwrites a live claim |
| `claimed_at` is stamped once per meeting | a five-target push is reclaimed mid-flight |
| the orphan sweep loses its age gate | a live enqueue's children survive |

### What no local test can prove

Every failure mode this design exists to handle is an Odoo response — a
`message_post` fault on target 3 of 3, a permissions refusal, an archived
record. A mocked client returns whatever it is told to.

The live smoke test has now gone unrun on three consecutive PRs. This feature
writes notes to up to five customer records per meeting instead of one, so
the same gap carries five times the blast radius. **The live check belongs in
the implementation plan as a task with an owner**, not as a standing offer.

Failure legs must be manufactured **locally** — kill the app, drop the
network, target an archived record. Never by sending bad credentials:
fail2ban on the Odoo host is `maxretry 10 / findtime 600 / bantime 3600`, and
a botched retry test locks the account out for an hour.
(Unban: `sudo fail2ban-client set odoo-login unbanip <ip>`.)

## Out of scope

- Per-audience note bodies
- Notifying targets who are not themselves receiving a note
  (`partner_ids` on the message)
- Sharing one attachment across records rather than uploading per target
- Any change to summarization, transcript slicing, or the watermark
- Making a `cancelled` meeting visible and retargetable on the queue page
  (see *Undo is untouched*)

## Forward compatibility: automated target selection

**Non-normative except where marked.** This section adds no requirements to
this implementation and no plan task implements it. It records what a later
calendar-sync feature — read the current Outlook meeting, match its attendee
list against the contact cache, propose targets — would attach to, so that
feature does not reopen decisions already made here.

The seam is `odoo_selected_targets`. A set of `(model, res_id, name)` rows is
already exactly the shape an automated selector would produce; nothing about
the flat list assumes a human clicked it.

**Binding on this implementation:** enqueue trusts every row in
`odoo_selected_targets` and performs no confirmation of its own. That is
sound today only because each row got there by an explicit click. Any
automated writer must therefore land its results somewhere a human confirms
first, and must not write into `odoo_selected_targets` directly. The failure
mode is not a wasted note: a wrong match posts one customer's meeting
transcript into another customer's CRM record, on up to five records at once,
under a `mail.mt_note` the wrong customer's account manager will read. This
paragraph exists so the invariant is written down where the next spec finds
it, not so this implementation adds a check.

Consequences for a future matcher, in the same spirit:

- **Email exact match is feasible against today's cache.**
  `odoo_contacts.email` exists (migration 11) and is indexed on
  `(instance, email)`. No sync change is needed to look attendees up by
  address.
- **Name similarity is propose-only, never auto-applied.** Two people share a
  name across two companies; the email index does not have that problem.
- **The cap of five applies to any source.** A source that produces more than
  five matches must choose or ask — the cap is enforced at the action layer
  precisely so a caller cannot exceed it. Which five, and how the overflow is
  presented, is that feature's design problem, not this one's.
- **Provenance is deliberately not stored now.** A `source` column
  (`'manual' | 'calendar'`) on `odoo_selected_targets` would only matter once
  something automated writes to it. The table holds the current selection, not
  durable history, so adding it later is a new migration file with
  `DEFAULT 'manual'` and no meaningful backfill — it does not touch the frozen
  checksums of 11 through 14. Deferred on purpose.
