# Notion Meeting Notes and Team Practices Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After a Meeting Assist recording has gone quiet for 30 minutes, Meetwings writes one Notion page per meeting into IC's Weekly Team Meetings database. The page carries the Notion AI shape, a Team Practices box and the collapsed transcript. Each practice is added to Team Knowledge as `Proposed`. All of this works with no Odoo config at all.

**Architecture:** The existing `meeting_log_queue` stays the one save-first store. Migration 17 gives each row a second, independent lane:
- **`notion_status`** holds the Notion lane. The existing `status` column stays the Odoo lane, with a new value `'none'` meaning "no Odoo destination".
- **A new `notion_sends` table** has one record per joined meeting. It owns the claim, the stored summary, the page ID and the resume progress.
- **A module-level scheduler** ticks every 60 s, starting only after `runMeetingRecovery`. It forms sends once a conversation has been silent for `MEETING_CONVERSATION_GAP_MS`, then runs them one at a time through a resumable state machine in `src/lib/notion/`.
- **Notion HTTP** goes through `tauriFetch` with the token from the OS keychain (new Rust commands). Errors are typed with fixed wording, behind a Notion-only fail-closed redactor.

**Tech Stack:** React 19 + TypeScript, Tauri 2 (Rust, `keyring` 3), SQLite via `@tauri-apps/plugin-sql`, `@tauri-apps/plugin-http`, Vitest + sql.js + Testing Library, Notion API `2025-09-03`.

**Spec:** `docs/superpowers/specs/2026-11-11-notion-meeting-notes-design.md` (read it with this plan; section numbers below are its sections).

## Global Constraints

- Notion API version header: `Notion-Version: 2025-09-03`. Base URL `https://api.notion.com/v1`. Pages are created with `parent: { type: "data_source_id", data_source_id }`.
- Limits (spec §3.3, §9):
  - at most 100 blocks per request;
  - at most 2,000 characters per rich-text item, never splitting a surrogate pair;
  - each request body at most `400_000` bytes of JSON (safety margin under Notion's 500 KB).
- Pacing: at most 180 requests a minute per token. The client spaces every call at least `NOTION_MIN_GAP_MS = 350` apart, which also keeps data-source queries under 3 a second.
- **"30 minutes" is always `MEETING_CONVERSATION_GAP_MS`** (`src/config/constants.ts:145`); don't add a second constant.
  - **Join:** gap `< MEETING_CONVERSATION_GAP_MS` joins (29:59 joins, 30:00 does not).
  - **Quiet:** `now - lastLine >= MEETING_CONVERSATION_GAP_MS`.
- Reuse `HOLD_MS` (30 s undo) and `STALE_CLAIM_MS` (5 min) from `src/lib/odoo/meeting-log.ts`. Don't copy them.
- **Team meeting time window:** `|start − teamTime| <= TEAM_TIME_WINDOW_MS = 30 * 60 * 1000`, in local minutes-of-day. An empty time matches any start that day.
- **Same meeting:** overlap `>= 0.5 × shorter duration` **and** the model agrees. Only pages whose date has an `end` and whose `start` contains `T` count. Recheck after `RECHECK_DELAY_MS = 5_000`.
- **Timeouts** (own `AbortController` timers; the timeout code comes only from that timer):
  - summary `NOTION_SUMMARY_TIMEOUT_MS = 120_000`
  - same-meeting `SAME_MEETING_TIMEOUT_MS = 30_000`
  - practices judge `PRACTICES_TIMEOUT_MS = 60_000`
  - each Notion HTTP call `NOTION_HTTP_TIMEOUT_MS = 30_000`
- **Retries:**
  - Inside one call, up to 3 tries on 429/5xx. `Retry-After` (seconds) is honoured and capped at `RETRY_AFTER_CAP_MS = 60_000`. A 429 without the header backs off 2 s, then 4 s.
  - Between attempts, `nextAt = now + max(retryAfterMs ?? 0, min(60_000 × 2^(attempts−1), 3_600_000))`.
- Summary strikes: `SUMMARY_STRIKES = 3` consecutive strike-coded failures end in `no_summary`.
- Team Knowledge property names are fixed: `Rule` (title), `Status` (status, option `Proposed`), `Topic` (select), `Meeting link` (URL). Meetwings never creates select options and never PATCHes an existing Knowledge row.
- Keychain: service `com.meetwings.notion`, account `token`.
  - **Never** write the token to the plugin store (`secureSet`), localStorage, logs, toasts, `error_code` or any thrown message.
  - On Linux the keychain is unavailable: Notion setup shows the fixed sentence and **does not** fall back to the plugin store.
- **SQL:**
  - No `BEGIN`/`COMMIT` anywhere. The guard test that scans `QUEUE_SQL` must also scan `NOTION_SQL`.
  - Migrations are never edited after release; the schema change is a new file `notion-sends.sql` at version 17.
- **Odoo absent ⇒ Odoo status `'none'`.** A row written while Odoo config is `absent` never gets `'held'`, `'pending'` or `'unassigned'`. Otherwise the Meetings page shows "Finish setting Odoo up" to a Notion-only user.
- The Notion path never reads `meeting_summaries`. Its summary is generated from the joined transcript and stored on `notion_sends.summary_json`.
- System-audio conversations (`conversation_id LIKE 'sysaudio_conv_%'`) are never Notion-bound.
- Logs carry error codes only, never meeting content, provider text or Notion response bodies.
- **User-visible copy** comes from the table in Task 6 (`NOTION_COPY`). A Notion-only user must see no string containing "Odoo".
- **Gate commands** (never the full suite: see memory "Vitest full-suite flakes"):
  - `npm run type-check`
  - `npx vitest run <the task's test files>`
  - `cargo test --manifest-path src-tauri/Cargo.toml db::` for migration registration
- **Test files** live in `src/tests/`. `tsc` doesn't type-check them, so type errors in tests surface only at runtime.
- **assumed:** spec §8.2 says live checks 1, 2 and 5 run "before building". Only Kevin holds a real token, so this plan builds code that handles **both** outcomes of each:
  - "Created by" shows the bot or the person;
  - the owner's name is readable or not;
  - `created_time` is minute-rounded or not.

  The checks run as Task 18's harness before merge, as a human gate recorded in the PR body.

## Deliberate deviations from the spec (do not "fix" back)

1. **The summary and progress live on a `notion_sends` record, not "the set's earliest row"** (spec §3.3, §5). That record's `id` **is** the earliest row's id, so it is still "carried by the earliest row" in identity. The columns stay off the Odoo table.
2. **The Notion path doesn't use the `meeting_summaries` cache** (spec §9's "new fields have to be stored and returned there too"). The Notion summary is stored on the send and reused on every retry of that send.
   - So no cached path loses the new fields.
   - A one-piece cached summary or an old field-less one can never be used for a page.
   - The spec §8.1 Summary bullets map to Task 13's tests as follows: "cache hit returns sections and practices" → *stored summary reused on retry*; "old cached summary regenerated" and "one piece not used for joined page" → *`meeting_summaries` never read*.
