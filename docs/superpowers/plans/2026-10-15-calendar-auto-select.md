# Calendar Auto-select Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When meeting capture starts, add the current Outlook meeting's attendees as Odoo targets, and create a contact for a clearly new attendee, with no confirm click. This happens only in the unambiguous case, and only while the setting is on.

**Architecture:**
- A pure planner (`planAutoSelect`) decides what to add and create. It reuses the existing calendar matching helpers.
- A hook (`useCalendarAutoSelect`) runs the plan when `useCompletion` dispatches a `meetingCaptureStarted` window event. It writes through `useOdooTarget`'s own `addTarget` and `onCreateContact`.
- `useOdooTarget.addTarget` is changed to wait for an in-flight new-chat clear.
- The Graph fetch is shared with `useCalendarProposal`.

**Tech Stack:** React 19, TypeScript (strict), Tauri 2 (`invoke`, `listen`), Vitest with @testing-library/react.

**Spec:** `docs/superpowers/specs/2026-10-15-calendar-auto-select-design.md`

**Worktree:** `C:/Users/kmorg/meetwings-autoselect`, branch `feat/calendar-auto-select`. `node_modules` is already junctioned from the primary checkout. Run every command from the worktree root.

## Global Constraints

- Setting key: `STORAGE_KEYS.CALENDAR_AUTO_SELECT_ENABLED = "calendar_auto_select_enabled"`. It is **on unless the stored value is exactly `"false"`**.
- Switch label, verbatim: `Add meeting attendees automatically`.
- Event names:
  - window `meetingCaptureStarted`, carrying no payload;
  - window `newConversationStarted`, which already exists;
  - Tauri `odoo-instance-changed`, which already exists.
- Writes are sequential: `for...of` with `await`. Never `Promise.all`, because `addSelectedTarget` is a non-atomic check-then-act.
- Never apply a subset. If the adds plus creates exceed the free slots (`MAX_TARGETS - targets.length`), skip everything.
- No new UI beyond the one Switch, and no new toasts or messages. Existing toasts in `addTarget` and `onCreateContact` stay as they are.
- New lib modules (`src/lib/calendar/auto-select.ts`, `src/lib/calendar/fetch-current-meetings.ts`) are imported **by path**. Do **not** add them to the `@/lib/calendar` barrel (`src/lib/calendar/index.ts`): the fetch module pulls in `invoke` and plugin storage at load.
- Imports use the `@/` alias. File names are kebab-case and hooks are `useX`.
- Run tests scoped: `npx vitest run <files>`. Never run the full suite, which has known load flakes.
- **Test files are not type-checked by `npm run type-check`** (tsconfig excludes `src/tests`). After writing or changing a test file, type-check it:
  1. Create `tsconfig.scratch.json` in the worktree root containing `{ "extends": "./tsconfig.json", "include": ["src/tests/setup.ts", "src/vite-env.d.ts", "src/tests/<FILE>"], "exclude": [] }`.
  2. Run `npx tsc --noEmit -p tsconfig.scratch.json`.
  3. Fix every error in `<FILE>`. Ignore the two pre-existing TS6133 errors in `src/tests/setup.ts`.
  4. Delete `tsconfig.scratch.json`. Never commit it.
- Every commit message ends with a blank line and then `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

These are the five inputs the spec implies that are most likely to bite. Each one has a pinning test in the task named.

1. **The ID-token claim's domain differs from the mail domain** (UPN `corp.onmicrosoft.com` vs `corp.com`) and no colleague is flagged. Expected: coworkers with no partner record are created, and so is the user's own SMTP row, which the claim no longer excludes. This is an accepted limit, and the test pins it so a change is deliberate (Task 1).
2. **`ownAddress` is null** (neither claim present). Expected: skip everything, never create coworkers (Task 1).
3. **Addresses in mixed case** (`Al@CORP.test`). Expected: domain checks are case-insensitive, so an own-domain attendee is never created (Task 1).
4. **The display name is the address in another case** (`New@Acme.example` for `new@acme.example`). Expected: treated as no name, so not created (Task 1).
5. **Recording is paused and resumed within seconds while the first run is still writing.** Expected: the second `meetingCaptureStarted` is ignored, and the first run finishes (Task 5, "ignores a capture start while a run is in flight").

---

### Task 1: The planner and the setting reader

**Files:**
- Modify: `src/config/constants.ts:55` (add the key beside `MEETING_AUTO_RECORD_ENABLED`)
- Modify: `src/lib/calendar/similar-contacts.ts:101` (`FREE_MAIL`) and `:109` (`domainOf`), to export both
- Create: `src/lib/calendar/auto-select.ts`
- Test: `src/tests/calendar-auto-select.test.ts`

**Interfaces:**
- Consumes:
  - `pickCurrentMeeting(events, nowMs): CurrentMeeting` (`./current-meeting`);
  - `participantsOf(event)` and `matchAttendees({ participants, contacts, ownAddress }): MatchResult` and `normalizeAddress(s)` (`./match-attendees`);
  - `similarContacts({ name, address, contacts })` and `inferCompany({ address, contacts })` (`./similar-contacts`);
  - `MAX_TARGETS` (`@/lib/odoo/meeting-log`);
  - `safeLocalStorage` (`@/lib/storage/helper`).
- Produces:
  - `isCalendarAutoSelectEnabled(): boolean`
  - `setCalendarAutoSelectEnabled(enabled: boolean): void`
  - `interface AutoCreate { participant: CalendarParticipant; name: string; parentId: number | null }`
  - `type AutoSelectPlan = { kind: "skip"; reason: AutoSelectSkip } | { kind: "apply"; add: OdooContact[]; create: AutoCreate[] }`
  - `planAutoSelect({ events, ownAddress, contacts, targets, now }: { events: CalendarEvent[]; ownAddress: string | null; contacts: OdooContact[]; targets: SelectedTarget[]; now: number }): AutoSelectPlan`

- [ ] **Step 1: Write the failing test**

Create `src/tests/calendar-auto-select.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isCalendarAutoSelectEnabled, planAutoSelect } from "@/lib/calendar/auto-select";
import type { CalendarEvent, CalendarParticipant, OdooContact, SelectedTarget } from "@/types";

const NOW = Date.UTC(2026, 9, 15, 10, 0, 0);
const MIN = 60_000;

function contact(id: number, email: string | null, over: Partial<OdooContact> = {}): OdooContact {
  return {
    id, name: `Contact ${id}`, email, phone: null, companyName: null, parentId: null,
    isCompany: false, active: true, writeDate: "2026-10-01 00:00:00", isColleague: false,
    lastMeetingAt: null, ...over,
  };
}

function person(address: string, name: string | null = null): CalendarParticipant {
  return { address, name, type: "required", isOrganizer: false };
}

/** The user, as the organizer row Graph returns under their SMTP address. */
const ME: CalendarParticipant = { address: "me@corp.test", name: "Me", type: "required", isOrganizer: true };

function meeting(people: CalendarParticipant[], over: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: "ev1", subject: "Sync", startMs: NOW - 5 * MIN, endMs: NOW + 25 * MIN,
    isCancelled: false, isAllDay: false, ownResponse: "accepted",
    participants: [ME, ...people],
    ...over,
  };
}

function lead(resId: number): SelectedTarget {
  return { model: "crm.lead", resId, name: `Lead ${resId}` };
}

function plan(over: Partial<Parameters<typeof planAutoSelect>[0]> = {}) {
  return planAutoSelect({ events: [], ownAddress: "me@corp.test", contacts: [], targets: [], now: NOW, ...over });
}

const CFO = contact(7, "cfo@acme.example", { name: "Cleo Cfo" });

