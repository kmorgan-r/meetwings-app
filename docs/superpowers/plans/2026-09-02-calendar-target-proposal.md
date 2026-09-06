# Calendar-proposed Odoo Targets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Read the signed-in user's Outlook calendar over Microsoft Graph, work out which meeting is happening now, match its attendees against the cached Odoo contacts by exact normalized email, and present the matches as a block the user confirms before anything is written to `odoo_selected_targets`.

**Architecture:** Rust does IO and holds credentials; every decision is a pure TypeScript function with unit tests. `src-tauri/src/graph/` owns OAuth (auth code + PKCE, system browser, loopback listener), the keychain, and the `calendarView` call, and returns attendee names/addresses plus epoch-millisecond times across the IPC boundary — never a token. `src/lib/calendar/` holds the pure decision functions (which meeting, which attendees match) and the `GRAPH_*` error codes. `useCalendarProposal` is mounted in `<Completion />` beside `useOdooTarget`; `CalendarProposal.tsx` is a props-only component rendered at the top of the existing `ContactPicker` popover, and writes exclusively through `ContactPicker`'s existing `onAddTarget` prop.

**Tech Stack:** Tauri 2 (Rust), `reqwest`, `keyring`, `sha2`, `rand`, `std::net::TcpListener`; React 19 + TypeScript, Vitest, `tauri-plugin-sql`.

**Spec:** `docs/superpowers/specs/2026-09-01-calendar-target-proposal-design.md` — read it alongside this plan. Every "why" below is argued there.

## Global Constraints

Copied verbatim from the spec. Every task's requirements implicitly include this section.

- **No write to `odoo_selected_targets` happens without an explicit user confirm action.** The control is a single confirm button, labelled with the exact count it will write — "Add 4 to log". Checking and unchecking proposal rows writes nothing.
- **No token ever crosses the Tauri IPC boundary.** Refresh token: OS keychain. Access token: Rust process memory only. Never written to `plugin-store`, `localStorage`, or any log.
- **Clear the stored refresh token only on an explicit `invalid_grant`** from the token endpoint. A transport failure or timeout during refresh maps to `GRAPH_NETWORK` and **retains** the token.
- **One refresh-and-retry on a 401** from a data call, then give up.
- **Rotation writes the new refresh token before deleting the old one.**
- **Disconnect clears the keychain entry, zeroes the in-memory access token, and aborts in-flight calls.**
- **On Linux with no keychain service: refuse to persist** and re-authenticate each launch. A silent plaintext fallback is not acceptable.
- **Device code flow is not implemented**, and "Allow public client flows" stays disabled on the registration.
- Bind **literal `127.0.0.1`** — not `localhost`, not `0.0.0.0`. Random ephemeral port per attempt. The listener is single-use and times out. `state` is validated before the code is accepted.
- **Tokens, meeting subjects, and attendee addresses are never logged, at any level.** This is a construction-site rule: they are never passed into a `GraphError`'s message or details in the first place. `toGraphError` maps to a code and **drops** the original text rather than redacting it.
- **The Rust layer fails loudly on an absent filter property** (`isCancelled`, `isAllDay`, `responseStatus`) rather than defaulting the event to included. That maps to `GRAPH_BAD_RESPONSE`.
- **`Prefer: outlook.timezone="UTC"` is sent on the `calendarView` request**, and a response whose `timeZone` is not `UTC` is rejected rather than parsed.
- **Both cap quantities read from `MAX_TARGETS`** (`src/lib/odoo/meeting-log.ts:66`) and never from a literal.
- **The confirm writes are sequential** — `for...of` with `await`, never `Promise.all`.
- **The popover's footprint must not change after open.** Statically-absent routes through `useCompletion`'s flag list; dynamically-absent occupies the reserved region.
- **v1 ships no client ID.** Client ID and authority are config strings with empty defaults, entered on the `/odoo` page.

### Repo facts every task depends on

- Type-check script is **`npm run type-check`** (NOT `check:types`). Lint is `npm run lint`.
- Tests live **flat in `src/tests/`** with `<subject>.<aspect>.test.ts[x]` naming. Run scoped: `npx vitest run src/tests/<file>`.
- `docs/superpowers` is **gitignored** — committing anything under it needs `git add -f`.
- `vi.mock` factories must close over `vi.hoisted(...)` values, never plain consts (TDZ; see `src/tests/useOdooTarget.test.tsx:52-56`).
- Tauri commands in this repo return `Result<T, String>` and are registered in `src-tauri/src/lib.rs:148`.
- Rust unit tests live in a `#[cfg(test)] mod tests` at the bottom of the module (`src-tauri/src/meeting_detect/mod.rs:703`). Run: `cargo test --manifest-path src-tauri/Cargo.toml`.

## File Structure

**Create:**

| Path | Responsibility |
|---|---|
| `src/types/calendar.ts` | `GraphErrorCode`, `CalendarEvent`, `CalendarParticipant`, `GraphStatus`, `CurrentMeetings` — the IPC contract, shared by Rust (via serde) and TS — **plus** `MatchResult` and `CalendarProposalState`, which live here rather than in the modules that produce them so `src/hooks/` and `src/pages/` never import each other's types |
| `src/lib/calendar/errors.ts` | `GraphError`, `graphError`, `toGraphError`, `reportGraphError` |
| `src/lib/calendar/match-attendees.ts` | `normalizeAddress`, `participantsOf`, `matchAttendees` — attendee identity and the matched/unmatched/excluded split |
| `src/lib/calendar/current-meeting.ts` | `pickCurrentMeeting` — one / several / none |
| `src/lib/calendar/index.ts` | barrel |
| `src/lib/storage/graph-config.storage.ts` | client ID + authority (not secret; passed to Rust on every command) |
| `src/hooks/useCalendarProposal.ts` | orchestration: presence, fetch, generation guard, lifecycle resets |
| `src/pages/app/components/completion/CalendarProposal.tsx` | the block's markup, the slot rule, the sequential confirm write |
| `src-tauri/src/graph/mod.rs` | the four commands + `GraphState` |
| `src-tauri/src/graph/auth.rs` | PKCE/state/nonce, loopback listener, token exchange + refresh |
| `src-tauri/src/graph/keychain.rs` | three functions behind which Probe 2's outcome is isolated |
| `src-tauri/src/graph/calendar.rs` | `calendarView` request, response parsing, epoch normalization |

**Modify:**

| Path | Change |
|---|---|
| `src-tauri/Cargo.toml` | add `keyring`, `sha2`, `rand`, `url` |
| `src-tauri/src/lib.rs:2-8, :148` | `mod graph;`, manage `GraphState`, register four commands |
| `src/types/index.ts` | `export * from "./calendar";` |
| `src/lib/index.ts` | `export * from "./calendar";` |
| `src/hooks/index.ts` | `export * from "./useCalendarProposal";` |
| `src/hooks/useCompletion.ts:130-143, :1929-1953, :2320-2327` | `calendarBlockPresent` state slot + resize dep, mirroring `targetCount` |
| `src/pages/app/components/completion/ContactPicker.tsx:88-158, :319-321` | new `calendar` prop; render `<CalendarProposal />` at the top of the popover content |
| `src/pages/app/components/completion/index.tsx:48-60, :158` | mount `useCalendarProposal`; pass `calendar` to `<ContactPicker />` |
| `src/pages/odoo/index.tsx` | calendar connect section |

**Test files created (8):** `src/tests/current-meeting.test.ts`, `src/tests/match-attendees.test.ts`, `src/tests/graph-errors.test.ts`, `src/tests/graph-redact.test.ts`, `src/tests/graph-config.storage.test.ts`, `src/tests/useCalendarProposal.test.tsx`, `src/tests/CalendarProposal.slots.test.tsx`, `src/tests/CalendarProposal.states.test.tsx`.

Also modified: `src/tests/odoo-contact-picker.test.tsx` (Task 15 extends it).

