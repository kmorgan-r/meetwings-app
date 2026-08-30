# .livecheck — the live Odoo smoke test

The one check the unit suite structurally cannot perform: it talks to a **real
Odoo instance** and asserts on what Odoo actually does, not on what a mock was
told to return.

Every failure mode the meeting-log feature handles is an Odoo *response* — a
`message_post` fault, a permissions refusal, a missing record, whether
`subtype_xmlid: "mail.mt_note"` really suppresses follower email. A mocked
client returns whatever it is handed, so a fully green suite says nothing about
any of them. This harness is what closes that gap.

## Running it

```bash
ODOO_LIVE=1 npx vitest run --config .livecheck/vitest.live.config.ts
```

Credentials are read at runtime from the app's own store
(`%APPDATA%/com.meetwings.app/.secure-settings.dat`) — never from this
directory, never printed, never logged.

## Why it cannot fire by accident

Three independent guards:

1. **`ODOO_LIVE=1` or it throws at import.** No flag, no writes.
2. **The filename cannot be collected by the default suite.** `*.live.ts` does
   not match vitest's `**/*.{test,spec}.?(c|m)[jt]s?(x)` include glob, so
   `npm test` never sees it. It runs only under its own config, which names the
   file explicitly.
3. **It creates its own scratch records** — `ZZ Meetwings smoke <timestamp>` —
   and never touches a real customer. A scratch record's only possible follower
   is the API user itself.

`.livecheck/` is also outside `tsconfig.json`'s `include: ["src"]` and is skipped
by `eslint .` (dot-directory), so it cannot break `npm run type-check` or
`npm run lint`.

## What it actually exercises

The **real `pushQueuedRow`**, not a re-implementation. Only two substitutions:

| Substituted | With | Why |
|---|---|---|
| `@tauri-apps/plugin-http` | node's `fetch` | no Tauri runtime outside the app |
| `@/lib/database/config` | a sql.js DB built from the real migration files, through migration 14 | no plugin-sql outside the app |

Everything else is the shipping code: the XML-RPC codec, the client, the note
body, the base64 attachment, the per-target compare-and-swap state machine, the
retryable-vs-deterministic error classification.

## Manufacturing failure legs

**Never by sending bad credentials.** `fail2ban` on that host is
`maxretry 10 / findtime 600 / bantime 3600`; a locked-out API user takes the
whole integration down for an hour. Unban with
`sudo fail2ban-client set odoo-login unbanip <ip>`.

Manufacture them locally instead — that is what this harness does:

- **crash between the wire call and the local write** → wipe the local
  `attachment_id`/`message_id`, bump `attempts`, push again, assert it *adopts*
  rather than re-posting
- **deterministic target failure** → point a target at a **missing** `res_id`.
  Note that **archiving a record is NOT an error**: `message_post` on an
  archived `res.partner` succeeds. A deleted record is both the correct way to
  produce the fault and the shape that actually reaches production.

## Findings from the 2026-08-30 run (Odoo 17.0, `ClimatePoint`)

14/14 passed, and two real defects surfaced that the 1173-test suite could not
see:

1. **Note bodies render as literal markup.** `buildNoteBody` emits HTML; Odoo 17
   treats a non-`Markup` `str` body as plaintext and runs `plaintext2html` on it,
   and XML-RPC can only send `str`. Probed fix: `message_post` followed by
   `mail.message.write({body})` preserves the HTML.
2. **A deterministically failed target strands a live attachment.**
   `ir.attachment.create` against a nonexistent `res_id` succeeds; only the
   subsequent `message_post` faults. Nothing cleans the orphan up.

`mail.mt_note` itself checked out: `subtype_id = [2, "Note"]`, and both
`mail.mail` and `mail.notification` came back empty — no customer was emailed.

## Cleaning up after a run

The scratch records are left in place deliberately, so they can be eyeballed in
the Odoo UI. To remove them:

- unlink every `res.partner` and `crm.lead` whose name starts `ZZ Meetwings smoke`
  — pass `active_test: False` in the context, or the search hides the archived ones
- unlink orphan attachments: `ir.attachment` where `res_model = 'res.partner'`
  and `res_id = 999999999`

This instance serves the classic `/web#` hash URLs, not `/odoo/<model>/<id>`; the
harness prints working links at the end of a run.
