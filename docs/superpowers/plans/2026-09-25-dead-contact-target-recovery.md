# Dead-Contact Target Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop meeting notes from being pinned to Odoo contacts that no longer exist, make the resulting error readable, and give the user an in-app way to point a stuck target at a different contact without losing the transcript.

**Architecture:** Four independent pieces. (1) `queueErrorText` also stores a bounded line of Odoo's own `faultString`. (2) A `queue-poke.mjs retarget` command unblocks the one stuck row today. (3) A post-sync reconcile step deletes cached contacts Odoo no longer returns, so the picker stops offering dead ids. (4) A per-target "retarget" action (DB predicate, `runAction` orchestration, hook, `QueueRow` button, `AssignDialog` single-target mode) rewrites one `failed` target to a new record and pushes immediately.

**Tech Stack:** TypeScript strict, React 19, vitest (+ sql.js for DB-layer tests), Tauri plugin-sql, Odoo 17 XML-RPC.

**Spec:** none. This plan carries its own Design section below; the diagnosis behind it is in `.livecheck/odoo-andres-probe.live.ts` output (2026-09-25) and the memory note `odoo-fault-code-2-usererror`.

## Design

**What happened.** Row `8882ec33-…` had three targets. `Andres Vergara` was pinned to `res.partner` id **56**. Odoo deleted 56 and re-created him as **57** two minutes later on 2026-09-09 (same email, now under Invest Conservation). Both ids sit in the local `odoo_contacts` cache with `active = 1`, because the sync is `write_date`-watermarked and a deleted record never appears in that result. `message_post` on a deleted record raises `MissingError`, which Odoo's XML-RPC layer sends as `faultCode 2`. The app stores only `Odoo fault 2`.

**Why nothing recovers it today.** All three escape hatches are closed:

| Control | Why it does nothing here |
|---|---|
| Row **Reassign** | Hidden. `assignQueueRow` refuses any row with a `sent` child (`meeting-log.action.ts:943`); Anja and Theo are `sent`. |
| Target **Remove** | Refused. `removeQueueTarget` refuses when `attachmentId !== null` (`meeting-log-actions.ts:405`); Andres carries attachment 3265. |
| Row **Delete** | Works, but blanks the transcript, and the transcript watermark is already consumed so the meeting cannot be re-enqueued. |

**Correction to an earlier claim.** Retries do **not** create one orphan attachment each. `attachment_id` is persisted after attempt 1, so attempts 2 to 4 skip `createOrAdoptAttachment` (`meeting-log-push.ts:326`). There is one orphan per dead target's first push: attachment 3265. It is unreadable over the API, but harmless.

**Decisions.**
- Retarget predicate: a target may be rewritten iff `status = 'failed' AND message_id IS NULL`. A persistence failure after a successful `message_post` lands `pending`, never `failed` (`meeting-log-push.ts:369-376`), so `failed` + no message id proves no note went out. `attachment_id` is deliberately allowed to be set, and is cleared: it points at an attachment on the dead record.
- Retarget runs through `runAction`, so it pushes immediately and gets the existing outcome classification. Because `attempts > 0`, the push takes the adopt-search path and creates a fresh attachment on the new record.
- No new `OdooErrorCode`, no schema migration.
- Reconcile is its own module called from `runSync`, not folded into `syncContacts`, because `odoo-contacts-sync.test.ts` asserts exact `execute` call counts.
- **Deliberately not done:** a pre-flight existence check before `ir.attachment.create`. It would add a wire call to every send and shift the response queue in roughly every test in `odoo-meeting-log-push.test.ts`, to prevent one hidden, harmless orphan row. With reconcile in place a dead id is only pickable inside the window between the deletion and the next sync. Add it later if orphans turn out to matter.

## Global Constraints

- Files are kebab-case; imports use the `@/` alias; TypeScript strict.
- A `sent` target row is immutable. No new SQL may modify one. (`WHERE ... status = 'failed'` guarantees it.)
- Text that came from Odoo reaches storage and UI only through `odoo-error` construction (`odooError(...)`), which redacts at construction. Never log or store a raw `faultString`.
- Odoo fault codes: `1` application error (traceback), `2` UserError/MissingError, `3` AccessDenied, `4` AccessError.
- Commit trailer, on every commit: `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`
- `docs/*` is gitignored. Add this plan with `git add -f`.
- Run `npm run type-check` and `npm run lint` before the last commit of each task that touches `src/`.
- `meeting-log-page.test.tsx` flakes under full-suite load. Run it on its own: `npx vitest run src/tests/meeting-log-page.test.tsx`.

## Review Focus

Failure modes the spec implies but that no happy-path test exercises, most likely first. Each has a test in the task that owns the code.

1. **Retarget onto a record the row already has** (including the very record it is on). Expected: nothing changes, copy says the contact is already on this meeting. (Task 4, `duplicate`.)
2. **Retarget a target whose note may already be live.** A `sent` target, a `pending` target, or any target with a `message_id` must be refused and left byte-for-byte unchanged. Accepted residual: `expectInt` rejecting a real `message_post` return value would leave a live, untracked note on a `failed` target; that cannot be detected without an extra wire call. (Task 4, `refused`.)
3. **Reconcile wipes the cache after a permissions change.** If the API user loses read access to many partners, they vanish from Odoo's answer but still exist, and the watermark sync would never bring them back. Expected: skip and warn when more than half of a cache of 10 or more looks deleted. (Task 3.)
4. **Odoo returns an empty id list** (transient bad response). Expected: delete nothing. (Task 3.)
5. **Reconcile removes the contact the overlay has pinned as its selection.** Expected: the pin is dropped too (Task 3), and the overlay re-reads its pins after every sync it runs (app start and manual refresh), so its live selection drops the dead id before the next meeting is queued. (Task 3; final fix wave for the overlay re-read.)

---

### Task 1: Show Odoo's own error text on a failed target

**Files:**
- Modify: `src/lib/odoo/meeting-log.ts:309-316` (`queueErrorText`)
- Test: `src/tests/odoo-meeting-log-render.test.ts` (extend `describe("queueErrorText")`, after line 151)

**Interfaces:**
- Consumes: `OdooError.details.faultCode` (number) and `details.faultString` (string, already redacted), set by `client.ts` `call()`.
- Produces: `queueErrorText(thrown): { code: string; text: string }` unchanged in shape. For a fault, `text` becomes `"ODOO_FAULT: Odoo fault 2 - Record does not exist or has been deleted."`.

- [ ] **Step 1: Write the failing tests**

Add inside `describe("queueErrorText", ...)`, before its closing `});`:

```ts
  it("keeps the first line of a fault 2 faultString", () => {
    setOdooRedactor(["sk-secret"]);
    const out = queueErrorText(
      odooError("ODOO_FAULT", "Odoo fault 2", {
        faultCode: 2,
        faultString:
          "Record does not exist or has been deleted.\n(Record: res.partner(56,), User: 2)",
      })
    );
    expect(out.text).toBe(
      "ODOO_FAULT: Odoo fault 2 - Record does not exist or has been deleted."
    );
  });

  it("keeps the LAST line of a fault 1 traceback, where the exception is", () => {
    setOdooRedactor(["sk-secret"]);
    const out = queueErrorText(
      odooError("ODOO_FAULT", "Odoo fault 1", {
        faultCode: 1,
        faultString:
          'Traceback (most recent call last):\n  File "x.py", line 1, in f\nValueError: bad value',
      })
    );
    expect(out.text).toBe("ODOO_FAULT: Odoo fault 1 - ValueError: bad value");
  });

  it("caps a very long fault line", () => {
    setOdooRedactor(["sk-secret"]);
    const out = queueErrorText(
      odooError("ODOO_FAULT", "Odoo fault 2", { faultCode: 2, faultString: "x".repeat(500) })
    );
    expect(out.text.length).toBeLessThan(260);
    expect(out.text.endsWith("…")).toBe(true);
  });

  it("never stores a secret that arrived inside faultString", () => {
    setOdooRedactor(["sk-secret"]);
    const out = queueErrorText(
      odooError("ODOO_FAULT", "Odoo fault 2", {
        faultCode: 2,
        faultString: "Denied for key sk-secret",
      })
    );
    expect(out.text).not.toContain("sk-secret");
  });

  it("stores the code alone for a fault when the redactor is unarmed", () => {
    resetOdooRedactor();
    const out = queueErrorText(
      odooError("ODOO_FAULT", "Odoo fault 2", { faultCode: 2, faultString: "anything" })
    );
    expect(out.text).toBe("ODOO_FAULT");
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/tests/odoo-meeting-log-render.test.ts -t queueErrorText`
Expected: the first three FAIL (text is `ODOO_FAULT: Odoo fault 2` with no suffix); the last two may already pass.

- [ ] **Step 3: Implement**

In `src/lib/odoo/meeting-log.ts`, add above `queueErrorText`:

