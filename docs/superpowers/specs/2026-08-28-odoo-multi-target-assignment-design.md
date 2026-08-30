# Odoo multi-target assignment — design

**Status:** approved, not implemented
**Date:** 2026-08-28
**Revised:** 2026-08-28, after two five-reviewer rounds and 79 applied findings
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
counts files against entries. Its `description` is
`"create_multi_target_tables"`, following `"create_odoo_contact_tables"`,
`"create_meeting_log_queue"` and `"allow_lead_only_selected_target"`. That
string is not cosmetic: the pin test finds its migration with
`.find(|m| m.description == "…")`.

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
```

No separate index on `row_id`. `UNIQUE (row_id, model, res_id)` already
creates one with `row_id` leftmost, which serves every `WHERE row_id = ?`
lookup; an explicit second index would only add write amplification on each
child insert and status update.

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
INSERT OR IGNORE INTO meeting_log_targets (id, row_id, model, res_id, name, status,
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

`INSERT OR IGNORE` matches migration 13's `INSERT OR REPLACE` precedent. The
DDL's `IF NOT EXISTS` lets a drifted development database survive the create,
and a bare `INSERT` would then abort on `UNIQUE (row_id, model, res_id)`
anyway.

It carries `attachment_id` and `message_id` across. Dropping those ids would
make every in-flight queued meeting re-post on the next sweep — duplicate
notes and duplicate transcript files on live customer records, for anyone who
upgrades with a non-empty queue.

The old singleton row migrates by the same coalesce rule **and the same
`WHERE contact_id IS NOT NULL OR lead_id IS NOT NULL` gate**, before
`DROP TABLE IF EXISTS odoo_selected_target` runs. A both-NULL singleton cannot
be produced by this app's writes — `saveTarget` never stores one — but
`loadTarget` already guards against reading one back, on the reasoning that it
"cannot be written by this app… but reading it back as a target would hand
slice 2 something it can only file as unassigned". The cost of the guard is one
WHERE clause; the cost of its absence is a permanently failing
`Database.load`.

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

- `ResolvedTarget` (`src/types/odoo.ts`) is replaced by two exported types
  living beside it in the same file — **the element is named, not only the
  list**, because the picker's per-row handlers, `AssignDialog`'s selection
  state and the per-target rendering each need to name one element, and an
  anonymous shape gets redeclared inline in all three:

  ```ts
  export interface SelectedTarget {
    model: "res.partner" | "crm.lead";
    resId: number;
    name: string | null;
  }
  export type SelectedTargets = SelectedTarget[];
  ```

  Unprefixed, matching every other type in that file, and camelCase over the
  snake_case columns, matching how `loadTarget` already maps its read. This is
  the type threaded through `useOdooTarget`'s `targetRef`, `useMeetingLog`'s
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

The new keys follow the existing naming so the object stays readable:
`insertTarget`, `deleteTargetsByRow`, `targetsByRow`, `sweepOrphanTargets`,
`targetToPending` / `targetToFailed` / `targetToSent` (mirroring `toPending` /
`toFailed` / `toSent`), and `setTargetAttachment` / `setTargetMessage`
(mirroring `setAttachment` / `setMessage`).

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

**`PushDeps.now` changes from `number` to `() => number`.** Today it is a
single value sampled once by the caller and threaded through the whole push.
That is fine for a push that writes one timestamp; it is not fine for a loop
that re-stamps the claim between targets, because every re-stamp would write
the identical value — making a correct implementation and one that stamps only
once indistinguishable in the database, and the corresponding mutation check
unkillable. This is an interface change to the push, not a test-only concern.

### One target's failure does not strand the others

Each target's attempt is wrapped in **its own error boundary**. Today
`pushQueuedRow` has one try/catch around the entire push, so the natural
port aborts the loop on the first failure — and that is unrecoverable. With a
deterministic fault on target 3 of 5 (an archived record → `ODOO_FAULT`, not
retryable): targets 1 and 2 skip as already sent, target 3 faults again, the
loop aborts. Every pass. Targets 4 and 5 are never attempted even once, and
`selectSweepable` never picks up `failed`.

So, three branches — not two:

- A **deterministic** failure is caught for that target, written to its
  `status` / `last_error` / `last_error_code`, and the loop **continues** to
  the next target. The per-target error columns only make sense under this
  rule.
- A **retryable transport** failure (`isRetryable`) **aborts the remaining
  targets** for this pass rather than burning N × 30s against a dead network.
  The aborting target records its own `last_error` and `last_error_code`
  before the loop unwinds — without that the parent's mirror has nothing to
  copy and a network outage renders as an unexplained stuck row. Untried
  targets stay `pending`; the next sweep picks the row up again.
- A **local persistence** failure is neither, and **also aborts the pass**.
  Continuing would fire wire calls on targets 4 and 5 whose returned ids the
  same broken database cannot store. See the next section for how that target
  is classified.

`attempts` remains a **parent-level** counter measuring passes, not targets.
`ESCALATE_AFTER_ATTEMPTS` therefore still counts sweep passes, and a row that
advances one target per pass does not escalate faster than a single-target
row would.

**Some deterministic codes are instance-wide, and that is accepted.**
`ODOO_UNREACHABLE` with a non-retryable status (a 404 from a wrong URL path),
`ODOO_PAYLOAD_UNSERIALIZABLE` and `ODOO_MALFORMED_RESPONSE` share the body and
the client, so they fail identically for every target and the loop marks all
five `failed` where the single-target code failed one row. This is deliberate
rather than carved into the abort branch: one whole-row Retry recovers all
five, because `retryRow` resets every `failed` child.

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

**The `persist` helper and its flag are re-created inside each target's error
boundary.** Today `persistenceFailed` is one boolean over the whole push and is
never reset. Hoisted unchanged into a per-target loop it stays `true` for every
subsequent target, so a `SQLITE_BUSY` on target 1 would route target 3's
genuine `ODOO_FAULT` to `pending` and retry it forever — the same
misclassification this section forbids, running the other way.

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

The re-stamp is a CAS:

```sql
UPDATE meeting_log_queue SET claimed_at = ? WHERE id = ? AND status = 'sending'
```

The predicate is **not** needed to make re-stamping work — a plain update
already defeats `reclaimBase`'s `claimed_at < ?` test, and the only other
reader, `isClaimStale`, is status-gated. It is there because
`rowsAffected = 0` is the pusher's only signal that its claim was taken by
another window while it was working. A zero-row result and a throw are treated
identically: the claim is gone or unprovable, so the pass aborts and the
remaining targets stay `pending`. Continuing to push under a claim nobody is
refreshing is precisely the reclaim-mid-flight duplicate the re-stamp exists to
prevent.

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

Derivation **refuses** to run on a parent in `cancelled`, `deleted`, `sent` or
`unassigned`. Re-deriving a `deleted` parent that still holds `pending`
children would flip it to `pending` — and a `deleted` row has
`transcript = ''`, so the next push would send an empty attachment and a
"Summarization failed" note to a customer record.

It is stated as an exclusion list, not as "only from `sending`". That earlier
phrasing was wrong, and wrong in a way that made the queue page's own actions
impossible: Remove and Retry act on a parent that is `pending` or `failed` —
QueueRow disables every control while `sending` — so a derive gated on
`status = 'sending'` would match zero rows by construction. Removing the
failed child from a 1-sent/1-failed row would leave every remaining target
`sent` while the parent stayed `failed`, sitting in needs-attention with a
Retry that has no failed child to reset.

### The derived write is one CAS'd mechanism with two callers

`toPending`, `toFailed` and `toSent` are each a CAS on `status = 'sending'`,
with a documented zombie-writer rationale. The derived write is no different
and must not be an unconditional `UPDATE`.

The race is concrete: a `failed` row sits on the dashboard; the user clicks
Retry; the main window's sweep claims it (`sending`); the stale dashboard's
Remove re-derives and writes over the live claim; `reclaimStaleSending` or
the next sweep re-claims and re-pushes — two attachments and two
customer-visible notes.

So the derived write carries **the status it observed**:

```sql
UPDATE meeting_log_queue SET status = ?, last_error = ?, last_error_code = ?
 WHERE id = ? AND status = ?
