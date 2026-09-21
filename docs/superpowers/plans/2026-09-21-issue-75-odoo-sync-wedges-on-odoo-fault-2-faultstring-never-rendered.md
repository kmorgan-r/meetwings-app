# Issue 75 — Odoo fault legibility, probe-before-create, contact-sync page isolation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make an Odoo XML-RPC fault name its cause in the queue text, stop the push from writing an attachment to an unproven record, and let the contacts sync walk past a faulting record instead of dying on it — plus remove the livecheck-disproven archived-target gates in AssignDialog.

**Architecture:** Four local edits. (1) `queueErrorText` composes `details.faultString` (redacted, capped) into the persisted `last_error`. (2) `createOrAdoptAttachment` gains an existence probe between the adopt-search and `ir.attachment.create`; a zero-row probe result throws a synthesized `ODOO_FAULT` whose text rides in `err.message` — no wire write happens on an unproven record. (3) The contacts-sync page fetch gains fault isolation: on `ODOO_FAULT` it re-names the page's ids with a field-less plain `search`, bisects the reads halving on each fault, skips a still-faulting singleton, and a zero-ingested page fails the run loudly. (4) AssignDialog drops `disabled={!c.active}` and the disproven comments; the `Archived` tag survives as the only trace.

**Tech Stack:** React 19 + TypeScript + Vitest (sql.js in-memory DB for push/sweep suites), Tauri 2 plugin-http, Odoo 17 XML-RPC.

**Spec:** `docs/superpowers/specs/2026-09-21-issue-75-odoo-sync-wedges-on-odoo-fault-2-faultstring-never-rendered.md` — the plan argues from the spec; executors read both.

## Global Constraints

- **Never run the full test suite.** Every test step runs `npx vitest run <files>` scoped to named files only (`test_paths` discipline). Vitest is the only runner.
- **Redaction fail-closed.** Anything Odoo-derived that reaches a persisted or rendered string passes through the redactor. `faultString` is server text that can embed record names, emails and API keys.
- **`isRetryable` and the error-code table are untouched.** `ODOO_FAULT` stays `isRetryable() === false`. The probe's synthesized fault is `ODOO_FAULT` precisely so it is terminal.
- **No DB-layer changes.** `targetToFailed`, `targetToPending`, `sweepable`, `deriveRowStatus` and the error columns already model every state this design produces. No migration.
- **No attempt cap on `retryTarget`.** Spec Out-list. `retryTarget` and `meeting-log-actions.test.ts` are untouched.
- **No backfill of stored error texts.** Historical `last_error` stays as written.
- **XML-RPC wire-shape rules the tests must assert:** a plain `search` takes NO `fields` kwarg (server-side fault); any read of partner data carries `context: { active_test: false }` (archived records are still valid data).
- **Archiving is not an error** (livecheck-proven): `message_post` on an archived `res.partner` succeeds. No archived-specific gate, copy, or status is added anywhere.
- Path alias `@/`; files kebab-case; run all commands from the repo root of this worktree.
- Commit messages: Conventional Commits, each ending with `Co-Authored-By: Claude Code <noreply@anthropic.com>`.

---

### Task 1: `queueErrorText` renders `faultString` (redacted, capped)

**Files:**
- Modify: `src/lib/odoo/meeting-log.ts:374-381` (`queueErrorText`)
- Test: `src/tests/odoo-meeting-log-render.test.ts` (new cases in the `queueErrorText` describe)
- Test: `src/tests/odoo-client.test.ts` (one end-to-end needle case)

**Interfaces:**
- Consumes: `OdooError.details` (`Record<string, string | number>`), `getRedactor()`, `isRedactorInitialised()` — all unchanged.
- Produces: `queueErrorText(thrown: unknown): { code: string; text: string }` — same signature. New behaviour: when `details.faultString` is a non-empty string, `text` is `${code}: ${message}[- ${detail}] - ${redacted faultString}`, capped at 400 chars with a trailing `…`. Every other error shape keeps today's output byte for byte. Task 2's synthesized fault and Task 3's callers rely on nothing new here — only the composition changes.

- [ ] **Step 1: Write the failing render tests**

Add to the existing `describe("queueErrorText")` block in `src/tests/odoo-meeting-log-render.test.ts` (import `OdooError` alongside `odooError`):

```ts
import { odooError, OdooError } from "@/lib/odoo/errors";
```

```ts
it("renders faultString after the message, both halves redacted", () => {
  setOdooRedactor(["sk-secret"]);
  // `new OdooError`, NOT `odooError()`: odooError redacts details.faultString at
  // construction, so a render-suite needle built with it never reaches
  // queueErrorText raw and the composition-half redaction passes vacuously.
  const err = new OdooError("ODOO_FAULT", "Odoo fault 2", {
    faultCode: 2,
    faultString: "AccessError: no match for sk-secret here",
  });
  const out = queueErrorText(err);
  expect(out.code).toBe("ODOO_FAULT");
  expect(out.text).toBe("ODOO_FAULT: Odoo fault 2 - AccessError: no match for [REDACTED] here");
});

it("keeps today's byte-identical output when faultString is absent, empty, or not a string", () => {
  setOdooRedactor(["sk-secret"]);
  const absent = queueErrorText(odooError("ODOO_FAULT", "Odoo fault 2"));
  const empty = queueErrorText(
    new OdooError("ODOO_FAULT", "Odoo fault 2", { faultString: "" })
  );
  const numeric = queueErrorText(
    new OdooError("ODOO_FAULT", "Odoo fault 2", { faultString: 2 as unknown as string })
  );
  const nulled = queueErrorText(
    new OdooError("ODOO_FAULT", "Odoo fault 2", { faultString: null as unknown as string })
  );
  for (const out of [absent, empty, numeric, nulled]) {
    expect(out.text).toBe("ODOO_FAULT: Odoo fault 2"); // no trailing " - "
  }
});

it("caps a 10k-character internal-fault traceback at 400 characters with an ellipsis", () => {
  setOdooRedactor(["sk-secret"]);
  const err = new OdooError("ODOO_FAULT", "Odoo fault 1", {
    faultCode: 1,
    faultString: "x".repeat(10_000),
  });
  const out = queueErrorText(err);
  expect(out.text.length).toBe(401);
  expect(out.text.endsWith("…")).toBe(true);
});

it("redacts a key that arrives raw in a directly-constructed faultString", () => {
  // Construction-time redaction is BYPASSED on purpose (raw OdooError) so the
  // composition's own redact() call is load-bearing, not decorative.
  setOdooRedactor(["sk-secret"]);
  const err = new OdooError("ODOO_FAULT", "Odoo fault 2", {
    faultCode: 2,
    faultString: "Traceback mentioning sk-secret in the payload",
  });
  const out = queueErrorText(err);
  expect(out.text).not.toContain("sk-secret");
  expect(out.text).toContain("Traceback mentioning"); // benign half survives
});
```

- [ ] **Step 2: Run the render tests, verify they fail**