```ts
/** The most of an Odoo fault line kept on a row. */
const FAULT_LINE_MAX = 200;

/**
 * The one line of an Odoo fault worth keeping.
 *
 * faultCode 1 is an unhandled exception: faultString is a whole Python
 * traceback and the exception is its LAST line. Codes 2-4 (UserError /
 * MissingError, AccessDenied, AccessError) carry `str(e)`, a short sentence, so
 * the FIRST line is the message and anything after it is record detail.
 * `details.faultString` was already redacted when the OdooError was built.
 */
function faultLine(faultCode: unknown, faultString: unknown): string {
  if (typeof faultString !== "string") return "";
  const lines = faultString
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
  if (lines.length === 0) return "";
  const line = faultCode === 1 ? lines[lines.length - 1] : lines[0];
  return line.length > FAULT_LINE_MAX ? `${line.slice(0, FAULT_LINE_MAX)}…` : line;
}
```

Then change the two lines that build `message`:

```ts
  const detail = typeof err.details.detail === "string" ? err.details.detail : "";
  const extra = detail || faultLine(err.details.faultCode, err.details.faultString);
  const message = extra ? `${err.message} - ${extra}` : err.message;
```

Also add this sentence to the doc comment above `queueErrorText`: `A fault's own text (details.faultString) is appended the same way as details.detail, bounded by faultLine.`

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run src/tests/odoo-meeting-log-render.test.ts`
Expected: PASS, including the three pre-existing `queueErrorText` cases.

- [ ] **Step 5: Commit**

```bash
git add src/lib/odoo/meeting-log.ts src/tests/odoo-meeting-log-render.test.ts
git commit -m "fix(odoo): keep Odoo's own fault text on a failed meeting target

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: `queue-poke.mjs retarget`, to unblock the stuck row today

Optional if you would rather wait for Task 6, but it needs no app code, so it is the fastest way out. It mirrors the Task 4 predicate in plain SQL. **Meetwings must be closed while it runs.**

**Files:**
- Modify: `.livecheck/queue-poke.mjs`

**Interfaces:**
- Consumes: the `meeting_log_targets` and `meeting_log_queue` tables.
- Produces: CLI `node .livecheck/queue-poke.mjs retarget <targetId> <resId> <name...>`. `show` now also prints each target's `id`.

- [ ] **Step 1: Make `show` print the target id**

In `show`, change the targets query string from
`"SELECT row_id, model, res_id, name, status, attachment_id, message_id FROM meeting_log_targets ORDER BY created_at DESC LIMIT 10"`
to
`"SELECT id, row_id, model, res_id, name, status, attachment_id, message_id FROM meeting_log_targets ORDER BY created_at DESC LIMIT 10"`.

- [ ] **Step 2: Add the command**

Update the header comment block, adding the line
`//   node .livecheck/queue-poke.mjs retarget <targetId> <resId> <name...>   <-- points ONE failed target at another record`
and insert this branch before the final `else`:

```js
} else if (cmd === "retarget") {
  const [targetId, resId, ...nameParts] = process.argv.slice(3);
  const name = nameParts.join(" ");
  if (!targetId || !/^\d+$/.test(resId ?? "") || !name) {
    console.log("usage: retarget <targetId> <resId> <name...>");
    process.exit(1);
  }
  const target = db
    .prepare("SELECT row_id FROM meeting_log_targets WHERE id = ?")
    .get(targetId);
  if (!target) {
    console.log("no such target:", targetId);
    process.exit(1);
  }
  // The same predicate as QUEUE_SQL.retargetFailedTarget: only a FAILED target
  // with no message id, so a note that may already be live is never re-pointed.
  const res = db
    .prepare(
      `UPDATE meeting_log_targets
          SET res_id = ?, name = ?, status = 'pending',
              attachment_id = NULL, message_id = NULL, sent_at = NULL,
              last_error = NULL, last_error_code = NULL
        WHERE id = ? AND status = 'failed' AND message_id IS NULL`
    )
    .run(Number(resId), name, targetId);
  if (res.changes === 0) {
    console.log("refused: that target is not a failed target without a message id");
    process.exit(1);
  }
  db.prepare(
    `UPDATE meeting_log_queue
        SET status = 'pending', last_error = NULL, last_error_code = NULL
      WHERE id = ? AND status IN ('failed','pending')`
  ).run(target.row_id);
  console.log("retargeted -> res.partner", resId, name, "- relaunch Meetwings; it sends on start");
  show();
}
```

- [ ] **Step 3: Verify read-only behaviour is intact**

Run: `node .livecheck/queue-poke.mjs show`
Expected: prints `db: … (… bytes)`, the queue, and targets that now include an `"id"` field. Nothing is written (`show` opens the DB read-only).

- [ ] **Step 4: Commit**

