# Odoo multi-target assignment — design

**Status:** approved, not implemented
**Date:** 2026-08-28
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
Five is roughly where a meeting starts taking visibly long to send.

## Data model

Migration 14. Migrations 11, 12 and 13 are frozen — sqlx checksums applied
migrations, and a changed checksum fails `Database.load`, which is the single
gate for chat history, prompts, cost tracking and meeting context.

```sql
-- Replaces the odoo_selected_target singleton.
CREATE TABLE odoo_selected_targets (
  instance        TEXT NOT NULL,
  model           TEXT NOT NULL,      -- 'res.partner' | 'crm.lead'
  res_id          INTEGER NOT NULL,
  name            TEXT NOT NULL,
  conversation_id TEXT,
  selected_at     INTEGER NOT NULL,
  PRIMARY KEY (instance, model, res_id)
);

CREATE TABLE meeting_log_targets (
  id              TEXT NOT NULL PRIMARY KEY,
  row_id          TEXT NOT NULL,
  model           TEXT NOT NULL,
  res_id          INTEGER NOT NULL,
  name            TEXT,               -- NULL only for backfilled pre-14 rows
  status          TEXT NOT NULL DEFAULT 'pending',   -- pending | sent | failed
  attachment_id   INTEGER,
  message_id      INTEGER,
  last_error      TEXT,
  last_error_code TEXT,
  created_at      INTEGER NOT NULL,
  sent_at         INTEGER,
  UNIQUE (row_id, model, res_id)
);

CREATE INDEX idx_meeting_log_targets_row ON meeting_log_targets (row_id);
```

### Why `model` + `res_id` and not `contact_id` / `lead_id`

That pair is what the push already writes. `resId = lead_id ?? contact_id`
exists only to collapse two columns into the one value Odoo needs; storing
the resolved value deletes the coalesce and makes the table's shape identical
to the flat list in the picker.

### `name` on the target row

A `crm.lead` is not in the synced contact cache by definition, and the
in-memory list a lookup produced does not survive a `<Completion />` remount.
This is the same constraint that put `lead_name` on
`odoo_selected_target` in migration 13. Both tables carry it for the same
reason.

### No per-target `sending` status

A crash mid-target would leave a target row that is neither `pending` nor
`failed`. Nothing reclaims targets — `reclaimStaleSending` operates on the
parent — so the parent could never derive a terminal status again. The
parent's CAS claim remains the whole concurrency gate. A double execution
converges anyway: the attachment adopt-search is scoped by `res_model`,
`res_id` and name, and both ids are persisted the moment they return.

### Backfill coalesces, never fans out

A pre-14 queue row holding both `contact_id` and `lead_id` means **the lead**
today — that is what `lead_id ?? contact_id` resolves to. The backfill writes
exactly one target per legacy row: `crm.lead` if `lead_id` is set, otherwise
`res.partner`.

It carries `attachment_id` and `message_id` across, and maps status
`sent` → `sent`, `failed` → `failed`, everything else → `pending`. Dropping
those ids would make every in-flight queued meeting re-post on the next
sweep — duplicate notes and duplicate transcript files on live customer
records, for anyone who upgrades with a non-empty queue.

The old singleton row migrates by the same coalesce rule, then
`DROP TABLE odoo_selected_target`. Two sources of truth for the current
selection is a worse outcome than the drop.

`meeting_log_queue.contact_id`, `lead_id`, `attachment_id` and `message_id`
remain on disk, unwritten and unread after migration 14, documented as
pre-14 history. Rebuilding a live write-ahead queue table to reclaim four
columns is not worth the risk.

### Migration 14 is one-way

After it runs, an older build finds no `odoo_selected_targets` and has no
target table at all. Back up the database before first run on any machine
holding real queued meetings.

## Writing and pushing

### Enqueue orders its writes; it cannot use a transaction

`BEGIN`/`COMMIT` is banned in this codebase. `getDatabase()` returns a
plugin-sql handle whose every `db.execute` is an independent IPC call against
a `Pool<Sqlite>` with no JS-side connection pinning: `BEGIN` and `COMMIT` can
land on different connections, `COMMIT` throws, and the connection that ran
`BEGIN` returns to the pool holding an open write transaction — every later
write in the app gets `SQLITE_BUSY` until restart.

`QUEUE_SQL`'s header comment currently reads "Nothing here writes two rows
that must agree." Multi-target makes that false. Ordering replaces atomicity:

1. Insert the target rows. `rowId` is already a client-side `crypto.randomUUID()`,
   so the children have their foreign key before the parent exists.
2. Insert the parent queue row last.

Target rows are inert until a parent references them, and the transcript
watermark is `MAX(transcript_end_at)` over the **parent** table. A crash
between the two steps therefore leaves the meeting un-queued, the watermark
unmoved, and the next trigger re-slices the same span correctly.

On `!created` — the other trigger won the `ON CONFLICT(session_key)` race —
delete the children by `row_id`.