Run: `npx vitest run src/tests/odoo-meeting-log-render.test.ts`
Expected: FAIL — the four new cases fail (today's text has no faultString half, no cap); all existing fixtures at `:124-147` pass.

- [ ] **Step 3: Implement the composition in `queueErrorText`**

Replace the body of `queueErrorText` (`src/lib/odoo/meeting-log.ts:374-381`), keeping the doc comment and adding the faultString paragraphs to it:

```ts
export function queueErrorText(thrown: unknown): { code: string; text: string } {
  const err = toOdooError(thrown);
  if (!isRedactorInitialised()) return { code: err.code, text: err.code };
  const redact = getRedactor();
  const detail = typeof err.details.detail === "string" ? err.details.detail : "";
  const message = detail ? `${err.message} - ${detail}` : err.message;
  // faultString is the one detail family whose VALUE is the answer the queue
  // row needs (the code's own message is the placeholder "Odoo fault N"). The
  // guard is a truthiness check on the value, NOT `"faultString" in details`:
  // a key with an empty-string value must fall back byte-identically, and an
  // `in` check passes it.
  const faultString =
    typeof err.details.faultString === "string" && err.details.faultString.length > 0
      ? err.details.faultString
      : "";
  let text = `${err.code}: ${redact(message)}`;
  if (faultString) {
    // The redactor runs on the faultString half exactly as on the rest: it is
    // Odoo-derived server text that can embed record names, emails and keys.
    // An INTERNAL fault (code 1) can carry a full Python traceback here, and
    // this column is rendered verbatim in every queue group - hence the cap.
    text = `${text} - ${redact(faultString)}`;
    if (text.length > 400) text = `${text.slice(0, 400)}…`;
  }
  return { code: err.code, text };
}
```

- [ ] **Step 4: Add the end-to-end needle case to the client suite**

In `src/tests/odoo-client.test.ts` add the import and the case inside `describe("createOdooClient")`:

```ts
import { queueErrorText } from "@/lib/odoo/meeting-log";
```

```ts
// THE wire-to-storage proof this fix exists for: wire XML carrying an
// XML-escaped key inside faultString → codec unescape (&amp; last) → the
// client's odooError() → queueErrorText. A naive replaceAll on the ESCAPED
// form misses; the unescape-and-redact chain must catch it. This is the only
// test that proves the composed stored text is needle-free from the wire down.
it("renders a wire fault through queueErrorText with the key gone end-to-end", async () => {
  mockFetch.mockResolvedValueOnce(
    faultResponse(`Traceback: create('odoo', '${LOGIN}', '${KEY}', {})`)
  );
  let caught: OdooError | null = null;
  try {
    await createOdooClient(CONFIG).authenticate();
  } catch (err) {
    caught = err as OdooError;
  }
  expect(caught?.code).toBe("ODOO_FAULT");
  const { text } = queueErrorText(caught);
  expect(text).not.toContain("i9j0");
  expect(text).not.toContain("example.com");
  // The fix's whole point: the faultString SURVIVES into the stored text
  // (redacted), where today's queueErrorText drops it entirely.
  expect(text).toContain("Odoo fault 3");
  expect(text).toContain("Traceback");
});
```

- [ ] **Step 5: Run both suites, verify green**

Run: `npx vitest run src/tests/odoo-meeting-log-render.test.ts src/tests/odoo-client.test.ts`
Expected: PASS — all new cases green; every existing fixture byte-identical (no cap and no faultString half on non-fault errors).

- [ ] **Step 6: Commit**

```bash
git add src/lib/odoo/meeting-log.ts src/tests/odoo-meeting-log-render.test.ts src/tests/odoo-client.test.ts
git commit -m "feat: render Odoo faultString in the queue error text (redacted, 400-char cap)

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 2: Existence probe in `createOrAdoptAttachment` — no attachment on an unproven record

**Files:**
- Modify: `src/lib/odoo/meeting-log-push.ts:245-263` (`createOrAdoptAttachment`)
- Test: `src/tests/odoo-meeting-log-push.test.ts` (stub model-awareness, new probe legs, wire-chain re-points)
- Test: `src/tests/odoo-meeting-log-sweep.test.ts` (stub answers the probe + one dead-target sweep case)

**Interfaces:**
- Consumes: `deps.client.execute(model, method, args, kwargs)`, `firstId` (local helper, unchanged), `expectInt`, `odooError` — all already imported in `meeting-log-push.ts`.
- Produces: NO signature change. `createOrAdoptAttachment(target, attemptsBefore, deps)` keeps its shape; on a zero-row probe result it throws `odooError("ODOO_FAULT", "target record <resId> missing or inaccessible (search returned 0 rows)", { resId, model })`, which the existing per-target catch records as `last_error_code: "ODOO_FAULT"` and `last_error: "ODOO_FAULT: target record <resId> missing or inaccessible (search returned 0 rows)"` via `queueErrorText` (Task 1). Probe rejections propagate untouched (no wrapping).

- [ ] **Step 1: Write the failing probe tests (fake-client section)**

In `src/tests/odoo-meeting-log-push.test.ts`, inside `describe("the push loop, per target")`:

1. Add a per-test probe scripter next to `failPostFor`:

```ts
// Per-test scripts for the existence probe, keyed by the target's resId.
// Absent = the record exists (the overwhelmingly common case); `[]` = a dead
// or invisible record; an Error = the probe call itself faults.
const probeScripts = new WeakMap<OdooClient, Map<number, XmlRpcValue | Error>>();

function scriptProbe(target: OdooClient, resId: number, answer: XmlRpcValue | Error) {
  let m = probeScripts.get(target);
  if (!m) {
    m = new Map();
    probeScripts.set(target, m);
  }
  m.set(resId, answer);
}
```

2. Replace the `execute` stub inside `makeClient()` so it is MODEL-AWARE. Today it answers every `search` with `[]`; with the probe that default terminally fails every healthy target and no probe test is writable on top of it:

```ts
execute: vi.fn(
  async (
    model: string,
    method: string,
    args: XmlRpcValue[],
    _kwargs?: Record<string, XmlRpcValue>
  ): Promise<XmlRpcValue> => {
    if (method === "search") {
      // Adopt searches (ir.attachment, mail.message) never match, as before.
      if (model === "ir.attachment" || model === "mail.message") return [];
      // The existence probe on the target's model: the record EXISTS unless
      // this test scripts otherwise. Extract resId from the probe's domain
      // [[["id", "=", resId]]].
      const resId = (args as unknown as number[][][][])[0]?.[0]?.[0]?.[2];
      const scripted = probeScripts.get(fake)?.get(typeof resId === "number" ? resId : -1);
      if (scripted instanceof Error) throw scripted;
      if (scripted !== undefined) return scripted;
      return [typeof resId === "number" ? resId : 1];
    }
    if (method === "message_post") {
      postCount += 1;
      const failure = postFailures.get(fake);
      if (failure && postCount === failure.n) throw failure.error;
    }
    return nextId++;
  }
),
```

3. Add the four named probe cases (after the "never re-attempts a failed target either" test):

```ts
it("probes the record before creating an attachment and terminally fails a dead target with the composed text", async () => {
  seedRow({ id: "r1", status: "pending" });
  seedTargets("r1", [{ resId: 42, status: "pending" }]);
  scriptProbe(client, 42, []); // record gone
  await pushQueuedRow(await readRow("r1"), deps);

  const made = (client.execute as ReturnType<typeof vi.fn>).mock.calls;
  expect(made.map(([m, meth]) => `${m}.${meth}`)).toEqual(["res.partner.search"]);
  // Kwargs are asserted, not just the method: omitting
  // `context: { active_test: false }` would terminally fail ARCHIVED (still
  // valid) partners, and an order-of-calls assertion alone cannot see it.
  expect(client.execute).toHaveBeenCalledWith(
    "res.partner", "search", [[["id", "=", 42]]],
    { limit: 1, context: { active_test: false } }
  );
  const t = (await listTargets("r1"))[0];
  expect(t.status).toBe("failed");
  expect(t.lastErrorCode).toBe("ODOO_FAULT");
  expect(t.lastError).toBe(
    "ODOO_FAULT: target record 42 missing or inaccessible (search returned 0 rows)"
  );
});

it("probes before create on a healthy target: search, then create, then post", async () => {
  seedRow({ id: "r1", status: "pending" });
  seedTargets("r1", [{ resId: 42, status: "pending" }]);
  await pushQueuedRow(await readRow("r1"), deps); // default probe: record exists
  const made = (client.execute as ReturnType<typeof vi.fn>).mock.calls;
  expect(made.map(([m, meth]) => `${m}.${meth}`)).toEqual([
    "res.partner.search",
    "ir.attachment.create",
    "res.partner.message_post",
  ]);
  expect(client.execute).toHaveBeenCalledWith(
    "res.partner", "search", [[["id", "=", 42]]],
    { limit: 1, context: { active_test: false } }
  );
});

it("treats a faulting probe as deterministic: no create, no post, target failed", async () => {
  seedRow({ id: "r1", status: "pending" });
  seedTargets("r1", [{ resId: 42, status: "pending" }]);
  scriptProbe(client, 42, odooFault());
  await pushQueuedRow(await readRow("r1"), deps);
  const made = (client.execute as ReturnType<typeof vi.fn>).mock.calls;
  expect(made.map(([m, meth]) => `${m}.${meth}`)).toEqual(["res.partner.search"]);
  const t = (await listTargets("r1"))[0];
  expect(t.status).toBe("failed");
  expect(t.lastErrorCode).toBe("ODOO_FAULT");
  // Task 1's fix is visible on the push path: the real fault's faultString is
  // rendered into the stored text.
  expect(t.lastError).toBe("ODOO_FAULT: Odoo fault 2 - AccessError");
});

it("returns a probe-blip target to pending, retryable, with no create and no synthesized fault", async () => {
  // This is the defect a catch-all around the probe produces: synthesizing the
  // fault on ANY rejection turns an ODOO_UNREACHABLE blip into a terminal row.
  seedRow({ id: "r1", status: "pending" });
  seedTargets("r1", [{ resId: 42, status: "pending" }]);
  scriptProbe(client, 42, unreachable());
  await pushQueuedRow(await readRow("r1"), deps);
  const made = (client.execute as ReturnType<typeof vi.fn>).mock.calls;
  expect(made.map(([m, meth]) => `${m}.${meth}`)).toEqual(["res.partner.search"]);
  const t = (await listTargets("r1"))[0];
  expect(t.status).toBe("pending");
  expect(t.lastErrorCode).toBe("ODOO_UNREACHABLE");
  expect(t.lastError ?? "").not.toContain("missing or inaccessible");
});
```

- [ ] **Step 2: Run the push suite, verify the new tests fail and the old fixtures break in the predicted way**

Run: `npx vitest run src/tests/odoo-meeting-log-push.test.ts`
Expected: the four new fake-client tests FAIL (today no probe is issued: a "search" never happens for a fresh target, so `res.partner.search` never appears). Additionally, several wire-chain fixtures break with ODOO_UNEXPECTED_ROW (a search eats an `<int>` response) — that is the mechanical re-point Step 4 fixes.

- [ ] **Step 3: Implement the probe in `createOrAdoptAttachment`**

In `src/lib/odoo/meeting-log-push.ts`, replace `createOrAdoptAttachment` (lines 245-263). The adopt-search block and the create call keep their exact shapes; only the probe between them is new:

```ts
async function createOrAdoptAttachment(
  target: MeetingLogTarget, attemptsBefore: number, deps: PushDeps
): Promise<number> {
  if (attemptsBefore > 0) {
    // Prove absence before writing. The commit-then-timeout window means a
    // NULL id does not prove the attachment is absent.
    const found = await deps.client.execute("ir.attachment", "search", [
      [["res_model", "=", target.model], ["res_id", "=", target.resId], ["name", "=", name]],
    ], { limit: 1 });
    const adopted = firstId(found);
    if (adopted !== null) return adopted;
  }
  // THE PROBE. No ir.attachment is created on a record the API user cannot
  // see: a deleted record AND a record-rule-invisible record both return zero
  // rows here, and both are exactly the cases where message_post would fault
  // with MissingError/AccessError AFTER ir.attachment.create has already
  // stranded an unreclaimable orphan (livecheck finding 2). `active_test:
  // false` is load-bearing: without it the probe classifies an ARCHIVED
  // (still valid) partner as missing and reintroduces a false terminal state.
  // The window between probe and create is a race in theory; the post-fault
  // target carries its persisted attachment id for the retry to reuse.
  //
  // NO catch wraps this: only a zero-row probe RESULT synthesizes the fault.
  // A probe REJECTION propagates untouched to the per-target catch, whose
  // isRetryable discipline keeps an ODOO_UNREACHABLE blip retryable and lets
  // a genuine ODOO_FAULT stay deterministic with its faultString rendered.
  const proven = firstId(
    await deps.client.execute(target.model, "search", [
      [["id", "=", target.resId]],
    ], { limit: 1, context: { active_test: false } })
  );
  if (proven === null) {
    // No server fault exists here, so none is fabricated: the code is
    // ODOO_FAULT (deterministic, exactly like a message_post MissingError)
    // but the message segment "Odoo fault N" is reserved for a real
    // faultCode and is not reused. The cause rides in err.message, which
    // queueErrorText already renders.
    throw odooError(
      "ODOO_FAULT",
      `target record ${target.resId} missing or inaccessible (search returned 0 rows)`,
      { resId: target.resId, model: target.model }
    );
  }
  return expectInt(
    await deps.client.execute("ir.attachment", "create", [
      { name, res_model: target.model, res_id: target.resId, datas: getDatas() },
    ]),
    "attachment id"
  );
}
```

`postOrAdoptMessage` is untouched: if the attachment already exists, a re-faulting `message_post` strands nothing new.

- [ ] **Step 4: Re-point the wire-chain fixtures (mechanical, same file)**

Every wire test below a fresh target (no stored ids, `attempts` 0) now sees a probe `search` before `ir.attachment.create`. Insert `arrayResponse([42])` (probe hit) after `AUTH()` wherever a create follows, and shift every `tauriFetch.mock.calls[N]` index that pointed at the create/post by +1. Exact per-test changes (test name → new chain, with index fixes):

| Test | New tauriFetch chain | Index fixes |
|---|---|---|
| `creates one attachment, posts one note carrying it, and marks the row sent` | `AUTH, arrayResponse([42]), intResponse(555), intResponse(999)` | `calls()` → `["authenticate", "res.partner.search", "ir.attachment.create", "res.partner.message_post"]`; message_post body at `mock.calls[3]` (was 2) |
| `pins the note subtype to an internal log note` | same as above | body index `2` → `3`; comment "Index 2 is the message_post POST; index 0 is authenticate" → "Index 3 …" |
| `issues NO search on the first attempt` | same as happy path | RENAME to `issues no ADOPT search on the first attempt`; the probe `res.partner.search` is DELIBERATE on every attachment creation — assert `calls()` equals the 4-element list above AND `expect(calls()).not.toContain("ir.attachment.search")`; rewrite the comment: the `attemptsBefore` gate is about the adopt search; the probe is the invariant's cost, one `search` per creation on a fresh target |
| `names the attachment from transcript_start_at and the row id` | `AUTH, arrayResponse([42]), intResponse(555), intResponse(999)` | create body at `mock.calls[2]` (was 1) |
| `puts the AI summary in the note body instead of the fallback` | `AUTH, arrayResponse([42]), intResponse(555), intResponse(999)` | body index `2` → `3` |
| `posts to crm.lead when lead_id is set` | `AUTH, arrayResponse([88]), intResponse(555), intResponse(999)` | `calls()` contains `"crm.lead.search"` and `"crm.lead.message_post"`; the res_model assertion moves to the CREATE body at `mock.calls[2]` (was 1) so it stays load-bearing (the probe body contains "crm.lead" too, but as the search's model, not the attachment's `res_model`) |
| `posts to res.partner with contact_id when lead_id is null` | `AUTH, arrayResponse([42]), intResponse(555), intResponse(999)` | none beyond the chain |
| `creates when the retry search finds nothing` | `AUTH, arrayResponse([]) /* adopt */, arrayResponse([42]) /* probe */, intResponse(555), arrayResponse([]) /* mail.message */, intResponse(999)` | none (no index asserts) |
| `keeps the row pending on a 5xx` | `AUTH, arrayResponse([42]), xml("", 503)` | none — the 503 now lands on the probe; ODOO_UNREACHABLE/503 stays retryable → pending (same assertion) |
| `FAILS the row on a 4xx that is not 408 or 429` | `AUTH, arrayResponse([42]), xml("", 413)` | same shape; 413 on the probe is deterministic → failed (same assertion) |
| `keeps the row pending on a 429` | `AUTH, arrayResponse([42]), xml("", 429)` | same shape |
| `FAILS the row on ODOO_FAULT` | `AUTH, arrayResponse([42]), faultResponse(2, "no such partner")` | the fault now lands on the create, preserving the test's create-path meaning (the probe-fault leg is covered by the fake-client case) |
| `FAILS the row on an unexpected Odoo return value` | `AUTH, arrayResponse([42]), xml("<boolean>0</boolean>…")` | the boolean now lands on the create (`expectInt` throws) |
| `does NOT fail a row whose Odoo write already landed but whose DB write did not` | `AUTH, arrayResponse([42]), intResponse(555)` | probe precedes the create; `calls()` contains `ir.attachment.create` ✓ unchanged assertion |
| the five `summarization is walled off` fixtures | `AUTH, arrayResponse([42]), intResponse(555), intResponse(999)` | message_post body index `2` → `3` in all five |
| `strips the api key from a PLAIN Error…` | `AUTH, arrayResponse([42]), mockRejectedValueOnce(new Error("socket hang up…"))` | the rejection stays on the create path, preserving the test's intent |
| `registers the row while pushing and removes it afterwards…` | `AUTH, arrayResponse([42]), mockImplementationOnce(… throw "boom")` | the throwing call moves to the create, keeping the observed-inside-a-write assertion's meaning |

Unchanged fixtures (no probe reaches them — verify, do not edit): `reuses a stored attachment_id…` and `searches before creating on a retry…` (adopt hit pays nothing), `searches mail.message before re-posting…`, `short-circuits entirely…`, both `a search that fails never falls through to a write` fixtures (adopt search is attempted first, so the rejection hits it), `the instance re-check`, `the claim CAS`, `a local write failing after the Odoo write already landed` (both), `leaves the row alone when the claim itself cannot be written`, `does not post a row belonging to another database`, and every fake-client fixture (the model-aware default keeps them green).

- [ ] **Step 5: Run the push suite, verify green**

Run: `npx vitest run src/tests/odoo-meeting-log-push.test.ts`
Expected: PASS — old fixtures green on the new order (adopt-miss → probe → create), the four probe legs green.

- [ ] **Step 6: Point the sweep suite's wire stubs at the probe, and add the sweep-driven dead-target case**

In `src/tests/odoo-meeting-log-sweep.test.ts`, add a shared body parser next to `calls()` and re-write each `mockImplementation` that answers wire calls. The probe is `execute_kw` with model `res.partner`/`crm.lead` and method `search`; today's `body.includes("ir.attachment") ? int : int` fallback would hand the probe a bare `<int>` (the probe reads an array, throws ODOO_UNEXPECTED_ROW, and fails every fixture).

```ts
/** The execute_kw body's (model, method) pair - same parse calls() uses. */
function modelMethod(body: string): { model: string; method: string } {
  const strings = [...body.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1]);
  return { model: strings[2], method: strings[3] };
}
```

1. `pushes pending rows oldest-first and sequentially` — replace the implementation:

```ts
tauriFetch.mockImplementation(async (_url, init) => {
  const body = String((init as { body: string }).body);
  if (body.includes("authenticate")) return AUTH();
  const { model, method } = modelMethod(body);
  if (model === "res.partner" && method === "search") {
    order.push("probe"); // existence probe before each create
    return arrayResponse([42]);
  }
  if (body.includes("ir.attachment")) {
    order.push("create");
    await new Promise((r) => setTimeout(r, 0));
    return intResponse(555);
  }
  order.push("post");
  return intResponse(999);
});
```

and the assertion becomes `expect(order).toEqual(["probe", "create", "post", "probe", "create", "post"]);` (the sequential no-interleave property is unchanged: probe/create/post per row, never create/create/post/post).

2. `performs exactly one authenticate across a two-row run` — insert before the final return:

```ts
const { model, method } = modelMethod(body);
if (model === "res.partner" && method === "search") return arrayResponse([42]);
```

3. `passes each row's own conversation_id to summarize…` — same insertion.

