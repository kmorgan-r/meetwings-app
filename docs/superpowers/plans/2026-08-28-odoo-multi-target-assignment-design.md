# Odoo Multi-Target Assignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Log one meeting to up to five Odoo records at once — a colleague, a partner and a client — instead of the single target the app supports today.

**Architecture:** A new child table `meeting_log_targets` hangs off `meeting_log_queue`, and a new `odoo_selected_targets` set replaces the `odoo_selected_target` singleton. The push loop iterates targets, persisting per-target `attachment_id` / `message_id` so a retry never re-posts. The parent queue row keeps one derived status, computed from its children through a single CAS'd write. No transaction is available anywhere in this codebase, so write **ordering** replaces atomicity throughout.

**Tech Stack:** Tauri 2 (Rust) + sqlx migrations, SQLite via `@tauri-apps/plugin-sql`, React 19 + TypeScript strict, Vitest 4 with sql.js for the test database, Radix/shadcn UI.

**Spec:** `docs/superpowers/specs/2026-08-28-odoo-multi-target-assignment-design.md`

## Global Constraints

Copied verbatim from the spec. Every task's requirements implicitly include this section.

- **`BEGIN`/`COMMIT` is banned in this codebase.** `getDatabase()` returns a plugin-sql handle whose every `db.execute` is an independent IPC call against a `Pool<Sqlite>` with no JS-side connection pinning: `BEGIN` and `COMMIT` can land on different connections, `COMMIT` throws, and the connection that ran `BEGIN` returns to the pool holding an open write transaction — every later write in the app gets `SQLITE_BUSY` until restart. Never write one. Ordering replaces atomicity.
- **Every new SQL statement goes in `QUEUE_SQL`** (or a sibling exported object added to the scan in the same commit). `QUEUE_SQL` is exported so the static scan in `meeting-log.action.test.ts` can iterate its VALUES and reject a `BEGIN`. That scan is the only check that exists for the rule above — the sql.js harness is a single in-process connection and can never reproduce the pool bug at runtime.
- **Migrations 11, 12 and 13 are frozen.** sqlx checksums applied migrations; a changed checksum fails `Database.load`, which is the single gate for chat history, prompts, cost tracking and meeting context. Never edit an existing migration file.
- **New migration file:** `src-tauri/src/db/migrations/odoo-multi-target.sql`, registered in `src-tauri/src/db/main.rs` as **version 14** with `description: "create_multi_target_tables"`.
- **Cap: 5 targets per meeting.** Overflow **rejects** at the selection write; overflow **caps to five and records the error on the row** at the enqueue and retarget child inserts. Rejecting at enqueue throws into `trigger`, whose catch calls `skipUnwritten()` and advances the watermark, destroying the whole meeting.
- **`subtype_xmlid: "mail.mt_note"` stays pinned on every target.** If it ever flips, every customer is emailed their own transcript — now on up to five records.
- **No line in this feature may claim nothing reached Odoo when something did.** This binds `deleteRow`'s copy, `runAction`'s classification, and any new copy.
- **A `sent` target row is immutable.** No user action deletes one.
- **Migration 14 is one-way.** Back up the database before first run on any machine holding real queued meetings.
- **`MAX_TARGETS` lives in `src/lib/odoo/meeting-log.ts`**, beside
  `ESCALATE_AFTER_ATTEMPTS`, `HOLD_MS` and `STALE_CLAIM_MS`. Both action files import
  it from there. `meeting-log.action.ts` already sources every shared domain constant
  from that module and never from a sibling `database/*.action.ts`.
- **`assignQueueRow`, `deleteQueueRow` and `insertQueueRow` return `Promise<boolean>`,
  and every caller consumes them by truthiness** (`if (!(await cas())) return
  {kind:"conflict"}`). Do NOT change any of them to return a `QueryResult`: a
  `QueryResult` is always truthy, so every refused CAS would be reported as a success
  — a delete or reassign that did nothing, reported as done. That is the exact class
  of lie this feature exists to remove.
- **Before Task 1, copy the development database aside.** Migration 14 drops
  `odoo_selected_target`. Checking the branch out at an earlier commit afterwards
  leaves version 14 recorded in `_sqlx_migrations` with no matching file and the
  singleton table gone — this repo has already hit checksum-drift breakage of exactly
  that shape. Recovery is "restore the copy and re-run". **Never edit
  `odoo-multi-target.sql` after it has been applied locally.**