**Cargo dependencies added** (Task 6): `sha2`, `rand`, `url`, and — unless Probe 2 finds a Rust-side API on `tauri-plugin-keychain` — `keyring`. Deliberately NOT added: `oauth2` (the flow is four HTTP calls and two hashes; a framework would put the token lifecycle inside someone else's state machine) and `chrono`/`time`/`chrono-tz` (the query window arrives from TypeScript as ISO strings, and the response parse is fixed-layout integer math).

---

## Slice 0 — Probes

Both probes are **findings**, not code. They are Tasks 1 and 2 because each can move a module boundary, and Task 1 gates every auth task (7, 9, 10, 11).

### Task 1: Probe 2 — does `tauri-plugin-keychain` expose a Rust API?

**Files:**
- Create: `docs/superpowers/plans/probe-results/2026-09-02-keychain-rust-api.md`

**Interfaces:**
- Produces: a recorded decision that Task 9's `src-tauri/src/graph/keychain.rs` implements against. Nothing else in the plan branches on it — the whole point of isolating three functions in their own file is that this probe changes one file.

**Why this is first:** if the plugin is JS-facing only, it cannot hold the refresh token without putting that token back in the webview, which the Global Constraints forbid. Evidence already in hand that it probably is JS-only: `src-tauri/capabilities/cross-platform.json` lists `keychain:allow-get-item` / `allow-save-item` / `allow-remove-item`, which are **webview command permissions**, and `src-tauri/src/lib.rs:119` registers it with `tauri_plugin_keychain::init()` and never calls it from Rust.

- [ ] **Step 1: Read the plugin's public Rust surface**

```bash
cargo doc --manifest-path src-tauri/Cargo.toml -p tauri-plugin-keychain --no-deps 2>&1 | tail -5
find ~/.cargo/registry/src -maxdepth 3 -type d -name "tauri-plugin-keychain-*"
```

Then read that directory's `src/lib.rs` and look for either (a) an extension trait on `AppHandle`/`Manager` exposing get/save/remove, or (b) only `#[tauri::command]` functions plus `init()`.

- [ ] **Step 2: Record the finding**

Write `docs/superpowers/plans/probe-results/2026-09-02-keychain-rust-api.md` with exactly these fields:

```markdown
# Probe 2 — tauri-plugin-keychain Rust API

- Version inspected:
- Public Rust items found: (list, or "commands + init() only")
- Verdict: RUST-API-AVAILABLE | JS-ONLY
- Decision for Task 9: (which of the two below)
  - RUST-API-AVAILABLE -> keychain.rs wraps the plugin's extension trait; do NOT add the `keyring` crate in Task 6.
  - JS-ONLY -> keychain.rs wraps the `keyring` crate exactly as Task 9 specifies; `keyring` stays in Task 6's Cargo additions.

## Second question, same probe: which error variant means "no keychain service"?

Task 9's `available()` decides the ENTIRE refuse-to-persist fallback by matching
one error variant. Guessing wrong is not a small miss: `available()` returns true,
`persist_rotated` then fails, and `graph_connect` errors AFTER `exchange_code` has
already burnt the authorization code — so a credential that was successfully
obtained is thrown away and the user must redo the whole browser flow.

- Variant returned by `Entry::new` / `get_password` when no Secret Service is
  running (read `keyring`'s own `Error` enum for the platform in use; on Linux the
  candidates are `PlatformFailure`, `NoStorageAccess`, and `Invalid`):
- Variant(s) `available()` must therefore treat as "unavailable":
```

**Whatever this probe finds, Task 9's `available()` is still a heuristic and Task 11
must not depend on it being right** — see Task 11's degrade-to-session-only rule.

- [ ] **Step 3: Commit**

```bash
git add -f docs/superpowers/plans/probe-results/2026-09-02-keychain-rust-api.md
git commit -m "docs(graph): record keychain Rust-API probe result"
```

### Task 2: Probe 1 — the `calendarView` property set under `Calendars.ReadBasic`

**Files:**
- Create: `docs/superpowers/plans/probe-results/2026-09-02-calendarview-properties.md`

**Interfaces:**
- Produces: the value of `GRAPH_SCOPES` that Task 9 hardcodes.

**Why:** Microsoft documents ReadBasic as excluding "properties such as body, attachments, and extensions" — not an exhaustive list. If ReadBasic withholds `isCancelled` or `responseStatus`, the cancelled and declined filters silently no-op and a meeting the user *declined* proposes its attendees.

- [ ] **Step 1: Make one Graph Explorer call with a ReadBasic-consented token**

In [Graph Explorer](https://developer.microsoft.com/graph/graph-explorer), consent to **only** `Calendars.ReadBasic` (revoke `Calendars.Read` if present), then run — with a real meeting inside the window — this request, sending the header `Prefer: outlook.timezone="UTC"`:

```
GET https://graph.microsoft.com/v1.0/me/calendarView?startDateTime=2026-09-02T00:00:00Z&endDateTime=2026-09-03T00:00:00Z&$select=id,subject,start,end,isCancelled,isAllDay,responseStatus,organizer,attendees
```

- [ ] **Step 2: Record the finding**

```markdown
# Probe 1 — calendarView properties under Calendars.ReadBasic

Present / absent, one line each:
- attendees:
- attendees[].type (does a booked room appear with type "resource"?):
- organizer:
- organizer repeated inside attendees? (confirmation only — the union-and-dedupe rule is correct either way):
- subject:
- start / end (and the `timeZone` value returned with the Prefer header):
- isCancelled:
- isAllDay:
- responseStatus:

Verdict: ALL-PRESENT | MISSING (<list>)
Decision for Task 9's GRAPH_SCOPES:
  ALL-PRESENT -> "openid profile offline_access https://graph.microsoft.com/Calendars.ReadBasic"
  MISSING     -> "openid profile offline_access https://graph.microsoft.com/Calendars.Read"
```

- [ ] **Step 3: Commit**

```bash
git add -f docs/superpowers/plans/probe-results/2026-09-02-calendarview-properties.md
git commit -m "docs(graph): record calendarView property probe result"
```

---

## Slice 1 — Types and pure decision functions

No dependency on either probe. Every function here is pure and runs in Vitest with no Tauri mock.

### Task 3: The IPC contract types and `GRAPH_*` errors

**Files:**
- Create: `src/types/calendar.ts`, `src/lib/calendar/errors.ts`, `src/lib/calendar/index.ts`
- Modify: `src/types/index.ts`, `src/lib/index.ts`
- Test: `src/tests/graph-errors.test.ts`, `src/tests/graph-redact.test.ts`

**Interfaces:**
- Produces, from `src/types/calendar.ts`: `GraphErrorCode`, `AttendeeType`, `CalendarParticipant`, `CalendarEvent`, `GraphStatus`, `CurrentMeetings` — plus, because they are shared across `src/lib/`, `src/hooks/` and `src/pages/`, `AttendeeMatch`, `UnmatchedAttendee`, `ExcludedAttendee`, `MatchResult`, `CurrentMeeting`, `CandidateSummary` and `CalendarProposalState`.
- Produces, from `src/lib/calendar/errors.ts`: `GraphError`, `graphError(code)`, `toGraphError(thrown)`, `reportGraphError(thrown, where)`.

  Tasks 4, 5, 11, 13, 14 and 15 consume these. Tasks 4 and 5 declare **no** result types of their own — they import them from here, which is what keeps `src/hooks/` and `src/pages/` from importing each other's types.

- [ ] **Step 1: Write the failing tests**

`src/tests/graph-errors.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
// `reportGraphError` is deliberately NOT imported here - it is exercised in
// graph-redact.test.ts. An unused import fails the `npm run lint` this task's
// own verification step expects to be clean.
import { GraphError, graphError, toGraphError } from "@/lib/calendar/errors";

describe("graphError", () => {
  it("carries the code and non-identifying details only", () => {
    const err = graphError("GRAPH_BAD_RESPONSE", { eventCount: 3 });
    expect(err).toBeInstanceOf(GraphError);
    expect(err.code).toBe("GRAPH_BAD_RESPONSE");
    // `message` IS the code. There is no free-text message parameter to pass a
    // subject or an address through.
    expect(err.message).toBe("GRAPH_BAD_RESPONSE");
    expect(err.details).toEqual({ eventCount: 3 });
  });

  /**
   * "Respect Retry-After; do not retry in a loop" holds BY CONSTRUCTION here,
   * so no seconds value is carried and none is needed.
   *
   * This feature has exactly one automatic retry anywhere - the single
   * refresh-and-retry on a 401 (Task 11) - and a 429 is not it: calendar.rs
   * returns GRAPH_THROTTLED straight to the caller, useCalendarProposal puts
   * it in an error state, and the only thing that issues another request is a
   * user clicking Try again. A stored Retry-After would have nothing to gate.
   */
  it("carries no retry hint on GRAPH_THROTTLED, because nothing auto-retries", () => {
    expect(graphError("GRAPH_THROTTLED").details).toEqual({});
  });
});

describe("toGraphError", () => {
  // Rust returns a bare GRAPH_* code string as its Err value.
  it("maps a bare code string thrown by the IPC boundary", () => {
    expect(toGraphError("GRAPH_BAD_RESPONSE").code).toBe("GRAPH_BAD_RESPONSE");
    expect(toGraphError(new Error("GRAPH_AUTH_EXPIRED")).code).toBe("GRAPH_AUTH_EXPIRED");
  });

  it("maps anything unrecognized to GRAPH_NETWORK", () => {
    expect(toGraphError(new Error("connection reset")).code).toBe("GRAPH_NETWORK");
    expect(toGraphError(undefined).code).toBe("GRAPH_NETWORK");
  });

  it("passes a GraphError through unchanged", () => {
    const original = graphError("GRAPH_NO_KEYCHAIN");
    expect(toGraphError(original)).toBe(original);
  });
});
```

`src/tests/graph-redact.test.ts` — the executable form of the construction-site rule. This is the analogue of `odoo-redact.test.ts`, and it is what makes the deliberate divergence from `reportOdooError` observable:

```typescript
import { describe, expect, it } from "vitest";
import { reportGraphError, toGraphError } from "@/lib/calendar/errors";

const TOKEN = "eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiJ9.SECRETPAYLOAD.sig";
const SUBJECT = "Acme renewal — pricing";
const ADDRESS = "cfo@acme.example";

describe("Graph errors never carry meeting content", () => {
  // reportOdooError propagates the thrown error's message once the redactor is
  // initialised. The Graph analogue must NOT: a subject or address lifted from
  // a raw reqwest/serde failure would survive into the report, and no fixed
  // needle list can catch a per-event value.
  it.each([TOKEN, SUBJECT, ADDRESS])("drops %s from a raw thrown error", (secret) => {
    const report = reportGraphError(new Error(`failed on ${secret}`), "current meetings");
    expect(JSON.stringify(report)).not.toContain(secret);
  });

  it("keeps the code and the operation", () => {
    const report = reportGraphError("GRAPH_THROTTLED", "current meetings");
    expect(report.code).toBe("GRAPH_THROTTLED");
    expect(report.message).toBe("GRAPH_THROTTLED");
    expect(report.details.where).toBe("current meetings");
  });

  it("keeps non-identifying counts", () => {
    const report = reportGraphError(
      toGraphError("GRAPH_BAD_RESPONSE"),
      "current meetings"
    );
    expect(report.code).toBe("GRAPH_BAD_RESPONSE");
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/tests/graph-errors.test.ts src/tests/graph-redact.test.ts`
Expected: FAIL — `Failed to resolve import "@/lib/calendar/errors"`.

- [ ] **Step 3: Write the types**

`src/types/calendar.ts`:

```typescript
/** Every failure this feature can surface. Mirrors OdooErrorCode's shape. */
export type GraphErrorCode =
  | "GRAPH_NOT_CONNECTED"
  | "GRAPH_CONSENT_REQUIRED"
  | "GRAPH_AUTH_CANCELLED"
  | "GRAPH_AUTH_EXPIRED"
  | "GRAPH_AUTH_REJECTED"
  | "GRAPH_BAD_RESPONSE"
  | "GRAPH_THROTTLED"
  | "GRAPH_NETWORK"
  | "GRAPH_NO_KEYCHAIN";

/**
 * Graph puts rooms and equipment in the same `attendees[]` array as people,
 * distinguished only by `type: "resource"`. They are dropped before any rule
 * sees them - see participantsOf.
 */
export type AttendeeType = "required" | "optional" | "resource";

export interface CalendarParticipant {
  address: string;
  name: string | null;
  type: AttendeeType;
  /**
   * Graph carries the organizer in a separate `organizer` property and
   * generally does NOT repeat them in `attendees`. Rust unions both; this flag
   * says which side a participant came from.
   */
  isOrganizer: boolean;
}

/**
 * One event, already normalized by Rust.
 *
 * `startMs`/`endMs` are epoch milliseconds, NOT strings. Graph sends
 * `dateTime` with no offset suffix alongside a separate `timeZone`, so
 * `new Date(ev.start.dateTime)` in the webview reads it as LOCAL time and
 * shifts the entire acceptance window by the UTC offset.
 */
export interface CalendarEvent {
  id: string;
  subject: string | null;
  startMs: number;
  endMs: number;
  isCancelled: boolean;
  isAllDay: boolean;
  /** The signed-in user's own responseStatus.response, verbatim from Graph. */
  ownResponse: string;
  /** organizer + attendees, unfiltered and undeduped. participantsOf does both. */
  participants: CalendarParticipant[];
}

/**
 * NO TOKEN FIELD, EVER. src-tauri/src/graph/mod.rs carries a cargo test that
 * fails if any exposed command's return struct gains a credential field.
 */
export interface GraphStatus {
  connected: boolean;
  /** true when no keychain service was available and the connection is session-only. */
  sessionOnly: boolean;
}

export interface CurrentMeetings {
  /**
   * The preferred_username (falling back to upn) claim of the ID token, or
   * null when neither is present. BEST-EFFORT by design: both claims are
   * UPN-shaped and in many tenants differ from the primary SMTP address in
   * `attendees[]`. When it resolves to nothing the user's own row is proposed
   * like any other - a visible row they can uncheck, never a silent drop.
   */
  ownAddress: string | null;
  events: CalendarEvent[];
}

/* ----------------------------------------------------------------------------
 * Everything below is shared between `src/lib/calendar/`, `src/hooks/` and
 * `src/pages/`, so it lives HERE rather than in whichever module happens to
 * produce it.
 *
 * That placement is load-bearing, not tidiness. The obvious alternative -
 * declaring `MatchResult` in match-attendees.ts and `CalendarProposalState` in
 * useCalendarProposal.ts - has `src/pages/` and `src/hooks/` importing types out
 * of each other: CalendarProposal.tsx and ContactPicker.tsx would both pull the
 * state union out of the hook, while the hook depends on nothing but @/types and
 * @/lib. Those edges are all `import type`, so they erase at build and the
 * runtime graph stays acyclic - but widening any one of them to a value import
 * later makes it real, and nothing in this repo has a page importing a type back
 * out of a hook.
 * ------------------------------------------------------------------------- */

export interface AttendeeMatch {
  participant: CalendarParticipant;
  contact: OdooContact;
}

export interface UnmatchedAttendee {
  participant: CalendarParticipant;
  /**
   * `archived` is NOT a softer `no-contact`: the record exists, it is just not
   * somewhere new notes should land. The two render differently.
   */
  reason: "no-contact" | "archived";
}

export interface ExcludedAttendee {
  participant: CalendarParticipant;
  /** Excluded from the PROPOSAL, not from what the user may select by hand. */
  reason: "self" | "colleague";
}

export interface MatchResult {
  matched: AttendeeMatch[];
  unmatched: UnmatchedAttendee[];
  excluded: ExcludedAttendee[];
}

export type CurrentMeeting =
  | { kind: "one"; event: CalendarEvent }
  | { kind: "several"; candidates: CalendarEvent[] }
  | { kind: "none" };

export interface CandidateSummary {
  id: string;
  subject: string | null;
  startMs: number;
  endMs: number;
}

export type CalendarProposalState =
  /** Popover closed, or reset. The region is not reserved. */
  | { kind: "idle" }
  | { kind: "loading" }
  /**
   * DYNAMICALLY absent: connected, the call ran, no current meeting. Occupies
   * the reserved region, because it resolves after open.
   */
  | { kind: "no-meeting" }
  | { kind: "several"; candidates: CandidateSummary[] }
  | {
      kind: "proposal";
      eventId: string;
      subject: string | null;
      matched: AttendeeMatch[];
      unmatched: UnmatchedAttendee[];
    }
  | { kind: "error"; code: GraphErrorCode };
```

The file's one import, at the top:

```typescript
import type { OdooContact } from "./odoo";
```

Add to `src/types/index.ts`: `export * from "./calendar";`

- [ ] **Step 4: Write the errors module**

`src/lib/calendar/errors.ts`:

```typescript
import type { GraphErrorCode } from "@/types";

export type GraphErrorDetails = Record<string, string | number>;

const CODES: ReadonlySet<string> = new Set<GraphErrorCode>([
  "GRAPH_NOT_CONNECTED",
  "GRAPH_CONSENT_REQUIRED",
  "GRAPH_AUTH_CANCELLED",
  "GRAPH_AUTH_EXPIRED",
  "GRAPH_AUTH_REJECTED",
  "GRAPH_BAD_RESPONSE",
  "GRAPH_THROTTLED",
  "GRAPH_NETWORK",
  "GRAPH_NO_KEYCHAIN",
]);

/**
 * `message` IS the code. There is deliberately no free-text message parameter:
 * meeting subjects and attendee addresses are per-event values that no
 * pre-built needle list can redact, so they are never passed in at all.
 *
 * `details` takes only non-identifying values - counts, retry seconds, the
 * operation name. Never an address, never a subject, never a token.
 */
export class GraphError extends Error {
  readonly code: GraphErrorCode;
  readonly details: GraphErrorDetails;

  constructor(code: GraphErrorCode, details: GraphErrorDetails) {
    super(code);
    this.name = "GraphError";
    this.code = code;
    this.details = details;
  }
}

export function graphError(
  code: GraphErrorCode,
  details: GraphErrorDetails = {}
): GraphError {
  return new GraphError(code, details);
}

/**
 * The boundary catch. Rust returns a BARE `GRAPH_*` code string as its Err
 * value, which `invoke` rejects with; `plugin-sql` and friends throw plain
 * Errors that are not GraphError at all.
 *
 * DELIBERATE DIVERGENCE from toOdooError: the thrown value's text is DROPPED,
 * not attached as a `detail`. A subject or address lifted from a raw reqwest
 * or serde failure would otherwise survive into the report.
 */
export function toGraphError(thrown: unknown): GraphError {
  if (thrown instanceof GraphError) return thrown;
  const raw = thrown instanceof Error ? thrown.message : String(thrown);
  return CODES.has(raw)
    ? new GraphError(raw as GraphErrorCode, {})
    : new GraphError("GRAPH_NETWORK", {});
}

export interface GraphErrorReport {
  code: GraphErrorCode;
  message: string;
  details: GraphErrorDetails;
}

/**
 * The single reporting choke point, mirroring reportOdooError - except that
 * `message` is always the code. There is no isRedactorInitialised branch here
 * because there is nothing to redact: nothing identifying was ever put in.
 */
export function reportGraphError(thrown: unknown, where: string): GraphErrorReport {
  const err = toGraphError(thrown);
  return {
    code: err.code,
    message: err.code,
    details: { ...err.details, where },
  };
}
```

`src/lib/calendar/index.ts`:

```typescript
export * from "./errors";
```

Add to `src/lib/index.ts`: `export * from "./calendar";`

- [ ] **Step 5: Run tests, lint and types**

Run: `npx vitest run src/tests/graph-errors.test.ts src/tests/graph-redact.test.ts && npm run type-check && npm run lint`
Expected: PASS, no type errors, no lint errors.

Barrel collision check — `src/lib/index.ts` is flat, so a duplicate export name across `./odoo` and `./calendar` is a build error. Confirm none of `GraphError`, `graphError`, `toGraphError`, `reportGraphError`, `GraphErrorDetails`, `GraphErrorReport` already exists:

```bash
grep -rn "GraphError\|graphError\|AttendeeType\|CalendarParticipant\|CalendarEvent\|GraphStatus\|CurrentMeetings\|AttendeeMatch\|UnmatchedAttendee\|ExcludedAttendee\|MatchResult\|CurrentMeeting\|CandidateSummary\|CalendarProposalState" \
  src/lib src/types --include=*.ts | grep -v "src/lib/calendar\|src/types/calendar"
```
Expected: no output. The filter excludes `src/types/calendar` as well as `src/lib/calendar` — this task's own declarations are not collisions, and without the second term every new type would report as one.

- [ ] **Step 6: Commit**

```bash
git add src/types/calendar.ts src/types/index.ts src/lib/calendar src/lib/index.ts src/tests/graph-errors.test.ts src/tests/graph-redact.test.ts
git commit -m "feat(calendar): add Graph IPC types and GRAPH_* error codes"
```

### Task 4: `match-attendees.ts` — attendee identity and the three-way split

**Files:**
- Create: `src/lib/calendar/match-attendees.ts`
- Modify: `src/lib/calendar/index.ts`
- Test: `src/tests/match-attendees.test.ts`

**Interfaces:**
- Consumes: `CalendarEvent`, `CalendarParticipant`, `MatchResult`, `AttendeeMatch`, `UnmatchedAttendee`, `ExcludedAttendee` (all from `@/types`, Task 3), `OdooContact` (`src/types/odoo.ts:26`).
- Produces — **functions only.** The result types are declared in `src/types/calendar.ts`, not here; see the placement note in Task 3.
  - `normalizeAddress(address: string): string`
  - `participantsOf(event: CalendarEvent): CalendarParticipant[]`
  - `matchAttendees(args: { participants: CalendarParticipant[]; contacts: OdooContact[]; ownAddress: string | null }): MatchResult`

  Task 5 imports `participantsOf` (this module owns attendee identity; `current-meeting.ts` owns which meeting it is). Tasks 13 and 14 import the rest.

- [ ] **Step 1: Write the failing test**

`src/tests/match-attendees.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { matchAttendees, normalizeAddress, participantsOf } from "@/lib/calendar/match-attendees";
import type { CalendarEvent, CalendarParticipant } from "@/types";
import type { OdooContact } from "@/types";

function participant(
  address: string,
  over: Partial<CalendarParticipant> = {}
): CalendarParticipant {
  return { address, name: null, type: "required", isOrganizer: false, ...over };
}

function contact(id: number, email: string | null, over: Partial<OdooContact> = {}): OdooContact {
  return {
    id,
    name: `Contact ${id}`,
    email,
    phone: null,
    companyName: null,
    parentId: null,
    isCompany: false,
    active: true,
    writeDate: "2026-09-01 00:00:00",
    isColleague: false,
    lastMeetingAt: null,
    ...over,
  };
}

function event(participants: CalendarParticipant[]): CalendarEvent {
  return {
    id: "e1",
    subject: "Sync",
    startMs: 0,
    endMs: 0,
    isCancelled: false,
    isAllDay: false,
    ownResponse: "accepted",
    participants,
  };
}

describe("normalizeAddress", () => {
  it("trims and lowercases", () => {
    expect(normalizeAddress("  CFO@Acme.Example ")).toBe("cfo@acme.example");
  });
});

describe("participantsOf", () => {
  it("drops resource attendees", () => {
    const out = participantsOf(
      event([participant("a@x.test"), participant("room3@x.test", { type: "resource" })])
    );
    expect(out.map((p) => p.address)).toEqual(["a@x.test"]);
  });

  // Graph generally does NOT repeat the organizer in attendees, but it may.
  // The union-and-dedupe rule is correct either way.
  it("counts an organizer who also appears in attendees once, keeping the organizer flag", () => {
    const out = participantsOf(
      event([
        participant("Host@x.test", { isOrganizer: true, name: "Host" }),
        participant("host@x.test"),
      ])
    );
    expect(out).toHaveLength(1);
    expect(out[0].isOrganizer).toBe(true);
  });

  it("dedupes duplicate addresses on one event", () => {
    const out = participantsOf(event([participant("a@x.test"), participant("A@X.test")]));
    expect(out).toHaveLength(1);
  });
});

describe("matchAttendees", () => {
  const own = "me@corp.test";

  it("matches on normalized email", () => {
    const result = matchAttendees({
      participants: [participant(" CFO@Acme.Example ")],
      contacts: [contact(7, "cfo@acme.example")],
      ownAddress: own,
    });
    expect(result.matched.map((m) => m.contact.id)).toEqual([7]);
    expect(result.unmatched).toHaveLength(0);
  });

  it("excludes the signed-in user's own address", () => {
    const result = matchAttendees({
      participants: [participant("ME@corp.test"), participant("cfo@acme.example")],
      contacts: [contact(7, "cfo@acme.example"), contact(8, "me@corp.test")],
      ownAddress: own,
    });
    expect(result.excluded.map((e) => e.reason)).toEqual(["self"]);
    expect(result.matched.map((m) => m.contact.id)).toEqual([7]);
  });

  // The safe failure. Both claims are UPN-shaped and often differ from the
  // primary SMTP address; an extra visible row beats a silently dropped one.
  it("proposes the user's own row when the claim resolves to nothing", () => {
    const result = matchAttendees({
      participants: [participant("me@corp.test")],
      contacts: [contact(8, "me@corp.test")],
      ownAddress: null,
    });
    expect(result.excluded).toHaveLength(0);
    expect(result.matched.map((m) => m.contact.id)).toEqual([8]);
  });

  it("excludes colleagues entirely - not even a greyed row", () => {
    const result = matchAttendees({
      participants: [participant("mate@corp.test")],
      contacts: [contact(9, "mate@corp.test", { isColleague: true })],
      ownAddress: own,
    });
    expect(result.matched).toHaveLength(0);
    expect(result.unmatched).toHaveLength(0);
    expect(result.excluded.map((e) => e.reason)).toEqual(["colleague"]);
  });

  // listContacts runs a bare SELECT with no `active` filter
  // (odoo-contacts.action.ts:122), so archived partners ARE in the cache.
  it("treats an archived contact as unmatched, shown and labelled", () => {
    const result = matchAttendees({
      participants: [participant("old@acme.example")],
      contacts: [contact(10, "old@acme.example", { active: false })],
      ownAddress: own,
    });
    expect(result.matched).toHaveLength(0);
    expect(result.unmatched.map((u) => u.reason)).toEqual(["archived"]);
  });

  it("retains an unmatched attendee rather than dropping it", () => {
    const result = matchAttendees({
      participants: [participant("nobody@acme.example")],
      contacts: [],
      ownAddress: own,
    });
    expect(result.unmatched.map((u) => u.reason)).toEqual(["no-contact"]);
  });

  it("returns three empty buckets for no participants", () => {
    const result = matchAttendees({ participants: [], contacts: [], ownAddress: own });
    expect(result).toEqual({ matched: [], unmatched: [], excluded: [] });
  });

  // A cache row with a null or blank email must never match a blank address.
  it("never matches on a null or blank contact email", () => {
    const result = matchAttendees({
      participants: [participant("  ")],
      contacts: [contact(11, null), contact(12, "   ")],
      ownAddress: own,
    });
    expect(result.matched).toHaveLength(0);
  });

  /**
   * Two cached contacts sharing an email is ROUTINE in Odoo - a person and
   * their company, or the same person under two parents. `listContacts` runs a
   * bare `SELECT * FROM odoo_contacts WHERE instance = ?` with no ORDER BY
   * (odoo-contacts.action.ts:122), so "whichever row came back first" is not a
   * rule, it is whatever SQLite happened to return.
   *
   * The user sees only a NAME on the proposal row, so if the wrong record wins
   * the substitution is invisible at confirm time - and the confirm button is
   * the whole safety gate. Deterministic beats arbitrary even when both are
   * imperfect.
   */
  it("breaks a duplicate-email tie deterministically, whatever the cache order", () => {
    const person = contact(20, "shared@acme.example", { name: "Zoe Person" });
    const company = contact(21, "shared@acme.example", {
      name: "Acme Ltd",
      isCompany: true,
    });
    const forwards = matchAttendees({
      participants: [participant("shared@acme.example")],
      contacts: [company, person],
      ownAddress: own,
    });
    const backwards = matchAttendees({
      participants: [participant("shared@acme.example")],
      contacts: [person, company],
      ownAddress: own,
    });
    // Same winner both ways round, and it is the PERSON, not the company.
    expect(forwards.matched[0].contact.id).toBe(20);
    expect(backwards.matched[0].contact.id).toBe(20);
  });

  it("breaks a person-vs-person duplicate by lowest id", () => {
    const result = matchAttendees({
      participants: [participant("shared@acme.example")],
      contacts: [
        contact(31, "shared@acme.example", { name: "Bee" }),
        contact(30, "shared@acme.example", { name: "Ay" }),
      ],
      ownAddress: own,
    });
    expect(result.matched[0].contact.id).toBe(30);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/tests/match-attendees.test.ts`
Expected: FAIL — `Failed to resolve import "@/lib/calendar/match-attendees"`.

- [ ] **Step 3: Write the implementation**

`src/lib/calendar/match-attendees.ts`:

```typescript
import type {
  AttendeeMatch,
  CalendarEvent,
  CalendarParticipant,
  ExcludedAttendee,
  MatchResult,
  OdooContact,
  UnmatchedAttendee,
} from "@/types";

/** Exact match on normalized email: trim and lowercase BOTH sides. */
export function normalizeAddress(address: string): string {
  return address.trim().toLowerCase();
}

/**
 * The organizer-plus-attendees union every rule in this feature operates on.
 *
 * Two jobs, in this order:
 *
 * 1. Rooms and equipment are dropped. Graph puts them in the same
 *    `attendees[]` array, distinguished only by `type: "resource"`. Keeping
 *    them breaks two things at once: a booked room defeats the solo/focus
 *    block filter in current-meeting.ts (user + room = two participants), and
 *    every room-booked meeting renders a permanent greyed "Conf Room 3 - no
 *    Odoo contact" row no user can ever resolve.
 * 2. Dedupe by normalized address, organizer winning. Graph generally does
 *    not repeat the organizer inside `attendees`, but the union is correct
 *    either way and a duplicate would otherwise be proposed twice.
 */
export function participantsOf(event: CalendarEvent): CalendarParticipant[] {
  const byAddress = new Map<string, CalendarParticipant>();
  for (const participant of event.participants) {
    if (participant.type === "resource") continue;
    const key = normalizeAddress(participant.address);
    if (key === "") continue;
    const existing = byAddress.get(key);
    if (existing === undefined) {
      byAddress.set(key, participant);
    } else if (participant.isOrganizer && !existing.isOrganizer) {
      // The organizer entry carries the flag the matcher and the UI read.
      byAddress.set(key, participant);
    }
  }
  return [...byAddress.values()];
}

/**
 * Which of two contacts sharing one email wins.
 *
 * `listContacts` has no ORDER BY (odoo-contacts.action.ts:122), so without an
 * explicit rule the winner is whatever SQLite returned first - and the proposal
 * row shows only a name, so picking the wrong partner record is invisible at
 * the confirm gate. Deterministic beats arbitrary even when both are imperfect.
 *
 * A PERSON beats a company: an email shared between the two is almost always
 * the individual's, and a meeting note belongs on the person. Then lowest id,
 * which is stable across syncs in a way `name` is not.
 */
function preferForDuplicateEmail(a: OdooContact, b: OdooContact): OdooContact {
  if (a.isCompany !== b.isCompany) return a.isCompany ? b : a;
  return a.id <= b.id ? a : b;
}

export function matchAttendees({
  participants,
  contacts,
  ownAddress,
}: {
  participants: CalendarParticipant[];
  contacts: OdooContact[];
  ownAddress: string | null;
}): MatchResult {
  const byEmail = new Map<string, OdooContact>();
  for (const contact of contacts) {
    if (contact.email === null) continue;
    const key = normalizeAddress(contact.email);
    if (key === "") continue;
    const existing = byEmail.get(key);
    byEmail.set(key, existing === undefined ? contact : preferForDuplicateEmail(existing, contact));
  }

  // null when neither claim was present. Normalizing null to "" would make the
  // blank-address guard below silently exclude somebody.
  const own = ownAddress === null ? null : normalizeAddress(ownAddress);

  const result: MatchResult = { matched: [], unmatched: [], excluded: [] };
  for (const participant of participants) {
    const key = normalizeAddress(participant.address);
    if (own !== null && key === own) {
      result.excluded.push({ participant, reason: "self" });
      continue;
    }
    const contact = key === "" ? undefined : byEmail.get(key);
    if (contact === undefined) {
      result.unmatched.push({ participant, reason: "no-contact" });
      continue;
    }
    if (contact.isColleague) {
      // Logging a meeting onto a coworker's partner record is noise. No greyed
      // row either - the user can still add a colleague by hand.
      result.excluded.push({ participant, reason: "colleague" });
      continue;
    }
    if (!contact.active) {
      result.unmatched.push({ participant, reason: "archived" });
      continue;
    }
    result.matched.push({ participant, contact });
  }
  return result;
}
```

Add `export * from "./match-attendees";` to `src/lib/calendar/index.ts`.

- [ ] **Step 4: Run tests, lint and types**

Run: `npx vitest run src/tests/match-attendees.test.ts && npm run type-check && npm run lint`
Expected: PASS.

Barrel collision check, same as Task 3 — `src/lib/index.ts` is a flat `export *`, so a duplicate name across `./calendar` and `./odoo` is a build error:

```bash
grep -rn "normalizeAddress\|participantsOf\|matchAttendees" src/lib src/types --include=*.ts | grep -v "src/lib/calendar"
```
Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add src/lib/calendar/match-attendees.ts src/lib/calendar/index.ts src/tests/match-attendees.test.ts
git commit -m "feat(calendar): match attendees to cached Odoo contacts by email"
```

### Task 5: `current-meeting.ts` — which meeting is happening now

**Files:**
- Create: `src/lib/calendar/current-meeting.ts`
- Modify: `src/lib/calendar/index.ts`
- Test: `src/tests/current-meeting.test.ts`

**Interfaces:**
- Consumes: `CalendarEvent`, `CurrentMeeting` (both from `@/types`, Task 3), `participantsOf` (Task 4).
- Produces: `EARLY_JOIN_MS`, `ENDED_GRACE_MS`, `pickCurrentMeeting(events: CalendarEvent[], nowMs: number): CurrentMeeting`. The `CurrentMeeting` union itself is declared in `src/types/calendar.ts`, not here. Task 13 consumes it.

- [ ] **Step 1: Write the failing test**

`src/tests/current-meeting.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { pickCurrentMeeting } from "@/lib/calendar/current-meeting";
import type { CalendarEvent, CalendarParticipant } from "@/types";

const NOW = Date.UTC(2026, 8, 2, 14, 0, 0); // 2026-09-02T14:00:00Z
const MIN = 60_000;

function participant(
  address: string,
  over: Partial<CalendarParticipant> = {}
): CalendarParticipant {
  return { address, name: null, type: "required", isOrganizer: false, ...over };
}

function event(over: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: "e1",
    subject: "Client sync",
    startMs: NOW - 5 * MIN,
    endMs: NOW + 25 * MIN,
    isCancelled: false,
    isAllDay: false,
    ownResponse: "accepted",
    participants: [
      participant("me@corp.test", { isOrganizer: true }),
      participant("cfo@acme.example"),
    ],
    ...over,
  };
}

describe("pickCurrentMeeting", () => {
  it("returns none for an empty calendar", () => {
    expect(pickCurrentMeeting([], NOW)).toEqual({ kind: "none" });
  });

  it("returns the single live meeting", () => {
    const result = pickCurrentMeeting([event()], NOW);
    expect(result).toEqual({ kind: "one", event: expect.objectContaining({ id: "e1" }) });
  });

  it.each([
    ["cancelled", { isCancelled: true }],
    ["all-day", { isAllDay: true }],
    ["declined", { ownResponse: "declined" }],
  ])("rejects a %s event", (_label, over) => {
    expect(pickCurrentMeeting([event(over)], NOW)).toEqual({ kind: "none" });
  });

  // Focus blocks and reminders. This filter alone collapses most apparent
  // overlaps.
  it("rejects an event whose only participant is the user", () => {
    const solo = event({
      participants: [participant("me@corp.test", { isOrganizer: true })],
    });
    expect(pickCurrentMeeting([solo], NOW)).toEqual({ kind: "none" });
  });

  // The room is not a participant: without the resource drop, user + room = 2
  // and the focus block survives as a candidate.
  it("still rejects a focus block that has a room resource attached", () => {
    const solo = event({
      participants: [
        participant("me@corp.test", { isOrganizer: true }),
        participant("room3@corp.test", { type: "resource" }),
      ],
    });
    expect(pickCurrentMeeting([solo], NOW)).toEqual({ kind: "none" });
  });

  // The issue's opening scenario. The CLIENT organized, so `attendees` is just
  // the user - a naive rule discards this as a focus block.
  it("keeps a client-organized 1:1 where the only attendee is the user", () => {
    const clientCall = event({
      participants: [
        participant("cfo@acme.example", { isOrganizer: true }),
        participant("me@corp.test"),
      ],
    });
    expect(pickCurrentMeeting([clientCall], NOW)).toMatchObject({ kind: "one" });
  });

  describe("acceptance window", () => {
    it("accepts a meeting starting inside the 5-minute early-join window", () => {
      const soon = event({ startMs: NOW + 4 * MIN, endMs: NOW + 34 * MIN });
      expect(pickCurrentMeeting([soon], NOW)).toMatchObject({ kind: "one" });
    });

    it("rejects a meeting starting beyond the early-join window", () => {
      const later = event({ startMs: NOW + 6 * MIN, endMs: NOW + 36 * MIN });
      expect(pickCurrentMeeting([later], NOW)).toEqual({ kind: "none" });
    });

    it("accepts a meeting that ended inside the 10-minute grace", () => {
      const justEnded = event({ startMs: NOW - 40 * MIN, endMs: NOW - 9 * MIN });
      expect(pickCurrentMeeting([justEnded], NOW)).toMatchObject({ kind: "one" });
    });

    it("rejects a meeting that ended outside the grace", () => {
      const over = event({ startMs: NOW - 60 * MIN, endMs: NOW - 11 * MIN });
      expect(pickCurrentMeeting([over], NOW)).toEqual({ kind: "none" });
    });

    // The window is anchored on `now`, not on when recording started, so
    // joining late needs no special handling.
    it("accepts a long meeting joined late", () => {
      const joinedLate = event({ startMs: NOW - 50 * MIN, endMs: NOW + 10 * MIN });
      expect(pickCurrentMeeting([joinedLate], NOW)).toMatchObject({ kind: "one" });
    });
  });

  it("returns every survivor when more than one qualifies", () => {
    const a = event({ id: "a" });
    const b = event({ id: "b", subject: "Other", startMs: NOW, endMs: NOW + 30 * MIN });
    const result = pickCurrentMeeting([a, b], NOW);
    expect(result.kind).toBe("several");
    if (result.kind === "several") {
      expect(result.candidates.map((c) => c.id).sort()).toEqual(["a", "b"]);
    }
  });

  // The whole reason Rust normalizes to epoch ms at the boundary. If a caller
  // ever regressed to `new Date(dateTime)` on an offset-bearing string, this
  // window arithmetic would shift by the local UTC offset. Feeding the same
  // instant expressed via a non-UTC offset must land identically.
  it("evaluates the window on epoch milliseconds, not a locally-parsed string", () => {
    const startMs = Date.parse("2026-09-02T16:55:00+03:00"); // == 13:55Z
    const endMs = Date.parse("2026-09-02T17:25:00+03:00"); // == 14:25Z
    const shifted = event({ startMs, endMs });
    expect(pickCurrentMeeting([shifted], NOW)).toMatchObject({ kind: "one" });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/tests/current-meeting.test.ts`
Expected: FAIL — `Failed to resolve import "@/lib/calendar/current-meeting"`.

- [ ] **Step 3: Write the implementation**

`src/lib/calendar/current-meeting.ts`:

```typescript
import type { CalendarEvent, CurrentMeeting } from "@/types";
import { participantsOf } from "./match-attendees";

/**
 * An event starting further out than this is not the meeting you are in, even
 * when the wider 15-minute query window returns it. Five minutes covers the
 * normal early join.
 */
export const EARLY_JOIN_MS = 5 * 60 * 1000;

/**
 * An event that ended within this still counts when nothing else is live.
 * Meetings run over, and users start logging after the fact.
 */
export const ENDED_GRACE_MS = 10 * 60 * 1000;

// `CurrentMeeting` is imported from @/types (see Task 3's placement note). The
// "several" case is deliberate: do NOT guess. The block renders one row per
// candidate, and picking one replaces it with that meeting's proposal.

/**
 * `declined` is the ONLY response that rejects. `notResponded`, `none` and
 * `tentativelyAccepted` all survive: a tentative meeting the user is sitting
 * in is still the meeting they are in.
 */
function isDeclined(event: CalendarEvent): boolean {
  return event.ownResponse.toLowerCase() === "declined";
}

function isCandidate(event: CalendarEvent, nowMs: number): boolean {
  if (event.isCancelled) return false;
  if (event.isAllDay) return false;
  if (isDeclined(event)) return false;
  // Organizer INCLUDED, resources EXCLUDED - both handled by participantsOf.
  // A solo entry is a focus block or a reminder, not a meeting.
  if (participantsOf(event).length < 2) return false;
  if (event.startMs > nowMs + EARLY_JOIN_MS) return false;
  if (event.endMs < nowMs - ENDED_GRACE_MS) return false;
  return true;
}

export function pickCurrentMeeting(
  events: CalendarEvent[],
  nowMs: number
): CurrentMeeting {
  const candidates = events.filter((event) => isCandidate(event, nowMs));
  if (candidates.length === 0) return { kind: "none" };
  if (candidates.length === 1) return { kind: "one", event: candidates[0] };
  // Soonest-starting first, so the candidate list reads in the order the user
  // would scan it. Ties broken by id for a stable render.
  const ordered = [...candidates].sort(
    (a, b) => a.startMs - b.startMs || a.id.localeCompare(b.id)
  );
  return { kind: "several", candidates: ordered };
}
```

Add `export * from "./current-meeting";` to `src/lib/calendar/index.ts`.

- [ ] **Step 4: Run tests, lint and types**

Run: `npx vitest run src/tests/current-meeting.test.ts src/tests/match-attendees.test.ts && npm run type-check && npm run lint`
Expected: PASS.

Barrel collision check:

```bash
grep -rn "pickCurrentMeeting\|EARLY_JOIN_MS\|ENDED_GRACE_MS" src/lib src/types --include=*.ts | grep -v "src/lib/calendar"
```
Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add src/lib/calendar/current-meeting.ts src/lib/calendar/index.ts src/tests/current-meeting.test.ts
git commit -m "feat(calendar): pick the meeting happening now from a calendar view"
```

---

## Slice 2 — Rust: credentials and IO

Everything here is gated on **Task 1** (Probe 2). **Task 9** is additionally gated on **Task 2** (Probe 1), because Task 9 is where `GRAPH_SCOPES` is written — Task 10 consumes the constant but never sets it. Getting this gate wrong is not bookkeeping: an executor following the stated gates would hardcode `Calendars.ReadBasic` before the probe has run, which is exactly the outcome Probe 1 exists to prevent (a meeting the user *declined* proposing its attendees, because `responseStatus` was silently absent).

Every command returns `Result<T, String>` where the `Err` value is a **bare `GRAPH_*` code** and nothing else — `toGraphError` (Task 3) maps it back, and dropping the text is what keeps subjects and addresses out of the report.

### Task 6: Cargo dependencies, module skeleton, and the IPC-shape test

**Files:**
- Modify: `src-tauri/Cargo.toml`, `src-tauri/src/lib.rs:2-8`
- Create: `src-tauri/src/graph/mod.rs`

**Interfaces:**
- Produces: `mod graph;` compiling, the serde structs `CalendarEvent`, `CalendarParticipant`, `GraphStatus`, `CurrentMeetings` that mirror `src/types/calendar.ts` exactly, and the cargo test that fails if any of them gains a credential field. Tasks 7–11 build inside this module.

- [ ] **Step 1: Write the failing test**

Create `src-tauri/src/graph/mod.rs` containing ONLY the test module for now:

```rust
//! Microsoft Graph: OAuth (auth code + PKCE), the keychain, and calendarView.
//!
//! All decision logic lives here as pure functions with no network dependency,
//! so it compiles and is unit-tested on every target - the same shape as
//! `meeting_detect`.

#[cfg(test)]
mod tests {
    use super::*;

    /// The executable form of the spec's central security invariant.
    ///
    /// Every struct an exposed command can return is serialized here and
    /// scanned for credential-shaped keys. A future edit that widens one of
    /// these to carry a token fails this test rather than shipping.
    #[test]
    fn no_exposed_command_return_type_serializes_a_credential() {
        const FORBIDDEN: &[&str] = &[
            "token",
            "access",
            "refresh",
            "secret",
            "credential",
            "verifier",
            "code",
            "assertion",
            "password",
        ];

        let payloads = vec![
            serde_json::to_string(&GraphStatus {
                connected: true,
                session_only: false,
            })
            .unwrap(),
            serde_json::to_string(&CurrentMeetings {
                own_address: Some("me@corp.test".into()),
                events: vec![CalendarEvent {
                    id: "e1".into(),
                    subject: Some("Sync".into()),
                    start_ms: 0,
                    end_ms: 0,
                    is_cancelled: false,
                    is_all_day: false,
                    own_response: "accepted".into(),
                    participants: vec![CalendarParticipant {
                        address: "cfo@acme.example".into(),
                        name: None,
                        r#type: "required".into(),
                        is_organizer: false,
                    }],
                }],
            })
            .unwrap(),
        ];

        for payload in payloads {
            // Keys only: a VALUE may legitimately contain one of these words
            // (a meeting subject is free text), a KEY may not.
            for key in serde_json::from_str::<serde_json::Value>(&payload)
                .unwrap()
                .to_string()
                .split('"')
                .filter(|s| !s.is_empty())
            {
                for needle in FORBIDDEN {
                    assert!(
                        !key.to_lowercase().contains(needle)
                            || !payload.contains(&format!("\"{key}\":")),
                        "exposed return type serializes a credential-shaped key: {key}"
                    );
                }
            }
        }
    }
}
```

Add `mod graph;` to `src-tauri/src/lib.rs` beside the other `mod` lines (`:2-8`).

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test --manifest-path src-tauri/Cargo.toml graph::`
Expected: FAIL to compile — `cannot find type GraphStatus in this scope`.

- [ ] **Step 3: Add the Cargo dependencies**

In `src-tauri/Cargo.toml`, under `[dependencies]`, after `reqwest`:

```toml
# Graph OAuth. `base64` (0.22) is already present above and covers the
# URL-safe encoding PKCE needs; `reqwest` covers the token and data calls.
sha2 = "0.10"           # PKCE S256 challenge
rand = "0.8"            # verifier, state, nonce - CSPRNG, never a counter
url = "2"               # authorize-URL construction and callback parsing
keyring = "3"           # refresh token at rest. SEE PROBE 2 (Task 1): drop
                        # this line if the probe found a Rust-side API on
                        # tauri-plugin-keychain, and implement keychain.rs
                        # against that instead.
```

There is deliberately **no** `oauth2` crate: the flow is four HTTP calls and two hashes, and pulling a framework in would put the token lifecycle inside someone else's state machine when the Global Constraints above specify it exactly. There is deliberately **no** `chrono`/`time`/`chrono-tz`: the query window arrives from TypeScript as ISO strings and the response parse is fixed-layout integer math (Task 10).

- [ ] **Step 4: Write the shared structs**

At the top of `src-tauri/src/graph/mod.rs`, above the test module:

```rust
use serde::{Deserialize, Serialize};

/// Mirrors `src/types/calendar.ts` exactly. `rename_all = "camelCase"` is what
/// makes `start_ms` arrive in the webview as `startMs`; the two files must be
/// changed together.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CalendarParticipant {
    pub address: String,
    pub name: Option<String>,
    /// "required" | "optional" | "resource". Kept as a string rather than an
    /// enum: an unknown value from Graph must not fail the whole response, and
    /// the only value any rule tests for is "resource".
    pub r#type: String,
    pub is_organizer: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CalendarEvent {
    pub id: String,
    pub subject: Option<String>,
    /// Epoch MILLISECONDS. See `parse_graph_utc` in calendar.rs for why the
    /// normalization happens here and not in the webview.
    pub start_ms: i64,
    pub end_ms: i64,
    pub is_cancelled: bool,
    pub is_all_day: bool,
    pub own_response: String,
    pub participants: Vec<CalendarParticipant>,
}

/// NO TOKEN FIELD, EVER - enforced by the test at the bottom of this file.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GraphStatus {
    pub connected: bool,
    pub session_only: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CurrentMeetings {
    pub own_address: Option<String>,
    pub events: Vec<CalendarEvent>,
}

/// Every failure this module can produce, as the bare string the webview's
/// `toGraphError` maps back to a code. No message text ever accompanies one:
/// a subject or address lifted from a raw reqwest or serde failure would
/// otherwise survive into the report.
pub const NOT_CONNECTED: &str = "GRAPH_NOT_CONNECTED";
pub const CONSENT_REQUIRED: &str = "GRAPH_CONSENT_REQUIRED";
pub const AUTH_CANCELLED: &str = "GRAPH_AUTH_CANCELLED";
pub const AUTH_EXPIRED: &str = "GRAPH_AUTH_EXPIRED";
pub const AUTH_REJECTED: &str = "GRAPH_AUTH_REJECTED";
pub const BAD_RESPONSE: &str = "GRAPH_BAD_RESPONSE";
pub const THROTTLED: &str = "GRAPH_THROTTLED";
pub const NETWORK: &str = "GRAPH_NETWORK";
pub const NO_KEYCHAIN: &str = "GRAPH_NO_KEYCHAIN";
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cargo test --manifest-path src-tauri/Cargo.toml graph::`
Expected: PASS (1 test).

- [ ] **Step 6: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/graph/mod.rs src-tauri/src/lib.rs
git commit -m "feat(graph): add the graph module skeleton and IPC shape guard"
```

### Task 7: PKCE, `state`, and `nonce`

**Files:**
- Create: `src-tauri/src/graph/auth.rs`
- Modify: `src-tauri/src/graph/mod.rs` (add `mod auth;`)

**Interfaces:**
- Consumes: the `GRAPH_*` constants from Task 6.
- Produces:
  - `pub struct Pkce { pub verifier: String, pub challenge: String }`
  - `pub fn new_pkce() -> Pkce`
  - `pub fn challenge_for(verifier: &str) -> String`
  - `pub fn random_token(bytes: usize) -> String` (used for `state` and `nonce`)
  - `pub fn validate_state(expected: &str, received: Option<&str>) -> Result<(), String>`
  - `pub fn nonce_from_id_token(id_token: &str) -> Option<String>`
  - `pub fn validate_nonce(expected: &str, id_token: Option<&str>) -> Result<(), String>` — an absent ID token is a rejection, not a skip
  - `pub fn own_address_from_id_token(id_token: &str) -> Option<String>`

  Tasks 8, 9 and 11 consume all of these.

- [ ] **Step 1: Write the failing tests**

Append to `src-tauri/src/graph/auth.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    /// RFC 7636 Appendix B's published vector. A hand-rolled S256 that base64s
    /// the HEX digest instead of the raw bytes still "looks right" and fails
    /// only against a real server - this vector is what catches it.
    #[test]
    fn pkce_challenge_matches_rfc7636_appendix_b() {
        let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        assert_eq!(
            challenge_for(verifier),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn pkce_verifier_is_url_safe_and_long_enough() {
        let pkce = new_pkce();
        assert!(pkce.verifier.len() >= 43 && pkce.verifier.len() <= 128);
        assert!(pkce
            .verifier
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "-._~".contains(c)));
        assert_eq!(pkce.challenge, challenge_for(&pkce.verifier));
    }

    #[test]
    fn random_tokens_do_not_repeat() {
        assert_ne!(random_token(32), random_token(32));
    }

    #[test]
    fn state_mismatch_is_rejected() {
        assert!(validate_state("abc", Some("abc")).is_ok());
        assert_eq!(validate_state("abc", Some("xyz")), Err(AUTH_REJECTED.to_string()));
        // A callback with no `state` at all is a mismatch, not a pass.
        assert_eq!(validate_state("abc", None), Err(AUTH_REJECTED.to_string()));
    }

    // Not a signature check - Entra's own transport is TLS and the token came
    // straight from the token endpoint. This reads the claim the flow binds.
    fn fake_id_token(claims: &str) -> String {
        use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
        format!("header.{}.sig", URL_SAFE_NO_PAD.encode(claims))
    }

    #[test]
    fn nonce_is_read_from_the_id_token() {
        let token = fake_id_token(r#"{"nonce":"n-123","preferred_username":"a@b.test"}"#);
        assert_eq!(nonce_from_id_token(&token), Some("n-123".to_string()));
    }

    /// The spec asks for "nonce validation in the returned ID token" — a
    /// REJECTION behaviour, not extraction. Extraction passing tells you
    /// nothing about whether a wrong nonce is refused.
    #[test]
    fn nonce_mismatch_is_rejected() {
        let good = fake_id_token(r#"{"nonce":"n-123"}"#);
        let wrong = fake_id_token(r#"{"nonce":"n-999"}"#);
        assert!(validate_nonce("n-123", Some(&good)).is_ok());
        assert_eq!(
            validate_nonce("n-123", Some(&wrong)),
            Err(AUTH_REJECTED.to_string())
        );
    }

    /// An ABSENT id_token, or one carrying no nonce claim, is a rejection - not
    /// a skip. The scopes ask for `openid profile` explicitly, so a response
    /// without an ID token is not what we requested, and an `if let Some(...)`
    /// guard around the comparison would accept it while binding nothing.
    #[test]
    fn a_missing_id_token_or_nonce_claim_is_rejected_not_skipped() {
        assert_eq!(validate_nonce("n-123", None), Err(AUTH_REJECTED.to_string()));
        let no_claim = fake_id_token(r#"{"sub":"x"}"#);
        assert_eq!(
            validate_nonce("n-123", Some(&no_claim)),
            Err(AUTH_REJECTED.to_string())
        );
        assert_eq!(
            validate_nonce("n-123", Some("not-a-jwt")),
            Err(AUTH_REJECTED.to_string())
        );
    }

    #[test]
    fn own_address_prefers_preferred_username() {
        let token =
            fake_id_token(r#"{"preferred_username":"k.morgan@corp.test","upn":"other@corp.test"}"#);
        assert_eq!(
            own_address_from_id_token(&token),
            Some("k.morgan@corp.test".to_string())
        );
    }

    #[test]
    fn own_address_falls_back_to_upn() {
        let token = fake_id_token(r#"{"upn":"k.morgan@corp.test"}"#);
        assert_eq!(
            own_address_from_id_token(&token),
            Some("k.morgan@corp.test".to_string())
        );
    }

    // The safe failure: match-attendees.ts proposes the user's own row rather
    // than dropping an attendee when this is None.
    #[test]
    fn own_address_is_none_when_neither_claim_is_present() {
        assert_eq!(own_address_from_id_token(&fake_id_token(r#"{"sub":"x"}"#)), None);
        assert_eq!(own_address_from_id_token("not-a-jwt"), None);
    }
}
```

- [ ] **Step 2: Run to verify they fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml graph::auth`
Expected: FAIL to compile — `cannot find function new_pkce`.

- [ ] **Step 3: Write the implementation**

At the top of `src-tauri/src/graph/auth.rs`:

```rust
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rand::RngCore;
use sha2::{Digest, Sha256};

use super::AUTH_REJECTED;

pub struct Pkce {
    pub verifier: String,
    pub challenge: String,
}

/// URL-safe base64 of 32 CSPRNG bytes: 43 characters, inside RFC 7636's
/// 43..128 range, and made only of unreserved characters so it needs no
/// further escaping in the token request body.
pub fn random_token(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    rand::thread_rng().fill_bytes(&mut buf);
    URL_SAFE_NO_PAD.encode(buf)
}

/// S256: base64url(SHA256(ASCII(verifier))) over the RAW DIGEST BYTES.
/// Encoding the hex digest instead is the classic silent break.
pub fn challenge_for(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

pub fn new_pkce() -> Pkce {
    let verifier = random_token(32);
    let challenge = challenge_for(&verifier);
    Pkce { verifier, challenge }
}

/// A mismatched or absent `state` is rejected BEFORE the code is redeemed -
/// nothing is sent to the token endpoint.
pub fn validate_state(expected: &str, received: Option<&str>) -> Result<(), String> {
    match received {
        Some(value) if value == expected => Ok(()),
        _ => Err(AUTH_REJECTED.to_string()),
    }
}

/// The ID token's payload segment, decoded. NOT a signature verification: the
/// token arrived over TLS directly from the token endpoint, so this reads
/// claims rather than establishing trust.
fn id_token_claims(id_token: &str) -> Option<serde_json::Value> {
    let payload = id_token.split('.').nth(1)?;
    let bytes = URL_SAFE_NO_PAD.decode(payload).ok()?;
    serde_json::from_slice(&bytes).ok()
}

pub fn nonce_from_id_token(id_token: &str) -> Option<String> {
    Some(id_token_claims(id_token)?.get("nonce")?.as_str()?.to_string())
}

/// The nonce check, as its OWN function for the same reason `validate_state` is
/// one: a comparison inlined in an async `#[tauri::command]` body cannot be unit
/// tested, and this is a security check.
///
/// **An ABSENT `id_token` is a rejection, not a skip.** The scopes request
/// `openid profile` explicitly, so a token response without an ID token means
/// something other than what we asked for came back - and the earlier inline
/// form, guarded by `if let Some(id_token)`, would have silently accepted it and
/// bound nothing.
pub fn validate_nonce(expected: &str, id_token: Option<&str>) -> Result<(), String> {
    match id_token.and_then(nonce_from_id_token) {
        Some(actual) if actual == expected => Ok(()),
        _ => Err(AUTH_REJECTED.to_string()),
    }
}

/// `preferred_username`, falling back to `upn`.
///
/// Best-effort BY DESIGN. `/me` would return the primary SMTP address - the
/// exact string in `attendees[]` - but that needs `User.Read`, and widening a
/// mailbox-adjacent grant to improve a cosmetic exclusion is a bad exchange
/// when the failure mode is one extra visible row.
pub fn own_address_from_id_token(id_token: &str) -> Option<String> {
    let claims = id_token_claims(id_token)?;
    for key in ["preferred_username", "upn"] {
        if let Some(value) = claims.get(key).and_then(|v| v.as_str()) {
            if !value.trim().is_empty() {
                return Some(value.to_string());
            }
        }
    }
    None
}
```

Add `mod auth;` to `src-tauri/src/graph/mod.rs`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml graph::`
Expected: PASS (11 tests).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/graph/auth.rs src-tauri/src/graph/mod.rs
git commit -m "feat(graph): add PKCE, state and nonce primitives"
```

### Task 8: The single-use loopback listener

**Files:**
- Modify: `src-tauri/src/graph/auth.rs`

**Interfaces:**
- Consumes: `validate_state` (Task 7), the `GRAPH_*` constants (Task 6).
- Produces:
  - `pub struct Callback { pub code: Option<String>, pub state: Option<String>, pub error: Option<String> }`
  - `pub fn parse_callback(request_line: &str) -> Callback`
  - `pub fn classify_callback_error(error: &str) -> &'static str`
  - `pub fn listen_once(timeout: Duration) -> Result<(u16, Receiver<Result<Callback, String>>), String>` — binds first so the port is known before the browser opens
  - `pub const LISTENER_TIMEOUT: Duration`

  Task 9 consumes them.

**Why a hand-rolled `TcpListener` and no HTTP crate:** the listener answers exactly one request and needs only the request line. Adding a server framework for that would be a dependency whose surface dwarfs the 40 lines it replaces, and the parsing this way is a pure function with its own tests.

- [ ] **Step 1: Write the failing tests**

Append to `auth.rs`'s `mod tests`:

```rust
    #[test]
    fn parses_the_success_callback() {
        let cb = parse_callback("GET /?code=abc123&state=xyz HTTP/1.1");
        assert_eq!(cb.code.as_deref(), Some("abc123"));
        assert_eq!(cb.state.as_deref(), Some("xyz"));
        assert!(cb.error.is_none());
    }

    #[test]
    fn parses_percent_encoded_values() {
        let cb = parse_callback("GET /?code=a%2Bb%2Fc&state=x%20y HTTP/1.1");
        assert_eq!(cb.code.as_deref(), Some("a+b/c"));
        assert_eq!(cb.state.as_deref(), Some("x y"));
    }

    #[test]
    fn parses_the_error_callback_form() {
        let cb = parse_callback("GET /?error=access_denied&error_description=User+cancelled HTTP/1.1");
        assert_eq!(cb.error.as_deref(), Some("access_denied"));
        assert!(cb.code.is_none());
    }

    #[test]
    fn a_malformed_request_line_yields_an_empty_callback() {
        let cb = parse_callback("garbage");
        assert!(cb.code.is_none() && cb.state.is_none() && cb.error.is_none());
    }

    // The commonest outcome of a loopback flow is not a failure and must not
    // be dressed as one.
    #[test]
    fn cancellation_forms_map_to_auth_cancelled() {
        assert_eq!(classify_callback_error("access_denied"), AUTH_CANCELLED);
        assert_eq!(classify_callback_error("consent_required"), CONSENT_REQUIRED);
        assert_eq!(classify_callback_error("interaction_required"), CONSENT_REQUIRED);
        assert_eq!(classify_callback_error("something_else"), AUTH_REJECTED);
    }

    #[test]
    fn listener_binds_loopback_only_and_reports_its_port() {
        let (port, _rx) = listen_once(Duration::from_millis(200)).unwrap();
        assert!(port > 0);
    }

    /// Single-use: the accept loop runs exactly once, so a SECOND connection to
    /// the same port after the first was consumed is never redeemed.
    #[test]
    fn a_second_callback_to_a_consumed_listener_is_not_redeemed() {
        use std::io::Write;
        use std::net::TcpStream;

        let (port, rx) = listen_once(Duration::from_secs(5)).unwrap();
        let mut first = TcpStream::connect(("127.0.0.1", port)).unwrap();
        first
            .write_all(b"GET /?code=first&state=s HTTP/1.1\r\n\r\n")
            .unwrap();
        let received = rx.recv_timeout(Duration::from_secs(5)).unwrap().unwrap();
        assert_eq!(received.code.as_deref(), Some("first"));

        // The listener is dropped after one accept, so this either refuses or
        // connects to nothing that will ever deliver a second Callback.
        if let Ok(mut second) = TcpStream::connect(("127.0.0.1", port)) {
            let _ = second.write_all(b"GET /?code=second&state=s HTTP/1.1\r\n\r\n");
        }
        assert!(rx.recv_timeout(Duration::from_millis(300)).is_err());
    }

    #[test]
    fn the_listener_times_out_rather_than_waiting_forever() {
        let (_port, rx) = listen_once(Duration::from_millis(150)).unwrap();
        let outcome = rx.recv_timeout(Duration::from_secs(2)).unwrap();
        assert_eq!(outcome, Err(AUTH_CANCELLED.to_string()));
    }

    /// The spec's third listener case: "a second callback to a consumed OR
    /// STALE listener is rejected, not redeemed."
    ///
    /// This is the one that fails against a watchdog which only messages the
    /// channel. Sending `Err(AUTH_CANCELLED)` does not unblock `accept`, so
    /// without the self-connect the thread stays parked, the port stays bound,
    /// and a late callback is still accepted and parsed - the listener has
    /// "timed out" only from the receiver's point of view.
    #[test]
    fn a_callback_arriving_after_the_timeout_is_not_redeemed() {
        use std::io::Write;
        use std::net::TcpStream;

        let (port, rx) = listen_once(Duration::from_millis(150)).unwrap();
        assert_eq!(
            rx.recv_timeout(Duration::from_secs(2)).unwrap(),
            Err(AUTH_CANCELLED.to_string())
        );

        // Give the watchdog's self-connect time to wake `accept` and drop the
        // listener, then try to deliver a code to the dead port.
        std::thread::sleep(Duration::from_millis(200));
        if let Ok(mut late) = TcpStream::connect(("127.0.0.1", port)) {
            let _ = late.write_all(b"GET /?code=late&state=s HTTP/1.1\r\n\r\n");
        }
        // Nothing carrying a code may ever arrive.
        while let Ok(outcome) = rx.recv_timeout(Duration::from_millis(300)) {
            assert!(
                !matches!(&outcome, Ok(cb) if cb.code.is_some()),
                "a callback arriving after the timeout was redeemed"
            );
        }
    }
```

Add to the test module's imports: `use std::time::Duration;` and extend the `use super::*;` already there to cover `AUTH_CANCELLED`, `CONSENT_REQUIRED`.

- [ ] **Step 2: Run to verify they fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml graph::auth`
Expected: FAIL to compile — `cannot find function parse_callback`.

- [ ] **Step 3: Write the implementation**

Append to `auth.rs`:

```rust
use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::sync::mpsc::{self, Receiver};
use std::time::Duration;

use super::{AUTH_CANCELLED, CONSENT_REQUIRED};

/// Long enough for a real consent screen with an MFA prompt, short enough that
/// an abandoned flow does not leave a socket open all session.
pub const LISTENER_TIMEOUT: Duration = Duration::from_secs(300);

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Callback {
    pub code: Option<String>,
    pub state: Option<String>,
    pub error: Option<String>,
}

fn percent_decode(value: &str) -> String {
    let bytes = value.replace('+', " ").into_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(byte) = u8::from_str_radix(
                std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or(""),
                16,
            ) {
                out.push(byte);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Parses `GET /?code=...&state=... HTTP/1.1` - the only line of the request
/// this listener reads. Anything it cannot parse yields an empty Callback,
/// which the caller treats as a rejected redemption rather than a success.
pub fn parse_callback(request_line: &str) -> Callback {
    let mut callback = Callback::default();
    let Some(target) = request_line.split_whitespace().nth(1) else {
        return callback;
    };
    let Some((_, query)) = target.split_once('?') else {
        return callback;
    };
    for pair in query.split('&') {
        let Some((key, value)) = pair.split_once('=') else {
            continue;
        };
        let decoded = percent_decode(value);
        match key {
            "code" => callback.code = Some(decoded),
            "state" => callback.state = Some(decoded),
            "error" => callback.error = Some(decoded),
            _ => {}
        }
    }
    callback
}

/// `access_denied` is the user clicking Cancel. It is the COMMONEST outcome of
/// this flow and it is not a failure.
pub fn classify_callback_error(error: &str) -> &'static str {
    match error {
        "access_denied" => AUTH_CANCELLED,
        "consent_required" | "interaction_required" | "admin_consent_required" => CONSENT_REQUIRED,
        _ => AUTH_REJECTED,
    }
}

/// Binds a single-use loopback listener and returns its port immediately, so
/// the authorize URL can be built with the real redirect before the browser
/// opens.
///
/// LITERAL `127.0.0.1`, never `localhost` (which can resolve to `::1` or, in a
/// poisoned hosts file, off-box) and never `0.0.0.0` (which would accept from
/// the network). Port 0 asks the OS for a random ephemeral port, chosen per
/// attempt.
///
/// The accept loop runs EXACTLY ONCE. A second callback to a consumed listener
/// finds nothing listening - that is the single-use property, and it is why
/// the listener is moved into the thread rather than borrowed.
pub fn listen_once(timeout: Duration) -> Result<(u16, Receiver<Result<Callback, String>>), String> {
    let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|_| NETWORK.to_string())?;
    let port = listener.local_addr().map_err(|_| NETWORK.to_string())?.port();
    listener
        .set_nonblocking(false)
        .map_err(|_| NETWORK.to_string())?;

    let (tx, rx) = mpsc::channel();
    let timeout_tx = tx.clone();

    std::thread::spawn(move || {
        // A watchdog rather than a socket read timeout: `accept` has no
        // per-call timeout on a blocking listener, and an abandoned flow must
        // not hold the thread for the life of the process.
        //
        // The self-connect on the last line is the whole point. Sending the
        // timeout into the channel does NOT unblock `accept`, so a watchdog
        // that only sent would leave this thread parked and the loopback port
        // bound until the process exits - one leaked thread and one leaked
        // port per abandoned connect attempt. Dialling our own port wakes
        // `accept`, which lets the thread finish and DROP the listener, which
        // is also what makes the port genuinely stop listening after a timeout
        // rather than merely stop being read.
        std::thread::spawn(move || {
            std::thread::sleep(timeout);
            let _ = timeout_tx.send(Err(AUTH_CANCELLED.to_string()));
            let _ = std::net::TcpStream::connect(("127.0.0.1", port));
        });

        match listener.accept() {
            Ok((stream, _)) => {
                let mut reader = BufReader::new(&stream);
                let mut request_line = String::new();
                let outcome = match reader.read_line(&mut request_line) {
                    Ok(_) => Ok(parse_callback(&request_line)),
                    Err(_) => Err(NETWORK.to_string()),
                };
                // A static page that NEVER echoes the code back into the
                // browser's history, title or DOM.
                let body = "<!doctype html><meta charset=utf-8><title>Meetwings</title>\
                            <p>You can close this tab and return to Meetwings.";
                let mut stream = stream;
                let _ = write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                let _ = stream.flush();
                let _ = tx.send(outcome);
            }
            Err(_) => {
                let _ = tx.send(Err(NETWORK.to_string()));
            }
        }
        // `listener` drops here. The port stops accepting: single-use.
    });

    Ok((port, rx))
}
```

Add `NETWORK` to the `use super::{...}` list at the top of the file.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml graph::`
Expected: PASS (20 tests).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/graph/auth.rs
git commit -m "feat(graph): add the single-use loopback callback listener"
```

### Task 9: Keychain, token exchange, refresh, and the lifecycle rules

**Files:**
- Create: `src-tauri/src/graph/keychain.rs`
- Modify: `src-tauri/src/graph/auth.rs`, `src-tauri/src/graph/mod.rs`

**Gated on Task 1 AND Task 2.** Probe 2's verdict decides only what the three functions in `keychain.rs` call; the rest of the task is identical either way. Probe 1 fixes the value of `GRAPH_SCOPES`, which is written *here* — so this task cannot start before Task 2 has recorded its verdict.

**Interfaces:**
- Consumes: Tasks 6, 7, 8.
- Produces:
  - `keychain::{store_refresh_token, load_refresh_token, delete_refresh_token} -> Result<_, String>`, and `keychain::available() -> bool` (a heuristic — Task 11 degrades on a persist failure rather than trusting it)
  - `pub struct Tokens { pub access_token: String, pub expires_at_ms: i64, pub refresh_token: Option<String>, pub id_token: Option<String> }`
  - `pub fn classify_token_error(status: u16, body: &str) -> &'static str`
  - `pub async fn exchange_code(...) -> Result<Tokens, String>`
  - `pub async fn refresh(...) -> Result<Tokens, String>`
  - `pub fn validate_authority(authority: &str) -> Result<url::Url, String>` — https-only, host required
  - `pub fn authorize_url(...) -> Result<String, String>` — a Result, never an `expect`: the authority is user-typed free text

  Tasks 10 and 11 consume them.

- [ ] **Step 1: Write the failing tests**

Append to `auth.rs`'s `mod tests`:

```rust
    // The three-way split is load-bearing, not bookkeeping. A test that only
    // asserted "auth failure clears the token" would lock in the exact defect
    // the spec corrected.
    #[test]
    fn only_invalid_grant_means_the_refresh_token_is_dead() {
        assert_eq!(
            classify_token_error(400, r#"{"error":"invalid_grant"}"#),
            AUTH_EXPIRED
        );
        assert_eq!(
            classify_token_error(400, r#"{"error":"consent_required"}"#),
            CONSENT_REQUIRED
        );
        assert_eq!(
            classify_token_error(400, r#"{"error":"invalid_client"}"#),
            AUTH_REJECTED
        );
        assert_eq!(classify_token_error(429, "{}"), THROTTLED);
        assert_eq!(classify_token_error(503, "{}"), NETWORK);
        // A body that is not JSON at all is unusable, not a dead credential.
        assert_eq!(classify_token_error(400, "<html>"), AUTH_REJECTED);
    }

    /// The authority is the host this module POSTs the auth code, the PKCE
    /// verifier and later the refresh token to. An unvalidated one is an
    /// arbitrary exfiltration target, and a plain-http one puts those values on
    /// the wire in clear - so anything that is not an absolute https URL with a
    /// host is rejected BEFORE a browser is ever opened.
    #[test]
    fn a_non_https_or_malformed_authority_is_rejected_not_panicked_on() {
        for bad in [
            "login.microsoftonline.com/organizations", // no scheme - the typo case
            "http://login.microsoftonline.com/organizations", // clear text
            "ftp://example.test",
            "https://",  // no host
            "",
            "not a url",
        ] {
            assert_eq!(
                validate_authority(bad),
                Err(AUTH_REJECTED.to_string()),
                "authority {bad:?} must be rejected"
            );
            assert!(
                authorize_url(bad, "client-1", 8123, "c", "s", "n").is_err(),
                "authorize_url must return Err, never panic, for {bad:?}"
            );
        }
    }

    #[test]
    fn authorize_url_carries_pkce_state_nonce_and_the_loopback_redirect() {
        let url = authorize_url(
            "https://login.microsoftonline.com/organizations",
            "client-1",
            8123,
            "challenge-x",
            "state-y",
            "nonce-z",
        )
        .expect("a well-formed https authority");
        assert!(url.starts_with(
            "https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize?"
        ));
        for expected in [
            "client_id=client-1",
            "response_type=code",
            "code_challenge=challenge-x",
            "code_challenge_method=S256",
            "state=state-y",
            "nonce=nonce-z",
            // Literal 127.0.0.1, percent-encoded in the query.
            "redirect_uri=http%3A%2F%2F127.0.0.1%3A8123",
            // openid and profile are requested EXPLICITLY - the own-address
            // exclusion depends on the ID token carrying a username claim.
            "openid",
            "profile",
            "offline_access",
        ] {
            assert!(url.contains(expected), "authorize URL is missing {expected}");
        }
        assert!(!url.contains("localhost"));
    }

    #[test]
    fn scopes_request_exactly_one_calendars_permission() {
        let calendars: Vec<&str> = GRAPH_SCOPES
            .split_whitespace()
            .filter(|s| s.contains("Calendars."))
            .collect();
        assert_eq!(calendars.len(), 1, "exactly one Calendars scope: {calendars:?}");
    }
```

- [ ] **Step 2: Run to verify they fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml graph::auth`
Expected: FAIL to compile — `cannot find function classify_token_error`.

- [ ] **Step 3: Write `keychain.rs`**

```rust
//! The refresh token at rest, and the ONLY place this feature touches disk.
//!
//! Isolated in its own file because Probe 2 (Task 1) decides what backs it:
//! `tauri-plugin-keychain`'s Rust API if it has one, the `keyring` crate
//! otherwise. Nothing else in the module changes with that answer.
//!
//! On Linux with no Secret Service running, `available()` is false and the
//! caller REFUSES TO PERSIST and re-authenticates each launch. A silent
//! plaintext fallback is not acceptable: src/lib/secure-storage.ts is
//! plaintext JSON on disk and says so in its own doc comment - that is the one
//! existing pattern this feature must not copy.

use super::NO_KEYCHAIN;

const SERVICE: &str = "com.meetwings.graph";
const ACCOUNT: &str = "refresh-token";

fn entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, ACCOUNT).map_err(|_| NO_KEYCHAIN.to_string())
}

/// Whether a keychain service is reachable at all. Probed by opening an entry
/// and reading it: on Linux with no Secret Service this fails at the D-Bus
/// connection, which is exactly the condition the refuse-to-persist rule tests.
///
/// **This is a HEURISTIC and Task 11 must not trust it.** It decides by matching
/// error variants, and which variant a keychain-less platform actually produces
/// is a question Probe 2 records rather than one this code can know. Guessing
/// wrong here is expensive in the worst place: `available()` returns true, the
/// write then fails, and `graph_connect` errors AFTER `exchange_code` has already
/// burnt the authorization code - so a credential that was successfully obtained
/// is discarded and the user redoes the whole browser flow. Task 11 therefore
/// degrades to session-only on a persist FAILURE as well, and this function is
/// only the fast path.
///
/// `NoEntry` is success: it means the keychain answered, and answered "nothing
/// stored yet" - the normal state before a first connect.
pub fn available() -> bool {
    match entry() {
        Ok(e) => !matches!(
            e.get_password(),
            Err(keyring::Error::PlatformFailure(_)) | Err(keyring::Error::NoStorageAccess(_))
        ),
        Err(_) => false,
    }
}

pub fn store_refresh_token(token: &str) -> Result<(), String> {
    entry()?
        .set_password(token)
        .map_err(|_| NO_KEYCHAIN.to_string())
}

/// `Ok(None)` means "no entry", which is NOT an error - it is the normal state
/// before a first connect and after a disconnect.
pub fn load_refresh_token() -> Result<Option<String>, String> {
    match entry()?.get_password() {
        Ok(token) => Ok(Some(token)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err(NO_KEYCHAIN.to_string()),
    }
}

pub fn delete_refresh_token() -> Result<(), String> {
    match entry()?.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        // NO_KEYCHAIN, matching store/load above. This is a keychain-access
        // failure and calling it NETWORK would send the user chasing their
        // connection over a problem that has nothing to do with the network.
        Err(_) => Err(NO_KEYCHAIN.to_string()),
    }
}
```

Add `mod keychain;` to `src-tauri/src/graph/mod.rs`.

**If Probe 2 found a Rust API:** replace the four function bodies with calls to it and drop `keyring` from `Cargo.toml`. The signatures, the `Ok(None)`-for-absent contract, and the `available()` semantics do not change.

- [ ] **Step 4: Write the token half of `auth.rs`**

```rust
/// SEE PROBE 1 (Task 2). ReadBasic additionally withholds the meeting body -
/// text this feature never needs and would rather not hold - so it is the
/// default. If the probe found any filter property absent under ReadBasic,
/// this becomes `Calendars.Read` and nothing else changes.
pub const GRAPH_SCOPES: &str =
    "openid profile offline_access https://graph.microsoft.com/Calendars.ReadBasic";

pub struct Tokens {
    pub access_token: String,
    pub expires_at_ms: i64,
    /// Entra ROTATES the refresh token on every redemption. `None` means the
    /// response carried none and the caller keeps the one it has.
    pub refresh_token: Option<String>,
    pub id_token: Option<String>,
}

/// The authority is FREE TEXT the user typed on the `/odoo` page, and it is the
/// host this module sends credentials to: `post_token` POSTs the authorization
/// code, the PKCE verifier and later the refresh token to
/// `{authority}/oauth2/v2.0/token`. An unvalidated authority is therefore not a
/// cosmetic problem — it is an arbitrary exfiltration target, and a plain `http`
/// one puts those values on the wire in clear.
///
/// So: parse it, require `https`, and reject anything else. The previous draft
/// used `.expect("authority is validated before this point")` when nothing
/// validated it anywhere — a typo would have PANICKED the Rust side mid-connect,
/// bypassing the whole GRAPH_*/redaction path this feature is built on.
///
/// Returning `Result` rather than validating only in the TypeScript layer is
/// deliberate: this is the last point before credentials move, and a check that
/// lives only on the caller's side is one refactor away from being skipped.
pub fn validate_authority(authority: &str) -> Result<url::Url, String> {
    let parsed = url::Url::parse(authority.trim_end_matches('/')).map_err(|_| AUTH_REJECTED.to_string())?;
    if parsed.scheme() != "https" {
        return Err(AUTH_REJECTED.to_string());
    }
    if !parsed.has_host() {
        return Err(AUTH_REJECTED.to_string());
    }
    Ok(parsed)
}

pub fn authorize_url(
    authority: &str,
    client_id: &str,
    port: u16,
    challenge: &str,
    state: &str,
    nonce: &str,
) -> Result<String, String> {
    let redirect = format!("http://127.0.0.1:{port}");
    let base = validate_authority(authority)?;
    let mut url = url::Url::parse(&format!("{}/oauth2/v2.0/authorize", base.as_str().trim_end_matches('/')))
        .map_err(|_| AUTH_REJECTED.to_string())?;
    url.query_pairs_mut()
        .append_pair("client_id", client_id)
        .append_pair("response_type", "code")
        .append_pair("redirect_uri", &redirect)
        .append_pair("response_mode", "query")
        .append_pair("scope", GRAPH_SCOPES)
        .append_pair("code_challenge", challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("state", state)
        .append_pair("nonce", nonce);
    Ok(url.to_string())
}

/// ONLY `invalid_grant` proves the refresh token is dead (revoked, expired,
/// password changed). Everything else RETAINS it: destroying a working ~90-day
/// credential over a transport blip can need an administrator to undo, in a
/// consent-blocked tenant.
pub fn classify_token_error(status: u16, body: &str) -> &'static str {
    if status == 429 {
        return THROTTLED;
    }
    if status >= 500 {
        return NETWORK;
    }
    let Ok(json) = serde_json::from_str::<serde_json::Value>(body) else {
        return AUTH_REJECTED;
    };
    match json.get("error").and_then(|v| v.as_str()) {
        Some("invalid_grant") => AUTH_EXPIRED,
        Some("consent_required") | Some("interaction_required")
        | Some("admin_consent_required") => CONSENT_REQUIRED,
        _ => AUTH_REJECTED,
    }
}

async fn post_token(
    authority: &str,
    form: &[(&str, &str)],
    now_ms: i64,
) -> Result<Tokens, String> {
    // Validated HERE too, not only in authorize_url. This is the call that
    // actually carries the authorization code, the PKCE verifier and the
    // refresh token, so it does its own check rather than trusting that some
    // earlier caller did one.
    let base = validate_authority(authority)?;
    let endpoint = format!("{}/oauth2/v2.0/token", base.as_str().trim_end_matches('/'));
    // A transport failure is NETWORK, never AUTH_EXPIRED. This mapping is the
    // one that decides whether a working credential survives a flaky café
    // wifi.
    let response = reqwest::Client::new()
        .post(&endpoint)
        .form(form)
        .send()
        .await
        .map_err(|_| NETWORK.to_string())?;
    let status = response.status().as_u16();
    let body = response.text().await.map_err(|_| NETWORK.to_string())?;
    if status != 200 {
        return Err(classify_token_error(status, &body).to_string());
    }
    let json: serde_json::Value =
        serde_json::from_str(&body).map_err(|_| BAD_RESPONSE.to_string())?;
    let access_token = json
        .get("access_token")
        .and_then(|v| v.as_str())
        .ok_or_else(|| BAD_RESPONSE.to_string())?
        .to_string();
    let expires_in = json.get("expires_in").and_then(|v| v.as_i64()).unwrap_or(3600);
    Ok(Tokens {
        access_token,
        // 60s of slack so a call started just under the wire does not race the
        // expiry it just checked.
        expires_at_ms: now_ms + (expires_in - 60).max(0) * 1000,
        refresh_token: json
            .get("refresh_token")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        id_token: json.get("id_token").and_then(|v| v.as_str()).map(str::to_string),
    })
}

pub async fn exchange_code(
    authority: &str,
    client_id: &str,
    code: &str,
    verifier: &str,
    port: u16,
    now_ms: i64,
) -> Result<Tokens, String> {
    let redirect = format!("http://127.0.0.1:{port}");
    post_token(
        authority,
        &[
            ("client_id", client_id),
            ("grant_type", "authorization_code"),
            ("code", code),
            ("redirect_uri", &redirect),
            ("code_verifier", verifier),
            ("scope", GRAPH_SCOPES),
        ],
        now_ms,
    )
    .await
}

pub async fn refresh(
    authority: &str,
    client_id: &str,
    refresh_token: &str,
    now_ms: i64,
) -> Result<Tokens, String> {
    post_token(
        authority,
        &[
            ("client_id", client_id),
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh_token),
            ("scope", GRAPH_SCOPES),
        ],
        now_ms,
    )
    .await
}

/// Rotation: WRITE THE NEW TOKEN BEFORE DELETING THE OLD ONE.
///
/// keyring's set_password overwrites the same entry, so there is no separate
/// delete to order wrongly - but the ordering is stated because a future
/// backend with distinct create/delete calls must preserve it. Deleting first
/// and then failing the write leaves the user with no credential and no way
/// back.
pub fn persist_rotated(tokens: &Tokens) -> Result<(), String> {
    match &tokens.refresh_token {
        Some(token) => super::keychain::store_refresh_token(token),
        None => Ok(()),
    }
}
```

Extend `auth.rs`'s `use super::{...}` to cover `AUTH_EXPIRED`, `BAD_RESPONSE`, `THROTTLED`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml graph:: && cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings`
Expected: PASS (24 tests), no clippy warnings.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/graph/keychain.rs src-tauri/src/graph/auth.rs src-tauri/src/graph/mod.rs
git commit -m "feat(graph): add keychain storage, token exchange and refresh"
```

### Task 10: `calendar.rs` — the `calendarView` request and epoch normalization

**Files:**
- Create: `src-tauri/src/graph/calendar.rs`
- Modify: `src-tauri/src/graph/mod.rs`

**Gated on Task 9** (which is itself gated on both probes). This task consumes `GRAPH_SCOPES` but never sets it.

**Interfaces:**
- Consumes: `CalendarEvent`, `CalendarParticipant`, the `GRAPH_*` constants (Task 6).
- Produces:
  - `pub fn parse_graph_utc(dt: &str) -> Option<i64>`
  - `pub fn parse_events(body: &str) -> Result<Vec<CalendarEvent>, String>`
  - `pub async fn fetch_calendar_view(access_token: &str, start_iso: &str, end_iso: &str) -> Result<String, String>`
  - `pub const PREFER_UTC: &str`

  Task 11 consumes them.

- [ ] **Step 1: Write the failing tests**

`src-tauri/src/graph/calendar.rs`, test module:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_graph_utc_to_epoch_millis() {
        // Graph sends seven fractional digits and NO offset suffix.
        assert_eq!(
            parse_graph_utc("2026-09-02T14:00:00.0000000"),
            Some(1_788_357_600_000)
        );
        assert_eq!(parse_graph_utc("1970-01-01T00:00:00.0000000"), Some(0));
        // Fractional seconds are honoured to millisecond precision.
        assert_eq!(
            parse_graph_utc("1970-01-01T00:00:00.5000000"),
            Some(500)
        );
        // A leap-year boundary, because days_from_civil is where this breaks.
        assert_eq!(
            parse_graph_utc("2024-02-29T00:00:00.0000000"),
            Some(1_709_164_800_000)
        );
    }

    #[test]
    fn rejects_a_datetime_it_cannot_parse() {
        assert_eq!(parse_graph_utc(""), None);
        assert_eq!(parse_graph_utc("2026-09-02"), None);
        assert_eq!(parse_graph_utc("not a date"), None);
    }

    fn event_json(extra: &str) -> String {
        format!(
            r#"{{"value":[{{
                "id":"e1","subject":"Sync",
                "start":{{"dateTime":"2026-09-02T14:00:00.0000000","timeZone":"UTC"}},
                "end":{{"dateTime":"2026-09-02T14:30:00.0000000","timeZone":"UTC"}},
                "organizer":{{"emailAddress":{{"address":"host@x.test","name":"Host"}}}},
                "attendees":[{{"type":"required","emailAddress":{{"address":"a@x.test","name":"A"}},
                               "status":{{"response":"accepted"}}}}]
                {extra}
            }}]}}"#
        )
    }

    const FILTERS: &str = r#","isCancelled":false,"isAllDay":false,
                             "responseStatus":{"response":"accepted"}"#;

    #[test]
    fn parses_a_well_formed_event() {
        let events = parse_events(&event_json(FILTERS)).unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].start_ms, 1_788_357_600_000);
        assert_eq!(events[0].end_ms, 1_788_359_400_000);
        assert!(!events[0].is_cancelled);
        assert_eq!(events[0].own_response, "accepted");
        // organizer + attendees, unioned. participantsOf dedupes in TS.
        assert_eq!(events[0].participants.len(), 2);
        assert!(events[0].participants.iter().any(|p| p.is_organizer));
    }

    #[test]
    fn keeps_the_resource_type_so_typescript_can_drop_rooms() {
        let with_room = event_json(&format!(
            r#"{FILTERS},"__unused":0"#
        ))
        .replace(
            r#""attendees":["#,
            r#""attendees":[{"type":"resource","emailAddress":{"address":"room3@x.test","name":"Conf Room 3"},"status":{"response":"accepted"}},"#,
        );
        let events = parse_events(&with_room).unwrap();
        assert!(events[0]
            .participants
            .iter()
            .any(|p| p.r#type == "resource" && p.address == "room3@x.test"));
    }

    /// A response missing a filter property is UNUSABLE, not empty. Treating
    /// it as "no meetings" would silently propose a meeting the user declined.
    #[test]
    fn an_absent_filter_property_is_a_bad_response_not_a_default() {
        for missing in [
            r#","isAllDay":false,"responseStatus":{"response":"accepted"}"#, // no isCancelled
            r#","isCancelled":false,"responseStatus":{"response":"accepted"}"#, // no isAllDay
            r#","isCancelled":false,"isAllDay":false"#,                     // no responseStatus
        ] {
            assert_eq!(
                parse_events(&event_json(missing)),
                Err(BAD_RESPONSE.to_string()),
                "missing filter property must not default to included"
            );
        }
    }

    /// The normalization to epoch milliseconds ASSUMES the Prefer header held.
    /// A non-UTC timeZone means it did not, and parsing anyway would shift the
    /// whole acceptance window by the mailbox's offset.
    #[test]
    fn a_non_utc_timezone_is_rejected_rather_than_parsed() {
        let local = event_json(FILTERS).replace(r#""timeZone":"UTC""#, r#""timeZone":"Pacific Standard Time""#);
        assert_eq!(parse_events(&local), Err(BAD_RESPONSE.to_string()));
    }

    #[test]
    fn the_prefer_header_asks_for_utc() {
        assert_eq!(PREFER_UTC, "outlook.timezone=\"UTC\"");
    }

    #[test]
    fn an_empty_value_array_is_no_events_not_an_error() {
        assert_eq!(parse_events(r#"{"value":[]}"#), Ok(vec![]));
    }
}
```

- [ ] **Step 2: Run to verify they fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml graph::calendar`
Expected: FAIL to compile — `cannot find function parse_graph_utc`.

- [ ] **Step 3: Write the implementation**

```rust
//! GET /me/calendarView, and the normalization that makes the pure TypeScript
//! window arithmetic possible.

use super::{CalendarEvent, CalendarParticipant, AUTH_REJECTED, BAD_RESPONSE, NETWORK, THROTTLED};

/// Without this header Graph answers in the mailbox's own zone, named in
/// Windows style ("Pacific Standard Time"), and resolving those needs a
/// timezone database this crate deliberately does not carry.
pub const PREFER_UTC: &str = "outlook.timezone=\"UTC\"";

/// Days since 1970-01-01 for a proleptic Gregorian date. Howard Hinnant's
/// `days_from_civil`, integer-only - which is why this crate needs no
/// `chrono`/`time`/`chrono-tz` for a job that is one fixed layout.
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = if m > 2 { m - 3 } else { m + 9 };
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// Parses Graph's fixed `YYYY-MM-DDTHH:MM:SS[.fffffff]` layout as UTC.
///
/// The caller has already established `timeZone == "UTC"`; this function does
/// NOT interpret an offset suffix, and returns None for anything that is not
/// this exact layout rather than guessing.
pub fn parse_graph_utc(dt: &str) -> Option<i64> {
    let (date, rest) = dt.split_once('T')?;
    let mut date_parts = date.split('-');
    let year: i64 = date_parts.next()?.parse().ok()?;
    let month: i64 = date_parts.next()?.parse().ok()?;
    let day: i64 = date_parts.next()?.parse().ok()?;
    if date_parts.next().is_some() || !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }

    let (clock, fraction) = match rest.split_once('.') {
        Some((clock, fraction)) => (clock, fraction),
        None => (rest, ""),
    };
    let mut clock_parts = clock.split(':');
    let hour: i64 = clock_parts.next()?.parse().ok()?;
    let minute: i64 = clock_parts.next()?.parse().ok()?;
    let second: i64 = clock_parts.next()?.parse().ok()?;
    if clock_parts.next().is_some() || hour > 23 || minute > 59 || second > 60 {
        return None;
    }

    // Graph sends seven fractional digits; take three, pad short ones.
    let millis: i64 = if fraction.is_empty() {
        0
    } else {
        let digits: String = fraction.chars().take(3).collect();
        let padded = format!("{digits:0<3}");
        padded.parse().ok()?
    };

    Some(
        (days_from_civil(year, month, day) * 86_400 + hour * 3_600 + minute * 60 + second) * 1_000
            + millis,
    )
}

fn address_of(node: &serde_json::Value) -> Option<(String, Option<String>)> {
    let email = node.get("emailAddress")?;
    let address = email.get("address")?.as_str()?.to_string();
    let name = email.get("name").and_then(|v| v.as_str()).map(str::to_string);
    Some((address, name))
}

/// Reads a `{ dateTime, timeZone }` pair, REJECTING a timeZone that is not UTC.
fn utc_millis(node: Option<&serde_json::Value>) -> Option<i64> {
    let node = node?;
    if node.get("timeZone")?.as_str()? != "UTC" {
        return None;
    }
    parse_graph_utc(node.get("dateTime")?.as_str()?)
}

pub fn parse_events(body: &str) -> Result<Vec<CalendarEvent>, String> {
    let json: serde_json::Value =
        serde_json::from_str(body).map_err(|_| BAD_RESPONSE.to_string())?;
    let values = json
        .get("value")
        .and_then(|v| v.as_array())
        .ok_or_else(|| BAD_RESPONSE.to_string())?;

    let mut events = Vec::with_capacity(values.len());
    for value in values {
        // EVERY property a rule reads is required. A missing `isCancelled` is
        // not "false" - it is an unusable response.
        let id = value
            .get("id")
            .and_then(|v| v.as_str())
            .ok_or_else(|| BAD_RESPONSE.to_string())?
            .to_string();
        let is_cancelled = value
            .get("isCancelled")
            .and_then(|v| v.as_bool())
            .ok_or_else(|| BAD_RESPONSE.to_string())?;
        let is_all_day = value
            .get("isAllDay")
            .and_then(|v| v.as_bool())
            .ok_or_else(|| BAD_RESPONSE.to_string())?;
        let own_response = value
            .get("responseStatus")
            .and_then(|v| v.get("response"))
            .and_then(|v| v.as_str())
            .ok_or_else(|| BAD_RESPONSE.to_string())?
            .to_string();
        let start_ms = utc_millis(value.get("start")).ok_or_else(|| BAD_RESPONSE.to_string())?;
        let end_ms = utc_millis(value.get("end")).ok_or_else(|| BAD_RESPONSE.to_string())?;

        // `subject` is OPTIONAL, unlike the filter properties: an untitled
        // event is a real event, and the block just has no heading for it.
        let subject = value.get("subject").and_then(|v| v.as_str()).map(str::to_string);

        let mut participants: Vec<CalendarParticipant> = Vec::new();
        if let Some((address, name)) = value.get("organizer").and_then(address_of) {
            participants.push(CalendarParticipant {
                address,
                name,
                r#type: "required".to_string(),
                is_organizer: true,
            });
        }
        for attendee in value.get("attendees").and_then(|v| v.as_array()).unwrap_or(&vec![]) {
            if let Some((address, name)) = address_of(attendee) {
                participants.push(CalendarParticipant {
                    address,
                    name,
                    // Kept verbatim so `participantsOf` in TypeScript can drop
                    // rooms and equipment. Defaulting an unknown value to
                    // "required" is deliberate: a person is the safe guess,
                    // and a resource always carries the literal string.
                    r#type: attendee
                        .get("type")
                        .and_then(|v| v.as_str())
                        .unwrap_or("required")
                        .to_string(),
                    is_organizer: false,
                });
            }
        }

        events.push(CalendarEvent {
            id,
            subject,
            start_ms,
            end_ms,
            is_cancelled,
            is_all_day,
            own_response,
            participants,
        });
    }
    Ok(events)
}

/// The raw body, so `parse_events` stays pure and testable. `start_iso` and
/// `end_iso` come from the WEBVIEW - JavaScript already owns a clock and a
/// correct `toISOString`, so no date library is needed on this side either.
pub async fn fetch_calendar_view(
    access_token: &str,
    start_iso: &str,
    end_iso: &str,
) -> Result<String, String> {
    let response = reqwest::Client::new()
        .get("https://graph.microsoft.com/v1.0/me/calendarView")
        .query(&[
            ("startDateTime", start_iso),
            ("endDateTime", end_iso),
            (
                "$select",
                "id,subject,start,end,isCancelled,isAllDay,responseStatus,organizer,attendees",
            ),
            ("$top", "50"),
        ])
        .bearer_auth(access_token)
        .header("Prefer", PREFER_UTC)
        .send()
        .await
        .map_err(|_| NETWORK.to_string())?;

    match response.status().as_u16() {
        200 => response.text().await.map_err(|_| NETWORK.to_string()),
        // Surfaced so the caller can run its ONE refresh-and-retry.
        401 => Err(AUTH_REJECTED.to_string()),
        // "Respect Retry-After; do not retry in a loop" holds BY CONSTRUCTION:
        // this returns straight to the caller, useCalendarProposal renders an
        // error state, and the ONLY thing that issues another request is the
        // user clicking Try again. The header's seconds value is therefore not
        // read - there is no automatic retry for it to gate.
        429 => Err(THROTTLED.to_string()),
        status if status >= 500 => Err(NETWORK.to_string()),
        _ => Err(BAD_RESPONSE.to_string()),
    }
}
```

Add `mod calendar;` to `src-tauri/src/graph/mod.rs`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml graph::`
Expected: PASS (32 tests).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/graph/calendar.rs src-tauri/src/graph/mod.rs
git commit -m "feat(graph): fetch calendarView and normalize times to epoch millis"
```

### Task 11: The four commands

**Files:**
- Modify: `src-tauri/src/graph/mod.rs`, `src-tauri/src/lib.rs:148`

**Interfaces:**
- Consumes: Tasks 6–10.
- Produces the IPC surface Tasks 12–15 call:
  - `graph_connect(app, clientId, authority) -> Result<GraphStatus, String>`
  - `graph_disconnect(app) -> Result<(), String>`
  - `graph_status(app) -> Result<GraphStatus, String>` (local only, no network)
  - `graph_current_meetings(app, clientId, authority, startIso, endIso) -> Result<CurrentMeetings, String>`

- [ ] **Step 1: Write the failing test**

Append to `mod.rs`'s `mod tests`:

```rust
    #[test]
    fn disconnect_zeroes_the_in_memory_access_token() {
        // Clearing only the keychain leaves a live token in Rust memory that
        // keeps working until its expiry - a disconnect that does not
        // disconnect.
        let state = GraphState::default();
        {
            let mut session = state.session.lock().unwrap();
            session.access_token = Some("live".into());
            session.refresh_token = Some("also-live".into());
            session.expires_at_ms = i64::MAX;
            session.generation = 3;
        }
        state.clear_session();
        let session = state.session.lock().unwrap();
        assert!(session.access_token.is_none());
        // The session-only path's ONLY copy of the refresh token lives here,
        // so a disconnect that left it behind would not disconnect at all.
        assert!(session.refresh_token.is_none());
        assert_eq!(session.expires_at_ms, 0);
        // A bumped generation is what makes an in-flight call abandon its
        // result instead of writing it back after the disconnect.
        assert_eq!(session.generation, 4);
    }

    #[test]
    fn session_only_reports_disconnected_with_nothing_in_memory() {
        let state = GraphState::default();
        *state.session_only.lock().unwrap() = true;
        assert_eq!(
            state.status().unwrap(),
            GraphStatus { connected: false, session_only: true }
        );
    }

    /// A session-only connection lasts until app QUIT, not until access-token
    /// expiry. Reading the access token in `status()` would report a
    /// disconnection roughly every 55 minutes, and `stored_refresh_token`
    /// reading only the keychain would make the next call fail outright - on
    /// the one platform where the refuse-to-persist rule applies.
    #[test]
    fn session_only_survives_access_token_expiry() {
        let state = GraphState::default();
        *state.session_only.lock().unwrap() = true;
        {
            let mut session = state.session.lock().unwrap();
            session.refresh_token = Some("in-memory-only".into());
            session.access_token = Some("stale".into());
            session.expires_at_ms = 0; // long expired
        }
        assert_eq!(
            state.status().unwrap(),
            GraphStatus { connected: true, session_only: true }
        );
        assert_eq!(
            stored_refresh_token(&state),
            Ok("in-memory-only".to_string())
        );
    }

    /// A disconnect landing while a refresh is in the air must not be undone by
    /// that refresh completing. `adopt` compares the generation UNDER the
    /// session lock and writes nothing on a mismatch; `adopt_and_persist` then
    /// refuses to touch the keychain at all, so the entry the user just deleted
    /// is not rewritten behind them.
    #[test]
    fn a_disconnect_mid_flight_beats_a_refresh_that_was_already_running() {
        let state = GraphState::default();
        let generation = state.session.lock().unwrap().generation;
        let tokens = auth::Tokens {
            access_token: "fresh".into(),
            expires_at_ms: i64::MAX,
            refresh_token: Some("rotated".into()),
            id_token: None,
        };

        // The disconnect lands first, bumping the generation.
        state.clear_session();

        assert!(!adopt(&state, &tokens, generation), "stale generation must not adopt");
        assert_eq!(
            adopt_and_persist(&state, &tokens, generation),
            Err(NOT_CONNECTED.to_string())
        );
        let session = state.session.lock().unwrap();
        assert!(session.access_token.is_none(), "a disconnected session stayed disconnected");
        assert!(session.refresh_token.is_none());
    }

    /// On the session-only path `available()` was false at connect, so any
    /// keychain call errors. Deleting BEFORE clearing memory therefore made
    /// Disconnect impossible on exactly the platform where memory holds the only
    /// copy of the credential. Memory is cleared unconditionally and first.
    #[test]
    fn forgetting_on_the_session_only_path_touches_no_keychain_and_clears_memory() {
        let state = GraphState::default();
        *state.session_only.lock().unwrap() = true;
        state.session.lock().unwrap().refresh_token = Some("in-memory-only".into());

        assert_eq!(forget_refresh_token(&state), Ok(()));
        assert!(state.session.lock().unwrap().refresh_token.is_none());
    }

    /// Session-only must never write to disk, and a skipped write is not a
    /// failure: the tokens still reach memory and the call proceeds.
    #[test]
    fn session_only_adopts_without_persisting() {
        let state = GraphState::default();
        *state.session_only.lock().unwrap() = true;
        let generation = state.session.lock().unwrap().generation;
        let tokens = auth::Tokens {
            access_token: "fresh".into(),
            expires_at_ms: i64::MAX,
            refresh_token: Some("rotated".into()),
            id_token: None,
        };

        assert_eq!(adopt_and_persist(&state, &tokens, generation), Ok(()));
        let session = state.session.lock().unwrap();
        assert_eq!(session.access_token.as_deref(), Some("fresh"));
        assert_eq!(session.refresh_token.as_deref(), Some("rotated"));
    }

    /// Nothing was written to disk, so there is nothing to fall back to. This
    /// is the re-authenticate-each-launch state, and it must be NOT_CONNECTED
    /// rather than a keychain error.
    #[test]
    fn session_only_with_no_memory_token_is_not_connected() {
        let state = GraphState::default();
        *state.session_only.lock().unwrap() = true;
        assert_eq!(stored_refresh_token(&state), Err(NOT_CONNECTED.to_string()));
    }
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test --manifest-path src-tauri/Cargo.toml graph::`
Expected: FAIL to compile — `cannot find type GraphState`.

- [ ] **Step 3: Write the state and commands**

Append to `src-tauri/src/graph/mod.rs`:

```rust
use std::sync::Mutex;
use tauri::{AppHandle, Manager};
use tauri_plugin_opener::OpenerExt;

/// The access token lives HERE and nowhere else - process memory, never
/// plugin-store, never localStorage, never a log line.
#[derive(Default)]
pub struct Session {
    pub access_token: Option<String>,
    pub expires_at_ms: i64,
    /**
     * The refresh token IN MEMORY - the session-only path's only copy.
     *
     * On Linux with no keychain service nothing is written to disk, so without
     * this field the connection would die at ACCESS-token expiry (~55 minutes)
     * rather than at app quit. The spec says re-authenticate each LAUNCH.
     *
     * On the normal path this mirrors the keychain entry, and the refresh path
     * reads memory first so a keychain hiccup mid-session does not force a
     * reconnect.
     */
    pub refresh_token: Option<String>,
    pub own_address: Option<String>,
    /// Bumped by disconnect. An in-flight call captures it before awaiting and
    /// discards its result if the value moved - which is how "aborts in-flight
    /// calls" is delivered without cancellation tokens threaded everywhere.
    pub generation: u64,
}

#[derive(Default)]
pub struct GraphState {
    pub session: Mutex<Session>,
    /// True when no keychain service was available: the connection works for
    /// this launch and NOTHING is written to disk.
    pub session_only: Mutex<bool>,
}

impl GraphState {
    pub fn clear_session(&self) {
        let mut session = self.session.lock().unwrap();
        session.access_token = None;
        session.refresh_token = None;
        session.expires_at_ms = 0;
        session.own_address = None;
        session.generation = session.generation.wrapping_add(1);
    }

    /// Returns `Err` when the keychain cannot be READ.
    ///
    /// It must not collapse that into `connected: false`. `matches!(load(),
    /// Ok(Some(_)))` treats a real read failure as "disconnected", so a
    /// genuinely connected user hits a transient keychain problem, gets
    /// `connected: false` with no error anywhere, and the calendar block simply
    /// VANISHES (`present` goes false in Task 13) instead of saying anything.
    /// A feature that disappears silently is indistinguishable from one that
    /// was never set up.
    pub fn status(&self) -> Result<GraphStatus, String> {
        let session_only = *self.session_only.lock().unwrap();
        // The REFRESH token, not the access token: a connection whose access
        // token has expired is still connected - the next call refreshes.
        // Testing the access token would report a disconnection roughly every
        // 55 minutes.
        let in_memory = self.session.lock().unwrap().refresh_token.is_some();
        // Memory first, and on the session-only path memory is all there is.
        let connected = if session_only || in_memory {
            in_memory
        } else {
            keychain::load_refresh_token()?.is_some()
        };
        Ok(GraphStatus { connected, session_only })
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Adopt a freshly obtained token set into the session.
///
/// Returns `false` when a disconnect landed while the caller was awaiting -
/// the generation moved, so these tokens belong to a connection the user has
/// since destroyed. The caller must then write NOTHING, keychain included.
///
/// Checking the generation INSIDE the lock is what makes this sound: a caller
/// that checked first and adopted second would race the very disconnect it is
/// trying to observe.
fn adopt(state: &GraphState, tokens: &auth::Tokens, generation: u64) -> bool {
    let mut session = state.session.lock().unwrap();
    if session.generation != generation {
        return false;
    }
    session.access_token = Some(tokens.access_token.clone());
    session.expires_at_ms = tokens.expires_at_ms;
    // Entra ROTATES on every redemption; `None` means this response carried no
    // new one, so the existing value stands rather than being cleared.
    if tokens.refresh_token.is_some() {
        session.refresh_token = tokens.refresh_token.clone();
    }
    if let Some(id_token) = &tokens.id_token {
        if let Some(address) = auth::own_address_from_id_token(id_token) {
            session.own_address = Some(address);
        }
    }
    true
}

/// Adopt into MEMORY first, persist SECOND, and never let a persist failure
/// throw away a credential we already hold.
///
/// Three separate rules live here, each of which was a defect when this was an
/// inline `persist_rotated(&tokens)?; adopt(&state, &tokens);` pair:
///
/// 1. **A disconnect that landed mid-flight wins.** `adopt` returning false
///    means the user disconnected while we were awaiting; persisting anyway
///    would REWRITE the keychain entry they just destroyed and leave `status()`
///    reporting connected again after a disconnect that appeared to succeed.
/// 2. **Session-only never touches disk.** The write is skipped, not attempted
///    and ignored - `persist_rotated` would fail and its `?` would abort the
///    whole call, so every request after access-token expiry died on the one
///    platform where the refuse-to-persist rule applies.
/// 3. **A persist failure degrades; it does not discard.** `available()` is a
///    heuristic over error variants (see keychain.rs), so it can be wrong, and
///    the keychain can also go away mid-session. We already hold working tokens
///    in memory at this point - falling back to session-only keeps the user
///    working until quit, where propagating the error would throw away a
///    credential that is fine.
fn adopt_and_persist(
    state: &GraphState,
    tokens: &auth::Tokens,
    generation: u64,
) -> Result<(), String> {
    if !adopt(state, tokens, generation) {
        return Err(NOT_CONNECTED.to_string());
    }
    if *state.session_only.lock().unwrap() {
        return Ok(());
    }
    if auth::persist_rotated(tokens).is_err() {
        *state.session_only.lock().unwrap() = true;
    }
    Ok(())
}

/// Called ONLY on an explicit `invalid_grant` - the one response that proves
/// the refresh token is genuinely dead.
///
/// Memory is cleared first and unconditionally: whatever the keychain does, a
/// token known to be dead must not survive in this process. The keychain delete
/// is then propagated rather than discarded with `let _ =`. A silently failed
/// delete leaves the dead token on disk while memory says disconnected, so the
/// next launch reads it straight back and fails identically, with nothing
/// anywhere telling the user why.
fn forget_refresh_token(state: &GraphState) -> Result<(), String> {
    let was_session_only = *state.session_only.lock().unwrap();
    state.clear_session();
    if was_session_only {
        return Ok(());
    }
    keychain::delete_refresh_token()
}

/// The ONE refresh path. Both call sites in `graph_current_meetings` go through
/// it, which is what keeps the `invalid_grant` handling identical between them.
///
/// The earlier draft special-cased AUTH_EXPIRED at the first call site and used
/// a bare `?` at the second, so a refresh token revoked at the same moment as
/// the access token - a password change, the single commonest cause - left the
/// dead credential sitting in the keychain forever.
async fn refresh_and_adopt(
    state: &GraphState,
    authority: &str,
    client_id: &str,
    generation: u64,
) -> Result<String, String> {
    let stored = stored_refresh_token(state)?;
    let tokens = match auth::refresh(authority, client_id, &stored, now_ms()).await {
        Ok(tokens) => tokens,
        Err(code) if code == AUTH_EXPIRED => {
            // A keychain failure while forgetting is surfaced, not swallowed:
            // "your credential is dead AND it is stuck on disk" is a different
            // problem from "reconnect", and the user can act on it.
            forget_refresh_token(state)?;
            return Err(AUTH_EXPIRED.to_string());
        }
        Err(code) => return Err(code),
    };
    let access = tokens.access_token.clone();
    adopt_and_persist(state, &tokens, generation)?;
    Ok(access)
}

/// MEMORY FIRST, then the keychain.
///
/// The session-only path (Linux with no keychain service) has no keychain
/// entry at all, so a keychain-only read would strand it at access-token
/// expiry. On the normal path memory and keychain hold the same value, and
/// preferring memory also survives a transient keychain failure mid-session.
fn stored_refresh_token(state: &GraphState) -> Result<String, String> {
    if let Some(token) = state.session.lock().unwrap().refresh_token.clone() {
        return Ok(token);
    }
    if *state.session_only.lock().unwrap() {
        // Nothing was ever written to disk, so there is nothing to fall back
        // to - this is the re-authenticate-each-launch state.
        return Err(NOT_CONNECTED.to_string());
    }
    keychain::load_refresh_token()?.ok_or_else(|| NOT_CONNECTED.to_string())
}

#[tauri::command]
pub async fn graph_connect(
    app: AppHandle,
    client_id: String,
    authority: String,
) -> Result<GraphStatus, String> {
    let state = app.state::<GraphState>();

    // Bind BEFORE opening the browser: the redirect URI must carry the real
    // port, and a bind failure must not leave a consent screen with nowhere
    // to land.
    let (port, rx) = auth::listen_once(auth::LISTENER_TIMEOUT)?;
    let pkce = auth::new_pkce();
    let expected_state = auth::random_token(24);
    let expected_nonce = auth::random_token(24);

    // Returns Err on a malformed or non-https authority - the user typed it,
    // and it is the host that will receive the code, the verifier and the
    // refresh token. Nothing is opened until it is validated.
    let url = auth::authorize_url(
        &authority,
        &client_id,
        port,
        &pkce.challenge,
        &expected_state,
        &expected_nonce,
    )?;
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|_| NETWORK.to_string())?;

    let callback = tauri::async_runtime::spawn_blocking(move || rx.recv())
        .await
        .map_err(|_| NETWORK.to_string())?
        .map_err(|_| AUTH_CANCELLED.to_string())??;

    if let Some(error) = &callback.error {
        return Err(auth::classify_callback_error(error).to_string());
    }
    // Validated BEFORE the code is redeemed - a mismatch sends nothing to the
    // token endpoint.
    auth::validate_state(&expected_state, callback.state.as_deref())?;
    let code = callback.code.ok_or_else(|| AUTH_CANCELLED.to_string())?;

    let tokens = auth::exchange_code(&authority, &client_id, &code, &pkce.verifier, port, now_ms())
        .await?;

    // The nonce binds this ID token to this authorize request. An ABSENT id
    // token is a rejection, not a skip - see auth::validate_nonce.
    auth::validate_nonce(&expected_nonce, tokens.id_token.as_deref())?;

    // `available()` is only the fast path. adopt_and_persist degrades to
    // session-only if the write fails anyway, so a wrong guess here costs
    // nothing - where propagating a persist failure would discard a credential
    // we have already paid for the browser round trip to obtain, forcing the
    // user through the whole flow again.
    *state.session_only.lock().unwrap() = !keychain::available();
    let generation = state.session.lock().unwrap().generation;
    adopt_and_persist(&state, &tokens, generation)?;
    state.status()
}

#[tauri::command]
pub async fn graph_disconnect(app: AppHandle) -> Result<(), String> {
    let state = app.state::<GraphState>();
    let was_session_only = *state.session_only.lock().unwrap();

    // MEMORY FIRST, unconditionally, before anything that can fail.
    //
    // Deleting the keychain entry first with `?` meant ANY keychain error
    // returned early and left both the access token and the in-memory refresh
    // token live - a disconnect that does not disconnect. On the session-only
    // path that was not an edge case but the guaranteed outcome: `available()`
    // was false at connect, so the delete always errors, and Disconnect could
    // never succeed on the one platform where memory holds the ONLY copy of
    // the credential.
    state.clear_session();
    *state.session_only.lock().unwrap() = false;

    // Nothing was ever written to disk on that path, so there is nothing to
    // delete and no failure to report.
    if was_session_only {
        return Ok(());
    }
    // Surfaced, not swallowed: the user needs to know the entry survived.
    // Memory is already clear either way.
    keychain::delete_refresh_token()
}

#[tauri::command]
pub fn graph_status(app: AppHandle) -> Result<GraphStatus, String> {
    app.state::<GraphState>().status()
}

#[tauri::command]
pub async fn graph_current_meetings(
    app: AppHandle,
    client_id: String,
    authority: String,
    start_iso: String,
    end_iso: String,
) -> Result<CurrentMeetings, String> {
    let state = app.state::<GraphState>();
    let generation = state.session.lock().unwrap().generation;

    let mut token = {
        let session = state.session.lock().unwrap();
        match &session.access_token {
            Some(token) if session.expires_at_ms > now_ms() => Some(token.clone()),
            _ => None,
        }
    };

    // BOTH refresh sites go through refresh_and_adopt, which is what makes the
    // invalid_grant handling identical between them.
    if token.is_none() {
        token = Some(refresh_and_adopt(&state, &authority, &client_id, generation).await?);
    }

    let access = token.ok_or_else(|| NOT_CONNECTED.to_string())?;
    let body = match calendar::fetch_calendar_view(&access, &start_iso, &end_iso).await {
        Ok(body) => body,
        // ONE refresh-and-retry on a 401, then give up. A second 401 after a
        // fresh token is a real authorization failure - scopes or tenant
        // policy changed - and the refresh token is RETAINED.
        Err(code) if code == AUTH_REJECTED => {
            let refreshed = refresh_and_adopt(&state, &authority, &client_id, generation).await?;
            calendar::fetch_calendar_view(&refreshed, &start_iso, &end_iso).await?
        }
        Err(code) => return Err(code),
    };

    // A disconnect that landed while this was in flight invalidates the
    // result: returning it would answer a question the user has withdrawn.
    //
    // This check is now a BACKSTOP rather than the only guard. `adopt` makes
    // the same comparison under the session lock before writing anything, so a
    // disconnect can no longer be undone by a refresh that was already in the
    // air - which is what this check alone, sitting after the fetch, allowed.
    if state.session.lock().unwrap().generation != generation {
        return Err(NOT_CONNECTED.to_string());
    }

    Ok(CurrentMeetings {
        own_address: state.session.lock().unwrap().own_address.clone(),
        events: calendar::parse_events(&body)?,
    })
}
```

In `src-tauri/src/lib.rs`: add `.manage(graph::GraphState::default())` beside the other managed state, and add the four commands to `tauri::generate_handler![...]` at `:148`.

- [ ] **Step 4: Run tests, clippy and a real build**

Run:
```bash
cargo test --manifest-path src-tauri/Cargo.toml graph::
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
cargo build --manifest-path src-tauri/Cargo.toml
```
Expected: PASS (39 tests), no warnings, builds.

If `app.opener().open_url(...)` does not resolve against the pinned `tauri-plugin-opener` version, substitute the plugin's current URL-opening entry point (`lib.rs:116` already registers the plugin) — do not shell out to a per-platform `Command`, which would reintroduce a quoting surface for the authorize URL.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/graph/mod.rs src-tauri/src/lib.rs
git commit -m "feat(graph): expose connect, disconnect, status and current-meetings commands"
```

---

## Slice 3 — TypeScript integration

### Task 12: Calendar config storage and the `/odoo` connect section

**Files:**
- Create: `src/lib/storage/graph-config.storage.ts`
- Modify: `src/lib/storage/index.ts`, `src/pages/odoo/index.tsx`
- Test: `src/tests/graph-config.storage.test.ts`

**Interfaces:**
- Consumes: `secureGet`/`secureSet`/`secureDelete` (`src/lib/secure-storage.ts`), `toGraphError` (Task 3), the four commands (Task 11).
- Produces:
  - `SECURE_GRAPH_CONFIG_KEY`
  - `DEFAULT_AUTHORITY = "https://login.microsoftonline.com/organizations"`
  - `GraphConfig = { clientId: string; authority: string }`
  - A **discriminated union**, not a single object — `config` is only non-null on the `complete` arm, and that is what makes `config.config.clientId` type-check at the call sites:
    ```typescript
    export type GraphConfigState =
      | { state: "absent"; config: null }
      | { state: "unreadable"; config: null }
      | { state: "complete"; config: GraphConfig };
    ```
  - `loadGraphConfigState(): Promise<GraphConfigState>` — the one that distinguishes "never set up" from "corrupt"
  - `loadGraphConfig(): Promise<GraphConfig | null>` — thin wrapper collapsing both non-complete arms to `null`. **It has no caller in this plan**: Task 13 and the `/odoo` section both need the distinction, so both use `loadGraphConfigState`. Kept because it is the shape a future caller that genuinely does not care will want, and its own test pins the collapse.
  - `isHttpsUrl(value: string): boolean`
  - `saveGraphConfig(config: GraphConfig): Promise<void>`

  Task 13 consumes `loadGraphConfigState`; so does this task's own `/odoo` section.

**Why plugin-store and not the keychain:** a public client ID is **not a secret** — it travels in every authorize URL and is trivially extracted from any native binary. It is stored the same way the Odoo config is, and passed to Rust as a command argument on every call, which keeps Rust's persistent state to exactly one thing: the refresh token.

- [ ] **Step 1: Write the failing test**

`src/tests/graph-config.storage.test.ts`:

```typescript
import { beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({
  secureGet: vi.fn(async () => null as string | null),
  secureSet: vi.fn(async () => {}),
  secureDelete: vi.fn(async () => {}),
}));
vi.mock("@/lib/secure-storage", () => store);

import {
  DEFAULT_AUTHORITY,
  loadGraphConfig,
  loadGraphConfigState,
  saveGraphConfig,
} from "@/lib/storage/graph-config.storage";

beforeEach(() => {
  vi.clearAllMocks();
  store.secureGet.mockResolvedValue(null);
});

describe("loadGraphConfig", () => {
  // v1 ships NO client ID: the defaults are empty and setup is two fields on
  // the /odoo page. "Nothing stored" must therefore be a first-class state,
  // not an error.
  it("returns null when nothing is stored", async () => {
    await expect(loadGraphConfig()).resolves.toBeNull();
  });

  it("returns null when the client ID is blank", async () => {
    store.secureGet.mockResolvedValue(JSON.stringify({ clientId: "  ", authority: "" }));
    await expect(loadGraphConfig()).resolves.toBeNull();
  });

  it("defaults the authority to /organizations", async () => {
    store.secureGet.mockResolvedValue(JSON.stringify({ clientId: "abc" }));
    await expect(loadGraphConfig()).resolves.toEqual({
      clientId: "abc",
      authority: DEFAULT_AUTHORITY,
    });
  });

  // /common would admit personal MSA accounts, which are out of scope.
  it("uses the /organizations authority as its default", () => {
    expect(DEFAULT_AUTHORITY).toBe("https://login.microsoftonline.com/organizations");
    expect(DEFAULT_AUTHORITY).not.toContain("/common");
  });

  // "Never set up" and "corrupt" must not be the same state. Collapsing them
  // takes the feature away from a previously-connected user with nothing on
  // screen to say why - the exact distinction loadOdooConfigState draws.
  it("reports an unreadable blob as unreadable, not absent", async () => {
    store.secureGet.mockResolvedValue("{not json");
    await expect(loadGraphConfigState()).resolves.toEqual({
      state: "unreadable",
      config: null,
    });
  });

  it("reports nothing stored as absent, not unreadable", async () => {
    store.secureGet.mockResolvedValue(null);
    await expect(loadGraphConfigState()).resolves.toEqual({
      state: "absent",
      config: null,
    });
  });

  // A blank client ID is a half-finished setup, not corruption.
  it("reports a blank client ID as absent", async () => {
    store.secureGet.mockResolvedValue(JSON.stringify({ clientId: "  " }));
    await expect(loadGraphConfigState()).resolves.toMatchObject({ state: "absent" });
  });

  // The authority is the host that receives the auth code, the PKCE verifier
  // and later the refresh token. Rust rejects a non-https one outright; this
  // check exists so /odoo can say something useful first.
  it.each(["http://login.microsoftonline.com/x", "login.microsoftonline.com/x", "ftp://x.test"])(
    "reports %s as unreadable rather than handing it to Rust",
    async (authority) => {
      store.secureGet.mockResolvedValue(JSON.stringify({ clientId: "abc", authority }));
      await expect(loadGraphConfigState()).resolves.toMatchObject({ state: "unreadable" });
    }
  );
});

describe("saveGraphConfig", () => {
  it("trims both fields before storing", async () => {
    await saveGraphConfig({ clientId: "  abc  ", authority: "  https://x/tenant  " });
    expect(store.secureSet).toHaveBeenCalledWith(
      expect.any(String),
      JSON.stringify({ clientId: "abc", authority: "https://x/tenant" })
    );
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/tests/graph-config.storage.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the storage module**

`src/lib/storage/graph-config.storage.ts`:

```typescript
import { secureGet, secureSet } from "@/lib/secure-storage";

export const SECURE_GRAPH_CONFIG_KEY = "secure_graph_config";

/**
 * `/organizations`, NOT `/common`: personal MSA accounts are out of scope for
 * this feature, and narrowing the authority is one of the four registration
 * hygiene measures the design relies on (the others: loopback-only redirect
 * URIs, public client flows disabled, minimum scopes).
 */
export const DEFAULT_AUTHORITY = "https://login.microsoftonline.com/organizations";

export interface GraphConfig {
  /**
   * NOT a secret. A public client ID travels in every authorize URL and is
   * trivially extracted from any native binary, so it is stored beside the
   * Odoo config and passed to Rust on every command rather than persisted
   * there.
   */
  clientId: string;
  authority: string;
}

/**
 * "Absent" and "unreadable" are DIFFERENT states, and this function must not
 * collapse them - the same distinction `loadOdooConfigState` already draws
 * ("Throws ODOO_INTERNAL on an unreadable blob; never throws for 'not set up'").
 *
 * `absent` is the routine v1 state: the app ships no client ID, so almost every
 * user is here, and the correct response is a statically-absent proposal block
 * and a picker identical to today's. `unreadable` is a real failure - a config
 * that once worked and whose store is now corrupt - and returning `absent` for
 * it would take the whole feature away from a previously-connected user with
 * nothing on screen to say why.
 */
export type GraphConfigState =
  | { state: "absent"; config: null }
  | { state: "unreadable"; config: null }
  | { state: "complete"; config: GraphConfig };

export async function loadGraphConfigState(): Promise<GraphConfigState> {
  let raw: string | null;
  try {
    raw = await secureGet(SECURE_GRAPH_CONFIG_KEY);
  } catch {
    return { state: "unreadable", config: null };
  }
  if (!raw) return { state: "absent", config: null };

  let parsed: Partial<GraphConfig>;
  try {
    parsed = JSON.parse(raw) as Partial<GraphConfig>;
  } catch {
    return { state: "unreadable", config: null };
  }

  const clientId = (parsed.clientId ?? "").trim();
  // A blank client ID is "not set up yet", not corruption: the fields exist
  // and are empty, which is exactly what a half-finished setup looks like.
  if (clientId === "") return { state: "absent", config: null };

  const authority = (parsed.authority ?? "").trim();
  const resolved = authority === "" ? DEFAULT_AUTHORITY : authority;
  // Validated here as well as in Rust. Rust's check is the one that actually
  // protects the credentials (see auth::validate_authority); this one exists so
  // the /odoo page can say something useful instead of surfacing a bare
  // GRAPH_AUTH_REJECTED from deep in the connect flow.
  if (!isHttpsUrl(resolved)) return { state: "unreadable", config: null };

  return { state: "complete", config: { clientId, authority: resolved } };
}

export function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Thin wrapper for the callers that only need the config and treat every
 * non-complete state the same way. `useCalendarProposal` does NOT use this -
 * it needs to tell "absent" from "unreadable" apart to decide between a silent
 * absence and an error state.
 */
export async function loadGraphConfig(): Promise<GraphConfig | null> {
  return (await loadGraphConfigState()).config;
}

export async function saveGraphConfig(config: GraphConfig): Promise<void> {
  await secureSet(
    SECURE_GRAPH_CONFIG_KEY,
    JSON.stringify({
      clientId: config.clientId.trim(),
      authority: config.authority.trim(),
    })
  );
}
```

Add `export * from "./graph-config.storage";` to `src/lib/storage/index.ts`.

- [ ] **Step 4: Add the `/odoo` connect section**

In `src/pages/odoo/index.tsx`, add a section below the existing Odoo credential block. It reuses the page's own `Status`/`okStatus`/`errorStatus`/`infoStatus` vocabulary rather than inventing a second one:

```tsx
// Two fields, exactly like Odoo's own: the user brings their own registration.
const [graph, setGraph] = useState<GraphConfig>({ clientId: "", authority: "" });
const [graphStatus, setGraphStatus] = useState<GraphStatus | null>(null);
const [graphMessage, setGraphMessage] = useState<Status | null>(null);

// Seeded on MOUNT, not only by handleConnect. Without this a user who
// connected in a previous session opens /odoo and sees no Disconnect button
// (it is gated on graphStatus?.connected) and no session-only banner - the page
// would claim they had never connected.
useEffect(() => {
  let cancelled = false;
  void (async () => {
    try {
      const status = await invoke<GraphStatus>("graph_status");
      if (!cancelled) setGraphStatus(status);
    } catch (err) {
      // A keychain that cannot be READ is a real failure, not "disconnected".
      if (!cancelled) setGraphMessage(errorStatus(reportGraphError(err, "calendar status").code));
    }
  })();
  return () => {
    cancelled = true;
  };
}, []);

/**
 * Tauri events broadcast to every window. The overlay's own
 * `useCalendarProposal` listens for this, because /odoo runs in the `dashboard`
 * webview and <Completion /> runs in `main` — without it, connecting here would
 * not make the proposal block appear over there until the app restarted, and
 * disconnecting here would leave the overlay believing it is still connected
 * and erroring on every open. Same shape as the existing
 * `odoo-instance-changed` broadcast this page already emits.
 */
const notifyCalendarConnectionChanged = () => emit("graph-connection-changed");

const handleConnect = async () => {
  const config = await (async () => {
    try {
      // INSIDE the try. Sitting outside it, a genuine secureSet write failure
      // was an unhandled rejection that set no message at all, unlike every
      // other failure path in this handler.
      await saveGraphConfig(graph);
      return await loadGraphConfigState();
    } catch (err) {
      setGraphMessage(errorStatus(reportGraphError(err, "save calendar config").code));
      return null;
    }
  })();
  if (config === null) return;
  if (config.state === "absent") {
    setGraphMessage(errorStatus("Enter the application (client) ID from your app registration."));
    return;
  }
  if (config.state === "unreadable") {
    setGraphMessage(
      errorStatus("The authority must be an https URL, e.g. " + DEFAULT_AUTHORITY)
    );
    return;
  }
  try {
    setGraphStatus(
      await invoke<GraphStatus>("graph_connect", {
        clientId: config.config.clientId,
        authority: config.config.authority,
      })
    );
    setGraphMessage(okStatus("Calendar connected."));
    void notifyCalendarConnectionChanged();
  } catch (err) {
    const report = reportGraphError(err, "connect calendar");
    // GRAPH_AUTH_CANCELLED is the commonest outcome of a loopback flow - the
    // user closed the tab or clicked Cancel. It returns the control to idle
    // with NO error styling.
    if (report.code === "GRAPH_AUTH_CANCELLED") {
      setGraphMessage(null);
      return;
    }
    setGraphMessage(
      report.code === "GRAPH_CONSENT_REQUIRED"
        ? infoStatus(
            `Your tenant requires administrator consent. Send an administrator this URL: ${config.config.authority}/adminconsent?client_id=${config.config.clientId}`
          )
        : report.code === "GRAPH_NO_KEYCHAIN"
          ? infoStatus(
              "No keychain service is available, so the connection lasts only until you quit. Nothing was written to disk."
            )
          : errorStatus(report.code)
    );
  }
};

/**
 * `graph_disconnect` is exposed by Task 11 and this is its ONLY caller. Without
 * it the command ships with nothing invoking it, and a user has no way to
 * revoke a stored credential from inside the app.
 *
 * The catch matters as much as the call: `graph_disconnect` clears memory
 * unconditionally and THEN propagates a keychain delete failure, so an error
 * here means "you are disconnected in this session, but the stored credential
 * survived on disk" — which the user needs told, not swallowed.
 */
const handleDisconnect = async () => {
  try {
    await invoke("graph_disconnect");
    setGraphStatus({ connected: false, sessionOnly: false });
    setGraphMessage(okStatus("Calendar disconnected."));
  } catch (err) {
    setGraphStatus({ connected: false, sessionOnly: false });
    const report = reportGraphError(err, "disconnect calendar");
    setGraphMessage(
      report.code === "GRAPH_NO_KEYCHAIN"
        ? errorStatus(
            "Disconnected in this session, but the stored credential could not be removed from the keychain. Remove it manually."
          )
        : errorStatus(report.code)
    );
  }
  void notifyCalendarConnectionChanged();
};
```

Imports this section needs, none of which the page already has:

```typescript
import { emit } from "@tauri-apps/api/event"; // already imported by this page
import { invoke } from "@tauri-apps/api/core";
import { reportGraphError } from "@/lib/calendar";
import {
  DEFAULT_AUTHORITY,
  loadGraphConfigState,
  saveGraphConfig,
  type GraphConfig,
} from "@/lib/storage/graph-config.storage";
import type { GraphStatus } from "@/types";
```

Render: the two inputs, a **Connect calendar** button, a **Disconnect** button (wired to `handleDisconnect`) shown only when `graphStatus?.connected`, the status line, and — when `graphStatus?.sessionOnly` — the plain sentence that this connection is session-only.

The `GRAPH_CONSENT_REQUIRED` remedy is **the admin-consent URL for the user's own client ID**, not a pointer at the client-ID fields: v1 ships no client ID, so they had already filled those in to reach this error at all.

- [ ] **Step 5: Run tests, lint and types**

Run: `npx vitest run src/tests/graph-config.storage.test.ts && npm run type-check && npm run lint`
Expected: PASS.

Barrel collision check — `src/lib/storage/index.ts` is a flat `export *`:

```bash
grep -rn "loadGraphConfig\|saveGraphConfig\|DEFAULT_AUTHORITY\|isHttpsUrl\|GraphConfig" src/lib src/types --include=*.ts | grep -v "graph-config.storage"
```
Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add src/lib/storage/graph-config.storage.ts src/lib/storage/index.ts src/pages/odoo/index.tsx src/tests/graph-config.storage.test.ts
git commit -m "feat(calendar): add Graph registration config and the connect section"
```

### Task 13: `useCalendarProposal` — orchestration and lifecycle

**Files:**
- Create: `src/hooks/useCalendarProposal.ts`
- Modify: `src/hooks/index.ts`
- Test: `src/tests/useCalendarProposal.test.tsx`

**Interfaces:**
- Consumes: `pickCurrentMeeting`, `participantsOf`, `matchAttendees` (Tasks 4–5), `toGraphError`, `CalendarProposalState`, `CandidateSummary` (Task 3), `loadGraphConfigState` (Task 12), `graph_status` / `graph_current_meetings` (Task 11).

  **It does NOT import `PickerCacheState` from `ContactPicker.tsx`.** It takes `contacts: OdooContact[] | null` instead — `null` meaning "cache not ready". That is not a style preference: importing a page's type into a hook, while the page imports this hook's state union back, is the closed cycle Task 3's placement note describes. The hook never needed the cache *variant*, only the contacts, so `<Completion />` narrows at the call site.
- Produces:
  - `UseCalendarProposalReturn = { present: boolean; state: CalendarProposalState; onPickCandidate: (eventId: string) => void; onRetry: () => void }`
  - `useCalendarProposal({ isPickerOpen, contacts, setCalendarBlockPresent })`

  Tasks 14 and 15 consume them.

**The query window is ±15 minutes and the acceptance window is narrower on purpose** — the pure function must see the events either side of the boundary rather than having them filtered away by the query.

- [ ] **Step 1: Write the failing test**

`src/tests/useCalendarProposal.test.tsx` — this hook orchestrates the whole feature and had no coverage in the spec's first draft; these are the cases that matter:

```tsx
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

const listeners = vi.hoisted(() => new Map<string, Set<(e: unknown) => void>>());
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, handler: (e: unknown) => void) => {
    const set = listeners.get(name) ?? new Set();
    set.add(handler);
    listeners.set(name, set);
    return () => set.delete(handler);
  }),
  emit: vi.fn(async () => {}),
}));

const config = vi.hoisted(() => ({
  loadGraphConfigState: vi.fn(async () => ({
    state: "complete" as const,
    config: { clientId: "c", authority: "https://login.microsoftonline.com/organizations" },
  })),
}));
vi.mock("@/lib/storage/graph-config.storage", () => config);

import { useCalendarProposal } from "@/hooks/useCalendarProposal";
import type { OdooContact } from "@/types";

const NOW = Date.UTC(2026, 8, 2, 14, 0, 0);
const MIN = 60_000;

function contact(id: number, email: string): OdooContact {
  return {
    id, name: `Contact ${id}`, email, phone: null, companyName: null, parentId: null,
    isCompany: false, active: true, writeDate: "2026-09-01 00:00:00",
    isColleague: false, lastMeetingAt: null,
  };
}

const CONTACTS: OdooContact[] = [contact(7, "cfo@acme.example")];

function meeting(id: string, subject: string) {
  return {
    id, subject, startMs: NOW - 5 * MIN, endMs: NOW + 25 * MIN,
    isCancelled: false, isAllDay: false, ownResponse: "accepted",
    participants: [
      { address: "me@corp.test", name: null, type: "required", isOrganizer: true },
      { address: "cfo@acme.example", name: "CFO", type: "required", isOrganizer: false },
    ],
  };
}

function mockGraph(events: unknown[]) {
  invoke.mockImplementation(async (cmd: string) => {
    if (cmd === "graph_status") return { connected: true, sessionOnly: false };
    if (cmd === "graph_current_meetings") return { ownAddress: "me@corp.test", events };
    throw new Error(`unexpected command ${cmd}`);
  });
}

function setup(over: Partial<Parameters<typeof useCalendarProposal>[0]> = {}) {
  const setCalendarBlockPresent = vi.fn();
  const props = { isPickerOpen: false, contacts: CONTACTS, setCalendarBlockPresent, ...over };
  const view = renderHook((p: typeof props) => useCalendarProposal(p), {
    initialProps: props,
  });
  return { ...view, setCalendarBlockPresent };
}

beforeEach(() => {
  vi.clearAllMocks();
  listeners.clear();
  vi.setSystemTime(NOW);
  config.loadGraphConfigState.mockResolvedValue({
    state: "complete",
    config: { clientId: "c", authority: "https://login.microsoftonline.com/organizations" },
  });
});

describe("presence", () => {
  // All three are known BEFORE the popover opens, so they route into
  // useCompletion's flag list and nothing is reserved. This is the common case
  // for the default v1 user and it must cost nothing.
  it("is statically absent when no calendar is connected", async () => {
    invoke.mockResolvedValue({ connected: false, sessionOnly: false });
    const { result, setCalendarBlockPresent } = setup();
    await waitFor(() => expect(result.current.present).toBe(false));
    expect(setCalendarBlockPresent).toHaveBeenLastCalledWith(false);
  });

  it("is statically absent while the contact cache is not ready", async () => {
    mockGraph([meeting("e1", "Sync")]);
    const { result } = setup({ contacts: null });
    await waitFor(() => expect(result.current.present).toBe(false));
  });

  it("is statically absent when the contact cache is empty", async () => {
    mockGraph([meeting("e1", "Sync")]);
    const { result } = setup({ contacts: [] });
    await waitFor(() => expect(result.current.present).toBe(false));
  });

  it("is present when connected with a populated cache", async () => {
    mockGraph([]);
    const { result, setCalendarBlockPresent } = setup();
    await waitFor(() => expect(result.current.present).toBe(true));
    expect(setCalendarBlockPresent).toHaveBeenLastCalledWith(true);
  });

  /**
   * A status read that FAILED is not "not connected". Collapsing the two makes
   * the feature vanish with nothing on screen, which looks exactly like never
   * having set it up - so a user with a momentarily unreadable keychain has no
   * way to tell the difference.
   */
  it("surfaces an unreadable connection state as an error, not a silent absence", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "graph_status") throw new Error("GRAPH_NO_KEYCHAIN");
      throw new Error(`unexpected command ${cmd}`);
    });
    const { result } = setup();
    await waitFor(() =>
      expect(result.current.state).toEqual({ kind: "error", code: "GRAPH_NO_KEYCHAIN" })
    );
    // Forced present: this is the one failure worth the reserved space.
    expect(result.current.present).toBe(true);
  });

  /**
   * What the hook RETURNS and what it PUBLISHES to useCompletion must be the
   * same value. `calendarBlockPresent` exists solely to sit in the resize
   * effect's dependency array, so a returned `true` alongside a published
   * `false` renders the 112px region with nothing re-running the resize.
   */
  it("publishes the same presence it returns, including on a status error", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "graph_status") throw new Error("GRAPH_NO_KEYCHAIN");
      throw new Error(`unexpected command ${cmd}`);
    });
    const { result, setCalendarBlockPresent } = setup();
    await waitFor(() => expect(result.current.present).toBe(true));
    expect(setCalendarBlockPresent).toHaveBeenLastCalledWith(true);
  });

  /**
   * `idle` renders nothing and the fetch is triggered from a PASSIVE effect, so
   * without deriving the loading state during render the region would be absent
   * for the commit the popover opens on and appear on the next one — the
   * footprint growing after open, in miniature.
   */
  it("reports loading on the very first render after the picker opens", async () => {
    // Never resolves: the state under test is the one before any response.
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "graph_status") return { connected: true, sessionOnly: false };
      return new Promise(() => {});
    });
    const { result, rerender } = setup();
    await waitFor(() => expect(result.current.present).toBe(true));

    rerender({ isPickerOpen: true, contacts: CONTACTS, setCalendarBlockPresent: vi.fn() });
    // Synchronously on the opening render - no await, no flush.
    expect(result.current.state).toEqual({ kind: "loading" });
  });

  // "Never set up" is the routine v1 state and must stay silent.
  it("stays silently absent when no client ID is configured", async () => {
    config.loadGraphConfigState.mockResolvedValue({ state: "absent", config: null });
    const { result } = setup();
    await waitFor(() => expect(result.current.present).toBe(false));
    expect(result.current.state).toEqual({ kind: "idle" });
  });

  /**
   * `/odoo` lives in the `dashboard` webview and this hook runs in `main`.
   * Without the cross-window listener, connecting there would not reach here
   * until an app restart, and disconnecting there would leave this window
   * erroring on every open.
   */
  it("re-reads the connection state when /odoo broadcasts a change", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "graph_status") return { connected: false, sessionOnly: false };
      throw new Error(`unexpected command ${cmd}`);
    });
    const { result } = setup();
    await waitFor(() => expect(result.current.present).toBe(false));

    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "graph_status") return { connected: true, sessionOnly: false };
      throw new Error(`unexpected command ${cmd}`);
    });
    await act(async () => {
      for (const handler of listeners.get("graph-connection-changed") ?? []) {
        handler({ payload: null });
      }
    });
    await waitFor(() => expect(result.current.present).toBe(true));
  });
});

describe("fetching", () => {
  /**
   * The race the frozen-`present` gate produced: open the picker before
   * `connected` and the contact cache have resolved, and the effect saw
   * `present === false`, returned, and — with `present` out of its dependency
   * array — never ran again. No block at all for the whole open session, not
   * even "Checking your calendar…", until the user closed and reopened.
   */
  it("still fetches when present resolves true AFTER the picker is already open", async () => {
    mockGraph([meeting("e1", "Sync")]);
    const props = { isPickerOpen: true, contacts: null as OdooContact[] | null, setCalendarBlockPresent: vi.fn() };
    const { result, rerender } = renderHook((p: typeof props) => useCalendarProposal(p), {
      initialProps: props,
    });
    // Cache not ready yet: nothing to fetch against.
    expect(invoke).not.toHaveBeenCalledWith("graph_current_meetings", expect.anything());

    rerender({ ...props, contacts: CONTACTS });
    await waitFor(() =>
      expect(result.current.state).toMatchObject({ kind: "proposal", subject: "Sync" })
    );
    // Exactly once, not once per render - the fetch-guard ref is what keeps
    // adding `present` to the deps from becoming a refetch loop.
    expect(
      invoke.mock.calls.filter(([cmd]) => cmd === "graph_current_meetings")
    ).toHaveLength(1);
  });

  it("does not call Graph until the picker opens", async () => {
    mockGraph([meeting("e1", "Sync")]);
    const { result, rerender } = setup();
    await waitFor(() => expect(result.current.present).toBe(true));
    expect(invoke).not.toHaveBeenCalledWith("graph_current_meetings", expect.anything());

    rerender({ isPickerOpen: true, contacts: CONTACTS, setCalendarBlockPresent: vi.fn() });
    await waitFor(() =>
      expect(result.current.state).toMatchObject({ kind: "proposal", subject: "Sync" })
    );
  });

  // Recomputed each time the picker opens - which covers the realistic case
  // (the calendar entry changing mid-meeting) without a watcher.
  it("recomputes on each open and not on a calendar-data change", async () => {
    mockGraph([meeting("e1", "Sync")]);
    const props = { isPickerOpen: true, contacts: CONTACTS, setCalendarBlockPresent: vi.fn() };
    const { rerender } = renderHook((p: typeof props) => useCalendarProposal(p), {
      initialProps: props,
    });
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("graph_current_meetings", expect.anything())
    );
    const afterFirstOpen = invoke.mock.calls.filter(
      ([cmd]) => cmd === "graph_current_meetings"
    ).length;

    // A NEW array reference with identical contents, while the picker stays
    // open. Rerendering with the SAME `contacts` reference could not fail this
    // test: `project`/`fetchNow` would keep their identity whatever the
    // dependency array said, so a future edit that put `contacts` back into the
    // fetch effect's deps would still pass. Changing the reference is what
    // actually exercises the rule.
    rerender({ ...props, contacts: [...CONTACTS] });
    expect(
      invoke.mock.calls.filter(([cmd]) => cmd === "graph_current_meetings")
    ).toHaveLength(afterFirstOpen);

    rerender({ ...props, contacts: [...CONTACTS, contact(8, "new@acme.example")] });
    expect(
      invoke.mock.calls.filter(([cmd]) => cmd === "graph_current_meetings")
    ).toHaveLength(afterFirstOpen);

    rerender({ ...props, isPickerOpen: false });
    rerender({ ...props, isPickerOpen: true });
    await waitFor(() =>
      expect(
        invoke.mock.calls.filter(([cmd]) => cmd === "graph_current_meetings").length
      ).toBe(afterFirstOpen + 1)
    );
  });

  it("moves from several survivors to a single proposal when one is picked", async () => {
    mockGraph([meeting("a", "Client sync"), meeting("b", "Standup")]);
    const props = { isPickerOpen: true, contacts: CONTACTS, setCalendarBlockPresent: vi.fn() };
    const { result } = renderHook((p: typeof props) => useCalendarProposal(p), {
      initialProps: props,
    });
    await waitFor(() => expect(result.current.state.kind).toBe("several"));

    act(() => result.current.onPickCandidate("b"));
    expect(result.current.state).toMatchObject({ kind: "proposal", subject: "Standup" });
  });

  it("reports no-meeting rather than an error when nothing is live", async () => {
    mockGraph([]);
    const props = { isPickerOpen: true, contacts: CONTACTS, setCalendarBlockPresent: vi.fn() };
    const { result } = renderHook((p: typeof props) => useCalendarProposal(p), {
      initialProps: props,
    });
    await waitFor(() => expect(result.current.state).toEqual({ kind: "no-meeting" }));
  });

  it("surfaces a GRAPH_* code as an error state", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "graph_status") return { connected: true, sessionOnly: false };
      throw new Error("GRAPH_BAD_RESPONSE");
    });
    const props = { isPickerOpen: true, contacts: CONTACTS, setCalendarBlockPresent: vi.fn() };
    const { result } = renderHook((p: typeof props) => useCalendarProposal(p), {
      initialProps: props,
    });
    await waitFor(() =>
      expect(result.current.state).toEqual({ kind: "error", code: "GRAPH_BAD_RESPONSE" })
    );
  });
});

describe("lifecycle", () => {
  // ContactPicker stays MOUNTED when the popover closes (ContactPicker.tsx:205-206),
  // so without an explicit reset the previous meeting's matches are what the
  // user sees on reopen - and the feature's own motivating case is the SAME
  // attendees recurring week to week.
  it("clears state on the open -> false transition", async () => {
    mockGraph([meeting("e1", "Sync")]);
    const props = { isPickerOpen: true, contacts: CONTACTS, setCalendarBlockPresent: vi.fn() };
    const { result, rerender } = renderHook((p: typeof props) => useCalendarProposal(p), {
      initialProps: props,
    });
    await waitFor(() => expect(result.current.state.kind).toBe("proposal"));

    rerender({ ...props, isPickerOpen: false });
    expect(result.current.state).toEqual({ kind: "idle" });
  });

  // An id from one instance names a DIFFERENT partner in another - the same
  // reason the matcher is instance-scoped.
  it("clears state on an Odoo instance change", async () => {
    mockGraph([meeting("e1", "Sync")]);
    const props = { isPickerOpen: true, contacts: CONTACTS, setCalendarBlockPresent: vi.fn() };
    const { result } = renderHook((p: typeof props) => useCalendarProposal(p), {
      initialProps: props,
    });
    await waitFor(() => expect(result.current.state.kind).toBe("proposal"));

    await act(async () => {
      for (const handler of listeners.get("odoo-instance-changed") ?? []) {
        handler({ payload: null });
      }
    });
    expect(result.current.state).toEqual({ kind: "idle" });
  });

  // React 19 StrictMode double-invokes effects, and a close-then-reopen can
  // leave two Graph calls in flight. Without a generation guard the OLDER
  // response overwrites the newer one.
  it("discards a superseded in-flight response", async () => {
    const resolvers: Array<(value: unknown) => void> = [];
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "graph_status") return { connected: true, sessionOnly: false };
      return new Promise((resolve) => resolvers.push(resolve));
    });
    const props = { isPickerOpen: true, contacts: CONTACTS, setCalendarBlockPresent: vi.fn() };
    const { result, rerender } = renderHook((p: typeof props) => useCalendarProposal(p), {
      initialProps: props,
    });
    await waitFor(() => expect(resolvers).toHaveLength(1));

    rerender({ ...props, isPickerOpen: false });
    rerender({ ...props, isPickerOpen: true });
    await waitFor(() => expect(resolvers).toHaveLength(2));

    // Second (current) request answers first, then the stale one answers.
    await act(async () => {
      resolvers[1]({ ownAddress: "me@corp.test", events: [meeting("new", "Newer")] });
      resolvers[0]({ ownAddress: "me@corp.test", events: [meeting("old", "Stale")] });
    });
    expect(result.current.state).toMatchObject({ kind: "proposal", subject: "Newer" });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/tests/useCalendarProposal.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the hook**

`src/hooks/useCalendarProposal.ts`:

```typescript
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
// `GraphErrorCode` is a type-only import alongside the others below.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  matchAttendees,
  participantsOf,
  pickCurrentMeeting,
  toGraphError,
} from "@/lib/calendar";
import { loadGraphConfigState } from "@/lib/storage/graph-config.storage";
import type {
  CalendarEvent,
  CalendarProposalState,
  CandidateSummary,
  CurrentMeetings,
  GraphErrorCode,
  GraphStatus,
  OdooContact,
} from "@/types";

/** Deliberately WIDER than the acceptance window in current-meeting.ts, so the
 * pure function sees the events either side of the boundary rather than having
 * them filtered away by the query. */
const QUERY_WINDOW_MS = 15 * 60 * 1000;

/**
 * Module scope, so the derived loading state below is referentially stable. A
 * fresh `{ kind: "loading" }` per render would change `calendarProps`'s
 * identity and defeat `ContactPicker`'s memo.
 */
const LOADING_STATE: CalendarProposalState = { kind: "loading" };

// `CalendarProposalState` and `CandidateSummary` are imported from @/types, not
// declared here - see the placement note in src/types/calendar.ts.

export interface UseCalendarProposalReturn {
  present: boolean;
  state: CalendarProposalState;
  onPickCandidate: (eventId: string) => void;
  onRetry: () => void;
}

function summarize(event: CalendarEvent): CandidateSummary {
  return { id: event.id, subject: event.subject, startMs: event.startMs, endMs: event.endMs };
}

export function useCalendarProposal({
  isPickerOpen,
  contacts,
  setCalendarBlockPresent,
}: {
  isPickerOpen: boolean;
  /**
   * The synced contact cache, or `null` while it is not ready. Deliberately NOT
   * `PickerCacheState`: this hook never needed the cache variant, only the
   * rows, and importing a page's type here (while that page imports this hook's
   * state union back) closes the dependency cycle Task 3's note describes.
   */
  contacts: OdooContact[] | null;
  /**
   * useCompletion owns the slot; this hook writes into it. Mirrors
   * setTargetCount exactly (useCompletion.ts:143), and for the same reason:
   * useCompletion runs BEFORE this hook in <Completion />, so it cannot read
   * the value off this hook's return - only own a slot this one fills.
   */
  setCalendarBlockPresent: (present: boolean) => void;
}): UseCalendarProposalReturn {
  const [connected, setConnected] = useState(false);
  /** Non-null when the connection state itself could not be read. */
  const [statusError, setStatusError] = useState<GraphErrorCode | null>(null);
  const [state, setState] = useState<CalendarProposalState>({ kind: "idle" });
  /** Every resolved fetch checks this before writing. A close/reopen or an
   * instance change bumps it, so a superseded response is discarded rather
   * than overwriting a newer one. */
  const generation = useRef(0);
  /** The last fetch's raw events, so picking a candidate needs no second call. */
  const eventsRef = useRef<CalendarEvent[]>([]);
  const ownAddressRef = useRef<string | null>(null);

  const rows = contacts ?? [];
  // All three inputs are known BEFORE the popover opens. That is what makes
  // this the STATIC absence the resize effect can route on.
  const present = connected && rows.length > 0;

  /**
   * ONE value, published to `useCompletion` AND returned to the caller.
   *
   * They must not diverge. Publishing the computed `present` while returning a
   * forced `true` for the error case would render the 112px region while
   * `calendarBlockPresent` stayed false — and that flag's ONLY job is to sit in
   * the resize effect's dependency array, so nothing would re-run the resize.
   * A status read failing or recovering while the picker is open would then
   * change the footprint with no resize behind it, which is precisely the case
   * the static/dynamic split exists to cover.
   *
   * A failed status read forces the block present because it is the one failure
   * worth the reserved space: the alternative is the feature silently vanishing.
   */
  const blockPresent = statusError !== null || present;

  useEffect(() => {
    setCalendarBlockPresent(blockPresent);
  }, [blockPresent, setCalendarBlockPresent]);

  /**
   * Read the connection state. Runs on mount AND whenever the /odoo page
   * broadcasts a change.
   *
   * The two failure branches are deliberately DIFFERENT. A config that is
   * absent means "never set up", which is the routine v1 state and must stay
   * silent — the block is statically absent and the picker is exactly what it
   * is today. A config that is UNREADABLE, or a `graph_status` that throws,
   * means something is genuinely broken; swallowing that into `connected =
   * false` makes the whole feature disappear with nothing on screen to explain
   * it, which is indistinguishable from never having set it up.
   */
  const readStatus = useCallback(async () => {
    const config = await loadGraphConfigState();
    if (config.state === "absent") {
      setConnected(false);
      setStatusError(null);
      return;
    }
    if (config.state === "unreadable") {
      setConnected(false);
      // GRAPH_AUTH_REJECTED, not GRAPH_NOT_CONNECTED. Task 12 drew the
      // absent/unreadable distinction precisely so a bad stored config is
      // distinguishable from a disconnected account, and collapsing it back to
      // the disconnected code here would throw that away at the last step: the
      // user reads "not connected" for a config that IS there but invalid, and
      // Try again re-reads the same bad value forever. AUTH_REJECTED matches
      // what Rust's own `validate_authority` returns for the same input.
      setStatusError("GRAPH_AUTH_REJECTED");
      return;
    }
    try {
      const status = await invoke<GraphStatus>("graph_status");
      setConnected(status.connected);
      setStatusError(null);
    } catch (err) {
      setConnected(false);
      setStatusError(toGraphError(err).code);
    }
  }, []);

  useEffect(() => {
    void readStatus();
  }, [readStatus]);

  /**
   * `/odoo` runs in the `dashboard` webview; `<Completion />` runs in `main`.
   * Without this listener, connecting on that page would not make the block
   * appear here until the app restarted, and disconnecting there would leave
   * this window believing it is connected — so every open would produce a
   * GRAPH_NOT_CONNECTED error state. Same cross-window pattern the picker
   * already uses for `odoo-instance-changed`.
   */
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen("graph-connection-changed", () => void readStatus()).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, [readStatus]);

  const reset = useCallback(() => {
    generation.current += 1;
    eventsRef.current = [];
    ownAddressRef.current = null;
    setState({ kind: "idle" });
  }, []);

  // Same listener the picker's own hook uses: an id from one instance names a
  // different partner in another.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen("odoo-instance-changed", () => reset()).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, [reset]);

  const project = useCallback(
    (events: CalendarEvent[], ownAddress: string | null, forcedId?: string) => {
      const forced = forcedId === undefined ? null : events.find((e) => e.id === forcedId) ?? null;
      const picked = forced !== null
        ? ({ kind: "one", event: forced } as const)
        : pickCurrentMeeting(events, Date.now());
      if (picked.kind === "none") return { kind: "no-meeting" } as const;
      if (picked.kind === "several") {
        return { kind: "several", candidates: picked.candidates.map(summarize) } as const;
      }
      const result = matchAttendees({
        participants: participantsOf(picked.event),
        contacts: rows,
        ownAddress,
      });
      return {
        kind: "proposal",
        eventId: picked.event.id,
        subject: picked.event.subject,
        matched: result.matched,
        unmatched: result.unmatched,
      } as const;
    },
    [rows]
  );

  const fetchNow = useCallback(async () => {
    // BEFORE any await, all three of them:
    //
    // - `setState({ kind: "loading" })` — setting it AFTER the config round
    //   trip left `idle` rendering `null` for however long plugin-store took,
    //   so the block appeared well after open and grew the popover's footprint.
    //   This effect is PASSIVE, so this alone still cannot cover the commit the
    //   popover opens on; `visibleState` below derives `loading` during render
    //   for exactly that commit. Between the two, the region is on screen from
    //   the first render and its footprint never changes — which is what the
    //   Global Constraints require and why the static/dynamic split exists.
    // - the generation bump, so ordering is decided by call order rather than
    //   by which config load happens to resolve first.
    generation.current += 1;
    const mine = generation.current;
    setState({ kind: "loading" });

    const config = await loadGraphConfigState();
    if (config.state !== "complete") {
      if (mine === generation.current) {
        // Same code `readStatus` uses for the same condition: an invalid stored
        // config is a rejected authority, not a disconnected account.
        setState(
          config.state === "absent"
            ? { kind: "idle" }
            : { kind: "error", code: "GRAPH_AUTH_REJECTED" }
        );
      }
      return;
    }
    const now = Date.now();
    try {
      const response = await invoke<CurrentMeetings>("graph_current_meetings", {
        clientId: config.config.clientId,
        authority: config.config.authority,
        startIso: new Date(now - QUERY_WINDOW_MS).toISOString(),
        endIso: new Date(now + QUERY_WINDOW_MS).toISOString(),
      });
      if (mine !== generation.current) return;
      eventsRef.current = response.events;
      ownAddressRef.current = response.ownAddress;
      setState(project(response.events, response.ownAddress));
    } catch (err) {
      if (mine !== generation.current) return;
      setState({ kind: "error", code: toGraphError(err).code });
    }
  }, [project]);

  /**
   * Recomputed each time the picker OPENS — not on a calendar-data change,
   * which would need a watcher for a case that reopening already covers.
   *
   * `present` IS in the dependency array, and that is load-bearing rather than
   * lint appeasement. It is composed of two values that resolve asynchronously
   * after mount (`connected`, and the contact cache). With `[isPickerOpen]`
   * alone, opening the picker shortly after launch evaluated `present` as false,
   * returned, and — because nothing re-ran the effect when `present` later
   * flipped true — never fetched at all for that whole open session. The user
   * saw no block, not even "Checking your calendar…", until they closed and
   * reopened.
   *
   * `hasFetched` is what keeps that from becoming a refetch loop: `present` can
   * only transition false -> true once per open, and the ref makes the second
   * pass a no-op, so this still fetches exactly once per open. `fetchNow` stays
   * out of the deps deliberately — it changes identity with `project`, which
   * changes with `contacts`, and re-running on that IS the calendar-data
   * refetch the spec rules out.
   */
  const hasFetched = useRef(false);
  useEffect(() => {
    if (!isPickerOpen) {
      hasFetched.current = false;
      reset();
      return;
    }
    if (!present || hasFetched.current) return;
    hasFetched.current = true;
    void fetchNow();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPickerOpen, present]);

  const onPickCandidate = useCallback(
    (eventId: string) => {
      setState(project(eventsRef.current, ownAddressRef.current, eventId));
    },
    [project]
  );

  const onRetry = useCallback(() => {
    void fetchNow();
  }, [fetchNow]);

  /**
   * A status read that FAILED outranks whatever the proposal state happens to
   * be. Without this the hook reports the same absence for an unreadable
   * keychain as for "never configured", and the feature vanishes silently
   * instead of saying what went wrong.
   *
   * Both of these are memoized, and that is not tidiness. `<Completion />`
   * feeds `state` and `onRetry` into the `calendarProps` useMemo that keeps
   * `ContactPicker`'s `React.memo` intact; a fresh object literal and a fresh
   * arrow here would change identity every render, so the memo would recompute
   * every render and the picker would re-render on every streamed AI token —
   * reintroducing the exact defect the memo was added to fix, and doing it for
   * the whole session because `blockPresent` is forced true in this branch.
   */
  const retryStatus = useCallback(() => void readStatus(), [readStatus]);
  const errorState = useMemo<CalendarProposalState>(
    () => ({ kind: "error", code: statusError ?? "GRAPH_NETWORK" }),
    [statusError]
  );

  /**
   * `idle` renders nothing, and `fetchNow` sets `loading` from a PASSIVE
   * effect — so on the commit where `isPickerOpen` flips true the state is
   * still `idle` and the region is absent for exactly one commit, after which
   * it appears. That is the footprint growing after open, in miniature.
   *
   * Deriving the loading state during render closes that commit. It is not the
   * same as setting it in the effect: this is what is on screen for the render
   * the popover opens on.
   */
  const visibleState =
    isPickerOpen && blockPresent && state.kind === "idle" ? LOADING_STATE : state;

  if (statusError !== null) {
    return {
      present: blockPresent,
      state: errorState,
      onPickCandidate,
      onRetry: retryStatus,
    };
  }

  return { present: blockPresent, state: visibleState, onPickCandidate, onRetry };
}
```

Add `export * from "./useCalendarProposal";` to `src/hooks/index.ts`.

- [ ] **Step 4: Run tests, lint and types**

Run: `npx vitest run src/tests/useCalendarProposal.test.tsx && npm run type-check && npm run lint`
Expected: PASS.

Barrel collision check — `src/hooks/index.ts` is a flat `export *`:

```bash
grep -rn "useCalendarProposal\|UseCalendarProposalReturn" src/hooks --include=*.ts* \
  | grep -v "^src/hooks/useCalendarProposal.ts\|^src/hooks/index.ts"
```
Expected: no output. Both exclusions are needed: Step 3 adds `export * from "./useCalendarProposal";` to `src/hooks/index.ts`, and that line contains the name — filtering only on `useCalendarProposal.ts` would never match it, so the check would report a false collision every time and be quietly ignored thereafter.

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useCalendarProposal.ts src/hooks/index.ts src/tests/useCalendarProposal.test.tsx
git commit -m "feat(calendar): orchestrate the proposal with useCalendarProposal"
```

### Task 14: `CalendarProposal.tsx` — the slot rule and the sequential write

**Files:**
- Create: `src/pages/app/components/completion/CalendarProposal.tsx`
- Test: `src/tests/CalendarProposal.slots.test.tsx`, `src/tests/CalendarProposal.states.test.tsx`

**Interfaces:**
- Consumes: `CalendarProposalState` (Task 3, via `@/types` — **not** from the hook; see the placement note in `src/types/calendar.ts`), `MAX_TARGETS` (`src/lib/odoo/meeting-log.ts:66`), `compareContacts`-style ordering, `SelectedTargets` / `SelectedTarget`.
- Produces: `CalendarProposalProps`, `CalendarProposal` (a props-only component — it fetches nothing). Task 15 renders it.

- [ ] **Step 1: Write the failing tests**

`src/tests/CalendarProposal.slots.test.tsx` — the slot rule, **not a bare match count**. Every case pre-populates `targets`, because stubbing a blanket cap rejection would pass against exactly the match-count rule the review corrected:

```tsx
import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CalendarProposal } from "@/pages/app/components/completion/CalendarProposal";
import { MAX_TARGETS } from "@/lib/odoo";
import type { OdooContact, SelectedTargets } from "@/types";

function contact(id: number, over: Partial<OdooContact> = {}): OdooContact {
  return {
    id, name: `Person ${id}`, email: `p${id}@acme.example`, phone: null,
    companyName: null, parentId: null, isCompany: false, active: true,
    writeDate: "2026-09-01 00:00:00", isColleague: false, lastMeetingAt: null,
    ...over,
  };
}

function matched(contacts: OdooContact[]) {
  return contacts.map((c) => ({
    participant: { address: c.email!, name: c.name, type: "required" as const, isOrganizer: false },
    contact: c,
  }));
}

function target(resId: number): SelectedTargets[number] {
  return { model: "res.partner", resId, name: `Person ${resId}` };
}

function renderProposal({
  contacts,
  targets = [],
  onAddTarget = vi.fn(async () => ({ ok: true })),
  unmatched = [],
}: {
  contacts: OdooContact[];
  targets?: SelectedTargets;
  onAddTarget?: (t: SelectedTargets[number]) => Promise<{ ok: boolean; reason?: "cap" }>;
  unmatched?: { participant: { address: string; name: string | null; type: "required"; isOrganizer: false }; reason: "no-contact" | "archived" }[];
}) {
  render(
    <CalendarProposal
      state={{
        kind: "proposal",
        eventId: "e1",
        subject: "Client sync",
        matched: matched(contacts),
        unmatched,
      }}
      targets={targets}
      onAddTarget={onAddTarget}
      onPickCandidate={vi.fn()}
      onRetry={vi.fn()}
    />
  );
  return { onAddTarget };
}

describe("slot rule", () => {
  it("pre-checks every writable match when they fit the free slots", async () => {
    // 3 matches, 1 target already selected -> 4 free slots. All fit.
    renderProposal({ contacts: [contact(1), contact(2), contact(3)], targets: [target(9)] });
    for (const id of [1, 2, 3]) {
      expect(screen.getByTestId(`calendar-proposal-row-${id}`)).toBeChecked();
    }
    expect(screen.getByTestId("calendar-proposal-confirm")).toHaveTextContent("Add 3 to log");
  });

  // Auto-selecting an arbitrary subset is precisely the wrong-record risk this
  // feature exists to avoid, and the cap makes some choice unavoidable - so
  // the choice is the user's.
  it("pre-checks nothing when writable matches exceed free slots", () => {
    const contacts = Array.from({ length: 8 }, (_, i) => contact(i + 1));
    renderProposal({ contacts, targets: [target(90), target(91), target(92)] });
    for (const c of contacts) {
      expect(screen.getByTestId(`calendar-proposal-row-${c.id}`)).not.toBeChecked();
    }
    // The copy names the REAL remaining count, not MAX_TARGETS. "Pick up to
    // five" when two slots remain is a promise the database will break.
    const notice = screen.getByTestId("calendar-proposal-notice").textContent ?? "";
    expect(notice).toContain("8 attendees matched");
    expect(notice).toContain("2 slots left");
    expect(notice).not.toContain(String(MAX_TARGETS));
  });

  it("offers nothing checkable when there are no free slots", () => {
    const full = Array.from({ length: MAX_TARGETS }, (_, i) => target(80 + i));
    renderProposal({ contacts: [contact(1)], targets: full });
    expect(screen.getByTestId("calendar-proposal-row-1")).toBeDisabled();
    expect(screen.getByTestId("calendar-proposal-notice")).toHaveTextContent(/full/i);
    expect(screen.queryByTestId("calendar-proposal-confirm")).toBeNull();
  });

  // Re-upserting an already-selected row would overwrite its conversation_id
  // (possibly to null) and its selected_at, reordering loadTargets - silently
  // rewriting a row the user chose by hand.
  it("renders an already-selected match as selected and excludes it from the write", async () => {
    const { onAddTarget } = renderProposal({
      contacts: [contact(1), contact(2)],
      targets: [target(1)],
    });
    expect(screen.getByTestId("calendar-proposal-row-1")).toBeDisabled();
    expect(screen.getByTestId("calendar-proposal-selected-1")).toBeInTheDocument();
    expect(screen.getByTestId("calendar-proposal-confirm")).toHaveTextContent("Add 1 to log");

    await userEvent.click(screen.getByTestId("calendar-proposal-confirm"));
    await waitFor(() => expect(onAddTarget).toHaveBeenCalledTimes(1));
    expect(onAddTarget).toHaveBeenCalledWith({ model: "res.partner", resId: 2, name: "Person 2" });
  });

  it("orders by lastMeetingAt descending, nulls last, ties by name", () => {
    renderProposal({
      contacts: [
        contact(1, { name: "Zoe", lastMeetingAt: null }),
        contact(2, { name: "Adam", lastMeetingAt: null }),
        contact(3, { name: "Recent", lastMeetingAt: 5_000 }),
        contact(4, { name: "Older", lastMeetingAt: 1_000 }),
      ],
    });
    const rendered = screen
      .getAllByTestId(/^calendar-proposal-label-/)
      .map((n) => n.textContent);
    expect(rendered).toEqual(["Recent", "Older", "Adam", "Zoe"]);
  });
});

describe("the write", () => {
  it("calls onAddTarget once per checked row", async () => {
    const { onAddTarget } = renderProposal({ contacts: [contact(1), contact(2), contact(3)] });
    await userEvent.click(screen.getByTestId("calendar-proposal-row-2")); // uncheck
    await userEvent.click(screen.getByTestId("calendar-proposal-confirm"));
    await waitFor(() => expect(onAddTarget).toHaveBeenCalledTimes(2));
    expect(onAddTarget.mock.calls.map(([t]) => t.resId)).toEqual([1, 3]);
  });

  /**
   * addSelectedTarget is a non-atomic select-then-upsert with no transaction
   * (odoo-contacts.action.ts:319-331), and this is its first BULK caller.
   * Issued concurrently, every call's count runs before any insert commits and
   * more than MAX_TARGETS rows land.
   *
   * This asserts OVERLAP, not call order: a Promise.all would still produce
   * calls in array order, so asserting the order alone would pass against the
   * exact defect. The gate is that no second call starts before the first
   * resolves.
   */
  it("issues the writes sequentially, never concurrently", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const onAddTarget = vi.fn(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return { ok: true };
    });
    renderProposal({ contacts: [contact(1), contact(2), contact(3)], onAddTarget });
    await userEvent.click(screen.getByTestId("calendar-proposal-confirm"));
    await waitFor(() => expect(onAddTarget).toHaveBeenCalledTimes(3));
    expect(maxInFlight).toBe(1);
  });

  /**
   * The regression the static-`targets` tests above cannot see.
   *
   * In production every successful `onAddTarget` updates the parent's `targets`,
   * so this test re-renders with the grown list exactly as `<Completion />`
   * would. Without the `writingRef` guard on the pre-check effect, the row the
   * user UNCHECKED gets re-checked mid-write and written anyway - a write to
   * odoo_selected_targets they never authorised, which is the one thing the
   * confirm gate exists to prevent.
   */
  it("never writes a row the user unchecked, even as targets grow mid-write", async () => {
    const contacts = [contact(1), contact(2), contact(3)];
    const added: number[] = [];
    let live: SelectedTargets = [];

    function Harness() {
      const [targets, setTargets] = React.useState<SelectedTargets>([]);
      live = targets;
      return (
        <CalendarProposal
          state={{
            kind: "proposal",
            eventId: "e1",
            subject: "Client sync",
            matched: matched(contacts),
            unmatched: [],
          }}
          targets={targets}
          onAddTarget={async (t) => {
            added.push(t.resId);
            // Exactly what useOdooTarget.addTarget does on success.
            setTargets((prev) => [...prev, t]);
            return { ok: true };
          }}
          onPickCandidate={vi.fn()}
          onRetry={vi.fn()}
        />
      );
    }

    render(<Harness />);
    // The user deliberately excludes Person 2.
    await userEvent.click(screen.getByTestId("calendar-proposal-row-2"));
    expect(screen.getByTestId("calendar-proposal-confirm")).toHaveTextContent("Add 2 to log");

    await userEvent.click(screen.getByTestId("calendar-proposal-confirm"));
    await waitFor(() => expect(added).toHaveLength(2));
    expect(added).toEqual([1, 3]);
    expect(live.map((t) => t.resId)).toEqual([1, 3]);
  });

  // The action-layer cap remains the backstop; a rejection is SURFACED, never
  // swallowed.
  it("stops at the first cap rejection and names what was and was not written", async () => {
    const onAddTarget = vi.fn(async (t: { resId: number }) =>
      t.resId === 2 ? { ok: false, reason: "cap" as const } : { ok: true }
    );
    renderProposal({ contacts: [contact(1), contact(2), contact(3)], onAddTarget });
    await userEvent.click(screen.getByTestId("calendar-proposal-confirm"));
    await waitFor(() => expect(onAddTarget).toHaveBeenCalledTimes(2));
    const message = await screen.findByTestId("calendar-proposal-write-result");
    // Assert the SPLIT, not just that each name appears somewhere: checking
    // only for presence would pass even if Person 1 were reported as not
    // written.
    expect(message).toHaveTextContent("Added Person 1");
    expect(message).toHaveTextContent(/The log is full, so Person 2, Person 3 were not added/);
  });

  /**
   * `useOdooTarget.addTarget` returns a bare `{ ok: false }` from its catch for
   * ANY thrown error - a busy database, ODOO_NOT_CONFIGURED - and has already
   * toasted the real cause. Reporting that as "the log is full" contradicts the
   * toast and sends the user to remove destinations that were never the problem.
   */
  it("does not blame the cap for a failure that carries no cap reason", async () => {
    const onAddTarget = vi.fn(async (t: { resId: number }) =>
      t.resId === 2 ? { ok: false } : { ok: true }
    );
    renderProposal({ contacts: [contact(1), contact(2), contact(3)], onAddTarget });
    await userEvent.click(screen.getByTestId("calendar-proposal-confirm"));
    const message = await screen.findByTestId("calendar-proposal-write-result");
    expect(message).toHaveTextContent(/Something went wrong/);
    expect(message).not.toHaveTextContent(/log is full/i);
  });

  /**
   * `<Completion />` force-closes the picker when a meeting-log hold begins,
   * and this component stays MOUNTED across that. With no reset path, `writing`
   * stayed true forever and the confirm button was dead on every later open.
   */
  it("clears in-flight state when the popover closes", async () => {
    const { rerender } = render(
      <CalendarProposal
        state={{
          kind: "proposal",
          eventId: "e1",
          subject: "Client sync",
          matched: matched([contact(1)]),
          unmatched: [],
        }}
        targets={[]}
        onAddTarget={vi.fn(async () => ({ ok: false, reason: "cap" as const }))}
        onPickCandidate={vi.fn()}
        onRetry={vi.fn()}
      />
    );
    await userEvent.click(screen.getByTestId("calendar-proposal-confirm"));
    await screen.findByTestId("calendar-proposal-write-result");

    const closed = (
      <CalendarProposal
        state={{ kind: "idle" }}
        targets={[]}
        onAddTarget={vi.fn(async () => ({ ok: true }))}
        onPickCandidate={vi.fn()}
        onRetry={vi.fn()}
      />
    );
    rerender(closed);
    expect(screen.queryByTestId("calendar-proposal-region")).toBeNull();

    // Reopened for a later meeting: the confirm control is live again, and no
    // stale failure message survives.
    rerender(
      <CalendarProposal
        state={{
          kind: "proposal",
          eventId: "e2",
          subject: "Another meeting",
          matched: matched([contact(4)]),
          unmatched: [],
        }}
        targets={[]}
        onAddTarget={vi.fn(async () => ({ ok: true }))}
        onPickCandidate={vi.fn()}
        onRetry={vi.fn()}
      />
    );
    expect(screen.getByTestId("calendar-proposal-confirm")).toBeEnabled();
    expect(screen.queryByTestId("calendar-proposal-write-result")).toBeNull();
  });
});
```

`src/tests/CalendarProposal.states.test.tsx` — the non-proposal states, **including the two the P1 review flagged as missing** (the several-survivors candidate list and the greyed unmatched rows):

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CalendarProposal } from "@/pages/app/components/completion/CalendarProposal";
import type { CalendarProposalState } from "@/types";