```

There is **one** such mechanism, with two callers, not two separately
specified writes:

- the push's terminal derive, where the observed status is `'sending'` — the
  special case that reduces to today's `toSent` / `toFailed` / `toPending`
- the queue page's Remove and per-target Retry, where the observed status is
  the `pending` or `failed` the caller read

Specifying those as different mechanisms would re-create the contradiction
above in new words. A zero-row result means the row moved underneath the
caller: the action reports a refusal and re-reads, exactly as the existing
zero-row assign CAS does.

### The parent's error is a denormalized mirror

The parent keeps `last_error` and `last_error_code`. Three consumers read
them — `QUEUE_SQL.lastError`, `getQueueCounts().lastError` (the /odoo page's
only sentence explaining why a backlog is stuck), and `runAction`'s
`push-failed` copy — and `recordErrorOnUnsent` still writes them. Dropping
them from the parent leaves all three permanently blank while the writer
keeps writing, so the two sources drift.

On derivation the parent copies the error of the target that determined its
status. "First" must be defined or the mirror silently resolves to NULL:
target rows have no ordering column, and an untried target and a
transport-aborted one are both `pending`, so an unqualified "first retryable
target" can land on a row that never ran and carries no error. The rule is
therefore: **`ORDER BY created_at, id`, restricted to targets that actually
carry a `last_error_code`** — the first such retryable target, else the first
such failed one.

When it derives `sent` it clears both columns, mirroring `toSent`. Otherwise
the parent's error is **never overwritten with NULL while the row is
non-terminal** — blanking it takes `QUEUE_SQL.lastError`, `getQueueCounts()`
and `runAction`'s copy down with it, turning a network outage into an
unexplained stuck row. The parent's copy is a mirror for display, never a
second source of truth.

### A partly-failed meeting must not hide in "Waiting"

Precedence rule 1 makes a row with one retryable target and one terminally
failed target derive `pending`. `groupOf` then files it under *waiting*,
`QUEUE_SQL.counts` counts it as `waiting` rather than `needs_attention`, and
`countAll` — which backs /odoo's promise that finishing the credentials will
send these rows — counts it too, though one of its targets never will be
sent. The failure surfaces only once `attempts` reaches
`ESCALATE_AFTER_ATTEMPTS`, if ever.

"Any target failed" is therefore a first-class signal, independent of the
derived parent status. Four consumers take it, not two:

- `groupOf` files such a row under needs-attention while its parent is still
  `pending`
- `QUEUE_SQL.counts` counts it there rather than under `waiting`
- `countAll` excludes it from its "finishing the credentials will send these"
  promise
- **`statusLine`** gets its own sentence for a partly-failed parent. Without
  it the row renders "Waiting to be sent" directly beneath the "Needs
  attention" heading, beside a "1 of 3 failed" summary — three surfaces
  disagreeing about one row.

`QUEUE_SQL.lastError` needs the same condition. Its predicate today is
`status = 'failed' OR (status = 'pending' AND attempts >= ?)`, so a
partly-failed row counted as needs-attention is `pending` below the threshold
— the /odoo page's count rises with no reason attached anywhere on the page.

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
                       WHERE row_id = meeting_log_queue.id AND status = 'sent')
```