4. `continues to the next row when one row throws` — the fault stays on the first `ir.attachment` call (which is now the CREATE, after the probe); add the same probe branch returning `arrayResponse([42])` before the `ir.attachment` check.

5. `reclaims a stale sending row first, then pushes it` — same insertion.

6. `joins an in-flight run instead of starting a second one` — same insertion (its `ir.attachment.create` count assertion still reads 1).

7. Add the new dead-target sweep case at the end of the describe (also add `listTargets` to the existing `@/lib/database/meeting-log.action` import):

```ts
it("sweeps a dead target through the probe: no orphan, failed with the composed text", async () => {
  // The sweep drives the REAL pushQueuedRow, so a swept target with a null
  // attachment id hits the probe on the production path. The dead-target leg
  // must produce zero wire writes and the persisted composed text - the
  // sweep-visible half of the invariant.
  seedRow();
  seedTargets("row-1", 999);
  let probeBody = "";
  tauriFetch.mockImplementation(async (_url, init) => {
    const body = String((init as { body: string }).body);
    if (body.includes("authenticate")) return AUTH();
    const { model, method } = modelMethod(body);
    if (model === "res.partner" && method === "search") {
      probeBody = body;
      return arrayResponse([]); // record gone
    }
    return body.includes("ir.attachment") ? intResponse(555) : intResponse(999);
  });
  await runMeetingLogSweep(async () => null);

  expect(calls()).toEqual(["authenticate", "res.partner.search"]);
  expect(calls()).not.toContain("ir.attachment.create");
  const stored = await getQueueRow("row-1");
  expect(stored).toMatchObject({ status: "failed", last_error_code: "ODOO_FAULT" });
  expect(stored?.last_error).toBe(
    "ODOO_FAULT: target record 999 missing or inaccessible (search returned 0 rows)"
  );
  // The probe's kwargs, on the WIRE: limit 1, active_test false, no fields key.
  expect(probeBody).toContain("<int>999</int>"); // the target's resId in the domain
  expect(probeBody).toContain("<name>limit</name>");
  expect(probeBody).toContain("<int>1</int>");
  expect(probeBody).toContain("<name>active_test</name>");
  expect(probeBody).toContain("<boolean>0</boolean>");
  expect(probeBody).not.toContain("<name>fields</name>");
});
```