function renderState(state: CalendarProposalState, over = {}) {
  const handlers = {
    onPickCandidate: vi.fn(),
    onRetry: vi.fn(),
    onAddTarget: vi.fn(async () => ({ ok: true })),
    ...over,
  };
  render(<CalendarProposal state={state} targets={[]} {...handlers} />);
  return handlers;
}

const MIN = 60_000;
const NOW = Date.UTC(2026, 8, 2, 14, 0, 0);

describe("several survivors", () => {
  // Do not guess. One row per candidate meeting, subject and start-end time.
  it("lists one row per candidate with its subject and time", () => {
    renderState({
      kind: "several",
      candidates: [
        { id: "a", subject: "Client sync", startMs: NOW, endMs: NOW + 30 * MIN },
        { id: "b", subject: null, startMs: NOW + 5 * MIN, endMs: NOW + 35 * MIN },
      ],
    });
    expect(screen.getByTestId("calendar-candidate-a")).toHaveTextContent("Client sync");
    // An untitled event is a real event; the row still has to name a time.
    expect(screen.getByTestId("calendar-candidate-b")).toHaveTextContent(/untitled/i);
    expect(screen.getAllByTestId(/^calendar-candidate-/)).toHaveLength(2);
  });

  it("picking a candidate reports it to the hook", async () => {
    const { onPickCandidate } = renderState({
      kind: "several",
      candidates: [{ id: "a", subject: "Client sync", startMs: NOW, endMs: NOW + 30 * MIN }],
    });
    await userEvent.click(screen.getByTestId("calendar-candidate-a"));
    expect(onPickCandidate).toHaveBeenCalledWith("a");
  });
});