The subquery correlates on `meeting_log_queue.id` rather than taking a second
`?`, matching the delete predicate below. A second placeholder would mean the
row id is bound twice, and the existing `assignQueueRow` call site gives an
implementer no cue that the parameter count changed.

The three-step retarget gets the same crash-ordering treatment the enqueue
path got, because it has the same exposure and no transaction available:

1. **Insert the new children**, with
   `ON CONFLICT(row_id, model, res_id) DO UPDATE SET status = 'pending',
   last_error = NULL, last_error_code = NULL`.
2. **Delete the old children**, scoped to the *complement* of the new
   `(model, res_id)` set, and `AND status <> 'sent'`.
3. **Flip the parent last**, under the CAS above.

Every clause there is load-bearing:

- Without `ON CONFLICT`, an overlapping target set aborts the whole retarget.
  Old `{A, B}` → new `{A, C}` re-inserts `A` under the same `row_id` and
  violates `UNIQUE (row_id, model, res_id)`.
- The `DO UPDATE` resets a retained child to `pending` and clears its error.
  Without that, a retained child that was `failed` keeps that status, the push
  loop filters on `status = 'pending'`, and the retarget is a silent partial
  no-op against it.
- The `DO UPDATE` deliberately does **not** touch `attachment_id` or
  `message_id`. Preserving them is what makes a concurrently-sent retained
  child converge: the stored ids short-circuit the next push straight to
  `sent` instead of re-posting.