- [ ] **Step 7: Run both suites, verify green**

Run: `npx vitest run src/tests/odoo-meeting-log-push.test.ts src/tests/odoo-meeting-log-sweep.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/lib/odoo/meeting-log-push.ts src/tests/odoo-meeting-log-push.test.ts src/tests/odoo-meeting-log-sweep.test.ts
git commit -m "feat: probe the target record before creating an attachment

No ir.attachment is created on a record the API user cannot see; a zero-row
probe synthesizes a deterministic ODOO_FAULT whose text names the cause.

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 3: Contacts-sync page-fault isolation (+ the `opportunities.ts` comment rewrite)

**Files:**
- Modify: `src/lib/odoo/contacts-sync.ts` (page fetch at :126-131 gains the machinery; helpers at module scope)
- Modify: `src/lib/odoo/opportunities.ts:131-139` (comment text only — the fail-loud contract stands)
- Test: `src/tests/odoo-contacts-sync.test.ts` (new cases)

**Interfaces:**
- Consumes: `client.execute`, `OdooError`/`odooError`/`toOdooError` (already imported), `PAGE_LIMIT`, `PARTNER_FIELDS`.
- Produces: no exported-signature change. `syncContacts(deps)` keeps its shape; `SyncResult.skipped` now also counts machinery singleton skips. The watermark (`maxWriteDate`) still advances only from successfully parsed rows — unchanged. A run that trips the zero-upsert breaker throws `ODOO_UNEXPECTED_ROW` through the existing run-level catch, so `failSync(instance, code, now)` fires exactly as today.

**Design notes the implementer must not skip:**

1. **Only `ODOO_FAULT` enters the machinery, at every level.** A page fetch rejecting anything else re-throws untouched. Inside the machinery, an id-only `search` rejection re-throws (a fault there is not record-shaped). A sub-batch or singleton fetch rejecting non-`ODOO_FAULT` re-throws. The machinery narrows record faults; it never launders other failure shapes into skips.
2. **The plain `search` takes NO `fields` kwarg** — domain/offset/limit/order only. A `fields: ["id"]` kwarg on `search` is a server-side fault that would make the entire machinery a no-op no mocked test could catch. The wire-shape test asserts its absence explicitly.
3. **The zero-upsert breaker keys on the count of rows HANDED to the upsert (`contacts.length === 0`), not on `upsertContacts`' return.** The spec says "keys on the per-page upsert count"; the only reading that is implementable without a false positive is the handed-row count: `upsertContacts` returns the count of rows that genuinely CHANGED (guarded upsert's per-row `rowsAffected`, `odoo-contacts.action.ts:97-102`), and a healthy re-sync of unchanged data legitimately changes zero rows — keying on the return would fail every healthy no-op run and break the existing mocked fixtures that leave it at 0. The load-bearing half of the spec's rule survives intact: the breaker does NOT care which skip path produced the zero — every singleton faulted inside the machinery, or every row failed `parsePartnerRow`, both reach the same loud failure.
4. **The break condition moves from `page.length` to the page's id count** (`rows + singleton-skipped ids`). A fault-isolated page can be short because of skips, not because the table ended — breaking on row count alone would strand every later page behind the fault. On a non-faulting page the id count equals the row count, so the existing short-page semantics are preserved.
5. **Skipped singletons advance the cursor past their id** (folded into `pageMaxId`), or the loop re-fetches the identical domain forever. The existing raw-id rule (cursor advances from the RAW id before parsing) survives unchanged for rows the machinery returns.

- [ ] **Step 1: Write the failing tests**

Append a new `describe("the page-fault machinery")` block inside `describe("syncContacts")` in `src/tests/odoo-contacts-sync.test.ts`:

```ts
import { PAGE_LIMIT, PARTNER_FIELDS } from "@/lib/odoo/contacts-sync"; // extend the existing import line

