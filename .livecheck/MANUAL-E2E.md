# Manual GUI end-to-end — the two legs the harness cannot reach

`.livecheck/odoo-live-smoke.live.ts` enters at the queue row and proves five of
PR #48's seven behaviours. Two remain, and both need the running app:

- **Leg 4** — a local write failure *after* a successful `message_post`
- **Leg 7** — two running app instances racing the same meeting

Everything below aims at **scratch records**, never a customer.

## Before you start

```bash
# 1. Back up the database. Cheap, and this walkthrough edits it on purpose.
node .livecheck/queue-poke.mjs backup

# 2. Create the scratch contact + lead to aim at.
#    SKIP THIS if a pair already exists - see below.
ODOO_LIVE=1 npx vitest run --config .livecheck/vitest.scratch.config.ts
```

The second command prints a contact id, a lead id, and working `/web#` links.
Search the app's contact picker for **`ZZ Meetwings smoke GUI`**.

> A pair was already created on 2026-08-30: **contact 47, lead 533**. Running
> step 2 again just makes a second pair — harmless, the cleanup sweeps the whole
> `ZZ Meetwings smoke` prefix — but there is no need.

Migration 14 is already applied locally (`_sqlx_migrations` version 14,
`success = 1`), so the one-way-migration warning does not apply to this machine.

## Part 1 — the happy path through the real UI

This is the "does it work after an actual conversation" run.

1. Open Meetwings. Pick the scratch contact in the picker; add the scratch lead
   too, so the meeting has **two** destinations.
2. Have a short conversation — a few lines of speech is enough. The transcript
   only needs to be non-empty.
3. End the meeting. The hold timer runs, then the row moves to `pending` and the
   sweep pushes it.
4. Open both `/web#` links. Each should carry **one** internal note (grey, not a
   customer-visible message) with `transcript-<date>-<rowid>.md` attached.

Confirm along the way:

```bash
node .livecheck/queue-poke.mjs show
```

Both targets `sent`, each with its own `attachment_id` and `message_id`, parent
row `sent`.

> Expect the note text to show literal `<b>` and `&mdash;` — that is the known
> escaping defect (finding 1 in the README), not a failure of this run.

## Part 2 — leg 4: a live note reported as unsent

The exact crash window is milliseconds wide and not worth chasing by hand. The
*state* it leaves behind is what matters, and it can be produced exactly:

```bash
# Close Meetwings first - it holds the database open.
node .livecheck/queue-poke.mjs unsend-write-failure
```

That takes the most recently sent target, sets it back to `pending`, and
**keeps its `message_id`** — precisely what a crash between `message_post`
returning and the local write leaves.

⚠️ **Drop the network before relaunching.** The row is `pending`, so the sweep
fires on launch and the adopt-search converges it straight back to `sent` — very
likely before you can look at it. Offline, the row stays `pending` and holds
still while you inspect it. (Killing the network is one of the approved local
failure manufactures; never send bad credentials.)

That instant convergence is itself informative: if you *do* let it sweep online
and the chatter still shows **exactly one note**, the adopt half of this leg has
passed. Reconnect and retry deliberately, per question 2 below.

Relaunch the app, open the meeting-log page, and answer three questions:

1. **What does the row say?** It should not claim nothing was sent.
2. **What does Retry do?** The adopt-search should find the existing message and
   converge to `sent` **without** posting a second note. Check the chatter: still
   exactly one note.
3. **What does Delete say?** This is residual 1. `removeQueueTarget` refuses to
   delete a target holding a `message_id`, but `deleteQueueRow`'s gate tests only
   `NOT EXISTS (… status='sent')` — so deleting the **whole meeting** is expected
   to succeed and to tell you "Nothing was sent to Odoo." while the note is live
   in Odoo. Confirm whether it does, and capture the exact wording.

## Part 3 — leg 7: two running instances

The in-process claim exclusion (`claimed`, a module-level `Set`) is per-process.
The database CAS (`claimRow`'s `WHERE status IN ('pending','held')`) is what has
to arbitrate across processes.

1. Queue a meeting against the scratch contact but let it sit — cancel the hold
   or keep the app idle so it stays `pending`.
2. Start a **second** instance: `npm run tauri dev` alongside the installed app,
   or launch the built exe twice.
3. Let both sweep. Whichever wins the CAS should push; the loser's `claimRow`
   should return `rowsAffected = 0` and it should decline.
4. Check the chatter: **exactly one note**. Two notes means the cross-process
   exclusion does not hold, which is a merge blocker.

`node .livecheck/queue-poke.mjs show` afterwards: one target row, `sent`, one
`message_id`.

## When you are done

```bash
ODOO_LIVE=1 npx vitest run --config .livecheck/vitest.cleanup.config.ts
```

Removes every `ZZ Meetwings smoke` record and everything attached to them. It
cannot remove orphan attachments from a failed target — nothing over XML-RPC can;
see the README.

If anything went sideways locally, the backup from step 1 is in `%APPDATA%`;
close the app, copy it back over
`%APPDATA%/com.meetwings.app/meetwings.db`, relaunch.