describe("planAutoSelect", () => {
  it("skips without an own address, so coworkers are never created blind", () => {
    expect(plan({ ownAddress: null, events: [meeting([person("new@acme.example", "New Person")])] }))
      .toEqual({ kind: "skip", reason: "no-own-address" });
  });

  it("skips when no meeting is current", () => {
    expect(plan()).toEqual({ kind: "skip", reason: "no-meeting" });
  });

  it("skips when two meetings overlap, rather than guess", () => {
    const events = [meeting([person("cfo@acme.example")]), meeting([person("x@beta.example")], { id: "ev2" })];
    expect(plan({ events, contacts: [CFO] })).toEqual({ kind: "skip", reason: "several-meetings" });
  });

  it("adds a matched contact", () => {
    expect(plan({ events: [meeting([person("cfo@acme.example", "Cleo")])], contacts: [CFO] }))
      .toEqual({ kind: "apply", add: [CFO], create: [] });
  });

  it("adds a matched contact even when a lead shares its id", () => {
    expect(plan({ events: [meeting([person("cfo@acme.example")])], contacts: [CFO], targets: [lead(7)] }))
      .toEqual({ kind: "apply", add: [CFO], create: [] });
  });

  it("does not create an attendee whose address has no domain", () => {
    expect(plan({ events: [meeting([person("no-at-sign", "Some Name")])], contacts: [CFO] }))
      .toEqual({ kind: "skip", reason: "nothing-to-do" });
  });

  it("does not re-add a contact that is already a target", () => {
    const targets: SelectedTarget[] = [{ model: "res.partner", resId: 7, name: "Cleo Cfo" }];
    expect(plan({ events: [meeting([person("cfo@acme.example")])], contacts: [CFO], targets }))
      .toEqual({ kind: "skip", reason: "nothing-to-do" });
  });

  it("does not add a matched contact on a colleague domain", () => {
    const coworker = contact(9, "pat@corp.test", { name: "Pat Coworker" });
    expect(plan({ events: [meeting([person("pat@corp.test", "Pat")])], contacts: [coworker] }))
      .toEqual({ kind: "skip", reason: "nothing-to-do" });
  });

  it("never creates over an archived contact", () => {
    const archived = contact(3, "old@acme.example", { active: false, name: "Old Timer" });
    expect(plan({ events: [meeting([person("old@acme.example", "Old Timer")])], contacts: [archived] }))
      .toEqual({ kind: "skip", reason: "nothing-to-do" });
  });

  it("creates a named attendee with no contact", () => {
    const ana = person("ana@newco.example", "Ana Newco");
    expect(plan({ events: [meeting([ana])], contacts: [CFO] }))
      .toEqual({ kind: "apply", add: [], create: [{ participant: ana, name: "Ana Newco", parentId: null }] });
  });

  it.each([
    ["no name", null],
    ["a blank name", "   "],
    ["the address as its name, in another case", "New@Acme.example"],
  ])("does not create an attendee with %s", (_label, name) => {
    expect(plan({ events: [meeting([person("new@acme.example", name)])], contacts: [CFO] }))
      .toEqual({ kind: "skip", reason: "nothing-to-do" });
  });

  it("does not create an attendee whose name matches an existing contact", () => {
    const jane = contact(4, "jane@other.example", { name: "Jane Doe" });
    expect(plan({ events: [meeting([person("jane.doe@acme.example", "Jane Doe")])], contacts: [jane] }))
      .toEqual({ kind: "skip", reason: "nothing-to-do" });
  });

  it("does not create an attendee on the user's own domain, whatever the case", () => {
    expect(plan({ events: [meeting([person("Al@CORP.test", "Al Coworker")])], contacts: [CFO] }))
      .toEqual({ kind: "skip", reason: "nothing-to-do" });
  });

  it("does not create an attendee on a flagged colleague's domain", () => {
    const bo = contact(5, "bo@partner.test", { isColleague: true, name: "Bo Colleague" });
    expect(plan({ events: [meeting([person("al@partner.test", "Al Partner")])], contacts: [bo] }))
      .toEqual({ kind: "skip", reason: "nothing-to-do" });
  });

  it("does not let a colleague on free mail block other free-mail attendees", () => {
    const bo = contact(5, "bo@gmail.com", { isColleague: true, name: "Bo Colleague" });
    const al = person("al@gmail.com", "Al Gmail");
    expect(plan({ events: [meeting([al])], contacts: [bo] }))
      .toEqual({ kind: "apply", add: [], create: [{ participant: al, name: "Al Gmail", parentId: null }] });
  });

  it("pins the accepted limit: a UPN domain unlike the mail domain lets coworkers, the user included, be created", () => {
    const pat = person("pat@corp.test", "Pat Coworker");
    expect(plan({ ownAddress: "me@corp.onmicrosoft.com", events: [meeting([pat])], contacts: [CFO] }))
      .toEqual({
        kind: "apply",
        add: [],
        create: [
          { participant: ME, name: "Me", parentId: null },
          { participant: pat, name: "Pat Coworker", parentId: null },
        ],
      });
  });

  it("prefills the company inferred from the address domain", () => {
    const acme = contact(50, null, { isCompany: true, name: "Acme" });
    const ops = contact(51, "ops@acme.example", { parentId: 50, name: "Ops Desk" });
    const neu = person("new@acme.example", "New Person");
    expect(plan({ events: [meeting([neu])], contacts: [acme, ops] }))
      .toEqual({ kind: "apply", add: [], create: [{ participant: neu, name: "New Person", parentId: 50 }] });
  });

  it("skips everything when the adds and creates do not all fit", () => {
    const events = [meeting([person("cfo@acme.example"), person("ana@newco.example", "Ana Newco")])];
    expect(plan({ events, contacts: [CFO], targets: [lead(1), lead(2), lead(3), lead(4)] }))
      .toEqual({ kind: "skip", reason: "over-cap" });
  });

  it("applies when they fit exactly", () => {
    const ana = person("ana@newco.example", "Ana Newco");
    const events = [meeting([person("cfo@acme.example"), ana])];
    expect(plan({ events, contacts: [CFO], targets: [lead(1), lead(2), lead(3)] }))
      .toEqual({ kind: "apply", add: [CFO], create: [{ participant: ana, name: "Ana Newco", parentId: null }] });
  });
});