/** The "id in [batch]" leaf of a machinery call's domain, or null for a plain page fetch. */
function idsIn(args: unknown[]): number[] | null {
  const domain = (args[0] as unknown[][] | undefined) ?? [];
  const leaf = domain.find((l) => Array.isArray(l) && l[0] === "id" && l[1] === "in");
  return leaf ? (leaf[2] as number[]) : null;
}

function fault() {
  return new OdooError("ODOO_FAULT", "Odoo fault 2", { faultCode: 2, faultString: "read blew up" });
}
```

```ts
describe("the page-fault machinery", () => {
  it("isolates a faulting page: id-only search, halved sub-batches, one counted singleton skip", async () => {
    // Page fetch faults -> plain search names [1,2,3] -> the batch read
    // faults (id 3 is the bad record) -> bisect [1] ok, [2,3] faults ->
    // [2] ok, [3] singleton faults -> skipped. Two rows upserted; the
    // watermark advances from the UPSERTED rows' write_date only.
    const execute = vi.fn(async (_m: string, method: string, args: unknown[], kwargs: unknown) => {
      const batch = idsIn(args);
      if (method === "search") {
        // The machinery's own `fields`-kwarg trap, made mock-visible.
        expect(kwargs).toEqual({
          order: "id asc",
          limit: PAGE_LIMIT,
          context: { active_test: false },
        });
        return [1, 2, 3];
      }
      if (batch) {
        if (batch.includes(3)) throw fault();
        return batch.map((id) => partner({ id }));
      }
      throw fault(); // the page fetch
    });
    const client = { authenticate: vi.fn(), execute, serverDate: "Tue, 04 Aug 2026 12:00:00 GMT" };

    const result = await syncContacts({ client, instance: INSTANCE, now: NOW });

    expect(result.skipped).toBe(1);
    expect(result.fetched).toBe(2);
    expect(action.upsertContacts).toHaveBeenCalledTimes(1);
    expect(action.upsertContacts.mock.calls[0][1]).toMatchObject([{ id: 1 }, { id: 2 }]);
    expect(action.finishSync).toHaveBeenCalledWith(INSTANCE, "2026-08-01 09:59:59", NOW, 1);

    // Deterministic bisection: the whole batch first, then the halves.
    const batches = execute.mock.calls
      .filter(([, m, a]) => m === "search_read" && idsIn(a))
      .map(([, , a]) => idsIn(a));
    expect(batches).toEqual([[1, 2, 3], [1], [2, 3], [2], [3]]);

    // Wire shapes: the id-only search carries NO fields key; every sub-batch
    // read keeps fields, the type filters and the context flag.
    const searchCall = execute.mock.calls.find(([, m]) => m === "search")!;
    expect(searchCall[3]).not.toHaveProperty("fields");
    const subBatchCalls = execute.mock.calls.filter(
      ([, m, a]) => m === "search_read" && idsIn(a)
    );
    for (const [, , a, kw] of subBatchCalls) {
      expect((kw as { fields: string[] }).fields).toEqual(PARTNER_FIELDS);
      expect((kw as { context: unknown }).context).toEqual({ active_test: false });
      const domain = (a as unknown[][][])[0];
      for (const t of ["delivery", "invoice", "other"]) {
        expect(domain).toContainEqual(["type", "!=", t]);
      }
    }
  });

  it("advances the cursor past a skipped singleton", async () => {
    // 200 ids, the id-200 singleton keeps faulting. The cursor must move past
    // it, or the next page's domain re-fetches the identical window forever.
    const execute = vi.fn(async (_m: string, method: string, args: unknown[]) => {
      const batch = idsIn(args);
      if (method === "search") {
        return Array.from({ length: PAGE_LIMIT }, (_v, i) => i + 1);
      }
      if (batch) {
        if (batch.length === 1 && batch[0] === 200) throw fault();
        return batch.map((id) => partner({ id }));
      }
      throw fault(); // page fetch faults every time in this run
    });
    const client = { authenticate: vi.fn(), execute, serverDate: null };

    await syncContacts({ client, instance: INSTANCE, now: NOW });

    // The next page fetch's domain moved past the skipped id (raw id 200).
    const pageFetches = execute.mock.calls.filter(
      ([, m, a]) => m === "search_read" && !idsIn(a)
    );
    const lastDomain = (pageFetches[pageFetches.length - 1][2] as unknown[][][])[0];
    expect(lastDomain).toContainEqual(["id", ">", 200]);
  });

  it("keeps the raw-id cursor rule inside the machinery: a parse-malformed row in a successful sub-batch advances the cursor from its raw id", async () => {
    const execute = vi.fn(async (_m: string, method: string, args: unknown[]) => {
      const batch = idsIn(args);
      if (method === "search") return Array.from({ length: PAGE_LIMIT }, (_v, i) => i + 1);
      if (batch) {
        const rows = batch.map((id) => partner({ id }));
        if (batch.includes(200)) {
          // Row 200 parse-fails (no write_date) but still carries a raw id.
          rows[rows.length - 1] = { id: 200, name: "x" };
        }
        return rows;
      }
      throw fault();
    });
    const client = { authenticate: vi.fn(), execute, serverDate: null };

    const result = await syncContacts({ client, instance: INSTANCE, now: NOW });

    expect(result.skipped).toBe(1);
    const pageFetches = execute.mock.calls.filter(
      ([, m, a]) => m === "search_read" && !idsIn(a)
    );
    const lastDomain = (pageFetches[pageFetches.length - 1][2] as unknown[][][])[0];
    // The cursor advanced from the RAW id 200, not from the parsed max (199) -
    // a parsed-only cursor would re-fetch row 200 every run and spin.
    expect(lastDomain).toContainEqual(["id", ">", 200]);
  });

  it("fails the run loudly when a page yields zero upserted rows from the machinery (every singleton faults)", async () => {
    // A PARTNER_FIELDS drift faults with code 2 on every read yet spares the
    // id-only search. Without the breaker the cursor walks past the whole
    // table, the run "succeeds", nothing is ingested and the watermark is
    // unadvanced - a silent total failure where today's code fails loudly.
    const execute = vi.fn(async (_m: string, method: string, args: unknown[]) => {
      const batch = idsIn(args);
      if (method === "search") return [1, 2];
      if (batch) throw fault(); // every read faults, down to the singletons
      throw fault(); // page fetch
    });
    const client = { authenticate: vi.fn(), execute, serverDate: null };

    await expect(
      syncContacts({ client, instance: INSTANCE, now: NOW })
    ).rejects.toMatchObject({ code: "ODOO_UNEXPECTED_ROW" });
    expect(action.failSync).toHaveBeenCalledWith(INSTANCE, "ODOO_UNEXPECTED_ROW", NOW);
    expect(action.finishSync).not.toHaveBeenCalled();
  });

  it("fails the run loudly when every row of a non-empty page fails parse (the breaker does not care which route the zero came by)", async () => {
    const broken = Array.from({ length: PAGE_LIMIT }, (_v, i) => partner({ id: i + 1, write_date: 123 }));
    const { client, execute } = clientReturning([broken, broken]);
    await expect(
      syncContacts({ client, instance: INSTANCE, now: NOW })
    ).rejects.toMatchObject({ code: "ODOO_UNEXPECTED_ROW" });
    expect(action.failSync).toHaveBeenCalledWith(INSTANCE, "ODOO_UNEXPECTED_ROW", NOW);
    expect(action.finishSync).not.toHaveBeenCalled();
  });

  it("re-throws when the id-only search itself faults: the fault is not record-shaped", async () => {
    const execute = vi.fn(async () => {
      throw fault(); // page fetch AND the id-only search both fault
    });
    const client = { authenticate: vi.fn(), execute, serverDate: null };
    await expect(
      syncContacts({ client, instance: INSTANCE, now: NOW })
    ).rejects.toMatchObject({ code: "ODOO_FAULT" });
    expect(execute).toHaveBeenCalledTimes(2); // page fetch + id-only search, no bisection
    expect(action.failSync).toHaveBeenCalledWith(INSTANCE, "ODOO_FAULT", NOW);
  });

  it("never enters the machinery for ODOO_UNREACHABLE or ODOO_UNEXPECTED_ROW - zero bisection calls", async () => {
    for (const code of ["ODOO_UNREACHABLE", "ODOO_UNEXPECTED_ROW"] as const) {
      const execute = vi.fn(async () => {
        throw new OdooError(code, "down", {});
      });
      const client = { authenticate: vi.fn(), execute, serverDate: null };
      await expect(
        syncContacts({ client, instance: INSTANCE, now: NOW })
      ).rejects.toMatchObject({ code });
      expect(execute).toHaveBeenCalledTimes(1); // the page fetch, nothing else
      expect(action.failSync).toHaveBeenCalledWith(INSTANCE, code, NOW);
    }
  });
});
```

- [ ] **Step 2: Run the sync suite, verify the new tests fail**

Run: `npx vitest run src/tests/odoo-contacts-sync.test.ts`
Expected: FAIL — today a faulting page fetch escapes to the run-level catch (no id-only search, no bisection, no breaker).

- [ ] **Step 3: Implement the machinery in `src/lib/odoo/contacts-sync.ts`**

Add at module scope (after `PARTNER_FIELDS`):

```ts
/** The sync domain's type leaves, shared by the page fetch and its fault-isolated re-fetches. */
const TYPE_FILTERS: XmlRpcValue[] = [
  ["type", "!=", "delivery"],
  ["type", "!=", "invoice"],
  ["type", "!=", "other"],
];