Crash-orphaned children are swept once at startup, **before** the meeting log
sweep, age-gated on `created_at` older than a few minutes. An ungated
`NOT IN (SELECT id FROM meeting_log_queue)` racing a live enqueue would
delete the children of a meeting about to be queued, and that meeting would
queue with zero targets.

### The push loop

The parent claim is unchanged. Summarize once; build one body and one
rendered transcript for the whole meeting.

Then, sequentially, for each target whose status is `pending`:

1. `ir.attachment.create` (preceded by the adopt-search when
   `attemptsBefore > 0`), persist `attachment_id`
2. `message_post` (preceded by its adopt-search), persist `message_id`
3. mark that target `sent`

Targets already `sent` are skipped. That skip is what makes retry
non-duplicating, and it is the reason the per-target ids must survive the
backfill.

`attachmentNameFor(row.id, transcript_start_at)` is unchanged — the
adopt-search is scoped by `res_model` and `res_id` as well as name, and those
differ per target.

### Parent status derives from its targets, in this precedence

1. any target still retryable → `pending`
2. else any target failed → `failed`
3. else all sent → `sent`

**The order is load-bearing.** Failed-wins-over-retryable would strand the
retryable target permanently: `selectSweepable` picks up only `pending` and
`held`, so nothing would ever come back for it.

A row with zero targets is treated as unassigned and never claimed.

### Undo is untouched

`startHold(rowId)` holds the parent; `cancelHeld` flips it to `cancelled`; no
target is ever claimed during the hold. One strip, one Cancel, nothing sent
to any target. A cancelled meeting stays on the queue page and can be
retargeted later.

### Reassign splits on whether anything already landed

Whole-row retarget — delete children, insert new ones, flip the parent last —
is permitted **only when no target is `sent`**. On a 2-sent/1-failed row it
would delete the only record that those two notes exist, and the next push
would post them again.

A partially-sent row gets per-target actions instead:

- **Retry this one** — flips the parent to `pending`; the loop skips the
  already-sent children.
- **Remove** — deletes that one child, then re-derives the parent status.

### The cap is enforced at the action layer

Not only in the picker. The UI can hold stale state; the insert cannot.

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
affordances are disabled carrying that reason. Disabled, not hidden — a
search box that vanishes reads as a bug.

### Rows are toggles

Every contact row, every deal row and every lead-search result gets the same
`+ add` / `✓ added` treatment. Clicking an added row removes it. One
interaction across all three sections, because under a flat list they all
produce the same kind of thing.

A target is exactly one Odoo record. Clicking a deal under a contact adds
**the deal**, as its own line — not a deal attached to that contact's line.
Wanting the note on both the person and their lead means adding both, which
is two lines and two notes. What the list shows is exactly what gets written.

### The deal lookup moves from selection-time to browse-time

Today `fetchOpportunities` fires when a contact is *selected*. That cannot
serve a list where selecting no longer means "this is the target".

A contact row gets a disclosure that fetches its leads and opportunities on
expand, keyed by contact id and cached for the popover session so
re-expanding costs nothing.

The colleague guard survives verbatim: `isColleague` still skips the lookup,
it now guards an expansion rather than a selection. This is why "a colleague
and a client at the same time" stops being a conflict — under single-target
selection, marking someone a colleague disabled the deal lookup for the
whole selection.

### Destination sentence

Pluralises, and stays exact about each record's kind:

```
1 target   "This meeting will be logged on the lead Partnership with ECS."
3 targets  "This meeting will be logged on 3 records: Christian Carron,
            the lead Partnership with ECS, and Bentley AS."
```

Vertical space is the scarce resource: this is now the third scrolling
section in a fixed 600×54 overlay that grows only through `useCompletion`'s
resize effect. Both existing lists keep their `max-h`, and the resize effect
must be re-checked against the added header.

### AssignDialog

`AssignPayload` becomes a list, and the dashboard's assign dialog gets the
same multi-select treatment. Left single-target, assigning from the dashboard
would silently collapse a queued meeting back to one record.

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

## Testing

Unit and component coverage in the existing style:

- the migration's backfill: both id shapes, and that `attachment_id` /
  `message_id` carry across
- the three-way parent status precedence
- enqueue ordering under a crash between the two writes
- the orphan sweep's age gate
- retry skipping already-sent targets
- the cap at the action layer
- the picker's toggle behaviour, cap state, and pluralised sentence

Mutation checks where a passing test proves least:

| Mutant | Must fail |
|---|---|
| parent status precedence inverted (failed before retryable) | a mixed row stays retryable |
| the retry loop stops skipping `sent` targets | retry re-posts to a sent target |
| the backfill drops `attachment_id` / `message_id` | an upgraded in-flight row re-posts |
| the orphan sweep loses its age gate | a live enqueue's children survive |

### What no local test can prove

Every failure mode this design exists to handle is an Odoo response — a
`message_post` fault on target 3 of 3, a permissions refusal, an archived
record. A mocked client returns whatever it is told to.

The live smoke test has now gone unrun on two consecutive PRs. This feature
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