3. **The Meetings page shows Notion in its own section and its own badge.** Notion states don't get rows in the Odoo `BADGE_RANK`/`groupOf`, because a Notion item spans several queue rows and `QueueRow` actions are per row.
4. **Claims live on the one `notion_sends` row** (spec §5's "every row's `claimed_at` … is re-stamped"). The Odoo sweep never reads the Notion lane, so row-level claims would add writes without protecting anything.
5. **Migration row survival is proven in the sql.js harness** (spec §8.1 asks for a Rust test). `src-tauri/Cargo.toml` has no SQLite dev-dependency. The Rust test covers registration and version, as the existing ones do.
6. **`notion_token_get` returns the token to the webview, on purpose.** Spec §9 requires `plugin-http` and §7 a JS redactor. The `lib.rs:232` credential-scan comment is about Graph payload structs; the Notion commands sit in their own module with a comment saying so.

These edits are applied to the spec in the same commit as this plan: §3.3 and §5 "earliest queue row" → "send record", §9 cache bullet, §8.1 Summary/Migration bullets, §8.2 timing.

## Review Focus

1. **Database link shapes.** People paste the database link with a `?v=<view id>` query, a title slug (`Weekly-Team-Meetings-<id>`), a workspace path (`/p/<workspace>/<id>`), dashed UUIDs, or trailing whitespace. Expected: the database id is the last 32-hex run in the **path**, never the `v=` view id. Test in Task 5.
2. **Two windows act on one send.** The overlay scheduler and a dashboard Retry click hit the same send within a second. Expected: exactly one attempt runs (CAS claim), and the other returns without writing. Test in Task 3.
3. **A teammate edits the page while it's being written.** Someone adds a block to the brand-new page (or inside the toggle) before the body or transcript append finishes. Expected: the resume check sees the last existing child doesn't match the expected block, stops with `NOTION_PAGE_CHANGED`, and doesn't duplicate or interleave. Test in Task 11.
4. **Odd transcript lines.** Stored transcripts contain blank lines, a line of only whitespace, or a single 7,000-character line full of emoji. Expected: blank lines are dropped before indexing, so resume counts stay consistent. A long line becomes one block with several rich-text items, with no broken surrogate. Test in Task 10.
5. **Dangling Meeting summaries provider.** The setting names a custom provider that was later deleted. Expected: treated exactly as an empty setting (fall back to today's behaviour), never a crash and never `SUMMARY_NO_PROVIDER` while a fallback exists. Test in Task 8.

---

## File map

| File | Responsibility |
|---|---|
| `src-tauri/src/db/migrations/notion-sends.sql` | migration 17 |
| `src-tauri/src/db/main.rs`, `migration_tests.rs` | register and test v17 |
| `src-tauri/src/notion_token.rs`, `src-tauri/src/lib.rs` | keychain commands |
| `src/types/notion.ts` | Notion row and send types |
| `src/types/odoo.ts` | `'none'` status, new row columns |
| `src/lib/database/meeting-log.action.ts` | row-lane SQL changes (insert, undo, held lookup, prune, delete guards) |
| `src/lib/database/notion-queue.action.ts` | `NOTION_SQL` and send-record access |
| `src/lib/notion/destinations.ts` | who-sends-where decision (pure) |
| `src/lib/notion/join.ts` | quiet check and join sets (pure) |
| `src/lib/notion/token.ts` | invoke wrappers for the keychain |
| `src/lib/storage/notion-config.storage.ts` | Notion settings and auto-send flag |
| `src/lib/notion/redact.ts`, `src/lib/notion/errors.ts` | redactor, error types, fixed copy |
| `src/lib/notion/client.ts` | HTTP, pacing, retries, typed errors, endpoint wrappers |
| `src/lib/functions/ai-response.function.ts` | `onError`, `skipMeetwingsAPI`, `rawSystemPrompt` params |
| `src/lib/functions/summary-provider.ts` | Meeting summaries resolution |
| `src/lib/storage/secure-provider-configs.ts` | summary provider storage |
| `src/lib/functions/meeting-summarizer.ts` | uses `resolveSummaryProvider` |
| `src/lib/notion/ai.ts` | timed, classified model call |
| `src/lib/notion/summarize.ts` | Notion summary prompt and parse |
| `src/lib/notion/routing.ts`, `src/lib/notion/page-blocks.ts` | sub-table routing, block builders, chunking |
| `src/lib/notion/append.ts`, `src/lib/notion/same-meeting.ts` | resumable append, duplicate-page check |
| `src/lib/notion/knowledge.ts` | Team Knowledge read, judge and create |
| `src/lib/notion/send.ts` | the send state machine |
| `src/lib/notion/scheduler.ts` | tick and single-flight start |
| `src/lib/notion/actions.ts` | page actions (Send to Notion, Retry, Don't send) |
| `src/lib/notion/check.ts` | settings Check |
| `src/lib/odoo/meeting-log-recovery.ts`, `src/hooks/useMeetingLog.ts` | Notion-aware recovery, trigger, hold, startup |
| `src/hooks/useNotionPick.ts`, `ContactPicker.tsx`, `completion/index.tsx` | overlay Notion choice |
| `src/pages/odoo/components/NotionSettingsCard.tsx`, `src/pages/odoo/index.tsx` | Notion settings |
| `src/pages/dev/components/ai-configs/SummaryProviderCard.tsx`, `src/pages/dev/index.tsx` | Meeting summaries setting |
| `src/hooks/useNotionQueue.ts`, `src/pages/meetings/components/NotionSection.tsx`, `ConversationRow.tsx`, `src/pages/meetings/index.tsx` | Meetings page |
| `.livecheck/notion-live.live.ts`, `.livecheck/README.md` | live checks with a real token |

---

### Task 1: Migration 17 and types

**Files:**
- Create: `src-tauri/src/db/migrations/notion-sends.sql`, `src/types/notion.ts`, `src/tests/migration-17.test.ts`
- Modify: `src-tauri/src/db/main.rs` (append after version 16), `src-tauri/src/db/migration_tests.rs`, `src/types/odoo.ts:129-160`, `src/types/index.ts` (barrel, if types are re-exported there)
- Modify (schema harnesses): every test or helper that builds the current schema from a hand-listed file set. Run `grep -rln "meeting-log-queue-v2.sql\|odoo-multi-target.sql" src/tests` to find them. Today that is `meeting-log.action.test.ts`, `odoo-meeting-log-push.test.ts`, `odoo-meeting-log-sweep.test.ts`, `odoo-contacts.action.test.ts`, `overlay-meeting-targets-survive.test.tsx` and `helpers/migration-14.ts`/`migration-16.ts`. Each one appends `notion-sends.sql` after `meeting-log-queue-v2.sql`.

**Interfaces:**
- Produces (SQL), with the migration header comment listing every status value:
  ```sql
  ALTER TABLE meeting_log_queue ADD COLUMN notion_status TEXT;   -- NULL|held|offered|waiting|joined|cancelled
  ALTER TABLE meeting_log_queue ADD COLUMN notion_send_id TEXT;
  CREATE INDEX IF NOT EXISTS idx_mlq_notion ON meeting_log_queue(notion_status, conversation_id);
  CREATE INDEX IF NOT EXISTS idx_mlq_notion_send ON meeting_log_queue(notion_send_id);
  CREATE TABLE IF NOT EXISTS notion_sends (
    id TEXT PRIMARY KEY,              -- the earliest joined row's id
    conversation_id TEXT,
    status TEXT NOT NULL,             -- retry|sending|failed|no_summary|sent|already|cancelled
    span_start_at INTEGER NOT NULL, span_end_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0, summary_failures INTEGER NOT NULL DEFAULT 0,
    claimed_at INTEGER, next_at INTEGER,
    error_code TEXT, practices_error_code TEXT,
    summary_json TEXT,
    create_started_at INTEGER, page_id TEXT, page_url TEXT, page_created_time TEXT,
    lost_to_url TEXT,
    body_done INTEGER NOT NULL DEFAULT 0, toggle_block_id TEXT,
    transcript_done INTEGER NOT NULL DEFAULT 0, practices_done INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL, sent_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_notion_sends_due ON notion_sends(status, next_at);
  ```
- Produces (TS, `src/types/notion.ts`):
  - `type NotionRowStatus = "held" | "offered" | "waiting" | "joined" | "cancelled"`
  - `type NotionSendStatus = "retry" | "sending" | "failed" | "no_summary" | "sent" | "already" | "cancelled"`
  - `interface DbNotionSend` (snake_case, one field per column)
- Modifies (`src/types/odoo.ts`):
  - `MeetingLogStatus` gains `| "none"` with the comment `// no Odoo destination (Notion-only row); every Odoo query whitelists statuses, so it is invisible to them`.
  - `DbMeetingLogRow` gains `notion_status: NotionRowStatus | null; notion_send_id: string | null`.

- [ ] **Step 1: Write the failing tests**

`src/tests/migration-17.test.ts`. Build a pre-17 DB with the migration-16 helper's file list plus `meeting-log-queue-v2.sql`, insert two queue rows (one `sent`, one `held` with a target), then apply `notion-sends.sql`:
```ts
it("keeps every existing queue row and target, with an empty Notion lane", ...)
  // rows(db,"SELECT id,status,transcript FROM meeting_log_queue") deep-equals the pre-17 rows
  // every row: notion_status === null && notion_send_id === null
  // meeting_log_targets count unchanged
it("creates notion_sends with the documented columns", ...)
  // PRAGMA table_info(notion_sends) names ⊇ ["id","status","summary_json","page_id","toggle_block_id","transcript_done","practices_done","claimed_at","next_at"]
```
Rust, in `migration_tests.rs`, following `summary_backfill_migration_is_version_16_and_points_at_its_own_file`:
```rust
#[test]
fn notion_sends_migration_is_version_17_and_points_at_its_own_file() {
    // find description "create_notion_sends"; assert version == 17; assert sql == include_str!("migrations/notion-sends.sql")
}
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/tests/migration-17.test.ts`, which should fail with ENOENT for `notion-sends.sql`. Then run `cargo test --manifest-path src-tauri/Cargo.toml db::`, where the registration test should fail.

- [ ] **Step 3: Write the migration and register it** at `version: 17, description: "create_notion_sends"`. Add the new types and append the file to every schema harness listed above.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/tests/migration-17.test.ts src/tests/meeting-log.action.test.ts src/tests/odoo-meeting-log-push.test.ts src/tests/odoo-meeting-log-sweep.test.ts` plus `cargo test --manifest-path src-tauri/Cargo.toml db::` and `npm run type-check`. Expected: all PASS.

- [ ] **Step 5: Commit** `feat(notion): add migration 17 for the Notion send lane`

---

### Task 2: Row-lane SQL in `meeting-log.action.ts`

**Files:**
- Modify: `src/lib/database/meeting-log.action.ts`. The statements are `QUEUE_SQL.insert:69`, `cancelHeld:89`, `heldInWindow:148`, `deleteRow:324`, `deleteTerminalRow:347` and `prune:418`. The functions are `insertQueueRow:576`, `cancelHeldRow:763`, `findHeldRow:849` and `pruneTranscripts:1255`.
- Test: `src/tests/meeting-log.action.test.ts` (extend)

**Interfaces:**
- `NewQueueRow` gains `notionStatus: NotionRowStatus | null`, and its `status` widens to `"held" | "unassigned" | "none"`. The insert writes `notion_status`. Every existing caller passes `notionStatus: null` (grep `insertQueueRow(`).
- `cancelHeldRow(id): Promise<boolean>`: one statement cancels whichever lanes are `held`.
  ```sql
  UPDATE meeting_log_queue
     SET status        = CASE WHEN status = 'held' THEN 'cancelled' ELSE status END,
         notion_status = CASE WHEN notion_status = 'held' THEN 'cancelled' ELSE notion_status END
   WHERE id = ? AND (status = 'held' OR notion_status = 'held')
  ```
- `findHeldRow(instance: string | null, now: number): Promise<DbMeetingLogRow | null>` checks the in-window rows where `(instance = ? AND status = 'held') OR notion_status = 'held'`. A `null` instance drops the first arm.
- `promoteHeldNotionRow(id: string): Promise<boolean>`: CAS `held → waiting` on `notion_status`.
- `promoteStaleHeldNotionRows(olderThan: number): Promise<number>`: same CAS for `created_at <= olderThan`.
- Lane-open SQL fragment, exported as `NOTION_LANE_OPEN` for reuse in Task 3:
  ```sql
  (notion_status IN ('held','offered','waiting')
   OR (notion_status = 'joined' AND EXISTS (SELECT 1 FROM notion_sends s
        WHERE s.id = meeting_log_queue.notion_send_id
          AND s.status NOT IN ('sent','already','cancelled'))))
  ```
- `deleteRow` and `deleteTerminalRow` each gain `AND NOT <NOTION_LANE_OPEN>`, so a row whose Notion lane is still open is never blanked. Rewrite each WHERE clause whole, keeping the existing parentheses comments. A refused delete returns the existing `conflict` outcome.
- `prune` blanks a transcript only when **both** lanes are terminal:
  - Odoo: `status IN ('sent','cancelled','none')`;
  - Notion: `notion_status IS NULL OR notion_status = 'cancelled' OR` the row is `joined` to a send in `('sent','already','cancelled')`.
- `pruneTranscripts(now)` also runs `UPDATE notion_sends SET summary_json = NULL WHERE status IN ('sent','already','cancelled') AND summary_json IS NOT NULL AND created_at < ?`, and returns the sum of the two counts.

- [ ] **Step 1: Write the failing tests** (sql.js harness, the existing `rawExecute` seeding)
```ts
it("undo cancels a Notion-only held row (status 'none')", ...)            // cancelHeldRow → true; notion_status 'cancelled', status 'none'
it("undo cancels both lanes of a both-held row in one call", ...)        // status 'cancelled', notion_status 'cancelled'
it("findHeldRow(null, now) finds an in-window Notion held row", ...)
it("findHeldRow(instance, now) still ignores other-instance Odoo held rows", ...)
it("promoteStaleHeldNotionRows promotes only rows older than the cutoff", ...)
it("deleteRow refuses a row whose Notion lane is waiting", ...)           // returns false, transcript intact
it("deleteTerminalRow refuses an Odoo-sent row joined to a send in retry", ...)
it("prune never blanks an Odoo-sent row whose Notion lane is waiting", ...)
it("prune blanks a 'none' row joined to a sent send, and nulls that send's summary_json", ...)
it("recordErrorOnUnsent never stamps a 'none' row (Notion-only user, Odoo absent)", ...)
it("no NOTION or QUEUE statement contains BEGIN or COMMIT", ...)        // extend the existing guard over Object.values(QUEUE_SQL) to NOTION_SQL too (NOTION_SQL lands in Task 3; add the import then)
```

- [ ] **Step 2:** Run `npx vitest run src/tests/meeting-log.action.test.ts`. Expected: the new cases FAIL.
- [ ] **Step 3: Implement** the statements and signatures above.
- [ ] **Step 4:** Run `npx vitest run src/tests/meeting-log.action.test.ts src/tests/odoo-meeting-log-push.test.ts src/tests/odoo-meeting-log-sweep.test.ts src/tests/odoo-meeting-log-recovery.test.ts` and `npm run type-check`. Expected: PASS, and the existing Odoo cases are unchanged.
- [ ] **Step 5: Commit** `feat(notion): give queue rows an independent Notion lane`

---

### Task 3: Send-record SQL (`notion-queue.action.ts`)

**Files:**
- Create: `src/lib/database/notion-queue.action.ts`, `src/tests/notion-queue.action.test.ts`

**Interfaces** (all exported; `NOTION_SQL` is an `as const` object of strings):
- `listWaitingRows(): Promise<WaitingRow[]>` returns rows with `notion_status='waiting' AND notion_send_id IS NULL`, ordered by `conversation_id, transcript_start_at`.
  - `WaitingRow = { id; conversation_id: string | null; transcript_start_at; transcript_end_at; created_at }`
- `lastSpokenLineAt(conversationId: string): Promise<number | null>`:
  ```sql
  SELECT MAX(timestamp) FROM messages WHERE conversation_id = ? AND audio_source IS NOT NULL
  ```
- `conversationsWithLiveSend(staleBefore: number): Promise<Set<string>>` returns the conversation ids of sends with `status='sending' AND claimed_at > staleBefore`.
- `createSendAndLink(s: { id; conversationId: string | null; spanStartAt; spanEndAt; createdAt }, rowIds: string[]): Promise<void>`. **Write order is pinned:**
  1. `INSERT ... (status 'retry', next_at 0) ON CONFLICT(id) DO NOTHING`
  2. **always** `UPDATE meeting_log_queue SET notion_status='joined', notion_send_id=? WHERE id IN (…) AND notion_status='waiting' AND notion_send_id IS NULL`

  Step 2 runs even when step 1 inserted nothing, so a crash between them heals on the next tick.
- `claimSend(id, now, staleBefore): Promise<number | null>` is a CAS:
  ```sql
  UPDATE notion_sends SET status='sending', claimed_at=?now, attempts=attempts+1
   WHERE id=? AND ((status='retry' AND COALESCE(next_at,0) <= ?now)
                   OR (status='sending' AND claimed_at <= ?staleBefore))
  ```
  It returns the `claimed_at` written on success, `null` on a lost race.
- `restampSend(id, prevClaimedAt, now): Promise<boolean>` is a CAS on `status='sending' AND claimed_at = prevClaimedAt`. `false` means another attempt owns the send, and the caller must abort without writing.
- `patchSend(id, claimedAt, patch: SendPatch): Promise<boolean>`.
  - `SendPatch` keys are restricted to `summary_json`, `summary_failures`, `create_started_at`, `page_id`, `page_url`, `page_created_time`, `lost_to_url`, `body_done`, `toggle_block_id`, `transcript_done` and `practices_done`.
  - Columns come from a whitelist, never interpolated from caller strings.
  - CAS on `status='sending' AND claimed_at=?`.
- `finishSend(id, claimedAt, o: { status: "retry" | "failed" | "no_summary" | "sent" | "already"; errorCode?: string | null; practicesErrorCode?: string | null; nextAt?: number | null; sentAt?: number | null }): Promise<boolean>` is a CAS that also sets `claimed_at = NULL`.
- `getSend(id)`, `listDueSends(now, staleBefore): Promise<DbNotionSend[]>` (due `retry` sends and stale `sending` ones, oldest first), `readSendLines(sendId): Promise<{ lines: string[]; startAt: number; endAt: number }>`.
  - `readSendLines` reads the joined rows' `transcript` by `transcript_start_at`, splits on `\n`, and drops lines that are empty after `trim()`.
- Page actions, each a single statement returning `boolean`:
  - `retrySend(id)`: `failed|no_summary|retry → retry`, `next_at=0`, `error_code=NULL`, and `summary_failures=0` when the send was `no_summary`.
  - `cancelSend(id)`: only when `status IN ('retry','failed','no_summary') AND page_id IS NULL`.
  - `offerRowsToWaiting(rowIds)`: `offered → waiting`.
  - `cancelOfferedRows(rowIds)`: `offered|waiting → cancelled`, only while `notion_send_id IS NULL`.
  - `requeueAuthFailures()`: `failed → retry` with `next_at=0` where `error_code IN ('NOTION_UNAUTHORIZED','NOTION_NO_ACCESS','NOTION_NOT_FOUND')`.
- `listNotionItems(): Promise<NotionItem[]>` for the Meetings page:
  ```ts
  type NotionItem =
    | { kind: "rows"; conversationId: string | null; rowIds: string[]; status: "offered" | "waiting" | "held"; startAt: number; endAt: number }
    | { kind: "send"; send: DbNotionSend; rowIds: string[] };
  ```
  It covers sends of any status except `cancelled`, plus not-yet-joined `held|offered|waiting` rows grouped by conversation.

- [ ] **Step 1: Write the failing tests**
```ts
it("createSendAndLink links rows even when the send already exists (crash between insert and link)", ...)
it("createSendAndLink never relinks a row already joined to another send", ...)
it("claimSend: two concurrent claims → exactly one non-null", ...)          // Review Focus 2: Promise.all([claimSend(id,t,s), claimSend(id,t,s)])
it("claimSend refuses a retry send whose next_at is in the future", ...)
it("claimSend reclaims a sending send only once its claim is stale", ...)
it("restampSend / patchSend / finishSend refuse a stale claimedAt (zombie writer)", ...)
it("finishSend 'sent' is one statement and the lane reads closed for every joined row", ...)  // NOTION_LANE_OPEN false for all rows
it("readSendLines joins rows in time order and drops blank lines", ...)
it("retrySend resets summary_failures only for no_summary", ...)
it("cancelSend refuses a send that already has a page", ...)
it("listNotionItems groups unjoined waiting rows by conversation", ...)
```
- [ ] **Step 2:** Run `npx vitest run src/tests/notion-queue.action.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement.** Add `NOTION_SQL` to the no-transaction guard from Task 2.
- [ ] **Step 4:** Run `npx vitest run src/tests/notion-queue.action.test.ts src/tests/meeting-log.action.test.ts` and `npm run type-check`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(notion): add send-record storage with CAS claims`

---

### Task 4: Keychain commands and token wrapper

**Files:**
- Create: `src-tauri/src/notion_token.rs`, `src/lib/notion/token.ts`, `src/tests/notion-token.test.ts`
- Modify: `src-tauri/src/lib.rs` (`mod notion_token;` at `:2-9`; register the commands after `graph::graph_current_meetings` at `:240`, with the comment `// Notion token: deliberately returns the credential to the webview (spec §7/§9: plugin-http + JS redactor). Not a Graph payload; the scan above does not apply.`)

**Interfaces:**
- Rust: mirror `src-tauri/src/graph/keychain.rs`, with `SERVICE = "com.meetwings.notion"`, `ACCOUNT = "token"` and the same `#[cfg(target_os = "linux")]` split. The commands are:
  - `notion_keychain_available() -> bool`
  - `notion_token_set(token: String) -> Result<(), String>`, which trims and rejects an empty value
  - `notion_token_get() -> Result<Option<String>, String>`
  - `notion_token_clear() -> Result<(), String>`

  Error strings are fixed: `"The system keychain isn't available on this computer."` They never contain the token.
- TS (`src/lib/notion/token.ts`):
  - `isNotionKeychainAvailable(): Promise<boolean>`
  - `saveNotionToken(raw: string): Promise<void>`, which trims and throws `NotionError("NOTION_KEYCHAIN_UNAVAILABLE")` when the invoke fails
  - `loadNotionToken(): Promise<string | null>`
  - `clearNotionToken(): Promise<void>`

- [ ] **Step 1: Write the failing test** (mock `@tauri-apps/api/core` `invoke`; spy on `@/lib/secure-storage`)
```ts
it("saveNotionToken trims and stores through the keychain command only", ...)
  // invoke called with ("notion_token_set", { token: "secret_abc" }) for "  secret_abc\n"; secureSet never called; localStorage.setItem never called with the token
it("saveNotionToken surfaces a keychain failure as NOTION_KEYCHAIN_UNAVAILABLE without the token in message", ...)
it("loadNotionToken returns null when the command returns null", ...)
```
- [ ] **Step 2:** Run `npx vitest run src/tests/notion-token.test.ts`. Expected: FAIL. This task creates `src/lib/notion/errors.ts` holding only `class NotionError` and the code `NOTION_KEYCHAIN_UNAVAILABLE`; Task 6 extends that file.
- [ ] **Step 3: Implement the Rust and TS.** Run `cargo check --manifest-path src-tauri/Cargo.toml`.
- [ ] **Step 4:** Run `npx vitest run src/tests/notion-token.test.ts`, `cargo test --manifest-path src-tauri/Cargo.toml` and `npm run type-check`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(notion): store the Notion token in the OS keychain`

---

### Task 5: Notion settings storage

**Files:**
- Create: `src/lib/storage/notion-config.storage.ts`, `src/tests/notion-config.storage.test.ts`
- Modify: `src/lib/storage/index.ts` (barrel), `src/config/constants.ts` (`STORAGE_KEYS.NOTION_AUTO_SEND: "notion_auto_send"`, `STORAGE_KEYS.NOTION_PICKED: "notion_picked"`)

**Interfaces** (copy the `graph-config.storage.ts` pattern: `secureGet`/`secureSet` under `SECURE_NOTION_CONFIG_KEY = "secure_notion_config"`; this blob holds **no** token):
```ts
interface NotionConfig {
  meetingsDbUrl: string;
  knowledgeDbUrl: string;                 // "" = practices step skipped (box still written)
  teamTimes: Partial<Record<Weekday, string>>; // "HH:MM" local; missing/"" = any time that day
  yourName: string;                        // "" = use Notion name, else "You"
}
type Weekday = "monday"|"tuesday"|"wednesday"|"thursday"|"friday"|"saturday"|"sunday";
type NotionConfigState =
  | { state: "absent" }
  | { state: "incomplete"; missing: ("token" | "meetingsDbUrl")[] }
  | { state: "complete"; config: NotionConfig; meetingsDbId: string; knowledgeDbId: string | null };
function parseNotionDatabaseId(url: string): string | null; // 32 lowercase hex, no dashes
function loadNotionConfig(): Promise<NotionConfig | null>;
function saveNotionConfig(c: NotionConfig): Promise<void>;
function loadNotionConfigState(): Promise<NotionConfigState>; // token presence via loadNotionToken()
function isNotionConfigured(): Promise<boolean>;               // state === "complete"
function isNotionAutoSendEnabled(): boolean;                   // safeLocalStorage, default true
function setNotionAutoSendEnabled(on: boolean): void;
```
- `absent` means no token and no meetings link. Either one alone is `incomplete`.
- `parseNotionDatabaseId` takes the **last** run of 32 hex characters (dashes removed) in the URL **path**, ignoring the query string. It returns `null` for anything else. A dashed 8-4-4-4-12 UUID in the path also counts.

- [ ] **Step 1: Write the failing tests** (fake ids only; never put a real IC id in this public repo)
```ts
const ID = "0123456789abcdef0123456789abcdef", VIEW = "fedcba9876543210fedcba9876543210";
it.each([
  [`https://app.notion.com/p/acme/${ID}?v=${VIEW}`, ID],
  [`https://www.notion.so/acme/Weekly-Team-Meetings-${ID}?v=${VIEW}&pvs=4`, ID],
  [`https://www.notion.so/${ID}`, ID],
  [`  https://www.notion.so/acme/01234567-89ab-cdef-0123-456789abcdef \n`, ID],
  ["https://www.notion.so/acme/no-id-here", null],
  ["not a url", null],
])("parseNotionDatabaseId(%s)", (url, id) => expect(parseNotionDatabaseId(url)).toBe(id));
it("state is absent with no token and no link; incomplete lists what is missing; complete parses both ids", ...)
it("knowledgeDbId is null when the Team Knowledge link is empty", ...)
it("auto-send defaults to on and persists off", ...)
it("the stored blob never contains the token", ...)  // saveNotionConfig then inspect the secureSet mock's payload
```
- [ ] **Step 2:** Run `npx vitest run src/tests/notion-config.storage.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** Run the same test file and `npm run type-check`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(notion): add Notion settings storage`

---

### Task 6: Redactor, error types and fixed copy

**Files:**
- Create: `src/lib/notion/redact.ts`, `src/lib/notion/errors.ts`, `src/tests/notion-errors.test.ts`

**Interfaces:**
- `redact.ts`:
  - `armNotionRedactor(secrets: ReadonlyArray<string | undefined>): void`, built on `buildRedactor` from `src/lib/odoo/redact.ts`. An empty usable set leaves it unarmed, the same rule as `setOdooRedactor`.
  - `resetNotionRedactor()`, `isNotionRedactorArmed()`.
  - `redactNotion(s: string): string`, which returns `"[REDACTED]"` when unarmed.
- `errors.ts`:
  ```ts
  type NotionErrorCode =
    | "NOTION_NOT_CONFIGURED" | "NOTION_KEYCHAIN_UNAVAILABLE"
    | "NOTION_UNAUTHORIZED" | "NOTION_NO_ACCESS" | "NOTION_NOT_FOUND" | "NOTION_INVALID"
    | "NOTION_RATE_LIMITED" | "NOTION_SERVER" | "NOTION_NETWORK" | "NOTION_TIMEOUT"
    | "NOTION_PAGE_CHANGED" | "SAME_MEETING_UNDECIDED" | "PRACTICES_UNDECIDED" | "NOTION_INTERNAL";
  type SummaryErrorCode =
    | "SUMMARY_NO_PROVIDER" | "SUMMARY_TOO_SHORT"                                  // final
    | "SUMMARY_NETWORK" | "SUMMARY_RATE_LIMITED" | "SUMMARY_SPENDING_LIMIT"
    | "SUMMARY_PROVIDER_DOWN" | "SUMMARY_AUTH"                                     // retry, no strike
    | "SUMMARY_UNREADABLE" | "SUMMARY_EMPTY" | "SUMMARY_TIMEOUT" | "SUMMARY_REJECTED"; // strike
  class NotionError extends Error { code: NotionErrorCode; retryAfterMs?: number } // message = NOTION_COPY[code], never a response body
  class SummaryError extends Error { code: SummaryErrorCode }                      // message = NOTION_COPY[code]
  const SUMMARY_FINAL: ReadonlySet<SummaryErrorCode>;   // NO_PROVIDER, TOO_SHORT
  const SUMMARY_STRIKE: ReadonlySet<SummaryErrorCode>;  // UNREADABLE, EMPTY, TIMEOUT, REJECTED
  const NOTION_SHOW_AT_ONCE: ReadonlySet<NotionErrorCode>; // UNAUTHORIZED, NO_ACCESS, NOT_FOUND, INVALID, NOT_CONFIGURED, KEYCHAIN_UNAVAILABLE, PAGE_CHANGED, INTERNAL → status 'failed'
  function notionErrorText(thrown: unknown): { code: string; text: string };
  ```
  - `notionErrorText` returns the fixed copy for a `NotionError` or `SummaryError`.
  - Anything else becomes `{ code: "NOTION_INTERNAL", text: NOTION_COPY.NOTION_INTERNAL }`. Unknown error text is never shown.
  - The `console.error` line logs `redactNotion(String(message))`, which fails closed.
- `NOTION_COPY: Record<NotionErrorCode | SummaryErrorCode | "SUMMARY_STRIKES_OUT", string>`. `SUMMARY_STRIKES_OUT` is a stored `error_code` only and is never thrown. The strings below are exact and user-visible, and none contain "Odoo":

| Code | Text |
|---|---|
| `NOTION_NOT_CONFIGURED` | Notion isn't set up. Finish it in Settings > Integrations > Notion. |
| `NOTION_KEYCHAIN_UNAVAILABLE` | The system keychain isn't available on this computer, so the Notion token can't be saved. |
| `NOTION_UNAUTHORIZED` | Notion rejected your token. Paste a new one in Settings > Integrations > Notion. |
| `NOTION_NO_ACCESS` | Notion refused access. Open the database in Notion and check you have edit access. |
| `NOTION_NOT_FOUND` | Notion can't find the database. Check the link in Settings > Integrations > Notion. |
| `NOTION_INVALID` | Notion refused the page. Press Check in Settings > Integrations > Notion. |
| `NOTION_RATE_LIMITED` | Notion is busy. Trying again shortly. |
| `NOTION_SERVER` | Notion is having problems. Trying again shortly. |
| `NOTION_NETWORK` | Can't reach Notion. Trying again shortly. |
| `NOTION_TIMEOUT` | Notion took too long. Trying again shortly. |
| `NOTION_PAGE_CHANGED` | The Notion page was changed while it was being written. Check it, then press Retry. |
| `SAME_MEETING_UNDECIDED` | Checking whether a teammate already sent this meeting. Trying again shortly. |
| `PRACTICES_UNDECIDED` | The AI couldn't check the practices against Team Knowledge. Trying again shortly. |
| `NOTION_INTERNAL` | Something went wrong sending to Notion. Press Retry. |
| `SUMMARY_NO_PROVIDER` | No AI provider is set up for meeting summaries. |
| `SUMMARY_TOO_SHORT` | The meeting is too short to summarise. |
| `SUMMARY_NETWORK` | Can't reach the AI provider. |
| `SUMMARY_RATE_LIMITED` | The AI provider is busy. |
| `SUMMARY_SPENDING_LIMIT` | The shared AI key has hit its spending limit. |
| `SUMMARY_PROVIDER_DOWN` | The AI provider is having problems. |
| `SUMMARY_AUTH` | The AI provider refused the key, or its limit was reached. |
| `SUMMARY_UNREADABLE` | The AI reply couldn't be used. |
| `SUMMARY_EMPTY` | The AI sent an empty reply. |
| `SUMMARY_TIMEOUT` | The AI took too long. |
| `SUMMARY_REJECTED` | The AI provider refused the request. |
| `SUMMARY_STRIKES_OUT` | The AI gave no usable summary three times. |

Labels used with these on the Meetings page (Task 17): "Waiting for summary", "Couldn't summarise", "Already in Notion", "In Notion", "Practices not added yet", "Waiting for the meeting to end", "Sending to Notion", "Notion failed".

- [ ] **Step 1: Write the failing tests**
```ts
it("redactNotion blanks everything when unarmed", ...)   // "[REDACTED]"
it("arming with only empty strings stays unarmed", ...)
it("armed redactor removes the token and the AI key from 401, 429 and 5xx bodies", ...)
  // body = `{"message":"API token secret_ntn_XYZ is invalid","request":{"Authorization":"Bearer secret_ntn_XYZ"}}`, also "sk-or-v1-KEY"
it("notionErrorText never returns raw text for an unknown Error", ...)  // new Error("secret_ntn_XYZ leaked") → text === NOTION_COPY.NOTION_INTERNAL
it("every NOTION_COPY string is free of the word Odoo", ...)
```
- [ ] **Step 2:** Run `npx vitest run src/tests/notion-errors.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** Run `npx vitest run src/tests/notion-errors.test.ts src/tests/odoo-redact.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(notion): add Notion redactor, error codes and copy`

---

### Task 7: Notion HTTP client

**Files:**
- Create: `src/lib/notion/client.ts`, `src/tests/notion-client.test.ts`

**Interfaces:**
```ts
interface NotionClientDeps { token: string; fetch?: typeof tauriFetch; now?: () => number; sleep?: (ms: number) => Promise<void> }
interface NotionClient {
  request<T>(method: "GET"|"POST"|"PATCH", path: string, body?: unknown): Promise<T>; // path starts with "/v1/"
  me(): Promise<{ id: string; ownerUserId: string | null }>;              // GET /v1/users/me → bot.owner.user.id
  userName(id: string): Promise<string | null>;                          // GET /v1/users/{id}; 403/404 → null
  database(id: string): Promise<{ dataSources: { id: string; name: string }[] }>;
  dataSource(id: string): Promise<{ id: string; name: string; properties: Record<string, NotionProperty> }>;
  queryAll(dataSourceId: string, body: object): Promise<NotionPage[]>;   // follows next_cursor, page_size 100
  createPage(body: object): Promise<NotionPage>;
  listChildren(blockId: string): Promise<NotionBlock[]>;                 // follows next_cursor, page_size 100
  appendChildren(blockId: string, children: NotionBlockInput[]): Promise<NotionBlock[]>;
  trashPage(pageId: string): Promise<void>;                              // PATCH /v1/pages/{id} { in_trash: true }
}
function createNotionClient(deps: NotionClientDeps): NotionClient;
```
`NotionPage`, `NotionBlock`, `NotionProperty` and `NotionBlockInput` are minimal structural types in `client.ts`, holding only the fields later tasks read: `id`, `url`, `created_time`, `created_by.id`, `properties`, `type` and the block's `rich_text`.

How `request` behaves:
- **Pacing:** a module-level promise chain keeps each send at least `NOTION_MIN_GAP_MS` after the previous one, per client.
- **Timeout:** an `AbortController` timer of `NOTION_HTTP_TIMEOUT_MS`. An abort becomes `NOTION_TIMEOUT`.
- **Status mapping:**
  - 401 → `NOTION_UNAUTHORIZED`
  - 403 → `NOTION_NO_ACCESS`
  - 404 → `NOTION_NOT_FOUND`
  - 400/409/422 → `NOTION_INVALID`
  - 429 → retry
  - 5xx → retry
  - any thrown fetch → `NOTION_NETWORK`
- **Retries:** up to 3 tries on 429/5xx with the waits in Global Constraints. After the last 429, throw `NotionError("NOTION_RATE_LIMITED")` with `retryAfterMs` set to the last header value (capped). After the last 5xx, throw `NOTION_SERVER`.
- The response body is read only to parse JSON on success. Error bodies are never put in a message.

- [ ] **Step 1: Write the failing tests** (inject a fake `fetch` returning `{ ok, status, headers: new Headers(...), json, text }`, and a fake `sleep` that records waits)
```ts
it("sends Authorization Bearer and Notion-Version 2025-09-03", ...)
it("honours Retry-After seconds, capped at 60 s", ...)               // header "120" → sleep(60_000)
it("backs off 2 s then 4 s on a 429 without Retry-After, then throws NOTION_RATE_LIMITED", ...)
it("a 429 that then succeeds returns the body, no error", ...)
it("401 and 403 throw at once with no retry", ...)                  // fetch called once
it("an error body echoing the token never reaches the thrown message", ...)
it("spaces consecutive calls at least 350 ms apart", ...)           // fake now/sleep
it("queryAll follows next_cursor until has_more is false", ...)
it("me() returns the bot id and bot.owner.user.id", ...)
```
- [ ] **Step 2:** Run `npx vitest run src/tests/notion-client.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** Run the same test file and `npm run type-check`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(notion): add paced Notion client with typed errors`

---

### Task 8: AI plumbing and the Meeting summaries setting

**Files:**
- Modify:
  - `src/lib/functions/ai-response.function.ts`: the params at `:172-185`, every error `yield` (`:336`, `:347`, the in-stream `API error:` yield, `Failed to parse non-streaming response`, `Streaming not supported…`, `Error reading stream`), and `fetchMeetwingsAIResponse`'s `Meetwings API Error` yield
  - `src/lib/storage/secure-provider-configs.ts`
  - `src/lib/functions/meeting-summarizer.ts:321-402`
- Create: `src/lib/functions/summary-provider.ts`, `src/tests/summary-provider.test.ts`, `src/tests/ai-response.on-error.test.ts`

**Interfaces:**
- `fetchAIResponse` params gain three optional fields:
  - `onError?: (e: AIErrorInfo) => void`
  - `skipMeetwingsAPI?: boolean`, which bypasses the `shouldUseMeetwingsAPI()` reroute
  - `rawSystemPrompt?: boolean`, which skips `buildEnhancedSystemPrompt`: no Context Memory, no response-length or language prompts. That keeps Context Memory (which can hold personal detail) out of the practices, duplicate and same-meeting calls.

  ```ts
  type AIErrorInfo = { kind: "http"; status: number } | { kind: "network" } | { kind: "stream" } | { kind: "meetwings" };
  ```
  `onError` is called immediately before each existing error `yield`. The yields themselves are unchanged, so existing callers see no difference.
- In `secure-provider-configs.ts`:
  - `loadSummaryProvider(): Promise<{ provider: string; variables: Record<string,string> } | null>`
  - `saveSummaryProvider(v: { provider: string; variables: Record<string,string> } | null): Promise<void>`

  Both use the key `secure_summary_provider` through `secureGet`/`secureSet`.
- `summary-provider.ts` moves `ProviderConfig` here and exports it. `meeting-summarizer.ts` and `useMeetingLog.ts:37` import it instead of their local copies.
  ```ts
  type ResolvedSummaryProvider =
    | { kind: "override"; config: ProviderConfig }   // Meeting summaries setting, found in AI_PROVIDERS ∪ getCustomAiProviders()
    | { kind: "meetwings" }
    | { kind: "chat"; config: ProviderConfig }
    | { kind: "none" };
  function resolveSummaryProvider(fallback?: ProviderConfig): Promise<ResolvedSummaryProvider>;
  function summarySecrets(r: ResolvedSummaryProvider): string[]; // values of variables whose key matches /key|token|secret/i, length >= 6
  ```
  - **Order:** override, then (`shouldUseMeetwingsAPI()` → meetwings), then fallback → chat, then none.
  - A stored override whose provider id no longer exists is treated as unset.
- `ensureMeetingSummary` replaces its `useMeetwingsAPI`/`providerConfig` block with `resolveSummaryProvider(providerConfig)`:
  - `none` → return `null`;
  - `override` → pass `skipMeetwingsAPI: true`.

  The prompt, the return shape and the cache logic are unchanged. That is what makes the Context Memory caller (`useCompletion.ts:1441`) safe; check it and the other four callers by reading them, not by editing them.

- [ ] **Step 1: Write the failing tests**
```ts
// ai-response.on-error.test.ts (mock plugin-http fetch + shouldUseMeetwingsAPI)
it.each([
  [{ status: 429, ok: false }, { kind: "http", status: 429 }],
  [{ status: 402, ok: false }, { kind: "http", status: 402 }],
  ["throws", { kind: "network" }],
  ["sse error event", { kind: "stream" }],
])("onError reports %s before yielding the same error text as today", ...)
it("rawSystemPrompt sends the system prompt verbatim (no context memory)", ...) // getContextForInjection mocked to "MEMORY"; body excludes "MEMORY"
it("skipMeetwingsAPI uses the given provider even when the Meetwings API is on", ...)
// summary-provider.test.ts
it("override beats the Meetwings API and the chat provider", ...)
it("empty override → meetwings when enabled, else chat, else none", ...)
it("an override naming a deleted custom provider is treated as unset", ...)    // Review Focus 5
it("ensureMeetingSummary calls fetchAIResponse with the override and skipMeetwingsAPI", ...)
it("summarySecrets returns the api key and not the model name", ...)
```
- [ ] **Step 2:** Run `npx vitest run src/tests/ai-response.on-error.test.ts src/tests/summary-provider.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** Run `npx vitest run src/tests/ai-response.on-error.test.ts src/tests/summary-provider.test.ts src/tests/ensure-meeting-summary.test.ts src/tests/ai-response.stream-error.test.ts src/tests/ai-response.responded-model.test.ts` and `npm run type-check`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(summaries): add the Meeting summaries provider and typed AI errors`

---

### Task 9: Timed model call and the Notion summary

**Files:**
- Create: `src/lib/notion/ai.ts`, `src/lib/notion/summarize.ts`, `src/tests/notion-summarize.test.ts`

**Interfaces:**
```ts
// ai.ts
interface NotionAi { ask(systemPrompt: string, userMessage: string, timeoutMs: number): Promise<string> }
function createNotionAi(r: ResolvedSummaryProvider, fetchImpl = fetchAIResponse): NotionAi;
// summarize.ts
interface NotionSummary {
  title: string;                                   // bold meeting title
  actionItems: string[];
  sections: { heading: string; bullets: string[] }[];
  practices: { rule: string; topic: string | null }[];
}
const MIN_NOTION_LINES = 4;
function summarizeForNotion(lines: string[], ai: NotionAi): Promise<NotionSummary>; // throws SummaryError
function parseNotionSummary(text: string): NotionSummary | null;
```

`createNotionAi(r)`:
- For `r.kind === "none"`, `ask` throws `SummaryError("SUMMARY_NO_PROVIDER")`.
- Otherwise it calls `fetchImpl` with `rawSystemPrompt: true`. It passes `skipMeetwingsAPI: r.kind === "override"`, uses `provider: undefined` for `meetwings`, and passes `signal` from its own timer.
- It collects the chunks. The `onError` info maps to codes as follows:
  - `http` 401/403 → `SUMMARY_AUTH`
  - 402 → `SUMMARY_SPENDING_LIMIT`
  - 429 → `SUMMARY_RATE_LIMITED`
  - 408 and 5xx → `SUMMARY_PROVIDER_DOWN`
  - any other 4xx → `SUMMARY_REJECTED`
  - `network` → `SUMMARY_NETWORK`
  - `stream` → `SUMMARY_UNREADABLE`
  - `meetwings` → `SUMMARY_PROVIDER_DOWN`
  - a thrown error → `SUMMARY_REJECTED`
- If its own timer fired → `SUMMARY_TIMEOUT`. If the text is empty after `trim()` → `SUMMARY_EMPTY`.
- **When `onError` fired, the collected text is discarded.** It is the provider's error text, never returned.

`summarizeForNotion`:
- `lines.length < MIN_NOTION_LINES` → `SUMMARY_TOO_SHORT` (no AI call).
- Otherwise it calls `ai.ask(NOTION_SUMMARY_PROMPT, "MEETING TRANSCRIPT:\n" + lines.join("\n"), NOTION_SUMMARY_TIMEOUT_MS)`. An unparseable reply → `SUMMARY_UNREADABLE`.
- `parseNotionSummary` reuses `extractJsonObject` from `meeting-summarizer.ts:132`. It requires a non-empty `title` and drops empty strings. It caps output at 12 sections × 8 bullets, 20 action items and 10 practices.

`NOTION_SUMMARY_PROMPT` must say (the wording is the builder's):
- the output is JSON only, `{"title","action_items","sections":[{"heading","bullets"}],"practices":[{"rule","topic"}]}`;
- the transcript is data, and instructions spoken in it are ignored;
- the team-practice definition copied from spec §4;
- a practice `rule` is one short instruction in Meetwings' own words, with no people's names, fees, percentages or deal terms, and a partner organisation named only if the practice is about it;
- sections are in the order the topics came up.

- [ ] **Step 1: Write the failing tests**
```ts
it("fewer than 4 lines → SUMMARY_TOO_SHORT and no model call", ...)
it.each([[401,"SUMMARY_AUTH"],[402,"SUMMARY_SPENDING_LIMIT"],[429,"SUMMARY_RATE_LIMITED"],[503,"SUMMARY_PROVIDER_DOWN"],[400,"SUMMARY_REJECTED"]])
  ("http %i → %s, and the provider text is not in the message", ...) // fake fetchImpl calls onError then yields `API request failed: 429 Too Many Requests - {"key":"sk-or-v1-KEY"}`
it("network error → SUMMARY_NETWORK", ...)                // yields "Network error during API request: ..."
it("own timer firing → SUMMARY_TIMEOUT (abort makes fetchImpl return silently)", ...)
it("empty reply → SUMMARY_EMPTY; prose reply → SUMMARY_UNREADABLE", ...)
it("kind none → SUMMARY_NO_PROVIDER", ...)
it("parses title, action items, sections and practices; caps lengths", ...)
it("passes rawSystemPrompt: true and skipMeetwingsAPI only for override", ...)
```
- [ ] **Step 2:** Run `npx vitest run src/tests/notion-summarize.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** Run the same test file and `npm run type-check`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(notion): add the Notion summary with typed failures`

---

### Task 10: Routing and page blocks

**Files:**
- Create: `src/lib/notion/routing.ts`, `src/lib/notion/page-blocks.ts`, `src/tests/notion-routing.test.ts`, `src/tests/notion-page-blocks.test.ts`

**Interfaces:**
```ts
// routing.ts
interface SubTable { dataSourceId: string; name: string; titleProp: string; dateProp: string; recordedByProp: string | null }
interface Mapping { byWeekday: Partial<Record<Weekday, SubTable>>; other: SubTable }
function describeSubTable(ds: { id: string; name: string; properties: Record<string, NotionProperty> }): SubTable | null;
  // titleProp = the property of type "title"; dateProp = "Date" if a date property has that name, else "Meeting Date", else the first date property; recordedByProp = a "people" property named "Recorded by" (case-insensitive) or null; null when no title or date property
function buildMapping(subTables: SubTable[]): Mapping | null;
  // weekday ← sub-table whose name starts with the weekday name (case-insensitive); other ← name starting "Other", else the first sub-table; null when subTables is empty
function routeMeeting(startAt: number, m: Mapping, teamTimes: NotionConfig["teamTimes"], aiTitle: string):
  { subTable: SubTable; title: string };
  // weekday sub-table only if within TEAM_TIME_WINDOW_MS of its team time (or time empty) → title `${Weekday} Meeting` (e.g. "Monday Meeting"); else other → aiTitle
function describeMapping(m: Mapping): string; // "Monday → Monday Meetings, Wednesday → Wednesday Meetings, other days → Other Meetings"
// page-blocks.ts
function buildPageBlocks(s: NotionSummary): NotionBlockInput[];          // spec §3.3 items 1–11, toggle LAST, toggle has no children
function transcriptBlocks(lines: string[], youName: string): NotionBlockInput[]; // one paragraph per line; leading "You: " → `${youName}: `
function splitRichText(text: string, max = 2000): string[];              // never splits a surrogate pair; "" → []
function batchBlocks(blocks: NotionBlockInput[], maxBlocks = 100, maxBytes = 400_000): NotionBlockInput[][];
function pageProperties(r: { subTable: SubTable; title: string }, startAt: number, endAt: number, ownerUserId: string | null): object;
  // title prop; date prop { date: { start: ISO, end: ISO } }; recordedByProp → { people: [{ id: ownerUserId }] } only if both non-null
```
These are the exact block types `buildPageBlocks` emits, in order:
1. `table_of_contents`
2. `heading_2` "Agenda"
3. a `bulleted_list_item` per section heading
4. `divider`
5. `heading_2` "Meeting Notes"
6. a `paragraph` with the title as bold rich text
7. a `callout` (only if there are practices), with icon emoji 📌, `color: "yellow_background"`, bold rich text "Team Practices", and children: one `bulleted_list_item` per rule
8. `heading_3` "Action Items", then a `to_do` per item (`checked: false`)
9. `divider`
10. per section, a `heading_3` and then its bullets
11. `divider`
12. `toggle` "Transcript"

- [ ] **Step 1: Write the failing tests**
```ts
// routing: table-driven over (weekday, start time, team time) — includes 08:30 vs 09:00 (in), 08:29 (out), empty time (in), Tuesday (other), no "Other" sub-table (first)
it.each(ROUTING_CASES)("%s routes to %s titled %s", ...)
it("describeSubTable picks Meeting Date in Other and finds a Recorded by people column", ...)
it("describeMapping reads like the settings sentence", ...)
// page-blocks
it("emits the §3.3 order with the toggle last and no callout when there are no practices", ...)
it("splitRichText: 2000 chars → 1 item, 2001 → 2", ...)
it("splitRichText never splits a surrogate pair at the boundary", ...)   // 1999 'a' + "😀" → items[0].length === 1999
it("a 7,000-char emoji line becomes ONE paragraph with several rich-text items", ...) // Review Focus 4
it("batchBlocks: 100 → 1 batch, 101 → 2, 1,050 → 11, and no batch exceeds 400,000 bytes", ...)
it("transcriptBlocks replaces a leading 'You: ' only, keeps 'Guest: '", ...)
it("pageProperties writes a datetime range and Recorded by only when both exist", ...)
```
- [ ] **Step 2:** Run `npx vitest run src/tests/notion-routing.test.ts src/tests/notion-page-blocks.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** Run the same test files. Expected: PASS.
- [ ] **Step 5: Commit** `feat(notion): add sub-table routing and page block builders`

---

### Task 11: Resumable append and same-meeting check

**Files:**
- Create: `src/lib/notion/append.ts`, `src/lib/notion/same-meeting.ts`, `src/tests/notion-append.test.ts`, `src/tests/notion-same-meeting.test.ts`

**Interfaces:**
```ts
// append.ts
function appendResumable(client: NotionClient, parentId: string, blocks: NotionBlockInput[],
  onBatch: () => Promise<void>): Promise<NotionBlock[]>; // returns all children after the append
```
How it resumes:
- `existing = await client.listChildren(parentId)`.
- If `existing.length > blocks.length`, or the plain text of `existing.at(-1)` differs from that of `blocks[existing.length-1]`, it throws `NotionError("NOTION_PAGE_CHANGED")`. The comparison uses the block type plus the concatenated `rich_text[].plain_text`/`text.content`.
- Otherwise it appends `blocks.slice(existing.length)` via `batchBlocks`, calling `onBatch()` (the claim re-stamp) after each batch.

```ts
// same-meeting.ts
interface Candidate { pageId: string; url: string; createdTime: string; createdById: string | null;
  recordedByIds: string[]; start: number; end: number; boldTitle: string; headings: string[] }
function overlapEnough(a: {start:number;end:number}, b: {start:number;end:number}): boolean; // overlap >= 0.5 × min duration
function readCandidates(client: NotionClient, subTables: SubTable[], startAt: number, endAt: number): Promise<Candidate[]>;
  // queryAll on every sub-table, filter date on_or_after start−24h AND on_or_before end+24h; keep pages whose date has `end` and `start` contains "T" and overlapEnough; then listChildren to extract boldTitle (first all-bold paragraph after the "Meeting Notes" heading_2) and headings (heading_3 texts except "Action Items")
function isOwnPage(c: Candidate, me: { id: string; ownerUserId: string | null }): boolean; // createdById ∈ {me.id, ownerUserId} or recordedByIds ∋ ownerUserId
function sameMeeting(ai: NotionAi, c: Candidate, s: NotionSummary): Promise<boolean>;
  // one ask(SAME_MEETING_PROMPT, …, SAME_MEETING_TIMEOUT_MS), reply JSON {"same": boolean}; any SummaryError or unparsable reply → throw NotionError("SAME_MEETING_UNDECIDED")
function pickWinner(pages: { pageId: string; createdTime: string }[]): string; // earliest createdTime, tie → lowest pageId (string compare)
```

- [ ] **Step 1: Write the failing tests** (fake `NotionClient` object; fake `NotionAi`)
```ts
// append
it("appends everything when the parent is empty, calling onBatch per batch", ...)
it("a failure at batch 3 resumes at batch 3 with no duplicate lines", ...)
it("a batch whose response was lost (children exist) is not appended twice", ...)
it("a last child that doesn't match → NOTION_PAGE_CHANGED, nothing appended", ...) // Review Focus 3
// same-meeting
it("overlap exactly half → true; just under → false; one range inside another → true", ...)
it("an all-day page and a page without end are ignored", ...)
it("a match in a different sub-table is found", ...)
it("overlapping ranges the AI calls different → not same", ...)
it("AI failure → SAME_MEETING_UNDECIDED (never a guess)", ...)
it("pickWinner: equal created_time → lowest page id", ...)
it("isOwnPage matches the bot id, the owner id, or Recorded by", ...)
```
- [ ] **Step 2:** Run `npx vitest run src/tests/notion-append.test.ts src/tests/notion-same-meeting.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** Run the same test files. Expected: PASS.
- [ ] **Step 5: Commit** `feat(notion): add resumable append and same-meeting check`

---

### Task 12: Team Knowledge

**Files:**
- Create: `src/lib/notion/knowledge.ts`, `src/tests/notion-knowledge.test.ts`

**Interfaces:**
```ts
interface KnowledgeDb { dataSourceId: string; topicOptions: string[]; hasProposed: boolean;
  rules: { rule: string; meetingLink: string | null }[] }
function readKnowledge(client: NotionClient, knowledgeDbId: string): Promise<KnowledgeDb>;
  // database → first data source; dataSource → Topic select options, Status status options; queryAll → Rule title text + Meeting link url (every Status)
function addPractices(client: NotionClient, ai: NotionAi, db: KnowledgeDb, practices: NotionSummary["practices"],
  pageUrl: string, onRow: () => Promise<void>): Promise<void>;
```
How `addPractices` decides what to write:
1. It drops practices whose normalised rule (lowercase, collapsed whitespace, trailing punctuation removed) equals that of a row whose `meetingLink === pageUrl`. These are rows this send already added.
2. It drops exact normalised duplicates of any existing rule.
3. For whatever remains, it makes one `ai.ask(PRACTICES_PROMPT, …, PRACTICES_TIMEOUT_MS)` with the candidates, every existing rule and `topicOptions`. The reply is a JSON array `[{ "index": n, "duplicate": boolean, "topic": string | null }]`. An unparsable reply or a `SummaryError` → `NotionError("PRACTICES_UNDECIDED")`.
4. For each non-duplicate, it calls `createPage` with `parent: { type: "data_source_id", data_source_id }` and these properties:
   - `Rule` as title;
   - `Status: { status: { name: "Proposed" } }`;
   - `Topic: { select: { name } }`, only when the topic is in `topicOptions`, case-insensitive and normalised to the option's spelling;
   - `Meeting link: { url: pageUrl }`.

   It calls `onRow()` after each create.
- If `!db.hasProposed`, it throws `NotionError("NOTION_INVALID")` before writing anything.
- It never calls `request` with PATCH, and never touches the `Source meeting` relation.

- [ ] **Step 1: Write the failing tests**
```ts
it("rows the model marks duplicate are skipped", ...)
it("a retry skips rules already added with this page's Meeting link, without asking the model about them", ...)
it("Status is always { status: { name: 'Proposed' } }", ...)
it("an unknown topic is omitted; no request ever creates a select option", ...)
it("never PATCHes or edits existing rows", ...)                  // fake client records every call; none is PATCH
it("missing Proposed option → NOTION_INVALID and nothing written", ...)
it("model failure → PRACTICES_UNDECIDED and nothing written", ...)
```
- [ ] **Step 2:** Run `npx vitest run src/tests/notion-knowledge.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** Run the same test file. Expected: PASS.
- [ ] **Step 5: Commit** `feat(notion): propose team practices in Team Knowledge`

---

### Task 13: The send state machine

**Files:**
- Create: `src/lib/notion/send.ts`, `src/tests/notion-send.test.ts`

**Interfaces:**
```ts
interface NotionSendDeps {
  now: () => number; sleep: (ms: number) => Promise<void>;
  client: NotionClient; ai: NotionAi;
  state: Extract<NotionConfigState, { state: "complete" }>;
}
type SendOutcome = "sent" | "already" | "retry" | "failed" | "no_summary" | "lost-claim" | "not-claimed";
function runNotionSend(sendId: string, deps: NotionSendDeps): Promise<SendOutcome>;
function buildSendDeps(fallback?: ProviderConfig): Promise<NotionSendDeps | { error: NotionErrorCode }>;
  // loadNotionConfigState complete? else NOTION_NOT_CONFIGURED; loadNotionToken; resolveSummaryProvider(fallback);
  // armNotionRedactor([token, ...summarySecrets(resolved)]); createNotionClient; createNotionAi
```
`runNotionSend` runs these steps in order. Every step after the claim uses the claim's `claimedAt`. A refused `restampSend`, `patchSend` or `finishSend` makes the function return `"lost-claim"` at once, with no further writes.

0. **Claim:** `claimSend(id, now, now − STALE_CLAIM_MS)`. A `null` claim → `"not-claimed"`.
1. **Summary:**
   - If `summary_json` is present, reuse it and make no AI call.
   - Otherwise call `readSendLines` → `summarizeForNotion`, then `patchSend({ summary_json, summary_failures: 0 })`.
   - On a `SummaryError`:
     - a final code → `finishSend('no_summary', code)`;
     - a strike code → increment `summary_failures`; once it reaches `SUMMARY_STRIKES`, `finishSend('no_summary', 'SUMMARY_STRIKES_OUT')`, otherwise `retry`;
     - any other code → `retry`.

   No page is created on any of these paths.
2. **Me:** `client.me()`, then the recorder name: `config.yourName`, else `client.userName(ownerUserId)`, else `"You"`.
3. **Mapping:** `database(meetingsDbId)` → `dataSource` each → `describeSubTable` → `buildMapping`. A `null` mapping → `NOTION_INVALID`.
4. **Find or create:**
   - If `page_id` is set, skip to 5.
   - Otherwise call `readCandidates`.
   - If `create_started_at` is set, adopt the first candidate where `isOwnPage`: `patchSend({ page_id, page_url, page_created_time })` and go to 5.
   - Otherwise check each non-own candidate with `sameMeeting`. On a match: `patchSend({ lost_to_url: candidate.url })`, then `finishSend('already')`. **No** page is written. The Meetings page reads the link from `lost_to_url`.
   - With no match:
     - `patchSend({ create_started_at: now })`;
     - `createPage` with `pageProperties` and the first `≤100` blocks of `buildPageBlocks`;
     - `patchSend({ page_id, page_url, page_created_time })` immediately.
5. **Body:** while `!body_done`, run `appendResumable(page_id, allBodyBlocks)` with the page as parent, then `patchSend({ body_done: 1, toggle_block_id })`. The toggle id is the last child whose type is `toggle`.
6. **Recheck:**
   - Skipped when `lost_to_url` is already set; in that case go straight to the trash step.
   - Otherwise `sleep(RECHECK_DELAY_MS)` → `readCandidates`.
   - Any other `isOwnPage` candidate (not `page_id`) is an orphan from a create whose response was lost and that the query hadn't shown yet. Trash it; it is never a competitor.
   - The set is this page plus every non-own candidate passing `sameMeeting` → `pickWinner`.
   - If this page didn't win: `patchSend({ lost_to_url })`, then `trashPage(page_id)`, then `finishSend('already')`.
   - A trash failure → `retry` (the next attempt goes straight to the trash step). The loser never runs step 7.
7. **Transcript and practices, independently.** Each is in its own try/catch, and the error of each is kept.
   - **(a)** If `!transcript_done`, run `appendResumable(toggle_block_id, transcriptBlocks(lines, name))`, then `patchSend({ transcript_done: 1 })`.
   - **(b)** If `!practices_done`:
     - with no practices or a null `knowledgeDbId`, just mark it done;
     - otherwise `readKnowledge` → `addPractices`, then `patchSend({ practices_done: 1 })`.
8. **Finish:**
   - Both done → `finishSend('sent', sentAt: now)`.
   - Else the outcome is `failed` if either error's code is in `NOTION_SHOW_AT_ONCE`, otherwise `retry` with `nextAt` from Global Constraints.
   - `practicesErrorCode` gets the practices error's code. `errorCode` gets the transcript error's code, else the practices one.

Every `onBatch`/`onRow`, and the point before each AI call, calls `restampSend`. Any thrown non-`NotionError`/`SummaryError` is logged through `redactNotion` and finishes `retry` with `NOTION_INTERNAL`. It never throws to the caller.

- [ ] **Step 1: Write the failing tests** (sql.js harness from Task 3, plus a fake client and AI)
```ts
it("a retryable summary failure → retry, 'Waiting for summary' code, no page created", ...)
it("three strike failures in a row → no_summary SUMMARY_STRIKES_OUT; a fourth tick does not call the model", ...)
it("SUMMARY_NO_PROVIDER and SUMMARY_TOO_SHORT → no_summary at once", ...)
it("retry after the cause is fixed: retrySend → next run summarises and sends", ...)
it("the stored summary is reused on every retry (model called once across a transcript failure + retry)", ...)
it("the Notion path never reads meeting_summaries", ...)          // spy getMeetingSummaryByConversation: not called
it("someone else's matching page → already, no page, no practices", ...)
it("race: equal created_time, our id higher → we trash ours, finish already, never add practices", ...)
it("race loser whose trash call fails → retry, and the next run trashes without re-creating", ...)
it("an orphan own page from a lost create (invisible at step 4) is trashed at the recheck, not treated as a rival", ...)
it.each(["after create, before page_id saved", "after page_id saved", "after body", "mid-transcript", "mid-practices"])
  ("crash %s → the next run adopts its own page instead of skipping it", ...)
it("transcript failure does not stop practices, and vice versa; send stays open until both", ...)
it("a 401 during the transcript → failed at once with NOTION_UNAUTHORIZED", ...)
it("a lost claim mid-send stops all further writes", ...)        // restampSend → false
it("all joined rows read closed only when the send is sent", ...) // NOTION_LANE_OPEN before/after
it("the AI key and the token never appear in error_code or practices_error_code", ...)
```
- [ ] **Step 2:** Run `npx vitest run src/tests/notion-send.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** Run the same test file and `npm run type-check`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(notion): add the resumable Notion send`

---

### Task 14: Scheduler and page actions

**Files:**
- Create: `src/lib/notion/join.ts`, `src/lib/notion/scheduler.ts`, `src/lib/notion/actions.ts`, `src/tests/notion-scheduler.test.ts`

**Interfaces:**
```ts
// join.ts (pure)
function joinSets(rows: WaitingRow[]): WaitingRow[][];
  // per conversation_id (null ids: each row its own set), sorted by start; a row joins the previous set iff start − prevEnd < MEETING_CONVERSATION_GAP_MS
function isQuiet(lastLineAt: number, now: number): boolean; // now − lastLineAt >= MEETING_CONVERSATION_GAP_MS
// scheduler.ts
interface SchedulerDeps { now: () => number; liveLastLineAt: (conversationId: string) => number | null;
  fallbackProvider: () => ProviderConfig | undefined }
const NOTION_TICK_MS = 60_000;
function runNotionTick(deps: SchedulerDeps): Promise<void>;
function ensureNotionScheduler(deps: SchedulerDeps): void; // module-level single flight: first call runs a tick and starts setInterval; later calls only replace deps
function resetNotionSchedulerForTests(): void;
// actions.ts (used by the Meetings page; none touches Odoo config)
function sendConversationToNotion(conversationId: string, now: number): Promise<"queued" | "already" | "active" | "empty" | "not-configured" | "system-audio">;
function sendRowsToNotion(rowIds: string[]): Promise<void>;       // offerRowsToWaiting + kick a tick
function retryNotionSend(sendId: string): Promise<void>;          // retrySend + kick a tick
function dontSendToNotion(item: NotionItem): Promise<boolean>;    // cancelOfferedRows or cancelSend
```
`runNotionTick` steps:
1. Return unless `isNotionConfigured()`.
2. `promoteStaleHeldNotionRows(now − HOLD_MS)`.
3. `live = conversationsWithLiveSend(now − STALE_CLAIM_MS)`.
4. For each set from `joinSets(listWaitingRows())`:
   - skip it if its conversation is in `live`;
   - `last = max(lastSpokenLineAt(conv) ?? 0, deps.liveLastLineAt(conv) ?? 0, max row end)`;
   - if `isQuiet(last, now)`, call `createSendAndLink`. Its id is the earliest row's id and its span is the set's min start and max end.
5. For each `listDueSends`, run sequentially: `buildSendDeps(deps.fallbackProvider())`, then `runNotionSend`. If `buildSendDeps` returns an error, stop the tick.

The tick takes a module-level in-flight lock, so overlapping ticks join instead of running twice.

`sendConversationToNotion`:
- It returns `system-audio` for `sysaudio_conv_%` ids, and `active` for the active or capturing conversation (the same checks as `enqueueConversation`).
- If the conversation has queue rows that are not `cancelled`/`deleted` and whose `notion_status` is NULL or `offered`, they become `waiting`.
- Otherwise it segments `readConversationTranscript` by `MEETING_CONVERSATION_GAP_MS` and inserts rows with `status: 'none'` and `notionStatus: 'waiting'`. The session key is `notion:${conversationId}:${startAt}:${now}`, and the instance is `""`.
- A conversation whose Notion lane is already open or sent → `already`.

- [ ] **Step 1: Write the failing tests**
```ts
it("joinSets: 29:59 gap joins, 30:00 does not; different conversations never join", ...)
it("cancelled rows and rows not bound for Notion are never in a set", ...) // listWaitingRows only
it("flap flush at minute 10 + 40 min of unbroken talk → nothing until 30 min after the last spoken line", ...)
  // rows: one at 0–10 min; messages through minute 50; ticks at 45, 79, 80 → send created only at 80
it("live transcript keeps a conversation open even with no new saved messages", ...)
it("a conversation with a live sending send is skipped", ...)
it("stale held Notion rows are promoted to waiting", ...)
it("ensureNotionScheduler starts once however many times it is called", ...)
it("a restart mid-meeting: recovered rows join the pre-crash rows into one send", ...)
it("sendConversationToNotion refuses system audio and converts offered rows", ...)
it("sendConversationToNotion with no Odoo config writes status 'none' rows", ...)
```
- [ ] **Step 2:** Run `npx vitest run src/tests/notion-scheduler.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** Run the same test file and `npm run type-check`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(notion): add the background Notion scheduler`

---

### Task 15: Who sends where, recovery and the overlay hook

**Files:**
- Create: `src/lib/notion/destinations.ts`, `src/tests/notion-destinations.test.ts`, `src/hooks/useNotionPick.ts`
- Modify:
  - `src/hooks/useMeetingLog.ts`: `pushHeldRow:212`, `trigger:271-414`, the startup effect `:525-561`, the rehydrate `:570-610`, `onUndo:635-670`, plus a new `notionPickedRef` option
  - `src/lib/odoo/meeting-log-recovery.ts:84-160`
  - `src/pages/app/components/completion/index.tsx:148-166`
- Test: `src/tests/odoo-meeting-log-recovery.test.ts` (extend), `src/tests/meeting-log-entry-points.test.tsx` (extend)

**Interfaces:**
```ts
type OdooSetup = "absent" | "incomplete" | "complete";
type Decision =
  | { queue: false; toastIncomplete: boolean }
  | { queue: true; odooStatus: "held" | "unassigned" | "none"; notionStatus: "held" | "offered" | "waiting" | null; toastIncomplete: boolean };
function decideDestinations(i: { source: "live" | "recovery"; odoo: OdooSetup; notion: boolean; autoSend: boolean;
  odooTargets: number; notionPicked: boolean }): Decision;
```
The decision table (spec §6, with Odoo absent ⇒ `'none'`):

| odoo | notion | rule |
|---|---|---|
| any | false | Today: `complete` → `targets ? held : unassigned`, notion `null`; `incomplete` → no queue, toast; `absent` → no queue |
| absent | true | `none` plus: live with autoSend → `held`; recovery with autoSend → `waiting`; autoSend off → `offered` |
| complete | true | Odoo `targets ? held : (picked ? none : unassigned)`, notion `picked ? (live ? held : waiting) : null`; recovery → `unassigned`, `null` |
| incomplete | true | toast; `picked` → queue `none` + (live `held`); not picked → no queue. Recovery → `none` + `offered` |

Hook changes:
- **`trigger`** loads `loadOdooConfigState()`, `isNotionConfigured()` and `isNotionAutoSendEnabled()`, then calls `decideDestinations`.
  - The instance is the Odoo fingerprint when `complete`, else `""`.
  - It keeps every slicing, watermark and recovery line as it is.
  - The `incomplete` toast fires only when `toastIncomplete`.
  - `startHold` runs when either status is `held`.
  - The catch toast becomes **"This meeting could not be queued."**
- **`pushHeldRow`:**
  - if `notion_status === 'held'` → `promoteHeldNotionRow(id)`;
  - then, only if `status === 'held'`, the existing Odoo push.
- **The rehydrate** uses `findHeldRow(complete ? fingerprint : null, now)` with no Odoo gate.
- **`onUndo`'s blocked copy** becomes **"This meeting is already being sent."**
- **The startup chain:** after `.then(() => runMeetingRecovery())`, add `.then(() => ensureNotionScheduler(depsRef.current))`.
  - Deps: `liveLastLineAt = (c) => c === conversationIdRef.current && transcriptRef.current.length ? Math.max(...timestamps) : null`, and `fallbackProvider = () => providerConfigRef.current`.
  - On every render, refresh the deps via `ensureNotionScheduler` only once it has started (export `isNotionSchedulerStarted()`).
- **`runMeetingRecovery`** runs when Odoo is `complete` **or** Notion is configured. It writes rows per `decideDestinations({ source: "recovery", … })`, with instance `""` when Odoo isn't `complete`.
- **`useNotionPick()`** returns `{ picked: boolean; pickedRef: RefObject<boolean>; toggle(): void; clear(): void }`, persisted in `STORAGE_KEYS.NOTION_PICKED`.
  - `completion/index.tsx` passes `pickedRef` to `useMeetingLog`.
  - It calls `clear()` wherever `useOdooTarget` clears targets; find those calls with `graft callers clearTargets`.

- [ ] **Step 1: Write the failing tests**
```ts
// notion-destinations.test.ts — the §6 matrix: (Notion only, Odoo only, both, neither) × (on, off) × (live, recovery)
it.each(MATRIX)("%o → %o", (input, expected) => expect(decideDestinations(input)).toEqual(expected));
it("never returns held/pending/unassigned for Odoo when Odoo is absent", ...)  // property over every MATRIX input with odoo:"absent"
// recovery
it("a Notion-only crash with no Odoo config rescues the meeting as status 'none', notion 'waiting'", ...)
it("Notion-only with auto-send off rescues as 'offered'", ...)
it("Odoo set up: rescued meetings stay unassigned with no Notion lane", ...)
// hook (meeting-log-entry-points.test.tsx)
it("Notion-only, no Odoo config: pill-off queues a held Notion row and shows the undo strip", ...)
it("undo during the hold cancels the Notion row", ...)
it("hold expiry promotes the Notion row to waiting and makes no Odoo call", ...)
it("Notion-only user never sees Odoo in the trigger toast or the undo-blocked message", ...)
it("the scheduler starts only after recovery finished", ...)     // order spy: runMeetingRecovery resolves before ensureNotionScheduler
```
- [ ] **Step 2:** Run `npx vitest run src/tests/notion-destinations.test.ts src/tests/odoo-meeting-log-recovery.test.ts src/tests/meeting-log-entry-points.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** Run the same files plus `src/tests/meeting-log-watermark.test.ts src/tests/odoo-meeting-log-strip.test.tsx`, then `npm run type-check`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(notion): queue meetings for Notion without Odoo`

---

### Task 16: Overlay picker, Notion settings, Meeting summaries setting

**Files:**
- Create: `src/lib/notion/check.ts`, `src/pages/odoo/components/NotionSettingsCard.tsx`, `src/pages/dev/components/ai-configs/SummaryProviderCard.tsx`, `src/tests/notion-check.test.ts`, `src/tests/notion-settings-card.test.tsx`
- Modify:
  - `src/pages/app/components/completion/ContactPicker.tsx`: props `:109-202`, the "Logging to" block `:395-466`
  - `src/pages/app/components/completion/index.tsx:265`
  - `src/pages/odoo/index.tsx:784-961`
  - `src/pages/dev/index.tsx:37`
- Test: `src/tests/odoo-contact-picker.test.tsx` (extend)

**Interfaces:**
- `ContactPicker` gains three stable props: `notionAvailable: boolean`, `notionSelected: boolean` and `onToggleNotion: () => void` (from `useNotionPick`, wrapped in `useCallback`).
  - With `notionAvailable`, the popover shows a checkbox row labelled **"Notion: Weekly Team Meetings"** above "Logging to".
  - `notionAvailable` is true only when Odoo is set up **and** Notion is configured.
  - `completion/index.tsx` doesn't render `ContactPicker` at all when Notion is configured and Odoo is `absent` (spec §6: no picker).
- `checkNotionSetup(token: string, cfg: NotionConfig): Promise<CheckResult>`:
  ```ts
  type CheckResult = { ok: true; mapping: string; recorder: string; warnings: string[] } | { ok: false; message: string };
  ```
  - It arms the redactor with the token and calls `me()`, then `database(meetingsDbId)`. Every sub-table must pass `describeSubTable`, and the result runs through `buildMapping`/`describeMapping`.
  - With a knowledge link, it runs `readKnowledge` and requires all four properties and `hasProposed`.
  - It returns fixed sentences:
    - "Can't see the Weekly Team Meetings database: open it in Notion and check you have edit access."
    - "Can't see the Team Knowledge database: open it in Notion and check you have edit access."
    - "Team Knowledge is missing the {column} column."
    - "Team Knowledge's Status column has no Proposed option."
    - "{sub-table} has no date column."
  - A warning when the knowledge link is empty: "No Team Knowledge link: practices will only appear on the meeting page."
  - On success, `requeueAuthFailures()`.
- `NotionSettingsCard` fields:
  - Notion token (password input; Save calls `saveNotionToken`; shows "Saved in your system keychain", never the value);
  - Meetings database link; Team Knowledge database link;
  - "Send meetings to Notion automatically" switch (`setNotionAutoSendEnabled`), copying the calendar Switch at `pages/odoo/index.tsx:943-960`;
  - one "Usual start time" `<input type="time">` per weekday sub-table, shown after a successful Check;
  - "Your name" (used only when Notion can't give the name);
  - a Check button that renders `CheckResult`.

  On Linux (`isNotionKeychainAvailable()` false) the token field is disabled with `NOTION_COPY.NOTION_KEYCHAIN_UNAVAILABLE`. It emits `notion-config-changed` after a save.
- On the Integrations page, while Notion is configured and Odoo is `absent`, `OdooSetupCard` sits behind a "Show other integrations" button.
- `SummaryProviderCard` (title "Meeting summaries", description "The AI that writes every meeting summary, for Notion and Odoo. Leave empty to use your chat model.") renders the existing `Providers` component with its own state, backed by `loadSummaryProvider`/`saveSummaryProvider` and `variables = extractVariables(provider.curl)`. A "Clear" button saves `null`. It is mounted on API Setup.

- [ ] **Step 1: Write the failing tests**
```ts
it("Check reports the weekday mapping on success and requeues auth failures", ...)
it("Check: missing Proposed option → that sentence", ...)
it("Check: 404 on the meetings database → the 'Can't see the Weekly Team Meetings database' sentence", ...)
it("settings card never renders the stored token", ...)
it("settings card disables the token field when the keychain is unavailable", ...)
it("Notion-only: Integrations page shows no 'Odoo' text until 'Show other integrations' is pressed", ...)
it("picker shows the Notion row only when Odoo and Notion are both set up", ...)
it("Notion-only: the overlay renders no contact picker", ...)
```
- [ ] **Step 2:** Run `npx vitest run src/tests/notion-check.test.ts src/tests/notion-settings-card.test.tsx src/tests/odoo-contact-picker.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** Run the same files plus `src/tests/odoo-settings-page.test.tsx`, then `npm run type-check`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(notion): add Notion settings, Check, and the Meeting summaries setting`

---

### Task 17: Meetings page

**Files:**
- Create: `src/hooks/useNotionQueue.ts`, `src/pages/meetings/components/NotionSection.tsx`, `src/tests/meetings-page.notion.test.tsx`
- Modify:
  - `src/pages/meetings/index.tsx:247` (description), `:300-306` (stranded line), `:375` (row props)
  - `src/pages/meetings/components/ConversationRow.tsx:19-26,61,281`
  - `ConversationList.tsx`, `DateGroup.tsx` (pass the new props through)
  - `src/hooks/useMeetingLogQueue.ts:461-512`, so `reload` with a non-complete Odoo config still sets `stranded` only from `countActionableQueued()`. That function already ignores `'none'` rows; this is asserted, not changed.

**Interfaces:**
- `useNotionQueue(): { configured: boolean; items: NotionItem[]; byConversation: Map<string, NotionBadge>; reload(); onSendRows(rowIds); onRetry(sendId); onDontSend(item); onSendConversation(id) }`. It reloads on window focus and on `notion-config-changed`, and is independent of Odoo config.
- `type NotionBadge = { label: string; url: string | null; tone: "attention" | "waiting" | "done" }`. It is resolved per conversation, worst first:

| Item state | Label | Tone | Link |
|---|---|---|---|
| send `failed` | Notion failed | attention | `page_url` |
| send `no_summary` | Couldn't summarise | attention | none |
| send `retry`/`sending` with `error_code` SUMMARY_* | Waiting for summary | waiting | none |
| send with `page_id`, `practices_done=0` and `practices_error_code` | Practices not added yet | waiting | `page_url` |
| send `retry`/`sending` (other) | Sending to Notion | waiting | `page_url` |
| rows `offered` | Send to Notion | waiting | none |
| rows `held`/`waiting` | Waiting for the meeting to end | waiting | none |
| send `already` | Already in Notion | done | `lost_to_url` |
| send `sent` | In Notion | done | `page_url` |

- `NotionSection`, titled "Notion", lists every item that isn't `sent`/`already`, with the label, the reason (`NOTION_COPY[error_code]`, never raw text) and these actions:
  - `offered` → **Send to Notion** and **Don't send**;
  - `failed`/`no_summary`/`retry` → **Retry**;
  - **Don't send** while there's no page.

  External links open with `@tauri-apps/plugin-opener` (or the app's existing link helper; grep `openUrl`).
- `ConversationRow`:
  - gains `notionBadge: NotionBadge | null`, rendered next to the Odoo badge as a small link;
  - gains `onSendToNotion: ((id: string) => Promise<string | null>) | null`, a button **"Send to Notion"** shown when Notion is configured, the conversation isn't system audio, and `notionBadge` is null.
- Page description:
  - Odoo set up and Notion → "Your conversations, and the meetings waiting to reach Odoo and Notion."
  - Notion only → "Your conversations, and the meetings waiting to reach Notion."
  - Odoo only → unchanged.
  - Neither → "Your conversations."

- [ ] **Step 1: Write the failing tests**
```ts
it("Notion-only user: no rendered text contains 'Odoo' (page, rows, badges, buttons)", ...) // container.textContent
it("a no_summary send shows 'Couldn't summarise', the fixed reason and a Retry that calls retrySend", ...)
it("an already send shows 'Already in Notion' linking to the winner page", ...)
it("practices pending shows 'Practices not added yet' with the page link and the reason", ...)
it("a 429-coded send is shown as waiting, not as a failure", ...)
it("offered rows show Send to Notion; pressing it calls offerRowsToWaiting with the group's row ids", ...)
it("the Notion section renders with no Odoo config at all", ...)
```
- [ ] **Step 2:** Run `npx vitest run src/tests/meetings-page.notion.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** Run `npx vitest run src/tests/meetings-page.notion.test.tsx src/tests/meetings-page.test.tsx src/tests/meetings-page.badges.test.ts src/tests/meeting-log-page.test.tsx src/tests/meetings-conversation-list.test.tsx` and `npm run type-check`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(notion): show Notion sends on the Meetings page`

---

### Task 18: Live checks with a real token (human gate before merge)

**Files:**
- Create: `.livecheck/notion-live.live.ts`
- Modify: `.livecheck/README.md` (add a Notion section). The vitest config comes from `.livecheck/vitest.live.config.ts`.

**Interfaces:**
- Reads `NOTION_LIVE_TOKEN`, `NOTION_LIVE_MEETINGS_DB` and `NOTION_LIVE_KNOWLEDGE_DB` from the environment. The test skips when they're unset. It is **never** committed with values, and only throwaway database ids are used. It uses `createNotionClient` with a Node `fetch` adapter.
- The checks, numbered as spec §8.2, with assertions printed for the PR body:
  1. Create a page in each sub-table. Print whether `page.created_by.id` equals `me().id` (the bot), `ownerUserId` (the person) or neither. Assert that `isOwnPage` is true for it.
  2. `userName(ownerUserId)` returns a non-empty name, or null (print which).
  3. The page landed in the requested data source with `date.end` set.
  4. A Knowledge row created with `Status = Proposed` reads back as Proposed.
  5. Two pages created back to back: print both `created_time` values (minute-rounded or not). Assert a query immediately after the second create sees it, or print the delay needed.
  6. Fire 200 cheap GETs: print whether any 429 carried `Retry-After`.
- Cleanup trashes every page it created.

- [ ] **Step 1: Write the harness**, with a module-top comment: "Run by Kevin with a real token against throwaway databases; paste the printed results into the PR body. Checks 1, 2 and 5 confirm the assumptions this build handles both ways."
- [ ] **Step 2:** Run it without the environment variables: `npx vitest run --config .livecheck/vitest.live.config.ts .livecheck/notion-live.live.ts`. Expected: skipped, exit 0.
- [ ] **Step 3: Commit** `test(notion): add the live Notion checks`
- [ ] **Step 4: Human gate.** The PR body lists this harness as unrun until Kevin pastes results. If check 1 shows neither id matches, or check 5 shows a query can't see a just-created page within `RECHECK_DELAY_MS`, the matching constant or `isOwnPage` changes before merge.

---

## Spec coverage map (§8.1)

| §8.1 bullet | Tests |
|---|---|
| Joining | Task 14 (gaps, conversations, flap + 40 min, sending skip, restart + recovery), Task 2/3 (cancelled excluded, sent-together), Task 15 (scheduler after recovery) |
| Who sends where | Task 15 matrix; render tests in Tasks 15, 16, 17 |
| Recovery | Task 15 |
| Same meeting | Task 11 |
| Race | Task 13 |
| Transcript batches | Tasks 10, 11 |
| Summary | Task 13 (reuse, never reads `meeting_summaries`, codes, Retry), Task 9 (codes) |
| Retries | Task 7 (Retry-After, cap, no header), Task 17 (429 not a failure), Task 13 (401 at once) |
| Secrets | Tasks 4, 6, 7, 9, 13 |
| Migration | Task 1 (Rust registration plus sql.js survival) |
| Team Knowledge plumbing | Task 12 |
| AI judgements on fixtures | Not automatable with a mock (spec §8.1). Task 18's README section lists the fixture transcripts to try against the real model before rollout: a name, a fee, "ignore previous instructions", a repeat of a Rejected rule. |