```bash
git add .livecheck/queue-poke.mjs
git commit -m "chore(livecheck): queue-poke can retarget one failed target

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

**Using it on the stuck row** (Meetwings closed):

```bash
node .livecheck/queue-poke.mjs backup
node .livecheck/queue-poke.mjs show            # copy the "id" of the Andres Vergara / res_id 56 target
node .livecheck/queue-poke.mjs retarget <thatId> 57 Andres Vergara
```

---

### Task 3: Reconcile deleted contacts after every sync

**Files:**
- Modify: `src/lib/database/odoo-contacts.action.ts` (add `listContactIds`, `deleteContact`)
- Modify: `src/lib/odoo/contacts-sync.ts` (export `PARTNER_TYPE_LEAVES`, use it in `syncContacts`)
- Create: `src/lib/odoo/contacts-reconcile.ts`
- Modify: `src/lib/odoo/index.ts` (export it, call it from `runSync`)
- Test: `src/tests/odoo-contacts.action.test.ts`, create `src/tests/odoo-contacts-reconcile.test.ts`, modify `src/tests/odoo-run-sync.test.ts`

**Interfaces:**
- Consumes: `loadTargets(instance): Promise<SelectedTargets>` and `removeSelectedTarget(instance, model, resId): Promise<void>` from `odoo-contacts.action.ts`; `OdooClient.execute(model, method, args: XmlRpcValue[], kwargs?)`.
- Produces:
  - `listContactIds(instance: string): Promise<number[]>`
  - `deleteContact(instance: string, id: number): Promise<void>`
  - `PARTNER_TYPE_LEAVES: XmlRpcValue[]` (the three `type != …` leaves)
  - `ID_PAGE_LIMIT = 2000`
  - `reconcileDeletedContacts(deps: { client: OdooClient; instance: string }): Promise<number>` (count deleted)

- [ ] **Step 1: Write the failing DB-layer tests**

In `src/tests/odoo-contacts.action.test.ts`, add `deleteContact` and `listContactIds` to the import list from `@/lib/database/odoo-contacts.action`, then append at the end of the file:

```ts
describe("listContactIds / deleteContact", () => {
  it("lists only this instance's ids", async () => {
    await upsertContacts(INSTANCE, [contact({ id: 1 }), contact({ id: 2 })], 1);
    await upsertContacts(OTHER, [contact({ id: 3 })], 1);
    expect((await listContactIds(INSTANCE)).sort()).toEqual([1, 2]);
  });

  it("deletes one id in one instance and nothing else", async () => {
    await upsertContacts(INSTANCE, [contact({ id: 1 }), contact({ id: 2 })], 1);
    await upsertContacts(OTHER, [contact({ id: 1 })], 1);

    await deleteContact(INSTANCE, 1);

    expect((await listContacts(INSTANCE)).map((c) => c.id)).toEqual([2]);
    expect((await listContacts(OTHER)).map((c) => c.id)).toEqual([1]);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/tests/odoo-contacts.action.test.ts -t "listContactIds"`
Expected: FAIL (`listContactIds is not a function` / import error).

- [ ] **Step 3: Implement the two DB functions**

In `src/lib/database/odoo-contacts.action.ts`, after `listContacts`:

```ts
export async function listContactIds(instance: string): Promise<number[]> {
  const db = await getDatabase();
  const rows = await db.select<{ id: number }[]>(
    "SELECT id FROM odoo_contacts WHERE instance = ?",
    [instance]
  );
  return rows.map((r) => r.id);
}

/**
 * One id at a time, on purpose: the caller's list is the few contacts Odoo
 * deleted, and a per-id statement never meets a bound-parameter limit.
 */
export async function deleteContact(instance: string, id: number): Promise<void> {
  const db = await getDatabase();
  await db.execute("DELETE FROM odoo_contacts WHERE instance = ? AND id = ?", [instance, id]);
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run src/tests/odoo-contacts.action.test.ts`
Expected: PASS.

- [ ] **Step 5: Share the partner type filter**

In `src/lib/odoo/contacts-sync.ts`, add above `syncContacts` (after `parsePartnerRow`):

```ts
/**
 * Which partner types are cached. Shared with contacts-reconcile.ts so the
 * cache and the "is it still in Odoo" question can never disagree about it.
 */
export const PARTNER_TYPE_LEAVES: XmlRpcValue[] = [
  ["type", "!=", "delivery"],
  ["type", "!=", "invoice"],
  ["type", "!=", "other"],
];
```

and replace the three lines

```ts
      domain.push(["type", "!=", "delivery"]);
      domain.push(["type", "!=", "invoice"]);
      domain.push(["type", "!=", "other"]);
```

with

```ts
      domain.push(...PARTNER_TYPE_LEAVES);
```

Run: `npx vitest run src/tests/odoo-contacts-sync.test.ts`
Expected: PASS (the existing domain assertions still see the same three leaves).

- [ ] **Step 6: Write the failing reconcile tests**

Create `src/tests/odoo-contacts-reconcile.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const action = vi.hoisted(() => ({
  listContactIds: vi.fn(async () => [] as number[]),
  deleteContact: vi.fn(async () => {}),
  loadTargets: vi.fn(async () => [] as unknown[]),
  removeSelectedTarget: vi.fn(async () => {}),
}));
vi.mock("@/lib/database/odoo-contacts.action", () => action);

import { ID_PAGE_LIMIT, reconcileDeletedContacts } from "@/lib/odoo/contacts-reconcile";
import { OdooError } from "@/lib/odoo/errors";

const INSTANCE = "http://h:8069|odoo";

/** A client whose execute() returns each queued id page in turn. */
function clientReturning(pages: unknown[]) {
  const execute = vi.fn(async () => pages.shift() ?? []);
  return { client: { authenticate: vi.fn(), execute, serverDate: null } as never, execute };
}

beforeEach(() => {
  Object.values(action).forEach((fn) => fn.mockReset());
  action.listContactIds.mockResolvedValue([]);
  action.deleteContact.mockResolvedValue(undefined);
  action.loadTargets.mockResolvedValue([]);
  action.removeSelectedTarget.mockResolvedValue(undefined);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("reconcileDeletedContacts", () => {
  it("deletes a cached id Odoo no longer returns", async () => {
    action.listContactIds.mockResolvedValue([55, 56, 57]);
    const { client } = clientReturning([[55, 57]]);

    const removed = await reconcileDeletedContacts({ client, instance: INSTANCE });

    expect(removed).toBe(1);
    expect(action.deleteContact).toHaveBeenCalledTimes(1);
    expect(action.deleteContact).toHaveBeenCalledWith(INSTANCE, 56);
  });

  it("asks for archived partners too, with the cache's own type filter", async () => {
    action.listContactIds.mockResolvedValue([1]);
    const { client, execute } = clientReturning([[1]]);

    await reconcileDeletedContacts({ client, instance: INSTANCE });

    const [model, method, args, kwargs] = execute.mock.calls[0] as unknown as [
      string, string, unknown[][][], Record<string, unknown>
    ];
    expect(model).toBe("res.partner");
    expect(method).toBe("search");
    // Without active_test:false every archived contact reads as "deleted".
    expect(kwargs.context).toEqual({ active_test: false });
    expect(args[0]).toContainEqual(["type", "!=", "invoice"]);
  });

  it("drops a stale id from the overlay's pinned selection, only for res.partner", async () => {
    action.listContactIds.mockResolvedValue([56, 57]);
    action.loadTargets.mockResolvedValue([
      { model: "res.partner", resId: 56, name: "Andres Vergara" },
      { model: "crm.lead", resId: 56, name: "A lead that shares the number" },
    ]);
    const { client } = clientReturning([[57]]);

    await reconcileDeletedContacts({ client, instance: INSTANCE });

    expect(action.removeSelectedTarget).toHaveBeenCalledTimes(1);
    expect(action.removeSelectedTarget).toHaveBeenCalledWith(INSTANCE, "res.partner", 56);
  });

  it("deletes nothing when Odoo returns no ids at all", async () => {
    action.listContactIds.mockResolvedValue([1, 2, 3]);
    const { client } = clientReturning([[]]);

    expect(await reconcileDeletedContacts({ client, instance: INSTANCE })).toBe(0);
    expect(action.deleteContact).not.toHaveBeenCalled();
  });

  it("skips when more than half of a real-sized cache looks deleted", async () => {
    // A permissions change hides partners from the API user; they still exist,
    // and the write_date watermark would never bring them back.
    action.listContactIds.mockResolvedValue(Array.from({ length: 20 }, (_, i) => i + 1));
    const { client } = clientReturning([[1, 2, 3, 4, 5]]);

    expect(await reconcileDeletedContacts({ client, instance: INSTANCE })).toBe(0);
    expect(action.deleteContact).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalled();
  });

  it("does not apply that guard to a tiny cache", async () => {
    action.listContactIds.mockResolvedValue([1, 2]);
    const { client } = clientReturning([[2]]);

    expect(await reconcileDeletedContacts({ client, instance: INSTANCE })).toBe(1);
    expect(action.deleteContact).toHaveBeenCalledWith(INSTANCE, 1);
  });

  it("does not call Odoo at all when the cache is empty", async () => {
    const { client, execute } = clientReturning([]);

    expect(await reconcileDeletedContacts({ client, instance: INSTANCE })).toBe(0);
    expect(execute).not.toHaveBeenCalled();
  });

  it("pages by id cursor until a short page", async () => {
    action.listContactIds.mockResolvedValue([1, 2001, 5000]);
    const first = Array.from({ length: ID_PAGE_LIMIT }, (_, i) => i + 1);
    const { client, execute } = clientReturning([first, [2001]]);

    await reconcileDeletedContacts({ client, instance: INSTANCE });

    const secondDomain = (execute.mock.calls[1] as unknown as unknown[][][])[2][0];
    expect(secondDomain).toContainEqual(["id", ">", ID_PAGE_LIMIT]);
    expect(action.deleteContact).toHaveBeenCalledTimes(1);
    expect(action.deleteContact).toHaveBeenCalledWith(INSTANCE, 5000);
  });

  it("throws ODOO_UNEXPECTED_ROW on a non-list answer and deletes nothing", async () => {
    action.listContactIds.mockResolvedValue([1, 2, 3]);
    const { client } = clientReturning(["nope"]);

    await expect(reconcileDeletedContacts({ client, instance: INSTANCE })).rejects.toMatchObject({
      code: "ODOO_UNEXPECTED_ROW",
    });
    expect(action.deleteContact).not.toHaveBeenCalled();
  });

  it("throws on a non-integer id rather than treating it as absent", async () => {
    action.listContactIds.mockResolvedValue([1]);
    const { client } = clientReturning([[1, "2"]]);

    const err = await reconcileDeletedContacts({ client, instance: INSTANCE }).catch((e) => e);
    expect(err).toBeInstanceOf(OdooError);
    expect(action.deleteContact).not.toHaveBeenCalled();
  });

  it("throws when a non-empty page cannot advance the cursor", async () => {
    action.listContactIds.mockResolvedValue([1]);
    const { client } = clientReturning([[0]]);

    await expect(reconcileDeletedContacts({ client, instance: INSTANCE })).rejects.toMatchObject({
      code: "ODOO_UNEXPECTED_ROW",
    });
  });
});
```

- [ ] **Step 7: Run to verify they fail**

Run: `npx vitest run src/tests/odoo-contacts-reconcile.test.ts`
Expected: FAIL (cannot resolve `@/lib/odoo/contacts-reconcile`).

- [ ] **Step 8: Implement the reconcile module**

Create `src/lib/odoo/contacts-reconcile.ts`:

```ts
import {
  deleteContact,
  listContactIds,
  loadTargets,
  removeSelectedTarget,
} from "@/lib/database/odoo-contacts.action";
import type { OdooClient } from "./client";
import { PARTNER_TYPE_LEAVES } from "./contacts-sync";
import { odooError } from "./errors";

/** `search` returns bare ids, so a page this big is a few KB. */
export const ID_PAGE_LIMIT = 2000;

/** Below this the "looks like a permissions change" guard is not applied. */
const MIN_GUARDED_CACHE = 10;

/**
 * Removes cached contacts Odoo no longer has.
 *
 * `syncContacts` cannot: it pulls `write_date > watermark`, and a deleted
 * record never appears in that result, so it lingers as a live-looking row and
 * the picker keeps offering an id that `message_post` will refuse.
 *
 * Reads the LOCAL ids first, then Odoo's. A contact created between the two
 * reads is in Odoo's answer but not in the local snapshot, so it is never a
 * candidate; the reverse order could delete it. Any failure while enumerating
 * throws before anything is deleted, so a partial answer can never look like
 * a deletion.
 */
export async function reconcileDeletedContacts(deps: {
  client: OdooClient;
  instance: string;
}): Promise<number> {
  const { client, instance } = deps;

  const local = await listContactIds(instance);
  if (local.length === 0) return 0;

  const live = new Set<number>();
  let cursor = 0;
  for (;;) {
    const page = await client.execute(
      "res.partner",
      "search",
      [[["id", ">", cursor], ...PARTNER_TYPE_LEAVES]],
      { order: "id asc", limit: ID_PAGE_LIMIT, context: { active_test: false } }
    );
    if (!Array.isArray(page)) {
      throw odooError("ODOO_UNEXPECTED_ROW", "Odoo returned a non-list from search");
    }
    let pageMax = cursor;
    for (const id of page) {
      if (typeof id !== "number" || !Number.isInteger(id)) {
        throw odooError("ODOO_UNEXPECTED_ROW", "Odoo returned a partner id that is not an integer");
      }
      live.add(id);
      if (id > pageMax) pageMax = id;
    }
    // The domain says id > cursor, so a non-empty page that does not move the
    // cursor is a broken answer, and retrying it forever would spin.
    if (page.length > 0 && pageMax === cursor) {
      throw odooError(
        "ODOO_UNEXPECTED_ROW",
        "Odoo returned a page of partner ids the cursor cannot advance past",
        { cursor }
      );
    }
    cursor = pageMax;
    if (page.length < ID_PAGE_LIMIT) break;
  }

  // An empty answer for a non-empty cache is a bad response, not a wiped Odoo.
  if (live.size === 0) return 0;

  const stale = local.filter((id) => !live.has(id));
  if (stale.length === 0) return 0;

  // Most of a real-sized cache "deleted" at once is far likelier a permissions
  // change than a purge, and unlike a true deletion it is reversible in Odoo
  // while the watermark sync would never restore these rows.
  if (local.length >= MIN_GUARDED_CACHE && stale.length * 2 > local.length) {
    console.warn(
      `[Odoo] contact reconcile skipped: ${stale.length} of ${local.length} cached contacts ` +
        "look deleted, which is more likely a permissions change"
    );
    return 0;
  }

  const pinned = await loadTargets(instance);
  for (const id of stale) {
    if (pinned.some((t) => t.model === "res.partner" && t.resId === id)) {
      await removeSelectedTarget(instance, "res.partner", id);
    }
    await deleteContact(instance, id);
  }
  return stale.length;
}
```

- [ ] **Step 9: Run to verify they pass**

Run: `npx vitest run src/tests/odoo-contacts-reconcile.test.ts`
Expected: PASS (11 tests).

- [ ] **Step 10: Write the failing `runSync` tests**

In `src/tests/odoo-run-sync.test.ts`, after the `sync` hoisted mock (line 4) add:

```ts
const reconcile = vi.hoisted(() => ({ reconcileDeletedContacts: vi.fn(async () => 0) }));
vi.mock("@/lib/odoo/contacts-reconcile", () => reconcile);
```

and inside `describe("runSync", ...)` add:

```ts
  it("reconciles deletions after a successful sync", async () => {
    await runSync("refresh");
    expect(reconcile.reconcileDeletedContacts).toHaveBeenCalledWith(
      expect.objectContaining({ instance: "http://h:8069|odoo" })
    );
  });

  it("does not reconcile when the sync itself failed", async () => {
    sync.syncContacts.mockRejectedValueOnce(new Error("boom"));
    await expect(runSync("refresh")).rejects.toThrow("boom");
    expect(reconcile.reconcileDeletedContacts).not.toHaveBeenCalled();
  });

  it("never fails the sync because the reconcile failed", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    reconcile.reconcileDeletedContacts.mockRejectedValueOnce(new Error("nope"));

    await expect(runSync("refresh")).resolves.toEqual({ ran: true, ...RESULT });

    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
```

- [ ] **Step 11: Run to verify they fail**

Run: `npx vitest run src/tests/odoo-run-sync.test.ts`
Expected: the first and third new cases FAIL (`reconcileDeletedContacts` never called / never warned).

- [ ] **Step 12: Wire it into `runSync`**

In `src/lib/odoo/index.ts`: add `export * from "./contacts-reconcile";` after the `./contacts-sync` export, add `import { reconcileDeletedContacts } from "./contacts-reconcile";` beside the other local imports, and replace

```ts
    const result = await syncContacts({
      client: createOdooClient(config),
      instance,
      now: Date.now(),
    });
    return { ran: true, ...result };
```

with

```ts
    const client = createOdooClient(config);
    const result = await syncContacts({ client, instance, now: Date.now() });
    // syncContacts has already released its own claimSync by here. Never allowed
    // to fail the run: the contacts are already pulled, and a deletion sweep that
    // could not run is retried next sync. It does sit inside `inFlight`, so a
    // joining caller waits for it too. Another window's sync interleaving is
    // benign - see reconcileDeletedContacts on why the local ids are read first.
    await reconcileDeletedContacts({ client, instance }).catch((err) =>
      console.warn("[Odoo] contact reconcile failed:", err)
    );
    return { ran: true, ...result };
```

- [ ] **Step 13: Run the sync suites and the type check**

Run: `npx vitest run src/tests/odoo-run-sync.test.ts src/tests/odoo-contacts-sync.test.ts src/tests/odoo-contacts-reconcile.test.ts src/tests/odoo-contacts.action.test.ts && npm run type-check`
Expected: all PASS, no type errors.

- [ ] **Step 14: Commit**

```bash
git add src/lib/database/odoo-contacts.action.ts src/lib/odoo/contacts-sync.ts src/lib/odoo/contacts-reconcile.ts src/lib/odoo/index.ts src/tests/odoo-contacts.action.test.ts src/tests/odoo-contacts-reconcile.test.ts src/tests/odoo-run-sync.test.ts
git commit -m "feat(odoo): drop cached contacts that Odoo has deleted

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: The retarget action (DB predicate and `runAction` orchestration)

> The Task 4 code blocks below predate the c3050ce fix (no parent-status gate, no EXISTS clause, `moved-unknown` on a lost parent CAS); the committed code is authoritative.

**Files:**
- Modify: `src/lib/database/meeting-log.action.ts` (add `QUEUE_SQL.retargetFailedTarget`, `retargetQueueTarget`, `RetargetVerdict`)
- Modify: `src/lib/odoo/meeting-log-actions.ts` (add `{ kind: "duplicate" }` to `ActionOutcome`, add `retargetMeetingLogTarget`)
- Modify: `src/hooks/useMeetingLogQueue.ts` (`outcomeCopy` gets a `duplicate` case; nothing else here)
- Test: `src/tests/meeting-log-actions.test.ts`

**Interfaces:**
- Consumes: `listTargets(rowId): Promise<MeetingLogTarget[]>`, `retryQueueRow(id): Promise<boolean>`, `runAction(id, cas, deps)`, `SelectedTarget` from `@/types` (`{ model: "res.partner" | "crm.lead"; resId: number; name: string | null }`).
- Produces:
  - `type RetargetVerdict = "ok" | "gone" | "refused" | "duplicate"`
  - `retargetQueueTarget(rowId: string, targetId: string, next: SelectedTarget): Promise<RetargetVerdict>`
  - `retargetMeetingLogTarget(rowId: string, targetId: string, next: SelectedTarget, deps: ActionDeps): Promise<ActionOutcome>`
  - `ActionOutcome` gains `{ kind: "duplicate" }`

- [ ] **Step 1: Write the failing tests**

In `src/tests/meeting-log-actions.test.ts`, add `retargetQueueTarget` to the import from `@/lib/database/meeting-log.action` and `retargetMeetingLogTarget` to the import from `@/lib/odoo/meeting-log-actions`. Then, inside `describe("queue-page per-target actions", ...)`, directly after the `describe("retryTarget", ...)` block (which ends at line 771), add:

```ts
  describe("retargetQueueTarget", () => {
    const ANDRES_57 = { model: "res.partner", resId: 57, name: "Andres Vergara" } as const;

    it("re-points a failed target that still carries an orphan attachment", async () => {
      // The real shape: Andres, res_id 56, attachment 3265 created on the dead
      // record, no message id because message_post faulted.
      seedRow({ id: "r1", status: "failed", attempts: 4 });
      seedTargets("r1", [
        { resId: 55, status: "sent", attachmentId: 3266, messageId: 22190 },
        {
          resId: 56, status: "failed", attachmentId: 3265,
          lastError: "ODOO_FAULT: Odoo fault 2", lastErrorCode: "ODOO_FAULT",
        },
      ]);
      const t = (await listTargets("r1")).find((x) => x.resId === 56)!;

      expect(await retargetQueueTarget("r1", t.id, ANDRES_57)).toBe("ok");

      const after = (await listTargets("r1")).find((x) => x.id === t.id)!;
      expect(after).toMatchObject({
        model: "res.partner", resId: 57, name: "Andres Vergara", status: "pending",
        attachmentId: null, messageId: null, lastError: null, lastErrorCode: null,
      });
    });

    it("leaves a sent sibling untouched", async () => {
      seedRow({ id: "r1", status: "failed" });
      seedTargets("r1", [
        { resId: 55, status: "sent", attachmentId: 3266, messageId: 22190 },
        { resId: 56, status: "failed" },
      ]);
      const failed = (await listTargets("r1")).find((x) => x.resId === 56)!;

      await retargetQueueTarget("r1", failed.id, ANDRES_57);

      const sent = (await listTargets("r1")).find((x) => x.resId === 55)!;
      expect(sent).toMatchObject({ status: "sent", attachmentId: 3266, messageId: 22190 });
    });

    it("refuses a sent target and changes nothing", async () => {
      seedRow({ id: "r1", status: "failed" });
      seedTargets("r1", [{ resId: 55, status: "sent", attachmentId: 1, messageId: 2 }]);
      const t = (await listTargets("r1"))[0];

      expect(await retargetQueueTarget("r1", t.id, ANDRES_57)).toBe("refused");
      expect((await listTargets("r1"))[0]).toMatchObject({ resId: 55, status: "sent" });
    });

    it("refuses a pending target, whose note may already be live", async () => {
      // A persistence failure after a successful message_post lands `pending`
      // WITH a message id. Re-pointing it would orphan a real note.
      seedRow({ id: "r1", status: "pending" });
      seedTargets("r1", [{ resId: 56, status: "pending", attachmentId: 3, messageId: 9 }]);
      const t = (await listTargets("r1"))[0];

      expect(await retargetQueueTarget("r1", t.id, ANDRES_57)).toBe("refused");
      expect((await listTargets("r1"))[0]).toMatchObject({ resId: 56, messageId: 9 });
    });

    it("refuses a failed target that somehow has a message id", async () => {
      seedRow({ id: "r1", status: "failed" });
      seedTargets("r1", [{ resId: 56, status: "failed", attachmentId: 3, messageId: 9 }]);
      const t = (await listTargets("r1"))[0];

      expect(await retargetQueueTarget("r1", t.id, ANDRES_57)).toBe("refused");
      expect((await listTargets("r1"))[0]).toMatchObject({ resId: 56, messageId: 9 });
    });

    it("reports a missing target as gone", async () => {
      seedRow({ id: "r1", status: "failed" });
      expect(await retargetQueueTarget("r1", "no-such-target", ANDRES_57)).toBe("gone");
    });

    it("refuses a record a sibling already has, and changes nothing", async () => {
      seedRow({ id: "r1", status: "failed" });
      seedTargets("r1", [
        { resId: 57, status: "sent", attachmentId: 1, messageId: 2 },
        { resId: 56, status: "failed", attachmentId: 3265 },
      ]);
      const t = (await listTargets("r1")).find((x) => x.resId === 56)!;

      expect(await retargetQueueTarget("r1", t.id, ANDRES_57)).toBe("duplicate");
      expect((await listTargets("r1")).find((x) => x.id === t.id)).toMatchObject({
        resId: 56, status: "failed", attachmentId: 3265,
      });
    });

    it("treats choosing the record it is already on as a duplicate, not a retry", async () => {
      // A "retarget" onto the same record would clear a possibly VALID
      // attachment and create a second one.
      seedRow({ id: "r1", status: "failed" });
      seedTargets("r1", [{ resId: 56, status: "failed", attachmentId: 3265 }]);
      const t = (await listTargets("r1"))[0];

      expect(
        await retargetQueueTarget("r1", t.id, { model: "res.partner", resId: 56, name: "X" })
      ).toBe("duplicate");
      expect((await listTargets("r1"))[0].attachmentId).toBe(3265);
    });
  });

  describe("retargetMeetingLogTarget", () => {
    const ANDRES_57 = { model: "res.partner", resId: 57, name: "Andres Vergara" } as const;

    it("re-points the target, pushes, and reports ok when every target lands", async () => {
      seedRow({ id: "r1", status: "failed", attempts: 4 });
      seedTargets("r1", [
        { resId: 55, status: "sent", attachmentId: 3266, messageId: 22190 },
        { resId: 56, status: "failed", attachmentId: 3265 },
      ]);
      const t = (await listTargets("r1")).find((x) => x.resId === 56)!;
      mockPush({ sent: [57], failed: [] });

      const res = await retargetMeetingLogTarget("r1", t.id, ANDRES_57, deps);

      expect(res).toEqual({ kind: "ok" });
      expect(push.pushQueuedRow).toHaveBeenCalledTimes(1);
      expect(await readRow("r1")).toMatchObject({ status: "sent" });
    });

    it("reports duplicate, pushes nothing, and leaves the target alone", async () => {
      seedRow({ id: "r1", status: "failed" });
      seedTargets("r1", [
        { resId: 57, status: "sent", attachmentId: 1, messageId: 2 },
        { resId: 56, status: "failed", attachmentId: 3265 },
      ]);
      const t = (await listTargets("r1")).find((x) => x.resId === 56)!;

      const res = await retargetMeetingLogTarget("r1", t.id, ANDRES_57, deps);

      expect(res).toEqual({ kind: "duplicate" });
      expect(push.pushQueuedRow).not.toHaveBeenCalled();
      expect((await listTargets("r1")).find((x) => x.id === t.id)).toMatchObject({ resId: 56 });
    });

    it("reports conflict and pushes nothing when the target is not retargetable", async () => {
      seedRow({ id: "r1", status: "failed" });
      seedTargets("r1", [{ resId: 55, status: "sent", attachmentId: 1, messageId: 2 }]);
      const t = (await listTargets("r1"))[0];

      const res = await retargetMeetingLogTarget("r1", t.id, ANDRES_57, deps);

      expect(res).toEqual({ kind: "conflict" });
      expect(push.pushQueuedRow).not.toHaveBeenCalled();
    });

    it("never pushes for a row that belongs to another Odoo database", async () => {
      seedRow({ id: "r1", status: "failed", instance: "http://other:8069|odoo" });
      seedTargets("r1", [{ resId: 56, status: "failed", attachmentId: 3265 }]);
      const t = (await listTargets("r1"))[0];

      const res = await retargetMeetingLogTarget("r1", t.id, ANDRES_57, deps);

      expect(res).toEqual({ kind: "conflict" });
      expect(push.pushQueuedRow).not.toHaveBeenCalled();
      expect((await listTargets("r1"))[0]).toMatchObject({ resId: 56, attachmentId: 3265 });
    });
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/tests/meeting-log-actions.test.ts -t retarget`
Expected: FAIL (`retargetQueueTarget is not a function`).

- [ ] **Step 3: Add the SQL and the DB function**

In `src/lib/database/meeting-log.action.ts`, in `QUEUE_SQL` directly after `targetToFailed`:

```ts
  // Points a FAILED target at a different record. The two guards are the whole
  // safety argument, not decoration:
  //   status = 'failed'      a `sent` target is immutable, and a `pending` one
  //                          may have a note in flight;
  //   message_id IS NULL     message_post never returned an id we stored. A
  //                          persistence failure AFTER a successful post lands
  //                          `pending`, never `failed`, so failed + no id proves
  //                          no note went out.
  // attachment_id is cleared, not kept: it hangs off the OLD record, and a
  // create against a deleted res_id succeeds while only message_post faults.
  retargetFailedTarget: `UPDATE meeting_log_targets
    SET model = ?, res_id = ?, name = ?, status = 'pending',
        attachment_id = NULL, message_id = NULL, sent_at = NULL,
        last_error = NULL, last_error_code = NULL
    WHERE id = ? AND row_id = ? AND status = 'failed' AND message_id IS NULL`,
```

Add `SelectedTarget` to that file's `@/types` import if it is not already imported, and add after `assignQueueRow`:

```ts
export type RetargetVerdict = "ok" | "gone" | "refused" | "duplicate";

/**
 * Re-points ONE failed target at another record; the parent row is the
 * caller's to flip (retargetMeetingLogTarget does, via retryQueueRow).
 *
 * `duplicate` covers the record ANOTHER target already has and the record this
 * target is already on. UNIQUE(row_id, model, res_id) would reject the first
 * as a raw constraint error; the second would clear a possibly valid
 * attachment and make a second one, so it is refused as well.
 */
export async function retargetQueueTarget(
  rowId: string,
  targetId: string,
  next: SelectedTarget
): Promise<RetargetVerdict> {
  const targets = await listTargets(rowId);
  const target = targets.find((t) => t.id === targetId);
  if (!target) return "gone";
  if (target.status !== "failed" || target.messageId !== null) return "refused";
  if (targets.some((t) => t.model === next.model && t.resId === next.resId)) return "duplicate";

  const db = await getDatabase();
  const res = await db.execute(QUEUE_SQL.retargetFailedTarget, [
    next.model, next.resId, next.name, targetId, rowId,
  ]);
  return (res.rowsAffected ?? 0) > 0 ? "ok" : "refused";
}
```

- [ ] **Step 4: Add the orchestration**

In `src/lib/odoo/meeting-log-actions.ts`: add `retargetQueueTarget` and `type RetargetVerdict` to the import from `@/lib/database/meeting-log.action`, add `SelectedTarget` to the `@/types` import, add to `ActionOutcome` (after `moved-unknown`):

```ts
  /**
   * The chosen record is already on this meeting, so nothing was written.
   * Not `conflict`: the user needs to be told to pick someone else, not that
   * another window got there first.
   */
  | { kind: "duplicate" }
```

and add after `assignMeetingLog`:

```ts
/**
 * Swaps ONE failed target for another record and pushes at once.
 *
 * Goes through runAction so it inherits the credential check, the instance
 * check, the push and the partial-send classification. Because `attempts` is
 * already above zero the push takes the adopt-search path and creates a fresh
 * attachment on the new record. A holder object, not a `let`, carries the
 * verdict out of the cas closure: TypeScript narrows a captured `let` to its
 * initial value and would call the `duplicate` comparison unreachable.
 */
export async function retargetMeetingLogTarget(
  rowId: string,
  targetId: string,
  next: SelectedTarget,
  deps: ActionDeps
): Promise<ActionOutcome> {
  const seen: { verdict: RetargetVerdict } = { verdict: "ok" };
  const outcome = await runAction(
    rowId,
    async () => {
      seen.verdict = await retargetQueueTarget(rowId, targetId, next);
      if (seen.verdict !== "ok") return false;
      // Same parent CAS as retryTarget: failed/pending -> pending, so the push
      // below (and the sweep, if it never runs) picks the target up.
      return retryQueueRow(rowId);
    },
    deps
  );
  if (outcome.kind === "conflict" && seen.verdict === "duplicate") return { kind: "duplicate" };
  return outcome;
}
```

- [ ] **Step 5: Close the exhaustive switch in the hook**

`outcomeCopy` in `src/hooks/useMeetingLogQueue.ts` is an exhaustive switch over `ActionOutcome`, so the new kind must be handled in this task or type-check goes red. Add before `case "conflict":`:

```ts
    case "duplicate":
      // Nothing was written, and the row still needs a contact from the user.
      return "That contact is already on this meeting. Choose someone else.";
```

- [ ] **Step 6: Run to verify they pass**

Run: `npx vitest run src/tests/meeting-log-actions.test.ts src/tests/meeting-log.action.test.ts && npm run type-check && npm run lint`
Expected: PASS, including every pre-existing case. (The test file's outer `beforeEach` re-arms `push.pushQueuedRow`, so the `not.toHaveBeenCalled()` assertions start from a clean count. Another-database rows return `conflict` from `runAction`'s pre-CAS instance check, the same as the existing retry case at line 462.)

- [ ] **Step 7: Commit**

```bash
git add src/lib/database/meeting-log.action.ts src/lib/odoo/meeting-log-actions.ts src/hooks/useMeetingLogQueue.ts src/tests/meeting-log-actions.test.ts
git commit -m "feat(meeting-log): retarget one failed target to another record

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 5: Hook state and a "Choose a different contact" button on `QueueRow`

**Files:**
- Modify: `src/hooks/useMeetingLogQueue.ts` (state, three handlers, conflict copy, return values)
- Modify: `src/pages/meetings/components/QueueRow.tsx` (props at ~71, destructure at ~222, buttons at ~482-496, memo comparator at ~677)
- Modify: `src/pages/meetings/components/QueueStrip.tsx` (Pick list at line 40, destructure at ~129, prop at ~178)
- Modify: `src/pages/meetings/index.tsx` (one prop on `QueueStrip`)
- Modify: `src/tests/meeting-log-page.test.tsx` (`actions` mock; fixture at ~2405), `src/tests/queue-row.summary-expand.test.tsx:57` (fixture)
- Test: create `src/tests/queue-row.retarget.test.tsx`

**Interfaces:**
- Consumes: `retargetMeetingLogTarget(rowId, targetId, next, deps): Promise<ActionOutcome>` (Task 4); `AssignPayload { targets: SelectedTargets; providerConfig }` (existing export of `AssignDialog.tsx`); `runRowAction(row, run, successCopy, conflictCopy)` (existing, in the hook); `MeetingLogTarget` (has `attachmentId`, `messageId`).
- Produces:
  - hook returns `retarget: { row: MeetingLogListRow; target: MeetingLogTarget } | null`, `handleRetargetTarget(row, target)`, `handleRetargetConfirm(row, target, payload)`, `handleRetargetCancel()`
  - `QueueRowProps.onRetargetTarget: (row: MeetingLogListRow, target: MeetingLogTarget) => void`
  - `QueueStripProps` accepts `handleRetargetTarget`; Task 6 renders the dialog that consumes `retarget`, `handleRetargetConfirm` and `handleRetargetCancel`.

- [ ] **Step 1: Write the failing tests**

Create `src/tests/queue-row.retarget.test.tsx`:

```tsx
import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@/lib/database", () => ({
  getMeetingSummaryByConversation: vi.fn(),
  getEntitiesForSummary: vi.fn(async () => []),
}));

import { QueueRow, type QueueRowProps } from "@/pages/meetings/components/QueueRow";
import type { MeetingLogListRow, MeetingLogTarget } from "@/types";

const INSTANCE = "http://h:8069|odoo";

// Same fixture shape as queue-row.summary-expand.test.tsx (BASE_ROW / baseProps),
// with `targets` and a failed status. The expand button is named "Expand
// targets" and each expanded target is a role="group" labelled "<name> (#<resId>)".
const BASE_ROW: MeetingLogListRow = {
  id: "qr-1",
  session_key: "s1",
  conversation_id: null,
  instance: INSTANCE,
  contact_id: null,
  lead_id: null,
  transcript_start_at: 1_700_000_000_000,
  transcript_end_at: 1_700_000_060_000,
  attachment_id: null,
  message_id: null,
  status: "failed",
  attempts: 4,
  claimed_at: null,
  last_error: null,
  last_error_code: null,
  meeting_started_at: 1_700_000_000_000,
  created_at: 1_700_000_000_000,
  sent_at: null,
  targets: [],
};

function target(over: Partial<MeetingLogTarget> = {}): MeetingLogTarget {
  return {
    id: "t-1", rowId: "qr-1", model: "res.partner", resId: 56, name: "Andres Vergara",
    status: "failed", attachmentId: null, messageId: null,
    lastError: "ODOO_FAULT: Odoo fault 2", lastErrorCode: "ODOO_FAULT",
    createdAt: 1, sentAt: null, ...over,
  };
}

function props(targets: MeetingLogTarget[], over: Partial<QueueRowProps> = {}): QueueRowProps {
  return {
    row: { ...BASE_ROW, targets },
    targetName: "Someone",
    conversationTitle: null,
    isRenaming: false,
    instance: INSTANCE,
    busy: false,
    stale: false,
    outcome: null,
    transcript: null,
    contacts: new Map(),
    onRetry: vi.fn(),
    onAssign: vi.fn(),
    onDelete: vi.fn(),
    onToggleTranscript: vi.fn(),
    onReloadTranscript: vi.fn(),
    onRetryTarget: vi.fn(),
    onRemoveTarget: vi.fn(),
    onRetargetTarget: vi.fn(),
    onStartRename: vi.fn(),
    onCommitRename: vi.fn(async () => true),
    onCancelRename: vi.fn(),
    ...over,
  };
}

async function expand() {
  await userEvent.click(screen.getByRole("button", { name: "Expand targets" }));
  return screen.getByRole("group", { name: /Andres Vergara/ });
}

describe("QueueRow retarget", () => {
  it("offers a different contact on a failed target, even beside a sent sibling", async () => {
    const sent = target({ id: "t-0", resId: 55, name: "Anja", status: "sent", messageId: 1 });
    render(<QueueRow {...props([sent, target()])} />);
    const group = await expand();
    expect(within(group).getByRole("button", { name: /choose a different contact/i })).toBeVisible();
  });

  it("hands up the row and the clicked target", async () => {
    const t = target();
    const p = props([t]);
    render(<QueueRow {...p} />);
    const group = await expand();
    await userEvent.click(within(group).getByRole("button", { name: /choose a different contact/i }));
    expect(p.onRetargetTarget).toHaveBeenCalledWith(p.row, t);
  });

  it("does not offer Remove on a target that already made an attachment", async () => {
    // removeQueueTarget refuses these, so the button would only ever say no.
    render(<QueueRow {...props([target({ attachmentId: 3265 })])} />);
    const group = await expand();
    expect(within(group).queryByRole("button", { name: /^remove$/i })).toBeNull();
    expect(within(group).getByRole("button", { name: /retry this one/i })).toBeVisible();
  });

  it("still offers Remove on a failed target that never made one", async () => {
    render(<QueueRow {...props([target()])} />);
    const group = await expand();
    expect(within(group).getByRole("button", { name: /^remove$/i })).toBeVisible();
  });

  it("offers nothing on a sent target", async () => {
    render(<QueueRow {...props([target({ status: "sent", messageId: 9, name: "Andres Vergara" })])} />);
    const group = await expand();
    expect(within(group).queryByRole("button", { name: /choose a different contact/i })).toBeNull();
  });

  it("disables it for a row that belongs to another database", async () => {
    render(<QueueRow {...props([target()], { instance: "http://elsewhere|odoo" })} />);
    const group = await expand();
    expect(within(group).getByRole("button", { name: /choose a different contact/i })).toBeDisabled();
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/tests/queue-row.retarget.test.tsx`
Expected: FAIL (no button named "Choose a different contact").

- [ ] **Step 3: Implement in `QueueRow.tsx`**

Add the prop to `QueueRowProps` beside `onRemoveTarget`:

```ts
  /** Swap one failed target for another contact. The page opens the picker. */
  onRetargetTarget: (row: MeetingLogListRow, target: MeetingLogTarget) => void;
```

Destructure `onRetargetTarget,` after `onRemoveTarget,` in `QueueRowInner`, add `a.onRetargetTarget === b.onRetargetTarget &&` after the `onRemoveTarget` line in the memo comparator, and replace the failed-target button block:

```tsx
                {targetsExpanded && targetActionsAllowed && t.status === "failed" && (
                  <>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={otherDatabase}
                      onClick={() => onRetryTarget(row, t)}
                    >
                      Retry this one
                    </Button>
                    {/*
                      Distinct from the ROW-level Reassign, which is hidden the
                      moment any sibling is sent. This one re-points ONLY this
                      target, so it is the way out when the contact it names
                      was deleted in Odoo. Needs no message id: retargetQueueTarget
                      refuses a target whose note may be live.
                    */}
                    {t.messageId === null && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={otherDatabase}
                        onClick={() => onRetargetTarget(row, t)}
                      >
                        Choose a different contact
                      </Button>
                    )}
                    {/*
                      removeQueueTarget refuses any target that already made an
                      attachment or a message (a note may be live), so offering
                      Remove there is a button that can only say no - the same
                      reasoning as hasSentTarget above.
                    */}
                    {t.attachmentId === null && t.messageId === null && (
                      <Button size="sm" variant="ghost" onClick={() => onRemoveTarget(row, t)}>
                        Remove
                      </Button>
                    )}
                  </>
                )}
```

- [ ] **Step 4: Add the hook state and handlers**

In `src/hooks/useMeetingLogQueue.ts`:

1. Import `retargetMeetingLogTarget` alongside `assignMeetingLog` from `@/lib/odoo/meeting-log-actions`.
2. Next to the `assignRow` state add:

```ts
  /**
   * The failed target being swapped, with its row as an OBJECT for the same
   * reason `assignRow` is one: the CAS matches on ids, so a stale snapshot is
   * harmless, and a re-read that dropped the row must not leave Confirm with
   * nothing to name. `null` is the closed state.
   */
  const [retarget, setRetarget] = useState<{
    row: MeetingLogListRow;
    target: MeetingLogTarget;
  } | null>(null);
```

3. Next to `ASSIGN_CONFLICT_COPY` add:

```ts
const RETARGET_CONFLICT_COPY =
  "That contact could not be swapped in — this meeting changed in another window.";
```

4. After `handleAssignCancel` add:

```ts
  const handleRetargetTarget = useCallback(
    (row: MeetingLogListRow, target: MeetingLogTarget) => {
      if (busyRef.current.has(row.id)) return;
      setRetarget({ row, target });
    },
    []
  );

  /** Same shape as `handleAssignConfirm`: the dialog unmounts first, the page owns the push. */
  const handleRetargetConfirm = useCallback(
    (row: MeetingLogListRow, target: MeetingLogTarget, payload: AssignPayload) => {
      setRetarget(null);
      const next = payload.targets[0];
      if (!next) return;
      void runRowAction(
        row,
        () =>
          retargetMeetingLogTarget(row.id, target.id, next, {
            providerConfig: payload.providerConfig,
            onCommitted: () => void loaderRef.current(),
          }),
        SENT_COPY,
        RETARGET_CONFLICT_COPY
      );
    },
    [runRowAction]
  );

  const handleRetargetCancel = useCallback(() => setRetarget(null), []);
```

5. Add `retarget,`, `handleRetargetTarget,`, `handleRetargetConfirm,` and `handleRetargetCancel,` to the returned object, beside `assignRow` and `handleRemoveTarget`.

Use the exact names `busyRef`, `loaderRef`, `runRowAction`, `SENT_COPY` and `AssignPayload` as they appear next to `handleAssignConfirm` (~line 696); this block mirrors it line for line.

- [ ] **Step 5: Thread it through `QueueStrip.tsx` and the page**

`QueueStrip.tsx`: add `| "handleRetargetTarget"` after `| "handleRemoveTarget"` in the `Pick` union, add `handleRetargetTarget,` after `handleRemoveTarget,` in the destructure, and add `onRetargetTarget={handleRetargetTarget}` after `onRemoveTarget={handleRemoveTarget}` on `<QueueRow>`.

`src/pages/meetings/index.tsx`: add `handleRetargetTarget={queue.handleRetargetTarget}` after `handleRemoveTarget={queue.handleRemoveTarget}` on `<QueueStrip>`.

- [ ] **Step 6: Update the fixtures and the page's action mock**

Add `onRetargetTarget: vi.fn(),` after `onRemoveTarget: vi.fn(),` in `src/tests/meeting-log-page.test.tsx:2405` and `src/tests/queue-row.summary-expand.test.tsx:57`. In the hoisted `actions` mock of `meeting-log-page.test.tsx` (lines 28-39) add `retargetMeetingLogTarget: vi.fn(),` after `removeQueueTarget: vi.fn(),`.

- [ ] **Step 7: Run to verify they pass**

Run: `npx vitest run src/tests/queue-row.retarget.test.tsx src/tests/queue-row.summary-expand.test.tsx && npx vitest run src/tests/meeting-log-page.test.tsx && npm run type-check && npm run lint`
Expected: PASS everywhere.

- [ ] **Step 8: Commit**

```bash
git add src/hooks/useMeetingLogQueue.ts src/pages/meetings/components/QueueRow.tsx src/pages/meetings/components/QueueStrip.tsx src/pages/meetings/index.tsx src/tests/queue-row.retarget.test.tsx src/tests/meeting-log-page.test.tsx src/tests/queue-row.summary-expand.test.tsx
git commit -m "feat(meetings): offer a different contact on a failed target

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 6: Single-target `AssignDialog` and the page's second dialog

**Files:**
- Modify: `src/pages/meetings/components/AssignDialog.tsx` (new `replacing` prop)
- Modify: `src/pages/meetings/index.tsx` (render the second dialog)
- Modify: `src/tests/meeting-log-page.test.tsx` (new dialog cases and one page-level flow)

**Interfaces:**
- Consumes: from the hook (Task 5) `retarget`, `handleRetargetConfirm(row, target, payload)`, `handleRetargetCancel()`; `retargetMeetingLogTarget` mock already in the page test's hoisted `actions`.
- Produces: `AssignDialogProps.replacing?: MeetingLogTarget`.

- [ ] **Step 1: Write the failing dialog tests**

In `src/tests/meeting-log-page.test.tsx`, add inside `describe("AssignDialog", ...)` after its last `it`:

```tsx
  describe("replacing one target", () => {
    const DEAD = {
      id: "t-56", rowId: "r1", model: "res.partner" as const, resId: 56,
      name: "Andres Vergara", status: "failed" as const, attachmentId: 3265,
      messageId: null, lastError: "ODOO_FAULT", lastErrorCode: "ODOO_FAULT",
      createdAt: 1, sentAt: null,
    };
    const ANDRES_57 = contact({ id: 57, name: "Andres Vergara", companyName: "Invest Conservation" });

    function replacingProps() {
      return {
        row: row({ id: "r1", status: "failed" }),
        instance: INSTANCE,
        replacing: DEAD,
        onConfirm: vi.fn(),
        onCancel: vi.fn(),
      };
    }

    it("titles itself for the contact being replaced", async () => {
      contacts.listContacts.mockResolvedValue([ANDRES_57]);
      render(<AssignDialog {...replacingProps()} />);
      await screen.findByPlaceholderText("Search contacts");
      expect(screen.getByRole("heading", { name: /choose a different contact/i })).toBeVisible();
    });

    it("does not offer the dead contact it is replacing", async () => {
      contacts.listContacts.mockResolvedValue([
        contact({ id: 56, name: "Andres Vergara" }),
        ANDRES_57,
      ]);
      render(<AssignDialog {...replacingProps()} />);
      await screen.findByPlaceholderText("Search contacts");
      // Both are named "Andres Vergara"; only the live one (57) may remain.
      expect(screen.getAllByRole("button", { name: /add Andres Vergara/i })).toHaveLength(1);
    });

    it("keeps exactly one choice: picking a second replaces the first", async () => {
      const BENTLEY = contact({ id: 3, name: "Bentley AS" });
      contacts.listContacts.mockResolvedValue([ANDRES_57, BENTLEY]);
      const props = replacingProps();
      render(<AssignDialog {...props} />);
      await screen.findByPlaceholderText("Search contacts");

      await userEvent.click(screen.getByRole("button", { name: /add Andres Vergara/i }));
      await userEvent.click(screen.getByRole("button", { name: /add Bentley AS/i }));
      await userEvent.click(screen.getByRole("button", { name: "Log this meeting" }));

      expect(props.onConfirm).toHaveBeenCalledWith(
        expect.objectContaining({
          targets: [{ model: "res.partner", resId: 3, name: "Bentley AS" }],
        })
      );
    });

    it("hands up the chosen contact on Confirm", async () => {
      contacts.listContacts.mockResolvedValue([ANDRES_57]);
      const props = replacingProps();
      render(<AssignDialog {...props} />);
      await screen.findByPlaceholderText("Search contacts");

      await userEvent.click(screen.getByRole("button", { name: /add Andres Vergara/i }));
      await userEvent.click(screen.getByRole("button", { name: "Log this meeting" }));

      expect(props.onConfirm).toHaveBeenCalledWith(
        expect.objectContaining({
          targets: [{ model: "res.partner", resId: 57, name: "Andres Vergara" }],
        })
      );
    });
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/tests/meeting-log-page.test.tsx -t "replacing one target"`
Expected: FAIL (heading text is "Reassign this meeting", the dead contact is offered, and a second pick appends).

- [ ] **Step 3: Implement the dialog change**

In `src/pages/meetings/components/AssignDialog.tsx`:

1. Import the type: add `MeetingLogTarget` to the existing `@/types` import.
2. Add to `AssignDialogProps`:

```ts
  /**
   * Set when the dialog swaps ONE failed target rather than assigning the whole
   * meeting. The list then holds a single choice (picking another replaces it)
   * and the record being replaced is not offered.
   */
  replacing?: MeetingLogTarget;
```

3. Destructure it: `export function AssignDialog({ row, instance, replacing, onConfirm, onCancel }: AssignDialogProps) {`
4. In `visible`, filter out the dead record and add `replacing` to the dependency list:

```tsx
  const visible = useMemo(
    // `filterContacts` returns a COPY, which is what makes the in-place sort
    // safe here; sorting its argument would reorder the cache during render.
    () =>
      filterContacts(contacts, query)
        // The record being replaced is dead or wrong by definition; until the
        // next sync drops it from the cache it must not be pickable again.
        .filter((c) => !(replacing?.model === "res.partner" && c.id === replacing.resId))
        .sort(compareContacts)
        .slice(0, MAX_CONTACT_ROWS),
    [contacts, query, replacing]
  );
```

5. In `addTarget`, make it single-choice when replacing, as the first line of the updater, and have `atCap` ignore the cap:

```tsx
    setTargets((prev) => {
      // One choice only: a swap has exactly one destination.
      if (replacing) return [t];
      const idx = prev.findIndex((x) => x.model === t.model && x.resId === t.resId);
```

Change `const atCap = targets.length >= MAX_TARGETS;` to `const atCap = !replacing && targets.length >= MAX_TARGETS;` and add `replacing` to `addTarget`'s `useCallback` dependency array (currently `[]`).

6. Title:

```tsx
          <DialogTitle>
            {replacing
              ? "Choose a different contact"
              : row.status === "failed"
                ? "Reassign this meeting"
                : "Assign this meeting"}
          </DialogTitle>
```

- [ ] **Step 4: Run to verify the dialog tests pass**

Run: `npx vitest run src/tests/meeting-log-page.test.tsx -t "AssignDialog"`
Expected: PASS, including the existing `AssignDialog` cases (no `replacing` means unchanged behaviour).

- [ ] **Step 5: Render the second dialog**

In `src/pages/meetings/index.tsx`: after `const assignRow = queue.assignRow;` add `const retarget = queue.retarget;` (a local, so TypeScript narrows it inside the JSX), and after the existing `AssignDialog` block add:

```tsx
      {retarget !== null && (
        <AssignDialog
          key={`${retarget.row.id}:${retarget.target.id}`}
          row={retarget.row}
          replacing={retarget.target}
          instance={queue.instance}
          onConfirm={(payload) =>
            queue.handleRetargetConfirm(retarget.row, retarget.target, payload)
          }
          onCancel={queue.handleRetargetCancel}
        />
      )}
```

- [ ] **Step 6: Write and run one page-level test**

Add to `src/tests/meeting-log-page.test.tsx`, in the page-level describe that renders the full page with `renderPage()` (the block containing the `listContacts` cache case near line 1274), a case that drives the whole flow:

```tsx
  it("swaps one failed target for another contact from the queue page", async () => {
    contacts.listContacts.mockResolvedValue([
      contact({ id: 57, name: "Andres Vergara", companyName: "Invest Conservation" }),
    ]);
    actions.retargetMeetingLogTarget.mockResolvedValue({ kind: "ok" });
    db.listActionableRows.mockResolvedValue([
      row({
        id: "na",
        status: "failed",
        targets: [
          { id: "t-55", rowId: "na", model: "res.partner", resId: 55, name: "Anja",
            status: "sent", attachmentId: 1, messageId: 2, lastError: null,
            lastErrorCode: null, createdAt: 1, sentAt: 1 },
          { id: "t-56", rowId: "na", model: "res.partner", resId: 56, name: "Andres Vergara",
            status: "failed", attachmentId: 3265, messageId: null, lastError: "ODOO_FAULT",
            lastErrorCode: "ODOO_FAULT", createdAt: 1, sentAt: null },
        ],
      }),
    ]);
    await renderPage();

    await userEvent.click(await screen.findByRole("button", { name: "Expand targets" }));
    await userEvent.click(screen.getByRole("button", { name: /choose a different contact/i }));
    await userEvent.click(await screen.findByRole("button", { name: /add Andres Vergara/i }));
    await userEvent.click(screen.getByRole("button", { name: "Log this meeting" }));

    await waitFor(() =>
      expect(actions.retargetMeetingLogTarget).toHaveBeenCalledWith(
        "na",
        "t-56",
        { model: "res.partner", resId: 57, name: "Andres Vergara" },
        // providerConfig may legitimately be null on this page, so match the
        // callback the hook always adds instead of the config.
        expect.objectContaining({ onCommitted: expect.any(Function) })
      )
    );
  });
```

Run: `npx vitest run src/tests/meeting-log-page.test.tsx`
Expected: PASS.

- [ ] **Step 7: Type-check, lint, and run the related suites**

Run: `npm run type-check && npm run lint && npx vitest run src/tests/meeting-log-actions.test.ts src/tests/queue-row.retarget.test.tsx`, then `npx vitest run src/tests/meeting-log-page.test.tsx` on its own.
Expected: PASS everywhere.

- [ ] **Step 8: Commit**

```bash
git add src/pages/meetings/components/AssignDialog.tsx src/pages/meetings/index.tsx src/tests/meeting-log-page.test.tsx
git commit -m "feat(meetings): pick a different contact for one failed target

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 7: Manual acceptance against the real database

No code. Run once after Tasks 3 to 6 are merged and built.

- [ ] **Step 1: Dead id leaves the cache.** Start Meetwings and let the app-start sync run (or press Refresh in the picker). Close it, then run:

```bash
node -e "import('node:sqlite').then(({DatabaseSync})=>{const db=new DatabaseSync(process.env.APPDATA+'/com.meetwings.app/meetwings.db',{readOnly:true});console.log(JSON.stringify(db.prepare(\"SELECT id,name,company_name FROM odoo_contacts WHERE name LIKE '%Vergara%'\").all()))})"
```

Expected: only `id 57`. `id 56` is gone. If it is still present, check the app log for `[Odoo] contact reconcile skipped` (the permissions guard) or `contact reconcile failed`.

- [ ] **Step 2: Retarget works in the UI.** If Task 2 was not used, open the Meetings page, expand the `Andres Vergara` failed target, click **Choose a different contact**, pick the Invest Conservation entry, click **Log this meeting**.
Expected: the row shows `Sent to 3 of 3` (or the summary-degraded variant), the target status is `sent`, and Odoo record 57's chatter shows the note.

- [ ] **Step 3: The message is readable next time.** Point any test target at a nonexistent partner and let it fail once.
Expected: the row's error reads `ODOO_FAULT: Odoo fault 2 - Record does not exist or has been deleted.`, not `Odoo fault 2` alone.

- [ ] **Step 4: Clean up.** Remove the untracked diagnostic probe from the diagnosis: `.livecheck/odoo-andres-probe.live.ts` and `.livecheck/vitest.andres.config.ts`, unless you want to keep them as a template.