function expectRows(value: XmlRpcValue, what: string): unknown[] {
  if (!Array.isArray(value)) {
    throw odooError("ODOO_UNEXPECTED_ROW", `Odoo returned a non-list from ${what}`);
  }
  return value;
}

function expectIds(value: XmlRpcValue, what: string): number[] {
  const rows = expectRows(value, what);
  return rows.map((v, i) => {
    if (typeof v !== "number" || !Number.isInteger(v)) {
      throw odooError("ODOO_UNEXPECTED_ROW", `Odoo returned a non-integer id at index ${i} from ${what}`);
    }
    return v;
  });
}

const asFault = (err: unknown): OdooError | null =>
  err instanceof OdooError && err.code === "ODOO_FAULT" ? err : null;

/**
 * The fault-isolated row fetch. ONLY an ODOO_FAULT enters: any other
 * rejection re-throws and fails the run exactly as today. A batch that
 * faults is halved and both halves retried; a singleton that still faults
 * is recorded as skipped and the cursor moves past it. Successful rows
 * accumulate in `out.rows`.
 */
async function fetchRowsBisectingFaults(
  client: OdooClient,
  ids: number[],
  out: { rows: unknown[]; skippedIds: number[] }
): Promise<void> {
  if (ids.length === 0) return;
  const domain: XmlRpcValue[] = [["id", "in", ids], ...TYPE_FILTERS];
  let rows: XmlRpcValue;
  try {
    rows = await client.execute("res.partner", "search_read", [domain], {
      fields: PARTNER_FIELDS,
      context: { active_test: false },
    });
  } catch (err) {
    if (asFault(err) === null) throw err;
    const mid = Math.floor(ids.length / 2);
    if (mid === 0) {
      // Singleton: this record's read is what faults. Skip it, count it,
      // move the cursor past it - the run continues.
      out.skippedIds.push(ids[0]);
      return;
    }
    await fetchRowsBisectingFaults(client, ids.slice(0, mid), out);
    await fetchRowsBisectingFaults(client, ids.slice(mid), out);
    return;
  }
  out.rows.push(...expectRows(rows, "search_read"));
  if (ids.length > 1) {
    await fetchRowsBisectingFaults(client, ids.slice(Math.floor(ids.length / 2)), out);
  }
}
```

Rewrite the page-fetch portion of the `for (;;)` loop in `syncContacts` (lines 117-138 today; the domain construction spreads `TYPE_FILTERS` instead of pushing the three leaves inline):

```ts
for (;;) {
  const domain: XmlRpcValue[] = [];
  if (watermark !== null) domain.push(["write_date", ">", watermark]);
  domain.push(["id", ">", cursor]);
  domain.push(...TYPE_FILTERS);

  let page: XmlRpcValue;
  const isolatedSkips: number[] = [];
  try {
    page = await client.execute("res.partner", "search_read", [domain], {
      fields: PARTNER_FIELDS,
      order: "id asc",
      limit: PAGE_LIMIT,
      context: { active_test: false },
    });
  } catch (err) {
    // ONLY ODOO_FAULT enters the machinery. A transport failure (UNREACHABLE)
    // or a shape failure (UNEXPECTED_ROW) re-throws to the run-level catch:
    // bisection against a dead server burns calls to learn nothing, and a
    // shape drift is systemic, not per-record.
    if (asFault(err) === null) throw err;
    // 1. Re-fetch the same domain as an id-only PLAIN search. No `fields`
    // kwarg - plain search takes none, and a fields kwarg here is a
    // server-side fault that would make this whole machinery a no-op. A
    // read-side crash (a computed field raising for one record) happens on
    // READ, not on search, so this call names the page's ids without
    // tripping the fault.
    // 2. If THIS faults, the fault is domain/permission/server-shaped -
    // re-throw. The run fails honestly, as today.
    const ids = expectIds(
      await client.execute("res.partner", "search", [domain], {
        order: "id asc",
        limit: PAGE_LIMIT,
        context: { active_test: false },
      }),
      "search"
    );
    // 3-4. Bisect the reads; a singleton that still faults is skipped and
    // counted; the cursor moves past it.
    const isolated = { rows: [] as unknown[], skippedIds: [] as number[] };
    await fetchRowsBisectingFaults(client, ids, isolated);
    page = isolated.rows as XmlRpcValue;
    skipped += isolated.skippedIds.length;
    isolatedSkips.push(...isolated.skippedIds);
  }

  if (runStartedAt === null && client.serverDate) {
    const parsed = new Date(client.serverDate);
    if (!Number.isNaN(parsed.getTime())) {
      runStartedAt = parsed.toISOString().slice(0, 19).replace("T", " ");
    }
  }

  if (!Array.isArray(page)) {
    throw odooError("ODOO_UNEXPECTED_ROW", "Odoo returned a non-list from search_read");
  }

  const contacts: OdooContact[] = [];
  // `isolatedSkips` is a per-page `const number[]` declared beside `page`
  // above and RESET each iteration by re-declaration - its ids are folded
  // into pageMaxId below so the cursor moves past records the machinery
  // skipped (their write_date is unknown and stays above the watermark).
  let pageMaxId = cursor;
  for (const rawId of isolatedSkips) pageMaxId = Math.max(pageMaxId, rawId);
  for (const raw of page) {
    // ... the existing raw-id / parse / skip-count loop, byte for byte ...
  }

  if (page.length > 0 && pageMaxId === cursor) {
    throw odooError(
      "ODOO_UNEXPECTED_ROW",
      "Odoo returned a page of partners with no usable id - the sync cursor cannot advance",
      { cursor }
    );
  }
  cursor = pageMaxId;

  changed += await upsertContacts(instance, contacts, now);
  fetched += contacts.length;

  // THE ZERO-UPSERT BREAKER. A page that listed records and handed the
  // upsert ZERO rows is a systemic fault wearing a per-record fault's
  // clothes - the cursor would walk the whole table and the run would end
  // "successfully" with nothing ingested. Keyed on the rows HANDED to the
  // upsert, not on its return (that return counts genuinely-CHANGED rows and
  // is legitimately zero for unchanged data on a healthy re-sync). Whichever
  // route the zero came by - every singleton faulted, or every row failed
  // parse - the outcome is identical and loud, through the existing
  // failSync path.
  const pageIdCount = page.length + isolatedSkips.length;
  if (pageIdCount > 0 && contacts.length === 0) {
    throw odooError(
      "ODOO_UNEXPECTED_ROW",
      `a page listed ${pageIdCount} partner records and none could be ingested - the field list or domain no longer matches this server`,
      { cursor, pageIds: pageIdCount }
    );
  }

  // The break keys on the page's ID count, not its row count: a
  // fault-isolated page is short because records were skipped, not because
  // the table ended. On a non-faulting page the two are the same number.
  if (pageIdCount < PAGE_LIMIT) break;
}
```

(`isolatedSkips` is declared as `const isolatedSkips: number[] = [];` beside `let page` inside the loop body, per the snippet above.)

- [ ] **Step 4: Rewrite the disproven premise in `src/lib/odoo/opportunities.ts:131-139`**

The contract stands; only the comment's sync half is now false. Replace the sentence pair inside the `fetchOpportunities` doc comment:

OLD: `This THROWS on the first unreadable row, where syncContacts skips and counts. The asymmetry is deliberate, not an oversight. In the sync, failing the run leaves the watermark unadvanced, so one malformed partner among thousands wedges syncing permanently with no way past it. Here nothing is wedged: ...`

NEW: `This THROWS on the first unreadable row, where syncContacts isolates and skips. The asymmetry is deliberate, not an oversight. The sync walks past a faulting record (id-only search + bisection, with a zero-upsert breaker for systemic drifts) because a run that died on one bad partner would wedge syncing permanently with no way past it. Here nothing is wedged: the target is already committed to the contact BEFORE this call runs, the failure lands in \`opportunityError\` beside a Retry button, and the user keeps a working contact-only selection. Loud beats partial when a partial list means "no open deals" - which is the sentence that sends slice 2 to the wrong record.`