describe("isCalendarAutoSelectEnabled", () => {
  beforeEach(() => {
    vi.mocked(localStorage.getItem).mockReset();
  });

  it.each([
    [null, true],
    ["true", true],
    ["garbage", true],
    ["false", false],
  ])("reads stored %s as %s", (stored, expected) => {
    vi.mocked(localStorage.getItem).mockImplementation((key: string) =>
      key === "calendar_auto_select_enabled" ? stored : null
    );
    expect(isCalendarAutoSelectEnabled()).toBe(expected);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/tests/calendar-auto-select.test.ts`
Expected: FAIL. The suite cannot resolve `@/lib/calendar/auto-select`.

- [ ] **Step 3: Write the implementation**

In `src/config/constants.ts`, directly below the `MEETING_AUTO_RECORD_ENABLED: "meeting_auto_record_enabled",` line (L55), add:

```ts
  CALENDAR_AUTO_SELECT_ENABLED: "calendar_auto_select_enabled",
```

In `src/lib/calendar/similar-contacts.ts`, change `const FREE_MAIL` (L101) to `export const FREE_MAIL` and `function domainOf` (L109) to `export function domainOf`. Nothing else in that file changes.

Create `src/lib/calendar/auto-select.ts`:

```ts
import { STORAGE_KEYS } from "@/config/constants";
import { MAX_TARGETS } from "@/lib/odoo/meeting-log";
import { safeLocalStorage } from "@/lib/storage/helper";
import type {
  CalendarEvent,
  CalendarParticipant,
  OdooContact,
  SelectedTarget,
} from "@/types";
import { pickCurrentMeeting } from "./current-meeting";
import { matchAttendees, normalizeAddress, participantsOf } from "./match-attendees";
import { domainOf, FREE_MAIL, inferCompany, similarContacts } from "./similar-contacts";

/**
 * Auto-select adds targets, and creates contacts, with no confirm click: a
 * deliberate exception to the confirm-gate rules of the 2026-09-01 and
 * 2026-09-05 specs, for the clear case only. See
 * docs/superpowers/specs/2026-10-15-calendar-auto-select-design.md.
 */

/** Default ON: only an explicit "false" turns it off. */
export function isCalendarAutoSelectEnabled(): boolean {
  return safeLocalStorage.getItem(STORAGE_KEYS.CALENDAR_AUTO_SELECT_ENABLED) !== "false";
}

export function setCalendarAutoSelectEnabled(enabled: boolean): void {
  safeLocalStorage.setItem(STORAGE_KEYS.CALENDAR_AUTO_SELECT_ENABLED, String(enabled));
}

export interface AutoCreate {
  participant: CalendarParticipant;
  name: string;
  parentId: number | null;
}

export type AutoSelectSkip =
  | "no-own-address"
  | "no-meeting"
  | "several-meetings"
  | "nothing-to-do"
  | "over-cap";

export type AutoSelectPlan =
  | { kind: "skip"; reason: AutoSelectSkip }
  | { kind: "apply"; add: OdooContact[]; create: AutoCreate[] };

export function planAutoSelect({
  events,
  ownAddress,
  contacts,
  targets,
  now,
}: {
  events: CalendarEvent[];
  ownAddress: string | null;
  contacts: OdooContact[];
  targets: SelectedTarget[];
  now: number;
}): AutoSelectPlan {
  // No own domain means no way to tell a coworker from a customer.
  if (ownAddress === null) return { kind: "skip", reason: "no-own-address" };

  const current = pickCurrentMeeting(events, now);
  if (current.kind === "none") return { kind: "skip", reason: "no-meeting" };
  if (current.kind === "several") return { kind: "skip", reason: "several-meetings" };

  // Free mail is left out: one colleague on gmail must not block every gmail
  // attendee. domainOf lowercases, so the comparison is case-insensitive.
  const colleagueDomains = new Set<string>();
  for (const address of [ownAddress, ...contacts.filter((c) => c.isColleague).map((c) => c.email)]) {
    const domain = address === null ? null : domainOf(address);
    if (domain !== null && !FREE_MAIL.has(domain)) colleagueDomains.add(domain);
  }
  const outside = (address: string) => {
    const domain = domainOf(address);
    return domain !== null && !colleagueDomains.has(domain);
  };

  const { matched, unmatched } = matchAttendees({
    participants: participantsOf(current.event),
    contacts,
    ownAddress,
  });

  // An already-selected match is never re-upserted: that would rewrite its
  // selected_at and conversation_id.
  const add = matched
    .filter(
      ({ participant, contact }) =>
        outside(participant.address) &&
        !targets.some((t) => t.model === "res.partner" && t.resId === contact.id)
    )
    .map(({ contact }) => contact);

  const create: AutoCreate[] = [];
  for (const { participant, reason } of unmatched) {
    // Creating over an archived record would duplicate it.
    if (reason !== "no-contact") continue;
    const name = participant.name?.trim() ?? "";
    // A name that is just the address says nothing about who this is.
    if (name === "" || normalizeAddress(name) === normalizeAddress(participant.address)) continue;
    if (!outside(participant.address)) continue;
    // A similar name is probably the same person under another address: the user's call.
    if (similarContacts({ name, address: participant.address, contacts }).length > 0) continue;
    create.push({ participant, name, parentId: inferCompany({ address: participant.address, contacts }) });
  }

  if (add.length + create.length === 0) return { kind: "skip", reason: "nothing-to-do" };
  // Never a subset: choosing which attendees fit is the guess "clear cases only" rules out.
  if (add.length + create.length > MAX_TARGETS - targets.length) {
    return { kind: "skip", reason: "over-cap" };
  }
  return { kind: "apply", add, create };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/tests/calendar-auto-select.test.ts src/tests/similar-contacts.test.ts`
Expected: all PASS. Then type-check the new test file (Global Constraints) and run `npm run type-check`. Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/config/constants.ts src/lib/calendar/similar-contacts.ts src/lib/calendar/auto-select.ts src/tests/calendar-auto-select.test.ts
git commit -m "feat(calendar): plan which meeting attendees to add or create automatically" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Share the current-meetings fetch

**Files:**
- Create: `src/lib/calendar/fetch-current-meetings.ts`
- Modify: `src/hooks/useCalendarProposal.ts`. Remove `QUERY_WINDOW_MS` (L22-25) and rewrite the body of `fetchNow` (L356-402).
- Test: `src/tests/fetch-current-meetings.test.ts` (new). `src/tests/useCalendarProposal.test.tsx` must pass **unchanged**.

**Interfaces:**
- Consumes:
  - `loadGraphConfigState(): Promise<GraphConfigState>` (`@/lib/storage/graph-config.storage`), whose states are `absent | unreadable | complete`;
  - `toGraphError(err).code` (`./errors`);
  - Tauri `invoke("graph_current_meetings", { clientId, authority, startIso, endIso })`.
- Produces:
  - `type FetchCurrentMeetingsResult = { kind: "ok"; events: CalendarEvent[]; ownAddress: string | null } | { kind: "absent" } | { kind: "error"; code: GraphErrorCode }`
  - `fetchCurrentMeetings(): Promise<FetchCurrentMeetingsResult>`, which never rejects.

- [ ] **Step 1: Write the failing test**

Create `src/tests/fetch-current-meetings.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

const config = vi.hoisted(() => ({ loadGraphConfigState: vi.fn() }));
vi.mock("@/lib/storage/graph-config.storage", () => config);

import { fetchCurrentMeetings } from "@/lib/calendar/fetch-current-meetings";

const COMPLETE = {
  state: "complete" as const,
  config: { clientId: "c", authority: "https://login.microsoftonline.com/organizations" },
};

beforeEach(() => {
  invoke.mockReset();
  config.loadGraphConfigState.mockReset();
  config.loadGraphConfigState.mockResolvedValue(COMPLETE);
});

describe("fetchCurrentMeetings", () => {
  it("queries 15 minutes either side of now and returns the meetings", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2026, 9, 15, 10, 0, 0));
    invoke.mockResolvedValue({ ownAddress: "me@corp.test", events: [] });

    await expect(fetchCurrentMeetings()).resolves.toEqual({ kind: "ok", ownAddress: "me@corp.test", events: [] });
    expect(invoke).toHaveBeenCalledWith("graph_current_meetings", {
      clientId: "c",
      authority: "https://login.microsoftonline.com/organizations",
      startIso: "2026-10-15T09:45:00.000Z",
      endIso: "2026-10-15T10:15:00.000Z",
    });
    vi.useRealTimers();
  });

  it("reports an absent config without calling Graph", async () => {
    config.loadGraphConfigState.mockResolvedValue({ state: "absent", config: null });
    await expect(fetchCurrentMeetings()).resolves.toEqual({ kind: "absent" });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("reports an unreadable config as a rejected authority", async () => {
    config.loadGraphConfigState.mockResolvedValue({ state: "unreadable", config: null });
    await expect(fetchCurrentMeetings()).resolves.toEqual({ kind: "error", code: "GRAPH_AUTH_REJECTED" });
  });

  it("maps a Graph failure to its code instead of rejecting", async () => {
    invoke.mockRejectedValue(new Error("GRAPH_THROTTLED"));
    await expect(fetchCurrentMeetings()).resolves.toEqual({ kind: "error", code: "GRAPH_THROTTLED" });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/tests/fetch-current-meetings.test.ts`
Expected: FAIL. The suite cannot resolve `@/lib/calendar/fetch-current-meetings`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/calendar/fetch-current-meetings.ts`:

```ts
import { invoke } from "@tauri-apps/api/core";
import { loadGraphConfigState } from "@/lib/storage/graph-config.storage";
import type { CalendarEvent, CurrentMeetings, GraphErrorCode } from "@/types";
import { toGraphError } from "./errors";

/** Deliberately WIDER than the acceptance window in current-meeting.ts, so the
 * pure function sees the events either side of the boundary rather than having
 * them filtered away by the query. */
export const QUERY_WINDOW_MS = 15 * 60 * 1000;

export type FetchCurrentMeetingsResult =
  | { kind: "ok"; events: CalendarEvent[]; ownAddress: string | null }
  | { kind: "absent" }
  | { kind: "error"; code: GraphErrorCode };

/** The calendar read both the proposal block and auto-select make. Never rejects. */
export async function fetchCurrentMeetings(): Promise<FetchCurrentMeetingsResult> {
  const config = await loadGraphConfigState();
  if (config.state === "absent") return { kind: "absent" };
  // Same code readStatus uses for the same condition: an invalid stored config
  // is a rejected authority, not a disconnected account.
  if (config.state !== "complete") return { kind: "error", code: "GRAPH_AUTH_REJECTED" };
  const now = Date.now();
  try {
    const response = await invoke<CurrentMeetings>("graph_current_meetings", {
      clientId: config.config.clientId,
      authority: config.config.authority,
      startIso: new Date(now - QUERY_WINDOW_MS).toISOString(),
      endIso: new Date(now + QUERY_WINDOW_MS).toISOString(),
    });
    return { kind: "ok", events: response.events, ownAddress: response.ownAddress };
  } catch (err) {
    return { kind: "error", code: toGraphError(err).code };
  }
}
```

In `src/hooks/useCalendarProposal.ts`:
- Delete the `QUERY_WINDOW_MS` constant and its doc comment (L22-25).
- Add `import { fetchCurrentMeetings } from "@/lib/calendar/fetch-current-meetings";`.
- Replace everything in `fetchNow` from `const config = await loadGraphConfigState();` (L373) to the end of the `catch` block (L401) with the code below. Keep the leading comment and the three statements `generation.current += 1; const mine = generation.current; setState({ kind: "loading" });` exactly as they are.

```ts
    const result = await fetchCurrentMeetings();
    if (mine !== generation.current) return;
    if (result.kind === "absent") {
      setState({ kind: "idle" });
      return;
    }
    if (result.kind === "error") {
      setState({ kind: "error", code: result.code });
      return;
    }
    eventsRef.current = result.events;
    ownAddressRef.current = result.ownAddress;
    setState(project(result.events, result.ownAddress));
```

`invoke`, `toGraphError` and `loadGraphConfigState` are still used by `readStatus` (L144, L167, L175), so keep those imports. Remove `CurrentMeetings` from the `@/types` import if nothing else in the file uses it (`npm run lint` and `npm run type-check` will say).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/tests/fetch-current-meetings.test.ts src/tests/useCalendarProposal.test.tsx src/tests/CalendarProposal.states.test.tsx`
Expected: all PASS, with `useCalendarProposal.test.tsx` unmodified. Then type-check the new test file, run `npm run type-check`, and run `npx eslint src/hooks/useCalendarProposal.ts src/lib/calendar/fetch-current-meetings.ts`. Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/lib/calendar/fetch-current-meetings.ts src/hooks/useCalendarProposal.ts src/tests/fetch-current-meetings.test.ts
git commit -m "refactor(calendar): share the current-meetings fetch" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: `addTarget` waits for an in-flight new-chat clear, and Clear is announced

**Files:**
- Modify: `src/hooks/useOdooTarget.ts`:
  - `handleNewChat` (L811-829);
  - `addTarget` (L1114-1137);
  - `clearAllTargets` (L1249-1265);
  - one new ref next to `selectionToken` (L272).
- Test: `src/tests/useOdooTarget.test.tsx`. Add two `describe`s directly after `describe("starting a new chat", ...)` (ends L1086).

**Interfaces:**
- Consumes: the existing `handleNewChat`, `addTarget` and `clearAllTargets`.
- Produces:
  - window event `odooTargetsCleared` (a `CustomEvent` with no detail), dispatched as the first statement of `clearAllTargets`, before its delete. Task 5 stops a run on it.
  - No new exports. `addTarget`'s signature is unchanged: `(t: SelectedTarget) => Promise<{ ok: boolean; reason?: "cap" }>`.

- [ ] **Step 1: Write the failing test**

Insert after the `describe("starting a new chat", ...)` block in `src/tests/useOdooTarget.test.tsx`. Its imports and helpers (`act`, `waitFor`, `mount`, `action`) already exist in the file.

```tsx
describe("adding a target while a new chat's clear is in flight", () => {
  const pick: SelectedTarget = { model: "res.partner", resId: 1, name: "Ada Lovelace" };

  async function startNewChat() {
    act(() => {
      window.dispatchEvent(new CustomEvent("newConversationStarted"));
    });
    await waitFor(() => expect(action.clearTargets).toHaveBeenCalled());
  }

  it("writes after the clear, so the clear cannot wipe it", async () => {
    let releaseClear!: () => void;
    action.clearTargets.mockImplementation(
      () => new Promise<void>((resolve) => { releaseClear = resolve; })
    );
    const { result } = mount();
    await waitFor(() => expect(action.listContacts).toHaveBeenCalled());
    await startNewChat();

    let added!: Promise<{ ok: boolean; reason?: "cap" }>;
    act(() => {
      added = result.current.addTarget(pick);
    });
    // A macrotask, not a few microtasks: today's addTarget must have every
    // chance to reach its write while the clear is parked.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(action.addSelectedTarget).not.toHaveBeenCalled();

    await act(async () => {
      releaseClear();
      await added;
    });
    expect(action.addSelectedTarget).toHaveBeenCalledTimes(1);
    expect(action.clearTargets.mock.invocationCallOrder[0]).toBeLessThan(
      action.addSelectedTarget.mock.invocationCallOrder[0]
    );
    expect(result.current.targets).toEqual([pick]);
  });

  it("still writes when the clear fails", async () => {
    action.clearTargets.mockRejectedValue(new Error("database is locked"));
    const { result } = mount();
    await waitFor(() => expect(action.listContacts).toHaveBeenCalled());
    await startNewChat();

    await act(async () => {
      await result.current.addTarget(pick);
    });
    expect(action.addSelectedTarget).toHaveBeenCalledTimes(1);
  });

  it("still writes when a second new chat supersedes the first clear", async () => {
    const { result } = mount();
    await waitFor(() => expect(action.listContacts).toHaveBeenCalled());
    act(() => {
      window.dispatchEvent(new CustomEvent("newConversationStarted"));
      window.dispatchEvent(new CustomEvent("newConversationStarted"));
    });

    await act(async () => {
      await result.current.addTarget(pick);
    });
    expect(action.addSelectedTarget).toHaveBeenCalledTimes(1);
  });
});

describe("clearing every target", () => {
  it("announces the Clear before it deletes, so a calendar auto-select run stops", async () => {
    const seen: string[] = [];
    const onCleared = () => seen.push("odooTargetsCleared");
    window.addEventListener("odooTargetsCleared", onCleared);
    action.clearTargets.mockImplementation(async () => {
      seen.push("clearTargets");
    });
    try {
      const { result } = mount();
      await waitFor(() => expect(action.listContacts).toHaveBeenCalled());

      await act(async () => {
        await result.current.clearAllTargets();
      });
      expect(seen).toEqual(["odooTargetsCleared", "clearTargets"]);
    } finally {
      window.removeEventListener("odooTargetsCleared", onCleared);
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/tests/useOdooTarget.test.tsx -t "new chat's clear is in flight|clearing every target"`
Expected:
- "writes after the clear" FAILS at `expect(action.addSelectedTarget).not.toHaveBeenCalled()`, because today's `addTarget` does not wait. If it passes here, stop and report: the test is not reaching the race.
- "announces the Clear" FAILS: `seen` is `["clearTargets"]`.
- The other two may already pass; they guard the fix against hanging.

- [ ] **Step 3: Write the implementation**

In `src/hooks/useOdooTarget.ts`, directly below `const selectionToken = useRef(0);` (L272), add:

```ts
  /**
   * The detached clear `handleNewChat` started. `addTarget` waits for it: an
   * upsert that lands before the delete is wiped by it, which auto-select hits
   * on every rollover and a pick made right after a new chat can hit too.
   * Never rejects: the block reports its own errors, a superseded clear just
   * returns, and the trailing catch covers a throw from the reporting itself.
   */
  const clearingRef = useRef<Promise<void>>(Promise.resolve());
```

In `handleNewChat`, change `void (async () => {` to `clearingRef.current = (async () => {`, and change the block's closing `})();` to:

```ts
    })().catch((err) => console.error("Clearing targets failed:", err));
```

The block body stays as it is.

In `addTarget`, make the first statement inside `try` the wait:

```ts
      try {
        await clearingRef.current;
        const instance = await resolveInstance();
```

In `clearAllTargets`, make the dispatch the first statement of the callback, above `selectionToken.current += 1;`:

```ts
    // Before the delete, not after: a calendar auto-select run checks for this
    // before each write, and must not re-add what the user just dropped.
    window.dispatchEvent(new CustomEvent("odooTargetsCleared"));
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/tests/useOdooTarget.test.tsx src/tests/odoo-target-new-chat-entry-points.test.tsx`
Expected: all PASS. Then type-check `src/tests/useOdooTarget.test.tsx` (Global Constraints; only the new lines need to be clean) and run `npm run type-check`.

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useOdooTarget.ts src/tests/useOdooTarget.test.tsx
git commit -m "fix(odoo): an add made during a new chat's clear survives the clear" -m "clearAllTargets also announces itself (odooTargetsCleared) before its delete, for calendar auto-select to stop on." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: `useCompletion` announces a fresh meeting capture

**Files:**
- Modify: `src/hooks/useCompletion.ts:1539-1567` (the capture-edge rollover effect)
- Test: `src/tests/useCompletion.meeting-assist.test.tsx`. Add tests inside `describe("a meeting capture that opens long after the last line", ...)` (L678-791), and add one top-level `it` in the main `describe`.

**Interfaces:**
- Consumes: `startNewConversation(): Promise<void>`, which dispatches `newConversationStarted` as its last statement; `conversationHistoryRef`; `MEETING_CONVERSATION_GAP_MS`.
- Produces: window event `meetingCaptureStarted` (a `CustomEvent` with no detail). It is dispatched once per rising edge of `meetingAssistMode && enableVAD`, after any rollover has finished, and only when no message in the conversation history has an `audioSource`.

- [ ] **Step 1: Write the failing tests**

Add this helper at module scope in `src/tests/useCompletion.meeting-assist.test.tsx`, after the `vi.mock` blocks and before `describe("useCompletion meeting assist mode", ...)`:

```tsx
/** The two window events the capture edge can fire, in arrival order. */
function recordCaptureEvents() {
  const seen: string[] = [];
  const onNew = () => seen.push("newConversationStarted");
  const onCapture = () => seen.push("meetingCaptureStarted");
  window.addEventListener("newConversationStarted", onNew);
  window.addEventListener("meetingCaptureStarted", onCapture);
  return {
    seen,
    stop() {
      window.removeEventListener("newConversationStarted", onNew);
      window.removeEventListener("meetingCaptureStarted", onCapture);
    },
  };
}
```

Add this top-level test inside `describe("useCompletion meeting assist mode", ...)`, for example just before `describe("a meeting capture that opens long after the last line", ...)`:

```tsx
  it("announces a fresh meeting capture, even with an empty conversation", async () => {
    const events = recordCaptureEvents();
    const { result } = renderHook(() => useCompletion(), { wrapper: strictModeWrapper });

    await act(async () => {
      result.current.setMeetingAssistMode(true);
      result.current.setEnableVAD(true);
    });

    await waitFor(() => expect(events.seen).toEqual(["meetingCaptureStarted"]));
    events.stop();
  });
```

Inside `describe("a meeting capture that opens long after the last line", ...)`, after the existing tests, add:

```tsx
    it("announces the next meeting only after the rollover has started its conversation", async () => {
      const events = recordCaptureEvents();
      const result = await recordOneMeetingThenReopenAfter(MEETING_CONVERSATION_GAP_MS + 60_000);

      await waitFor(() =>
        expect(events.seen).toEqual([
          "meetingCaptureStarted",
          "newConversationStarted",
          "meetingCaptureStarted",
        ])
      );
      // The session-wide transcript still holds the first meeting. It must not
      // block the announcement (spec, "When it runs", condition 3).
      expect(result.current.meetingTranscript.length).toBeGreaterThan(0);
      events.stop();
    });

    it("does not announce a capture that resumes the same meeting", async () => {
      const events = recordCaptureEvents();
      await recordOneMeetingThenReopenAfter(MEETING_CONVERSATION_GAP_MS - 60_000);
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      expect(events.seen).toEqual(["meetingCaptureStarted"]);
      events.stop();
    });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/tests/useCompletion.meeting-assist.test.tsx -t "announce"`
Expected: all three FAIL, because no `meetingCaptureStarted` is ever dispatched. "does not announce ..." expects exactly one event, from the first capture.

- [ ] **Step 3: Write the implementation**

Replace the effect at `src/hooks/useCompletion.ts:1551-1567` (keep the comment block at L1539-1548 and the two `const` lines at L1549-1550):

```ts
  useEffect(() => {
    const wasActive = wasMeetingCaptureActiveRef.current;
    wasMeetingCaptureActiveRef.current = meetingCaptureActive;
    if (wasActive || !meetingCaptureActive) return;
    (async () => {
      const history = conversationHistoryRef.current;
      if (history.length > 0) {
        // Meeting lines are the messages with an audioSource. Role can't tell them
        // apart: a question typed to the AI after the meeting is role "user" too,
        // and would hold the next meeting in this conversation. A chat with no
        // meeting in it falls back to its last message.
        const meetingLines = history.filter((m) => m.audioSource != null);
        const clock = meetingLines.length > 0 ? meetingLines : history;
        // Max, not the last element: the history is sorted newest-first in place.
        const lastLineAt = Math.max(...clock.map((m) => m.timestamp));
        if (Date.now() - lastLineAt > MEETING_CONVERSATION_GAP_MS) {
          // Awaited: its newConversationStarted clears the Odoo targets, and
          // auto-select must land after that, not be wiped by it.
          await startNewConversation();
          // Capture stopped during the flush (the effect re-ran and mirrored
          // it): nobody is recording this conversation, so announce nothing.
          if (!wasMeetingCaptureActiveRef.current) return;
        }
      }
      // Only a conversation with no meeting in it yet. A capture restart
      // mid-call, or a back-to-back meeting inside the gap, keeps its targets.
      // NOT meetingTranscript: that buffer is session-wide and never cleared
      // per conversation, so it would block every rollover. Every transcript
      // line reaches conversationHistoryRef with its audioSource on arrival.
      if (!conversationHistoryRef.current.some((m) => m.audioSource != null)) {
        window.dispatchEvent(new CustomEvent("meetingCaptureStarted"));
      }
      // The flush inside startNewConversation can reject. Logged rather than
      // left unhandled; the capture itself carries on either way.
    })().catch((err) => console.error("Meeting capture rollover failed:", err));
  }, [meetingCaptureActive, startNewConversation]);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/tests/useCompletion.meeting-assist.test.tsx src/tests/overlay-meeting-targets-survive.test.tsx`
Expected: all PASS, including the four existing rollover tests. Then type-check `src/tests/useCompletion.meeting-assist.test.tsx` (new lines clean) and run `npm run type-check`.

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useCompletion.ts src/tests/useCompletion.meeting-assist.test.tsx
git commit -m "feat(meeting): announce a fresh meeting capture after any rollover" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: The `useCalendarAutoSelect` hook

**Files:**
- Create: `src/hooks/useCalendarAutoSelect.ts`
- Test: `src/tests/useCalendarAutoSelect.test.tsx`

**Interfaces:**
- Consumes:
  - `isCalendarAutoSelectEnabled()` and `planAutoSelect(...)` (Task 1, `@/lib/calendar/auto-select`);
  - `fetchCurrentMeetings()` (Task 2, `@/lib/calendar/fetch-current-meetings`);
  - window `meetingCaptureStarted` (Task 4), `odooTargetsCleared` (Task 3) and `newConversationStarted`;
  - Tauri `odoo-instance-changed`.
- Produces:

```ts
export function useCalendarAutoSelect(args: {
  contacts: OdooContact[] | null;
  targetsRef: RefObject<SelectedTargets>;
  addTarget: (t: SelectedTarget) => Promise<{ ok: boolean; reason?: "cap" }>;
  onCreateContact: (
    participant: CalendarParticipant,
    draft: { name: string; parentId: number | null }
  ) => Promise<CreateContactResult>;
}): void
```

- [ ] **Step 1: Write the failing test**

Create `src/tests/useCalendarAutoSelect.test.tsx`:

```tsx
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchCurrentMeetings = vi.hoisted(() => vi.fn());
vi.mock("@/lib/calendar/fetch-current-meetings", () => ({ fetchCurrentMeetings }));

const listeners = vi.hoisted(() => new Map<string, Set<(e: unknown) => void>>());
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, handler: (e: unknown) => void) => {
    const set = listeners.get(name) ?? new Set();
    set.add(handler);
    listeners.set(name, set);
    return () => set.delete(handler);
  }),
}));

import { useCalendarAutoSelect } from "@/hooks/useCalendarAutoSelect";
import type {
  CalendarParticipant,
  CreateContactResult,
  OdooContact,
  SelectedTarget,
} from "@/types";

const MIN = 60_000;

function contact(id: number, email: string, name = `Contact ${id}`): OdooContact {
  return {
    id, name, email, phone: null, companyName: null, parentId: null, isCompany: false,
    active: true, writeDate: "2026-10-01 00:00:00", isColleague: false, lastMeetingAt: null,
  };
}

function person(address: string, name: string): CalendarParticipant {
  return { address, name, type: "required", isOrganizer: false };
}

const CFO = contact(7, "cfo@acme.example", "Cleo Cfo");
const CTO = contact(8, "cto@acme.example", "Theo Cto");
const CONTACTS = [CFO, CTO];
const AT_CFO = person("cfo@acme.example", "Cleo Cfo");
const AT_CTO = person("cto@acme.example", "Theo Cto");
const NEW_A = person("ana@newco.example", "Ana Newco");
const NEW_B = person("ben@otherco.example", "Ben Otherco");

/** One current meeting with these attendees, as fetchCurrentMeetings returns it. */
function meetingWith(...people: CalendarParticipant[]) {
  const now = Date.now();
  return {
    kind: "ok" as const,
    ownAddress: "me@corp.test",
    events: [
      {
        id: "ev1", subject: "Sync", startMs: now - 5 * MIN, endMs: now + 25 * MIN,
        isCancelled: false, isAllDay: false, ownResponse: "accepted",
        participants: [
          { address: "me@corp.test", name: "Me", type: "required" as const, isOrganizer: true },
          ...people,
        ],
      },
    ],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

type AddResult = { ok: boolean; reason?: "cap" };

function setup(contacts: OdooContact[] | null = CONTACTS) {
  const addTarget = vi.fn(async (_t: SelectedTarget): Promise<AddResult> => ({ ok: true }));
  const onCreateContact = vi.fn(
    async (p: CalendarParticipant, _d: { name: string; parentId: number | null }): Promise<CreateContactResult> => ({
      kind: "created",
      contact: contact(200, p.address, p.name ?? ""),
    })
  );
  const targetsRef = { current: [] as SelectedTarget[] };
  const view = renderHook(
    (p: { contacts: OdooContact[] | null }) =>
      useCalendarAutoSelect({ contacts: p.contacts, targetsRef, addTarget, onCreateContact }),
    { initialProps: { contacts } }
  );
  return { ...view, addTarget, onCreateContact, targetsRef };
}

async function captureStarts() {
  await act(async () => {
    window.dispatchEvent(new CustomEvent("meetingCaptureStarted"));
  });
}

/** Lets a run that is not parked on a deferred reach its end. */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  listeners.clear();
  vi.mocked(localStorage.getItem).mockReset();
  fetchCurrentMeetings.mockReset();
  fetchCurrentMeetings.mockImplementation(async () => meetingWith(AT_CFO));
});

describe("useCalendarAutoSelect", () => {
  it("does nothing until meeting capture starts", async () => {
    setup();
    await settle();
    expect(fetchCurrentMeetings).not.toHaveBeenCalled();
  });

  it("adds the meeting's matched contact when capture starts", async () => {
    const { addTarget } = setup();
    await captureStarts();
    await waitFor(() =>
      expect(addTarget).toHaveBeenCalledWith({ model: "res.partner", resId: 7, name: "Cleo Cfo" })
    );
  });

  it("does not fetch when the setting is off", async () => {
    vi.mocked(localStorage.getItem).mockImplementation((key: string) =>
      key === "calendar_auto_select_enabled" ? "false" : null
    );
    setup();
    await captureStarts();
    await settle();
    expect(fetchCurrentMeetings).not.toHaveBeenCalled();
  });

  it.each([
    ["not ready", null],
    ["empty", []],
  ])("does not fetch when the contact cache is %s", async (_label, contacts) => {
    setup(contacts as OdooContact[] | null);
    await captureStarts();
    await settle();
    expect(fetchCurrentMeetings).not.toHaveBeenCalled();
  });

  it("treats the cache as stale after an instance change until the contacts are replaced", async () => {
    const { rerender } = setup();
    await waitFor(() => expect(listeners.get("odoo-instance-changed")?.size).toBe(1));
    await act(async () => {
      for (const handler of listeners.get("odoo-instance-changed") ?? []) handler({ payload: null });
    });

    await captureStarts();
    await settle();
    expect(fetchCurrentMeetings).not.toHaveBeenCalled();

    rerender({ contacts: [...CONTACTS] });
    await captureStarts();
    await waitFor(() => expect(fetchCurrentMeetings).toHaveBeenCalledTimes(1));
  });

  it("writes nothing when the calendar call fails", async () => {
    fetchCurrentMeetings.mockImplementation(async () => ({ kind: "error", code: "GRAPH_NETWORK" }));
    const { addTarget, onCreateContact } = setup();
    await captureStarts();
    await settle();
    expect(fetchCurrentMeetings).toHaveBeenCalledTimes(1);
    expect(addTarget).not.toHaveBeenCalled();
    expect(onCreateContact).not.toHaveBeenCalled();
  });

  it("writes one target at a time", async () => {
    fetchCurrentMeetings.mockImplementation(async () => meetingWith(AT_CFO, AT_CTO));
    const first = deferred<AddResult>();
    const { addTarget } = setup();
    addTarget.mockImplementationOnce(() => first.promise);

    await captureStarts();
    await waitFor(() => expect(addTarget).toHaveBeenCalledTimes(1));
    await settle();
    expect(addTarget).toHaveBeenCalledTimes(1);

    await act(async () => {
      first.resolve({ ok: true });
    });
    await waitFor(() => expect(addTarget).toHaveBeenCalledTimes(2));
  });

  it("adds every matched contact before creating anyone", async () => {
    fetchCurrentMeetings.mockImplementation(async () => meetingWith(NEW_A, AT_CFO));
    const { addTarget, onCreateContact } = setup();
    await captureStarts();
    await waitFor(() => expect(onCreateContact).toHaveBeenCalledTimes(1));
    expect(addTarget.mock.invocationCallOrder[0]).toBeLessThan(
      onCreateContact.mock.invocationCallOrder[0]
    );
  });

  const MADE = contact(100, NEW_A.address, "Ana Newco");
  it.each<[CreateContactResult, boolean]>([
    [{ kind: "created", contact: MADE }, true],
    [{ kind: "adopted-active", contact: MADE }, true],
    [{ kind: "adopted-archived", contact: MADE }, false],
    [{ kind: "created-invisible" }, false],
    [{ kind: "cached-failed" }, false],
    [{ kind: "failed", code: "ODOO_UNREACHABLE" }, false],
    [{ kind: "abandoned" }, false],
    [{ kind: "busy" }, false],
  ])("after a create returning %o, adds it: %s, and moves on to the next attendee", async (outcome, adds) => {
    fetchCurrentMeetings.mockImplementation(async () => meetingWith(NEW_A, NEW_B));
    const { addTarget, onCreateContact } = setup();
    onCreateContact.mockResolvedValueOnce(outcome);

    await captureStarts();
    await waitFor(() => expect(onCreateContact).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(addTarget).toHaveBeenCalledWith({ model: "res.partner", resId: 200, name: "Ben Otherco" })
    );
    expect(addTarget.mock.calls.some(([t]) => t.resId === 100)).toBe(adds);
  });

  it.each<[AddResult]>([[{ ok: false, reason: "cap" }], [{ ok: false }]])(
    "stops at the first refused add (%o)",
    async (refusal) => {
      fetchCurrentMeetings.mockImplementation(async () => meetingWith(AT_CFO, AT_CTO, NEW_A));
      const { addTarget, onCreateContact } = setup();
      addTarget.mockResolvedValueOnce(refusal);

      await captureStarts();
      await waitFor(() => expect(addTarget).toHaveBeenCalledTimes(1));
      await settle();
      expect(addTarget).toHaveBeenCalledTimes(1);
      expect(onCreateContact).not.toHaveBeenCalled();
    }
  );

  it("stops when the add after a create is refused", async () => {
    fetchCurrentMeetings.mockImplementation(async () => meetingWith(NEW_A, NEW_B));
    const { addTarget, onCreateContact } = setup();
    addTarget.mockResolvedValueOnce({ ok: false, reason: "cap" });

    await captureStarts();
    await waitFor(() => expect(addTarget).toHaveBeenCalledTimes(1));
    await settle();
    expect(onCreateContact).toHaveBeenCalledTimes(1);
  });

  it.each<[string, () => void]>([
    ["a new conversation starts", () => window.dispatchEvent(new CustomEvent("newConversationStarted"))],
    ["the user clears the targets", () => window.dispatchEvent(new CustomEvent("odooTargetsCleared"))],
    [
      "the Odoo instance changes",
      () => {
        for (const handler of listeners.get("odoo-instance-changed") ?? []) handler({ payload: null });
      },
    ],
  ])("stops before the next write when %s mid-run", async (_label, interrupt) => {
    fetchCurrentMeetings.mockImplementation(async () => meetingWith(AT_CFO, AT_CTO));
    const first = deferred<AddResult>();
    const { addTarget } = setup();
    addTarget.mockImplementationOnce(() => first.promise);
    await waitFor(() => expect(listeners.get("odoo-instance-changed")?.size).toBe(1));

    await captureStarts();
    await waitFor(() => expect(addTarget).toHaveBeenCalledTimes(1));
    await act(async () => {
      interrupt();
      first.resolve({ ok: true });
    });
    await settle();
    expect(addTarget).toHaveBeenCalledTimes(1);
  });

  it("writes nothing when a new conversation starts during the calendar call", async () => {
    const parked = deferred<ReturnType<typeof meetingWith>>();
    fetchCurrentMeetings.mockImplementationOnce(() => parked.promise);
    const { addTarget, onCreateContact } = setup();

    await captureStarts();
    await act(async () => {
      window.dispatchEvent(new CustomEvent("newConversationStarted"));
      parked.resolve(meetingWith(AT_CFO, NEW_A));
    });
    await settle();
    expect(addTarget).not.toHaveBeenCalled();
    expect(onCreateContact).not.toHaveBeenCalled();
  });

  it("does not add a created contact when a new conversation starts during the create", async () => {
    fetchCurrentMeetings.mockImplementation(async () => meetingWith(NEW_A));
    const created = deferred<CreateContactResult>();
    const { addTarget, onCreateContact } = setup();
    onCreateContact.mockImplementationOnce(() => created.promise);

    await captureStarts();
    await waitFor(() => expect(onCreateContact).toHaveBeenCalledTimes(1));
    await act(async () => {
      window.dispatchEvent(new CustomEvent("newConversationStarted"));
      created.resolve({ kind: "created", contact: contact(100, NEW_A.address, "Ana Newco") });
    });
    await settle();
    expect(addTarget).not.toHaveBeenCalled();
  });

  it("ignores a capture start while a run is in flight", async () => {
    const parked = deferred<ReturnType<typeof meetingWith>>();
    fetchCurrentMeetings.mockImplementationOnce(() => parked.promise);
    const { addTarget } = setup();

    await captureStarts();
    await captureStarts();
    expect(fetchCurrentMeetings).toHaveBeenCalledTimes(1);

    await act(async () => {
      parked.resolve(meetingWith(AT_CFO));
    });
    await waitFor(() => expect(addTarget).toHaveBeenCalledTimes(1));
  });

  it("runs again for a later capture, after a failed run and after a finished one", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    fetchCurrentMeetings.mockImplementationOnce(async () => {
      throw new Error("boom");
    });
    setup();

    await captureStarts();
    await settle();
    await captureStarts();
    await settle();
    await captureStarts();
    await settle();
    expect(fetchCurrentMeetings).toHaveBeenCalledTimes(3);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/tests/useCalendarAutoSelect.test.tsx`
Expected: FAIL. The suite cannot resolve `@/hooks/useCalendarAutoSelect`.

- [ ] **Step 3: Write the implementation**

Create `src/hooks/useCalendarAutoSelect.ts`:

```ts
import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import { listen } from "@tauri-apps/api/event";
import { isCalendarAutoSelectEnabled, planAutoSelect } from "@/lib/calendar/auto-select";
import { fetchCurrentMeetings } from "@/lib/calendar/fetch-current-meetings";
import type {
  CalendarParticipant,
  CreateContactResult,
  OdooContact,
  SelectedTarget,
  SelectedTargets,
} from "@/types";

interface AutoSelectInputs {
  /** The synced contact cache, or `null` while it is not ready. */
  contacts: OdooContact[] | null;
  targetsRef: RefObject<SelectedTargets>;
  addTarget: (t: SelectedTarget) => Promise<{ ok: boolean; reason?: "cap" }>;
  onCreateContact: (
    participant: CalendarParticipant,
    draft: { name: string; parentId: number | null }
  ) => Promise<CreateContactResult>;
}

/**
 * When meeting capture starts (useCompletion's `meetingCaptureStarted`), adds
 * the current Outlook meeting's attendees as Odoo targets, creating a contact
 * for a clearly new attendee, with no confirm click. Only the clear case -
 * see planAutoSelect - and only while CALENDAR_AUTO_SELECT_ENABLED is on.
 *
 * Writes through useOdooTarget's own addTarget/onCreateContact, so the picker,
 * the "Logging to" list and the database stay in step. Silent by design: a
 * skipped or failed run leaves today's confirm-only flow.
 */
export function useCalendarAutoSelect(inputs: AutoSelectInputs): void {
  // The listeners below register once; they read the latest props through this.
  // A LAYOUT effect, like useOdooTarget's mirrors: useCompletion's capture-edge
  // effect can dispatch meetingCaptureStarted synchronously inside the same
  // commit's passive-effect flush, before a passive sync here would have run.
  const latest = useRef(inputs);
  useLayoutEffect(() => {
    latest.current = inputs;
  });

  const inFlight = useRef(false);
  // Bumped by anything that moves the targets to another conversation or
  // instance, or empties them (the picker's Clear). A run stops at its next
  // write when this changes under it.
  const generation = useRef(0);
  // After an instance change the cache still holds the OUTGOING instance's rows
  // until the resync replaces the array (CalendarProposalState's `idle` doc);
  // an id from one instance names a different partner in another.
  const staleContacts = useRef<OdooContact[] | null | undefined>(undefined);

  useEffect(() => {
    const bump = () => {
      generation.current += 1;
    };
    window.addEventListener("newConversationStarted", bump);
    window.addEventListener("odooTargetsCleared", bump);
    return () => {
      window.removeEventListener("newConversationStarted", bump);
      window.removeEventListener("odooTargetsCleared", bump);
    };
  }, []);

  useEffect(() => {
    // Disposed flag: see useCalendarProposal's listeners for the
    // unmount-before-resolve race.
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen("odoo-instance-changed", () => {
      generation.current += 1;
      staleContacts.current = latest.current.contacts;
    }).then((fn) => {
      if (disposed) {
        fn();
        return;
      }
      unlisten = fn;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    const run = async () => {
      if (inFlight.current) return;
      inFlight.current = true;
      try {
        if (!isCalendarAutoSelectEnabled()) return;
        const { contacts } = latest.current;
        if (contacts === null || contacts.length === 0 || contacts === staleContacts.current) return;
        const mine = generation.current;

        const fetched = await fetchCurrentMeetings();
        if (fetched.kind !== "ok") return;
        const plan = planAutoSelect({
          events: fetched.events,
          ownAddress: fetched.ownAddress,
          contacts,
          targets: latest.current.targetsRef.current,
          now: Date.now(),
        });
        if (plan.kind === "skip") return;

        // Sequential: addSelectedTarget is a non-atomic check-then-act. Matches
        // first, so an Odoo failure on a create cannot cost them.
        for (const contact of plan.add) {
          if (generation.current !== mine) return;
          const added = await latest.current.addTarget({
            model: "res.partner",
            resId: contact.id,
            name: contact.name,
          });
          // Any refusal (cap, or an error addTarget already toasted) would only repeat.
          if (!added.ok) return;
        }
        for (const { participant, name, parentId } of plan.create) {
          if (generation.current !== mine) return;
          const created = await latest.current.onCreateContact(participant, { name, parentId });
          if (created.kind !== "created" && created.kind !== "adopted-active") continue;
          if (generation.current !== mine) return;
          const added = await latest.current.addTarget({
            model: "res.partner",
            resId: created.contact.id,
            name: created.contact.name,
          });
          if (!added.ok) return;
        }
      } finally {
        inFlight.current = false;
      }
    };
    const onCaptureStarted = () => {
      run().catch((err) => console.error("Calendar auto-select failed:", err));
    };
    window.addEventListener("meetingCaptureStarted", onCaptureStarted);
    return () => window.removeEventListener("meetingCaptureStarted", onCaptureStarted);
  }, []);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/tests/useCalendarAutoSelect.test.tsx`
Expected: all PASS. Then type-check the new test file, run `npm run type-check`, and run `npx eslint src/hooks/useCalendarAutoSelect.ts`. Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useCalendarAutoSelect.ts src/tests/useCalendarAutoSelect.test.tsx
git commit -m "feat(calendar): add the meeting's attendees as Odoo targets when capture starts" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Mount the hook in `<Completion />`

**Files:**
- Modify: `src/hooks/index.ts` (add the export beside `export * from "./useCalendarProposal";`, L28)
- Modify: `src/pages/app/components/completion/index.tsx`. Add it to the `@/hooks` import (L2-11), and mount the hook after the `useCalendarProposal` call (ends L77).
- Modify (`@/hooks` mock stubs; without these, every test that renders `<Completion />` crashes with `useCalendarAutoSelect is not a function`). In each of the following, add `useCalendarAutoSelect: vi.fn(),` on the line directly after the existing `useCalendarProposal` entry:
  - `src/tests/overlay-minimize-keeps-mounted.test.tsx:128`
  - `src/tests/settings-page.meeting-auto-record.test.tsx:213`, `:368`, `:515`
  - `src/tests/overlay-meeting-targets-survive.test.tsx:373`
- Test: `src/tests/completion-calendar-wiring.test.tsx`. Extend the existing test.

**Interfaces:**
- Consumes: `useCalendarAutoSelect` (Task 5); `odoo.pickerProps.cache`, `odoo.targetsRef`, `odoo.addTarget`, `odoo.onCreateContact` from `useOdooTarget`.
- Produces: nothing new.

- [ ] **Step 1: Write the failing test**

In `src/tests/completion-calendar-wiring.test.tsx`, inside the existing `it(...)`:

1. Below `const useCalendarProposal = vi.fn(...)` (ends L49), add:

```tsx
    const useCalendarAutoSelect = vi.fn();
    const targetsRef = { current: [] };
    const addTarget = vi.fn();
    const onCreateContact = vi.fn();
```

2. In the `useOdooTarget: () => ({ ... })` mock, replace `targetsRef: { current: [] },` (L76) with:

```tsx
        targetsRef,
        addTarget,
        onCreateContact,
```

3. Directly below `useCalendarProposal,` in the `@/hooks` mock (L106), add `useCalendarAutoSelect,`.

4. After `expect(args.isPickerOpen).toBe(true);` (L180), add:

```tsx
    // Kills deleting the useCalendarAutoSelect mount, or feeding it anything
    // but the picker's own cache rows and handlers.
    expect(useCalendarAutoSelect).toHaveBeenCalled();
    const auto = useCalendarAutoSelect.mock.calls[0][0];
    expect(auto.contacts).toBe(contactsArray);
    expect(auto.targetsRef).toBe(targetsRef);
    expect(auto.addTarget).toBe(addTarget);
    expect(auto.onCreateContact).toBe(onCreateContact);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/tests/completion-calendar-wiring.test.tsx`
Expected: FAIL at `expect(useCalendarAutoSelect).toHaveBeenCalled()`.

- [ ] **Step 3: Write the implementation**

In `src/hooks/index.ts`, after `export * from "./useCalendarProposal";`, add:

```ts
export * from "./useCalendarAutoSelect";
```

In `src/pages/app/components/completion/index.tsx`, add `useCalendarAutoSelect,` to the `@/hooks` import list (alphabetical, after `useCalendarProposal,`). Then, directly after the `useCalendarProposal({...});` call (L69-77), add:

```tsx
  // Beside useCalendarProposal, on the same cache rows, and writing through
  // the picker's own handlers so the picker and "Logging to" stay in step.
  // Runs once per fresh meeting capture - see useCompletion's capture edge.
  useCalendarAutoSelect({
    contacts:
      odoo.pickerProps.cache.kind === "ready" ? odoo.pickerProps.cache.contacts : null,
    targetsRef: odoo.targetsRef,
    addTarget: odoo.addTarget,
    onCreateContact: odoo.onCreateContact,
  });
```

Then add `useCalendarAutoSelect: vi.fn(),` to the five stub sites listed under **Files**. If line numbers have drifted, find each by searching for `useCalendarProposal:` inside a `vi.doMock("@/hooks"` factory.

Before Step 4, check that the list is complete: search `src/tests` for the regex `useCalendarProposal[:,]` (Grep tool, or `git grep -nE "useCalendarProposal[:,]" -- src/tests`). As of writing it hits exactly the five stub sites plus `completion-calendar-wiring.test.tsx:106`. Every other hit is a `@/hooks` mock this plan missed: stub it the same way, and add its file to the Step 4 run and the Step 5 `git add`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/tests/completion-calendar-wiring.test.tsx src/tests/settings-page.meeting-auto-record.test.tsx src/tests/overlay-minimize-keeps-mounted.test.tsx src/tests/overlay-meeting-targets-survive.test.tsx`
Expected: all PASS. If `overlay-minimize-keeps-mounted.test.tsx` times out, re-run it alone; it is a known full-run load flake. Then type-check `src/tests/completion-calendar-wiring.test.tsx` (new lines clean) and run `npm run type-check` and `npm run lint`.

- [ ] **Step 5: Commit**

```bash
git add src/hooks/index.ts src/pages/app/components/completion/index.tsx src/tests/completion-calendar-wiring.test.tsx src/tests/settings-page.meeting-auto-record.test.tsx src/tests/overlay-minimize-keeps-mounted.test.tsx src/tests/overlay-meeting-targets-survive.test.tsx
git commit -m "feat(overlay): mount calendar auto-select beside the calendar proposal" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: The setting's Switch on `/odoo`

**Files:**
- Modify: `src/pages/odoo/index.tsx`:
  - imports L1-36;
  - state in `OdooSettings` (starts L338);
  - the Calendar card's closing `</div>` (L939).
- Test: `src/tests/odoo-settings-page.test.tsx`. Add a new top-level `describe` at the end of the file.

**Interfaces:**
- Consumes: `isCalendarAutoSelectEnabled()` and `setCalendarAutoSelectEnabled(enabled)` (Task 1); `Switch` from `@/components`.
- Produces: nothing new.

- [ ] **Step 1: Write the failing test**

Append to `src/tests/odoo-settings-page.test.tsx`. `renderPage`, `screen` and `userEvent` already exist in the file.

```tsx
describe("the auto-select switch", () => {
  beforeEach(() => {
    vi.mocked(localStorage.getItem).mockReset();
  });

  it("is on by default, and turning it off stores \"false\"", async () => {
    vi.mocked(localStorage.getItem).mockReturnValue(null);
    renderPage();

    const toggle = await screen.findByRole("switch", { name: "Add meeting attendees automatically" });
    expect(toggle).toHaveAttribute("aria-checked", "true");

    await userEvent.click(toggle);
    expect(localStorage.setItem).toHaveBeenCalledWith("calendar_auto_select_enabled", "false");
    expect(toggle).toHaveAttribute("aria-checked", "false");
  });

  it("shows off when the stored value is \"false\"", async () => {
    vi.mocked(localStorage.getItem).mockImplementation((key: string) =>
      key === "calendar_auto_select_enabled" ? "false" : null
    );
    renderPage();

    const toggle = await screen.findByRole("switch", { name: "Add meeting attendees automatically" });
    expect(toggle).toHaveAttribute("aria-checked", "false");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/tests/odoo-settings-page.test.tsx -t "auto-select switch"`
Expected: FAIL. `findByRole` cannot find the switch.

- [ ] **Step 3: Write the implementation**

In `src/pages/odoo/index.tsx`:
- Add `Switch` to the `@/components` import: `import { Button, Input, Label, StatusIcon, Switch } from "@/components";`.
- Add `import { isCalendarAutoSelectEnabled, setCalendarAutoSelectEnabled } from "@/lib/calendar/auto-select";`.
- In `OdooSettings`, next to the other `useState` calls near the top of the function body, add:

```tsx
  const [autoSelect, setAutoSelect] = useState(isCalendarAutoSelectEnabled);
```

- In the Calendar card, directly before its closing `</div>` (after the `graphStatus?.sessionOnly` block, L934-938), add:

```tsx
        <div className="flex items-start justify-between gap-4">
          <div>
            <Label htmlFor="calendar-auto-select">Add meeting attendees automatically</Label>
            <p className="text-xs text-muted-foreground mt-1">
              When recording starts, add the current meeting's attendees as Odoo targets, and create
              a contact for a clearly new attendee, without asking. Anything unclear still waits
              for you in the contact picker.
            </p>
          </div>
          <Switch
            id="calendar-auto-select"
            checked={autoSelect}
            onCheckedChange={(checked) => {
              setAutoSelect(checked);
              setCalendarAutoSelectEnabled(checked);
            }}
          />
        </div>
```

The main window reads the key at the moment capture starts, so this needs no cross-window broadcast.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/tests/odoo-settings-page.test.tsx`
Expected: all PASS. If a calendar-seed test times out, re-run that file alone; it is a known full-run flake. Then type-check `src/tests/odoo-settings-page.test.tsx` (new lines clean) and run `npm run type-check` and `npm run lint`.

- [ ] **Step 5: Commit**

```bash
git add src/pages/odoo/index.tsx src/tests/odoo-settings-page.test.tsx
git commit -m "feat(odoo): setting to add meeting attendees automatically" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Manual verification (human, after merge or on a dev build)

Not a subagent task. Do this on a real Teams call that has a matching Outlook event, with the setting on:

- Without opening the picker, the attendees who have Odoo contacts appear in "Logging to" within a few seconds of recording starting.
- One attendee with no Odoo contact (a named external guest) is created in Odoo and added.
- With the setting off, only the confirm block in the picker proposes them, as before.