- Deleting only the complement, rather than everything under `row_id`, keeps
  the retained child that step 1 just upserted.
- `AND status <> 'sent'` protects the evidence the step-3 gate reads. If the
  sweep marks a target `sent` between steps 1 and 2 — the main window pushing
  a `failed` row while a stale dashboard retargets it — an unqualified delete
  removes that `sent` child, the gate then finds nothing sent and passes, and
  the only record that a note is live on a customer's chatter is gone. That is
  exactly the outcome the gate exists to prevent.

A crash after step 1, and a step-3 flip refused by the CAS, leave the **same**
state: extra `pending` children on a row whose parent status has not changed.
That is recoverable — the orphan sweep does not touch them because the parent
exists, and the next retarget's `ON CONFLICT` absorbs them. A refused flip is
reported to the caller as a refusal; the caller re-reads. There is no separate
reconciliation step, because after step 2 the old target set no longer exists
in the database to reconcile against.

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

**And `deleteTerminalRow` must be widened in the same change**, or the row
becomes permanently undeletable. Its predicate is `status IN ('sent',
'cancelled')`, and a partially-sent parent derives `pending` or `failed` — so
with only the change above, *both* statements refuse and `deleteMeetingLog`
returns `conflict` forever. It gains:

```sql
OR EXISTS (SELECT 1 FROM meeting_log_targets
            WHERE row_id = meeting_log_queue.id AND status = 'sent')
```

The two predicates are then complementary, and `deleteMeetingLog`'s existing
try-`deleteRow`-then-`deleteTerminalRow` routing works unchanged: a
partially-sent row falls through to `deleteTerminalRow` and the honest
`deleted-after-send` copy.

### Retry and Assign tell the same lie, and get the same fix

`runAction` classifies a push by the parent alone —
`if (after.status !== "sent") return { kind: "push-failed" }` — and the page
renders "This meeting could not be sent. The error on the row says why." A
pass that lands notes on two of three customer records and fails the third
derives `pending` or `failed`, so the user is told nothing was sent while two
notes are live on two customers' chatter.

This is the same falsehood `deleteRow` was just fixed for, on a different
path. `runAction`'s post-push classification becomes target-aware — comparing
sent-target counts before and after, or reading `failedTargets` /
`sentTargets` on the re-read — with its own outcome and copy for a partial
send. No line in this feature may claim nothing reached Odoo when something
did.

### The cap is enforced in `meeting-log.action.ts`