- [ ] **Step 5: Run the suite, verify green**

Run: `npx vitest run src/tests/odoo-contacts-sync.test.ts`
Expected: PASS — all new machinery cases green, every existing case unchanged (the `ODOO_UNREACHABLE` midway test, the ODOO_FAULT failSync tests, the empty-page NULL watermark test all still pass — the machinery does not fire for them).

- [ ] **Step 6: Commit**

```bash
git add src/lib/odoo/contacts-sync.ts src/lib/odoo/opportunities.ts src/tests/odoo-contacts-sync.test.ts
git commit -m "feat: walk contacts-sync past a faulting record instead of dying on it

ODOO_FAULT on a page fetch re-names the page's ids with a field-less plain
search, bisects the reads, skips a still-faulting singleton, and a page that
upserts zero rows fails the run loudly (the zero-upsert breaker).

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 4: Remove the disproven archived-target gates in AssignDialog

**Files:**
- Modify: `src/pages/meetings/components/AssignDialog.tsx` (:168-198 copy table + doc comment, :493-515 `submitCreate`, :691-724 row rendering)
- Test: `src/tests/meeting-log-page.test.tsx` (rewrite the two archived tests; add one)

**Interfaces:**
- Consumes: `createOrAdoptContact`'s `adopted-archived` outcome kind — UNCHANGED in `create-contact.ts` (the kind survives; only the dialog's copy and gating change).
- Produces: no testid change (`assign-contact` and the AddToggle button names are untouched), so every other page fixture selects rows the same way. The row button's accessible name still ends in "Archived" for an archived contact (the tag span stays inside the button).

- [ ] **Step 1: Rewrite the failing page tests first**

In `src/tests/meeting-log-page.test.tsx`:

1. Replace the test at :1589 (`does not preview an archived adoption - it cannot be selected at all`) with:

```ts
it("previews and auto-adds an archived adoption - the tag is the only trace", async () => {
  // Livecheck 2026-08-30: message_post on an ARCHIVED res.partner SUCCEEDS.
  // The old gates were built on the opposite belief and are gone; the tag is
  // the only surviving trace of the distinction.
  const archived = contact({ id: 42, name: "Priya Patel", active: false });
  createContact.createOrAdoptContact.mockResolvedValue({ kind: "adopted-archived", contact: archived });
  const props = assignDialogProps();
  render(<AssignDialog {...props} />);
  await screen.findByPlaceholderText("Search contacts");
  await userEvent.click(screen.getByRole("button", { name: "+ New contact" }));

  await userEvent.type(screen.getByLabelText("New contact name"), "Priya Patel");
  await userEvent.type(screen.getByLabelText("New contact email"), "priya@example.com");
  await userEvent.click(screen.getByRole("button", { name: "Create contact" }));

  expect(
    await screen.findByText("Already in Odoo — added to this meeting.")
  ).toBeInTheDocument();
  // Previewed: the archived contact is selected exactly as an active one.
  await waitFor(() => expect(opportunities.fetchOpportunities).toHaveBeenCalled());
  await userEvent.click(screen.getByRole("button", { name: "Log this meeting" }));
  expect(props.onConfirm).toHaveBeenCalledWith(
    expect.objectContaining({
      targets: [{ model: "res.partner", resId: 42, name: "Priya Patel" }],
    })
  );
});
```

2. Replace the test at :1843 (`refuses an archived contact, which is the target Reassign exists to escape`) with:

```ts
it("offers an archived contact as selectable and addable, with the tag as the only trace", async () => {
  contacts.listContacts.mockResolvedValue([
    contact({ id: 8, name: "Gone Partner", active: false }),
  ]);
  db.listActionableRows.mockResolvedValue([
    row({ id: "na", status: "failed", attempts: 3 }),
  ]);
  await renderPage();
  await openAssignReady("na", "Reassign");

  // Archived rows render as normal selectable rows carrying an Archived tag;
  // the livecheck disproved the "unrecoverable" premise the old gating cited.
  const rowButton = dialog().getByRole("button", { name: "Gone Partner Archived" });
  expect(rowButton).toBeEnabled();
  expect(dialog().getByRole("button", { name: /add Gone Partner/i })).toBeEnabled();

  // Previewing an archived contact works exactly as an active one.
  await userEvent.click(rowButton);
  await waitFor(() => expect(opportunities.fetchOpportunities).toHaveBeenCalled());
});
```

- [ ] **Step 2: Run the page suite, verify the two rewritten tests fail**

Run: `npx vitest run src/tests/meeting-log-page.test.tsx`
Expected: FAIL — the disabled gates and the old copy are still in place.

- [ ] **Step 3: Remove the gates and fix the copy in `AssignDialog.tsx`**

1. `createResultText` (:177-198): merge the archived case into the active one and update the doc comment above it (:168-176) — `autoAdded` is now `null` only for `created-invisible` (no selectable contact behind it) and `failed` (nothing was ever created):

```ts
case "adopted-active":
case "adopted-archived":
  return autoAdded
    ? "Already in Odoo — added to this meeting."
    : "Already in Odoo. The log is full, so tick them below once you free a slot.";