describe("unmatched attendees", () => {
  // Never silently dropped: silent dropping is how a user fails to notice that
  // the one person who mattered is missing from the list.
  it("shows unmatched attendees greyed and labelled, with no add control", () => {
    renderState({
      kind: "proposal",
      eventId: "e1",
      subject: "Client sync",
      matched: [],
      unmatched: [
        {
          participant: { address: "new@acme.example", name: "New Person", type: "required", isOrganizer: false },
          reason: "no-contact",
        },
        {
          participant: { address: "old@acme.example", name: "Archived Person", type: "required", isOrganizer: false },
          reason: "archived",
        },
      ],
    });
    expect(screen.getAllByTestId(/^calendar-unmatched-/)).toHaveLength(2);
    // The two reasons render DIFFERENTLY. Telling the user there is "no Odoo
    // contact" for a partner who is merely archived would send them off to
    // create a duplicate of a record they already have.
    expect(screen.getByTestId("calendar-unmatched-new@acme.example")).toHaveTextContent(
      /no odoo contact/i
    );
    expect(screen.getByTestId("calendar-unmatched-old@acme.example")).toHaveTextContent(
      /archived in odoo/i
    );
    // Greyed, and there is no create-contact action anywhere in this block.
    expect(screen.queryByRole("button", { name: /create/i })).toBeNull();
    expect(screen.queryByTestId("calendar-proposal-row-0")).toBeNull();
  });
});