Not in the picker, and not in `src/lib/odoo/meeting-log-actions.ts`. Those
two files differ by one hyphen and one letter and have opposite
responsibilities: `src/lib/database/meeting-log.action.ts` is the raw SQLite
layer where `insertQueueRow` and `QUEUE_SQL` live, and is what this codebase
calls "the action layer" elsewhere (see `sliceTranscript`'s doc comment).
`src/lib/odoo/meeting-log-actions.ts` is queue-page orchestration —
`retryMeetingLog`, `assignMeetingLog`, `deleteMeetingLog` — and has no
enqueue path at all, so it cannot cap target rows it never creates.

There are **three** write paths, not two, and they do not share an overflow
rule:

1. **The write to `odoo_selected_targets`** — the selection itself. Overflow
   **rejects**: the add is refused and the user is told the cap was reached.
   A user is present, the refusal is visible and immediately correctable, and
   silently dropping a target someone believes they selected is worse.
2. **The child insert at enqueue.** Overflow **caps to five and records the
   error on the row** — it does not reject. Rejecting here does not refuse a
   click; it throws into `trigger`, whose catch toasts "This meeting could not
   be queued for Odoo." and calls `skipUnwritten()`, advancing the skip
   watermark so the span is never re-sliced. A stale six-target selection
   would destroy the entire meeting rather than log five of it. The
   refusing-beats-truncating hierarchy inverts here precisely because refusal
   is the destructive option.
3. **The child insert during retarget**, which reuses the same capped helper
   as (2). AssignDialog's Confirm goes through this path, so leaving it out
   would make the dialog's cap UI-only — contradicting the rule two sections
   above that the gate belongs in the write, not in which buttons render.

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

The count has to travel the wrong way down the existing wiring, and the
mechanism must be a **push, not a pull**. `useCompletion` does not call
`useOdooTarget` — they are siblings. `<Completion />` calls `useCompletion()`
first, and only then calls `useOdooTarget({ isPickerOpen:
completion.isContactPickerOpen, … })`. The resize effect and its dependency
array live inside `useCompletion`'s body, so they can close over nothing
`useOdooTarget` returns: that value does not exist yet when `useCompletion()`
runs. Reading `targetCount` off `UseOdooTargetReturn` from inside
`useCompletion` is not something an implementer can do.

So it mirrors the idiom already in place for `isPickerOpen`:

- `useCompletion` owns a `targetCount` / `setTargetCount` state pair and adds
  `targetCount` to its own resize effect's dependencies.
- `setTargetCount` is threaded **down** into `useOdooTarget`'s params,
  alongside `setIsPickerOpen`.
- `useOdooTarget` calls it whenever the target list changes.

The alternative — moving the resize effect out of `useCompletion` into
`<Completion />`, where both values are in scope after both hooks return —
was rejected: it splits the resize logic across two files for one dependency.

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

**The archived-contact row keeps native `disabled`.** Its `disabled={!contact.active}`
is static at render time, not a side effect of another row's interaction, so
the focus-loss hazard the cap rule addresses does not arise. The two patterns
sitting in one list is a deliberate distinction — dynamic disablement uses
`aria-disabled`, static disablement uses the attribute — not an oversight.

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
`selectionToken` **for add and remove**. Re-expanding a contact whose fetch is
in flight, or already cached, starts no second request.

**Independent of adds and removes is not independent of everything.**
`handleInstanceChanged` bumps `selectionToken` precisely to supersede data from
a database the app just switched away from, and `ContactPicker` is a long-lived
`memo` component — Radix unmounts `PopoverContent`'s subtree, not the instance
holding the cache. A per-row cache with no hook into that event keeps serving
opportunities from the previous database, under contact ids that may now name
entirely different Odoo records.

The per-row primitive therefore reads a coarser **epoch** ref that
`handleInstanceChanged` and `handleNewChat` bump alongside `selectionToken`,
and a bumped epoch empties the cache. Equivalently, the disclosure cache can
live in `useOdooTarget` and be wiped in the same block that already does
`setTarget(null); targetRef.current = null;`. Either way: invalidate on
instance change, never on an add.

**The per-row error and its Retry are keyed the same way.** Today one
`opportunityError` and one `onRetryOpportunities` serve one selection. Left
shared under disclosures, one contact's failed lookup paints "Opportunities &
leads unavailable" beneath *every* expanded row, and a Retry hung off the
shared handler re-fetches whichever contact the hook last selected.

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

The mechanism is named, because `commit`'s signature
(`(next: ResolvedTarget | null, token: number)`) is built around the singleton
and its only archival path is a full clear. `commit` becomes list-accepting,
and archival removal filters `targetRef.current` down to the surviving targets
and calls it — under the same double `token !== selectionToken.current` check
`commit` already performs. A dedicated `removeTarget(model, resId, token)` with
an equivalent staleness guard is acceptable; inventing a partial-removal path
without one is not, because that race class is exactly what the existing
double-check exists for.

### The selection state is non-nullable

`useOdooTarget` holds `useState<SelectedTargets>([])`, **not**
`useState<SelectedTargets | null>(null)`.

The existing idiom derives picker props with a `??` fallback to a stable
primitive (`contactId: target?.contactId ?? null`). Ported literally, the list
version becomes `targets: target ?? []` — which allocates a brand-new array on
every render whenever there are zero targets, the steady state before anyone
picks anything. `ContactPicker` is wrapped in `memo` with the **default**
shallow comparator, so that single fallback would re-render it on every
`<Completion />` render — every streamed AI chunk — in exactly the case the
memo most needs to hold.

Starting non-nullable keeps `pickerProps.targets` referentially stable except
when a real add or remove produces a genuinely new array.

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

- **Selection state** mirrors the picker's: a `SelectedTarget[]` replacing the
  dialog's single `selected` / `leadId` pair, with the same `+ add` /
  `✓ added` rows.
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

  For that gate to be implementable at all, **`MeetingLogListRow` gains
  `targets: MeetingLogTarget[]`**, populated by the same per-target join
  `listActionableRows` already performs for the queue page. Today
  `handleAssign` is just `setAssignRow(row)` and `AssignDialogProps.row` is a
  bare `MeetingLogListRow` with no target data, so the dialog has nothing to
  test "any target sent" against. Attaching the array to the row snapshot lets
  `QueueRow`'s expansion and `AssignDialog`'s Confirm gate read the same data.

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
that would multiply the parent rows. The result is attached to
`MeetingLogListRow` as `targets`, which is also what makes AssignDialog's
Confirm gate implementable.

**`QueueRow`'s `propsAreEqual` gains a structural comparison over that list.**
That comparator is exhaustive by design — its own comment reads "EVERY PROP
THE ROW RENDERS, not just the DB columns" and warns that "a comparator
narrowed to the DB columns is worse than none". A new `targets` prop left out
of it makes the memo return `true` while a target moves `pending → failed`, so
an expanded row renders a stale per-target status permanently. Comparing it by
reference instead re-renders all 200 rows on every read, since each refresh
hands back fresh SQLite objects. The comparison is length plus per-target
`id`, `status` and `last_error` — the same shape as the existing
`sameTranscript` treatment — alongside entries for the new `onRetryTarget` and
`onRemoveTarget` callbacks.

---

## Testing

Unit and component coverage in the existing style.

**What the harness can and cannot do.** "Crash" in the bullets below means
partial execution — call the child-insert step, do not call the parent-insert
step, inspect the result — which `seed()` already supports throughout
`meeting-log.action.test.ts`. CAS-loss bullets seed the row as though a
concurrent claim already won, attempt the write, and assert zero rows
affected, exactly like the existing `markSent` / `failRow` tests. Neither needs
a harness that does not exist. The one bullet that did — `claimed_at` being
re-stamped between targets — is unprovable while `PushDeps.now` is a scalar,
which is why that is specified as an interface change in the push-loop section
rather than left here as a test note.

**Migration and backfill**

- an `unassigned` legacy row — both ids NULL — backfills to **zero** targets,
  and the migration applies cleanly
- a legacy row with `lead_id` set backfills to one `crm.lead` target; a row
  with only `contact_id` backfills to one `res.partner` target
- `attachment_id` and `message_id` carry across for an in-flight row
- the legacy singleton migrates with the **correct `model`, `res_id` and
  `name`** for both a contact-only and a lead-set singleton — including one
  with `lead_id` set and `lead_name` NULL, which must not violate a constraint.
  Asserting only that the migration does not abort is not enough
- a both-NULL legacy singleton backfills to zero rows
- `purgeOtherInstances` completes after migration 14 and deletes exactly the
  `odoo_selected_targets` rows belonging to other instances
- **Rust:** `multi_target_migration_is_version_14_and_points_at_its_own_file`
  in `migration_tests.rs`, following the three existing precedents. The two
  generic checks already cover migration 14 automatically; no others are
  needed

**Data layer**

- the four-way parent status precedence, including rule 0 (zero targets →
  `unassigned`) **and** a mixed retryable-plus-failed row deriving `pending`
  — the order the spec calls load-bearing, exercised through derivation rather
  than seeded as a fixture
- derivation refuses to run on a `cancelled`, `deleted`, `sent` or
  `unassigned` parent
- derivation from the queue page's Remove and per-target Retry succeeds on a
  `pending` or `failed` parent — the case a `sending`-only gate would have
  made impossible
- the derived write is a CAS and loses to a concurrent claim
- the parent's `last_error` / `last_error_code` mirror the determining
  target's, are chosen deterministically among targets that carry an error,
  clear when the derived status is `sent`, and are never blanked while the row
  is non-terminal
- a zero-target row is excluded from claim and from every "will be sent"
  count
- `deleteRow` refuses a row with a `sent` target, so it routes to the
  `deleted-after-send` copy
- the reassign predicate refuses a row with a `sent` target, and separately
  refuses on the base `status IN ('unassigned','failed')` CAS — two different
  conditions, two cases
- a zero-row assign CAS is surfaced to the caller, not swallowed
- Remove is refused on a `sent` target
- Remove of the last target flips the parent to `unassigned`
- enqueue ordering under a crash between the two writes
- the losing `ON CONFLICT(session_key)` trigger deletes the children it just
  inserted
- the three-step retarget under a crash after each step
- the three-step retarget with an **overlapping** target set — old `{A,B}` to
  new `{A,C}` — upserts the retained child back to `pending`, preserves its
  `attachment_id` / `message_id`, and deletes only the complement
- the retarget's delete leaves a concurrently-`sent` child in place
- the orphan sweep's age gate
- the orphan sweep leaves the children of a **still-existing** parent alone
  regardless of age, and sweeps genuinely parentless old children
- the orphan sweep runs once per process across two mounts, and still runs
  when `runMeetingLogSweep` reports it did not run — mirroring the two
  `runTranscriptPrune` tests the spec's design is copied from
- the no-transaction static scan covers every new statement
- the cap at the selection write **rejects**, and the cap at the enqueue and
  retarget child inserts **caps to five and records the error** rather than
  failing the parent insert

**Push**

- retry skips already-`sent` targets
- retry of a `failed` target actually re-attempts it — the child is reset,
  not just the parent
- a deterministic failure on target 3 of 5 does not stop targets 4 and 5
- a retryable transport failure aborts the remaining targets, leaves them
  `pending`, and records the aborting target's own error
- a local write failure after a successful wire call routes that target to
  `pending`, never `failed`, and aborts the pass
- a persistence failure on target 1 does not misclassify target 3's genuine
  Odoo fault — the flag is per target, not per push
- the adopt / reuse / short-circuit matrix across **mixed** target states in
  one push — target A short-circuiting on stored ids while target B needs an
  adopt-search
- `claimed_at` is re-stamped between targets, tracking the last completed
  target rather than the first, driven by sequential mocked clock values
- a re-stamp that affects zero rows aborts the pass
- a target marked `sent` has its error columns cleared
- a push over N contact targets stamps `last_meeting_at` for all N, and skips
  any `crm.lead` target

**UI**

- the picker's toggle behaviour, cap state, and pluralised sentence
- a backfilled NULL-name target whose id is also absent from the contact
  cache renders the generic placeholder
- a partly-failed row is grouped by `groupOf`, counted by `QUEUE_SQL.counts`,
  excluded from `countAll`'s promise, and described by `statusLine` as needing
  attention while its parent is `pending` — all four, since three surfaces
  agreeing and one disagreeing is the bug
- expanding two contacts in quick succession resolves both disclosures;
  adding a target elsewhere does not strand an open one on "Looking up…"
- a **rejected** per-row fetch does not paint under a newer, unrelated row's
  state — the reject path the existing suite tests deliberately alongside the
  resolve path
- an instance change empties the per-row disclosure cache
- a failed lookup shows its message on its own row only, and its Retry
  re-fetches that contact
- the resize effect re-fires when a target is added or removed while the
  picker is open
- a colleague's expanded row renders static text and no dead control
- an archived contact drops only its own target
- `QueueRow`'s `propsAreEqual` re-renders when a target's status changes
- AssignDialog's Confirm is unreachable on a row with a `sent` target, and an
  individual target can be added and taken back off

`assignQueueRow`'s two-id signature, its own test, and the roughly 560 lines
of AssignDialog tests built on singular-opportunity semantics are **replaced**
by list-based equivalents, not left to break during implementation. The three
proofs the originals carried are itemised above rather than left as prose: the
zero-row assign CAS is surfaced, an individual target can be added and removed,
and a still-pending row is refused.

Mutation checks where a passing test proves least:

| Mutant | Must fail |
|---|---|
| parent status precedence inverted (failed before retryable) | a mixed row stays retryable |
| rule 0 removed, so zero targets falls through to "all sent" | removing the last target marks the meeting `sent` |
| derivation gated on `status = 'sending'` alone | Remove on a `failed` parent silently does nothing |
| the retry loop stops skipping `sent` targets | retry re-posts to a sent target |
| "Retry this one" flips only the parent, not the child | the retry is a no-op against a failed target |
| the loop aborts on the first target failure | a target behind a deterministic fault is never attempted |
| a persistence failure marks the target `failed` | an attachment is stranded on a customer record with no retry path |
| the persistence flag is hoisted out of the per-target boundary | a later target's Odoo fault is misclassified as retryable |
| the backfill drops `attachment_id` / `message_id` | an upgraded in-flight row re-posts |
| the backfill loses its `contact_id IS NOT NULL OR lead_id IS NOT NULL` gate | an unassigned legacy row aborts the migration |
| the retarget insert loses its `ON CONFLICT` clause | an overlapping target set aborts the retarget |
| the retarget delete drops `AND status <> 'sent'` | a concurrently-sent child is destroyed and the gate then passes |
| the reassign gate moves from the predicate to the UI | a stale dashboard retargets a partially-sent row |
| `deleteRow` loses its `sent`-target check | a 1-sent/1-failed row deletes under "Nothing was sent to Odoo" |
| `runAction` classifies a partial send as `push-failed` | the page says nothing was sent while two notes are live |
| the derived write drops its CAS | a stale dashboard overwrites a live claim |
| `claimed_at` is stamped once per meeting | a five-target push is reclaimed mid-flight |
| the orphan sweep loses its age gate | a live enqueue's children survive |
| the orphan sweep loses its `NOT IN (SELECT id FROM meeting_log_queue)` | the children of an aged, still-queued row are deleted |
| the purge still names `odoo_selected_target` | contact sync throws "no such table" on every run |
| `targets` omitted from `QueueRow`'s comparator | an expanded row never updates |

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