```

2. `submitCreate` (:493-515): delete the `if (outcome.contact.active)` conditional AND its comment (:497-499) — `selectContact` and the capped auto-add run for every non-`created-invisible` outcome:

```ts
setContacts((prev) => {
  const idx = prev.findIndex((c) => c.id === outcome.contact.id);
  return idx === -1 ? [...prev, outcome.contact] : prev.map((c, i) => (i === idx ? outcome.contact : c));
});
// `targetsRef.current`, not `addTarget`'s own resolved value - see that
// ref's own doc comment for why this call site cannot trust it.
selectContact(outcome.contact);
if (targetsRef.current.length < MAX_TARGETS) {
  await addTarget({
    model: "res.partner",
    resId: outcome.contact.id,
    name: outcome.contact.name,
  });
  autoAdded = true;
} else {
  autoAdded = false;
}
```

3. Row rendering (:691-724): on the `assign-contact` button delete `disabled={!c.active}`, the disproven comment (:696-698), and the `opacity-50` clause; keep the `Archived` tag span. On the `AddToggle` delete `disabled={!c.active}`:

```tsx
<button
  type="button"
  data-testid="assign-contact"
  aria-pressed={selected?.id === c.id}
  onClick={() => selectContact(c)}
  className={`flex-1 rounded-lg px-2 py-1 text-left text-sm hover:bg-muted/50 ${
    selected?.id === c.id ? "bg-muted" : ""
  }`}
>
  {c.name}
  {c.companyName && (
    <span className="text-muted-foreground">{` (${c.companyName})`}</span>
  )}
  {!c.active && (
    <span className="ml-1 text-xs text-muted-foreground">Archived</span>
  )}
</button>
<AddToggle
  model="res.partner"
  resId={c.id}
  name={c.name}
  targets={targets}
  atCap={atCap}
  onAdd={addTarget}
  onRemove={removeTarget}
/>
```

- [ ] **Step 4: Run the page suite, verify green**

Run: `npx vitest run src/tests/meeting-log-page.test.tsx`
Expected: PASS — the two rewritten tests green, every other fixture unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/pages/meetings/components/AssignDialog.tsx src/tests/meeting-log-page.test.tsx
git commit -m "fix: drop the disproven archived-target gates in AssignDialog

message_post on an archived res.partner succeeds (livecheck 2026-08-30);
archived contacts preview and add exactly as active ones do, and the
Archived tag is the only surviving trace of the distinction.

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Self-review

**Spec coverage:**
- `queueErrorText` faultString rendering (redacted, capped, appended; fallback byte-identical; message segment stays) → Task 1.
- Existence probe + synthesized ODOO_FAULT + retryable-vs-deterministic probe discipline → Task 2 (no catch wraps the probe — Step 3's comment is normative).
- Retry path: `retryTarget` untouched, no attempt cap → Global Constraints; nothing in any task touches `meeting-log-actions.ts`.
- Contacts-sync page-fault machinery (id-only search, bisection, singleton skip, watermark-from-upserted, zero-upsert breaker, non-fault re-throws, cursor rules) → Task 3, including both named cursor cases as tests.
- `opportunities.ts` comment rewrite (same plan as the sync change) → Task 3 Step 4.
- Archived-gate removal + copy merge + informational tag → Task 4.
- `.livecheck/` — conditional future work, not a code task (spec: "if a livecheck run happens").
- Out-of-scope items (no cap, no backfill, no stranded-attachment cleanup, proposal region untouched) → honoured; no task touches them.

**Placeholder scan:** none — every code step carries its exact code; every chain edit is listed per test; the two prose-heavy steps (comment rewrites) quote the exact old and new text.

**Type consistency:** `queueErrorText` signature unchanged (Task 1 consumers: push catch :356, sweep not-configured path :474). Probe throws `OdooError` with `OdooErrorDetails`-compatible details (`resId: number, model: string`). Machinery helpers are module-private; `syncContacts`'s exported signature and `SyncResult` unchanged. Test-side names match: `scriptProbe`, `probeScripts`, `modelMethod`, `idsIn`, `fault`, `expectIds`/`expectRows`/`asFault`/`TYPE_FILTERS`/`fetchRowsBisectingFaults` — each defined exactly once, in the task that introduces it.