describe("other states", () => {
  it.each([
    ["loading", { kind: "loading" } as const],
    ["no-meeting", { kind: "no-meeting" } as const],
  ])("renders the reserved region for %s", (_label, state) => {
    renderState(state);
    expect(screen.getByTestId("calendar-proposal-region")).toBeInTheDocument();
  });

  it("renders nothing at all when idle", () => {
    renderState({ kind: "idle" });
    expect(screen.queryByTestId("calendar-proposal-region")).toBeNull();
  });

  it("offers a retry on an error", async () => {
    const { onRetry } = renderState({ kind: "error", code: "GRAPH_NETWORK" });
    await userEvent.click(screen.getByTestId("calendar-proposal-retry"));
    expect(onRetry).toHaveBeenCalled();
  });

  it("never renders a token or a raw error message", () => {
    renderState({ kind: "error", code: "GRAPH_AUTH_REJECTED" });
    expect(screen.getByTestId("calendar-proposal-region").textContent ?? "").not.toMatch(/eyJ/);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/tests/CalendarProposal.slots.test.tsx src/tests/CalendarProposal.states.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the component**

`src/pages/app/components/completion/CalendarProposal.tsx`:

```tsx
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components";
import { MAX_TARGETS } from "@/lib/odoo";
// From @/types, NOT from the hook - see the placement note in
// src/types/calendar.ts. A page importing a type back out of a hook that
// depends on that page is the cycle this avoids.
import type {
  CalendarProposalState,
  OdooContact,
  SelectedTarget,
  SelectedTargets,
} from "@/types";

/**
 * FIXED height, not max-height.
 *
 * resizeWindow(true) is driven by a fixed flag list observed when the popover
 * OPENS, not by measured content height, and it is the only thing that grows a
 * window tauri.conf.json pins at 600x54 with "resizable": false. The proposal
 * arrives AFTER the popover opens because the Graph call is async, so content
 * that appears later has nothing to grow the window around it.
 *
 * A max-height would still let the footprint differ between two rows and
 * twelve. A fixed height with internal scrolling is what actually delivers the
 * identical-footprint rule the spec states in the same paragraph.
 */
const REGION_CLASS = "h-28 overflow-y-auto border-b pb-2 flex flex-col gap-1";

export interface CalendarProposalProps {
  state: CalendarProposalState;
  /** The live multi-target list. Free slots are counted from THIS, not from
   * the match count: targets picked by hand before the proposal ran consume
   * slots (odoo-contacts.action.ts:279 countOthers). */
  targets: SelectedTargets;
  /**
   * ContactPicker's existing prop, owned by useOdooTarget. NOT
   * addSelectedTarget: calling the database layer from a component would
   * bypass the hook that owns `targets`, leaving the picker's own list, its
   * atCap at ContactPicker.tsx:284 and the "Logging to" box stale.
   */
  onAddTarget: (t: SelectedTarget) => Promise<{ ok: boolean; reason?: "cap" }>;
  onPickCandidate: (eventId: string) => void;
  onRetry: () => void;
}

/** lastMeetingAt descending, nulls last, ties by name. The field is nullable
 * (types/odoo.ts:37) and a contact never logged to must not sort ahead of one
 * that was. */
function byRecency(a: OdooContact, b: OdooContact): number {
  if (a.lastMeetingAt !== b.lastMeetingAt) {
    if (a.lastMeetingAt === null) return 1;
    if (b.lastMeetingAt === null) return -1;
    return b.lastMeetingAt - a.lastMeetingAt;
  }
  return a.name.localeCompare(b.name);
}

function timeRange(startMs: number, endMs: number): string {
  const fmt = (ms: number) =>
    new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return `${fmt(startMs)}–${fmt(endMs)}`;
}

export function CalendarProposal({
  state,
  targets,
  onAddTarget,
  onPickCandidate,
  onRetry,
}: CalendarProposalProps) {
  const [checked, setChecked] = useState<ReadonlySet<number>>(new Set());
  const [writeResult, setWriteResult] = useState<string | null>(null);
  const [writing, setWriting] = useState(false);
  /**
   * The same fact as `writing`, in a ref, because two different consumers need
   * it at two different times:
   *
   * - the reset effect below reads it DURING the write, and a state read there
   *   is a render-time snapshot that can lag the loop;
   * - `confirm` reads it to refuse re-entry, and the button's `disabled` alone
   *   only covers repeat clicks on that one control.
   */
  const writingRef = useRef(false);

  const proposal = state.kind === "proposal" ? state : null;

  const { rows, writable, freeSlots } = useMemo(() => {
    const sorted = (proposal?.matched ?? [])
      .slice()
      .sort((a, b) => byRecency(a.contact, b.contact));
    const isSelected = (id: number) =>
      targets.some((t) => t.model === "res.partner" && t.resId === id);
    return {
      rows: sorted,
      // A match already in `targets` is rendered as already-selected, is not
      // checkable, and is EXCLUDED FROM THE WRITE ENTIRELY.
      writable: sorted.filter((m) => !isSelected(m.contact.id)),
      freeSlots: MAX_TARGETS - targets.length,
    };
  }, [proposal, targets]);

  const writableKey = writable.map((m) => m.contact.id).join(",");
  useEffect(() => {
    /**
     * NOT WHILE A WRITE IS RUNNING. This guard is the whole finding.
     *
     * `confirm` writes sequentially, and each successful `onAddTarget` updates
     * the parent's `targets` (useOdooTarget.addTarget -> applyTargets). Since
     * `targets` is a prop and a dependency of the memo above, every successful
     * write re-renders, recomputes `writable` without the row just added,
     * changes `writableKey`, and re-fires this effect - which then rebuilt the
     * pre-checked set from scratch, SILENTLY RE-CHECKING rows the user had
     * deliberately unchecked before clicking Add. The user watches boxes tick
     * themselves back on mid-write, clicks Add again trusting what is on
     * screen, and writes the attendee they excluded.
     *
     * That is a write to odoo_selected_targets the user did not authorise,
     * which is precisely what the confirm gate exists to make impossible.
     *
     * It also erased `writeResult`, so a partial-write failure could lose its
     * only surface to a `targets` update flushing after the loop.
     */
    if (writingRef.current) return;
    // Pre-check only when EVERY writable match fits. Auto-selecting an
    // arbitrary subset is the wrong-record risk this feature exists to avoid.
    setChecked(
      writable.length > 0 && writable.length <= freeSlots
        ? new Set(writable.map((m) => m.contact.id))
        : new Set()
    );
    setWriteResult(null);
  }, [writableKey, freeSlots]);

  /**
   * The popover closed. `ContactPicker` — and therefore this component — stays
   * MOUNTED when it does (see its `confirmingClear` reset keyed on `open`), so
   * without this every local flag survives into the next open.
   *
   * `writing` is the one that matters most: it had no reset path at all, and a
   * real force-close exists — `<Completion />`'s layout effect closes the picker
   * when `meetingLog.holding` flips true. Closed mid-write, `writing` stayed
   * true forever and the confirm button was dead on every subsequent open, for
   * an unrelated later meeting, with nothing saying why.
   */
  useEffect(() => {
    if (state.kind !== "idle") return;
    writingRef.current = false;
    setWriting(false);
    setChecked(new Set());
    setWriteResult(null);
  }, [state.kind]);

  if (state.kind === "idle") return null;

  const region = (children: React.ReactNode) => (
    <div className={REGION_CLASS} data-testid="calendar-proposal-region">
      {children}
    </div>
  );

  if (state.kind === "loading") {
    return region(<p className="text-[11px] text-muted-foreground">Checking your calendar…</p>);
  }
  if (state.kind === "no-meeting") {
    return region(
      <p className="text-[11px] text-muted-foreground">No meeting found right now.</p>
    );
  }
  if (state.kind === "error") {
    // The code only. Subjects, addresses and tokens were never put into the
    // error in the first place - see src/lib/calendar/errors.ts.
    return region(
      <>
        <p className="text-[11px] text-destructive">{state.code}</p>
        <button
          type="button"
          data-testid="calendar-proposal-retry"
          className="text-[10px] uppercase tracking-wide text-muted-foreground hover:text-foreground self-start"
          onClick={onRetry}
        >
          Try again
        </button>
      </>
    );
  }
  if (state.kind === "several") {
    return region(
      <>
        <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
          Which meeting?
        </p>
        {state.candidates.map((candidate) => (
          <button
            key={candidate.id}
            type="button"
            data-testid={`calendar-candidate-${candidate.id}`}
            className="text-left text-[11px] hover:text-primary"
            onClick={() => onPickCandidate(candidate.id)}
          >
            {`${candidate.subject ?? "Untitled meeting"} · ${timeRange(candidate.startMs, candidate.endMs)}`}
          </button>
        ))}
      </>
    );
  }

  const checkedWritable = writable.filter((m) => checked.has(m.contact.id));
  const atCap = freeSlots <= 0;
  const overflowing = writable.length > freeSlots && !atCap;

  const confirm = async () => {
    if (writingRef.current) return;
    writingRef.current = true;
    setWriting(true);

    // SNAPSHOT the user's choice before the first await. `targets` mutates
    // under us as the loop lands rows, so re-reading `checkedWritable` mid-loop
    // would write whatever the recomputed set says rather than what the user
    // actually confirmed.
    const batch = [...checkedWritable];
    const written: string[] = [];
    const notWritten: string[] = [];
    let failure: "cap" | "other" | null = null;

    // SEQUENTIAL. addSelectedTarget is a non-atomic check-then-act; issued
    // concurrently every call reads the same pre-write count, all pass, and
    // more than MAX_TARGETS rows land.
    for (const match of batch) {
      if (failure !== null) {
        notWritten.push(match.contact.name);
        continue;
      }
      const result = await onAddTarget({
        model: "res.partner",
        resId: match.contact.id,
        name: match.contact.name,
      });
      if (result.ok) {
        written.push(match.contact.name);
        continue;
      }
      // `reason` MATTERS. useOdooTarget.addTarget returns a bare `{ ok: false }`
      // from its catch for any thrown error - a busy database,
      // ODOO_NOT_CONFIGURED - and it has already shown the user a toast naming
      // the real cause. Reporting every failure as "the log is full" would
      // contradict that toast and send the user to remove destinations that
      // were never the problem.
      failure = result.reason === "cap" ? "cap" : "other";
      notWritten.push(match.contact.name);
    }

    writingRef.current = false;
    setWriting(false);
    setWriteResult(
      failure === null
        ? null
        : `Added ${written.join(", ") || "none"}. ${
            failure === "cap"
              ? "The log is full, so"
              : "Something went wrong, so"
          } ${notWritten.join(", ")} ${notWritten.length === 1 ? "was" : "were"} not added.`
    );
  };

  return region(
    <>
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {proposal?.subject ?? "Untitled meeting"}
      </p>

      {(atCap || overflowing) && (
        <p className="text-[11px]" data-testid="calendar-proposal-notice">
          {atCap
            ? "The log is full. Remove a destination above to add anyone from this meeting."
            : `${writable.length} attendees matched — ${freeSlots} slot${
                freeSlots === 1 ? "" : "s"
              } left. Pick up to ${freeSlots}.`}
        </p>
      )}

      {rows.map((match) => {
        const selected = !writable.some((w) => w.contact.id === match.contact.id);
        return (
          <label key={match.contact.id} className="flex items-center gap-2 text-[11px]">
            <input
              type="checkbox"
              data-testid={`calendar-proposal-row-${match.contact.id}`}
              checked={selected || checked.has(match.contact.id)}
              disabled={selected || atCap}
              onChange={(e) =>
                setChecked((prev) => {
                  const next = new Set(prev);
                  if (e.target.checked) next.add(match.contact.id);
                  else next.delete(match.contact.id);
                  return next;
                })
              }
            />
            <span data-testid={`calendar-proposal-label-${match.contact.id}`}>
              {match.contact.name}
            </span>
            {selected && (
              <span
                data-testid={`calendar-proposal-selected-${match.contact.id}`}
                className="text-[10px] text-muted-foreground"
              >
                already added
              </span>
            )}
          </label>
        );
      })}

      {/*
        The label switches on `reason`. Task 4 computes `archived` precisely
        because it is NOT a softer "no-contact" - the partner record exists, it
        is just archived, and telling the user there is no contact for someone
        who is in their Odoo would send them to create a duplicate.
      */}
      {proposal?.unmatched.map((entry) => (
        <p
          key={entry.participant.address}
          data-testid={`calendar-unmatched-${entry.participant.address}`}
          className="text-[11px] text-muted-foreground"
        >
          {`${entry.participant.name ?? entry.participant.address} — ${
            entry.reason === "archived" ? "archived in Odoo" : "no Odoo contact"
          }`}
        </p>
      ))}

      {!atCap && (
        <Button
          size="sm"
          className="h-6 text-[11px] self-start"
          data-testid="calendar-proposal-confirm"
          disabled={writing || checkedWritable.length === 0}
          onClick={() => void confirm()}
        >
          {`Add ${checkedWritable.length} to log`}
        </Button>
      )}

      {writeResult !== null && (
        <p className="text-[11px] text-destructive" data-testid="calendar-proposal-write-result">
          {writeResult}
        </p>
      )}
    </>
  );
}
```

- [ ] **Step 4: Run tests, lint and types**

Run: `npx vitest run src/tests/CalendarProposal.slots.test.tsx src/tests/CalendarProposal.states.test.tsx && npm run type-check && npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/pages/app/components/completion/CalendarProposal.tsx src/tests/CalendarProposal.slots.test.tsx src/tests/CalendarProposal.states.test.tsx
git commit -m "feat(calendar): render the proposal with the slot rule and a sequential write"
```

### Task 15: Wire it into the picker, `<Completion />` and the resize effect

**Files:**
- Modify: `src/hooks/useCompletion.ts` (`:130-143`, `:1929-1953`, `:2320-2327`), `src/pages/app/components/completion/ContactPicker.tsx` (`:88-158`, `:319-321`), `src/pages/app/components/completion/index.tsx` (`:48-60`, `:158`)
- Test: `src/tests/odoo-contact-picker.test.tsx` (extend)

**Interfaces:**
- Consumes: everything above.
- Produces: the rendered feature. `ContactPickerProps` gains ONE new optional prop.

**The spec is explicit that `ContactPicker.tsx` is edited.** Its props all arrive via `{...odoo.pickerProps}` from `useOdooTarget`, but the calendar is not that hook's concern, so the new prop is spread separately at the call site.

- [ ] **Step 1: Write the failing test**

Append to `src/tests/odoo-contact-picker.test.tsx`:

```tsx
describe("calendar proposal slot", () => {
  // Statically absent must cost NOTHING: the default v1 user ships no client
  // ID, and reserving blank space in a 54px window for them is the exact
  // regression the static/dynamic split exists to prevent.
  it("renders no region at all when no calendar prop is passed", async () => {
    renderPicker(); // the file's existing helper, which passes no `calendar`
    await openPicker();
    expect(screen.queryByTestId("calendar-proposal-region")).toBeNull();
  });

  it("renders the region above the search box when a proposal is present", async () => {
    renderPicker({
      calendar: {
        state: { kind: "no-meeting" as const },
        onPickCandidate: vi.fn(),
        onRetry: vi.fn(),
      },
    });
    await openPicker();
    const region = screen.getByTestId("calendar-proposal-region");
    const search = screen.getByPlaceholderText("Search contacts");
    // Node.DOCUMENT_POSITION_FOLLOWING: the search box comes after the region.
    expect(region.compareDocumentPosition(search) & 4).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/tests/odoo-contact-picker.test.tsx`
Expected: FAIL — `calendar-proposal-region` not found in the second case.

- [ ] **Step 3: Add the `useCompletion` state slot**

In `src/hooks/useCompletion.ts`, beside `targetCount` (`:143`):

```typescript
  // Whether the calendar proposal block will occupy space in the picker.
  //
  // Mirrors targetCount above EXACTLY, including why: useCompletion runs
  // before useCalendarProposal in <Completion />, so this hook cannot read the
  // value off that hook - only own a slot it writes into.
  //
  // This is the STATIC half of the absence rule. Not connected, Odoo
  // unconfigured or an empty contact cache are all known BEFORE the popover
  // opens, so they belong in this flag-driven effect. "Connected but no
  // meeting right now" resolves AFTER open and is handled inside the block by
  // the identical-footprint rule instead.
  const [calendarBlockPresent, setCalendarBlockPresent] = useState(false);
```

In the resize effect (`:1929-1953`), beside `void targetCount;` add `void calendarBlockPresent;` and add `calendarBlockPresent` to the dependency array. Do **not** add it to the `resizeWindow(...)` OR expression — the block only ever renders inside the already-open picker, and ORing it would grow a 54px bar with no popover on screen.

Export `calendarBlockPresent` and `setCalendarBlockPresent` from the return object (`:2320-2327`).

`<Completion />` also needs `useMemo` added to its React import (it already imports `useEffect`, `useLayoutEffect`, `useMemo`, `useState` — verify before editing).

- [ ] **Step 4: Add the prop to `ContactPicker`**

In `ContactPickerProps` (after `onOpenChange`, `:157`):

```typescript
  /**
   * The calendar proposal block, or undefined when it is STATICALLY absent -
   * not connected, Odoo unconfigured, or an empty contact cache. Optional
   * because those three are the common v1 case and must reserve nothing.
   *
   * `targets` and `onAddTarget` are NOT in here: CalendarProposal reads them
   * from this component's own props, so there is exactly one source for the
   * list the slot rule counts against.
   */
  calendar?: {
    state: CalendarProposalState;
    onPickCandidate: (eventId: string) => void;
    onRetry: () => void;
  };
```

The two imports this file gains — the type from `@/types`, never from the hook (see Task 3's placement note), and the component by the same relative path `index.tsx` already uses for `./ContactPicker`:

```tsx
import { CalendarProposal } from "./CalendarProposal";
import type { CalendarProposalState } from "@/types";
```

Destructure `calendar` in the parameter list, and render it as the first child of the popover's `flex flex-col gap-2` container (`:320`), above the "Logging to" section:

```tsx
          {calendar !== undefined && (
            <CalendarProposal
              state={calendar.state}
              targets={targets}
              onAddTarget={onAddTarget}
              onPickCandidate={calendar.onPickCandidate}
              onRetry={calendar.onRetry}
            />
          )}
```

- [ ] **Step 5: Mount the hook in `<Completion />`**

In `src/pages/app/components/completion/index.tsx`, **after** the `useOdooTarget` call (it reads that hook's `cache`):

```tsx
  // Mounted HERE, not inside ContactPicker: a hook there would re-run on every
  // keystroke in the search box, and could not survive the popover's lifecycle
  // rules. `cache` comes from useOdooTarget rather than a second listContacts
  // read, so the matcher and the picker can never disagree about which
  // contacts exist.
  const calendar = useCalendarProposal({
    isPickerOpen: completion.isContactPickerOpen,
    // Narrowed HERE, not inside the hook: the hook takes contacts, not the
    // cache variant, so it never has to import a page's type. `null` while the
    // cache is not ready.
    contacts:
      odoo.pickerProps.cache.kind === "ready" ? odoo.pickerProps.cache.contacts : null,
    setCalendarBlockPresent: completion.setCalendarBlockPresent,
  });

  /**
   * MEMOIZED, not an inline literal at the call site.
   *
   * `ContactPicker` is `React.memo`'d with ~30 props, and `<Completion />`
   * re-renders on every streamed AI token (`completion.state.response`). A
   * fresh `{ state, onPickCandidate, onRetry }` object each render makes
   * memo's shallow compare see a changed prop every single time, defeating the
   * memo for as long as the feature is active — popover closed included. With
   * the picker open during a stream that means re-diffing the contact list (up
   * to MAX_RENDERED_ROWS = 100) once per token.
   */
  const calendarProps = useMemo(
    () =>
      calendar.present
        ? {
            state: calendar.state,
            onPickCandidate: calendar.onPickCandidate,
            onRetry: calendar.onRetry,
          }
        : undefined,
    [calendar.present, calendar.state, calendar.onPickCandidate, calendar.onRetry]
  );
```

And at `:158`:

```tsx
        <ContactPicker {...odoo.pickerProps} calendar={calendarProps} />
```

- [ ] **Step 6: Run the full picker and hook suites, lint and types**

Run:
```bash
npx vitest run src/tests/odoo-contact-picker.test.tsx src/tests/useOdooTarget.test.tsx src/tests/useCalendarProposal.test.tsx
npm run type-check && npm run lint
```
Expected: PASS, including every pre-existing `odoo-contact-picker` and `useOdooTarget` test — the new prop is optional precisely so those keep passing unchanged.

- [ ] **Step 7: Commit**

```bash
git add src/hooks/useCompletion.ts src/pages/app/components/completion/ContactPicker.tsx src/pages/app/components/completion/index.tsx src/tests/odoo-contact-picker.test.tsx
git commit -m "feat(calendar): render the proposal inside the contact picker"
```

### Task 16: Full gate and the manual acceptance checklist

**Files:**
- Create: `docs/superpowers/plans/probe-results/2026-09-02-manual-acceptance.md`

**Interfaces:**
- Consumes: every task above.

**Why manual items exist at all:** a loopback browser round-trip cannot be proven in jsdom, and jsdom has no window bounds — the same acknowledgement `MeetingLogStrip.tsx` already makes. Five things can only be checked by hand, and one of them (the Linux refuse-to-persist rule) is a stated security requirement with no other place to be exercised.

- [ ] **Step 1: Run the whole automated gate**

```bash
npm run type-check
npm run lint
npx vitest run src/tests/current-meeting.test.ts src/tests/match-attendees.test.ts \
  src/tests/graph-errors.test.ts src/tests/graph-redact.test.ts \
  src/tests/graph-config.storage.test.ts src/tests/useCalendarProposal.test.tsx \
  src/tests/CalendarProposal.slots.test.tsx src/tests/CalendarProposal.states.test.tsx \
  src/tests/odoo-contact-picker.test.tsx src/tests/useOdooTarget.test.tsx
cargo test --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
npm run build
```
Expected: all green.

- [ ] **Step 2: Write the manual acceptance checklist**

`docs/superpowers/plans/probe-results/2026-09-02-manual-acceptance.md`:

```markdown
# Manual acceptance — calendar-proposed Odoo targets

Five items. Nothing automated can cover any of them.

- [ ] **Full connect flow in a real tenant, ending in a proposal.** Register an
      app with loopback-only redirect URIs, "Allow public client flows" = No,
      and the `/organizations` authority. Enter its client ID on `/odoo`,
      connect, consent, and confirm the picker proposes the attendees of a
      meeting happening now.
- [ ] **Disconnect really disconnects.** After Disconnect, the keychain entry is
      gone AND a subsequent proposal fails rather than succeeding on a
      still-live in-memory access token. (Clearing only the keychain leaves a
      token that keeps working until its expiry.)
- [ ] **`invalid_grant` clears the stored token.** Revoke the app's consent in
      Entra (or change the account password), then open the picker. Expect
      `GRAPH_AUTH_EXPIRED`, the keychain entry GONE, and `/odoo` showing
      disconnected. The cargo tests cover `classify_token_error`'s output codes
      but nothing exercises the branch that acts on them — that wiring lives in
      an async `#[tauri::command]` making real network calls, so this is the
      only place it can be checked.
- [ ] **A transport failure RETAINS the token.** With a connected account whose
      access token has expired, cut the network and open the picker. Expect
      `GRAPH_NETWORK`, and — once the network is back — a working proposal with
      NO reconnect required. A test asserting only "auth failure clears the
      token" would lock in the exact defect this three-way split corrected, so
      the retain half has to be exercised too.
- [ ] **`GRAPH_CONSENT_REQUIRED` in a tenant that blocks third-party consent.**
      It is the NORMAL first result there, not an edge case. Confirm the page
      shows the admin-consent URL for the user's own client ID.
- [ ] **Linux with no keychain service.** Stop the Secret Service, connect, and
      confirm: the connection is session-only, the UI says so plainly, NOTHING
      is written to disk, and relaunching requires re-authentication.
- [ ] **The popover's height is unchanged** whether the block is absent (no
      calendar connected), loading, showing two rows, or showing twelve. jsdom
      has no window bounds, so nothing automated can prove the block is even
      visible.
```

- [ ] **Step 3: Commit**

```bash
git add -f docs/superpowers/plans/probe-results/2026-09-02-manual-acceptance.md
git commit -m "docs(calendar): add the manual acceptance checklist"
```

---

## Self-Review

**1. Spec coverage.** Every spec section maps to a task:

| Spec section | Task |
|---|---|
| The invariant / no write without confirm | 14 (confirm button is the only writer), 15 |
| Scope: no migration, no persistence, no auto-popup | 13 (state is in-memory, reset on close), 14 |
| Architecture / where matching runs | 4, 5, 10 (Rust returns addresses + epoch ms) |
| Where the proposal mounts | 15 |
| Auth flow, PKCE, loopback, no device code | 7, 8, 9 |
| Registration ownership, v1 ships no client ID | 12 |
| Scopes (`openid profile offline_access` + one Calendars) | 2, 9 |
| Token handling + the four lifecycle rules | 9, 11 |
| Probes | 1, 2 |
| Selecting the meeting (union, resources, rejects, window) | 4, 5 |
| Matching attendees (own address, colleague, archived, unmatched) | 4 |
| Must not change the popover's height (static vs dynamic) | 13, 14, 15 |
| Slot rule | 14 |
| The write (via `onAddTarget`, sequential, cap surfaced) | 14 |
| Lifecycle (open reset, instance reset, generation guard) | 13 |
| Errors table (all 9 codes) | 3, 9, 10, 11 |
| Never logged | 3 (`toGraphError` drops text), tested in Task 3 |
| Testing section (every bullet) | 3, 4, 5, 13, 14, and cargo tests in 6–11 |
| Follow-up work | out of scope by design |

**2. Placeholder scan.** No "TBD", no "add appropriate error handling", no "similar to Task N". The two probes have concrete decision procedures and both outcomes named; the `keyring`-vs-plugin branch is isolated to four function bodies in one file.

**3. Type consistency.** `CalendarEvent` / `CalendarParticipant` / `GraphStatus` / `CurrentMeetings` are declared once in `src/types/calendar.ts` (Task 3) and mirrored field-for-field by the serde structs in Task 6 with `rename_all = "camelCase"`; `startMs`/`start_ms`, `ownResponse`/`own_response`, `isOrganizer`/`is_organizer` and `sessionOnly`/`session_only` are the pairs to keep aligned. `matchAttendees` returns `{ matched, unmatched, excluded }` in Task 4 and Task 13 forwards exactly `matched` and `unmatched` into `CalendarProposalState`; `excluded` is deliberately not rendered. `onAddTarget`'s signature `(t: SelectedTarget) => Promise<{ ok: boolean; reason?: "cap" }>` matches `ContactPickerProps` (`ContactPicker.tsx:130`) and `useOdooTarget.addTarget` (`useOdooTarget.ts:163`) exactly.

**Known deviation from the spec's wording, resolved deliberately:** the spec says "fixed max-height, internally scrollable region" and, in the same paragraph, that the footprint is identical whether the block is empty, loading, showing two rows or twelve. A `max-height` alone does not deliver the second, so Task 14 uses a **fixed** height with internal scrolling. The stronger of the two statements wins.

## Review pass 1 — what changed and why it matters

Seven CRITICALs, all in planned *code* rather than prose, and five of them in Task 11's credential lifecycle. Recorded here because several are the kind of defect that reads as correct until you trace a specific interleaving:

- **The 401-retry path never handled `invalid_grant`.** The three-way split was implemented at the first refresh call site and left on a bare `?` at the second. A password change revokes the access token and the refresh token together — the single commonest cause — so the dead credential would have stayed in the keychain forever. Both sites now go through one `refresh_and_adopt`, which is the only durable fix: two call sites with hand-copied error handling drift again.
- **A disconnect landing mid-refresh re-armed the credential.** The generation check sat *after* the fetch, while `persist_rotated` and `adopt` ran before it — so a refresh already in the air would rewrite the keychain entry the user had just deleted, and `status()` would report connected again. `adopt` now compares the generation *under the session lock* and writes nothing on a mismatch.
- **Disconnect could never succeed on the session-only path.** It deleted the keychain entry with `?` before clearing memory; on that path `available()` was false at connect, so the delete always errors and the early return left both tokens live — on the one platform where memory holds the only copy.
- **`persist_rotated` was unguarded**, so on the session-only path every call after access-token expiry died with `GRAPH_NO_KEYCHAIN` and discarded the rotated token. Now: adopt into memory first, persist second, and *degrade* to session-only on a persist failure rather than throwing away a credential that already cost a browser round trip.
- **`status()` read a keychain `Err` as "disconnected"**, so a transient read failure made the whole feature vanish silently — indistinguishable from never having set it up.
- **The pre-check effect re-checked rows mid-write.** Each successful write mutates `targets`, which recomputes `writable`, which re-fires the effect that rebuilds the checked set — so an attendee the user deliberately unchecked could be written anyway. That is a write to `odoo_selected_targets` the user never authorised, which is exactly what the confirm gate exists to prevent. The sequential-write test could not catch it because it held `targets` static; there is now a test that re-renders with the growing list the way `<Completion />` does.
- **The authority was unvalidated free text.** `authorize_url` used `.expect(...)` where nothing validated anything, and there was no scheme check — so a typo panicked Rust mid-connect, and a wrong or `http` authority meant `post_token` sent the authorization code, the PKCE verifier and later the refresh token to that host. Now validated in both layers, https-only, `Result` rather than `expect`. Neither reviewer rated this critical alone; merged, it is credential exfiltration rather than a panic, so it was upgraded.

Two test-quality findings were about tests that *could not fail against the defect they named* — the "not on a calendar-data change" test reused one `cache` reference, and the cap-rejection test only checked that each name appeared somewhere in the message. Both are now written so the regression they target actually breaks them.

Seven Sonnet MINORs were reported but withheld by the review's auto-apply guard, and are worth a look before execution: a `GRAPH_UNKNOWN` code so programming errors stop rendering a "Try again" that cannot help; suppressing that same retry affordance for `GRAPH_AUTH_EXPIRED`/`GRAPH_NOT_CONNECTED`; and renaming `graph-*.test.ts` to `calendar-*` to match the folder, per the uniform `odoo-` precedent.

## Review pass 2 — the `--diff` verification

One Opus reviewer, re-reading the applied edits against the whole plan rather than re-reviewing the design. **Zero criticals**, which is the convergence signal, and all three importants were *self-inflicted by pass 1* rather than pre-existing — the same shape as the spec review's second pass:

- **The `statusError` early return reintroduced the memo defect pass 1 had just fixed.** It returned a fresh state literal and a fresh `onRetry` arrow every render, both of which feed Task 15's `calendarProps` memo — so the memo recomputed every render and `ContactPicker`'s `React.memo` failed every render, for the whole session, popover closed included. Now memoized.
- **The hook published one presence value and returned another.** `setCalendarBlockPresent` got the computed `present` while the return forced `true` on a status error. That flag exists only to sit in the resize effect's dependency array, so the block would have rendered with nothing re-running the resize. One `blockPresent` now serves both.
- **The "loading before any await" comment overclaimed.** Moving `setState` before the await shrank the gap but could not close it: `fetchNow` runs from a passive effect, so the opening commit was still `idle`, which renders nothing. `visibleState` now derives `loading` during render for exactly that commit.

Also corrected: the cargo test counts were off by one from Task 7 onward; Task 13's new barrel grep could never pass (its filter did not match the `index.ts` line the same step adds); Task 3's grep did not cover the types it introduced; and an unreadable stored config was reported as `GRAPH_NOT_CONNECTED`, which discarded the absent/unreadable distinction Task 12 exists to draw and offered a retry that re-reads the same bad value forever.