- **Verify every existing signature against source before you write a call to it.**
  Two review rounds on this plan found the same failure repeatedly: snippets reproducing
  an *existing* API from memory got binding orders, return types and parameter counts
  wrong, while snippets checked against source were right. Before using any function,
  `QUEUE_SQL` key, or column list this plan did not itself create, open the file and read
  it. Where a code block below calls existing code, treat it as **intent plus the exact
  file and symbol to read** — the surrounding prose and the tests are the contract, not
  the transcription. Newly invented code (the migration SQL, the push loop's structure)
  is verbatim and has been reviewed as such.
- **Live Odoo failure legs are manufactured locally only** — kill the app, drop the network, target an archived record. Never by sending bad credentials: fail2ban on the Odoo host is `maxretry 10 / findtime 600 / bantime 3600`. Unban: `sudo fail2ban-client set odoo-login unbanip <ip>`.

## Slice boundary

**Tasks 1–9 compile and pass their tests at every commit, and preserve today's
behaviour.** They move the app onto the new schema and the per-target machinery while
every meeting still resolves to exactly one target — the backfill writes at most one
child per row, and Task 6 adapts the picker's still-singular selection at the call
site. They carry *all* the database risk.

They are deliberately **not** described as shippable: `ResolvedTarget` and the
singular `targetRef` survive until Task 14, so the UI is mid-migration until then.
"Compiles and passes tests" is the property each task boundary actually guarantees,
and it is the one the gates check.

**Tasks 10–14 are the UI** that lets a user pick more than one; they add no migration
risk. If execution needs a checkpoint, take it after Task 9.

### Keeping the tree green between tasks

Signature changes are kept in the same task as their call sites. Where that is
impossible, the plan says exactly how the gap is bridged:

| Break | Bridge |
|---|---|
| `assignQueueRow(id, targets)` (Task 7) vs `assignMeetingLog` | Task 7 updates the caller in-task; the file is in its Files list |
| `saveTarget` / `loadTarget` removed (Task 4) vs `useOdooTarget` (Task 11) | Task 4 **keeps** both. They are runtime-dead once migration 14 drops the table, but they compile and their pre-14 tests pass. Deleted in Task 11 |
| `NewQueueRow` loses `contactId`/`leadId` (Task 6) vs `targetRef: ResolvedTarget \| null` (until Task 14) | Task 6 adapts at the call site: `target ? [resolvedToSelected(target)] : []`. Three lines, single-target behaviour identical, deleted in Task 14 |
| `groupOf` / `statusLine` gain `failedTargets` (Task 8) vs their callers (Tasks 13, 14) | The parameter is **optional, defaulting to 0**. Real wiring lands in Tasks 13 and 14 |
| `ResolvedTarget` deletion | **Task 14**, not Task 11 — Tasks 12 and 14 still consume it |

## File Structure

**Create**

| File | Responsibility |
|---|---|
| `src-tauri/src/db/migrations/odoo-multi-target.sql` | Migration 14: both new tables, both backfills, the drop |

**Modify**

| File | Change |
|---|---|
| `src-tauri/src/db/main.rs` | Register migration 14 |
| `src-tauri/src/db/migration_tests.rs` | Pin test for migration 14 |
| `src/types/odoo.ts` | `SelectedTarget`, `SelectedTargets`, `MeetingLogTarget`; `MeetingLogListRow.targets`; delete `ResolvedTarget` |
| `src/lib/database/meeting-log.action.ts` | New `QUEUE_SQL` keys, derivation, predicates, the join, cap, `NewQueueRow` |
| `src/lib/database/odoo-contacts.action.ts` | Selection set read/write, `purgeOtherInstances` repoint |
| `src/lib/odoo/meeting-log-push.ts` | Per-target loop, `PushDeps.now`, per-target persist, claim re-stamp |
| `src/lib/odoo/meeting-log.ts` | `groupOf`, `SUMMARIZE_TIMEOUT_MS` comment |
| `src/lib/odoo/meeting-log-actions.ts` | `runAction` partial send, retry, remove |
| `src/hooks/useMeetingLog.ts` | Enqueue ordering, orphan sweep |
| `src/hooks/useOdooTarget.ts` | List state, epoch cache, per-row disclosure, per-target archival, `targetCount` |
| `src/hooks/useCompletion.ts` | Resize effect dependency |
| `src/pages/app/components/completion/ContactPicker.tsx` | "Logging to", toggles, disclosure |
| `src/pages/meeting-log/components/QueueRow.tsx` | Per-target expansion, `propsAreEqual`, `statusLine` |
| `src/pages/meeting-log/components/AssignDialog.tsx` | Multi-select, Confirm gate |
| `src/pages/meeting-log/index.tsx` | `handleAssign`, per-target handlers |

---

### Task 1: Migration 14 and the row types

**Files:**
- Create: `src-tauri/src/db/migrations/odoo-multi-target.sql`
- Modify: `src-tauri/src/db/main.rs`
- Modify: `src-tauri/src/db/migration_tests.rs`
- Modify: `src/types/odoo.ts`
- Test: `src-tauri/src/db/migration_tests.rs`, `src/tests/meeting-log.action.test.ts`

**Interfaces:**
- Produces: migration version 14, `description: "create_multi_target_tables"`; tables `odoo_selected_targets` and `meeting_log_targets`; TS types `SelectedTarget`, `SelectedTargets`, `MeetingLogTarget`.
- Consumes: nothing.

Read `src-tauri/src/db/main.rs` lines 76–97 and `src-tauri/src/db/migration_tests.rs` lines 21–102 before starting. The three existing pin tests are the pattern to copy.

- [ ] **Step 1: Write the failing Rust pin test**

Append to `src-tauri/src/db/migration_tests.rs`, following `lead_only_target_migration_is_version_13_and_points_at_its_own_file`:

```rust
#[test]
fn multi_target_migration_is_version_14_and_points_at_its_own_file() {
    let all = migrations();
    let m = all
        .iter()
        .find(|m| m.description == "create_multi_target_tables")
        .expect("multi target migration must be registered");
    assert_eq!(m.version, 14, "multi target migration must be version 14");
    assert_eq!(
        m.sql,
        include_str!("migrations/odoo-multi-target.sql"),
        "multi target migration must embed migrations/odoo-multi-target.sql"
    );
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd src-tauri && cargo test multi_target_migration`
Expected: FAIL — `multi target migration must be registered` (the migration does not exist yet).

- [ ] **Step 3: Write the migration SQL**

Create `src-tauri/src/db/migrations/odoo-multi-target.sql`:

```sql
-- Odoo multi-target assignment (migration 14).
--
-- NEVER EDIT THIS FILE AFTER RELEASE. sqlx checksums applied migrations; a
-- changed checksum fails Database.load, which is the single gate for chat
-- history, prompts, cost tracking and meeting context - the whole app's
-- persistence, not just this feature.
--
-- Replaces the odoo_selected_target singleton with a set, and gives each
-- queued meeting a child row per Odoo record it must reach.

CREATE TABLE IF NOT EXISTS odoo_selected_targets (
  instance        TEXT NOT NULL,
  model           TEXT NOT NULL,      -- 'res.partner' | 'crm.lead'
  res_id          INTEGER NOT NULL,
  name            TEXT,
  conversation_id TEXT,
  selected_at     INTEGER NOT NULL,
  PRIMARY KEY (instance, model, res_id)
);

CREATE TABLE IF NOT EXISTS meeting_log_targets (
  id              TEXT NOT NULL PRIMARY KEY,
  row_id          TEXT NOT NULL,
  model           TEXT NOT NULL,
  res_id          INTEGER NOT NULL,
  name            TEXT,
  status          TEXT NOT NULL DEFAULT 'pending',   -- pending | sent | failed
  attachment_id   INTEGER,
  message_id      INTEGER,
  last_error      TEXT,
  last_error_code TEXT,
  created_at      INTEGER NOT NULL,
  sent_at         INTEGER,
  UNIQUE (row_id, model, res_id)
);

-- No separate index on row_id: UNIQUE (row_id, model, res_id) already creates
-- one with row_id leftmost, which serves every WHERE row_id = ? lookup.

-- Backfill the queue. A row with NEITHER id set is an unassigned meeting and
-- produces NO target - sending it down the res.partner branch would write
-- res_id = NULL against NOT NULL and abort the whole migration.
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

-- Migrate the singleton by the same coalesce rule and the same gate. A
-- both-NULL singleton cannot be written by this app, but loadTarget already
-- guards against reading one back, so the gate costs one clause and the
-- absence of it costs Database.load.
INSERT OR IGNORE INTO odoo_selected_targets (instance, model, res_id, name,
                                             conversation_id, selected_at)
SELECT instance,
       CASE WHEN lead_id IS NOT NULL THEN 'crm.lead' ELSE 'res.partner' END,
       COALESCE(lead_id, contact_id),
       CASE WHEN lead_id IS NOT NULL THEN lead_name ELSE NULL END,
       conversation_id,
       selected_at
  FROM odoo_selected_target
 WHERE contact_id IS NOT NULL OR lead_id IS NOT NULL;

DROP TABLE IF EXISTS odoo_selected_target;
```

- [ ] **Step 4: Register it**

In `src-tauri/src/db/main.rs`, append to the `migrations()` vec after the version-13 entry, matching the surrounding style exactly:

```rust
Migration {
    version: 14,
    description: "create_multi_target_tables",
    sql: include_str!("migrations/odoo-multi-target.sql"),
    kind: MigrationKind::Up,
},
```

- [ ] **Step 5: Run the Rust tests**

Run: `cd src-tauri && cargo test --lib db::migration_tests`
Expected: PASS, including `every_migration_file_is_registered` and `migration_versions_are_unique_and_monotonic`, which now cover migration 14 automatically.

- [ ] **Step 6: Add the TypeScript row types**

In `src/types/odoo.ts`, add beside the existing types (unprefixed, matching every other type in that file):

```ts
export interface SelectedTarget {
  model: "res.partner" | "crm.lead";
  resId: number;
  name: string | null;
}

export type SelectedTargets = SelectedTarget[];

export type MeetingLogTargetStatus = "pending" | "sent" | "failed";

export interface MeetingLogTarget {
  id: string;
  rowId: string;
  model: "res.partner" | "crm.lead";
  resId: number;
  name: string | null;
  status: MeetingLogTargetStatus;
  attachmentId: number | null;
  messageId: number | null;
  lastError: string | null;
  lastErrorCode: string | null;
  createdAt: number;
  sentAt: number | null;
}
```

Do **not** delete `ResolvedTarget` yet — **Task 14** removes it, once its last consumer is gone. Deleting it here breaks every consumer before its replacement is wired.

- [ ] **Step 7: Run the type check**

Run: `npm run check:types`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src-tauri/src/db/migrations/odoo-multi-target.sql src-tauri/src/db/main.rs src-tauri/src/db/migration_tests.rs src/types/odoo.ts
git commit -m "feat(odoo): add migration 14 for multi-target assignment"
```

---

### Task 2: The migration's backfill, proven against every legacy row shape

**Files:**
- Test: `src/tests/meeting-log.action.test.ts`

**Interfaces:**
- Consumes: migration 14's SQL from Task 1.
- Produces: nothing new; this task proves Task 1.

This is its own task because the backfill is a one-way data migration over live user data, and the row shapes it must survive are the difference between a working upgrade and a permanently failing `Database.load`.

**Three harness facts you must handle before any test here runs.** Three separate reviewers hit these from different angles:

1. **The suite's shared `beforeEach` applies migrations only through version 12** (`odoo-contacts.sql`, `meeting-log-queue.sql`). It never runs `odoo-lead-only-target.sql`. Migration 14's singleton backfill reads `lead_name`, which only exists after migration 13, and needs `contact_id` nullable — also a migration-13 change, since migration 11 declares it `NOT NULL`. `seedPre14` must run migration 13 itself, or the first singleton test dies with `no such column: lead_name`.
2. **The existing `seed()` helper applies no migrations at all** — it only inserts into already-existing tables. Do not model `seedPre14` on it for schema; model it on the `beforeEach` that loads migration files.
3. **Four test files each build their own sql.js database, and all four need migration 14.** `meeting-log.action.test.ts`, `odoo-contacts.action.test.ts` (Task 4), `odoo-meeting-log-push.test.ts` (Task 9) and `meeting-log-actions.test.ts` (Task 10) each carry an independent `beforeEach` that loads migration files. Adding migration 14 to one does nothing for the others, and every `seedTargets` / `meeting_log_targets` / `odoo_selected_targets` call in those files fails on a missing table.

   **The subtler half is worse.** Every *existing, unmodified* test in `odoo-meeting-log-push.test.ts` seeds through `seedRow`'s legacy `contact_id` / `lead_id` columns. Under the new schema those rows have **zero targets**, so Task 9's pre-claim check returns before any wire call and **the entire existing suite in that file silently goes green while testing nothing.** Each of Tasks 4, 9 and 10 carries an explicit step: load `odoo-multi-target.sql` in that file's `beforeEach`, and give every pre-existing fixture a `seedTargets(...)` call.

4. **The helpers must be importable, because Step 6 splits the tests across two files.** `applyMigration14`, `seedPre14`, `seedPre14Singleton`, `readMigration` and `MIGRATIONS` go in a small shared module — `src/tests/helpers/migration-14.ts` — that both `meeting-log.action.test.ts` and `odoo-contacts.action.test.ts` import. Declared as unexported top-level consts in one test file, the moved tests do not compile.

- [ ] **Step 1: Write the failing tests**

Add to `src/tests/meeting-log.action.test.ts`, in a new `describe("migration 14 backfill")`:

```ts
it("backfills an unassigned legacy row to zero targets", async () => {
  const db = await seedPre14([
    { id: "r1", contact_id: null, lead_id: null, status: "unassigned" },
  ]);
  await applyMigration14(db);
  expect(rows(db, "SELECT * FROM meeting_log_targets")).toHaveLength(0);
});

it("backfills a lead row to one crm.lead target", async () => {
  const db = await seedPre14([
    { id: "r1", contact_id: 7, lead_id: 90, status: "pending" },
  ]);
  await applyMigration14(db);
  const t = rows(db, "SELECT * FROM meeting_log_targets");
  expect(t).toHaveLength(1);
  expect(t[0]).toMatchObject({ row_id: "r1", model: "crm.lead", res_id: 90 });
});

it("backfills a contact-only row to one res.partner target", async () => {
  const db = await seedPre14([
    { id: "r1", contact_id: 7, lead_id: null, status: "pending" },
  ]);
  await applyMigration14(db);
  const t = rows(db, "SELECT * FROM meeting_log_targets");
  expect(t[0]).toMatchObject({ model: "res.partner", res_id: 7 });
});

it("carries attachment_id and message_id across for an in-flight row", async () => {
  const db = await seedPre14([
    { id: "r1", contact_id: 7, lead_id: null, status: "sending",
      attachment_id: 111, message_id: 222 },
  ]);
  await applyMigration14(db);
  const t = rows(db, "SELECT * FROM meeting_log_targets")[0];
  expect(t).toMatchObject({ attachment_id: 111, message_id: 222, status: "pending" });
});

it("maps sent to sent and failed to failed, everything else to pending", async () => {
  const db = await seedPre14([
    { id: "a", contact_id: 1, lead_id: null, status: "sent" },
    { id: "b", contact_id: 2, lead_id: null, status: "failed" },
    { id: "c", contact_id: 3, lead_id: null, status: "held" },
  ]);
  await applyMigration14(db);
  const byRow = Object.fromEntries(
    rows(db, "SELECT row_id, status FROM meeting_log_targets").map((r) => [r.row_id, r.status]),
  );
  expect(byRow).toEqual({ a: "sent", b: "failed", c: "pending" });
});

it("migrates a lead singleton whose lead_name migration 13 left NULL", async () => {
  const db = await seedPre14Singleton({
    instance: "i1", contact_id: 7, lead_id: 90, lead_name: null,
  });
  await applyMigration14(db);
  const s = rows(db, "SELECT * FROM odoo_selected_targets");
  expect(s).toHaveLength(1);
  expect(s[0]).toMatchObject({ model: "crm.lead", res_id: 90, name: null });
});

it("migrates a contact-only singleton with a null name", async () => {
  const db = await seedPre14Singleton({
    instance: "i1", contact_id: 7, lead_id: null, lead_name: null,
  });
  await applyMigration14(db);
  expect(rows(db, "SELECT * FROM odoo_selected_targets")[0]).toMatchObject({
    model: "res.partner", res_id: 7, name: null,
  });
});

it("backfills a both-NULL singleton to zero rows", async () => {
  // The spec requires this case explicitly. It cannot be produced by saveTarget,
  // but loadTarget already guards against reading one back, and the cost of the
  // guard is one WHERE clause against a permanently failing Database.load.
  const db = await seedPre14Singleton({
    instance: "i1", contact_id: null, lead_id: null, lead_name: null,
  });
  await applyMigration14(db);
  expect(rows(db, "SELECT * FROM odoo_selected_targets")).toHaveLength(0);
});

it("drops the singleton table", async () => {
  const db = await seedPre14([]);
  await applyMigration14(db);
  expect(() => db.exec("SELECT 1 FROM odoo_selected_target")).toThrow();
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/tests/meeting-log.action.test.ts -t "migration 14 backfill"`
Expected: FAIL — the `seedPre14` / `applyMigration14` helpers do not exist.

- [ ] **Step 3: Write the helpers**

Add to the same file, above the `describe`. `applyMigration14` reads the real migration file so the test can never drift from what ships:

```ts
import { readFileSync } from "node:fs";
import path from "node:path";

// Use the file's existing MIGRATIONS constant, not a bare relative path - every
// other migration load here goes through it, and a bare path is cwd-fragile.
const readMigration = (name: string) =>
  readFileSync(path.join(MIGRATIONS, name), "utf8");

function applyMigration14(db: Database) {
  db.exec(readMigration("odoo-multi-target.sql"));
}

// Migrations 11 and 12 come from the shared beforeEach. Migration 13 does NOT -
// and migration 14's singleton backfill reads lead_name, which only 13 creates.
function seedPre14(queueRows: PreQueueRow[]): Database {
  const db = freshDb();                       // beforeEach: migrations 11 and 12
  db.exec(readMigration("odoo-lead-only-target.sql"));   // migration 13
  for (const r of queueRows) insertPreQueueRow(db, r);
  return db;
}

function seedPre14Singleton(row: PreSingletonRow): Database {
  const db = seedPre14([]);
  db.run(
    `INSERT INTO odoo_selected_target
       (id, instance, contact_id, lead_id, lead_name, conversation_id, selected_at)
     VALUES ('current', ?, ?, ?, ?, NULL, 0)`,
    [row.instance, row.contact_id, row.lead_id, row.lead_name],
  );
  return db;
}
```

`insertPreQueueRow` is a raw INSERT into `meeting_log_queue` in the pre-14 shape — the same style as the file's existing `seed()` helper, which inserts into already-existing tables and applies no migrations of its own.

- [ ] **Step 4: Run them to verify they pass**

Run: `npx vitest run src/tests/meeting-log.action.test.ts -t "migration 14 backfill"`
Expected: PASS, all eight.

- [ ] **Step 5: Apply the mutants and confirm each test dies**

Temporarily edit the migration and re-run after each:

| Mutant | Must fail |
|---|---|
| remove `WHERE contact_id IS NOT NULL OR lead_id IS NOT NULL` from the queue backfill | the unassigned-row test — a NOT NULL violation |
| drop `attachment_id, message_id` from the SELECT list | the in-flight carry-across test |
| remove the same `WHERE` from the singleton copy | **the both-NULL singleton test** — not the contact-only one, whose `contact_id: 7` fixture never triggers a NOT NULL violation and would survive this mutant |

Revert every mutant before committing.

- [ ] **Step 6: Put the singleton tests in the right file**

The three `odoo_selected_target(s)` tests — both named singletons and the
both-NULL one — belong in `src/tests/odoo-contacts.action.test.ts`, which already
owns that table and has `describe("the migration")` and
`describe("the selected target")` blocks for it. Only the `meeting_log_targets`
backfill tests stay in `meeting-log.action.test.ts`. Splitting them here keeps the
codebase's one-file-per-action-module convention, and puts them in the file Task 4
edits next.

- [ ] **Step 7: Commit**

```bash
git add src/tests/meeting-log.action.test.ts src/tests/odoo-contacts.action.test.ts
git commit -m "test(odoo): prove migration 14's backfill against every legacy row shape"
```
---

### Task 3: The target statements, inside `QUEUE_SQL`

**Files:**
- Modify: `src/lib/database/meeting-log.action.ts`
- Test: `src/tests/meeting-log.action.test.ts`

**Interfaces:**
- Consumes: `MeetingLogTarget` from Task 1.
- Produces: `QUEUE_SQL.insertTarget`, `.deleteTargetsByRow`, `.targetsByRow`, `.sweepOrphanTargets`, `.targetToPending`, `.targetToFailed`, `.targetToSent`, `.setTargetAttachment`, `.setTargetMessage`; and `listTargets(rowId: string): Promise<MeetingLogTarget[]>`.

Read `QUEUE_SQL`'s header comment and `reclaimBase`'s comment first. `QUEUE_SQL` is exported **so the static scan can iterate its VALUES**; a statement written inline in an action function escapes the only guard that exists for the no-transaction rule.

**Do the test-harness refactor in this task, before anything else.** The
`vi.mock("@/lib/database/config", …)` factory currently builds a brand-new
`{ execute, select }` closure pair on *every* `getDatabase()` call, so there is no
stable object for `vi.spyOn()` to attach to. Tasks 6 and 8 both need to observe
statement order and count — Task 6's "children before the parent" test is the only
thing proving the feature's core no-transaction safety argument, and it cannot be
written against the current mock.

Hoist them to module level, the way the sibling suite's `failNextWrite` is already a
module-level hoisted mutable the mock checks:

**Use `vi.hoisted`.** `vi.mock` is hoisted above every top-level statement, so a factory
closing over a plain `const` reads a binding still in TDZ and the file throws
`ReferenceError: Cannot access 'execute' before initialization` on import, before any test
runs. This is the same gotcha `odoo-meeting-log-push.test.ts` already works around with
`const { failNextWrite } = vi.hoisted(() => ({ failNextWrite: { value: null } }))`.

```ts
const { execute, select } = vi.hoisted(() => ({
  execute: vi.fn(),
  select: vi.fn(),
}));
vi.mock("@/lib/database/config", () => ({
  getDatabase: async () => ({ execute, select }),
}));

// In beforeEach, after the sql.js db exists:
execute.mockImplementation(async (sql: string, args?: unknown[]) => rawExecute(sql, args));
select.mockImplementation(async (sql: string, args?: unknown[]) => rawSelect(sql, args));

// The order spy must actually invoke the callback, or Task 6's "children before
// the parent" test - the only proof of the core no-transaction argument - sees
// an empty array and its mutant is unkillable either way.
const spyOnExecute = (fn: (sql: string) => void) => {
  execute.mockImplementation(async (sql: string, args?: unknown[]) => {
    fn(sql);
    return rawExecute(sql, args);
  });
};
```

`rawExecute` and `rawSelect` are the only names for these — tests call them directly for
fixture setup. There is no `rawExec`.

`seedTargets`, used from this task onward, is a **raw test-only INSERT** into
`meeting_log_targets`, parallel to `seed()`. It must not be built on
`QUEUE_SQL.insertTarget`: that statement hardcodes `status = 'pending'` in its
`ON CONFLICT` and cannot set `attachmentId`, `messageId`, `lastError` or
`lastErrorCode` — which nearly every fixture in this plan needs.

- [ ] **Step 1: Write the failing test**

Extend the existing `describe("no JS transactions")` block in `src/tests/meeting-log.action.test.ts` so it also asserts the new keys exist and are covered:

```ts
it("keeps every target statement inside QUEUE_SQL where the scan can see it", () => {
  const required = [
    "insertTarget", "deleteTargetsByRow", "targetsByRow", "sweepOrphanTargets",
    "targetToPending", "targetToFailed", "targetToSent",
    "setTargetAttachment", "setTargetMessage",
  ];
  for (const key of required) {
    expect(QUEUE_SQL, `QUEUE_SQL is missing ${key}`).toHaveProperty(key);
  }
});
```

The existing scan over `Object.entries(QUEUE_SQL)` then covers them for free.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/tests/meeting-log.action.test.ts -t "no JS transactions"`
Expected: FAIL — `QUEUE_SQL is missing insertTarget`.

- [ ] **Step 3: Add the statements**

In `src/lib/database/meeting-log.action.ts`, add to `QUEUE_SQL`. Update its header comment first — it currently claims "Nothing here writes two rows that must agree", which multi-target makes false:

```ts
  // Children of a queue row. Ordering replaces atomicity: these are written
  // BEFORE the parent, because the watermark reads the parent table and a
  // child without a parent is inert.
  insertTarget: `INSERT INTO meeting_log_targets
      (id, row_id, model, res_id, name, status, created_at)
    VALUES (?, ?, ?, ?, ?, 'pending', ?)
    ON CONFLICT(row_id, model, res_id) DO UPDATE SET
      status = 'pending', last_error = NULL, last_error_code = NULL
    WHERE meeting_log_targets.status <> 'sent'`,

  deleteTargetsByRow: `DELETE FROM meeting_log_targets WHERE row_id = ?`,

  targetsByRow: `SELECT * FROM meeting_log_targets
    WHERE row_id = ? ORDER BY created_at, id`,

  // Orphans only. The NOT IN half is as load-bearing as the age gate: a
  // cancelled row's children are NOT orphans, because the parent still exists.
  sweepOrphanTargets: `DELETE FROM meeting_log_targets
    WHERE created_at < ?
      AND row_id NOT IN (SELECT id FROM meeting_log_queue)`,

  // Parameter order is (code, text, id), matching the parent toPending/toFailed
  // these are named to mirror. Do NOT reverse it: two statements with mirrored
  // names and reversed parameters is swap-bait, and a swap silently puts
  // ODOO_FAULT into the user-visible message field.
  // `AND status <> 'sent'` on BOTH. Without it a stale dashboard's Retry - or the
  // push's own record() after a stolen claim - flips a sent target back to
  // pending. No duplicate note results (message_id is still stored), but
  // deleteRow's `NOT EXISTS (... status='sent')` gate then PASSES, and the user
  // deletes the row under "Nothing was sent to Odoo." while a note is live on a
  // customer's chatter. Also the Global Constraint: a sent target is immutable.
  targetToPending: `UPDATE meeting_log_targets
    SET status = 'pending', last_error_code = ?, last_error = ?
    WHERE id = ? AND status <> 'sent'`,
  targetToFailed: `UPDATE meeting_log_targets
    SET status = 'failed', last_error_code = ?, last_error = ?
    WHERE id = ? AND status <> 'sent'`,
  // Clearing the error columns matters: a stale error rendered beside a green
  // sent target reads as a fresh failure.
  targetToSent: `UPDATE meeting_log_targets
    SET status = 'sent', sent_at = ?, last_error = NULL, last_error_code = NULL
    WHERE id = ?`,

  setTargetAttachment: `UPDATE meeting_log_targets SET attachment_id = ? WHERE id = ?`,
  setTargetMessage: `UPDATE meeting_log_targets SET message_id = ? WHERE id = ?`,
```

The `ON CONFLICT` clause on `insertTarget` deliberately does **not** touch `attachment_id` or `message_id`. Preserving them is what lets a retained child converge on the next push instead of re-posting.

- [ ] **Step 4: Add the reader**

```ts
export async function listTargets(rowId: string): Promise<MeetingLogTarget[]> {
  const db = await getDatabase();
  const rows = await db.select<Record<string, unknown>[]>(QUEUE_SQL.targetsByRow, [rowId]);
  return rows.map(toMeetingLogTarget);
}
```

Write `toMeetingLogTarget` beside the file's existing row mappers, mapping snake_case columns to the camelCase `MeetingLogTarget` fields from Task 1.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run src/tests/meeting-log.action.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/database/meeting-log.action.ts src/tests/meeting-log.action.test.ts
git commit -m "feat(odoo): add the meeting-log target statements to QUEUE_SQL"
```

---

### Task 4: The selection set, its cap, and the instance purge

**Files:**
- Modify: `src/lib/database/odoo-contacts.action.ts`
- Test: `src/tests/odoo-contacts.action.test.ts`

**Interfaces:**
- Consumes: `SelectedTarget`, `SelectedTargets` from Task 1.
- Produces: `loadTargets(instance: string): Promise<SelectedTargets>`, `addSelectedTarget(instance: string, t: SelectedTarget, conversationId: string | null, at: number): Promise<{ ok: boolean; reason?: "cap" }>`, `removeSelectedTarget(instance: string, model: string, resId: number): Promise<void>`, `clearTargets(instance: string): Promise<void>`. `purgeOtherInstances` keeps its signature. `saveTarget` and `loadTarget` are **kept** (see below).

**Names matter here.** `src/lib/index.ts` star-exports this module and `./odoo` into one flat `@/lib` namespace, so a bare `removeTarget` would collide with Task 10's queue-target remover. Hence `addSelectedTarget` / `removeSelectedTarget` in this file and `removeQueueTarget` in `meeting-log-actions.ts`.

**Do not delete `saveTarget` or `loadTarget` in this task.** They become runtime-dead the moment migration 14 drops their table, but they still compile and their pre-14 tests still pass, and `useOdooTarget` consumes them until Task 11. Deleting them here breaks the build for seven tasks.

`purgeOtherInstances` currently ends with `DELETE FROM odoo_selected_target WHERE instance <> ?` and runs on **every** contact sync. Migration 14 dropped that table. Left unchanged, every sync throws "no such table" after it has already purged `odoo_contacts` and `odoo_sync_state` — contact sync breaks permanently, for every user.

- [ ] **Step 1: Write the failing tests**

```ts
describe("selected targets", () => {
  it("purges other instances from the new table", async () => {
    await addSelectedTarget("i1", { model: "res.partner", resId: 1, name: "A" }, null, 100);
    await addSelectedTarget("i2", { model: "res.partner", resId: 2, name: "B" }, null, 100);
    await purgeOtherInstances("i1");
    expect(await loadTargets("i1")).toHaveLength(1);
    expect(await loadTargets("i2")).toHaveLength(0);
  });

  it("rejects a sixth target instead of truncating", async () => {
    for (let i = 1; i <= 5; i++) {
      const r = await addSelectedTarget("i1", { model: "res.partner", resId: i, name: `C${i}` }, null, 100);
      expect(r.ok).toBe(true);
    }
    const sixth = await addSelectedTarget("i1", { model: "res.partner", resId: 6, name: "C6" }, null, 100);
    expect(sixth).toEqual({ ok: false, reason: "cap" });
    expect(await loadTargets("i1")).toHaveLength(5);
  });

  it("re-adding an existing target is not a new target", async () => {
    for (let i = 1; i <= 5; i++) {
      await addSelectedTarget("i1", { model: "res.partner", resId: i, name: `C${i}` }, null, 100);
    }
    const again = await addSelectedTarget("i1", { model: "res.partner", resId: 3, name: "C3" }, null, 200);
    expect(again.ok).toBe(true);
    expect(await loadTargets("i1")).toHaveLength(5);
  });

  it("removes one target and leaves the rest", async () => {
    await addSelectedTarget("i1", { model: "res.partner", resId: 1, name: "A" }, null, 100);
    await addSelectedTarget("i1", { model: "crm.lead", resId: 9, name: "L" }, null, 100);
    await removeSelectedTarget("i1", "res.partner", 1);
    expect(await loadTargets("i1")).toEqual([
      { model: "crm.lead", resId: 9, name: "L" },
    ]);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/tests/odoo-contacts.action.test.ts -t "selected targets"`
Expected: FAIL — `addSelectedTarget is not a function`.

- [ ] **Step 3: Implement**

**Add** the set operations beside `saveTarget` / `loadTarget`, which stay until Task 11 — deleting them here breaks `useOdooTarget` for seven tasks. The cap check reads the current count and refuses; the `INSERT … ON CONFLICT DO UPDATE` means re-adding an existing target updates it rather than counting against the cap:

`MAX_TARGETS` is **imported from `src/lib/odoo/meeting-log.ts`**, where it sits beside `ESCALATE_AFTER_ATTEMPTS` and `STALE_CLAIM_MS`. Do not define it here: `meeting-log.action.ts` (Tasks 6 and 7) also needs it, and that file sources every shared domain constant from `meeting-log.ts`, never from a sibling `database/*.action.ts`.

```ts
import { MAX_TARGETS } from "@/lib/odoo/meeting-log";

export async function addSelectedTarget(
  instance: string,
  t: SelectedTarget,
  conversationId: string | null,
  at: number,
): Promise<{ ok: boolean; reason?: "cap" }> {
  const db = await getDatabase();
  const existing = await db.select<{ n: number }[]>(
    `SELECT COUNT(*) AS n FROM odoo_selected_targets
      WHERE instance = ? AND NOT (model = ? AND res_id = ?)`,
    [instance, t.model, t.resId],
  );
  if ((existing[0]?.n ?? 0) >= MAX_TARGETS) return { ok: false, reason: "cap" };
  await db.execute(
    `INSERT INTO odoo_selected_targets
       (instance, model, res_id, name, conversation_id, selected_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(instance, model, res_id) DO UPDATE SET
       name = excluded.name,
       conversation_id = excluded.conversation_id,
       selected_at = excluded.selected_at`,
    [instance, t.model, t.resId, t.name, conversationId, at],
  );
  return { ok: true };
}
```

Write `loadTargets`, `removeSelectedTarget` and `clearTargets` in the same style. In `purgeOtherInstances`, change the final statement's table name to `odoo_selected_targets` — the new table carries `instance`, so it is a one-word substitution.

- [ ] **Step 4: Run them to verify they pass**

Run: `npx vitest run src/tests/odoo-contacts.action.test.ts`
Expected: PASS.

- [ ] **Step 5: Apply the mutant**

Revert `purgeOtherInstances` to name `odoo_selected_target`. The purge test must fail with a "no such table" error. Revert the mutant.

- [ ] **Step 6: Commit**

```bash
git add src/lib/database/odoo-contacts.action.ts src/tests/odoo-contacts.action.test.ts
git commit -m "feat(odoo): store the selection as a capped set, and repoint the instance purge"
```

---

### Task 5: Parent status derivation — one CAS'd mechanism, two callers

**Files:**
- Modify: `src/lib/database/meeting-log.action.ts`
- Test: `src/tests/meeting-log.action.test.ts`

**Interfaces:**
- Consumes: `listTargets` and the target statements from Task 3.
- Produces: `deriveRowStatus(rowId: string, observedStatus: MeetingLogStatus, now: number): Promise<{ changed: boolean; status: MeetingLogStatus }>`. **Three parameters** — the timestamp is injected so the push can pass `deps.now()` and tests can drive it. Task 9 and Task 10 both call it with three.

The precedence, in order — **rule 0 first, and the 1-before-2 order load-bearing**:

0. zero targets → `unassigned`
1. any target still retryable → `pending`
2. else any target failed → `failed`
3. else all sent → `sent`

Rule 0 exists because "all sent" is vacuously true of an empty set. The 1-before-2 order exists because `selectSweepable` picks up only `pending` and `held`, so failed-wins would strand a retryable target forever.

Derivation **refuses** to run on a parent in `cancelled`, `deleted`, `sent` or `unassigned`. It is stated as an exclusion list, **not** as "only from `sending`" — Remove and Retry act on a `pending` or `failed` parent, so a `sending`-only gate would match zero rows by construction.

- [ ] **Step 1: Write the failing tests**

```ts
describe("deriveRowStatus", () => {
  it("derives unassigned when the row has no targets", async () => {
    await seedRow({ id: "r1", status: "sending" });
    expect(await deriveRowStatus("r1", "sending", 1_000)).toMatchObject({ status: "unassigned" });
  });

  it("prefers a retryable target over a failed one", async () => {
    await seedRow({ id: "r1", status: "sending" });
    await seedTargets("r1", [
      { resId: 1, status: "pending" },
      { resId: 2, status: "failed", lastErrorCode: "ODOO_FAULT" },
    ]);
    expect(await deriveRowStatus("r1", "sending", 1_000)).toMatchObject({ status: "pending" });
  });

  it("derives failed when every unsent target is failed", async () => {
    await seedRow({ id: "r1", status: "sending" });
    await seedTargets("r1", [
      { resId: 1, status: "sent" },
      { resId: 2, status: "failed", lastErrorCode: "ODOO_FAULT" },
    ]);
    expect(await deriveRowStatus("r1", "sending", 1_000)).toMatchObject({ status: "failed" });
  });

  it("derives sent when every target is sent", async () => {
    await seedRow({ id: "r1", status: "sending" });
    await seedTargets("r1", [{ resId: 1, status: "sent" }, { resId: 2, status: "sent" }]);
    expect(await deriveRowStatus("r1", "sending", 1_000)).toMatchObject({ status: "sent" });
  });

  it("runs from a failed parent, which is what Remove needs", async () => {
    await seedRow({ id: "r1", status: "failed" });
    await seedTargets("r1", [{ resId: 1, status: "sent" }]);
    expect(await deriveRowStatus("r1", "failed", 1_000)).toMatchObject({
      changed: true, status: "sent",
    });
  });

  it("refuses to run on a deleted parent", async () => {
    await seedRow({ id: "r1", status: "deleted" });
    await seedTargets("r1", [{ resId: 1, status: "pending" }]);
    expect(await deriveRowStatus("r1", "deleted", 1_000)).toMatchObject({ changed: false });
    expect(await readRow("r1")).toMatchObject({ status: "deleted" });
  });

  it("loses to a concurrent claim", async () => {
    await seedRow({ id: "r1", status: "failed" });
    await seedTargets("r1", [{ resId: 1, status: "sent" }]);
    // Seed the stolen claim with raw SQL. QUEUE_SQL.claim is
    // `WHERE id = ? AND status IN ('pending','held')` and CANNOT claim a failed
    // row - calling claimRow here would leave the row `failed`, the derive CAS
    // would match, and this test would fail against a CORRECT implementation.
    await rawExecute("UPDATE meeting_log_queue SET status = 'sending' WHERE id = ?", ["r1"]);
    expect(await deriveRowStatus("r1", "failed", 1_000)).toMatchObject({ changed: false });
  });

  it("mirrors the determining target's error and clears it on sent", async () => {
    await seedRow({ id: "r1", status: "sending" });
    await seedTargets("r1", [
      { resId: 1, status: "pending", createdAt: 1 },              // no error yet
      { resId: 2, status: "pending", createdAt: 2,
        lastError: "boom", lastErrorCode: "ODOO_UNREACHABLE" },
    ]);
    await deriveRowStatus("r1", "sending", 1_000);
    expect(await readRow("r1")).toMatchObject({ last_error_code: "ODOO_UNREACHABLE" });
  });
});
```

That last test is the one that catches the mirror resolving to NULL: target 1 is retryable and earlier, but carries no error, so an unqualified "first retryable" would mirror NULL and blank every error surface in the app.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/tests/meeting-log.action.test.ts -t "deriveRowStatus"`
Expected: FAIL — `deriveRowStatus is not a function`.

- [ ] **Step 3: Implement**

```ts
const DERIVE_FORBIDDEN: MeetingLogStatus[] = ["cancelled", "deleted", "sent", "unassigned"];

export async function deriveRowStatus(
  rowId: string,
  observedStatus: MeetingLogStatus,
  now: number,                       // injected, like PushDeps.now - never Date.now() here
): Promise<{ changed: boolean; status: MeetingLogStatus }> {
  if (DERIVE_FORBIDDEN.includes(observedStatus)) {
    return { changed: false, status: observedStatus };
  }

  const targets = await listTargets(rowId);                    // ORDER BY created_at, id
  const withError = targets.filter((t) => t.lastErrorCode !== null);

  let next: MeetingLogStatus;
  let source: MeetingLogTarget | undefined;

  if (targets.length === 0) {
    next = "unassigned";
  } else if (targets.some((t) => t.status === "pending")) {
    next = "pending";
    source = withError.find((t) => t.status === "pending");
  } else if (targets.some((t) => t.status === "failed")) {
    next = "failed";
    source = withError.find((t) => t.status === "failed");
  } else {
    next = "sent";
  }

  const db = await getDatabase();
  const res = await db.execute(QUEUE_SQL.deriveStatus, [
    next,
    next === "sent" ? null : (source?.lastError ?? null),
    next === "sent" ? null : (source?.lastErrorCode ?? null),
    next === "sent" ? now : null,
    rowId,
    observedStatus,
  ]);
  // ?? 0 matches every other rowsAffected read in this file.
  return { changed: (res.rowsAffected ?? 0) > 0, status: next };
}
```

And the statement, in `QUEUE_SQL` — a CAS on **the status the caller observed**, which for the push is `'sending'` and for the queue page is the `pending` or `failed` it read. `COALESCE` on the error columns keeps a non-terminal row from being blanked:

```ts
  // Fully numbered, matching QUEUE_SQL.counts' style, because ?1 is reused three
  // times. Clearing claimed_at is part of the reduction to today's
  // toSent/toFailed/toPending, all three of which set it NULL.
  deriveStatus: `UPDATE meeting_log_queue
    SET status = ?1,
        last_error      = CASE WHEN ?1 = 'sent' THEN NULL ELSE COALESCE(?2, last_error) END,
        last_error_code = CASE WHEN ?1 = 'sent' THEN NULL ELSE COALESCE(?3, last_error_code) END,
        sent_at    = COALESCE(?4, sent_at),
        claimed_at = NULL
    WHERE id = ?5 AND status = ?6`,
```

`deriveRowStatus` takes the timestamp from its caller rather than calling `Date.now()` itself, so the push can pass `deps.now()` and the test can drive it.

- [ ] **Step 4: Run them to verify they pass**

Run: `npx vitest run src/tests/meeting-log.action.test.ts -t "deriveRowStatus"`
Expected: PASS, all eight.

- [ ] **Step 5: Apply the mutants and confirm each test dies**

| Mutant | Must fail |
|---|---|
| swap rules 1 and 2 so failed wins | "prefers a retryable target over a failed one" |
| delete the `targets.length === 0` branch | "derives unassigned when the row has no targets" |
| change the CAS to `WHERE id = ?` only | "loses to a concurrent claim" |
| replace `DERIVE_FORBIDDEN` with `observedStatus !== "sending"` | "runs from a failed parent, which is what Remove needs" |
| drop the `.filter((t) => t.lastErrorCode !== null)` | the error-mirror test |

Revert every mutant before committing.

- [ ] **Step 6: Commit**

```bash
git add src/lib/database/meeting-log.action.ts src/tests/meeting-log.action.test.ts
git commit -m "feat(odoo): derive a queue row's status from its targets under a CAS"
```
---

### Task 6: Enqueue ordering and the orphan sweep

**Files:**
- Modify: `src/lib/database/meeting-log.action.ts`
- Modify: `src/hooks/useMeetingLog.ts`
- Test: `src/tests/meeting-log.action.test.ts`, `src/tests/useMeetingLog.enqueue.test.tsx`

**Interfaces:**
- Consumes: `QUEUE_SQL.insertTarget`, `.deleteTargetsByRow`, `.sweepOrphanTargets` from Task 3; `loadTargets` from Task 4.
- Produces: `insertQueueRow` gains a `targets: SelectedTargets` parameter and loses `contactId` / `leadId`. **It keeps its `Promise<boolean>` return** — the caller does `const created = await insertQueueRow(…); if (!created) return;`, and the child cleanup and overflow stamp are internal to it. Also `sweepOrphanTargets(olderThan: number): Promise<number>` and `runOrphanSweep(): Promise<void>` in `useMeetingLog`'s module scope.

**The caller is still single-target, and this task adapts it rather than converting it.** `useMeetingLog` holds `targetRef: RefObject<ResolvedTarget | null>` until Task 14. Map at the call site:

```ts
// Deleted in Task 14. Lead wins, matching the backfill's coalesce. Returns null
// rather than asserting, because ResolvedTarget.contactId is `number | null` and
// SelectedTarget.resId is `number` - an assertion would fail TS strict, and this
// task claims a compiling tree.
const resolvedToSelected = (t: ResolvedTarget): SelectedTarget | null => {
  if (t.leadId !== null) {
    return { model: "crm.lead", resId: t.leadId, name: t.leadName };
  }
  if (t.contactId !== null) {
    return { model: "res.partner", resId: t.contactId, name: null };
  }
  return null;                       // neither id set: not a target, same as today
};

const targets = [target ? resolvedToSelected(target) : null]
  .filter((t): t is SelectedTarget => t !== null);
```

`status: targets.length ? "held" : "unassigned"` and `if (targets.length) startHold(rowId)` replace the `target ?` conditionals. Behaviour is bit-for-bit what it is today.

There is no transaction. Ordering is the whole safety argument:

1. Insert the target rows. `rowId` is a client-side `crypto.randomUUID()`, so the children have their foreign key before the parent exists.
2. Insert the parent queue row last.

Target rows are inert until a parent references them, and the watermark is `MAX(transcript_end_at)` over the **parent** table. A crash between the steps leaves the meeting un-queued, the watermark unmoved, and the next trigger re-slices the same span correctly.

- [ ] **Step 1: Write the failing tests**

```ts
it("writes children before the parent", async () => {
  const order: string[] = [];
  spyOnExecute((sql) => {
    if (sql.includes("INSERT INTO meeting_log_targets")) order.push("child");
    if (sql.includes("INSERT INTO meeting_log_queue")) order.push("parent");
  });
  await insertQueueRow({ ...baseRow, targets: [
    { model: "res.partner", resId: 1, name: "A" },
    { model: "crm.lead", resId: 9, name: "L" },
  ]});
  expect(order).toEqual(["child", "child", "parent"]);
});

it("leaves the meeting un-queued when the parent insert never runs", async () => {
  // Crash after the children: the row is absent, so the watermark cannot advance
  // and the next trigger re-slices the same span.
  await insertTargetsOnly("r1", [{ model: "res.partner", resId: 1, name: "A" }]);
  expect(await readRow("r1")).toBeUndefined();
  expect(await listTargets("r1")).toHaveLength(1);
});

it("deletes its children when it loses the session_key race", async () => {
  await insertQueueRow({ ...baseRow, id: "r1", sessionKey: "k", targets: [
    { model: "res.partner", resId: 1, name: "A" },
  ]});
  const second = await insertQueueRow({ ...baseRow, id: "r2", sessionKey: "k", targets: [
    { model: "res.partner", resId: 2, name: "B" },
  ]});
  // NOTE: this test only means something once the binding array above is right.
  // With `instance` bound into session_key, EVERY meeting on one instance
  // collides and this test passes for the wrong reason.
  expect(second).toBe(false);            // insertQueueRow returns Promise<boolean>
  expect(await listTargets("r2")).toHaveLength(0);
  expect(await listTargets("r1")).toHaveLength(1);
});

it("caps the child insert at five and records the error, rather than failing the parent", async () => {
  const six = Array.from({ length: 6 }, (_, i) => ({
    model: "res.partner" as const, resId: i + 1, name: `C${i + 1}`,
  }));
  const created = await insertQueueRow({ ...baseRow, id: "r1", targets: six });
  expect(created).toBe(true);                           // the meeting is NOT lost
  expect(await listTargets("r1")).toHaveLength(5);
  expect(await readRow("r1")).toMatchObject({ last_error_code: "TARGET_CAP" });
});

describe("orphan sweep", () => {
  it("sweeps parentless children older than the gate", async () => {
    await insertTargetsOnly("gone", [{ model: "res.partner", resId: 1, name: "A" }], 0);
    expect(await sweepOrphanTargets(1_000)).toBe(1);
  });

  it("leaves recent parentless children alone", async () => {
    await insertTargetsOnly("gone", [{ model: "res.partner", resId: 1, name: "A" }], 5_000);
    expect(await sweepOrphanTargets(1_000)).toBe(0);
  });

  it("never touches the children of a row that still exists, however old", async () => {
    await seedRow({ id: "r1", status: "cancelled" });
    await seedTargets("r1", [{ resId: 1, status: "pending", createdAt: 0 }]);
    expect(await sweepOrphanTargets(1_000)).toBe(0);
    expect(await listTargets("r1")).toHaveLength(1);
  });
});
```

That last test is the one the age gate alone does not give you: a mutant that drops `row_id NOT IN (SELECT id FROM meeting_log_queue)` and keeps the age gate would pass every other test here while deleting the targets of every aged queued row in the backlog.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/tests/meeting-log.action.test.ts -t "orphan sweep"`
Expected: FAIL — `sweepOrphanTargets is not a function`.

- [ ] **Step 3: Implement the ordered insert**

In `insertQueueRow`, remove the `contactId` / `leadId` parameters from `NewQueueRow` and take `targets: SelectedTargets`. Then:

```ts
const capped = targets.slice(0, MAX_TARGETS);
const overflowed = targets.length > MAX_TARGETS;

// Children first. The watermark reads the parent table, so a crash here
// leaves the meeting un-queued and the next trigger re-slices it.
for (const t of capped) {
  await db.execute(QUEUE_SQL.insertTarget, [
    crypto.randomUUID(), row.id, t.model, t.resId, t.name, row.createdAt,
  ]);
}

// QUEUE_SQL.insert's column order, verified against the statement:
//   (id, session_key, conversation_id, instance, contact_id, lead_id,
//    transcript, transcript_start_at, transcript_end_at, meeting_started_at,
//    status, created_at)
// Only the two id columns change - bind BOTH as null, because the target rows
// are the source of truth now and these stay on disk as pre-14 history.
// NewQueueRow has no `attempts` field; do not invent one.
const res = await db.execute(QUEUE_SQL.insert, [
  row.id, row.sessionKey, row.conversationId, row.instance,
  null, null,                                   // contact_id, lead_id
  row.transcript, row.transcriptStartAt, row.transcriptEndAt,
  row.meetingStartedAt, row.status, row.createdAt,
]);
const created = (res.rowsAffected ?? 0) > 0;

// Both bookkeeping writes are guarded. They run AFTER the parent insert has
// already succeeded, and an escaping throw would reject out of insertQueueRow
// into trigger's catch - which toasts "This meeting could not be queued for
// Odoo.", calls skipUnwritten() so the span is never re-sliced, and never calls
// startHold. A false failure report and no undo window, for a meeting that IS
// queued.
try {
  if (!created) {
    // The other trigger won ON CONFLICT(session_key). Take our children back.
    await db.execute(QUEUE_SQL.deleteTargetsByRow, [row.id]);
  } else if (overflowed) {
    // recordError, NOT recordErrorOnUnsent. The latter has no id predicate -
    // `WHERE status IN ('held','pending','sending')` - and would stamp
    // TARGET_CAP across every unsent row in the queue, destroying the real
    // reason on unrelated stuck meetings. Bindings are code-first, matching
    // recordAttemptError.
    await db.execute(QUEUE_SQL.recordError, [
      "TARGET_CAP", `Only the first ${MAX_TARGETS} targets were queued.`, row.id,
    ]);
  }
} catch (e) {
  console.warn("[meeting-log] enqueue bookkeeping failed", e);
}

return created;
```

Capping rather than rejecting here is deliberate and is the opposite of the selection-write rule. Throwing lands in `trigger`'s catch, which calls `skipUnwritten()` and advances the skip watermark — the span is never re-sliced and the **whole meeting** is lost, instead of one note off a stale selection.

- [ ] **Step 4: Implement the sweep**

```ts
export async function sweepOrphanTargets(olderThan: number): Promise<number> {
  const db = await getDatabase();
  const res = await db.execute(QUEUE_SQL.sweepOrphanTargets, [olderThan]);
  return res.rowsAffected ?? 0;      // ?? 0 matches every other read in this file
}
```

In `src/hooks/useMeetingLog.ts`, add it beside `runTranscriptPrune`, copying that function's shape for the reasons its own comments give:

```ts
const ORPHAN_SWEEP_AGE_MS = 5 * 60 * 1000;
let orphanSweepRan = false;   // module scope: survives a <Completion /> remount

export async function runOrphanSweep(): Promise<void> {
  if (orphanSweepRan) return;
  orphanSweepRan = true;
  try {
    const n = await sweepOrphanTargets(Date.now() - ORPHAN_SWEEP_AGE_MS);
    if (n > 0) console.info(`[meeting-log] swept ${n} orphaned target rows`);
  } catch (e) {
    console.warn("[meeting-log] orphan sweep failed", e);
  }
}
```

Chain it **outside** `runMeetingLogSweep`'s `ran` guard, alongside `runTranscriptPrune`, with its own `.catch()` at the effect boundary. `runMeetingLogSweep` returns `{ran: false}` before doing anything when the Odoo config is absent or half-filled — an orphan sweep inside it would never run for exactly the users most likely to accumulate orphans, and it needs no Odoo config.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run src/tests/meeting-log.action.test.ts src/tests/useMeetingLog.enqueue.test.tsx`
Expected: PASS.

- [ ] **Step 6: Apply the mutants**

| Mutant | Must fail |
|---|---|
| move the parent insert before the child loop | "writes children before the parent" |
| drop `row_id NOT IN (SELECT id FROM meeting_log_queue)` | "never touches the children of a row that still exists" |
| drop `created_at < ?` | "leaves recent parentless children alone" |
| throw on overflow instead of capping | "caps the child insert at five … rather than failing the parent" |
| delete the `!created` child cleanup | "deletes its children when it loses the session_key race" |

Revert every mutant before committing.

- [ ] **Step 7: Commit**

```bash
git add src/lib/database/meeting-log.action.ts src/hooks/useMeetingLog.ts src/tests/
git commit -m "feat(odoo): order enqueue's writes and sweep orphaned target rows"
```

---

### Task 7: The two predicates — delete, and the three-step retarget

**Files:**
- Modify: `src/lib/database/meeting-log.action.ts`
- Test: `src/tests/meeting-log.action.test.ts`

**Interfaces:**
- Consumes: Tasks 3 and 5.
- Produces: `assignQueueRow(id: string, targets: SelectedTargets): Promise<boolean>` replacing the `(id, contactId, leadId)` signature — **the `Promise<boolean>` return is unchanged and must stay**, because `runAction` consumes it as `if (!(await cas())) return {kind:"conflict"}`. `deleteRow` gains a sent-target check and `deleteTerminalRow` gains its complement.

**Files also include `src/lib/odoo/meeting-log-actions.ts`.** `assignMeetingLog(id, contactId, leadId, deps)` calls `assignQueueRow(id, contactId, leadId)`; changing the signature without updating it in the same task breaks the build. It becomes `assignMeetingLog(id, targets: SelectedTargets, deps)`.

Both gates live in the **write predicate**, not in which buttons render. `assignRow`'s CAS is status-only and cannot see children, and `deleteRow`'s own comment documents the stale-dashboard window as reachable: "the dashboard window only re-reads on focus, mount and action".

- [ ] **Step 1: Write the failing tests**

```ts
it("refuses to delete a partially-sent row under the nothing-was-sent copy", async () => {
  await seedRow({ id: "r1", status: "failed" });
  await seedTargets("r1", [
    { resId: 1, status: "sent" },
    { resId: 2, status: "failed", lastErrorCode: "ODOO_FAULT" },
  ]);
  // deleteQueueRow returns Promise<boolean>, not a QueryResult.
  expect(await deleteQueueRow("r1")).toBe(false);
});

it("still deletes a row where nothing was sent", async () => {
  await seedRow({ id: "r1", status: "failed" });
  await seedTargets("r1", [{ resId: 1, status: "failed", lastErrorCode: "ODOO_FAULT" }]);
  expect(await deleteQueueRow("r1")).toBe(true);
});

it("deletes a partially-sent row through the honest deleted-after-send copy", async () => {
  await seedRow({ id: "r1", status: "failed" });
  await seedTargets("r1", [
    { resId: 1, status: "sent" },
    { resId: 2, status: "failed", lastErrorCode: "ODOO_FAULT" },
  ]);
  // Without widening deleteTerminalRow, BOTH statements refuse and the row is
  // permanently undeletable.
  expect(await deleteTerminalQueueRow("r1")).toBe(true);
});

it("un-sends nothing when the new set contains an already-sent target", async () => {
  await seedRow({ id: "r1", status: "failed" });
  await seedTargets("r1", [{ resId: 1, status: "sent" }]);
  await assignQueueRow("r1", [{ model: "res.partner", resId: 1, name: "A" }]);
  expect((await listTargets("r1"))[0].status).toBe("sent");
});

it("refuses to retarget a row with a sent target, without touching the children", async () => {
  await seedRow({ id: "r1", status: "failed" });
  await seedTargets("r1", [{ resId: 1, status: "sent" }]);
  expect(await assignQueueRow("r1", [{ model: "res.partner", resId: 2, name: "B" }]))
    .toBe(false);
  // Length 1, not 2: the gate runs BEFORE the inserts. Gating only in step 3
  // would leave the new child behind on a "refused" retarget.
  expect(await listTargets("r1")).toHaveLength(1);
});

it("refuses to retarget a row that is neither unassigned nor failed", async () => {
  await seedRow({ id: "r1", status: "pending" });
  expect(await assignQueueRow("r1", [{ model: "res.partner", resId: 2, name: "B" }]))
    .toBe(false);
});

it("deletes only the row it was asked to delete", async () => {
  // The AND/OR precedence bug drops the id scope and deletes every row with a
  // sent child. Every other fixture here is single-row and cannot see it.
  await seedRow({ id: "r1", status: "failed" });
  await seedTargets("r1", [{ resId: 1, status: "sent" }]);
  await seedRow({ id: "r2", status: "sent" });
  await seedTargets("r2", [{ resId: 2, status: "sent" }]);
  await deleteTerminalQueueRow("r1");
  expect(await readRow("r2")).toMatchObject({ status: "sent" });
});

it("refuses to delete a row that is mid-push", async () => {
  await seedRow({ id: "r1", status: "sending" });
  await seedTargets("r1", [{ resId: 1, status: "sent" }]);
  expect(await deleteTerminalQueueRow("r1")).toBe(false);
});

it("retargets an overlapping set without colliding, and resets the retained child", async () => {
  await seedRow({ id: "r1", status: "failed" });
  await seedTargets("r1", [
    { resId: 1, status: "failed", lastErrorCode: "ODOO_FAULT", attachmentId: 111 },
    { resId: 2, status: "failed", lastErrorCode: "ODOO_FAULT" },
  ]);
  await assignQueueRow("r1", [
    { model: "res.partner", resId: 1, name: "A" },     // retained
    { model: "res.partner", resId: 3, name: "C" },     // new
  ]);
  const t = await listTargets("r1");
  expect(t.map((x) => x.resId).sort()).toEqual([1, 3]);
  const retained = t.find((x) => x.resId === 1)!;
  expect(retained.status).toBe("pending");
  expect(retained.lastErrorCode).toBeNull();
  expect(retained.attachmentId).toBe(111);   // preserved, so the next push converges
});

it("leaves a concurrently-sent child in place during the delete step", async () => {
  await seedRow({ id: "r1", status: "failed" });
  await seedTargets("r1", [{ resId: 2, status: "sent" }]);   // sent between steps 1 and 2
  await assignQueueRow("r1", [{ model: "res.partner", resId: 3, name: "C" }]);
  const t = await listTargets("r1");
  expect(t.some((x) => x.resId === 2 && x.status === "sent")).toBe(true);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/tests/meeting-log.action.test.ts -t "retarget"`
Expected: FAIL — `assignQueueRow` still takes three arguments.

- [ ] **Step 3: Add the sent-target check to `deleteRow` — and widen `deleteTerminalRow`**

Both, in this step. Extend `QUEUE_SQL.deleteRow`'s predicate — the subquery correlates on `meeting_log_queue.id`, so the call site's single `[id]` binding is untouched:

```sql
AND NOT EXISTS (SELECT 1 FROM meeting_log_targets
                 WHERE row_id = meeting_log_queue.id AND status = 'sent')
```

**And `deleteTerminalRow`, or the row becomes permanently undeletable.** Its predicate is `status IN ('sent','cancelled')`; a partially-sent parent derives `pending` or `failed`, so with only the change above *both* statements refuse and `deleteMeetingLog` returns `conflict` forever.

Write the **whole** rewritten `WHERE`, not a fragment — this is the single most dangerous statement in the plan:

```sql
 WHERE id = ?
   AND status <> 'sending'
   AND (status IN ('sent','cancelled')
        OR EXISTS (SELECT 1 FROM meeting_log_targets
                    WHERE row_id = meeting_log_queue.id AND status = 'sent'))
```

Both additions are load-bearing:

- **The parentheses.** `AND` binds tighter than `OR`, so appending a bare `OR EXISTS (…)` yields `(id = ? AND status IN (…)) OR EXISTS (…)` — **the `id` scope is gone**, and one Delete click sets `status='deleted', transcript='', summary_json=NULL` on *every* queue row that has a sent target. After migration 14's backfill that is the user's entire sent history.
- **`status <> 'sending'`.** Even parenthesized, the new `OR` arm admits a mid-push row, which both delete statements deliberately refuse today. A stale dashboard's Delete would blank the transcript while the loop keeps posting notes to the remaining customer records.

The two predicates are then complementary, and `deleteMeetingLog`'s existing try-`deleteRow`-then-`deleteTerminalRow` routing sends a partially-sent row to the honest `deleted-after-send` copy with no other change.

- [ ] **Step 4: Rewrite the retarget as three ordered steps**

```ts
export async function assignQueueRow(id: string, targets: SelectedTargets): Promise<boolean> {
  const db = await getDatabase();

  // GATE FIRST. Evaluating the sent-target check only in step 3 means a REFUSED
  // retarget has already rewritten the child set: on {A(sent), B(failed)} to
  // {A, C}, B is deleted and C inserted before the CAS refuses, and step 2's
  // deletes are unrecoverable. Step 3's NOT EXISTS stays as the authoritative
  // backstop - the residual TOCTOU is safe, because step 2 skips sent children.
  const existing = await listTargets(id);
  if (existing.some((t) => t.status === "sent")) return false;

  const capped = targets.slice(0, MAX_TARGETS);
  const overflowed = targets.length > MAX_TARGETS;

  // 1. Insert the new children. ON CONFLICT is what stops an overlapping set
  //    from aborting on UNIQUE (row_id, model, res_id), and DO UPDATE resets a
  //    retained child to pending so the push loop does not skip it. It does NOT
  //    touch attachment_id / message_id: preserving those is what makes a
  //    concurrently-sent retained child converge instead of re-posting.
  //    The `WHERE status <> 'sent'` on the DO UPDATE is what keeps a sent target
  //    immutable: without it, a stale dashboard whose new set CONTAINS a target
  //    just marked sent would un-send it here, so step 2's skip and step 3's gate
  //    both see nothing and the retarget succeeds on a partially-sent row.
  for (const t of capped) {
    await db.execute(QUEUE_SQL.insertTarget, [
      crypto.randomUUID(), id, t.model, t.resId, t.name, Date.now(),
    ]);
  }

  // 2. Delete only the COMPLEMENT of the new set, and never a sent child.
  //    Deleting by bare row_id would remove the child step 1 just upserted.
  //    Dropping `status <> 'sent'` would destroy a child the sweep marked sent
  //    between steps 1 and 2 - after which step 3's gate finds nothing sent and
  //    passes, which is exactly what the gate exists to prevent.
  const keep = capped.map((t) => `${t.model}:${t.resId}`);
  for (const existing of await listTargets(id)) {
    if (existing.status === "sent") continue;
    if (keep.includes(`${existing.model}:${existing.resId}`)) continue;
    await db.execute(QUEUE_SQL.deleteTargetById, [existing.id]);
  }

  // 3. Flip the parent last, under the gate. Returns boolean, like today.
  const res = await db.execute(QUEUE_SQL.assignRow, [id]);
  const ok = (res.rowsAffected ?? 0) > 0;

  // The retarget path caps like the enqueue path does - and records why, rather
  // than truncating silently.
  if (ok && overflowed) {
    try {
      await db.execute(QUEUE_SQL.recordError, [
        "TARGET_CAP", `Only the first ${MAX_TARGETS} targets were assigned.`, id,
      ]);
    } catch (e) {
      console.warn("[meeting-log] retarget cap note failed", e);
    }
  }
  return ok;
}
```

Then update the caller in the same task:

```ts
export async function assignMeetingLog(id: string, targets: SelectedTargets, deps: Deps) {
  if (!(await assignQueueRow(id, targets))) return { kind: "conflict" as const };
  // ... unchanged
}
```

And the parent statement:

```ts
  // `attempts` is deliberately NOT reset - retryRow's own comment says why: it is
  // the escalation record. Resetting it also makes attemptsBefore === 0 on the
  // next push, which DISABLES BOTH ADOPT-SEARCHES, so a retained child whose
  // message_post succeeded but whose setTargetMessage failed gets re-posted as a
  // duplicate customer-visible note.
  assignRow: `UPDATE meeting_log_queue
    SET status = 'pending', last_error = NULL, last_error_code = NULL
    WHERE id = ?
      AND status IN ('unassigned','failed')
      AND NOT EXISTS (SELECT 1 FROM meeting_log_targets
                       WHERE row_id = meeting_log_queue.id AND status = 'sent')`,
  deleteTargetById: `DELETE FROM meeting_log_targets WHERE id = ?`,
```

A crash after step 1, and a step-3 flip refused by the CAS, leave the **same** recoverable state: extra `pending` children on a row whose parent status has not changed. The orphan sweep does not touch them (the parent exists) and the next retarget's `ON CONFLICT` absorbs them. There is no separate reconciliation step — after step 2 the old target set no longer exists to reconcile against.

- [ ] **Step 5: Run them to verify they pass**

Run: `npx vitest run src/tests/meeting-log.action.test.ts`
Expected: PASS.

- [ ] **Step 6: Apply the mutants**

| Mutant | Must fail |
|---|---|
| drop `ON CONFLICT … DO UPDATE` from `insertTarget` | "retargets an overlapping set without colliding" |
| add `attachment_id = NULL` to the `DO UPDATE` | the same test's `attachmentId` assertion |
| delete by bare `row_id` instead of the complement | "retargets an overlapping set…" |
| drop the `status === "sent"` skip in step 2 | "leaves a concurrently-sent child in place" |
| remove the `NOT EXISTS` from `assignRow` | "refuses to retarget a row with a sent target" |
| remove the `NOT EXISTS` from `deleteRow` | "refuses to delete a partially-sent row" |
| move the sent-gate back to step 3 only | "refuses to retarget … without touching the children" |
| drop the parentheses around `deleteTerminalRow`'s OR group | "deletes only the row it was asked to delete" |
| drop `status <> 'sending'` from `deleteTerminalRow` | "refuses to delete a row that is mid-push" |
| drop `WHERE status <> 'sent'` from `insertTarget`'s DO UPDATE | "un-sends nothing when the new set contains an already-sent target" |
| skip widening `deleteTerminalRow` | "deletes a partially-sent row through the honest deleted-after-send copy" |
| add `attempts = 0` back to `assignRow` | a retarget disables the adopt-search and re-posts a duplicate note |

Revert every mutant before committing.

- [ ] **Step 7: Commit**

```bash
git add src/lib/database/meeting-log.action.ts src/tests/meeting-log.action.test.ts
git commit -m "feat(odoo): gate delete and retarget on sent targets, in the write not the UI"
```
---

### Task 8: Attach targets to the listed rows, and make "any target failed" a first-class signal

**Files:**
- Modify: `src/lib/database/meeting-log.action.ts`
- Modify: `src/lib/odoo/meeting-log.ts`
- Modify: `src/types/odoo.ts`
- Test: `src/tests/meeting-log.action.test.ts`, `src/tests/odoo-meeting-log-groups.test.ts`

**Interfaces:**
- Consumes: `listTargets` from Task 3.
- Produces: `MeetingLogListRow.targets: MeetingLogTarget[]`; `groupOf` and `statusLine` take `failedTargets: number`; `QUEUE_SQL.counts` and `QUEUE_SQL.lastError` account for it.

A row with one retryable target and one terminally failed target derives `pending` under rule 1. Without a separate signal it is filed under *waiting*, counted as `waiting`, promised by `countAll`, and described by `statusLine` as "Waiting to be sent" — while a "1 of 3 failed" summary sits beside it. Four surfaces, one row, three of them wrong.

- [ ] **Step 1: Write the failing tests**

```ts
it("attaches targets to every listed row with one extra query, not N+1", async () => {
  const spy = spyOnSelect();
  await seedRow({ id: "r1", status: "pending" });
  await seedRow({ id: "r2", status: "failed" });
  await seedTargets("r1", [{ resId: 1, status: "pending" }]);
  await seedTargets("r2", [{ resId: 2, status: "failed", lastErrorCode: "ODOO_FAULT" }]);
  const rows = await listActionableRows();
  expect(rows.map((r) => r.targets.length)).toEqual([1, 1]);
  expect(spy.calls.filter((s) => s.includes("meeting_log_targets"))).toHaveLength(1);
});

it("groups a partly-failed pending row as needing attention", () => {
  // groupOf(row, instance) - two arguments, instance second, and the union
  // member is hyphenated. Both verified against src/lib/odoo/meeting-log.ts.
  const row = { status: "pending", attempts: 0, instance: "i1" };
  expect(groupOf({ ...row, failedTargets: 1 }, "i1")).toBe("needs-attention");
  expect(groupOf({ ...row, failedTargets: 0 }, "i1")).toBe("waiting");
});

it("counts a partly-failed row under needs-attention, not waiting", async () => {
  await seedRow({ id: "r1", status: "pending", attempts: 0 });
  await seedTargets("r1", [
    { resId: 1, status: "pending" },
    { resId: 2, status: "failed", lastErrorCode: "ODOO_FAULT" },
  ]);
  const c = await getQueueCounts("i1");   // takes an instance
  expect(c.needsAttention).toBe(1);
  expect(c.waiting).toBe(0);
});

it("excludes a partly-failed row from countAllQueued's promise", async () => {
  await seedRow({ id: "r1", status: "pending", attempts: 0 });
  await seedTargets("r1", [
    { resId: 1, status: "pending" },
    { resId: 2, status: "failed", lastErrorCode: "ODOO_FAULT" },
  ]);
  // countAllQueued is a SEPARATE function, and it takes NO arguments -
  // "regardless of instance", per its own doc comment. QueueCounts has no `all`.
  expect(await countAllQueued()).toBe(0);
});

it("surfaces a reason for a partly-failed row below the escalation threshold", async () => {
  await seedRow({ id: "r1", status: "pending", attempts: 0 });
  await seedTargets("r1", [
    { resId: 1, status: "pending" },
    { resId: 2, status: "failed", lastError: "boom", lastErrorCode: "ODOO_FAULT" },
  ]);
  // QUEUE_SQL.lastError selects from meeting_log_queue and filters
  // `last_error IS NOT NULL`, so the PARENT's mirror must exist - seeding the
  // child alone leaves the row excluded however the status predicate is widened.
  // Derive it, which is what the push does.
  await deriveRowStatus("r1", "pending", 1_000);
  expect((await getQueueCounts("i1")).lastError).toBe("boom");
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/tests/meeting-log.action.test.ts src/tests/odoo-meeting-log-groups.test.ts`
Expected: FAIL — `r.targets` is undefined; `groupOf` takes no `failedTargets`.

- [ ] **Step 3: Add the join**

In `listActionableRows`, after the existing parent query, fetch every target for the listed ids in **one** statement and join in memory. Not N+1, and not a SQL JOIN — a JOIN would multiply the parent rows:

The statement's static half goes in `QUEUE_SQL` — the plan's own Global Constraint, and `reclaimBase` is the established precedent for a statement whose `IN (…)` list is generated at call time:

```ts
  // Deliberately incomplete, like reclaimBase - the caller appends the generated
  // `?,?,...) ORDER BY ...`. The `Base` suffix is what tells you that.
  targetsByRowsBase: `SELECT * FROM meeting_log_targets WHERE row_id IN (`,
```

```ts
const ids = parents.map((p) => p.id);
const targets = ids.length
  ? await db.select<Record<string, unknown>[]>(
      `${QUEUE_SQL.targetsByRowsBase}${ids.map(() => "?").join(",")}) ORDER BY created_at, id`,
      ids,
    )
  : [];
const byRow = new Map<string, MeetingLogTarget[]>();
for (const t of targets.map(toMeetingLogTarget)) {
  (byRow.get(t.rowId) ?? byRow.set(t.rowId, []).get(t.rowId)!).push(t);
}
return parents.map((p) => ({ ...p, targets: byRow.get(p.id) ?? [] }));
```

Add `targets: MeetingLogTarget[]` to `MeetingLogListRow` in `src/types/odoo.ts`. This field is also what makes AssignDialog's Confirm gate implementable in Task 14 — without it the dialog has no target status to read.

- [ ] **Step 4: Thread the signal through the four consumers**

`groupOf(row, instance)` and `statusLine` **derive the count from `row.targets`** rather than taking a new parameter: `const failedTargets = row.targets.filter(t => t.status === "failed").length;`. Every caller already passes the row, so no signature changes and no optional-parameter bridge is needed — and the tests, which set `failedTargets` as a property of the fixture row, then exercise the real path. Both return `"needs-attention"` when it is above zero, whatever the parent status says.

`MeetingLogListRow.targets` is added **optional** in this task and made required in Task 14. Required here, every existing fixture object literal in `meeting-log-page.test.tsx` stops type-checking at Task 11's gate — three tasks before Task 14 replaces them.

`QUEUE_SQL.counts` and `QUEUE_SQL.lastError` gain the matching condition. Both arms are needed, not just the additive one: without the `AND NOT EXISTS` the row is counted twice, and this task's own test asserts `waiting` drops it.

Write the **whole rewritten arm**, never a fragment. `AND` binds tighter than `OR`, so an appended `OR EXISTS (…)` escapes the `instance = ?1` scoping and counts other databases' rows — the same precedence trap as `deleteTerminalRow`. The new arm goes **inside** the existing parenthesised group:

```sql
-- needs-attention arm, whole:
   instance = ?1
   AND ( <existing needs-attention conditions>
         OR EXISTS (SELECT 1 FROM meeting_log_targets
                     WHERE row_id = meeting_log_queue.id AND status = 'failed') )
   AND status IN ('pending','failed')

-- waiting arm, whole:
   instance = ?1
   AND ( <existing waiting conditions> )
   AND NOT EXISTS (SELECT 1 FROM meeting_log_targets
                    WHERE row_id = meeting_log_queue.id AND status = 'failed')
```

The trailing `status IN ('pending','failed')` on the needs-attention arm is load-bearing: `deleteRow` only flips the parent to `deleted` and leaves its children, so without it a deleted meeting's failed child counts under needs-attention and feeds `lastError` **forever**, while `groupOf` returns null and the page never lists it.

The `meeting_log_queue.status IN ('pending','failed')` scoping is load-bearing. `deleteRow` only flips the parent to `deleted` and leaves its children, so an unscoped `EXISTS` makes a deleted meeting's failed child count under needs-attention and supply `getQueueCounts().lastError` **forever**, while `groupOf` returns null and the page never lists it.

`countAllQueued` excludes such a row from its "finishing the credentials will send these" promise.

- [ ] **Step 5: Run them to verify they pass**

Run: `npx vitest run src/tests/meeting-log.action.test.ts src/tests/odoo-meeting-log-groups.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/database/meeting-log.action.ts src/lib/odoo/meeting-log.ts src/types/odoo.ts src/tests/
git commit -m "feat(odoo): attach targets to listed rows and surface partly-failed meetings"
```

---

### Task 9: The push loop, per target

**Files:**
- Modify: `src/lib/odoo/meeting-log-push.ts`
- Modify: `src/lib/odoo/meeting-log.ts`
- Modify: `src/lib/database/meeting-log.action.ts`
- Modify: `src/lib/odoo/meeting-log-actions.ts` — constructs `PushDeps` in `runAction`
- Modify: `src/hooks/useMeetingLog.ts` — constructs `PushDeps` for the hold push
- Test: `src/tests/odoo-meeting-log-push.test.ts`

**Interfaces:**
- Consumes: Tasks 3, 5 and 8.
- Produces: `PushDeps.now` changes from `number` to `() => number`; `QUEUE_SQL.restampClaim`.

The parent claim is unchanged. Summarize once; build one body and one rendered transcript for the whole meeting. Then, sequentially, for each target whose status is `pending`: `ir.attachment.create` (adopt-search first when `attemptsBefore > 0`), persist `attachment_id`, `message_post` (adopt-search first), persist `message_id`, mark `sent`. Skip targets already `sent` — that skip is what makes retry non-duplicating.

`attachmentNameFor(…)` takes **the parent queue row's `id`**, not the target's. Both are in scope now, so it must be written explicitly.

- [ ] **Step 1: Change the clock first**

`PushDeps.now` becomes `() => number`. This is an interface change, not a test convenience: `now` is currently a single value sampled once by the caller, so every claim re-stamp would write the identical value — making a correct implementation and one that stamps only once **indistinguishable in the database**, and the corresponding mutation check unkillable.

`PushDeps` is constructed with `now: Date.now()` in **three** places, all of which change to `now: () => Date.now()`: `runMeetingLogSweep`, `runAction` in `src/lib/odoo/meeting-log-actions.ts`, and `useMeetingLog.ts`'s hold push. Update every `deps.now` read to `deps.now()`.

- [ ] **Step 2: Write the failing tests**

```ts
it("posts to every pending target and skips the sent ones", async () => {
  await seedRow({ id: "r1", status: "pending" });
  await seedTargets("r1", [
    { resId: 1, status: "sent", attachmentId: 11, messageId: 22 },
    { resId: 2, status: "pending" },
  ]);
  await pushQueuedRow(await readRow("r1"), deps);
  // There is no OdooClient.messagePost. The real push calls the generic execute:
  // client.execute(model, "message_post", [[resId]], { body, attachment_ids, subtype_xmlid })
  expect(postCalls(client)).toHaveLength(1);
  expect(client.execute).toHaveBeenCalledWith(
    "res.partner", "message_post", [[2]],
    expect.objectContaining({ subtype_xmlid: "mail.mt_note" }),
  );
});

it("continues past a deterministic failure on target 3 of 5", async () => {
  await seedRow({ id: "r1", status: "pending" });
  await seedTargets("r1", [1, 2, 3, 4, 5].map((resId) => ({ resId, status: "pending" })));
  failPostFor(client, 3, odooFault());
  await pushQueuedRow(await readRow("r1"), deps);   // takes a DbMeetingLogRow
  const t = await listTargets("r1");
  expect(t.filter((x) => x.status === "sent").map((x) => x.resId)).toEqual([1, 2, 4, 5]);
  expect(t.find((x) => x.resId === 3)!.status).toBe("failed");
});

it("aborts the remaining targets on a retryable transport failure, and records its error", async () => {
  await seedRow({ id: "r1", status: "pending" });
  await seedTargets("r1", [1, 2, 3].map((resId) => ({ resId, status: "pending" })));
  failPostFor(client, 2, unreachable());
  await pushQueuedRow(await readRow("r1"), deps);
  const t = await listTargets("r1");
  expect(t.find((x) => x.resId === 3)!.status).toBe("pending");   // never attempted
  expect(t.find((x) => x.resId === 2)!.lastErrorCode).toBe("ODOO_UNREACHABLE");
});

it("routes a local write failure after a wire call to pending, never failed", async () => {
  await seedRow({ id: "r1", status: "pending" });
  await seedTargets("r1", [{ resId: 1, status: "pending" }]);
  failNextExecute("UPDATE meeting_log_targets SET attachment_id");
  await pushQueuedRow(await readRow("r1"), deps);
  expect((await listTargets("r1"))[0].status).toBe("pending");
});

it("does not let a persistence failure on target 1 misclassify target 3's Odoo fault", async () => {
  await seedRow({ id: "r1", status: "pending" });
  await seedTargets("r1", [1, 2, 3].map((resId) => ({ resId, status: "pending" })));
  failOnceOnExecute("UPDATE meeting_log_targets SET attachment_id");   // target 1
  failPostFor(client, 3, odooFault());
  await pushQueuedRow(await readRow("r1"), deps);
  // The pass aborted at target 1, so target 3 was never reached this pass.
  expect((await listTargets("r1")).find((x) => x.resId === 3)!.status).toBe("pending");
});

it("re-stamps claimed_at after each target, tracking the last one", async () => {
  await seedRow({ id: "r1", status: "pending" });
  await seedTargets("r1", [{ resId: 1, status: "pending" }, { resId: 2, status: "pending" }]);
  const clock = vi.fn().mockReturnValueOnce(1_000).mockReturnValueOnce(2_000)
                       .mockReturnValue(3_000);
  await pushQueuedRow(await readRow("r1"), { ...deps, now: clock });
  expect((await readRow("r1")).claimed_at).toBe(3_000);
});
// NOTE: this test alone cannot distinguish "re-stamp after every target" from
// "re-stamp once after the loop" - both end at 3_000, since deps.now() is called
// three times per res.partner target. The neighbouring zero-rows test is what
// proves the per-target cadence. They only work as a pair.

it("aborts the pass when the claim re-stamp affects zero rows", async () => {
  await seedRow({ id: "r1", status: "pending" });
  await seedTargets("r1", [{ resId: 1, status: "pending" }, { resId: 2, status: "pending" }]);
  // Injects a competing write BETWEEN two of the push's own calls - unlike
  // failNextWrite, which is a one-shot self-failure hook. Implement it as a
  // call-count side effect on the mocked execute: after the Nth statement
  // matching /UPDATE meeting_log_targets SET status = 'sent'/, run
  // rawExecute("UPDATE meeting_log_queue SET status='pending' WHERE id=?", [rowId]).
  stealClaimAfterFirstTarget("r1");
  await pushQueuedRow(await readRow("r1"), deps);
  expect((await listTargets("r1")).find((x) => x.resId === 2)!.status).toBe("pending");
  expect(postCalls(client)).toHaveLength(1);
});

it("stamps last_meeting_at for every contact target and skips leads", async () => {
  await seedRow({ id: "r1", status: "pending" });
  await seedTargets("r1", [
    { resId: 1, model: "res.partner", status: "pending" },
    { resId: 2, model: "res.partner", status: "pending" },
    { resId: 9, model: "crm.lead", status: "pending" },
  ]);
  await pushQueuedRow(await readRow("r1"), deps);
  expect(stampLastMeeting).toHaveBeenCalledTimes(2);
});

it("declines a zero-target row before the claim, and derives it out of Waiting", async () => {
  await seedRow({ id: "r1", status: "pending", attempts: 0 });
  await pushQueuedRow(await readRow("r1"), deps);
  // attempts untouched (never claimed), but the status IS corrected, or the row
  // sits in countAllQueued's "these will be sent" promise permanently.
  expect(await readRow("r1")).toMatchObject({ status: "unassigned", attempts: 0 });
});

it("re-stamps the claim after a deterministic failure too", async () => {
  await seedRow({ id: "r1", status: "pending" });
  await seedTargets("r1", [{ resId: 1, status: "pending" }, { resId: 2, status: "pending" }]);
  failPostFor(client, 1, odooFault());
  const clock = vi.fn().mockReturnValueOnce(1_000).mockReturnValue(9_000);
  await pushQueuedRow(await readRow("r1"), { ...deps, now: clock });
  // Target 1 failed deterministically. If the re-stamp lived in the success
  // branch instead of the finally, the claim would never have been refreshed.
  expect((await readRow("r1")).claimed_at).not.toBe(1_000);
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `npx vitest run src/tests/odoo-meeting-log-push.test.ts`
Expected: FAIL — the push still resolves one `resId` via `row.lead_id ?? row.contact_id`.

- [ ] **Step 4: Implement the loop**

Write the control flow **once, as one state machine**. These rules interlock; applied as
independent patches they contradict each other.

The whole loop stays inside `pushQueuedRow`'s existing outer `try/finally`. That
`finally { if (claimedHere) claimed.delete(row.id) }` and the function's documented
**NEVER THROWS** contract survive verbatim. If an escaping throw skipped that `finally`, the
row would stay in the module-scope `claimed` set — excluded from `reclaimStaleSending` **for
the life of the process**, with nothing to recover it.

```ts
// Read the children first, and decline BEFORE the claim when there are none, the
// way today's push returns before the CAS on a null resId "so a mismatch moves
// neither status nor attempts".
const targets = await listTargets(row.id);
if (targets.length === 0) {
  // Derive before returning. deriveRowStatus is CAS'd on the observed status and
  // safe without a claim. Returning bare leaves a `pending` zero-target row
  // uncorrected forever - reachable, because Task 14's dialog can confirm an
  // empty set and assignQueueRow([]) CASes the parent to `pending`. The push
  // then declines pre-claim every sweep while the row sits under "Waiting to be
  // sent" inside countAllQueued's promise.
  await deriveRowStatus(row.id, row.status, deps.now());
  return;
}

for (const target of targets) {
  // `!== "pending"`, NOT `=== "sent"`. Skipping only sent means a deterministically
  // failed child is re-attempted on EVERY sweep of a row that still has a pending
  // sibling - re-firing the fault forever and making retryTarget's child reset
  // (its entire reason for existing) dead code.
  if (target.status !== "pending") continue;

  // The persist helper and its flag are re-created HERE, inside the boundary.
  // Hoisting them makes a SQLITE_BUSY on target 1 route target 3's genuine
  // ODOO_FAULT to pending and retry it forever.
  let persistenceFailed = false;
  const persist = async (sql: string, args: unknown[]) => {
    try { await db.execute(sql, args); }
    catch (e) { persistenceFailed = true; throw e; }
  };

  try {
    let attachmentId = target.attachmentId;
    if (attachmentId === null) {
      attachmentId = await createOrAdoptAttachment(target, attemptsBefore, deps);
      await persist(QUEUE_SQL.setTargetAttachment, [attachmentId, target.id]);
    }

    let messageId = target.messageId;
    if (messageId === null) {
      messageId = await postOrAdoptMessage(target, attachmentId, attemptsBefore, deps);
      await persist(QUEUE_SQL.setTargetMessage, [messageId, target.id]);
    }

    await persist(QUEUE_SQL.targetToSent, [deps.now(), target.id]);

    if (target.model === "res.partner") {
      // Never bare `void`: this is a db.execute, a transient SQLITE_BUSY rejects,
      // and an unhandled rejection in the webview is the exact path errors.ts
      // exists to close. Never await it unwrapped either - it sits inside the
      // boundary but outside persist(), so an awaited rejection would be read as
      // an Odoo fault and mark a target terminal whose note is already live.
      stampLastMeeting(instance, target.resId, deps.now())
        .catch((e) => console.warn("[meeting-log] last_meeting_at stamp failed", e));
    }
  } catch (e) {
    // toOdooError FIRST. isRetryable switches on err.code, so an unwrapped
    // transport rejection (a fetch TypeError, an abort) hits `default: false`,
    // is treated as deterministic, and is marked terminally failed - which
    // selectSweepable never picks up.
    // queueErrorText calls toOdooError internally and returns { code, text } -
    // pass the RAW error, and destructure. toOdooError is still needed separately
    // for isRetryable, which switches on err.code: handing it an unwrapped
    // transport rejection hits `default: false` and marks the target terminally
    // failed, which selectSweepable never picks up.
    const odoo = toOdooError(e);
    const { code, text } = queueErrorText(e);

    // Every recovery write keeps its own guard. This branch is reached when the
    // database is what is broken, so a second unguarded write escapes the outer
    // contract.
    const record = async (sql: string) => {
      try { await db.execute(sql, [code, text, target.id]); }
      catch (inner) { console.warn("[meeting-log] target status write failed", inner); }
    };

    if (persistenceFailed) {
      // A local write failed AFTER a wire call. This target goes pending - never
      // failed, whatever the code says - and the pass aborts, because continuing
      // fires wire calls whose ids the same broken database cannot store.
      await record(QUEUE_SQL.targetToPending);
      break;
    }
    if (isRetryable(odoo)) {
      await record(QUEUE_SQL.targetToPending);
      break;
    }
    await record(QUEUE_SQL.targetToFailed);
    // continue - a deterministic fault on one target must not strand the rest
  } finally {
    // In a finally, so a DETERMINISTIC failure refreshes the claim too. Three
    // consecutive slow faults (a 30s-timeout client returning an access refusal)
    // would otherwise cross STALE_CLAIM_MS with zero re-stamps, and the other
    // window would reclaim mid-flight - the duplicate note this exists to stop.
    //
    // Guarded, and a throw is treated exactly like zero rows. This finally is
    // reached on the persistenceFailed path, where the database is precisely
    // what is broken - so an unguarded write here is the statement guaranteed to
    // fail, and it would escape a function whose contract is NEVER THROWS.
    let claimHeld = false;
    try {
      const stamp = await db.execute(QUEUE_SQL.restampClaim, [deps.now(), row.id]);
      claimHeld = (stamp.rowsAffected ?? 0) > 0;
    } catch (e) {
      console.warn("[meeting-log] claim re-stamp failed", e);
    }
    if (!claimHeld) {
      // The claim is gone or unprovable. RETURN, not break: the terminal derive
      // below CASes on 'sending' and would match the NEW owner's row,
      // overwriting their state mid-push. A `return` in a `finally` overrides a
      // pending `break` - which is exactly what is wanted here.
      return;
    }
  }
}

try {
  await deriveRowStatus(row.id, "sending", deps.now());
} catch (e) {
  console.warn("[meeting-log] terminal derive failed", e);
}
```

`db` is `await getDatabase()`, imported explicitly — `meeting-log-push.ts` has only ever
used action wrappers, so the import is new. `attachmentNameFor(…)` takes **the parent queue
row's `id`**, not the target's.

**The existing outer `catch` must be replaced, not left.** It references `persistenceFailed`,
which is now block-scoped inside the loop — so it will not compile — and it routes any DB
failure through `failRow` / `releaseRowToPending`, writing the parent status directly and
bypassing derivation. Replace its body with a guarded `console.warn` and **no status write**:
per-target failures are already recorded on the children, and the parent's status comes from
the derive. Keep the outer `try` and its `finally { if (claimedHere) claimed.delete(row.id) }`
verbatim — if an escaping throw skipped that `finally`, the row would stay in the
module-scope `claimed` set, excluded from `reclaimStaleSending` for the life of the process,
with nothing to recover it.

With the statement:

```ts
  restampClaim: `UPDATE meeting_log_queue SET claimed_at = ?
    WHERE id = ? AND status = 'sending'`,
```

The predicate is **not** needed to make re-stamping work — a plain update already defeats
`reclaimBase`'s `claimed_at < ?` test, and the only other reader, `isClaimStale`, is
status-gated. It is there because `rowsAffected = 0` is the pusher's only signal that its
claim was taken.

Some deterministic codes are instance-wide — `ODOO_UNREACHABLE` with a non-retryable status,
`ODOO_PAYLOAD_UNSERIALIZABLE`, `ODOO_MALFORMED_RESPONSE` — and will mark all five targets
`failed` on one fault. That is accepted, not carved out: one whole-row Retry recovers all
five, because it resets every `failed` child.

- [ ] **Step 5: Rewrite the stale budget comment**

`SUMMARIZE_TIMEOUT_MS`'s doc comment in `src/lib/odoo/meeting-log.ts` reads "five Odoo calls at 30s AND an AI call. 150s + 60s = 210s against the 300s gate." That arithmetic is now false — five targets is 5 × 2 × 30s = 300s on a first push and 600s on a retry. Replace it with the per-target claim argument, so nobody tunes against stale numbers.

- [ ] **Step 6: Run them to verify they pass**

Run: `npx vitest run src/tests/odoo-meeting-log-push.test.ts`
Expected: PASS.

- [ ] **Step 7: Apply the mutants**

| Mutant | Must fail |
|---|---|
| `break` instead of `continue` on a deterministic failure | "continues past a deterministic failure on target 3 of 5" |
| `continue` instead of `break` on a retryable failure | "aborts the remaining targets on a retryable transport failure" |
| hoist `persistenceFailed` above the loop | "does not let a persistence failure on target 1 misclassify target 3's" |
| route a persistence failure to `targetToFailed` | "routes a local write failure … to pending, never failed" |
| drop the `status === "sent"` skip | "posts to every pending target and skips the sent ones" |
| re-stamp with a hoisted `now` value | "re-stamps claimed_at after each target, tracking the last one" |
| ignore `stamp.rowsAffected` | "aborts the pass when the claim re-stamp affects zero rows" |
| move the re-stamp out of `finally` into the success path | a deterministic failure stops refreshing the claim |
| pass the raw error to `isRetryable` instead of `toOdooError(e)` | an unwrapped transport rejection is marked terminally failed |
| claim before reading the targets | "declines a zero-target row before the claim" |
| skip on `status === "sent"` instead of `!== "pending"` | a failed child is re-posted on the next sweep |
| leave the re-stamp unguarded | a persistence failure throws out of a NEVER-THROWS function |
| return bare on zero targets without deriving | an emptied row sits in "Waiting" forever |

Revert every mutant before committing.

- [ ] **Step 8: Commit**

```bash
git add src/lib/odoo/meeting-log-push.ts src/lib/odoo/meeting-log.ts src/lib/database/meeting-log.action.ts src/tests/odoo-meeting-log-push.test.ts
git commit -m "feat(odoo): push a meeting to every one of its targets"
```
---

### Task 10: Queue-page actions — partial sends, per-target retry, per-target remove

**Files:**
- Modify: `src/lib/odoo/meeting-log-actions.ts`
- Test: `src/tests/meeting-log-actions.test.ts`

**Interfaces:**
- Consumes: `deriveRowStatus` (Task 5), `assignQueueRow` (Task 7), `listTargets` (Task 3).
- Produces: `retryTarget(rowId: string, targetId: string)`, `removeQueueTarget(rowId: string, targetId: string)`; `runAction` gains a `push-partial` outcome. Named `removeQueueTarget`, not `removeTarget`: `src/lib/index.ts` star-exports this module and `./database` into one flat `@/lib` namespace, where Task 4's `removeSelectedTarget` also lands.

`mockPush` has a **two-part contract**: `runAction`'s partial-send classification re-reads target counts from the database, so the mock must both replace `pushQueuedRow` *and* perform the underlying `meeting_log_targets` writes (raw SQL, `seedTargets`-style). Resolving a return value alone leaves the re-read seeing nothing.

`runAction` classifies a push by the parent alone — `if (after.status !== "sent") return { kind: "push-failed" }` — and the page renders "This meeting could not be sent. The error on the row says why." A pass that lands notes on two of three customer records derives `pending` or `failed`, so the user is told nothing was sent while two notes are live on two customers' chatter. This is the same falsehood `deleteRow` was fixed for in Task 7, on a different path.

- [ ] **Step 1: Write the failing tests**

```ts
it("reports a partial send rather than claiming nothing was sent", async () => {
  await seedRow({ id: "r1", status: "pending" });
  await seedTargets("r1", [
    { resId: 1, status: "pending" },
    { resId: 2, status: "pending" },
  ]);
  mockPush({ sent: [1], failed: [2] });
  const res = await retryMeetingLog("r1", deps);
  expect(res.kind).toBe("push-partial");
  expect(res.sentCount).toBe(1);
  expect(res.failedCount).toBe(1);
});

it("still reports push-failed when nothing landed", async () => {
  await seedRow({ id: "r1", status: "pending" });
  await seedTargets("r1", [{ resId: 1, status: "pending" }]);
  mockPush({ sent: [], failed: [1] });
  expect((await retryMeetingLog("r1", deps)).kind).toBe("push-failed");
});

it("reports a partial send even when this pass changed nothing", async () => {
  // The delta is zero: target 3 faults again. Classifying on the delta would
  // fall through to push-failed and print "This meeting could not be sent" while
  // two notes are live on two customers' chatter - the exact lie this task
  // exists to remove, reintroduced on the retry path the feature adds.
  await seedRow({ id: "r1", status: "failed" });
  await seedTargets("r1", [
    { resId: 1, status: "sent" },
    { resId: 2, status: "sent" },
    { resId: 3, status: "failed", lastErrorCode: "ODOO_FAULT" },
  ]);
  mockPush({ sent: [], failed: [3] });
  expect((await retryMeetingLog("r1", deps)).kind).toBe("push-partial");
});

it("surfaces a refusal when the row moved underneath the caller", async () => {
  await seedRow({ id: "r1", status: "failed" });
  await seedTargets("r1", [{ resId: 1, status: "failed", lastErrorCode: "ODOO_FAULT" }]);
  const t = (await listTargets("r1"))[0];
  await rawExecute("UPDATE meeting_log_queue SET status = 'sending' WHERE id = ?", ["r1"]);
  expect(await retryTarget("r1", t.id)).toMatchObject({ kind: "conflict" });
});

it("resets the child, not just the parent, on a per-target retry", async () => {
  await seedRow({ id: "r1", status: "failed" });
  await seedTargets("r1", [
    { resId: 1, status: "sent" },
    { resId: 2, status: "failed", lastError: "boom", lastErrorCode: "ODOO_FAULT" },
  ]);
  const t = (await listTargets("r1")).find((x) => x.resId === 2)!;
  expect(await retryTarget("r1", t.id)).toMatchObject({ kind: "ok" });
  const after = (await listTargets("r1")).find((x) => x.resId === 2)!;
  expect(after.status).toBe("pending");
  expect(after.lastErrorCode).toBeNull();
  expect(await readRow("r1")).toMatchObject({ status: "pending" });
});

it("resets every failed child and no sent child on a whole-row retry", async () => {
  await seedRow({ id: "r1", status: "failed" });
  await seedTargets("r1", [
    { resId: 1, status: "sent" },
    { resId: 2, status: "failed", lastErrorCode: "ODOO_FAULT" },
    { resId: 3, status: "failed", lastErrorCode: "ODOO_FAULT" },
  ]);
  await retryMeetingLog("r1");
  const t = await listTargets("r1");
  expect(t.find((x) => x.resId === 1)!.status).toBe("sent");
  expect(t.filter((x) => x.status === "pending").map((x) => x.resId)).toEqual([2, 3]);
});

it("refuses to retry a sent target", async () => {
  await seedRow({ id: "r1", status: "failed" });
  await seedTargets("r1", [{ resId: 1, status: "sent" }]);
  const t = (await listTargets("r1"))[0];
  expect(await retryTarget("r1", t.id)).toMatchObject({ kind: "refused" });
  expect((await listTargets("r1"))[0].status).toBe("sent");
});

it("refuses to remove a sent target", async () => {
  await seedRow({ id: "r1", status: "failed" });
  await seedTargets("r1", [{ resId: 1, status: "sent" }]);
  const t = (await listTargets("r1"))[0];
  await expect(removeQueueTarget("r1", t.id)).resolves.toMatchObject({ kind: "refused" });
  expect(await listTargets("r1")).toHaveLength(1);
});

it("flips the parent to unassigned when the last target is removed", async () => {
  await seedRow({ id: "r1", status: "failed" });
  await seedTargets("r1", [{ resId: 1, status: "failed", lastErrorCode: "ODOO_FAULT" }]);
  const t = (await listTargets("r1"))[0];
  await removeQueueTarget("r1", t.id);
  expect(await readRow("r1")).toMatchObject({ status: "unassigned" });
});

it("leaves a cancelled meeting's children in place, and the sweep does not take them", async () => {
  // The spec asserts undo is untouched: cancelHeld flips the parent and never
  // claims a child. Those children are NOT orphans - the parent row still
  // exists - so the startup sweep's NOT IN clause correctly ignores them, and
  // they go when the row goes.
  await seedRow({ id: "r1", status: "held" });
  await seedTargets("r1", [{ resId: 1, status: "pending", createdAt: 0 }]);
  await cancelHeld("r1");
  expect(await readRow("r1")).toMatchObject({ status: "cancelled" });
  expect(await listTargets("r1")).toHaveLength(1);
  expect(await sweepOrphanTargets(1_000)).toBe(0);
  await deleteQueueRow("r1");
  expect(await listTargets("r1")).toHaveLength(0);
});

it("re-derives to sent when the only failed target is removed", async () => {
  await seedRow({ id: "r1", status: "failed" });
  await seedTargets("r1", [
    { resId: 1, status: "sent" },
    { resId: 2, status: "failed", lastErrorCode: "ODOO_FAULT" },
  ]);
  const t = (await listTargets("r1")).find((x) => x.resId === 2)!;
  await removeQueueTarget("r1", t.id);
  expect(await readRow("r1")).toMatchObject({ status: "sent" });
});
```

That last test is the one a `sending`-only derivation gate would fail: Remove acts on a `failed` parent.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/tests/meeting-log-actions.test.ts`
Expected: FAIL — `retryTarget is not a function`.

- [ ] **Step 3: Implement**

```ts
export async function retryTarget(rowId: string, targetId: string) {
  const target = (await listTargets(rowId)).find((t) => t.id === targetId);
  if (!target) return { kind: "gone" as const };
  // Mirror removeQueueTarget: a sent target is immutable. The statement's own
  // `AND status <> 'sent'` is the backstop; this is the honest answer to the UI.
  if (target.status === "sent") return { kind: "refused" as const };

  const db = await getDatabase();
  // The child reset is the load-bearing half. The push loop filters on
  // status = 'pending', so flipping only the parent leaves this a no-op
  // against the very target the button names.
  await db.execute(QUEUE_SQL.targetToPending, [null, null, targetId]);
  // retryRow's CAS is `WHERE id = ? AND status IN ('failed','pending')`. A row
  // that went 'sending' between render and click matches nothing - surface that
  // rather than telling the user a retry is under way.
  const res = await db.execute(QUEUE_SQL.retryRow, [rowId]);
  if ((res.rowsAffected ?? 0) === 0) return { kind: "conflict" as const };
  return { kind: "ok" as const };
}

export async function removeQueueTarget(rowId: string, targetId: string) {
  const target = (await listTargets(rowId)).find((t) => t.id === targetId);
  if (!target) return { kind: "gone" as const };
  // A sent target row is immutable: it is the only record that the note exists.
  if (target.status === "sent") return { kind: "refused" as const };

  const db = await getDatabase();
  // Read the parent's current status to CAS against. There is no readRowStatus
  // helper - use the existing row reader:
  const before = (await getQueueRow(rowId))?.status;
  if (!before) return { kind: "gone" as const };
  await db.execute(QUEUE_SQL.deleteTargetById, [targetId]);
  // The read-then-derive window is a real TOCTOU, but a fail-safe one: the CAS
  // turns a moved row into zero rows affected. Surface it instead of discarding
  // it - the spec requires the action to report a refusal and re-read.
  const { changed } = await deriveRowStatus(rowId, before, Date.now());
  if (!changed) return { kind: "conflict" as const };
  return { kind: "ok" as const };
}
```

In `retryMeetingLog`, reset every `failed` child before flipping the parent — never a `sent` one.

In `runAction`, classify on the **after-state, not the delta**: any target `sent` **and** any target not `sent` → `push-partial`, regardless of what changed this pass. A delta-keyed rule reports `push-failed` when a retry re-faults on the same target, which is the falsehood this task exists to remove.

Two details the rule alone does not settle:

- **Where the arm sits in the ladder.** `runAction`'s existing order is `no-op` →
  `still-sending` → … → `push-failed`. `push-partial` **replaces** the blanket
  `after.status !== "sent"` arm and sits immediately after `still-sending`.
- **The counts are three, not two.** "Not sent" includes `pending`, so reporting a
  retryable abort with 1 sent and 2 pending as `failedCount: 2` tells the user two records
  failed when they are queued for automatic retry — the mirror image of the lie this task
  removes. Return `sentCount`, `failedCount` and `pendingCount`, read from the after-state.

- [ ] **Step 4: Run them to verify they pass**

Run: `npx vitest run src/tests/meeting-log-actions.test.ts`
Expected: PASS.

- [ ] **Step 5: Apply the mutants**

| Mutant | Must fail |
|---|---|
| `retryTarget` flips only the parent | "resets the child, not just the parent" |
| `retryMeetingLog` resets `sent` children too | "resets every failed child and no sent child" |
| `removeQueueTarget` drops the `sent` check | "refuses to remove a sent target" |
| `runAction` returns `push-failed` for any non-`sent` parent | "reports a partial send rather than claiming nothing was sent" |
| `runAction` classifies on the delta rather than the after-state | "reports a partial send even when this pass changed nothing" |
| `retryTarget` discards `retryRow`'s zero-row result | "surfaces a refusal when the row moved underneath the caller" |

- [ ] **Step 6: Commit**

```bash
git add src/lib/odoo/meeting-log-actions.ts src/tests/meeting-log-actions.test.ts
git commit -m "feat(odoo): retry and remove one target, and stop calling a partial send a failure"
```

---

### Task 11: `useOdooTarget` holds a list

**Files:**
- Modify: `src/hooks/useOdooTarget.ts`
- Modify: `src/types/odoo.ts`
- Test: `src/tests/useOdooTarget.test.tsx`

**Interfaces:**
- Consumes: Task 4's selection API.
- Produces: `UseOdooTargetReturn` gains `targets: SelectedTargets`, `targetCount: number`, `addTarget`, `removeTarget`, `expandContact(contactId)`, `opportunitiesFor(contactId)`, `errorFor(contactId)`, `retryOpportunitiesFor(contactId)`. These are **hook return fields**, not module exports, so they do not collide with Task 4's or Task 10's similarly-named functions.
- **`ResolvedTarget` is NOT deleted here.** `useMeetingLog`'s `targetRef`, `ContactPicker` (Task 12) and the meeting-log page (Task 14) still declare it. Task 14 removes it. This task removes `saveTarget` / `loadTarget` only.

**Files also include** `src/lib/database/odoo-contacts.action.ts` and `src/tests/odoo-contacts.action.test.ts` — Step 6 deletes `saveTarget` / `loadTarget` and their tests there.

- [ ] **Step 1: Write the failing tests**

```ts
it("hands ContactPicker a referentially stable list at zero targets", () => {
  // `pickerProps.targets` only exists once Task 12 adds `targets` to
  // ContactPickerProps, so this task asserts on the hook's own field and Task 12
  // adds the pickerProps-level assertion alongside its picker tests. Asserting
  // the wrong one here would fail this task's own check:types gate.
  const { result, rerender } = renderHook(() => useOdooTarget(opts));
  const first = result.current.targets;
  rerender();
  expect(result.current.targets).toBe(first);   // same reference, not a new []
});

it("re-renders the picker when a row's lookup resolves", async () => {
  // The ref-only version of the cache passes every hook-level assertion and
  // still leaves the row stuck on "Looking up..." - only a render-level test
  // catches it.
  render(<Harness />);
  await user.click(screen.getByRole("button", { name: /expand Christian Carron/i }));
  await resolveOpportunities(1, [{ id: 9, name: "Partnership with ECS" }]);
  expect(await screen.findByRole("button", { name: /add Partnership with ECS/i }))
    .toBeVisible();
});

it("keys the deal lookup per contact, so adding a target does not strand an open row", async () => {
  const { result } = renderHook(() => useOdooTarget(opts));
  act(() => { result.current.expandContact(1); });
  act(() => { result.current.addTarget({ model: "res.partner", resId: 2, name: "B" }); });
  await resolveOpportunities(1, [{ id: 9, name: "Deal" }]);
  expect(result.current.opportunitiesFor(1)).toHaveLength(1);   // not stuck loading
});

it("empties the disclosure cache when the instance changes", async () => {
  const { result } = renderHook(() => useOdooTarget(opts));
  act(() => { result.current.expandContact(1); });
  await resolveOpportunities(1, [{ id: 9, name: "Deal" }]);
  act(() => { result.current.handleInstanceChanged(); });
  expect(result.current.opportunitiesFor(1)).toBeNull();
});

it("keys the lookup error per contact", async () => {
  const { result } = renderHook(() => useOdooTarget(opts));
  act(() => { result.current.expandContact(1); result.current.expandContact(2); });
  await rejectOpportunities(1, new Error("boom"));
  await resolveOpportunities(2, [{ id: 9, name: "Deal" }]);
  expect(result.current.errorFor(1)).not.toBeNull();
  expect(result.current.errorFor(2)).toBeNull();
});

it("skips the lookup for a colleague", async () => {
  const { result } = renderHook(() => useOdooTarget(opts));
  act(() => { result.current.expandContact(COLLEAGUE_ID); });
  expect(fetchOpportunities).not.toHaveBeenCalled();
});

it("drops only the archived contact's target, not the selection", async () => {
  const { result } = renderHook(() => useOdooTarget(opts));
  await addTargets(result, [
    { model: "res.partner", resId: 1, name: "A" },
    { model: "res.partner", resId: 2, name: "B" },
  ]);
  await archiveContactAndReload(1);
  expect(result.current.targets.map((t) => t.resId)).toEqual([2]);
});

it("refuses a sixth target and surfaces the cap", async () => {
  const { result } = renderHook(() => useOdooTarget(opts));
  await addTargets(result, [1, 2, 3, 4, 5].map((resId) => ({
    model: "res.partner" as const, resId, name: `C${resId}`,
  })));
  await act(async () => {
    const r = await result.current.addTarget({ model: "res.partner", resId: 6, name: "C6" });
    expect(r).toMatchObject({ ok: false, reason: "cap" });
  });
  expect(result.current.targets).toHaveLength(5);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/tests/useOdooTarget.test.tsx`
Expected: FAIL — `expandContact is not a function`.

- [ ] **Step 3: Implement the list state**

```ts
// Non-nullable. `useState<SelectedTargets | null>(null)` would make the natural
// pickerProps fallback `targets: target ?? []`, which allocates a fresh array on
// every render at zero targets - the steady state before anyone picks anything -
// and ContactPicker's default shallow memo comparator would then re-render it on
// every streamed AI chunk.
const [targets, setTargets] = useState<SelectedTargets>([]);
```

- [ ] **Step 4: Implement the per-contact disclosure cache and its epoch**

**The cache must be state, not only refs.** A `useRef` write schedules no render, so
when `expandContact`'s fetch resolves and writes the cache, `ContactPicker` never learns
the data arrived and the row sits on "Looking up…" forever. Every other ref in this file
that backs rendered UI (`opportunitiesRef`, `cacheRef`) mirrors a real `useState`.

Refs stay for the fast in-flight and staleness checks; the rendered data is state, replaced
by a **new `Map`** on every write so the identity changes — the idiom `onToggleColleague`
already uses for `cache`:

```ts
// Per-contact generation, so adding or removing a target elsewhere in the list
// cannot invalidate an unrelated open disclosure. Refs: not rendered.
const rowGen = useRef(new Map<number, number>());

// Rendered. New Map on every write, or nothing re-renders.
const [rowCache, setRowCache] = useState<Map<number, OdooOpportunity[]>>(new Map());
const [rowError, setRowError] = useState<Map<number, string>>(new Map());

// ...but NOT independent of everything. handleInstanceChanged bumps
// selectionToken precisely to supersede data from a database we just switched
// away from, and ContactPicker is a long-lived memo component - Radix unmounts
// PopoverContent's subtree, not the instance holding these maps. Without an
// epoch, the cache serves opportunities from the old database under contact ids
// that may now name entirely different Odoo records.
const epoch = useRef(0);

function bumpEpoch() {
  epoch.current += 1;
  rowGen.current.clear();          // a ref: .current is right here
  setRowCache(new Map());          // STATE: no .current, and a NEW Map, not .clear()
  setRowError(new Map());          // an in-place clear schedules no render
}
```

`rowGen` is the only one of the three that is still a ref. Calling `.current` on the other
two does not compile, and clearing them in place would leave the previous database's
opportunities on screen after an instance change — the exact failure the epoch exists to
prevent.

`expandContact`'s writes use the **functional updater**, because the suite drives two
lookups concurrently and a closed-over write can drop one:

```ts
setRowCache((prev) => new Map(prev).set(contactId, rows));
setRowError((prev) => { const next = new Map(prev); next.delete(contactId); return next; });
```

Call `bumpEpoch()` from `handleInstanceChanged` and `handleNewChat`, alongside the existing `selectionToken` bump. `expandContact` early-returns when the contact is a colleague, when a fetch is already in flight for that contact, or when the cache already holds a result.

- [ ] **Step 5: Make archival removal per-target**

`commit` becomes list-accepting. `reload()`'s archived check filters `targetRef.current` down to the survivors and commits that, under the same double `token !== selectionToken.current` check `commit` already performs — never a full clear.

- [ ] **Step 6: Delete `saveTarget` and `loadTarget`**

Task 4 kept them so the tree would compile; `useOdooTarget` was their last consumer and
this task removes it. Delete both from `src/lib/database/odoo-contacts.action.ts` and drop
their tests.

**`ResolvedTarget` stays.** `useMeetingLog.ts`'s `targetRef`, `ContactPicker` (Task 12) and
the meeting-log page (Task 14) still declare it. It is deleted in **Task 14**.

- [ ] **Step 7: Run them to verify they pass**

Run: `npx vitest run src/tests/useOdooTarget.test.tsx && npm run check:types`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/hooks/useOdooTarget.ts src/types/odoo.ts src/tests/useOdooTarget.test.tsx \
        src/lib/database/odoo-contacts.action.ts src/tests/odoo-contacts.action.test.ts
git commit -m "feat(odoo): hold a list of targets, with a per-contact deal lookup"
```

---

### Task 12: The picker

**Files:**
- Modify: `src/pages/app/components/completion/ContactPicker.tsx` — including `ContactPickerProps`, which gains `targets`
- Modify: `src/hooks/useCompletion.ts` — owns `targetCount` / `setTargetCount`
- Modify: `src/hooks/useOdooTarget.ts` — takes `setTargetCount` as a param and calls it when the list changes
- Test: `src/tests/odoo-contact-picker.test.tsx`, `src/tests/useCompletion.meeting-assist.test.tsx`

**Interfaces:**
- Consumes: Task 11's hook surface.
- Produces: no new exports.

- [ ] **Step 1: Write the failing tests**

```ts
it("shows the count in the trigger line", () => {
  render(<ContactPicker {...props} targets={[t("Christian Carron"), t("B"), t("C")]} />);
  expect(screen.getByRole("button", { name: /Christian Carron \+ 2 more/ })).toBeVisible();
});

it("adds a deal as its own line, not attached to the contact", async () => {
  render(<ContactPicker {...props} />);
  await user.click(screen.getByRole("button", { name: /expand Christian Carron/i }));
  await user.click(await screen.findByRole("button", { name: /add Partnership with ECS/i }));
  expect(props.onAddTarget).toHaveBeenCalledWith({
    model: "crm.lead", resId: 90, name: "Partnership with ECS",
  });
});

it("uses aria-disabled at the cap, keeping the control focusable", () => {
  render(<ContactPicker {...props} targets={fiveTargets} />);
  const add = screen.getByRole("button", { name: /add Bentley AS/i });
  expect(add).toHaveAttribute("aria-disabled", "true");
  expect(add).not.toHaveAttribute("disabled");
  add.focus();
  expect(add).toHaveFocus();
});

it("keeps native disabled on an archived contact", () => {
  render(<ContactPicker {...props} contacts={[{ ...contact, active: false }]} />);
  expect(screen.getByRole("button", { name: /Archived Person/i })).toBeDisabled();
});

it("pluralises the destination sentence and names each record's kind", () => {
  render(<ContactPicker {...props} targets={[
    t("Christian Carron", "res.partner"), t("Partnership with ECS", "crm.lead"), t("Bentley AS"),
  ]} />);
  expect(screen.getByText(
    /logged on 3 records: Christian Carron, the lead Partnership with ECS, and Bentley AS\./,
  )).toBeVisible();
});

it("renders static text for a colleague's expanded row, with no dead control", async () => {
  render(<ContactPicker {...props} contacts={[colleague]} />);
  await user.click(screen.getByRole("button", { name: /expand/i }));
  expect(screen.queryByRole("button", { name: /look up/i })).toBeNull();
});
```

Plus, in `src/tests/useCompletion.meeting-assist.test.tsx`:

```ts
it("re-runs the resize effect when a target is added while the picker is open", () => {
  const { rerender } = renderCompletion({ isPickerOpen: true, targetCount: 1 });
  resize.mockClear();
  rerender({ isPickerOpen: true, targetCount: 2 });
  expect(resize).toHaveBeenCalled();
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/tests/odoo-contact-picker.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Build the "Logging to" section**

Pinned above the search box, with its own `max-h` and scroll. Header is `Logging to (3)`; at the cap it reads `Logging to (5) · limit reached`.

- [ ] **Step 4: Turn every row into a toggle**

Contact rows, deal rows and lead-search results all get `+ add` / `✓ added`; clicking an added row removes it. Under a flat list they all produce the same kind of thing.

At the cap, add affordances get `aria-disabled="true"` and a no-op handler — **not** the native attribute, which drops the element from the tab order and blurs it with no defined recovery target. The archived-contact row keeps native `disabled`: its disablement is static at render time, not a side effect of another row's interaction, so the focus hazard does not apply. Two patterns in one list, deliberately.

- [ ] **Step 5: Wire the resize dependency — as a push, not a pull**

`useCompletion`'s resize effect watches a fixed flag list and fires on picker open/close.
"Logging to" changes height from clicks *inside* an already-open popover, which never
toggles `isPickerOpen`.

`useCompletion` **cannot read** `targetCount` off `UseOdooTargetReturn`: the two hooks are
siblings, and `<Completion />` calls `useCompletion()` first, so nothing `useOdooTarget`
returns exists when the effect is defined. Mirror the idiom already in place for
`isPickerOpen`:

- `useCompletion` owns a `targetCount` / `setTargetCount` pair and adds `targetCount` to
  its own resize effect's dependency array.
- `setTargetCount` is threaded **down** into `useOdooTarget`'s params, beside
  `setIsPickerOpen`.
- `useOdooTarget` calls it whenever the target list changes.

- [ ] **Step 6: Run them to verify they pass**

Run: `npx vitest run src/tests/odoo-contact-picker.test.tsx src/tests/useCompletion.meeting-assist.test.tsx`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/pages/app/components/completion/ContactPicker.tsx src/hooks/useCompletion.ts \
        src/hooks/useOdooTarget.ts src/tests/
git commit -m "feat(odoo): let the picker hold several targets at once"
```

---

### Task 13: The queue row

**Files:**
- Modify: `src/pages/meeting-log/components/QueueRow.tsx`
- Modify: `src/pages/meeting-log/index.tsx` — owns the `<QueueRow>` call site, so it supplies the new `onRetryTarget` / `onRemoveTarget` props
- Test: `src/tests/meeting-log-page.test.tsx`

**Interfaces:**
- Consumes: `MeetingLogListRow.targets` (Task 8), `retryTarget` / `removeTarget` (Task 10).
- Produces: `QueueRowProps` gains `onRetryTarget` and `onRemoveTarget`.

- [ ] **Step 1: Write the failing tests**

```ts
it("summarises how many targets failed", () => {
  render(<QueueRow {...props} row={rowWith([sent(), sent(), failed()])} />);
  expect(screen.getByText("1 of 3 failed")).toBeVisible();
});

it("expands to per-target state", async () => {
  render(<QueueRow {...props} row={rowWith([sent("Christian Carron"), failed("Bentley AS")])} />);
  await user.click(screen.getByRole("button", { name: /expand/i }));
  expect(screen.getByText("Christian Carron")).toBeVisible();
  expect(screen.getByText("ODOO_FAULT")).toBeVisible();
});

it("offers Retry and Remove on a failed target only", async () => {
  render(<QueueRow {...props} row={rowWith([sent("A"), failed("B")])} />);
  await user.click(screen.getByRole("button", { name: /expand/i }));
  const rowB = screen.getByRole("group", { name: /B/ });
  expect(within(rowB).getByRole("button", { name: /retry this one/i })).toBeVisible();
  const rowA = screen.getByRole("group", { name: /A/ });
  expect(within(rowA).queryByRole("button", { name: /remove/i })).toBeNull();
});

it("says a partly-failed row needs attention, not that it is waiting", () => {
  render(<QueueRow {...props} row={{ ...pendingRow, targets: [pending(), failed()] }} />);
  expect(screen.queryByText(/waiting to be sent/i)).toBeNull();
});

it("re-renders when a target's status changes", () => {
  const { rerender } = render(<QueueRow {...props} row={rowWith([pending("A")])} />);
  rerender(<QueueRow {...props} row={rowWith([failed("A")])} />);
  expect(screen.getByText("ODOO_FAULT")).toBeVisible();
});

it("falls back through name, cache, then a generic placeholder", () => {
  render(<QueueRow {...props} row={rowWith([{ ...target, name: null, resId: 12 }])} />);
  expect(screen.getByText("Contact #12")).toBeVisible();
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/tests/meeting-log-page.test.tsx -t "QueueRow"`
Expected: FAIL.

- [ ] **Step 3: Implement the expansion and `targetNameOf`**

`targetNameOf` reads `meeting_log_targets.name`, falls back to the contact cache, then to `Contact #12` / `Lead or opportunity #90`. Every backfilled pre-14 target has a NULL name and hits this chain.

- [ ] **Step 4: Extend `propsAreEqual`**

That comparator is exhaustive by design — its own comment reads "EVERY PROP THE ROW RENDERS, not just the DB columns" and warns that "a comparator narrowed to the DB columns is worse than none". Add a structural comparison over the target list — length plus per-target `id`, `status`, `lastError` (camelCase: `MeetingLogTarget` is a mapped type, unlike the snake_case DB-mirrored fields in the comparator right above it) — the same shape as the existing `sameTranscript` treatment, plus entries for `onRetryTarget` and `onRemoveTarget`. Comparing by reference instead re-renders all 200 rows on every read, because each refresh hands back fresh SQLite objects.

- [ ] **Step 5: Give `statusLine` the `failedTargets` input**

Without it a partly-failed row renders "Waiting to be sent" directly beneath the "Needs attention" heading, beside a "1 of 3 failed" summary.

- [ ] **Step 6: Run them to verify they pass**

Run: `npx vitest run src/tests/meeting-log-page.test.tsx`
Expected: PASS.

- [ ] **Step 7: Apply the mutant**

Omit `targets` from `propsAreEqual`. "re-renders when a target's status changes" must fail. Revert.

- [ ] **Step 8: Commit**

```bash
git add src/pages/meeting-log/components/QueueRow.tsx src/tests/meeting-log-page.test.tsx
git commit -m "feat(odoo): expand a queue row to its per-target state"
```

---

### Task 14: The assign dialog

**Files:**
- Modify: `src/pages/meeting-log/components/AssignDialog.tsx`
- Modify: `src/pages/meeting-log/index.tsx`
- Modify: `src/hooks/useMeetingLog.ts` — `targetRef` becomes `RefObject<SelectedTargets>`, and Task 6's `resolvedToSelected` adapter is deleted
- Modify: `src/types/odoo.ts` — delete `ResolvedTarget`
- Test: `src/tests/meeting-log-page.test.tsx`

**Interfaces:**
- Consumes: `MeetingLogListRow.targets` (Task 8), `assignQueueRow` (Task 7).
- Produces: `AssignPayload` becomes `{ targets: SelectedTargets; providerConfig: … }`.

- [ ] **Step 1: Write the failing tests**

```ts
it("hands up a list of targets", async () => {
  render(<AssignDialog {...props} />);
  await user.click(screen.getByRole("button", { name: /add Christian Carron/i }));
  await user.click(screen.getByRole("button", { name: /add Bentley AS/i }));
  await user.click(screen.getByRole("button", { name: /confirm/i }));
  expect(props.onAssign).toHaveBeenCalledWith(expect.objectContaining({
    targets: [
      { model: "res.partner", resId: 1, name: "Christian Carron" },
      { model: "res.partner", resId: 3, name: "Bentley AS" },
    ],
  }));
});

it("lets a target be taken back off before confirming", async () => {
  render(<AssignDialog {...props} />);
  await user.click(screen.getByRole("button", { name: /add Christian Carron/i }));
  await user.click(screen.getByRole("button", { name: /added Christian Carron/i }));
  await user.click(screen.getByRole("button", { name: /confirm/i }));
  expect(props.onAssign).toHaveBeenCalledWith(expect.objectContaining({ targets: [] }));
});

it("enforces the cap in the dialog", async () => {
  render(<AssignDialog {...props} />);
  for (const n of ["A", "B", "C", "D", "E"]) {
    await user.click(screen.getByRole("button", { name: new RegExp(`add ${n}`, "i") }));
  }
  expect(screen.getByRole("button", { name: /add F/i })).toHaveAttribute("aria-disabled", "true");
});

it("is unreachable on a row with a sent target", () => {
  render(<MeetingLogPage rows={[{ ...row, targets: [sent(), failed()] }]} />);
  expect(screen.queryByRole("button", { name: /assign/i })).toBeNull();
});

it("surfaces a zero-row assign CAS instead of swallowing it", async () => {
  // assignQueueRow returns Promise<boolean>. Mocking an object here is always
  // truthy, so `if (!(await assignQueueRow(...)))` reads the refusal as success
  // and this test could never pass.
  assignQueueRow.mockResolvedValue(false);
  render(<MeetingLogPage rows={[row]} />);
  await assignVia(screen, [{ model: "res.partner", resId: 1, name: "A" }]);
  expect(await screen.findByText(/could not be reassigned/i)).toBeVisible();
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/tests/meeting-log-page.test.tsx -t "AssignDialog"`
Expected: FAIL.

- [ ] **Step 3: Implement**

Replace the dialog's single `selected` / `leadId` pair with `SelectedTarget[]` and the same `+ add` / `✓ added` rows as the picker, with the same `aria-disabled` cap treatment.

In `src/pages/meeting-log/index.tsx`, `handleAssign` reads `row.targets` — the field Task 8 attached — and does not open the dialog when any target is `sent`. Confirm performs exactly the insert-new / delete-old / flip-parent operation the reassign rule forbids on a partially-sent row; the write predicate refuses it anyway, and this keeps the UI from offering an action that will be rejected.

- [ ] **Step 4: Retire `ResolvedTarget` and the adapter**

This is its last task. Convert `useMeetingLog`'s `targetRef` to
`RefObject<SelectedTargets>`, delete Task 6's `resolvedToSelected` shim and the
`targets.length` conditionals it fed, and remove `ResolvedTarget` from
`src/types/odoo.ts`. Nothing else should reference it — `grep -rn "ResolvedTarget" src/`
must come back empty.

- [ ] **Step 5: Run them to verify they pass**

Run: `npx vitest run src/tests/meeting-log-page.test.tsx && npm run check:types && npm run lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/pages/meeting-log/components/AssignDialog.tsx src/pages/meeting-log/index.tsx src/hooks/useMeetingLog.ts src/types/odoo.ts src/tests/meeting-log-page.test.tsx
git commit -m "feat(odoo): assign a queued meeting to several records from the dashboard"
```

---

### Task 15: The live Odoo check

**Files:** none — this task produces a written result, not a diff.

**Owner:** this task is assigned to the human running the pipeline. It is not optional and it is not a standing offer.

Every failure mode this feature exists to handle is an Odoo response — a `message_post` fault on target 3 of 3, a permissions refusal, an archived record. A mocked client returns whatever it is told to. **The live smoke test has now gone unrun on three consecutive PRs (#41, #43, #46), and this feature writes notes to up to five customer records per meeting instead of one — the same gap at five times the blast radius.**

> **Before starting:** back up the database. Migration 14 is one-way, and this is the first run against real queued meetings.

- [ ] **Step 1: Verify the migration on a real database**

Take a copy of a database with a non-empty queue. Confirm the app starts (`Database.load` succeeds), the queue page lists the same meetings as before, and each shows exactly one target.

- [ ] **Step 2: Log one meeting to three records**

Pick a colleague, a lead, and a client contact in the test Odoo instance. Confirm three separate notes and three separate transcript attachments, each on the right record, each an internal log note — **not** an email to the customer.

- [ ] **Step 3: Force a deterministic failure on the middle target**

Archive the second target's record in Odoo, then push. Confirm targets 1 and 3 land, target 2 shows `ODOO_FAULT`, and the row reads as partly failed rather than "Waiting to be sent".

- [ ] **Step 4: Retry the failed target**

Un-archive it, click "Retry this one". Confirm it posts, that targets 1 and 3 are **not** re-posted, and that no duplicate attachment appears on any record.

- [ ] **Step 5: Force a transport failure mid-push**

Drop the network after the first target lands. Confirm the remaining targets stay `pending`, the row carries a reason, and the next sweep resumes without duplicating the first note.

> **Manufacture every failure locally** — kill the app, drop the network, archive a record. **Never by sending bad credentials.** fail2ban on the Odoo host is `maxretry 10 / findtime 600 / bantime 3600`, so a botched retry test locks the account out for an hour. Unban: `sudo fail2ban-client set odoo-login unbanip <ip>`.

- [ ] **Step 6: Record the result**

Write what was checked, and what was found, into the PR. If a step could not be run, say which and why — an unrun step recorded as unrun is worth far more than a checkbox nobody ticked.
