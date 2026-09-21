# Odoo sync wedges on ODOO_FAULT 2; faultString never rendered

Issue: [#75](https://github.com/kmorgan-r/meetwings-app/issues/75)
Follows: [#71](https://github.com/kmorgan-r/meetwings-app/issues/71)
Date: 2026-09-21
Status: design approved, plan not yet written

A meeting row fails with `ODOO_FAULT: Odoo fault 2`, the text says nothing
about why, the manual Retry re-faults identically forever, each retry that
reaches the attachment path can strand one more unreclaimable attachment, and
one faulting page aborts the whole contacts sync with the watermark left
behind. This spec makes the fault legible, makes the retry loop bounded and
harmless, and makes the contact sync walk past a bad record instead of dying on
it.

## Why

Three separate problems share one root: an Odoo XML-RPC fault carries its real
cause in `faultString`, and the code throws the cause away.

1. **The text is useless by construction.** `createOdooClient`'s `call` throws
   `odooError("ODOO_FAULT", "Odoo fault ${faultCode}", { faultCode,
   faultString })` (`src/lib/odoo/client.ts:108-116`), and `queueErrorText`
   (`src/lib/odoo/meeting-log.ts:374-381`) composes its output from
   `err.message` and `err.details.detail` only — `faultString` is never read.
   So the only error family whose message is a placeholder (`"Odoo fault 2"`)
   is the one family whose details hold the actual answer (`"AccessError: No
   matching records found (for id=...)"`), and the answer is discarded at the
   single choke point every queue error text flows through
   (`src/lib/odoo/meeting-log-push.ts:356` and `:474` both call it; QueueRow
   renders the stored column verbatim, `src/pages/meetings/components/QueueRow.tsx:431`).
2. **The retry loop is invisible *and* destructive.** The push loop isolates
   per-target correctly (`src/lib/odoo/meeting-log-push.ts:303-383`): a
   deterministic fault marks that target `failed` and moves on. `selectSweepable`
   takes only `pending`/`held` parents (`src/lib/database/meeting-log.action.ts:141-145`),
   so the automatic sweep never re-fires the fault. The harm concentrates in
   the manual path: `retryTarget` resets the child to `pending` with no attempt
   cap (`src/lib/odoo/meeting-log-actions.ts:355-381` — `targetToPending`
   clears error columns only, `src/lib/database/meeting-log.action.ts:450-452`),
   the user clicks, the push re-faults, and the text still says `Odoo fault 2`.
   Worse, the livecheck proved the shape of this fault: `ir.attachment.create`
   against a nonexistent `res_id` *succeeds*, only the subsequent
   `message_post` faults, and the stranded attachment is then unreclaimable
   through the API — `search` filters it out, `read` and `unlink` raise
   AccessError (`.livecheck/README.md`, finding 2, verified on rows 3058 and
   3063). Any retry that reaches `createOrAdoptAttachment` with a null
   attachment id cannot see its own orphan — the adopt search filters it — and
   creates a second one (`src/lib/odoo/meeting-log-push.ts:245-263`).
3. **The contacts sync has no per-record isolation for faults.** Malformed rows
   are already skipped and counted (`src/lib/odoo/contacts-sync.ts:157-174`),
   but a *fault* thrown by the page's `search_read` escapes the whole run into
   the catch at `src/lib/odoo/contacts-sync.ts:201-209`, which calls `failSync`
   and re-throws. The watermark never advances, and the next run re-fetches the
   identical page and re-faults — the permanent wedge the codebase already
   documents for the sibling path ("one malformed partner among thousands
   wedges syncing permanently", `src/lib/odoo/opportunities.ts:131-139`).

The wedge the report describes ("blocks the sync") is the combination of 1 and
2: the user sees a dead `Odoo fault 2`, retries into the identical fault, and
the row is wedged because nothing ever names the cause — the *automatic* sweep
is not the looper.

## What the issue settled — design inputs, not open questions

- **faultCode 2 is the UserError family** (UserError / AccessError /
  MissingError / ValidationError) in Odoo 17 XML-RPC. The code must not
  special-case 2 by name; it renders whatever `faultString` arrived, for every
  faultCode.
- **Archiving is not an error.** The 2026-08-30 livecheck against production
  Odoo 17 proved `message_post` on an *archived* `res.partner` succeeds. The
  comment at `src/pages/meetings/components/AssignDialog.tsx:696-698` ("a
  target Odoo archived is unrecoverable ... reproduces the same terminal
  ODOO_FAULT") and the gates it justifies are disproven, and this spec removes
  them.
- **The failure shape is already modeled in tests** — `odooError("ODOO_FAULT",
  "Odoo fault 2", { faultCode: 2, faultString: "AccessError" })` at
  `src/tests/odoo-meeting-log-push.test.ts:840` (the issue cites
  `meeting-log-page.test.tsx:642`; that line holds a different fixture — the
  real one lives in the push suite).
- **The parent row is not the looper.** `deriveRowStatus` rule 1 keeps a parent
  `pending` only while a *retryable* target remains; a terminally failed child
  is skipped by the push loop (`meeting-log-push.ts:304-309`) and never
  re-attempted by the sweep. Whatever protection this design adds targets the
  manual retry path and the wire-call waste, not the sweep.

## The invariant: no attachment is created on an unproven record

The orphan in livecheck finding 2 exists because the push writes in the order
create → post, and the second call is the one that can reject the record. Flip
the burden of proof before the first write:

**No `ir.attachment` is created until the target record is proven to exist and
be readable by the API user.**

Concretely, `createOrAdoptAttachment` gains a probe between the adopt-search
and the `create`: an `execute(target.model, "search", [[["id", "=",
target.resId]]], { limit: 1, context: { active_test: false } })`. The probe
covers both deterministic causes in one call — a deleted record and a
record-rule-invisible record both return zero rows, and both are exactly the
cases where `message_post` would fault with MissingError/AccessError. The
context flag is load-bearing: without `active_test: false` the probe would
classify an *archived* (still valid) partner as missing, reintroducing the
exact false terminal state this spec removes.

- **Probe hits** → create proceeds. The window between probe and create is a
  race in theory; the orphan path returns only inside it, and the post-fault
  target still carries its persisted attachment id for the retry to reuse. This
  is the same commit-then-timeout tolerance the existing code already documents.
- **Probe misses** → no wire write happens. The target is marked `failed` with
  the synthesized ODOO_FAULT specified in the next section, and the row lands
  in needs-attention as any deterministic fault does.
- **Probe faults** (AccessError on the model itself, say) → the thrown error
  propagates untouched to the existing per-target catch — only a zero-row
  probe *result* synthesizes the terminal ODOO_FAULT. An `ODOO_UNREACHABLE`
  blip during the probe must stay retryable, which is exactly the
  retryable-vs-deterministic discipline the catch's own comment enforces
  (`meeting-log-push.ts:350-352`); a genuine `ODOO_FAULT` stays deterministic,
  and its faultString flows into the error text.

The probe runs only where the adopt-search fails to produce an id, so a fresh
target (null persisted id, nothing to adopt) pays one extra `search` per
attachment creation, and the adopt-hit path (attachment id already persisted,
or re-found by the adopt search) and the post step pay nothing.
`postOrAdoptMessage` needs no probe of its own: if the attachment already
exists, a re-faulting `message_post` strands nothing new.

## What the retry path becomes

`retryTarget` keeps its shape: DB-only, no attempt cap, no wire calls
(`src/lib/odoo/meeting-log-actions.ts:355-381`). The spec considered capping
deterministic retries and rejects it, deliberately: with the probe above and
the text fix below, a manual retry of a genuinely dead target costs two
`search` calls — the adopt-search miss, then the probe miss — strands nothing,
and returns an error text that names the cause, while a cap would also block
the legitimate "the record rule was fixed, retry now" path, which is the whole
reason Retry exists. The livelock the issue describes was never an automatic
loop (the sweep skips failed targets); it was an invisible, destructive loop.
Informed, harmless, bounded: the loop is no longer a wedge, so no cap is added.

What changes is what a re-fault *costs and says*. The synthesized fault is
specified exactly, because a probe miss involves no server fault and must not
fabricate one:

```ts
odooError("ODOO_FAULT",
  `target record ${target.resId} missing or inaccessible (search returned 0 rows)`,
  { resId: target.resId, model: target.model })
```

The cause rides in `err.message` — which today's `queueErrorText` already
renders — not in `details.faultString`, so the dead-target text does not depend
on the faultString leg shipping; and `"Odoo fault 2"` is not fabricated, since
no server fault exists here and that message segment is reserved for a real
faultCode. The failure sequence for the issue's report case becomes two
`search` calls returning nothing, and a queue row reading:

    ODOO_FAULT: target record 42 missing or inaccessible (search returned 0 rows)

instead of one `ir.attachment.create` + one faulting `message_post` + one more
orphan per click.

## faultString rendering

`queueErrorText` (`src/lib/odoo/meeting-log.ts:374-381`) reads
`err.details.faultString` alongside `err.details.detail`:

- `faultString` present and non-empty →
  `${err.code}: ${message} - ${faultString}`, both halves redacted, the whole
  thing capped at 400 characters with an ellipsis. The cap matters: an
  *internal* Odoo fault (faultCode 1, not our UserError family) can carry a
  full Python traceback in `faultString`, and the queue column is rendered
  verbatim in every group — a traceback in the UI is its own wedge.
- `faultString` absent, empty, or non-string → today's behaviour, byte for
  byte. Plain `Error`s, plugin-sql failures and non-fault `OdooError`s keep
  their current shape, and the existing fixtures at
  `src/tests/odoo-meeting-log-render.test.ts:124-147` keep passing untouched.
- The redactor runs on the faultString half exactly as it runs on the rest —
  faultString is Odoo-derived server text that can embed record names and
  emails, and `odoo-errors.test.ts:17-22` already asserts details are redacted
  at construction; the composed text must not become a new leak path. The
  codec already XML-unescapes string members at decode, `&amp;` last so
  `&amp;lt;` round-trips (`src/lib/odoo/xmlrpc-codec.ts:180-188`), so the
  runtime faultString is raw text and `redact()` sees the raw key — the plan's
  test must still prove the needle end-to-end: a key that arrives XML-escaped
  inside the fault XML (`odoo-client.test.ts:48`), which is the shape a naive
  `replaceAll` misses, caught after unescape-and-redact, because this spec is
  what first renders faultString at all.
- The `"Odoo fault 2"` message segment stays. It carries the faultCode, which
  distinguishes the UserError family (2) from an internal fault (1) — losing
  that would cost diagnosability the text fix is meant to add.

Both recording paths in the push (`meeting-log-push.ts:356` and `:474`) call
`queueErrorText`, so the fix lands everywhere errors are stored. One honest
limitation: historically failed rows keep their old stored text until
something rewrites that column. The plan must not attempt a backfill — a
`re-render all stored errors` migration would have to re-derive `faultString`
it no longer has. The fix applies to every fault recorded after it ships.

## Contacts-sync: walk past a faulting page, never around it

The page loop keeps its shape; only the `search_read` call at
`src/lib/odoo/contacts-sync.ts:126-131` gains fault isolation. The design
borrows the push's own rule — a deterministic fault on one record must not
strand the rest — and the machinery is deliberately simple:

1. On `ODOO_FAULT` from the page fetch: re-fetch the same domain as an
   id-only **plain `search`** — `execute("res.partner", "search", [domain], {
   order: "id asc", limit: PAGE_LIMIT, context: { active_test: false } })`.
   Plain `search` takes no `fields` kwarg (domain/offset/limit/order only); a
   `fields: ["id"]` kwarg on `search` is a server-side error that would come
   back as a fault and make the entire machinery a no-op no mocked test could
   catch. A read-side crash (a computed field raising for one record) happens
   on *read*, not on search — this call names the page's ids without tripping
   the fault.
2. If the id-only search itself faults, the fault is not record-shaped (domain,
   permissions, server) — re-throw. The run fails honestly, as today.
3. With ids in hand, fetch rows by `search_read` on `["id", "in", batch]`,
   halving the batch on each fault, exactly like the push's per-target
   isolation. Every sub-batch fetch keeps `fields: PARTNER_FIELDS`,
   `context: { active_test: false }` and the type filters. Successful subsets
   upsert and advance the cursor by their max id.
4. A singleton id that still faults is skipped — `skipped += 1`, the counter
   `finishSync` already receives — and the cursor moves past it. The run
   continues.
5. **The zero-upsert breaker.** A page whose isolation ends with *zero
   upserted rows* — every singleton faulted — is a systemic fault wearing a
   record fault's clothes: a `PARTNER_FIELDS` drift against the customer's
   server, say, faults with code 2 on every read yet spares the id-only
   search. Letting that run as skips would walk the cursor past the whole
   table and end the run "successfully" with nothing ingested and the
   watermark unadvanced — a silent total ingestion failure where today's code
   fails loudly at `contacts-sync.ts:201-209`. That outcome is not a skip: fail
   the run loudly through the existing `failSync` path.

Only `ODOO_FAULT` enters the machinery, at every level of it: a batch or
singleton fetch that rejects with `ODOO_UNREACHABLE`, `ODOO_UNEXPECTED_ROW` or
`ODOO_INTERNAL` re-throws and fails the run. The machinery narrows record
faults; it never launders other failure shapes into skips.

The watermark needs no change: `maxWriteDate` is already advanced only by
successfully parsed rows (`contacts-sync.ts:160-162`), so a skipped record's
write_date is unknown and excluded — and that is a decision this spec makes
with its eyes open. While the record's write_date stays above the watermark,
every run re-fetches its page, re-bisects and re-skips it: a page fetch fault
plus one id-only search plus O(log n) bisection per run per bad record, not two
calls — and visible every run through the `skipped` count. If its write_date
has fallen below the advanced watermark, the next run's domain excludes it and
the record is silently absent: a permanently missing contact until the record
is fixed, with no run still counting it. Both fates are accepted here, and
giving the sub-watermark one a durable home — a persisted skip ledger the
picker can render — is follow-up work, not this change. A record that faults
intermittently (transient server state) is re-fetched next run and recovers
naturally.

Transport failures (`ODOO_UNREACHABLE`) and shape failures
(`ODOO_UNEXPECTED_ROW`) do **not** enter this machinery. Bisection against a
dead server burns calls to learn nothing, and the run-level catch at
`contacts-sync.ts:201-209` keeps its role for them.

## The disproven archived belief

Livecheck: `message_post` on an archived `res.partner` succeeds. The gates
built on the opposite belief come out:

- `src/pages/meetings/components/AssignDialog.tsx:696-704` — the
  `disabled={!c.active}` on the reassign select button and the `opacity-50`
  dimming, with the disproven comment.
- `AssignDialog.tsx:710-720` — the `Archived` badge may stay as an
  *informational* label, but the `AddToggle`'s `disabled={!c.active}` and the
  comment at `:497-500` do not. The `if (outcome.contact.active)` conditional
  that comment documents is removed with it: archived contacts preview and add
  exactly as active ones do, and nothing archived-specific replaces the gate —
  the tag is the only surviving trace.
- `AssignDialog.tsx:186-188` — the `adopted-archived` copy ("Un-archive them
  there to log this meeting to them") is factually wrong; archived targets
  receive the note.

Archived rows render as normal selectable rows carrying an `Archived` tag. The
user picks an archived partner deliberately, the note posts, and
`stampLastMeeting` is *expected* to write `last_meeting_at` on it — an
assumption, not a verified fact: the livecheck exercised `message_post`, not
the field write, and the push's acceptance for this leg depends on it. The
Testing section conditions the livecheck's assertion set on that call. The
`archived` *reason* row
in the proposal region (`CalendarProposal`) is a different feature with a
different decision behind it — out of scope here.

## Scope

### In

- `queueErrorText`: render `details.faultString` (redacted, capped, appended).
- The existence probe in `createOrAdoptAttachment`, and the synthesized
  ODOO_FAULT on a probe miss.
- The contacts-sync page-fault isolation (id-only search + batch halving +
  singleton skip), preserving the watermark semantics above.
- Removal of the archived-target gates and disproven comments in AssignDialog,
  keeping the informational `Archived` tag.

### Out, and why

- **No attempt cap on `retryTarget`.** The loop is not automatic, the probe
  makes it harmless, and a cap blocks the legitimate fixed-record-rule retry —
  reasoned in full above.
- **No backfill of stored error texts.** `last_error` on already-failed rows
  stays as written at failure time; the text fix applies from the next fault
  on.
- **No cleanup of the livecheck's stranded attachments.** They are unreclaimable
  via the API by Odoo's own design (finding 2); removing them needs host SQL or
  `odoo shell`, which is a customer-side action, not an app feature.
- **No change to `fetchOpportunities`' fail-loud contract**
  (`opportunities.ts:131-139`). Its asymmetry with the sync is deliberate and
  documented there; this spec changes only the sync.
- **The proposal region's own archived handling** (spec 2026-09-05: "Archived
  rows get nothing") is untouched.

## Architecture

Four edits, three of them local to files the issue names:

1. `src/lib/odoo/meeting-log.ts` — `queueErrorText` composes `faultString`.
2. `src/lib/odoo/meeting-log-push.ts` — `createOrAdoptAttachment` probes
   before creating. No signature changes; the helpers are closed over the
   per-row state they already read.
3. `src/lib/odoo/contacts-sync.ts` — the page fetch gains the fault-isolation
   wrapper. `skipped` and the watermark flow through unchanged.
4. `src/pages/meetings/components/AssignDialog.tsx` — gate removal plus copy
   fix; the data-testid surface (`assign-contact`) is unchanged, so page tests
   select rows the same way.

The DB layer needs nothing: `targetToFailed`, `sweepable`,
`deriveRowStatus` and the error columns already model every state this design
produces, and the probe's synthesized fault flows through the existing
per-target catch (`meeting-log-push.ts:350-383`) with no new status, column or
code. `ODOO_FAULT` stays `isRetryable() === false`; a probe miss is terminal
exactly as a `message_post` MissingError is today.

## Testing

- **`odoo-meeting-log-render.test.ts`** — new `queueErrorText` cases: fault
  with `faultString` renders both halves; `faultString: ""` and a *non-string*
  `faultString` (number, null) both fall back byte-identical to today's output
  — a truthiness check on `"faultString" in details` passes the first and
  breaks these, which is why both are named; a 10k-character traceback is
  capped at 400; the redactor catches a key embedded in `faultString`, with the
  XML-escaped needle `odoo-client.test.ts:48` models asserted end-to-end
  through unescape-and-redact. The existing fixtures at `:124-147` construct
  their ODOO_FAULT with no details at all
  (`odooError("ODOO_FAULT", "Odoo rejected sk-secret on partner 4")`), so they
  pass byte-identical as claimed.
- **`odoo-meeting-log-push.test.ts`** — the fault fixture at `:840` gains
  assertions on the *order* of wire calls: for a target whose record is gone,
  the client sees the probe `search` and never `ir.attachment.create` or
  `message_post`; for a healthy target, `create` follows the probe; for a
  probe that *rejects*, the same no-create/no-post order holds and the target
  lands `failed`; and for every fault leg the target's stored
  `last_error_code`/`last_error` equal the composed text — the dead-target
  retry's persisted `last_error` must match the sample composition above,
  since the stored column is the user-visible fix. The crash-between-wire-and-
  write leg (wipe local ids, bump attempts) now exercises adopt-or-probe-or-
  create.
- **`odoo-meeting-log-sweep.test.ts`** — swept targets with null attachment ids
  hit the probe on the real push path, so the suite's `create`/`message_post`
  stubs must answer the new `search` wire call; add one sweep-driven
  dead-target case (probe, no orphan, failed with the composed text).
- **Contacts-sync tests** — a faulting `search_read` page splits into
  id-only `search` + successful halves + counted singleton skip, with the
  watermark advancing from the upserted rows only; a page whose every
  singleton faults fails the run loudly (the zero-upsert breaker); a faulting
  id-only search fails the run; `ODOO_UNREACHABLE` and `ODOO_UNEXPECTED_ROW`
  bypass the machinery entirely — zero bisection calls, run-level catch fires.
- **`meeting-log-actions.test.ts` / page tests** — `retryTarget` behaviour is
  unchanged by design; the page suite's existing fault-row fixtures keep
  passing, and the AssignDialog tests gain an archived contact selectable and
  addable with the tag visible.
- **`.livecheck/`** — the harness already manufactures the deterministic leg
  by pointing a target at a missing `res_id` (`.livecheck/README.md`); the
  probe changes what that leg produces (no orphan). If a livecheck run happens
  for this change, its assertion set must cover the new order-of-calls shape
  and the stamp-on-archived assumption — the harness runs the real
  `pushQueuedRow`, which is exactly the code under test.

## Follow-up work

- The `opportunities.ts:131-139` wedge rationale cites "failing the run leaves
  the watermark unadvanced" for the *sync*; with page isolation the sentence's
  premise changes for contacts. Rewriting that comment belongs in the same
  plan as the contacts-sync change, since the code it describes is changing.
- A persisted ledger of skipped contact ids — the sub-watermark fate accepted
  in the contacts-sync section — so a permanently unreachable partner stays
  visible in the picker instead of silently absent once the watermark advances
  past it.
- Historical `Odoo fault N` texts stored in `meeting_log_targets.last_error`
  before this fix remain until the row is retried. A user-facing "these texts
  are stale" affordance is not designed here; the retry path's new text makes
  the staleness self-evident.